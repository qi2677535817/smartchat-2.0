# Tasks: add-conversation-pdf-attachments

> 执行规则：一任务一次 git commit（中文），做完立刻验收；失败立即回滚。严格顺序执行，禁止提前实现后续任务。
> 前置：阶段 1 tender 模块已就绪；`python` 与 `pdfplumber` 可用。

## 1. PDF 纯文本提取脚本

- [ ] 1.1 在 skill `scripts/` 下新建 `extract_text.py`（`--pdf` / `--out`，逐页 `extract_text()` 拼接输出 UTF-8 纯文本；不触碰现有脚本）
- [ ] 1.2 后端新增 `pdf-text-extract` 服务（复用 `PythonPipelineService` 的 spawn/超时/stderr 模式），或给 `PythonPipelineService` 加 `extractText(pdfPath, outPath)` 方法

**验收**：`python extract_text.py --pdf <招标PDF> --out out.txt` 退出码 0，out.txt 为非空中文文本；`npm run build` 通过。
**commit**：`feat: 新增PDF纯文本提取脚本与后端调用服务`

## 2. 会话附件实体与端点

- [ ] 2.1 新增 `session-attachment.entity.ts`（design 表结构）+ `app.module.ts` 注册
- [ ] 2.2 `POST /sessions/:id/attachments`：校验 PDF → 提取文本 → `ChunkingUtil.chunking` → `EmbeddingService.embedText` 逐块向量化 → 入库
- [ ] 2.3 `GET /sessions/:id/attachments`（不含向量）、`DELETE /sessions/:id/attachments/:attachmentId`

**验收**：Postman 上传 PDF → 返回 201 + chunkCount；GET 列表可见；DELETE 后消失；`knowledge-data` 与 `knowledge-vectors.json` 无变化（隔离验证）。
**commit**：`feat: 会话附件实体与上传/列表/删除端点`

## 3. 检索扩展

- [ ] 3.1 `searchRag(query, isTest?, extraChunks?)` 增加可选参数，内部合并全局 chunks + extraChunks 后复用余弦逻辑
- [ ] 3.2 附件服务提供 `listChunksBySession(sessionId)`：读表、解析 chunks JSON、展平为 Chunk[]

**验收**：不传 extraChunks 时全局检索行为不变；传附件 chunks 时能命中附件内容。
**commit**：`feat: searchRag支持会话附件extraChunks检索`

## 4. chat 链路接入

- [ ] 4.1 `ChatMessageDto` 加 `sessionId`；`ChatController.streamChat` / `ChatService.streamChat` 透传
- [ ] 4.2 `runChatLoop` 依 sessionId 拉取附件 chunks 传入 `searchRag`
- [ ] 4.3 前端 `stores/chat.ts` 发送 `/chat/stream` 带 `activeId`（**该文件含用户未提交改动，需协同**）

**验收**：带 sessionId 的对话能检索到该会话附件内容并给出引用；无 sessionId 行为不变。
**commit**：`feat: 对话流式接入会话附件检索`

## 5. 前端附件交互

- [ ] 5.1 `ChatView.vue`：附件支持 `.pdf`，走新端点；保留待发送 + 可删除标签
- [ ] 5.2 会话切换时 `GET /sessions/:id/attachments` 加载该会话附件列表并展示

**验收**：选择 PDF → 标签展示 → 发送入库 → 对话能引用；切换会话附件列表正确；`npm run type-check` 通过。
**commit**：`feat: 对话输入框支持PDF附件与会话级持久展示`

## 收尾验收

- [ ] 回归：`verify_rects.py` 对阶段 1 产物 PASS 100% / SKIP 0（确认未破坏管线）
- [ ] `nest build` + `vue-tsc` 通过
- [ ] 将验收证据写入本目录 `verification.md`

## 明确不做（越界即停）

- 不把附件写进全局 RAG 库（严格隔离，红线 4 语义）
- 不做 OCR / 扫描件识别
- 不新写检索算法（只扩展 searchRag 参数）
- 不改 `build_review_html.py` 现有逻辑（红线 6）
