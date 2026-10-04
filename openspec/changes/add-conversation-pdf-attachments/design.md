# Design: add-conversation-pdf-attachments

## 与既有模块的接口关系

| 对象 | 关系 | 说明 |
|---|---|---|
| `session` 模块 | 承载新实体与端点 | 新增 `session-attachment.entity.ts` + 端点；参照 `session.entity.ts` / `session.controller.ts` 风格 |
| `knowledge-base` 模块 | 复用分块、向量化、检索 | 附件服务注入 `ChunkingUtil`（静态）、`EmbeddingService`；`searchRag` 增加 `extraChunks` 参数 |
| `chat` 模块 | 检索时注入附件 | `/chat/stream` 增加可选 `sessionId`，`runChatLoop` 依 sessionId 拉取附件向量传入 `searchRag` |
| `tender` 模块 | 复用 PDF 子进程调用方式 | 附件的 PDF 提取复用「spawn python + 超时 + stderr 透传」模式（可抽出公共 util 或复制精简版） |
| `app.module.ts` | 注册新实体 | `entities` 数组加 `SessionAttachment` |

## PDF 纯文本提取（红线 6 合规）

**推荐方案 ②：新建独立脚本** `extract_text.py`，放 skill 目录 `scripts/` 下，不触碰现有 `build_review_html.py`：

```
用法: python extract_text.py --pdf <in.pdf> --out <out.txt>
逻辑: pdfplumber.open → 逐页 extract_text() → 拼接 → 写出 UTF-8 纯文本
```

理由：红线 6 字面禁止「修改现有脚本逻辑」，新建独立脚本零改动风险；提取纯文本是独立简单操作，不需要复用 build_review_html 的词级坐标/容错匹配等重逻辑。

- 子进程调用方式复用 `PythonPipelineService` 既有模式：`spawn('python', ['extract_text.py', '--pdf', ...])`，含 150s 超时、stderr 透传、Python 环境探测。
- 脚本路径解析沿用 `TENDER_SKILL_DIR`（缺省 `~/.workbuddy/skills/tender-material-checklist`）。
- 扫描件 PDF（无文本层）→ 提取结果为空或过短 → 服务端拒绝并提示「扫描件暂不支持，请提供文字版 PDF」。

## 数据表（TypeORM 写法）

`session_attachment`（表名 `session_attachments`）：

| 字段 | 类型 | TypeORM | 说明 |
|---|---|---|---|
| `id` | uuid PK | `@PrimaryGeneratedColumn('uuid')` | |
| `sessionId` | varchar + 索引 | `@Column()` + `@Index()` | 归属会话 |
| `filename` | varchar | `@Column()` | 原始文件名 |
| `text` | text | `@Column({ type: 'text' })` | 解析全文（展示/降级用） |
| `chunks` | text | `@Column({ type: 'text' })` | JSON 数组：`{ text, vector:number[] }[]` |
| `createdAt` | integer | `@Column()` | 毫秒时间戳 |

`sessionId` 与 `Session.id` 逻辑关联（一期不加外键约束，与 `Message.sessionId` 现有做法一致）。删除会话时前端显式级联删除附件（或后续补 onDelete）。

## 附件入库流程

```
POST /sessions/:id/attachments (multipart file=PDF)
  → 校验 PDF 扩展名/MIME（否则 400）
  → spawn python extract_text.py --pdf --out → 纯文本
  → 空文本/过短 → 400「扫描件或无可提取文本」
  → ChunkingUtil.chunking(text, 200) → string[]
  → 逐块 EmbeddingService.embedText() → number[][]
  → 组装 chunks JSON 存入 session_attachment
  → 返回 { id, filename, chunkCount, size }
```

- 逐块 embedding 无并发控制（一期单实例，附件通常 1 份、分块可控）；若单文件分块超 500 块则拒绝（沿用知识库防失控经验）。
- embedding 失败 → 500，不写入半成品记录。

## 检索扩展（红线 4 合规）

`KnowledgeBaseService.searchRag(query, isTest?, extraChunks?)`：

```ts
async searchRag(query: string, isTest = false, extraChunks: Chunk[] = []) {
    const base = isTest ? this.test_chunks : this.chunks
    const merged = { meta: base.meta, chunks: [...base.chunks, ...extraChunks] }
    // 后续 compareSimilarity 逻辑复用，仅检索集合不同
}
```

- 默认 `extraChunks = []` → 行为与现状完全一致（不影响现有调用）。
- chat 侧传入本会话全部附件 chunk 展平数组；检索结果与全局结果同构（含 `name` 用 filename 标注），前端引用来源展示一致。
- 附件 chunk 的 `name` 字段统一带前缀 `[附件] ` 以便前端区分来源。

## chat 链路改造

- `ChatMessageDto` 增加 `@IsOptional() @IsString() sessionId`。
- `ChatController.streamChat` → `chatService.streamChat(body.messages, body.model, body.sessionId)`。
- `runChatLoop`：若有 sessionId → `attachmentService.listChunksBySession(sessionId)` → 展平 chunks → `searchRag(query, false, extraChunks)`。
- 前端 `stores/chat.ts` 发送 `/chat/stream` 时带上 `activeId`。

## 前端交互

- 输入框附件支持 `.pdf`（连同 `.txt/.md` 走文本直传；PDF 走新端点）。
- 附件标签展示文件名 + 体积 + 解析状态；上传中可删；发送前确保附件已入库（与现有待发送逻辑一致）。
- 会话切换时按 `GET /sessions/:id/attachments` 加载该会话附件列表。

## 降级方案

| 情形 | 行为 |
|---|---|
| 扫描件 / 无文本层 PDF | 提取文本为空或过短 → 400 提示「请提供文字版 PDF」 |
| 环境缺 Python | 复用既有 503 探测与提示 |
| 附件分块超 500 | 400「附件过大，请拆分」 |
| embedding 接口异常 | 500，记录日志，不写半成品 |
| 会话被删除 | 前端删除会话时同步 DELETE 附件（一期显式级联，不依赖外键） |
