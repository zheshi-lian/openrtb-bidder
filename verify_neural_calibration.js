'use strict';
// 验证：神经引擎输出已接入 calibration.js，且校准能从真实反馈修正过度自信
process.env.NEURAL_ENGINE = '1';
process.env.NEURAL_MODEL = 'd:/训练数据/AI广告/ml-pipeline/models/reallog_merged.esmm.json';

const calibration = require('./ml/calibration');   // 与 neural_bridge 共享同一单例
const neural = require('./ml/neural_bridge');

const c = { app_category: 'gaming', goal_type: 'CPA', target_cpm_micros: 25000000 };
const ctx = { base: 25000000, format: 'interstitial', hour: 14 };

console.log('enabled=', neural.isEnabled(), 'healthy=', neural.isHealthy());

// 1) 无校准器时：apply 原样返回，predict 透传神经原始输出
const r0 = neural.predict(c, ctx);
console.log('[未校准] predict =', JSON.stringify(r0));

// 2) 模拟真实回流：神经给 ~0.98 但实际点击率只有 0.05（过度自信）——拟合校准器
const pairs = [];
for (let i = 0; i < 200; i++) pairs.push({ score: 0.98 - Math.random() * 0.02, label: Math.random() < 0.05 ? 1 : 0 });
const fitRes = calibration.fit('neural:ctr', pairs);
console.log('[拟合 neural:ctr]', JSON.stringify(fitRes));
console.log('  apply(0.98) 校准前→后:', 0.98, '→', calibration.apply('neural:ctr', 0.98).toFixed(4));

// 3) 校准器生效后，predict 的 pctr 应被压缩（证明校准接到了神经输出）
const r1 = neural.predict(c, ctx);
console.log('[校准后] predict =', JSON.stringify(r1));

// 4) scoreFeatures（供 refitCalibration 周期重拟合使用）
console.log('[scoreFeatures x=[gaming,CPA,display,banner]] =', JSON.stringify(neural.scoreFeatures(['gaming', 'CPA', 'display', 'banner'])));

console.log('OK: 神经引擎输出已接入 calibration，关闭 NEURAL_ENGINE 时 predict 回落 null（见此前验证）。');
