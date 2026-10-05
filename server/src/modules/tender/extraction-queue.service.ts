import { Injectable } from '@nestjs/common'

/**
 * 提取并发闸门（局域网多人加固 — 见 openspec/changes/harden-lan-multiuser/design.md §4）
 *
 * 单机部署下，多个提取任务同时执行会同时打满外部 LLM 配额与本地 CPU：
 * 10 人并发可能瞬间打出数十次模型请求，触发限流并让成本线性膨胀。
 * 这里用原生 FIFO 信号量把并发数限制在 TENDER_MAX_CONCURRENCY（默认 2），
 * 超出的任务排队等待而非被拒绝，前端通过 queued 事件看到排队位次。
 *
 * 说明：仅在进程内生效（单实例部署）。多实例场景需替换为分布式队列，属后续变更。
 */
@Injectable()
export class ExtractionQueueService {
    // 当前正在执行的任务数
    private running = 0

    // 等待槽位的 FIFO 队列（存放唤醒回调）
    private readonly waiters: Array<() => void> = []

    // 并发上限：可由 TENDER_MAX_CONCURRENCY 覆盖，最小 1
    get maxConcurrent(): number {
        return Math.max(1, Number(process.env.TENDER_MAX_CONCURRENCY ?? 2))
    }

    // 当前执行中的任务数
    get active(): number {
        return this.running
    }

    // 当前排队中的任务数
    get pending(): number {
        return this.waiters.length
    }

    /**
     * 获取一个执行槽位
     * @returns 释放函数（务必在 finally 中调用，否则槽位泄漏会导致后续任务永远排队）
     */
    async acquire(): Promise<() => void> {
        if (this.running < this.maxConcurrent) {
            this.running++
            return () => this.release()
        }
        // 满员：进入 FIFO 等待队列；被唤醒时槽位由 release 直接移交（running 不再自增）
        await new Promise<void>((resolve) => this.waiters.push(resolve))
        return () => this.release()
    }

    // 释放槽位：优先把槽位移交给队首，否则递减计数
    private release(): void {
        const next = this.waiters.shift()
        if (next) {
            next()
            return
        }
        this.running = Math.max(0, this.running - 1)
    }
}
