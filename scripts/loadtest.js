#!/usr/bin/env node
// ADX 竞价接口压测（零依赖，仅用 Node 内置 http）。用来"证明容量"。
// 用法:
//   node scripts/loadtest.js -u http://127.0.0.1:8080/ssp/bid -n 2000 -c 50
//   node scripts/loadtest.js -d 30000            # 持续 30s
// 参数: -u URL(默认 :8080/ssp/bid)  -n 总请求数(默认 1000)  -c 并发(默认 20)  -d 持续毫秒
const http = require('http');
const { URL } = require('url');

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const url = new URL(arg('-u', 'http://127.0.0.1:8080/ssp/bid'));
const total = parseInt(arg('-n', '1000'), 10);
const conc = Math.max(1, parseInt(arg('-c', '20'), 10));
const durMs = arg('-d', '') ? parseInt(arg('-d', ''), 10) : 0;

function bidBody(i) {
  return JSON.stringify({
    id: 'lt' + i, site: { domain: 'dellai.xyz', name: 't', keywords: 'game' },
    device: { ip: '127.0.0.1', geo: { country: 'CN' } },
    imp: [{ id: 'lt' + i + 'a', banner: { w: 300, h: 250 }, bidfloor: 0.1,
      ext: { cat: 'puzzle', ad_unit_id: 'au_loadtest' } }]
  });
}
function pct(arr, p) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor(s.length * p))] * 100) / 100;
}
function fire() {
  return new Promise((resolve) => {
    const t = Date.now();
    const req = http.request({
      method: 'POST', host: url.hostname, port: url.port, path: url.pathname,
      headers: { 'content-type': 'application/json' }, timeout: 5000
    }, (res) => {
      res.on('data', () => {}); res.on('end', () => resolve({ ms: Date.now() - t, ok: res.statusCode < 500 }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ ms: Date.now() - t, ok: false, to: true }); });
    req.on('error', () => resolve({ ms: Date.now() - t, ok: false, err: true }));
    req.write(bidBody(Math.floor(Math.random() * 1e9)));
    req.end();
  });
}
(async () => {
  const lat = [], errors = [];
  const start = Date.now();
  let sent = 0, inflight = 0, stopped = false;
  const limit = durMs ? Infinity : total;
  async function worker() {
    while (!stopped && sent < limit && (durMs ? Date.now() - start < durMs : true)) {
      sent++;
      const r = await fire();
      lat.push(r.ms); if (!r.ok) errors.push(r);
    }
  }
  const workers = [];
  for (let i = 0; i < conc; i++) workers.push(worker());
  await Promise.all(workers);
  stopped = true;
  const secs = (Date.now() - start) / 1000;
  console.log(`=== loadtest ${url.href} ===`);
  console.log(`sent=${sent} duration=${secs.toFixed(2)}s QPS=${(sent / secs).toFixed(1)}`);
  console.log(`latency ms: p50=${pct(lat,0.5)} p95=${pct(lat,0.95)} p99=${pct(lat,0.99)} max=${Math.max(...lat)}`);
  console.log(`errors=${errors.length} (timeout=${errors.filter(e=>e.to).length} other=${errors.filter(e=>e.err).length})`);
})();
