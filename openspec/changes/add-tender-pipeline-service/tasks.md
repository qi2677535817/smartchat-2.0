# Tasks: add-tender-pipeline-service

> 执行规则：一任务一次 git commit（信息中文），做完立刻验收；验收不过立即回滚，禁止在坏状态上叠加。任务 1-4 顺序执行，不得跨阶段提前实现阶段 2+ 内容（FC 提取、前端、RAG 均不在本 change）。
> 前置检查：阶段 0 产物在位（基线.html、items.json、一份真实招标 PDF）；`python --version` 可用。

## 1. 模块骨架与数据表

- [ ] 1.1 新建 `server/src/modules/tender/`：`tender.module.ts`、`tender-document.entity.ts`（按 design 表结构）、空的 `tender.controller.ts` / `tender.service.ts` / `python-pipeline.service.ts`
- [ ] 1.2 `app.module.ts` 注册：`imports` 加 `TenderModule`，`entities` 加 `TenderDocument`

**验收**：`cd server && npm run build` 退出码 0；启动 `npm run start:dev` 无报错，`data-cache/smartchat.db` 中出现 `tender_documents` 表（用 SQLite 工具或日志确认）。
**commit**：`tender: 阶段1-1 新增tender模块骨架与tender_document表`

## 2. 上传受理（POST /tender/review）

- [ ] 2.1 `FileFieldsInterceptor([{ name: 'file', maxCount: 1 }, { name: 'items', maxCount: 1 }])` 接收 multipart
- [ ] 2.2 校验：file 扩展名/MIME 为 PDF，否则 400；items 可 JSON.parse 且为非空数组，否则 400
- [ ] 2.3 生成 uuid → 落盘 `data-cache/tender/<uuid>/{source.pdf, items.json}` → 写入 `tender_document` → 返回 `{ id }`

**验收**：
- `curl -F "file=@<真实招标PDF>" -F "items=@<阶段0的items.json>" http://localhost:3000/tender/review` 返回 id，且目录内两个文件字节数与原件一致，库中新增记录
- `curl -F "file=@某个.docx" ...` 返回 400；items 传非法 JSON 返回 400，且不产生落盘目录
**commit**：`tender: 阶段1-2 实现上传受理与校验落盘入库`

## 3. Python 管线子进程调用

- [ ] 3.1 `python-pipeline.service.ts`：`TENDER_SKILL_DIR` 配置读取与路径存在性校验（脚本 + `assets/vendor`）→ `python --version` 探测（失败 503）→ `spawn` 五参数调用（design 参数表）→ 150s 超时 `taskkill /T /F` → stderr 收集与透传
- [ ] 3.2 编排成功路径：退出码 0 且产物文件存在且非空 → 响应 `{ id, downloadUrl: "/tender/review/<id>/download" }`

**验收**：
- 用任务 2 的同款请求重发，150 秒内返回 downloadUrl，`data-cache/tender/<id>/review.html` 生成
- 打开该 HTML 与阶段 0 `基线.html` 内容一致（页数、高亮框、条目数相同）
- 故障注入：临时把 `TENDER_SKILL_DIR` 指到不存在路径 → 500 且信息指明配置项；改回后恢复
- **红线 6 核验**：对 skill 目录做改动前后文件清单比对（如 `Get-ChildItem -Recurse | Get-FileHash`），确认零文件被修改
**commit**：`tender: 阶段1-3 实现spawn调用Python管线生成复核HTML`

## 4. 产物下载（GET /tender/review/:id/download）

- [ ] 4.1 流式返回产物：`Content-Type: text/html` + `Content-Disposition: attachment; filename*=UTF-8''review.html`
- [ ] 4.2 分支：id 不存在 → 404；产物文件丢失 → 404 并说明原因

**验收**：
- 用任务 3 返回的 downloadUrl 下载，浏览器双击打开可正常翻页高亮，与基线一致
- `curl -i http://localhost:3000/tender/review/不存在的id/download` 返回 404
- **计时**：从上传到下载完成全链路 ≤ 3 分钟（PRD 验收口径）
**commit**：`tender: 阶段1-4 实现产物下载端点`

## 5. 阶段验收与收尾

- [ ] 5.1 最终 `cd server && npm run build` 通过
- [ ] 5.2 回归佐证：对阶段 0 同款 PDF + items 跑 `python <skill>/scripts/verify_rects.py --pdf <pdf> --items <items>`，确认 PASS 率 100%、SKIP = 0（本 change 未改 Python，此为回归确认而非新验证）
- [ ] 5.3 将各项验收证据（命令与输出摘要）记入本目录 `verification.md`，供归档时引用

**commit**：`tender: 阶段1-5 阶段验收与证据留存`

## 明确不做（越界即停）

- 不写 FC 提取 / `submit_requirements` 工具（阶段 2）
- 不写任何 Vue 前端（阶段 3）
- 不调 `searchRag`（阶段 4）
- 不做导出与 chat 入口（阶段 5）
- 不改 skill 目录任何文件；若发现实现需要改脚本逻辑，立即停下问人
