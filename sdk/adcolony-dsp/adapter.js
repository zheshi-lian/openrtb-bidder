'use strict';
/**
 * AdColony DSP 适配器（简化版 Waterfall 外部需求方 · 对标 AppLovin MAX 聚合的第三方 Bidding 网络）
 * ============================================================================
 * 合约与 generic-dsp 完全一致：导出 bid(br) 返回标准 OpenRTB seatbid，status() 返回接入状态。
 *
 * sim 模式：基于请求上下文（广告形态 / 地理 / 类目）给出有竞争力的出价，参与本地多需求方拍卖。
 * real 模式：将 OpenRTB 请求转发至 AdColony Bidding 端点（需配置 AC_BID_URL / AC_API_KEY），
 *           真实接入需参照 AdColony 官方 RTB 文档完成签名与字段映射；此处提供可落地请求骨架。
 */
const crypto = require('crypto');

const MODE = process.env.AC_MODE === 'real' ? 'real' : 'sim';
// AdColony 在视频 / 插屏上 eCPM 突出
const FORMAT_BASE = {
  rewarded: 7_500_000, interstitial: 5_500_000, splash: 5_500_000,
  native: 3_200_000, banner: 2_000_000, icon: 1_600_000, push: 1_400_000
};
const GEO_MULT = { US: 1.75, JP: 1.45, GB: 1.45, DE: 1.35, KR: 1.4, CN: 1.0, IN: 0.5, BR: 0.6, OTHER: 0.72 };
const CAT_MULT = { game: 1.35, gaming: 1.35, shopping: 1.3, finance: 1.55, edu: 1.1, tools: 1.12, other: 1.0 };

function geoOf(br) { return (br.device && br.device.geo && br.device.geo.country) || 'OTHER'; }
function catOf(imp) {
  const c = ((imp.ext && (imp.ext.cat || imp.ext.iab_cat)) || '').toLowerCase();
  if (/game|gaming|puzzle|casual/.test(c)) return 'game';
  if (/shop|retail|ecom/.test(c)) return 'shopping';
  if (/financ|bank|insur/.test(c)) return 'finance';
  if (/edu|learn/.test(c)) return 'edu';
  if (/tool|util/.test(c)) return 'tools';
  return 'other';
}
function formatOf(imp) {
  const f = ((imp.ext && (imp.ext.ad_type || imp.ext.ad_format)) || '').toLowerCase();
  return FORMAT_BASE[f] ? f : 'banner';
}
function jitter(seed) {
  const h = crypto.createHash('sha1').update(seed).digest('hex');
  const v = parseInt(h.slice(0, 8), 16) / 0xffffffff;
  return 0.9 + v * 0.3;
}

async function bid(br) {
  if (MODE !== 'real') {
    const imp = (br.imp && br.imp[0]) || {};
    const impid = imp.id || (br.id + '-imp');
    const floor = Number(imp.bidfloor) || 0;
    const base = FORMAT_BASE[formatOf(imp)] || FORMAT_BASE.banner;
    const mult = (GEO_MULT[geoOf(br)] || GEO_MULT.OTHER) * (CAT_MULT[catOf(imp)] || CAT_MULT.other);
    const price = Math.max(Math.round(base * mult * jitter(String(br.id || '') + '|' + impid)),
      Math.round(floor) || Math.round(base * mult * 0.95));
    const fmt = formatOf(imp);
    const crid = 'ac-' + crypto.createHash('md5').update(impid).digest('hex').slice(0, 8);
    const adm = fmt === 'rewarded'
      ? '<!-- adcolony rewarded placeholder -->'
      : `<div style="padding:10px;background:#f5a623;color:#1a1a1a;border-radius:6px">AdColony · ${fmt} 出价 ${(price / 1e6).toFixed(2)} 元<a style="color:#1a1a1a;margin-left:8px" href="https://dellai.xyz">了解详情</a></div>`;
    return { seatbid: [{ seat: 'adcolony-dsp', bid: [{ id: 'b-ac', impid, price, adm, crid, cid: 0, ext: { cid: 0, source: 'adcolony-dsp', sim: true, value_estimate_micros: Math.round(base * mult) } }] }] };
  }
  // real 模式：转发 OpenRTB 至 AdColony Bidding 端点
  const url = process.env.AC_BID_URL, key = process.env.AC_API_KEY;
  if (!url || !key) throw new Error('AdColony real 模式需配置 AC_BID_URL / AC_API_KEY');
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), Number(process.env.DSP_HTTP_TIMEOUT_MS || 800));
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-AC-API-Key': key }, body: JSON.stringify(br), signal: ctrl.signal });
    const j = await r.json().catch(() => ({}));
    return (j && j.seatbid) ? j : null;
  } finally { clearTimeout(t); }
}

function status() {
  return {
    source: 'adcolony-dsp', mode: MODE,
    note: MODE === 'real'
      ? '转发至 AdColony Bidding 端点（需 AC_BID_URL / AC_API_KEY）'
      : 'sim 模式：基于上下文估值出价，参与本地多需求方拍卖，用于验证整体 eCPM 提升'
  };
}

module.exports = { bid, status, MODE, FORMAT_BASE, GEO_MULT, CAT_MULT };
