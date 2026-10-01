// 程序化广告平台原型 v2 —— 供给端(SSP) + 需求端(DSP) + 意图匹配(inten>eCPM) + 双边账本
const express = require('express');
const mysql = require('mysql2/promise');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const llm = require('./llm');
const cache = require('./cache'); // 可降级缓存(Redis可选) + 指标采集
const ecpm = require('./ecpm_engine'); // eCPM' 引擎（对齐 BP_v7 §2.6）
const bidModel = require('./bid_model'); // 在线转化预测（数据驱动出价）
const creativeAb = require('./creative_ab'); // P1 创意 A/B 多版本 + Thompson Sampling 自动优选
const ksDSP = require('./sdk/kuaishou-dsp/adapter'); // 快手磁力引擎 开放平台 · DSP/买量侧 适配脚手架
const security = require('./security'); // 生产化安全基线：密钥/鉴权/审计/CORS

// ===== 补齐 AppLovin 差距的新增能力层（Tier 0 生产化 + Tier 1 技术竞争力）=====
const trust = require('./trust');            // ads.txt / app-ads.txt / sellers.json 信任层
const pacing = require('./pacing');          // 时段投放 + 频控 + 流量曲线 pace + 预算感知出价
const billing = require('./billing');        // 账户/账期/账单/发票/收款/账龄
const brandSafety = require('./brand_safety'); // IAB 分类 + GARM 分级 + pre-bid 屏蔽 + 验证厂商
const identity = require('./identity_graph'); // 身份解析图谱（post-ATT 设备图）
const attribution = require('./attribution'); // 多触点归因 + 浏览归因 + SKAN + 增量实验
const creativeAuto = require('./creative');  // 可玩广告 / DCO / 静图转视频 / 多语言
const ml = require('./ml');                  // 特征平台 + 多目标 pLTV + 校准 + Bandit + 注册监控
const neuralBridge = require('./ml/neural_bridge');  // 离线预训练权重(含阿里妈妈 CVR 头)接入在线出价，门控且默认回落 LR
const bidEng = require('./bid');             // 胜率模型 + bid shading + 限流 + deadline
const metrics = require('./metrics');        // p50/p95/p99 分位数 + QPS + SLO

const app = express();
app.use(express.json({ limit: '1mb' }));

// 安全响应头 + CORS 分区：第三方 SDK 可跨域调竞价/上报；管理面仅白名单域
app.use(security.secureCors);

// ===== 后台鉴权：本机经隧道公网可达(dellai.xyz)，管理面必须鉴权 =====
// 注意：必须早于业务路由注册，否则会先命中 handler 而绕过鉴权
const ADMIN_PREFIXES = [
  '/report', '/ssp/report', '/api/report', '/api/reports', '/api/attribution',
  // 注意：/api/creatives(素材库) 由其路由自身用 requireAuth('admin','advertiser') 保护，
  // 不放进管理员前缀——否则前缀 requireAdmin 会先于路由执行、把广告主自己挡在素材库外。
  '/api/dsp', '/api/demand-partners', '/api/console', '/api/ecpm',
  '/api/reward/log', '/metrics',
  // 新增能力面：经营与身份数据一律不得匿名访问
  '/api/billing', '/api/trust', '/api/incrementality', '/api/ml',
  '/api/creative-auto', '/api/pacing', '/api/identity', '/api/brand-safety', '/api/bid'
];
ADMIN_PREFIXES.forEach(p => app.use(p, security.requireAdmin('admin')));

// 管理员登录：交换 httpOnly cookie，使现有 dashboard 页面无需改造即可通过鉴权
// 接受三种凭据：① 旧版静态 ADMIN_TOKEN ② 账号体系签发的作用域令牌 ③（仅 token 换 cookie）
// 修掉原缺陷：identify() 只认静态令牌，账号体系令牌被拒 → 账号密码登录后此处写 cookie 返回 401，
//   导致依赖 adm cookie 的旧 dashboard 页面在「账号密码登录」后仍然 401。现补上 verifyToken() 校验。
app.post('/api/admin/login', (req, res) => {
  const t = String((req.body || {}).token || '');
  const valid = t && (security.identify({ headers: { authorization: 'Bearer ' + t } }) || security.verifyToken(t) !== null);
  if (valid) {
    // Secure 仅在实际 HTTPS 连接下下发：本地 HTTP 演示时若带 Secure，浏览器会拒绝随请求回传该 cookie，导致登录永远失效、管理页全 401
    const isHttps = req.secure || String(req.headers['x-forwarded-proto'] || '').split(',').map(s => s.trim()).includes('https');
    res.setHeader('Set-Cookie', `adm=${encodeURIComponent(t)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=86400` + (isHttps ? '; Secure' : ''));
    return res.json({ ok: true });
  }
  security.logAudit(req, 'LOGIN_FAIL', '', '');
  res.status(401).json({ error: 'bad token' });
});
app.post('/api/admin/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'adm=; HttpOnly; Path=/; Max-Age=0');
  res.json({ ok: true });
});

// ===== 三方账号体系：注册 / 登录 / 作用域令牌（对标 AppLovin 三套独立后台）=====
// 仅管理员可注册租客账号（广告主/媒体/子管理员），用于运营给客户开通与演示
app.post('/api/account/register', security.requireAuth('admin'), async (req, res) => {
  const { type, username, password, scope, display } = req.body || {};
  if (!['admin', 'advertiser', 'publisher'].includes(type)) return res.status(400).json({ error: 'type 必须是 admin/advertiser/publisher' });
  if (!username || !password) return res.status(400).json({ error: 'username,password required' });
  if (String(password).length < 6) return res.status(400).json({ error: 'password 至少 6 位' });
  let sc = (scope || '').toString().trim();
  if (type === 'advertiser' && !sc) return res.status(400).json({ error: 'advertiser 账号需指定 scope=广告主名称' });
  if (type === 'publisher' && !sc) return res.status(400).json({ error: 'publisher 账号需指定 scope=媒体域名' });
  if (type === 'admin') sc = '*';
  try {
    const [[dup]] = await pool.query('SELECT id FROM accounts WHERE username=?', [username]);
    if (dup) return res.status(409).json({ error: '用户名已存在' });
    await pool.query('INSERT INTO accounts (type,username,pass_hash,scope,display,created_by) VALUES (?,?,?,?,?,?)',
      [type, username, security.hashPwd(password), sc, display || username, (req.account && req.account.u) || 'system']);
    res.json({ ok: true, type, username, scope: sc });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── 登录防爆破（对标 AppLovin/Trade Desk：失败 N 次锁定）──
// 按 (出口IP | 用户名小写) 计数：5 次失败锁定 15 分钟。内存态、不落敏感日志、重启清零；
// 单实例足够演示与中小规模使用，多实例请改为 Redis（现有 redisadx 可直接复用）。
const _loginFails = new Map();
function _loginKey(ip, username) { return (ip || '?') + '|' + String(username || '').toLowerCase(); }
function loginGuard(ip, username) {
  const k = _loginKey(ip, username), now = Date.now();
  const rec = _loginFails.get(k) || { n: 0, until: 0 };
  if (rec.until > now) return { lock: true, wait: Math.ceil((rec.until - now) / 1000) };
  rec.n += 1;
  if (rec.n >= 5) { rec.until = now + 15 * 60 * 1000; rec.n = 0; return { lock: true, wait: 15 * 60 }; }
  _loginFails.set(k, rec);
  return { lock: false, tries: rec.n };
}
function loginReset(ip, username) { _loginFails.delete(_loginKey(ip, username)); }
setInterval(() => { const now = Date.now(); for (const [k, v] of _loginFails) if (v.until < now - 30 * 60 * 1000) _loginFails.delete(k); }, 30 * 60 * 1000).unref();

app.post('/api/account/login', async (req, res) => {
  const { username, password } = req.body || {};
  const ip = String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
  if (!username || !password) return res.status(400).json({ error: 'username,password required' });
  const g = loginGuard(ip, username);
  if (g.lock) {
    security.logAudit(req, 'LOGIN_LOCKED', String(username), '');
    return res.status(429).json({ error: '尝试次数过多，请稍后再试', wait: g.wait });
  }
  try {
    const [[a]] = await pool.query('SELECT * FROM accounts WHERE username=?', [username]);
    if (!a || a.status !== 1 || security.hashPwd(password) !== a.pass_hash) {
      security.logAudit(req, 'LOGIN_FAIL', String(username), '');
      return res.status(401).json({ error: '用户名或密码错误' });
    }
    loginReset(ip, username);
    const token = security.issueToken({ username: a.username, type: a.type, scope: a.scope });
    res.json({ ok: true, token, type: a.type, scope: a.scope, username: a.username, display: a.display });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 当前登录账号信息
app.get('/api/account/me', security.requireAuth(), async (req, res) => {
  res.json({ username: req.account.u, type: req.account.t, scope: req.account.s });
});

// 管理员查看所有账号（租客清单）
app.get('/api/accounts', security.requireAuth('admin'), async (_, res) => {
  try { const [rows] = await pool.query('SELECT id,type,username,scope,display,status,created_by,created_at FROM accounts ORDER BY id DESC'); res.json(rows); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// 广告主自助开户（公开，对标 AppLovin 自助投放平台）：注册独立账号 + 作用域
// 与媒体入驻同理——注册即开通独立账号，登录后仅看自己作用域
app.post('/api/signup/advertiser', async (req, res) => {
  const { username, password, advertiser, display } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'username,password required' });
  if (String(password).length < 6) return res.status(400).json({ error: 'password 至少 6 位' });
  const scope = (advertiser || username).toString().trim();
  if (!scope) return res.status(400).json({ error: 'advertiser(作用域) 必填' });
  try {
    const [[dup]] = await pool.query('SELECT id FROM accounts WHERE username=?', [username]);
    if (dup) return res.status(409).json({ error: '用户名已存在' });
    await pool.query('INSERT INTO accounts (type,username,pass_hash,scope,display,created_by) VALUES (?,?,?,?,?,?)',
      ['advertiser', username, security.hashPwd(password), scope, display || scope, 'self-signup']);
    const token = security.issueToken({ username, type: 'advertiser', scope });
    res.json({ ok: true, username, scope, token, account: { username, password }, note: '已开通广告主独立账号，可直接登录广告主后台（advertiser.html）' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 管理员用户名+密码登录统一走 /api/account/login（seed 的 admin 账号 type=admin，scope=*）；
// 旧式静态令牌 → cookie 由上方 /api/admin/login 处理（现已同时接受账号体系签发的作用域令牌）。
// 原有的第二个 /api/admin/login（username/password 分支）因被第一个同名路由完全遮蔽而不可达，已删除。
const PORT = process.env.PORT || 8080;

// 健康检查端点：浏览器/监控直接 GET 即可确认服务与隧道全链路通
app.get('/health', (_, res) => res.json({ ok: true, ts: Date.now() }));

// 反向代理：把 /ms/* 转发到媒体服务端(默认 8081)，便于只暴露 8080 一个端口上公网
// 公网演示时浏览器只连 ADX 域名，媒体结算请求经此代理转发，无需再暴露第二个端口。
const MEDIA_SERVER = process.env.MEDIA_SERVER || 'http://127.0.0.1:8081';
const httpFwd = require('http');
app.use('/ms', (req, res) => {
  const target = MEDIA_SERVER + req.url; // req.url 已去掉 /ms 前缀，如 /api/reward
  const payload = ['POST', 'PUT', 'PATCH'].includes(req.method) ? JSON.stringify(req.body || {}) : null;
  const r = httpFwd.request(target, {
    method: req.method,
    headers: Object.assign({}, req.headers, payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {})
  }, (resp) => {
    res.status(resp.statusCode);
    Object.keys(resp.headers).forEach(h => { if (h.toLowerCase() !== 'transfer-encoding') res.setHeader(h, resp.headers[h]); });
    resp.pipe(res);
  });
  r.on('error', (e) => res.status(502).json({ ok: false, error: 'media_server_unreachable', detail: String(e) }));
  if (payload) r.write(payload);
  r.end();
});

const pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'test',
  password: process.env.DB_PASSWORD || 'test@fftime',
  database: process.env.DB_NAME || 'zhuque',
  connectionLimit: 20
});

const AUCTION = { secondPrice: true }; // 二价拍卖：胜出者付次高价+0.01元

// 管理员操作审计管道：鉴权中间件落库（含被拒绝的未授权访问）
security.attachAudit(async (req, action, target, detail) => {
  await pool.query('INSERT INTO admin_audit (actor,action,target,detail,ip) VALUES (?,?,?,?,?)',
    [String(req.admin || 'anonymous').slice(0, 64), String(action).slice(0, 64), String(target).slice(0, 255), String(detail).slice(0, 255), String(req.ip || '').slice(0, 64)]).catch(() => {});
});

// 需求方(DSP)注册表：可经 /ssp/demand 动态添加外部 DSP
// 保留「自有」需求方 zhuque-dsp + 两个外部演示需求方，
// 竞价引擎（二价/eCPM'/意图匹配/deadline）原样保留，供演示多需求方拍卖。
// 注：快手磁力引擎(kuaishou-dsp)已从公开投放链路移除——其模拟创意不应出现在对外落地页；
//     如需在管理台单独演示磁力引擎买量，可经 /api/demand/kuaishou/* 调用，不影响公开页面。
let DEMAND_PARTNERS = [
  { name: 'zhuque-dsp', type: 'http', url: `http://127.0.0.1:${PORT}/openrtb2/bid`, payoutRate: 0.70, isOwn: true },
  { name: 'external-dsp-A', type: 'mock', priceMicros: 4000000, payoutRate: 0.65, isOwn: false, adm: '<div style="padding:10px;background:#e67e22;color:#fff">外部DSP-A 演示广告</div>', crid: 'ext-a' },
  { name: 'external-dsp-B', type: 'mock', priceMicros: 4500000, payoutRate: 0.60, isOwn: false, adm: '<div style="padding:10px;background:#27ae60;color:#fff">外部DSP-B 演示广告</div>', crid: 'ext-b' }
];

// SSP 账本（内存；生产落 ssp_pub_ledger）
const sspLedger = { wins: 0, grossMicros: 0, payoutMicros: 0 };
const pubLedger = {}; // publisher(domain) -> {wins,grossMicros,payoutMicros,clicks,conversions}
const pubFloor = new Map(); // publisher -> 近期清盘价 EMA（P1 动态底价）
function recordSsp(gross, payout, publisher) {
  sspLedger.wins++; sspLedger.grossMicros += gross; sspLedger.payoutMicros += payout;
  const prev = pubFloor.get(publisher); pubFloor.set(publisher, prev ? prev * 0.8 + gross * 0.2 : gross);
  const p = pubLedger[publisher] = pubLedger[publisher] || { wins: 0, grossMicros: 0, payoutMicros: 0, clicks: 0, conversions: 0 };
  p.wins++; p.grossMicros += gross; p.payoutMicros += payout;
}

// ===== 反作弊：内存限流 + 回传校验工具 =====
const rlMap = new Map(); // ip -> [timestamp,...]
function rateHit(ip, limit = 60, win = 1000) {
  const t = Date.now(); const a = (rlMap.get(ip) || []).filter(x => t - x < win); a.push(t); rlMap.set(ip, a);
  return a.length > limit; // 单 IP 1 秒内超 60 次请求即限流
}

// ===== 激励视频：服务端完播校验（一次性签名令牌）=====
// 前端 SDK 无法自证"完播"，必须由服务端签发令牌并校验后才发放奖励，否则可被伪造刷量。
// 生产环境密钥必须通过环境变量注入，切勿硬编码。
const RW_SECRET = security.RW_SECRET;
const RW_TTL_MS = 5 * 60 * 1000;   // 令牌有效期 5 分钟
const RW_MIN_RATIO = 0.95;         // 完播阈值：观看时长占比 ≥95%
const RW_MAX_RATIO = 1.5;          // 观看时长不可能超过视频时长的 1.5 倍（防伪造时长）

// ===== 设备指纹层：S2S 仍挡不住"多设备构造真实播放"，故在结算侧加设备级风控 =====
// 设备指纹由 SDK/客户端计算并随竞价与结算一并上报；服务端做两件事：
//   1) 令牌与 device_fp 绑定：跨设备重放同一令牌直接拒绝（比单纯 impid 单次更抗农场化）
//   2) 设备级速率/异常检测：同一指纹在窗口内领奖超阈值，判为 DEVICE_FP_RATE_LIMIT（设备农场嫌疑）
const FP_MAX = 30;                 // 单设备 10 分钟内最多结算次数
const FP_WIN_MS = 10 * 60 * 1000;
const fpGrants = new Map();        // device_fp -> [timestamp,...]
function fpRisk(fp) {
  if (!fp) return { ok: true, count: 0 };
  const t = Date.now();
  const a = (fpGrants.get(fp) || []).filter(x => t - x < FP_WIN_MS);
  a.push(t); fpGrants.set(fp, a);
  if (a.length > FP_MAX) return { ok: false, reason: 'DEVICE_FP_RATE_LIMIT', count: a.length };
  return { ok: true, count: a.length };
}

// ===== OMID / 可见性测量：VAST 4.0 标配 AdVerifications，反作弊加分项 =====
// 真实 OMID 由播放器加载 Verification 中的 JavaScriptResource（omsdk）做可见性度量；
// 这里给出本地演示用的 shim（public/omid-session.js），做几何可见性并回传 /vast/omid。
const OMID_JS = process.env.OMID_JS || 'http://127.0.0.1:8080/omid-session.js';

// ===== 多广告形态：插屏 / 开屏 / 原生 / icon / push =====
const AD_FORMATS = ['banner', 'rewarded', 'interstitial', 'splash', 'native', 'icon', 'push'];
const ICON_SVG = 'data:image/svg+xml;utf8,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120">' +
  '<rect width="120" height="120" rx="24" fill="#2563eb"/>' +
  '<text x="60" y="74" font-size="42" text-anchor="middle" fill="#fff">AD</text></svg>');

function buildNative(o) {
  return {
    title: o.title || '原生广告标题',
    body: o.body || '原生广告描述，样式完全由 App 自行渲染',
    icon: ICON_SVG, image: ICON_SVG, cta: '立即下载',
    clickUrl: `${PUBLIC_BASE}/ssp/click?cid=${o.cid}&imp=${o.impid}&pub=${encodeURIComponent(o.publisher || '')}`,
    impTrackers: [`${PUBLIC_BASE}/vast/track?impid=${o.impid}&cid=${o.cid}&event=impression`],
    ad_format: 'native'
  };
}
function buildPush(o) {
  return {
    title: o.title || '推送广告标题',
    body: o.body || '推送广告正文，由媒体推送系统下发（不经 SDK 渲染）',
    icon: ICON_SVG,
    clickUrl: `${PUBLIC_BASE}/ssp/click?cid=${o.cid}&imp=${o.impid}&pub=${encodeURIComponent(o.publisher || '')}`,
    impUrl: `${PUBLIC_BASE}/vast/track?impid=${o.impid}&cid=${o.cid}&event=impression`,
    ad_format: 'push'
  };
}
function buildInterstitialHtml(o) {
  return `<div style="position:fixed;left:0;top:0;right:0;bottom:0;background:rgba(0,0,0,.75);display:flex;align-items:center;justify-content:center;z-index:99999;font-family:'Microsoft YaHei',sans-serif">
  <div style="width:300px;background:#fff;border-radius:12px;overflow:hidden;position:relative">
    <button onclick="this.parentNode.parentNode.remove()" style="position:absolute;right:8px;top:8px;border:0;background:#e5e7eb;border-radius:50%;width:28px;height:28px;cursor:pointer">×</button>
    <img src="${ICON_SVG}" style="width:100%;height:170px;object-fit:cover;background:#eef2ff" alt="ad">
    <div style="padding:12px">
      <div style="font-size:15px;font-weight:700">${o.title || '插屏广告'}</div>
      <div style="font-size:12px;color:#6b7280;margin-top:4px">全屏展示，可关闭</div>
      <a href="${PUBLIC_BASE}/ssp/click?cid=${o.cid}&imp=${o.impid}" target="_blank" style="display:block;margin-top:10px;background:#2563eb;color:#fff;text-align:center;padding:9px;border-radius:8px;text-decoration:none;font-size:14px">立即下载</a>
    </div>
  </div>
</div>`;
}
function buildSplashHtml(o) {
  return `<div onclick="this.remove()" style="position:fixed;left:0;top:0;right:0;bottom:0;background:#0f172a;color:#fff;font-family:'Microsoft YaHei',sans-serif;z-index:99999;cursor:pointer">
  <div style="position:absolute;right:16px;top:16px;background:rgba(255,255,255,.2);border-radius:16px;padding:6px 12px;font-size:12px">点击跳过</div>
  <div style="height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center">
    <img src="${ICON_SVG}" style="width:120px;height:120px;border-radius:24px" alt="icon">
    <div style="font-size:18px;font-weight:700;margin-top:16px">${o.title || '开屏广告'}</div>
  </div>
</div>`;
}
function buildIconHtml(o) {
  return `<a href="${PUBLIC_BASE}/ssp/click?cid=${o.cid}&imp=${o.impid}" target="_blank" style="display:inline-block;width:120px;text-align:center;text-decoration:none;color:#111;font-family:'Microsoft YaHei',sans-serif">
  <img src="${ICON_SVG}" style="width:120px;height:120px;border-radius:24px;display:block" alt="icon">
  <div style="font-size:12px;margin-top:4px">${o.title || 'icon广告'}</div>
</a>`;
}
function safeJson(s) { try { return JSON.parse(s); } catch (e) { return {}; } }
// 素材库选取：按 campaign + 形态返回已上传创意（管理后台上传，优于合成占位）
async function pickCreative(campaignId, format, ctx) {
  if (!campaignId) return null;
  const f = String(format || 'banner').toLowerCase();
  try {
    const [rows] = await pool.query(
      "SELECT id,title,type,content,media_url,landing_url,width,height,format FROM creatives WHERE campaign_id=? AND status='active' AND (format=? OR format='any') ORDER BY (format = ?) DESC",
      [campaignId, f, f]);
    if (!rows.length) return null;
    // P1 创意 A/B：按轮播选择（多版本均匀轮播），归因到具体创意用于效果对比
    const n = rows.length;
    const idxKey = `ab:${campaignId}:${f}`;
    const cur = (await cache.get(idxKey)) || 0;
    const pick = rows[cur % n];
    cache.set(idxKey, (cur + 1) % n, 0).catch(() => {});
    // 动态创意宏替换：${PUBLISHER}/${KEYWORD}/${CID}（按流量上下文注入）
    const pub = (ctx && ctx.publisher) || '';
    const kw = (ctx && ctx.keyword) || '';
    const sub = (s) => String(s || '').replace(/\$\{PUBLISHER\}/g, pub).replace(/\$\{KEYWORD\}/g, kw).replace(/\$\{CID\}/g, campaignId);
    return {
      id: pick.id, title: sub(pick.title), type: pick.type, format: pick.format, content: sub(pick.content),
      mediaUrl: pick.media_url, landingUrl: sub(pick.landing_url), width: pick.width, height: pick.height, abTotal: n
    };
  } catch (e) { return null; }
}

/** 按 imp.ext.ad_type 生成对应形态创意；返回 null 表示沿用 campaign 自带 creative_html */
function buildFormatAd(format, o) {
  switch (String(format || 'banner').toLowerCase()) {
    case 'rewarded':     return { adm: buildVast(o), admType: 'vast4' };
    case 'interstitial': return { adm: buildInterstitialHtml(o), admType: 'html' };
    case 'splash':       return { adm: buildSplashHtml(o), admType: 'html' };
    case 'icon':         return { adm: buildIconHtml(o), admType: 'html' };
    case 'native':       return { adm: JSON.stringify(buildNative(o)), admType: 'native_json' };
    case 'push':         return { adm: '', admType: 'push', push: buildPush(o) };
    default:             return null;
  }
}

// 创意与请求形态是否匹配：native 必须 native 类创意、push 必须 push 类，否则回落到按形态合成
// （避免 'any'/html 创意被当成原生/推送，导致前端 JSON.parse 失败或拿不到 push 载荷）
function creativeFits(cr, fmt) {
  if (!cr) return false;
  if (cr.type === 'vast') return true;
  if (cr.format === 'any') return false; // 'any' 是兜底占位，优先按形态合成（带点击/落地），避免裸占位 div 点了无反应
  if (fmt === 'native') return cr.type === 'native';
  if (fmt === 'push') return cr.type === 'push';
  return cr.type === 'html';
}

// ===== S2S 服务端回调：客户端不可信，媒体服务端签名回调才是结算权威 =====
// 生产请设 S2S_ENFORCE=1：届时客户端 /ssp/reward 只登记为「待确认」，不计入结算。
const S2S_ENFORCE = process.env.S2S_ENFORCE === '1';
const S2S_TTL_MS = 5 * 60 * 1000;
function s2sSign(secret, impid, cid, watchedMs, durationMs, ts) {
  return crypto.createHmac('sha256', String(secret))
    .update(`${impid}|${cid || 0}|${watchedMs}|${durationMs}|${ts}`).digest('hex');
}

// ===== VAST 4.0 返回（行业标准：广告内容为 XML 而非 HTML）=====
const PUBLIC_BASE = process.env.PUBLIC_BASE || 'https://dellai.xyz';
const RW_MEDIA = process.env.RW_MEDIA || 'https://media.w3.org/2010/05/sintel/trailer.mp4';
const RW_DURATION = '00:00:52';

/** 生成 VAST 4.0 InLine XML：含 Impression/TrackingEvents(start~complete)/MediaFiles */
function buildVast(o) {
  const q = (ev) => `${PUBLIC_BASE}/vast/track?impid=${encodeURIComponent(o.impid)}&cid=${o.cid}&event=${ev}`;
  const T = [[ 'start', 'start' ], [ 'firstQuartile', 'firstQuartile' ], [ 'midpoint', 'midpoint' ], [ 'thirdQuartile', 'thirdQuartile' ], [ 'complete', 'complete' ]]
    .map(([ ev, name ]) => `<Tracking event="${name}"><![CDATA[${q(ev)}]]></Tracking>`).join('\n              ');
  return `<?xml version="1.0" encoding="UTF-8"?>
<VAST xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" version="4.0">
  <Ad id="${o.cid}">
    <InLine>
      <AdSystem version="1.0">linkos-adx</AdSystem>
      <AdTitle><![CDATA[${o.title}]]></AdTitle>
      <Impression id="zhuque-imp"><![CDATA[${q('impression')}]]></Impression>
      <AdVerifications>
        <Verification vendor="zhuque-omid">
          <JavaScriptResource apiFramework="omid" browserOptional="true"><![CDATA[${OMID_JS}]]></JavaScriptResource>
          <Tracking event="verificationNotExecuted"><![CDATA[${q('omid_not_executed')}]]></Tracking>
        </Verification>
      </AdVerifications>
      <Creatives>
        <Creative id="${o.cid}" sequence="1" adId="${o.cid}">
          <UniversalAdId idRegistry="Ad-ID">ADX-${o.cid}</UniversalAdId>
          <Linear>
            <Duration>${o.duration || RW_DURATION}</Duration>
            <TrackingEvents>
              ${T}
            </TrackingEvents>
            <MediaFiles>
              <MediaFile id="1" delivery="progressive" type="video/mp4" bitrate="800" width="1280" height="720" scalable="true" maintainAspectRatio="true">
                <![CDATA[${o.mediaUrl || RW_MEDIA}]]>
              </MediaFile>
            </MediaFiles>
          </Linear>
        </Creative>
      </Creatives>
    </InLine>
  </Ad>
</VAST>`;
}

function rwSign(raw) { return crypto.createHmac('sha256', RW_SECRET).update(raw).digest('hex'); }
function rwPayload(impid, cid, pub, ts) { return `${impid}|${cid || 0}|${pub}|${ts}`; }
function rwIssue(impid, cid, pub, fp) {
  const ts = Date.now();
  return { impid: String(impid), cid: Number(cid) || 0, pub: String(pub), fp: String(fp || ''), ts, token: rwSign(rwPayload(impid, cid, pub, ts)) };
}
function rwVerify(rw, impid, cid, pub) {
  if (!rw || !rw.token) return { ok: false, why: 'MISSING_TOKEN' };
  if (String(rw.impid) !== String(impid)) return { ok: false, why: 'TOKEN_IMPID_MISMATCH' };
  if (String(rw.cid || 0) !== String(cid || 0)) return { ok: false, why: 'TOKEN_CID_MISMATCH' };
  if (String(rw.pub) !== String(pub)) return { ok: false, why: 'TOKEN_PUB_MISMATCH' };
  if (!rw.ts || Date.now() - Number(rw.ts) > RW_TTL_MS) return { ok: false, why: 'TOKEN_EXPIRED' };
  if (rwSign(rwPayload(rw.impid, rw.cid, rw.pub, rw.ts)) !== rw.token) return { ok: false, why: 'BAD_SIGNATURE' };
  return { ok: true };
}

async function init() {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS bid_win_log (
      id BIGINT AUTO_INCREMENT PRIMARY KEY, campaign_id INT, creative_id INT,
      imp_id VARCHAR(64), price_micros BIGINT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
    // 激励视频令牌表：issued 记录签发，used 防重放（同一 impid 只能兑换一次奖励）
    // device_fp：令牌与设备指纹绑定，跨设备重放直接拒绝（S2S 仍挡不住"多设备构造真实播放"，靠指纹层兜底）
    await pool.query(`CREATE TABLE IF NOT EXISTS rw_token (
      id INT AUTO_INCREMENT PRIMARY KEY, imp_id VARCHAR(64) NOT NULL UNIQUE, campaign_id INT,
      publisher VARCHAR(128), used TINYINT DEFAULT 0, device_fp VARCHAR(64) DEFAULT '',
      issued_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, used_at TIMESTAMP NULL)`);
    // 激励视频完播审计日志：既记录发放成功，也记录每一次被拒绝的原因（反作弊可追溯）
    await pool.query(`CREATE TABLE IF NOT EXISTS reward_log (
      id BIGINT AUTO_INCREMENT PRIMARY KEY, imp_id VARCHAR(64), campaign_id INT, publisher VARCHAR(128),
      watched_ms INT DEFAULT 0, duration_ms INT DEFAULT 0, ratio DECIMAL(6,3) DEFAULT 0,
      status VARCHAR(32), remote VARCHAR(64), device_fp VARCHAR(64) DEFAULT '',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
    // VAST 视频事件流水：impression/start/quartile/complete（行业标准可见性与进度度量）
    await pool.query(`CREATE TABLE IF NOT EXISTS vast_event (
      id BIGINT AUTO_INCREMENT PRIMARY KEY, imp_id VARCHAR(64), campaign_id INT, event VARCHAR(32),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
    // OMID / 可见性测量事件流水：viewable / not_viewable / omid_session_start（反作弊加分项）
    await pool.query(`CREATE TABLE IF NOT EXISTS omid_event (
      id BIGINT AUTO_INCREMENT PRIMARY KEY, imp_id VARCHAR(64), campaign_id INT, event VARCHAR(32),
      viewable TINYINT DEFAULT 0, duration_ms INT DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
    // 媒体服务端密钥：S2S 回调签名用（客户端不可信，服务端回调才是结算权威）
    await pool.query("ALTER TABLE publishers ADD COLUMN api_key VARCHAR(64) DEFAULT ''").catch(() => {});
    // 兼容已存在表：补齐设备指纹列（设备绑定 + 设备级风控用）
    await pool.query("ALTER TABLE rw_token ADD COLUMN device_fp VARCHAR(64) DEFAULT ''").catch(() => {});
    await pool.query("ALTER TABLE reward_log ADD COLUMN device_fp VARCHAR(64) DEFAULT ''").catch(() => {});
    await pool.query(`CREATE TABLE IF NOT EXISTS adv_campaign (
      id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(128), advertiser VARCHAR(128),
      budget_micros BIGINT, status TINYINT DEFAULT 1, country VARCHAR(8) DEFAULT '',
      app_category VARCHAR(32) DEFAULT '', creative_html TEXT, landing_url VARCHAR(256),
      target_cpm_micros BIGINT DEFAULT 5000000, intent_tags VARCHAR(128) DEFAULT '', intent_profile TEXT)`);
    await pool.query('ALTER TABLE adv_campaign ADD COLUMN intent_profile TEXT').catch(() => {}); // 兼容已存在表
    await pool.query('ALTER TABLE adv_campaign ADD COLUMN review_status VARCHAR(16) DEFAULT \'approved\'').catch(() => {}); // 素材审核状态: pending/approved/rejected
    await pool.query(`CREATE TABLE IF NOT EXISTS conv_log (
      id BIGINT AUTO_INCREMENT PRIMARY KEY, type ENUM('click','conversion') NOT NULL,
      campaign_id INT, publisher VARCHAR(128), imp_id VARCHAR(64),
      amount DECIMAL(10,2) DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
    await pool.query('ALTER TABLE conv_log ADD COLUMN amount DECIMAL(10,2) DEFAULT 0').catch(() => {}); // 兼容已存在表：成交金额(元)
    await pool.query(`CREATE TABLE IF NOT EXISTS publishers (
      domain VARCHAR(128) PRIMARY KEY, name VARCHAR(128), contact VARCHAR(128),
      payout_rate DECIMAL(4,2) DEFAULT 0.70, status TINYINT DEFAULT 1, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
    // 供给爬虫回填字段（合规：仅抓媒体方自己声明的 site_url）
    await pool.query('ALTER TABLE publishers ADD COLUMN site_url VARCHAR(256)').catch(() => {});
    await pool.query('ALTER TABLE publishers ADD COLUMN cat VARCHAR(32)').catch(() => {});
    await pool.query('ALTER TABLE publishers ADD COLUMN geo VARCHAR(8)').catch(() => {});
    await pool.query('ALTER TABLE publishers ADD COLUMN keywords VARCHAR(128)').catch(() => {});
    await pool.query('ALTER TABLE publishers ADD COLUMN last_crawl BIGINT').catch(() => {});
    // eCPM' 三层评测库（§3.3）+ 归因样本统计（§2.6 冷启动燃料）
    // 素材库：广告主/计划上传的多形态创意（banner/rewarded/interstitial/splash/native/icon/push）
    await pool.query(`CREATE TABLE IF NOT EXISTS creatives (
      id INT AUTO_INCREMENT PRIMARY KEY, advertiser VARCHAR(128) DEFAULT '', campaign_id INT DEFAULT 0,
      format VARCHAR(16) DEFAULT 'banner', type VARCHAR(16) DEFAULT 'html',
      title VARCHAR(128) DEFAULT '', content TEXT, media_url VARCHAR(256) DEFAULT '',
      landing_url VARCHAR(256) DEFAULT '', width INT DEFAULT 0, height INT DEFAULT 0,
      status VARCHAR(16) DEFAULT 'active', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
    // 外部 DSP 合作方（持久化；重启后自动加载进拍卖，实现"真实需求方连接"）
    await pool.query(`CREATE TABLE IF NOT EXISTS dsp_partners (
      id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(64) UNIQUE, url VARCHAR(256) DEFAULT '',
      payout_rate DECIMAL(4,2) DEFAULT 0.6, type VARCHAR(16) DEFAULT 'http',
      is_own TINYINT DEFAULT 0, status TINYINT DEFAULT 1, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
    // 胜出记录补齐 publisher 维度（结算/报表按媒体方归因，重启后仍可追溯）
    await pool.query("ALTER TABLE bid_win_log ADD COLUMN publisher VARCHAR(128) DEFAULT ''").catch(() => {});
    await pool.query('ALTER TABLE bid_win_log ADD COLUMN feat TEXT').catch(() => {});            // 在线模型特征向量(回流训练用)
    await pool.query('ALTER TABLE bid_win_log ADD COLUMN model_trained TINYINT DEFAULT 0').catch(() => {}); // 是否已用于模型训练
    await pool.query('ALTER TABLE bid_win_log ADD COLUMN consent VARCHAR(64) DEFAULT \'\'').catch(() => {}); // 隐私同意(GDPR/CCPA)透传
    await pool.query('ALTER TABLE adv_campaign ADD COLUMN intent_embed TEXT').catch(() => {}); // 意图 embedding 向量(异步缓存化相关性)
    await pool.query('ALTER TABLE adv_campaign ADD COLUMN daily_cap_micros BIGINT DEFAULT 0').catch(() => {}); // 日预算上限(0=不限)，用于 pacing
    // 出价目标：CPM(曝光) / CPA(转化成本) / ROAS(投入产出比)——多目标预估需要知道广告主按什么付费
    await pool.query("ALTER TABLE adv_campaign ADD COLUMN goal_type VARCHAR(8) DEFAULT 'CPM'").catch(() => {});
    await pool.query('ALTER TABLE adv_campaign ADD COLUMN target_cpa_micros BIGINT DEFAULT 0').catch(() => {});
    await pool.query('ALTER TABLE adv_campaign ADD COLUMN target_roas DECIMAL(8,3) DEFAULT 1').catch(() => {});
    await pool.query(`CREATE TABLE IF NOT EXISTS daily_spend (
      campaign_id INT, d DATE, micros BIGINT DEFAULT 0, PRIMARY KEY(campaign_id,d))`).catch(() => {});
    await pool.query(`CREATE TABLE IF NOT EXISTS adv_ledger (
      id BIGINT AUTO_INCREMENT PRIMARY KEY, campaign_id INT, imp_id VARCHAR(64),
      req_id VARCHAR(64) DEFAULT '', charge_micros BIGINT DEFAULT 0, insufficient TINYINT DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, UNIQUE KEY uk_imp_req (imp_id, req_id))`).catch(() => {});
    // 幂等键升级为 (imp_id, req_id)：否则不同请求复用同一 slot 名时，第二次扣费会被唯一键吞掉 → 再度账实不符
    await pool.query('ALTER TABLE adv_ledger ADD COLUMN req_id VARCHAR(64) DEFAULT \'\'').catch(() => {});
    await pool.query('ALTER TABLE adv_ledger DROP INDEX uk_imp').catch(() => {});
    await pool.query('ALTER TABLE adv_ledger ADD UNIQUE KEY uk_imp_req (imp_id, req_id)').catch(() => {});
    // 创意 A/B 统计（Thompson Sampling 的后验计数：曝光/点击/转化）
    await pool.query('ALTER TABLE creatives ADD COLUMN impressions INT DEFAULT 0').catch(() => {});
    await pool.query('ALTER TABLE creatives ADD COLUMN clicks INT DEFAULT 0').catch(() => {});
    await pool.query('ALTER TABLE creatives ADD COLUMN conversions INT DEFAULT 0').catch(() => {});
    // 加载持久化的外部 DSP 合作方进入拍卖（真实需求方连接，重启自动恢复）
    try {
      const [ds] = await pool.query("SELECT name,url,payout_rate,is_own FROM dsp_partners WHERE status=1");
      ds.forEach(d => { if (!DEMAND_PARTNERS.find(p => p.name === d.name)) DEMAND_PARTNERS.push({ name: d.name, type: 'http', url: d.url, payoutRate: Number(d.payout_rate) || 0.6, isOwn: !!d.is_own }); });
    } catch (e) {}
    await pool.query(`CREATE TABLE IF NOT EXISTS sku_eval (
      sku_id VARCHAR(64) PRIMARY KEY, name VARCHAR(128),
      l1 DECIMAL(4,3) DEFAULT 0.5, l2 DECIMAL(4,3) DEFAULT 0.5, l3 DECIMAL(4,3) DEFAULT 0.5,
      eval_score DECIMAL(5,4) DEFAULT 0.5,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP)`);
    await pool.query(`CREATE TABLE IF NOT EXISTS sku_stats (
      sku_id VARCHAR(64) PRIMARY KEY, n_samples INT DEFAULT 0,
      successes INT DEFAULT 0, failures INT DEFAULT 0,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP)`);
    // SKAdNetwork / 隐私聚合归因回传（P1 隐私与测量）：苹果/Google 聚合归因回传落库
    await pool.query(`CREATE TABLE IF NOT EXISTS skan_postback (
      id BIGINT AUTO_INCREMENT PRIMARY KEY, dsp_domain VARCHAR(64), campaign_id INT,
      source_app VARCHAR(64), postback_version VARCHAR(8), fidelity INT DEFAULT 0,
      conversion_value INT DEFAULT -1, coarse_value VARCHAR(16) DEFAULT '',
      payload JSON, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
    const [[c]] = await pool.query('SELECT COUNT(*) n FROM adv_campaign');
    if (c.n === 0) {
      await pool.query(`INSERT INTO adv_campaign
        (name,advertiser,budget_micros,country,app_category,creative_html,landing_url,target_cpm_micros,intent_tags) VALUES
        ('益智游戏买量','GameCo',2000000000,'','puzzle','<div style="padding:10px;background:#4F8EF7;color:#fff;border-radius:6px">试玩即玩·益智爆款</div>','https://example.com',6000000,'puzzle,game,casual'),
        ('电商促销-北美','ShopUS',3000000000,'US','', '<div style="padding:10px;background:#e74c3c;color:#fff">北美大促 低至5折</div>','https://shop.example.com',8000000,'shop,ecommerce,sale')`);
    }
    // 结算身份修正：以 (请求id, impid) 复合身份区分不同请求重复使用的 slot 名；
    // billable=0 标记"同一身份重复记录"的历史行（非破坏性，保留审计轨迹）
    await pool.query("ALTER TABLE bid_win_log ADD COLUMN req_id VARCHAR(64) DEFAULT ''").catch(() => {});
    await pool.query('ALTER TABLE bid_win_log ADD COLUMN billable TINYINT DEFAULT 1').catch(() => {});
    await pool.query(`CREATE TABLE IF NOT EXISTS admin_audit (
      id BIGINT AUTO_INCREMENT PRIMARY KEY, actor VARCHAR(64), action VARCHAR(64),
      target VARCHAR(255), detail VARCHAR(255), ip VARCHAR(64),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
    // 三方账号体系：admin / advertiser / publisher 独立账号 + 作用域
    await pool.query(`CREATE TABLE IF NOT EXISTS accounts (
      id INT AUTO_INCREMENT PRIMARY KEY,
      type ENUM('admin','advertiser','publisher') NOT NULL,
      username VARCHAR(128) NOT NULL UNIQUE,
      pass_hash VARCHAR(128) NOT NULL,
      scope VARCHAR(255) DEFAULT '',
      display VARCHAR(128) DEFAULT '',
      status TINYINT DEFAULT 1,
      created_by VARCHAR(128) DEFAULT '',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
    // 首次启动播种：默认管理员 + 演示租客账号（便于直接演示三方独立后台）
    try {
      const [[cnt]] = await pool.query('SELECT COUNT(*) c FROM accounts');
      if (cnt && cnt.c === 0) {
        const seed = [
          ['admin', process.env.ADMIN_USER || 'admin', process.env.ADMIN_PASS || 'admin123', '*', '超级管理员'],
          ['advertiser', 'demobrand', 'demo123', 'DemoBrand', '演示广告主'],
          ['publisher', 'demomedia', 'demo123', 'edurobot.cn', '演示媒体'],
        ];
        for (const [type, username, password, scope, display] of seed) {
          await pool.query('INSERT INTO accounts (type,username,pass_hash,scope,display) VALUES (?,?,?,?,?)',
            [type, username, security.hashPwd(password), scope, display]).catch(() => {});
        }
        console.warn('[SEED] 账号已播种 → 管理员 admin/admin123｜广告主 demobrand/demo123(作用域 DemoBrand)｜媒体 demomedia/demo123(作用域 edurobot.cn)');
      }
    } catch (e) { console.warn('[WARN] 账号播种失败（可忽略）:', e.message); }
    // 在线转化预测模型权重持久化（无论是否有种子数据都初始化）
    await pool.query(`CREATE TABLE IF NOT EXISTS bid_model_weights (
      campaign_id INT PRIMARY KEY, w_json TEXT, n INT DEFAULT 0,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP)`);
    // 软考落地页留资（landing/ruankao/index.html 回传邮箱/微信，免登录、无敏感数据）
    await pool.query(`CREATE TABLE IF NOT EXISTS ruankao_lead (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      contact VARCHAR(128),
      channel VARCHAR(32) DEFAULT 'direct',
      source VARCHAR(128) DEFAULT '',
      ip VARCHAR(64) DEFAULT '',
      delivered TINYINT DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX(channel), INDEX(created_at)`);
    bidModel.attachPool(pool);
    await bidModel.loadAll();
    bidModel.startFlusher();
    bidModel.startSweeper();
    creativeAb.attachPool(pool);

    // ===== 新增能力层初始化（失败不影响主流程：各自 try/catch 已内置）=====
    trust.attachPool(pool); await trust.initTables();
    pacing.attachPool(pool); await pacing.initTables();
    billing.attachPool(pool); await billing.initTables();
    brandSafety.attachPool(pool); await brandSafety.initTables();
    identity.attachPool(pool); await identity.initTables(); await identity.load();
    attribution.attachPool(pool); await attribution.init();
    creativeAuto.attachPool(pool); await creativeAuto.init();
    ml.attachPool(pool); await ml.init(); ml.startWorkers();
    bidEng.attachPool(pool); await bidEng.init(); bidEng.startFlusher();
    console.log('[platform] 信任层/节奏/计费/品牌安全/身份图谱/归因/创意自动化/ML/竞价工程 已就绪');
  } catch (e) { console.error('init', e.message); }
}

// === 意图匹配：上下文与 campaign.intent_tags 重合度 0..1，用于抬高 eCPM ===
function intentScore(campaign, ctx) {
  const tags = (campaign.intent_tags || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!tags.length) return 0;
  const hay = [ctx.app_category, ctx.country, ...(ctx.keywords || [])].map(s => (s || '').toLowerCase());
  let hit = 0;
  tags.forEach(t => { if (hay.some(h => h && (h.includes(t) || t.includes(h)))) hit++; });
  return hit / tags.length;
}

// 用 LLM 给单个 campaign 打相关性（优先 LLM 画像，否则启发式）；返回 {score,reason,llm?}
async function llmRel(c, ctx) {
  if (llm.ENABLED && llm.LIVE_MATCH && c.intent_profile) {
    try { const p = JSON.parse(c.intent_profile); return await llm.scoreRelevance(p, ctx); } catch (e) {}
  }
  return { score: intentScore(c, ctx), reason: '启发式' };
}

// ============ P0/P1/P2 增强：相关性缓存 + 学习化 eCPM + 反欺诈设备图谱 ============
const MIN_RELEVANCE = 0.05;   // P0 最低相关性门槛：低于此值不参与竞价，避免无关创意抢量
const REL_TTL_MS = 60 * 60 * 1000;

// 上下文签名：品类 + 地区 + 排序后关键词（用于相关性/embedding 缓存）
function ctxSig(ctx) {
  const kw = (ctx.keywords || []).slice().sort().join(',');
  return `${(ctx.app_category || '').toLowerCase()}|${(ctx.country || '').toLowerCase()}|${kw}`;
}

// 异步缓存化相关性：热路径同步返回启发式分数（不阻塞）；并火速(非阻塞)刷新 embedding 分数覆盖缓存
async function relevanceFor(c, ctx) {
  const key = `r:${c.id}:${ctxSig(ctx)}`;
  const cached = await cache.get(key);
  if (cached && Date.now() - cached.ts < REL_TTL_MS) { cache.incr('relcache_hit'); return cached; }
  cache.incr('relcache_miss');
  const h = intentScore(c, ctx);
  const base = { score: h, source: 'heuristic', ts: Date.now() };
  cache.set(key, base, REL_TTL_MS).catch(() => {});
  if (llm.ENABLED && c.intent_embed) setImmediate(() => refreshEmbeddingRel(c, ctx, key).catch(() => {}));
  return base;
}
async function refreshEmbeddingRel(c, ctx, key) {
  const campEmb = safeJson(c.intent_embed);
  if (!Array.isArray(campEmb) || !campEmb.length) return;
  const text = `${(ctx.app_category || '')} ${(ctx.keywords || []).join(' ')} ${ctx.country || ''}`.trim();
  const ctxEmb = await embedCached(text);
  if (!ctxEmb) return;
  const sc = llm.cosine(campEmb, ctxEmb);
  if (sc <= 0) return;
  await cache.set(key, { score: Math.max(0, Math.min(1, sc)), source: 'embedding', ts: Date.now() }, REL_TTL_MS);
  cache.incr('rel_embed_refresh');
}
async function embedCached(text) {
  const key = 'e:' + crypto.createHash('md5').update(text).digest('hex');
  const c = await cache.get(key);
  if (c) return c;
  const v = await llm.embed(text);
  if (v) await cache.set(key, v, 24 * 60 * 60 * 1000);
  return v;
}

// 学习化 eCPM：基于近 7 天历史转化表现动态调整出价系数（冷启动先验=1，样本足时由行为接管）
const perfCache = new Map();
async function perfFactor(cid) {
  const now = Date.now();
  const c = perfCache.get(cid);
  if (c && now - c.ts < 60000) return c.factor;
  try {
    const [[s]] = await pool.query(
      "SELECT COUNT(*) clicks, COALESCE(SUM(type='conversion'),0) conv FROM conv_log WHERE campaign_id=? AND created_at > NOW()-INTERVAL 7 DAY",
      [cid]);
    const clicks = Number(s.clicks) || 0, conv = Number(s.conv) || 0;
    let factor = 1;
    if (clicks >= 20) factor = Math.max(0.7, Math.min(1.3, 0.7 + (conv / clicks) * 6));
    perfCache.set(cid, { factor, ts: now });
    return factor;
  } catch (e) { return 1; }
}

// P2 反欺诈：设备图谱 + 竞价侧频次风控（跨设备农场/单设备刷量）
const deviceGraph = new Map(); // fp -> { ips:Set, bids:[ts], lastSeen }
const BID_FP_MAX = 300;       // 单设备窗口内最大竞价次数
const BID_FP_WIN = 10 * 60 * 1000;
function bidFpRisk(fp, ip) {
  if (!fp) return { ok: true };
  const t = Date.now();
  const g = deviceGraph.get(fp) || { ips: new Set(), bids: [] };
  g.ips.add(ip);
  g.bids = (g.bids || []).filter(x => t - x < BID_FP_WIN);
  g.bids.push(t); g.lastSeen = t; deviceGraph.set(fp, g);
  if (g.bids.length > BID_FP_MAX) return { ok: false, reason: 'DEVICE_FP_BID_RATE' };
  if (g.ips.size > 50) return { ok: false, reason: 'DEVICE_IP_FARM' };
  return { ok: true };
}

// ============ P1 Pacing：日预算平滑，避免几分钟把预算烧光 ============
// 允许消费上限 = 日预算 × 当日流逝比例（至少保留 15% 兜底，防止凌晨完全停投）
const paceCache = new Map(); // cid -> { micros, ts }
const PACE_TTL = 30 * 1000;
async function todaySpend(cid) {
  const now = Date.now();
  const c = paceCache.get(cid);
  if (c && now - c.ts < PACE_TTL) return c.micros;
  let micros = 0;
  try {
    const [[r]] = await pool.query('SELECT COALESCE(micros,0) micros FROM daily_spend WHERE campaign_id=? AND d=CURDATE()', [cid]);
    micros = Number(r && r.micros) || 0;
  } catch (e) {}
  paceCache.set(cid, { micros, ts: now });
  return micros;
}
function bustPace(cid) { paceCache.delete(cid); }
// true = 在预算节奏内可投放
function withinPace(campaign, spentMicros) {
  const cap = Number(campaign.daily_cap_micros) || 0;
  if (cap <= 0) return true;                       // 未设日预算 → 不限节奏
  const d = new Date();
  const elapsed = (d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds()) / 86400;
  const allowed = cap * Math.max(0.15, elapsed);   // 按当日流逝比例放预算
  return spentMicros < allowed && spentMicros < cap;
}

// 创建 campaign 后用 LLM 抽取意图画像 + embedding 向量并回写（用户已填标签则做并集）
async function enrichCampaign(id) {
  const [[c]] = await pool.query('SELECT * FROM adv_campaign WHERE id=?', [id]);
  if (!c) return;
  const ex = await llm.extractDemandIntent(c);
  if (!ex) return;
  const userTags = (c.intent_tags || '').split(',').map(s => s.trim()).filter(Boolean);
  const tags = userTags.length ? [...new Set([...userTags, ...ex.tags])] : ex.tags;
  // 计算并存储 intent_embed（异步缓存化 embedding 相关性用；无 embedding Key 时跳过）
  let emb = null;
  if (llm.ENABLED) {
    const text = `${c.name} ${c.advertiser || ''} ${String(c.creative_html || '').replace(/<[^>]*>/g, ' ')} ${c.landing_url || ''} ${c.intent_tags || ''}`.slice(0, 4000);
    emb = await llm.embed(text);
  }
  await pool.query('UPDATE adv_campaign SET intent_tags=?, intent_profile=?, intent_embed=? WHERE id=?',
    [tags.join(','), JSON.stringify(ex.profile), emb ? JSON.stringify(emb) : null, id]);
}

// ===== 需求方：DSP 出价引擎（含品类隔离 + 异步相关性 + 学习化 eCPM）=====
app.post('/openrtb2/bid', async (req, res) => {
  const br = req.body || {};
  // P0 竞价热路径保护：容量节流 + 硬 deadline（对齐 /ssp/bid）。慢隧道/上游堆积时快速 503 失败，避免雪崩拖垮全站
  const th = bidEng.shouldProcess({ key: 'openrtb', priority: 'high' });
  if (!th.ok) { metrics.incr('throttled'); return res.status(503).json({ id: br.id, seatbid: [], nbr: 8, retry_after_ms: th.retryAfterMs }); }
  const deadline = Date.now() + Number(process.env.OPENRTB_DEADLINE_MS || 300);
  const imp = (br.imp && br.imp[0]) || {};
  const floorMicros = Math.round((imp.bidfloor || 1.0) * 1e6);
  const ctx = {
    app_category: (br.app && br.app.cat) || (imp.ext && imp.ext.cat) || '',
    country: (br.device && br.device.geo && br.device.geo.country) || '',
    keywords: ((br.site && br.site.keywords) || '').split(',').filter(Boolean)
  };
  const ctxCat = (ctx.app_category || '').toLowerCase();
  const t0 = Date.now();
  // ── 身份解析：一次请求一台设备，解析出 canonical 设备标识供频控/跨App/模型使用 ──
  const idReq = identity.fromOpenRTB(br);
  const idRes = identity.resolve(idReq.ids, idReq.signals, { consented: idReq.consented, bundle: idReq.signals.bundle });
  const unitId = idRes.canonicalId || ((br.device && br.device.ext && br.device.ext.fp) || (br.device && br.device.ip) || '');
  // ── 品牌安全 pre-bid（供给侧上下文）：命中 GARM Floor 直接不参竞 ──
  const bsCtx = {
    publisher: (br.site && br.site.domain) || '', domain: (br.site && br.site.domain) || '',
    bundle: (br.app && br.app.bundle) || '', app_category: ctx.app_category, cat: ctxCat,
    keywords: ctx.keywords, title: (br.site && br.site.name) || '', description: (br.site && br.site.keywords) || '',
  };
  const bsSupply = brandSafety.classify(bsCtx);
  try {
    const [rows] = await pool.query("SELECT * FROM adv_campaign WHERE status=1 AND (review_status IS NULL OR review_status='approved') AND budget_micros>=?", [floorMicros]);
    let best = null, fallback = null;   // best=相关性达标；fallback=相关性不足但其它均合规（保证合法请求都有应答，不空跑库存）
    for (const c of rows) {
      if (Date.now() > deadline) { cache.incr('openrtb_deadline'); break; } // 硬 deadline：宁可少算候选，也不超时丢标
      // P0 品类(vertical)隔离：campaign 有明确品类但与上下文品类不符 → 不参与，避免错配(游戏抢教育流量)
      const campCat = (c.app_category || '').toLowerCase();
      const catMatch = !campCat || campCat === 'all' || !ctxCat || campCat === ctxCat;
      if (!catMatch) continue;
      const rel = await relevanceFor(c, ctx);            // 异步缓存化相关性（不阻塞热路径）
      const score = rel.score;
      // P1 品牌安全：广告主策略（bcat/badv/GARM 分级）未通过 → 不参竞
      const bpol = await brandSafety.policy(c.id);
      const bs = brandSafety.preBid(br, bpol, { ...bsCtx, iab: bsSupply.iab });
      if (bs.block) {
        cache.incr('brand_safety_skip');
        if (bs.reasons.some(r => r.code === 'GARM_FLOOR' || r.code === 'GARM_TIER')) brandSafety.logEvent(c.id, bsCtx.publisher, bs.reasons[0]).catch(() => {});
        continue;
      }
      // P1 Pacing v2：时段(daypart) → 频控(freq cap) → 预算节奏（含按流量曲线的软着陆系数）
      const spent = Number(c.daily_cap_micros) > 0 ? await todaySpend(c.id) : 0;
      const gate = await pacing.gate(c, spent, { deviceId: unitId, userId: idReq.ids.login_id, creativeId: 0 });
      if (!gate.ok) { cache.incr(gate.reason === 'FREQ_CAP' ? 'freq_cap_skip' : (gate.reason === 'OUT_OF_DAYPART' ? 'daypart_skip' : 'pacing_skip')); continue; }
      const base = Math.min(c.target_cpm_micros, c.budget_micros);
      if (base < floorMicros) continue;
      // ===== 多目标预估（pCTR / pCVR / pLTV）→ 出价 → 一价拍卖 shading =====
      const mlCtx = {
        campaign: c, cat: campCat, ctxCat, relScore: score,
        kwOverlap: score, format: (imp.ext && imp.ext.ad_type) || 'banner',
        geo: ctx.country, deviceType: (br.device && br.device.devicetype) || 0,
        floorMicros, targetCpm: c.target_cpm_micros, bidMicros: base,
        publisher: bsCtx.publisher, creativeId: 0,
        noPersonalization: !!(br.ext && br.ext.no_personalization),
        stats: { cImps: 0, cClicks: 0, cConv: 0, ageDays: 0 },
        hour: new Date().getHours(),
      };
      const pred = ml.mo.predict(c.id, ml.fs.compute(mlCtx));
      // 离线预训练权重接入在线：用真实公开集训(cold-start 先验)的 pCTR/pCVR 覆盖 LR 先验
      const np = neuralBridge.predict(c, { base, format: (imp.ext && imp.ext.ad_type) || 'banner', hour: mlCtx.hour });
      if (np) {
        pred.pctr = np.pctr; pred.pcvr = np.pcvr; pred.pctcvr = np.pctr * np.pcvr;
        pred.expected_value_micros = Math.round(np.pctr * np.pcvr * (pred.pltv_micros || 0));
        pred.neural = true;
      }
      const goalType = String(c.goal_type || 'CPM').toUpperCase();
      const goal = goalType === 'ROAS' ? { type: 'ROAS', targetRoas: Number(c.target_roas) || 1, targetCpmMicros: base }
        : goalType === 'CPA' ? { type: 'CPA', targetCpaMicros: Number(c.target_cpa_micros) || base, targetCpmMicros: base }
          : { type: 'CPM', targetCpmMicros: base };
      const bd = ml.mo.bidFor({
        pred, goal, floorMicros,
        maxBidMicros: Math.min(Number(c.target_cpm_micros) || 0, Number(c.budget_micros) || 0) * 3,
        bidAdjust: (gate.bidAdjust || 1) * (1 + 0.5 * score),
      });
      // 一价拍卖（br.at=1）才需要 shading；二价下 shading 只会降低胜率
      const shaded = bidEng.shade({
        valueMicros: bd.bidMicros, floorMicros, ctx: { publisher: bsCtx.publisher, format: mlCtx.format, country: ctx.country },
        auctionType: Number(br.at || 2),
      });
      const bidMicros = shaded.skipped ? 0 : (shaded.bidMicros || bd.bidMicros);
      if (bidMicros <= 0) { cache.incr('shading_skip'); continue; }
      // 保留旧模型出价作为对照（模型灰度/回退用），不参与决策
      const fx = bidModel.featureVector(c, { ...ctx, _relScore: score });
      const modelMul = bidModel.modelMul(c.id, fx);
      const cand = {
        c, bidMicros, score, source: rel.source, fx, modelMul,
        pcvr: pred.pcvr, pctr: pred.pctr, pltv: pred.pltv_micros, pctcvr: pred.pctcvr,
        shade: shaded.shade, pWin: shaded.pWin, basis: bd.basis, bidAdjust: gate.bidAdjust, lowRel: score < MIN_RELEVANCE,
      };
      // 相关性达标优先；不足时进入兜底（仍出价并标记 lowRel 便于风控/回收），绝不空跑合法请求
      if (score >= MIN_RELEVANCE) { if (!best || bidMicros > best.bidMicros) best = cand; }
      else if (!fallback || bidMicros > fallback.bidMicros) fallback = cand;
    }
    metrics.observe('dsp_latency', Date.now() - t0);
    cache.observe('dsp_latency', Date.now() - t0);
    best = best || fallback;   // 兜底：相关性不足的合规库存也能应答，避免 demo/通用请求空跑
    if (!best) return res.json({ id: br.id, seatbid: [], nbr: 2 });   // nbr=2 无效竞价请求（无广告可投）
    // P1 创意引擎：该 campaign 有多个 active 创意时做 A/B 选版（Thompson Sampling 自动优选）
    const cv = await creativeAb.pick(best.c.id).catch(() => null);
    const adm = cv ? (cv.content || best.c.creative_html) : best.c.creative_html;
    const crid = cv ? String(cv.id) : String(best.c.id);      // crid=创意版本 id → 后续统计可归因
    const landing = (cv && cv.landing_url) || best.c.landing_url;
    return res.json({
      id: br.id,
      seatbid: [{
        seat: 'zhuque',
        bid: [{
          id: 'bid1', impid: imp.id, price: best.bidMicros,
          adm, crid, cid: String(best.c.id),
          ext: {
            cid: best.c.id, intent_score: best.score, intent_source: best.source,
            model_mul: Number(best.modelMul.toFixed(3)), pcvr: Number(best.pcvr.toFixed(4)), feat: best.fx, landing,
            variant_id: cv ? cv.id : null,
            // 新增：多目标预估与 shading 可解释字段（买方/广告主审计用）
            pctr: best.pctr, pctcvr: best.pctcvr, pltv_micros: best.pltv,
            bid_basis: best.basis, shade: best.shade, p_win: best.pWin, bid_adjust: best.bidAdjust,
            canonical_id: idRes.canonicalId, garm_tier: bsSupply.garmTier,
          }
        }]
      }]
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== 供给方：SSP（OpenRTB 端点，多 DSP 并发拍卖）=====
const pubMetaCache = new Map(); // domain -> {rate,cat,geo,keywords}（内存快取；底层由 cache 持久化到 Redis）
async function getPub(domain) {
  if (pubMetaCache.has(domain)) return pubMetaCache.get(domain);
  const cm = await cache.get('pub:' + domain).catch(() => null); // Redis 命中 → 重启也不丢
  if (cm) { pubMetaCache.set(domain, cm); return cm; }
  try {
    const [[p]] = await pool.query('SELECT payout_rate,cat,geo,keywords FROM publishers WHERE domain=?', [domain]);
    const meta = p ? {
      rate: Number(p.payout_rate) || 0.70,
      cat: p.cat || '', geo: p.geo || '', keywords: (p.keywords || '').split(',').filter(Boolean),
    } : { rate: 0.70, cat: '', geo: '', keywords: [] };
    pubMetaCache.set(domain, meta);
    cache.set('pub:' + domain, meta, 5 * 60 * 1000).catch(() => {});
    return meta;
  } catch (e) { return { rate: 0.70, cat: '', geo: '', keywords: [] }; }
}
app.post('/ssp/bid', async (req, res) => {
  const ip = req.ip || (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (rateHit(ip)) return res.status(429).json({ error: 'rate limited' }); // 反作弊：单 IP 频率限制
  // 容量节流：QPS 超限或 p99 恶化时主动降载，宁可少接也不能把全站拖成超时雪崩
  const th = bidEng.shouldProcess({ key: 'ssp', priority: 'normal' });
  if (!th.ok) { metrics.incr('throttled'); return res.status(503).json({ id: (req.body || {}).id, seatbid: [], nbr: 8, retry_after_ms: th.retryAfterMs }); }
  const t0 = Date.now(); cache.incr('bid_requests'); metrics.incr('bid_requests');
  const br = req.body || {};
  if (!br.id) return res.status(400).json({ error: 'missing id' });
  const publisher = (br.site && br.site.domain) || 'unknown';
  const pub = await getPub(publisher);                 // 媒体方画像(含 supply crawler 回填的 cat/geo)
  // P1 隐私同意(GDPR/CCPA)透传：从 OpenRTB regs / user.consent 取，落库用于合规审计
  const consent = (br.user && br.user.consent) || '';
  const regs = br.regs ? JSON.stringify(br.regs) : '';
  // P2 竞价侧设备频次风控：单设备窗口内竞价超阈值 → 设备农场嫌疑
  const devFp = (br.device && br.device.ext && br.device.ext.fp) || (br.imp && br.imp[0] && br.imp[0].ext && br.imp[0].ext.device_fp) || '';
  const fr = bidFpRisk(devFp, ip);
  if (!fr.ok) return res.status(429).json({ error: 'device risk', why: fr.reason });
  // P1 底价优化：媒体方未设底价时，用该媒体方近期清盘价 EMA 作为建议底价（动态底价）
  const imp0 = (br.imp && br.imp[0]) || {};
  if (!imp0.bidfloor || Number(imp0.bidfloor) <= 0) {
    const sf = pubFloor[publisher];
    if (sf) imp0.bidfloor = Math.max(0.5, +(sf * 0.9 / 1e6).toFixed(4));
  }
  // 供给上下文补全：媒体方 SDK 未带 cat/geo 时，用已爬取的画像补全 → 提升意图匹配 eCPM
  const imp = (br.imp && br.imp[0]) || {};
  br.imp = br.imp || [imp];
  if (!imp.ext) imp.ext = {};
  if (!imp.ext.cat && pub.cat) imp.ext.cat = pub.cat;
  if (!(br.device && br.device.geo && br.device.geo.country) && pub.geo) {
    br.device = br.device || {}; br.device.geo = br.device.geo || {}; br.device.geo.country = pub.geo;
  }
  const kw = ((br.site && br.site.keywords) || '').split(',').filter(Boolean);
  if (pub.keywords.length && !kw.length) { br.site = br.site || {}; br.site.keywords = pub.keywords.join(','); }
  // 身份解析（供给侧同样需要：频控、跨 App 识别、设备级反作弊都依赖 canonical 设备标识）
  const idReqS = identity.fromOpenRTB(br);
  const idResS = identity.resolve(idReqS.ids, idReqS.signals, { consented: idReqS.consented, bundle: idReqS.signals.bundle });
  // 品牌安全：供给侧命中 GARM Floor（色情/暴力/仇恨等零容忍内容）→ 直接不卖，保护所有广告主
  const bsSup = brandSafety.classify({
    publisher, domain: publisher, bundle: (br.app && br.app.bundle) || '',
    app_category: imp.ext.cat || '', keywords: kw, title: (br.site && br.site.name) || '',
  });
  if (bsSup.garmTier === 0) {
    metrics.incr('brand_safety_blocked');
    brandSafety.logEvent(0, publisher, { code: 'GARM_FLOOR', detail: bsSup.floorHit }).catch(() => {});
    return res.json({ id: br.id, seatbid: [], nbr: 3 });   // nbr=3 无效请求（未通过审核/政策）
  }
  // 竞价总 deadline：到点即返回已到达的出价，p99 不再被最慢的 partner 决定
  // 库存范围开关：公开落地页广告位带 ownOnly 时，只让「自有」需求方参与，
  // 外部/Kuaishou 演示创意不进公开页面；管理台/演示页走完整多需求方竞价（竞价引擎逻辑不变）。
  const partners = (imp.ext && imp.ext.ownOnly) ? DEMAND_PARTNERS.filter(p => p.isOwn) : DEMAND_PARTNERS;
  const responses = await bidEng.deadlineAll(partners.map(async (p) => {
    if (p.type === 'mock') {
      const imp = (br.imp && br.imp[0]) || {};
      return { seatbid: [{ seat: p.name, bid: [{ id: 'b-mock', impid: imp.id, price: p.priceMicros, adm: p.adm, crid: p.crid, cid: 0, ext: { cid: 0 } }] }] };
    }
    if (p.type === 'kuaishou') {
      try { return await ksDSP.bid(br); }   // 快手买量：sim 返回模拟出价；real 走开放平台
      catch (e) { console.error('kuaishou dsp err', e.message); return null; }
    }
    try {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 10000);
      const r = await fetch(p.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(br), signal: ctrl.signal });
      clearTimeout(to);
      return await r.json();
    } catch (e) { console.error('demand err', p.name, e.message); return null; }
  }));
  const allBids = [];
  responses.forEach((resp, idx) => {
    if (!resp) return;
    const partner = partners[idx];
    (resp.seatbid || []).forEach(seat => (seat.bid || []).forEach(bid => allBids.push({ partner, seat, bid, micros: bid.price || 0 })));
  });
  // P1 统一竞价增强：聚合外部 SSP（类 AppLovin MAX 的"中介聚合多供给"）；SUPPLY_PARTNERS 默认空则不生效
  const supplyPartners = safeJson(process.env.SUPPLY_PARTNERS) || [];
  let sres = [];
  if (Array.isArray(supplyPartners) && supplyPartners.length) {
    try {
      sres = await Promise.all(supplyPartners.map(async (sp) => {
        try {
          const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), 10000);
          const r = await fetch(sp.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(br), signal: ctrl.signal });
          clearTimeout(to); return { sp, json: await r.json() };
        } catch (e) { console.error('supply err', sp.name, e.message); return null; }
      }));
      sres.forEach((s) => {
        if (!s || !s.json) return;
        (s.json.seatbid || []).forEach(seat => (seat.bid || []).forEach(bid => allBids.push({ partner: { name: s.sp.name, isOwn: false }, seat, bid, micros: bid.price || 0 })));
      });
    } catch (e) {}
  }
  if (!allBids.length) return res.json({ id: br.id, seatbid: [] });
  allBids.sort((a, b) => b.micros - a.micros);
  const best = allBids[0];
  const second = allBids.length > 1 ? allBids[1].micros : best.micros;
  const winMicros = AUCTION.secondPrice ? Math.min(best.micros, second + 10000) : best.micros; // 清盘价
  const grossMicros = winMicros;                              // SSP 向需求方实收(清盘价)
  const payoutMicros = Math.round(winMicros * pub.rate);      // 给媒体分成(媒体方独立费率)
  recordSsp(grossMicros, payoutMicros, publisher);
  // 胜率模型：用真实清盘价拟合市场分布（bid shading 的决策依据，也是动态底价的数据源）
  bidEng.onAuctionEnd({
    publisher, format: String((imp.ext && imp.ext.ad_type) || 'banner').toLowerCase(),
    country: (br.device && br.device.geo && br.device.geo.country) || '',
  }, winMicros, true, best.micros);
  // 媒体应付累计（计费闭环：媒体侧按账期结算而非实时打款）
  billing.accruePublisher(publisher, payoutMicros, 'WIN:' + String(br.id || '')).catch(() => {});
  if (best.partner.isOwn) { // 自有 DSP：广告主按「二价清盘价」付费（不是自己的出价），避免虚高
    try {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 2000);
      await fetch(`http://127.0.0.1:${PORT}/notify`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        // 带上请求 id：结算去重改按 (req_id, impid) 复合身份，避免"重复使用同一 slot 名的新请求"被误判为重放而漏扣广告主费用
        body: JSON.stringify({ cid: best.bid.cid || (best.bid.ext && best.bid.ext.cid), crid: best.bid.crid, impid: best.bid.impid, reqid: String(br.id || ''), price: winMicros, win: true }),
        signal: ctrl.signal
      });
      clearTimeout(to);
    } catch (e) {}
  }
  const winBid = { ...best.bid, price: winMicros };
  const bestCid = best.bid.cid || (best.bid.ext && best.bid.ext.cid);
  // 每次胜出均落库（按媒体方归因），用于持久化结算/报表（重启不丢、按 publisher 追溯）
  // 落地特征向量（供在线模型回流训练）；外部 DSP 无 feat 时为 null
  const winFeat = (best.bid.ext && Array.isArray(best.bid.ext.feat)) ? JSON.stringify(best.bid.ext.feat) : null;
  await pool.query('INSERT INTO bid_win_log (campaign_id,creative_id,imp_id,req_id,price_micros,publisher,consent,feat) VALUES (?,?,?,?,?,?,?,?)', [Number(bestCid) || 0, Number(best.bid.crid) || 0, String(best.bid.impid), String(br.id || ''), winMicros, publisher, consent, winFeat]).catch(() => {});
  creativeAb.bump(String(best.bid.impid), 'impressions').catch(() => {}); // A/B：本次曝光计入所服务创意版本
  // 特征落库（离线训练样本源）：写入即与在线同一套 compute()，天然无 training-serving skew。
  // 采样写入，避免高 QPS 下把特征日志表打爆（采样率随负载自适应）
  if (Math.random() < bidEng.throttle.sampleRate('feature_log', Number(process.env.FEATURE_LOG_RATE || 0.2))) {
    ml.onImpression(String(best.bid.impid), Number(bestCid) || 0, {
      campaign: { app_category: imp.ext && imp.ext.cat, target_cpm_micros: 0 },
      ctxCat: (imp.ext && imp.ext.cat) || '', format: String((imp.ext && imp.ext.ad_type) || 'banner'),
      geo: (br.device && br.device.geo && br.device.geo.country) || '',
      publisher, floorMicros: Math.round((imp0.bidfloor || 0) * 1e6),
      deviceType: (br.device && br.device.devicetype) || 0,
      noPersonalization: !!(br.ext && br.ext.no_personalization),
    }).catch(() => {});
  }
  // 激励视频：服务端签发一次性签名令牌，前端 SDK 只能上报、无法自证完播
  const fmt = String((imp.ext && imp.ext.ad_type) || ((imp.ext && imp.ext.reward) ? 'rewarded' : '') || 'banner');
  // 设备指纹：SDK/客户端随竞价上报，写入令牌实现"设备绑定"，跨设备重放将被拒
  const rwFp = (imp.ext && imp.ext.device_fp) || (br.device && br.device.ext && br.device.ext.fp) || '';
  if (fmt === 'rewarded') {
    const rw = rwIssue(best.bid.impid, bestCid, publisher, rwFp);
    // 行业标准：视频广告返回 VAST 4.0 XML；imp.ext.protocol='html' 时可退回 HTML 创意
    const useVast = imp.ext.protocol !== 'html';
    if (useVast) {
      let vast = buildVast({
        impid: rw.impid, cid: rw.cid,
        title: bestCid ? ('ADX-' + bestCid + ' 激励视频') : 'rewarded-ad',
        mediaUrl: RW_MEDIA, duration: RW_DURATION
      });
      // 第三方可见性验证（IAS / DoubleVerify / Moat / OMID）注入 VAST <AdVerifications>
      const bpol = await brandSafety.policy(bestCid).catch(() => brandSafety.DEFAULT_POLICY);
      const vscripts = brandSafety.verificationScripts(bpol, rw.impid);
      if (vscripts.length) vast = brandSafety.injectVerifications(vast, vscripts);
      winBid.adm = vast;
    }
    winBid.ext = Object.assign({}, best.bid.ext, {
      rw, rw_min_ratio: RW_MIN_RATIO, rw_ttl_ms: RW_TTL_MS,
      ad_type: 'rewarded', ad_format: 'rewarded', adm_type: useVast ? 'vast4' : 'html'
    });
    await pool.query('INSERT IGNORE INTO rw_token (imp_id,campaign_id,publisher,device_fp) VALUES (?,?,?,?)', [rw.impid, rw.cid, publisher, rw.fp || '']).catch(() => {});
  } else if (fmt !== 'banner') {
    // 其它形态：插屏 / 开屏 / 原生 / icon / push（优先用素材库真实创意，否则合成占位）
    const cr = await pickCreative(bestCid, fmt, { publisher, keyword: kw.join(',') });
    if (creativeFits(cr, fmt)) {
      winBid.crid = String(cr.id); // A/B 归因到具体创意（而非仅 campaign）
      if (cr.type === 'vast') {
        winBid.adm = cr.content;
        winBid.ext = Object.assign({}, best.bid.ext, { ad_format: fmt, adm_type: 'vast4' });
      } else if (cr.type === 'native') {
        const nat = Object.assign(buildNative({ cid: bestCid, publisher, title: cr.title || '原生广告' }), cr.content ? safeJson(cr.content) : {});
        winBid.adm = JSON.stringify(nat);
        winBid.ext = Object.assign({}, best.bid.ext, { ad_format: 'native', adm_type: 'native_json' });
      } else if (cr.type === 'push') {
        winBid.adm = '';
        winBid.ext = Object.assign({}, best.bid.ext, { ad_format: 'push', adm_type: 'push', push: cr.content ? safeJson(cr.content) : null });
      } else {
        winBid.adm = cr.content;
        winBid.ext = Object.assign({}, best.bid.ext, { ad_format: fmt, adm_type: 'html' });
      }
    } else {
      const fa = buildFormatAd(fmt, {
        impid: best.bid.impid, cid: bestCid, publisher,
        title: bestCid ? ('ADX-' + bestCid) : 'ad',
        body: '由 ADX 下发的 ' + fmt + ' 广告',
        mediaUrl: RW_MEDIA, duration: RW_DURATION
      });
      if (fa) {
        winBid.adm = fa.adm;
        winBid.ext = Object.assign({}, best.bid.ext, { ad_format: fmt, adm_type: fa.admType, push: fa.push || null });
      }
    }
  }
  cache.observe('bid_latency', Date.now() - t0); cache.incr('wins');
  // 调试透出：?trace=1 时附上各参与方真实调用结果，证明外部 DSP/SSP 真的被调用（不影响正常响应）
  let participants = null;
  if (req.query.trace === '1') {
    participants = DEMAND_PARTNERS.map((p, i) => {
      const resp = responses[i];
      let st = 'timeout', top = 0;
      if (resp && resp.seatbid) {
        st = 'bid';
        resp.seatbid.forEach(s => (s.bid || []).forEach(b => { if ((b.price || 0) > top) top = b.price; }));
      } else if (resp === null) st = 'error';
      return { seat: p.name, type: p.type, status: st, topBidMicros: top, won: !!(best && best.partner.name === p.name) };
    });
    sres.forEach((s) => {
      if (!s || !s.json) return;
      let top = 0; (s.json.seatbid || []).forEach(seat => (seat.bid || []).forEach(b => { if ((b.price || 0) > top) top = b.price; }));
      participants.push({ seat: s.sp.name, type: 'supply', status: 'bid', topBidMicros: top, won: false });
    });
  }
  res.json({ id: br.id, cur: 'CNY', seatbid: [{ seat: best.partner.name, bid: [winBid] }], ...(participants ? { participants } : {}) });
});

// 动态注册外部 DSP（合作方案落地：Appluck 类供给/需求接入）
app.post('/ssp/demand', (req, res) => {
  const { name, url, payoutRate = 0.6 } = req.body || {};
  if (!name || !url) return res.status(400).json({ error: 'name,url required' });
  DEMAND_PARTNERS.push({ name, type: 'http', url, payoutRate, isOwn: false });
  res.json({ ok: true, partners: DEMAND_PARTNERS.map(p => p.name) });
});

// ===== 快手磁力引擎 开放平台 · DSP/买量侧 接入（脚手架）=====
// 仅供 demo 展示与自测；真实模式需 KS_APP_ID/KS_APP_SECRET + 开放平台端点文档
app.get('/api/demand/kuaishou/status', (_, res) => res.json(ksDSP.status()));
app.post('/api/demand/kuaishou/buy', async (req, res) => {
  try { const r = await ksDSP.buy(req.body || {}); res.json(r); }
  catch (e) { res.status(501).json({ ok: false, error: e.message }); }
});
// 快手转化/事件回传（webhook）签名校验：demo 用随机参数+签名演示
app.post('/api/demand/kuaishou/callback', (req, res) => {
  const b = req.body || {};
  const ok = ksDSP.verifyCallback(b, b.sign);
  res.json({ ok, verified: ok, mode: ksDSP.MODE });
});

// 快手 OAuth2 授权（真实模式）：跳转到快手授权页；回调交换 token
app.get('/api/demand/kuaishou/auth', (req, res) => {
  if (ksDSP.MODE !== 'real') return res.json({ mode: 'sim', note: 'sim 模式无需授权；设 KS_MODE=real + KS_APP_ID/SECRET + KS_REDIRECT_URI 后访问此端点完成真实授权' });
  res.redirect(ksDSP.authUrl(req.query.state));
});
app.get('/api/demand/kuaishou/oauth-callback', async (req, res) => {
  try {
    const j = await ksDSP.exchangeCode(req.query.code || '');
    if (j && j.access_token) res.send('<h3>快手授权成功 ✓</h3><p>access_token 已保存，可回到演示页点「测试快手买量(real)」。</p><p><a href="/media-demo.html">返回演示</a></p>');
    else res.status(400).send('<h3>授权失败</h3><pre>' + JSON.stringify(j) + '</pre>');
  } catch (e) { res.status(500).send('授权错误: ' + e.message); }
});

// 媒体方曝光上报（由 pub_sdk.js 自动调用）
const pubImpr = {};
app.get('/ssp/imp', (req, res) => {
  const pub = req.query.pub || 'unknown';
  pubImpr[pub] = (pubImpr[pub] || 0) + 1;
  res.status(204).end();
});
// 媒体方点击上报（pub_sdk 在创意被点击时调用）→ 转化漏斗 + 媒体方点击数
app.get('/ssp/click', async (req, res) => {
  const pub = req.query.pub || 'unknown';
  const cid = req.query.cid ? +req.query.cid : null;
  const imp = req.query.imp || '';
  if (!imp) return res.status(400).end();
  const [[ex]] = await pool.query('SELECT 1 FROM bid_win_log WHERE imp_id=?', [imp]);
  if (!ex) return res.status(204).end(); // 反作弊：无对应曝光的点击直接忽略
  if (pubLedger[pub]) pubLedger[pub].clicks++;
  await pool.query('INSERT IGNORE INTO conv_log (type,campaign_id,publisher,imp_id) VALUES (?,?,?,?)', ['click', cid, pub, imp]).catch(() => {});
  creativeAb.bump(imp, 'clicks').catch(() => {}); // A/B：点击计入所服务创意版本
  // 多目标模型回流（pCTR）：点击即 CTR 塔的正样本
  ml.onClick(imp).catch(() => {});
  res.status(204).end();
});
// 转化/线索上报（广告主落地页在留资/下单时调用）→ 转化 + 媒体方转化数
app.post('/api/track/conversion', async (req, res) => {
  const { cid, publisher, impid, amount } = req.body || {};
  const pub = publisher || 'unknown';
  const imp = impid || '';
  if (!imp) return res.status(400).json({ error: 'impid required' });
  const amt = Number(amount) || 0;
  if (amt < 0 || amt > 1e7) return res.status(400).json({ error: 'amount out of range' }); // 反作弊：金额区间校验，防刷 GMV
  const [[win]] = await pool.query('SELECT 1 FROM bid_win_log WHERE imp_id=?', [imp]);
  if (!win) return res.status(400).json({ error: 'unknown impression' }); // 反作弊：转化必须对应真实曝光
  const [[dup]] = await pool.query("SELECT 1 FROM conv_log WHERE type='conversion' AND imp_id=?", [imp]);
  if (dup) return res.json({ ok: true, amount: 0, dup: true }); // 同一 imp 不重复计转化
  if (pubLedger[pub]) pubLedger[pub].conversions++;
  try {
    await pool.query('INSERT INTO conv_log (type,campaign_id,publisher,imp_id,amount) VALUES (?,?,?,?,?)', ['conversion', cid ? +cid : null, pub, imp, amt]);
    bidModel.trainConversion(imp).catch(() => {}); // 在线模型正样本回流（旧单模型，保留作对照）
    // 多目标模型回流（pCVR + pLTV）：标签回流是"离线训练→在线 serving 一致性"的燃料
    ml.onConversion(imp, Math.round(amt * 1e6)).catch(() => {});
    creativeAb.bump(imp, 'conversions').catch(() => {}); // A/B：转化计入所服务创意版本
    res.json({ ok: true, amount: amt });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== S2S 服务端回调：媒体/App 服务端用 api_key 签名上报观看结果，是结算唯一权威 =====
app.post('/s2s/reward', async (req, res) => {
  const { impid, cid, publisher, watchedMs, durationMs, ts, sig, rewardResult, device_fp } = req.body || {};
  const pub = String(publisher || '');
  const watched = Number(watchedMs) || 0, dur = Number(durationMs) || 0;
  const fp = String(device_fp || '');
  const remote = req.ip || (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  const audit = (status, ratio) =>
    pool.query('INSERT INTO reward_log (imp_id,campaign_id,publisher,watched_ms,duration_ms,ratio,status,remote,device_fp) VALUES (?,?,?,?,?,?,?,?,?)',
      [String(impid || ''), cid ? Number(cid) : null, pub, watched, dur, Number((ratio || 0).toFixed(3)), status, remote, fp]).catch(() => {});
  const deny = (why, code = 403) => { audit('S2S_REJECT_' + why, 0); return res.status(code).json({ ok: false, why, deviceFp: fp }); };

  if (!impid || !pub) return deny('MISSING_FIELDS', 400);
  const age = Math.abs(Date.now() - Number(ts || 0));
  if (!ts || age > S2S_TTL_MS) return deny('TIMESTAMP_EXPIRED');
  const [[pu]] = await pool.query('SELECT api_key FROM publishers WHERE domain=?', [pub]).catch(() => [[]]);
  if (!pu || !pu.api_key) return deny('UNKNOWN_PUBLISHER');
  if (s2sSign(pu.api_key, impid, cid, watchedMs, durationMs, ts) !== sig) return deny('BAD_S2S_SIGNATURE');
  const [[win]] = await pool.query('SELECT campaign_id FROM bid_win_log WHERE imp_id=?', [String(impid)]).catch(() => [[]]);
  if (!win) return deny('NO_IMPRESSION', 400);
  const [[tk]] = await pool.query('SELECT used, device_fp FROM rw_token WHERE imp_id=?', [String(impid)]).catch(() => [[]]);
  if (tk && Number(tk.used) === 1) return deny('TOKEN_ALREADY_SETTLED');
  // ② 设备指纹绑定：令牌签发设备与结算设备不一致 → 跨设备重放（农场化）直接拒绝
  if (tk && tk.device_fp && fp && String(tk.device_fp) !== fp) return deny('DEVICE_FP_MISMATCH');
  // ③ 设备级风控：单设备窗口内领奖超阈值 → 设备农场嫌疑
  const fpr = fpRisk(fp);
  if (!fpr.ok) return deny(fpr.reason, 429);
  if (!dur || dur <= 0) return deny('BAD_DURATION', 400);
  const ratio = watched / dur;
  if (ratio < RW_MIN_RATIO) return deny('INCOMPLETE_WATCH', 400);
  if (ratio > RW_MAX_RATIO) return deny('IMPOSSIBLE_WATCH', 400);
  if (rewardResult === 'skipped' || rewardResult === 'abandoned') return deny('MEDIA_REPORTED_ABANDONED', 400);

  await pool.query('UPDATE rw_token SET used=1, used_at=NOW() WHERE imp_id=?', [String(impid)]).catch(() => {});
  let counted = false;
  try {
    const [dupRows] = await pool.query("SELECT 1 FROM conv_log WHERE type='conversion' AND imp_id=?", [String(impid)]);
    if (!dupRows.length) {
      await pool.query("INSERT INTO conv_log (type,campaign_id,publisher,imp_id,amount) VALUES ('conversion',?,?,?,?)", [cid ? Number(cid) : null, pub, String(impid), 0]);
      bidModel.trainConversion(String(impid)).catch(() => {});
      creativeAb.bump(String(impid), 'conversions').catch(() => {});
      counted = true;
    }
    if (pubLedger[pub]) pubLedger[pub].conversions++;
  } catch (e) {}
  audit('S2S_GRANTED', ratio);
  res.json({ ok: true, granted: true, counted, ratio: Number(ratio.toFixed(3)), settlement: 'server-authoritative', deviceFp: fp, deviceFpCount: fpr.count });
});

// VAST 视频事件上报：曝光/播放进度/完播由播放器按 XML 中的 tracking URL 回调（行业标准度量）
app.get('/vast/track', async (req, res) => {
  const qy = req.query || {};
  const impid = String(qy.impid || '');
  const cid = qy.cid ? Number(qy.cid) : null;
  const ev = String(qy.event || 'unknown');
  await pool.query('INSERT INTO vast_event (imp_id,campaign_id,event) VALUES (?,?,?)', [impid, cid, ev]).catch(() => {});
  res.status(204).end();
});

// OMID / 可见性测量上报：由 VAST 中 AdVerifications 的 JavaScriptResource（omsdk/本演示 shim）回传
// 事件：omid_session_start / viewable / not_viewable / omid_not_executed（反作弊加分项）
app.post('/vast/omid', async (req, res) => {
  const { impid, cid, event, viewable, durationMs } = req.body || {};
  await pool.query('INSERT INTO omid_event (imp_id,campaign_id,event,viewable,duration_ms) VALUES (?,?,?,?,?)',
    [String(impid || ''), cid ? Number(cid) : null, String(event || 'unknown'), viewable ? 1 : 0, Number(durationMs) || 0]).catch(() => {});
  res.status(204).end();
});
app.get('/vast/omid', async (req, res) => {
  const qy = req.query || {};
  const impid = String(qy.impid || '');
  const cid = qy.cid ? Number(qy.cid) : null;
  const ev = String(qy.event || 'unknown');
  await pool.query('INSERT INTO omid_event (imp_id,campaign_id,event,viewable,duration_ms) VALUES (?,?,?,?,?)',
    [impid, cid, ev, qy.viewable === '1' ? 1 : 0, Number(qy.durationMs) || 0]).catch(() => {});
  res.status(204).end();
});

// ===== 激励视频完播上报：服务端校验令牌后才发放奖励（前端无法自证完播）=====
app.post('/ssp/reward', async (req, res) => {
  const { impid, cid, publisher, rw, watchedMs, durationMs, device_fp } = req.body || {};
  const pub = String(publisher || 'unknown');
  const fp = String(device_fp || '');
  const remote = req.ip || (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  const watched = Number(watchedMs) || 0, dur = Number(durationMs) || 0;
  const audit = (status, ratio) =>
    pool.query('INSERT INTO reward_log (imp_id,campaign_id,publisher,watched_ms,duration_ms,ratio,status,remote,device_fp) VALUES (?,?,?,?,?,?,?,?,?)',
      [String(impid || ''), cid ? Number(cid) : null, pub, watched, dur, Number((ratio || 0).toFixed(3)), status, remote, fp]).catch(() => {});
  const deny = (why, code = 403) => { audit('REJECT_' + why, 0); return res.status(code).json({ ok: false, why, deviceFp: fp }); };

  if (!impid) return deny('MISSING_IMPID', 400);
  // ① 必须对应一次真实曝光（bid_win_log 由竞价成功后落库）
  let winRows = [];
  try { [winRows] = await pool.query('SELECT campaign_id, price_micros FROM bid_win_log WHERE imp_id=?', [String(impid)]); } catch (e) { return deny('DB_ERROR', 500); }
  if (!winRows.length) return deny('NO_IMPRESSION', 400);
  // ② 令牌签名校验（HMAC 绑定 impid+cid+publisher+时间戳）
  const v = rwVerify(rw, impid, cid, pub);
  if (!v.ok) return deny(v.why);
  // ③ 令牌未被兑换过（防重放：同一 impid 只能领一次）
  const [[tk]] = await pool.query('SELECT used, device_fp FROM rw_token WHERE imp_id=?', [String(impid)]).catch(() => [[]]);
  if (tk && Number(tk.used) === 1) return deny('TOKEN_REPLAYED');
  // ③b 设备指纹绑定：令牌签发设备与结算设备不一致 → 跨设备重放直接拒绝
  if (tk && tk.device_fp && fp && String(tk.device_fp) !== fp) return deny('DEVICE_FP_MISMATCH');
  // ③c 设备级风控：单设备窗口内领奖超阈值 → 设备农场嫌疑
  const fpr = fpRisk(fp);
  if (!fpr.ok) return deny(fpr.reason, 429);
  // ④ 完播证据合理性：时长有效 + 观看比例在合法区间
  if (!dur || dur <= 0) return deny('BAD_DURATION', 400);
  const ratio = watched / dur;
  if (ratio < RW_MIN_RATIO) return deny('INCOMPLETE_WATCH', 400);
  if (ratio > RW_MAX_RATIO) return deny('IMPOSSIBLE_WATCH', 400);
  // ⑤ S2S 强校验模式：客户端上报只是「信号」，不计入结算，须等媒体服务端 /s2s/reward 回调
  if (S2S_ENFORCE) {
    audit('CLIENT_CLAIM_AWAITING_S2S', ratio);
    return res.json({ ok: true, granted: false, pending: 'await_s2s', why: 'CLIENT_SIGNAL_ONLY', ratio: Number(ratio.toFixed(3)) });
  }
  // ⑥ 客户端直结模式（H5 演示用；生产应设 S2S_ENFORCE=1）
  await pool.query('UPDATE rw_token SET used=1, used_at=NOW() WHERE imp_id=?', [String(impid)]).catch(() => {});
  let counted = false;
  try {
    const [dupRows] = await pool.query("SELECT 1 FROM conv_log WHERE type='conversion' AND imp_id=?", [String(impid)]);
    if (!dupRows.length) {
      await pool.query("INSERT INTO conv_log (type,campaign_id,publisher,imp_id,amount) VALUES ('conversion',?,?,?,?)", [cid ? Number(cid) : null, pub, String(impid), 0]);
      bidModel.trainConversion(String(impid)).catch(() => {});
      creativeAb.bump(String(impid), 'conversions').catch(() => {});
      counted = true;
    }
    if (pubLedger[pub]) pubLedger[pub].conversions++;
  } catch (e) {}
  audit('GRANTED', ratio);
  return res.json({ ok: true, granted: true, counted, ratio: Number(ratio.toFixed(3)), campaignId: winRows[0].campaign_id, priceMicros: winRows[0].price_micros, deviceFp: fp, deviceFpCount: fpr.count });
});

// 激励视频审计日志：既看发放成功，也看每一次被拒绝的原因（反作弊可追溯）
app.get('/api/reward/log', async (req, res) => {
  const limit = Math.min(100, Number(req.query.limit) || 20);
  try {
    const [rows] = await pool.query('SELECT imp_id,campaign_id,publisher,watched_ms,duration_ms,ratio,status,created_at FROM reward_log ORDER BY id DESC LIMIT ' + limit);
    const [[agg]] = await pool.query("SELECT SUM(status='GRANTED') AS granted, COUNT(*) AS total FROM reward_log");
    res.json({ rows, agg });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== 控制台：广告主充值 + 双边看板 =====
app.post('/api/campaign/:id/topup', security.requireAdmin('topup'), async (req, res) => {
  const cid = Number(req.params.id);
  const cny = Number((req.body || {}).amount_cny);
  if (!cid || !cny || cny <= 0 || cny > 1e6) return res.status(400).json({ error: 'amount_cny required (0, 1e6]' });
  const micros = Math.round(cny * 1e6);
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS topup_log (
      id BIGINT AUTO_INCREMENT PRIMARY KEY, campaign_id INT, amount_micros BIGINT,
      note VARCHAR(128), created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
    await pool.query('UPDATE adv_campaign SET budget_micros = budget_micros + ? WHERE id=?', [micros, cid]);
    await pool.query('INSERT INTO topup_log (campaign_id,amount_micros,note) VALUES (?,?,?)', [cid, micros, (req.body && req.body.note) || 'recharge']);
    const [[row]] = await pool.query('SELECT id,name,advertiser,budget_micros FROM adv_campaign WHERE id=?', [cid]);
    res.json({ ok: true, campaign: row });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/console/overview', async (_, res) => {
  try {
    const [advRows] = await pool.query(`
      SELECT c.id, c.name, c.advertiser, c.app_category, c.review_status, c.status,
             c.budget_micros AS balance_micros,
             COALESCE(t.filled_micros,0) AS spend_micros,
             COALESCE(t.impressions,0) AS impressions,
             COALESCE(k.clicks,0) AS clicks,
             COALESCE(v.conversions,0) AS conversions
      FROM adv_campaign c
      LEFT JOIN (SELECT campaign_id, SUM(price_micros) filled_micros, COUNT(*) impressions FROM bid_win_log GROUP BY campaign_id) t ON t.campaign_id=c.id
      LEFT JOIN (SELECT campaign_id, COUNT(*) clicks FROM conv_log WHERE type='click' GROUP BY campaign_id) k ON k.campaign_id=c.id
      LEFT JOIN (SELECT campaign_id, COUNT(*) conversions FROM conv_log WHERE type='conversion' GROUP BY campaign_id) v ON v.campaign_id=c.id
      ORDER BY c.id DESC LIMIT 50`);
    const [[tot]] = await pool.query('SELECT COALESCE(SUM(price_micros),0) AS gross_micros, COUNT(*) AS impressions FROM bid_win_log');
    const [[conv]] = await pool.query("SELECT COALESCE(SUM(type='conversion'),0) AS conversions, COALESCE(SUM(type='click'),0) AS clicks FROM conv_log");
    const [[rw]] = await pool.query("SELECT COALESCE(SUM(status='GRANTED'),0) AS granted, COALESCE(SUM(status LIKE 'REJECT%'),0) AS rejected, COUNT(*) AS total FROM reward_log");
    const [pubRows] = await pool.query('SELECT domain,name,payout_rate,cat,geo FROM publishers ORDER BY domain DESC LIMIT 50');
    const [todayRows] = await pool.query('SELECT COUNT(*) AS impressions, COALESCE(SUM(price_micros),0) AS gross_micros FROM bid_win_log WHERE DATE(created_at)=CURDATE()');
    res.json({
      platform: {
        grossMicros: Number(tot.gross_micros), impressions: Number(tot.impressions),
        conversions: Number(conv.conversions), clicks: Number(conv.clicks),
        todayImpressions: Number(todayRows[0].impressions), todayGrossMicros: Number(todayRows[0].gross_micros),
        ssp: sspLedger, publishers: pubLedger
      },
      reward: { granted: Number(rw.granted) || 0, rejected: Number(rw.rejected) || 0, total: Number(rw.total) || 0 },
      advertisers: advRows, publisherList: pubRows
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== DSP 赢价回收 =====
app.post('/notify', async (req, res) => {
  const { cid, crid, impid, reqid, price, win = true } = req.body || {};
  if (!win) return res.json({ ok: true, counted: false });
  const imp = String(impid || '');
  if (!imp) return res.status(400).json({ error: 'impid required' });
  // 去重改用复合身份 (impid, reqid)：
  // 仅按 impid 去重会把"不同请求复用了同一 slot 名"误判为重放 → 广告主曝光已投放却不扣费（资金漏洞）
  const reqId = String(reqid || '');
  // 去重以 adv_ledger 为准：/notify 自身只写 adv_ledger（唯一键 uk_imp_req 兜底），查 bid_win_log 会漏判导致重复扣费
  const [[dup]] = await pool.query('SELECT 1 FROM adv_ledger WHERE imp_id=? AND req_id=?', [imp, reqId]);
  if (dup) return res.json({ ok: true, counted: false, dup: true }); // 同一请求的重放赢价忽略，防刷曝光
  const micros = Math.max(0, Number(price) || 0);
  const id = Number(cid) || 0;
  try {
    // 仅扣广告主预算；胜出记录由 /ssp/bid 统一落库（含 publisher 维度），避免重复计
    const [up] = await pool.query('UPDATE adv_campaign SET budget_micros = budget_micros - ? WHERE id = ? AND budget_micros >= ?', [micros, id, micros]);
    // 余额不足时 UPDATE 影响 0 行：曝光已投放但扣不到款 → 记为挂账，由对账报表暴露
    const insufficient = up && Number(up.affectedRows) === 0 ? 1 : 0;
    await pool.query('INSERT IGNORE INTO adv_ledger (campaign_id,imp_id,req_id,charge_micros,insufficient) VALUES (?,?,?,?,?)', [id, imp, reqId, micros, insufficient]).catch(() => {});
    await pool.query('INSERT INTO daily_spend (campaign_id,d,micros) VALUES (?,CURDATE(),?) ON DUPLICATE KEY UPDATE micros=micros+VALUES(micros)', [id, micros]).catch(() => {});
    bustPace(id);
    if (insufficient) cache.incr('charge_insufficient');
    res.json({ ok: true, counted: true, charged: micros, insufficient: !!insufficient });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== 媒体方（供给）入驻 API =====
app.post('/api/publisher', async (req, res) => {
  const { domain, name, contact, payout_rate, site_url, cat, geo, keywords } = req.body || {};
  if (!domain) return res.status(400).json({ error: 'domain required' });
  const rate = payout_rate != null ? Math.max(0.1, Math.min(0.95, Number(payout_rate))) : 0.70;
  // 安全：已入驻媒体不得被重复调用重写/套取密钥（否则任何人 POST 一次即可夺取 S2S 签名私钥）
  const [[exist]] = await pool.query('SELECT api_key FROM publishers WHERE domain=?', [domain]).catch(() => [[]]);
  await pool.query('INSERT INTO publishers (domain,name,contact,payout_rate,site_url,cat,geo,keywords) VALUES (?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE name=VALUES(name),contact=VALUES(contact),payout_rate=VALUES(payout_rate),site_url=VALUES(site_url),cat=VALUES(cat),geo=VALUES(geo),keywords=VALUES(keywords)',
    [domain, name || domain, contact || '', rate, site_url || '', cat || '', geo || '', keywords || '']);
  pubMetaCache.set(domain, { rate, cat: cat || '', geo: geo || '', keywords: (keywords || '').split(',').filter(Boolean) });
  // 同步开通媒体独立账号（作用域=域名），供媒体后台登录查看自己的收益报表
  // 修掉原缺陷：ON DUPLICATE KEY UPDATE pass_hash=VALUES(pass_hash) 会在媒体重复提交入驻时把密码重置成随机值，
  //   而「密钥已存在」分支又不返回密码 → 媒体被永久锁在后台外（且自己完全不知情）。
  //   改为：账号已存在只补 display/scope，绝不动 pass_hash；未返回密码时前端提示「密码沿用首次注册设定」。
  const acctPass = (req.body && req.body.password) ? String(req.body.password) : ('pub_' + crypto.randomBytes(6).toString('hex'));
  let accExists = false;
  try {
    const [[acc]] = await pool.query('SELECT id FROM accounts WHERE type="publisher" AND username=?', [domain]);
    accExists = !!(acc && acc.id);
    if (accExists) {
      await pool.query('UPDATE accounts SET display=?, scope=? WHERE id=?', [name || domain, domain, acc.id]).catch(() => {});
    } else {
      await pool.query('INSERT INTO accounts (type,username,pass_hash,scope,display) VALUES (?,?,?,?,?)',
        ['publisher', domain, security.hashPwd(acctPass), domain, name || domain]).catch(() => {});
    }
  } catch (e) {}
  if (exist && exist.api_key) {
    return res.json({ ok: true, domain, payout_rate: rate, keyIssued: false,
      account: { username: domain, password: accExists ? undefined : acctPass },
      note: '已入驻，密钥不予返回；媒体账号用户名=域名' +
        (accExists ? '（密码沿用首次注册时设定的值，如需找回请由管理员重置）' : '（密码见 account.password）') +
        '。轮换密钥请走 GET /api/publisher/:domain/key?rotate=1（需管理员令牌）' });
  }
  const key = 'pub_' + crypto.randomBytes(16).toString('hex'); // 首次入驻签发，仅此一次返回
  await pool.query('UPDATE publishers SET api_key=? WHERE domain=?', [key, domain]);
  res.json({ ok: true, domain, payout_rate: rate, api_key: key, keyIssued: true,
    account: { username: domain, password: accExists ? undefined : acctPass },
    note: '已开通媒体独立账号（用户名=域名，密码见 account.password）；SDK 用 api_key，后台登录用账号' });
});

// 查看 / 轮换媒体服务端密钥（S2S 回调签名用）
app.get('/api/publisher/:domain/key', security.requireAdmin('pubkey'), async (req, res) => {
  const d = String(req.params.domain || '');
  try {
    if (String(req.query.rotate || '') === '1') {
      const k = 'pub_' + crypto.randomBytes(16).toString('hex');
      await pool.query('UPDATE publishers SET api_key=? WHERE domain=?', [k, d]);
      return res.json({ ok: true, domain: d, api_key: k, rotated: true });
    }
    const [[row]] = await pool.query('SELECT api_key FROM publishers WHERE domain=?', [d]);
    res.json({ ok: true, domain: d, api_key: (row && row.api_key) || '' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/publishers', security.requireAdmin('publist'), async (_, res) => {
  try { const [rows] = await pool.query('SELECT domain,name,contact,payout_rate,site_url,cat,geo,keywords,status FROM publishers'); res.json(rows); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
// 合规供给爬虫：抓取媒体方自己声明的 site_url，LLM 提取 cat/geo/keywords 回填（限流+冷却由调用方控制）
app.post('/api/publisher/:domain/crawl', security.requireAdmin('pubcrawl'), async (req, res) => {
  const domain = req.params.domain;
  try {
    const [[p]] = await pool.query('SELECT site_url FROM publishers WHERE domain=?', [domain]);
    if (!p || !p.site_url) return res.status(400).json({ error: '该媒体方未声明 site_url，无法合规爬取' });
    const r = await fetch(p.site_url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SupplyCrawler/1.0)' } });
    if (!r.ok) return res.status(502).json({ error: '抓取失败 ' + r.status });
    const html = await r.text();
    const text = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 2000);
    const prof = await llm.extractSupplyTags(text);
    if (!prof) return res.json({ ok: false, reason: 'LLM 未返回(未配置Key时用启发式)' });
    const kw = [...new Set([...(prof.keywords || []), ...(prof.tags || [])])].join(',');
    await pool.query('UPDATE publishers SET cat=?, geo=?, keywords=?, last_crawl=? WHERE domain=?',
      [prof.category || '', (prof.geo || [])[0] || '', kw, Date.now(), domain]);
    pubMetaCache.set(domain, { rate: (pubMetaCache.get(domain) || {}).rate || 0.70, cat: prof.category || '', geo: (prof.geo || [])[0] || '', keywords: kw.split(',').filter(Boolean) });
    res.json({ ok: true, domain, cat: prof.category, geo: prof.geo, keywords: kw, summary: prof.summary, llm_enabled: llm.ENABLED });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== 广告主控制台 API =====
app.post('/api/campaign', security.requireAuth('admin','advertiser'), async (req, res) => {
  const { name, advertiser: advBody, budget_cny, country, app_category, creative_html, landing_url, target_cpm_cny, intent_tags } = req.body || {};
  const advertiser = (req.account && req.account.t === 'advertiser') ? req.account.s : (advBody || '');
  if (!name || !creative_html) return res.status(400).json({ error: 'name,creative_html required' });
  const budget_micros = Math.round((budget_cny || 1000) * 1e6);
  const target_cpm_micros = Math.round((target_cpm_cny || 5) * 1e6);
  const [r] = await pool.query('INSERT INTO adv_campaign (name,advertiser,budget_micros,country,app_category,creative_html,landing_url,target_cpm_micros,intent_tags,review_status) VALUES (?,?,?,?,?,?,?,?,?,?)',
    [name, advertiser || '', budget_micros, country || '', app_category || '', creative_html, landing_url || '', target_cpm_micros, intent_tags || '', 'pending']);
  enrichCampaign(r.insertId).catch(e => console.error('[enrich]', e.message)); // 异步 LLM 抽意图
  res.json({ ok: true, id: r.insertId, llm_enrich: llm.ENABLED, review_status: 'pending' });
});
app.get('/api/campaigns', security.requireAuth('admin','advertiser'), async (req, res) => {
  const acc = req.account;
  const sql = acc.t === 'advertiser'
    ? 'SELECT id,name,advertiser,budget_micros,status,country,app_category,target_cpm_micros,intent_tags,intent_profile,review_status FROM adv_campaign WHERE advertiser=?'
    : 'SELECT id,name,advertiser,budget_micros,status,country,app_category,target_cpm_micros,intent_tags,intent_profile,review_status FROM adv_campaign';
  const [rows] = await pool.query(sql, acc.t === 'advertiser' ? [acc.s] : []);
  res.json(rows.map(c => ({
    ...c, budget_cny: c.budget_micros / 1e6, target_cpm_cny: c.target_cpm_micros / 1e6,
    intent_summary: (c.intent_profile && JSON.parse(c.intent_profile).summary) || null,
    intent_source: c.intent_profile ? 'llm' : 'manual',
  })));
});

// 意图检索演示：给定流量上下文，返回匹配度最高的广告主(意图)与预估 eCPM（LLM 或启发式）
app.post('/api/intent-match', async (req, res) => {
  const ctx = req.body || {};
  const [rows] = await pool.query('SELECT * FROM adv_campaign WHERE status=1');
  const matches = [];
  for (const c of rows) {
    const rel = await llmRel(c, ctx);
    matches.push({
      id: c.id, name: c.name,
      intent_score: rel.score, source: rel.llm ? 'llm' : 'heuristic', reason: rel.reason,
      est_cpm_cny: Math.round(Math.min(c.target_cpm_micros, c.budget_micros) * (1 + 0.5 * rel.score) / 1e4) / 100,
    });
  }
  matches.sort((a, b) => b.intent_score - a.intent_score);
  res.json({ ctx, llm_enabled: llm.ENABLED, matches });
});

// LLM 抽取意图：单个 campaign 重抽（创建时也会自动抽）
app.post('/api/intent-extract/:id', security.requireAuth('admin','advertiser'), async (req, res) => {
  try {
    const id = +req.params.id;
    if (req.account.t === 'advertiser') {
      const [[c]] = await pool.query('SELECT id FROM adv_campaign WHERE id=? AND advertiser=?', [id, req.account.s]);
      if (!c) return res.status(403).json({ error: '无权操作他人计划' });
    }
    await enrichCampaign(id);
    const [[c]] = await pool.query('SELECT id,name,intent_tags,intent_profile FROM adv_campaign WHERE id=?', [id]);
    res.json({ ok: true, id: c.id, name: c.name, intent_tags: c.intent_tags, intent_profile: c.intent_profile ? JSON.parse(c.intent_profile) : null, llm_enabled: llm.ENABLED });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// LLM 抽取意图：批量重抽所有在投 campaign
app.post('/api/intent-extract', security.requireAdmin('enrich'), async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT id FROM adv_campaign WHERE status=1');
    await Promise.all(rows.map(r => enrichCampaign(r.id)));
    res.json({ ok: true, enriched: rows.length, llm_enabled: llm.ENABLED });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// 并单：更新 campaign 意图标签（意图 Agent 自动撮合时调用）
// 广告主自助视图：只看自己作用域内的计划 + 聚合数据（对标 AppLovin 广告主后台）
app.get('/api/advertiser/me', security.requireAuth('advertiser'), async (req, res) => {
  const adv = req.account.s;
  try {
    const [rows] = await pool.query('SELECT id,name,advertiser,budget_micros,status,review_status,country,app_category,target_cpm_micros FROM adv_campaign WHERE advertiser=?', [adv]);
    const [[agg]] = await pool.query(`
      SELECT COUNT(DISTINCT b.imp_id) impressions, COALESCE(SUM(b.price_micros),0)/1e6 spent_cny, COALESCE(SUM(c.amount),0) gmv
      FROM adv_campaign a
      LEFT JOIN bid_win_log b ON b.campaign_id=a.id
      LEFT JOIN conv_log c ON c.campaign_id=a.id AND c.type='conversion'
      WHERE a.advertiser=?`, [adv]);
    res.json({ advertiser: adv, campaigns: rows.map(c => ({ ...c, budget_cny: c.budget_micros / 1e6 })),
      stats: { impressions: Number(agg.impressions) || 0, spent_cny: Number(agg.spent_cny) || 0, gmv: Number(agg.gmv) || 0 } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/campaign/:id/tags', security.requireAdmin('tags'), async (req, res) => {
  try {
    const { intent_tags } = req.body || {};
    await pool.query('UPDATE adv_campaign SET intent_tags=? WHERE id=?', [intent_tags || '', +req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// 素材审核通过（只有通过 approved 的素材才参拍）
app.put('/api/campaign/:id/approve', security.requireAdmin('approve'), async (req, res) => {
  try {
    await pool.query("UPDATE adv_campaign SET review_status='approved' WHERE id=?", [+req.params.id]);
    res.json({ ok: true, review_status: 'approved' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== 报表 =====
// ===== eCPM' 引擎（对齐 BP_v7 §2.6 / §3.3 三层评测冷启动）=====
const numOr = (v, d) => (typeof v === 'number' ? v : d);

// 用 DB 里的三层评测结果 + 归因样本回填候选 SKU：
//   评测分(eval_score) = 冷启动先验；已积累的归因样本 = 行为数据，两者按 α 衰减融合（§2.6）
async function enrichCandidates(candidates) {
  const ids = candidates.map((c) => c.skuId).filter(Boolean);
  if (!ids.length) return candidates;
  const [ev] = await pool.query('SELECT * FROM sku_eval WHERE sku_id IN (?)', [ids]);
  const [st] = await pool.query('SELECT * FROM sku_stats WHERE sku_id IN (?)', [ids]);
  const evMap = {}, stMap = {};
  ev.forEach((r) => (evMap[r.sku_id] = r));
  st.forEach((r) => (stMap[r.sku_id] = r));
  return candidates.map((c) => {
    const o = { ...c };
    const e = evMap[c.skuId];
    if (e) {
      o.evalScore = Number(e.eval_score);
      o.evalDetail = { l1: +e.l1, l2: +e.l2, l3: +e.l3 };
      if (!o.name) o.name = e.name;
    }
    const s = stMap[c.skuId];
    if (s) {
      o.nSamples = s.n_samples;
      o.successes = s.successes;
      o.failures = s.failures;
      // 行为数据 = 归因回流观测到的真实商机率（T+30）
      if (s.n_samples > 0) o.behaviorScore = s.successes / s.n_samples;
    }
    if (o.nSamples == null) o.nSamples = 0;
    if (o.successes == null) o.successes = 0;
    if (o.failures == null) o.failures = 0;
    return o;
  });
}

// ① 注册/更新某服务包的三层评测结果（L1 能力 / L2 效果 / L3 口碑）→ 合成冷启动评测分
app.post('/api/ecpm/eval', async (req, res) => {
  const { skuId, name, l1, l2, l3 } = req.body || {};
  if (!skuId) return res.status(400).json({ error: 'skuId required' });
  const evalScore = ecpm.composeEvalScore({ l1: numOr(l1, 0.5), l2: numOr(l2, 0.5), l3: numOr(l3, 0.5) });
  try {
    await pool.query(
      `INSERT INTO sku_eval (sku_id,name,l1,l2,l3,eval_score) VALUES (?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE name=VALUES(name), l1=VALUES(l1), l2=VALUES(l2), l3=VALUES(l3), eval_score=VALUES(eval_score)`,
      [skuId, name || skuId, numOr(l1, 0.5), numOr(l2, 0.5), numOr(l3, 0.5), evalScore]);
    res.json({ ok: true, skuId, evalScore, alpha: +ecpm.alpha(0).toFixed(3) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ② 评测库一览（含已积累样本与 α 衰减状态）
app.get('/api/ecpm/evals', async (_, res) => {
  try {
    const [ev] = await pool.query('SELECT * FROM sku_eval');
    const [st] = await pool.query('SELECT * FROM sku_stats');
    const sm = {}; st.forEach((x) => (sm[x.sku_id] = x));
    res.json(ev.map((r) => ({
      skuId: r.sku_id, name: r.name, l1: +r.l1, l2: +r.l2, l3: +r.l3, evalScore: +r.eval_score,
      nSamples: sm[r.sku_id] ? sm[r.sku_id].n_samples : 0,
      successes: sm[r.sku_id] ? sm[r.sku_id].successes : 0,
      failures: sm[r.sku_id] ? sm[r.sku_id].failures : 0,
      alpha: +ecpm.alpha(sm[r.sku_id] ? sm[r.sku_id].n_samples : 0).toFixed(3),
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ③ 归因回流（T+30 商机判定回写）→ 行为数据累积，α 衰减后行为分接管排序
app.post('/api/ecpm/feedback', async (req, res) => {
  const { skuId, converted } = req.body || {};
  if (!skuId) return res.status(400).json({ error: 'skuId required' });
  const ok1 = converted ? 1 : 0;
  try {
    await pool.query(
      `INSERT INTO sku_stats (sku_id,n_samples,successes,failures) VALUES (?,1,?,?)
       ON DUPLICATE KEY UPDATE n_samples=n_samples+1, successes=successes+?, failures=failures+?`,
      [skuId, ok1, 1 - ok1, ok1, 1 - ok1]);
    const [[s]] = await pool.query('SELECT * FROM sku_stats WHERE sku_id=?', [skuId]);
    res.json({
      ok: true, skuId, nSamples: s.n_samples,
      behaviorScore: s.n_samples ? +(s.successes / s.n_samples).toFixed(4) : null,
      alpha: +ecpm.alpha(s.n_samples).toFixed(3),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 清空某 SKU（或全部）的归因样本，便于重复演示"冷启动 → 学习接管"
app.post('/api/ecpm/reset', async (req, res) => {
  const { skuId } = req.body || {};
  try {
    if (skuId) await pool.query('DELETE FROM sku_stats WHERE sku_id=?', [skuId]);
    else await pool.query('DELETE FROM sku_stats');
    res.json({ ok: true, reset: skuId || 'ALL' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ④ 竞价排序：组织需求事件 → 候选服务包 SKU（已回填评测+归因）→ 统一 eCPM' 排序
app.post('/api/ecpm/rank', async (req, res) => {
  const { demand, candidates, slot, opts } = req.body || {};
  if (!Array.isArray(candidates) || !candidates.length) return res.status(400).json({ error: 'candidates[] required' });
  try {
    const enriched = await enrichCandidates(candidates);
    const out = ecpm.selectWinner(demand || {}, enriched, slot || {}, opts || {});
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/report', async (_, res) => {
  try {
    const [rows] = await pool.query('SELECT id,name,budget_micros,status FROM adv_campaign');
    const [[agg]] = await pool.query('SELECT COUNT(*) wins, COALESCE(SUM(price_micros),0) spent FROM bid_win_log');
    res.json({ campaigns: rows.map(c => ({ ...c, budget_cny: c.budget_micros / 1e6 })), wins: agg.wins, spent_cny: Number(agg.spent) / 1e6 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// 多广告主隔离报表：按 advertiser 聚合曝光/花费/GMV（对标 AppLuck 多客户分账）
app.get('/api/report/advertiser', async (_, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT a.advertiser,
        COUNT(DISTINCT b.imp_id) impressions,
        COALESCE(SUM(b.price_micros),0)/1e6 spent_cny,
        COALESCE(SUM(c.amount),0) gmv
      FROM adv_campaign a
      LEFT JOIN bid_win_log b ON b.campaign_id=a.id
      LEFT JOIN conv_log c ON c.campaign_id=a.id AND c.type='conversion'
      GROUP BY a.advertiser`);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// SSP 结算报表：由 bid_win_log（含 publisher 维度）实时聚合，重启不丢、按媒体方归因
app.get('/ssp/report', async (_, res) => {
  try {
    const [rows] = await pool.query('SELECT publisher, COUNT(*) wins, COALESCE(SUM(price_micros),0) gross FROM bid_win_log GROUP BY publisher');
    const [pubs] = await pool.query('SELECT domain, payout_rate FROM publishers');
    const rateMap = {}; pubs.forEach(p => rateMap[p.domain] = Number(p.payout_rate) || 0.7);
    let grossAll = 0, payoutAll = 0;
    const list = rows.map(r => {
      const rate = rateMap[r.publisher] || 0.7; const gross = Number(r.gross);
      const payout = Math.round(gross * rate); grossAll += gross; payoutAll += payout;
      return { publisher: r.publisher, wins: Number(r.wins), gross_cny: gross / 1e6, payout_cny: payout / 1e6, ssp_margin_cny: (gross - payout) / 1e6 };
    });
    const margin = grossAll - payoutAll;
    res.json({ ssp: { wins: list.reduce((a, b) => a + b.wins, 0), gross_cny: grossAll / 1e6, payout_cny: payoutAll / 1e6, ssp_margin_cny: margin / 1e6, margin_rate: grossAll ? margin / grossAll : 0 }, publishers: list });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== 公共（免登录）接口：营销漏斗 / 免费工具 / 演示可信度 =====
// eCPM' 免费打分器（工具钩子）：复用与平台同款的 ecpm_engine，纯计算、不读敏感数据、无鉴权
app.get('/api/public/ecpm-score', async (req, res) => {
  const q = req.query || {};
  const num = (v, d) => (v === undefined || v === '' ? d : Number(v));
  const sku = {
    skuId: 'tool-' + Date.now(),
    bidType: String(q.bidType || 'CPM').toUpperCase(),
    bid: num(q.bid, 1000),              // CPM=元/千次 · CPC=元/次 · CPA=元/商机
    ltvFactor: num(q.ltv, 1.0),         // LTV 预测系数
    svcFactor: num(q.svc, 1.0),         // 服务承诺系数（SLA/赔付）
    nSamples: num(q.nSamples, 0),       // 已回流归因样本数（T+30）
    successes: num(q.successes, 0),
    failures: num(q.failures, 0),
    l1: num(q.l1, 0.5), l2: num(q.l2, 0.5), l3: num(q.l3, 0.5), // 三层评测分
  };
  if (q.evalScore !== undefined && q.evalScore !== '') sku.evalScore = Number(q.evalScore); // 直接给合成评测分则优先
  const slot = { ctr: num(q.ctr, 0.12), leadRate: num(q.leadRate, 0.10) };
  const ranked = ecpm.rankCandidates({ cat: q.cat || '' }, [sku], slot, { deterministic: true });
  const r = ranked[0] || {};
  const unified = Number(r.unifiedEcpm) || 0;
  res.json({
    ok: true,
    ecpmPrime: r.ecpmPrime,               // 排序分（效果×LTV×折算出价×服务承诺）
    pEffect: r.pEffect,                   // 效果预测（贝叶斯融合，冷启动先验+行为数据）
    unifiedEcpm: unified,                 // 折算到"每千次曝光"的期望收入
    alpha: +ecpm.alpha(sku.nSamples).toFixed(3), // 先验权重：样本越多，真实效果越接管
    coldStart: !!r.cold,
    estRange: [+((unified * 0.8) < 1e-9 ? 0 : unified * 0.8).toFixed(3), +((unified * 1.25)).toFixed(3)],
    note: "eCPM' = 效果预测 × LTV × 折算出价 × 服务承诺（与平台同款引擎，纯预估，非收益承诺）。",
  });
});

// Prebid 演示页专用的公共只读报表（/report 需 admin；此接口形状对齐 index.html 期望，避免匿名访问 401/undefined）
app.get('/api/demo/report', async (_, res) => {
  try {
    const [[c]] = await pool.query('SELECT * FROM adv_campaign WHERE status=1 ORDER BY id DESC LIMIT 1');
    const [[agg]] = await pool.query('SELECT COUNT(*) wins, COALESCE(SUM(price_micros),0) spent FROM bid_win_log');
    res.json({
      campaign: c ? { id: c.id, name: c.name, budget: c.budget_micros } : { id: 0, name: 'demo', budget: 0 },
      wins: agg ? Number(agg.wins) : 0,
      spent_cny: agg ? Number(agg.spent) / 1e6 : 0,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 需求侧开户已统一到 /api/signup/advertiser（唯一实现）。
// 原 /api/public/advertiser-open 是第二套开户实现：账号作用域取「邮箱」而非「广告主名称」，
//   与 advertiser_signup.html / 广告主控制台的口径不一致（同一主体两个 scope，数据互相看不见）。
//   按「一个角色=一个开户接口=一个作用域口径」收敛后，此处仅保留明确提示，不再重复建账号。
app.post('/api/public/advertiser-open', (req, res) => {
  res.status(410).json({
    error: '该开户入口已下线',
    hint: '请改用统一开户接口 POST /api/signup/advertiser（字段：username/password/advertiser/display，作用域=广告主名称）',
    ui: '/register.html#advertiser'
  });
});

// 软考留资闭环（landing/ruankao/index.html 提交邮箱/微信时回传）：免登录、纯联系方式，无敏感数据
// 这是"访客→拿到资料包"闭环里唯一真正存下联系方式的一环（之前只记了广告转化，没存人）
// 惰性建表：不依赖 init() 启动时序，端点首次被调用时自动建表（幂等），保证冷启动也稳
let _ruankaoLeadReady = false;
async function ensureRuankaoLeadTable() {
  if (_ruankaoLeadReady) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS ruankao_lead (
    id BIGINT AUTO_INCREMENT PRIMARY KEY, contact VARCHAR(128), channel VARCHAR(32) DEFAULT 'direct',
    source VARCHAR(128) DEFAULT '', ip VARCHAR(64) DEFAULT '', delivered TINYINT DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, INDEX(channel), INDEX(created_at))`);
  _ruankaoLeadReady = true;
}
app.post('/api/public/ruankao-lead', async (req, res) => {
  const b = req.body || {};
  const contact = String(b.contact || '').trim();
  if (!contact || contact.length > 120) return res.status(400).json({ error: 'contact 必填（120 字内）' });
  const channel = String(b.channel || 'direct').slice(0, 32);
  const source = String(b.source || '').slice(0, 128);
  const ip = String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim().slice(0, 64);
  try {
    await ensureRuankaoLeadTable();
    const [r] = await pool.query('INSERT INTO ruankao_lead (contact,channel,source,ip) VALUES (?,?,?,?)', [contact, channel, source, ip]);
    res.json({ ok: true, id: r.insertId, msg: '已记录。资料包也可直接用页内百度云提取码立即领取。' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 运营侧读软考线索（只看，导出/批量导入邮件群发工具用）
app.get('/api/leads/ruankao', security.requireAuth('admin'), async (req, res) => {
  try {
    await ensureRuankaoLeadTable();
    const [rows] = await pool.query('SELECT id,contact,channel,source,ip,delivered,created_at FROM ruankao_lead ORDER BY id DESC LIMIT 200');
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// ===== 素材管理（④ 对标真实平台的 Creative Management）=====
app.post('/api/creatives', security.requireAuth('admin','advertiser'), async (req, res) => {
  const b = req.body || {};
  if (!b.content && !b.media_url) return res.status(400).json({ error: 'content 或 media_url 必填其一' });
  const fmt = String(b.format || 'banner').toLowerCase();
  if (!AD_FORMATS.includes(fmt) && fmt !== 'any') return res.status(400).json({ error: 'format 不合法: ' + AD_FORMATS.join('/') });
  const adv = (req.account && req.account.t === 'advertiser') ? req.account.s : (b.advertiser || '');
  try {
    const [r] = await pool.query('INSERT INTO creatives (advertiser,campaign_id,format,type,title,content,media_url,landing_url,width,height) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [adv, Number(b.campaign_id) || 0, fmt, b.type || 'html', b.title || '', b.content || '', b.media_url || '', b.landing_url || '', Number(b.width) || 0, Number(b.height) || 0]);
    creativeAb.bust(Number(b.campaign_id) || 0); // 变体名单变化立即生效
    res.json({ ok: true, id: r.insertId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/creatives', security.requireAuth('admin','advertiser'), async (req, res) => {
  try {
    const acc = req.account; const cid = req.query.campaign_id;
    const [rows] = cid
      ? (acc.t === 'advertiser'
          ? await pool.query('SELECT * FROM creatives WHERE campaign_id=? AND advertiser=? ORDER BY id DESC', [Number(cid), acc.s])
          : await pool.query('SELECT * FROM creatives WHERE campaign_id=? ORDER BY id DESC', [Number(cid)]))
      : (acc.t === 'advertiser'
          ? await pool.query('SELECT * FROM creatives WHERE advertiser=? ORDER BY id DESC LIMIT 200', [acc.s])
          : await pool.query('SELECT * FROM creatives ORDER BY id DESC LIMIT 200'));
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/creatives/:id', security.requireAuth('admin','advertiser'), async (req, res) => {
  const b = req.body || {}; const id = +req.params.id;
  try {
    if (req.account.t === 'advertiser') {
      const [[own]] = await pool.query('SELECT id FROM creatives WHERE id=? AND advertiser=?', [id, req.account.s]);
      if (!own) return res.status(403).json({ error: '无权修改他人素材' });
    }
    const adv = (req.account.t === 'advertiser') ? req.account.s : (b.advertiser || '');
    await pool.query('UPDATE creatives SET advertiser=?,campaign_id=?,format=?,type=?,title=?,content=?,media_url=?,landing_url=?,width=?,height=?,status=? WHERE id=?',
      [adv, Number(b.campaign_id) || 0, String(b.format || 'banner').toLowerCase(), b.type || 'html', b.title || '', b.content || '', b.media_url || '', b.landing_url || '', Number(b.width) || 0, Number(b.height) || 0, b.status || 'active', id]);
    creativeAb.bust(Number(b.campaign_id) || 0); // 变体名单变化立即生效
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/creatives/:id', security.requireAuth('admin','advertiser'), async (req, res) => {
  const id = +req.params.id;
  try {
    if (req.account.t === 'advertiser') {
      const [[own]] = await pool.query('SELECT id FROM creatives WHERE id=? AND advertiser=?', [id, req.account.s]);
      if (!own) return res.status(403).json({ error: '无权删除他人素材' });
    }
    await pool.query('DELETE FROM creatives WHERE id=?', [id]); res.json({ ok: true });
  }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== 需求方(DSP)持久化注册（③ 真实需求方连接）=====
// 注册后该 DSP 立即进入拍卖；并写入 dsp_partners 表，重启后由 init() 自动恢复
app.post('/api/dsp/register', async (req, res) => {
  const { name, url, payoutRate = 0.6, type = 'http', isOwn = 0 } = req.body || {};
  if (!name || !url) return res.status(400).json({ error: 'name,url required' });
  try {
    await pool.query('INSERT INTO dsp_partners (name,url,payout_rate,type,is_own) VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE url=VALUES(url),payout_rate=VALUES(payout_rate),type=VALUES(type),is_own=VALUES(is_own),status=1',
      [name, url, Number(payoutRate), type, isOwn ? 1 : 0]);
    if (!DEMAND_PARTNERS.find(p => p.name === name)) DEMAND_PARTNERS.push({ name, type, url, payoutRate: Number(payoutRate), isOwn: !!isOwn });
    res.json({ ok: true, partners: DEMAND_PARTNERS.map(p => p.name) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/dsp', async (_, res) => {
  try { const [rows] = await pool.query('SELECT name,url,payout_rate,type,is_own,status FROM dsp_partners WHERE status=1 ORDER BY id DESC'); res.json(rows); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/dsp/:name', async (req, res) => {
  const n = req.params.name;
  try { await pool.query('UPDATE dsp_partners SET status=0 WHERE name=?', [n]); DEMAND_PARTNERS = DEMAND_PARTNERS.filter(p => p.name !== n); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== 结算 / 报表闭环（⑤ 对标多客户分账）=====
// SSP 全局结算（由 bid_win_log 聚合，含媒体方分成与 SSP 毛利）
// 广告主侧对账：应收(adv_ledger) vs 已投放(bid_win_log)，diff≠0 需人工核查
app.get('/api/reports/reconciliation', async (req, res) => {
  try {
    const [ledger] = await pool.query('SELECT campaign_id, COUNT(*) n, SUM(charge_micros) charged, SUM(insufficient) bad FROM adv_ledger GROUP BY campaign_id');
    // 仅统计 billable=1 的行：历史重复记录已标记为不可计费，避免"已投放未扣费"的假差异
    const [wins] = await pool.query('SELECT campaign_id, COUNT(*) n, SUM(price_micros) served FROM bid_win_log WHERE campaign_id>0 AND COALESCE(billable,1)=1 GROUP BY campaign_id');
    const [[nb]] = await pool.query('SELECT COUNT(*) n FROM bid_win_log WHERE COALESCE(billable,1)=0');
    const lMap = new Map(ledger.map(l => [Number(l.campaign_id), l]));
    const rows = wins.map(w => {
      const l = lMap.get(Number(w.campaign_id));
      const served = Number(w.served) || 0, charged = l ? (Number(l.charged) || 0) : 0;
      return {
        campaign_id: Number(w.campaign_id), win_n: w.n, ledger_n: l ? l.n : 0,
        served_micros: served, charged_micros: charged, diff_micros: charged - served,
        insufficient: l ? (Number(l.bad) || 0) : 0,
        issue: charged === served ? '' : (l ? 'AMOUNT_MISMATCH' : 'NO_LEDGER')
      };
    });
    const tCharged = rows.reduce((s, r) => s + r.charged_micros, 0);
    const tServed = rows.reduce((s, r) => s + r.served_micros, 0);
    res.json({
      rows: rows.sort((a, b) => Math.abs(b.diff_micros) - Math.abs(a.diff_micros)),
      total: { charged_micros: tCharged, served_micros: tServed, diff_micros: tCharged - tServed },
      non_billable_rows: Number(nb && nb.n) || 0,
      note: 'diff≠0 或 issue 非空即账务与投放不一致，需人工核查'
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/reports/settlement', async (_, res) => {
  try {
    const [rows] = await pool.query('SELECT publisher, COUNT(*) wins, COALESCE(SUM(price_micros),0) gross FROM bid_win_log GROUP BY publisher');
    const [pubs] = await pool.query('SELECT domain, payout_rate FROM publishers');
    const rateMap = {}; pubs.forEach(p => rateMap[p.domain] = Number(p.payout_rate) || 0.7);
    let grossAll = 0, payoutAll = 0;
    const list = rows.map(r => {
      const rate = rateMap[r.publisher] || 0.7; const gross = Number(r.gross);
      const payout = Math.round(gross * rate); grossAll += gross; payoutAll += payout;
      return { publisher: r.publisher, wins: Number(r.wins), gross_cny: gross / 1e6, payout_cny: payout / 1e6, ssp_margin_cny: (gross - payout) / 1e6 };
    });
    const margin = grossAll - payoutAll;
    res.json({ ssp: { wins: list.reduce((a, b) => a + b.wins, 0), gross_cny: grossAll / 1e6, payout_cny: payoutAll / 1e6, ssp_margin_cny: margin / 1e6, margin_rate: grossAll ? margin / grossAll : 0 }, publishers: list });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// 媒体方自助报表（凭 api_key 或 domain/作用域令牌 查看自己的胜出/分成/完播/转化）——抽成公共函数
async function publisherReport(key) {
  // key 可能是 api_key，也可能是媒体账号令牌的作用域(=域名)，两者都支持
  const [[p]] = await pool.query('SELECT domain,name,payout_rate FROM publishers WHERE api_key=? OR domain=?', [String(key || ''), String(key || '')]);
  if (!p) { const e = new Error('invalid api_key or domain'); e.status = 403; throw e; }
  const domain = p.domain; const rate = Number(p.payout_rate) || 0.7;
  const [[w]] = await pool.query('SELECT COUNT(*) wins, COALESCE(SUM(price_micros),0) gross FROM bid_win_log WHERE publisher=?', [domain]);
  const [[rw]] = await pool.query("SELECT COALESCE(SUM(status='GRANTED'),0) granted, COUNT(*) total FROM reward_log WHERE publisher=?", [domain]);
  const [[ck]] = await pool.query("SELECT COUNT(*) clicks FROM conv_log WHERE type='click' AND publisher=?", [domain]);
  const [[cv]] = await pool.query("SELECT COUNT(*) conversions, COALESCE(SUM(amount),0) gmv FROM conv_log WHERE type='conversion' AND publisher=?", [domain]);
  const gross = Number(w.gross) || 0; const payout = Math.round(gross * rate);
  return {
    publisher: { domain, name: p.name, payout_rate: rate },
    wins: Number(w.wins), gross_cny: gross / 1e6, payout_cny: payout / 1e6, ssp_margin_cny: (gross - payout) / 1e6,
    rewarded_granted: Number(rw.granted) || 0, rewarded_total: Number(rw.total) || 0,
    clicks: Number(ck.clicks) || 0, conversions: Number(cv.conversions) || 0, gmv: Number(cv.gmv) || 0
  };
}
// 内部：管理员也可按 api_key 查某媒体（保留原语义）
app.get('/api/reports/publisher', async (req, res) => {
  try { res.json(await publisherReport(req.query.api_key)); }
  catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
// 供给方自助（公开，仅 api_key 鉴权，不要求管理员令牌）——真正的「媒体后台」入口，规避管理员网关
app.get('/api/publisher/report', (req, res, next) => {
  const a = security.accountFromReq(req);
  if (a && a.t === 'publisher') { req.pubScope = a.s; return next(); }
  if (req.query.api_key) return next();
  return res.status(401).json({ error: 'unauthorized', hint: '请登录媒体账号或携带 api_key' });
}, async (req, res) => {
  try { res.json(await publisherReport(req.pubScope || req.query.api_key)); }
  catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// ===== P1 隐私与测量：多触点归因 + SKAN 聚合回传 =====
// 多触点归因：给定 impid，返回 曝光→点击→转化 全链路触点，并按指定模型分配功劳
// model: last_touch | first_touch | linear | time_decay | position_based | data_driven | compare
app.get('/api/attribution', async (req, res) => {
  const imp = String(req.query.impid || '');
  const model = String(req.query.model || 'last_touch');
  if (!imp) return res.status(400).json({ error: 'impid required' });
  try {
    const [[win]] = await pool.query('SELECT campaign_id, publisher, price_micros, created_at FROM bid_win_log WHERE imp_id=?', [imp]);
    if (!win) return res.status(404).json({ error: 'no impression' });
    const [clicks] = await pool.query("SELECT id, created_at FROM conv_log WHERE type='click' AND imp_id=?", [imp]);
    const [convs] = await pool.query("SELECT id, amount, created_at FROM conv_log WHERE type='conversion' AND imp_id=?", [imp]);
    // 构造触点链：曝光 + 点击按时间排序，转化时间作为归因基准
    const journey = attribution.multiTouch.buildJourney([
      { imp_id: imp, campaign_id: win.campaign_id, publisher: win.publisher, price_micros: win.price_micros, created_at: win.created_at, type: 'impression' },
      ...clicks.map(c => ({ imp_id: imp, campaign_id: win.campaign_id, publisher: win.publisher, created_at: c.created_at, type: 'click' })),
    ]);
    const convTs = convs.length ? new Date(convs[convs.length - 1].created_at).getTime() : undefined;
    const attr = attribution.multiTouch.attribute(journey, model, {
      convTs, vta: { enabled: req.query.vta !== '0', factor: Number(req.query.vta_factor) || undefined },
    });
    if (model === 'compare') {
      return res.json({ impid: imp, campaign_id: win.campaign_id, publisher: win.publisher,
        impression: { price_micros: win.price_micros, at: win.created_at }, clicks, conversions: convs,
        models: attribution.multiTouch.compare(journey, { convTs }) });
    }
    res.json({ impid: imp, campaign_id: win.campaign_id, publisher: win.publisher,
      impression: { price_micros: win.price_micros, at: win.created_at }, clicks, conversions: convs,
      attribution: attr });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// SKAN conversion schema 管理：事件→conversion value 的编码必须版本化，否则历史数据不可比
app.post('/api/skan/schema', async (req, res) => {
  const b = req.body || {};
  if (!b.campaign_id) return res.status(400).json({ error: 'campaign_id required' });
  try { res.json(await attribution.skan.defineSchema(b.campaign_id, b)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/skan/schema/:cid', async (req, res) => {
  try { res.json((await attribution.skan.getSchema(Number(req.params.cid), String(req.query.version || '4.0'), String(req.query.app_id || ''))) || { none: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/skan/aggregate', async (req, res) => {
  try { res.json(await attribution.skan.aggregate({ campaignId: Number(req.query.campaign_id) || 0, days: Number(req.query.days) || 7 })); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
// SKAN 回传接收：验签（Apple ECDSA P-256）+ 解码 + 多窗口去重
app.post('/api/skan/postback', async (req, res) => {
  const b = req.body || {};
  if (!b.dsp_domain && !b.campaign_id) return res.status(400).json({ error: 'dsp_domain/campaign_id required' });
  try { res.json(await attribution.skan.ingest(b, { campaignId: b.campaign_id, skipVerify: process.env.SKAN_SKIP_VERIFY === '1' })); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== 增量度量：holdout / ghost ads / geo-lift =====
app.post('/api/incrementality/create', async (req, res) => {
  try { res.json(await attribution.incrementality.create(req.body || {})); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/incrementality', async (req, res) => {
  try { res.json(await attribution.incrementality.list()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/incrementality/:id/analyze', async (req, res) => {
  try { res.json(await attribution.incrementality.analyze(Number(req.params.id))); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/incrementality/:id/record', async (req, res) => {
  const b = req.body || {};
  try {
    await attribution.incrementality.record(Number(req.params.id), String(b.unit_id || ''), String(b.bucket || 'treat'), b);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/incrementality/:id/stop', async (req, res) => {
  try { res.json(await attribution.incrementality.stop(Number(req.params.id), String((req.body || {}).status || 'stopped'))); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== 身份解析图谱 =====
app.post('/api/identity/resolve', (req, res) => {
  const b = req.body || {};
  try { res.json(identity.resolve(b.ids || {}, b.signals || {}, b)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/identity/stats', (_, res) => res.json(identity.stats()));
app.get('/api/identity/:canonical/apps', async (req, res) => {
  try { res.json({ canonical_id: req.params.canonical, apps: await identity.apps(req.params.canonical) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== 信任层：ads.txt / app-ads.txt / sellers.json（公网只读，买方采买前必查）=====
app.get('/ads.txt', (_, res) => { res.type('text/plain'); res.send(trust.adsTxtContent()); });
app.get('/app-ads.txt', (_, res) => { res.type('text/plain'); res.send(trust.appAdsTxtContent()); });
app.get('/sellers.json', async (_, res) => { res.json(await trust.sellersJson()); });
app.post('/api/trust/crawl/:domain', async (req, res) => {
  const d = decodeURIComponent(req.params.domain);
  try {
    const a = await trust.crawl(d, 'ads.txt');
    const b = await trust.crawl(d, 'app-ads.txt');
    res.json({ ads_txt: a, app_ads_txt: b, supply_chain: await trust.supplyChainStatus(d) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/trust/status/:domain', async (req, res) => {
  try { res.json(await trust.supplyChainStatus(decodeURIComponent(req.params.domain))); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== Pacing：时段 / 频控 / 预算节奏 =====
app.get('/api/pacing/:cid', async (req, res) => {
  try { res.json(await pacing.delivery(Number(req.params.cid))); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/pacing/:cid', async (req, res) => {
  try { res.json(await pacing.save(Number(req.params.cid), req.body || {})); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== 计费闭环：账户 / 充值 / 开票 / 收款 / 账龄 =====
app.post('/api/billing/account', async (req, res) => {
  const b = req.body || {};
  if (!b.party) return res.status(400).json({ error: 'party required' });
  try { res.json(await billing.ensureAccount(b.partyType || 'advertiser', b.party, b)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/billing/accounts', async (req, res) => {
  try { res.json(await billing.listAccounts(req.query.partyType || 'advertiser')); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/billing/topup', async (req, res) => {
  const b = req.body || {};
  try { res.json(await billing.topUp(b.partyType || 'advertiser', b.party, b.micros || 0, b.ref || '')); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/billing/invoice', async (req, res) => {
  const b = req.body || {};
  if (!b.party || !b.start || !b.end) return res.status(400).json({ error: 'party,start,end required' });
  try { res.json(await billing.issueInvoice(b.partyType || 'advertiser', b.party, b.start, b.end, b)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/billing/close-period', async (req, res) => {
  const b = req.body || {};
  if (!b.start || !b.end) return res.status(400).json({ error: 'start,end required' });
  try { res.json(await billing.closePeriod(b.start, b.end, b)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/billing/invoices', async (req, res) => {
  try { res.json(await billing.listInvoices({ partyType: req.query.partyType, party: req.query.party, status: req.query.status })); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/billing/invoice/:no', async (req, res) => {
  try {
    const inv = await billing.getInvoice(req.params.no);
    if (!inv) return res.status(404).json({ error: 'not found' });
    res.json(inv);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/billing/pay', async (req, res) => {
  const b = req.body || {};
  try { res.json(await billing.pay(b.invoice_no, b.micros, b.method || 'transfer', b.ref || '')); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/billing/aging', async (_, res) => {
  try { res.json(await billing.aging()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== 品牌安全策略 =====
app.get('/api/brand-safety/:cid', async (req, res) => {
  try { res.json(await brandSafety.policy(Number(req.params.cid))); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/brand-safety/:cid', async (req, res) => {
  try { res.json(await brandSafety.savePolicy(Number(req.params.cid), req.body || {})); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/brand-safety/report', async (_, res) => {
  try { res.json(await brandSafety.report()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/brand-safety/classify', (req, res) => {
  const b = req.body || {};
  try { res.json(brandSafety.classify(b)); } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== ML 平台：快照 / 校准 / 漂移 / 健康度 / 模型注册 =====
app.get('/api/ml/snapshot', (_, res) => res.json(ml.snapshot()));
app.post('/api/ml/calibrate', async (_, res) => { try { res.json(await ml.refitCalibration()); } catch (e) { res.status(500).json({ error: e.message }); } });
app.get('/api/ml/drift', async (_, res) => { try { res.json(await ml.fs.driftReport()); } catch (e) { res.status(500).json({ error: e.message }); } });
app.get('/api/ml/health', async (_, res) => { try { res.json(await ml.registry.health()); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post('/api/ml/model', async (req, res) => {
  const b = req.body || {};
  try {
    if (b.action === 'promote') return res.json(await ml.registry.promote(b.modelId, b.status, b.trafficPct));
    return res.json(await ml.registry.register(b));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/ml/models', (_, res) => res.json(ml.registry.list()));

// ===== 创意自动化：可玩广告 / 视频 / DCO / 本地化 =====
app.post('/api/creative-auto/generate', async (req, res) => {
  try { res.json(creativeAuto.generate(req.body || {})); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/creative-auto/playable', (req, res) => {
  const b = req.body || {};
  try { res.json({ html: creativeAuto.playable.render(b), bytes: creativeAuto.playable.estimateBytes(b) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/creative-auto/video', (req, res) => {
  const b = req.body || {};
  try {
    const sb = creativeAuto.videogen.storyboard(b.images || [], b);
    res.json({ storyboard: sb, html: creativeAuto.videogen.htmlFallback(sb, b.cta), ffmpeg: creativeAuto.videogen.ffmpegCommand(sb, b.out || 'out.mp4') });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/creative-auto/dco', async (req, res) => {
  const b = req.body || {};
  try {
    const tpl = b.template || creativeAuto.dco.DEFAULT_TEMPLATE;
    const pick = await creativeAuto.dco.pick(tpl, b.item || {}, b.ctx || {}, b.stats || []);
    res.json(pick || { none: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/creative-auto/i18n', async (req, res) => {
  const b = req.body || {};
  try {
    if (b.action === 'translate') {
      const r = await creativeAuto.i18n.autoTranslate(b.copy || {}, b.locales || [], null);
      return res.json(r);
    }
    await creativeAuto.i18n.setText(b.scope || {}, b.locale, b.field, b.text, b.source || 'human');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/creative-auto/capabilities', (_, res) => res.json(creativeAuto.snapshot()));

// ===== 真实生成式模型接入：配置 / 文生图 / 图生视频（落在 /api/creative-auto 管理员前缀下）=====
app.get('/api/creative-auto/gen-config', async (_, res) => {
  try { res.json(await creativeAuto.getGenConfig()); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/creative-auto/gen-config', async (req, res) => {
  try { res.json(await creativeAuto.setGenConfig(req.body || {})); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/creative-auto/generate-image', async (req, res) => {
  try {
    const r = await creativeAuto.generateImage(req.body.prompt || '', req.body || {});
    if (!r.ok) return res.status(400).json(r);
    res.json(r);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/creative-auto/generate-video', async (req, res) => {
  try { res.json(await creativeAuto.imageToVideo(req.body.images || [], req.body.prompt || '')); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
// 真实素材文件上传（base64 → public/uploads → 可入库下发）
app.post('/api/creatives/upload', security.requireAuth('admin', 'advertiser'), async (req, res) => {
  try {
    const { data, name, mime } = req.body || {};
    if (!data) return res.status(400).json({ error: 'data(base64) required' });
    const dir = path.join(__dirname, 'public', 'uploads');
    fs.mkdirSync(dir, { recursive: true });
    const ext = (mime && mime.split('/')[1]) || (name && name.split('.').pop()) || 'bin';
    const fname = 'upl_' + crypto.randomBytes(6).toString('hex') + '.' + String(ext).replace(/[^a-z0-9]/gi, '');
    fs.writeFileSync(path.join(dir, fname), Buffer.from(data, 'base64'));
    res.json({ ok: true, url: '/uploads/' + fname, filename: fname });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== 竞价工程：胜率分布 / shading / 节流状态 =====
app.get('/api/bid/winrate', (_, res) => res.json(bidEng.winrate.snapshot()));
app.get('/api/bid/throttle', (_, res) => res.json(bidEng.throttle.snapshot()));
app.post('/api/bid/shade', (req, res) => {
  const b = req.body || {};
  try { res.json(bidEng.shade({ valueMicros: b.valueMicros, floorMicros: b.floorMicros || 0, ctx: b.ctx || {}, auctionType: b.auctionType || 1 })); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== 可观测性：分位数指标 + SLO（P0 规模化底座）=====
app.get('/metrics', (_, res) => res.json(Object.assign(cache.snapshot(), metrics.snapshot())));
app.get('/metrics/slo', (_, res) => res.json({
  bid_latency: metrics.slo('bid_latency', Number(process.env.BID_P99_TARGET_MS || 10)),
  dsp_latency: metrics.slo('dsp_latency', Number(process.env.DSP_P99_TARGET_MS || 50)),
}));

app.use('/landing', express.static('landing'));   // 平台自托管落地页：广告主 landing_url 可指向 /landing/<项目>/，不再依赖外部托管
app.use(express.static('public'));
init().then(() => {
  const srv = app.listen(PORT, () =>
  console.log(`[platform v2] http://0.0.0.0:${PORT} | SSP /ssp/bid | DSP /openrtb2/bid | 控制台 /advertiser.html | 媒体报表 /publisher_report.html | 意图 /api/intent-match
  意图Agent LLM: ${llm.ENABLED ? `已接入(${llm.PROVIDER.keyEnv}/${llm.MODEL}, 热路径匹配=${llm.LIVE_MATCH ? '开' : '关'})` : '未配置Key(启发式回落, 复制.env.example为.env填入Key启用)'}`));
  // ── 反代(Cloudflare Tunnel)后的连接调优 ──
  // Node 默认 keepAliveTimeout 仅 5s：上游复用稍久一点的空闲连接时，Node 已单方面关闭，
  // 请求会卡到超时（表现为"随机某些端点 15~20s 超时"）。这里放宽以匹配上游保活。
  srv.keepAliveTimeout = Number(process.env.KEEPALIVE_TIMEOUT_MS || 65000);
  srv.headersTimeout = srv.keepAliveTimeout + 5000;            // 必须 > keepAliveTimeout
  srv.requestTimeout = Number(process.env.REQUEST_TIMEOUT_MS || 120000);
  srv.setTimeout(0);                                           // 禁用 socket 空闲超时，交由上游控制
})
