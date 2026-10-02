// metrics.js —— 分位数延迟直方图 + 滑动窗口 QPS + SLO 判定
//
// cache.js 的 observe() 只存 {n,sum,max}，只能出 avg/max——而竞价热路径的 SLO 是
// "p99 < 10ms"：均值 3ms 但 p99 300ms 照样会被买方超时丢弃（他们通常 80~120ms 超时）。
// 没有分位数就无法：①判断是否达标 ②做自适应限流（延迟升高→主动降载）
//
// 实现：固定边界直方图（对数分级），内存开销恒定，支持线性插值分位数与多直方图合并。

const BUCKETS = [0.5, 1, 2, 3, 5, 8, 12, 20, 30, 50, 80, 120, 200, 300, 500, 800,
  1200, 2000, 3000, 5000, 8000, 12000, 20000, 30000, 60000];

class Histogram {
  constructor(buckets = BUCKETS) {
    this.buckets = buckets;
    this.counts = new Array(buckets.length + 1).fill(0); // 末位 = 上溢桶
    this.n = 0; this.sum = 0; this.max = 0;
  }
  observe(v) {
    const x = Number(v);
    if (!Number.isFinite(x) || x < 0) return;
    this.n++; this.sum += x; if (x > this.max) this.max = x;
    let i = 0;
    while (i < this.buckets.length && x > this.buckets[i]) i++;
    this.counts[i]++;
  }
  quantile(q) {
    if (!this.n) return 0;
    const target = Math.max(0, Math.min(1, q)) * this.n;
    let cum = 0, lo = 0;
    for (let i = 0; i < this.counts.length; i++) {
      const hi = i < this.buckets.length ? this.buckets[i] : this.max;
      const c = this.counts[i];
      if (cum + c >= target) {
        // 桶内线性插值：直方图不可避免有离散误差，插值比"取上界"更稳
        const frac = c ? (target - cum) / c : 0;
        return +(lo + (hi - lo) * frac).toFixed(3);
      }
      cum += c; lo = hi;
    }
    return +this.max.toFixed(3);
  }
  merge(o) {
    if (!o) return this;
    for (let i = 0; i < this.counts.length; i++) this.counts[i] += o.counts[i] || 0;
    this.n += o.n || 0; this.sum += o.sum || 0; this.max = Math.max(this.max, o.max || 0);
    return this;
  }
  snapshot() {
    return {
      n: this.n, avg: this.n ? +(this.sum / this.n).toFixed(3) : 0,
      p50: this.quantile(0.5), p90: this.quantile(0.9), p95: this.quantile(0.95),
      p99: this.quantile(0.99), p999: this.quantile(0.999), max: +this.max.toFixed(3),
    };
  }
}

// ───────── 滑动窗口速率（1s 粒度，保留 120s）─────────
const WIN_SLOTS = 120;
class RateMeter {
  constructor() { this.slots = new Map(); }
  hit(n = 1) {
    const s = Math.floor(Date.now() / 1000);
    this.slots.set(s, (this.slots.get(s) || 0) + n);
    if (this.slots.size > WIN_SLOTS + 5) {
      const cut = s - WIN_SLOTS;
      for (const k of this.slots.keys()) if (k < cut) this.slots.delete(k);
    }
  }
  qps(windowSec = 10) {
    const s = Math.floor(Date.now() / 1000);
    let total = 0;
    for (let i = 0; i < windowSec; i++) total += this.slots.get(s - i) || 0;
    return +(total / Math.max(1, windowSec)).toFixed(2);
  }
  total(windowSec = 60) {
    const s = Math.floor(Date.now() / 1000);
    let total = 0;
    for (let i = 0; i < windowSec; i++) total += this.slots.get(s - i) || 0;
    return total;
  }
}

const hists = new Map();
const counters = new Map();
const rates = new Map();
const gauges = new Map();

function hist(name) { let h = hists.get(name); if (!h) { h = new Histogram(); hists.set(name, h); } return h; }
function incr(name, by = 1) { counters.set(name, (counters.get(name) || 0) + by); rate(name).hit(by); }
function observe(name, ms) { hist(name).observe(ms); }
function rate(name) { let r = rates.get(name); if (!r) { r = new RateMeter(); rates.set(name, r); } return r; }
function gauge(name, v) { gauges.set(name, v); }
function qps(name) { return rate(name).qps(10); }

function snapshot() {
  const h = {};
  for (const [k, v] of hists) if (v.n) h[k] = v.snapshot();
  const c = {};
  for (const [k, v] of counters) c[k] = v;
  const q = {};
  for (const [k, v] of rates) { const x = v.qps(10); if (x > 0) q[k + '_qps'] = x; }
  const g = {};
  for (const [k, v] of gauges) g[k] = v;
  return { counters: c, hist: h, qps: q, gauges: g, ts: Date.now() };
}

// SLO：把"p99<10ms"变成可断言的检查项，供告警与自适应限流使用
function slo(name, targetMs, q = 0.99) {
  const h = hists.get(name);
  if (!h || !h.n) return { ok: true, name, targetMs, p: 0, n: 0, reason: 'NO_DATA' };
  const p = h.quantile(q);
  return { ok: p <= targetMs, name, targetMs, p, n: h.n, reason: p <= targetMs ? '' : 'SLO_BREACH' };
}

function reset() { hists.clear(); counters.clear(); rates.clear(); gauges.clear(); }

module.exports = { Histogram, RateMeter, BUCKETS, hist, incr, observe, rate, gauge, qps, snapshot, slo, reset };
