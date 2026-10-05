# spec delta: tender（局域网多人加固）

> 本文件为 OpenSpec 变更增量，全部为 ADDED Requirements。
> 既有需求（复核产物生成、管线调用、产物下载、记录持久化）**不变**。
> 高亮坐标与页码的计算仍全部发生在后端 Python 管线内，本变更不涉及坐标逻辑。

## ADDED Requirements

### Requirement: 上传体积上限与磁盘落盘

系统 SHALL 以磁盘存储方式接收上传的 PDF（内存占用 SHALL NOT 随文件体积增长），
并 SHALL 以 `TENDER_MAX_UPLOAD_MB`（缺省 200）限制单文件字节数。
文件 SHALL 先落盘至 `data-cache/tender/_uploads/`，再移动至 `data-cache/tender/<id>/source.pdf`。

#### Scenario: 上传合法 PDF

- **WHEN** 客户端上传一个体积 ≤ 上限的合法 `.pdf`
- **THEN** 返回 2xx 与 `id`
- **AND** `data-cache/tender/<id>/source.pdf` 的字节数与上传文件完全一致
- **AND** `_uploads/` 目录中不残留本次上传的临时文件
- **AND** 服务进程 RSS 增量 < 50 MB（以 200 MB 以内文件计）

#### Scenario: 超过体积上限

- **WHEN** 上传文件体积超过 `TENDER_MAX_UPLOAD_MB`
- **THEN** 返回 **413**，错误信息包含上限的 MB 数值
- **AND** 不创建 `<id>` 目录、不写入 `tender_documents`

#### Scenario: 上传非 PDF

- **WHEN** 上传文件的扩展名与 MIME 均不是 PDF
- **THEN** 返回 400
- **AND** 已落盘的临时文件被删除，`_uploads/` 目录为空

#### Scenario: 启动时清理残留

- **WHEN** 服务启动且 `_uploads/` 中存在上一次异常中断遗留的临时文件
- **THEN** 该目录被清空

### Requirement: 提取任务并发上限与排队

系统 SHALL 限制同时处于执行中的提取任务数量不超过 `TENDER_MAX_CONCURRENCY`（缺省 2）。
超出上限的任务 SHALL 进入 FIFO 队列，SHALL NOT 被拒绝或丢弃。

#### Scenario: 并发数超过上限

- **WHEN** 同时提交 5 个提取任务且上限为 2
- **THEN** 任意时刻处于 `extracting` 的任务数 ≤ 2
- **AND** 其余任务状态为 `queued`，且订阅者收到 `{ type: 'queued', ahead }`，`ahead` 从 1 递增

#### Scenario: 排队任务被放行

- **WHEN** 某个执行中的任务结束（成功或失败）
- **THEN** 队首的 `queued` 任务在其后 5 秒内进入 `extracting`
- **AND** 连续执行 5 个任务后，活动任务计数归 0（无槽位泄漏）

### Requirement: 提取任务可重复订阅

系统 SHALL 使提取任务的生命周期独立于单个 SSE 连接。
对同一 `id` 的重复订阅 SHALL 复用同一任务，SHALL NOT 重复执行提取（SHALL NOT 重复消耗模型配额）。

#### Scenario: 断线后重新订阅进行中任务

- **WHEN** 提取进行中，客户端断开 SSE 连接后重新订阅同一 `id`
- **THEN** 新连接先收到当前状态快照（`queued` / `start` / `progress` 之一）
- **AND** 随后继续收到该任务的后续事件直至 `done`
- **AND** 该任务的 `extract()` 调用次数不因重连而增加

#### Scenario: 订阅已完成的任务

- **WHEN** 任务的数据库状态为 `done`，客户端冷启动订阅该 `id`
- **THEN** 客户端立即收到一次 `done` 事件（含 `itemCount` / `missCount` / `failedBlocks` / `downloadUrl`）后连接结束
- **AND** 不重新执行提取

#### Scenario: 订阅已失败的任务

- **WHEN** 任务的数据库状态为 `failed`
- **THEN** 客户端立即收到一次 `error` 事件（含失败原因）后连接结束

### Requirement: 任务状态查询

系统 SHALL 提供最近任务列表与单任务状态查询，使未完成任务与已完成结果在页面刷新后仍可被找回。

#### Scenario: 查询最近任务列表

- **WHEN** 请求 `GET /tender/documents?limit=20`
- **THEN** 返回 200 与 `{ items: TaskSummary[] }`，按 `updatedAt` 倒序
- **AND** `limit` 大于 100 时被夹取为 100；缺省为 20
- **AND** 每项含 `id`、`filename`、`status`、`itemCount`、`missCount`、`failedBlocks`、`errorMsg`、`createdAt`、`updatedAt`

#### Scenario: 查询单个任务

- **WHEN** 请求 `GET /tender/documents/:id` 且记录存在
- **THEN** 返回 200 与 `TaskSummary`
- **AND** 当 `status = 'done'` 时额外包含 `downloadUrl` 与 `inlineUrl`

#### Scenario: 查询不存在的任务

- **WHEN** 请求 `GET /tender/documents/:id` 且记录不存在
- **THEN** 返回 404

### Requirement: 任务状态落库

系统 SHALL 将提取任务的状态变更持久化到 `tender_documents`，
字段为 `status`（`uploaded`/`queued`/`extracting`/`generating`/`done`/`failed`）、
`itemCount`、`missCount`、`failedBlocks`、`errorMsg`、`updatedAt`（毫秒时间戳）。

#### Scenario: 状态随流程推进

- **WHEN** 一个任务从提交走到完成
- **THEN** 数据库中的 `status` 依次经历 `queued` → `extracting` → `generating` → `done`
- **AND** 每次变更同步更新 `updatedAt`
- **AND** 失败时 `status = 'failed'` 且 `errorMsg` 非空（截断至 500 字符）

#### Scenario: 中断态可被观测

- **WHEN** 服务在任务执行中被重启
- **THEN** 该任务在 `GET /tender/documents` 中仍可见，且 `status` 保持重启前的非终态值，供人工识别重试

### Requirement: 多任务并行视图

系统 SHALL 允许在同一页面同时提交并跟踪多个提取任务，各任务的进度互不影响；
某任务的新建、进行或完成 SHALL NOT 重置其他任务的前端展示状态。

#### Scenario: 新建任务不覆盖既有任务视图

- **WHEN** 任务 A 正在提取，用户在同一页面切入提交任务 B
- **THEN** 页面同时展示 A 与 B 两个任务
- **AND** A 的进度继续实时更新，不因 B 的提交而重置或消失

#### Scenario: 刷新后自动恢复进行中任务的进度

- **WHEN** 用户在进行中刷新页面
- **THEN** 页面加载后 SHALL 自动订阅所有进行中任务并展示实时进度，无需人工点击

#### Scenario: 超出并发上限的任务显示排队

- **WHEN** 同时执行的任务数达到 `TENDER_MAX_CONCURRENCY`
- **THEN** 新任务展示为「排队中」并显示前方任务数
- **AND** 有空槽释放后该任务自动转为执行中

### Requirement: 任务取消

系统 SHALL 允许取消处于非终态的提取任务。
取消 SHALL 立即反映在任务状态上（对外可见），后台执行 SHALL 在下一个检查点停止；
已提取但未完成的内容 SHALL NOT 被保留为完成结果。

#### Scenario: 取消正在执行的任务

- **WHEN** 对处于 `extracting` 的任务发起取消
- **THEN** 接口返回 2xx，任务状态在 1 秒内变为 `cancelled`
- **AND** 订阅者收到一次 `cancelled` 事件，连接随后关闭
- **AND** 后台任务在**当前文本块处理完成后**停止，不再处理后续块
- **AND** 该任务不进入 `done`，不生成复核 HTML

#### Scenario: 取消排队中的任务

- **WHEN** 对处于 `queued` 的任务发起取消
- **THEN** 该任务不进入执行，直接进入 `cancelled`
- **AND** 其并发槽位在获得后立即释放，不影响其他排队任务

#### Scenario: 取消已终态的任务

- **WHEN** 对 `status` 为 `done` / `failed` / `cancelled` 的任务发起取消
- **THEN** 任务状态保持不变，接口返回当前状态

#### Scenario: 取消不泄漏并发槽位

- **WHEN** 连续执行「提交 → 取消」多次
- **THEN** 并发闸门中处于执行态的任务数最终归 0
- **AND** 后续新任务可正常获得槽位

### Requirement: 任务删除

系统 SHALL 允许删除任意状态的任务，删除 SHALL 同时清理该任务的数据库记录与磁盘产物目录。

#### Scenario: 删除已终态任务

- **WHEN** 对 `done` / `failed` / `cancelled` 的任务发起删除
- **THEN** 接口返回 2xx
- **AND** `tender_documents` 中该记录被删除
- **AND** `data-cache/tender/<id>/` 目录（含 `source.pdf`、`items.json`、`review.html`）被递归删除
- **AND** 此后 `GET /tender/documents/:id` 返回 404

#### Scenario: 删除进行中任务

- **WHEN** 对非终态任务发起删除
- **THEN** 该任务先被取消（状态置 `cancelled`），后台执行在下一个检查点停止
- **AND** 其记录与产物目录随后被删除
- **AND** 并发槽位在任务停止后正常释放

#### Scenario: 删除不存在的任务

- **WHEN** 对不存在的 `id` 发起删除
- **THEN** 返回 404

#### Scenario: 删除不泄漏并发槽位

- **WHEN** 连续执行「提交 → 删除」多次
- **THEN** 并发闸门中处于执行态的任务数最终归 0
