# Tasks: harden-lan-multiuser

> 执行规则：一任务一次 git commit（信息中文），做完立刻验收；验收不过立即回滚，禁止在坏状态上叠加。
> 本变更**不属于** PRD 第 6 节的功能阶段，是对已完成功能的交付加固，**不得改动任何域逻辑**（分块、去重、提示词、Python 脚本）。
> 前置检查：`cd server && npm run build` 通过；`python --version` 与 `pdfplumber` 可用；准备一份 ≥ 30 MB 的真实招标 PDF 用于上传验收。

## 1. 数据库并发配置（WAL）

- [ ] 1.1 `app.module.ts` 的 `TypeOrmModule.forRoot` 增加 `prepareDatabase`，开启 `journal_mode = WAL`、`busy_timeout = 5000`、`synchronous = NORMAL`
- [ ] 1.2 保持 `synchronize: true`，并在 `design.md` 已有技术债记录中确认不扩大范围

**验收**：
- `cd server && npm run build` 退出码 0
- 启动服务后，用 SQLite 工具执行 `PRAGMA journal_mode;` 返回 `wal`；`data-cache/smartchat.db-wal` 文件出现
- 并发写冒烟：连续调用两次 `POST /tender/documents`（间隔 < 1s），均返回 2xx，日志无 `SQLITE_BUSY`

**commit**：`chore(server): SQLite 开启 WAL 与 busy_timeout 以支持多人并发写`

## 2. 上传落盘改造（防 OOM）

- [ ] 2.1 新增 `server/src/modules/tender/upload.config.ts`：`diskStorage` 落 `data-cache/tender/_uploads/`，`limits.fileSize` 由 `TENDER_MAX_UPLOAD_MB`（默认 200）控制
- [ ] 2.2 `POST /tender/documents` 与 `POST /tender/review` 两处上传拦截器改用该配置
- [ ] 2.3 `TenderService.acceptPdf(filename, tmpPath)`：`rename` 移动（跨分区回退 `copyFile+unlink`）→ 写库 → `finally` 清理临时文件
- [ ] 2.4 `MulterError('LIMIT_FILE_SIZE')` 映射为 **413**，文案含上限 MB 数；非 PDF 校验失败时删除已落盘的临时文件
- [ ] 2.5 `TenderService` 实现 `OnModuleInit`：启动时清空 `_uploads/` 残留

**验收**：
- 上传 30 MB 正常 PDF → 2xx，`data-cache/tender/<id>/source.pdf` 字节数与原件一致，`_uploads/` 为空
- 临时把 `TENDER_MAX_UPLOAD_MB=5` 后上传 30 MB 文件 → **413**，文案含「5MB」
- 上传 `.docx` → **400**，且 `_uploads/` 目录为空（无垃圾残留）
- 并发上传：同时发起 3 个 30 MB 上传，进程 RSS 峰值增幅 < 100 MB

**commit**：`fix(tender): 上传改用磁盘落盘并限制体积，避免并发上传 OOM`

## 3. 任务驻留与断线可恢复

> 本任务先于并发闸门实施：闸门需要挂在驻留任务的执行入口上。

- [ ] 3.1 新增 `server/src/modules/tender/tender-task.service.ts`：`Map<id, {snapshot, emitter}>` + `join(id, model)` 语义（订阅或启动）、终态快照 TTL 5 分钟
- [ ] 3.2 `tender-document.entity.ts` 增 6 列（`status/itemCount/missCount/failedBlocks/errorMsg/updatedAt`），`updatedAt` 建索引
- [ ] 3.3 `TenderService` 增 `listDocuments(limit)` 与 `updateStatus(id, patch)`
- [ ] 3.4 `GET /tender/documents/:id/extract` 改为「订阅或启动」：无驻留任务且 DB 非终态 → 启动；DB 为终态 → 补发终态事件后 complete
- [ ] 3.5 新增 `GET /tender/documents?limit=20` 与 `GET /tender/documents/:id`
- [ ] 3.6 `TenderView.vue`：`onMounted` 拉取最近任务；存在未完成任务时显示「继续查看进度」；`errorMsg` 按 413/503 分流

**验收**：
- 提取进行到一半时**刷新页面** → 重新订阅同一 `id` 可继续看到进度并最终拿到 `done`（结果不丢）
- 提取**完成后**再订阅同一 `id` → 立即收到 `done` 事件（无需重新跑任务）
- 服务重启后访问 `GET /tender/documents` → 能看到中断任务（`status` 为 `extracting`），其 `review.html` 若已生成仍可下载
- `curl "http://localhost:3000/tender/documents?limit=5"` 返回按 `updatedAt` 倒序的列表；`limit=999` 被夹到 100
- `curl -i http://localhost:3000/tender/documents/不存在id` → 404
- `cd client && npx vue-tsc --noEmit` 退出码 0

**commit**：`feat(tender): 提取任务驻留化，支持断线重连与历史任务查询`

## 4. 提取并发上限（排队）

- [ ] 4.1 新增 `server/src/modules/tender/extraction-queue.service.ts`：原生 FIFO 信号量，上限 `TENDER_MAX_CONCURRENCY`（默认 2），`acquire()` 返回释放函数
- [ ] 4.2 `TenderTaskService.run()` 在调用 `extraction.extract()` **之前**获取槽位、**之后**释放（`try/finally` 保证异常也释放）
- [ ] 4.3 排队期间向订阅者推送 `{ type:'queued', ahead }`，`ahead` 从 1 起

**验收**：
- 同时发起 5 个提取任务 → 日志/接口显示**最多 2 个处于 `extracting`**，其余为 `queued`，且发生等待
- 任一任务失败或完成 → 有排队任务被立刻放行（`pending` 计数递减），无槽位泄漏（连续跑 5 个任务后 `active` 归 0）
- 前端进度卡在排队时显示「前方 N 个任务」

**commit**：`feat(tender): 提取任务增加并发上限与排队，避免 LLM 与 CPU 风暴`

## 5. 部署基线与阶段验收

- [ ] 5.1 新增 `deploy/ecosystem.config.js`（PM2：server 单实例 fork、`max_memory_restart: 1G`、日志路径；前端由 Nginx 托管静态产物，避免用 dev server 扛生产流量）
- [ ] 5.2 新增 `deploy/nginx.conf.example`（`proxy_read_timeout 900s`、`proxy_buffering off`、`client_max_body_size 210m`）
- [ ] 5.3 新增 `docs/局域网多人部署指南.md`（依赖安装、构建、守护、开机自启、故障排查）
- [ ] 5.4 最终 `cd server && npm run build` 与 `cd client && npx vue-tsc --noEmit` 双双通过
- [ ] 5.5 红线 6 核验：对 `tender-material-checklist/` 做改动前后文件哈希比对，确认**零文件被修改**
- [ ] 5.6 5 人并发人工验收：3 人同时上传并提取，全程无 5xx、无 OOM、无 `SQLITE_BUSY`；将命令与输出摘要记入本目录 `verification.md`

**commit**：`chore(deploy): 新增局域网多人部署基线与并发验收证据`

## 明确不做（越界即停）

- 不改 `build_review_html.py` / `extract_text.py` 等任何 skill 脚本（红线 1/6）
- 不改分块页数、重叠页数、去重规则、提示词（域逻辑冻结）
- 不引入新依赖（队列为原生实现；不装 BullMQ / Redis）
- 不做认证与用户体系（属 PRD「明确不做」）
- 不做容器化（属 PRD「明确不做」）
- 不迁移 PostgreSQL（记为技术债，另起变更）
- 不做进程重启后的任务自动恢复（本期仅暴露中断态，供人工重试）
