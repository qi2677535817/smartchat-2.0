# spec delta: tender-extraction（新增 capability）

> 本文件为 OpenSpec 变更增量：全部为 ADDED Requirements。
> 核心约束：模型不得输出页码（红线 2）；FC 循环复用 chat 模块（红线 5）；PDF 与 HTML 均走既有 Python 脚本（红线 1）。

## ADDED Requirements

### Requirement: 分页文本提取

系统 SHALL 支持以分页结构提取 PDF 文本（`extract_text.py --json`），输出每页纯文本与总页数，且不改变默认（纯文本）输出行为。

#### Scenario: 分页提取

- **WHEN** 对文字版 PDF 调用分页提取
- **THEN** 返回结构含 `pageCount` 与按页序号排列的 `pages[].text`
- **AND** 页数与 `pdfplumber` 读取的页数一致

#### Scenario: 向后兼容

- **WHEN** 不传 `--json`（会话附件链路调用）
- **THEN** 输出与改造前一致的纯文本

### Requirement: FC 自动提取条目

系统 SHALL 复用 chat 模块的 FC 循环，按「每块 15 页 + 相邻重叠 1 页」分块提取需求条目；每块 SHALL 注入三条铁律、六区域关注点、强制级别判定表与易漏点清单；模型 SHALL 只输出 `anchor`/`quote` 等文本字段，SHALL NOT 输出页码。

#### Scenario: 分块提取

- **WHEN** 对 79 页 PDF 发起提取
- **THEN** 按 15 页/块切分为 6 块（含重叠），逐块调用 FC 循环
- **AND** 每块完成即推送一次进度事件（块序号 + 当前累计条目数）
- **AND** 模型产出中不含任何页码字段

#### Scenario: 未调用工具

- **WHEN** 某块模型未调用 `submit_requirements`
- **THEN** 该块记为 0 条并记录日志，不中断整体流程

### Requirement: 全局去重

系统 SHALL 对跨块提取结果做全局去重：`anchor` 归一化相同或 `name` 相同/包含者合并；合并时 `origin` 去重拼接、`level` 取最严、`form` 合并；限定条件冲突（年份/份数不同）SHALL NOT 合并。

#### Scenario: 同一材料多处出现

- **WHEN** "营业执照"在资格要求与格式章节各出现一次
- **THEN** 合并为一条，`origin` 含两处出处，`level` 取最严者

#### Scenario: 限定条件冲突

- **WHEN** 同一材料出现"近三年"与"近五年"两种限定
- **THEN** 保留两条并在 `note` 标注差异，不合并

### Requirement: 一键生成复核界面

系统 SHALL 提供 `GET /tender/documents/:id/extract`（SSE）：提取完成后自动调用 `build_review_html.py` 生成复核 HTML，并以 `done` 事件返回下载地址；SHALL 提供 `POST /tender/documents`（multipart PDF）用于上传落盘。

#### Scenario: 一键到底

- **WHEN** 上传文字版 PDF 并订阅提取 SSE
- **THEN** 依次收到 `start` → 多次 `progress` → `generating` → `done`
- **AND** `done` 事件含 `downloadUrl`，访问该地址返回复核 HTML
- **AND** `items.json` 与 `review.html` 落盘于 `data-cache/tender/<id>/`

#### Scenario: 扫描件拒绝

- **WHEN** 上传无文本层的 PDF
- **THEN** 收到 `error` 事件，说明扫描件不支持

#### Scenario: 部分块失败

- **WHEN** 部分块的 FC 调用失败
- **THEN** 继续处理其余块，`done` 事件中报告失败块数，已提取条目不丢弃

### Requirement: 提取结果可定位（质量闸门）

系统 SHALL 保证交付的复核界面中每条条目都有可定位的 `anchor`；未定位条目 SHALL 在界面标注为未找到，并统计其数量。

#### Scenario: 几何验证

- **WHEN** 对提取产物运行 `verify_rects.py`
- **THEN** PASS 率 100%，SKIP = 0（无凭空条目）

#### Scenario: MISS 提示

- **WHEN** 管线报告存在 MISS 条目
- **THEN** `done` 事件附带 `missCount`，前端提示未定位条数，不阻断交付
