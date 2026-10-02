// creative/dco.js —— DCO 动态创意优化：元素级组合 + 规则定向 + 自动优选
//
// 与 A/B 的区别：A/B 是"人做几个整版，系统选哪个版好"；DCO 是"系统自己组合出几百个版"。
// 一个广告 = 标题 × 主图 × CTA × 背景 × 徽章，5×4×3×3=180 种组合，人工做不出来。
// 有了 DCO，"静图转视频、多语言、多尺寸"这些批量素材需求就都能复用同一套组合引擎。
//
// 流程：template(slots) × feed(商品/内容) × rules(定向规则) → 候选组合 → bandit 选版 → 渲染

const ecpm = require('../ecpm_engine'); // 复用 Thompson（无上下文时）/ 也可换 ml/bandit（有上下文）

let pool = null;
function attachPool(p) { pool = p; }
async function initTables() {
  if (!pool) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS dco_template (
    id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(128), campaign_id INT DEFAULT 0,
    slots TEXT, base_html TEXT, status VARCHAR(16) DEFAULT 'active',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`).catch(() => {});
  await pool.query(`CREATE TABLE IF NOT EXISTS dco_feed (
    id INT AUTO_INCREMENT PRIMARY KEY, campaign_id INT DEFAULT 0, item_id VARCHAR(64),
    title VARCHAR(200), image_url VARCHAR(400), target_url VARCHAR(400), price_micros BIGINT DEFAULT 0,
    tags VARCHAR(128) DEFAULT '', lang VARCHAR(8) DEFAULT '', status VARCHAR(16) DEFAULT 'active',
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP)`).catch(() => {});
  await pool.query(`CREATE TABLE IF NOT EXISTS dco_combo_stat (
    combo_key VARCHAR(160) PRIMARY KEY, impressions INT DEFAULT 0, clicks INT DEFAULT 0,
    conversions INT DEFAULT 0, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP)`).catch(() => {});
}
function safeJson(s) { try { return JSON.parse(s); } catch (e) { return null; } }
function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const DEFAULT_TEMPLATE = {
  slots: {
    headline: { variants: ['{{title}}'], required: true },
    image: { variants: ['{{image}}'], required: true },
    cta: { variants: ['立即下载', '免费试玩', '了解更多'], required: true },
    background: { variants: ['#ffffff', '#0f172a', '#f8fafc'], required: false },
    badge: { variants: ['', '限时优惠', '热门推荐'], required: false },
  },
  layout: 'card',
};

/**
 * 生成候选组合（笛卡尔积，带上限保护）
 * @param {object} template {slots:{slotName:{variants:[]}}}
 * @param {object} item   feed 条目（用于 {{title}} 等占位符）
 */
function combinations(template = DEFAULT_TEMPLATE, item = {}, max = 200) {
  const slots = (template && template.slots) || DEFAULT_TEMPLATE.slots;
  const keys = Object.keys(slots);
  let combos = [{}];
  for (const k of keys) {
    const vs = (slots[k].variants || []).map(v => fill(String(v), item));
    if (!vs.length) continue;
    const next = [];
    for (const c of combos) for (const v of vs) next.push(Object.assign({}, c, { [k]: v }));
    combos = next;
    if (combos.length > max) combos = combos.slice(0, max);
  }
  return combos;
}
function fill(s, item = {}) {
  return s.replace(/\{\{(\w+)\}\}/g, (_, k) => (item[k] != null ? item[k] : ''));
}
function comboKey(cid, itemId, combo) {
  return [cid, itemId || '0', Object.keys(combo).sort().map(k => k + ':' + combo[k]).join('|')].join('#').slice(0, 160);
}

// 定向规则：不同人群看到不同元素（这是 DCO 相对静态素材的核心增量）
function filterByRules(combos, ctx = {}, rules = []) {
  if (!rules.length) return combos;
  let allowed = null;
  for (const r of rules) {
    const geoOk = !r.geo || !r.geo.length || r.geo.includes(String(ctx.geo || '').toUpperCase());
    const devOk = !r.device || r.device === ctx.deviceType || (r.device === 'mobile' && ctx.deviceType === 1);
    const hourOk = !r.hours || !r.hours.length || r.hours.includes(Number(ctx.hour));
    const langOk = !r.lang || !r.lang.length || r.lang.includes(String(ctx.lang || '').toLowerCase());
    if (geoOk && devOk && hourOk && langOk) {
      // 规则里声明"该 slot 只能用这些取值"
      for (const slot in (r.allow || {})) {
        const set = new Set(r.allow[slot]);
        combos = combos.filter(c => !c[slot] || set.has(c[slot]));
      }
      allowed = combos;
    }
  }
  return allowed || combos;
}

function render(template = DEFAULT_TEMPLATE, combo = {}, item = {}, opts = {}) {
  const bg = combo.background || '#ffffff';
  const dark = /^#(0|1|2|3)/.test(bg);
  const fg = dark ? '#f8fafc' : '#0f172a';
  const img = combo.image || (item && item.image_url) || '';
  const click = opts.clickUrl || (item && item.target_url) || '#';
  const price = item && item.price_micros ? (Number(item.price_micros) / 1e6).toFixed(2) : '';
  return [
    '<div style="font-family:system-ui,-apple-system,sans-serif;background:' + esc(bg) + ';color:' + fg + ';border-radius:12px;overflow:hidden;max-width:360px">',
    img ? '<img src="' + esc(img) + '" style="width:100%;display:block;max-height:200px;object-fit:cover" alt="">' : '',
    combo.badge ? '<div style="position:absolute;margin:8px;background:#ef4444;color:#fff;font-size:11px;padding:3px 8px;border-radius:999px">' + esc(combo.badge) + '</div>' : '',
    '<div style="padding:12px">',
    '<div style="font-size:15px;font-weight:700;line-height:1.35">' + esc(combo.headline || (item && item.title) || '') + '</div>',
    price ? '<div style="margin-top:6px;font-size:16px;color:#ef4444;font-weight:700">¥' + esc(price) + '</div>' : '',
    '<a href="' + esc(click) + '" target="_blank" rel="nofollow" style="display:block;margin-top:12px;text-align:center;background:#2563eb;color:#fff;text-decoration:none;padding:10px;border-radius:8px;font-size:14px;font-weight:600">' + esc(combo.cta || '立即下载') + '</a>',
    '</div></div>',
  ].join('');
}

// 选版：优先用统计后验（Thompson），无数据时均匀探索
async function pick(template, item, ctx = {}, stats = []) {
  const combos = filterByRules(combinations(template, item), ctx, (template && template.rules) || []);
  if (!combos.length) return null;
  const map = new Map(stats.map(s => [s.combo_key, s]));
  const scored = combos.map(c => {
    const k = comboKey((template && template.campaign_id) || 0, item && item.item_id, c);
    const st = map.get(k) || { impressions: 0, clicks: 0, conversions: 0 };
    return {
      combo: c, combo_key: k,
      successes: Number(st.clicks || 0) + Number(st.conversions || 0) * 3, // 转化权重更高
      failures: Math.max(0, Number(st.impressions || 0) - Number(st.clicks || 0)),
    };
  });
  const chosen = ecpm.thompsonPick(scored);
  return { ...chosen, html: render(template, chosen.combo, item) };
}

async function bump(comboKeyName, field) {
  if (!pool || !comboKeyName) return;
  const col = ['impressions', 'clicks', 'conversions'].includes(field) ? field : null;
  if (!col) return;
  await pool.query(`INSERT INTO dco_combo_stat (combo_key,${col}) VALUES (?,1)
    ON DUPLICATE KEY UPDATE ${col}=${col}+1`, [comboKeyName]).catch(() => {});
}
async function topCombos(campaignId, limit = 20) {
  if (!pool) return [];
  const [rows] = await pool.query(
    `SELECT combo_key, impressions, clicks, conversions FROM dco_combo_stat
     WHERE combo_key LIKE ? ORDER BY (clicks+conversions*3) DESC LIMIT ?`, [String(campaignId) + '#%', Number(limit)]);
  return rows;
}

module.exports = {
  attachPool, initTables, DEFAULT_TEMPLATE,
  combinations, combination: combinations, filterByRules, fill, render, pick, bump, topCombos, comboKey, esc,
};
