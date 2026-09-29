// run_ecpm_demo.js —— 用 BP_v7 真实场景演示 eCPM' 引擎
// 场景：某 SMB 组织刚完成"采购审批"，进入工作流空档（§3.2 审批完成页=最佳位）
//       候选 = 若干 to B 服务商的服务包 SKU（L-B 层，§2.2）竞价这个"组织需求位"
const ecpm = require('./ecpm_engine');

// 检索位上下文（§3.4 验收线：CTR≥12%、商机率≥10%）
const slot = { ctr: 0.12, leadRate: 0.10 };

// 候选服务包 SKU（供给单位=SKU 不是公司，§2.2）
const candidates = [
  { id: 'A', name: '财税月结包',     bidType: 'CPA', bid: 220, evalScore: 0.85, behaviorScore: 0.20, nSamples: 5,   svcFactor: 1.15, ltvFactor: 1.1, successes: 1,  failures: 4 },
  { id: 'B', name: '物流调度包',     bidType: 'CPA', bid: 260, evalScore: 0.55, behaviorScore: 0.12, nSamples: 3,   svcFactor: 1.0,  ltvFactor: 1.0, successes: 0,  failures: 3 },
  { id: 'C', name: 'HR招聘初筛包',   bidType: 'CPC', bid: 25,  evalScore: 0.70, behaviorScore: 0.30, nSamples: 120, svcFactor: 1.2,  ltvFactor: 1.2, successes: 36, failures: 84 },
  { id: 'D', name: '新入驻法务包',   bidType: 'CPA', bid: 300, evalScore: 0.60, behaviorScore: 0.0,  nSamples: 0,   svcFactor: 1.0,  ltvFactor: 1.0, successes: 0,  failures: 0 },
  { id: 'E', name: '品牌品类独占',   bidType: 'CPM', bid: 1200, evalScore: 0.0,  behaviorScore: 0.0,  nSamples: 0,   svcFactor: 1.0,  ltvFactor: 1.0, successes: 0,  failures: 0 },
];

const demand = { orgId: 'smb-8821', trigger: 'purchase_approval', orgSize: 'SMB' };

console.log('=== 场景：SMB 组织"采购审批完成" → 组织需求位（检索位, CTR=12% 商机率=10%）===\n');
const out = ecpm.selectWinner(demand, candidates, slot, { deterministic: true });

console.log('候选 SKU 排序（deterministic eCPM\' 主排序）：');
console.log('排名  SKU   类型   出价     nSamples  pEffect  统一eCPM   eCPM\'     冷启动');
out.ranked.forEach((s, i) => {
  console.log(
    `${String(i + 1).padEnd(4)} ${s.id.padEnd(5)} ${s.bidType.padEnd(4)} ${String(s.bid).padEnd(7)} ` +
    `${String(s.nSamples).padEnd(8)} ${String(s.pEffect).padEnd(8)} ${String(s.unifiedEcpm).padEnd(9)} ${String(s.ecpmPrime).padEnd(9)} ${s.cold ? '是' : '否'}`
  );
});
console.log('\n胜出者(主排序)：', out.winner.name, 'eCPM\'=', out.winner.ecpmPrime, '\n');

console.log('--- BP_v7 关键结论验证 ---');
console.log('① 质量度机制：品牌型 E 出价最高(CPM1200)但 evalScore=0 → eCPM\' 最低，排不上（效果差出价高也排不上，§2.6）');
console.log('② 冷启动贝叶斯：A 仅 5 样本，α=' + (ecpm.N0 / (ecpm.N0 + 5)).toFixed(2) + '，主要靠评测分 0.85 兜底，第一天就有可用效果预估');
console.log('③ 成熟服务商 C：nSamples=120，行为数据接管，出价虽低(CPC25)仍凭真实效果排前');

// 探索配额模拟：跑 2000 次拍卖，统计胜出分布（验证 10–15% 探索把新服务商 D 送上去）
const N = 2000;
const win = {};
for (let i = 0; i < N; i++) {
  const r = ecpm.selectWinner(demand, candidates, slot, { exploreRate: 0.15 });
  win[r.winner.id] = (win[r.winner.id] || 0) + 1;
}
console.log('\n--- 探索配额模拟（' + N + ' 次拍卖, exploreRate=0.15）---');
console.log('胜出分布：', Object.fromEntries(Object.entries(win).map(([k, v]) => [k, (v / N * 100).toFixed(1) + '%'])));
console.log('→ 约 15% 拍卖进入探索配额；纯冷启动、零行为数据的 D（法务包）在其中分到可观份额，不会被"永远排不上"死锁（§2.6）');
console.log('\nAPI 调用示例：POST /api/ecpm/rank  { demand, candidates, slot, opts }');
