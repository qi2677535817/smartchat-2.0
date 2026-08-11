---
tags: [学习笔记, SSE, NestJS, Vue3, DeepSeek, 大模型]
创建时间: 2026-08-10
---

# SSE 流式接入 DeepSeek —— 从零到完整链路

> 本项目（smartchat-2.0）手动敲码实现：Vue3 前端 → NestJS 后端（SSE 代理中转）→ DeepSeek API。全程手敲，踩坑无数，本文沉淀全部经验。

## 一、技术栈与架构

```
浏览器 (Vue3) ──POST /chat/stream──> NestJS 后端 ──HTTPS──> DeepSeek API
      │                               │                        │
      │   text/event-stream           │  stream: true           │
      └────────────── SSE 流 ◄────────┴─────── 逐 token ◄───────┘
```

- 前端：Vue3 + Vite + `fetch` + `ReadableStream.getReader()`
- 后端：NestJS 11 + `@Sse()` 装饰器 + RxJS `Observable`
- 模型：`deepseek-v4-flash`（DeepSeek V4，OpenAI 兼容 API）
- 为什么后端要做代理中转？
  1. API Key 不能暴露给浏览器（安全）
  2. 可加日志、限流、消息持久化
  3. 前端与供应商解耦，可随时换模型

## 二、SSE 协议核心知识

**SSE（Server-Sent Events）**：客户端发起普通 HTTP 请求，服务端不关闭连接，持续推送 `text/event-stream` 格式文本。

### SSE 消息格式

```
data: 第一行内容
id: 1

data: 第二行内容
id: 2

data: [DONE]
```

- `data:` 后跟数据，**以空行分隔每条消息**
- `[DONE]` 是常见的结束标记（OpenAI 系 API）
- 浏览器原生 API 是 `EventSource`，但**只支持 GET**；要 POST 必须用 `fetch` + `getReader()` 手动解析

### 为什么前端不用 EventSource？

`EventSource` 只能 GET，且无自定义请求头。AI 对话要 POST body，所以用 `fetch` + 流式读取（`response.body.getReader()`）。

## 三、完整数据流（三层解析）

SSE 在整条链路上出现**三层**，每层都要处理"剥 `data:` 前缀"：

| 层 | 传输内容 | 后端/前端动作 |
|---|---|---|
| DeepSeek → NestJS | `data: {"choices":[{"delta":{"content":"你"}...}]}` | 剥前缀 + `JSON.parse` + 取 `choices[0].delta.content` |
| NestJS → 浏览器 | `data: 你` + `id: 1` | 剥前缀 + 取纯文字 |
| 浏览器显示 | `你` | 直接拼接 |

### 后端核心代码（buffer + 逐行解析）

```typescript
streamChat(content: string): Observable<MessageEvent> {
  return new Observable((observer) => {
    fetch(this.DEEPSEEK_BASE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.DEEPSEEK_API_KEY}` },
      body: JSON.stringify({
        model: 'deepseek-v4-flash',
        messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content }],
        stream: true,
      }),
    })
      .then(async (response) => {
        if (!response.ok) {
          const errorText = await response.text();   // 带出 DeepSeek 原始错误
          throw new Error(`DeepSeek API 错误 ${response.status}: ${errorText}`);
        }
        if (!response.body) throw new Error('Response body is null');
        const reader = response.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let buffer = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });   // 关键：stream:true
          buffer += chunk;
          let lines = buffer.split('\n');
          buffer = lines.pop() ?? '';    // 未完整的行留到下次
          for (const line of lines) {
            if (line.trim() === '') continue;
            if (!line.startsWith('data:')) continue;
            const jsonStr = line.slice(5).trim();
            if (jsonStr === '[DONE]') { observer.complete(); return; }
            const parsed = JSON.parse(jsonStr);
            const content = parsed.choices[0].delta.content;
            if (content) observer.next({ data: { content } });   // 见"关键决策"
          }
        }
        observer.complete();
      })
      .catch((error) => observer.error(error));
  });
}
```

### 前端核心代码（同样 buffer + 逐行）

```typescript
let buffer = ''
while (true) {
  const { done, value } = await read!.read()
  if (done) break
  buffer += decoder.decode(value)
  let lines = buffer.split('\n')
  buffer = lines.pop() || ''
  for (const line of lines) {
    if (line.trim() === '') continue
    if (!line.startsWith('data:')) continue
    const event = JSON.parse(line.slice(5).trim())   // 见"关键决策"
    messageList[messageList.length - 1]!.content += event.content
  }
}
```

## 四、关键决策：传输传 JSON 对象，而非裸字符串 ⭐

**这是本项目踩过最深的坑。**

### 坑的表现

AI 回复的 markdown 全部粘连：`##前端开发行业趋势以下是...`，标题、列表、换行全部失效。看似 marked 解析问题，实际是**换行在传输中丢失**。

### 根因（读 NestJS 源码定位）

`node_modules/@nestjs/core/router/sse-stream.js`：

```javascript
function toDataString(data) {
    if (isObject(data)) {
        return toDataString(JSON.stringify(data));   // 对象 → JSON.stringify → 单行！
    }
    return data
        .split(/\r\n|\r|\n/)              // ← 裸字符串按换行拆分成多行
        .map(line => `data: ${line}\n`)
        .join('');
}
```

**如果 `observer.next({ data: content })` 传裸字符串，content 里的 `\n` 会被拆成多个 `data:` 行；前端按行拼接时换行全丢！**

### 解决：后端传对象，前端 JSON.parse

```typescript
// 后端
observer.next({ data: { content } });   // NestJS 会 JSON.stringify 成单行，换行转义为 \n 无损传输
```

```typescript
// 前端
const event = JSON.parse(line.slice(5).trim())
content += event.content
```

### 为什么这是业界标准

DeepSeek / OpenAI 官方 API 返回的就是 `data: {"choices":[...]}` 单行 JSON——同一个道理：**换行被 JSON 转义保护，SSE 传输无损**。

| 传输方式 | 换行处理 | 适用场景 |
|---|---|---|
| 裸文本 | `\n` 被 SSE 拆行、前端难恢复 | 简单通知、状态推送 |
| JSON 对象 | `\n` 转义进 JSON，单行传输无损 | AI 对话、markdown、结构化数据 |

## 五、踩坑清单（全部亲身经历）

### 坑 1：URL 拼写错误 → 404
`.env` 里 `DEEPSEEK_BASE_URL` 写成 `.../chat/completion`（少个 s），正确是 `completions`。注入的配置错了，硬编码的对。**教训：先用 curl 直接测 API，判断是代码问题还是配置/网络问题。**

### 坑 2：TypeScript 类型错误（TS2769 / TS18047）
- `configService.get()` 返回 `string | undefined`，`fetch` 不认 undefined → 用 `getOrThrow()`（快速失败）或 `??` 兜底或 `!` 断言
- `response.body` 可能是 `null` → 加 `if (!response.body)` 检查，TS 自动类型收窄
- **教训：类型系统在帮你拦截"运行时才炸"的 bug，报错是朋友。**

### 坑 3：MessageEvent 导入来源错误
`import { MessageEvent } from 'ws'` —— 错！`ws` 没装，且 MessageEvent 是 NestJS 自己定义的接口：
```typescript
import { MessageEvent } from '@nestjs/common';
```

### 坑 4：SSE `data:` 前缀没剥 → JSON.parse 报错
错误信息：`Unexpected token 'd', "data: {"id"... is not valid JSON`。`d` 就是 `data:` 的第一个字母。**学会读错误信息 = 学会调试。** 修法：`line.slice(5)` 剥掉前 5 个字符。

### 坑 5：字段名拼错 → 400 Bad Request
`{ role: 'system', centent: '...' }` —— `centent` 应为 `content`。JS 对象键名任意写，**编译不报错**，运行时 DeepSeek 校验消息结构才发现。**教训：调 API 第一反应看请求体是否符合规范。**

### 坑 6：错误响应体当 SSE 流处理
DeepSeek 返回 401/429/500 时 body 是错误 JSON 而非流。必须先 `if (!response.ok) { const errorText = await response.text(); throw ... }` 再读流，否则错误 JSON 会被转发给前端。

### 坑 7：流式首块数据没有 content
第一块 `delta` 只有 `{ role: "assistant" }`，没有 content。必须 `const content = parsed.choices[0]?.delta?.content; if (content)` 空值兜底，否则拼出 "undefined"。

### 坑 8：中文乱码（跨 chunk 切半个字）
`TextDecoder.decode(value)` 默认会把跨 chunk 切半的中文字符解成乱码 `�`。修法：`decoder.decode(value, { stream: true })`——缓存未完结的字节等下一个 chunk。

## 六、RxJS Observable 三条通道

```typescript
observer.next(data)      // 正常数据通道 → 前端 data: xxx
observer.error(err)      // 错误通道     → NestJS 转成 event: error 发给前端
observer.complete()      // 完成通道     → 连接正常关闭
```

- `observer.error` 会被前端看到 `event: error` + 错误信息
- `@Sse()` 装饰器把 Observable 的每个 `next` 序列化成 SSE 消息

## 七、markdown 渲染（marked + DOMPurify）

```typescript
import { marked } from 'marked'
import DOMPurify from 'dompurify'

export function renderMarkdown(text: string): string {
    const html = marked.parse(text) as string   // 同步路径！async 不能用于 v-html
    return DOMPurify.sanitize(html)             // 防 XSS：AI 输出是第三方内容，必须清洗
}
```

- **marked**：markdown → HTML（只负责结构）
- **DOMPurify**：清洗危险 HTML（`<script>`、`onclick`）——聊天应用防 XSS 的底线
- **v-html 必须用同步字符串**，`marked.parse` 有同步/异步两条路径，`{ async: true }` 返回 Promise 会渲染失败
- **scoped 样式穿透**：v-html 生成的内容没有 `data-v-xxx`，要用 `:deep()` 才能命中

```scss
.rows-box {
  :deep(h2) { margin: 0.8em 0 0.4em; }
  :deep(p) { margin: 0.5em 0; }
  :deep(pre) { background: #282c34; color: #abb2bf; padding: 10px; border-radius: 6px; overflow-x: auto; }
  :deep(code) { background: #f0f0f0; padding: 2px 4px; border-radius: 3px; }
  :deep(pre code) { background: none; padding: 0; }
  :deep(ul), :deep(ol) { padding-left: 1.5em; margin: 0.5em 0; }
  :deep(blockquote) { margin: 1.2em 0; padding: 12px 16px; border-left: 4px solid #8b5cf6; background: rgba(139,92,246,0.06); }
}
```

**踩过的样式坑：**
- ❌ `white-space: pre-wrap` 与 markdown 渲染冲突——pre-wrap 是"纯文本模式"兜底，会破坏 HTML 盒模型的间距，导致内容拥挤、列表粘连。上了 marked 就该删掉
- ⚠️ AI 输出可能不规范（`##1.`、`-React` 缺空格）——这是"脏数据"，库是"死的"，需要你在清洗层用正则修复（真实产品如 ChatGPT 也这么干）

## 八、系统提示词（Prompt Engineering 起点）

`messages` 数组支持三种角色：

| role | 含义 | 例子 |
|---|---|---|
| `system` | 系统指令，设定 AI 行为规范 | "你是客服助手，用中文回答" |
| `user` | 用户消息 | "你好" |
| `assistant` | AI 的历史回答 | "你好，有什么可以帮你？" |

```typescript
messages: [
  { role: 'system', content: '你是 SmartChat 智能助手。请遵循输出规范：...' },
  { role: 'user', content: content },
]
```

**同一个模型，换 system 提示词 = 换一个产品。** 提示词工程是 LLM 应用的核心产品逻辑。

## 九、NestJS 依赖注入（DI）

```typescript
@Injectable()
export class ChatService {
  constructor(private readonly configService: ConfigService) {}  // 框架注入依赖
  // 使用：this.configService.get('KEY') / getOrThrow('KEY')
}
```

- `private readonly` 是 TS 参数属性语法，自动 `this.configService = configService`
- `ConfigModule.forRoot({ isGlobal: true })` 全局注册后容器里才有 ConfigService
- 不注册会注入失败直接报错

## 十、调试方法论沉淀

1. **先怀疑数据，再怀疑代码**：多处共用同一配置/同一错误 → 问题大概率在共享层（.env）
2. **curl 是调 API 的第一工具**：绕过代码直接测 API，5 秒定位是代码问题还是配置/网络问题
3. **错误信息逐字读**：`Unexpected token 'd'` 里的 `d` 就是 `data:` 的第一个字母
4. **类型报错是朋友**：TS 把运行时 bug 提前到编译时拦截
5. **读库源码定位根因**：NestJS 换行丢失问题，读 `sse-stream.js` 源码直接找到 `split(/\r\n|\r|\n/)`
6. **调 API 报错必须带出响应体**：`throw new Error(\`DeepSeek API 错误 ${status}: ${errorText}\`)`，否则只能看到 400/404

## 十一、后续方向（待做）

- [ ] **多轮对话**：前端发历史 messages 数组，后端透传（AI 无状态，上下文全靠 messages）
- [ ] 流式渲染优化：未闭合 markdown 的防抖/惰性渲染，避免闪烁
- [ ] deepseek-reasoner 推理模型：`reasoning_content` 与 `content` 分流
- [ ] 对话历史持久化（数据库）
