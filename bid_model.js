// bid_model.js —— 在线转化预测（在线逻辑回归，per-campaign）
//
const cache = require('./cache'); // 可降级缓存 + 指标
// 目标：让竞价真正"数据驱动"。预测 pCVR，按"预测转化价值"调整出价系数：
//   modelMul = clamp(pCVR / BASE_PCVR, 0.3, 3.0)
//   一个在上下文里转化率 3× 基线的 campaign 出价 ×3；一个错配（游戏投教育）学到低 pCVR → 出价 ×0.3 → 跌破底价自动不抢标。
// 与硬 gate（品类隔离/相关性门槛）互补：gate 管冷启动+不可学约束，模型管软的、数据驱动的优化。
// 与 ecpm_engine 的贝叶斯融合也互补：那里用"评测分先验+行为分"，这里是真实归因回流做在线学习。

const BASE_PCVR = 0.5;    // 逻辑回归"无信息先验"：未训练时预测 0.5，modelMul=1（不放大也不压低）
const LR = 0.08;          // 学习率
const L2 = 0.001;         // L2 正则（防过拟合稀疏信号）
const MUL_MIN = 0.3, MUL_MAX = 3.0;
const FEAT_DIM = 8;

let pool = null;
const weights = new Map(); // cid -> { w:[], n, dirty }

function safeJson(s) { try { return JSON.parse(s); } catch { return null; } }
function attachPool(p) { pool = p; }

// 特征向量：捕获品类匹配 / 相关性 / 关键词重叠 / 时段（ diurnal 转化规律）
// ctx._relScore 由调用方注入（上下文相关性分数 0..1）
function featureVector(c, ctx) {
  const campCat = (c.app_category || '').toLowerCase();
  const ctxCat = (ctx.app_category || '').toLowerCase();
  const catEqual = (campCat && ctxCat && campCat === ctxCat) ? 1 : 0;
  const catAbsent = (!campCat || campCat === 'all') ? 1 : 0;
  const catMismatch = (campCat && ctxCat && campCat !== ctxCat) ? 1 : 0;
  const tags = (c.intent_tags || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const kw = (ctx.keywords || []).map(s => String(s).toLowerCase());
  let overlap = 0;
  for (const t of tags) if (kw.some(k => k.includes(t) || t.includes(k))) overlap++;
  const kwNorm = tags.length ? Math.min(1, overlap / tags.length) : 0;
  const rel = typeof ctx._relScore === 'number' ? ctx._relScore : 0;
  const hr = (new Date().getHours() / 24) * 2 * Math.PI;
  return [1, catEqual, catAbsent, catMismatch, rel, kwNorm, Math.sin(hr), Math.cos(hr)];
}

function sigmoid(z) { return 1 / (1 + Math.exp(-z)); }

function predict(cid, x) {
  const m = weights.get(cid);
  if (!m) return BASE_PCVR;
  let z = 0;
  for (let i = 0; i < x.length; i++) z += (m.w[i] || 0) * x[i];
  return sigmoid(z);
}

// 在线 SGD 一步：label=1 转化 / 0 未转化
function train(cid, x, y) {
  let m = weights.get(cid);
  if (!m) { m = { w: new Array(FEAT_DIM).fill(0), n: 0, dirty: false }; weights.set(cid, m); }
  let z = 0; for (let i = 0; i < FEAT_DIM; i++) z += (m.w[i] || 0) * x[i];
  const err = y - sigmoid(z);
  for (let i = 0; i < FEAT_DIM; i++) m.w[i] = (m.w[i] || 0) + LR * err * x[i] - L2 * (m.w[i] || 0);
  m.n++; m.dirty = true;
}

function modelMul(cid, x) {
  const p = predict(cid, x);
  return Math.max(MUL_MIN, Math.min(MUL_MAX, p / BASE_PCVR));
}

// 持久化：从 DB 加载（启动时），周期性 flush 脏权重
async function loadAll() {
  if (!pool) return;
  try {
    const [rows] = await pool.query('SELECT campaign_id, w_json, n FROM bid_model_weights');
    for (const r of rows) {
      const w = safeJson(r.w_json);
      if (Array.isArray(w) && w.length === FEAT_DIM) weights.set(r.campaign_id, { w, n: r.n || 0, dirty: false });
    }
  } catch (e) {}
}
async function flushDirty() {
  if (!pool) return;
  for (const [cid, m] of weights) {
    if (!m.dirty) continue;
    try {
      await pool.query('INSERT INTO bid_model_weights (campaign_id,w_json,n,updated_at) VALUES (?,?,?,NOW()) ON DUPLICATE KEY UPDATE w_json=VALUES(w_json),n=VALUES(n),updated_at=NOW()',
        [cid, JSON.stringify(m.w), m.n]);
      m.dirty = false;
    } catch (e) {}
  }
}
function startFlusher() { setInterval(flushDirty, 15000).unref && setInterval(flushDirty, 15000).unref(); }

// 负样本扫描：超过归因窗口仍未转化的曝光 → 标 0 训练一次（避免无限重复训练）
async function sweepNegatives() {
  if (!pool) return;
  try {
    const [rows] = await pool.query(
      "SELECT imp_id, campaign_id, feat FROM bid_win_log WHERE model_trained=0 AND feat IS NOT NULL AND created_at < NOW()-INTERVAL 30 MINUTE AND imp_id NOT IN (SELECT imp_id FROM conv_log WHERE type='conversion') LIMIT 200");
    for (const r of rows) {
      const fx = safeJson(r.feat);
      if (Array.isArray(fx)) train(Number(r.campaign_id) || 0, fx, 0);
      await pool.query('UPDATE bid_win_log SET model_trained=1 WHERE imp_id=?', [r.imp_id]).catch(() => {});
    }
  } catch (e) {}
}
function startSweeper() { setInterval(sweepNegatives, 60000).unref && setInterval(sweepNegatives, 60000).unref(); }

// 转化回流时训练正样本（在写 conv_log 后调用）
async function trainConversion(impid) {
  if (!impid) return;
  try {
    const [[w]] = await pool.query('SELECT campaign_id, feat FROM bid_win_log WHERE imp_id=?', [String(impid)]);
    if (!w || !w.feat) return;
    const fx = safeJson(w.feat);
    if (Array.isArray(fx)) { train(Number(w.campaign_id) || 0, fx, 1); cache.incr('model_train_pos'); }
    await pool.query('UPDATE bid_win_log SET model_trained=1 WHERE imp_id=?', [String(impid)]).catch(() => {});
  } catch (e) {}
}

module.exports = {
  attachPool, featureVector, predict, train, modelMul,
  loadAll, flushDirty, startFlusher, startSweeper, trainConversion,
  BASE_PCVR, MUL_MIN, MUL_MAX, FEAT_DIM,
};
