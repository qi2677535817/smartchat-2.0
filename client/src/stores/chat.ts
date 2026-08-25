import { ref, reactive, watch, computed } from "vue";
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
interface Session {
    id: string,
    messages: Message[],
    createdAt: number,
    title: string,
}

export const useChatStore = defineStore('chat', () => {
    const message = ref('')
    const sessions = ref<Session[]>([])
    const activeId = ref('')
    const messageList = computed((): Message[] => {
        // 如果是第一次对话，这里就没有数据需要加判断
        let index = sessions.value.findIndex(item => item.id === activeId.value)
        if (index > -1) {
            return sessions.value[index]!.messages
        } else {
            return []
        }
    })
    const title = computed((): string => {
        let index = sessions.value.findIndex(item => item.id === activeId.value)
        if (index > -1) {
            return sessions.value[index]!.title
        } else {
            return '新对话'
        }
    })
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
            messageList.value.push({
                content: message.value,
                role: 'user'
            })
            waiting.value = true
            const messages = messageList.value.map(item => ({
                role: item.role,
                content: item.content,
                reasoning_content: item.reasoning_content
            }))
            let index = sessions.value.findIndex(item => item.id == activeId.value)
            if (index > -1 && sessions.value[index]!.title == '新对话') {
                sessions.value[index]!.title = sessions.value[index]!.messages[0]!.content.slice(0, 12)
            }
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
            messageList.value.push({
                content: '',
                role: 'assistant',
                showReasoning: false,
                renderedHtml: '',
                reasoningHtml: ''
            })
            let buffer = ''
            const targetMessages = messageList.value
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
                            targetMessages[targetMessages.length - 1]!.reasoning_content = (targetMessages[targetMessages.length - 1]!.reasoning_content ?? '') + event.content
                        } else if (event.type === 'answer') {
                            targetMessages[targetMessages.length - 1]!.content = (targetMessages[targetMessages.length - 1]!.content ?? '') + event.content
                        } else if (event.type === 'rag') {
                            targetMessages[targetMessages.length - 1]!.citations = event.list
                        }
                    }
                }
            } catch (err) {
                if (err instanceof DOMException && err.name === 'AbortError') {
                    console.log('用户主动停止生成')
                    targetMessages[targetMessages.length - 1]!.content += '\n\n用户主动停止生成'
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
        const last = messageList.value[messageList.value.length - 1]
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

    watch(sessions, () => {
        saveSessions(activeId.value, sessions.value)
    }, { deep: true })

    /**
     * 初始化数据
     * @returns 
     */
    const initSessions = () => {
        try {
            let sessionsData = localStorage.getItem('chat_message')
            if (!sessionsData) {
                sessionsData = JSON.stringify({
                    activeId: '',
                    sessions: []
                })
            }
            let data = JSON.parse(sessionsData)
            // 这里判断sessions是否为空
            if (!Array.isArray(data.sessions)) data = { activeId: '', sessions: [] }
            if (data.sessions.length == 0) {
                let id = crypto.randomUUID()
                // 如果为空则创建一个新会话
                data.sessions.push({
                    id,
                    createdAt: Date.now(),
                    messages: [],
                    title: "新对话"
                })
            }
            let index = data.sessions.findIndex((item:Session) => item.id == data.activeId)
            if(index > -1) {
                activeId.value = data.activeId
            }
           
            if (!activeId.value) {
                activeId.value = data.sessions[0].id
            }

            sessions.value = [...data.sessions]
            return sessionsData
        } catch (e) {
            console.error(e)
            return {}
        }
    }

    const saveSessions = (id: string, list: Array<any>) => {
        let obj = {
            activeId: id,
            sessions: list
        }
        localStorage.setItem('chat_message', JSON.stringify(obj))
    }

    const renderLastMessage = () => {
        const last = messageList.value[messageList.value.length - 1]
        if (!last || last.role !== 'assistant') return
        last.renderedHtml = renderMarkdown(last.content)
        last.reasoningHtml = renderMarkdown(last.reasoning_content ?? '')
    }

    const stopGeneration = () => {
        abortController?.abort()
    }

    /**
     * 新建会话
     */
    const createSession = () => {
        let obj = {
            id: crypto.randomUUID(),
            createdAt: Date.now(),
            messages: [],
            title: "新对话"
        }
        activeId.value = obj.id
        sessions.value.push(obj)
    }

    /**
     * 切换会话
     */
    const switchSession = (id: string) => {
        activeId.value = id
    }

    /**
     * 删除会话 
     */
    const deleteSession = (id: string) => {
        let index = sessions.value.findIndex(item => item.id === id)
        if (index > -1) {
            sessions.value.splice(index, 1)
            if (sessions.value.length == 0) {
                createSession()
            }
            if (id == activeId.value) {
                activeId.value = sessions.value[0]!.id
            }
        }
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
        renderLastMessage,
        initSessions,
        activeId,
        title,
        sessions,
        createSession,
        switchSession,
        deleteSession
    }
})