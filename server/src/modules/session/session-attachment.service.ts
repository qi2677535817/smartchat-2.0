import { BadRequestException, Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { SessionAttachment } from "./session-attachment.entity";
import { PythonPipelineService } from "../tender/python-pipeline.service";
import { EmbeddingService } from "../embedding/embedding.service";
import { ChunkingUtil } from "../knowledge-base/chunking.util";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const CHUNK_SIZE = 200
const MAX_CHUNKS = 500
const MIN_TEXT_LEN = 10

// 会话附件 chunk 结构（与 knowledge-base 的 Chunk 对齐 text/vector，name 用于引用来源标注）
export interface AttachmentChunk {
    text: string
    vector: number[]
    name: string
}

@Injectable()
export class SessionAttachmentService {
    constructor(
        @InjectRepository(SessionAttachment)
        private readonly attachmentRepo: Repository<SessionAttachment>,
        private readonly pipeline: PythonPipelineService,
        private readonly embedding: EmbeddingService,
    ) {}

    // 上传附件：PDF 走管线提取文本，txt/md 直接读文本 → 分块 → 向量化 → 入库
    async upload(sessionId: string, filename: string, buffer: Buffer) {
        let text: string
        if (/\.pdf$/i.test(filename)) {
            const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "attach-"));
            const pdfPath = path.join(tmpDir, "source.pdf");
            const txtPath = path.join(tmpDir, "text.txt");
            try {
                await fs.promises.writeFile(pdfPath, buffer);
                text = await this.pipeline.extractText(pdfPath, txtPath);
            } finally {
                await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
            }
        } else {
            text = buffer.toString('utf-8');
        }

        if (!text || text.trim().length < MIN_TEXT_LEN) {
            throw new BadRequestException("文件内容为空或过短（PDF 可能是扫描件），请提供文字版内容");
        }

        const pieces = ChunkingUtil.chunking(text, CHUNK_SIZE);
        if (pieces.length > MAX_CHUNKS) {
            throw new BadRequestException(`附件过大（${pieces.length} 个分块，超过 ${MAX_CHUNKS}），请拆分后上传`);
        }

        const chunks: { text: string; vector: number[] }[] = [];
        for (const piece of pieces) {
            const vector = await this.embedding.embedText(piece);
            chunks.push({ text: piece, vector });
        }

        const attachment = new SessionAttachment();
        attachment.sessionId = sessionId;
        attachment.filename = filename;
        attachment.text = text;
        attachment.chunks = JSON.stringify(chunks);
        attachment.createdAt = Date.now();
        const saved = await this.attachmentRepo.save(attachment);
        return { id: saved.id, filename: saved.filename, chunkCount: chunks.length };
    }

    // 附件列表（不含向量）
    async list(sessionId: string) {
        const list = await this.attachmentRepo.find({ where: { sessionId }, order: { createdAt: 'ASC' } });
        return list.map(a => ({
            id: a.id,
            filename: a.filename,
            chunkCount: (JSON.parse(a.chunks || '[]') as unknown[]).length,
            createdAt: a.createdAt,
        }));
    }

    // 删除单条附件
    async remove(sessionId: string, attachmentId: string) {
        const res = await this.attachmentRepo.delete({ id: attachmentId, sessionId });
        if (!res.affected) throw new BadRequestException("附件不存在");
        return { msg: "删除成功", code: 0 };
    }

    // 展平某会话全部附件的 chunks，供检索（任务 3 使用）
    async listChunksBySession(sessionId: string): Promise<AttachmentChunk[]> {
        const list = await this.attachmentRepo.find({ where: { sessionId } });
        const result: AttachmentChunk[] = [];
        for (const a of list) {
            const chunks = JSON.parse(a.chunks || '[]') as { text: string; vector: number[] }[];
            for (const c of chunks) {
                result.push({ text: c.text, vector: c.vector, name: `[附件] ${a.filename}` });
            }
        }
        return result;
    }
}
