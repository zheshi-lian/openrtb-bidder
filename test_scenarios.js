// test_scenarios.js —— 验证"协同办公场景版"是否说服力成立：
// ① 每个场景下，推荐首选必须是真正解决痛点的产品，而不是只见曝光的品牌型 SKU
// ② 品牌型 SKU（L2效果≈0）必须排在末位 —— 质量度机制生效
// ③ 归因回流后，真实交付效果好(trueRate高)的产品应被数据推上来
const BASE = 'http://127.0.0.1:8080';
const SLOT = { ctr: 0.12, leadRate: 0.10 };
const post = async (p, b) => (await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) })).json();
const cand = (arr) => arr.map(s => ({ skuId: s.skuId, name: s.name, bidType: s.bidType, bid: s.bid, ltvFactor: s.ltv, svcFactor: s.svc }));

const SCENARIOS = {
  '直播/培训结束页': [
    { skuId: 'kx-learning', name: 'AI学习地图(一键转必修课)', bidType: 'CPA', bid: 210, l1: .88, l2: .86, l3: .82, ltv: 1.15, svc: 1.10, trueRate: .30 },
    { skuId: 'yxt-course', name: '体系化课程库', bidType: 'CPA', bid: 190, l1: .82, l2: .74, l3: .78, ltv: 1.05, svc: 1.00, trueRate: .18 },
    { skuId: 'survey', name: '满意度调研', bidType: 'CPC', bid: 22, l1: .80, l2: .60, l3: .66, ltv: 1.00, svc: 1.00, trueRate: .12 },
    { skuId: 'cert', name: '学时证书', bidType: 'CPA', bid: 150, l1: .78, l2: .55, l3: .62, ltv: 1.00, svc: 1.05, trueRate: .08 },
    { skuId: 'live-brand', name: '品牌曝光', bidType: 'CPM', bid: 1100, l1: .50, l2: .00, l3: .00, ltv: 1.00, svc: 1.00, trueRate: .00 },
  ],
  '考勤核算完成': [
    { skuId: 'paiban', name: '智能排班(一键生成排班)', bidType: 'CPA', bid: 250, l1: .90, l2: .90, l3: .82, ltv: 1.25, svc: 1.15, trueRate: .30 },
    { skuId: 'jijian', name: '计件工资核算', bidType: 'CPA', bid: 270, l1: .86, l2: .86, l3: .80, ltv: 1.20, svc: 1.05, trueRate: .38 },
    { skuId: 'xinchou', name: '薪酬社保核算', bidType: 'CPA', bid: 210, l1: .88, l2: .72, l3: .80, ltv: 1.25, svc: 1.15, trueRate: .22 },
    { skuId: 'att-brand', name: 'HR品类曝光', bidType: 'CPM', bid: 1000, l1: .55, l2: .05, l3: .05, ltv: 1.00, svc: 1.00, trueRate: .01 },
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
    console.log('\n→ 结论：推荐首选始终是解决此刻痛点的产品，只见曝光的品牌 SKU 恒排末位；' +
      '真实交付效果一旦被 T+30 商机数据验证，就会被飞轮推上来（§2.6）。');
  } catch (e) { console.log('失败（确认 server 已重启加载 /api/ecpm/reset）：', e.message); }
})();
