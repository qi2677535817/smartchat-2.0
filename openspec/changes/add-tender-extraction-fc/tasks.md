# Tasks: add-tender-extraction-fc

> 执行规则：一任务一次 git commit（中文），做完立刻验收；失败立即回滚，禁止叠加。
> 前置：阶段 1 已交付（`/tender/review` 可用）；`python` + `pdfplumber` 可用。

## 1. 分页文本提取

- [ ] 1.1 `extract_text.py` 增加 `--json`：输出 `{"pageCount":N,"pages":[{"pno":1,"text":"..."}]}`（两份 skill 副本同步）；不传时行为不变
- [ ] 1.2 `PythonPipelineService` 增加 `extractPages(pdfPath, outPath)` 返回分页结构

**验收**：对 79 页 PDF 跑 `--json`，`pageCount` 为 79；默认模式输出与改造前一致（会话附件链路不受影响）。
**commit**：`feat: extract_text支持分页JSON输出`

## 2. FC 工具与循环复用

- [ ] 2.1 新增 `submit-requirements.tool.ts`（定义 + handler，schema 见 design）
- [ ] 2.2 `ChatService` 新增公开方法 `runToolLoop(messages, tools, model, toolChoice)`（由 `runChatLoopNonStream` 泛化而来，既有行为不变）

**验收**：`npm run build` 通过；普通对话（`/chat/stream`）行为不变。
**commit**：`feat: 新增submit_requirements工具与可复用FC循环方法`

## 3. 提取服务（分块 + 提示词 + 去重）

- [ ] 3.1 `tender-extraction.prompt.ts`：三条铁律 + 六区域 + 判定表 + 15 项易漏点 + 输出规范（常量）
- [ ] 3.2 `tender-extraction.service.ts`：分块（15 页 + 1 页重叠）→ 逐块调 `runToolLoop` → 累积条目 → 去重 → 返回 items
- [ ] 3.3 去重实现（anchor/name 归并、level 取严、冲突不合并）

**验收**：对 CPU 采购 PDF 跑提取，日志显示分块数与每块条数；去重后条目数 ≤ 去重前；抽查 3 条确认 `anchor` 能在原文找到。
**commit**：`feat: 标书条目分块提取与全局去重`

## 4. SSE 端点与 HTML 串联

- [ ] 4.1 `POST /tender/documents`（multipart）：落盘 + 建记录 → `{id}`
- [ ] 4.2 `GET /tender/documents/:id/extract`（SSE）：推送 `start/progress/generating/done/error`；完成后落 items.json 并调 `buildReviewHtml`
- [ ] 4.3 `done` 事件含 `downloadUrl`、`itemCount`、`missCount`、`failedBlocks`

**验收**：用 curl 订阅 SSE 观察事件序列；`done` 后访问 downloadUrl 得到复核 HTML；`data-cache/tender/<id>/` 含 source.pdf、items.json、review.html。
**commit**：`feat: 标书提取SSE端点与复核HTML自动生成`

## 5. 前端标书复核页

- [ ] 5.1 新增 `/tender` 路由 + `TenderView.vue`（上传 PDF → SSE 进度条 → 完成显示「打开复核界面」）
- [ ] 5.2 侧边栏新增「标书复核」导航项（复用 `AppIcon`）

**验收**：浏览器上传 PDF 可见实时进度（第 N/6 块、已提取 X 条）；完成后点击可打开复核界面；`npm run type-check` 通过。
**commit**：`feat: 前端标书复核页（上传+SSE进度+打开界面）`

## 收尾验收（对同一份真实招标文件）

- [ ] 人工列该 PDF 应交材料**基准清单**（15–20 条关键项），核对提取结果召回（目标 100%）
- [ ] `verify_rects.py`：PASS 率 100%、SKIP 0
- [ ] 覆盖度校验：未覆盖语句收敛到人工可过一遍的量级（参考 ~70 条）
- [ ] `nest build` + `vue-tsc` 通过
- [ ] 验收证据写入本目录 `verification.md`

## 明确不做（越界即停）

- 不让模型输出页码（红线 2）
- 不新写 Agent 引擎（红线 5）
- 不改 skill 既有 Python 脚本逻辑（红线 6）
- 不做复核界面内的状态机/导出（阶段 3/5）；本 change 复用阶段 1 产出的 HTML
