// pacing.js —— 投放节奏控制：日预算平滑 + 时段(daypart) + 频次控制(freq cap) + 预算感知出价调节
//
// v1 只有"按当日流逝比例线性放预算"，问题：
//   ① 流量不是均匀的：凌晨 3 点和晚 8 点的请求量差 10 倍，线性 pace 会在高峰秒光、低谷空跑
//   ② 没有时段投放：广告主"只投工作日 9-18 点"这种最基本诉求无法表达
//   ③ 没有频控：同一用户一天看 50 次同一广告，钱烧光且体验崩坏（也是品牌广告主的验收项）
//   ④ 超节奏只能"不参竞"：要么全投要么不投，缺少"降低出价继续投"的软着陆
//
// v2 提供：
//   · 流量曲线加权 pace：按真实流量分布（24 小时权重）算"此刻应该花到多少"
//   · daypart：168 位掩码（7 天 × 24 小时），支持多段
//   · freq cap：按 device/user/campaign 维度，滑动窗口计数（Redis 优先，内存降级）
//   · bidAdjust：节奏偏慢 → 提价抢量；偏快 → 压价省钱（PID 式，避免震荡）

const cache = require('./cache');

let pool = null;
function attachPool(p) { pool = p; }

async function initTables() {
  if (!pool) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS campaign_delivery (
    campaign_id INT PRIMARY KEY,
    mode VARCHAR(16) DEFAULT 'SMOOTH',
    daypart TEXT,
    freq_cap TEXT,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  )`).catch(() => {});
}

// ───────── 流量曲线：默认按"移动端活跃度"经验分布，可用真实请求量在线更新 ─────────
// 单位：每小时相对权重（未归一化）。真实生产应每小时用上一周同小时请求量重算。
const DEFAULT_HOUR_W = [0.6, 0.4, 0.3, 0.25, 0.3, 0.5, 0.9, 1.4, 1.8, 2.1, 2.2, 2.2,
  2.1, 2.0, 2.1, 2.2, 2.3, 2.5, 2.9, 3.3, 3.6, 3.2, 2.0, 1.2];
let hourW = DEFAULT_HOUR_W.slice();
let hourWSum = hourW.reduce((a, b) => a + b, 0);

function setHourlyCurve(arr) {
  if (!Array.isArray(arr) || arr.length !== 24) return false;
  const s = arr.reduce((a, b) => a + Number(b) || 0, 0);
  if (s <= 0) return false;
  hourW = arr.map(x => Math.max(0.01, Number(x) || 0));
  hourWSum = hourW.reduce((a, b) => a + b, 0);
  return true;
}
// 截止到此刻"应该花掉的预算比例"（0..1）：按小时权重累加 + 小时内线性插值
function expectedFraction(date = new Date()) {
  const h = date.getHours();
  let acc = 0;
  for (let i = 0; i < h; i++) acc += hourW[i];
  acc += hourW[h] * (date.getMinutes() * 60 + date.getSeconds()) / 3600;
  return Math.min(1, acc / hourWSum);
}

// ───────── daypart：168 位掩码（bit = day*24 + hour，0=周日）─────────
function defaultMask() { return 'f'.repeat(42); } // 42 个 hex f = 168 位全 1
function parseMask(hex) {
  const s = String(hex || defaultMask());
  let bits = '';
  for (const ch of s) {
    const v = parseInt(ch, 16);
    if (Number.isNaN(v)) continue;
    bits += v.toString(2).padStart(4, '0');
  }
  return bits.length >= 168 ? bits.slice(0, 168) : defaultMask().split('').map(c => parseInt(c, 16).toString(2).padStart(4, '0')).join('');
}
function daypartNormalize(dp) {
  // 接受两种写法：{mask:"<hex>"} 或 {days:[1,2,3,4,5], hours:[9..18]}
  if (!dp) return defaultMask();
  if (typeof dp === 'string') return dp.length >= 42 ? dp : defaultMask();
  if (dp.mask) return String(dp.mask);
  const days = Array.isArray(dp.days) && dp.days.length ? dp.days.map(Number) : [0, 1, 2, 3, 4, 5, 6];
  const hours = Array.isArray(dp.hours) && dp.hours.length ? dp.hours.map(Number) : Array.from({ length: 24 }, (_, i) => i);
  const arr = new Array(168).fill(0);
  days.forEach(d => hours.forEach(h => { if (d >= 0 && d < 7 && h >= 0 && h < 24) arr[d * 24 + h] = 1; }));
  let hex = '';
  for (let i = 0; i < 168; i += 4) {
    const nibble = (arr[i] << 3) | (arr[i + 1] << 2) | (arr[i + 2] << 1) | arr[i + 3];
    hex += nibble.toString(16);
  }
  return hex;
}
function inDaypart(maskHex, date = new Date()) {
  const bits = parseMask(maskHex);
  return bits[date.getDay() * 24 + date.getHours()] === '1';
}

// ───────── 配置加载 ─────────
const cfgCache = new Map(); // cid -> {ts, cfg}
const CFG_TTL = 30 * 1000;
async function delivery(cid) {
  const now = Date.now();
  const c = cfgCache.get(cid);
  if (c && now - c.ts < CFG_TTL) return c.cfg;
  let cfg = { mode: 'SMOOTH', daypart: defaultMask(), freqCap: null };
  if (pool) {
    try {
      const [[r]] = await pool.query('SELECT mode,daypart,freq_cap FROM campaign_delivery WHERE campaign_id=?', [cid]);
      if (r) {
        cfg = {
          mode: r.mode || 'SMOOTH',
          daypart: daypartNormalize(safeJson(r.daypart)),
          freqCap: safeJson(r.freq_cap),
        };
      }
    } catch (e) {}
  }
  cfgCache.set(cid, { ts: now, cfg });
  return cfg;
}
function bust(cid) { cfgCache.delete(cid); }
async function save(cid, patch = {}) {
  const cur = await delivery(cid);
  const next = {
    mode: patch.mode || cur.mode,
    daypart: daypartNormalize(patch.daypart || cur.daypart),
    freqCap: patch.freqCap === undefined ? cur.freqCap : patch.freqCap,
  };
  if (!pool) return next;
  await pool.query(
    `INSERT INTO campaign_delivery (campaign_id,mode,daypart,freq_cap) VALUES (?,?,?,?)
     ON DUPLICATE KEY UPDATE mode=VALUES(mode), daypart=VALUES(daypart), freq_cap=VALUES(freq_cap)`,
    [cid, next.mode, next.daypart, next.freqCap ? JSON.stringify(next.freqCap) : null]);
  bust(cid);
  return next;
}
function safeJson(s) { try { return JSON.parse(s); } catch (e) { return null; } }

// ───────── 频次控制 ─────────
// scope: 'device' | 'user' | 'campaign'(全局) | 'creative'
// 计数用 Redis（跨实例共享）；Redis 不可用时内存降级（单实例内仍有效）
const freqMem = new Map();
async function freqHit(key, ttlMs) {
  const ckey = 'fc:' + key;
  const prev = Number(await cache.get(ckey).catch(() => null));
  if (prev != null && !Number.isNaN(prev)) {
    await cache.set(ckey, prev + 1, ttlMs).catch(() => {});
    return prev + 1;
  }
  const now = Date.now();
  const m = freqMem.get(ckey);
  const n = (m && m.exp > now ? m.n : 0) + 1;
  freqMem.set(ckey, { n, exp: now + ttlMs });
  if (freqMem.size > 200000) { // 内存兜底的硬上限，防 OOM
    for (const [k, v] of freqMem) if (v.exp <= now) freqMem.delete(k);
  }
  return n;
}
async function freqAllow(cid, cfg, ids = {}) {
  const fc = cfg && cfg.freqCap;
  if (!fc || !fc.count || !fc.windowSec) return { ok: true };
  const scope = fc.scope || 'device';
  const dim = scope === 'user' ? (ids.userId || ids.deviceId || '') :
    scope === 'creative' ? (ids.creativeId || '') :
      scope === 'campaign' ? '' : (ids.deviceId || ids.userId || '');
  const key = `${cid}:${scope}:${dim}`;
  const n = await freqHit(key, Number(fc.windowSec) * 1000);
  if (n > Number(fc.count)) return { ok: false, reason: 'FREQ_CAP', seen: n, cap: fc.count };
  return { ok: true, seen: n, cap: fc.count };
}

// ───────── 预算节奏 ─────────
// 返回 allowed / 允许消费上限 / 节奏偏差 / 建议出价系数
function paceEval(campaign, spentMicros, opts = {}) {
  const now = opts.now || new Date();
  const cap = Number(campaign.daily_cap_micros) || 0;
  const mode = (opts.mode || campaign.pacing_mode || 'SMOOTH').toUpperCase();
  if (cap <= 0) return { allowed: true, allowedMicros: Infinity, ratio: 0, bidAdjust: 1, reason: 'NO_CAP' };
  if (spentMicros >= cap) return { allowed: false, allowedMicros: cap, ratio: 1, bidAdjust: 0, reason: 'DAILY_CAP_REACHED' };
  if (mode === 'ASAP') return { allowed: true, allowedMicros: cap, ratio: spentMicros / cap, bidAdjust: 1, reason: 'ASAP' };

  const frac = expectedFraction(now);
  const expected = cap * frac;
  const tolerance = Number(opts.tolerance || 0.15);
  // 允许上限 = 期望 × (1+容差)，并保留至少 10% 给当天剩余时间（防止完全停投）
  const allowedMicros = Math.max(cap * 0.10, expected * (1 + tolerance));
  const allowed = spentMicros < allowedMicros;
  const ratio = expected > 0 ? spentMicros / expected : 0;

  // PID 式出价调节：偏离越大修正越强，带阻尼避免震荡
  let bidAdjust = 1;
  if (ratio > 1.15) bidAdjust = Math.max(0.5, 1 - (ratio - 1) * 0.8);
  else if (ratio < 0.85) bidAdjust = Math.min(1.4, 1 + (0.85 - ratio) * 0.8);
  return {
    allowed,
    allowedMicros: Math.round(allowedMicros),
    expectedMicros: Math.round(expected),
    ratio: +ratio.toFixed(3),
    bidAdjust: +bidAdjust.toFixed(3),
    reason: allowed ? '' : 'AHEAD_OF_PACE',
  };
}

// 竞价热路径一次性判定：时段 → 频控 → 预算节奏
async function gate(campaign, spentMicros, ids = {}, opts = {}) {
  const cfg = (opts && opts.delivery) || (await delivery(campaign.id));
  if (!inDaypart(cfg.daypart, opts.now || new Date())) return { ok: false, reason: 'OUT_OF_DAYPART', skip: true };
  const f = await freqAllow(campaign.id, cfg, ids);
  if (!f.ok) return { ok: false, reason: f.reason, skip: true, seen: f.seen };
  const p = paceEval(campaign, spentMicros, { mode: cfg.mode, ...opts });
  if (!p.allowed) return { ok: false, reason: p.reason, skip: true, pace: p };
  return { ok: true, pace: p, bidAdjust: p.bidAdjust };
}

module.exports = {
  attachPool, initTables, delivery, save, bust,
  inDaypart, daypartNormalize, parseMask, defaultMask,
  expectedFraction, setHourlyCurve, hourW: () => hourW.slice(),
  freqAllow, freqHit, paceEval, gate,
};
