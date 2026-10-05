import {
    BadRequestException,
    Controller,
    Delete,
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
    UseFilters,
    UseInterceptors,
} from "@nestjs/common";
import { FileFieldsInterceptor, FileInterceptor } from "@nestjs/platform-express";
import { uploadOptions } from "./upload.config";
import { UploadExceptionFilter } from "./upload.filter";
import { Observable } from "rxjs";
import type { Response } from "express";
import * as fs from "node:fs";
import * as path from "node:path";
import { TENDER_DIR, TenderService } from "./tender.service";
import { TERMINAL_STATUS, TenderTaskService } from "./tender-task.service";
import { TenderDocument } from "./tender-document.entity";
import { PythonPipelineService } from "../pdf-pipeline/python-pipeline.service";

// 提取默认模型（与前端模型列表一致，可用 ?model= 覆盖）
const DEFAULT_EXTRACT_MODEL = 'deepseek-v4-flash'

// SSE 终态事件：收到即关闭连接（cancelled 表示用户主动取消）
const isTerminalEvent = (type: string): boolean =>
    type === 'done' || type === 'error' || type === 'cancelled'

// 说明：锚点修正重试（MAX_ANCHOR_RETRY / pickCandidateAnchor）与分类归一化（normalizeCat）
// 等提取编排逻辑，已随「任务驻留」重构迁至 TenderTaskService（见 tender-task.service.ts）

// multer 上传文件的最小类型描述（项目 tsconfig 的 types 数组限制了 @types/multer 全局声明，故就地声明）
interface MulterFile {
    fieldname: string
    originalname: string
    encoding: string
    mimetype: string
    size: number
    // 上传已改用磁盘存储（upload.config.ts），以 path 为准；
    // buffer 仅在 memoryStorage 下存在，保留可选声明以免破坏既有类型引用
    buffer?: Buffer
    path?: string
}

// 文件名 UTF-8 还原（multer 按 latin1 解码中文文件名）
const decodeFilename = (originalname: string, mimetype: string): { filename: string; isPdf: boolean } => {
    const isPdf = originalname.toLowerCase().endsWith('.pdf') || mimetype === 'application/pdf'
    const utf8Name = Buffer.from(originalname, 'latin1').toString('utf8')
    const filename = /[^\x00-\x7F]/.test(utf8Name) ? utf8Name : originalname
    return { filename, isPdf }
}

@Controller('tender')
@UseFilters(UploadExceptionFilter)
export class TenderController {
    private readonly logger = new Logger(TenderController.name)

    constructor(
        private readonly tenderService: TenderService,
        private readonly pipeline: PythonPipelineService,
        private readonly taskService: TenderTaskService,
    ) {}

    // ==================== 阶段 1：已有清单直接渲染 ====================

    // POST /tender/review —— 上传招标 PDF（file）与条目 JSON（items），调用管线生成复核 HTML
    @Post('review')
    @UseInterceptors(FileFieldsInterceptor([
        { name: 'file', maxCount: 1 },
        { name: 'items', maxCount: 1 },
    ], uploadOptions))
    async review(
        @UploadedFiles() files: { file?: MulterFile[]; items?: MulterFile[] },
    ) {
        const pdf = files.file?.[0];
        const items = files.items?.[0];
        // 磁盘存储：先把临时文件路径全部收集，保证任何分支都能清理，避免 _uploads 目录堆积
        const tmpFiles = [pdf?.path, items?.path].filter((p): p is string => !!p);
        try {
            if (!pdf?.path) throw new BadRequestException('缺少 file 字段（招标 PDF）');
            if (!items?.path) throw new BadRequestException('缺少 items 字段（条目 JSON 文件）');
            const { filename, isPdf } = decodeFilename(pdf.originalname, pdf.mimetype)
            if (!isPdf) throw new BadRequestException('仅支持文字版 PDF');

            // 条目 JSON 为 KB 级，读入内存校验可接受
            const prepared = this.tenderService.prepareItems(await fs.promises.readFile(items.path));
            const started = Date.now();
            const { doc, itemsPath } = await this.tenderService.acceptUpload(filename, pdf.path, items.path);

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
        } finally {
            // 成功时文件已被 acceptUpload 移走，这里只清理失败分支的残留（unlink 失败可忽略）
            await Promise.all(tmpFiles.map(p => fs.promises.unlink(p).catch(() => {})));
        }
    }

    // ==================== 阶段 2：一键到底（自动提取 + 生成界面） ====================

    // POST /tender/documents —— 上传招标 PDF 落盘，供自动提取
    @Post('documents')
    @UseInterceptors(FileInterceptor('file', uploadOptions))
    async uploadDocument(@UploadedFile() file: MulterFile) {
        const tmpPath = file?.path;
        try {
            if (!tmpPath) throw new BadRequestException('缺少 file 字段（招标 PDF）');
            const { filename, isPdf } = decodeFilename(file.originalname, file.mimetype)
            if (!isPdf) throw new BadRequestException('仅支持文字版 PDF');
            const { doc } = await this.tenderService.acceptPdf(filename, tmpPath);
            return { id: doc.id, filename: doc.filename };
        } finally {
            // 成功时临时文件已被 acceptPdf 移走，unlink 失败可忽略
            if (tmpPath) await fs.promises.unlink(tmpPath).catch(() => {});
        }
    }

    // GET /tender/documents/:id/extract —— SSE：订阅或启动提取任务
    // 断线重连会复用同一任务（不重复消耗模型配额）；任务已完成则直接补发终态结果
    @Get('documents/:id/extract')
    @Sse()
    extract(@Param('id') id: string, @Query('model') model?: string): Observable<MessageEvent> {
        return new Observable<MessageEvent>((observer) => {
            let off: () => void = () => {};
            let closed = false;
            // 终态事件发出后稍作延迟再关闭连接，确保客户端收到最后一帧
            const finish = () => {
                if (closed) return;
                closed = true;
                setTimeout(() => observer.complete(), 50);
            };
            this.taskService
                .join(id, model || DEFAULT_EXTRACT_MODEL, (evt) => {
                    observer.next({ data: evt });
                    if (isTerminalEvent(String(evt.type))) finish();
                })
                .then(({ off: offFn, immediate }) => {
                    off = offFn;
                    // 补发当前快照，使新订阅者立即对齐状态（刷新后重连的关键）
                    for (const evt of immediate) {
                        observer.next({ data: evt });
                        if (isTerminalEvent(String(evt.type))) finish();
                    }
                })
                .catch((e) => {
                    observer.next({
                        data: { type: 'error', message: e instanceof Error ? e.message : String(e) },
                    });
                    finish();
                });
            // 客户端断开：仅取消订阅；任务由 TenderTaskService 继续跑完并落库
            return () => off();
        });
    }

    // GET /tender/documents —— 最近任务列表（刷新后可找回未完成任务与已完成结果）
    @Get('documents')
    async listDocuments(@Query('limit') limit?: string) {
        const docs = await this.tenderService.listDocuments(Number(limit ?? 20));
        return { items: docs.map((d) => this.toSummary(d)) };
    }

    // GET /tender/documents/:id —— 单任务状态（done 时附下载/预览地址）
    @Get('documents/:id')
    async documentStatus(@Param('id') id: string) {
        const doc = await this.tenderService.findDocument(id);
        if (!doc) throw new NotFoundException('记录不存在');
        return this.toSummary(doc);
    }

    // POST /tender/documents/:id/cancel —— 取消进行中的提取任务
    // 协作式取消：立即落库为 cancelled，后台任务在下一个检查点（块边界 / 生成前后）停止
    @Post('documents/:id/cancel')
    async cancelDocument(@Param('id') id: string) {
        const res = await this.taskService.cancel(id);
        if (!res.ok) throw new NotFoundException('记录不存在');
        return { id, status: res.status };
    }

    // DELETE /tender/documents/:id —— 删除任务及其磁盘产物（不可恢复）
    // 进行中任务先取消（协作式），再从驻留表移除监听，最后删记录并递归清理 data-cache/tender/<id>/
    @Delete('documents/:id')
    async deleteDocument(@Param('id') id: string) {
        const doc = await this.tenderService.findDocument(id);
        if (!doc) throw new NotFoundException('记录不存在');
        // 非终态任务先取消，避免后台继续往即将被删除的目录写产物
        if (!TERMINAL_STATUS.includes(doc.status)) {
            await this.taskService.cancel(id);
        }
        this.taskService.discard(id);
        await this.tenderService.removeDocument(id);
        return { id, deleted: true };
    }

    // 记录 → 前端任务摘要
    private toSummary(doc: TenderDocument) {
        const summary = {
            id: doc.id,
            filename: doc.filename,
            status: doc.status,
            itemCount: doc.itemCount,
            missCount: doc.missCount,
            failedBlocks: doc.failedBlocks,
            errorMsg: doc.errorMsg,
            createdAt: doc.createdAt,
            updatedAt: doc.updatedAt,
        };
        if (doc.status === 'done') {
            return {
                ...summary,
                downloadUrl: `/tender/review/${doc.id}/download`,
                inlineUrl: `/tender/review/${doc.id}/download?inline=1`,
            };
        }
        return summary;
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
