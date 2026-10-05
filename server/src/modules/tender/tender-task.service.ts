import { Injectable, Logger } from '@nestjs/common'
import { EventEmitter } from 'node:events'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { TENDER_DIR, TenderService } from './tender.service'
import { TenderExtractionService } from './tender-extraction.service'
import { PythonPipelineService } from '../pdf-pipeline/python-pipeline.service'
import { CATEGORIES } from './tender-extraction.prompt'

/**
 * 提取任务驻留服务（局域网多人加固 — 见 openspec/changes/harden-lan-multiuser/design.md §5）
 *
 * 解决的问题：原本提取任务的生命周期与 SSE 连接强绑定，用户刷新页面即失联、结果无处找回。
 * 现在任务由本服务持有（Map 驻留 + EventEmitter 广播），SSE 连接只是「订阅者」：
 *   - 断线重连 → 复用同一任务，不重复消耗模型配额
 *   - 已完成任务 → 直接以数据库终态合成事件返回结果
 */

// 任务状态机（与 tender_documents.status 列取值一致）
export type TaskStatus = 'uploaded' | 'queued' | 'extracting' | 'generating' | 'done' | 'failed'

// SSE 事件载荷（沿用既有协议，仅新增 queued）
export interface TaskEvent {
    type: 'queued' | 'start' | 'progress' | 'generating' | 'done' | 'error'
    [key: string]: unknown
}

// 任务完成结果
export interface TaskResult {
    itemCount: number
    missCount: number
    failedBlocks: number
    downloadUrl: string
    inlineUrl: string
}

// 任务快照：新订阅者据此立即对齐状态
export interface TaskSnapshot {
    id: string
    status: TaskStatus
    pageCount: number
    blockIndex: number
    blockTotal: number
    itemCount: number
    ahead: number
    result?: TaskResult
    error?: string
    finishedAt?: number
}

// 驻留任务条目
interface TaskEntry {
    snapshot: TaskSnapshot
    emitter: EventEmitter
}

// 终态快照保留时长：过期后仅依赖数据库查询（结果文件仍在磁盘，不丢）
const TERMINAL_TTL_MS = 5 * 60 * 1000

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

@Injectable()
export class TenderTaskService {
    private readonly logger = new Logger(TenderTaskService.name)

    // 驻留任务表：id → { snapshot, emitter }
    private readonly tasks = new Map<string, TaskEntry>()

    constructor(
        private readonly tenderService: TenderService,
        private readonly extraction: TenderExtractionService,
        private readonly pipeline: PythonPipelineService,
    ) {}

    /**
     * 订阅或启动
     * @returns off：取消订阅；immediate：当前快照合成的事件（新订阅者用来对齐状态）
     */
    async join(
        id: string,
        model: string,
        listener: (evt: TaskEvent) => void,
    ): Promise<{ off: () => void; immediate: TaskEvent[] }> {
        // 1) 已有驻留任务：直接挂监听（断线重连场景）
        const existing = this.tasks.get(id)
        if (existing) {
            existing.emitter.on('event', listener)
            return {
                off: () => existing.emitter.off('event', listener),
                immediate: this.snapshotEvents(existing.snapshot),
            }
        }

        // 2) 无驻留任务：查数据库判断是否已经终态
        const doc = await this.tenderService.findDocument(id)
        if (!doc) {
            return { off: () => {}, immediate: [{ type: 'error', message: '记录不存在' }] }
        }
        const terminal = this.terminalEvent(doc.id, doc.status, doc)
        if (terminal) {
            // 已完成/已失败：不重跑任务，直接补发终态事件
            return { off: () => {}, immediate: [terminal] }
        }

        // 3) 未完成任务：创建驻留任务并后台启动（发射后不管，连接断开也继续跑完）
        const entry: TaskEntry = {
            snapshot: {
                id,
                status: 'extracting',
                pageCount: 0,
                blockIndex: 0,
                blockTotal: 0,
                itemCount: 0,
                ahead: 0,
            },
            emitter: new EventEmitter(),
        }
        this.tasks.set(id, entry)
        entry.emitter.on('event', listener)
        void this.run(id, model, entry).catch(e =>
            this.logger.error(`任务执行异常（${id}）：${e instanceof Error ? e.message : String(e)}`),
        )
        return { off: () => entry.emitter.off('event', listener), immediate: [] }
    }

    // 后台执行：状态流转 + 分块提取 + 生成复核 HTML + 落库
    private async run(id: string, model: string, entry: TaskEntry): Promise<void> {
        const { snapshot, emitter } = entry
        const emit = (evt: TaskEvent) => emitter.emit('event', evt)
        try {
            const doc = await this.tenderService.findDocument(id)
            if (!doc) throw new Error('记录不存在')
            const dir = path.join(TENDER_DIR, doc.id)
            await this.pipeline.precheck()

            snapshot.status = 'extracting'
            await this.tenderService.updateStatus(id, { status: 'extracting' }).catch(() => {})

            const { items, failedBlocks } = await this.extraction.extract(doc.path, dir, model, {
                onStart: (pageCount, blockTotal) => {
                    snapshot.pageCount = pageCount
                    snapshot.blockTotal = blockTotal
                    emit({ type: 'start', pageCount, blockTotal })
                },
                onProgress: (blockIndex, blockTotal, itemCount) => {
                    snapshot.blockIndex = blockIndex
                    snapshot.blockTotal = blockTotal
                    snapshot.itemCount = itemCount
                    emit({ type: 'progress', blockIndex, blockTotal, itemCount })
                },
            })

            if (items.length === 0) {
                throw new Error('未提取到任何条目：请确认 PDF 为文字版且包含材料要求')
            }

            // 落盘 items.json（含编号与归一化分类，供人工修正后复用阶段 1 端点重跑）
            const title = path.basename(doc.filename, path.extname(doc.filename))
            const itemsPath = path.join(dir, 'items.json')
            const payload = {
                project: { title },
                items: items.map((it, i) => ({ id: i + 1, ...it, cat: normalizeCat(it.cat) })),
            }
            await fs.promises.writeFile(itemsPath, JSON.stringify(payload, null, 2), 'utf-8')

            // 进入生成阶段
            snapshot.status = 'generating'
            await this.tenderService.updateStatus(id, { status: 'generating' }).catch(() => {})
            emit({ type: 'generating' })

            // 生成复核 HTML，并对未定位条目做锚点修正重试（提高定位率）
            const outPath = path.join(dir, 'review.html')
            const missCount = await this.generateWithAnchorRetry(doc.path, itemsPath, outPath, dir, title)

            // 终态：done
            const result: TaskResult = {
                itemCount: items.length,
                missCount,
                failedBlocks,
                downloadUrl: `/tender/review/${doc.id}/download`,
                inlineUrl: `/tender/review/${doc.id}/download?inline=1`,
            }
            await this.tenderService
                .updateStatus(id, {
                    status: 'done',
                    itemCount: items.length,
                    missCount,
                    failedBlocks,
                    errorMsg: null,
                })
                .catch(() => {})
            snapshot.status = 'done'
            snapshot.result = result
            emit({ type: 'done', id: doc.id, ...result })
        } catch (e) {
            const message = e instanceof Error ? e.message : String(e)
            this.logger.error(`标书提取失败（${id}）：${message}`)
            await this.tenderService.updateStatus(id, { status: 'failed', errorMsg: message }).catch(() => {})
            snapshot.status = 'failed'
            snapshot.error = message
            emit({ type: 'error', message })
        } finally {
            snapshot.finishedAt = Date.now()
            // 终态快照保留 5 分钟供迟到订阅者直接取结果；过期后仅依赖数据库查询
            const timer = setTimeout(() => this.tasks.delete(id), TERMINAL_TTL_MS)
            timer.unref?.()
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

    // 快照 → 事件序列（新订阅者据此对齐当前状态）
    private snapshotEvents(s: TaskSnapshot): TaskEvent[] {
        switch (s.status) {
            case 'queued':
                return [{ type: 'queued', ahead: s.ahead }]
            case 'extracting':
                return s.blockTotal > 0
                    ? [
                          { type: 'start', pageCount: s.pageCount, blockTotal: s.blockTotal },
                          {
                              type: 'progress',
                              blockIndex: s.blockIndex,
                              blockTotal: s.blockTotal,
                              itemCount: s.itemCount,
                          },
                      ]
                    : []
            case 'generating':
                return [{ type: 'generating' }]
            case 'done':
                return [{ type: 'done', id: s.id, ...s.result }]
            case 'failed':
                return [{ type: 'error', message: s.error ?? '提取失败' }]
            default:
                return []
        }
    }

    // 数据库终态 → 事件（已完成任务不重跑，直接补发结果）
    private terminalEvent(
        id: string,
        status: string,
        doc: { itemCount: number | null; missCount: number | null; failedBlocks: number | null; errorMsg: string | null },
    ): TaskEvent | null {
        if (status === 'done') {
            return {
                type: 'done',
                id,
                downloadUrl: `/tender/review/${id}/download`,
                inlineUrl: `/tender/review/${id}/download?inline=1`,
                itemCount: doc.itemCount ?? 0,
                missCount: doc.missCount ?? 0,
                failedBlocks: doc.failedBlocks ?? 0,
            }
        }
        if (status === 'failed') {
            return { type: 'error', message: doc.errorMsg ?? '提取失败' }
        }
        return null
    }
}
