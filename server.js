// 程序化广告平台原型 v2 —— 供给端(SSP) + 需求端(DSP) + 意图匹配(inten>eCPM) + 双边账本
const express = require('express');
const mysql = require('mysql2/promise');
const crypto = require('crypto');
const llm = require('./llm');
const ecpm = require('./ecpm_engine'); // eCPM' 引擎（对齐 BP_v7 §2.6）
const app = express();
app.use(express.json({ limit: '1mb' }));

// 允许跨域：让嵌入第三方网站的 pub_sdk.js 能调用 /ssp/bid、/ssp/imp、/ssp/click
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204); // 预检直接放行
  next();
});
const PORT = process.env.PORT || 8080;

// 健康检查端点：浏览器/监控直接 GET 即可确认服务与隧道全链路通
app.get('/health', (_, res) => res.json({ ok: true, ts: Date.now() }));

const pool = mysql.createPool({ host: '127.0.0.1', port: 3306, user: 'test', password: 'test@fftime', database: 'zhuque', connectionLimit: 5 });

const AUCTION = { secondPrice: true }; // 二价拍卖：胜出者付次高价+0.01元

// 需求方(DSP)注册表：可经 /ssp/demand 动态添加外部 DSP
let DEMAND_PARTNERS = [
  { name: 'zhuque-dsp', type: 'http', url: `http://127.0.0.1:${PORT}/openrtb2/bid`, payoutRate: 0.70, isOwn: true },
  { name: 'external-dsp-A', type: 'mock', priceMicros: 4000000, payoutRate: 0.65, isOwn: false, adm: '<div style="padding:10px;background:#e67e22;color:#fff">外部DSP-A 演示广告</div>', crid: 'ext-a' },
  { name: 'external-dsp-B', type: 'mock', priceMicros: 4500000, payoutRate: 0.60, isOwn: false, adm: '<div style="padding:10px;background:#27ae60;color:#fff">外部DSP-B 演示广告</div>', crid: 'ext-b' }
];

// SSP 账本（内存；生产落 ssp_pub_ledger）
const sspLedger = { wins: 0, grossMicros: 0, payoutMicros: 0 };
const pubLedger = {}; // publisher(domain) -> {wins,grossMicros,payoutMicros,clicks,conversions}
function recordSsp(gross, payout, publisher) {
  sspLedger.wins++; sspLedger.grossMicros += gross; sspLedger.payoutMicros += payout;
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
const RW_SECRET = process.env.RW_SECRET || 'demo-rw-secret-change-me';
const RW_TTL_MS = 5 * 60 * 1000;   // 令牌有效期 5 分钟
const RW_MIN_RATIO = 0.95;         // 完播阈值：观看时长占比 ≥95%
const RW_MAX_RATIO = 1.5;          // 观看时长不可能超过视频时长的 1.5 倍（防伪造时长）

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

// ===== S2S 服务端回调：客户端不可信，媒体服务端签名回调才是结算权威 =====
// 生产请设 S2S_ENFORCE=1：届时客户端 /ssp/reward 只登记为「待确认」，不计入结算。
const S2S_ENFORCE = process.env.S2S_ENFORCE === '1';
const S2S_TTL_MS = 5 * 60 * 1000;
function s2sSign(secret, impid, cid, watchedMs, durationMs, ts) {
  return crypto.createHmac('sha256', String(secret))
    .update(`${impid}|${cid || 0}|${watchedMs}|${durationMs}|${ts}`).digest('hex');
}

// ===== VAST 4.0 返回（行业标准：广告内容为 XML 而非 HTML）=====
const PUBLIC_BASE = process.env.PUBLIC_BASE || 'https://calendar.dellai.xyz';
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
      <AdSystem version="1.0">zhuque-adx</AdSystem>
      <AdTitle><![CDATA[${o.title}]]></AdTitle>
      <Impression id="zhuque-imp"><![CDATA[${q('impression')}]]></Impression>
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
function rwIssue(impid, cid, pub) {
  const ts = Date.now();
  return { impid: String(impid), cid: Number(cid) || 0, pub: String(pub), ts, token: rwSign(rwPayload(impid, cid, pub, ts)) };
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
    await pool.query(`CREATE TABLE IF NOT EXISTS rw_token (
      id INT AUTO_INCREMENT PRIMARY KEY, imp_id VARCHAR(64) NOT NULL UNIQUE, campaign_id INT,
      publisher VARCHAR(128), used TINYINT DEFAULT 0,
      issued_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, used_at TIMESTAMP NULL)`);
    // 激励视频完播审计日志：既记录发放成功，也记录每一次被拒绝的原因（反作弊可追溯）
    await pool.query(`CREATE TABLE IF NOT EXISTS reward_log (
      id BIGINT AUTO_INCREMENT PRIMARY KEY, imp_id VARCHAR(64), campaign_id INT, publisher VARCHAR(128),
      watched_ms INT DEFAULT 0, duration_ms INT DEFAULT 0, ratio DECIMAL(6,3) DEFAULT 0,
      status VARCHAR(32), remote VARCHAR(64), created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
    // VAST 视频事件流水：impression/start/quartile/complete（行业标准可见性与进度度量）
    await pool.query(`CREATE TABLE IF NOT EXISTS vast_event (
      id BIGINT AUTO_INCREMENT PRIMARY KEY, imp_id VARCHAR(64), campaign_id INT, event VARCHAR(32),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
    // 媒体服务端密钥：S2S 回调签名用（客户端不可信，服务端回调才是结算权威）
    await pool.query("ALTER TABLE publishers ADD COLUMN api_key VARCHAR(64) DEFAULT ''").catch(() => {});
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
    await pool.query(`CREATE TABLE IF NOT EXISTS sku_eval (
      sku_id VARCHAR(64) PRIMARY KEY, name VARCHAR(128),
      l1 DECIMAL(4,3) DEFAULT 0.5, l2 DECIMAL(4,3) DEFAULT 0.5, l3 DECIMAL(4,3) DEFAULT 0.5,
      eval_score DECIMAL(5,4) DEFAULT 0.5,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP)`);
    await pool.query(`CREATE TABLE IF NOT EXISTS sku_stats (
      sku_id VARCHAR(64) PRIMARY KEY, n_samples INT DEFAULT 0,
      successes INT DEFAULT 0, failures INT DEFAULT 0,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP)`);
    const [[c]] = await pool.query('SELECT COUNT(*) n FROM adv_campaign');
    if (c.n === 0) {
      await pool.query(`INSERT INTO adv_campaign
        (name,advertiser,budget_micros,country,app_category,creative_html,landing_url,target_cpm_micros,intent_tags) VALUES
        ('益智游戏买量','GameCo',2000000000,'','puzzle','<div style="padding:10px;background:#4F8EF7;color:#fff;border-radius:6px">试玩即玩·益智爆款</div>','https://example.com',6000000,'puzzle,game,casual'),
        ('电商促销-北美','ShopUS',3000000000,'US','', '<div style="padding:10px;background:#e74c3c;color:#fff">北美大促 低至5折</div>','https://shop.example.com',8000000,'shop,ecommerce,sale')`);
    }
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
  if (llm.ENABLED && c.intent_profile) {
    try { const p = JSON.parse(c.intent_profile); return await llm.scoreRelevance(p, ctx); } catch (e) {}
  }
  return { score: intentScore(c, ctx), reason: '启发式' };
}

// 创建 campaign 后用 LLM 抽取意图画像并回写（用户已填标签则做并集）
async function enrichCampaign(id) {
  const [[c]] = await pool.query('SELECT * FROM adv_campaign WHERE id=?', [id]);
  if (!c) return;
  const ex = await llm.extractDemandIntent(c);
  if (!ex) return;
  const userTags = (c.intent_tags || '').split(',').map(s => s.trim()).filter(Boolean);
  const tags = userTags.length ? [...new Set([...userTags, ...ex.tags])] : ex.tags;
  await pool.query('UPDATE adv_campaign SET intent_tags=?, intent_profile=? WHERE id=?',
    [tags.join(','), JSON.stringify(ex.profile), id]);
}

// ===== 需求方：DSP 出价引擎（含意图加成）=====
app.post('/openrtb2/bid', async (req, res) => {
  const br = req.body || {};
  const imp = (br.imp && br.imp[0]) || {};
  const floorMicros = Math.round((imp.bidfloor || 1.0) * 1e6);
  const ctx = {
    app_category: (br.app && br.app.cat) || (imp.ext && imp.ext.cat) || '',
    country: (br.device && br.device.geo && br.device.geo.country) || '',
    keywords: ((br.site && br.site.keywords) || '').split(',').filter(Boolean)
  };
  try {
    const [rows] = await pool.query("SELECT * FROM adv_campaign WHERE status=1 AND (review_status IS NULL OR review_status='approved') AND budget_micros>=?", [floorMicros]);
    let best = null;
    for (const c of rows) {
      const rel = await llmRel(c, ctx);                  // LLM 或启发式相关性
      const score = rel.score;
      const base = Math.min(c.target_cpm_micros, c.budget_micros);
      if (base < floorMicros) continue;
      const bidMicros = Math.round(base * (1 + 0.5 * score)); // 意图匹配最高 +50% 出价 -> eCPM 更高
      if (!best || bidMicros > best.bidMicros) best = { c, bidMicros, score, llm: !!rel.llm, reason: rel.reason };
    }
    if (!best) return res.json({ id: br.id, seatbid: [] });
    res.json({
      id: br.id,
      seatbid: [{
        seat: 'zhuque',
        bid: [{
          id: 'bid1', impid: imp.id, price: best.bidMicros,
          adm: best.c.creative_html, crid: String(best.c.id), cid: String(best.c.id),
          ext: { cid: best.c.id, intent_score: best.score, intent_source: best.llm ? 'llm' : 'heuristic', intent_reason: best.reason, landing: best.c.landing_url }
        }]
      }]
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== 供给方：SSP（OpenRTB 端点，多 DSP 并发拍卖）=====
const pubMetaCache = new Map(); // domain -> {rate,cat,geo,keywords}
async function getPub(domain) {
  if (pubMetaCache.has(domain)) return pubMetaCache.get(domain);
  try {
    const [[p]] = await pool.query('SELECT payout_rate,cat,geo,keywords FROM publishers WHERE domain=?', [domain]);
    const meta = p ? {
      rate: Number(p.payout_rate) || 0.70,
      cat: p.cat || '', geo: p.geo || '', keywords: (p.keywords || '').split(',').filter(Boolean),
    } : { rate: 0.70, cat: '', geo: '', keywords: [] };
    pubMetaCache.set(domain, meta);
    return meta;
  } catch (e) { return { rate: 0.70, cat: '', geo: '', keywords: [] }; }
}
app.post('/ssp/bid', async (req, res) => {
  const ip = req.ip || (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (rateHit(ip)) return res.status(429).json({ error: 'rate limited' }); // 反作弊：单 IP 频率限制
  const br = req.body || {};
  if (!br.id) return res.status(400).json({ error: 'missing id' });
  const publisher = (br.site && br.site.domain) || 'unknown';
  const pub = await getPub(publisher);                 // 媒体方画像(含 supply crawler 回填的 cat/geo)
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
  const responses = await Promise.all(DEMAND_PARTNERS.map(async (p) => {
    if (p.type === 'mock') {
      const imp = (br.imp && br.imp[0]) || {};
      return { seatbid: [{ seat: p.name, bid: [{ id: 'b-mock', impid: imp.id, price: p.priceMicros, adm: p.adm, crid: p.crid, cid: 0, ext: { cid: 0 } }] }] };
    }
    try {
      const r = await fetch(p.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(br) });
      return await r.json();
    } catch (e) { console.error('demand err', p.name, e.message); return null; }
  }));
  const allBids = [];
  responses.forEach((resp, idx) => {
    if (!resp) return;
    const partner = DEMAND_PARTNERS[idx];
    (resp.seatbid || []).forEach(seat => (seat.bid || []).forEach(bid => allBids.push({ partner, seat, bid, micros: bid.price || 0 })));
  });
  if (!allBids.length) return res.json({ id: br.id, seatbid: [] });
  allBids.sort((a, b) => b.micros - a.micros);
  const best = allBids[0];
  const second = allBids.length > 1 ? allBids[1].micros : best.micros;
  const winMicros = AUCTION.secondPrice ? Math.min(best.micros, second + 10000) : best.micros; // 清盘价
  const grossMicros = winMicros;                              // SSP 向需求方实收(清盘价)
  const payoutMicros = Math.round(winMicros * pub.rate);      // 给媒体分成(媒体方独立费率)
  recordSsp(grossMicros, payoutMicros, publisher);
  if (best.partner.isOwn) { // 自有 DSP：广告主按「二价清盘价」付费（不是自己的出价），避免虚高
    try {
      await fetch(`http://127.0.0.1:${PORT}/notify`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cid: best.bid.cid || (best.bid.ext && best.bid.ext.cid), crid: best.bid.crid, impid: best.bid.impid, price: winMicros, win: true })
      });
    } catch (e) {}
  }
  const winBid = { ...best.bid, price: winMicros };
  const bestCid = best.bid.cid || (best.bid.ext && best.bid.ext.cid);
  // 激励视频：服务端签发一次性签名令牌，前端 SDK 只能上报、无法自证完播
  const fmt = String((imp.ext && imp.ext.ad_type) || ((imp.ext && imp.ext.reward) ? 'rewarded' : '') || 'banner');
  if (fmt === 'rewarded') {
    const rw = rwIssue(best.bid.impid, bestCid, publisher);
    // 行业标准：视频广告返回 VAST 4.0 XML；imp.ext.protocol='html' 时可退回 HTML 创意
    const useVast = imp.ext.protocol !== 'html';
    if (useVast) {
      winBid.adm = buildVast({
        impid: rw.impid, cid: rw.cid,
        title: bestCid ? ('ADX-' + bestCid + ' 激励视频') : 'rewarded-ad',
        mediaUrl: RW_MEDIA, duration: RW_DURATION
      });
    }
    winBid.ext = Object.assign({}, best.bid.ext, {
      rw, rw_min_ratio: RW_MIN_RATIO, rw_ttl_ms: RW_TTL_MS,
      ad_type: 'rewarded', ad_format: 'rewarded', adm_type: useVast ? 'vast4' : 'html'
    });
    await pool.query('INSERT IGNORE INTO rw_token (imp_id,campaign_id,publisher) VALUES (?,?,?)', [rw.impid, rw.cid, publisher]).catch(() => {});
  } else if (fmt !== 'banner') {
    // 其它形态：插屏 / 开屏 / 原生 / icon / push（banner 沿用 campaign 自带 creative_html）
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
  res.json({ id: br.id, cur: 'CNY', seatbid: [{ seat: best.partner.name, bid: [winBid] }] });
});

// 动态注册外部 DSP（合作方案落地：Appluck 类供给/需求接入）
app.post('/ssp/demand', (req, res) => {
  const { name, url, payoutRate = 0.6 } = req.body || {};
  if (!name || !url) return res.status(400).json({ error: 'name,url required' });
  DEMAND_PARTNERS.push({ name, type: 'http', url, payoutRate, isOwn: false });
  res.json({ ok: true, partners: DEMAND_PARTNERS.map(p => p.name) });
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
    res.json({ ok: true, amount: amt });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== S2S 服务端回调：媒体/App 服务端用 api_key 签名上报观看结果，是结算唯一权威 =====
app.post('/s2s/reward', async (req, res) => {
  const { impid, cid, publisher, watchedMs, durationMs, ts, sig, rewardResult } = req.body || {};
  const pub = String(publisher || '');
  const watched = Number(watchedMs) || 0, dur = Number(durationMs) || 0;
  const remote = req.ip || (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  const audit = (status, ratio) =>
    pool.query('INSERT INTO reward_log (imp_id,campaign_id,publisher,watched_ms,duration_ms,ratio,status,remote) VALUES (?,?,?,?,?,?,?,?)',
      [String(impid || ''), cid ? Number(cid) : null, pub, watched, dur, Number((ratio || 0).toFixed(3)), status, remote]).catch(() => {});
  const deny = (why, code = 403) => { audit('S2S_REJECT_' + why); return res.status(code).json({ ok: false, why }); };

  if (!impid || !pub) return deny('MISSING_FIELDS', 400);
  const age = Math.abs(Date.now() - Number(ts || 0));
  if (!ts || age > S2S_TTL_MS) return deny('TIMESTAMP_EXPIRED');
  const [[pu]] = await pool.query('SELECT api_key FROM publishers WHERE domain=?', [pub]).catch(() => [[]]);
  if (!pu || !pu.api_key) return deny('UNKNOWN_PUBLISHER');
  if (s2sSign(pu.api_key, impid, cid, watchedMs, durationMs, ts) !== sig) return deny('BAD_S2S_SIGNATURE');
  const [[win]] = await pool.query('SELECT campaign_id FROM bid_win_log WHERE imp_id=?', [String(impid)]).catch(() => [[]]);
  if (!win) return deny('NO_IMPRESSION', 400);
  const [[tk]] = await pool.query('SELECT used FROM rw_token WHERE imp_id=?', [String(impid)]).catch(() => [[]]);
  if (tk && Number(tk.used) === 1) return deny('TOKEN_ALREADY_SETTLED');
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
      counted = true;
    }
    if (pubLedger[pub]) pubLedger[pub].conversions++;
  } catch (e) {}
  audit('S2S_GRANTED', ratio);
  res.json({ ok: true, granted: true, counted, ratio: Number(ratio.toFixed(3)), settlement: 'server-authoritative' });
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

// ===== 激励视频完播上报：服务端校验令牌后才发放奖励（前端无法自证完播）=====
app.post('/ssp/reward', async (req, res) => {
  const { impid, cid, publisher, rw, watchedMs, durationMs } = req.body || {};
  const pub = String(publisher || 'unknown');
  const remote = req.ip || (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  const watched = Number(watchedMs) || 0, dur = Number(durationMs) || 0;
  const audit = (status, ratio) =>
    pool.query('INSERT INTO reward_log (imp_id,campaign_id,publisher,watched_ms,duration_ms,ratio,status,remote) VALUES (?,?,?,?,?,?,?,?)',
      [String(impid || ''), cid ? Number(cid) : null, pub, watched, dur, Number((ratio || 0).toFixed(3)), status, remote]).catch(() => {});
  const deny = (why, code = 403) => { audit('REJECT_' + why); return res.status(code).json({ ok: false, why }); };

  if (!impid) return deny('MISSING_IMPID', 400);
  // ① 必须对应一次真实曝光（bid_win_log 由竞价成功后落库）
  let winRows = [];
  try { [winRows] = await pool.query('SELECT campaign_id, price_micros FROM bid_win_log WHERE imp_id=?', [String(impid)]); } catch (e) { return deny('DB_ERROR', 500); }
  if (!winRows.length) return deny('NO_IMPRESSION', 400);
  // ② 令牌签名校验（HMAC 绑定 impid+cid+publisher+时间戳）
  const v = rwVerify(rw, impid, cid, pub);
  if (!v.ok) return deny(v.why);
  // ③ 令牌未被兑换过（防重放：同一 impid 只能领一次）
  const [[tk]] = await pool.query('SELECT used FROM rw_token WHERE imp_id=?', [String(impid)]).catch(() => [[]]);
  if (tk && Number(tk.used) === 1) return deny('TOKEN_REPLAYED');
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
      counted = true;
    }
    if (pubLedger[pub]) pubLedger[pub].conversions++;
  } catch (e) {}
  audit('GRANTED', ratio);
  return res.json({ ok: true, granted: true, counted, ratio: Number(ratio.toFixed(3)), campaignId: winRows[0].campaign_id, priceMicros: winRows[0].price_micros });
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
app.post('/api/campaign/:id/topup', async (req, res) => {
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
  const { cid, crid, impid, price, win = true } = req.body || {};
  if (!win) return res.json({ ok: true, counted: false });
  const imp = String(impid || '');
  if (!imp) return res.status(400).json({ error: 'impid required' });
  const [[dup]] = await pool.query('SELECT 1 FROM bid_win_log WHERE imp_id=?', [imp]);
  if (dup) return res.json({ ok: true, counted: false, dup: true }); // 反作弊：重复赢价忽略，防刷曝光
  try {
    await pool.query('UPDATE adv_campaign SET budget_micros = budget_micros - ? WHERE id = ? AND budget_micros >= ?', [Number(price), Number(cid), Number(price)]);
    await pool.query('INSERT INTO bid_win_log (campaign_id, creative_id, imp_id, price_micros) VALUES (?,?,?,?)', [Number(cid), Number(crid), imp, Number(price)]);
    res.json({ ok: true, counted: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== 媒体方（供给）入驻 API =====
app.post('/api/publisher', async (req, res) => {
  const { domain, name, contact, payout_rate, site_url, cat, geo, keywords } = req.body || {};
  if (!domain) return res.status(400).json({ error: 'domain required' });
  const rate = payout_rate != null ? Math.max(0.1, Math.min(0.95, Number(payout_rate))) : 0.70;
  await pool.query('INSERT INTO publishers (domain,name,contact,payout_rate,site_url,cat,geo,keywords) VALUES (?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE name=VALUES(name),contact=VALUES(contact),payout_rate=VALUES(payout_rate),site_url=VALUES(site_url),cat=VALUES(cat),geo=VALUES(geo),keywords=VALUES(keywords)',
    [domain, name || domain, contact || '', rate, site_url || '', cat || '', geo || '', keywords || '']);
  const key = 'pub_' + crypto.randomBytes(16).toString('hex'); // 首次入驻即签发 S2S 密钥
  await pool.query('INSERT INTO publishers (domain,name,contact,payout_rate,site_url,cat,geo,keywords,api_key) VALUES (?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE name=VALUES(name),contact=VALUES(contact),payout_rate=VALUES(payout_rate),site_url=VALUES(site_url),cat=VALUES(cat),geo=VALUES(geo),keywords=VALUES(keywords)',
    [domain, name || domain, contact || '', rate, site_url || '', cat || '', geo || '', keywords || '', key]);
  pubMetaCache.set(domain, { rate, cat: cat || '', geo: geo || '', keywords: (keywords || '').split(',').filter(Boolean) });
  const [[prow]] = await pool.query('SELECT api_key FROM publishers WHERE domain=?', [domain]).catch(() => [[]]);
  res.json({ ok: true, domain, payout_rate: rate, api_key: (prow && prow.api_key) || '' });
});

// 查看 / 轮换媒体服务端密钥（S2S 回调签名用）
app.get('/api/publisher/:domain/key', async (req, res) => {
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
app.get('/api/publishers', async (_, res) => {
  try { const [rows] = await pool.query('SELECT domain,name,contact,payout_rate,site_url,cat,geo,keywords,status FROM publishers'); res.json(rows); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
// 合规供给爬虫：抓取媒体方自己声明的 site_url，LLM 提取 cat/geo/keywords 回填（限流+冷却由调用方控制）
app.post('/api/publisher/:domain/crawl', async (req, res) => {
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
app.post('/api/campaign', async (req, res) => {
  const { name, advertiser, budget_cny, country, app_category, creative_html, landing_url, target_cpm_cny, intent_tags } = req.body || {};
  if (!name || !creative_html) return res.status(400).json({ error: 'name,creative_html required' });
  const budget_micros = Math.round((budget_cny || 1000) * 1e6);
  const target_cpm_micros = Math.round((target_cpm_cny || 5) * 1e6);
  const [r] = await pool.query('INSERT INTO adv_campaign (name,advertiser,budget_micros,country,app_category,creative_html,landing_url,target_cpm_micros,intent_tags,review_status) VALUES (?,?,?,?,?,?,?,?,?,?)',
    [name, advertiser || '', budget_micros, country || '', app_category || '', creative_html, landing_url || '', target_cpm_micros, intent_tags || '', 'pending']);
  enrichCampaign(r.insertId).catch(e => console.error('[enrich]', e.message)); // 异步 LLM 抽意图
  res.json({ ok: true, id: r.insertId, llm_enrich: llm.ENABLED, review_status: 'pending' });
});
app.get('/api/campaigns', async (_, res) => {
  const [rows] = await pool.query('SELECT id,name,advertiser,budget_micros,status,country,app_category,target_cpm_micros,intent_tags,intent_profile,review_status FROM adv_campaign');
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
app.post('/api/intent-extract/:id', async (req, res) => {
  try {
    const id = +req.params.id;
    await enrichCampaign(id);
    const [[c]] = await pool.query('SELECT id,name,intent_tags,intent_profile FROM adv_campaign WHERE id=?', [id]);
    res.json({ ok: true, id: c.id, name: c.name, intent_tags: c.intent_tags, intent_profile: c.intent_profile ? JSON.parse(c.intent_profile) : null, llm_enabled: llm.ENABLED });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// LLM 抽取意图：批量重抽所有在投 campaign
app.post('/api/intent-extract', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT id FROM adv_campaign WHERE status=1');
    await Promise.all(rows.map(r => enrichCampaign(r.id)));
    res.json({ ok: true, enriched: rows.length, llm_enabled: llm.ENABLED });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// 并单：更新 campaign 意图标签（意图 Agent 自动撮合时调用）
app.put('/api/campaign/:id/tags', async (req, res) => {
  try {
    const { intent_tags } = req.body || {};
    await pool.query('UPDATE adv_campaign SET intent_tags=? WHERE id=?', [intent_tags || '', +req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// 素材审核通过（只有通过 approved 的素材才参拍）
app.put('/api/campaign/:id/approve', async (req, res) => {
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
app.get('/ssp/report', (_, res) => {
  const margin = sspLedger.grossMicros - sspLedger.payoutMicros;
  res.json({
    ssp: { wins: sspLedger.wins, gross_cny: sspLedger.grossMicros / 1e6, payout_cny: sspLedger.payoutMicros / 1e6, ssp_margin_cny: margin / 1e6, margin_rate: sspLedger.grossMicros ? margin / sspLedger.grossMicros : 0 },
    publishers: Object.entries(pubLedger).map(([k, v]) => ({ publisher: k, wins: v.wins, impressions: pubImpr[k] || 0, clicks: v.clicks || 0, conversions: v.conversions || 0, gross_cny: v.grossMicros / 1e6, payout_cny: v.payoutMicros / 1e6 }))
  });
});

app.use(express.static('public'));
init().then(() => app.listen(PORT, () =>
  console.log(`[platform v2] http://0.0.0.0:${PORT} | SSP /ssp/bid | DSP /openrtb2/bid | 控制台 /advertiser.html | 媒体报表 /publisher_report.html | 意图 /api/intent-match
  意图Agent LLM: ${llm.ENABLED ? `已接入(${llm.PROVIDER.keyEnv}/${llm.MODEL}, 热路径匹配=${llm.LIVE_MATCH ? '开' : '关'})` : '未配置Key(启发式回落, 复制.env.example为.env填入Key启用)'}`)));
