<script setup lang="ts">
import { ref, watch, nextTick, onMounted, computed } from 'vue'
import { renderMarkdown } from '@/utils/markdown'
import { useChatStore } from '@/stores/chat'
import AppIcon from '@/components/AppIcon.vue'

interface Message {
  content: string
  role: 'user' | 'assistant',
  reasoning_content?: string,
  showReasoning?: boolean,
  renderedHtml?: string,
  reasoningHtml?: string,
  citations?: { name: string, index: number }[]
}


const chat = useChatStore()

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
    // console.log('length watch 触发了，当前长度:', message.length, 'waiting:', waiting.value)
  }
  // saveMessage(chat.messageList)
})
watch(() => chat.activeId, async () => {
  await nextTick()
  if (messageListRef.value) {
    messageListRef.value.scrollTop = messageListRef.value.scrollHeight
  }
})

// 是否处于空状态（用于展示引导卡）
const isEmpty = computed(() => chat.messageList.length === 0)

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

  if(chat.messageList.length > 0 && chat.messageList[0]) {
    chat.messageList.forEach((element: Message) => {
      if(element.role === 'assistant') {
        element.renderedHtml = renderMarkdown(element.content)
        element.reasoningHtml = renderMarkdown(element.reasoning_content ?? '')
      }
    });
    await nextTick()
    if(messageListRef.value) {
      messageListRef.value.scrollTop = messageListRef.value.scrollHeight
    }
  }
})
</script>

<template>
  <div class="chat-container">
    <!-- 顶部标题栏 -->
    <header class="topbar">
      <div class="topbar__title">
        <h1>{{ chat.title }}</h1>
        <span class="topbar__sub">基于企业知识库的智能问答</span>
      </div>
    </header>

    <!-- 消息区 -->
    <div class="message-list" ref="messageListRef">
      <!-- 空状态引导 -->
      <div v-if="isEmpty" class="empty-state chat-empty">
        <span class="empty-state__icon"><AppIcon name="sparkle" :size="24" /></span>
        <div class="empty-state__title">开始一次知识问答</div>
        <p class="empty-state__desc">
          提问会结合已入库的企业资料进行回答，并在回复下方标注引用来源。可先在「RAG 知识库」中上传文档。
        </p>
        <div class="chat-empty__actions">
          <RouterLink to="/knowledge" class="btn btn-primary">
            <AppIcon name="book" :size="15" />
            <span>前往知识库</span>
          </RouterLink>
          <button class="btn" @click="uploadFile" :disabled="chat.waiting">
            <AppIcon name="paperclip" :size="15" />
            <span>上传文档</span>
          </button>
        </div>
      </div>

      <!-- 消息列表 -->
      <div v-for="(item, index) in chat.messageList" :key="index" :class="['msg-row', item.role]">
        <!-- 头像 -->
        <div class="avatar" :class="item.role === 'user' ? 'avatar--user' : 'avatar--ai'" aria-hidden="true">
          <template v-if="item.role === 'user'">我</template>
          <AppIcon v-else name="sparkle" :size="15" />
        </div>

        <!-- 用户消息，纯文本 -->
        <div v-if="item.role === 'user'" class="msg-bubble msg-bubble--user">{{ item.content }}</div>

        <!-- 助手消息，支持 Markdown -->
        <div v-else class="msg-body">
          <div class="msg-bubble msg-bubble--ai">
            <!-- 思考中 -->
            <div v-if="chat.waiting && index === chat.messageList.length - 1" class="thinking">
              <span class="thinking__dot"></span>
              <span class="thinking__dot"></span>
              <span class="thinking__dot"></span>
              <span class="thinking__text">正在思考</span>
            </div>

            <!-- 推理过程（可折叠） -->
            <div v-if="item.reasoning_content" class="reasoning">
              <button class="reasoning__title" :aria-expanded="item.showReasoning"
                @click="item.showReasoning = !item.showReasoning">
                <AppIcon name="chevron" :size="14" class="reasoning__arrow" :class="{ rotated: item.showReasoning }" />
                <span>推理过程</span>
              </button>
              <div class="reasoning__wrap" :class="{ open: item.showReasoning }">
                <div v-if="item.showReasoning" v-html="item.reasoningHtml" class="reasoning__content markdown"></div>
              </div>
            </div>

            <!-- 正文 -->
            <div v-html="item.renderedHtml" class="markdown"></div>

            <!-- 引用来源 -->
            <div v-if="item.citations && item.citations.length > 0" class="citation">
              <span class="citation__label"><AppIcon name="file" :size="13" /> 参考资料</span>
              <span v-for="(citation, i) in item.citations" :key="i" class="citation__chip">
                {{ citation.name }}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 输入区 -->
    <div class="composer-wrap">
      <div class="message-container" @click="focusInput">
        <textarea ref="textareaRef" v-model="chat.message" rows="3" placeholder="输入你的问题，Enter 发送，Shift+Enter 换行"
          aria-label="输入消息" @keydown.enter.exact.prevent="chat.sendMessage"></textarea>
        <div class="nav-list">
          <button class="btn btn-ghost-tool" title="上传文档到知识库" aria-label="上传文档到知识库" @click="uploadFile"
            :disabled="chat.waiting">
            <AppIcon name="paperclip" :size="16" />
          </button>
          <div class="llm-box">
            <div class="llm-list" v-if="chat.showLLM">
              <button v-for="(item, index) in chat.llmList" :key="index" class="llm-item" @click="pickLLM(item)">
                {{ item.name }}
              </button>
            </div>
            <button class="llm-model" :aria-expanded="chat.showLLM" @click="pickLLM(chat.llmModel)">
              <span>{{ chat.llmModel.name }}</span>
              <AppIcon name="chevron" :size="13" :class="{ rotated: chat.showLLM }" />
            </button>
          </div>
          <span class="nav-list__spacer" />
          <button v-if="chat.waiting" class="btn btn-danger" @click="chat.stopGeneration">
            <AppIcon name="stop" :size="14" />
            <span>停止</span>
          </button>
          <button v-else class="btn btn-primary" @click="chat.sendMessage" :disabled="!chat.message.trim()">
            <AppIcon name="send" :size="15" />
            <span>发送</span>
          </button>
        </div>
      </div>
      <p class="composer-hint">AI 生成内容可能存在偏差，重要结论请核对引用原文</p>
      <input type="file" ref="folderInputRef" accept=".txt,.md,.pdf" style="display:none" @change="onFileChange"></input>
    </div>
  </div>
</template>

<style lang="scss" scoped>
/**
 * 聊天主界面：顶栏 + 消息流 + 固定输入区
 * 排版约束：内容最大宽度 880px 居中，保证长文可读性
 */
.chat-container {
    display: flex;
    flex-direction: column;
    height: 100vh;
    background: var(--ink-50);

    /* ---------- 顶栏 ---------- */
    .topbar {
        display: flex;
        align-items: center;
        height: var(--header-h);
        padding: 0 var(--sp-8);
        background: rgba(255, 255, 255, .8);
        backdrop-filter: blur(8px);
        border-bottom: 1px solid var(--ink-200);
        flex: none;
    }

    .topbar__title {
        display: flex;
        flex-direction: column;
        line-height: 1.3;
        max-width: var(--content-max);
        margin: 0 auto;
        width: 100%;

        h1 {
            font-size: 16px;
            font-weight: 600;
            color: var(--ink-900);
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }
    }

    .topbar__sub {
        font-size: 12px;
        color: var(--ink-500);
    }

    /* ---------- 消息区 ---------- */
    .message-list {
        flex: 1;
        overflow-y: auto;
        padding: var(--sp-6) var(--sp-8) var(--sp-4);
    }

    .msg-row {
        display: flex;
        gap: var(--sp-3);
        max-width: var(--content-max);
        margin: 0 auto var(--sp-6);
    }

    .avatar {
        display: grid;
        place-items: center;
        width: 32px;
        height: 32px;
        flex: none;
        margin-top: 2px;
        font-size: 13px;
        font-weight: 600;
        border-radius: var(--r-md);

        &--user {
            color: var(--ink-600);
            background: var(--ink-100);
            border: 1px solid var(--ink-200);
        }

        &--ai {
            color: var(--white);
            background: linear-gradient(135deg, var(--brand-500), var(--brand-700));
            box-shadow: var(--shadow-sm);
        }
    }

    .msg-bubble {
        min-width: 0;
        max-width: 100%;
        padding: var(--sp-3) var(--sp-4);
        font-size: 14.5px;
        line-height: 1.7;
        word-wrap: break-word;
        border-radius: var(--r-lg);
        transition: box-shadow .2s ease;

        &--user {
            align-self: flex-start;
            color: var(--ink-900);
            background: var(--white);
            border: 1px solid var(--ink-200);
            border-top-left-radius: var(--r-xs);
            box-shadow: var(--shadow-xs);
        }

        &--ai {
            color: var(--ink-800);
            background: var(--white);
            border: 1px solid var(--ink-200);
            border-top-left-radius: var(--r-xs);
            box-shadow: var(--shadow-xs);
        }
    }

    .msg-row.user {
        .msg-bubble {
            background: var(--brand-600);
            color: var(--white);
            border-color: var(--brand-600);
        }
    }

    .msg-body {
        min-width: 0;
        max-width: calc(100% - 44px);
    }

    /* ---------- 思考中 ---------- */
    .thinking {
        display: flex;
        align-items: center;
        gap: 5px;
        padding: var(--sp-1) 0;
    }

    .thinking__dot {
        width: 6px;
        height: 6px;
        background: var(--brand-500);
        border-radius: 50%;
        animation: blink 1.3s infinite;
    }

    .thinking__dot:nth-child(2) {
        animation-delay: .18s;
    }

    .thinking__dot:nth-child(3) {
        animation-delay: .36s;
    }

    .thinking__text {
        margin-left: 6px;
        font-size: 13px;
        color: var(--ink-400);
    }

    @keyframes blink {

        0%,
        80%,
        100% {
            opacity: .25;
            transform: translateY(0);
        }

        40% {
            opacity: 1;
            transform: translateY(-2px);
        }
    }

    /* ---------- 推理过程 ---------- */
    .reasoning {
        margin-bottom: var(--sp-3);
        padding-bottom: var(--sp-3);
        border-bottom: 1px dashed var(--ink-200);
    }

    .reasoning__title {
        display: flex;
        align-items: center;
        gap: var(--sp-1);
        padding: 4px 0;
        font-family: inherit;
        font-size: 12.5px;
        font-weight: 500;
        color: var(--ink-500);
        background: transparent;
        border: none;
        cursor: pointer;
        transition: color .16s ease;

        &:hover {
            color: var(--brand-600);
        }
    }

    .reasoning__arrow {
        transition: transform .22s ease;

        &.rotated {
            transform: rotate(180deg);
        }
    }

    .reasoning__wrap {
        display: grid;
        grid-template-rows: 0fr;
        transition: grid-template-rows .28s ease;

        &.open {
            grid-template-rows: 1fr;
        }
    }

    .reasoning__content {
        overflow: hidden;
        min-height: 0;
        font-size: 13px;
        color: var(--ink-500);
    }

    /* ---------- 引用来源 ---------- */
    .citation {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: var(--sp-2);
        margin-top: var(--sp-3);
        padding-top: var(--sp-3);
        border-top: 1px solid var(--ink-100);
    }

    .citation__label {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        font-size: 12px;
        font-weight: 600;
        color: var(--ink-500);
    }

    .citation__chip {
        padding: 2px 9px;
        font-size: 12px;
        color: var(--ink-600);
        background: var(--ink-100);
        border-radius: var(--r-full);
        transition: background .16s ease, color .16s ease;

        &:hover {
            color: var(--brand-700);
            background: var(--brand-50);
        }
    }

    /* ---------- 空状态 ---------- */
    .chat-empty {
        max-width: var(--content-max);
        margin: auto;
    }

    .chat-empty__actions {
        display: flex;
        gap: var(--sp-2);
        margin-top: var(--sp-2);
    }
}

/* ---------- Markdown 正文排版（作用于 v-html） ---------- */
.markdown {

    :deep(> *:first-child) {
        margin-top: 0;
    }

    :deep(> *:last-child) {
        margin-bottom: 0;
    }

    :deep(p) {
        margin: .5em 0;
    }

    :deep(h1) {
        font-size: 1.3em;
        margin: .8em 0 .4em;
    }

    :deep(h2) {
        font-size: 1.18em;
        margin: .8em 0 .4em;
        padding-bottom: .25em;
        border-bottom: 1px solid var(--ink-200);
    }

    :deep(h3) {
        font-size: 1.05em;
        margin: .7em 0 .3em;
    }

    :deep(ul),
    :deep(ol) {
        margin: .5em 0;
        padding-left: 1.4em;
    }

    :deep(li) {
        margin: .25em 0;
    }

    :deep(li::marker) {
        color: var(--ink-400);
    }

    :deep(code) {
        padding: 2px 5px;
        font-family: var(--font-mono);
        font-size: .88em;
        color: var(--brand-700);
        background: var(--brand-50);
        border: 1px solid var(--brand-100);
        border-radius: var(--r-xs);
    }

    :deep(pre) {
        margin: .7em 0;
        padding: var(--sp-4);
        overflow-x: auto;
        background: var(--ink-900);
        border: 1px solid var(--ink-800);
        border-radius: var(--r-md);
        box-shadow: var(--shadow-sm);
    }

    :deep(pre code) {
        padding: 0;
        font-size: 13px;
        line-height: 1.6;
        color: #e2e8f0;
        background: none;
        border: none;
    }

    :deep(blockquote) {
        margin: .8em 0;
        padding: var(--sp-2) var(--sp-4);
        color: var(--ink-600);
        background: var(--ink-50);
        border-left: 3px solid var(--brand-500);
        border-radius: 0 var(--r-sm) var(--r-sm) 0;
    }

    :deep(table) {
        width: 100%;
        margin: .8em 0;
        border-collapse: collapse;
        font-size: .92em;
    }

    :deep(th),
    :deep(td) {
        padding: 7px 10px;
        text-align: left;
        border: 1px solid var(--ink-200);
    }

    :deep(th) {
        background: var(--ink-50);
        font-weight: 600;
    }

    :deep(hr) {
        margin: 1em 0;
        border: none;
        border-top: 1px solid var(--ink-200);
    }

    :deep(a) {
        color: var(--brand-600);
        text-decoration: underline;
        text-underline-offset: 2px;
    }
}

/* ---------- 输入区 ---------- */
.composer-wrap {
    flex: none;
    padding: var(--sp-3) var(--sp-8) var(--sp-5);
    background: linear-gradient(to bottom, rgba(248, 250, 252, 0), var(--ink-50) 24%);
}

.message-container {
    max-width: var(--content-max);
    margin: 0 auto;
    padding: var(--sp-3) var(--sp-3) var(--sp-2);
    background: var(--white);
    border: 1px solid var(--ink-200);
    border-radius: var(--r-xl);
    box-shadow: var(--shadow-md);
    transition: border-color .18s ease, box-shadow .18s ease;

    &:focus-within {
        border-color: var(--brand-500);
        box-shadow: var(--shadow-md), 0 0 0 3px var(--brand-50);
    }

    textarea {
        display: block;
        width: 100%;
        max-height: 200px;
        padding: var(--sp-1) var(--sp-2);
        font-family: inherit;
        font-size: 15px;
        line-height: 1.6;
        color: var(--ink-900);
        background: transparent;
        border: none;
        resize: none;
        field-sizing: content;

        &::placeholder {
            color: var(--ink-400);
        }

        &:focus,
        &:active {
            outline: none;
        }
    }

    .nav-list {
        display: flex;
        align-items: center;
        gap: var(--sp-2);
        margin-top: var(--sp-2);
    }

    .nav-list__spacer {
        flex: 1;
    }
}

/* 工具按钮（上传） */
.btn-ghost-tool {
    padding: 8px;
    color: var(--ink-500);

    &:hover:not(:disabled) {
        color: var(--brand-600);
    }
}

/* 模型选择 */
.llm-box {
    position: relative;

    .llm-list {
        position: absolute;
        bottom: calc(100% + 8px);
        left: 0;
        min-width: 180px;
        padding: var(--sp-1);
        background: var(--white);
        border: 1px solid var(--ink-200);
        border-radius: var(--r-md);
        box-shadow: var(--shadow-lg);
        z-index: 20;
    }

    .llm-item {
        display: block;
        width: 100%;
        padding: 8px 10px;
        font-family: inherit;
        font-size: 13.5px;
        text-align: left;
        color: var(--ink-700);
        background: transparent;
        border: none;
        border-radius: var(--r-xs);
        cursor: pointer;
        transition: background .14s ease, color .14s ease;

        &:hover {
            color: var(--brand-700);
            background: var(--brand-50);
        }
    }

    .llm-model {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 8px 12px;
        font-family: inherit;
        font-size: 13.5px;
        color: var(--ink-600);
        background: var(--ink-50);
        border: 1px solid var(--ink-200);
        border-radius: var(--r-sm);
        cursor: pointer;
        transition: background .16s ease, border-color .16s ease;

        &:hover {
            background: var(--ink-100);
            border-color: var(--ink-300);
        }

        :deep(.app-icon) {
            transition: transform .22s ease;

            &.rotated {
                transform: rotate(180deg);
            }
        }
    }
}

.composer-hint {
    max-width: var(--content-max);
    margin: var(--sp-2) auto 0;
    font-size: 12px;
    color: var(--ink-400);
    text-align: center;
}
</style>
