// ml/registry.js —— 模型注册 / 影子评估 / 上线灰度 / 漂移告警
//
// "ML 平台化"和"有几个模型"的分界线就在这里：没有注册与灰度，改模型等于直接改线上，
// 出事只能回滚代码；有了 registry，可以做 shadow（并行打分不生效）→ canary（1% 生效）
// → active（全量），且任何时刻能按指标一键回退。

const fs = require('./feature_store');

let pool = null;
function attachPool(p) { pool = p; }
async function initTables() {
  if (!pool) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS ml_model (
    model_id VARCHAR(64) PRIMARY KEY, name VARCHAR(64), version VARCHAR(24), kind VARCHAR(24),
    feature_version VARCHAR(16), params TEXT, metrics TEXT,
    status VARCHAR(16) DEFAULT 'staging', traffic_pct INT DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP)`).catch(() => {});
  await pool.query(`CREATE TABLE IF NOT EXISTS ml_eval_log (
    id BIGINT AUTO_INCREMENT PRIMARY KEY, model_id VARCHAR(64), window_start BIGINT, window_end BIGINT,
    n INT DEFAULT 0, auc DECIMAL(5,4) NULL, log_loss DECIMAL(6,4) NULL, ece DECIMAL(6,4) NULL,
    psi DECIMAL(6,4) NULL, note VARCHAR(255) DEFAULT '',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`).catch(() => {});
}
function safeJson(s) { try { return JSON.parse(s); } catch (e) { return null; } }

const models = new Map(); // model_id -> record

async function register(rec) {
  const r = {
    model_id: rec.modelId || `${rec.name}:${rec.version}`,
    name: rec.name, version: rec.version || '1', kind: rec.kind || 'lr',
    feature_version: rec.featureVersion || fs.FEATURE_VERSION,
    params: rec.params || {}, metrics: rec.metrics || {},
    status: rec.status || 'staging', trafficPct: Number(rec.trafficPct || 0),
  };
  // 特征版本不匹配一律拒绝注册：这是防"离线/在线特征不一致"最硬的一道闸
  if (r.feature_version !== fs.FEATURE_VERSION) {
    return { ok: false, reason: 'FEATURE_VERSION_MISMATCH', expected: fs.FEATURE_VERSION, got: r.feature_version };
  }
  models.set(r.model_id, r);
  if (pool) {
    await pool.query(`INSERT INTO ml_model (model_id,name,version,kind,feature_version,params,metrics,status,traffic_pct)
      VALUES (?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE metrics=VALUES(metrics), status=VALUES(status), traffic_pct=VALUES(traffic_pct), params=VALUES(params)`,
      [r.model_id, r.name, r.version, r.kind, r.feature_version, JSON.stringify(r.params), JSON.stringify(r.metrics), r.status, r.trafficPct]).catch(() => {});
  }
  return { ok: true, model: r };
}
async function promote(modelId, status, trafficPct) {
  const m = models.get(modelId);
  if (!m) return { ok: false, reason: 'NOT_FOUND' };
  if (status) m.status = status;
  if (trafficPct != null) m.trafficPct = Number(trafficPct);
  if (m.status === 'active') {
    // 同一 name 下只允许一个 active：避免两个模型同时全量
    for (const [id, o] of models) {
      if (id !== modelId && o.name === m.name && o.status === 'active') { o.status = 'retired'; o.trafficPct = 0; }
    }
  }
  if (pool) await pool.query('UPDATE ml_model SET status=?, traffic_pct=? WHERE model_id=?', [m.status, m.trafficPct, modelId]).catch(() => {});
  return { ok: true, model: m };
}
function active(name) {
  for (const m of models.values()) if (m.name === name && m.status === 'active') return m;
  return null;
}
function list() { return [...models.values()]; }

// ───────── 影子评估：线上并行打分但结果不生效，用真实流量比新旧模型 ──────────
const shadowBuckets = new Map(); // model_id -> {pairs:[], n}
function logPrediction(modelId, score, label) {
  let b = shadowBuckets.get(modelId);
  if (!b) { b = { pairs: [], n: 0 }; shadowBuckets.set(modelId, b); }
  b.pairs.push({ score, label });
  b.n++;
  if (b.pairs.length > 20000) b.pairs.splice(0, b.pairs.length - 20000);
}
function auc(pairs) {
  if (!pairs.length) return null;
  const pos = pairs.filter(p => p.label === 1).length;
  const neg = pairs.length - pos;
  if (!pos || !neg) return null;
  const s = pairs.slice().sort((a, b) => a.score - b.score);
  let rank = 0, sumRank = 0;
  for (const p of s) { rank++; if (p.label === 1) sumRank += rank; }
  return +((sumRank - pos * (pos + 1) / 2) / (pos * neg)).toFixed(4);
}
function logLoss(pairs) {
  if (!pairs.length) return null;
  let s = 0;
  for (const p of pairs) {
    const pr = Math.max(1e-6, Math.min(1 - 1e-6, p.score));
    s += p.label ? -Math.log(pr) : -Math.log(1 - pr);
  }
  return +(s / pairs.length).toFixed(4);
}
async function evaluate(modelId) {
  const b = shadowBuckets.get(modelId);
  if (!b || b.pairs.length < 100) return { ok: false, reason: 'INSUFFICIENT_SAMPLES', n: (b && b.pairs.length) || 0 };
  const a = auc(b.pairs), ll = logLoss(b.pairs);
  const drift = await fs.driftReport();
  const rec = { window_start: Date.now() - 3600000, window_end: Date.now(), n: b.pairs.length, auc: a, log_loss: ll, ece: null, psi: drift.ok ? (drift.worst ? drift.worst.psi : 0) : null };
  if (pool) {
    await pool.query(`INSERT INTO ml_eval_log (model_id,window_start,window_end,n,auc,log_loss,ece,psi) VALUES (?,?,?,?,?,?,?,?)`,
      [modelId, rec.window_start, rec.window_end, rec.n, a, ll, rec.ece, rec.psi]).catch(() => {});
  }
  b.pairs = []; b.n = 0;
  return { ok: true, ...rec };
}

// 健康度总览：一次看清"模型有没有退化"
async function health() {
  const drift = await fs.driftReport();
  const out = [];
  for (const m of models.values()) {
    const b = shadowBuckets.get(m.model_id);
    out.push({
      model_id: m.model_id, status: m.status, traffic_pct: m.trafficPct,
      shadow_n: b ? b.n : 0, shadow_auc: b && b.pairs.length >= 100 ? auc(b.pairs) : null,
    });
  }
  return { models: out, feature_drift: drift, alert: !!(drift && drift.alert) };
}

async function load() {
  if (!pool) return;
  try {
    const [rows] = await pool.query('SELECT * FROM ml_model');
    rows.forEach(r => models.set(r.model_id, {
      model_id: r.model_id, name: r.name, version: r.version, kind: r.kind,
      feature_version: r.feature_version, params: safeJson(r.params) || {}, metrics: safeJson(r.metrics) || {},
      status: r.status, trafficPct: Number(r.traffic_pct) || 0,
    }));
    if (rows.length) console.log(`[registry] 已加载 ${rows.length} 个模型`);
  } catch (e) {}
}

module.exports = {
  attachPool, initTables, load, register, promote, active, list,
  logPrediction, evaluate, health, auc, logLoss, _models: models,
};
