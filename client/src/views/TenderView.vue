<script lang="ts" setup>
/**
 * 标书复核页（Tender Review）
 *
 * 职责：上传招标文件 PDF → 后端解析并逐块提取需求条目 → 生成「左原文 / 右清单」的人工复核界面。
 *
 * 局域网多人加固（openspec/changes/harden-lan-multiuser）：
 *   1. 任务列表视图：可同时提交多个任务，各自独立订阅与显示进度（不再互相"覆盖"）
 *   2. 每个任务独立 SSE 订阅：刷新页面后自动恢复进行中任务的进度
 *   3. queued 事件：并发上限已满时显示排队位次
 *   4. 手动取消：进行中任务可取消（协作式，在下一个检查点停止）
 *   5. 错误按 413（超出体积上限）/ 503（服务端解析环境缺失）分流提示
 */
import { onMounted, onUnmounted, ref } from 'vue'
import AppIcon from '@/components/AppIcon.vue'

// 后端接口基础路径：优先取环境变量 VITE_API_BASE，未配置时回退到 /api（由本地或网关代理）
const API_BASE = import.meta.env.VITE_API_BASE ?? '/api'

/** 服务端任务摘要（GET /tender/documents 返回项） */
interface ServerTask {
    id: string
    filename: string
    status: string
    itemCount: number | null
    missCount: number | null
    failedBlocks: number | null
    errorMsg: string | null
    updatedAt: number | null
    downloadUrl?: string
    inlineUrl?: string
}

/** 前端任务视图模型（服务端字段 + 本地实时进度） */
interface TaskItem extends ServerTask {
    pageCount: number      // 文档总页数
    blockIndex: number     // 已处理块序号
    blockTotal: number     // 总块数
    liveItemCount: number  // 实时已提取条目数
    ahead: number          // 并发排队位次
    stage: string          // 阶段文案
    cancelling?: boolean   // 已发起取消、等待任务在检查点停止
}

// 进行中（非终态）的状态集合
const RUNNING_STATUS = ['uploaded', 'queued', 'extracting', 'generating']

// 状态 → 展示文案
const STATUS_LABEL: Record<string, string> = {
    uploaded: '待提取',
    queued: '排队中',
    extracting: '提取中',
    generating: '生成中',
    done: '已完成',
    failed: '失败',
    cancelled: '已取消',
}

const fileInputRef = ref<HTMLInputElement | null>(null) // 隐藏的 file input
const uploading = ref(false)   // 是否正在上传
const errorMsg = ref('')       // 全局错误提示（上传失败等）
const tasks = ref<TaskItem[]>([]) // 任务列表（多个任务并存，互不影响）

// 每个任务一个 SSE 订阅控制器，key = 任务 id
const subs = new Map<string, AbortController>()

/** 触发隐藏 file input 的点击 */
const pickFile = () => fileInputRef.value?.click()

/** 是否处于进行中状态（需要订阅 SSE） */
const isRunning = (status: string) => RUNNING_STATUS.includes(status)

/** 状态展示文案 */
const statusLabel = (s: string) => STATUS_LABEL[s] ?? s

/** 状态徽标样式 */
const badgeClass = (s: string) => ({
    'badge--running': isRunning(s),
    'badge--done': s === 'done',
    'badge--failed': s === 'failed',
    'badge--cancelled': s === 'cancelled',
})

/** 进度百分比 */
const percentOf = (t: TaskItem) => {
    if (!t.blockTotal) return 0
    return Math.round((t.blockIndex / t.blockTotal) * 100)
}

/** 服务端摘要 → 前端任务项（补齐本地进度字段） */
const blankTask = (s: ServerTask, prev?: TaskItem): TaskItem => ({
    ...s,
    pageCount: prev?.pageCount ?? 0,
    blockIndex: prev?.blockIndex ?? 0,
    blockTotal: prev?.blockTotal ?? 0,
    liveItemCount: prev?.liveItemCount ?? 0,
    ahead: prev?.ahead ?? 0,
    stage: prev?.stage ?? '',
    cancelling: prev?.cancelling ?? false,
})

/** 局部更新某个任务（不重建数组，避免进度闪烁） */
const patchTask = (id: string, patch: Partial<TaskItem>) => {
    const t = tasks.value.find(x => x.id === id)
    if (t) Object.assign(t, patch)
}

/**
 * 读取后端错误响应文案（Nest 统一返回 { statusCode, message }）
 */
const readErrorText = async (res: Response): Promise<string> => {
    const raw = await res.text().catch(() => '')
    try {
        const body = JSON.parse(raw) as { message?: string | string[] }
        if (body?.message) {
            return Array.isArray(body.message) ? body.message.join('；') : body.message
        }
    } catch {
        // 非 JSON 响应，原样返回
    }
    return raw
}

/** 错误分流：413 超限 / 503 环境缺失 给出明确指引 */
const describeError = (status: number, message: string): string => {
    if (status === 413) return message || '文件超过服务器允许的大小上限'
    if (status === 503) {
        return '服务端 PDF 解析环境不可用（缺少 Python 或 pdfplumber），请联系管理员检查部署'
    }
    return `请求失败（${status}）${message ? '：' + message.slice(0, 120) : ''}`
}

/** SSE 事件 → 更新对应任务的进度（多任务各自独立） */
const applyEvent = (id: string, evt: Record<string, unknown>) => {
    switch (evt.type) {
        case 'queued': {
            const ahead = Number(evt.ahead ?? 0)
            patchTask(id, {
                status: 'queued',
                ahead,
                stage: ahead > 0 ? `排队中（前方还有 ${ahead} 个任务）` : '正在排队',
            })
            break
        }
        case 'start':
            patchTask(id, {
                status: 'extracting',
                pageCount: Number(evt.pageCount ?? 0),
                blockTotal: Number(evt.blockTotal ?? 0),
                blockIndex: 0,
                liveItemCount: 0,
                stage: '正在逐块提取条目',
            })
            break
        case 'progress':
            patchTask(id, {
                blockIndex: Number(evt.blockIndex ?? 0),
                blockTotal: Number(evt.blockTotal ?? 0),
                liveItemCount: Number(evt.itemCount ?? 0),
            })
            break
        case 'generating':
            patchTask(id, { status: 'generating', stage: '正在生成复核界面' })
            break
        case 'done':
            patchTask(id, {
                status: 'done',
                itemCount: Number(evt.itemCount ?? 0),
                missCount: Number(evt.missCount ?? 0),
                failedBlocks: Number(evt.failedBlocks ?? 0),
                downloadUrl: String(evt.downloadUrl ?? ''),
                inlineUrl: String(evt.inlineUrl ?? ''),
                stage: '',
                cancelling: false,
            })
            break
        case 'cancelled':
            patchTask(id, { status: 'cancelled', stage: '', cancelling: false })
            break
        case 'error':
            patchTask(id, {
                status: 'failed',
                errorMsg: String(evt.message ?? '提取失败'),
                stage: '',
                cancelling: false,
            })
            break
    }
}

/**
 * 订阅单个任务的提取进度（幂等：同一 id 只保留一个连接）
 * 语义为「订阅或启动」：任务已驻留则复用；已完成则后端立即补发终态
 */
const subscribe = async (id: string) => {
    if (subs.has(id)) return
    const controller = new AbortController()
    subs.set(id, controller)
    try {
        const res = await fetch(`${API_BASE}/tender/documents/${id}/extract`, {
            signal: controller.signal,
        })
        if (!res.ok || !res.body) {
            patchTask(id, { status: 'failed', errorMsg: describeError(res.status, await readErrorText(res)) })
            return
        }
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        while (true) {
            const { done, value } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })
            const lines = buffer.split('\n')
            buffer = lines.pop() ?? ''
            for (const line of lines) {
                const trimmed = line.trim()
                if (!trimmed.startsWith('data:')) continue
                try {
                    applyEvent(id, JSON.parse(trimmed.slice(5).trim()))
                } catch {
                    // 忽略非法行
                }
            }
        }
    } catch (e) {
        // 组件卸载导致的中断不视为失败
        if ((e as Error)?.name !== 'AbortError') {
            patchTask(id, { status: 'failed', errorMsg: e instanceof Error ? e.message : String(e) })
        }
    } finally {
        subs.delete(id)
        // 连接结束（完成/失败/取消/排队等待）后与后端对齐一次状态
        void loadTasks()
    }
}

/** 拉取任务列表，并自动订阅所有进行中的任务（刷新后恢复进度的关键） */
const loadTasks = async () => {
    try {
        const res = await fetch(`${API_BASE}/tender/documents?limit=20`)
        if (!res.ok) return
        const data = (await res.json()) as { items?: ServerTask[] }
        // 合并：保留本地已有的实时进度，避免列表刷新导致进度跳动
        tasks.value = (data.items ?? []).map(s =>
            blankTask(s, tasks.value.find(t => t.id === s.id)),
        )
        for (const t of tasks.value) {
            if (isRunning(t.status)) void subscribe(t.id)
        }
    } catch {
        // 列表拉取失败不影响主流程
    }
}

/**
 * 取消任务（协作式）
 * 后端立即落库为 cancelled，后台任务在下一个检查点停止；
 * 因此点击后按钮进入「取消中…」，直到收到 cancelled 事件或刷新列表
 */
const cancelTask = async (t: TaskItem) => {
    if (t.cancelling) return
    patchTask(t.id, { cancelling: true })
    try {
        const res = await fetch(`${API_BASE}/tender/documents/${t.id}/cancel`, { method: 'POST' })
        if (!res.ok) {
            patchTask(t.id, { cancelling: false })
            errorMsg.value = describeError(res.status, await readErrorText(res))
            return
        }
        // 后端已落库，先本地标记；SSE 随后会推送 cancelled 事件
        patchTask(t.id, { status: 'cancelled', stage: '', cancelling: false })
    } catch (e) {
        patchTask(t.id, { cancelling: false })
        errorMsg.value = e instanceof Error ? e.message : String(e)
    }
}

/**
 * 删除任务及其磁盘产物（不可恢复）
 * 进行中任务由后端先取消再删除；前端同时断开订阅并本地移除，避免残留连接
 */
const deleteTask = async (t: TaskItem) => {
    const running = isRunning(t.status)
    const tip = running
        ? `任务「${t.filename}」正在进行，删除将同时取消它。确定继续？`
        : `确定删除任务「${t.filename}」及其产物？此操作不可恢复。`
    if (!window.confirm(tip)) return
    try {
        const res = await fetch(`${API_BASE}/tender/documents/${t.id}`, { method: 'DELETE' })
        // 404 视为已删除，同样从列表移除
        if (!res.ok && res.status !== 404) {
            errorMsg.value = describeError(res.status, await readErrorText(res))
            return
        }
        subs.get(t.id)?.abort()
        subs.delete(t.id)
        tasks.value = tasks.value.filter(x => x.id !== t.id)
    } catch (e) {
        errorMsg.value = e instanceof Error ? e.message : String(e)
    }
}

onMounted(loadTasks)

// 离开页面时断开所有 SSE 连接（任务在后端继续执行，结果不丢）
onUnmounted(() => {
    for (const c of subs.values()) c.abort()
    subs.clear()
})

/**
 * 文件选择回调：校验类型 → 上传 → 新任务入列表并订阅（不影响其他任务）
 */
const onFileChange = async (e: Event) => {
    const target = e.target as HTMLInputElement
    const file = target.files?.[0]
    target.value = '' // 清空 input 值，保证同一文件可再次触发 change
    if (!file) return
    if (!/\.pdf$/i.test(file.name)) {
        errorMsg.value = '请选择 PDF 文件'
        return
    }

    errorMsg.value = ''
    uploading.value = true
    try {
        const form = new FormData()
        form.append('file', file)
        const res = await fetch(`${API_BASE}/tender/documents`, { method: 'POST', body: form })
        if (!res.ok) {
            errorMsg.value = describeError(res.status, await readErrorText(res))
            return
        }
        const { id, filename } = (await res.json()) as { id: string; filename: string }
        // 新任务插入列表顶部并订阅；已有任务保持原样继续推进（并行）
        tasks.value.unshift(
            blankTask({
                id,
                filename,
                status: 'extracting',
                itemCount: null,
                missCount: null,
                failedBlocks: null,
                errorMsg: null,
                updatedAt: Date.now(),
            }),
        )
        patchTask(id, { stage: '正在提交提取…' })
        await subscribe(id)
    } catch (err) {
        errorMsg.value = err instanceof Error ? err.message : String(err)
    } finally {
        uploading.value = false
    }
}
</script>

<template>
    <div class="tender">
        <!-- 页头：标题与一句话说明 -->
        <div class="page-head">
            <div class="page-head__title">
                <h1>标书复核</h1>
                <p>上传招标文件 PDF，自动提取全部应交材料与资质，生成左右对照的人工复核界面</p>
            </div>
        </div>

        <div class="tender__body">
            <!-- 上传区：始终可用，支持同时提交多个任务 -->
            <div class="card upload-card" @click="pickFile">
                <span class="upload-card__icon"><AppIcon name="file" :size="24" /></span>
                <div class="upload-card__text">
                    <div class="upload-card__title">选择招标文件 PDF</div>
                    <p class="upload-card__desc">
                        可同时提交多个任务：最多 2 个并行执行，超出的自动排队，互不覆盖
                    </p>
                </div>
                <button class="btn btn-primary" :disabled="uploading" @click.stop="pickFile">
                    <AppIcon name="plus" :size="15" />
                    <span>{{ uploading ? '上传中…' : '上传 PDF' }}</span>
                </button>
            </div>

            <!-- 全局错误（上传失败等） -->
            <div v-if="errorMsg" class="card error-card">
                <span class="error-card__icon"><AppIcon name="alert" :size="18" /></span>
                <span class="error-card__text">{{ errorMsg }}</span>
                <button class="btn" @click="errorMsg = ''">关闭</button>
            </div>

            <!-- 任务列表 -->
            <div v-if="tasks.length" class="task-list">
                <div class="task-list__head">提取任务（{{ tasks.length }}）</div>

                <div v-for="t in tasks" :key="t.id" class="card task-item">
                    <!-- 任务头部：文件名 + 状态徽标 + 删除 -->
                    <div class="task-item__head">
                        <span class="task-item__file">{{ t.filename }}</span>
                        <div class="task-item__head-right">
                            <span class="badge" :class="badgeClass(t.status)">{{ statusLabel(t.status) }}</span>
                            <button class="task-item__del" title="删除任务及其产物" @click="deleteTask(t)">删除</button>
                        </div>
                    </div>

                    <!-- 进行中：进度条 + 阶段文案 + 实时条目数 + 取消按钮 -->
                    <template v-if="isRunning(t.status)">
                        <div class="progress-bar">
                            <div class="progress-bar__fill" :style="{ width: percentOf(t) + '%' }"></div>
                        </div>
                        <div class="task-item__stats">
                            <span>{{ t.stage || '准备中' }}</span>
                            <span>已提取 <strong>{{ t.liveItemCount }}</strong> 条</span>
                        </div>
                        <div class="task-item__foot">
                            <span class="task-item__hint">
                                页数 {{ t.pageCount }} · 进度 {{ t.blockIndex }}/{{ t.blockTotal }} 块
                            </span>
                            <button class="btn" :disabled="t.cancelling" @click="cancelTask(t)">
                                {{ t.cancelling ? '取消中…' : '取消任务' }}
                            </button>
                        </div>
                    </template>

                    <!-- 已完成：统计 + 操作入口 -->
                    <template v-else-if="t.status === 'done'">
                        <div class="task-item__stats">
                            <span>提取条目 <strong>{{ t.itemCount ?? 0 }}</strong></span>
                            <span :class="{ 'is-warn': (t.missCount ?? 0) > 0 }">未定位 {{ t.missCount ?? 0 }}</span>
                            <span :class="{ 'is-warn': (t.failedBlocks ?? 0) > 0 }">失败块 {{ t.failedBlocks ?? 0 }}</span>
                        </div>
                        <div class="task-item__actions">
                            <a class="btn btn-primary" :href="`${API_BASE}${t.inlineUrl}`" target="_blank" rel="noopener">
                                <AppIcon name="book" :size="15" />
                                <span>打开复核界面</span>
                            </a>
                            <a class="btn" :href="`${API_BASE}${t.downloadUrl}`">
                                <AppIcon name="file" :size="15" />
                                <span>下载 HTML</span>
                            </a>
                        </div>
                    </template>

                    <!-- 已取消 -->
                    <template v-else-if="t.status === 'cancelled'">
                        <div class="task-item__muted">任务已取消（已提取的内容未保留）</div>
                    </template>

                    <!-- 失败：错误原因 -->
                    <template v-else-if="t.status === 'failed'">
                        <div class="task-item__error">{{ t.errorMsg || '提取失败' }}</div>
                    </template>
                </div>
            </div>
        </div>

        <!-- 隐藏的文件选择框：仅接受 PDF，由 pickFile 触发 -->
        <input type="file" ref="fileInputRef" accept=".pdf" style="display:none" @change="onFileChange" />
    </div>
</template>

<style lang="scss" scoped>
/* 页面根容器：占满视口高度，内容超出时可滚动 */
.tender {
    height: 100vh;
    overflow-y: auto;
    padding-bottom: var(--sp-8);

    /* 内容区：居中限宽，各卡片纵向排列并留间距 */
    .tender__body {
        max-width: 720px;
        margin: 0 auto;
        padding: 0 var(--sp-8);
        display: flex;
        flex-direction: column;
        gap: var(--sp-4);
    }
}

/* 上传区：一行式紧凑布局，整块可点击 */
.upload-card {
    display: flex;
    align-items: center;
    gap: var(--sp-4);
    padding: var(--sp-4) var(--sp-5);
    cursor: pointer;
    transition: border-color .18s ease, box-shadow .18s ease;

    &:hover {
        border-color: var(--brand-500);
        box-shadow: var(--shadow-md);
    }
}

/* 上传区图标容器：品牌色方块 */
.upload-card__icon {
    display: grid;
    place-items: center;
    flex: none;
    width: 44px;
    height: 44px;
    color: var(--brand-600);
    background: var(--brand-50);
    border: 1px solid var(--brand-100);
    border-radius: var(--r-md);
}

.upload-card__text {
    flex: 1;
    min-width: 0;
}

.upload-card__title {
    font-size: 15px;
    font-weight: 600;
    color: var(--ink-900);
}

.upload-card__desc {
    margin: 2px 0 0;
    font-size: 12.5px;
    color: var(--ink-500);
    line-height: 1.6;
}

/* 任务列表 */
.task-list {
    display: flex;
    flex-direction: column;
    gap: var(--sp-3);
}

.task-list__head {
    font-size: 13px;
    font-weight: 600;
    color: var(--ink-600);
}

/* 单个任务卡片 */
.task-item {
    padding: var(--sp-4);
}

.task-item__head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--sp-3);
    margin-bottom: var(--sp-3);
}

/* 任务文件名：超长省略号截断 */
.task-item__file {
    font-size: 14px;
    font-weight: 500;
    color: var(--ink-800);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

/* 头部右侧：状态徽标 + 删除按钮 */
.task-item__head-right {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    flex: none;
}

/* 删除按钮：低调样式，hover 时转为危险色 */
.task-item__del {
    padding: 2px 8px;
    font-size: 12px;
    line-height: 1.6;
    color: var(--ink-500);
    background: transparent;
    border: 1px solid var(--ink-100);
    border-radius: 6px;
    cursor: pointer;
    transition: color .15s ease, border-color .15s ease;

    &:hover {
        color: var(--danger);
        border-color: #fecaca;
    }
}

/* 状态徽标修饰符（.badge 为全局样式） */
.badge--running {
    color: var(--brand-700);
    background: var(--brand-50);
    border-color: var(--brand-100);
}

.badge--done {
    color: var(--success);
    background: #f0fdf4;
    border-color: #bbf7d0;
}

.badge--failed {
    color: var(--danger);
    background: var(--danger-soft);
    border-color: #fecaca;
}

.badge--cancelled {
    color: var(--ink-600);
    background: var(--ink-100);
    border-color: var(--ink-100);
}

/* 进度条轨道 */
.progress-bar {
    height: 8px;
    overflow: hidden;
    background: var(--ink-100);
    border-radius: var(--r-full);
}

/* 进度条填充：品牌渐变色，宽度过渡动画 */
.progress-bar__fill {
    height: 100%;
    background: linear-gradient(90deg, var(--brand-500), var(--brand-700));
    border-radius: var(--r-full);
    transition: width .4s ease;
}

/* 任务统计行：阶段文案与实时条目数 */
.task-item__stats {
    display: flex;
    justify-content: space-between;
    gap: var(--sp-3);
    margin-top: var(--sp-3);
    font-size: 13px;
    color: var(--ink-600);

    strong {
        color: var(--brand-700);
        font-variant-numeric: tabular-nums;
    }

    /* 需要人工关注的指标用告警色 */
    .is-warn {
        color: var(--warning);
    }
}

/* 进度行底部：左侧细节提示，右侧取消按钮 */
.task-item__foot {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--sp-3);
    margin-top: var(--sp-2);
}

.task-item__hint {
    font-size: 12px;
    color: var(--ink-400);
}

/* 已取消的说明文字 */
.task-item__muted {
    font-size: 13px;
    color: var(--ink-500);
}

/* 失败原因 */
.task-item__error {
    font-size: 13px;
    color: var(--danger);
    line-height: 1.6;
}

/* 任务操作按钮组 */
.task-item__actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--sp-2);
    margin-top: var(--sp-3);
}

/* 错误卡片：红色描边 + 浅红背景 */
.error-card {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
    padding: var(--sp-4);
    border-color: #fecaca;
    background: var(--danger-soft);
}

.error-card__icon {
    color: var(--danger);
    flex: none;
}

.error-card__text {
    flex: 1;
    font-size: 13.5px;
    color: var(--ink-700);
}
</style>
