// attribution/multi_touch.js —— 多触点归因模型 + 浏览归因(VTA)
//
// v1 只有 last-touch 桩（server.js:1496），它把 100% 功劳给最后一次曝光——
// 后果很实际：低价收量的"捡漏型"媒体会被高估，做心智的前链路媒体一分钱功劳拿不到，
// 广告主据此砍预算，投放长期效果反而变差。AppLovin/Adjust 这类 MMP 的核心价值就在
// "谁该拿多少钱"是可配置的、可审计的。
//
// 实现 6 种模型：
//   last_touch / first_touch / linear / time_decay(7天半衰) / position_based(40-20-40)
//   data_driven：Shapley 值（n≤10 用蒙特卡洛置换采样；n>10 退化为 Markov 移除效应）
// 浏览归因：无点击但在窗口内的曝光，按 vtaFactor（默认 0.3）折权计入，避免"看一眼也算转化"。

const HALF_LIFE_DAYS = 7;
const VTA_FACTOR = Number(process.env.VTA_FACTOR || 0.3);

// ───────── 旅程构建 ─────────
// touchpoint: {impId, campaignId, publisher, creativeId, ts, type:'impression'|'click', priceMicros}
function buildJourney(rows = []) {
  return rows
    .map(r => ({
      impId: r.imp_id || r.impId, campaignId: Number(r.campaign_id || r.campaignId) || 0,
      publisher: r.publisher || '', creativeId: Number(r.creative_id || r.creativeId) || 0,
      ts: new Date(r.created_at || r.ts).getTime(),
      type: r.type === 'click' ? 'click' : 'impression',
      priceMicros: Number(r.price_micros || r.priceMicros) || 0,
    }))
    .filter(t => Number.isFinite(t.ts))
    .sort((a, b) => a.ts - b.ts);
}

function decayWeight(t, convTs, halfLifeDays = HALF_LIFE_DAYS) {
  const days = Math.max(0, (convTs - t.ts) / 86400000);
  return Math.pow(0.5, days / halfLifeDays);
}

// ───────── 各模型 ─────────
function lastTouch(j) {
  const c = new Array(j.length).fill(0);
  if (!j.length) return c;
  c[j.length - 1] = 1;
  return c;
}
function firstTouch(j) {
  const c = new Array(j.length).fill(0);
  if (j.length) c[0] = 1;
  return c;
}
function linear(j) {
  if (!j.length) return [];
  const v = 1 / j.length;
  return j.map(() => v);
}
function timeDecay(j, convTs) {
  if (!j.length) return [];
  const w = j.map(t => decayWeight(t, convTs));
  const s = w.reduce((a, b) => a + b, 0);
  return s ? w.map(x => x / s) : j.map(() => 1 / j.length);
}
function positionBased(j, first = 0.4, last = 0.4) {
  const n = j.length;
  if (!n) return [];
  if (n === 1) return [1];
  if (n === 2) return [0.5, 0.5];
  const mid = (1 - first - last) / (n - 2);
  return j.map((_, i) => (i === 0 ? first : i === n - 1 ? last : mid));
}
// Shapley（数据驱动）：把"转化是否发生"看作合作博弈，每个触点的贡献 = 其边际贡献期望。
// n 小时的精确 Shapley 需要 2^n 次求值，这里用随机置换采样近似（标准做法）。
function shapley(j, outcomeFn, samples = 512) {
  const n = j.length;
  if (!n) return [];
  if (n === 1) return [outcomeFn([j[0]]) ? 1 : 0];
  const acc = new Array(n).fill(0);
  for (let s = 0; s < samples; s++) {
    const order = j.map((_, i) => i);
    for (let i = n - 1; i > 0; i--) { const k = Math.floor(Math.random() * (i + 1)); [order[i], order[k]] = [order[k], order[i]]; }
    let prev = 0;
    const cur = [];
    for (const idx of order) {
      cur.push(j[idx]);
      const v = outcomeFn(cur) ? 1 : 0;
      acc[idx] += v - prev;
      prev = v;
    }
  }
  const total = acc.reduce((a, b) => a + b, 0);
  if (total <= 0) return linear(j);           // 博弈无贡献差异 → 退化均分，别返回全 0
  const sum = acc.reduce((a, b) => a + b, 0);
  return acc.map(x => x / sum);
}
// Markov 移除效应（长旅程时替代 Shapley）：移除某触点后转化概率下降多少 = 该触点价值
function removalEffect(j, outcomeFn) {
  const full = outcomeFn(j) ? 1 : 0;
  const effects = j.map((_, i) => {
    const sub = j.filter((_, k) => k !== i);
    return Math.max(0, full - (outcomeFn(sub) ? 1 : 0));
  });
  const s = effects.reduce((a, b) => a + b, 0);
  return s ? effects.map(x => x / s) : linear(j);
}

function dataDriven(j, outcomeFn) {
  if (!j.length) return [];
  // 现实中 outcomeFn 由历史数据拟合（如逻辑回归的转化率）；这里允许调用方注入
  const fn = typeof outcomeFn === 'function' ? outcomeFn : () => 1;
  return j.length <= 10 ? shapley(j, fn) : removalEffect(j, fn);
}

const MODELS = { last_touch: lastTouch, first_touch: firstTouch, linear, time_decay: timeDecay, position_based: positionBased, data_driven: dataDriven };

/**
 * @param {Array} journey
 * @param {string} model
 * @param {object} opts {convTs, vta:{enabled, windowMs, factor}, outcomeFn}
 */
function attribute(journey, model = 'last_touch', opts = {}) {
  const j = buildJourney(journey);
  if (!j.length) return { model, credits: [], rollup: {} };
  const convTs = opts.convTs || j[j.length - 1].ts;
  let fn = MODELS[model] || lastTouch;
  let credits = (model === 'time_decay') ? timeDecay(j, convTs) : fn(j, opts.outcomeFn);

  // 浏览归因：无点击的曝光按 factor 折权（防止"一次曝光 = 一次转化功劳"的虚高）
  const vta = opts.vta || {};
  if (vta.enabled !== false) {
    const win = Number(vta.windowMs || 24 * 3600 * 1000);
    const factor = Number(vta.factor || VTA_FACTOR);
    const hasClick = j.some(t => t.type === 'click');
    credits = credits.map((c, i) => {
      const t = j[i];
      if (hasClick && t.type !== 'click') return c * factor;          // 有点击路径时曝光只算辅助
      if (!hasClick && (convTs - t.ts) > win) return 0;               // 纯浏览需落在窗口内
      return c;
    });
    const s = credits.reduce((a, b) => a + b, 0);
    if (s > 0) credits = credits.map(c => c / s);                     // 重新归一，保证总功劳 = 1
    else credits = linear(j);
  }

  const out = j.map((t, i) => ({ ...t, credit: +credits[i].toFixed(6) }));
  const rollup = {};
  for (const t of out) {
    const k = `${t.publisher || 'unknown'}`;
    rollup[k] = (rollup[k] || 0) + t.credit;
  }
  return {
    model, touchpoints: out,
    rollup: Object.keys(rollup).sort((a, b) => rollup[b] - rollup[a])
      .map(k => ({ publisher: k, credit: +rollup[k].toFixed(6) })),
    vta: { enabled: vta.enabled !== false, factor: Number(vta.factor || VTA_FACTOR), windowMs: Number(vta.windowMs || 86400000) },
  };
}

// 多模型对比：让广告主/媒体自己看"换个口径结果差多少"——这也是计量透明度的卖点
function compare(journey, opts = {}) {
  const out = {};
  for (const m of Object.keys(MODELS)) {
    if (m === 'data_driven' && typeof opts.outcomeFn !== 'function') continue;
    out[m] = attribute(journey, m, opts).rollup;
  }
  return out;
}

module.exports = {
  buildJourney, attribute, compare, MODELS,
  lastTouch, firstTouch, linear, timeDecay, positionBased, shapley, removalEffect, dataDriven,
  decayWeight, HALF_LIFE_DAYS, VTA_FACTOR,
};
