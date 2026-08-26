<script lang="ts" setup>
import { useChatStore } from '@/stores/chat';
import { onMounted, reactive, ref } from 'vue';
interface RagData {
    name: string,
    mtime: number,
    chunkCount: number
}
const ragList = ref<RagData[]>([])
const chat = useChatStore()
const folderInputRef = ref<HTMLInputElement | null>(null)

const getRagList = () => {
    return fetch('http://localhost:3000/knowledge-base/documents', {
        method: 'Get'
    })
}
const deleteRag = (name: string) => {
    let ok = window.confirm('你确定要删除本条数据')
    if (ok) {
        fetch('http://localhost:3000/knowledge-base/documents/' + name, {
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
        // 读取文本内容
        content = await file.text()
        name = file.name
    }
    chat.waiting = true
    let res = await fetch('http://localhost:3000/knowledge-base/documents', {
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
onMounted(async () => {
    let res = await getRagList()
    if (res.ok) {
        ragList.value = [...await res.json() as RagData[]]
    }
})
</script>
<template>
    <div class="knowLedge-box">
        <div class="nav-menu">
            <div class="add-btn" @click="uploadFile" :disabled="chat.waiting">{{ chat.waiting ? '上传中' : '添加+' }}</div>
        </div>
        <table class="knowledge-table">
            <thead>
                <tr>
                    <th>名称</th>
                    <th>修改时间</th>
                    <th>分块数量</th>
                    <th>操作</th>
                </tr>
            </thead>
            <tbody>
                <tr v-for="row in ragList" :key="row.name">
                    <td>{{ row.name }}</td>
                    <td>{{ new Date(row.mtime).toLocaleString() }}</td>
                    <td>{{ row.chunkCount }}</td>
                    <td @click="deleteRag(row.name)" class="delete">删除</td>
                </tr>
            </tbody>
        </table>
        <input type="file" ref="folderInputRef" accept=".txt,.md,.pdf" style="display:none"
            @change="onFileChange"></input>
    </div>
</template>
<style lang="scss">
.nav-menu {
    display: flex;
    align-items: center;
    padding: 10px;
}

.knowledge-table {
    width: 100%;
    border-collapse: collapse;
}

.knowledge-table th,
.knowledge-table td {
    border: 1px solid #e5e7eb;
    padding: 8px 12px;
    text-align: center;
}

.delete {
    cursor: pointer;
}

.add-btn {
    background: #2e91ed;
    color: #fff;
    padding: 5px 15px;
    border-radius: 5px;
    cursor: pointer;
}
</style>