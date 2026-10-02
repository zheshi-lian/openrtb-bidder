// cache.js —— 可降级 KV 缓存（Redis 可选）+ 轻量指标采集
// 设计目标：本地零依赖可跑；生产设 REDIS_URL 并 npm i ioredis 即自动切换为共享缓存。
// 所有方法均 async，调用方用 await；内存回退时也是同步返回（已包成 Promise）。
const mem = new Map(); // k -> { v, exp }

// === Redis 适配（可选）===
let client = null;
let errLogged = false;
if (process.env.REDIS_URL) {
  try {
    const Redis = require('ioredis');
    client = new Redis(process.env.REDIS_URL, {
      // 断线后持续重试（指数退避上限 5s），不再"一次出错就永久退化"
      retryStrategy: (times) => Math.min(times * 200, 5000),
      // 断线期间命令立即失败而非排队：避免 Redis 抖动时把竞价请求挂住（延迟尖刺）
      enableOfflineQueue: false,
      maxRetriesPerRequest: 2,
    });
    client.on('error', (e) => {
      // 注意：这里不能把 client 置 null——否则 Redis 抖动一次就永久退回内存、永不恢复
      if (!errLogged) { console.error('[cache] redis 暂时不可用，降级内存；客户端持续重连中:', e.message); errLogged = true; }
    });
    client.on('ready', () => { errLogged = false; console.log('[cache] Redis 已就绪，恢复共享缓存'); });
    console.log('[cache] Redis 客户端已创建:', process.env.REDIS_URL);
  } catch (e) {
    console.warn('[cache] 未安装 ioredis，使用内存缓存（npm i ioredis 后设 REDIS_URL 启用共享缓存）');
    client = null;
  }
}
function redisUp() { return !!client && client.status === 'ready'; }

function memGet(k) { const e = mem.get(k); if (!e) return null; if (e.exp && e.exp < Date.now()) { mem.delete(k); return null; } return e.v; }
function memSet(k, v, ttl) { mem.set(k, { v, exp: ttl ? Date.now() + ttl : 0 }); }

async function get(k) {
  if (client) { try { const v = await client.get(k); return v == null ? null : JSON.parse(v); } catch (e) {} }
  return memGet(k);
}
async function set(k, v, ttlMs) {
  if (client) { try { if (ttlMs) await client.set(k, JSON.stringify(v), 'PX', ttlMs); else await client.set(k, JSON.stringify(v)); return; } catch (e) {} }
  memSet(k, v, ttlMs);
}
async function del(k) {
  if (client) { try { await client.del(k); } catch (e) {} }
  mem.delete(k);
}

// === 指标采集（内存，重启可丢；生产可对接 Prometheus）===
const M = { counters: {}, hist: {} };
function incr(name, by = 1) { M.counters[name] = (M.counters[name] || 0) + by; }
function observe(name, ms) {
  const h = M.hist[name] = M.hist[name] || { n: 0, sum: 0, max: 0 };
  h.n++; h.sum += ms; h.max = Math.max(h.max, ms);
}
function snapshot() {
  const hist = {};
  for (const k in M.hist) { const h = M.hist[k]; hist[k] = { n: h.n, avg: h.n ? +(h.sum / h.n).toFixed(2) : 0, max: +(h.max).toFixed(2) }; }
  return { counters: M.counters, hist, backend: redisUp() ? 'redis' : 'memory' };
}

module.exports = { get, set, del, incr, observe, snapshot, redisReady: redisUp };
