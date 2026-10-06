'use strict';
/**
 * Mintegral DSP 适配器（简化版 Waterfall 外部需求方 · 对标 AppLovin MAX 聚合的第三方 Bidding 网络）
 * ============================================================================
 * 合约与 generic-dsp 完全一致：导出 bid(br) 返回标准 OpenRTB seatbid，status() 返回接入状态。
 *
 * sim 模式：基于请求上下文（广告形态 / 地理 / 类目）给出有竞争力的出价，参与本地多需求方拍卖，
 *           用于演示「引入 Mintegral 这类高 eCPM 第三方网络后，整体清算价提升 30~50%」。
 * real 模式：将 OpenRTB 请求转发至 Mintegral Bidding 端点（需配置 MG_BID_URL / MG_API_KEY），
 *           真实接入需参照 Mintegral 官方 RTB 文档完成签名与字段映射；此处提供可落地请求骨架。
 */
const crypto = require('crypto');

const MODE = process.env.MG_MODE === 'real' ? 'real' : 'sim';
// Mintegral 在游戏 / 激励视频上 eCPM 突出，基础价值整体高于通用需求方
const FORMAT_BASE = {
  rewarded: 8_000_000, interstitial: 5_200_000, splash: 6_000_000,
  native: 3_600_000, banner: 2_200_000, icon: 1_800_000, push: 1_500_000
};
const GEO_MULT = { US: 1.8, JP: 1.5, GB: 1.5, DE: 1.4, KR: 1.5, CN: 1.0, IN: 0.5, BR: 0.6, OTHER: 0.75 };
const CAT_MULT = { game: 1.4, gaming: 1.4, shopping: 1.25, finance: 1.6, edu: 1.15, tools: 1.1, other: 1.0 };

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
  return 0.92 + v * 0.28;
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
    const crid = 'mg-' + crypto.createHash('md5').update(impid).digest('hex').slice(0, 8);
    // 修复：rewarded 此前只回一行 HTML 注释占位（`<!-- placeholder -->`），
    // 解析器拿不到 <MediaFile>，演示页就是一块空白/黑屏视频位 —— 这正是"演示广告难看"的来源之一。
    // sim 模式也必须给出结构完整的 VAST 4.0，媒体地址走 MG_MEDIA（未配则用平台兜底样片）。
    const media = process.env.MG_MEDIA || process.env.RW_MEDIA || '/uploads/demo-trailer.mp4';
    const adm = fmt === 'rewarded'
      ? `<?xml version="1.0" encoding="UTF-8"?><VAST version="4.0"><Ad id="${crid}"><InLine>` +
        `<AdSystem version="1.0">mintegral-dsp</AdSystem>` +
        `<AdTitle><![CDATA[Mintegral 激励视频]]></AdTitle>` +
        `<Impression id="mg-imp"><![CDATA[https://dellai.xyz/vast/track?impid=${impid}&cid=0&event=impression]]></Impression>` +
        `<Creatives><Creative id="${crid}-cre"><Linear skipoffset="00:00:05">` +
        `<Duration>00:00:30</Duration>` +
        `<TrackingEvents>` +
        `<Tracking event="start"><![CDATA[https://dellai.xyz/vast/track?impid=${impid}&cid=0&event=start]]></Tracking>` +
        `<Tracking event="complete"><![CDATA[https://dellai.xyz/vast/track?impid=${impid}&cid=0&event=complete]]></Tracking>` +
        `</TrackingEvents>` +
        `<VideoClicks><ClickThrough><![CDATA[https://dellai.xyz]]></ClickThrough></VideoClicks>` +
        `<MediaFiles><MediaFile delivery="progressive" type="video/mp4" width="1280" height="720" scalable="true"><![CDATA[${media}]]></MediaFile></MediaFiles>` +
        `</Linear></Creative></Creatives></InLine></Ad></VAST>`
      : `<div style="padding:10px;background:#7b2ff7;color:#fff;border-radius:6px">Mintegral · ${fmt} 出价 ${(price / 1e6).toFixed(2)} 元<a style="color:#fff;margin-left:8px" href="https://dellai.xyz">了解详情</a></div>`;
    return { seatbid: [{ seat: 'mintegral-dsp', bid: [{ id: 'b-mg', impid, price, adm, crid, cid: 0, ext: { cid: 0, source: 'mintegral-dsp', sim: true, value_estimate_micros: Math.round(base * mult) } }] }] };
  }
  // real 模式：转发 OpenRTB 至 Mintegral Bidding 端点
  const url = process.env.MG_BID_URL, key = process.env.MG_API_KEY;
  if (!url || !key) throw new Error('Mintegral real 模式需配置 MG_BID_URL / MG_API_KEY');
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), Number(process.env.DSP_HTTP_TIMEOUT_MS || 800));
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-MG-API-Key': key }, body: JSON.stringify(br), signal: ctrl.signal });
    const j = await r.json().catch(() => ({}));
    return (j && j.seatbid) ? j : null;
  } finally { clearTimeout(t); }
}

function status() {
  return {
    source: 'mintegral-dsp', mode: MODE,
    note: MODE === 'real'
      ? '转发至 Mintegral Bidding 端点（需 MG_BID_URL / MG_API_KEY）'
      : 'sim 模式：基于上下文估值出价，参与本地多需求方拍卖，用于验证整体 eCPM 提升'
  };
}

module.exports = { bid, status, MODE, FORMAT_BASE, GEO_MULT, CAT_MULT };
