<script setup lang="ts">
import { ref, reactive, watch, nextTick, onMounted, stop } from 'vue'
import { renderMarkdown } from '@/utils/markdown'
import { loadMessages, saveMessage } from '@/utils/storage'
import { userChatStore } from '@/stores/chat'
 
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

const chat = userChatStore()

const textareaRef = ref<HTMLTextAreaElement | null>(null)
const folderInputRef = ref<HTMLInputElement | null>(null)

const focusInput = () => {
  const textarea = textareaRef.value
  if (textarea) {
    textarea.focus()
  }
}
const messageListRef = ref<HTMLDivElement | null>(null)
const pickLLM = (item: { name: string; icon: string }) => {
  if (chat.llmModel.name === item.name) {
    chat.showLLM = !chat.showLLM
    return
  }
  chat.llmModel.name = item.name
  chat.llmModel.icon = item.icon
  chat.showLLM = !chat.showLLM
}
watch(chat.messageList, async () => {
  await nextTick()
  if (chat.waiting && messageListRef.value) {
    messageListRef.value.scrollTop = messageListRef.value.scrollHeight
    // console.log('length watch 触发了，当前长度:', messageList.length, 'waiting:', waiting.value)
  }
  saveMessage(chat.messageList)
})


// 触发上传文件
const uploadFile = () => {
  folderInputRef.value?.click()
}
// 上传文件
const onFileChange = async (e:Event) => {
  const target = e.target as HTMLInputElement
  const files = target.files
  if(!files || files.length === 0) return
  
  // files转数组
  const _files = Array.from(files)
  let content: string = ''
  let name: string = ''
  for(let file of _files) {
    // 读取文本内容
    content = await file.text()
    name = file.name
  }
  chat.messageList.push({
    content: '上传文件：' + name ,
    role: 'user'
  })
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
  if(res.ok) {
    let data = await res.json()
    console.log(data);
    chat.messageList.push({
      content: data.msg,
      role: 'assistant'
    })
    chat.waiting = false
  }
}
onMounted(async () => {
  // 加载对话记录
  const list = loadMessages()
  if(list.length > 0 && list[0]) {
    list.forEach((element: Message) => {
      if(element.role === 'assistant') {
        element.renderedHtml = renderMarkdown(element.content)
        element.reasoningHtml = renderMarkdown(element.reasoning_content ?? '')
      }
    });
    chat.messageList.splice(0, chat.messageList.length, ...list)
    await nextTick()
    if(messageListRef.value) {
      messageListRef.value.scrollTop = messageListRef.value.scrollHeight
    }
  }
})
</script>

<template>
  <div class="chat-container">
    <!-- 背景 -->
    <div class="message-list" ref="messageListRef">
      <div v-for="(item, index) in chat.messageList" :key="index" :class="['rows', item.role]">
        <!-- 用户消息，纯文本 -->
        <div v-if="item.role === 'user'" class="rows-box">{{ item.content }}</div>
        <!-- 助手消息，支持 Markdown -->
        <div v-else-if="item.role === 'assistant'" class="rows-box">
          <div v-if="chat.waiting && index === chat.messageList.length - 1" class="assistant waiting">
            <div class="waiting-box">思考中<span></span><span></span><span></span></div>
          </div>
          <div v-if="item.reasoning_content" class="reasoning">
            <!-- 点击折叠推理过程 -->
            <div class="reasoning-title" @click="item.showReasoning = !item.showReasoning">
            推理过程 <span class="arrow" :class="{rotated: (item.showReasoning || (chat.waiting && index === chat.messageList.length - 1))}">⬆️</span></div>
            <div class="reasoning-wrap" :class="{ open: item.showReasoning || (chat.waiting && index === chat.messageList.length - 1) }">
              <div v-if="item.showReasoning || (chat.waiting && index === chat.messageList.length - 1)" 
              v-html="item.reasoningHtml" class="reasoning-content"></div>
            </div>
          </div>
          <div v-html="item.renderedHtml"></div>
          <div v-if="item.citations && item.citations.length > 0" class="citation">
            参考资料：
            <div v-for="(citation, index) in item.citations" :key="index" style="margin-right: 5px;">
              {{ citation.name }}
            </div>
          </div>
        </div>
      </div>
    </div>
    <!-- 输入框 -->
    <div class="message-container" @click="focusInput">
      <textarea ref="textareaRef" v-model="chat.message" rows="5" placeholder="输入消息" aria-label="输入消息"
        @keydown.enter.exact.prevent="chat.sendMessage"></textarea>
      <div class="nav-list">
        <button @click="uploadFile" :disabled="chat.waiting" class="send-btn">📃</button>
        <div class="llm-box">
          <div class="llm-list" v-if="chat.showLLM">
            <div v-for="(item, index) in chat.llmList" :key="index" class="llm-item" @click="pickLLM(item)">
              {{ item.name }}
            </div>
          </div>
          <div class="llm-model" @click="pickLLM(chat.llmModel)">
            {{ chat.llmModel.name }}
          </div>
        </div>
        <button @click="chat.stopGeneration" v-if="chat.waiting" class="stop-btn">停止</button>
        <button @click="chat.sendMessage" v-else :disabled="!chat.message.trim()">发送</button>
      </div>
      <input type="file" ref="folderInputRef" accept=".txt,.md,.pdf" style="display:none"
      @change="onFileChange"></input>
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
  .citation {
    display: flex;
    align-items: center;
    gap: 5px;
    font-size: 12px;
    color: #676767;
    border-top: 1px solid #676767;
    margin-top: 10px;
    padding-top: 5px;
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
    .send-btn {
      background: #484848;
      margin-right: 10px;
    }
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
    .stop-btn {
      background: #000;
      &:hover {
        background: #484848
      }
    }
  }
}
</style>
