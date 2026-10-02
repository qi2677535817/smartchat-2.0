import { BadRequestException, Controller, Post, UploadedFiles, UseInterceptors } from "@nestjs/common";
import { FileFieldsInterceptor } from "@nestjs/platform-express";
import { TenderService } from "./tender.service";

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
    constructor(private readonly tenderService: TenderService) {}

    // POST /tender/review —— 上传招标 PDF（file）与条目 JSON（items）
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
        const prepared = this.tenderService.prepareItems(items.buffer);
        // multer 按 latin1 解码文件名，中文文件名需还原为 UTF-8（浏览器 FormData 均以 UTF-8 传输）
        const utf8Name = Buffer.from(pdf.originalname, 'latin1').toString('utf8');
        const doc = await this.tenderService.acceptUpload(
            /[^\x00-\x7F]/.test(utf8Name) ? utf8Name : pdf.originalname,
            pdf.buffer,
            prepared.clean,
        );
        return { id: doc.id, filename: doc.filename };
    }
}
