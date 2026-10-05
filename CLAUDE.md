# CLAUDE.md — smartchat-2.0 项目规则

> 本文件是给 AI 编码助手（Claude Code / Cursor / Codex）的项目级规则。
> 事实来源：`docs/PRD-标书复核Agent.md`（产品定义）、`docs/tender-agent-design.md` v1.2（技术细节）。
> 文档与你的判断冲突时，一律以文档为准，并停下来向人确认。

## 项目是什么

在既有的 smartchat-2.0（企业内部知识问答系统）上做二开，新增"标书复核"业务链路：
上传招标文件 PDF → 自动提取全部应交材料与资质 → 生成左右对照复核界面（左原文/右清单/可定位高亮）
→ 检索企业知识库填充"我方是否具备" → 导出成表。

唯一硬指标是「准确」：**不能少、不能多、不能错**。漏一份材料 = 废标，这是真金白银的业务风险。

## 二开的本质（最重要的判断）

这不是从零开发，而是**集成工程**：把一条已在离线状态验证过的 Python 文档管线，
接进一个已有服务化能力（NestJS + Vue3）的平台。工作量和风险都因此可控。

## 已有资产 —— 必须复用，严禁重写

【平台层 · smartchat-2.0】
- FC 引擎（流式工具调用循环、tool_calls 按 index 累积、多轮执行）
  位置：`server/src/modules/chat/chat.service.ts` —— 这就是 Agent 引擎，提取需求项走它
- 工具注册机制：`server/src/modules/chat/tools/index.ts`（tools 数组 + toolHandlers 映射）
- SSE 流式：POST /chat/stream（@Sse + RxJS）
- RAG 检索：`KnowledgeBaseService.searchRag(query, isTest)` —— 填充"我方是否具备"必须用它
- 知识库：分级 chunking + mtime 增量 + 余弦检索（JSON 向量库）
- 会话持久化：session 模块（TypeORM + better-sqlite3）
- 前端流式接收 / 思维链折叠 / DOMPurify：`client/src/stores/chat.ts`、`client/src/views/ChatView.vue`

【文档管线层 · tender-material-checklist skill】
位置：`~/.workbuddy/skills/tender-material-checklist/`
- SKILL.md：三条铁律（不能少/不能多/不能错）+ 五阶段流程 + 六区域定位表
- references/extraction-guide.md：强制性用词判定表 + 15 项高频易漏点清单
- references/review-tool-spec.md：8 项锁定决策 + 3 大核心机制 + 9 条已踩技术坑
- scripts/build_review_html.py（878 行）：词级坐标定位 + 字符级容错匹配 + 页码投票校准 + 覆盖度校验 + 单文件 HTML 打包
- scripts/verify_rects.py：高亮框几何验证（裁图提字反查原文，PASS 率要求 100%）
- assets/vendor/：pdf.js（Mozilla，Apache-2.0）

## 技术栈（锁定，不得擅自变更或引入新框架）

- 后端：NestJS 11 + TypeScript 5.7 + TypeORM + better-sqlite3 + class-validator + RxJS（SSE）
- 前端：Vue 3.5 + TypeScript + Vite + Pinia + vue-router + marked + DOMPurify
- 文档解析：Python 3.13 + pdfplumber（skill 资产，走子进程调用）
- PDF 渲染：pdf.js（skill 内嵌资产）
- 存储：SQLite（关系数据）+ JSON 文件（向量库，一期可接受暴力检索）
- 大模型：DeepSeek（对话与 Function Calling）+ embedding / rerank 双通道外部 API
- 测试：Jest（后端）+ skill 自带的 Python / Node 自检脚本

## 架构红线（违反其一即为跑偏，必须停下来问人）

1. 禁止把 pdfplumber 管线用 Node 重写 —— 会销毁已验证的容错匹配、页码校准、几何验证能力
2. 禁止让大模型输出页码 —— 模型数不准页；页码与坐标必须由本地字符串匹配计算
3. 禁止在前端做运行时模糊搜索定位 —— 高亮坐标必须由后端预计算
4. 禁止新写检索逻辑 —— RAG 填充必须复用 `KnowledgeBaseService.searchRag()`
5. 禁止新写 Agent 引擎 —— 提取必须复用 chat 模块既有的 FC 循环
6. 禁止修改 skill 里的 Python 脚本逻辑 —— 只允许新增命令行参数做接口适配
7. 导出内容必须来自机器验证过的逐字引用 —— AI 概括只可用于标题与导航，不得作为清单正文

## 明确不做（一期边界）

用户体系/登录/权限、扫描件 OCR、Word/图片多格式、向量库专业方案升级、
替换 FC 引擎或引入 LangChain、云部署与容器化、移动端与响应式、完美 UI 样式。

## 代码规范

- 后端严格沿用现有 NestJS 模块结构：module / controller / service / dto 分离
- 新模块放 `server/src/modules/<name>/`，在 app.module.ts 注册
- 工具文件放 `server/src/modules/chat/tools/` 下按 `<name>.tool.ts` 命名，
  同时导出「定义」与「handler」，并在 tools/index.ts 注册
- 全部注释用中文；提交信息用中文
- 不引入新依赖除非确有必要，引入前说明理由
- 注意：server 必须在 server 目录下启动（FsUtil 依赖 process.cwd()）

## 验收要求（每批改动都必须满足）

- 量化标准优先，禁止用"应该没问题"作为验收结论
- 涉及定位/坐标的改动：必须跑 `verify_rects.py`，PASS 率 100%、SKIP 为 0
- 涉及前端脚本的改动：必须跑 `test_frontend_logic.js` 且退出码为 0
- 涉及编译的改动：`nest build` / `vue-tsc` 必须通过
- 一个任务一次 commit，验收不过立即回滚，禁止在坏状态上继续叠加
- 报告结果时如实呈现：不得把 SKIP 计入 PASS、不得把"未验证"表述为"通过"
