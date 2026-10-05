# Proposal: harden-lan-multiuser（局域网多人使用加固）

> 对应 PRD：**不对应新功能编号（F1–F6 均已实现或已规划）**。本变更是**非功能性加固**，
> 直接支撑 **F1「文档上传与解析」**与 **F2「条款自动提取」** 在**多人并发**下的可靠性；
> 不新增产品能力，不放宽任何既有验收口径（几何验证 PASS 率仍须 100%、SKIP 仍须为 0）。
> 触发场景：单台工作站部署、**局域网内 ≤5 名同事同时使用**。

## 容量假设（本变更全部设计的量化前提）

| 项 | 假设值 | 依据 |
|---|---|---|
| 并发用户数 | ≤ 5 | 目标场景 |
| 单份 PDF 体积上限 | ≤ 200 MB | 常见招标文件（含图纸）上限 |
| 单次提取时长 | ≤ 5 分钟 | 15 页/块 × 约 20 块 |
| 同时进行的提取任务 | ≤ 2 | 外部 LLM API 配额与单机 CPU 的现实上限 |
| 单个上传请求内存占用 | ≤ 5 MB | 改磁盘落盘后，内存不再随文件体积增长 |

## Why

当前实现是**单人开发态**，5 人同时使用时会在四个点**依次退化**（不是一次全挂）：

| # | 退化点 | 现状证据 | 后果 |
|---|---|---|---|
| 1 | **上传 OOM** | `FileInterceptor('file')` 使用 Multer 默认 `memoryStorage`，且无 `limits.fileSize`（`tender.controller.ts`） | 整份 PDF 进内存；3 人同传 100 MB 即数百 MB 常驻，进程可能被 OOM 杀死，**全员请求一起断** |
| 2 | **LLM 与 CPU 风暴** | `server/src` 全库无队列 / 无并发上限 / 无限流 | 10 人并发 = 数十次 LLM 请求瞬间打出；触发 429、成本线性膨胀、彼此抢占 |
| 3 | **SQLite 并发写** | `TypeOrmModule.forRoot({ type: 'better-sqlite3' })` 未开 WAL、未设 busy_timeout | 并发写易遇 `SQLITE_BUSY`；且 `synchronize: true` 为生产反模式 |
| 4 | **断线即丢结果** | 提取任务与 SSE 连接强绑定（`runExtraction` 由 `@Sse` 直接启动）；无任何任务查询接口 | 用户跑到 80% 刷新页面 → 结果无从找回，只能重传重跑，**重复消耗 LLM 配额与时间** |

此外无生产运行方式（靠 IDE 跑 dev 模式），工作站重启即全断。

## What Changes

1. **上传落盘改造**：把 PDF 上传从内存存储改为**磁盘存储**，并设置体积与数量上限；超限返回 413；落盘后由 service 原子移动到 `data-cache/tender/<id>/source.pdf`。
2. **提取并发上限（排队）**：新增内存信号量，同时进行的提取任务数受 `TENDER_MAX_CONCURRENCY`（默认 2）约束；排队时向前端推送 `queued` 事件，进度条不再"假死"。
3. **数据库并发配置**：`better-sqlite3` 启动时开启 `journal_mode = WAL`、`busy_timeout = 5000`、`synchronous = NORMAL`；关闭 `synchronize`（改用显式列迁移）**留待下一变更**，本变更仅记录该技术债。
4. **任务状态落库与断线可恢复**：`tender_documents` 增加 `status / itemCount / missCount / failedBlocks / errorMsg / updatedAt` 六列；新增 `GET /tender/documents`（最近任务列表）与 `GET /tender/documents/:id`（单任务状态）；提取任务改为**可重复订阅**——刷新后重新订阅同一 `id` 即可继续看到进度或直接拿到终态结果。
5. **部署基线**：新增 PM2 进程守护配置、反向代理（SSE 超时）配置示例与一份局域网部署说明文档；不使用容器（符合 config「明确不做」的容器化边界）。
6. **前端适配**：`TenderView.vue` 进入页面时拉取最近任务，若存在未完成任务则提供「继续查看进度」入口；上传错误按 413 / 503 分别提示。

## 复用资产与不可重写理由

| 资产 | 复用方式 | 为什么不能重写 |
|---|---|---|
| `TenderExtractionService.extract()` 分块与去重 | 原样调用，仅在外部包一层并发闸门 | 内含已调优的 15 页/块 + 1 页重叠策略与「限定条件冲突不合并」规则（红线：域逻辑不可动） |
| `ChatService.runToolLoop()`（FC 引擎） | 继续由 `extractBlock()` 复用 | 红线 5：禁止新写 Agent 引擎 |
| `PythonPipelineService`（子进程管线） | 零改动 | 红线 1/6：禁止 Node 重写、禁止改 skill 脚本 |
| `@nestjs/platform-express` 内置 multer | 仅调整其 `storage` / `limits` 选项 | 不引入新依赖 |
| TypeORM + better-sqlite3 | 复用既有连接，仅加 `prepareDatabase` pragma | 平台已有数据层，不引入第二套连接 |
| 既有 SSE（`@Sse` + RxJS Observable） | 保留协议，改为「订阅驻留任务」而非「连接即启动」 | 前端已按 SSE 事件协议实现，协议不变可零成本复用 |

**不引入任何新依赖**（队列、信号量均以约 40 行原生代码实现），符合项目「不引入新依赖除非确有必要」规范。

## 架构红线确认

| 红线 | 是否触碰 | 说明 |
|---|---|---|
| 1 禁止 Node 重写 pdfplumber 管线 | 否 | 管线仍为子进程整体调用，零改动 |
| 2 禁止模型输出页码 | 否 | 不涉及模型提示词 |
| 3 禁止前端运行时模糊搜索定位 | 否 | 高亮坐标仍由后端管线预计算；前端仅新增任务列表查询 |
| 4 禁止新写检索逻辑 | 否 | 不涉及 RAG |
| 5 禁止新写 Agent 引擎 | 否 | 提取仍复用 `ChatService.runToolLoop()` |
| 6 禁止修改 skill Python 脚本逻辑 | **否（严格零改动）** | 验收时须对 skill 目录做改动前后哈希比对 |
| 7 导出内容须来自机器验证引用 | 否 | 不涉及导出 |

## 回滚方案

本变更拆为 5 个实现任务 = 5 次 commit，**一任务一验收**，验收失败即 `git revert` 该 commit 后重做。
- 新增代码集中在 `server/src/modules/tender/`、`deploy/`、`docs/`，revert 不影响 chat / session / knowledge-base / pdf-pipeline。
- `tender_documents` 新增列为**可空**，回滚后旧版本代码忽略这些列即可运行，**无需数据迁移回滚**。
- `app.module.ts` 仅新增一个 `prepareDatabase` 选项，revert 即还原为默认 journal 模式。

## Impact

- **规格**：增量修改 capability `tender`（见 `specs/tender/spec.md`）；新增 capability `runtime`（见 `specs/runtime/spec.md`）。
- **代码**：新增 `server/src/modules/tender/{upload.config.ts, extraction-queue.service.ts, tender-task.service.ts}`；修改 `tender.controller.ts`、`tender.service.ts`、`tender-document.entity.ts`、`tender.module.ts`、`app.module.ts`；修改 `client/src/views/TenderView.vue`。
- **接口**：新增 2 个查询端点；`GET /tender/documents/:id/extract` 语义由「连接即启动」变为「订阅或启动」（**SSE 事件协议不变**，前端兼容）。
- **依赖**：零新增。
- **数据**：`tender_documents` 增 6 列（均可空）；产物目录 `server/data-cache/` 已在 `.gitignore` 中。
- **验收口径**：见 `tasks.md` 每任务验收命令；最终须 `nest build` 与 `vue-tsc` 双双通过，并完成一次「5 人并发」人工验收。
