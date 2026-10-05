# Design: harden-lan-multiuser

> 设计原则：**只加闸门与状态，不改域逻辑**。分块策略、去重规则、提示词、Python 管线一律零改动。

## 1. 与既有模块的接口关系（调用哪些既有函数，签名是否变化）

| 既有接口 | 本变更如何接触 | 签名是否变化 |
|---|---|---|
| `TenderExtractionService.extract(pdfPath, workDir, model, callbacks)` | 在外部包一层并发闸门后调用；新增 `queued` 回调（可选） | **不变** |
| `PythonPipelineService.extractPages()` / `buildReviewHtml()` / `precheck()` | 原样调用 | **不变** |
| `TenderService.acceptPdf()` / `findDocument()` | `acceptPdf` 入参由 `Buffer` 改为**磁盘临时路径**；新增 `listDocuments()` / `updateStatus()` | 变更（见 §3.2） |
| `ChatService.runToolLoop()` | 经 `extractBlock()` 间接复用 | **不变** |
| `PythonPipelineService.runOnce()` 超时/终止逻辑 | 原样复用 | **不变** |

## 2. 数据库表结构变更

### 2.1 `tender_documents` 新增列（全部可空，回滚安全）

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `status` | TEXT | NOT NULL DEFAULT `'uploaded'` | `uploaded` / `queued` / `extracting` / `generating` / `done` / `failed` |
| `itemCount` | INTEGER | NULL | 提取条目总数 |
| `missCount` | INTEGER | NULL | 未定位条目数（需人工核查） |
| `failedBlocks` | INTEGER | NULL | 提取失败的块数 |
| `errorMsg` | TEXT | NULL | 失败原因（截断至 500 字符） |
| `updatedAt` | INTEGER | NULL，**建索引** | 最后状态更新时间（毫秒时间戳） |

**索引**：`@Index()` 于 `updatedAt`，供「最近任务列表」排序；`status` 选择性低，不建索引（单机 ≤ 数千行，全表扫描足够）。

### 2.2 TypeORM 写法

```ts
import { Column, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

@Entity('tender_documents')
export class TenderDocument {
    @PrimaryGeneratedColumn('uuid') id!: string
    @Column() filename!: string
    @Column() path!: string
    @Column({ nullable: true, type: 'integer' }) pageCount!: number | null
    @Column({ nullable: true, type: 'integer' }) pageOffset!: number | null
    @Column() createdAt!: number

    // ===== 本变更新增（局域网多人加固）=====
    @Column({ default: 'uploaded' }) status!: string
    @Column({ nullable: true, type: 'integer' }) itemCount!: number | null
    @Column({ nullable: true, type: 'integer' }) missCount!: number | null
    @Column({ nullable: true, type: 'integer' }) failedBlocks!: number | null
    @Column({ nullable: true, type: 'text' }) errorMsg!: string | null
    @Index()
    @Column({ nullable: true, type: 'integer' }) updatedAt!: number | null
}
```

> `synchronize: true` 会在启动时自动 `ALTER TABLE ADD COLUMN`（SQLite 支持 nullable 列在线新增），因此本期**不需要**迁移脚本；但 `synchronize: true` 本身是技术债，见 §7。

## 3. 上传落盘改造

### 3.1 存储配置（新增 `server/src/modules/tender/upload.config.ts`）

```ts
import { diskStorage } from 'multer'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'

export const UPLOAD_TMP_DIR = path.resolve('data-cache', 'tender', '_uploads')
export const MAX_PDF_BYTES = Number(process.env.TENDER_MAX_UPLOAD_MB ?? 200) * 1024 * 1024

export const pdfUploadOptions = {
    storage: diskStorage({
        destination: (_req, _file, cb) => {
            fs.mkdirSync(UPLOAD_TMP_DIR, { recursive: true })
            cb(null, UPLOAD_TMP_DIR)
        },
        filename: (_req, _file, cb) => cb(null, `${randomUUID()}.upload`),
    }),
    limits: { fileSize: MAX_PDF_BYTES, files: 2 },
}
```

要点：
- `destination` 内 `mkdirSync(recursive)` 保证目录存在（Multer 不会自动建目录）。
- 临时文件名用 UUID，避免并发同名冲突；扩展名 `.upload` 不暴露原类型。
- `files: 2` 兼容 `FileFieldsInterceptor`（file + items）场景。

### 3.2 `TenderService.acceptPdf` 签名调整

```ts
// 变更前：async acceptPdf(filename, pdf: Buffer)
// 变更后：把 Multer 已落盘的临时文件移动进正式目录
async acceptPdf(filename: string, tmpPath: string): Promise<{ doc: TenderDocument; pdfPath: string }>
```

实现顺序（**原子性优先**）：
1. `id = randomUUID()`；`dir = TENDER_DIR/<id>`；`mkdir(recursive)`；
2. `fs.promises.rename(tmpPath, <dir>/source.pdf)`（同一磁盘分区为原子操作，无需先复制）；
3. `rename` 跨分区失败（`EXDEV`）时回退 `copyFile + unlink`；
4. 写库（`status='uploaded'`, `createdAt=Date.now()`, `updatedAt=Date.now()`）；
5. `finally` 中清理残留临时文件。

### 3.3 超限与错误映射

| 情况 | Multer 行为 | 处理 |
|---|---|---|
| 超过 `fileSize` | 抛 `MulterError('LIMIT_FILE_SIZE')` | 全局异常过滤转为 **413**，文案含上限 MB 数 |
| 非 PDF | 已落临时文件 | 控制器校验后 `unlink(tmpPath)` 再抛 400，**不留垃圾** |
| 上传中断 | 临时文件残留 | 服务启动时（`onModuleInit`）清空 `_uploads/` 目录 |

## 4. 提取并发上限（信号量）

新增 `server/src/modules/tender/extraction-queue.service.ts`，约 40 行原生实现，**零依赖**：

```ts
@Injectable()
export class ExtractionQueueService {
    private running = 0
    private readonly waiters: Array<() => void> = []
    private get limit(): number {
        return Math.max(1, Number(process.env.TENDER_MAX_CONCURRENCY ?? 2))
    }
    /** 获取槽位，返回释放函数；满员时返回的 ahead 为排队位次（1 起） */
    async acquire(): Promise<() => void> { /* ... */ }
    get pending(): number { return this.waiters.length }
    get active(): number { return this.running }
}
```

行为约定：
- `running < limit` → 立即获得槽位；
- 否则进入 FIFO 等待队列；释放时把槽位**直接移交**队首（不减 `running`，避免竞态）；
- 进程重启即清空，**不持久化**（单机场景可接受，见 §8 技术债）。

## 5. 任务驻留与可重复订阅（核心）

### 5.1 问题

现状 `@Sse() extract()` 直接 `new Observable(() => this.runExtraction(...))`：任务生命周期 == 连接生命周期，断线即失联，且无任何查询入口。

### 5.2 方案：任务驻留 + 订阅广播（新增 `tender-task.service.ts`）

```ts
interface TaskSnapshot {
    id: string
    status: 'queued' | 'extracting' | 'generating' | 'done' | 'failed'
    pageCount: number
    blockIndex: number
    blockTotal: number
    itemCount: number
    ahead: number            // 排队位次
    result?: { itemCount; missCount; failedBlocks; downloadUrl; inlineUrl }
    error?: string
    finishedAt?: number
}
```

服务内部维护 `Map<string, { snapshot: TaskSnapshot; emitter: EventEmitter }>`：

| 方法 | 语义 |
|---|---|
| `join(id, model): { snapshot, on(listener), off(listener) }` | **订阅或启动**：无驻留任务且 DB 状态非终态 → 启动后台任务；无驻留任务且 DB 为终态 → 直接返回该终态快照（不重启任务）；有驻留任务 → 返回当前快照 |
| `private run(id, model)` | 后台执行：写状态 → 取并发槽 → `extraction.extract()` → 生成 HTML → 写终态；每个阶段 `emit('event', evt)` 并同步 `updateStatus()` 到 DB |

**SSE 端点语义（协议不变，仅新增 `queued` 事件）**：

```
无驻留任务 & DB 非终态  → 启动任务，订阅其事件流
无驻留任务 & DB 终态    → 立即补发一次 done/error，随即 complete（刷新后秒回结果）
有驻留任务             → 先补发当前快照（queued/start/progress），再转发后续事件
```

**事件协议对照**：

| 事件 | 是否新增 | 载荷 |
|---|---|---|
| `queued` | **新增** | `{ type:'queued', ahead }` |
| `start` / `progress` / `generating` | 沿用 | 同既有 |
| `done` | 沿用 | 同既有 |
| `error` | 沿用 | 同既有 |

### 5.3 终态快照的保留与回收

- 任务结束后快照保留 **5 分钟**（`setTimeout` 清理），便于迟到订阅者直接拿到结果；
- 5 分钟后仅依赖 DB 查询（`GET /tender/documents/:id`），结果不丢（`review.html` 已在磁盘）；
- 单实例内存占用上界：`并发数 × 快照大小`（KB 级），无风险。

## 6. 接口清单（新增 2 个）

| 方法 | 路径 | 响应 |
|---|---|---|
| GET | `/tender/documents?limit=20` | `{ items: TaskSummary[] }`，按 `updatedAt` 倒序，`limit` 上限 100 |
| GET | `/tender/documents/:id` | `TaskSummary`；不存在 → 404；`status='done'` 时附 `downloadUrl` / `inlineUrl` |

```ts
interface TaskSummary {
    id: string
    filename: string
    status: string
    itemCount: number | null
    missCount: number | null
    failedBlocks: number | null
    errorMsg: string | null
    createdAt: number
    updatedAt: number | null
    downloadUrl?: string
    inlineUrl?: string
}
```

> 路由顺序：`GET /tender/documents/:id` 与既有 `GET /tender/documents/:id/extract` 不冲突（后者路径更长，Nest 精确匹配）。

## 7. 数据库并发配置

`app.module.ts` 的 `TypeOrmModule.forRoot` 增加：

```ts
TypeOrmModule.forRoot({
  type: 'better-sqlite3',
  database: 'data-cache/smartchat.db',
  entities: [Session, Message, SessionAttachment, TenderDocument],
  synchronize: true,
  prepareDatabase: (db: any) => {
    db.pragma('journal_mode = WAL')      // 读写不互斥
    db.pragma('busy_timeout = 5000')     // 写锁等待 5s 再报错
    db.pragma('synchronous = NORMAL')    // WAL 下兼顾安全与性能
  },
})
```

> **技术债（显式记录，不隐瞒）**：`synchronize: true` 与 `better-sqlite3` 同步驱动在多人写场景仍是隐患；因 PRD「明确不做」包含数据库升级，本期保留，
> 待并发用户数 > 5 或出现 `SQLITE_BUSY` 告警时，另起变更迁移至 PostgreSQL（异步驱动）。

## 8. 部署基线

| 文件 | 作用 |
|---|---|
| `deploy/ecosystem.config.js` | PM2 配置：`server`（`node dist/main`）与 `client`（静态托管）双进程、`autorestart`、`max_memory_restart: 1G`、日志路径 |
| `deploy/nginx.conf.example` | 反向代理：`proxy_read_timeout 900s`、`proxy_buffering off`（SSE 必需）、`client_max_body_size 210m` |
| `docs/局域网多人部署指南.md` | 前置依赖（Node / Python 3.11+ / pdfplumber / `TENDER_SKILL_DIR`）、构建、守护、开机自启、故障排查清单 |

**不使用容器**：符合 config「明确不做：云部署与容器化」。

## 9. 降级方案（必须逐一可解释）

| 场景 | 降级行为 |
|---|---|
| Python 环境缺失 | `precheck()` → 503，文案含安装要求（既有能力，保持不变） |
| 扫描件 PDF | 提取 0 条 → `error` 事件 + `status='failed'`（既有行为，新增落库） |
| 单块提取失败 | `failedBlocks++`，不中断整体（既有）；终态快照如实上报 |
| 队列满 | 排队并推送 `queued`，前端显示「前面还有 N 个任务」 |
| 上传超 200 MB | 413，文案含上限值 |
| 反向代理 60s 切断 SSE | 部署文档强制要求 `proxy_read_timeout ≥ 900s`；即便被切断，任务仍在后台跑完并落库，重新订阅可拿结果 |
| 进程重启 | 内存快照丢失；`status` 停留在中断态的任务由 `GET /tender/documents` 暴露，用户可重新触发（本期不做自动恢复） |

## 10. 前端改动（最小面）

`client/src/views/TenderView.vue`：
1. `onMounted` 调 `GET /tender/documents?limit=5`；
2. 若首条 `status ∈ {queued, extracting, generating}` → 显示「继续查看进度」卡片，点击后按该 `id` 重新订阅 SSE；
3. `errorMsg` 分流：413 → 「文件超过 200MB」；503 → 「服务端 Python 环境不可用」；其余原样展示；
4. `queued` 事件 → 进度卡片显示排队位次。
