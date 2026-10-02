// creative_ab.js —— P1 创意引擎：多版本 A/B + 自动优选
//
// 为什么用 Thompson Sampling 而不是固定权重：
//   与 ecpm_engine §2.6 同一套探索理论——样本越少的版本不确定性越大、越容易被选中 thereby 探索；
//   点击率高的版本后验分布更靠上 thereby 更容易被选中。表现差的版本自动降权，无需人工改配额。
// 统计口径：impressions / clicks / conversions 记在 creatives 行上，归因靠 bid_win_log.creative_id。

const ecpm = require('./ecpm_engine'); // 复用 sampleBeta/thompsonPick（Beta 后验）

let pool = null;
const cache = new Map();          // campaign_id -> { ts, list }（变体名单本地缓存，避免每次竞价查库）
const CACHE_TTL = 30 * 1000;
// 只允许这三个字段自增，杜绝字段名拼接导致的 SQL 注入
const FIELDS = { impressions: 'impressions', clicks: 'clicks', conversions: 'conversions' };

function attachPool(p) { pool = p; }
function bust(cid) { cache.delete(cid); }

async function variants(cid) {
  if (!cid || !pool) return [];
  const now = Date.now();
  const c = cache.get(cid);
  if (c && now - c.ts < CACHE_TTL) return c.list;
  let list = [];
  try {
    const [rows] = await pool.query(
      "SELECT id,content,media_url,title,landing_url,COALESCE(impressions,0) impressions,COALESCE(clicks,0) clicks,COALESCE(conversions,0) conversions FROM creatives WHERE campaign_id=? AND status='active'", [cid]);
    list = rows || [];
  } catch (e) { list = []; }
  cache.set(cid, { ts: now, list });
  return list;
}

// 按 Beta 后验抽版本；无变体时返回 null（调用方回退到 campaign.creative_html）
async function pick(cid) {
  const vs = await variants(cid);
  if (!vs.length) return null;
  const scored = vs.map(v => {
    const clicks = Number(v.clicks) || 0;
    return { ...v, successes: clicks, failures: Math.max(0, (Number(v.impressions) || 0) - clicks) };
  });
  return ecpm.thompsonPick(scored);
}

// 给该曝光所服务的创意自增统计（异步、不阻塞竞价热路径）
async function bump(impid, field) {
  const col = FIELDS[field];
  if (!impid || !col || !pool) return;
  try {
    const [[w]] = await pool.query('SELECT creative_id FROM bid_win_log WHERE imp_id=?', [String(impid)]);
    if (!w || !w.creative_id) return;
    await pool.query(`UPDATE creatives SET ${col}=${col}+1 WHERE id=?`, [Number(w.creative_id)]).catch(() => {});
  } catch (e) {}
}

module.exports = { attachPool, pick, bump, bust, variants, FIELDS };
