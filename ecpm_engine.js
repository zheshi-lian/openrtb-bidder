// ecpm_engine.js —— eCPM' 竞价排序引擎骨架（对齐 BP_v7《给钉钉商业化总裁》§2.6）
//
// 核心公式（§2.6）：
//   eCPM' = 效果预测 × LTV预测 × 出价 × 服务承诺系数
//
// 与 Google Ad Rank 同源：Ad Rank = 出价 × 质量度；本方案 eCPM' = 出价 × 质量度(三因子)。
// 质量度由"效果预测"承载，保证"效果差的服务商出价再高也排不上"（§2.6 枢纽）。
//
// 关键设计点（均来自 BP_v7）：
//   · 供给单位 = 可交付服务包 SKU（L-B 层），不是公司（§2.2）
//   · 冷启动 = 贝叶斯融合：效果预测 = α·评测分 + (1-α)·行为数据分，α=N0/(N0+n)（§2.6）
//   · 探索 = 预留 10–15% 探索流量，Thompson Sampling（不确定性越大越易中）（§2.6）
//   · 统一货币 = CPM/CPC/CPA 全部折算为"每千次曝光口径"后统一排序（§2.10）

const N0 = 20; // 先验强度：前 20 条样本以评测分为准（§2.6）

// ── 三层评测（§3.3）：L1 能力评测 30% + L2 效果评测 50% + L3 交付口碑 20% ──
// 评测集是 eCPM' 冷启动的燃料：新服务商在拿到第一次曝光之前就有可用效果预估。
const EVAL_WEIGHTS = { l1: 0.30, l2: 0.50, l3: 0.20 };

function composeEvalScore(e = {}) {
  const num = (v, d) => (typeof v === 'number' ? v : d);
  const l1 = num(e.l1, 0.5), l2 = num(e.l2, 0.5), l3 = num(e.l3, 0.5);
  return +(l1 * EVAL_WEIGHTS.l1 + l2 * EVAL_WEIGHTS.l2 + l3 * EVAL_WEIGHTS.l3).toFixed(4);
}

// 兼容两种喂法：直接给 evalScore，或给 L1/L2/L3 由三层评测合成
function evalScoreOf(sku) {
  if (typeof sku.evalScore === 'number') return sku.evalScore;
  if (sku.l1 != null || sku.l2 != null || sku.l3 != null) return composeEvalScore(sku);
  return 0.5;
}

// α 衰减：先验(评测分)权重，随归因样本 n 增加而下降
function alpha(n) { return N0 / (N0 + (n || 0)); }

// ── 效果预测：贝叶斯融合（评测分先验 + 行为数据似然）─────────────────
// evalScore  : L2 效果评测分（冷启动先验，§3.3 行业评测集盲测）——新服务商第一天就有的质量信号
// behavior   : 历史归因商机率（行为数据，T+30 回流）——成熟后接管
function predictEffect(sku) {
  const n = sku.nSamples || 0;
  const a = alpha(n);
  const evalScore = evalScoreOf(sku);                                  // 先验：三层评测分
  const behavior = typeof sku.behaviorScore === 'number' ? sku.behaviorScore : evalScore; // 似然：归因回流
  return a * evalScore + (1 - a) * behavior;
}

// ── 出价折算到每千次曝光口径（跨 CPM/CPC/CPA 可比）───────────────────
// slot.ctr     : 该位点击率（检索位默认 0.12，§3.4）
// slot.leadRate: 该位商机率（点击→有效商机 T+30，默认 0.10，§3.4）
function unifiedEcpm(sku, slot) {
  const ctr = slot.ctr ?? 0.12;
  const cvr = slot.leadRate ?? 0.10;
  if (sku.bidType === 'CPM') return sku.bid / 1000;
  if (sku.bidType === 'CPC') return sku.bid * ctr;
  return sku.bid * ctr * cvr; // CPA：出价×CTR×商机率 = 每曝光期望收入
}

// ── eCPM' 主排序分 ─────────────────────────────────────────────────
function ecpmPrime(sku, slot) {
  const pEffect = predictEffect(sku);              // 质量度（效果预测）
  const ltv = typeof sku.ltvFactor === 'number' ? sku.ltvFactor : 1.0;   // LTV预测（行业均值先验=1.0）
  const svc = typeof sku.svcFactor === 'number' ? sku.svcFactor : 1.0;   // 服务承诺系数（SLA/赔付）
  return pEffect * ltv * unifiedEcpm(sku, slot) * svc;
}

// ── 完整排序：返回带 pEffect / 折算 / eCPM' 的候选列表 ───────────────
function rankCandidates(demand, candidates, slot, opts = {}) {
  const ranked = candidates.map((sku) => ({
    ...sku,
    pEffect: +predictEffect(sku).toFixed(4),
    unifiedEcpm: +unifiedEcpm(sku, slot).toFixed(4),
    ecpmPrime: +ecpmPrime(sku, slot).toFixed(4),
    cold: (sku.nSamples || 0) < N0, // 冷启动标记
  }));
  ranked.sort((a, b) => b.ecpmPrime - a.ecpmPrime);
  return ranked;
}

// ── Thompson Sampling 探索抽样（Beta 后验）───────────────────────────
function gauss() { let u = 0; while (!u) u = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * Math.random()); }
function gamma(shape) {
  if (shape < 1) return gamma(shape + 1) * Math.pow(Math.random(), 1 / shape);
  const d = shape - 1 / 3, c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x, v; do { x = gauss(); v = 1 + c * x; } while (v <= 0);
    v = v * v * v; const u = Math.random();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}
function sampleBeta(a, b) { return gamma(a) / (gamma(a) + gamma(b)); }
function thompsonPick(candidates) {
  // 用"成功/失败"计数构造 Beta 后验；样本越少不确定性越大，越易被探索选中
  const s = candidates.map((c) => ({ c, v: sampleBeta((c.successes || 0) + 1, (c.failures || 0) + 1) }));
  s.sort((a, b) => b.v - a.v);
  return s[0].c;
}

// ── 选胜出者：默认主排序，按 exploreRate 概率走探索配额 ─────────────
// opts.exploreRate : 探索流量比例（默认 0.15，§2.6）
// opts.deterministic: true 时永远走 eCPM' 主排序（演示/验收用，结果稳定）
function selectWinner(demand, candidates, slot, opts = {}) {
  const ranked = rankCandidates(demand, candidates, slot, opts);
  const exploreRate = opts.exploreRate ?? 0.15;
  if (!opts.deterministic && Math.random() < exploreRate) {
    return { winner: thompsonPick(candidates), exploration: true, ranked, exploreRate };
  }
  return { winner: ranked[0], exploration: false, ranked, exploreRate };
}

module.exports = {
  N0, EVAL_WEIGHTS, composeEvalScore, evalScoreOf, alpha,
  predictEffect, unifiedEcpm, ecpmPrime, rankCandidates,
  selectWinner, sampleBeta, thompsonPick,
};
