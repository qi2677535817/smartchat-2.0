# 验收证据：add-conversation-pdf-attachments

> 验收日期：2026-10-03　环境：Windows 11 · Node 22.14 · Python 3.14.7 · pdfplumber 0.11.10

## 方案确认

- PDF 纯文本提取采用**方案 ②（新建独立 `extract_text.py`，不改动 `build_review_html.py`）**
- 附件严格隔离：走独立 `session_attachments` 表，不写全局 RAG 库

## 任务 1：PDF 纯文本提取脚本

- `extract_text.py --pdf --out`：真实招标 PDF（79 页）提取成功，退出码 0，输出 51905 字符正确中文
- 后端 `PythonPipelineService.extractText()` + `TenderModule.exports` 编译通过

## 任务 2：会话附件实体与端点

| 用例 | 结果 |
|---|---|
| `POST /sessions/:id/attachments` 空列表 | GET 返回 `[]` 200 |
| 上传非 PDF | 400「仅支持 PDF / TXT / MD 文件」 |
| 缺少 file | 400「缺少 file 字段」 |
| 上传 79 页 PDF | 400「附件过大（2055 分块 > 500）」——保护生效 |
| 上传小 PDF（15 分块） | 201 + `chunkCount:15`，3 秒（含 15 次向量化） |
| 列表 | 返回元信息，不含向量字段 |
| 删除 | 200「删除成功」，删除后列表为空 |
| 隔离 | `knowledge-data` 与 `knowledge-vectors.json` 无变化 |

## 任务 3：检索扩展

- `searchRag(query, isTest?, extraChunks?)` 增加可选参数，复用 `compareSimilarity` 余弦逻辑；默认 `[]` 行为不变（编译级保证 + 逻辑复用）

## 任务 4：chat 链路接入

- `ChatMessageDto.sessionId`、`streamChat`/`runChatLoop` 透传、`SessionAttachmentService.listChunksBySession` 注入 `searchRag`

## 任务 5 + 端到端（核心验证）

发起 `POST /chat/stream` 携带 `sessionId`，附件内容为英文政策段，SSE 返回：

```
data: {"type":"rag","list":[
  {"name":"[附件] e2e-test.pdf","index":13},
  {"name":"[附件] e2e-test.pdf","index":14},
  {"name":"[附件] e2e-test.pdf","index":7}]}
```

证明：
1. sessionId 传递正确
2. `listChunksBySession` 返回附件 chunks
3. `searchRag` 的 extraChunks 检索命中附件内容
4. 引用来源带 `[附件]` 前缀，可区分
5. **隔离成立**：结果仅含附件命中，未混入全局中文资料（查询与全局库不相关）

## 管线回归

- `build_review_html.py` 退出码 0（HTML 正常生成，未因新增脚本受影响）
- `verify_rects.py`：**PASS 5/5、SKIP 0、FAIL 0**（100% 达标）

## 遗留与偏差

| 项 | 说明 |
|---|---|
| `stores/chat.ts` 的 sessionId 改动 | 该文件含用户既有未提交改动，未随本 change 提交，留在工作区待用户自行提交 |
| 79 页大 PDF 作为对话附件 | 被 500 分块上限拒绝，符合预期（大文档应走标书复核，对话附件定位为中小文档） |
| embedding 逐块无并发 | 一期单实例可接受；大附件（数百块）会偏慢，后续可加并发 |
| 会话删除的附件级联 | 一期由前端显式删除，未做 DB 级 onDelete 级联 |
