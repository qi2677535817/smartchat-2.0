# Proposal: add-conversation-pdf-attachments（对话内 PDF 附件作为会话上下文）

> 性质：**PRD 未显式列出的新增需求**（PRD 第 6 节六阶段之外），最接近的关联项是差距 G3（知识库联动）的延伸——把「检索能力」从全局知识库扩展为「全局 + 会话级附件」两级上下文。
> 前置：阶段 1（tender 模块的 pdfplumber 子进程调用能力）已落地，可直接复用。

## Why

当前知识库上传只接受 `.txt/.md`，PDF 会被 `file.text()` 读成乱码（已加拒绝提示）。业务上用户需要「在这个对话里贴一份招标文件 / 简历 / 报告 PDF，围绕它提问」，但又不希望它污染全局 RAG 库（其他对话不应搜到）。

因此需要一条**会话级 PDF 附件链路**：解析 PDF → 向量化 → 仅在该会话的对话中作为可检索上下文，与全局知识库严格隔离。

## What Changes

1. **新表 `session_attachment`**（会话级附件，含解析文本与向量，与全局 RAG 隔离）。
2. **新端点**：
   - `POST /sessions/:id/attachments`（multipart PDF）—— 解析 + 分块 + 向量化 + 入库
   - `GET /sessions/:id/attachments` —— 附件列表（不含向量）
   - `DELETE /sessions/:id/attachments/:attachmentId` —— 删除
3. **PDF 纯文本提取**：复用 pdfplumber（见 design，含红线 6 合规说明）。
4. **检索扩展**：`KnowledgeBaseService.searchRag()` 增加可选 `extraChunks` 参数，检索范围 = 全局库 + 会话附件（复用既有余弦逻辑，不新写检索）。
5. **对话链路**：`/chat/stream` 携带 `sessionId`，`runChatLoop` 按 sessionId 取附件向量并注入检索。
6. **前端**：对话输入框支持 PDF 附件（走新端点），附件在会话内持久化展示。

## 复用资产与不可重写理由

| 资产 | 复用方式 | 为什么不能重写 |
|---|---|---|
| pdfplumber（阶段 1 tender 管线） | 子进程提取 PDF 纯文本 | PDF 解析必须走已验证管线，Node 重写违反红线 1 |
| `ChunkingUtil.chunking()` | 附件文本分块 | 与知识库同源分块策略，保持一致 |
| `EmbeddingService.embedText()` | 附件分块向量化 | 复用外部 embedding 配置与调用 |
| `KnowledgeBaseService.searchRag()` | 增加 `extraChunks` 参数扩展检索范围 | 红线 4 禁止新写检索逻辑 |
| session 模块 TypeORM 写法 | `session_attachment` 实体参照 `session.entity.ts` | 保持模块风格统一 |

## 架构红线确认（本 change 触碰 3 条，需人工确认）

| 红线 | 是否触碰 | 说明 |
|---|---|---|
| 1 禁止 Node 重写 pdfplumber 管线 | 否（复用） | 提取走 Python 子进程，零 Node 重写 |
| 4 禁止新写检索逻辑 | 否（扩展复用） | 只给 `searchRag` 增加 `extraChunks` 可选参数，余弦计算复用 `compareSimilarity` |
| 6 禁止修改 skill Python 脚本逻辑 | **触碰（合规边界）** | 方案二选一：①给 `build_review_html.py` 加 `--dump-text` 参数（红线 6 明确允许「只新增命令行参数」）；②新建独立 `extract_text.py`（不碰现有脚本）。**推荐 ②**，理由见 design |
| 2/3/5/7 | 不涉及 | — |

> ⚠️ 红线 6 是本 change 唯一需要显式确认的点：无论 ① 还是 ②，都只「新增」不「改逻辑」，且完成后会重跑 `verify_rects.py` 确认原有能力未破坏。

## 回滚方案

5 个任务 = 5 个 commit，一任务一验收；失败即 `git revert` 对应 commit。
新增代码集中在 `session` 模块（attachment 实体/端点）与既有文件的**最小增量**（searchRag 加参数、chat 传 sessionId）；Python 侧为**新增独立脚本**（不触碰现有 build_review_html.py），回滚零风险。

## Impact

- **规格**：新增 capability `conversation-attachment`。
- **后端**：`session` 模块新增实体/端点；`knowledge-base.service.ts` 加参数；`chat.dto/controller/service` 加 sessionId 透传；新增 PDF 文本提取脚本调用。
- **前端**：`ChatView.vue` 附件上传改走新端点（支持 PDF）；`stores/chat.ts` 的 `/chat/stream` 请求加 sessionId（该文件含未提交改动，实施时需与用户改动协同）。
- **数据库**：新表 `session_attachment`。
- **依赖**：零新增。
