// attribution/skan.js —— SKAdNetwork / Privacy Sandbox 归因：conversion schema 管理 + 回传解码 + 验签
//
// 为什么是"管理"而不只是"接收"：SKAN 只给你一个 0~63 的整数（fine value）或 low/medium/high
// （coarse value），且带噪声、延迟 24~72 小时、没有用户级 ID。要让这个整数有意义，
// 必须提前把业务事件（注册/付费/订阅/付费金额档）编码进 64 个槽位，并保证 schema 版本
// 在 App 侧与服务端严格一致——改一次编码，历史数据就全部不可比。这就是 schema 管理。
//
// 能力：
//   ① schema 定义与版本化（事件 → value 槽位；coarse 阈值；SKAN 版本 2.0/3.0/4.0）
//   ② conversion value 编码 / 解码（含多事件位打包：低 3 位放事件类型，高位放价值档）
//   ③ 苹果回传验签（ECDSA P-256，公钥来自 Apple 提供的 PEM）
//   ④ 多轮回传去重（SKAN 4 有 3 个窗口，同一 device 可能来 3 次，按最后一次胜出）
//   ⑤ 聚合还原：把带噪声的 CV 分布还原成"估计真实转化数"，供出价模型消费

const crypto = require('crypto');

const COARSE = { low: { min: 0, max: 2 }, medium: { min: 3, max: 5 }, high: { min: 6, max: 63 } };
const SKAN_PUBKEY_PEM = process.env.SKAN_PUBKEY_PEM || '';

let pool = null;
function attachPool(p) { pool = p; }
async function initTables() {
  if (!pool) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS skan_schema (
    id INT AUTO_INCREMENT PRIMARY KEY, campaign_id INT NOT NULL, version VARCHAR(8) DEFAULT '4.0',
    app_id VARCHAR(64) DEFAULT '', encoding VARCHAR(16) DEFAULT 'priority',
    events TEXT, coarse_thresholds TEXT, status VARCHAR(16) DEFAULT 'active',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uk_schema (campaign_id, version, app_id))`).catch(() => {});
  await pool.query(`ALTER TABLE skan_postback ADD COLUMN source_id VARCHAR(32) DEFAULT ''`).catch(() => {});
  await pool.query(`ALTER TABLE skan_postback ADD COLUMN verified TINYINT DEFAULT 0`).catch(() => {});
  await pool.query(`ALTER TABLE skan_postback ADD COLUMN decoded TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE skan_postback ADD COLUMN dedupe_key VARCHAR(80) DEFAULT ''`).catch(() => {});
  await pool.query(`ALTER TABLE skan_postback ADD UNIQUE KEY uk_dedupe (dedupe_key)`).catch(() => {});
}
function safeJson(s) { try { return JSON.parse(s); } catch (e) { return null; } }

// ───────── Schema 定义 ─────────
// events: [{name:'purchase', value:10, coarse:'high', priority:100}, ...]
async function defineSchema(campaignId, spec) {
  const s = {
    campaignId: Number(campaignId) || 0,
    version: spec.version || '4.0',
    appId: spec.appId || '',
    encoding: spec.encoding || 'priority',   // priority = 取优先级最高的事件；bitmap = 位打包
    events: (spec.events || []).map(e => ({
      name: e.name, value: Math.max(0, Math.min(63, Number(e.value) || 0)),
      coarse: e.coarse || 'low', priority: Number(e.priority || 0),
      valueMicros: Number(e.valueMicros || 0),
    })),
    coarseThresholds: spec.coarseThresholds || { low: 0, medium: 1000000, high: 10000000 }, // micros
  };
  if (pool) {
    await pool.query(`INSERT INTO skan_schema (campaign_id,version,app_id,encoding,events,coarse_thresholds)
      VALUES (?,?,?,?,?,?) ON DUPLICATE KEY UPDATE encoding=VALUES(encoding), events=VALUES(events),
      coarse_thresholds=VALUES(coarse_thresholds), status='active'`,
      [s.campaignId, s.version, s.appId, s.encoding, JSON.stringify(s.events), JSON.stringify(s.coarseThresholds)]);
    // 旧版本作废：同一 campaign 只允许一个版本生效，防止新旧编码混用导致数据不可比
    await pool.query(`UPDATE skan_schema SET status='deprecated' WHERE campaign_id=? AND version<>? AND app_id=?`,
      [s.campaignId, s.version, s.appId]).catch(() => {});
  }
  return s;
}
async function getSchema(campaignId, version = '4.0', appId = '') {
  if (!pool) return null;
  const [[r]] = await pool.query(
    `SELECT * FROM skan_schema WHERE campaign_id=? AND version=? AND app_id=? AND status='active' ORDER BY id DESC LIMIT 1`,
    [Number(campaignId), version, appId]);
  if (!r) return null;
  return { campaignId: r.campaign_id, version: r.version, appId: r.app_id, encoding: r.encoding, events: safeJson(r.events) || [], coarseThresholds: safeJson(r.coarse_thresholds) || {} };
}

// ───────── 编码 / 解码 ─────────
// priority 模式：取优先级最高的事件（简单、可解释，适合单目标优化）
// bitmap 模式：低 3 位 = 事件类型(0~7)，高 3 位 = 价值档(0~7)，一次回传表达两个维度
function encode(schema, occurred = []) {
  const evs = (schema.events || []).filter(e => occurred.includes(e.name));
  if (!evs.length) return { conversionValue: 0, coarse: 'low', events: [] };
  if (schema.encoding === 'bitmap') {
    const byName = new Map((schema.events || []).map(e => [e.name, e]));
    const top = evs.slice().sort((a, b) => (b.priority || 0) - (a.priority || 0))[0];
    const typeBits = Math.min(7, Number(top.value) || 0);
    const valueBits = Math.min(7, Math.round(Math.log2(Math.max(1, Number(top.valueMicros || 0) / 1000000))) || 0);
    return { conversionValue: typeBits | (valueBits << 3), coarse: top.coarse || 'low', events: [top.name] };
  }
  const top = evs.slice().sort((a, b) => (b.priority || 0) - (a.priority || 0))[0];
  return { conversionValue: Math.min(63, Number(top.value) || 0), coarse: top.coarse || 'low', events: [top.name] };
}
function decode(schema, payload) {
  const cv = payload.conversion_value == null ? null : Number(payload.conversion_value);
  const coarse = String(payload.coarse_value || '').toLowerCase();
  const out = { raw: cv, coarse, version: payload.version || payload.postback_version || '4.0', events: [], estimatedValueMicros: 0, fidelity: Number(payload.fidelity || 0) };
  if (cv == null || cv < 0) {
    // 只有 coarse（fidelity=1 时苹果只给粗粒度）→ 用阈值中值估计，必须标记为带噪
    const th = (schema && schema.coarseThresholds) || {};
    out.estimatedValueMicros = coarse === 'high' ? Number(th.high || 10000000) : coarse === 'medium' ? Number(th.medium || 1000000) : Number(th.low || 0);
    out.events = [coarse ? 'coarse_' + coarse : 'unknown'];
    out.noisy = true;
    return out;
  }
  if (schema && schema.events.length) {
    if (schema.encoding === 'bitmap') {
      const typeBits = cv & 7, valueBits = (cv >> 3) & 7;
      const e = schema.events.find(x => (Number(x.value) & 7) === typeBits);
      out.events = e ? [e.name] : [];
      out.estimatedValueMicros = e ? Number(e.valueMicros || 0) * Math.max(1, valueBits) : 0;
    } else {
      const e = schema.events.find(x => Number(x.value) === cv);
      out.events = e ? [e.name] : [];
      out.estimatedValueMicros = e ? Number(e.valueMicros || 0) : 0;
    }
  }
  // 噪声说明：fidelity=1 表示苹果返回的是粗粒度（低信息量），出价时应降权而不是当真
  out.noisy = Number(payload.fidelity) === 1 || cv == null;
  return out;
}

// ───────── 回传验签（Apple SKAN 4）─────────
// Apple 用 ECDSA-P256 对 postback JSON 原文签名；公钥从 Apple 提供的 endpoint 取（PEM）。
function verifyPostback(payloadJson, signatureB64, pem = SKAN_PUBKEY_PEM) {
  if (!pem) return { verified: false, reason: 'NO_PUBKEY', hint: '设置 SKAN_PUBKEY_PEM（Apple 提供的 P-256 公钥 PEM）' };
  try {
    const verifier = crypto.createVerify('SHA256');
    verifier.update(Buffer.from(payloadJson, 'utf8'));
    verifier.end();
    const ok = verifier.verify(pem, Buffer.from(String(signatureB64 || ''), 'base64'));
    return { verified: !!ok, reason: ok ? '' : 'BAD_SIGNATURE' };
  } catch (e) { return { verified: false, reason: 'VERIFY_ERROR:' + e.message }; }
}

// ───────── 回传接收：去重（SKAN 4 三个窗口）+ 解码 + 落库 ──────────
async function ingest(body, opts = {}) {
  const schema = opts.campaignId != null ? await getSchema(opts.campaignId, body.version || body.postback_version || '4.0', body.app_id || '') : null;
  const payloadJson = typeof body.payload === 'string' ? body.payload : JSON.stringify(body.payload || body);
  const v = opts.skipVerify ? { verified: false, reason: 'SKIPPED' } : verifyPostback(payloadJson, body.signature, opts.pem);
  const d = schema ? decode(schema, body) : { events: [], estimatedValueMicros: 0, version: body.version || '4.0', noisy: body.fidelity === 1 };
  // 去重键：同一 (source_id, campaign, app) 的多轮回传只保留信息量最高的一次
  const dedupeKey = [body.source_id || body.source_app || '', opts.campaignId || body.campaign_id || 0, body.app_id || ''].join('|');
  if (pool) {
    try {
      await pool.query(`INSERT INTO skan_postback (dsp_domain,campaign_id,source_app,source_id,postback_version,fidelity,
        conversion_value,coarse_value,payload,verified,decoded,dedupe_key)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
        ON DUPLICATE KEY UPDATE fidelity=VALUES(fidelity), conversion_value=VALUES(conversion_value),
          coarse_value=VALUES(coarse_value), verified=VALUES(verified), decoded=VALUES(decoded)`,
        [body.dsp_domain || '', Number(opts.campaignId || body.campaign_id) || 0, body.source_app || '', String(body.source_id || ''),
          body.version || body.postback_version || '4.0', Number(body.fidelity) || 0,
          body.conversion_value == null ? -1 : Number(body.conversion_value), String(body.coarse_value || ''),
          payloadJson.slice(0, 8000), v.verified ? 1 : 0, JSON.stringify(d), dedupeKey]);
    } catch (e) { /* 唯一键冲突 = 已去重，忽略 */ }
  }
  return { ok: true, verified: v.verified, reason: v.reason, decoded: d, dedupeKey };
}

// 聚合还原：把带噪声的 CV 分布还原成可用于出价的"估计转化数 / 估计价值"
async function aggregate({ campaignId, days = 7 } = {}) {
  if (!pool) return { ok: false, reason: 'NO_DB' };
  const [rows] = await pool.query(
    `SELECT conversion_value, coarse_value, fidelity, COUNT(*) n FROM skan_postback
     WHERE campaign_id=? AND created_at > NOW() - INTERVAL ? DAY GROUP BY conversion_value, coarse_value, fidelity`,
    [Number(campaignId) || 0, Number(days)]);
  const schema = await getSchema(campaignId);
  let estimatedConversions = 0, estimatedValueMicros = 0, n = 0, noisy = 0;
  for (const r of rows) {
    const c = Number(r.n);
    n += c;
    const d = schema ? decode(schema, r) : { estimatedValueMicros: 0 };
    estimatedValueMicros += Number(d.estimatedValueMicros || 0) * c;
    if (Number(r.fidelity) === 1 || Number(r.conversion_value) < 0) noisy += c;
    else estimatedConversions += c;
  }
  return {
    ok: true, campaignId, postbacks: n, estimated_conversions: estimatedConversions,
    estimated_value_micros: estimatedValueMicros, noisy_share: n ? +(noisy / n).toFixed(3) : 0,
    note: 'SKAN 为聚合+延迟+带噪数据，仅可作模型弱信号，不能替代确定性归因做实时优化',
  };
}

module.exports = {
  attachPool, initTables, defineSchema, getSchema, encode, decode,
  verifyPostback, ingest, aggregate, COARSE,
};
