import { defineStore } from 'pinia'
import { reactive, ref } from 'vue'
import { renderMarkdown } from '@/utils/markdown'

export interface ChatCitation {
  name: string
  index: number
}

export interface ChatMessage {
  content: string
  role: 'user' | 'assistant'
  reasoning_content?: string
  showReasoning?: boolean
  renderedHtml?: string
  reasoningHtml?: string
  citations?: ChatCitation[]
}

export interface SessionItem {
  id: string
  title: string
  createdAt: number
}

interface StreamEvent {
  type: 'rag' | 'reasoning' | 'answer'
  content?: string
  list?: ChatCitation[]
}

const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:3000'

export const useChatStore = defineStore('chat', () => {
  // ---------------- 状态 ----------------
  const title = ref('')
  const message = ref('')
  const messageList = ref<ChatMessage[]>([])
  const waiting = ref(false)
  const sessions = ref<SessionItem[]>([])
  const activeId = ref('')
  const showLLM = ref(false)
  const llmModel = reactive({ name: 'deepseek-v4-flash', icon: '⚡' })
  const llmList = reactive([
    { name: 'deepseek-v4-flash', icon: '⚡' },
    { name: 'deepseek-v4-pro', icon: '🧠' },
  ])

  // 中断控制器：不需要响应式
  let abortController: AbortController | null = null

  // ---------------- 会话管理 ----------------
  async function initSessions() {
    const res = await fetch(`${API_BASE}/sessions`)
    if (!res.ok) return
    sessions.value = await res.json()
    if (sessions.value.length > 0) {
      await switchSession(sessions.value[0]!.id)
    } else {
      await createSession()
    }
  }

  async function createSession() {
    const res = await fetch(`${API_BASE}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '新对话' }),
    })
    if (!res.ok) return
    const session: SessionItem = await res.json()
    sessions.value.push(session)
    await switchSession(session.id)
  }

  async function switchSession(id: string) {
    // 切走时停掉还在生成的流
    if (waiting.value) stopGeneration()
    activeId.value = id
    const current = sessions.value.find(s => s.id === id)
    title.value = current?.title ?? ''
    const res = await fetch(`${API_BASE}/sessions/${id}/messages`)
    if (!res.ok) return
    const msgs: Array<{
      role: string
      content: string
      reasoning?: string | null
    }> = await res.json()
    messageList.value = msgs.map(m => ({
      content: m.content,
      role: m.role === 'user' ? 'user' : 'assistant',
      reasoning_content: m.reasoning ?? '',
      showReasoning: false,
      renderedHtml:
        m.role === 'assistant' ? renderMarkdown(m.content) : undefined,
      reasoningHtml:
        m.role === 'assistant' ? renderMarkdown(m.reasoning ?? '') : undefined,
    }))
  }

  async function deleteSession(id: string) {
    const res = await fetch(`${API_BASE}/sessions/${id}`, { method: 'DELETE' })
    if (!res.ok) return
    const idx = sessions.value.findIndex(s => s.id === id)
    if (idx !== -1) sessions.value.splice(idx, 1)
    if (activeId.value === id) {
      if (sessions.value.length > 0) {
        await switchSession(sessions.value[0]!.id)
      } else {
        activeId.value = ''
        title.value = ''
        messageList.value = []
      }
    }
  }

  // ---------------- 发送 / 停止 ----------------
  async function sendMessage() {
    const content = message.value.trim()
    if (content === '' || waiting.value) return
    // 没有会话时自动建一个
    if (!activeId.value) await createSession()

    messageList.value.push({ content, role: 'user' })
    message.value = ''
    waiting.value = true

    // 首条消息后本地更新会话标题（展示层；后端暂无更新标题接口）
    const current = sessions.value.find(s => s.id === activeId.value)
    if (current && current.title === '新对话') {
      current.title = content.slice(0, 12)
      title.value = current.title
    }

    // assistant 占位消息，流式内容往里追加
    const assistantMsg: ChatMessage = {
      content: '',
      role: 'assistant',
      reasoning_content: '',
      citations: [],
    }
    messageList.value.push(assistantMsg)

    // 组装历史（去掉最后的 assistant 占位，过滤空 assistant 消息）
    const history = messageList.value
      .slice(0, -1)
      .filter(m => m.role === 'user' || m.content.trim() !== '')
      .map(m => ({ role: m.role, content: m.content }))

    abortController = new AbortController()

    try {
      const res = await fetch(`${API_BASE}/chat/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: history, model: llmModel.name, sessionId: activeId.value || undefined }),
        signal: abortController.signal,
      })
      if (!res.ok || !res.body) {
        const errText = await res.text().catch(() => '')
        throw new Error(`请求失败 ${res.status}: ${errText}`)
      }
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        // stream:true 防止中文多字节字符跨 chunk 被解成乱码
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          const trimmed = line.trim()
          if (trimmed === '' || !trimmed.startsWith('data:')) continue
          let event: StreamEvent
          try {
            event = JSON.parse(trimmed.slice(5).trim())
          } catch {
            continue
          }
          if (event.type === 'reasoning' && event.content) {
            assistantMsg.reasoning_content =
              (assistantMsg.reasoning_content ?? '') + event.content
          } else if (event.type === 'answer' && event.content) {
            assistantMsg.content += event.content
          } else if (event.type === 'rag' && event.list) {
            assistantMsg.citations = event.list
          }
        }
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        // 用户主动停止，保留已生成的部分内容
      } else {
        assistantMsg.content += `\n\n> ⚠️ 请求出错：${err instanceof Error ? err.message : String(err)}`
      }
    } finally {
      assistantMsg.renderedHtml = renderMarkdown(assistantMsg.content)
      assistantMsg.reasoningHtml = renderMarkdown(
        assistantMsg.reasoning_content ?? '',
      )
      waiting.value = false
      abortController = null
      // 本轮对话持久化到 SQLite
      await persistTurn(content, assistantMsg)
    }
  }

  function stopGeneration() {
    abortController?.abort()
    abortController = null
    waiting.value = false
  }

  async function persistTurn(userContent: string, assistantMsg: ChatMessage) {
    if (!activeId.value) return
    const save = (body: Record<string, unknown>) =>
      fetch(`${API_BASE}/sessions/${activeId.value}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    await save({ role: 'user', content: userContent })
    await save({
      role: 'assistant',
      content: assistantMsg.content,
      reasoning_content: assistantMsg.reasoning_content ?? '',
    })
  }

  return {
    // 状态
    title,
    message,
    messageList,
    waiting,
    sessions,
    activeId,
    showLLM,
    llmModel,
    llmList,
    // 方法
    initSessions,
    createSession,
    switchSession,
    deleteSession,
    sendMessage,
    stopGeneration,
  }
})
