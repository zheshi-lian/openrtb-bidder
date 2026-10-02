// attribution/incrementality.js —— 增量度量：holdout / ghost ads / geo-lift + 统计检验
//
// 归因（attribution）回答"功劳怎么分"，增量（incrementality）回答"这些转化是不是本来就会发生"。
// 后者才是广告主真正该付钱的东西：一个只投"本来就会下载的人"的平台，归因数据会非常漂亮，
// 但增量是 0。AppLovin/Google 现在都被广告主要求做 lift test，没有这套能力就进不了大客户的
// 采购流程。所以这是"写代码能补、且直接决定能否签单"的能力。
//
// 三种实验：
//   holdout     —— 用户级：控制组完全不投（或只投 PSA），对照组正常投
//   ghost_ads   —— 控制组"假装投"：记录一次曝光事件但不实际展示广告，排除"被看到"的心理效应
//   geo_lift    —— 地域级：整座城市不开投，对比投放城市（适用于无法做用户级拆分的渠道）
//
// 统计：两比例 z 检验 + 差值置信区间 + 增量转化数 + iROAS；并给出所需样本量（避免过早下结论）。

let pool = null;
function attachPool(p) { pool = p; }
async function initTables() {
  if (!pool) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS incr_experiment (
    id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(128), type VARCHAR(16) DEFAULT 'holdout',
    campaign_id INT DEFAULT 0, control_pct INT DEFAULT 10, metric VARCHAR(16) DEFAULT 'conversion',
    mde DECIMAL(5,4) DEFAULT 0.10, alpha DECIMAL(4,3) DEFAULT 0.05, power DECIMAL(4,3) DEFAULT 0.80,
    start_at BIGINT, end_at BIGINT, status VARCHAR(16) DEFAULT 'running',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`).catch(() => {});
  await pool.query(`CREATE TABLE IF NOT EXISTS incr_event (
    id BIGINT AUTO_INCREMENT PRIMARY KEY, exp_id INT, bucket VARCHAR(8), unit_id VARCHAR(80),
    impressions INT DEFAULT 0, conversions INT DEFAULT 0, value_micros BIGINT DEFAULT 0,
    spend_micros BIGINT DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uk_unit (exp_id, unit_id))`).catch(() => {});
}
function safeJson(s) { try { return JSON.parse(s); } catch (e) { return null; } }

// ───────── 稳定分桶：同一 unit 永远进同一组（hash 分桶，不用随机）──────────
function bucket(expId, unitId, controlPct) {
  const crypto = require('crypto');
  const h = crypto.createHash('md5').update(`${expId}:${unitId}`).digest();
  const v = h.readUInt32BE(0) % 10000;
  return v < Number(controlPct) * 100 ? 'control' : 'treat';
}

async function create(spec) {
  const e = {
    name: spec.name || 'exp-' + Date.now(),
    type: ['holdout', 'ghost_ads', 'geo_lift'].includes(spec.type) ? spec.type : 'holdout',
    campaignId: Number(spec.campaignId) || 0,
    controlPct: Math.max(1, Math.min(50, Number(spec.controlPct || 10))),
    metric: spec.metric || 'conversion',
    mde: Number(spec.mde || 0.10), alpha: Number(spec.alpha || 0.05), power: Number(spec.power || 0.80),
    startAt: Number(spec.startAt || Date.now()),
    endAt: Number(spec.endAt || Date.now() + 14 * 86400000),
    status: 'running',
  };
  if (!pool) return e;
  const [r] = await pool.query(
    `INSERT INTO incr_experiment (name,type,campaign_id,control_pct,metric,mde,alpha,power,start_at,end_at,status) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [e.name, e.type, e.campaignId, e.controlPct, e.metric, e.mde, e.alpha, e.power, e.startAt, e.endAt, 'running']);
  e.id = r.insertId;
  return e;
}
async function get(expId) {
  if (!pool) return null;
  const [[r]] = await pool.query('SELECT * FROM incr_experiment WHERE id=?', [expId]);
  if (!r) return null;
  return { id: r.id, name: r.name, type: r.type, campaignId: r.campaign_id, controlPct: r.control_pct, metric: r.metric, mde: Number(r.mde), alpha: Number(r.alpha), power: Number(r.power), startAt: Number(r.start_at), endAt: Number(r.end_at), status: r.status };
}
async function list() {
  if (!pool) return [];
  const [rows] = await pool.query('SELECT * FROM incr_experiment ORDER BY id DESC LIMIT 100');
  return rows;
}

// 竞价热路径用：这条请求该不该被"实验"影响？
// holdout: control 组直接不参竞（省下的钱就是"本来会浪费的钱"）
// ghost_ads: control 组照常返回广告但不计入该 campaign（用于测"看到广告"本身的lift）
async function assign(expId, unitId) {
  const e = await get(expId);
  if (!e || e.status !== 'running') return { participate: false };
  const now = Date.now();
  if (now < e.startAt || now > e.endAt) return { participate: false, reason: 'OUT_OF_WINDOW' };
  const b = bucket(expId, unitId, e.controlPct);
  return {
    participate: true, expId, bucket: b, type: e.type,
    // 控制组处置方式：holdout=不投；ghost_ads=投 PSA 但不计 campaign；geo_lift=整 geo 不投
    action: b === 'control' ? (e.type === 'ghost_ads' ? 'serve_blank' : 'suppress') : 'serve_normal',
  };
}

async function record(expId, unitId, bucketName, delta = {}) {
  if (!pool) return;
  await pool.query(
    `INSERT INTO incr_event (exp_id,bucket,unit_id,impressions,conversions,value_micros,spend_micros)
     VALUES (?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE impressions=impressions+VALUES(impressions), conversions=conversions+VALUES(conversions),
       value_micros=value_micros+VALUES(value_micros), spend_micros=spend_micros+VALUES(spend_micros)`,
    [expId, bucketName, String(unitId), Number(delta.impressions || 0), Number(delta.conversions || 0),
      Number(delta.valueMicros || 0), Number(delta.spendMicros || 0)]).catch(() => {});
}

// ───────── 统计 ─────────
function normCdf(z) { // Abramowitz-Stegun 7.1.26 近似，误差 < 1e-7，无需依赖
  const b = [0.319381530, -0.356563782, 1.781477937, -1.821255978, 1.330274429];
  const p = 0.2316419;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + p * Math.abs(z));
  const poly = b.reduce((s, bi, i) => s + bi * Math.pow(t, i + 1), 0);
  const erf = 1 - Math.exp(-x * x) * poly / Math.sqrt(Math.PI);
  const cdf = 0.5 * (1 + erf);
  return z >= 0 ? cdf : 1 - cdf;
}
function twoProportionZ(x1, n1, x2, n2) {
  if (!n1 || !n2) return { z: 0, pValue: 1 };
  const p1 = x1 / n1, p2 = x2 / n2;
  const p = (x1 + x2) / (n1 + n2);
  const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
  if (!se) return { z: 0, pValue: 1, p1, p2, diff: 0 };
  const z = (p1 - p2) / se;
  return { p1, p2, diff: p1 - p2, z: +z.toFixed(4), pValue: +(2 * (1 - normCdf(Math.abs(z)))).toFixed(5), se: +se.toFixed(6) };
}
// 所需样本量（每组）：n = (z_{1-α/2} + z_{power})² × 2p(1-p) / mde²
function requiredSampleSize(baselineRate, mde, alpha = 0.05, power = 0.8) {
  const za = 1.959964, zb = 0.8416212; // α=0.05 双侧 / power=0.80
  const p = Math.max(0.0001, Math.min(0.9999, baselineRate));
  const d = Math.max(0.0001, mde);
  return Math.ceil(((za + zb) ** 2) * 2 * p * (1 - p) / (d * d));
}

async function analyze(expId) {
  const e = await get(expId);
  if (!e || !pool) return { ok: false, reason: 'NOT_FOUND' };
  const [rows] = await pool.query(
    `SELECT bucket, COUNT(*) units, SUM(impressions) impressions, SUM(conversions) conversions,
            SUM(value_micros) value_micros, SUM(spend_micros) spend_micros
     FROM incr_event WHERE exp_id=? GROUP BY bucket`, [expId]);
  const g = { control: { units: 0, impressions: 0, conversions: 0, valueMicros: 0, spendMicros: 0 },
    treat: { units: 0, impressions: 0, conversions: 0, valueMicros: 0, spendMicros: 0 } };
  rows.forEach(r => {
    const b = g[String(r.bucket)] || (g[String(r.bucket)] = { units: 0, impressions: 0, conversions: 0, valueMicros: 0, spendMicros: 0 });
    b.units += Number(r.units) || 0; b.impressions += Number(r.impressions) || 0;
    b.conversions += Number(r.conversions) || 0; b.valueMicros += Number(r.value_micros) || 0;
    b.spendMicros += Number(r.spend_micros) || 0;
  });
  const c = g.control, t = g.treat;
  const test = twoProportionZ(t.conversions, Math.max(1, t.units), c.conversions, Math.max(1, c.units));
  const ctlRate = c.units ? c.conversions / c.units : 0;
  const trtRate = t.units ? t.conversions / t.units : 0;
  const lift = ctlRate > 0 ? (trtRate - ctlRate) / ctlRate : null;
  // 增量转化 = 实验组超出"自然发生"基线那部分 × 实验组规模
  const incrementalConversions = Math.max(0, (trtRate - ctlRate) * t.units);
  const incrementalValueMicros = Math.max(0, (t.units ? t.valueMicros / t.units : 0) - (c.units ? c.valueMicros / c.units : 0)) * t.units;
  const iroas = t.spendMicros > 0 ? incrementalValueMicros / t.spendMicros : null;
  const need = requiredSampleSize(ctlRate || 0.02, e.mde, e.alpha, e.power);
  const se = test.se || 0;
  const ci95 = se ? [(test.diff - 1.96 * se), (test.diff + 1.96 * se)] : null;
  const significant = test.pValue < e.alpha;
  return {
    ok: true, expId, name: e.name, type: e.type, status: e.status,
    control: c, treat: t,
    control_rate: +ctlRate.toFixed(5), treat_rate: +trtRate.toFixed(5),
    lift: lift == null ? null : +lift.toFixed(4),
    incremental_conversions: +incrementalConversions.toFixed(1),
    incremental_value_micros: Math.round(incrementalValueMicros),
    iroas: iroas == null ? null : +iroas.toFixed(3),
    test: { ...test, ci95: ci95 ? ci95.map(x => +x.toFixed(5)) : null, significant, alpha: e.alpha },
    power: { required_units_per_group: need, have_control: c.units, have_treat: t.units,
      enough: c.units >= need && t.units >= need,
      // 关键：样本不够时给出"别下结论"，而不是把噪声当结论（这是增量实验最常见的误用）
      verdict: significant ? (c.units >= need && t.units >= need ? 'SIGNIFICANT' : 'SIGNIFICANT_BUT_UNDERPOWERED')
        : (c.units + t.units >= need ? 'NO_EFFECT' : 'INCONCLUSIVE_NEED_MORE_DATA') },
  };
}

async function stop(expId, status = 'stopped') {
  if (!pool) return { ok: false };
  await pool.query('UPDATE incr_experiment SET status=? WHERE id=?', [status, expId]);
  return { ok: true, expId, status };
}

module.exports = {
  attachPool, initTables, create, get, list, assign, record, analyze, stop,
  bucket, twoProportionZ, requiredSampleSize, normCdf,
};
