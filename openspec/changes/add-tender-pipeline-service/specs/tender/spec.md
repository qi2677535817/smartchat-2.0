# spec delta: tender（新增 capability）

> 本文件为 OpenSpec 变更增量：全部为 ADDED Requirements。
> 高亮坐标与页码的计算全部发生在后端 Python 管线内，本阶段不涉及前端。

## ADDED Requirements

### Requirement: 复核产物生成端点

系统 SHALL 提供 `POST /tender/review`，接受 `multipart/form-data`，字段 `file`（文字版 PDF）与 `items`（需求条目 JSON 文件），校验通过后调用既有 Python 管线生成单文件复核 HTML。

#### Scenario: 上传合法 PDF 与条目 JSON

- **WHEN** 客户端上传 `.pdf` 文件与可解析为非空数组的 items JSON，且管线在时限内以退出码 0 结束
- **THEN** 产物写入 `server/data-cache/tender/<id>/review.html`，响应 2xx 且包含 `id` 与 `downloadUrl`
- **AND** `tender_document` 表新增一条记录，含 `filename` 与 PDF 落盘路径
- **AND** 从发起请求到收到响应的耗时 ≤ 3 分钟（以 100 页以内文字版 PDF 计）

#### Scenario: 上传非 PDF 文件

- **WHEN** 上传的 `file` 字段扩展名或 MIME 类型不是 PDF
- **THEN** 返回 400，错误信息说明仅支持文字版 PDF
- **AND** 不落盘、不写库、不调用 Python 管线

#### Scenario: items JSON 非法

- **WHEN** `items` 字段内容无法被 JSON 解析，或解析结果不是形如 `{"items": [非空数组]}` 的对象（管线要求 `data["items"]`，另允许可选 `project` 字段）
- **THEN** 返回 400，错误信息指明 items 格式问题
- **AND** 不调用 Python 管线

### Requirement: Python 管线子进程调用

系统 SHALL 以子进程方式调用 skill 管线，命令形如：
`python <skill>/scripts/build_review_html.py --pdf <abs>/source.pdf --items <abs>/items.json --out <abs>/review.html --vendor <skill>/assets/vendor --title <原始文件名去扩展名>`
系统 SHALL NOT 修改该脚本及 skill 目录内任何文件；skill 根路径 SHALL 可经环境变量 `TENDER_SKILL_DIR` 配置，缺省取 `<用户主目录>/.workbuddy/skills/tender-material-checklist`。

#### Scenario: 管线成功退出

- **WHEN** 子进程以退出码 0 结束
- **THEN** `--out` 指定路径存在完整 HTML 产物，服务基于该文件提供下载

#### Scenario: Python 环境缺失

- **WHEN** 调用前探测 `python --version` 失败（ENOENT 或非 0 退出）
- **THEN** 返回 503，错误信息包含「未检测到 Python 环境」与安装要求（Python 3.11+ 与 pdfplumber）
- **AND** 不产生部分产物或残留记录被误认为成功

#### Scenario: 管线执行报错

- **WHEN** 子进程以非 0 退出码结束
- **THEN** 返回 502，响应错误信息包含 stderr 最后 20 行
- **AND** 日志记录完整命令行与完整 stderr

#### Scenario: 管线超时

- **WHEN** 子进程运行超过 150 秒
- **THEN** 终止该子进程及其全部子进程，返回 504，错误信息包含超时时限
- **AND** 不将未完成的产物提供给下载

### Requirement: 产物下载

系统 SHALL 提供 `GET /tender/review/:id/download`，以文件流返回该记录对应的产物 HTML。

#### Scenario: 下载已生成的产物

- **WHEN** 请求的 `id` 在 `tender_document` 表中存在，且对应产物文件存在
- **THEN** 返回 200，`Content-Type: text/html`，`Content-Disposition: attachment`，响应字节与落盘产物一致

#### Scenario: 请求不存在的 id

- **WHEN** 请求的 `id` 在 `tender_document` 表中无记录
- **THEN** 返回 404

#### Scenario: 产物文件丢失

- **WHEN** 记录存在但产物文件已被删除
- **THEN** 返回 404，错误信息说明产物文件缺失

### Requirement: 上传记录持久化

系统 SHALL 建立 `tender_document` 表（字段与类型见 `design.md`），每次上传受理成功即写入一条记录；`pageCount` 与 `pageOffset` 允许为空，由后续阶段填充。

#### Scenario: 受理成功后可查记录

- **WHEN** 上传受理成功（校验通过、文件已落盘）
- **THEN** 可按返回的 `id` 查到记录，字段含 `id`、`filename`、`path`、`createdAt`
