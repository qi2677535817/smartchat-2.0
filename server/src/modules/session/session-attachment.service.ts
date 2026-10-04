import { BadRequestException, Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { SessionAttachment } from "./session-attachment.entity";
import { PythonPipelineService } from "../pdf-pipeline/python-pipeline.service";
import { EmbeddingService } from "../embedding/embedding.service";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// 附件分块尺寸：PDF 提取文本行很碎，需用较大块避免块数爆炸
const ATTACHMENT_CHUNK_SIZE = 800
// 分块上限：支持上百页文档（100 页 PDF 约 65 块）
const MAX_CHUNKS = 3000
// embedding 并发数：控制并发避免触发接口限流
const EMBED_CONCURRENCY = 5
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

        const pieces = this.chunkAttachmentText(text, ATTACHMENT_CHUNK_SIZE);
        if (pieces.length > MAX_CHUNKS) {
            throw new BadRequestException(`附件过大（${pieces.length} 个分块，超过 ${MAX_CHUNKS}），请拆分后上传`);
        }

        const vectors = await this.embedWithConcurrency(pieces, EMBED_CONCURRENCY);
        const chunks = pieces.map((piece, i) => ({ text: piece, vector: vectors[i] }));

        const attachment = new SessionAttachment();
        attachment.sessionId = sessionId;
        attachment.filename = filename;
        attachment.text = text;
        attachment.chunks = JSON.stringify(chunks);
        attachment.createdAt = Date.now();
        const saved = await this.attachmentRepo.save(attachment);
        return { id: saved.id, filename: saved.filename, chunkCount: chunks.length };
    }

    /**
     * 附件文本分块：先合并被 PDF 换行切碎的句子，再按标点边界切块。
     * 不能直接用 ChunkingUtil：它按行分块，而 PDF 提取文本每行只有几十字，
     * 会把 79 页文档切成 2000+ 块（实测 2055 块），导致 embedding 海量请求。
     */
    private chunkAttachmentText(text: string, size: number): string[] {
        // 单换行合并为空格（同一句被换行切断），双换行保留为段落分隔
        const normalized = text
            .replace(/\r\n/g, '\n')
            .replace(/([^\n])\n(?!\n)/g, '$1 ')
            .replace(/[ \t]{2,}/g, ' ')
        const chunks: string[] = []
        let buf = ''
        for (const ch of normalized) {
            buf += ch
            // 达到尺寸且在标点/换行处断开，尽量保持语义完整
            if (buf.length >= size && /[。！？；\n.!?;]/.test(ch)) {
                chunks.push(buf.trim())
                buf = ''
            }
        }
        if (buf.trim()) chunks.push(buf.trim())
        return chunks
    }

    /**
     * 并发 embedding：控制并发数避免触发接口限流，结果按原顺序返回
     */
    private async embedWithConcurrency(pieces: string[], concurrency: number): Promise<number[][]> {
        const results: number[][] = new Array(pieces.length)
        let cursor = 0
        const worker = async () => {
            while (cursor < pieces.length) {
                const i = cursor++
                results[i] = await this.embedding.embedText(pieces[i])
            }
        }
        const workerCount = Math.max(1, Math.min(concurrency, pieces.length))
        await Promise.all(Array.from({ length: workerCount }, () => worker()))
        return results
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
