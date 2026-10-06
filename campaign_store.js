// campaign_store.js — 竞价热路径内存快照 + 倒排索引（去 DB / 去逐条 redis，冲 <10ms）
//
// 原 /openrtb2/bid 循环对每个候选 campaign 串行做 5 处异步 I/O（relevanceFor redis /
// brandSafety.policy DB / todaySpend DB / pacing.gate DB+redis / perfFactor DB）+ 胜者创意 DB，
// 单次 MySQL ~130ms，冷 miss 在并发下排队 → p99 爆到秒级。
// 这里把「活跃 campaign 集 + 各 campaign 的品牌安全策略 / 当日消耗 / 转化系数 / 节奏配置 / 绑定创意」
// 一次性批量预计算进内存（默认每 3s 刷新），并提供按 品类 / 国家 的倒排索引取候选。
// 热路径只做同步读取，零 await、零逐条查库（RTB 标准的内存拍卖架构）。
const MIN_RELEVANCE = 0.05;

let _snap = {
  byId: new Map(), byCat: new Map(), byGeo: new Map(),
  pol: new Map(), spend: new Map(), perf: new Map(), del: new Map(), cv: new Map(),
  ts: 0, ok: false,
};
let _timer = null, _opts = null;

function _add(map, k, id) { if (!map.has(k)) map.set(k, new Set()); map.get(k).add(id); }

// 目标反馈闭环（对标 AppLovin 的「目标达成即自动调价」）：把「实际 CPA/ROAS vs 目标」
// 换算成一个出价系数乘进出价，让 CPA/ROAS 目标不只是写进库，而是真正参与每次竞价决策。
//   CPA 目标：实际CPA > 目标 → 降价（系数<1）；实际CPA < 目标 → 涨价（系数>1，上限 1.3）。
//   ROAS 目标：实际ROAS < 目标 → 降价；高于目标 → 涨价。
//   CPM 目标 / 无转化数据 → 返回 1（不干预，避免冷启动被误伤）。
async function goalMultiplier(c) {
  const goal = String(c.goal_type || 'CPM').toUpperCase();
  if (goal !== 'CPA' && goal !== 'ROAS') return 1;
  if (!_opts || !_opts.pool) return 1;
  try {
    const [[agg]] = await _opts.pool.query(
      `SELECT COALESCE(SUM(b.price_micros),0) spend,
              COALESCE(SUM(cv.amount),0) value,
              COALESCE(SUM(cv.n),0) conv
       FROM bid_win_log b
       LEFT JOIN (
         SELECT campaign_id, SUM(type='conversion') n,
                SUM(CASE WHEN type='conversion' THEN amount ELSE 0 END) amount
         FROM conv_log WHERE created_at > NOW() - INTERVAL 3 DAY GROUP BY campaign_id
       ) cv ON cv.campaign_id = b.campaign_id
       WHERE b.campaign_id=? AND b.created_at > NOW() - INTERVAL 3 DAY`,
      [c.id]);
    const spend = Number(agg && agg.spend) || 0;
    const value = Number(agg && agg.value) || 0;
    const conv = Number(agg && agg.conv) || 0;
    const clamp = (x) => +Math.min(1.3, Math.max(0.3, x)).toFixed(3);
    if (goal === 'CPA') {
      const target = Number(c.target_cpa_micros) || 0;
      if (target <= 0) return 1;
      if (conv <= 0) return spend > 0 ? 0.8 : 1;      // 有消耗无转化 → 降价
      return clamp(target / (spend / conv));
    }
    const target = Number(c.target_roas) || 0;         // ROAS
    if (target <= 0 || spend <= 0) return 1;
    return clamp((value / spend) / target);
  } catch (e) { return 1; }
}

async function refresh() {
  if (!_opts || !_opts.pool) return;
  const { pool, brandSafety, pacing, todaySpend, perfFactor } = _opts;
  try {
    const [rows] = await pool.query(
      "SELECT id,advertiser,budget_micros,status,country,app_category,creative_html,landing_url," +
      "target_cpm_micros,intent_tags,intent_profile,review_status,intent_embed,daily_cap_micros," +
      "goal_type,target_cpa_micros,target_roas,is_test,creative_id,geo_country,device_type,os,bid_floor_micros,retarget,retarget_window_days,interest_target,lookalike FROM adv_campaign " +
      "WHERE status=1 AND (review_status IS NULL OR review_status='approved') " +
      "AND (advertiser='' OR advertiser NOT IN (SELECT advertiser FROM adv_balance WHERE balance_micros<=0))"
    );
    const byId = new Map(), byCat = new Map(), byGeo = new Map();
    for (const c of rows) {
      byId.set(c.id, c);
      const cat = (c.app_category || '').toLowerCase();
      _add(byCat, (cat && cat !== 'all') ? cat : '*', c.id);     // '*' = 空/all 品类匹配任意上下文
      const geo = (c.geo_country || '').toUpperCase();
      _add(byGeo, geo || '*', c.id);                             // '*' = 不限国家匹配任意请求
    }
    const pol = new Map(), spend = new Map(), perf = new Map(), del = new Map(), cv = new Map(), gm = new Map();
    for (const c of rows) {
      try { pol.set(c.id, await brandSafety.policy(c.id)); } catch (e) { pol.set(c.id, null); }
      try { spend.set(c.id, Number(c.daily_cap_micros) > 0 ? await todaySpend(c.id) : 0); } catch (e) { spend.set(c.id, 0); }
      try { perf.set(c.id, await perfFactor(c.id)); } catch (e) { perf.set(c.id, 1); }
      try { gm.set(c.id, await goalMultiplier(c)); } catch (e) { gm.set(c.id, 1); }
      // 节奏配置走 pacing.delivery（内部 30s 缓存 + 归一化），直接复用避免热路径再查库
      try { del.set(c.id, await pacing.delivery(c.id)); } catch (e) { del.set(c.id, null); }
      if (c.creative_id) {
        try {
          const [[x]] = await pool.query(
            "SELECT id,title,type,content,media_url,landing_url,width,height,format FROM creatives WHERE id=? AND campaign_id=? AND status='active' AND (review_status IS NULL OR review_status='approved')",
            [c.creative_id, c.id]).catch(() => [[]]);
          cv.set(c.id, x || null);
        } catch (e) { cv.set(c.id, null); }
      }
    }
    _snap = { byId, byCat, byGeo, pol, spend, perf, del, cv, gm, ts: Date.now(), ok: true };
  } catch (e) { console.error('[campaignStore] refresh failed:', e.message); }
}

// 倒排索引取候选：品类命中 ∩ 国家命中（空/all 入 '*' 桶，匹配任意）
function getCandidates(ctxCat, ctxCountry) {
  const cat = (ctxCat || '').toLowerCase();
  const geo = (ctxCountry || '').toUpperCase();
  const catSet = new Set([...(_snap.byCat.get(cat) || []), ...(_snap.byCat.get('*') || [])]);
  const geoSet = new Set([...(_snap.byGeo.get(geo) || []), ...(_snap.byGeo.get('*') || [])]);
  const out = [];
  for (const id of catSet) if (geoSet.has(id)) { const c = _snap.byId.get(id); if (c) out.push(c); }
  return out;
}

const policyOf = (id) => _snap.pol.get(id);
const spendOf = (id) => _snap.spend.get(id) || 0;
const perfOf = (id) => _snap.perf.get(id);
const goalMultOf = (id) => _snap.gm.get(id) || 1;
const deliveryOf = (id) => _snap.del.get(id);
const creativeOf = (id) => _snap.cv.get(id);
const ready = () => _snap.ok;
const snapshot = () => _snap;

function start(opts) {
  _opts = opts;
  refresh().catch(() => {});                                  // 首刷不阻塞启动，~1s 内填充
  const ms = Number(process.env.CAMPAIGN_SNAPSHOT_MS || 3000);
  _timer = setInterval(() => refresh().catch(() => {}), ms);
}
function stop() { if (_timer) clearInterval(_timer); _timer = null; }

module.exports = { start, stop, refresh, getCandidates, policyOf, spendOf, perfOf, goalMultOf, deliveryOf, creativeOf, ready, snapshot, MIN_RELEVANCE };
