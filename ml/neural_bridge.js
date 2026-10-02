'use strict';
// ml/neural_bridge.js —— 把 ml-pipeline「离线真实公开集预训练」的 ESMM 权重接入在线出价热路径。
//
// 角色：作为 per-campaign LR 的「冷启动先验」覆盖 pCTR/pCVR，使离线训练成果(含阿里妈妈 CVR 头)在线生效。
// 安全闸门：
//   - 仅当 NEURAL_ENGINE==='1' 且 NEURAL_MODEL 指向合法模型时启用；默认关闭，完全回落 LR 先验。
//   - neural_cvr.load 内置 provenance 白名单：仅 real-public / real-db-reallog 可加载，
//     synthetic / undefined 一律抛错 → 此处捕获后回落 LR（绝不静默用错模型）。
//   - 离线 reallog 真实回流后，把 NEURAL_MODEL 指向 train_neural.js 产出的 reallog.esmm.json(real-db-reallog) 即可无缝升级。
// 校准：神经输出与 LR 共用同一 calibration 单例（calibration.load 从 DB 加载后共享），
//       predict/scoreFeatures 出栈即过 calibration.apply('neural:ctr'/'neural:cvr')，无拟合时原样返回。

const path = require('path');
let neuralCvr = null;
try {
  // marketing-agent 已内置 ESMM JSON 加载器 + provenance 白名单，直接复用，避免重复实现。
  neuralCvr = require(path.resolve(__dirname, '../../marketing-agent/agent-core/model/neural_cvr'));
} catch (e) {
  console.warn('[neural_bridge] 无法加载 neural_cvr 模块，回落 LR: ' + (e && e.message));
  neuralCvr = null;
}
// 与 LR 共用同一校准单例：calibration.load() 从 DB 加载后，两套预估共享同一组校准器
const calibration = require('./calibration');

const MODEL = process.env.NEURAL_MODEL || '';
const enabled = process.env.NEURAL_ENGINE === '1' && !!neuralCvr && !!MODEL;
let initialized = false, healthy = false;

// 由 campaign + 请求上下文构造 reallog 特征空间输入：industry/goal/channel/creative + bid/hour/crowd
function buildRow(c, ctx) {
  const base = Number((ctx && ctx.base) || (c && c.target_cpm_micros) || 0);
  return {
    industry: (c && (c.app_category || c.industry)) || 'unknown',
    goal: (c && (c.goal_type || c.goal)) || 'CPM',
    channel: 'display',                                  // reallog 样本无渠道维度，统一占位（cold-start 先验）
    creative: (ctx && ctx.format) || 'banner',
    bid: base / 1e6,                                     // micros → 货币单位，贴近离线归一化(x/10)量级
    hour: (ctx && ctx.hour != null) ? Number(ctx.hour) : new Date().getHours(),
    crowd: 0,                                            // 受众/人群列尚未接入 DMP，恒 0（与 marketing-agent 侧一致）
  };
}

function tryInit() {
  if (!enabled) return false;
  try {
    // 触发一次 load（含 provenance 白名单校验），用最小 row 验证可服务
    neuralCvr.predict(MODEL, { industry: 'unknown', goal: 'CPM', channel: 'display', creative: 'banner', bid: 5, hour: 12, crowd: 0 });
    healthy = true;
    console.log('[neural_bridge] 离线预训练权重已接入在线出价: ' + MODEL);
  } catch (e) {
    healthy = false;
    console.warn('[neural_bridge] 模型不可服务，回落 LR 先验: ' + (e && e.message));
  }
  initialized = true;
  return healthy;
}

// 返回 {pctr,pcvr,pctcvr} 或 null（未启用/不可服务时回落 LR）。输出经 calibration.apply 校准，
// 与 LR 共用 'neural:ctr'/'neural:cvr' 校准器（无拟合时原样返回，安全回落）。
function predict(c, ctx) {
  if (!enabled) return null;
  if (!initialized) tryInit();
  if (!healthy) return null;
  try {
    const p = neuralCvr.predict(MODEL, buildRow(c, ctx));
    const pctr = calibration.apply('neural:ctr', p.ctr);
    const pcvr = calibration.apply('neural:cvr', p.cvr);
    return { pctr, pcvr, pctcvr: pctr * pcvr };
  } catch (e) { return null; }
}

// 供校准重拟合(refitCalibration)使用：由 4 维特征向量 x=[industry,goal,channel,creative] 计算并校准神经预估。
// trainingSet 只存 4 维 x，dense(bid/hour/crowd) 用标称值重建——校准是单调变换，标称值不影响拟合质量。
function scoreFeatures(x, dense) {
  if (!enabled) return null;
  if (!initialized) tryInit();
  if (!healthy) return null;
  try {
    const row = {
      industry: (x && String(x[0])) || 'unknown',
      goal: (x && String(x[1])) || 'CPM',
      channel: (x && String(x[2])) || 'display',
      creative: (x && String(x[3])) || 'banner',
      bid: (dense && dense.bid != null) ? Number(dense.bid) / 1e6 : 5,
      hour: (dense && dense.hour != null) ? Number(dense.hour) : 12,
      crowd: (dense && dense.crowd != null) ? Number(dense.crowd) : 0,
    };
    const p = neuralCvr.predict(MODEL, row);
    const pctr = calibration.apply('neural:ctr', p.ctr);
    const pcvr = calibration.apply('neural:cvr', p.cvr);
    return { pctr, pcvr, pctcvr: pctr * pcvr };
  } catch (e) { return null; }
}

function init() { return tryInit(); }
module.exports = { init, predict, scoreFeatures, isEnabled: () => enabled, isHealthy: () => healthy, model: MODEL };
