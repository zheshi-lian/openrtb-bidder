// PM2 守护配置：进程崩溃自动拉起、多实例、日志落盘
// 用法：
//   npm i -g pm2
//   pm2 start deploy/ecosystem.config.js      （会自动读取上级目录 .env 中的变量）
//   pm2 save && pm2 startup                    （开机自启）

// 注意：本仓库未安装 dotenv，且 server.js 不需要它 —— .env 已由 ./llm.js 内置的
// 极简解析器在启动时加载（并覆盖同名 OS 环境变量）。因此这里不再 require('dotenv')。
const path = require('path');

module.exports = {
  apps: [
    {
      name: 'adx-server',
      script: path.join(__dirname, '..', 'server.js'),
      cwd: path.join(__dirname, '..'),
      instances: process.env.PM2_INSTANCES || 2,   // 多实例；启用 Redis 后才可水平扩展
      exec_mode: 'cluster',
      max_memory_restart: '600M',
      restart_delay: 1000,
      env: {
        NODE_ENV: 'production',
        PORT: 8080,
        // 生产必须显式设置：ADMIN_TOKEN / RW_SECRET / DB_PASSWORD / REDIS_URL
        // 缺失时 security.js 会直接拒绝启动。
      },
      error_file: path.join(__dirname, '..', 'logs', 'adx-error.log'),
      out_file: path.join(__dirname, '..', 'logs', 'adx-out.log'),
      merge_logs: true,
    },
    {
      name: 'media-server',
      script: path.join(__dirname, '..', 'sdk', 'media-server', 'appServer.js'),
      cwd: path.join(__dirname, '..'),
      instances: 1,
      restart_delay: 1000,
      env: { NODE_ENV: 'production', PORT: 8081 },
      error_file: path.join(__dirname, '..', 'logs', 'media-error.log'),
      out_file: path.join(__dirname, '..', 'logs', 'media-out.log'),
      merge_logs: true,
    },
  ],
};
