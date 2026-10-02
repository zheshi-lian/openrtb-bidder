// ml/multi_objective.js —— 多目标预估：pCTR / pCVR / pLTV + 出价决策
//
// v1 只有一个 per-campaign 的 pCVR 逻辑回归（bid_model.js），缺失：
//   ① pCTR：出价要的是"曝光→点击→转化"整条链路，缺 pCTR 就只能靠经验 CTR 常数
//   ② pLTV：同样一次转化，付费 6 元和 600 元不该出一样的价；没有价值模型就无法做 ROAS 出价
//   ③ 校准：见 calibration.js —— 未校准的概率直接乘出价会系统性偏差
//
// 结构沿用 ESMM（与 ml-pipeline 的离线塔一致，便于离线训练后直接灌权重）：
//   pCTR  = σ(w_ctr · x)
//   pCVR  = σ(w_cvr · x)          在全量曝光上训（label=conv），与 pCTR 相乘得 pCTCVR
//   pLTV  = max(0, w_val · x)     仅在转化样本上训（回归），单位 CNY
//   期望价值/曝光 = pCTR × pCVR × pLTV
// 冷启动：campaign 样本不足时，与全局模型（cid=0）按 α=N0/(N0+n) 融合。

const fs = require('./feature_store');
const calibration = require('./calibration');

const LR = { ctr: 0.05, cvr: 0.05, val: 0.01 };
const L2 = 1e-4;
const N0 = 50;                    // 冷启动融合先验强度
const DEFAULT_PCTR = 0.01, DEFAULT_PCVR = 0.05, DEFAULT_PLTV_CNY = 30;

let pool = null;
const towers = new Map();         // `${cid}:${obj}` -> {w, n}

function attachPool(p) { pool = p; }
async function initTables() {
  if (!pool) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS ml_tower_weights (
    campaign_id INT NOT NULL, objective VARCHAR(8) NOT NULL, feature_version VARCHAR(16) DEFAULT '',
    w_json TEXT, n INT DEFAULT 0, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (campaign_id, objective))`).catch(() => {});
}
function key(cid, obj) { return `${Number(cid) || 0}:${obj}`; }
function wOf(cid, obj) {
  let m = towers.get(key(cid, obj));
  if (!m) { m = { w: new Array(fs.DIM).fill(0), n: 0, dirty: false }; towers.set(key(cid, obj), m); }
  return m;
}
function sigmoid(z) { return 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z)))); }
function dot(w, x) { let z = 0; for (let i = 0; i < w.length && i < x.length; i++) z += w[i] * x[i]; return z; }

// ───────── 预测 ─────────
function predict(cid, x) {
  const gc = wOf(0, 'ctr'), gv = wOf(0, 'cvr'), gl = wOf(0, 'val');
  const cc = wOf(cid, 'ctr'), cv = wOf(cid, 'cvr'), cl = wOf(cid, 'val');
  // 冷启动融合：样本越少越信任全局模型
  const aC = N0 / (N0 + cc.n), aV = N0 / (N0 + cv.n), aL = N0 / (N0 + cl.n);
  const zC = aC * dot(gc.w, x) + (1 - aC) * dot(cc.w, x);
  const zV = aV * dot(gv.w, x) + (1 - aV) * dot(cv.w, x);
  const zL = aL * dot(gl.w, x) + (1 - aL) * dot(cl.w, x);

  let pctr = sigmoid(zC), pcvr = sigmoid(zV);
  let pltv = Math.max(0, zL) * 1e6;                       // CNY → micros
  // 校准：先取 campaign 级校准器，无则回退全局
  pctr = calibration.apply(`ctr:${cid}`, pctr) || calibration.apply('ctr:0', pctr);
  pcvr = calibration.apply(`cvr:${cid}`, pcvr) || calibration.apply('cvr:0', pcvr);
  // 无训练信号时给行业先验，避免 0 出价
  if (!cc.n && !gc.n) pctr = DEFAULT_PCTR;
  if (!cv.n && !gv.n) pcvr = DEFAULT_PCVR;
  if (!cl.n && !gl.n) pltv = DEFAULT_PLTV_CNY * 1e6;

  const pctcvr = pctr * pcvr;
  return {
    pctr: +pctr.toFixed(6), pcvr: +pcvr.toFixed(6), pctcvr: +pctcvr.toFixed(8),
    pltv_micros: Math.round(pltv),
    expected_value_micros: Math.round(pctcvr * pltv),
    cold: (cc.n + cv.n) < N0,
    n: { ctr: cc.n, cvr: cv.n, val: cl.n },
  };
}

// ───────── 训练（在线 SGD，各塔独立学习率）─────────
function learn(cid, x, sample) {
  const { click, conv, valueMicros } = sample || {};
  // CTR 塔：全量曝光，label = 是否点击
  const c = wOf(cid, 'ctr');
  const pc = sigmoid(dot(c.w, x));
  const ec = (click ? 1 : 0) - pc;
  for (let i = 0; i < c.w.length; i++) c.w[i] += LR.ctr * ec * (x[i] || 0) - L2 * c.w[i];
  c.n++; c.dirty = true;
  // 全局塔同步学习（新 campaign 立刻有可用先验）
  const gc = wOf(0, 'ctr');
  for (let i = 0; i < gc.w.length; i++) gc.w[i] += LR.ctr * ec * (x[i] || 0) - L2 * gc.w[i];
  gc.n++; gc.dirty = true;

  // CVR 塔：全量曝光，label = 是否转化（ESMM 语义，pCTCVR = pCTR×pCVR）
  const v = wOf(cid, 'cvr');
  const pv = sigmoid(dot(v.w, x));
  const ev = (conv ? 1 : 0) - pv;
  for (let i = 0; i < v.w.length; i++) v.w[i] += LR.cvr * ev * (x[i] || 0) - L2 * v.w[i];
  v.n++; v.dirty = true;
  const gv = wOf(0, 'cvr');
  for (let i = 0; i < gv.w.length; i++) gv.w[i] += LR.cvr * ev * (x[i] || 0) - L2 * gv.w[i];
  gv.n++; gv.dirty = true;

  // 价值塔：仅转化样本，回归到 CNY（除以 1e6 量纲，避免梯度爆炸）
  if (conv) {
    const l = wOf(cid, 'val');
    const y = Number(valueMicros || 0) / 1e6;
    const el = y - dot(l.w, x);
    for (let i = 0; i < l.w.length; i++) l.w[i] += LR.val * el * (x[i] || 0) - L2 * l.w[i];
    l.n++; l.dirty = true;
    const gl = wOf(0, 'val');
    for (let i = 0; i < gl.w.length; i++) gl.w[i] += LR.val * el * (x[i] || 0) - L2 * gl.w[i];
    gl.n++; gl.dirty = true;
  }
}

// ───────── 出价：目标驱动 + 预算/节奏调节 + 边界 ─────────
/**
 * @param {object} o {pred, goal:{type:'CPA'|'ROAS'|'CPM', targetCpaMicros|targetRoas|targetCpmMicros},
 *                    floorMicros, maxBidMicros, bidAdjust}
 */
function bidFor(o) {
  const p = o.pred || {};
  const goal = o.goal || { type: 'CPM' };
  let bid = 0, basis = '';
  if (goal.type === 'ROAS') {
    // ROAS 出价：出价上限 = 期望收入 / 目标 ROAS（这是效果广告最主流的出价方式）
    const roas = Number(goal.targetRoas) || 1;
    bid = (p.expected_value_micros || 0) / roas; basis = 'evalue/roas';
  } else if (goal.type === 'CPA') {
    bid = (p.pctcvr || 0) * Number(goal.targetCpaMicros || 0); basis = 'pctcvr*cpa';
  } else {
    bid = Number(goal.targetCpmMicros || 0); basis = 'target_cpm';
  }
  const adj = Number(o.bidAdjust) || 1;
  bid = bid * adj;
  // 冷启动保护：模型没信号时不要因 0 概率直接不参竞，用目标 CPM 兜底
  if (p.cold && bid <= 0 && goal.targetCpmMicros) bid = Number(goal.targetCpmMicros) * 0.8;
  const floor = Number(o.floorMicros || 0);
  const max = Number(o.maxBidMicros || 0);
  if (floor > 0 && bid < floor) bid = floor * (o.allowBelowFloor ? 0 : 1);
  if (max > 0) bid = Math.min(bid, max);
  return { bidMicros: Math.round(Math.max(0, bid)), basis, adjustedBy: adj };
}

// ───────── 持久化 ─────────
async function load() {
  if (!pool) return;
  try {
    const [rows] = await pool.query('SELECT campaign_id,objective,w_json,n FROM ml_tower_weights');
    let n = 0;
    for (const r of rows) {
      let w = null;
      try { w = JSON.parse(r.w_json); } catch (e) {}
      if (!Array.isArray(w)) continue;
      // 特征版本/维度变更时旧权重不可用：直接丢弃，避免静默用错维度
      if (w.length !== fs.DIM) continue;
      towers.set(key(r.campaign_id, r.objective), { w, n: Number(r.n) || 0, dirty: false });
      n++;
    }
    if (n) console.log(`[multi_objective] 已加载 ${n} 个塔权重 (dim=${fs.DIM})`);
  } catch (e) {}
}
async function flush() {
  if (!pool) return;
  for (const [k, m] of towers) {
    if (!m.dirty) continue;
    const [cid, obj] = k.split(':');
    await pool.query(`INSERT INTO ml_tower_weights (campaign_id,objective,feature_version,w_json,n) VALUES (?,?,?,?,?)
      ON DUPLICATE KEY UPDATE w_json=VALUES(w_json), n=VALUES(n), feature_version=VALUES(feature_version)`,
      [Number(cid), obj, fs.FEATURE_VERSION, JSON.stringify(m.w), m.n]).catch(() => {});
    m.dirty = false;
  }
}
function snapshot() {
  const out = {};
  for (const [k, m] of towers) if (m.n) out[k] = { n: m.n };
  return { towers: out, dim: fs.DIM, feature_version: fs.FEATURE_VERSION };
}

module.exports = {
  attachPool, initTables, load, flush, predict, learn, bidFor, snapshot,
  DEFAULT_PCTR, DEFAULT_PCVR, DEFAULT_PLTV_CNY, N0, _towers: towers,
};
