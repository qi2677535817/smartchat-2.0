import { BadRequestException, Controller, Delete, Get, Param, Post, UploadedFile, UseInterceptors } from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { SessionAttachmentService } from "./session-attachment.service";

// multer 上传文件的最小类型描述
interface MulterFile {
    originalname: string
    mimetype: string
    buffer: Buffer
    size: number
}

// 会话附件端点（与 SessionController 共用 /sessions 前缀）
@Controller('sessions')
export class SessionAttachmentController {
    constructor(private readonly attachmentService: SessionAttachmentService) {}

    // POST /sessions/:id/attachments —— 上传附件（PDF/TXT/MD），解析并向量化入库
    @Post(':id/attachments')
    @UseInterceptors(FileInterceptor('file'))
    async upload(@Param('id') id: string, @UploadedFile() file: MulterFile) {
        if (!file) throw new BadRequestException('缺少 file 字段（附件文件）');
        const ext = file.originalname.toLowerCase().split('.').pop() ?? '';
        if (!['pdf', 'txt', 'md'].includes(ext)) {
            throw new BadRequestException('仅支持 PDF / TXT / MD 文件');
        }
        // multer 按 latin1 解码文件名，中文名还原 UTF-8
        const utf8Name = Buffer.from(file.originalname, 'latin1').toString('utf8');
        const filename = /[^\x00-\x7F]/.test(utf8Name) ? utf8Name : file.originalname;
        return this.attachmentService.upload(id, filename, file.buffer);
    }

    // GET /sessions/:id/attachments —— 附件列表（不含向量）
    @Get(':id/attachments')
    list(@Param('id') id: string) {
        return this.attachmentService.list(id);
    }

    // DELETE /sessions/:id/attachments/:attachmentId —— 删除单条附件
    @Delete(':id/attachments/:attachmentId')
    remove(@Param('id') id: string, @Param('attachmentId') attachmentId: string) {
        return this.attachmentService.remove(id, attachmentId);
    }
}
