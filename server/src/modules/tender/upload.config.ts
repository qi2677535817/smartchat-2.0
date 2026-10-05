import { diskStorage } from 'multer'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'

/**
 * 上传落盘配置（局域网多人加固 — 见 openspec/changes/harden-lan-multiuser/design.md §3）
 *
 * 背景：Nest 的 FileInterceptor 默认使用 multer 的 memoryStorage，整份文件读进内存，
 * 多人并发上传大体积 PDF 会直接把 Node 进程撑爆。这里改为磁盘存储：
 * 请求体边接收边写临时文件，内存占用与文件体积解耦。
 */

// 临时目录：先落盘，校验通过后再由 TenderService 原子移动到 data-cache/tender/<id>/
export const UPLOAD_TMP_DIR = path.resolve('data-cache', 'tender', '_uploads')

// 单文件体积上限（MB），默认 200；部署时可用 TENDER_MAX_UPLOAD_MB 覆盖
export const MAX_UPLOAD_MB = Math.max(1, Number(process.env.TENDER_MAX_UPLOAD_MB ?? 200))
export const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024

// 上传体积与数量上限（files: 2 用于兼容「file + items」双字段的 review 端点）
export const uploadOptions = {
    storage: diskStorage({
        // multer 不会自动创建目标目录，必须在这里同步建目录
        destination: (_req: unknown, _file: unknown, cb: (error: Error | null, dir: string) => void) => {
            try {
                fs.mkdirSync(UPLOAD_TMP_DIR, { recursive: true })
                cb(null, UPLOAD_TMP_DIR)
            } catch (e) {
                cb(e as Error, UPLOAD_TMP_DIR)
            }
        },
        // UUID 命名：避免并发上传互相覆盖，且不对外暴露原始扩展名
        filename: (_req: unknown, _file: unknown, cb: (error: Error | null, name: string) => void) => {
            cb(null, `${randomUUID()}.upload`)
        },
    }),
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 2 },
}
