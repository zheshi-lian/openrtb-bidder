// ml/calibration.js —— 概率校准（Platt / Isotonic）+ 校准度监控（ECE / reliability）
//
// 为什么必须做：出价直接乘 pCVR。未校准的模型输出"相对序"可用但"绝对值"不可信——
// 预测 0.2 实际 0.05 时，出价会系统性高出 4 倍，表现为"ROI 达标但 CPA 爆表"。
// 排序模型（AUC 高）≠ 概率模型（校准好），这是广告 ML 最常见的上线事故。
//
// 两种校准器：
//   · Platt scaling：P = 1/(1+exp(A·s+B))，参数少、小样本也稳，适合 CTR/CVR 在线更新
//   · Isotonic regression：非参数、保序、能拟合任意形状，但需样本多且易过拟合尾部
// 选择：n<2000 用 Platt；n≥2000 用 Isotonic，并以 ECE 更优者胜出。

let pool = null;
function attachPool(p) { pool = p; }
async function initTables() {
  if (!pool) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS ml_calibration (
    model_id VARCHAR(64) PRIMARY KEY, type VARCHAR(16), params TEXT,
    ece_before DECIMAL(6,4) DEFAULT 0, ece_after DECIMAL(6,4) DEFAULT 0, n INT DEFAULT 0,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP)`).catch(() => {});
}
function safeJson(s) { try { return JSON.parse(s); } catch (e) { return null; } }

// ───────── Platt scaling（逻辑回归，梯度下降）─────────
// 学习率/迭代次数需足以让截距走到真实值：Platt 常有 B≈-3 量级（把高估概率压回真实水平），
// lr 太小（如 0.01×400 步）根本走不到，校准等于没做——这是"校准上线但 ECE 没降"的典型原因。
function fitPlatt(pairs, { lr = 0.5, iters = 1500, l2 = 1e-5 } = {}) {
  let A = 1, B = 0;
  const n = pairs.length || 1;
  for (let it = 0; it < iters; it++) {
    let gA = 0, gB = 0;
    for (const p of pairs) {
      const s = p.score, y = p.label;
      const z = A * s + B;
      const pr = 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));
      const err = pr - y;
      gA += err * s; gB += err;
    }
    A -= lr * (gA / n + l2 * A);
    B -= lr * (gB / n);
  }
  return { type: 'platt', A: +A.toFixed(6), B: +B.toFixed(6) };
}
function platt(model, s) {
  const z = model.A * s + model.B;
  return 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));
}

// ───────── Isotonic regression（PAVA 保序回归）─────────
function fitIsotonic(pairs) {
  const pts = pairs.slice().sort((a, b) => a.score - b.score);
  const blocks = []; // {w, sum, value}
  for (const p of pts) {
    let cur = { w: 1, sum: p.label, value: p.label, lo: p.score, hi: p.score };
    blocks.push(cur);
    // 违反单调性就与前一区块合并（pool adjacent violators）
    while (blocks.length > 1 && blocks[blocks.length - 2].value > blocks[blocks.length - 1].value + 1e-12) {
      const a = blocks[blocks.length - 2], b = blocks.pop();
      a.w += b.w; a.sum += b.sum; a.value = a.sum / a.w; a.hi = b.hi;
    }
  }
  return { type: 'isotonic', knots: blocks.map(b => ({ hi: b.hi, v: b.value })) };
}
function isotonic(model, s) {
  const ks = model.knots;
  if (!ks || !ks.length) return s;
  if (s <= ks[0].hi) return ks[0].v;
  for (let i = 0; i < ks.length; i++) if (s <= ks[i].hi) return ks[i].v;
  return ks[ks.length - 1].v;
}

// ───────── 评估：ECE（期望校准误差）与 reliability 表 ──────────
function ece(pairs, bins = 10) {
  if (!pairs.length) return 0;
  const b = Array.from({ length: bins }, () => ({ n: 0, s: 0, y: 0 }));
  for (const p of pairs) {
    let i = Math.floor(Math.max(0, Math.min(0.999, p.score)) * bins);
    b[i].n++; b[i].s += p.score; b[i].y += p.label;
  }
  let e = 0;
  const table = [];
  for (let i = 0; i < bins; i++) {
    if (!b[i].n) { table.push({ bin: i, n: 0 }); continue; }
    const avgP = b[i].s / b[i].n, avgY = b[i].y / b[i].n;
    e += (b[i].n / pairs.length) * Math.abs(avgP - avgY);
    table.push({ bin: i, n: b[i].n, avg_predicted: +avgP.toFixed(4), avg_actual: +avgY.toFixed(4) });
  }
  return { ece: +e.toFixed(4), table };
}
function logLoss(pairs) {
  if (!pairs.length) return 0;
  let s = 0;
  for (const p of pairs) {
    const pr = Math.max(1e-6, Math.min(1 - 1e-6, p.score));
    s += p.label ? -Math.log(pr) : -Math.log(1 - pr);
  }
  return +(s / pairs.length).toFixed(4);
}

// ───────── 注册表：model_id -> calibrator ──────────
const models = new Map();
function apply(modelId, score) {
  const m = models.get(modelId);
  if (!m) return score;
  const v = m.type === 'isotonic' ? isotonic(m, score) : platt(m, score);
  return Math.max(0, Math.min(1, v));
}
async function fit(modelId, pairs) {
  if (!pairs || pairs.length < 50) return { ok: false, reason: 'INSUFFICIENT_SAMPLES', n: (pairs || []).length };
  const before = ece(pairs).ece;
  const cand = pairs.length >= 2000 ? fitIsotonic(pairs) : fitPlatt(pairs);
  const afterPairs = pairs.map(p => ({ score: cand.type === 'isotonic' ? isotonic(cand, p.score) : platt(cand, p.score), label: p.label }));
  const after = ece(afterPairs).ece;
  // 校准后反而更差就不上（常见于样本极少时 isotonic 过拟合）
  const chosen = after <= before ? cand : { type: 'platt', A: 1, B: 0 };
  models.set(modelId, chosen);
  if (pool) {
    await pool.query(`INSERT INTO ml_calibration (model_id,type,params,ece_before,ece_after,n) VALUES (?,?,?,?,?,?)
      ON DUPLICATE KEY UPDATE type=VALUES(type), params=VALUES(params), ece_before=VALUES(ece_before), ece_after=VALUES(ece_after), n=VALUES(n)`,
      [modelId, chosen.type, JSON.stringify(chosen), before, after, pairs.length]).catch(() => {});
  }
  return { ok: true, modelId, type: chosen.type, ece_before: before, ece_after: after, n: pairs.length, log_loss: logLoss(pairs) };
}
async function load() {
  if (!pool) return;
  try {
    const [rows] = await pool.query('SELECT model_id,type,params,n FROM ml_calibration');
    rows.forEach(r => { const p = safeJson(r.params); if (p) models.set(r.model_id, p); });
    if (rows.length) console.log(`[calibration] 已加载 ${rows.length} 个校准器`);
  } catch (e) {}
}
function snapshot() {
  const out = {};
  for (const [k, v] of models) out[k] = { type: v.type, ...(v.type === 'platt' ? { A: v.A, B: v.B } : { knots: (v.knots || []).length }) };
  return out;
}

module.exports = {
  attachPool, initTables, fitPlatt, platt, fitIsotonic, isotonic,
  ece, logLoss, apply, fit, load, snapshot, _models: models,
};
