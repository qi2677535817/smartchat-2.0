# 标书需求整理 Agent · 最小演示链设计草案

> 版本：**v1.2（2026-10-02）** · 用途：交给 AI 自主开发的施工图纸 + 人工验收依据
> 原则：**AI 负责实现，本文件负责架构**。实现与本文件冲突时，以本文件为准。

---

## ⚠️ v1.2 重大变更（开工前必读，覆盖下文第 2-4 节的实现方式）

**已找到既有成品 skill：`tender-material-checklist`**（实体：`C:\Users\qi\Desktop\tender-material-checklist.zip`；解压副本：`C:\Users\qi\WorkBuddy\面试准备\_skill_tender\`；建议正式安装到 `~/.workbuddy/skills/`）。

它已实现本文档第 2-4 节的大部分设想，**且成熟度更高**（有几何验证、页码校准、容错匹配、离线自检）。因此本节以下内容**从"从零实现"改为"复用改造"**：

| 原 v1.1 设想 | v1.2 改为 |
|---|---|
| 前端 pdfjs 解析 PDF | **复用 `build_review_html.py` 的 pdfplumber 词级坐标管线** |
| 自写提取 Prompt 常量 | **复用 `SKILL.md` 三条铁律 + 六区域提取法 + `references/extraction-guide.md` 的 15 项易漏点清单** |
| 自设计复核页面 | **复用 skill 产出的单文件离线 HTML**（配色/对比度/状态机已调优） |
| 自写导出 | **复用 JSON 导出 → AI 生成规范 Word 双通道** |
| FC 工具 `submit_requirements` | 保留（这是与 smartchat 共引擎的看点），但**提取结果落到 skill 的 items JSON 结构**（见 review-tool-spec 第四节） |

**真正要新写的只剩两块**：
1. **服务化**：把 Python 管线包成 `POST /tender/review`，入参 PDF，返回 HTML 文件流（或落盘路径）
2. **RAG 填充**：条目 JSON → 复用 `KnowledgeBaseService.searchRag()` → 填充"我方是否具备"列

**Step 序列已更新为 5 步**，见 `C:\Users\qi\WorkBuddy\面试准备\06-项目二-招标材料清单复核工具.md` 第八节（每步含 ≤3 分钟验收标准）。

**不要重复造轮子**：skill 里的 `verify_rects.py`（几何验证）、`scan_keywords.py`（关键词定位）、`test_frontend_logic.js`（前端离线自检）直接调用，不要重写。

---

## 0. 目标与边界

**目标**：在 smartchat-2.0（NestJS + TypeORM/SQLite + Vue3）内新增 tender 模块，跑通一条最小演示链：

```
上传 PDF → 解析为带页码文本 → FC 强制提取需求项 JSON
  → 前端左右分栏复核（定位/高亮/确认/否决）
  → 确认项调 searchRag 检索历史资料填充
  → 导出 xlsx 下载
```

**明确不做**（涉及时统一回复"二期规划"）：用户体系/权限、扫描件 OCR、图片存储、完美样式、异常兜底重试、并发控制。

---

## 1. 核心数据结构（先定死，不得更改字段名）

```ts
// 需求项 —— 模型提取的原子产物
interface RequirementItem {
  id: string                    // "REQ-" + 3位序号，如 REQ-001
  documentId: string            // 所属文档
  title: string                 // 需求短标题（模型概括，≤20字，仅作导航用途）
  content: string               // 需求原文逐字引用（模型只摘录不改写）
  page: number                  // 页码：由本地脚本对 content 做字符串匹配计算得出，不信任模型报的页码
  matchStatus: 'verified' | 'not_found'  // 机器校验：引用片段在解析文本中是否匹配成功
  type: 'explicit' | 'implicit' // 显性需求 / 隐性需求（资质、业绩类隐藏条款）
  status: 'pending' | 'confirmed' | 'rejected'
}

// 解析后的文档
interface ParsedDocument {
  id: string                    // uuid
  name: string                  // 原始文件名
  totalPages: number
  createdAt: number
}

// 分页文本（与 ParsedDocument 1:N，或 JSON 列存储）
interface DocPage {
  documentId: string
  page: number                  // 从 1 开始
  text: string                  // 该页纯文本
}

// 检索填充结果
interface FilledResource {
  requirementId: string         // REQ-xxx
  sourceName: string            // 命中的知识库文档名（searchRag 返回的 name）
  score: number                 // 相似度/rerank 分
  content: string               // 命中的资料片段
}
```

存储：SQLite 新增三张表 `tender_documents` / `tender_requirements` / `tender_filled_resources`（分页文本可存 documents 表 JSON 列）。

---

## 2. 后端端点（NestJS，新建 `modules/tender/`）

| # | 端点 | 方法 | 输入 | 输出 | 说明 |
|---|---|---|---|---|---|
| 1 | `/tender/documents` | POST | multipart 文件（.pdf） | ParsedDocument | 接收上传 → pdfjs 解析 → 按页存文本 → 返回文档元信息 |
| 2 | `/tender/documents/:id/extract` | POST | 无 | SSE 流式 | 分块调 DeepSeek **Function Calling** 提取需求项；流式推送 `{type:'progress', done, total}` 与 `{type:'item', item}`；结束 `{type:'done', count}` |
| 3 | `/tender/documents/:id/requirements` | GET | 无 | RequirementItem[] | 复核页数据源 |
| 4 | `/tender/requirements` | PATCH | `{items: [{id, status}]}` | `{updated: n}` | 批量提交复核结果 |
| 5 | `/tender/documents/:id/fill` | POST | 无 | FilledResource[][] | 取 status=confirmed 的需求项，逐条调**现有 KnowledgeBaseService.searchRag()**（top3），结果存库并返回 |
| 6 | `/tender/documents/:id/export` | GET | 无 | xlsx 文件流 | exceljs 生成：列=需求标题/原文/页码/类型/状态/命中的资料与来源；设置 `Content-Disposition` 触发下载 |

**技术选型备注**：
- PDF 解析：优先 `pdfjs-dist`（legacy build，Node 可用，能按页取文本）；若安装/运行受阻，降级 `pdf-parse`。解析目标是**按页分割的纯文本**，页码即定位锚点。
- 复用约束：**第 5 步必须直接注入现有的 `KnowledgeBaseService` 调 `searchRag()`**，禁止重新实现检索。第 2 步的模型调用复用 `ChatService` 里已有的 DeepSeek 配置读取方式。
- 提取走 **Function Calling**（项目已有该机制）：定义工具 `submit_requirements`，参数即 `RequirementItem[]` 数组 schema——用 FC 的结构化输出保证 JSON 合法，而不是裸 Prompt 拼文本。

**提取 Prompt 要点**（写进 tender 模块常量，源自标书 skill 已验证的设计原则）：
- system：你是标书需求提取员；**只提取原文中明确存在的内容，禁止推断和补全**；每条输出**逐字引用的原文片段**（不许改写、不许概括内容字段）；区分显性需求与隐性需求（资质/业绩/人员/工期等隐藏门槛）；输出通过工具提交。
- **页码不由模型提供**：模型只给逐字引用片段；后端脚本在各页解析文本中做字符串匹配，命中即写入 page 并标记 verified；未命中标记 not_found（前端标红"原文未找到"，人工重点核查）。
- **零差错原则**：最终导出表格的实质内容由机器验证过的逐字引用片段拼接生成；模型的 title 概括只用于列表导航。
- 分块策略：按页分组、每 5 页一块；每块独立提取；结果全局去重（按 content 相似度 + 匹配页码）。

---

## 3. 前端（2 个新页面 + 路由）

| 页面 | 路由 | 功能 |
|---|---|---|
| `TenderReview.vue` | `/tender/review/:id` | 顶部：上传/选文档；主体左右分栏：左 = pdf.js 渲染原文（按页）；右 = 需求项卡片列表（类型徽标 + 状态标记 + **matchStatus=not_found 的项标红"原文未找到"**）。**点击需求项 → 左侧跳到匹配页并高亮该页文本**。每项操作：确认 / 否决。底部：提交复核（调端点 4）→ 成功后自动调端点 5 展示填充结果。可选辅助区：单独分区展示"疑似遗漏"（关键词召回未被任何需求项覆盖的句子，与正式结果隔离，控制误报影响） |
| `TenderResult.vue` | `/tender/result/:id` | 需求 × 命中资料对照表 + 「导出 Excel」按钮（调端点 6，`window.open` 或 a 标签下载） |

- pdf.js 高亮实现：解析时已有页码，翻到对应页后在该页文本节点中查找 `content` 的前 20 字符做 `mark` 标记（模糊匹配，找不到就不高亮但不报错）。
- 样式从简：现有 SCSS 风格复用，不引入新 UI 库。

---

## 4. AI 自主开发的执行序列（一步一验收，禁止连跑两步）

| Step | 任务 | 交付 | 人工验收标准（≤3 分钟） |
|---|---|---|---|
| 1 | tender 模块骨架 + 端点 1 | 代码 + git commit | `curl -F file=@test.pdf` 返回含 totalPages 和页数的 JSON；SQLite 有记录 |
| 2 | 端点 2（FC 提取） | 代码 + commit | curl 触发后 SSE 推进度；库中该文档 ≥10 条需求项，每条含页码和原文引用 |
| 3 | 复核页（TenderReview） | 代码 + commit | 浏览器打开：左右分栏渲染，点击需求项左侧跳页高亮，确认/否决可点 |
| 4 | 端点 4+5（复核提交 + 检索填充） | 代码 + commit | 提交后 confirmed 项能返回带 sourceName 的历史资料 |
| 5 | 端点 6（导出）+ TenderResult | 代码 + commit | 下载的 xlsx 用 WPS/Excel 打开：每行一条需求 + 命中资料 |

**给 AI 的开工指令模板**（每次新会话粘贴）：

> 阅读 `docs/tender-agent-design.md`，严格按其中数据结构与端点定义实现 Step N（只做这一步）。技术选型和复用约束以文档为准。完成后：`npm run build` 必须通过，写明如何用 curl 验收，然后 git commit（message: `tender: step N - <内容>`）。不要实现后续步骤。

**验收失败处理**：修一轮仍不过 → `git checkout .` 回滚该步，换提示重试；**绝不让 AI 在坏状态上叠下一步**。

---

## 5. 风险与预案（同时是面试话术）

| 风险 | 预案 | 面试口径 |
|---|---|---|
| 扫描件 PDF 解析出乱码 | 检测每页文本长度 < 阈值即判定扫描件，提示不支持 | "一期只做文字型 PDF，扫描件需要 OCR，二期规划" |
| 模型提取幻觉/漏项 | 强约束 FC schema + 逐字引用 + **人工复核页兜底** | "防幻觉靠流程设计：可溯源、可人工否决" |
| **模型报的页码不可信** | 页码由本地脚本字符串匹配计算，匹配失败标红 | "定位不信任模型输出，信任代码验证——零差错靠机器校验链" |
| 跨页需求被切断 | 按页 5 块重叠 + 全局去重 | "分块带重叠，提取结果合并去重" |
| 大文件超 token | 单块超限时对块内再切；极端换 128k 模型 | "三级预案：结构切分 → 块内再切 → 长上下文兜底" |

---

## 6. 完成定义（Definition of Done）

一条真实标书 PDF 走完全链路：上传 → 提取出需求列表 → 复核确认若干条 → 看到知识库填充结果 → 下载到一份完整的 xlsx。**能做到这一步，面试里"上周刚跑通核心链路"这句话就成立了。**
