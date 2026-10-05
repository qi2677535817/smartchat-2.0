# spec delta: runtime（新增 capability · 局域网运行时基线）

> 本文件为 OpenSpec 变更增量，全部为 ADDED Requirements。
> 该 capability 描述「单机部署、局域网 ≤5 人使用」场景下的运行时与交付要求，不涉及业务功能。

## ADDED Requirements

### Requirement: SQLite 并发配置

系统 SHALL 在建立数据库连接时启用 WAL 日志模式与写锁等待，
以支撑多人并发读写而不出现 `SQLITE_BUSY` 错误。

#### Scenario: 启动后日志模式为 WAL

- **WHEN** 服务启动完成
- **THEN** 对数据库执行 `PRAGMA journal_mode;` 返回 `wal`
- **AND** `data-cache/smartchat.db-wal` 文件存在

#### Scenario: 并发写入不失败

- **WHEN** 1 秒内并发发起 2 次以上写入（如连续上传）
- **THEN** 全部返回 2xx
- **AND** 日志中不出现 `SQLITE_BUSY`

#### Scenario: 写锁等待上限

- **WHEN** 写入遇到锁竞争
- **THEN** 系统 SHALL 最多等待 5000 毫秒后再判定失败，SHALL NOT 立即抛错

### Requirement: 生产运行与反向代理基线

交付物 SHALL 提供进程守护配置与反向代理配置示例，使服务在无 IDE 参与下常驻运行，
且长连接（SSE）不被代理层按默认超时切断。

#### Scenario: 进程崩溃自动重启

- **WHEN** 使用提供的进程守护配置启动服务，且进程异常退出
- **THEN** 守护器 SHALL 在 5 秒内自动重启该进程
- **AND** 进程内存超过 1 GB 时被重启，避免长期泄漏累积

#### Scenario: SSE 长连接不被切断

- **WHEN** 反向代理按示例配置转发 `/tender/documents/:id/extract`
- **THEN** 连接在 900 秒内保持不被切断
- **AND** 代理关闭响应缓冲（`proxy_buffering off`），使 `queued` / `progress` 事件实时到达
- **AND** 上传请求体上限（`client_max_body_size`）不小于 210 MB，与上传体积上限一致

#### Scenario: 部署前置依赖可核验

- **WHEN** 按部署指南执行前置检查
- **THEN** 指南 SHALL 逐项给出可执行命令，用于核验 Node、Python 3.11+、`pdfplumber`、`TENDER_SKILL_DIR` 是否就位
- **AND** 任一缺失时给出明确的失败现象与修复动作

### Requirement: 部署不越界

部署方案 SHALL NOT 引入容器化，SHALL NOT 引入用户体系或鉴权，
SHALL NOT 引入新运行时依赖（如 Redis / 消息队列中间件）。

#### Scenario: 依赖边界核验

- **WHEN** 检查 `package.json` 依赖与部署产物
- **THEN** 相对本变更前**无新增运行时依赖**
- **AND** 部署产物不包含 Dockerfile / docker-compose 等容器化文件
