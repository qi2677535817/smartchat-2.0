# Proposal: add-tender-extraction-fc（阶段 2 · FC 自动提取条目 + 一键生成复核界面）

> 对应 PRD：第 6 节「阶段 2」；差距项 **G2**（提取靠人，管线只负责渲染）；功能 **F2**（条款自动提取）+ 打通 **F3**（锚点定位，复用阶段 1）。
> 前置：阶段 1（`add-tender-pipeline-service`）已服务化 `build_review_html.py`；`extract_text.py` 已随会话附件变更落地。

## Why

现状：复核 HTML 的生成机器（阶段 1）已就绪，但**喂给它的 items 清单必须人工准备**——真实使用中表现为「上传招标文件后无法生成复核界面」。本 change 复用 chat 模块的 FC 引擎自动提取需求条目，并与阶段 1 打通，实现一键到底：

```
上传招标 PDF →（自动）分块 FC 提取条目 → 去重 → 落 items.json
            →（自动）调 build_review_html.py → 复核 HTML → 返回下载/打开链接
```

## What Changes

1. **分页文本提取**：`extract_text.py` 增加 `--json` 输出每页文本（分块需要页边界；纯文本输出保持向后兼容，供会话附件使用）。
2. **FC 工具**：新增 `submit-requirements.tool.ts`（按 `tools/index.ts` 模式），参数即条目数组。
3. **提取服务**：新增 `tender-extraction.service.ts`
   - 按页固定分块（每块 ~15 页 + 1 页重叠），每块 prompt 注入三条铁律 + 六区域要点 + 强制级别判定表 + 15 项易漏点清单
   - 逐块调用 FC 循环（**复用 chat 模块既有循环**，不新写引擎）
   - 全局去重（按 anchor/quote 精确归并 + name 相似归并；限定条件冲突不合并）
   - 产出 `items.json` 落盘
4. **一键端点**：
   - `POST /tender/documents`（multipart PDF）→ 落盘 + 建记录 → 返回 `id`
   - `GET /tender/documents/:id/extract`（**SSE**）→ 逐块推送进度 → 提取完成后自动调管线生成复核 HTML → 推送 `{type:'done', downloadUrl}`
   - 下载复用阶段 1 的 `GET /tender/review/:id/download`
5. **前端**：新增 `/tender` 独立路由页 + 侧边栏「标书复核」导航；上传 → SSE 实时进度 → 完成后「打开复核界面」。

## 复用资产与不可重写理由

| 资产 | 复用方式 | 为什么不能重写 |
|---|---|---|
| chat 模块 FC 循环 | 提取服务调用其循环（新增公开方法承载 tool 循环） | 红线 5：禁止新写 Agent 引擎 |
| `build_review_html.py` | 提取后自动调用产出 HTML | 红线 1：坐标/容错/校准能力不能重写 |
| `extract_text.py` | 加 `--json` 参数 | 同一脚本，仅扩展输出形态 |
| SKILL.md / extraction-guide.md 的三条铁律·六区域·判定表·15 项易漏点 | 转成提取 prompt 的常量 | 已离线验证的提取知识，重写即丢失 |
| `tools/index.ts` 注册模式 | 新增工具并按既有模式注册 | 平台既有机制 |
| 阶段 1 的落盘布局与下载端点 | 复用 `data-cache/tender/<id>/` 与下载路由 | 保持一致，不重复造 |

## 架构红线确认

| 红线 | 是否触碰 | 说明 |
|---|---|---|
| 1 禁 Node 重写 pdfplumber 管线 | 否 | PDF 解析与 HTML 生成均走既有 Python 脚本 |
| 2 禁模型输出页码 | 否（严格禁止） | 模型只给 `anchor`/`quote`，页码与坐标由 `build_review_html.py` 本地计算 |
| 5 禁新写 Agent 引擎 | 否（复用） | 复用 chat 模块的 FC 循环，仅新增承载工具循环的公开方法 |
| 6 禁修改 skill Python 脚本逻辑 | 否（不触碰） | 仅扩展本项目自建的 `extract_text.py`（会话附件变更新增的脚本），不改 skill 既有脚本 |
| 3/4/7 | 不涉及 | 运行时前端模糊搜索、RAG 检索、导出分别属其它阶段 |

## 回滚方案

5 个任务 = 5 个 commit，一任务一验收；失败即 `git revert`。
新增代码集中在 `tender` 模块（提取服务 + 端点）与前端新页面；对既有文件的改动为**增量**（chat 模块加一个公开方法、`extract_text.py` 加参数），回滚不影响阶段 1 与会话附件链路。

## Impact

- **规格**：新增 capability `tender-extraction`。
- **后端**：`extract_text.py` 加参数；新增 `submit-requirements.tool.ts`、`tender-extraction.service.ts`、tender 端点；chat 模块新增公开 tool 循环方法。
- **前端**：新增 `TenderView.vue` + `/tender` 路由 + 侧边栏导航项。
- **依赖**：零新增。
