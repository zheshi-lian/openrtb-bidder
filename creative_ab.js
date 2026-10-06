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

async function variants(cid, format) {
  if (!cid || !pool) return [];
  const now = Date.now();
  // 变体名单本地缓存（避免每次竞价查库）；格式维度变化时也命中（format 仅作查询参数，不影响缓存键）
  const cacheKey = cid + (format ? ':' + format : '');
  const c = cache.get(cacheKey);
  if (c && now - c.ts < CACHE_TTL) return c.list;
  let list = [];
  try {
    // 状态机已收敛到 creative_status 单一真源（status / review_status 列已下线），此处用 creative_status='approved'
    let sql = "SELECT id,content,media_url,title,landing_url,format,COALESCE(impressions,0) impressions,COALESCE(clicks,0) clicks,COALESCE(conversions,0) conversions,COALESCE(spend_micros,0) spend_micros FROM creatives WHERE campaign_id=? AND creative_status='approved'";
    const params = [cid];
    if (format) { sql += " AND (format=? OR format='any')"; params.push(format); }
    const [rows] = await pool.query(sql, params);
    list = rows || [];
  } catch (e) { list = []; }
  cache.set(cacheKey, { ts: now, list });
  return list;
}

// 创意疲劳度（fatigue）：素材投放久了 CTR 会自然衰减（用户看腻）。这里在「相对同计划均值」的
// 口径下度量：曝光量已具规模、但 CTR 明显低于计划均值的素材判为疲劳，并按衰减程度注入
// 伪失败(pseudo-failure)拉低其后验，让 Thompson 逐步少投它——实现"自动降权"，无需人工改配额。
// 绝对 CTR 不做跨计划比较（不同行业基线不同），只用同计划横向对比，避免误伤小样本新素材。
const FATIGUE_MIN_IMPS = 100;      // 低于此曝光量不判疲劳（样本不足）
const FATIGUE_RATIO = 0.6;         // CTR 低于计划均值的 60% 才计入疲劳
function computeFatigue(list) {
  let ti = 0, tc = 0;
  for (const v of list) { ti += Number(v.impressions) || 0; tc += Number(v.clicks) || 0; }
  const meanCtr = ti > 0 ? tc / ti : 0;
  return list.map(v => {
    const imps = Number(v.impressions) || 0, clicks = Number(v.clicks) || 0;
    const ctr = imps > 0 ? clicks / imps : 0;
    let fatigue = 0;
    if (meanCtr > 0 && imps >= FATIGUE_MIN_IMPS && ctr < meanCtr * FATIGUE_RATIO) {
      const shortfall = 1 - ctr / (meanCtr * FATIGUE_RATIO);        // 0..1
      const scale = imps / (imps + 2000);                            // 曝光越多越确信
      fatigue = Math.min(1, shortfall * scale);
    }
    return { ...v, ctr, fatigue };
  });
}

// ── 预算/曝光自动分配（素材自动轮换的核心）──
// 把计划的曝光与花费在多素材间按「性能 + 公平性」自动分配，避免单一爆款吃满全部预算、
// 其余素材饿死（那会让探索停滞、长尾素材永远拿不到样本）。
// 做法：每个素材目标占比 = 1/n；实际占比按累计花费(无花费时回落到曝光)估算；
// 实际占比低于目标 → 升权(鼓励多投)，高于目标 → 降权(限流)，clamp 到 [0.3,3] 防极端。
const FAIR_MIN = 0.3, FAIR_MAX = 3;
function computeAllocation(list) {
  const n = list.length;
  if (n <= 1) return list.map(v => ({ ...v, targetShare: 1, actualShare: 1, fair: 1 }));
  let totalSpend = 0, totalImps = 0;
  for (const v of list) { totalSpend += Number(v.spend_micros) || 0; totalImps += Number(v.impressions) || 0; }
  const targetShare = 1 / n;
  return list.map(v => {
    const imps = Number(v.impressions) || 0, spend = Number(v.spend_micros) || 0;
    const actualShare = totalSpend > 0 ? spend / totalSpend
      : (totalImps > 0 ? imps / totalImps : targetShare);
    let fair = targetShare / Math.max(actualShare, 1e-9);
    fair = Math.max(FAIR_MIN, Math.min(FAIR_MAX, fair));
    return { ...v, targetShare, actualShare, fair };
  });
}

// 按 Beta 后验抽版本；无变体时返回 null（调用方回退到 campaign.creative_html）
// 选中权重 = Thompson 后验 × 预算公平分配权重(fair)，实现「择优 + 均摊」同时生效。
// 传入 format 时只在该格式的已审素材中抽样（竞价侧按请求 ad_type 选版，避免 native 请求拿到 icon 素材）
async function pick(cid, format) {
  const vs = await variants(cid, format);
  if (!vs.length) return null;
  const scored = computeAllocation(computeFatigue(vs)).map(v => {
    const clicks = Number(v.clicks) || 0;
    const imps = Number(v.impressions) || 0;
    // 疲劳素材注入伪失败 → 后验下移 → 被抽中概率下降（软降权，不硬断投）
    const pseudoFail = Math.round((v.fatigue || 0) * imps * 0.6);
    // fair=预算公平分配权重：欠投素材升权、过投素材降权，乘进 Thompson 采样比较
    return { ...v, successes: clicks, failures: Math.max(0, imps - clicks) + pseudoFail, weight: v.fair || 1 };
  });
  return ecpm.thompsonPick(scored, { weightKey: 'weight' });
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

// 胜出时按创意 id 直接记账：曝光+花费（竞价热路径用，无需先等 bid_win_log 落库）
async function credit(creativeId, { impressions = 0, clicks = 0, conversions = 0, spendMicros = 0 } = {}) {
  const cid = Number(creativeId) || 0;
  if (!cid || !pool) return;
  const sets = [];
  const vals = [];
  if (impressions) { sets.push('impressions=impressions+?'); vals.push(impressions); }
  if (clicks) { sets.push('clicks=clicks+?'); vals.push(clicks); }
  if (conversions) { sets.push('conversions=conversions+?'); vals.push(conversions); }
  if (spendMicros) { sets.push('spend_micros=spend_micros+?'); vals.push(Math.round(spendMicros)); }
  if (!sets.length) return;
  vals.push(cid);
  await pool.query(`UPDATE creatives SET ${sets.join(',')} WHERE id=?`, vals).catch(() => {});
}

// 分配快照（管理端看数）：每个素材的目标占比 vs 实际占比 + 公平权重，验证"自动轮换/均摊"生效
function allocationOf(list) {
  return computeAllocation(computeFatigue(list)).map(v => ({
    id: v.id, title: v.title, impressions: Number(v.impressions) || 0, clicks: Number(v.clicks) || 0,
    conversions: Number(v.conversions) || 0, spend_micros: Number(v.spend_micros) || 0,
    ctr: v.ctr, fatigue: +(v.fatigue || 0).toFixed(3),
    target_share: +(v.targetShare).toFixed(3), actual_share: +(v.actualShare).toFixed(3),
    fair_weight: +(v.fair || 1).toFixed(3),
  }));
}

module.exports = { attachPool, pick, bump, credit, bust, variants, computeFatigue, computeAllocation, allocationOf, FIELDS };
