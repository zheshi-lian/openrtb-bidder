// anticheat.js —— 反作弊：设备/IP 去重 + Bot 检测 + 点击欺诈 + 黑名单
//
// 为什么单独一个模块：
//   pacing.freqAllow 只解决"一个 campaign 对同一设备不要超投"（广告主诉求），
//   但解决不了"一台设备 24h 被全站广告刷爆"（平台健康诉求），
//   也解决不了"一台服务器/IP 用上千个伪造 device_id 批量拉量"（反作弊诉求）。
//   这里做平台级的流量质量门禁：黑名单 → bot 信号 → 频率异常 → 曝光上限，
//   判定成本必须低（缓存快路径 + 内存降级），命中才落日志。
//
// 判定分三档：block（直接拒标）/ warn（放行但打标）/ pass（正常）
// 可解释性：每条拦截带 reason code + detail，管理面可查 anticheat_event。

const cache = require('./cache');

let pool = null;
function attachPool(p) { pool = p; }

async function initTables() {
  if (!pool) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS anticheat_event (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    device_id VARCHAR(80) DEFAULT '',
    ip VARCHAR(64) DEFAULT '',
    publisher VARCHAR(128) DEFAULT '',
    campaign_id INT DEFAULT 0,
    reason VARCHAR(32) NOT NULL,
    action VARCHAR(8) NOT NULL DEFAULT 'block',
    detail VARCHAR(255) DEFAULT '',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    KEY idx_device (device_id),
    KEY idx_ip (ip),
    KEY idx_reason_time (reason, created_at)
  )`).catch(() => {});

  await pool.query(`CREATE TABLE IF NOT EXISTS anticheat_blacklist (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    kind VARCHAR(8) NOT NULL COMMENT 'device / ip',
    value VARCHAR(80) NOT NULL,
    reason VARCHAR(128) DEFAULT '',
    auto TINYINT DEFAULT 0 COMMENT '1=自动拉黑',
    created_by VARCHAR(64) DEFAULT '',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uk_kind_value (kind, value)
  )`).catch(() => {});

  await pool.query(`CREATE TABLE IF NOT EXISTS anticheat_config (
    \`key\` VARCHAR(48) PRIMARY KEY,
    value VARCHAR(128) NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  )`).catch(() => {});

  const defaults = {
    enabled: '1', deviceImprMax24h: '500', ipReqsMax24h: '5000', ipReqsMax1m: '120',
    deviceReqsMax1m: '30', clickImprRatioMax: '2.0', clickMinGapMs: '500',
    autoBlacklist: '0', autoBlacklistThreshold: '5', botSignalBlockCount: '2', warnMode: '1',
  };
  for (const [k, v] of Object.entries(defaults)) {
    await pool.query('INSERT IGNORE INTO anticheat_config (`key`, value) VALUES (?,?)', [k, v]).catch(() => {});
  }
}

// ───────── 配置加载（带内存缓存） ─────────
const cfgCache = new Map();
const CFG_TTL = 30 * 1000;

async function cfg(key, def) {
  const now = Date.now();
  const c = cfgCache.get(key);
  if (c && c.ts > now - CFG_TTL) return c.v;
  let v = String(def);
  if (pool) {
    try {
      const [rows] = await pool.query('SELECT value FROM anticheat_config WHERE `key`=?', [key]);
      if (rows[0] && rows[0].value != null) v = String(rows[0].value);
    } catch (e) {}
  }
  cfgCache.set(key, { ts: now, v });
  return v;
}

async function cfgNum(key, def) {
  const s = await cfg(key, def);
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? n : Number(def);
}

async function cfgBool(key, def) {
  const s = await cfg(key, def ? '1' : '0');
  return s === '1' || s === 'true' || s === 'yes';
}

function cfgBust(key) { if (key) cfgCache.delete(key); else cfgCache.clear(); }

// ───────── 计数器（cache + 内存降级，与 pacing.freqHit 同模式） ─────────
const memCount = new Map();

async function countHit(key, ttlMs) {
  const ckey = 'ac:' + key;
  const prev = Number(await cache.get(ckey).catch(() => null));
  if (prev != null && !Number.isNaN(prev)) {
    await cache.set(ckey, prev + 1, ttlMs).catch(() => {});
    return prev + 1;
  }
  const now = Date.now();
  const m = memCount.get(ckey);
  const n = (m && m.exp > now ? m.n : 0) + 1;
  memCount.set(ckey, { n, exp: now + ttlMs });
  if (memCount.size > 200000) {
    for (const [k, v] of memCount) if (v.exp <= now) memCount.delete(k);
  }
  return n;
}

async function countGet(key) {
  const ckey = 'ac:' + key;
  const v = await cache.get(ckey).catch(() => null);
  if (v != null) return Number(v) || 0;
  return 0;
}

async function countSet(key, val, ttlMs) {
  const ckey = 'ac:' + key;
  await cache.set(ckey, val, ttlMs).catch(() => {});
}

// ───────── 事件日志（异步，不阻塞热路径） ─────────
async function logEvent(ev) {
  if (!pool) return;
  try {
    await pool.query(
      'INSERT INTO anticheat_event (device_id, ip, publisher, campaign_id, reason, action, detail) VALUES (?,?,?,?,?,?,?)',
      [
        String(ev.device_id || '').slice(0, 80),
        String(ev.ip || '').slice(0, 64),
        String(ev.publisher || '').slice(0, 128),
        Number(ev.campaign_id) || 0,
        String(ev.reason || '').slice(0, 32),
        ev.action === 'warn' ? 'warn' : 'block',
        String(ev.detail || '').slice(0, 255),
      ]
    );
  } catch (e) {}
}

// ───────── 黑名单（带内存缓存） ─────────
const blCache = new Map();
const BL_TTL = 10000;

async function isBlacklisted(kind, value) {
  if (!value) return false;
  const key = kind + ':' + value;
  const c = blCache.get(key);
  if (c && c.ts > Date.now() - BL_TTL) return c.v;
  let hit = false;
  if (pool) {
    try {
      const [rows] = await pool.query(
        'SELECT id FROM anticheat_blacklist WHERE kind=? AND value=? LIMIT 1', [kind, value]
      );
      hit = rows.length > 0;
    } catch (e) {}
  }
  blCache.set(key, { ts: Date.now(), v: hit });
  return hit;
}

function blBust(kind, value) { if (kind && value) blCache.delete(kind + ':' + value); else blCache.clear(); }

// ───────── Bot 信号检测 ─────────
const BOT_UA_PATTERNS = ['bot', 'crawler', 'spider', 'python-requests', 'curl', 'wget',
  'headless', 'phantomjs', 'selenium', 'playwright', 'scrapy', 'java/', 'go-http-client',
  'libwww', 'axtls', 'masscan', 'zgrab'];

const SUSPICIOUS_DEVICE_IDS = ['test', '0', '00000000-0000-0000-0000-000000000000',
  'ffffffff-ffff-ffff-ffff-ffffffffffff', 'device_id', 'unknown'];

function detectBotSignals(ctx) {
  const reasons = [];
  const ua = String(ctx.ua || '').trim().toLowerCase();
  const d = ctx.device || {};
  const ip = String(ctx.ip || '').trim();
  const devId = String(ctx.deviceId || '').trim().toLowerCase();

  if (!d.ua && !ua) reasons.push({ code: 'BOT_SIG_NO_UA', detail: 'no user-agent' });
  if (!d.os) reasons.push({ code: 'BOT_SIG_NO_OS', detail: 'no os' });
  if (!d.w || Number(d.w) === 0) reasons.push({ code: 'BOT_SIG_NO_SIZE', detail: 'no device size' });

  const botHits = BOT_UA_PATTERNS.filter(k => ua.includes(k));
  if (botHits.length) reasons.push({ code: 'BOT_SIG_UA', detail: 'ua matched: ' + botHits.slice(0, 3).join(',') });

  if (!ip || ip === 'unknown' || ip === '::1' || ip === '::ffff:127.0.0.1' || ip === '127.0.0.1') {
    reasons.push({ code: 'BOT_SIG_INVALID_IP', detail: 'ip=' + ip });
  }

  if (SUSPICIOUS_DEVICE_IDS.includes(devId)) {
    reasons.push({ code: 'BOT_SIG_SUSPECT_ID', detail: 'suspicious device_id: ' + devId });
  }

  return reasons;
}

// ───────── 竞价热路径主检查 ─────────
async function check(ctx) {
  const enabled = await cfgBool('enabled', true);
  if (!enabled) return { ok: true };

  const devId = String(ctx.deviceId || '').trim();
  const ip = String(ctx.ip || '').trim().slice(0, 64);
  const reasons = [];
  let blocked = false;

  // 1. 黑名单
  if (await isBlacklisted('device', devId)) {
    reasons.push({ code: 'BLACKLIST_DEVICE', severity: 'block', detail: 'device blacklisted' });
    blocked = true;
  }
  if (await isBlacklisted('ip', ip)) {
    reasons.push({ code: 'BLACKLIST_IP', severity: 'block', detail: 'ip blacklisted' });
    blocked = true;
  }
  if (blocked) return { ok: false, reasons, detail: 'blacklisted' };

  // 2. Bot 信号检测
  const botReasons = detectBotSignals(ctx);
  const botBlockCount = await cfgNum('botSignalBlockCount', 2);
  if (botReasons.length >= botBlockCount) {
    reasons.push(...botReasons.map(r => ({ ...r, severity: 'block' })));
    blocked = true;
  } else if (botReasons.length > 0) {
    reasons.push(...botReasons.map(r => ({ ...r, severity: 'warn' })));
  }
  if (blocked) return { ok: false, reasons, detail: 'bot signals >= ' + botBlockCount };

  // 3. IP 频率检测
  if (ip) {
    const ipReqs1m = await countHit('ip1m:' + ip, 60 * 1000);
    const ipReqsMax1m = await cfgNum('ipReqsMax1m', 120);
    if (ipReqs1m > ipReqsMax1m) {
      reasons.push({ code: 'IP_FREQ_1M', severity: 'block', detail: 'ip 1m reqs=' + ipReqs1m + ' > ' + ipReqsMax1m });
      blocked = true;
    }
    const ipReqs24h = await countHit('ip24h:' + ip, 24 * 3600 * 1000);
    const ipReqsMax24h = await cfgNum('ipReqsMax24h', 5000);
    if (ipReqs24h > ipReqsMax24h) {
      reasons.push({ code: 'IP_FREQ_24H', severity: 'block', detail: 'ip 24h reqs=' + ipReqs24h + ' > ' + ipReqsMax24h });
      blocked = true;
    }
  }

  // 4. Device 频率检测
  if (devId) {
    const devReqs1m = await countHit('dev1m:' + devId, 60 * 1000);
    const devReqsMax1m = await cfgNum('deviceReqsMax1m', 30);
    if (devReqs1m > devReqsMax1m) {
      reasons.push({ code: 'DEVICE_FREQ_1M', severity: 'block', detail: 'device 1m reqs=' + devReqs1m + ' > ' + devReqsMax1m });
      blocked = true;
    }
  }

  // 5. 设备 24h 曝光上限
  if (devId) {
    const devImpr24h = await countGet('impr24h:' + devId);
    const devImprMax24h = await cfgNum('deviceImprMax24h', 500);
    if (devImpr24h >= devImprMax24h) {
      reasons.push({ code: 'DEVICE_IMPR_MAX', severity: 'block', detail: 'device 24h imps=' + devImpr24h + ' >= ' + devImprMax24h });
      blocked = true;
    }
  }

  if (blocked) return { ok: false, reasons, detail: 'anticheat blocked' };
  return { ok: true, reasons };
}

// ───────── 曝光观察 ─────────
async function observeImpression(devId) {
  if (!devId) return;
  const prev = await countGet('impr24h:' + devId);
  await countSet('impr24h:' + devId, prev + 1, 24 * 3600 * 1000);
}

// ───────── 点击观察 ─────────
async function observeClick(devId, ip, impTs) {
  if (!devId) return { ok: true };
  const reasons = [];
  let blocked = false;

  const clickCount = await countHit('click24h:' + devId, 24 * 3600 * 1000);
  const imprCount = await countGet('impr24h:' + devId);
  const ratioMax = await cfgNum('clickImprRatioMax', 2.0);
  if (imprCount > 0 && clickCount / imprCount > ratioMax) {
    reasons.push({ code: 'CLICK_FARM_RATIO', severity: 'block', detail: 'click/imp=' + (clickCount / imprCount).toFixed(2) + ' > ' + ratioMax });
    blocked = true;
  }

  const clickMinGap = await cfgNum('clickMinGapMs', 500);
  if (impTs && clickMinGap > 0) {
    const gap = Date.now() - impTs;
    if (gap < clickMinGap) {
      reasons.push({ code: 'CLICK_TOO_FAST', severity: 'block', detail: 'gap=' + gap + 'ms < ' + clickMinGap + 'ms' });
      blocked = true;
    }
  }

  if (blocked) {
    const autoBL = await cfgBool('autoBlacklist', false);
    if (autoBL) {
      const threshold = await cfgNum('autoBlacklistThreshold', 5);
      const blockCount = await countHit('block24h:' + devId, 24 * 3600 * 1000);
      if (blockCount >= threshold && !(await isBlacklisted('device', devId))) {
        await blacklistAdd('device', devId, 'auto: click fraud (block count=' + blockCount + ')', true, 'system');
      }
    }
  }

  return { ok: !blocked, reasons };
}

// ───────── 自动拉黑计数 ─────────
async function recordBlock(devId, ip) {
  if (devId) {
    const prev = await countGet('block24h:' + devId);
    await countSet('block24h:' + devId, prev + 1, 24 * 3600 * 1000);
  }
  if (ip) {
    const prev = await countGet('ipblock24h:' + ip);
    await countSet('ipblock24h:' + ip, prev + 1, 24 * 3600 * 1000);
  }
}

// ───────── 黑名单管理 ─────────
async function blacklistAdd(kind, value, reason, auto, createdBy) {
  if (!pool) return { ok: false, error: 'no db' };
  kind = String(kind).trim().toLowerCase();
  value = String(value).trim();
  if (kind !== 'device' && kind !== 'ip') return { ok: false, error: 'invalid kind' };
  if (!value) return { ok: false, error: 'empty value' };
  try {
    await pool.query(
      'INSERT INTO anticheat_blacklist (kind, value, reason, auto, created_by) VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE reason=VALUES(reason), auto=VALUES(auto), created_by=VALUES(created_by)',
      [kind, value, String(reason || '').slice(0, 128), auto ? 1 : 0, String(createdBy || '').slice(0, 64)]
    );
    blBust(kind, value);
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}

async function blacklistRemove(kind, value) {
  if (!pool) return { ok: false, error: 'no db' };
  kind = String(kind).trim().toLowerCase();
  value = String(value).trim();
  try {
    await pool.query('DELETE FROM anticheat_blacklist WHERE kind=? AND value=?', [kind, value]);
    blBust(kind, value);
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}

async function blacklistList() {
  if (!pool) return { ok: false, error: 'no db', items: [] };
  try {
    const [rows] = await pool.query(
      'SELECT id, kind, value, reason, auto, created_by, created_at FROM anticheat_blacklist ORDER BY created_at DESC LIMIT 500'
    );
    return { ok: true, items: rows };
  } catch (e) { return { ok: false, error: e.message, items: [] }; }
}

// ───────── 配置管理 ─────────
async function getConfig() {
  if (!pool) return {};
  try {
    const [rows] = await pool.query('SELECT `key`, value, updated_at FROM anticheat_config ORDER BY `key`');
    const obj = {};
    for (const r of rows) obj[r.key] = r.value;
    return obj;
  } catch (e) { return {}; }
}

async function setConfig(key, value) {
  if (!pool) return { ok: false };
  try {
    await pool.query(
      'INSERT INTO anticheat_config (`key`, value) VALUES (?,?) ON DUPLICATE KEY UPDATE value=VALUES(value)',
      [String(key), String(value)]
    );
    cfgBust(key);
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}

// ───────── 统计 ─────────
async function stats() {
  if (!pool) return { backend: cache.redisReady() ? 'redis' : 'memory' };
  const result = { backend: cache.redisReady() ? 'redis' : 'memory' };

  try {
    const [rows] = await pool.query(
      `SELECT reason, COUNT(*) n, MAX(created_at) last_seen
       FROM anticheat_event WHERE created_at >= NOW() - INTERVAL 1 DAY AND action='block'
       GROUP BY reason ORDER BY n DESC`
    );
    result.byReason = rows;
    result.blocked24h = rows.reduce((s, r) => s + Number(r.n), 0);
  } catch (e) { result.byReason = []; result.blocked24h = 0; }

  try {
    const [rows] = await pool.query(
      `SELECT COUNT(*) n FROM anticheat_event WHERE created_at >= NOW() - INTERVAL 1 DAY AND action='warn'`
    );
    result.warned24h = rows[0] ? Number(rows[0].n) : 0;
  } catch (e) { result.warned24h = 0; }

  try {
    const [rows] = await pool.query(
      `SELECT kind, COUNT(*) n FROM anticheat_blacklist GROUP BY kind`
    );
    result.blacklistCount = {};
    for (const r of rows) result.blacklistCount[r.kind] = Number(r.n);
  } catch (e) { result.blacklistCount = {}; }

  result.config = await getConfig();
  return result;
}

// ───────── 事件列表（分页） ─────────
async function eventList(page, pageSize, filter) {
  if (!pool) return { ok: false, error: 'no db', items: [] };
  pageSize = Math.min(Math.max(Number(pageSize) || 50, 10), 500);
  const offset = (Math.max(Number(page) || 1, 1) - 1) * pageSize;
  try {
    let where = 'WHERE created_at >= NOW() - INTERVAL 7 DAY';
    const params = [];
    if (filter && filter.action) { where += ' AND action=?'; params.push(String(filter.action)); }
    if (filter && filter.reason) { where += ' AND reason=?'; params.push(String(filter.reason)); }
    if (filter && filter.device_id) { where += ' AND device_id=?'; params.push(String(filter.device_id)); }
    if (filter && filter.ip) { where += ' AND ip=?'; params.push(String(filter.ip)); }

    const [countRows] = await pool.query(
      'SELECT COUNT(*) total FROM anticheat_event ' + where, params
    );
    const [rows] = await pool.query(
      'SELECT id, device_id, ip, publisher, campaign_id, reason, action, detail, created_at ' +
      'FROM anticheat_event ' + where + ' ORDER BY created_at DESC LIMIT ? OFFSET ?',
      [...params, pageSize, offset]
    );
    return { ok: true, total: Number(countRows[0] ? countRows[0].total : 0), items: rows };
  } catch (e) { return { ok: false, error: e.message, items: [] }; }
}

module.exports = {
  attachPool, initTables,
  check, observeImpression, observeClick, recordBlock,
  logEvent,
  blacklistAdd, blacklistRemove, blacklistList,
  getConfig, setConfig, cfgBust,
  stats, eventList,
};