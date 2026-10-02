import { BadRequestException, Controller, Get, NotFoundException, Param, Post, Res, UploadedFiles, UseInterceptors } from "@nestjs/common";
import { FileFieldsInterceptor } from "@nestjs/platform-express";
import type { Response } from "express";
import * as fs from "node:fs";
import * as path from "node:path";
import { TENDER_DIR, TenderService } from "./tender.service";
import { PythonPipelineService } from "./python-pipeline.service";

// multer 上传文件的最小类型描述（项目 tsconfig 的 types 数组限制了 @types/multer 全局声明，故就地声明）
interface MulterFile {
    fieldname: string
    originalname: string
    encoding: string
    mimetype: string
    buffer: Buffer
    size: number
}

// 标书复核端点
@Controller('tender')
export class TenderController {
    constructor(
        private readonly tenderService: TenderService,
        private readonly pipeline: PythonPipelineService,
    ) {}

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
        const isPdf = pdf.originalname.toLowerCase().endsWith('.pdf')
            || pdf.mimetype === 'application/pdf';
        if (!isPdf) throw new BadRequestException('仅支持文字版 PDF');
        // multer 按 latin1 解码文件名，中文文件名需还原为 UTF-8（浏览器 FormData 均以 UTF-8 传输）
        const utf8Name = Buffer.from(pdf.originalname, 'latin1').toString('utf8');
        const filename = /[^\x00-\x7F]/.test(utf8Name) ? utf8Name : pdf.originalname;

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

    // GET /tender/review/:id/download —— 以文件流返回产物 HTML
    @Get('review/:id/download')
    async download(@Param('id') id: string, @Res() res: Response) {
        const doc = await this.tenderService.findDocument(id);
        if (!doc) throw new NotFoundException('记录不存在');
        const outPath = path.join(TENDER_DIR, doc.id, 'review.html');
        if (!fs.existsSync(outPath)) {
            throw new NotFoundException('产物文件缺失，请重新上传生成');
        }
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Content-Disposition', "attachment; filename*=UTF-8''review.html");
        fs.createReadStream(outPath).pipe(res);
    }
}
