# Verification: harden-lan-multiuser

> 记录规范：如实呈现。**未执行的项一律标注「待人工执行」**，不得把未验证表述为通过。
> 本变更的验收要求见 `tasks.md`，各任务提交记录见 `git log`。

## 一、已完成（可复现的自动验证）

| 项 | 命令 | 结果 |
|---|---|---|
| 后端编译 | `cd server && npm run build` | ✅ 退出码 0（每个任务提交前各执行一次） |
| 前端类型检查 | `cd client && npx vue-tsc --noEmit` | ✅ 退出码 0 |
| IDE 静态诊断 | 编辑器 diagnostics（`server/src/modules/tender`、`TenderView.vue`） | ✅ 0 error / 0 warning |
| 依赖边界 | 检查 `server/package.json` | ✅ 零新增运行时依赖（队列为原生实现） |

## 二、待人工执行（需要真实 PDF + 模型配额）

以下项**尚未执行**，填写结果前不得视为通过。

### 2.1 上传加固（tasks 2）

| 步骤 | 期望 | 实际 |
|---|---|---|
| 上传 30 MB 正常 PDF | 2xx；`data-cache/tender/<id>/source.pdf` 字节数与原件一致；`_uploads/` 为空 | 待人工执行 |
| `TENDER_MAX_UPLOAD_MB=5` 后上传 30 MB | 413，文案含「5MB」 | 待人工执行 |
| 上传 `.docx` | 400，且 `_uploads/` 为空 | 待人工执行 |
| 并发 3 个 30 MB 上传 | 进程 RSS 峰值增幅 < 100 MB | 待人工执行 |

### 2.2 数据库并发（tasks 1）

| 步骤 | 期望 | 实际 |
|---|---|---|
| 启动后 `PRAGMA journal_mode;` | `wal` | 待人工执行 |
| 1 秒内连续两次 `POST /tender/documents` | 均 2xx，日志无 `SQLITE_BUSY` | 待人工执行 |

### 2.3 任务驻留与断线恢复（tasks 3）

| 步骤 | 期望 | 实际 |
|---|---|---|
| 提取进行到一半刷新页面 | 出现「有未完成的提取任务」，点击后可继续看到进度并拿到结果 | 待人工执行 |
| 完成后重新订阅同一 `id` | 立即收到 `done`，不重跑任务 | 待人工执行 |
| 重启服务后 `GET /tender/documents` | 可见中断任务（status 非终态） | 待人工执行 |
| `curl "http://localhost:3000/tender/documents?limit=5"` | 按 `updatedAt` 倒序；`limit=999` 夹到 100 | 待人工执行 |
| `curl -i http://localhost:3000/tender/documents/不存在id` | 404 | 待人工执行 |

### 2.4 并发上限与排队（tasks 4）

| 步骤 | 期望 | 实际 |
|---|---|---|
| 同时发起 5 个提取任务 | 同时 `extracting` ≤ 2，其余 `queued` 并收到 `queued` 事件 | 待人工执行 |
| 5 个任务全部结束后 | `ExtractionQueueService.active` 归 0（无槽位泄漏） | 待人工执行 |

### 2.5 5 人并发人工验收（tasks 5.6）

| 步骤 | 期望 | 实际 |
|---|---|---|
| 3 人同时上传并提取 | 全程无 5xx、无 OOM、无 `SQLITE_BUSY`、无进程重启 | 待人工执行 |

## 三、架构红线核验

| 红线 | 核验方式 | 结果 |
|---|---|---|
| 1 禁止 Node 重写 pdfplumber 管线 | 管线仍以子进程调用，未改脚本 | ✅ 代码审查通过 |
| 5 禁止新写 Agent 引擎 | 提取仍走 `ChatService.runToolLoop()` | ✅ 代码审查通过 |
| 6 禁止修改 skill 脚本 | 本变更未触碰 `tender-material-checklist/` 任何文件（该目录最近一次改动为变更前的归档提交） | ✅ 待用哈希比对复核 |

红线 6 复核命令（改动前后各执行一次比对）：

```powershell
Get-ChildItem -Recurse -File tender-material-checklist | Get-FileHash -Algorithm SHA256 |
  Sort-Object Path | Format-Table -AutoSize
```

## 四、技术债（本变更显式记录，不得隐瞒）

1. `spawn` 命令名写死为 `python`，Linux 部署需软链或改造（建议后续加 `PYTHON_BIN`）。
2. `synchronize: true` 仍开启，生产环境应改为显式迁移。
3. SQLite 单文件库，不支持多实例扩展。
4. `data-cache/tender/` 产物无自动清理策略。
5. 内存队列不跨进程重启，中断任务需人工重试（不自动恢复）。

## 五、验收阶段发现的缺陷与处置

| 发现 | 现象 | 根因 | 处置 | 状态 |
|---|---|---|---|---|
| 任务 4 验收 | 提取中刷新页面后再点「上传 PDF」，前一任务的进度视图被「覆盖」 | **前端**仅有单套任务状态（`fileName`/`result`/`progress`），新建任务即重置；**后端实为按 id 独立并行，无覆盖行为** | `TenderView.vue` 改为多任务列表视图，每任务独立订阅与进度模型（见 tasks 6） | 已修复，待人工回归 |

> 定性说明：该问题**不属于后端缺陷**。`TenderTaskService` 以 `Map<id, TaskEntry>` 管理任务，不同 id 完全独立；
> 并发闸门仅在同时执行数超过 `TENDER_MAX_CONCURRENCY` 时排队，不会取消或覆盖任何任务。

## 六、任务手动取消（tasks 7）

| 步骤 | 期望 | 实际 |
|---|---|---|
| 提取中点「取消任务」 | 转为「取消中…」→ 当前块结束后转「已取消」 | 待人工执行 |
| 排队中任务取消 | 不执行提取，直接 `cancelled` | 待人工执行 |
| 连续「提交 → 取消」3 次 | 并发槽位归 0，无泄漏 | 待人工执行 |
| 已终态任务调取消接口 | 状态不变 | 待人工执行 |

> 取消语义说明：采用**协作式取消**——单次模型调用无法中途 abort，故取消在「块边界」生效，
> 最长需等待当前文本块处理完成；但状态对外**立即**变为 `cancelled`。

## 七、任务删除（tasks 8）

| 步骤 | 期望 | 实际 |
|---|---|---|
| 删除已完成任务 | 列表移除；`data-cache/tender/<id>/` 消失；`GET .../:id` 返回 404 | 待人工执行 |
| 删除进行中任务 | 先取消再删除；产物目录被清理 | 待人工执行 |
| 删除不存在的 id | 404 | 待人工执行 |
| 连续「提交 → 删除」3 次 | 并发槽位归 0，无泄漏 | 待人工执行 |
