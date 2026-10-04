import {
    BadRequestException,
    Controller,
    Get,
    Logger,
    MessageEvent,
    NotFoundException,
    Param,
    Post,
    Query,
    Res,
    Sse,
    UploadedFile,
    UploadedFiles,
    UseInterceptors,
} from "@nestjs/common";
import { FileFieldsInterceptor, FileInterceptor } from "@nestjs/platform-express";
import { Observable } from "rxjs";
import type { Response } from "express";
import * as fs from "node:fs";
import * as path from "node:path";
import { TENDER_DIR, TenderService } from "./tender.service";
import { TenderExtractionService } from "./tender-extraction.service";
import { CATEGORIES } from "./tender-extraction.prompt";
import { PythonPipelineService } from "../pdf-pipeline/python-pipeline.service";

// 提取默认模型（与前端模型列表一致，可用 ?model= 覆盖）
const DEFAULT_EXTRACT_MODEL = 'deepseek-v4-flash'

// 锚点修正最大轮次（每轮对未定位条目更换候选锚点后重新生成）
const MAX_ANCHOR_RETRY = 3

// 分类归一化：模型可能只输出字母（A/B/...），补全为完整分类名
const normalizeCat = (cat: string): string => {
    const key = (cat ?? '').trim().charAt(0).toUpperCase()
    return CATEGORIES.find(c => c.startsWith(key)) ?? CATEGORIES[CATEGORIES.length - 1]
}

// 从 quote 中挑选候选锚点（按标点切分后取较长片段，用于未定位条目重试）
const pickCandidateAnchor = (quote: string, round: number): string | null => {
    const text = (quote ?? '').replace(/\s+/g, '')
    if (text.length < 8) return null
    const segs = text
        .split(/[，,。；;：:、（）()《》【】\[\]“”"'’]/)
        .map(s => s.trim())
        .filter(s => s.length >= 8)
        .sort((a, b) => b.length - a.length)
    if (segs.length === 0) return null
    return segs[Math.min(round, segs.length - 1)].slice(0, 30)
}

// multer 上传文件的最小类型描述（项目 tsconfig 的 types 数组限制了 @types/multer 全局声明，故就地声明）
interface MulterFile {
    fieldname: string
    originalname: string
    encoding: string
    mimetype: string
    buffer: Buffer
    size: number
}

// 文件名 UTF-8 还原（multer 按 latin1 解码中文文件名）
const decodeFilename = (originalname: string, mimetype: string): { filename: string; isPdf: boolean } => {
    const isPdf = originalname.toLowerCase().endsWith('.pdf') || mimetype === 'application/pdf'
    const utf8Name = Buffer.from(originalname, 'latin1').toString('utf8')
    const filename = /[^\x00-\x7F]/.test(utf8Name) ? utf8Name : originalname
    return { filename, isPdf }
}

@Controller('tender')
export class TenderController {
    private readonly logger = new Logger(TenderController.name)

    constructor(
        private readonly tenderService: TenderService,
        private readonly pipeline: PythonPipelineService,
        private readonly extraction: TenderExtractionService,
    ) {}

    // ==================== 阶段 1：已有清单直接渲染 ====================

    // POST /tender/review —— 上传招标 PDF（file）与条目 JSON（items），调用管线生成复核 HTML
    @Post('review')
    @UseInterceptors(FileFieldsInterceptor([
        { name: 'file', maxCount: 1 },
        { name: 'items', maxCount: 1 },
    ]))
    async review(
        @UploadedFiles() files: { file?: MulterFile[]; items?: MulterFile[] },
    ) {
        const pdf = files.file?.[0];
        const items = files.items?.[0];
        if (!pdf) throw new BadRequestException('缺少 file 字段（招标 PDF）');
        if (!items) throw new BadRequestException('缺少 items 字段（条目 JSON 文件）');
        const { filename, isPdf } = decodeFilename(pdf.originalname, pdf.mimetype)
        if (!isPdf) throw new BadRequestException('仅支持文字版 PDF');

        const prepared = this.tenderService.prepareItems(items.buffer);
        const started = Date.now();
        const { doc, itemsPath } = await this.tenderService.acceptUpload(filename, pdf.buffer, prepared.clean);

        // 环境与资源前置校验（Python 缺失/资源缺失 → 503）
        await this.pipeline.precheck();
        const title = path.basename(doc.filename, path.extname(doc.filename));
        const outPath = path.join(TENDER_DIR, doc.id, 'review.html');
        await this.pipeline.buildReviewHtml(doc.path, itemsPath, outPath, title);

        return {
            id: doc.id,
            filename: doc.filename,
            downloadUrl: `/tender/review/${doc.id}/download`,
            elapsedMs: Date.now() - started,
        };
    }

    // ==================== 阶段 2：一键到底（自动提取 + 生成界面） ====================

    // POST /tender/documents —— 上传招标 PDF 落盘，供自动提取
    @Post('documents')
    @UseInterceptors(FileInterceptor('file'))
    async uploadDocument(@UploadedFile() file: MulterFile) {
        if (!file) throw new BadRequestException('缺少 file 字段（招标 PDF）');
        const { filename, isPdf } = decodeFilename(file.originalname, file.mimetype)
        if (!isPdf) throw new BadRequestException('仅支持文字版 PDF');
        const { doc } = await this.tenderService.acceptPdf(filename, file.buffer);
        return { id: doc.id, filename: doc.filename };
    }

    // GET /tender/documents/:id/extract —— SSE：自动提取条目并生成复核 HTML
    @Get('documents/:id/extract')
    @Sse()
    extract(@Param('id') id: string, @Query('model') model?: string): Observable<MessageEvent> {
        return new Observable<MessageEvent>((observer) => {
            this.runExtraction(id, model || DEFAULT_EXTRACT_MODEL, observer);
        });
    }

    // 提取 → 落 items.json → 生成 review.html → 推送 done
    private async runExtraction(
        id: string,
        model: string,
        observer: { next: (value: MessageEvent) => void; complete: () => void },
    ): Promise<void> {
        try {
            const doc = await this.tenderService.findDocument(id);
            if (!doc) {
                observer.next({ data: { type: 'error', message: '记录不存在' } });
                observer.complete();
                return;
            }
            const dir = path.join(TENDER_DIR, doc.id);
            await this.pipeline.precheck();

            const { items, failedBlocks } = await this.extraction.extract(doc.path, dir, model, {
                onStart: (pageCount, blockTotal) =>
                    observer.next({ data: { type: 'start', pageCount, blockTotal } }),
                onProgress: (blockIndex, blockTotal, itemCount) =>
                    observer.next({ data: { type: 'progress', blockIndex, blockTotal, itemCount } }),
            });

            if (items.length === 0) {
                observer.next({
                    data: { type: 'error', message: '未提取到任何条目：请确认 PDF 为文字版且包含材料要求' },
                });
                observer.complete();
                return;
            }

            // 落盘 items.json（含编号与归一化分类，供人工修正后复用阶段 1 端点重跑）
            const title = path.basename(doc.filename, path.extname(doc.filename));
            const itemsPath = path.join(dir, 'items.json');
            const payload = {
                project: { title },
                items: items.map((it, i) => ({ id: i + 1, ...it, cat: normalizeCat(it.cat) })),
            };
            await fs.promises.writeFile(itemsPath, JSON.stringify(payload, null, 2), 'utf-8');

            observer.next({ data: { type: 'generating' } });

            // 生成复核 HTML，并对未定位条目做锚点修正重试（提高定位率）
            const outPath = path.join(dir, 'review.html');
            const missCount = await this.generateWithAnchorRetry(doc.path, itemsPath, outPath, dir, title);

            observer.next({
                data: {
                    type: 'done',
                    id: doc.id,
                    downloadUrl: `/tender/review/${doc.id}/download`,
                    inlineUrl: `/tender/review/${doc.id}/download?inline=1`,
                    itemCount: items.length,
                    missCount,
                    failedBlocks,
                },
            });
            observer.complete();
        } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            this.logger.error('标书提取失败：' + message);
            observer.next({ data: { type: 'error', message } });
            observer.complete();
        }
    }

    /**
     * 生成复核 HTML，并对未定位（MISS）条目做锚点修正重试。
     * 每轮：生成 → 读管线输出的坐标条目 → 对 MISS 条目从 quote 中换一个候选锚点 → 再生成。
     * @returns 最终未定位条目数
     */
    private async generateWithAnchorRetry(
        pdfPath: string,
        itemsPath: string,
        outPath: string,
        dir: string,
        title: string,
    ): Promise<number> {
        const coordPath = path.join(dir, 'review_items.json')
        let missCount = 0

        for (let round = 0; round <= MAX_ANCHOR_RETRY; round++) {
            await this.pipeline.buildReviewHtml(pdfPath, itemsPath, outPath, title)

            let coord: { items?: { id: number; resolve?: string }[] }
            try {
                coord = JSON.parse(await fs.promises.readFile(coordPath, 'utf-8'))
            } catch {
                return 0 // 无报告文件则视为无未定位项
            }
            const missItems = (coord.items ?? []).filter(it => it.resolve === 'MISS')
            missCount = missItems.length
            if (missCount === 0 || round === MAX_ANCHOR_RETRY) break

            // 对未定位条目更换候选锚点
            const payload = JSON.parse(await fs.promises.readFile(itemsPath, 'utf-8')) as {
                items: { id: number; quote?: string; anchor?: string }[]
            }
            let changed = 0
            for (const m of missItems) {
                const target = payload.items.find(it => it.id === m.id)
                if (!target) continue
                const candidate = pickCandidateAnchor(target.quote ?? '', round)
                if (candidate && candidate !== target.anchor) {
                    target.anchor = candidate
                    changed++
                }
            }
            if (changed === 0) break
            this.logger.log(`锚点修正第 ${round + 1} 轮：调整 ${changed} 条未定位条目`)
            await fs.promises.writeFile(itemsPath, JSON.stringify(payload, null, 2), 'utf-8')
        }

        return missCount
    }

    // ==================== 产物下载 / 查看 ====================

    // GET /tender/review/:id/download —— 返回产物 HTML（默认下载，?inline=1 时为浏览器内查看）
    @Get('review/:id/download')
    async download(@Param('id') id: string, @Query('inline') inline: string, @Res() res: Response) {
        const doc = await this.tenderService.findDocument(id);
        if (!doc) throw new NotFoundException('记录不存在');
        const outPath = path.join(TENDER_DIR, doc.id, 'review.html');
        if (!fs.existsSync(outPath)) {
            throw new NotFoundException('产物文件缺失，请重新上传生成');
        }
        const disposition = inline === '1' ? 'inline' : 'attachment'
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Content-Disposition', `${disposition}; filename*=UTF-8''review.html`);
        fs.createReadStream(outPath).pipe(res);
    }
}
