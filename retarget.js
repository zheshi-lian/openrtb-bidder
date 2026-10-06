// retarget.js —— 受众分群 / 再营销（设备级）
//
// 为什么单独一个模块：再营销的最小闭环是「哪些设备见过这个广告主的广告」。
// bid_win_log 出于隐私只落聚合维度、没有设备标识，所以这里用「内存累加器 + 周期落库」
// 维护 advertiser→canonical设备 的活跃池（与 pacing.freqMem / identity._aud 同一套零 I/O 模式）：
//   · 竞价热路径命中广告时调 observeExposure() 记一笔（只更新内存，无 I/O、不拖慢 RTB）
//   · 广告主把计划设为「再营销」时，竞价侧用 inPool() 判断本设备是否在池中，不在池→不参竞
//   · startFlush() 周期把池子落 campaign_retarget_pool 表，供持久化与规模统计
//
// 合规：只存 canonical_id（identity_graph 里已加盐哈希的设备标识），不存原始 IDFA/邮箱/手机号。
// 跨 worker 一致性：竞价是多进程 cluster（4 worker），进程内 Map 不共享 → 记录曝光的 worker 与
// 后续再营销竞价命中的 worker 可能不同。因此写入时同步一份到共享 cache(Redis)，读取时先走内存
// 快路径、未命中再回落共享 cache，保证「任何 worker 看到过曝光的设备都能被再营销命中」。

const cache = require('./cache');

let pool = null;
function attachPool(p) { pool = p; }

async function initTables() {
  if (!pool) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS campaign_retarget_pool (
    advertiser VARCHAR(128) NOT NULL,
    canonical_id VARCHAR(80) NOT NULL,
    last_seen BIGINT,
    imps INT DEFAULT 1,
    PRIMARY KEY (advertiser, canonical_id)
  )`).catch(() => {});
}

// 内存：advertiser -> Map(canonicalId -> lastSeenTs)
const mem = new Map();
// Lookalike 种子画像：advertiser -> {os:{}, country:{}}（由 observeExposure 自动采集）
const seed = new Map();

function keyOf(adv, cid) { return 'rt:' + adv + ':' + cid; }

// 记录一次命中（曝光）到该广告主的再营销池：内存 + 共享 cache(Redis)
function observeExposure(advertiser, campaignId, canonicalId, traits) {
  const adv = String(advertiser || '').trim();
  const cid = String(canonicalId || '').trim();
  if (!adv || !cid) return;                 // 无广告主/无设备标识不进入池
  let m = mem.get(adv);
  if (!m) { m = new Map(); mem.set(adv, m); }
  const now = Date.now();
  m.set(cid, now);
  // 共享一份到 Redis（跨 worker 可见）；存 30 天 TTL，读取时再按各计划的 windowDays 判定
  cache.set(keyOf(adv, cid), now, 30 * 86400000).catch(() => {});
  // Lookalike 种子画像：记录池内设备的 OS / 地域构成（服务端自动采集，零用户打扰）
  const t = traits || {};
  let s = seed.get(adv);
  if (!s) { s = { os: {}, country: {} }; seed.set(adv, s); }
  const os = String(t.os || '').trim().toLowerCase(), co = String(t.country || '').trim().toUpperCase();
  if (os) s.os[os] = (s.os[os] || 0) + 1;
  if (co) s.country[co] = (s.country[co] || 0) + 1;
}

// Lookalike（相似人群）：目标不是"看过广告的人"，而是"与看过广告的人画像相似的新设备"。
// 用池内设备的 OS/地域主流构成当种子，新设备只要命中种子的主导 OS 且（地域一致或池无地域）即视为相似。
function lookalikeMatch(advertiser, os, country) {
  const adv = String(advertiser || '').trim();
  const s = seed.get(adv);
  if (!s) return false;
  const osKeys = Object.keys(s.os);
  if (!osKeys.length) return false;
  const myOs = String(os || '').trim().toLowerCase();
  if (myOs && !s.os[myOs]) return false;                 // OS 不在种子画像里 → 不相似
  const coKeys = Object.keys(s.country);
  if (coKeys.length) {
    const myCo = String(country || '').trim().toUpperCase();
    if (myCo && !s.country[myCo]) return false;          // 地域也不在种子里 → 不相似
  }
  return true;
}

// 本设备是否在该广告主的再营销池内（windowDays 内见过其广告）。
// 内存快路径优先；未命中回落共享 cache(Redis)，实现跨 worker 命中。
async function inPool(advertiser, canonicalId, windowDays) {
  const adv = String(advertiser || '').trim();
  const cid = String(canonicalId || '').trim();
  if (!adv || !cid) return false;
  const win = (Number(windowDays) > 0 ? Number(windowDays) : 7) * 86400000;
  const m = mem.get(adv);
  if (m) { const ts = m.get(cid); if (ts && (Date.now() - ts) <= win) return true; }
  try {
    const v = await cache.get(keyOf(adv, cid));
    if (v && (Date.now() - Number(v)) <= win) {
      let mm = mem.get(adv); if (!mm) { mm = new Map(); mem.set(adv, mm); }
      mm.set(cid, Number(v));
      return true;
    }
  } catch (e) {}
  return false;
}

function poolSize(advertiser) {
  const m = mem.get(String(advertiser || '').trim());
  return m ? m.size : 0;
}

// 周期落库（fire-and-forget，失败静默，下轮重试）
async function flush() {
  if (!pool || !mem.size) return;
  const now = Date.now();
  const snapshot = [...mem.entries()].map(([adv, m]) => ({ adv, entries: [...m.entries()] }));
  mem.clear();
  for (const { adv, entries } of snapshot) {
    for (const [cid, ts] of entries) {
      await pool.query(
        `INSERT INTO campaign_retarget_pool (advertiser, canonical_id, last_seen, imps)
         VALUES (?,?,?,1)
         ON DUPLICATE KEY UPDATE last_seen=VALUES(last_seen), imps=imps+1`,
        [adv, cid, ts]
      ).catch(() => {});
    }
  }
}

let _timer = null;
function startFlush() { if (_timer) return; _timer = setInterval(() => flush().catch(() => {}), 15000); }

// 池规模（内存 + 库），供广告主后台展示「我的再营销受众池」
async function poolStats(advertiser) {
  const adv = String(advertiser || '').trim();
  const memSize = poolSize(adv);
  let dbSize = 0;
  if (pool && adv) {
    try { const [[r]] = await pool.query('SELECT COUNT(*) c FROM campaign_retarget_pool WHERE advertiser=?', [adv]); dbSize = Number(r && r.c) || 0; }
    catch (e) { dbSize = 0; }
  }
  return { advertiser: adv, in_memory: memSize, persisted: dbSize };
}

module.exports = { attachPool, initTables, observeExposure, inPool, lookalikeMatch, poolSize, flush, startFlush, poolStats };
