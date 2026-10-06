#!/usr/bin/env node
// cluster.js —— 节点级负载均衡编排器（替代直接 `node server.js`）
//
// 职责：
//   ① 拉起 N 个 worker 进程（server.js MODE=worker，各自独立端口），充分利用多核；
//   ② 轻量反向代理 + 健康检查（/health），仅把流量转发到存活 worker，实现故障隔离；
//   ③ worker 崩溃自动重启（1s 后拉起），避免单点进程退出导致全站 503；
//   ④ 收到 SIGTERM/SIGINT 时先停 LB、再逐个 SIGTERM worker，优雅退出（配合 server.js 优雅关闭）。
//
// 说明：这是「单机多进程」层面的负载均衡（进程级 HA + 多核），并非跨物理机的多节点。
// 若要跨机器横向扩展，应在 Cloudflare 侧用 Load Balancing / 多个 tunnel 指向不同主机，
// 本文件无需改动（每个主机各自跑 cluster.js 即可）。
//
// 环境变量：WORKERS(默认=CPU核数,最多8)  WORKER_PORT(首个worker端口,默认8090)  PORT(对外LB端口,默认8080)

const http = require('http');
const { spawn } = require('child_process');
const os = require('os');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const WORKERS = Math.min(8, Math.max(1, parseInt(process.env.WORKERS || os.cpus().length)));
const BASE = parseInt(process.env.WORKER_PORT || 8090);
const LB_PORT = parseInt(process.env.PORT || 8080);
const procs = new Array(WORKERS);
const healthy = new Map();

// ── 密钥一致性引导（关键修复）──
// 历史缺陷：每个 worker 启动时各自 randomBytes 生成 RW_SECRET/ADMIN_TOKEN 并竞态写同一份
// .rtb_secret，导致不同 worker 持有不同密钥。这里在 master 进程里一次性读/写 .rtb_secret，并把
// 三值通过环境变量注入所有 worker（spawn 继承），保证全集群密钥完全一致且等于文件内容。
// 注意：ACCOUNT_SECRET 若已由 .env / start_stack 注入（如 act-media-demo-2026）则尊重之，
// 仅当确实缺失时才回退到 RW_SECRET，避免覆盖既有密码哈希所需的密钥。
function bootstrapSecrets() {
  const f = path.join(__dirname, '.rtb_secret');
  let map = {};
  try { if (fs.existsSync(f)) map = JSON.parse(fs.readFileSync(f, 'utf8') || '{}'); } catch (e) { map = {}; }
  let changed = false;
  for (const n of ['RW_SECRET', 'ADMIN_TOKEN']) {
    if (!map[n] || String(map[n]).length < 16) { map[n] = crypto.randomBytes(32).toString('hex'); changed = true; }
  }
  if (!process.env.RW_SECRET) process.env.RW_SECRET = map.RW_SECRET;
  if (!process.env.ADMIN_TOKEN) process.env.ADMIN_TOKEN = map.ADMIN_TOKEN;
  if (!process.env.ACCOUNT_SECRET) process.env.ACCOUNT_SECRET = map.RW_SECRET;
  if (changed) { try { fs.writeFileSync(f, JSON.stringify(map), { mode: 0o600 }); } catch (e) {} }
}
bootstrapSecrets();

function startWorker(i) {
  const port = BASE + i;
  const child = spawn(process.execPath, [__dirname + '/server.js'], {
    env: Object.assign({}, process.env, { MODE: 'worker', WORKER_PORT: String(port), WORKER_INDEX: String(i) }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => process.stdout.write(`[w${i}:${port}] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`[w${i}:${port}] ${d}`));
  child.on('exit', (code, sig) => {
    console.error(`[cluster] worker ${i} (port ${port}) exited code=${code} sig=${sig}; restart in 1s`);
    procs[i] = null;
    setTimeout(() => startWorker(i), 1000);
  });
  procs[i] = { child, port };
  console.error(`[cluster] started worker ${i} on :${port}`);
}
for (let i = 0; i < WORKERS; i++) startWorker(i);

// 健康检查：每 5s 探一次各 worker /health，结果用于 LB 路由
// 健康探测：需「连续失败 N 次」才把 worker 判为下线。
// 原因：高压下 /health 探针本身会排队超时，若单次失败就摘除，所有 worker 会被同时误判下线，
// LB 直接返回 503 'no healthy backend'，形成「越忙越全挂」的自毁雪崩。
const PROBE_FAIL_THRESHOLD = 3;
const failCount = new Map(); // port -> 连续失败次数
async function probe() {
  await Promise.all(procs.map(async (w) => {
    if (!w) return;
    let okNow = false;
    try {
      const r = await fetch(`http://127.0.0.1:${w.port}/health`, { signal: AbortSignal.timeout(3000) });
      okNow = !!r.ok;
    } catch (e) { okNow = false; }
    if (okNow) { failCount.set(w.port, 0); healthy.set(w.port, true); return; }
    const n = (failCount.get(w.port) || 0) + 1;
    failCount.set(w.port, n);
    if (n >= PROBE_FAIL_THRESHOLD) healthy.set(w.port, false);
  }));
}
setInterval(probe, 5000);
probe();

// 反向代理：轮询转发到健康 worker；保留原始 x-forwarded-for，使各 worker 的限流拿到真实客户端 IP
let rr = 0;
const proxy = http.createServer((req, res) => {
  // fail-open：只有「明确判定下线」的 worker 才排除；未探测到/探测抖动仍继续转发，避免全站 503
  const live = procs.filter((w) => w && healthy.get(w.port) !== false).map((w) => w.port);
  if (!live.length) {
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'no healthy backend' }));
    return;
  }
  const port = live[rr++ % live.length];
  const opt = { host: '127.0.0.1', port, path: req.url, method: req.method, headers: req.headers, timeout: 12000 };
  const px = http.request(opt, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
  px.on('error', () => { res.writeHead(502, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'bad gateway' })); });
  req.pipe(px);
});
// 不支持的升级请求（如 WebSocket）直接关闭，避免上游连接挂起
proxy.on('upgrade', (req, socket) => { try { socket.destroy(); } catch (e) {} });
proxy.listen(LB_PORT, () => console.error(`[cluster] LB listening on :${LB_PORT}, workers=${WORKERS} (ports ${BASE}..${BASE + WORKERS - 1})`));

// 优雅退出：先停 LB 新连接，再逐个通知 worker 退出，最后自身退出
let _down = false;
function shutdown(sig) {
  if (_down) return; _down = true;
  console.error(`[cluster] received ${sig}, shutting down`);
  try { proxy.close(); } catch (e) {}
  for (const w of procs) if (w && w.child) { try { w.child.kill('SIGTERM'); } catch (e) {} }
  setTimeout(() => process.exit(0), 1200).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
