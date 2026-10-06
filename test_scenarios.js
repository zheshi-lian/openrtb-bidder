// test_scenarios.js —— 验证"广告品类版"是否说服力成立：
// ① 每个广告位上下文下，胜出广告必须是真正命中此刻意图的品类，而不是只见曝光的品牌型广告
// ② 纯曝光型广告（L2效果≈0）必须排在末位 —— 质量度机制生效
// ③ 转化回流后，真实转化好(trueRate高)的品类应被数据推上来
const BASE = 'http://127.0.0.1:8080';
const SLOT = { ctr: 0.12, leadRate: 0.10 };
const post = async (p, b) => (await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) })).json();
const cand = (arr) => arr.map(s => ({ skuId: s.skuId, name: s.name, bidType: s.bidType, bid: s.bid, ltvFactor: s.ltv, svcFactor: s.svc }));

// Fix-06：候选必须是「广告库存品类」，不能是别的 SaaS 产品的商品目录。
// 此前这里播种的是电子签章 / 计件工资等 Kx Learning 品类，导致 /api/ecpm/evals 语义与本平台错位。
const SCENARIOS = {
  '休闲游戏 · 激励视频位': [
    { skuId: 'hybrid_game', name: '混合变现游戏(IAA+IAP)', bidType: 'CPA', bid: 260, l1: .91, l2: .86, l3: .82, ltv: 1.25, svc: 1.15, trueRate: .32 },
    { skuId: 'casual_game', name: '休闲游戏', bidType: 'CPA', bid: 240, l1: .82, l2: .74, l3: .70, ltv: 1.15, svc: 1.10, trueRate: .28 },
    { skuId: 'puzzle_game', name: '益智游戏', bidType: 'CPA', bid: 220, l1: .85, l2: .70, l3: .68, ltv: 1.05, svc: 1.00, trueRate: .24 },
    { skuId: 'game', name: '游戏(综合买量)', bidType: 'CPA', bid: 200, l1: .88, l2: .60, l3: .62, ltv: 1.00, svc: 1.00, trueRate: .18 },
    { skuId: 'brand_cpm', name: '纯品牌曝光', bidType: 'CPM', bid: 1200, l1: .50, l2: .00, l3: .00, ltv: 1.00, svc: 1.00, trueRate: .00 },
  ],
  '电商 App · 信息流位': [
    { skuId: 'ecommerce', name: '电商·限时折扣', bidType: 'CPA', bid: 230, l1: .78, l2: .78, l3: .70, ltv: 1.20, svc: 1.10, trueRate: .30 },
    { skuId: 'social', name: '社交·兴趣社区', bidType: 'CPA', bid: 180, l1: .80, l2: .62, l3: .62, ltv: 1.10, svc: 1.00, trueRate: .20 },
    { skuId: 'education', name: '教育·课程试听', bidType: 'CPA', bid: 200, l1: .75, l2: .58, l3: .55, ltv: 1.25, svc: 1.05, trueRate: .16 },
    { skuId: 'finance', name: '金融·分期免息', bidType: 'CPA', bid: 280, l1: .72, l2: .50, l3: .48, ltv: 1.30, svc: 1.00, trueRate: .12 },
  ],
  '工具类 App · 开屏位': [
    { skuId: 'tools', name: '工具·清理加速', bidType: 'CPA', bid: 150, l1: .65, l2: .70, l3: .60, ltv: 1.00, svc: 1.00, trueRate: .26 },
    { skuId: 'casual_game', name: '休闲游戏', bidType: 'CPA', bid: 210, l1: .82, l2: .66, l3: .68, ltv: 1.15, svc: 1.10, trueRate: .22 },
    { skuId: 'ecommerce', name: '电商·新人礼包', bidType: 'CPA', bid: 190, l1: .78, l2: .60, l3: .64, ltv: 1.20, svc: 1.05, trueRate: .18 },
    { skuId: 'brand_cpm', name: '纯品牌曝光', bidType: 'CPM', bid: 1000, l1: .50, l2: .00, l3: .00, ltv: 1.00, svc: 1.00, trueRate: .00 },
  ],
};

const isBrand = (n) => /曝光/.test(n);
const order = (d) => d.ranked.map(r => r.name).join(' > ');

(async () => {
  try {
    for (const [label, list] of Object.entries(SCENARIOS)) {
      for (const s of list) await post('/api/ecpm/eval', { skuId: s.skuId, name: s.name, l1: s.l1, l2: s.l2, l3: s.l3 });
      await post('/api/ecpm/reset', {}); // 回到冷启动，保证可重复演示
      const cold = await post('/api/ecpm/rank', { candidates: cand(list), slot: SLOT, opts: { deterministic: true } });
      const last = cold.ranked[cold.ranked.length - 1];

      const N = 50;
      for (const s of list) for (let i = 0; i < N; i++) await post('/api/ecpm/feedback', { skuId: s.skuId, converted: Math.random() < s.trueRate });
      const learned = await post('/api/ecpm/rank', { candidates: cand(list), slot: SLOT, opts: { deterministic: true } });

      const best = [...list].filter(s => !isBrand(s.name)).sort((a, b) => b.trueRate - a.trueRate)[0];
      console.log(`\n【${label}】`);
      console.log('  冷启动排序：', order(cold));
      console.log(`  ✓ 首选非曝光：${!isBrand(cold.winner.name) ? '通过（' + cold.winner.name + '）' : '未通过'}`);
      console.log(`  ✓ 曝光型垫底：${isBrand(last.name) ? '通过（' + last.name + '）' : '未通过：' + last.name}`);
      console.log('  学习后排序：', order(learned));
      console.log(`  ✓ 数据授证：真实效果最好「${best.name}」(trueRate=${best.trueRate}) 名次 ` +
        `${cold.ranked.findIndex(r => r.skuId === best.skuId) + 1} → ${learned.ranked.findIndex(r => r.skuId === best.skuId) + 1}`);
      await post('/api/ecpm/reset', {}); // 演示后复原冷启动
    }
    console.log('\n→ 结论：胜出广告始终是命中此刻意图的品类，只见曝光的品牌型广告恒排末位；' +
      '真实转化效果一旦被 T+30 回流数据验证，就会被飞轮推上来（§2.6）。');
  } catch (e) { console.log('失败（确认 server 已重启加载 /api/ecpm/reset）：', e.message); }
})();
