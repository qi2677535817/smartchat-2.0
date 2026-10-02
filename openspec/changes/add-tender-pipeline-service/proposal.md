# Proposal: add-tender-pipeline-service（阶段 1 · Python 管线服务化）

> 对应 PRD：`docs/PRD-标书复核Agent.md` 第 6 节「阶段 1」；差距项 **G1**；部分覆盖 **F1**（上传落盘与解析触发环节）；达成里程碑 **M1**。
> 前置条件：阶段 0 已完成——本机已装 Python 3.11+ 与 pdfplumber，且已有真实招标文件跑出的 `基线.html`、items.json 与验证报告作为对照基准。

## Why

Python 管线（`build_review_html.py`）目前是命令行脚本，只能手动执行，不被 smartchat 平台感知（G1）。本 change 把它包成 HTTP 端点：前端/调用方上传 PDF 即可获得复核 HTML 下载地址，跑通「上传 → 服务化生成 → 下载」的最小链路。这是 M1 的最后一步，完成后即有可演示成果。

## What Changes

1. 新建 `server/src/modules/tender/` 模块（module / controller / service / entity / dto 分离，沿用既有 NestJS 结构）。
2. 新增 `POST /tender/review`：multipart 上传（`file` = 文字版招标 PDF，`items` = 需求条目 JSON——阶段 1 由调用方提供，即阶段 0 人工准备的 items.json；阶段 2 起由 FC 自动产出）。
3. 以子进程 spawn 调用 skill 管线 `build_review_html.py`（参数 `--pdf/--items/--out/--vendor/--title`，全部为脚本既有参数，**零新增、零改动**）。
4. 产物落盘 `server/data-cache/tender/<id>/review.html`；新增 `GET /tender/review/:id/download` 返回文件流下载。
5. 新建 `tender_document` 表（字段按 PRD D3 拍板），记录上传文档。
6. 修改既有文件仅 `server/src/app.module.ts` 两处：`imports` 注册 `TenderModule`、`entities` 数组加入 `TenderDocument`。

## 复用资产与不可重写理由

| 资产 | 复用方式 | 为什么不能重写 |
|---|---|---|
| `build_review_html.py`（878 行） | 子进程调用，产出单文件 HTML | 内含已离线验证的词级坐标定位、字符级容错匹配、页码双轨校准、覆盖度校验——重写即销毁验证过的准确性（架构红线 1） |
| skill 的 `assets/vendor/`（pdf.js） | 经 `--vendor` 参数传给管线 | 产物内嵌依赖，随脚本整体复用 |
| TypeORM + better-sqlite3 连接 | 复用 `app.module.ts` 既有 `TypeOrmModule.forRoot`，新实体入数组即自动建表 | 平台已有数据层，无需第二套连接 |
| `session` 模块实体写法 | `tender-document.entity.ts` 参照 `session.entity.ts` 惯例 | 保持模块内风格统一 |
| `@nestjs/platform-express` 内置 multer | `FileFieldsInterceptor` 接收 multipart | 不引入新依赖 |

## 架构红线确认

| 红线 | 本 change 是否触碰 | 说明 |
|---|---|---|
| 1 禁止 Node 重写 pdfplumber 管线 | 否 | 管线以子进程整体调用，零重写 |
| 2 禁止模型输出页码 | 不涉及 | 本阶段无模型调用 |
| 3 禁止前端运行时模糊搜索 | 不涉及 | 本阶段不碰前端 |
| 4 禁止新写检索逻辑 | 不涉及 | RAG 属阶段 4 |
| 5 禁止新写 Agent 引擎 | 不涉及 | FC 提取属阶段 2 |
| 6 禁止修改 skill Python 脚本逻辑 | **否（严格零改动）** | 仅作为外部命令调用其 5 个既有参数；验收时须校验 skill 目录文件未被修改 |
| 7 导出内容须来自机器验证引用 | 不涉及 | 导出属阶段 5 |

## 回滚方案

4 个实现任务 = 4 个 commit，一任务一验收；验收失败即 `git revert` 对应 commit 后重做，禁止在坏状态上叠加。
本 change 新增代码全部位于独立目录 `server/src/modules/tender/`，revert 不影响 chat / session / knowledge-base；`app.module.ts` 的两行注册随 revert 一并还原。产物目录 `server/data-cache/` 已在 `server/.gitignore` 中，不产生提交物污染。

## Impact

- **规格**：新增 capability `tender`（见 `specs/tender/spec.md`），不影响既有 spec。
- **代码**：新增 `server/src/modules/tender/**`；修改 `server/src/app.module.ts`（2 行）。
- **依赖**：原则上零新增。`@nestjs/platform-express` 已内置 multer 运行时；若编译时缺 `@types/multer` 类型声明，才补 devDependency（理由：仅类型需要，无运行时影响）。
- **前端**：不碰（PRD 阶段 1 关键约束）。
- **验收口径**：Postman 上传一份真实 PDF + 阶段 0 的 items.json → 拿到下载链接 → 下载的 HTML 与阶段 0 基线内容一致，全链路 ≤ 3 分钟。
