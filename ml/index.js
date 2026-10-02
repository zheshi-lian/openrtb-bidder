// ml/index.js —— ML 平台统一入口：特征 → 多目标预估 → 校准 → 出价 → Bandit → 回流学习 → 监控
//
// 一条完整闭环（也是"平台化"和"单模型"的区别）：
//   竞价时：compute(x) → predict(pCTR/pCVR/pLTV) → calibration → bidFor → shade（竞价层）
//   行为回流：click/conversion → attachLabel → learn（各塔 SGD）→ 周期性 fit calibration
//   素材选择：bandit.choose（上下文感知，而非无上下文 Thompson）
//   监控：feature PSI 漂移 + 模型 AUC/ECE + registry 灰度状态

const fs = require('./feature_store');
const mo = require('./multi_objective');
const cal = require('./calibration');
const bandit = require('./bandit');
const registry = require('./registry');
const neuralBridge = require('./neural_bridge');   // 离线预训练权重(含阿里妈妈 CVR 头)接入在线出价 + 校准

const FLUSH_MS = Number(process.env.ML_FLUSH_MS || 30000);

function attachPool(pool) {
  fs.attachPool(pool); mo.attachPool(pool); cal.attachPool(pool); bandit.attachPool(pool); registry.attachPool(pool);
}
async function init() {
  await fs.initTables();
  await mo.initTables();
  await cal.initTables();
  await bandit.initTables();
  await registry.initTables();
  await Promise.all([mo.load(), cal.load(), bandit.load(), registry.load()]);
}
function startWorkers() {
  const t1 = setInterval(() => { mo.flush().catch(() => {}); bandit.flush().catch(() => {}); }, FLUSH_MS);
  // 每 30 分钟重拟合校准器：模型权重在变，校准参数必须跟着变
  const t2 = setInterval(() => { refitCalibration().catch(() => {}); }, 30 * 60 * 1000);
  // 每 6 小时刷新特征参考分布（漂移基线）
  const t3 = setInterval(() => { fs.saveRef().catch(() => {}); }, 6 * 60 * 60 * 1000);
  [t1, t2, t3].forEach(t => t.unref && t.unref());
  return { flushTimer: t1, calibTimer: t2, refTimer: t3 };
}

// ───────── 竞价热路径 ─────────
function score(cid, ctx) {
  const x = fs.compute(ctx);
  fs.observeOnline(x);
  const pred = mo.predict(cid, x);
  return { x, pred };
}
function bid(cid, ctx, opts = {}) {
  const { x, pred } = score(cid, ctx);
  const b = mo.bidFor({
    pred, goal: opts.goal || { type: 'CPM', targetCpmMicros: opts.targetCpmMicros || 5000000 },
    floorMicros: opts.floorMicros || 0, maxBidMicros: opts.maxBidMicros || 0,
    bidAdjust: opts.bidAdjust || 1, allowBelowFloor: opts.allowBelowFloor,
  });
  return { ...b, x, pred };
}

// ───────── 回流学习 ─────────
async function learn(cid, ctx, sample) {
  const x = fs.compute(ctx);
  mo.learn(cid, x, sample);
  // 校准与监控用采样：全量记录会把日志表写爆
  const m = registry.active('pCVR') || { model_id: 'pCVR:default' };
  registry.logPrediction(m.model_id, mo.predict(cid, x).pcvr, sample && sample.conv ? 1 : 0);
}
async function onImpression(impId, cid, ctx) {
  const x = fs.compute(ctx);
  return fs.log('campaign', cid, ctx, impId) || x;
}
async function onClick(impId) { await fs.attachLabel(impId, { click: 1 }); }
async function onConversion(impId, valueMicros) { await fs.attachLabel(impId, { click: 1, conv: 1, valueMicros }); }

async function refitCalibration() {
  const rows = await fs.trainingSet({ sinceDays: 7, limit: 50000 });
  if (rows.length < 200) return { ok: false, reason: 'INSUFFICIENT_SAMPLES', n: rows.length };
  const byCid = new Map();
  for (const r of rows) {
    const cid = Number(r.entityId) || 0;
    if (!byCid.has(cid)) byCid.set(cid, []);
    byCid.get(cid).push(r);
  }
  const out = [];
  for (const [cid, list] of byCid) {
    if (list.length < 100) continue;
    const preds = list.map(r => ({ score: mo.predict(cid, r.x).pcvr, label: r.yConv }));
    const res = await cal.fit(`cvr:${cid}`, preds);
    if (res.ok) out.push(res);
  }
  // 全局校准器（新 campaign 冷启动用）
  const globals = rows.map(r => ({ score: mo.predict(0, r.x).pcvr, label: r.yConv }));
  // 神经引擎(cold-start 先验)校准：用真实回流标签拟合 neural:ctr / neural:cvr 全局校准器，
  // 修正神经输出过度自信（早期观察到 pctr≈0.98）。需 NEURAL_ENGINE 开启且模型可服务才生效。
  if (neuralBridge.isEnabled()) {
    const ctrPairs = [], cvrPairs = [];
    for (const r of rows) {
      const s = neuralBridge.scoreFeatures(r.x);
      if (!s) continue;
      ctrPairs.push({ score: s.pctr, label: r.yClick });
      cvrPairs.push({ score: s.pcvr, label: r.yConv });
    }
    if (ctrPairs.length >= 200) { const rc = await cal.fit('neural:ctr', ctrPairs); if (rc.ok) out.push(Object.assign({ model: 'neural:ctr' }, rc)); }
    if (cvrPairs.length >= 200) { const rv = await cal.fit('neural:cvr', cvrPairs); if (rv.ok) out.push(Object.assign({ model: 'neural:cvr' }, rv)); }
  }
  const g = await cal.fit('cvr:0', globals);
  return { ok: true, models: out.length, global: g };
}

function snapshot() {
  return {
    feature_version: fs.FEATURE_VERSION, dim: fs.DIM,
    towers: mo.snapshot(), calibration: cal.snapshot(),
    bandit: bandit.snapshot(), registry: registry.list(),
    neural: { enabled: neuralBridge.isEnabled(), healthy: neuralBridge.isHealthy(), model: neuralBridge.model },
  };
}

module.exports = {
  attachPool, init, startWorkers, score, bid, learn,
  onImpression, onClick, onConversion, refitCalibration, snapshot,
  fs, mo, cal, bandit, registry, neuralBridge,
};
