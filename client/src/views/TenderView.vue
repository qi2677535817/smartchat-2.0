<script lang="ts" setup>
/**
 * 标书复核页：上传招标 PDF → 自动提取需求条目 → 生成复核界面
 * 流程：POST /tender/documents 上传 → GET /tender/documents/:id/extract（SSE）订阅进度
 */
import { reactive, ref } from 'vue'
import AppIcon from '@/components/AppIcon.vue'

const API_BASE = import.meta.env.VITE_API_BASE ?? '/api'

interface ExtractResult {
    id: string
    downloadUrl: string
    inlineUrl: string
    itemCount: number
    missCount: number
    failedBlocks: number
}

const fileInputRef = ref<HTMLInputElement | null>(null)
const uploading = ref(false)
const extracting = ref(false)
const fileName = ref('')
const errorMsg = ref('')
const result = ref<ExtractResult | null>(null)
const stage = ref('')

const progress = reactive({
    pageCount: 0,
    blockIndex: 0,
    blockTotal: 0,
    itemCount: 0,
})

const pickFile = () => fileInputRef.value?.click()

const handleEvent = (evt: Record<string, unknown>) => {
    switch (evt.type) {
        case 'start':
            progress.pageCount = Number(evt.pageCount ?? 0)
            progress.blockTotal = Number(evt.blockTotal ?? 0)
            progress.blockIndex = 0
            progress.itemCount = 0
            stage.value = '正在逐块提取条目'
            break
        case 'progress':
            progress.blockIndex = Number(evt.blockIndex ?? 0)
            progress.blockTotal = Number(evt.blockTotal ?? progress.blockTotal)
            progress.itemCount = Number(evt.itemCount ?? 0)
            break
        case 'generating':
            stage.value = '正在生成复核界面'
            break
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
        case 'error':
            errorMsg.value = String(evt.message ?? '提取失败')
            stage.value = ''
            break
    }
}

// SSE 订阅（fetch 流式读取，兼容后端 @Sse 输出）
const subscribeExtract = async (id: string) => {
    extracting.value = true
    try {
        const res = await fetch(`${API_BASE}/tender/documents/${id}/extract`)
        if (!res.ok || !res.body) {
            errorMsg.value = `提取请求失败（${res.status}）`
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
                    handleEvent(JSON.parse(trimmed.slice(5).trim()))
                } catch {
                    // 忽略非法行
                }
            }
        }
    } catch (e) {
        errorMsg.value = e instanceof Error ? e.message : String(e)
    } finally {
        extracting.value = false
    }
}

const onFileChange = async (e: Event) => {
    const target = e.target as HTMLInputElement
    const file = target.files?.[0]
    target.value = ''
    if (!file) return
    if (!/\.pdf$/i.test(file.name)) {
        errorMsg.value = '请选择 PDF 文件'
        return
    }

    // 重置状态
    errorMsg.value = ''
    result.value = null
    stage.value = ''
    progress.pageCount = 0
    progress.blockIndex = 0
    progress.blockTotal = 0
    progress.itemCount = 0
    fileName.value = file.name

    // 1) 上传落盘
    uploading.value = true
    try {
        const form = new FormData()
        form.append('file', file)
        const res = await fetch(`${API_BASE}/tender/documents`, { method: 'POST', body: form })
        if (!res.ok) {
            const text = await res.text().catch(() => '')
            errorMsg.value = `上传失败（${res.status}）${text ? '：' + text.slice(0, 120) : ''}`
            return
        }
        const { id } = await res.json()
        uploading.value = false
        // 2) SSE 提取
        await subscribeExtract(id)
    } catch (err) {
        errorMsg.value = err instanceof Error ? err.message : String(err)
    } finally {
        uploading.value = false
    }
}

const percent = () => {
    if (!progress.blockTotal) return 0
    return Math.round((progress.blockIndex / progress.blockTotal) * 100)
}

const reset = () => {
    result.value = null
    errorMsg.value = ''
    fileName.value = ''
    stage.value = ''
}
</script>

<template>
    <div class="tender">
        <!-- 页头 -->
        <div class="page-head">
            <div class="page-head__title">
                <h1>标书复核</h1>
                <p>上传招标文件 PDF，自动提取全部应交材料与资质，生成左右对照的人工复核界面</p>
            </div>
        </div>

        <div class="tender__body">
            <!-- 上传区 -->
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

            <!-- 提取进度 -->
            <div v-if="extracting" class="card progress-card">
                <div class="progress-card__head">
                    <span class="progress-card__file">{{ fileName }}</span>
                    <span class="badge">{{ progress.pageCount }} 页 / {{ progress.blockTotal }} 块</span>
                </div>
                <div class="progress-bar">
                    <div class="progress-bar__fill" :style="{ width: percent() + '%' }"></div>
                </div>
                <div class="progress-card__stats">
                    <span>{{ stage || '准备中' }}</span>
                    <span>已提取 <strong>{{ progress.itemCount }}</strong> 条</span>
                </div>
                <p class="progress-card__hint">整份文档预计 2–5 分钟，请勿关闭页面</p>
            </div>

            <!-- 结果 -->
            <div v-if="result" class="card result-card">
                <div class="result-card__head">
                    <span class="result-card__icon"><AppIcon name="check" :size="20" /></span>
                    <div>
                        <div class="result-card__title">复核界面已生成</div>
                        <div class="result-card__file">{{ fileName }}</div>
                    </div>
                </div>
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

            <!-- 错误 -->
            <div v-if="errorMsg" class="card error-card">
                <span class="error-card__icon"><AppIcon name="alert" :size="18" /></span>
                <span class="error-card__text">{{ errorMsg }}</span>
                <button class="btn" @click="reset">重试</button>
            </div>
        </div>

        <input type="file" ref="fileInputRef" accept=".pdf" style="display:none" @change="onFileChange" />
    </div>
</template>

<style lang="scss" scoped>
.tender {
    height: 100vh;
    overflow-y: auto;
    padding-bottom: var(--sp-8);

    .tender__body {
        max-width: 720px;
        margin: 0 auto;
        padding: 0 var(--sp-8);
        display: flex;
        flex-direction: column;
        gap: var(--sp-4);
    }
}

/* 上传区 */
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

.upload-card__title {
    font-size: 16px;
    font-weight: 600;
    color: var(--ink-900);
}

.upload-card__desc {
    max-width: 46ch;
    margin: 0;
    font-size: 13.5px;
    color: var(--ink-500);
    line-height: 1.7;
}

/* 进度 */
.progress-card {
    padding: var(--sp-5);
}

.progress-card__head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--sp-3);
    margin-bottom: var(--sp-3);
}

.progress-card__file {
    font-size: 14px;
    font-weight: 500;
    color: var(--ink-800);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.progress-bar {
    height: 8px;
    overflow: hidden;
    background: var(--ink-100);
    border-radius: var(--r-full);
}

.progress-bar__fill {
    height: 100%;
    background: linear-gradient(90deg, var(--brand-500), var(--brand-700));
    border-radius: var(--r-full);
    transition: width .4s ease;
}

.progress-card__stats {
    display: flex;
    justify-content: space-between;
    margin-top: var(--sp-3);
    font-size: 13.5px;
    color: var(--ink-600);

    strong {
        color: var(--brand-700);
        font-variant-numeric: tabular-nums;
    }
}

.progress-card__hint {
    margin: var(--sp-2) 0 0;
    font-size: 12px;
    color: var(--ink-400);
}

/* 结果 */
.result-card {
    padding: var(--sp-5);
}

.result-card__head {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
    margin-bottom: var(--sp-5);
}

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

.result-card__title {
    font-size: 15.5px;
    font-weight: 600;
    color: var(--ink-900);
}

.result-card__file {
    font-size: 12.5px;
    color: var(--ink-500);
}

.result-card__stats {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: var(--sp-3);
    padding: var(--sp-4) 0;
    border-top: 1px solid var(--ink-100);
    border-bottom: 1px solid var(--ink-100);
}

.stat {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
}

.stat__num {
    font-size: 22px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    color: var(--ink-900);

    &--warn {
        color: var(--warning);
    }
}

.stat__label {
    font-size: 12px;
    color: var(--ink-500);
    text-align: center;
}

.result-card__actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--sp-2);
    margin-top: var(--sp-5);
}

/* 错误 */
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
