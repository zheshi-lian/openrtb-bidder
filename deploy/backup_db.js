// 数据库备份：优先用 mysqldump（事务一致），找不到则降级为 CSV 逻辑导出
// 用法：
//   node deploy/backup_db.js                 # 备份到 backups/YYYYMMDD-HHmm/
//   $env:MYSQLDUMP="C:\Program Files\MySQL\MySQL Server 8.0\bin\mysqldump.exe"; node deploy/backup_db.js
//
// 建议 crontab/任务计划每天执行一次，并保留 7 天。

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
require('../llm'); // 副作用：加载 .env 到 process.env（本仓库未装 dotenv，靠 llm.js 内置解析器）

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'backups', new Date().toISOString().replace(/[-:T]/g, '').slice(0, 13));
const CONF = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'test',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'zhuque',
};
fs.mkdirSync(OUT, { recursive: true });

function findMysqldump() {
  if (process.env.MYSQLDUMP && fs.existsSync(process.env.MYSQLDUMP)) return process.env.MYSQLDUMP;
  // 动态探测：不硬编码版本号（本机实际为 MySQL Server 26.7，写死 8.0/8.4 会漏）——这一版修的就是这个 bug
  const roots = ['C:\\Program Files\\MySQL', 'C:\\Program Files (x86)\\MySQL', 'C:\\MySQL', 'C:\\ProgramData\\MySQL'];
  const found = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    try {
      for (const d of fs.readdirSync(root)) {
        const p = `${root}\\${d}\\bin\\mysqldump.exe`;
        if (fs.existsSync(p)) found.push(p);
      }
    } catch (e) {}
  }
  if (found.length) { found.sort(); return found[found.length - 1]; } // 取版本号最高的
  // 最后尝试 PATH
  const w = spawnSync('where', ['mysqldump.exe'], { encoding: 'utf8' });
  const first = String(w.stdout || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean)[0];
  return first && fs.existsSync(first) ? first : null;
}

const dump = findMysqldump();
if (dump) {
  const file = path.join(OUT, `${CONF.database}.sql`);
  // --skip-lock-tables / --no-tablespaces：在无 RELOAD、无 PROCESS 权限的最小权限账号下也能导出
  // 口令走 MYSQL_PWD 环境变量而非命令行，避免出现在进程列表里
  const common = ['-h', CONF.host, '-P', String(CONF.port), '-u', CONF.user,
    '--skip-lock-tables', '--no-tablespaces', '--quick', '--routines', '--default-character-set=utf8mb4', CONF.database];
  const run = (args) => spawnSync(dump, args, { stdio: ['ignore', 'pipe', 'pipe'], env: Object.assign({}, process.env, { MYSQL_PWD: CONF.password }) });
  // 一级：事务一致快照（需要 RELOAD/FLUSH_TABLES 权限）
  let r = run(['--single-transaction'].concat(common));
  let mode = '事务一致InnoDB快照';
  if (r.status !== 0 && /1227|FLUSH\s/i.test(String(r.stderr))) {
    // 二级：无 FLUSH/LOCK 的导出（备份账号权限不足时的可行解；不再是强一致快照）
    console.warn('[WARN] 备份账号缺 FLUSH_TABLES/RELOAD 权限，降级为无锁导出（仍为 SQL 全量，但非事务一致快照）');
    console.warn('      生产建议：GRANT RELOAD, PROCESS ON *.* TO 备份专用账号，以获得事务一致备份');
    r = run(common);
    mode = '无锁导出(非强一致)';
  }
  fs.writeFileSync(file, r.stdout || Buffer.from(''));
  if (r.status !== 0) { console.error('mysqldump 失败：', String(r.stderr).slice(0, 400)); process.exit(1); }
  console.log(`备份完成(mysqldump, ${mode}):`, file, (fs.statSync(file).size / 1024).toFixed(1) + 'KB');
} else {
  // 降级：逐表 CSV 导出（非事务一致，仅适合小数据量或临时兜底）
  const mysql = require('mysql2/promise');
  console.warn('[WARN] 未找到 mysqldump，降级为 CSV 逻辑导出（非事务一致快照）');
  (async () => {
    const c = await mysql.createConnection(CONF);
    const [ts] = await c.query('SHOW TABLES');
    const key = Object.keys(ts[0])[0];
    let total = 0;
    for (const row of ts) {
      const t = row[key];
      const [rows] = await c.query(`SELECT * FROM \`${t}\``);
      if (!rows.length) continue;
      const cols = Object.keys(rows[0]);
      const csv = [cols.join(',')].concat(rows.map(r => cols.map(k => {
        const v = r[k] == null ? '' : String(typeof r[k] === 'object' ? JSON.stringify(r[k]) : r[k]);
        return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
      }).join(','))).join('\n');
      fs.writeFileSync(path.join(OUT, `${t}.csv`), csv);
      total += rows.length;
    }
    await c.end();
    console.log('备份完成(CSV 降级):', OUT, `共 ${ts.length} 表 / ${total} 行`);
  })().catch(e => { console.error('备份失败:', e.message); process.exit(1); });
}
