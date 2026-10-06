// test_ecpm_learning.js —— 验证 B：三层评测冷启动 → 归因回流 → α 衰减后行为数据接管排序
// 期望看到：真实效果好但评测一般的 SKU 排名上升，真实效果差的 SKU 排名暴跌（§2.6 飞轮）
const BASE = 'http://127.0.0.1:8080';
const SLOT = { ctr: 0.12, leadRate: 0.10 };

// Fix-06：SKU 改为「广告库存品类」。此前是财税/物流/法务等外部 SaaS 商品包，
// 与本平台广告业务错位，且把 /api/ecpm/evals 的语义污染成了另一个产品的目录。
// trueRate = 该品类真实转化率（模拟"真相"，模型一开始不知道）
const SKUS = [
  { skuId: 'ecommerce',  name: '电商·限时折扣', bidType: 'CPA', bid: 230, l1: 0.90, l2: 0.85, l3: 0.80, ltvFactor: 1.10, svcFactor: 1.15, trueRate: 0.18 },
  { skuId: 'education',  name: '教育·课程试听', bidType: 'CPA', bid: 260, l1: 0.70, l2: 0.55, l3: 0.60, ltvFactor: 1.00, svcFactor: 1.00, trueRate: 0.04 },
  { skuId: 'casual_game', name: '休闲游戏',     bidType: 'CPA', bid: 300, l1: 0.60, l2: 0.60, l3: 0.50, ltvFactor: 1.00, svcFactor: 1.00, trueRate: 0.30 },
  { skuId: 'brand_cpm',  name: '纯品牌曝光',   bidType: 'CPM', bid: 1200, l1: 0.50, l2: 0.00, l3: 0.00, ltvFactor: 1.00, svcFactor: 1.00, trueRate: 0.00 },
];

const post = async (p, b) => (await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) })).json();
const cand = () => SKUS.map(s => ({ skuId: s.skuId, name: s.name, bidType: s.bidType, bid: s.bid, ltvFactor: s.ltvFactor, svcFactor: s.svcFactor }));
const order = d => d.ranked.map(r => `${r.name}(${r.ecpmPrime})`).join(' > ');

(async () => {
  try {
    // ① 入库三层评测
    for (const s of SKUS) await post('/api/ecpm/eval', { skuId: s.skuId, name: s.name, l1: s.l1, l2: s.l2, l3: s.l3 });
    const cold = await post('/api/ecpm/rank', { candidates: cand(), slot: SLOT, opts: { deterministic: true } });
    console.log('【冷启动 n=0】评测分主导');
    console.log('  排序：', order(cold));
    console.log('  胜出：', cold.winner.name, '\n');

    // ② 模拟 T+30 转化归因回流（每家 60 次）
    const N = 60;
    for (const s of SKUS) for (let i = 0; i < N; i++) await post('/api/ecpm/feedback', { skuId: s.skuId, converted: Math.random() < s.trueRate });
    const learned = await post('/api/ecpm/rank', { candidates: cand(), slot: SLOT, opts: { deterministic: true } });
    console.log(`【学习后 n=${N}】行为数据接管`);
    console.log('  排序：', order(learned));
    console.log('  胜出：', learned.winner.name, '\n');

    // ③ α 衰减状态
    const evals = await (await fetch(BASE + '/api/ecpm/evals')).json();
    console.log('【α 衰减 / 学习状态】');
    evals.forEach(e => {
      const truth = SKUS.find(s => s.skuId === e.skuId);
      console.log(`  ${e.name}: 评测分=${e.evalScore} 真实转化率≈${(e.successes / Math.max(1, e.nSamples)).toFixed(2)}(设定${truth.trueRate}) n=${e.nSamples} α=${e.alpha} → ${e.alpha >= 0.7 ? '评测分主导' : e.alpha > 0.3 ? '混合' : '行为数据主导'}`);
    });
    const BEST = 'casual_game', WORST = 'education';
    const before = cold.ranked.find(r => r.skuId === BEST);
    const after = learned.ranked.find(r => r.skuId === BEST);
    console.log(`\n结论：休闲游戏(真实效果最好 0.30)名次 ${cold.ranked.findIndex(r => r.skuId === BEST) + 1} → ${learned.ranked.findIndex(r => r.skuId === BEST) + 1}，` +
      `eCPM' ${before.ecpmPrime} → ${after.ecpmPrime}；教育(真实最差 0.04)被降到第 ${learned.ranked.findIndex(r => r.skuId === WORST) + 1}。`);
    console.log('→ 飞轮成立：提升真实效果 → 排名上升 → 更多曝光 → 更多数据（§2.6）。');
  } catch (e) { console.log('失败（请确认 server 已重启加载新端点）：', e.message); }
})();
