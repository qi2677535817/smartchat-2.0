<script setup lang="ts">
import { ref, reactive, watch, nextTick, onMounted } from 'vue'
import { renderMarkdown } from '@/utils/markdown'
import { loadMessages, saveMessage } from '@/utils/storage'

interface Message {
  content: string
  role: 'user' | 'assistant',
  reasoning_content?: string,
  showReasoning?: boolean,
  renderedHtml?: string,
  reasoningHtml?: string
}

const message = ref('')
const messageList = reactive<Message[]>([])
const waiting = ref(false)
const showLLM = ref(false)
const llmList =  ref([
  {
    name:"deepseek-v4-flash",
    icon:"https://deepseek.ai/static/media/deepseek-v4-flash.7e0f3c1d.png"
  },
  {
    name:"deepseek-v4-pro",
    icon:"https://deepseek.ai/static/media/deepseek-v4-pro.7e0f3c1d.png"
  }
])
const llmModel = reactive({
  name: llmList.value[0]!.name,
  icon: llmList.value[0]!.icon
})

const textareaRef = ref<HTMLTextAreaElement | null>(null)

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

    // 重组消息列表，添加系统消息
    let res = await fetch('http://localhost:3000/chat/stream', {
      method: "POST",
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({messages, model: llmModel.name}),
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
        if(event.type === 'reasoning') {
          messageList[messageList.length - 1]!.reasoning_content = (messageList[messageList.length - 1]!.reasoning_content ?? '') + event.content
        }else {
          messageList[messageList.length - 1]!.content = (messageList[messageList.length - 1]!.content ?? '') + event.content
        }
      }
    }
    renderLastMessage()
    waiting.value = false
    message.value = ''
  }
}
const focusInput = () => {
  const textarea = textareaRef.value
  if (textarea) {
    textarea.focus()
  }
}
const messageListRef = ref<HTMLDivElement | null>(null)
const pickLLM = (item: { name: string; icon: string }) => {
  if (llmModel.name === item.name) {
    showLLM.value = !showLLM.value
    return
  }
  llmModel.name = item.name
  llmModel.icon = item.icon
  showLLM.value = !showLLM.value
}
watch(messageList, async () => {
  await nextTick()
  if (waiting.value &&messageListRef.value) {
    messageListRef.value.scrollTop = messageListRef.value.scrollHeight
    console.log('length watch 触发了，当前长度:', messageList.length, 'waiting:', waiting.value)
  }
  saveMessage(messageList)
})

// 防抖：监听最后一条消息的变化，100ms后渲染
const RENDER_INTERVAL = 100
let lastRenderTime = 0
let renderTimer: ReturnType<typeof setTimeout> | null = null 
watch(() => {
  // 只关心最后一条 assistant消息, 返回 content + reasoning的合并串
  const last = messageList[messageList.length - 1]
  if(!last || last.role !== 'assistant') return ''
  return last.content + '|' + (last.reasoning_content ?? '')
}, (newVal) => {
  const now = Date.now()
  // 情况1：已经超过 100ms 没渲染 -> 直接渲染
  if(now - lastRenderTime >= RENDER_INTERVAL) {
    if (renderTimer) clearTimeout(renderTimer)
    renderLastMessage()
    lastRenderTime = now
    return
  }
  // 情況2：还没到100ms -> 设一个定时器，到时间就渲染
  if(!renderTimer) {
    renderTimer = setTimeout(() => {
      renderLastMessage()
      lastRenderTime = Date.now()
      renderTimer = null
    }, RENDER_INTERVAL - (now - lastRenderTime))
  }
})
const renderLastMessage = () => {
  const last = messageList[messageList.length - 1]
  if(!last || last.role !== 'assistant') return
  last.renderedHtml = renderMarkdown(last.content)
  last.reasoningHtml = renderMarkdown(last.reasoning_content ?? '')
}
onMounted(() => {
  // 加载对话记录
  const list = loadMessages()
  if(list.length > 0 && list[0]) {
    list.forEach((element: Message) => {
      if(element.role === 'assistant') {
        element.renderedHtml = renderMarkdown(element.content)
        element.reasoningHtml = renderMarkdown(element.reasoning_content ?? '')
      }
    });
    messageList.splice(0, messageList.length, ...list)
  }
})
</script>

<template>
  <div class="chat-container">
    <!-- 背景 -->
    <div class="message-list" ref="messageListRef">
      <div v-for="(item, index) in messageList" :key="index" :class="['rows', item.role]">
        <!-- 用户消息，纯文本 -->
        <div v-if="item.role === 'user'" class="rows-box">{{ item.content }}</div>
        <!-- 助手消息，支持 Markdown -->
        <div v-else-if="item.role === 'assistant'" class="rows-box">
          <div v-if="waiting && index === messageList.length - 1" class="assistant waiting">
            <div class="waiting-box">思考中<span></span><span></span><span></span></div>
          </div>
          <div v-if="item.reasoning_content" class="reasoning">
            <!-- 点击折叠推理过程 -->
            <div class="reasoning-title" @click="item.showReasoning = !item.showReasoning">
            推理过程 <span class="arrow" :class="{rotated: (item.showReasoning || (waiting && index === messageList.length - 1))}">⬆️</span></div>
            <div class="reasoning-wrap" :class="{ open: item.showReasoning || (waiting && index === messageList.length - 1) }">
              <div v-if="item.showReasoning || (waiting && index === messageList.length - 1)" 
              v-html="item.reasoningHtml" class="reasoning-content"></div>
            </div>
          </div>
          <div v-html="item.renderedHtml"></div>
        </div>
      </div>
    </div>
    <!-- 输入框 -->
    <div class="message-container" @click="focusInput">
      <textarea ref="textareaRef" v-model="message" rows="5" placeholder="输入消息" aria-label="输入消息"
        @keydown.enter.exact.prevent="sendMessage"></textarea>
      <div class="nav-list">
        <div class="llm-box">
          <div class="llm-list" v-if="showLLM">
            <div v-for="(item, index) in llmList" :key="index" class="llm-item" @click="pickLLM(item)">
              {{ item.name }}
            </div>
          </div>
          <div class="llm-model" @click="pickLLM(llmModel)">
            {{ llmModel.name }}
          </div>
        </div>
        <button @click="sendMessage" :disabled="waiting">发送</button>
      </div>
    </div>
  </div>
</template>

<style lang="scss" scoped>
/**
  * 聊天界面样式
*/
.chat-container {
  max-width: 1140px;
  height: 100vh;
  max-height: 100vh;
  margin: 0 auto;
  background-color: #f5f5f5;
  display: flex;
  flex-direction: column;
  padding: 15px;
  box-sizing: border-box;

  .rows {
    display: flex;
  }

  .user {
    justify-content: flex-end;

    .rows-box {
      background-color: #1a95e7;
      color: #fff;
      padding: 10px;
      border-radius: 5px;
      margin-bottom: 10px;
      max-width: 100%;
      min-width: 30px;
      text-align: center;
      word-wrap: break-word;
      border-radius: 15px 15px 0 15px;
      margin-bottom: 30px;
    }
  }
  .reasoning-wrap {
    display: grid;
    grid-template-rows: 0fr;
    transition: grid-template-rows 0.3s ease;
    &.open {
      grid-template-rows: 1fr;
    }
    .reasoning-content {
      overflow: hidden;
      min-height: 0;
    }
  }

  .reasoning {
    border-bottom: 1px solid #676767;
    padding-bottom: 10px;
    margin-bottom: 10px;
    font-size: 12px;
    color: #676767;
    transition: all 0.3s;
    .reasoning-title {
      cursor: pointer;
      .arrow {
        display: inline-block;
        transition: transform 0.3s ease;
        &.rotated {
          transform: rotate(180deg);
        }
      }
    }
  }
  .assistant {
    justify-content: flex-start;

    .rows-box {
      // background-color: #e7cd8c;
      color: #000;
      padding: 10px;
      border-radius: 5px;
      margin-bottom: 10px;
      max-width: 100%;
      word-wrap: break-word;
      border-radius: 0 15px 15px 15px;
      margin-bottom: 30px;
      transition: all 0.3s;

      // :deep() 让样式作用于 v-html 生成的子元素
      :deep(h1) {
        font-size: 1.4em;
        margin: 0.8em 0 0.4em; 
      }
      :deep(h2) { margin: 0.8em 0 0.4em; }
      :deep(p) {
        margin: 0.5em 0;
      }

      :deep(pre) {
        background: #282c34;
        color: #abb2bf;
        padding: 10px;
        border-radius: 6px;
        overflow-x: auto;
      }

      :deep(code) {
        background: #f0f0f0;
        padding: 2px 4px;
        border-radius: 3px;
      }

      :deep(pre code) {
        background: none;
        padding: 0;
      }

      :deep(ul) {
        padding-left: 1.5em;
        margin: 0.5em 0;
      }

      :deep(ol) {
        padding-left: 1.5em;
      }
      :deep(li) { margin: 0.3em 0; }
      :deep(hr) { margin: 1em 0; border: 1px solid #e0e0e0;}
      :deep(blockquote) {
        margin: 1.2em 0;
        padding: 12px 16px;
        border-left: 4px solid #8b5cf6; /* 紫色 */
        border-radius: 6px;
        background: rgba(139, 92, 246, 0.06);
        font-size: 0.95em;
        color: #4b5563;
      }
    }
  }
  .llm-box {
    position: relative;
    margin-right: 10px;
    height: 100%;
    .llm-list {
      position: absolute;
      top: -100px;
      right: 0;
      font-size: 14px;
      background-color: #fff;
      border: 1px solid #e6e6e6;
      border-radius: 10px;
      padding: 10px;
      box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
      z-index: 10;

      div {
        padding: 5px 10px;
        cursor: pointer;
        white-space: nowrap;
        &:hover {
          background-color: #f5f5f5;
        }
      }
    }
    .llm-model {
      display: flex;
      align-items: center;
      font-size: 14px;
      color: #4b5563;
      background: #f0f0f0;
      padding: 0 10px;
      border-radius: 10px;
      margin-right: 10px;
      height: 100%;
      cursor: pointer;
    }
  }
  .waiting {
    display: flex;

    .waiting-box {
      display: flex;
      align-items: center;

      span {
        width: 6px;
        height: 6px;
        background-color: #9ca3af;
        border-radius: 50%;
        margin: 0 2px;
        animation: blink 1.2s infinite;
      }

      span:nth-child(1) {
        margin-left: 5px;
      }

      span:nth-child(2) {
        animation-delay: 0.2s;
      }

      span:nth-child(3) {
        animation-delay: 0.4s;
      }
    }
  }

  @keyframes blink {

    0%,
    80%,
    100% {
      opacity: 0.25;
    }

    40% {
      opacity: 1;
    }
  }
}

/**
  * 消息列表样式
*/
.message-list {
  flex: 1;
  overflow-y: auto;
  padding: 15px;
}

/**
  * 消息输入框样式
*/
.message-container {
  margin-top: auto;
  width: 100%;
  background-color: #fff;
  border: 1px solid #e6e6e6;
  border-radius: 10px;
  padding: 15px;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;

  textarea {
    border: none;
    width: 100%;
    resize: none;
    font-size: 18px;
    field-sizing: content;
    max-height: 200px;

    &:focus,
    &:active {
      outline: none;
      // box-shadow: 0 0 0 2px rgba(0, 123, 255, 0.25);
    }
  }

  .nav-list {
    margin-top: 10px;
    display: flex;
    justify-content: flex-end;
    align-items: center;

    button {
      padding: 8px 20px;
      background-color: #007bff;
      color: #fff;
      border: none;
      border-radius: 10px;
      cursor: pointer;

      &:hover {
        background-color: #0056b3;
      }
    }
  }
}
</style>
