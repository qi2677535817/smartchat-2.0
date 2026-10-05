import { BadRequestException, Injectable, OnModuleInit } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { TenderDocument } from "./tender-document.entity";
import { UPLOAD_TMP_DIR } from "./upload.config";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

// 产物落盘根目录：server/data-cache/tender/（已在 server/.gitignore 的 /data-cache 内）
export const TENDER_DIR = path.resolve("data-cache", "tender");

// 原子移动上传临时文件到正式目录；跨磁盘分区时 rename 会抛 EXDEV，回退为「复制 + 删除」
async function moveFile(from: string, to: string): Promise<void> {
    try {
        await fs.promises.rename(from, to);
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EXDEV") {
            await fs.promises.copyFile(from, to);
            await fs.promises.unlink(from).catch(() => {});
            return;
        }
        throw e;
    }
}

@Injectable()
export class TenderService implements OnModuleInit {
    constructor(
        @InjectRepository(TenderDocument)
        private readonly tenderDocRepo: Repository<TenderDocument>,
    ) {}

    // 启动时清空上传临时目录：清理上次进程被强杀时残留的半截文件（局域网加固 design §3.3）
    async onModuleInit(): Promise<void> {
        await fs.promises.rm(UPLOAD_TMP_DIR, { recursive: true, force: true }).catch(() => {});
    }

    // 剥离 UTF-8 BOM：Windows 常见，且 Python 管线 json.load 无法处理 BOM（不改脚本，在 Node 侧清洗）
    private stripBom(raw: Buffer): Buffer {
        return raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf
            ? raw.subarray(3)
            : raw;
    }

    // 清洗并校验 items 内容：形如 {"items":[非空数组]}，可含 project 字段（管线 build_review_html.py 的读取约定）
    // 返回 clean 为剥除 BOM 后的 Buffer（落盘用，保证 Python 端可读）
    prepareItems(raw: Buffer): { json: { items: Record<string, unknown>[]; project?: Record<string, unknown> }; clean: Buffer } {
        const clean = this.stripBom(raw);
        let data: unknown;
        try {
            data = JSON.parse(clean.toString("utf-8"));
        } catch {
            throw new BadRequestException("items 文件不是合法 JSON");
        }
        if (typeof data !== "object" || data === null || Array.isArray(data)) {
            throw new BadRequestException("items 必须是形如 {\"items\":[...]} 的对象");
        }
        const obj = data as { items?: unknown; project?: unknown };
        if (!Array.isArray(obj.items) || obj.items.length === 0) {
            throw new BadRequestException("items.items 必须是非空数组");
        }
        for (const it of obj.items) {
            if (typeof it !== "object" || it === null) {
                throw new BadRequestException("items.items 中存在非对象条目");
            }
            const entry = it as Record<string, unknown>;
            if (!entry.id || !entry.name || !entry.anchor) {
                throw new BadRequestException("每条条目必须含 id、name、anchor 字段");
            }
        }
        return { json: data as { items: Record<string, unknown>[]; project?: Record<string, unknown> }, clean };
    }

    // 受理上传（阶段 1）：把 multer 已落盘的 PDF / items 临时文件移入 data-cache/tender/<id>/
    // 入参为临时文件绝对路径（upload.config.ts 磁盘存储的产物），避免大文件进内存
    async acceptUpload(filename: string, pdfTmpPath: string, itemsTmpPath: string): Promise<{ doc: TenderDocument; itemsPath: string }> {
        const id = randomUUID();
        const dir = path.join(TENDER_DIR, id);
        await fs.promises.mkdir(dir, { recursive: true });
        const pdfPath = path.join(dir, "source.pdf");
        const itemsPath = path.join(dir, "items.json");
        await moveFile(pdfTmpPath, pdfPath);
        await moveFile(itemsTmpPath, itemsPath);

        const doc = new TenderDocument();
        doc.id = id;
        doc.filename = filename;
        doc.path = pdfPath;
        doc.pageCount = null;
        doc.pageOffset = null;
        doc.createdAt = Date.now();
        return { doc: await this.tenderDocRepo.save(doc), itemsPath };
    }

    // 受理上传（仅 PDF）：移动临时文件入目录并建记录，返回 PDF 路径（阶段 2 自动提取流程用）
    async acceptPdf(filename: string, pdfTmpPath: string): Promise<{ doc: TenderDocument; pdfPath: string }> {
        const id = randomUUID();
        const dir = path.join(TENDER_DIR, id);
        await fs.promises.mkdir(dir, { recursive: true });
        const pdfPath = path.join(dir, "source.pdf");
        await moveFile(pdfTmpPath, pdfPath);

        const doc = new TenderDocument();
        doc.id = id;
        doc.filename = filename;
        doc.path = pdfPath;
        doc.pageCount = null;
        doc.pageOffset = null;
        doc.createdAt = Date.now();
        return { doc: await this.tenderDocRepo.save(doc), pdfPath };
    }

    // 按 id 查询上传记录（下载端点用）
    findDocument(id: string): Promise<TenderDocument | null> {
        return this.tenderDocRepo.findOne({ where: { id } });
    }
}
