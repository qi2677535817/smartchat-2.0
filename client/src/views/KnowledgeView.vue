<script lang="ts" setup>
import { useChatStore } from '@/stores/chat';
import { onMounted, ref } from 'vue';
import AppIcon from '@/components/AppIcon.vue';

interface RagData {
    name: string,
    mtime: number,
    chunkCount: number
}
const ragList = ref<RagData[]>([])
const chat = useChatStore()
const folderInputRef = ref<HTMLInputElement | null>(null)

// 后端 API 基址：开发环境走 vite 同源代理（见 .env.development），避免跨域与浏览器安全策略拦截
const API_BASE = import.meta.env.VITE_API_BASE ?? '/api'

const getRagList = () => {
    return fetch(`${API_BASE}/knowledge-base/documents`, {
        method: 'Get'
    })
}
const deleteRag = (name: string) => {
    let ok = window.confirm('你确定要删除本条数据')
    if (ok) {
        fetch(`${API_BASE}/knowledge-base/documents/${encodeURIComponent(name)}`, {
            method: 'Delete'
        }).then(async res => {
            if (res.ok) {
                const data = await res.json()
                if (data.code === 0) {
                    window.alert('删除成功')
                    // 更新列表
                    let _res = await getRagList()
                    if (_res.ok) {
                        ragList.value = [...await _res.json() as RagData[]]
                    }
                } else {
                    window.alert(data.msg)
                }
            }
        })
    }
}
// 触发上传文件
const uploadFile = () => {
    folderInputRef.value?.click()
}
// 上传文件
const onFileChange = async (e: Event) => {
    const target = e.target as HTMLInputElement
    const files = target.files
    if (!files || files.length === 0) return

    // files转数组
    const _files = Array.from(files)
    let content: string = ''
    let name: string = ''
    for (let file of _files) {
        // 知识库仅支持文本文件，PDF 属二进制，file.text() 会读出乱码导致后端海量无效分块
        if (/\.pdf$/i.test(file.name)) {
            window.alert('知识库暂不支持 PDF 直接上传，请先转为 .txt / .md 文本，或使用「标书复核」功能解析 PDF')
            return
        }
        // 读取文本内容
        content = await file.text()
        name = file.name
    }
    chat.waiting = true
    let res = await fetch(`${API_BASE}/knowledge-base/documents`, {
        method: 'Post',
        headers: {
            'Content-type': 'application/json'
        },
        body: JSON.stringify({
            content,
            name
        })
    })
    if (res.ok) {
        let data = await res.json()
        chat.waiting = false
        window.alert(data.msg)
        let _res = await getRagList()
        if (_res.ok) {
            ragList.value = [...await _res.json() as RagData[]]
        }
    }
}
// 统计总块数
const totalChunks = () => ragList.value.reduce((sum, r) => sum + (r.chunkCount || 0), 0)
onMounted(async () => {
    let res = await getRagList()
    if (res.ok) {
        ragList.value = [...await res.json() as RagData[]]
    }
})
</script>

<template>
    <div class="knowledge">
        <!-- 页头 -->
        <div class="page-head">
            <div class="page-head__title">
                <h1>RAG 知识库</h1>
                <p>共 {{ ragList.length }} 份文档 · {{ totalChunks() }} 个知识分块，问答时会据此检索引用</p>
            </div>
            <button class="btn btn-primary" @click="uploadFile" :disabled="chat.waiting">
                <AppIcon name="plus" :size="16" />
                <span>{{ chat.waiting ? '上传中…' : '添加文档' }}</span>
            </button>
        </div>

        <!-- 内容区 -->
        <div class="knowledge__body">
            <div v-if="ragList.length" class="card knowledge__card">
                <table class="knowledge-table">
                    <thead>
                        <tr>
                            <th class="col-name">名称</th>
                            <th class="col-time">修改时间</th>
                            <th class="col-chunk">分块数量</th>
                            <th class="col-act">操作</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr v-for="row in ragList" :key="row.name">
                            <td>
                                <span class="doc-cell">
                                    <span class="doc-cell__icon"><AppIcon name="file" :size="15" /></span>
                                    <span class="doc-cell__name" :title="row.name">{{ row.name }}</span>
                                </span>
                            </td>
                            <td class="num">{{ new Date(row.mtime).toLocaleString() }}</td>
                            <td class="num"><span class="badge">{{ row.chunkCount }}</span></td>
                            <td class="col-act">
                                <button class="btn btn-danger btn-sm" @click="deleteRag(row.name)">
                                    <AppIcon name="trash" :size="13" />
                                    <span>删除</span>
                                </button>
                            </td>
                        </tr>
                    </tbody>
                </table>
            </div>

            <!-- 空状态 -->
            <div v-else class="empty-state knowledge__empty">
                <span class="empty-state__icon"><AppIcon name="database" :size="24" /></span>
                <div class="empty-state__title">知识库还是空的</div>
                <p class="empty-state__desc">上传 .txt / .md / .pdf 文档后，系统会按分块向量化，问答时自动检索并标注引用来源。</p>
                <button class="btn btn-primary" @click="uploadFile" :disabled="chat.waiting">
                    <AppIcon name="paperclip" :size="15" />
                    <span>上传第一份文档</span>
                </button>
            </div>
        </div>

        <input type="file" ref="folderInputRef" accept=".txt,.md" style="display:none"
            @change="onFileChange"></input>
    </div>
</template>

<style lang="scss" scoped>
.knowledge {
    height: 100vh;
    overflow-y: auto;
    padding-bottom: var(--sp-8);

    .knowledge__body {
        max-width: var(--content-max);
        margin: 0 auto;
        padding: 0 var(--sp-8);
    }

    .knowledge__card {
        overflow: hidden;
    }

    .knowledge__empty {
        max-width: 560px;
        margin: var(--sp-10) auto;
    }
}

.knowledge-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 14px;

    th {
        padding: 12px 16px;
        font-size: 12.5px;
        font-weight: 600;
        text-align: left;
        color: var(--ink-500);
        background: var(--ink-50);
        border-bottom: 1px solid var(--ink-200);
    }

    td {
        padding: 12px 16px;
        border-bottom: 1px solid var(--ink-100);
        vertical-align: middle;
    }

    tbody tr {
        transition: background .14s ease;

        &:hover {
            background: var(--ink-50);
        }

        &:last-child td {
            border-bottom: none;
        }
    }

    .col-time {
        width: 220px;
    }

    .col-chunk {
        width: 120px;
    }

    .col-act {
        width: 110px;
        text-align: right;
    }

    .num {
        font-variant-numeric: tabular-nums;
        color: var(--ink-600);
    }
}

.doc-cell {
    display: inline-flex;
    align-items: center;
    gap: var(--sp-2);
    max-width: 100%;
}

.doc-cell__icon {
    display: grid;
    place-items: center;
    width: 30px;
    height: 30px;
    flex: none;
    color: var(--brand-600);
    background: var(--brand-50);
    border: 1px solid var(--brand-100);
    border-radius: var(--r-sm);
}

.doc-cell__name {
    font-weight: 500;
    color: var(--ink-800);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.btn-sm {
    padding: 5px 10px;
    font-size: 13px;
}
</style>
