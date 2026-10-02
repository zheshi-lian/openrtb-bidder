// bid/throttle.js —— 请求节流 / 负载卸载 / 竞价总 deadline
//
// 高 QPS 下最怕的不是平均慢，而是"雪崩"：外部 DSP 慢 → 连接池耗尽 → 全站 502。
// 三道防线：
//   ① 令牌桶：硬 QPS 上限，超出即丢弃（返回空 seatbid 或直接 503 让上游快速失败）
//   ② 自适应降载：p99 超阈值时 AIMD 收紧桶容量（延迟是容量不足最早的信号）
//   ③ 优先级：自有 DSP / 高价值媒体优先；低价值流量先被采样掉
// 另外提供 deadlineAll()：多 partner 并行时给"总预算"，到点返回已到达的结果，
// 而不是等最慢的那个（v1 的 Promise.all 等最慢者 = p99 被最慢 partner 决定）。

const metrics = require('../metrics');

const QPS_LIMIT = Number(process.env.BID_QPS_LIMIT || 0);      // 0 = 不限
const P99_TARGET = Number(process.env.BID_P99_TARGET_MS || 10);
const LATENCY_NAME = process.env.BID_LATENCY_METRIC || 'bid_latency';

class TokenBucket {
  constructor(ratePerSec, burst) {
    this.rate = ratePerSec;
    this.capacity = burst || Math.max(1, Math.ceil(ratePerSec));
    this.tokens = this.capacity;
    this.last = Date.now();
  }
  take(n = 1) {
    const now = Date.now();
    this.tokens = Math.min(this.capacity, this.tokens + (now - this.last) / 1000 * this.rate);
    this.last = now;
    if (this.tokens >= n) { this.tokens -= n; return true; }
    return false;
  }
}

const buckets = new Map();
function bucket(key, ratePerSec, burst) {
  let b = buckets.get(key);
  if (!b) { b = new TokenBucket(ratePerSec, burst); buckets.set(key, b); }
  return b;
}

// 自适应：p99 超阈值 → 乘性减小；持续达标 → 加性增大（AIMD，TCP 同款思想）
let factor = 1;
let lastTune = 0;
function tune() {
  const now = Date.now();
  if (now - lastTune < 2000) return factor;   // 每 2s 调整一次，避免抖动
  lastTune = now;
  const s = metrics.slo(LATENCY_NAME, P99_TARGET, 0.99);
  if (s.n < 50) return factor;                // 样本不足不动
  if (!s.ok) factor = Math.max(0.2, factor * 0.85);
  else factor = Math.min(1, factor + 0.03);
  metrics.gauge('throttle_factor', +factor.toFixed(3));
  return factor;
}

function effectiveQps() {
  if (!QPS_LIMIT) return 0;
  return Math.max(1, Math.floor(QPS_LIMIT * tune()));
}

/**
 * 是否处理该请求
 * @param {object} o {key, priority:'high'|'normal'|'low', cost}
 * 优先级：high 永远放行（自有需求/大客户）；low 在降载时最先被丢
 */
function shouldProcess(o = {}) {
  const limit = effectiveQps();
  if (!limit) return { ok: true, reason: 'NO_LIMIT' };
  const pr = o.priority || 'normal';
  const key = o.key || 'global';
  const b = bucket(key, limit, Math.ceil(limit / 2));
  if (b.take(Number(o.cost) || 1)) return { ok: true, reason: 'IN_BUDGET', qps: limit };
  if (pr === 'high') return { ok: true, reason: 'PRIORITY_OVERRIDE', qps: limit };
  metrics.incr('throttle_dropped');
  return { ok: false, reason: 'THROTTLED', qps: limit, retryAfterMs: Math.ceil(1000 / limit) };
}

// 采样率：用于日志/特征落库等旁路写入，避免把主库写爆
function sampleRate(name = 'default', base = 1) {
  const f = tune();
  return Math.max(0.001, Math.min(1, base * f));
}

/**
 * 带总 deadline 的并发：到点即返回已到达结果
 * @param {Array<Promise>} promises
 * @param {number} ms
 * @returns {Promise<Array>} 未完成的为 undefined（调用方需容错）
 */
function deadlineAll(promises, ms = 100) {
  if (!promises.length) return Promise.resolve([]);
  let settled = false;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      metrics.incr('deadline_timeout');
      resolve(results.slice());
    }, ms);
    const results = new Array(promises.length).fill(undefined);
    let done = 0;
    promises.forEach((p, i) => {
      Promise.resolve(p).then(v => { results[i] = v; }, () => { results[i] = undefined; })
        .then(() => {
          done++;
          if (done === promises.length && !settled) { settled = true; clearTimeout(timer); resolve(results); }
        });
    });
  });
}

function snapshot() {
  return { qps_limit: QPS_LIMIT, effective_qps: effectiveQps(), factor: +tune().toFixed(3), p99_target_ms: P99_TARGET, keys: [...buckets.keys()] };
}

module.exports = { shouldProcess, deadlineAll, sampleRate, snapshot, TokenBucket, tune, effectiveQps, metrics };
