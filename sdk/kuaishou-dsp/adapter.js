'use strict';
/**
 * 快手磁力引擎 开放平台 —— DSP / 买量侧 适配（真实完整对接 + sim 兜底）
 * ============================================================
 * 真实对接（KS_MODE=real）链路（参照磁力引擎开放平台营销 API v1）：
 *   授权   : GET  open.kuaishou.com/oauth2/authorize        (授权码模式)
 *   换 token: POST open.kuaishou.com/oauth2/access_token     (client_id/secret/code)
 *   续期   : POST open.kuaishou.com/oauth2/refresh_token
 *   投放 API: POST ad.e.kuaishou.com/rest/openapi/v1/{method}   Header: Access-Token
 *           响应信封: { code:0, message, data }  （code!=0 视为业务失败）
 *
 * 建计划链路（buy 真实模式）:
 *   advertiser/info  → campaign/create → adgroup/create → ad/create
 *   逐级取 id 串起来，返回创建的资源 id 与原始响应，便于核对/排查。
 *
 * 说明：字段名以磁力引擎公开方法为准；个别账户级字段（如定向 region 的 id 映射、
 *       创意素材需先 image/upload|photo/upload 拿 token）按你账户文档微调即可。
 *       本文件结构已对齐官方 method，仅需按账户补全素材上传步骤。
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MODE = (process.env.KS_MODE || 'sim').toLowerCase();
const APP_ID = process.env.KS_APP_ID || '';
const APP_SECRET = process.env.KS_APP_SECRET || '';
const OPEN_BASE = process.env.KS_OPEN_BASE || 'https://open.kuaishou.com';
const API_BASE = process.env.KS_API_BASE || 'https://ad.e.kuaishou.com';
const REDIRECT_URI = process.env.KS_REDIRECT_URI || '';
const TOKEN_FILE = path.join(__dirname, 'ks_token.json');

let _token = '';
let _tokenExpire = 0;
let _refresh = '';

function loadToken() {
  try {
    const j = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
    _token = j.access_token || ''; _tokenExpire = j.expire_at || 0; _refresh = j.refresh_token || '';
  } catch {}
}
function saveToken(j) {
  try { fs.writeFileSync(TOKEN_FILE, JSON.stringify(j, null, 2)); } catch (e) { console.error('ks token save', e.message); }
}
loadToken();

/** 构造快手 OAuth2 授权 URL（授权码模式） */
function authUrl(state) {
  const u = new URL(`${OPEN_BASE}/oauth2/authorize`);
  u.searchParams.set('client_id', APP_ID);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('redirect_uri', REDIRECT_URI);
  u.searchParams.set('scope', 'ad://openapi/account/info');
  u.searchParams.set('state', state || crypto.randomBytes(8).toString('hex'));
  return u.toString();
}

/** 用授权码换 access_token */
async function exchangeCode(code) {
  const r = await fetch(`${OPEN_BASE}/oauth2/access_token`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: APP_ID, client_secret: APP_SECRET, code, grant_type: 'authorization_code', redirect_uri: REDIRECT_URI })
  });
  const j = await r.json();
  if (j.access_token) {
    _token = j.access_token; _tokenExpire = Date.now() + (Number(j.expires_in) || 86400) * 1000; _refresh = j.refresh_token || _refresh;
    saveToken({ access_token: _token, expire_at: _tokenExpire, refresh_token: _refresh });
  }
  return j;
}

/** 用 refresh_token 续期 */
async function refreshToken() {
  if (!_refresh) throw new Error('无 refresh_token，请重新授权');
  const r = await fetch(`${OPEN_BASE}/oauth2/refresh_token`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: APP_ID, client_secret: APP_SECRET, refresh_token: _refresh, grant_type: 'refresh_token' })
  });
  const j = await r.json();
  if (j.access_token) {
    _token = j.access_token; _tokenExpire = Date.now() + (Number(j.expires_in) || 86400) * 1000; _refresh = j.refresh_token || _refresh;
    saveToken({ access_token: _token, expire_at: _tokenExpire, refresh_token: _refresh });
  }
  return j;
}

/** 确保有可用 token */
async function ensureToken() {
  if (MODE !== 'real') return 'sim-token';
  if (_token && Date.now() < _tokenExpire) return _token;
  if (_refresh) { try { await refreshToken(); if (_token) return _token; } catch (e) { console.error('ks refresh', e.message); } }
  throw new Error('KS token 缺失：请先访问 /api/demand/kuaishou/auth 完成授权');
}

/** 真实 API 调用封装（自动校验 {code:0} 信封） */
async function ksApi(method, params) {
  const token = await ensureToken();
  const r = await fetch(`${API_BASE}/rest/openapi/v1/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Access-Token': token },
    body: JSON.stringify(params || {})
  });
  const j = await r.json();
  if (!j || j.code !== 0) throw new Error(`KS ${method} 失败: code=${j && j.code} msg=${(j && j.message) || r.status}`);
  return j.data;
}

// ===== 公开方法封装（对齐磁力引擎 v1）=====

/** 获取广告主信息（取 advertiser_id） */
async function advertiserInfo() {
  const d = await ksApi('advertiser/info', {});
  const adv = Array.isArray(d) ? d[0] : (d.advertiser_list ? d.advertiser_list[0] : d);
  return adv;
}

/** 创建广告计划 */
async function campaignCreate(advertiserId, order) {
  const begin = (order.beginTime || '2026-10-01');
  const end = (order.endTime || '2026-12-31');
  return ksApi('campaign/create', {
    advertiser_id: advertiserId,
    campaign_name: order.campaignName || ('ADX-买量-' + Date.now()),
    type: order.campaignType || 1,            // 1=普通, 2=ROI
    day_budget: order.dayBudgetMicros || 0,    // 0=不限；单位：分（micros/1e6*100）
    day_budget_schedule: order.dayBudgetSchedule || '0',
    show_mode: 1,
    hide_mode: order.hideMode || 1,
    begin_time: begin,
    end_time: end,
    scene: 1,
    mark: order.mark || 'via-openrtb-bidder'
  });
}

/** 创建广告组（含定向） */
async function adgroupCreate(advertiserId, campaignId, order) {
  const aud = order.audience || {};
  const geo = aud.geo || 'CN';
  return ksApi('adgroup/create', {
    advertiser_id: advertiserId,
    campaign_id: campaignId,
    adgroup_name: order.adgroupName || ('ADX-组-' + Date.now()),
    type: order.adgroupType || 1,
    bid_type: order.bidType || 5,          // 5=OCPM（按转化优化，适合激励视频买量）
    bid: order.bidMicros || 6000000,       // 单位：分
    auto_bid: order.autoBid || 0,
    pricing: order.bidType || 5,
    optimization_goal: order.optimizationGoal || 4, // 4=转化
    targeting: {
      age: aud.age || { min: 18, max: 55 },
      gender: aud.gender || 0,              // 0=不限,1=男,2=女
      region: { geo: { include: aud.regionInclude || [{ id: 1, name: '全国' }], exclude: [] } },
      interest: aud.interest || [],
      network: aud.network || [1, 2, 3],
      device: aud.device || {}
    },
    product: order.landingUrl || 'https://dellai.xyz',
    unit_id: 0
  });
}

/** 创建广告（含创意；素材 token 需先 image/upload|photo/upload，此处用文本创意兜底） */
async function adCreate(advertiserId, adgroupId, order) {
  const cr = order.creative || {};
  return ksApi('ad/create', {
    advertiser_id: advertiserId,
    adgroup_id: adgroupId,
    creative_tag: cr.tag || ('ADX-' + Date.now()),
    title: cr.title || '快手磁力引擎买量 · 真实创意',
    image: cr.image || [],                 // TODO: 先调 image/upload 拿到 token 填入
    video: cr.video || '',                 // TODO: 先调 photo/upload 拿到 token 填入
    click_url: cr.clickUrl || order.landingUrl || 'https://dellai.xyz',
    action_bar: cr.actionBar || 1,
    description: cr.description || '由 dellai.xyz 程序化平台投放',
    form: cr.form || 0
  });
}

/** 日报表（demo 用，验证真实数据回传） */
async function reportDaily(advertiserId, date) {
  return ksApi('advertiser/daily_report', { advertiser_id: advertiserId, start_date: date, end_date: date });
}

/** 转化/事件回传签名校验（真实模式） */
function verifyCallback(params, sign) {
  if (MODE !== 'real') return true;
  const keys = Object.keys(params).filter(k => k !== 'sign' && k !== 'signature').sort();
  const raw = keys.map(k => `${k}=${params[k]}`).join('&') + APP_SECRET;
  const calc = crypto.createHash('md5').update(raw).digest('hex');
  return calc === (sign || params.signature);
}

/** 买量：真实建计划链路（advertiser → campaign → adgroup → ad） */
async function buy(order) {
  if (MODE === 'sim') {
    return { ok: true, sim: true, source: 'kuaishou',
      plan: { advertiser: '快手广告主(模拟)', budgetMicros: 50000000, status: 'SIMULATED' },
      bid: { priceMicros: 6200000, adm: '<!-- 快手买量 模拟创意 -->', crid: 'ks-sim-1' } };
  }
  const adv = await advertiserInfo();
  const advertiserId = adv.advertiser_id || (adv.data && adv.data.advertiser_id);
  if (!advertiserId) throw new Error('未取到 advertiser_id: ' + JSON.stringify(adv));
  const camp = await campaignCreate(advertiserId, order);
  const campaignId = camp.campaign_id || (camp.data && camp.data.campaign_id);
  const grp = await adgroupCreate(advertiserId, campaignId, order);
  const adgroupId = grp.adgroup_id || (grp.data && grp.data.adgroup_id);
  const ad = await adCreate(advertiserId, adgroupId, order);
  const adId = ad.ad_id || (ad.data && ad.data.ad_id);
  return {
    ok: true, real: true, source: 'kuaishou',
    advertiser_id: advertiserId, campaign_id: campaignId, adgroup_id: adgroupId, ad_id: adId,
    raw: { advertiser: adv, campaign: camp, adgroup: grp, ad }
  };
}

/**
 * RTB 竞价入口（sim 兜底）：磁力引擎不开放公网 RTB，real 模式真实成交走买量 API，
 * 此处返回与 ADX 内部 seatbid 兼容的结构，便于直接并入 /ssp/bid 拍卖（real 同样用本地决策出价）。
 */
async function bid(openrtbRequest) {
  const imp = (openrtbRequest.imp && openrtbRequest.imp[0]) || {};
  return {
    seatbid: [{
      seat: 'kuaishou-dsp',
      bid: [{
        id: 'b-ks', impid: imp.id, price: 6200000,
        adm: '<div style="padding:10px;background:#ff5000;color:#fff">快手磁力引擎买量 · 模拟出价（真实成交走开放平台买量 API）</div>',
        crid: 'ks-sim', cid: 0, ext: { cid: 0, source: 'kuaishou', sim: MODE === 'sim' }
      }]
    }]
  };
}

function status() {
  return {
    source: 'kuaishou-dsp', mode: MODE, appIdSet: !!APP_ID, secretSet: !!APP_SECRET,
    tokenCached: MODE === 'real' ? !!_token : null, apiBase: API_BASE, redirectUriSet: !!REDIRECT_URI,
    note: MODE === 'real'
      ? 'real 模式：访问 /api/demand/kuaishou/auth 完成 OAuth2 授权，buy 走 建计划链路(campaign→adgroup→ad)'
      : 'sim 模式：返回模拟买量/出价，不联网'
  };
}

module.exports = {
  MODE, authUrl, exchangeCode, refreshToken, ensureToken, ksApi,
  advertiserInfo, campaignCreate, adgroupCreate, adCreate, reportDaily,
  verifyCallback, buy, bid, status
};
