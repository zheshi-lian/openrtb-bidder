// attribution/index.js —— 测量层统一入口：多触点归因 + 浏览归因 + SKAN + 增量实验
const mt = require('./multi_touch');
const skan = require('./skan');
const incr = require('./incrementality');

function attachPool(pool) { skan.attachPool(pool); incr.attachPool(pool); }
async function init() { await skan.initTables(); await incr.initTables(); }

// 从库里取某次转化前的完整触点链（曝光+点击），再按指定模型分功劳
async function journeyFor(pool, { impId, canonicalId, lookbackDays = 30 }) {
  if (!pool) return [];
  const rows = await pool.query(
    `SELECT imp_id, campaign_id, publisher, price_micros, created_at, 'impression' type
     FROM bid_win_log WHERE imp_id=? OR ?=''
     UNION ALL
     SELECT imp_id, campaign_id, publisher, 0 price_micros, created_at, type FROM conv_log WHERE type='click' AND (imp_id=? OR ?='')
     ORDER BY created_at`,
    [impId, canonicalId ? '' : impId, impId, canonicalId ? '' : impId]).then(r => r[0]).catch(() => []);
  return mt.buildJourney(rows);
}

function snapshot() {
  return {
    models: Object.keys(mt.MODELS),
    vta_factor: mt.VTA_FACTOR,
    skan_versions: ['2.0', '3.0', '4.0'],
    experiment_types: ['holdout', 'ghost_ads', 'geo_lift'],
  };
}

module.exports = {
  attachPool, init, journeyFor, snapshot,
  multiTouch: mt, skan, incrementality: incr,
  attribute: mt.attribute, compare: mt.compare,
};
