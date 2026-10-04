import { Injectable, Logger } from "@nestjs/common";
import * as path from "node:path";
import { ChatService } from "../chat/chat.service";
import { PythonPipelineService } from "../pdf-pipeline/python-pipeline.service";
import {
    submitRequirementsTool,
    createSubmitRequirementsHandler,
    RequirementItem,
} from "../chat/tools/submit-requirements.tool";
import { EXTRACTION_SYSTEM_PROMPT } from "./tender-extraction.prompt";

// 分块：每块页数与块间重叠页数（方案 A：固定分块 + 六区域视角）
const PAGES_PER_BLOCK = 15
const OVERLAP_PAGES = 1

interface PageText {
    pno: number
    text: string
}

@Injectable()
export class TenderExtractionService {
    private readonly logger = new Logger(TenderExtractionService.name)

    constructor(
        private readonly pipeline: PythonPipelineService,
        private readonly chatService: ChatService,
    ) {}

    /**
     * 提取条目：分页 → 分块 → 逐块 FC 提取 → 全局去重
     *
     * @param pdfPath    PDF 路径
     * @param workDir    工作目录（pages.json 落盘位置）
     * @param model      模型名
     * @param callbacks  onStart（分页分块完成）、onProgress（每块完成）
     */
    async extract(
        pdfPath: string,
        workDir: string,
        model: string,
        callbacks: {
            onStart?: (pageCount: number, blockTotal: number) => void
            onProgress?: (blockIndex: number, blockTotal: number, itemCount: number) => void
        } = {},
    ): Promise<{ items: RequirementItem[]; failedBlocks: number }> {
        const pagesPath = path.join(workDir, "pages.json")
        const { pageCount, pages } = await this.pipeline.extractPages(pdfPath, pagesPath)
        if (!pages || pages.length === 0) {
            throw new Error("PDF 无可提取文本（可能是扫描件）")
        }

        const blocks = this.buildBlocks(pages, PAGES_PER_BLOCK, OVERLAP_PAGES)
        this.logger.log(`提取开始：${pageCount} 页 → ${blocks.length} 块`)
        callbacks.onStart?.(pageCount, blocks.length)

        const all: RequirementItem[] = []
        let failedBlocks = 0
        for (let i = 0; i < blocks.length; i++) {
            const text = blocks[i].map(p => p.text).join("\n")
            try {
                const items = await this.extractBlock(text, model)
                all.push(...items)
                this.logger.log(`第 ${i + 1}/${blocks.length} 块：${items.length} 条`)
            } catch (e) {
                // 单块失败不中断整体（design 降级方案）
                failedBlocks++
                this.logger.error(`第 ${i + 1}/${blocks.length} 块提取失败：${e instanceof Error ? e.message : String(e)}`)
            }
            callbacks.onProgress?.(i + 1, blocks.length, all.length)
        }

        const deduped = this.dedupe(all)
        this.logger.log(`去重：${all.length} → ${deduped.length} 条，失败块 ${failedBlocks}`)
        return { items: deduped, failedBlocks }
    }

    // 分块：每 size 页一块，块间重叠 overlap 页（避免边界句子被切断）
    private buildBlocks(pages: PageText[], size: number, overlap: number): PageText[][] {
        const blocks: PageText[][] = []
        let start = 0
        while (start < pages.length) {
            const end = Math.min(start + size, pages.length)
            blocks.push(pages.slice(start, end))
            if (end >= pages.length) break
            start = end - overlap
        }
        return blocks
    }

    // 单块提取：复用 chat 模块的 FC 循环，通过 submit_requirements 提交
    // 注意：思考模式（reasoning 模型）不支持 tool_choice='required'，只能使用 'auto'，
    // 因此在 system prompt 中硬性要求"必须调用工具"，并在未调用时记录告警。
    private async extractBlock(text: string, model: string): Promise<RequirementItem[]> {
        const collected: RequirementItem[] = []
        const handler = createSubmitRequirementsHandler(items => collected.push(...items))
        const message = await this.chatService.runToolLoop(
            [
                { role: 'system', content: EXTRACTION_SYSTEM_PROMPT },
                { role: 'user', content: text },
            ],
            model,
            [submitRequirementsTool] as never,
            { submit_requirements: handler },
            'auto',
        )
        if (collected.length === 0) {
            // 模型未调用工具（可能直接以文本作答），记录以便排查提示词效果
            this.logger.warn(
                `本块未通过工具提交条目；模型回复片段：${typeof message?.content === 'string' ? message.content.slice(0, 200) : '(空)'}`,
            )
        }
        return collected
    }

    /**
     * 全局去重：
     * 1) anchor 归一化相同 → 合并
     * 2) name 归一化相同或互为包含 → 视为同一材料合并
     * 3) 合并时 origin 去重拼接、level 取最严、form 合并、quote 取更长
     * 4) 限定条件（年份/份数）冲突 → 不合并（铁律三：不许抹平差异）
     */
    private dedupe(items: RequirementItem[]): RequirementItem[] {
        const norm = (s: string) => (s ?? '').replace(/\s+/g, '').toLowerCase()
        const levelRank: Record<string, number> = { '强制': 3, '评分': 2, '待确认': 1 }

        // 提取限定词（年/份/月）
        const limitsOf = (s: string): Set<string> => {
            const out = new Set<string>()
            const patterns = [
                /近\s*[一二三四五六七八九十\d]+\s*年/g,
                /[一二三四五六七八九十\d]+\s*份/g,
                /[一二三四五六七八九十\d]+\s*个?\s*月/g,
            ]
            for (const p of patterns) {
                for (const m of (s ?? '').match(p) ?? []) out.add(norm(m))
            }
            return out
        }
        const limitsConflict = (a: string, b: string): boolean => {
            const la = limitsOf(a)
            const lb = limitsOf(b)
            if (la.size === 0 || lb.size === 0) return false
            for (const x of la) if (!lb.has(x)) return true
            for (const y of lb) if (!la.has(y)) return true
            return false
        }

        const merged: RequirementItem[] = []
        for (const it of items) {
            const anchorKey = norm(it.anchor)
            const nameKey = norm(it.name)
            // 候选：anchor 相同，或 name 相同/互为包含
            const target = merged.find(m => {
                if (anchorKey && norm(m.anchor) === anchorKey) {
                    return !limitsConflict(m.quote + m.form, it.quote + it.form)
                }
                const mn = norm(m.name)
                const sameName = mn === nameKey || mn.includes(nameKey) || nameKey.includes(mn)
                if (!sameName) return false
                return !limitsConflict(m.quote + m.form, it.quote + it.form)
            })

            if (!target) {
                merged.push({ ...it })
                continue
            }

            // 合并
            if (it.origin && !target.origin.includes(it.origin)) {
                target.origin = target.origin ? `${target.origin}；${it.origin}` : it.origin
            }
            if ((levelRank[it.level] ?? 0) > (levelRank[target.level] ?? 0)) {
                target.level = it.level
            }
            if (it.form && it.form !== target.form && !target.form.includes(it.form)) {
                target.form = target.form ? `${target.form}；${it.form}` : it.form
            }
            if (it.quote.length > target.quote.length) {
                target.quote = it.quote
            }
        }
        return merged
    }
}
