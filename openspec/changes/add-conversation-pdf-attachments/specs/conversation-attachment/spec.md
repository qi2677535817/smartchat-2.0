# spec delta: conversation-attachment（新增 capability）

> 本文件为 OpenSpec 变更增量：全部为 ADDED Requirements。
> 核心约束：会话附件与全局 RAG 库严格隔离；检索必须复用 `searchRag`。

## ADDED Requirements

### Requirement: 会话附件上传与解析

系统 SHALL 提供 `POST /sessions/:id/attachments`，接受 `multipart/form-data` 字段 `file`（文字版 PDF），调用 Python pdfplumber 管线提取纯文本，分块向量化后存入 `session_attachment` 表，且 SHALL NOT 写入全局 RAG 库。

#### Scenario: 上传文字版 PDF

- **WHEN** 客户端上传 `.pdf` 文件，pdfplumber 成功提取出非空文本，embedding 全部成功
- **THEN** 返回 201 且包含 `id`、`filename`、`chunkCount`
- **AND** `session_attachment` 表新增一条记录，`chunks` 含每条分块文本与向量
- **AND** 全局 RAG 库（`knowledge-data` 与 `knowledge-vectors.json`）不产生任何变化

#### Scenario: 上传非 PDF

- **WHEN** 上传文件的扩展名或 MIME 不是 PDF
- **THEN** 返回 400，错误信息说明仅支持 PDF
- **AND** 不落盘、不建记录、不调 Python

#### Scenario: 扫描件或无文本层 PDF

- **WHEN** pdfplumber 提取的纯文本为空或长度低于阈值
- **THEN** 返回 400，错误信息说明「扫描件暂不支持，请提供文字版 PDF」

#### Scenario: 附件过大

- **WHEN** 提取文本分块后超过 500 块
- **THEN** 返回 400，错误信息说明附件过大需拆分

### Requirement: 会话附件列表与删除

系统 SHALL 提供 `GET /sessions/:id/attachments` 返回该会话附件元信息（不含向量），以及 `DELETE /sessions/:id/attachments/:attachmentId` 删除单条附件。

#### Scenario: 查询会话附件

- **WHEN** 请求某会话的附件列表
- **THEN** 返回该会话全部附件，每条含 `id`、`filename`、`chunkCount`、`createdAt`
- **AND** 不返回 `chunks` 向量字段

#### Scenario: 删除附件

- **WHEN** 删除某会话下存在的附件
- **THEN** 返回成功且该附件记录被移除，其他会话附件不受影响

### Requirement: 会话级检索（隔离）

系统 SHALL 在对话流式请求携带 `sessionId` 时，将检索范围扩展为「全局 RAG 库 + 该会话附件」，SHALL 复用 `KnowledgeBaseService.searchRag()`（经 `extraChunks` 参数），且其他会话的附件不可被检索到。

#### Scenario: 携带 sessionId 的对话检索

- **WHEN** `/chat/stream` 请求携带 `sessionId`，且该会话存在附件
- **THEN** 检索候选集包含全局库命中与该会话附件命中，结果按相似度排序取 top-k
- **AND** 附件命中项在引用来源中以可区分方式标注（如 `[附件] filename`）

#### Scenario: 附件严格隔离

- **WHEN** 会话 A 存在附件，会话 B（或无 sessionId）发起的检索
- **THEN** 会话 A 的附件内容不出现在会话 B 的检索结果中

#### Scenario: 无 sessionId 的兼容

- **WHEN** `/chat/stream` 请求未携带 `sessionId`
- **THEN** 检索范围仅全局 RAG 库，行为与改造前完全一致

### Requirement: 对话附件前端展示

系统 SHALL 在对话输入区支持选择 PDF 附件，展示为可删除的标签，并随会话切换加载该会话已入库的附件列表。

#### Scenario: 选择 PDF 附件

- **WHEN** 用户在输入区选择 `.pdf` 文件
- **THEN** 附件以标签形式展示（文件名 + 体积），未发送前不产生网络请求

#### Scenario: 发送时入库并可删除

- **WHEN** 用户点击发送
- **THEN** 先上传附件入库，成功后再发送消息；上传中标签不可重复触发，但可删除
