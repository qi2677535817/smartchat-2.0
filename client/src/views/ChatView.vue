<script setup lang="ts">
import { ref, reactive, watch, nextTick } from 'vue'

interface Message {
  content: string
  timestamp: string
  role: string
}

const message = ref('')
const messageList = reactive<Message[]>([])
const waiting = ref(false)

const textareaRef = ref<HTMLTextAreaElement | null>(null)

const sendMessage = () => {
  if (message.value.trim() !== '' && !waiting.value) {
    messageList.push({
      content: message.value,
      timestamp: new Date().toLocaleTimeString(),
      role: 'user',
    })
    message.value = ''
    waiting.value = true
    // 模拟接收消息
    setTimeout(() => {
      messageList.push({
        content: '这是自动回复的消息',
        timestamp: new Date().toLocaleTimeString(),
        role: 'assistant',
      })
      waiting.value = false
    }, 2400)
  }
}
const focusInput = () => {
  const textarea = textareaRef.value
  if (textarea) {
    textarea.focus()
  }
}
const messageListRef = ref<HTMLDivElement | null>(null)
watch(messageList, async () => {
  await nextTick()
  if (messageListRef.value) {
    messageListRef.value.scrollTop = messageListRef.value.scrollHeight
  }
})
</script>

<template>
  <div class="chat-container">
    <!-- 背景 -->
    <div class="message-list" ref="messageListRef">
      <div v-for="(item, index) in messageList" :key="index" :class="['rows', item.role]">
        <div class="rows-box">{{ item.content }}</div>
      </div>
      <div v-if="waiting" class="assistant waiting">
        <div class="waiting-box">思考中<span></span><span></span><span></span></div>
      </div>
    </div>
    <!-- 输入框 -->
    <div class="message-container" @click="focusInput">
      <textarea
        ref="textareaRef"
        v-model="message"
        rows="5"
        placeholder="输入消息"
        aria-label="输入消息"
        @keydown.enter.exact.prevent="sendMessage"
      ></textarea>
      <div class="nav-list">
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
      max-width: 70%;
      min-width: 30px;
      text-align: center;
      word-wrap: break-word;
      border-radius: 15px 15px 0 15px;
    }
  }
  .assistant {
    justify-content: flex-start;
    .rows-box {
      background-color: #e6e6e6;
      color: #000;
      padding: 10px;
      border-radius: 5px;
      margin-bottom: 10px;
      max-width: 70%;
      word-wrap: break-word;
      border-radius: 0 15px 15px 15px;
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
