// bid/winrate.js —— 胜率模型：清盘价分布 → P(win at bid)
//
// 为什么需要：一价（first-price）拍卖下出多少付多少。不做 shading 就等于按真实估值全额报价，
// margin 全让给交易所；而 shading 要算"降多少还能赢"，本质是 P(清盘价 < 我的出价)。
//
// 数据优势：SSP 侧每次拍卖都知道真实清盘价（二价下=次高价+ε），可直接拟合市场清盘价分布；
// 作为买方接入外部交易所时只有 win/lose 删失样本，用 logistic 回归兜底。

const BIN_MICROS = 500000;   // 0.5 元一档
const MAX_BINS = 240;        // 覆盖 0 ~ 120 元 CPM
const EMA_ALPHA = 0.05;      // 分布随时间漂移，用 EMA 追新

let pool = null;
function attachPool(p) { pool = p; }

class ClearingDist {
  constructor() { this.bins = new Array(MAX_BINS).fill(0); this.n = 0; }
  binOf(micros) {
    const i = Math.floor(Math.max(0, micros) / BIN_MICROS);
    return i >= MAX_BINS ? MAX_BINS - 1 : i;
  }
  observe(micros) {
    if (!Number.isFinite(micros) || micros <= 0) return;
    this.bins[this.binOf(micros)] += 1; this.n++;
  }
  decay() { for (let i = 0; i < this.bins.length; i++) this.bins[i] *= (1 - EMA_ALPHA); }
  // P(清盘价 < bid)：同档按 0.5 权重（tie-break 保守估计）
  cdf(micros) {
    if (!this.n) return null;
    const i = this.binOf(micros);
    let cum = 0;
    for (let k = 0; k < i; k++) cum += this.bins[k];
    cum += this.bins[i] * 0.5;
    return Math.max(0, Math.min(1, cum / this.n));
  }
  quantile(q) {
    if (!this.n) return null;
    const target = q * this.n; let cum = 0;
    for (let i = 0; i < this.bins.length; i++) { cum += this.bins[i]; if (cum >= target) return Math.round((i + 0.5) * BIN_MICROS); }
    return MAX_BINS * BIN_MICROS;
  }
  toJSON() { return { bins: this.bins.map(x => +x.toFixed(3)), n: this.n }; }
  static from(o) {
    const d = new ClearingDist();
    if (o && Array.isArray(o.bins)) {
      for (let i = 0; i < MAX_BINS; i++) d.bins[i] = Number(o.bins[i]) || 0;
      d.n = Number(o.n) || 0;
    }
    return d;
  }
}

const dists = new Map();    // key -> ClearingDist
const outcomes = new Map(); // key -> {wins,total}（仅 win/lose 可观测时兜底）

function keyOf(ctx = {}) {
  return `${(ctx.publisher || '').toLowerCase()}|${(ctx.format || 'banner').toLowerCase()}|${(ctx.country || '').toUpperCase()}`;
}
function dist(key) {
  let d = dists.get(key);
  if (!d) { d = new ClearingDist(); dists.set(key, d); }
  return d;
}
function observeClearing(ctx, clearingMicros) {
  const d = dist(keyOf(ctx));
  if (d.n > 4000) d.decay();
  d.observe(clearingMicros);
}
function observeOutcome(ctx, won) {
  const k = keyOf(ctx);
  const o = outcomes.get(k) || { wins: 0, total: 0 };
  o.total++; if (won) o.wins++;
  outcomes.set(k, o);
}

// 主接口：给定出价，估计胜率。优先清盘价分布；样本不足时用 win/lose 频率；再不足用先验
function pWin(ctx, bidMicros) {
  const d = dists.get(keyOf(ctx));
  if (d && d.n >= 30) return { p: d.cdf(bidMicros), source: 'clearing_dist', n: d.n };
  const o = outcomes.get(keyOf(ctx));
  if (o && o.total >= 50) {
    // 删失样本的频率只能给"平均胜率"，用 logit 线性外推到具体出价（单调、可解释）
    const base = o.wins / o.total;
    const d2 = dists.get(keyOf(ctx));
    const med = d2 && d2.n >= 10 ? d2.quantile(0.5) : null;
    if (med) {
      const z = Math.log(Math.max(0.01, bidMicros / med));
      const p = 1 / (1 + Math.exp(-(Math.log(base / (1 - base)) + 1.2 * z)));
      return { p: Math.max(0, Math.min(1, p)), source: 'logit_mix', n: o.total };
    }
    return { p: base, source: 'freq', n: o.total };
  }
  // 冷启动先验：出价相对市场价越高越可能赢（用 sigmoid 表达，避免 0/1 硬跳变）
  const ref = Number(process.env.MARKET_REF_CPM_MICROS || 5000000);
  return { p: 1 / (1 + Math.exp(-2.2 * (bidMicros / ref - 1))), source: 'prior', n: 0 };
}

function medianClearing(ctx) {
  const d = dists.get(keyOf(ctx));
  return d && d.n >= 10 ? d.quantile(0.5) : null;
}

async function initTables() {
  if (!pool) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS bid_clearing_price (
    bucket_key VARCHAR(160) PRIMARY KEY, bins_json TEXT, n INT DEFAULT 0,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP)`).catch(() => {});
}
async function load() {
  if (!pool) return;
  try {
    const [rows] = await pool.query('SELECT bucket_key, bins_json FROM bid_clearing_price');
    let n = 0;
    for (const r of rows) {
      try { dists.set(r.bucket_key, ClearingDist.from(JSON.parse(r.bins_json))); n++; } catch (e) {}
    }
    if (n) console.log(`[winrate] 已加载 ${n} 个清盘价分布`);
  } catch (e) {}
}
async function flush() {
  if (!pool) return;
  for (const [k, d] of dists) {
    if (!d.n) continue;
    await pool.query(`INSERT INTO bid_clearing_price (bucket_key,bins_json,n) VALUES (?,?,?)
      ON DUPLICATE KEY UPDATE bins_json=VALUES(bins_json), n=VALUES(n)`,
      [k, JSON.stringify(d.toJSON()), d.n]).catch(() => {});
  }
}
function snapshot() {
  const out = {};
  for (const [k, d] of dists) {
    if (!d.n) continue;
    out[k] = { n: d.n, p50: d.quantile(0.5), p75: d.quantile(0.75), p90: d.quantile(0.9) };
  }
  return out;
}

module.exports = {
  ClearingDist, attachPool, initTables, load, flush,
  observeClearing, observeOutcome, pWin, medianClearing, keyOf, snapshot,
  _dists: dists, BIN_MICROS,
};
