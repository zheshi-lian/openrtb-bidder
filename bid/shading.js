// bid/shading.js —— Bid shading：在一价拍卖下用"低于真实估值"的价格报价，最大化期望利润
//
// 期望利润： E(b) = (value − bid) × P(win at bid)
//   · bid = value       → 胜率最高但利润为 0（把 margin 全让出去）
//   · bid = floor       → 利润单价最高但几乎不赢（拿不到量）
//   · 最优在两者之间：依赖胜率曲线形状，不能拍脑袋给个固定 0.7 系数
//
// 本实现：在 [floor, value] 上网格搜索（默认 24 档），用 winrate.pWin() 估计胜率，取期望利润最大。
// 附带：
//   · 探索：以 ε 概率随机扰动 shade，避免模型自我强化（永远只探索窄区间→分布估计退化）
//   · 二价拍卖：不需要 shading（付次高价），仅保证 ≥ floor
//   · 冷启动：胜率模型样本不足时，用保守系数（如 0.85）而不是激进压价

const winrate = require('./winrate');

const DEFAULT_MIN_SHADE = 0.35;
const DEFAULT_EPS = 0.03;

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

/**
 * @param {object} o
 *   valueMicros  真实估值（出价上限；= pCTR×pCVR×pLTV / targetROAS）
 *   floorMicros  底价（低于此价不参竞）
 *   ctx          {publisher,format,country} 用于取胜率分布
 *   auctionType  1=一价 2=二价
 *   minShade     最低折扣系数（防止压到 0 拿不到量）
 *   steps        网格档数
 *   exploreEps   探索概率
 * @returns {bidMicros, shade, pWin, expectedProfitMicros, source, skipped?}
 */
function shade(o) {
  const value = Math.round(Number(o.valueMicros) || 0);
  const floor = Math.round(Number(o.floorMicros) || 0);
  const ctx = o.ctx || {};
  const type = Number(o.auctionType || 2);
  const minShade = Number(o.minShade || DEFAULT_MIN_SHADE);
  const steps = Number(o.steps || 24);

  if (value <= 0) return { bidMicros: 0, skipped: 'NO_VALUE', reason: 'value<=0' };
  if (floor > 0 && value < floor) {
    // 估值低于底价：正常不该买。除非是"保量合约/探索预算"，否则放弃
    if (!o.allowBelowFloor) return { bidMicros: 0, skipped: 'BELOW_FLOOR', value, floor };
  }
  // 二价：付次高价，shading 无意义（反而降低胜率），只需保证过底价
  if (type === 2) {
    const bid = Math.max(value, floor);
    const pw = winrate.pWin(ctx, bid);
    return { bidMicros: bid, shade: 1, pWin: pw.p, source: 'second_price', winSource: pw.source, expectedProfitMicros: 0 };
  }

  const lo = Math.max(floor, Math.round(value * clamp(minShade, 0.05, 1)));
  let best = null;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    let bid = Math.round(lo + (value - lo) * t);
    if (floor > 0 && bid < floor) bid = floor;
    if (bid > value) bid = value;                 // 绝不超过自身估值（一价下等于亏损）
    const pw = winrate.pWin(ctx, bid);
    const profit = (value - bid) * (pw.p || 0);
    if (!best || profit > best.expectedProfitMicros) {
      best = { bidMicros: bid, shade: value ? +(bid / value).toFixed(4) : 1, pWin: +(pw.p || 0).toFixed(4), expectedProfitMicros: Math.round(profit), winSource: pw.source, winN: pw.n };
    }
  }
  if (!best) return { bidMicros: Math.max(value, floor), shade: 1, source: 'fallback' };

  // 探索：以 ε 概率在 [minShade,1] 随机取系数，持续给胜率曲线注入新信息
  if (Math.random() < Number(o.exploreEps != null ? o.exploreEps : DEFAULT_EPS)) {
    const s = clamp(minShade + Math.random() * (1 - minShade), 0.05, 1);
    const bid = Math.max(floor, Math.round(value * s));
    const pw = winrate.pWin(ctx, bid);
    best = { bidMicros: Math.min(bid, value), shade: +s.toFixed(4), pWin: +(pw.p || 0).toFixed(4), expectedProfitMicros: Math.round((value - bid) * (pw.p || 0)), explore: true, winSource: pw.source };
  }
  // 冷启动保守：胜率模型没数据时，网格可能选到极端值，收回到经验区间
  if (best.winN === 0) {
    const bid = Math.max(floor, Math.round(value * 0.85));
    best = { ...best, bidMicros: bid, shade: 0.85, source: 'cold_start_conservative' };
  }
  return best;
}

// 批量：多 imp / 多 campaign 时复用同一套胜率估计
function shadeMany(items, opts = {}) {
  return items.map(it => Object.assign({ impid: it.impid }, shade({ ...opts, ...it })));
}

// 给定目标胜率反解出价：用于"保量型"广告主（要求胜率≥x%）
function bidForTargetWinRate(ctx, valueMicros, targetP, floorMicros = 0) {
  const ref = winrate.medianClearing(ctx);
  let lo = floorMicros, hi = Math.max(valueMicros, ref || valueMicros);
  for (let i = 0; i < 20; i++) {
    const mid = Math.round((lo + hi) / 2);
    const p = (winrate.pWin(ctx, mid).p) || 0;
    if (p < targetP) lo = mid; else hi = mid;
  }
  const bid = Math.min(Math.round(hi), Math.round(valueMicros));
  return { bidMicros: Math.max(bid, floorMicros), pWin: +(winrate.pWin(ctx, bid).p || 0).toFixed(4) };
}

module.exports = { shade, shadeMany, bidForTargetWinRate, DEFAULT_MIN_SHADE };
