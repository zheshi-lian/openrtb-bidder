'use strict';
/**
 * 通用 OpenRTB DSP 需求方（示例第三方竞价方） —— 自包含、可持续出价
 * ============================================================
 * 这是一个"真实"的需求方实现：它不依赖外部网路，而是基于请求上下文（媒体类目、地理、
 * 广告形态、底价）用一套内置估值模型给出出价，返回标准 OpenRTB seatbid。
 *
 * 价值：在演示环境里让 /ssp/bid 拍卖同时有多个独立需求方（自有 DSP + 快手 + 巨量 + 本示例）
 * 真实竞争，从而演示"多需求方竞价 / 二价清算 / eCPM' 排序"的完整数据链路。
 *
 * 部署为独立服务：把本文件用 `node sdk/generic-dsp/server.js` 起一个 HTTP 服务，
 * 在 ADX 的 DEMAND_PARTNERS 里加一条 { type:'http', url:'http://generic-dsp:port/openrtb2/bid' }
 * 即可作为外部真实 DSP 接入；此处直接 require 其 bid() 也可内联参与拍卖。
 */
const crypto = require('crypto');

// 内置估值参数（分广告形态的基础价值，单位 micros）
const FORMAT_BASE = {
  rewarded: 6_500_000, interstitial: 4_200_000, splash: 5_000_000,
  native: 3_000_000, banner: 1_800_000, icon: 1_500_000, push: 1_200_000
};
// 地理溢价系数
const GEO_MULT = { US: 1.6, JP: 1.4, GB: 1.4, DE: 1.3, CN: 1.0, IN: 0.5, BR: 0.6, OTHER: 0.7 };
// 类目溢价系数（IAB 大类 / 关键词）
const CAT_MULT = { game: 1.3, gaming: 1.3, shopping: 1.2, finance: 1.5, edu: 1.1, news: 0.9, other: 1.0 };

function geoOf(br) {
  return (br.device && br.device.geo && br.device.geo.country) || 'OTHER';
}
function catOf(imp) {
  const c = ((imp.ext && (imp.ext.cat || imp.ext.iab_cat)) || '').toLowerCase();
  if (/game|gaming|puzzle|casual/.test(c)) return 'game';
  if (/shop|retail|ecom/.test(c)) return 'shopping';
  if (/financ|bank|insur/.test(c)) return 'finance';
  if (/edu|learn/.test(c)) return 'edu';
  if (/news|news/.test(c)) return 'news';
  return 'other';
}
function formatOf(imp) {
  const f = ((imp.ext && (imp.ext.ad_type || imp.ext.ad_format)) || '').toLowerCase();
  return FORMAT_BASE[f] ? f : 'banner';
}
// 用请求 id + impid 生成稳定抖动，使同一请求可复现、不同请求有分布（避免每次同价）
function jitter(seed) {
  const h = crypto.createHash('sha1').update(seed).digest('hex');
  const v = parseInt(h.slice(0, 8), 16) / 0xffffffff; // 0..1
  return 0.9 + v * 0.25; // 0.90 ~ 1.15
}

/**
 * 给定一次 OpenRTB 请求，返回标准 seatbid（可并入 ADX 拍卖）。
 * @param {object} br OpenRTB bid request
 */
async function bid(br) {
  const imp = (br.imp && br.imp[0]) || {};
  const impid = imp.id || (br.id + '-imp');
  const floor = Number(imp.bidfloor) || 0;
  const base = FORMAT_BASE[formatOf(imp)] || FORMAT_BASE.banner;
  const mult = (GEO_MULT[geoOf(br)] || GEO_MULT.OTHER) * (CAT_MULT[catOf(imp)] || CAT_MULT.other);
  const raw = base * mult * jitter(String(br.id || '') + '|' + impid);
  const price = Math.max(Math.round(raw), Math.round(floor) || Math.round(raw * 0.95));
  const fmt = formatOf(imp);
  const crid = 'gen-' + crypto.createHash('md5').update(impid).digest('hex').slice(0, 8);
  let adm;
  if (fmt === 'rewarded') {
    // 主服务会按 rewarded 形态包成 VAST，这里仅提供占位文案（adm 会被覆盖）
    adm = '<!-- generic-dsp rewarded placeholder -->';
  } else {
    const color = '#3b6cff';
    adm = `<div style="padding:10px;background:${color};color:#fff;border-radius:6px">`
      + `通用OpenRTB需求方 · ${fmt} 出价 ${(price / 1e6).toFixed(2)} 元`
      + `<a style="color:#fff;margin-left:8px" href="https://dellai.xyz">了解详情</a></div>`;
  }
  return {
    seatbid: [{
      seat: 'generic-dsp',
      bid: [{
        id: 'b-gen', impid, price,
        adm, crid, cid: 0,
        ext: { cid: 0, source: 'generic-dsp', sim: true, value_estimate_micros: Math.round(base * mult) }
      }]
    }]
  };
}

function status() {
  return {
    source: 'generic-dsp', mode: 'self-contained', note:
      '自包含通用 OpenRTB 需求方：基于 媒体类目/地理/形态/底价 的估值模型实时出价，无需外部网络。'
  };
}

// 当作为独立服务运行时：暴露 /openrtb2/bid
if (require.main === module) {
  const http = require('http');
  const PORT = Number(process.env.GENERIC_DSP_PORT || 8700);
  http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/openrtb2/bid') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', async () => {
        try {
          const br = JSON.parse(body || '{}');
          const out = await bid(br);
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(out));
        } catch (e) { res.statusCode = 500; res.end(JSON.stringify({ error: e.message })); }
      });
    } else { res.statusCode = 404; res.end('not found'); }
  }).listen(PORT, () => console.log('generic-dsp listening on ' + PORT));
}

module.exports = { bid, status, FORMAT_BASE, GEO_MULT, CAT_MULT };
