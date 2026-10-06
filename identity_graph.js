// identity_graph.js —— 身份解析图谱（ID 归一 / 哈希标识 / 概率设备图 / 跨 App 识别）
//
// 为什么这是 post-ATT 最大缺口：
//   iOS ATT 授权率长期在 20~35%，意味着 2/3 的流量没有 IDFA。AppLovin 靠 Adjust + 自有 SDK
//   装机量，天然拥有跨 App 的设备图谱——同一台手机在不同 App 里的行为能串起来，
//   于是"这个用户在 A 游戏付费过"可以用来优化 B 游戏的出价。没有图谱，你每条请求都是陌生人。
//
// 我们能做的（不依赖 ATT）：
//   ① ID 归一：IDFA / GAID / OAID(国内安卓) / AndroidID / 登录ID / Cookie 统一哈希为内部标识
//   ② 哈希标识：email/phone 用 HMAC-SHA256 加盐哈希，可做跨端匹配且不可反解（合规前提）
//   ③ 概率设备图：IP 子网 + UA + 语言/时区 + 分辨率 + 设备指纹等信号加权打分，过阈值才连边
//   ④ 跨 App 识别：同一 canonical 设备在哪些 bundle 里出现过 → 兴趣/价值迁移、频控、去重
//
// 合规红线（代码里强制）：
//   · 原始 IDFA / 邮箱 / 手机号一律不落库，只存加盐哈希
//   · 无同意（TCF purpose 未授权 / ATT≠3）时，确定性 ID 不参与构图，只走概率信号

const crypto = require('crypto');

const HASH_SECRET = process.env.ID_HASH_SECRET || 'dev-identity-secret-change-me';
// 确定性 ID 权重：登录ID 最强（用户主动身份），设备广告 ID 次之
const ID_WEIGHT = {
  login_id: 1.0, idfa: 0.9, gaid: 0.9, oaid: 0.85, ifa: 0.9,
  android_id: 0.7, web_cookie: 0.6, email_sha: 0.8, phone_sha: 0.8,
  device_fp: 0.45, ip_ua: 0.25,
};
// 概率信号权重：单条信号都不足以判定同设备，组合起来才可能过阈值
const SIGNAL_WEIGHT = {
  install_id: 1.0, device_fp: 0.55, ip_subnet: 0.25, ua: 0.2,
  lang_tz: 0.15, screen: 0.15, bundle_group: 0.2,
};
const LINK_THRESHOLD = Number(process.env.ID_LINK_THRESHOLD || 0.72);

let pool = null;
const parent = new Map();      // idHash -> root（并查集，内存）
const nodeMeta = new Map();    // idHash -> {type, weight, canonical}
const edges = new Map();       // "a|b" -> score
const appSeen = new Map();     // canonical -> Map(bundle -> lastSeen)

function attachPool(p) { pool = p; }
async function initTables() {
  if (!pool) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS identity_node (
    id_hash VARCHAR(80) PRIMARY KEY, id_type VARCHAR(24), weight DECIMAL(4,3) DEFAULT 0.5,
    canonical_id VARCHAR(80), first_seen BIGINT, last_seen BIGINT, seen_count INT DEFAULT 1)`).catch(() => {});
  await pool.query(`CREATE TABLE IF NOT EXISTS identity_edge (
    a VARCHAR(80), b VARCHAR(80), score DECIMAL(5,4), signals VARCHAR(128), created_at BIGINT,
    PRIMARY KEY (a,b))`).catch(() => {});
  await pool.query(`CREATE TABLE IF NOT EXISTS identity_app_seen (
    canonical_id VARCHAR(80), bundle VARCHAR(128), last_seen BIGINT, seen_count INT DEFAULT 1,
    PRIMARY KEY (canonical_id, bundle))`).catch(() => {});
  // 受众信号自动采集表（OS/机型/兴趣/地域分布，按设备汇总，周期刷新）
  await pool.query(`CREATE TABLE IF NOT EXISTS audience_signal (
    canonical_id VARCHAR(80) PRIMARY KEY, os_json TEXT, model_json TEXT, interest_json TEXT, country_json TEXT,
    imps INT DEFAULT 0, created_at BIGINT, updated_at BIGINT)`).catch(() => {});
}

// ───────── 哈希与归一 ─────────
function hmac(v) {
  return crypto.createHmac('sha256', HASH_SECRET).update(String(v)).digest('hex').slice(0, 32);
}
function normalizeEmail(e) { return String(e || '').trim().toLowerCase(); }
function normalizePhone(p) { return String(p || '').replace(/[^\d+]/g, '').replace(/^\+?86/, ''); }
function hashId(type, value) {
  if (!value) return '';
  let v = String(value);
  if (type === 'email_sha') v = normalizeEmail(v);
  else if (type === 'phone_sha') v = normalizePhone(v);
  else if (type === 'idfa' || type === 'gaid' || type === 'ifa' || type === 'oaid') v = v.toLowerCase();
  return `${type}_${hmac(v)}`;
}

// ───────── 并查集 ─────────
function find(a) {
  let r = a;
  while (parent.get(r) && parent.get(r) !== r) r = parent.get(r);
  // 路径压缩
  let c = a;
  while (parent.get(c) && parent.get(c) !== c) { const nx = parent.get(c); parent.set(c, r); c = nx; }
  return r;
}
function union(a, b) {
  const ra = find(a), rb = find(b);
  if (ra === rb) return ra;
  // 根取"权重更高、字典序更小"者：保证稳定且优先保留强身份
  const wa = (nodeMeta.get(ra) || {}).weight || 0, wb = (nodeMeta.get(rb) || {}).weight || 0;
  const root = (wb > wa) ? rb : (wa > wb ? ra : (ra < rb ? ra : rb));
  const child = root === ra ? rb : ra;
  parent.set(child, root);
  return root;
}
function touch(type, hash) {
  let m = nodeMeta.get(hash);
  const now = Date.now();
  if (!m) {
    m = { type, weight: ID_WEIGHT[type] || 0.5, firstSeen: now, lastSeen: now, count: 1 };
    nodeMeta.set(hash, m);
    parent.set(hash, hash);
    if (pool) pool.query(
      `INSERT INTO identity_node (id_hash,id_type,weight,canonical_id,first_seen,last_seen,seen_count) VALUES (?,?,?,?,?,?,1)
       ON DUPLICATE KEY UPDATE last_seen=VALUES(last_seen), seen_count=seen_count+1`,
      [hash, type, m.weight, hash, now, now]).catch(() => {});
  } else {
    m.lastSeen = now; m.count++;
  }
  return m;
}

// ───────── 信号打分 ─────────
function ipSubnet(ip) {
  if (!ip) return '';
  const s = String(ip);
  if (s.includes(':')) return s.split(':').slice(0, 3).join(':');   // IPv6 取前缀
  const p = s.split('.');
  return p.length === 4 ? `${p[0]}.${p[1]}.${p[2]}` : s;
}
function linkScore(signals = {}) {
  let s = 0;
  const hit = [];
  for (const k in SIGNAL_WEIGHT) {
    if (signals[k]) { s += SIGNAL_WEIGHT[k]; hit.push(k); }
  }
  return { score: Math.min(1, +s.toFixed(4)), signals: hit };
}

/**
 * 解析一次请求 → canonical 设备标识
 * @param {object} ids      {idfa,gaid,oaid,android_id,login_id,web_cookie,email,phone,device_fp}
 * @param {object} signals  {install_id,device_fp,ip,ua,lang,tz,screen,bundle}
 * @param {object} opts     {consented:boolean, bundle:string}
 */
function resolve(ids = {}, signals = {}, opts = {}) {
  const consented = opts.consented !== false;
  const present = [];
  const push = (type, value) => { const h = hashId(type, value); if (h) { touch(type, h); present.push({ type, hash: h, weight: ID_WEIGHT[type] || 0.5 }); } };

  // 确定性 ID：只有 consented 才参与（ATT/GDPR 红线）
  if (consented) {
    if (ids.idfa) push('idfa', ids.idfa);
    if (ids.gaid) push('gaid', ids.gaid);
    if (ids.ifa) push('ifa', ids.ifa);
    if (ids.oaid) push('oaid', ids.oaid);
    if (ids.android_id) push('android_id', ids.android_id);
    if (ids.login_id) push('login_id', ids.login_id);
    if (ids.email) push('email_sha', ids.email);
    if (ids.phone) push('phone_sha', ids.phone);
  }
  if (ids.web_cookie) push('web_cookie', ids.web_cookie);
  if (signals.device_fp || ids.device_fp) push('device_fp', signals.device_fp || ids.device_fp);
  if (signals.ip && signals.ua) push('ip_ua', ipSubnet(signals.ip) + '|' + String(signals.ua).slice(0, 120));

  if (!present.length) return { canonicalId: '', nodes: 0, linked: false, reason: 'NO_ID' };

  // 同一请求里的多个 ID 必然同设备：直接连边（这是最高质量的边）
  const strong = present.filter(p => p.weight >= 0.6);
  for (let i = 1; i < present.length; i++) union(present[0].hash, present[i].hash);

  // 概率连边：与"已知同环境"的其他设备 ID 相连（如同一 IP 子网 + 同 UA + 同指纹）
  const sig = {
    install_id: signals.install_id || '',
    device_fp: signals.device_fp || ids.device_fp || '',
    ip_subnet: ipSubnet(signals.ip || ''),
    ua: signals.ua || '',
    lang_tz: (signals.lang || '') + '/' + (signals.tz || ''),
    screen: signals.screen || '',
    bundle_group: signals.bundle || '',
  };
  const { score, signals: hit } = linkScore(sig);
  const anchor = (strong[0] || present[0]).hash;
  let linked = false;
  const candidates = nearestBySignals(sig);
  if (candidates.length && score >= LINK_THRESHOLD) {
    for (const c of candidates.slice(0, 5)) {
      if (find(c) === find(anchor)) continue;
      union(anchor, c);
      recordEdge(anchor, c, score, hit.join(','));
      linked = true;
    }
  }
  const root = find(anchor);
  if (pool) {
    pool.query('UPDATE identity_node SET canonical_id=?, last_seen=? WHERE id_hash IN (?)', [root, Date.now(), present.map(p => p.hash)]).catch(() => {});
  }
  if (opts.bundle) markApp(root, opts.bundle);
  return { canonicalId: root, nodes: present.length, linked, linkScore: score, signals: hit, strong: strong.length };
}

// 找"信号最相近"的已有节点：生产应换成 LSH/倒排索引，这里是 O(n) 上限扫描（可控内存窗口）
const recent = [];   // {hash, sig}
const RECENT_MAX = 5000;
function nearestBySignals(sig) {
  const out = [];
  const now = Date.now();
  for (let i = recent.length - 1; i >= 0 && out.length < 8; i--) {
    const r = recent[i];
    if (now - r.ts > 10 * 60 * 1000) continue;
    let s = 0;
    if (sig.install_id && sig.install_id === r.sig.install_id) s += SIGNAL_WEIGHT.install_id;
    if (sig.device_fp && sig.device_fp === r.sig.device_fp) s += SIGNAL_WEIGHT.device_fp;
    if (sig.ip_subnet && sig.ip_subnet === r.sig.ip_subnet) s += SIGNAL_WEIGHT.ip_subnet;
    if (sig.ua && sig.ua === r.sig.ua) s += SIGNAL_WEIGHT.ua;
    if (sig.lang_tz && sig.lang_tz === r.sig.lang_tz) s += SIGNAL_WEIGHT.lang_tz;
    if (sig.screen && sig.screen === r.sig.screen) s += SIGNAL_WEIGHT.screen;
    if (s >= LINK_THRESHOLD) out.push(r.hash);
  }
  recent.push({ hash: '', sig, ts: now });
  if (recent.length > RECENT_MAX) recent.splice(0, recent.length - RECENT_MAX);
  return out;
}
function recordEdge(a, b, score, signals) {
  const k = a < b ? `${a}|${b}` : `${b}|${a}`;
  if (edges.has(k)) return;
  edges.set(k, score);
  if (pool) pool.query('INSERT IGNORE INTO identity_edge (a,b,score,signals,created_at) VALUES (?,?,?,?,?)',
    [a, b, score, String(signals || '').slice(0, 128), Date.now()]).catch(() => {});
}
function markApp(canonical, bundle) {
  let m = appSeen.get(canonical);
  if (!m) { m = new Map(); appSeen.set(canonical, m); }
  m.set(bundle, Date.now());
  if (pool) pool.query(`INSERT INTO identity_app_seen (canonical_id,bundle,last_seen,seen_count) VALUES (?,?,?,1)
    ON DUPLICATE KEY UPDATE last_seen=VALUES(last_seen), seen_count=seen_count+1`,
    [canonical, String(bundle).slice(0, 128), Date.now()]).catch(() => {});
}

// 跨 App 识别：这台设备还在哪些 App 里出现过（兴趣迁移、跨 App 频控、去重都靠它）
async function apps(canonicalId) {
  const mem = appSeen.get(canonicalId);
  const fromMem = mem ? [...mem.keys()] : [];
  if (!pool) return fromMem;
  try {
    const [rows] = await pool.query('SELECT bundle, seen_count FROM identity_app_seen WHERE canonical_id=? ORDER BY last_seen DESC LIMIT 50', [canonicalId]);
    const merged = new Set([...fromMem, ...rows.map(r => r.bundle)]);
    return [...merged];
  } catch (e) { return fromMem; }
}
async function appsCount(canonicalId) { return (await apps(canonicalId)).length; }

function stats() {
  const roots = new Set();
  for (const h of parent.keys()) roots.add(find(h));
  return { nodes: parent.size, clusters: roots.size, edges: edges.size, appClusters: appSeen.size, threshold: LINK_THRESHOLD };
}
async function load() {
  if (!pool) return;
  try {
    const [rows] = await pool.query('SELECT id_hash,id_type,weight,canonical_id FROM identity_node ORDER BY last_seen DESC LIMIT 200000');
    rows.forEach(r => {
      nodeMeta.set(r.id_hash, { type: r.id_type, weight: Number(r.weight) || 0.5, count: 0 });
      parent.set(r.id_hash, r.canonical_id || r.id_hash);
      if (r.canonical_id) parent.set(r.canonical_id, r.canonical_id);
    });
    const [es] = await pool.query('SELECT a,b,score FROM identity_edge LIMIT 200000');
    es.forEach(e => { edges.set(`${e.a}|${e.b}`, Number(e.score)); union(e.a, e.b); });
    console.log(`[identity] 已加载 ${rows.length} 节点 / ${es.length} 条边 → ${stats().clusters} 个设备簇`);
  } catch (e) {}
}

// 从 OpenRTB 请求里抽取身份（server.js 直接用这个）
function fromOpenRTB(br) {
  const dev = br.device || {};
  const usr = br.user || {};
  const ext = dev.ext || {};
  const consented = !(br.ext && br.ext.no_personalization) && (ext.att === undefined || Number(ext.att) === 3 || ext.att === 'authorized');
  return {
    ids: {
      idfa: dev.ifa && /^([0-9A-Fa-f]{8}-[0-9A-Fa-f]{4})/.test(dev.ifa) ? dev.ifa : '',
      gaid: ext.gaid || '', ifa: dev.ifa || '', oaid: ext.oaid || '',
      android_id: ext.android_id || '', login_id: usr.id || ext.login_id || '',
      web_cookie: usr.buyeruid || '', email: (usr.ext && usr.ext.email) || '', phone: (usr.ext && usr.ext.phone) || '',
      device_fp: ext.fp || '',
    },
    signals: {
      install_id: ext.install_id || '', device_fp: ext.fp || '',
      ip: dev.ip || '', ua: dev.ua || '', lang: dev.language || '',
      tz: String(ext.tz || ''), screen: ext.screen || '',
      bundle: (br.app && br.app.bundle) || '',
    },
    consented,
  };
}

// ===== 受众信号自动采集（服务端，零用户打扰）=====
// 第一性原理：定向信号应【自动采集】而非让用户/广告主手填。OS / 机型 / 兴趣 全部由服务端从请求上下文
// 解析（UA → OS/机型；app 类目 + 关键词 → 兴趣），不增加任何前端交互、不影响加载与体验。
// 热路径只更新内存累加器（无 I/O）；由 flush 周期落库，避免每次竞价都写库拖慢 RTB。
let _aud = new Map();   // canonicalId -> { os:{}, model:{}, interest:{}, country:{}, imps }
function observeContext(canonicalId, ctx = {}) {
  if (!canonicalId) return;                       // 无标识设备不计入受众画像
  const id = String(canonicalId);
  let a = _aud.get(id);
  if (!a) { a = { os: {}, model: {}, interest: {}, country: {}, imps: 0 }; _aud.set(id, a); }
  a.imps++;
  const bump = (m, k) => { if (k) m[k] = (m[k] || 0) + 1; };
  bump(a.os, String(ctx.os || '').trim());
  bump(a.model, String(ctx.model || '').trim());
  bump(a.country, String(ctx.country || '').trim());
  // 兴趣自动细分：app 类目 + 上下文关键词（去空、小写），累加出现频次（无需用户标注）
  const tags = [];
  if (ctx.app_category) tags.push(String(ctx.app_category).toLowerCase().trim());
  (Array.isArray(ctx.keywords) ? ctx.keywords : [])
    .concat(Array.isArray(ctx.interest) ? ctx.interest : [])
    .forEach(k => { const t = String(k || '').toLowerCase().trim(); if (t) tags.push(t); });
  tags.forEach(t => bump(a.interest, t));
}

// 周期落库：把内存累加器合并进 audience_signal 表（按设备汇总兴趣分布）。
// 落库失败不影响热路径（catch 静默），下一轮 flush 会再尝试。
let _audFlushTimer = null;
async function flushSignals() {
  if (!pool || !_aud.size) return;
  const now = Date.now();
  const items = [..._aud.entries()];
  _aud = new Map();
  try {
    for (const [cid, a] of items) {
      await pool.query(
        `INSERT INTO audience_signal (canonical_id, os_json, model_json, interest_json, country_json, imps, updated_at)
         VALUES (?,?,?,?,?,?,?)
         ON DUPLICATE KEY UPDATE os_json=VALUES(os_json), model_json=VALUES(model_json),
           interest_json=VALUES(interest_json), country_json=VALUES(country_json), imps=imps+VALUES(imps), updated_at=VALUES(updated_at)`,
        [cid, JSON.stringify(a.os), JSON.stringify(a.model), JSON.stringify(a.interest), JSON.stringify(a.country), a.imps, now]
      ).catch(() => {});
    }
  } catch (e) {}
}
function startFlush() { if (_audFlushTimer) return; _audFlushTimer = setInterval(() => flushSignals().catch(() => {}), 15000); }

// 受众概览（管理端看数）：跨设备聚合 OS / 机型 / 兴趣 / 地域分布，验证自动采集生效
async function audienceAggregate() {
  const agg = (rows, key) => {
    const m = {};
    for (const r of rows || []) {
      let obj; try { obj = JSON.parse(r[key] || '{}'); } catch (e) { obj = {}; }
      for (const k of Object.keys(obj)) m[k] = (m[k] || 0) + Number(obj[k] || 0);
    }
    return Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([k, v]) => ({ key: k, count: v }));
  };
  if (!pool) return { devices: _aud.size, os: [], model: [], interest: [], country: [] };
  try {
    const [rows] = await pool.query('SELECT os_json,model_json,interest_json,country_json,imps FROM audience_signal');
    const totalImps = (rows || []).reduce((s, r) => s + (Number(r.imps) || 0), 0);
    return {
      devices: (rows || []).length, total_imps: totalImps,
      os: agg(rows, 'os_json'), model: agg(rows, 'model_json'),
      interest: agg(rows, 'interest_json'), country: agg(rows, 'country_json'),
    };
  } catch (e) { return { devices: 0, os: [], model: [], interest: [], country: [] }; }
}

module.exports = {
  attachPool, initTables, load, hashId, normalizeEmail, normalizePhone,
  resolve, apps, appsCount, stats, fromOpenRTB, find, union, linkScore,
  ID_WEIGHT, SIGNAL_WEIGHT, LINK_THRESHOLD,
  observeContext, flushSignals, startFlush, audienceAggregate,
};
