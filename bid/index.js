// bid/index.js —— 竞价工程层统一入口（胜率 / shading / 节流 / deadline）
const winrate = require('./winrate');
const shading = require('./shading');
const throttle = require('./throttle');

function attachPool(pool) { winrate.attachPool(pool); }
async function init() { await winrate.initTables(); await winrate.load(); }
function startFlusher() {
  const t = setInterval(() => winrate.flush().catch(() => {}), 60000);
  if (t.unref) t.unref();
  return t;
}

// 拍卖结束后回调：记录真实清盘价（用于拟合分布）
function onAuctionEnd(ctx, clearingMicros, won, bidMicros) {
  if (Number.isFinite(clearingMicros) && clearingMicros > 0) winrate.observeClearing(ctx, clearingMicros);
  else winrate.observeOutcome(ctx, !!won);
  if (Number.isFinite(bidMicros) && bidMicros > 0 && typeof won === 'boolean') winrate.observeOutcome(ctx, won);
}

function snapshot() {
  return { winrate: winrate.snapshot(), throttle: throttle.snapshot() };
}

module.exports = {
  attachPool, init, startFlusher, onAuctionEnd, snapshot,
  winrate, shading, throttle,
  pWin: winrate.pWin, shade: shading.shade, shouldProcess: throttle.shouldProcess, deadlineAll: throttle.deadlineAll,
};
