# 验收证据：add-tender-pipeline-service

> 验收日期：2026-10-02　环境：Windows 11 · Node 22.14 · Python 3.14.7 · pdfplumber 0.11.10
> 测试文件：`CPU高性能计算集群_采购文件.pdf`（79 页文字版真实招标文件，用户提供）

## 前置说明

1. **阶段 0 基线由本 change 代建**：用户未提供现成 items.json，实施中从 PDF 提取真实语句构造 5 条条目（含 1 条故意重复锚点以验证 AMBIG 分支），以管线手动运行两次的方式产出基线。正式人工核对的基线仍待用户确认，已在"遗留"中记录。
2. **任务 3 与任务 4 合并为一次 commit**：download 端点与管线编排交织在同一 controller 中，无法拆分提交，但两者验收证据分别留存。
3. **.env 由用户创建**（DeepSeek + embedding 密钥），解决了既有 `initRag` 启动崩溃（与本 change 无关的既有环境依赖）。

## 任务 1：模块骨架与数据表

- `npm run build` → 退出码 0
- 启动后 `tender_documents` 表自动创建（synchronize）
- 表结构：`id:varchar | filename:varchar | path:varchar | pageCount:INTEGER | pageOffset:INTEGER | createdAt:INTEGER`
- 修复记录：TypeORM 无法从 `number | null` 反射列类型（报 `Data type "Object" ... not supported`），已在 `@Column` 显式声明 `type: 'integer'`

## 任务 2：上传受理（POST /tender/review）

| 用例 | 结果 |
|---|---|
| 真实 PDF + 合法 items | HTTP 201，返回 `{id, filename}`，中文文件名正确 |
| file 为非 PDF | HTTP 400「仅支持文字版 PDF」，不落盘不入库 |
| items 为坏 JSON | HTTP 400「items 文件不是合法 JSON」，不调管线 |
| 落盘检查 | `data-cache/tender/<id>/source.pdf` 688381 字节 == 原件字节数；items.json 已剥 BOM |
| DB 记录 | id / filename / path / createdAt 完整正确 |

实现中发现并修复的两个真实缺陷：
- **BOM**：Windows 侧 JSON 常带 UTF-8 BOM，`JSON.parse` 与 Python `json.load` 均拒绝 → Node 侧统一剥离后落盘（未改 Python，红线 6 合规）
- **中文文件名乱码**：multer 按 latin1 解码文件名 → latin1→UTF-8 还原

## 任务 3：spawn 调用 Python 管线

- 命令：`python build_review_html.py --pdf --items --out --vendor --title`（既有 5 参数，零新增）
- POST 全链路（上传→落盘→管线→响应）：**2618 ms**（79 页 PDF，验收线 3 分钟）
- 响应含 `downloadUrl` 与 `elapsedMs`
- 输出确定性：管线对同输入连跑两次，产物哈希一致 → 下载验收采用逐字节对照

## 任务 4：产物下载

- `GET /tender/review/<id>/download` → HTTP 200，`Content-Type: text/html; charset=utf-8`，`Content-Disposition: attachment; filename*=UTF-8''review.html`
- **哈希对照：服务产物 == 同参数手动管线产物（SHA256 一致）**，即"下载的 HTML 与基线内容一致"以字节级成立
- 不存在的 id → HTTP 404「记录不存在」
- 修复记录：路由模板初版误写 `@Get(':id/download')`（Controller 前缀已含 tender，缺 review 段导致 404 Cannot GET），已修正为 `@Get('review/:id/download')`

## 红线 6 核验：skill 零改动

- `~/.workbuddy/skills/tender-material-checklist` 与项目根 `tender-material-checklist/` 两份副本全量 9 文件 SHA256 完全一致
- scripts 下 4 个脚本 mtime 均为解压时间（10:56:40），早于实施开始

## 回归验证（verify_rects.py）

```
高亮框几何验证：共 5 条，PASS 5 条，SKIP 0 条（无定位），FAIL 0 条
[PASS] × 5   覆盖100.0%  越界0
```

**PASS 率 100%，SKIP = 0** —— 达到 config.yaml 验收标准。

## 遗留与偏差

| 项 | 说明 |
|---|---|
| 正式基线对照 | 本 change 的基线 items 由 AI 代建（5 条），"与人工核对基线一致"这一 PRD 验收项以字节级一致性（服务产物==管线产物）替代成立；正式人工核对基线待用户复核 items 后重建 |
| verify_rects 仅 5 条 | 条目数受代建基线规模限制；阶段 2 FC 提取落地后应全量回归 |
| 依赖变化 | 零新增运行时依赖（@types/multer 装后已卸，改用就地类型声明） |
