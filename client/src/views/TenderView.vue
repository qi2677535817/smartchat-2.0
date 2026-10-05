<script lang="ts" setup>
/**
 * 标书复核页（Tender Review）
 * 职责：上传招标文件 PDF → 后端解析并逐块提取需求条目 → SSE 实时推送进度 → 生成「左原文 / 右清单」的人工复核界面。
 * 流程：POST /tender/documents 上传落盘 → GET /tender/documents/:id/extract（SSE）订阅/启动提取任务 → 展示结果与入口。
 *
 * 局域网多人加固新增（openspec/changes/harden-lan-multiuser）：
 *   1. 进入页面拉取最近任务，未完成任务可「继续查看进度」——刷新/断线不再丢结果
 *   2. 支持 queued 事件：并发上限已满时提示排队位次
 *   3. 上传错误按 413（超出体积上限）/ 503（服务端解析环境缺失）分流提示
 */
import { onMounted, reactive, ref } from 'vue'
import AppIcon from '@/components/AppIcon.vue'

// 后端接口基础路径：优先取环境变量 VITE_API_BASE，未配置时回退到 /api（由本地或网关代理）
const API_BASE = import.meta.env.VITE_API_BASE ?? '/api'

/**
 * 提取完成后的结果数据（对应 SSE 的 done 事件）
 */
interface ExtractResult {
    id: string            // 文档任务 ID，用于拼接后续预览 / 下载地址
    downloadUrl: string   // 复核界面 HTML 的下载地址（相对路径，渲染时需拼接 API_BASE）
    inlineUrl: string     // 复核界面 HTML 的在线预览地址（相对路径，渲染时需拼接 API_BASE）
    itemCount: number     // 成功提取到的需求条目总数
    missCount: number     // 未能定位到原文的条目数（需人工核查）
    failedBlocks: number  // 提取失败的文本块数量
}

/** 任务摘要（GET /tender/documents 的返回项） */
interface TaskSummary {
    id: string
    filename: string
    status: string
    updatedAt: number | null
}

const fileInputRef = ref<HTMLInputElement | null>(null) // 隐藏的 <input type="file"> 引用，用于代码方式触发选文件
const uploading = ref(false)   // 是否正在上传 PDF（控制上传按钮禁用与文案）
const extracting = ref(false)  // 是否正在 SSE 流式提取（控制上传区 / 进度区的显示切换）
const fileName = ref('')       // 当前处理的文件名（用于进度区与结果区展示）
const errorMsg = ref('')       // 错误提示文案，非空时显示错误卡片
const result = ref<ExtractResult | null>(null) // 提取结果，非空时显示结果卡片
const stage = ref('')          // 当前阶段文案（如「正在逐块提取条目」「正在排队」）
const recentTask = ref<TaskSummary | null>(null) // 未完成的最近任务，用于刷新后「继续查看进度」

// 提取进度（由后端 SSE 事件实时更新）
const progress = reactive({
    pageCount: 0,   // 文档总页数
    blockIndex: 0,  // 当前已处理到的块序号（用于计算百分比）
    blockTotal: 0,  // 文档切分出的总块数
    itemCount: 0,   // 目前已提取的条目数
    ahead: 0,       // 并发排队位次（queued 事件：前面还有几个任务）
})

/** 触发隐藏 file input 的点击，打开系统文件选择框 */
const pickFile = () => fileInputRef.value?.click()

/**
 * SSE 事件分派器：根据事件类型更新进度 / 结果 / 阶段文案
 * @param evt 后端推送的单条事件对象（已 JSON 解析）
 */
const handleEvent = (evt: Record<string, unknown>) => {
    switch (evt.type) {
        // 排队事件：并发上限已满，等待前面任务释放槽位（局域网加固新增）
        case 'queued':
            progress.ahead = Number(evt.ahead ?? 0)
            stage.value = progress.ahead > 0 ? `排队中（前方还有 ${progress.ahead} 个任务）` : '正在排队'
            break
        // 开始事件：初始化页数、总块数，并清零进度
        case 'start':
            progress.pageCount = Number(evt.pageCount ?? 0)
            progress.blockTotal = Number(evt.blockTotal ?? 0)
            progress.blockIndex = 0
            progress.itemCount = 0
            progress.ahead = 0
            stage.value = '正在逐块提取条目'
            break
        // 进度事件：更新当前块、总块数与已提取条目数
        case 'progress':
            progress.blockIndex = Number(evt.blockIndex ?? 0)
            progress.blockTotal = Number(evt.blockTotal ?? 0)
            progress.itemCount = Number(evt.itemCount ?? 0)
            break
        // 生成事件：进入「生成复核界面」阶段
        case 'generating':
            stage.value = '正在生成复核界面'
            break
        // 完成事件：写入结果数据并清空阶段文案
        case 'done':
            result.value = {
                id: String(evt.id ?? ''),
                downloadUrl: String(evt.downloadUrl ?? ''),
                inlineUrl: String(evt.inlineUrl ?? ''),
                itemCount: Number(evt.itemCount ?? 0),
                missCount: Number(evt.missCount ?? 0),
                failedBlocks: Number(evt.failedBlocks ?? 0),
            }
            stage.value = ''
            break
        // 错误事件：记录错误信息并清空阶段文案
        case 'error':
            errorMsg.value = String(evt.message ?? '提取失败')
            stage.value = ''
            break
    }
}

/**
 * 读取后端错误响应文案（Nest 统一返回 { statusCode, message }）
 * @param res 失败响应
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

/**
 * 上传/提取错误分流：413 与 503 给出明确指引，其余原样展示
 * @param status  HTTP 状态码
 * @param message 后端返回的错误文案
 */
const describeError = (status: number, message: string): string => {
    if (status === 413) return message || '文件超过服务器允许的大小上限'
    if (status === 503) {
        return '服务端 PDF 解析环境不可用（缺少 Python 或 pdfplumber），请联系管理员检查部署'
    }
    return `上传失败（${status}）${message ? '：' + message.slice(0, 120) : ''}`
}

// SSE 订阅（fetch 流式读取，兼容后端 @Sse 输出）
/**
 * 建立 SSE 连接并流式读取提取进度
 * 语义为「订阅或启动」：若该任务已驻留则复用（断线重连不重复跑）；
 * 若已完成则后端会立即补发 done 事件，前端无需重新上传。
 * @param id 上传接口返回的文档任务 ID
 */
const subscribeExtract = async (id: string) => {
    extracting.value = true
    try {
        const res = await fetch(`${API_BASE}/tender/documents/${id}/extract`)
        if (!res.ok || !res.body) {
            errorMsg.value = describeError(res.status, await readErrorText(res))
            return
        }
        const reader = res.body.getReader() // 流读取器，逐段读取响应体
        const decoder = new TextDecoder()   // 字节流 → 文本解码器
        let buffer = ''                     // 行缓冲：保留未以 \n 结束的不完整行
        while (true) {
            const { done, value } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })
            const lines = buffer.split('\n') // 按行切分
            buffer = lines.pop() ?? ''       // 最后一段可能不完整，留到下次拼接
            for (const line of lines) {
                const trimmed = line.trim()
                if (!trimmed.startsWith('data:')) continue // 只处理 SSE 的 data 行
                try {
                    handleEvent(JSON.parse(trimmed.slice(5).trim())) // 去掉 "data:" 前缀后解析 JSON
                } catch {
                    // 忽略非法行
                }
            }
        }
    } catch (e) {
        errorMsg.value = e instanceof Error ? e.message : String(e)
    } finally {
        extracting.value = false
        // 任务可能已进入终态，刷新「未完成任务」列表
        void loadRecent()
    }
}

/**
 * 拉取最近任务：若存在未完成任务（queued / extracting / generating），
 * 记录到 recentTask 供用户「继续查看进度」（局域网加固：断线可恢复）
 */
const loadRecent = async () => {
    try {
        const res = await fetch(`${API_BASE}/tender/documents?limit=5`)
        if (!res.ok) return
        const data = (await res.json()) as { items?: TaskSummary[] }
        const unfinished = (data.items ?? []).find(it =>
            ['queued', 'extracting', 'generating'].includes(it.status),
        )
        recentTask.value = unfinished ?? null
    } catch {
        // 列表拉取失败不影响主流程
    }
}

/** 继续订阅已驻留的任务：刷新页面后恢复进度显示 */
const resumeTask = async () => {
    const task = recentTask.value
    if (!task) return
    // 重置前端状态后重新订阅（后端会复用同一任务或补发终态结果）
    recentTask.value = null
    errorMsg.value = ''
    result.value = null
    stage.value = ''
    fileName.value = task.filename
    progress.pageCount = 0
    progress.blockIndex = 0
    progress.blockTotal = 0
    progress.itemCount = 0
    progress.ahead = 0
    await subscribeExtract(task.id)
}

// 进入页面即检查是否有未完成任务（刷新后恢复入口）
onMounted(loadRecent)

/**
 * 文件选择回调：校验类型 → 上传落盘 → 触发 SSE 提取
 * @param e input 的 change 事件
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

    // 重置状态（开始新一轮任务前清空上一次的所有状态）
    errorMsg.value = ''
    result.value = null
    stage.value = ''
    recentTask.value = null
    progress.pageCount = 0
    progress.blockIndex = 0
    progress.blockTotal = 0
    progress.itemCount = 0
    progress.ahead = 0
    fileName.value = file.name

    // 1) 上传落盘
    uploading.value = true
    try {
        const form = new FormData()
        form.append('file', file)
        const res = await fetch(`${API_BASE}/tender/documents`, { method: 'POST', body: form })
        if (!res.ok) {
            // 413（超出上限）/ 503（解析环境缺失）在此分流提示
            errorMsg.value = describeError(res.status, await readErrorText(res))
            return
        }
        const { id } = await res.json()
        uploading.value = false
        // 2) SSE 提取（订阅或启动）
        await subscribeExtract(id)
    } catch (err) {
        errorMsg.value = err instanceof Error ? err.message : String(err)
    } finally {
        uploading.value = false
    }
}

/** 计算提取进度百分比（0-100），总块数为 0 时返回 0 */
const percent = () => {
    if (!progress.blockTotal) return 0
    return Math.round((progress.blockIndex / progress.blockTotal) * 100)
}

/** 重置页面：回到初始上传态（用于「重新上传 / 重试」按钮） */
const reset = () => {
    result.value = null
    errorMsg.value = ''
    fileName.value = ''
    stage.value = ''
    void loadRecent()
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
            <!-- 未完成任务恢复入口：刷新后仍可继续查看进度（局域网加固） -->
            <div v-if="recentTask && !extracting && !result" class="card resume-card">
                <span class="resume-card__icon"><AppIcon name="file" :size="20" /></span>
                <div class="resume-card__body">
                    <div class="resume-card__title">有未完成的提取任务</div>
                    <div class="resume-card__file">{{ recentTask.filename }}</div>
                </div>
                <button class="btn btn-primary" @click="resumeTask">继续查看进度</button>
            </div>

            <!-- 上传区：初始态（未提取且无结果） -->
            <div v-if="!extracting && !result" class="card upload-card" @click="pickFile">
                <span class="upload-card__icon"><AppIcon name="file" :size="26" /></span>
                <div class="upload-card__title">选择招标文件 PDF</div>
                <p class="upload-card__desc">
                    系统将解析全文并逐块提取需求条目，随后自动生成复核界面（左原文 / 右清单 / 点击定位高亮）
                </p>
                <button class="btn btn-primary" :disabled="uploading" @click.stop="pickFile">
                    <AppIcon name="plus" :size="15" />
                    <span>{{ uploading ? '上传中…' : '上传 PDF' }}</span>
                </button>
            </div>

            <!-- 提取进度：extracting 为 true 时显示 -->
            <div v-if="extracting" class="card progress-card">
                <!-- 文件名 + 页数/块数徽标 -->
                <div class="progress-card__head">
                    <span class="progress-card__file">{{ fileName }}</span>
                    <span class="badge">{{ progress.pageCount }} 页 / {{ progress.blockTotal }} 块</span>
                </div>
                <!-- 进度条：宽度由 percent() 计算 -->
                <div class="progress-bar">
                    <div class="progress-bar__fill" :style="{ width: percent() + '%' }"></div>
                </div>
                <!-- 阶段文案 + 已提取条目数 -->
                <div class="progress-card__stats">
                    <span>{{ stage || '准备中' }}</span>
                    <span>已提取 <strong>{{ progress.itemCount }}</strong> 条</span>
                </div>
                <p class="progress-card__hint">整份文档预计 2–5 分钟，请勿关闭页面</p>
            </div>

            <!-- 结果：result 非空时显示 -->
            <div v-if="result" class="card result-card">
                <!-- 结果头部：成功图标 + 标题 + 文件名 -->
                <div class="result-card__head">
                    <span class="result-card__icon"><AppIcon name="check" :size="20" /></span>
                    <div>
                        <div class="result-card__title">复核界面已生成</div>
                        <div class="result-card__file">{{ fileName }}</div>
                    </div>
                </div>
                <!-- 结果统计：提取条目 / 未定位 / 提取失败块（后两项 > 0 时高亮告警色） -->
                <div class="result-card__stats">
                    <div class="stat">
                        <span class="stat__num">{{ result.itemCount }}</span>
                        <span class="stat__label">提取条目</span>
                    </div>
                    <div class="stat">
                        <span class="stat__num" :class="{ 'stat__num--warn': result.missCount > 0 }">
                            {{ result.missCount }}
                        </span>
                        <span class="stat__label">未定位（需人工核查）</span>
                    </div>
                    <div class="stat">
                        <span class="stat__num" :class="{ 'stat__num--warn': result.failedBlocks > 0 }">
                            {{ result.failedBlocks }}
                        </span>
                        <span class="stat__label">提取失败块</span>
                    </div>
                </div>
                <!-- 结果操作：打开复核界面（新窗口）/ 下载 HTML / 重新上传 -->
                <div class="result-card__actions">
                    <a class="btn btn-primary" :href="`${API_BASE}${result.inlineUrl}`" target="_blank" rel="noopener">
                        <AppIcon name="book" :size="15" />
                        <span>打开复核界面</span>
                    </a>
                    <a class="btn" :href="`${API_BASE}${result.downloadUrl}`">
                        <AppIcon name="file" :size="15" />
                        <span>下载 HTML</span>
                    </a>
                    <button class="btn" @click="reset">重新上传</button>
                </div>
            </div>

            <!-- 错误：errorMsg 非空时显示 -->
            <div v-if="errorMsg" class="card error-card">
                <span class="error-card__icon"><AppIcon name="alert" :size="18" /></span>
                <span class="error-card__text">{{ errorMsg }}</span>
                <button class="btn" @click="reset">重试</button>
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

/* 未完成任务恢复卡片 */
.resume-card {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
    padding: var(--sp-4);
}

.resume-card__icon {
    display: grid;
    place-items: center;
    flex: none;
    width: 40px;
    height: 40px;
    color: var(--brand-600);
    background: var(--brand-50);
    border: 1px solid var(--brand-100);
    border-radius: var(--r-md);
}

.resume-card__body {
    flex: 1;
    min-width: 0;
}

.resume-card__title {
    font-size: 14px;
    font-weight: 600;
    color: var(--ink-900);
}

.resume-card__file {
    font-size: 12.5px;
    color: var(--ink-500);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

/* 上传区：整块可点击，纵向居中排列，hover 时高亮边框 */
.upload-card {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--sp-3);
    padding: var(--sp-10) var(--sp-6);
    text-align: center;
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
    width: 56px;
    height: 56px;
    color: var(--brand-600);
    background: var(--brand-50);
    border: 1px solid var(--brand-100);
    border-radius: var(--r-lg);
}

/* 上传区主标题 */
.upload-card__title {
    font-size: 16px;
    font-weight: 600;
    color: var(--ink-900);
}

/* 上传区说明文字：限制行宽提升可读性 */
.upload-card__desc {
    max-width: 46ch;
    margin: 0;
    font-size: 13.5px;
    color: var(--ink-500);
    line-height: 1.7;
}

/* 进度卡片 */
.progress-card {
    padding: var(--sp-5);
}

/* 进度头部：文件名与徽标左右分布 */
.progress-card__head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--sp-3);
    margin-bottom: var(--sp-3);
}

/* 进度区文件名：超长省略号截断 */
.progress-card__file {
    font-size: 14px;
    font-weight: 500;
    color: var(--ink-800);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
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

/* 进度文字行：左侧阶段文案，右侧已提取条目数 */
.progress-card__stats {
    display: flex;
    justify-content: space-between;
    margin-top: var(--sp-3);
    font-size: 13.5px;
    color: var(--ink-600);

    /* 条数数字：品牌色 + 等宽数字避免跳动 */
    strong {
        color: var(--brand-700);
        font-variant-numeric: tabular-nums;
    }
}

/* 进度提示小字 */
.progress-card__hint {
    margin: var(--sp-2) 0 0;
    font-size: 12px;
    color: var(--ink-400);
}

/* 结果卡片 */
.result-card {
    padding: var(--sp-5);
}

/* 结果头部：图标 + 文本 */
.result-card__head {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
    margin-bottom: var(--sp-5);
}

/* 结果成功图标：绿色方块 */
.result-card__icon {
    display: grid;
    place-items: center;
    width: 40px;
    height: 40px;
    color: var(--success);
    background: #f0fdf4;
    border: 1px solid #bbf7d0;
    border-radius: var(--r-md);
}

/* 结果标题 */
.result-card__title {
    font-size: 15.5px;
    font-weight: 600;
    color: var(--ink-900);
}

/* 结果区文件名 */
.result-card__file {
    font-size: 12.5px;
    color: var(--ink-500);
}

/* 结果统计区：三列等分，上下描边分隔 */
.result-card__stats {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: var(--sp-3);
    padding: var(--sp-4) 0;
    border-top: 1px solid var(--ink-100);
    border-bottom: 1px solid var(--ink-100);
}

/* 单个统计项：数字在上、标签在下 */
.stat {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
}

/* 统计数字：大号等宽数字；--warn 修饰符用于告警色 */
.stat__num {
    font-size: 22px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    color: var(--ink-900);

    &--warn {
        color: var(--warning);
    }
}

/* 统计标签 */
.stat__label {
    font-size: 12px;
    color: var(--ink-500);
    text-align: center;
}

/* 结果操作按钮组：自动换行 */
.result-card__actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--sp-2);
    margin-top: var(--sp-5);
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

/* 错误图标：固定不收缩 */
.error-card__icon {
    color: var(--danger);
    flex: none;
}

/* 错误文字：占满剩余宽度 */
.error-card__text {
    flex: 1;
    font-size: 13.5px;
    color: var(--ink-700);
}
</style>
