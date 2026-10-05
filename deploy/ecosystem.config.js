/**
 * PM2 进程守护配置（局域网多人部署基线 — openspec/changes/harden-lan-multiuser/design.md §8）
 *
 * 用途：替代「用 IDE 跑 dev 模式」，让服务在无人值守的工作站上常驻：
 * 崩溃自动重启、内存超限自动回收、日志统一落盘。
 *
 * 使用步骤（从仓库根目录执行）：
 *   1) mkdir logs
 *   2) cd server && npm run build            构建后端产物 dist/
 *   3) cd client && npm run build            构建前端 dist/（交给 Nginx 托管，见 nginx.conf.example）
 *   4) pm2 start deploy/ecosystem.config.js
 *   5) pm2 save && pm2 startup               配置开机自启
 *
 * 注意：
 *   - 必须单实例（instances: 1 / fork）：数据库是 SQLite 单文件，cluster 多实例会争抢写锁。
 *   - 前端不在此配置中：由 Nginx 直接托管 client/dist 静态产物，避免用 dev server 扛生产流量。
 */
module.exports = {
  apps: [
    {
      name: 'smartchat-server',
      cwd: './server',
      script: 'dist/main.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '1G', // 内存超限自动重启，避免长期泄漏累积
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
        // 上传体积上限（MB）：需与 Nginx client_max_body_size 一致
        TENDER_MAX_UPLOAD_MB: 200,
        // 提取并发上限：同时最多几个任务在跑（其余排队），按工作站性能与模型配额调整
        TENDER_MAX_CONCURRENCY: 2,
        // skill 目录：缺省取 ~/.workbuddy/skills/tender-material-checklist
        // 若已随仓库部署，请改为仓库内副本的绝对路径，例如：
        // TENDER_SKILL_DIR: 'F:/项目-实战/AI chat/smartchat-2.0/tender-material-checklist',
      },
      error_file: '../logs/server-error.log',
      out_file: '../logs/server-out.log',
      merge_logs: true,
      time: true,
    },
  ],
}
