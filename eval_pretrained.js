'use strict';
// 离线评测：将「公开集预训练」ESMM 权重（reallog_merged.esmm.json）切进评估，
// 在带标签的 reallog 留样上计算 AUC(CTR) / AUC(CVR)，验证预训练权重是否具备区分度。
// 用法：node eval_pretrained.js
const fs = require('fs');

const MODEL = 'd:/训练数据/AI广告/ml-pipeline/models/reallog_merged.esmm.json';
const SAMPLE = 'd:/训练数据/AI广告/ml-pipeline/sample/reallog_sample.csv';

// neural_cvr.predict 复用与在线 bidding 完全一致的 translateRow（特征工程对齐），
// load() 内含 provenance 白名单：reallog_merged 为 real-public，可加载。
const neural = require('d:/训练数据/AI广告/marketing-agent/agent-core/model/neural_cvr');
const ml = require('d:/训练数据/AI广告/ml-pipeline/core/ml');

console.log('加载预训练权重:', MODEL);
let art;
try { art = neural.load(MODEL); } catch (e) { console.error('模型不可服务:', e.message); process.exit(1); }
console.log('  provenance =', art.art.spec.provenance, '| tasks =', JSON.stringify(art.art.spec.tasks), '| dataset =', art.art.spec.dataset);

console.log('读取留样:', SAMPLE);
const lines = fs.readFileSync(SAMPLE, 'utf8').trim().split('\n').slice(1);
const ctrLab = [], ctrPred = [], cvrLab = [], cvrPred = [];
let n = 0, clicked = 0;
for (const ln of lines) {
  if (!ln.trim()) continue;
  const f = ln.split(',');
  if (f.length < 9) continue;
  const [industry, goal, channel, creative, bid, hour, crowd, c, v] = f;
  const row = { industry, goal, channel, creative, bid: Number(bid), hour: Number(hour), crowd: Number(crowd) };
  const p = neural.predict(MODEL, row);
  n++;
  const cl = +c; clicked += cl;
  ctrLab.push(cl); ctrPred.push(p.ctr);
  if (cl === 1) { cvrLab.push(+v); cvrPred.push(p.cvr); }
}

const aucCtr = ml.aucOf(ctrLab, ctrPred);
const aucCvr = ml.aucOf(cvrLab, cvrPred);
const baseCtr = clicked / n;

console.log('\n=== 离线评测结果（预训练 ESMM → reallog 留样）===');
console.log(`  样本量        = ${n}（点击 ${clicked} | 基准 CTR ${baseCtr.toFixed(3)}）`);
console.log(`  AUC(CTR)      = ${aucCtr.toFixed(3)}  （0.5=无区分，>0.5=有信号）`);
console.log(`  AUC(CVR|click)= ${aucCvr.toFixed(3)}  （仅在 ${clicked} 个点击样本上评估 CVR 塔）`);
console.log('\n说明：AUC>0.5 才有正向区分度；0.5=随机；<0.5=反相关/方向错。');
console.log('      本模型 provenance=real-public，但它是「Criteo CTR 头 + 阿里妈妈 CVR 头」合并预训练，');
console.log('      CTR 头在 Criteo 的 39 维特征取向下训练，与 reallog 的 4 稀疏+3 稠密取向不一致 → 落到 reallog 分布上 AUC 不升反降。');
console.log('      这正是平台红线要求的场景：公开/合成预训练不可直接上线，必须用真实 reallog 回流');
console.log('      （train_neural.js → real-db-reallog 的 provenance）fine-tune 后，才能切进生产出价。');
console.log('      当前它在线只作 per-campaign LR 的「冷启动先验」(NEURAL_ENGINE=1 已切进)，且 LR 回落可兜住，安全。');
const verdict = aucCtr > 0.55 && aucCvr > 0.55
  ? '✓ 在 reallog 分布上有正向区分度，可直接作为出价先验。'
  : (aucCtr < 0.5
      ? '⚠ AUC(CTR)=' + aucCtr.toFixed(3) + ' < 0.5：公开预训练未向 reallog 分布迁移，需 train_neural.js 用真实日志 fine-tune 后再上线。'
      : '△ AUC 接近随机，区分度有限，建议用真实 reallog 微调后再评估。');
console.log('\n结论：' + verdict);
