# Design: add-tender-extraction-fc

## 与既有模块的接口关系

| 对象 | 关系 | 说明 |
|---|---|---|
| `chat` 模块 | **复用 FC 循环**（红线 5） | 给 `ChatService` 新增公开方法 `runToolLoop(messages, model, tools, handlers, toolChoice)`：由现有 `runChatLoopNonStream` 泛化而来（接受 tools/handlers/toolChoice 参数）。TenderModule 导入 ChatModule（其导出 ChatService）后注入调用 |
| `tender` 模块 | 承载提取与端点 | 新增 `tender-extraction.service.ts`；扩展现有 controller 加两个端点 |
| `PythonPipelineService` | 复用 PDF 提取与 HTML 生成 | `extractText`（加 `--json` 形态）与 `buildReviewHtml` |
| `extract_text.py` | 加 `--json` 参数 | 输出 `{"pageCount":N,"pages":[{"pno":1,"text":"..."}]}`；不传 `--json` 时行为不变（会话附件链路不受影响） |
| `tools/index.ts` | 注册新工具 | `submit_requirements` 加入 tools 数组（提取专用，不参与普通对话，故在提取时显式传入 tools 参数而非全局注册） |
| `data-cache/tender/<id>/` | 复用落盘布局 | `source.pdf` / `items.json` / `review.html` 与阶段 1 一致 |

## 端点设计

| # | 端点 | 方法 | 输入 | 输出 | 说明 |
|---|---|---|---|---|---|
| 1 | `/tender/documents` | POST | multipart `file`(PDF) | `{id}` | 落盘 PDF + 建 `tender_document` 记录 |
| 2 | `/tender/documents/:id/extract` | GET | `?model=`(可选，默认 `deepseek-v4-flash`) | **SSE** | 提取 → 落 items.json → 生成 review.html → 推 done |
| 3 | `/tender/review/:id/download` | GET | — | HTML | **复用阶段 1** 已有端点 |

> 提取模型：默认 `deepseek-v4-flash`（与前端模型列表一致），可用 `?model=` 覆盖。

> 阶段 1 的 `POST /tender/review`（需人工 items）保持不变，作为"已有清单直接渲染"的路径保留。

## SSE 事件协议

```
data: {"type":"start","blockTotal":6,"pageCount":79}
data: {"type":"progress","blockIndex":1,"itemCount":12}      // 每块提取完成
data: {"type":"generating"}                                   // 提取完成，开始生成 HTML
data: {"type":"done","id":"<uuid>","downloadUrl":"/tender/review/<id>/download","itemCount":36}
data: {"type":"error","message":"..."}
```

- 前端 `EventSource`/fetch 流读，实时显示「正在提取第 N/6 块，已得 X 条」。
- 长连接（2–5 分钟）：服务端不设短超时；vite proxy 对 SSE 直通（已在 chat/stream 验证）。

## 分块策略（方案 A）

- 每块 **15 页**，相邻块**重叠 1 页**（块尾页同时作为下块首页）。
- 79 页 → 6 块：`1-15 / 15-29 / 29-43 / 43-57 / 57-71 / 71-79`。
- 每块文本 = 该页范围内逐页文本拼接，**不标注页码**（防止模型输出页码，红线 2）。
- 每块独立调用 FC 循环提取，块间结果全局去重。

## 提取 Prompt（常量集中在 `tender-extraction.prompt.ts`）

**system**（由 SKILL.md / extraction-guide.md 转成常量）：

1. 角色与三条铁律（不能少 / 不能多 / 不能错，逐字引用原文依据）
2. 六区域关注点（A 资格要求 / B 评审办法 / C 投标文件组成 / D 否决无效条款 / E 技术要求 / F 商务条款）—— 每块文本都要按这六个视角扫
3. 强制级别判定表（必须/须/应 → 强制；否则无效/否决 → 强制；提供…得 X 分 → 评分；如有/可以提供 → 待确认）
4. 15 项高频易漏点清单（作为自查提示，不得无依据添加）
5. 输出要求：
   - **必须**通过 `submit_requirements` 工具提交，禁止直接文本输出
   - `anchor` 必须是原文中**短（10–30 字）、唯一、不跨页**的连续片段
   - `origin` 用章节名（如「第四章 资格审查办法前附表」），**禁止写页码**
   - `cat` 从七大类枚举中选（见下）
6. **红线**：不要输出任何页码数字；找不到原文依据的内容不得进清单

**user**：本块纯文本。

### cat 七大类（供模型归类，前端分组展示用）

| 类 | 含义 |
|---|---|
| `A 资格证明文件` | 营业执照、资质证书、财务报告、社保/纳税、信用记录 |
| `B 投标保证金` | 保证金缴纳凭证、银行保函 |
| `C 投标文件格式文件` | 投标函、开标一览表、报价表、法定代表人身份证明、授权委托书 |
| `D 声明与承诺函件` | 中小企业声明函、无重大违法声明、各类承诺函 |
| `E 技术响应文件` | 检测报告、彩页、说明书、制造商授权书、认证证书 |
| `F 业绩与信誉材料` | 合同、中标通知书、验收证明、荣誉证书、人员证书 |
| `G 商务与其他` | 质保承诺、售后服务、其他补充要求 |

## `submit_requirements` 工具 schema

```ts
parameters: {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          cat:    { type: 'string', description: '七大类之一' },
          name:   { type: 'string', description: '材料/资质名称，用原文命名' },
          quote:  { type: 'string', description: '逐字摘录的要求原文' },
          origin: { type: 'string', description: '章节名，禁止页码' },
          level:  { type: 'string', enum: ['强制','评分','待确认'] },
          form:   { type: 'string', description: '份数/盖章/原件/有效期等形式要求' },
          anchor: { type: 'string', description: '短、唯一、不跨页的原文片段' },
        },
        required: ['cat','name','quote','origin','level','form','anchor'],
      },
    },
  },
  required: ['items'],
}
```

- handler 把 `args.items` 收集到提取上下文（跨块累积）。
- 提取时 `tool_choice` 设为 `required`（强制产出结构化结果）。

## 去重算法（后端，不交给模型）

```
输入：跨块累积的全部候选条目
1) anchor 归一化（去空白）后完全相同 → 合并，origin 去重拼接
2) name 归一化后完全相同，或一方包含另一方 → 视为同一材料 → 合并
3) 合并规则：
   - origin：去重后 '；' 拼接
   - level：取最严（强制 > 评分 > 待确认）
   - form：合并去重
   - quote：保留最长的一条（信息最全）
   - 若限定条件冲突（年份/份数不同）→ **不合并**，保留两条并在 note 标注差异
4) 合并完成后统一编号 id = 1..N（按首次出现顺序）
```

## 与阶段 1 的衔接

```
items（去重后）→ 落盘 data-cache/tender/<id>/items.json（结构 {"project":{},"items":[...]}）
              → pipeline.buildReviewHtml(pdf, items, review.html, title)
              → 复用的下载端点返回 HTML
```

- `project` 字段填 `{ title: <原文件名> }`（脚本可选读取）。
- 若管线报告存在 MISS → 在 done 事件中附带 `missCount`，前端提示「有 N 条未定位，界面内会标红」，不阻断交付（对应红线：宁可标红也不静默）。

### 锚点修正重试（提高定位率）

单次生成后读取管线输出的坐标条目（`review_items.json`），对 `resolve === 'MISS'` 的条目，
从自身 `quote` 中按标点切分出更可靠的候选片段替换 `anchor`，再重新生成，最多 3 轮。
实测：4 条未定位 → 修正后 2 条（其余 2 条因 `quote` 本身与原文不符，无可用候选，保留标红）。

### 分类归一化

模型可能只输出分类字母（`A`/`B`/…），落盘前统一归一化为完整分类名（如 `A` → `A 资格证明文件`），
保证前端与复核 HTML 的分组展示一致。

### 模块依赖处理（避免循环）

`ChatModule → SessionModule → TenderModule → ChatModule` 会成环，故将 `PythonPipelineService`
抽到独立的 `PdfPipelineModule`（无业务依赖）：

```
ChatModule  → SessionModule → PdfPipelineModule
            → KnowledgeBaseModule / EmbeddingModule
TenderModule → PdfPipelineModule + ChatModule(导出 ChatService)
```

`ChatModule` 导出 `ChatService`，`TenderModule` 导入它即可复用 `runToolLoop`。

## 降级方案

| 情形 | 行为 |
|---|---|
| 扫描件（无文本层） | `extract_text.py --json` 无有效文本 → `error` 事件「扫描件暂不支持」 |
| 单块 FC 调用失败 | 该块跳过并累计失败块数；全部块失败 → `error`；部分失败 → 继续并在 done 中报告 `failedBlocks` |
| 模型未调用工具（无产出） | 该块标记为 0 条并记录日志；最终若总条数为 0 → `error`「未提取到条目」 |
| HTML 生成失败（MISS 过多/脚本异常） | `error` 事件透传 stderr 摘要；items.json 已落盘，可人工修正后走阶段 1 端点重跑 |
| 超时 | 单块 FC 调用设超时（如 120s）；整体无硬超时，由 SSE 连接存活决定 |
