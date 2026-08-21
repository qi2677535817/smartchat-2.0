import { ref, reactive, watch } from "vue";
import { defineStore } from "pinia";
import { renderMarkdown } from '@/utils/markdown'

interface Message {
    content: string
    role: 'user' | 'assistant',
    reasoning_content?: string,
    showReasoning?: boolean,
    renderedHtml?: string,
    reasoningHtml?: string,
    citations?: [{
        name: string,
        index: number
    }]
}

export const userChatStore = defineStore('chat', () => {
    const message = ref('')
    const messageList = reactive<Message[]>([])
    const waiting = ref(false)
    const showLLM = ref(false)
    const llmList = ref([
        {
            name: "deepseek-v4-flash",
            icon: "https://deepseek.ai/static/media/deepseek-v4-flash.7e0f3c1d.png"
        },
        {
            name: "deepseek-v4-pro",
            icon: "https://deepseek.ai/static/media/deepseek-v4-pro.7e0f3c1d.png"
        }
    ])
    const llmModel = reactive({
        name: llmList.value[0]!.name,
        icon: llmList.value[0]!.icon
    })

    let abortController: AbortController | null = null
    const sendMessage = async () => {
        if (message.value.trim() !== '' && !waiting.value) {
            messageList.push({
                content: message.value,
                role: 'user'
            })
            waiting.value = true
            const messages = messageList.map(item => ({
                role: item.role,
                content: item.content,
                reasoning_content: item.reasoning_content
            }))
            // 定义信号
            abortController = new AbortController()
            // 重组消息列表，添加系统消息
            let res = await fetch('http://localhost:3000/chat/stream', {
                method: "POST",
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ messages, model: llmModel.name }),
                signal: abortController.signal
            })
            let read = res.body?.getReader()
            let decoder = new TextDecoder()
            messageList.push({
                content: '',
                role: 'assistant',
                showReasoning: false,
                renderedHtml: '',
                reasoningHtml: ''
            })
            let buffer = ''
            try {
                while (true) {
                    const { done, value } = await read!.read()
                    if (done) break
                    let chunk = decoder.decode(value)
                    buffer += chunk
                    let lines = buffer.split('\n')
                    buffer = lines.pop() || ''
                    for (let line of lines) {
                        if (line.trim() === '') continue
                        if (!line.startsWith('data:')) continue
                        const event = JSON.parse(line.slice(5).trim())
                        if (event.type === 'reasoning') {
                            messageList[messageList.length - 1]!.reasoning_content = (messageList[messageList.length - 1]!.reasoning_content ?? '') + event.content
                        } else if (event.type === 'answer') {
                            messageList[messageList.length - 1]!.content = (messageList[messageList.length - 1]!.content ?? '') + event.content
                        } else if (event.type === 'rag') {
                            messageList[messageList.length - 1]!.citations = event.list
                        }
                    }
                }
            } catch (err) {
                if (err instanceof DOMException && err.name === 'AbortError') {
                    console.log('用户主动停止生成')
                    messageList[messageList.length - 1]!.content += '\n\n用户主动停止生成'
                } else {
                    throw err
                }
            } finally {
                abortController = null
            }
            renderLastMessage()
            waiting.value = false
            message.value = ''
        }
    }

    // 防抖：监听最后一条消息的变化，100ms后渲染
    const RENDER_INTERVAL = 100
    let lastRenderTime = 0
    let renderTimer: ReturnType<typeof setTimeout> | null = null
    watch(() => {
        // 只关心最后一条 assistant消息, 返回 content + reasoning的合并串
        const last = messageList[messageList.length - 1]
        if (!last || last.role !== 'assistant') return ''
        return last.content + '|' + (last.reasoning_content ?? '')
    }, (newVal) => {
        const now = Date.now()
        // 情况1：已经超过 100ms 没渲染 -> 直接渲染
        if (now - lastRenderTime >= RENDER_INTERVAL) {
            if (renderTimer) clearTimeout(renderTimer)
            renderLastMessage()
            lastRenderTime = now
            return
        }
        // 情況2：还没到100ms -> 设一个定时器，到时间就渲染
        if (!renderTimer) {
            renderTimer = setTimeout(() => {
                renderLastMessage()
                lastRenderTime = Date.now()
                renderTimer = null
            }, RENDER_INTERVAL - (now - lastRenderTime))
        }
    })
    const renderLastMessage = () => {
        const last = messageList[messageList.length - 1]
        if (!last || last.role !== 'assistant') return
        last.renderedHtml = renderMarkdown(last.content)
        last.reasoningHtml = renderMarkdown(last.reasoning_content ?? '')
    }
    const stopGeneration = () => {
        abortController?.abort()
    }

    return {
        message,
        messageList,
        waiting,
        showLLM,
        llmList,
        llmModel,
        sendMessage,
        stopGeneration,
        renderLastMessage
    }
})