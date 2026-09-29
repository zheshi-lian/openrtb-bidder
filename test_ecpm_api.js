const body = {
  demand: { orgId: 'smb-8821', trigger: 'purchase_approval' },
  slot: { ctr: 0.12, leadRate: 0.10 },
  candidates: [
    { id: 'A', name: '财税月结包', bidType: 'CPA', bid: 220, evalScore: 0.85, behaviorScore: 0.20, nSamples: 5, svcFactor: 1.15, ltvFactor: 1.1 },
    { id: 'D', name: '新入驻法务包', bidType: 'CPA', bid: 300, evalScore: 0.60, nSamples: 0 },
    { id: 'E', name: '品牌品类独占', bidType: 'CPM', bid: 1200, evalScore: 0.0 }
  ]
};
fetch('http://127.0.0.1:8080/api/ecpm/rank', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
}).then(r => r.json()).then(d => {
  console.log('API /api/ecpm/rank 返回胜出：', d.winner.name, 'eCPM\'=', d.winner.ecpmPrime, '| 排序数=', d.ranked.length);
}).catch(e => console.log('API 调用失败（需重启 server 加载新路由）：', e.message));
