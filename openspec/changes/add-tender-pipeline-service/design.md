# Design: add-tender-pipeline-service

## 与既有模块的接口关系

| 对象 | 关系 | 说明 |
|---|---|---|
| `server/src/app.module.ts` | **唯一改动的既有文件** | `imports` 加 `TenderModule`；`entities` 加 `TenderDocument`。数据层复用既有 `TypeOrmModule.forRoot`（better-sqlite3，`synchronize: true`），新实体入数组即自动建表，不新建连接 |
| `chat` / `knowledge-base` 模块 | 本阶段**不依赖** | FC 提取（阶段 2）与 `searchRag` 填充（阶段 4）才接入；本 change 不 import 它们 |
| `session` 模块 | 仅参照写法 | 实体与 service 风格参照 `session.entity.ts` / `session.service.ts` |
| skill 管线 | 子进程调用 | `C:\Users\qi\.workbuddy\skills\tender-material-checklist\scripts\build_review_html.py`，经 `TENDER_SKILL_DIR` 环境变量可配（`ConfigService.get` 读取），缺省取 `os.homedir()/.workbuddy/skills/tender-material-checklist` |
| multer | 复用内置 | NestJS 11 `@nestjs/platform-express` 自带 multer 运行时，用 `FileFieldsInterceptor` 接收双文件字段；缺类型时才补 devDep `@types/multer` |

新模块文件布局（沿用既有 NestJS 分层）：

```
server/src/modules/tender/
├── tender.module.ts
├── tender.controller.ts        # POST /tender/review、GET /tender/review/:id/download
├── tender.service.ts           # 校验、落盘、编排、入库
├── python-pipeline.service.ts  # spawn 封装（探测/超时/stderr）
├── tender-document.entity.ts
└── dto/ (review-upload.dto.ts) # 上传校验 DTO
```

## spawn 调用设计（PRD 决策 D1 = 方案 A 子进程）

- 用 `child_process.spawn`（**非 exec**）：参数以数组传递、不经 shell，天然规避路径转义与注入问题。
- 命令行参数——脚本既有 5 个参数，**零新增零改动**（红线 6）：

| 参数 | 值 |
|---|---|
| `--pdf` | `<abs>/source.pdf`（落盘绝对路径） |
| `--items` | `<abs>/items.json` |
| `--out` | `<abs>/review.html` |
| `--vendor` | `<skill>/assets/vendor` |
| `--title` | 原始文件名去扩展名 |

- Windows 命令名用 `python`（`process.platform` 为 win32）。

### 错误与超时处理（PRD 实施要求四项全覆盖）

| 事件 | 处理 |
|---|---|
| spawn `error`（含 ENOENT） | 判定 Python 环境缺失 → 抛 503，信息含安装要求 |
| `close` code ≠ 0 | 收集 stderr 全量进日志，取**最后 20 行**随 502 返回 |
| 运行 > 150 s | 计时器触发 kill：Windows 下 `taskkill /pid <pid> /T /F`（spawn 加 `detached: true` 以获得独立进程组），返回 504 |
| `close` code = 0 | 校验 `--out` 文件存在且非空，否则按 502 处理（防脚本假成功） |

- stdout 全量收集进服务日志（脚本进度输出），不返回给调用方。
- Python 环境探测：请求处理前先 `spawn('python', ['--version'])` 探测一次并缓存结果，失败即 503，不静默。

## 数据表（PRD 决策 D3 拍板字段，TypeORM 写法）

`tender_document`（表名 `tender_documents`，与既有 `sessions` 复数命名一致）：

| 字段 | 列类型 | TypeORM | 说明 |
|---|---|---|---|
| `id` | uuid PK | `@PrimaryGeneratedColumn('uuid')` | 同时用作落盘目录名 |
| `filename` | varchar | `@Column()` | 原始文件名 |
| `path` | varchar | `@Column()` | PDF 落盘绝对路径 |
| `pageCount` | integer, nullable | `@Column({ nullable: true })` | 预留，阶段 2 填充 |
| `pageOffset` | integer, nullable | `@Column({ nullable: true })` | 预留，页码校准结果，阶段 2 填充 |
| `createdAt` | integer | `@Column()` | 毫秒时间戳（number，与 `session.entity.ts` 惯例一致） |

- 索引：除主键外不建（一期单实例、量级小）；`tender_item.documentId` 索引属阶段 2 change。
- 产物路径**不入库**：由 `id` 规则化推导 `server/data-cache/tender/<id>/review.html`，严格遵守 D3 字段集。

## 处理流程

```
POST /tender/review
  → FileFieldsInterceptor([{file,1},{items,1}])
  → 校验：file 扩展名/MIME 为 PDF；items 可 JSON.parse 且为非空数组（否则 400）
  → 生成 uuid，落盘 data-cache/tender/<uuid>/{source.pdf, items.json}
  → INSERT tender_document
  → python-pipeline.service spawn（探测→spawn→150s 超时看护）
  → 成功：响应 { id, downloadUrl: "/tender/review/<id>/download" }
  → 失败：503/502/504（对应上表），错误信息透传 stderr 摘要
```

- **同步等待**（Promise 包装 spawn 结束）：一期单实例 + 验收线 3 分钟，同步最简单且够用；PRD 风险表的「异步任务 + 进度推送」待出现实际超时案例、且阶段 2 具备 SSE 能力后再升级，本 change 不预做。
- **落盘布局**：`server/data-cache/tender/<uuid>/`，该目录已被 `server/.gitignore` 的 `/data-cache` 覆盖，不入库。

## 降级方案

| 情形 | 行为 |
|---|---|
| 环境缺 Python | 503 + 安装要求（Python 3.11+、pdfplumber），绝不静默成功 |
| skill 脚本或 `assets/vendor` 缺失 | 受理前校验路径存在性，失败返回 500 并指明配置项 `TENDER_SKILL_DIR` |
| 非文字版 PDF（扫描件） | 由管线自身解析失败兜底，服务透传 stderr 为 502；服务端**不做** OCR 判定（不改脚本逻辑，红线 6） |
| 大文件超 150 s | 504 + 提示拆分文档；不做异步队列 |
| 产物文件丢失后请求下载 | 404，提示重新上传生成 |
