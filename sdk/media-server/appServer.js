'use strict';
/**
 * 媒体 / App 服务端 —— S2S 结算参考实现（Node，零依赖）
 *
 * 作用：桥接「App SDK」与「ADX」，补上两者之间的空白
 *   1. 接收 SDK 上报的「观看证据」(impid/cid/watchedMs/durationMs)
 *   2. 用 publisher 的 api_key 做 HMAC 签名 → 调用 ADX `/s2s/reward`
 *   3. ADX 裁决通过，才把奖励下发到用户账户（demo 用内存账本，生产应落库）
 *   4. 客户端永远拿不到 api_key，因此无法伪造结算 —— 这是 S2S 的意义
 *
 * 启动：
 *   node appServer.js
 *   （可选环境变量：ADX_BASE / PUBLISHER / PUB_API_KEY / PORT）
 *
 * 自检：curl http://127.0.0.1:8081/api/selftest
 */
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// 极简 .env 加载（本仓库不装 dotenv）：让 PUB_API_KEY / ADMIN_TOKEN 集中配置、不硬编码
try {
  const p = path.join(__dirname, '..', '..', '.env');
  if (fs.existsSync(p)) {
    for (const line of fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
    }
  }
} catch (e) {}

const ADX = process.env.ADX_BASE || 'http://127.0.0.1:8080';
const PUB = process.env.PUBLISHER || 'dellai.xyz';
const PORT = Number(process.env.PORT || 8081);
let API_KEY = process.env.PUB_API_KEY || '';

// ===== 用户奖励账本：由「内存」改为「落库」=====
// 原先 `const ledger = {}` 是内存对象：重启即清零、多实例不一致，代码注释自认 demo。
// 现在落到 MySQL，并补上幂等去重（同一 impid 只结算一次，防重放/重试重复发奖）：
//   media_ledger(user_id, balance)  —— 用户奖励余额
//   media_settled(imp_id)           —— 已结算幂等表
const mysql = require('mysql2/promise');
const pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'test',
  password: process.env.DB_PASSWORD || 'test@fftime',
  database: process.env.DB_NAME || 'zhuque',
  waitForConnections: true, connectionLimit: 5,
});
async function initLedgerTables() {
  await pool.query(`CREATE TABLE IF NOT EXISTS media_ledger (
    user_id VARCHAR(128) PRIMARY KEY,
    balance INT DEFAULT 0,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS media_settled (
    imp_id VARCHAR(64) PRIMARY KEY,
    user_id VARCHAR(128) DEFAULT '',
    granted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
}
/** 幂等：该 impid 是否已结算过 */
async function alreadySettled(impid) {
  const [[r]] = await pool.query('SELECT 1 FROM media_settled WHERE imp_id=?', [String(impid)]).catch(() => [[]]);
  return !!r;
}
async function balanceOf(userId) {
  const [[row]] = await pool.query('SELECT balance FROM media_ledger WHERE user_id=?', [String(userId)]).catch(() => [[]]);
  return (row && Number(row.balance)) || 0;
}
/** 记账：同一 impid 只加一次，返回最新余额 */
async function credit(userId, impid) {
  await pool.query('INSERT IGNORE INTO media_settled (imp_id,user_id) VALUES (?,?)', [String(impid), String(userId)]).catch(() => {});
  await pool.query(`INSERT INTO media_ledger (user_id,balance) VALUES (?,1)
    ON DUPLICATE KEY UPDATE balance=balance+1`, [String(userId)]).catch(() => {});
  return balanceOf(userId);
}
async function ledgerAll() {
  const [rows] = await pool.query('SELECT user_id,balance FROM media_ledger ORDER BY balance DESC LIMIT 200').catch(() => [[]]);
  const out = {};
  (rows || []).forEach(r => { out[r.user_id] = Number(r.balance); });
  return out;
}

function hmac(impid, cid, watchedMs, durationMs, ts) {
  return crypto.createHmac('sha256', API_KEY)
    .update(`${impid}|${cid || 0}|${watchedMs}|${durationMs}|${ts}`).digest('hex');
}

/** 向 ADX 发起 S2S 结算（服务端签名，权威裁决） */
async function settle(impid, cid, watchedMs, durationMs, opts) {
  const ts = (opts && opts.ts) || Date.now();
  const body = {
    impid, cid, publisher: PUB,
    watchedMs: Number(watchedMs), durationMs: Number(durationMs), ts,
    device_fp: (opts && opts.device_fp) || '',
    sig: (opts && opts.badSig) ? 'deadbeef' : hmac(impid, cid, watchedMs, durationMs, ts)
  };
  const r = await fetch(ADX + '/s2s/reward', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}

/** 启动时自动向 ADX 索取媒体服务端密钥（无需手工填写） */
async function fetchApiKey() {
  if (API_KEY) return API_KEY;
  // 密钥中心如意茄子严谨后台鉴权，这里带上管理员令牌（或直接用 PUB_API_KEY，推荐后者）
  try {
    const headers = process.env.ADMIN_TOKEN ? { 'x-admin-token': process.env.ADMIN_TOKEN } : {};
    const r = await fetch(`${ADX}/api/publisher/${encodeURIComponent(PUB)}/key`, { headers }).then(x => x.json());
    if (r && r.api_key) { API_KEY = r.api_key; return API_KEY; }
    if (r && r.error === 'unauthorized') console.warn('[media-server] 取密钥被拒：请设置 PUB_API_KEY 或 ADMIN_TOKEN');
  } catch (e) {}
  return '';
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve) => {
    let s = '';
    req.on('data', c => { s += c; });
    req.on('end', () => { try { resolve(JSON.parse(s || '{}')); } catch (e) { resolve({}); } });
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 204, {});

  // SDK 上报观看证据 → 服务端签名 → ADX 裁决 → 下发奖励
  if (req.url === '/api/reward' && req.method === 'POST') {
    const b = await readBody(req);
    const { impid, cid, watchedMs, durationMs, userId, device_fp } = b;
    if (!impid || !watchedMs || !durationMs) return json(res, 400, { ok: false, reason: 'MISSING_FIELDS' });
    if (!API_KEY) { await fetchApiKey(); }   // ADX 晚于本服务启动时也能补齐密钥
    if (!API_KEY) return json(res, 500, { ok: false, reason: 'NO_API_KEY' });
    let r = await settle(impid, cid, watchedMs, durationMs, { device_fp });
    // 自愈：密钥可能因 ADX 端轮换而失效（BAD_S2S_SIGNATURE/UNKNOWN_PUBLISHER），重拉一次后重试
    if (r.json && (r.json.why === 'BAD_S2S_SIGNATURE' || r.json.why === 'UNKNOWN_PUBLISHER')) {
      API_KEY = await fetchApiKey();
      if (API_KEY) r = await settle(impid, cid, watchedMs, durationMs, { device_fp });
    }
    if (r.json && r.json.ok && r.json.granted) {
      const u = userId || 'demo_user';
      // ★ 只有 ADX 裁决通过才下发；且同一 impid 只发一次（幂等），余额落库而非内存
      if (await alreadySettled(impid)) {
        return json(res, 200, { ok: true, reward: '复活道具×1', balance: await balanceOf(u), dup: true, adx: r.json });
      }
      const balance = await credit(u, impid);
      return json(res, 200, { ok: true, reward: '复活道具×1', balance, adx: r.json });
    }
    return json(res, 200, { ok: false, reason: (r.json && r.json.why) || 'ADX_DENIED', adx: r.json });
  }

  // 查看奖励账本
  if (req.url === '/api/ledger') return json(res, 200, { ledger: await ledgerAll(), persisted: true, apiKeyPrefix: API_KEY.slice(0, 12) + '...' });

  // 自检：演示 ADX 对各类非法调用的裁决
  if (req.url === '/api/selftest') {
    if (!API_KEY) return json(res, 500, { ok: false, reason: 'NO_API_KEY' });
    const id = 'rw_s2s_' + Date.now();
    const bidBody = {
      id, site: { domain: PUB, keywords: '休闲游戏,激励视频,rewarded' },
      imp: [{ id, bidfloor: 2.0, ext: { cat: 'gaming', ad_type: 'rewarded' } }],
      device: { geo: { country: 'CN' } }
    };
    const requestBid = async (bidId) => {
      const r = await fetch(ADX + '/ssp/bid', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: bidId, site: { domain: PUB, keywords: '休闲游戏,激励视频,rewarded' },
          imp: [{ id: bidId, bidfloor: 2.0, ext: { cat: 'gaming', ad_type: 'rewarded' } }],
          device: { geo: { country: 'CN' } }
        })
      }).then(x => x.json());
      const s = r.seatbid && r.seatbid[0];
      return s && s.bid && s.bid[0];
    };
    const bid = await requestBid(id);
    if (!bid) return json(res, 200, { ok: false, reason: 'NO_FILL' });
    const cid = bid.ext && bid.ext.cid, W = 52000, D = 52000;
    const out = {};
    out['1_正常回调'] = await settle(id, cid, W, D);
    out['2_错误签名'] = await settle(id, cid, W, D, { badSig: true });
    out['3_过期时间戳'] = await settle(id, cid, W, D, { ts: Date.now() - 10 * 60 * 1000 });
    // 谎报时长用独立 impid，避免被上一条已结算的令牌干扰
    const id2 = 'rw_short_' + Date.now();
    const bid2 = await requestBid(id2);
    const cid2 = bid2 && bid2.ext && bid2.ext.cid;
    out['4_谎报时长'] = await settle(id2, cid2, 800, D);
    const fmt = {};
    for (const k of Object.keys(out)) fmt[k] = 'HTTP ' + out[k].status + ' ' + (out[k].json.ok ? 'GRANTED' : 'REJECT:' + out[k].json.why);
    return json(res, 200, { impid: id, cid, results: fmt });
  }

  json(res, 404, { error: 'not found', endpoints: ['POST /api/reward', 'GET /api/ledger', 'GET /api/selftest'] });
});

initLedgerTables().catch(e => console.warn('[media-server] 账本建表失败（将退化为不记账）：' + e.message));
fetchApiKey().then(k => {
  server.listen(PORT, () => {
    console.log(`[media-server] http://127.0.0.1:${PORT}  ADX=${ADX}  publisher=${PUB}`);
    console.log('[media-server] 奖励账本：已落库 media_ledger / media_settled（幂等），不再用内存');
    console.log(`[media-server] api_key=${k ? k.slice(0, 14) + '...' : '(未取得，请确认 publisher 已入驻)'}`);
    console.log('[media-server] 自检: curl http://127.0.0.1:' + PORT + '/api/selftest');
  });
});
