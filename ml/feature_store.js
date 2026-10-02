// ml/feature_store.js —— 特征平台（离线/在线一致性 + 版本化 + 点时间正确性 + 漂移监控）
//
// v1 的问题：特征在 bid_model.js:24 现场手算、只有 8 维、且离线（ml-pipeline）与在线各自实现一套。
// 这类"训练/serving 特征不一致"（training-serving skew）是线上模型效果崩塌的头号原因：
// 离线 AUC 0.78 上线变 0.62，往往不是模型不行，而是某个特征两边算法不同。
//
// 本模块把特征定义收敛为唯一真源：
//   · 注册表即为特征定义（名字/类型/变换函数/版本），在线与离线共用 compute()
//   · 每次在线打分可落库特征向量（ml_feature_log），离线训练直接读它 → 天然无 skew
//   · 特征版本化：改特征必须升 FEATURE_VERSION，旧模型拒绝加载（防止静默降级）
//   · PSI 监控：线上特征分布 vs 训练期分布漂移超阈值即告警

const crypto = require('crypto');

const FEATURE_VERSION = 'v3';
const HASH_BUCKETS = 64;

let pool = null;
function attachPool(p) { pool = p; }
async function initTables() {
  if (!pool) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS ml_feature_log (
    id BIGINT AUTO_INCREMENT PRIMARY KEY, entity_type VARCHAR(24), entity_id VARCHAR(64),
    imp_id VARCHAR(64) DEFAULT '', feature_version VARCHAR(16), features JSON,
    label_click TINYINT NULL, label_conv TINYINT NULL, label_value_micros BIGINT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, INDEX idx_imp (imp_id), INDEX idx_ts (created_at)
  )`).catch(() => {});
  await pool.query(`CREATE TABLE IF NOT EXISTS ml_feature_ref (
    feature_version VARCHAR(16) PRIMARY KEY, stats TEXT, samples INT DEFAULT 0,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP)`).catch(() => {});
}

// ───────── 基础变换 ─────────
function h(str, buckets = HASH_BUCKETS) {
  const d = crypto.createHash('md5').update(String(str == null ? '' : str)).digest();
  return d.readUInt32BE(0) % buckets;
}
function clamp01(x) { return Math.max(0, Math.min(1, Number(x) || 0)); }
// 平滑率：小样本时向先验收缩（贝叶斯平滑），避免 1/2 曝光算出 50% CTR 这种噪声特征
function smoothRate(succ, total, prior = 0.02, k = 100) {
  return (Number(succ || 0) + prior * k) / (Number(total || 0) + k);
}
const TIER1 = new Set(['US', 'GB', 'CA', 'AU', 'DE', 'FR', 'JP', 'KR', 'SG']);
const TIER2 = new Set(['CN', 'BR', 'IN', 'RU', 'MX', 'ID', 'TH', 'VN', 'TR', 'IT', 'ES']);

// ───────── 特征注册表：唯一真源 ─────────
// 每项：{name, dim, fn(ctx)}
// ctx 约定：{ campaign, creative, publisher, device, geo, format, floorMicros, hour, relScore, stats }
const FEATURES = [
  { name: 'bias', dim: 1, fn: () => 1 },
  { name: 'cat_equal', dim: 1, fn: c => (c.cat && c.ctxCat && c.cat === c.ctxCat) ? 1 : 0 },
  { name: 'cat_absent', dim: 1, fn: c => (!c.cat || c.cat === 'all') ? 1 : 0 },
  { name: 'cat_mismatch', dim: 1, fn: c => (c.cat && c.ctxCat && c.cat !== c.ctxCat) ? 1 : 0 },
  { name: 'rel_score', dim: 1, fn: c => clamp01(c.relScore) },
  { name: 'kw_overlap', dim: 1, fn: c => clamp01(c.kwOverlap) },
  { name: 'hour_sin', dim: 1, fn: c => Math.sin((c.hour / 24) * 2 * Math.PI) },
  { name: 'hour_cos', dim: 1, fn: c => Math.cos((c.hour / 24) * 2 * Math.PI) },
  { name: 'dow_sin', dim: 1, fn: c => Math.sin((c.dow / 7) * 2 * Math.PI) },
  { name: 'is_weekend', dim: 1, fn: c => (c.dow === 0 || c.dow === 6) ? 1 : 0 },
  { name: 'is_video', dim: 1, fn: c => ['rewarded', 'interstitial', 'splash'].includes(String(c.format || '')) ? 1 : 0 },
  { name: 'is_native', dim: 1, fn: c => String(c.format || '') === 'native' ? 1 : 0 },
  { name: 'device_mobile', dim: 1, fn: c => Number(c.deviceType) === 1 ? 1 : 0 },
  { name: 'geo_tier', dim: 1, fn: c => (TIER1.has(c.geo) ? 1 : TIER2.has(c.geo) ? 0.5 : 0) },
  // 价格类特征：出价与市场的关系决定胜率，是 shading 与出价模型的关键输入
  { name: 'floor_norm', dim: 1, fn: c => clamp01(Number(c.floorMicros || 0) / Math.max(1, Number(c.targetCpm || 5000000))) },
  { name: 'bid_to_market', dim: 1, fn: c => clamp01(Number(c.bidMicros || 0) / Math.max(1, Number(c.marketMedianMicros || 5000000)) / 2) },
  // 历史表现（平滑）：让模型知道"这个 campaign / 素材历史上行不行"
  { name: 'campaign_ctr', dim: 1, fn: c => smoothRate(c.stats && c.stats.cClicks, c.stats && c.stats.cImps, 0.01, 200) },
  { name: 'campaign_cvr', dim: 1, fn: c => smoothRate(c.stats && c.stats.cConv, c.stats && c.stats.cClicks, 0.05, 100) },
  { name: 'creative_ctr', dim: 1, fn: c => smoothRate(c.stats && c.stats.crClicks, c.stats && c.stats.crImps, 0.01, 200) },
  { name: 'publisher_cvr', dim: 1, fn: c => smoothRate(c.stats && c.stats.pConv, c.stats && c.stats.pImps, 0.02, 300) },
  { name: 'campaign_age_log', dim: 1, fn: c => Math.log1p(Number(c.stats && c.stats.ageDays || 0)) },
  // 频次：第 N 次曝光给同一用户的边际效果递减（也是频控的模型侧表达）
  { name: 'freq_norm', dim: 1, fn: c => clamp01(Number(c.freq || 0) / 10) },
  // 隐私：无个性化同意时只能用上下文，模型需要知道这条样本"信息量更低"
  { name: 'no_personalization', dim: 1, fn: c => c.noPersonalization ? 1 : 0 },
  // 类目哈希（hashing trick）：避免维护巨大 one-hot 词表
  { name: 'cat_hash', dim: 1, fn: c => h(c.cat || 'unknown', 32) / 32 },
  { name: 'pub_hash', dim: 1, fn: c => h(c.publisher || 'unknown', 64) / 64 },
  { name: 'creative_hash', dim: 1, fn: c => h(c.creativeId || '0', 32) / 32 },
];

const DIM = FEATURES.reduce((s, f) => s + f.dim, 0);
const NAMES = FEATURES.reduce((a, f) => a.concat(f.dim > 1 ? Array.from({ length: f.dim }, (_, i) => f.name + i) : [f.name]), []);

function normalize(ctx = {}) {
  const now = ctx.now ? new Date(ctx.now) : new Date();
  return {
    cat: String((ctx.campaign && ctx.campaign.app_category) || ctx.cat || '').toLowerCase(),
    ctxCat: String((ctx.app_category || ctx.ctxCat || '')).toLowerCase(),
    relScore: ctx.relScore != null ? ctx.relScore : 0,
    kwOverlap: ctx.kwOverlap != null ? ctx.kwOverlap : 0,
    hour: ctx.hour != null ? ctx.hour : now.getHours(),
    dow: ctx.dow != null ? ctx.dow : now.getDay(),
    format: ctx.format || 'banner',
    deviceType: ctx.deviceType != null ? ctx.deviceType : (/Mobi|Android|iPhone/i.test(String(ctx.ua || '')) ? 1 : 2),
    geo: String(ctx.geo || ctx.country || '').toUpperCase(),
    floorMicros: ctx.floorMicros || 0,
    targetCpm: ctx.targetCpm || (ctx.campaign && ctx.campaign.target_cpm_micros) || 5000000,
    bidMicros: ctx.bidMicros || 0,
    marketMedianMicros: ctx.marketMedianMicros || 0,
    stats: ctx.stats || {},
    freq: ctx.freq || 0,
    noPersonalization: !!ctx.noPersonalization,
    publisher: ctx.publisher || '',
    creativeId: ctx.creativeId || '0',
  };
}
// 在线打分与离线训练共用的唯一实现
function compute(ctx) {
  const c = normalize(ctx);
  const x = new Array(DIM);
  let i = 0;
  for (const f of FEATURES) { const v = f.fn(c); x[i++] = Number.isFinite(v) ? v : 0; }
  return x;
}

// ───────── 特征落库（供离线训练，天然保证一致性）─────────
async function log(entityType, entityId, ctx, impId = '') {
  if (!pool) return;
  const x = compute(ctx);
  await pool.query(
    `INSERT INTO ml_feature_log (entity_type,entity_id,imp_id,feature_version,features) VALUES (?,?,?,?,?)`,
    [entityType, String(entityId), String(impId), FEATURE_VERSION, JSON.stringify(x)]).catch(() => {});
  return x;
}
// 标签回流：点时间正确——标签只能来自"该曝光之后"的行为
async function attachLabel(impId, { click, conv, valueMicros }) {
  if (!pool || !impId) return;
  await pool.query(
    `UPDATE ml_feature_log SET label_click=?, label_conv=?, label_value_micros=? WHERE imp_id=?`,
    [click == null ? null : (click ? 1 : 0), conv == null ? null : (conv ? 1 : 0), conv ? (valueMicros || 0) : 0, String(impId)]).catch(() => {});
}
async function trainingSet({ sinceDays = 7, limit = 50000, objective = 'conv' } = {}) {
  if (!pool) return [];
  const [rows] = await pool.query(
    `SELECT imp_id, entity_id, features, label_click, label_conv, label_value_micros FROM ml_feature_log
     WHERE feature_version=? AND label_conv IS NOT NULL AND created_at > NOW() - INTERVAL ? DAY LIMIT ?`,
    [FEATURE_VERSION, Number(sinceDays), Number(limit)]);
  return rows.map(r => ({
    impId: r.imp_id, entityId: r.entity_id,
    x: safeJson(r.features) || [],
    yClick: r.label_click == null ? 0 : Number(r.label_click),
    yConv: Number(r.label_conv) || 0,
    valueMicros: Number(r.label_value_micros) || 0,
  })).filter(r => Array.isArray(r.x) && r.x.length === DIM);
}
function safeJson(s) { try { return JSON.parse(s); } catch (e) { return null; } }

// ───────── 漂移监控：PSI（Population Stability Index）─────────
// 经验阈值：<0.1 稳定；0.1~0.25 需关注；>0.25 显著漂移（该重训了）
function psi(expected, actual, bins = 10) {
  if (!expected.length || !actual.length) return null;
  const all = expected.concat(actual);
  const lo = Math.min(...all), hi = Math.max(...all);
  if (hi === lo) return 0;
  const w = (hi - lo) / bins;
  const bucket = (arr) => {
    const c = new Array(bins).fill(0);
    arr.forEach(v => { let i = Math.floor((v - lo) / w); if (i >= bins) i = bins - 1; if (i < 0) i = 0; c[i]++; });
    return c.map(x => Math.max(x / arr.length, 1e-6));
  };
  const e = bucket(expected), a = bucket(actual);
  let s = 0;
  for (let i = 0; i < bins; i++) s += (a[i] - e[i]) * Math.log(a[i] / e[i]);
  return +s.toFixed(4);
}
// 线上实时特征分布（滚动窗口）与训练期参考分布对比
const onlineWindow = new Map(); // featureIndex -> array
const WINDOW_MAX = 2000;
function observeOnline(x) {
  for (let i = 0; i < x.length; i++) {
    let a = onlineWindow.get(i);
    if (!a) { a = []; onlineWindow.set(i, a); }
    a.push(x[i]);
    if (a.length > WINDOW_MAX) a.shift();
  }
}
async function saveRef(samples = 5000) {
  if (!pool) return null;
  const [rows] = await pool.query('SELECT features FROM ml_feature_log WHERE feature_version=? ORDER BY id DESC LIMIT ?', [FEATURE_VERSION, Number(samples)]);
  const cols = Array.from({ length: DIM }, () => []);
  rows.forEach(r => { const x = safeJson(r.features); if (Array.isArray(x)) x.forEach((v, i) => { if (cols[i]) cols[i].push(v); }); });
  await pool.query(`INSERT INTO ml_feature_ref (feature_version,stats,samples) VALUES (?,?,?)
    ON DUPLICATE KEY UPDATE stats=VALUES(stats), samples=VALUES(samples)`,
    [FEATURE_VERSION, JSON.stringify(cols), rows.length]).catch(() => {});
  return { version: FEATURE_VERSION, samples: rows.length };
}
async function driftReport(threshold = 0.25) {
  let ref = null;
  if (pool) {
    try {
      const [[r]] = await pool.query('SELECT stats FROM ml_feature_ref WHERE feature_version=?', [FEATURE_VERSION]);
      if (r && r.stats) ref = safeJson(r.stats);
    } catch (e) {}
  }
  if (!ref) return { ok: false, reason: 'NO_REFERENCE' };
  const items = [];
  for (let i = 0; i < DIM; i++) {
    const online = onlineWindow.get(i);
    if (!online || online.length < 50) continue;
    const v = psi(ref[i] || [], online);
    if (v != null && v > threshold) items.push({ feature: NAMES[i], psi: v });
  }
  items.sort((a, b) => b.psi - a.psi);
  return { ok: true, version: FEATURE_VERSION, threshold, drifted: items.slice(0, 20), worst: items[0] || null, alert: items.length > 0 };
}

module.exports = {
  FEATURE_VERSION, DIM, NAMES, FEATURES,
  attachPool, initTables, compute, normalize, log, attachLabel, trainingSet,
  psi, observeOnline, saveRef, driftReport, smoothRate, clamp01, h,
};
