// brand_safety.js —— 品牌安全：IAB 内容分类 + GARM 分级 + pre-bid 屏蔽 + 第三方验证
//
// 现状：我们只有"品类字符串隔离"（server.js:593），这既不是 taxonomy 也没有分级——
// 广告主无法表达"我不要出现在暴力/政治内容旁边"，结果就是品牌广告主一单都进不来。
//
// 补齐：
//   ① IAB Content Taxonomy：把上下文归类到标准 IAB 类目（买方 bcat 屏蔽才能对得上）
//   ② GARM 分级：Brand Safety Floor（绝对禁投，Tier 0）+ Suitability Tier 1~4（可容忍度）
//   ③ pre-bid 屏蔽：OpenRTB bcat / badv / bapp / bseat，以及自有黑名单
//   ④ 第三方验证：IAS / DoubleVerify / Moat 的 OMID AdVerifications 注入（VAST）
//
// 说明：真正的"内容扫描"需要 NLP/视觉模型；这里先把"策略层 + taxonomy + 拦截链路"做实，
// 分类来源可插拔（publisher 声明 > 爬取关键词 > 广告主自报），后续接模型即可无缝替换。

// ───────── IAB Content Taxonomy（2.0 顶层，节选高频类目）─────────
const IAB_TAXONOMY = {
  IAB1: 'Arts & Entertainment', IAB2: 'Automotive', IAB3: 'Business', IAB4: 'Careers',
  IAB5: 'Education', IAB6: 'Family & Parenting', IAB7: 'Health & Fitness', IAB8: 'Food & Drink',
  IAB9: 'Hobbies & Interests', IAB10: 'Home & Garden', IAB11: 'Law, Gov&apos;t & Politics',
  IAB12: 'News', IAB13: 'Personal Finance', IAB14: 'Society', IAB15: 'Science',
  IAB16: 'Pets', IAB17: 'Sports', IAB18: 'Style & Fashion', IAB19: 'Technology & Computing',
  IAB20: 'Travel', IAB21: 'Video Gaming', IAB22: 'Shopping', IAB23: 'Religion & Spirituality',
  IAB24: 'Uncategorized', IAB25: 'Non-Standard Content', IAB26: 'Illegal Content',
};

// ───────── GARM：Floor（零容忍，任何品牌都不该出现）+ Suitability Tier 1~4 ──────────
const GARM_FLOOR = [
  'adult', 'arms', 'crime', 'death_injury', 'online_piracy', 'hate_speech',
  'terrorism', 'spam_harmful', 'drugs', 'military_conflict', 'obscenity', 'fake_news',
];
// Tier 1 最安全（家庭向内容）→ Tier 4 高风险；广告主配置 garm_max_tier 决定可投上限
const GARM_TIER = {
  1: ['family', 'education', 'food', 'pets', 'home', 'travel', 'hobbies', 'sports'],
  2: ['news_general', 'business', 'finance', 'technology', 'style', 'automotive', 'health', 'science'],
  3: ['politics', 'news_politics', 'religion', 'gaming_violent', 'dating', 'alcohol', 'gambling'],
  4: ['user_generated', 'unmoderated', 'controversial', 'sensitive_social'],
};

// 关键词 → 分类的启发式映射（生产应换成内容分类模型；这里保证链路可用且可解释）
const KEYWORD_MAP = [
  { cat: 'IAB12', garm: 2, keys: ['news', '新闻', '资讯', 'daily'] },
  { cat: 'IAB11', garm: 3, keys: ['politics', '政治', 'government', '选举'] },
  { cat: 'IAB17', garm: 1, keys: ['sports', '体育', 'nba', 'football', 'soccer'] },
  { cat: 'IAB21', garm: 2, keys: ['game', '游戏', 'gaming', 'puzzle', 'esports'] },
  { cat: 'IAB19', garm: 2, keys: ['tech', '科技', 'software', 'ai', 'developer'] },
  { cat: 'IAB8', garm: 1, keys: ['food', '美食', 'recipe', 'cooking'] },
  { cat: 'IAB7', garm: 2, keys: ['health', '健康', 'fitness', 'medical'] },
  { cat: 'IAB13', garm: 2, keys: ['finance', '金融', 'invest', 'crypto', 'stock'] },
  { cat: 'IAB18', garm: 2, keys: ['fashion', '时尚', 'beauty', 'style'] },
  { cat: 'IAB20', garm: 1, keys: ['travel', '旅游', 'hotel', 'flight'] },
  { cat: 'IAB5', garm: 1, keys: ['education', '教育', 'learn', 'course'] },
  { cat: 'IAB3', garm: 2, keys: ['business', '商业', 'b2b', 'saas'] },
  { cat: 'IAB9', garm: 1, keys: ['hobby', '兴趣', 'diy', 'craft'] },
];
// Floor 命中词：命中即禁投（零容忍）
const FLOOR_KEYWORDS = [
  { key: 'adult', keys: ['porn', 'xxx', '成人', '色情'] },
  { key: 'drugs', keys: ['drug', 'cannabis', '毒品'] },
  { key: 'crime', keys: ['crime', 'murder', '犯罪', '凶杀'] },
  { key: 'terrorism', keys: ['terror', '恐怖'] },
  { key: 'hate_speech', keys: ['hate', '仇恨', 'racist'] },
  { key: 'military_conflict', keys: ['war', '战争', 'conflict', 'military'] },
  { key: 'death_injury', keys: ['accident', 'death', '死亡', '事故'] },
  { key: 'online_piracy', keys: ['piracy', 'torrent', '盗版'] },
  { key: 'gambling', keys: ['casino', 'bet', 'gambling', '赌博'] },
];

let pool = null;
function attachPool(p) { pool = p; }
async function initTables() {
  if (!pool) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS brand_safety_policy (
    campaign_id INT PRIMARY KEY, garm_max_tier INT DEFAULT 2, floor_strict TINYINT DEFAULT 1,
    bcat TEXT, badv TEXT, bapp TEXT, blocklist TEXT, allowlist TEXT, vendors TEXT,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP)`).catch(() => {});
  await pool.query(`CREATE TABLE IF NOT EXISTS brand_safety_event (
    id BIGINT AUTO_INCREMENT PRIMARY KEY, campaign_id INT DEFAULT 0, publisher VARCHAR(128),
    reason VARCHAR(64), iab_cat VARCHAR(16), garm_tier INT DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`).catch(() => {});
}
function safeJson(s) { try { return JSON.parse(s); } catch (e) { return null; } }

const DEFAULT_POLICY = { garmMaxTier: 2, floorStrict: true, bcat: [], badv: [], bapp: [], blocklist: [], allowlist: [], vendors: [] };
const policyCache = new Map();
const POLICY_TTL = 60 * 1000;

async function policy(cid) {
  const now = Date.now();
  const c = policyCache.get(cid);
  if (c && now - c.ts < POLICY_TTL) return c.p;
  let p = { ...DEFAULT_POLICY };
  if (pool) {
    try {
      const [[r]] = await pool.query('SELECT * FROM brand_safety_policy WHERE campaign_id=?', [cid]);
      if (r) {
        p = {
          garmMaxTier: Number(r.garm_max_tier) || 2, floorStrict: Number(r.floor_strict) !== 0,
          bcat: safeJson(r.bcat) || [], badv: safeJson(r.badv) || [], bapp: safeJson(r.bapp) || [],
          blocklist: safeJson(r.blocklist) || [], allowlist: safeJson(r.allowlist) || [],
          vendors: safeJson(r.vendors) || [],
        };
      }
    } catch (e) {}
  }
  policyCache.set(cid, { ts: now, p });
  return p;
}
async function savePolicy(cid, patch = {}) {
  const cur = await policy(cid);
  const next = {
    garmMaxTier: patch.garmMaxTier != null ? Number(patch.garmMaxTier) : cur.garmMaxTier,
    floorStrict: patch.floorStrict != null ? !!patch.floorStrict : cur.floorStrict,
    bcat: patch.bcat || cur.bcat, badv: patch.badv || cur.badv, bapp: patch.bapp || cur.bapp,
    blocklist: patch.blocklist || cur.blocklist, allowlist: patch.allowlist || cur.allowlist,
    vendors: patch.vendors || cur.vendors,
  };
  if (pool) {
    await pool.query(`INSERT INTO brand_safety_policy (campaign_id,garm_max_tier,floor_strict,bcat,badv,bapp,blocklist,allowlist,vendors)
      VALUES (?,?,?,?,?,?,?,?,?)
      ON DUPLICATE KEY UPDATE garm_max_tier=VALUES(garm_max_tier), floor_strict=VALUES(floor_strict),
        bcat=VALUES(bcat), badv=VALUES(badv), bapp=VALUES(bapp), blocklist=VALUES(blocklist),
        allowlist=VALUES(allowlist), vendors=VALUES(vendors)`,
      [cid, next.garmMaxTier, next.floorStrict ? 1 : 0, JSON.stringify(next.bcat), JSON.stringify(next.badv),
        JSON.stringify(next.bapp), JSON.stringify(next.blocklist), JSON.stringify(next.allowlist), JSON.stringify(next.vendors)]);
  }
  policyCache.delete(cid);
  return next;
}
function bust(cid) { policyCache.delete(cid); }

// ───────── 分类 ─────────
// 关键词命中：拉丁词整词匹配（词边界，避免 'rewarded' 误中 'war'），CJK/含空格短语用子串（已足够具体）
function kwHit(hay, key) {
  key = String(key || '').trim().toLowerCase();
  if (!key) return false;
  if (/^[a-z0-9_]+$/i.test(key)) {
    try { return new RegExp('\\b' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i').test(hay); }
    catch (e) { return hay.includes(key); }
  }
  return hay.includes(key);
}
function classify(ctx = {}) {
  const hay = [
    ctx.app_category, ctx.cat, ctx.keywords && ctx.keywords.join(' '),
    ctx.domain, ctx.bundle, ctx.title, ctx.description,
  ].filter(Boolean).join(' ').toLowerCase();
  // Floor：命中零容忍词直接判 Tier 0
  for (const f of FLOOR_KEYWORDS) {
    if (f.keys.some(k => kwHit(hay, k))) return { iab: ['IAB25'], garmTier: 0, floorHit: f.key, reason: 'GARM_FLOOR' };
  }
  for (const m of KEYWORD_MAP) {
    if (m.keys.some(k => kwHit(hay, k))) return { iab: [m.cat], garmTier: m.garm, label: IAB_TAXONOMY[m.cat] || '' };
  }
  // 未知内容按"未分类"处理：默认给 Tier 3（保守），避免把未知当安全
  return { iab: ['IAB24'], garmTier: 3, label: 'Uncategorized', unknown: true };
}

// ───────── pre-bid 判定 ─────────
/**
 * @param {object} br  OpenRTB 请求（用于取 bcat/badv/bapp 与上下文）
 * @param {object} p   广告主策略
 * @param {object} ctx {publisher, domain, bundle, app_category, keywords, cat}
 */
function preBid(br = {}, p = DEFAULT_POLICY, ctx = {}) {
  const reasons = [];
  const cls = classify(ctx);
  if (cls.garmTier === 0 && p.floorStrict) reasons.push({ code: 'GARM_FLOOR', detail: cls.floorHit });
  // 仅对"已知"内容做 tier 拦截：未知/未分类不能因为无法判定就全挡，否则绝大多数没打标签的流量会空跑。
  // 零容忍 Floor 仍始终生效（上面 GARM_FLOOR）；品牌主若只投安全内容可用 allowlist 兜底。
  if (!cls.unknown && cls.garmTier > 0 && cls.garmTier > Number(p.garmMaxTier || 4)) reasons.push({ code: 'GARM_TIER', tier: cls.garmTier, max: p.garmMaxTier });

  // OpenRTB 买方屏蔽：bcat / badv / bapp / bseat
  const bcat = [].concat(br.bcat || p.bcat || []).map(String);
  for (const c of cls.iab) {
    const blocked = bcat.some(b => c === b || c.startsWith(b + '-') || b.startsWith(c));
    if (blocked) reasons.push({ code: 'BCAT', cat: c });
  }
  const domain = String(ctx.domain || ctx.publisher || '').toLowerCase();
  const badv = [].concat(br.badv || p.badv || []).map(s => String(s).toLowerCase());
  if (domain && badv.some(d => domain === d || domain.endsWith('.' + d))) reasons.push({ code: 'BADV', domain });
  const bundle = String(ctx.bundle || br.app && br.app.bundle || '').toLowerCase();
  const bapp = [].concat(br.bapp || p.bapp || []).map(s => String(s).toLowerCase());
  if (bundle && bapp.includes(bundle)) reasons.push({ code: 'BAPP', bundle });
  // 自有黑白名单
  const blocklist = (p.blocklist || []).map(s => String(s).toLowerCase());
  const allowlist = (p.allowlist || []).map(s => String(s).toLowerCase());
  if (domain && blocklist.some(d => domain === d || domain.endsWith('.' + d))) reasons.push({ code: 'BLOCKLIST', domain });
  if (allowlist.length && domain && !allowlist.some(d => domain === d || domain.endsWith('.' + d))) reasons.push({ code: 'NOT_IN_ALLOWLIST', domain });

  return { block: reasons.length > 0, reasons, iab: cls.iab, garmTier: cls.garmTier, label: cls.label, unknown: !!cls.unknown };
}

async function logEvent(cid, publisher, reason) {
  if (!pool || !reason) return;
  const code = typeof reason === 'string' ? reason : (reason.code || '');
  await pool.query('INSERT INTO brand_safety_event (campaign_id,publisher,reason) VALUES (?,?,?)',
    [Number(cid) || 0, String(publisher || '').slice(0, 128), String(code).slice(0, 64)]).catch(() => {});
}
async function report(limit = 100) {
  if (!pool) return [];
  const [rows] = await pool.query(
    `SELECT publisher, reason, COUNT(*) n FROM brand_safety_event GROUP BY publisher, reason ORDER BY n DESC LIMIT ?`, [Number(limit)]);
  return rows;
}

// ───────── 第三方验证（OMID AdVerifications）─────────
// 三阶段接入：
//   短期：OMID_JS 环境变量 → 自有验证脚本（public/omid_verify.js）
//   中期：IAS/DV/MOAT API Key → .env 配置对应 URL
//   长期：VAST 4.0 完整 AdVerifications 规范，多厂商并行验证
const VENDOR_PRESETS = {
  ias: { name: 'ias', vendor: 'ias', url: process.env.IAS_VERIFICATION_URL || '', params: ['campaign_id', 'pub'], trackingEvents: ['imp', 'clk', 'end', 'error'] },
  doubleverify: { name: 'doubleverify', vendor: 'doubleverify', url: process.env.DV_VERIFICATION_URL || '', params: ['campaign_id'], trackingEvents: ['imp', 'clk', 'end'] },
  moat: { name: 'moat', vendor: 'moat', url: process.env.MOAT_VERIFICATION_URL || '', params: ['campaign_id'], trackingEvents: ['imp', 'clk', 'end'] },
  omid: { name: 'omid', vendor: 'dellai-omid', url: process.env.OMID_JS || '', params: [], trackingEvents: ['imp', 'visibility', 'end'] },
};
function verificationScripts(p = DEFAULT_POLICY, impid = '') {
  const list = (p.vendors || []).map(v => VENDOR_PRESETS[String(v).toLowerCase()]).filter(Boolean).filter(v => v.url);
  if (!list.length && VENDOR_PRESETS.omid.url) return [VENDOR_PRESETS.omid];
  return list.map(v => ({ ...v, url: v.url.replace('{{impid}}', encodeURIComponent(impid)) }));
}
// VAST 4.0 注入：在 </InLine> 前插入 <AdVerifications>
// 支持多厂商并行验证 + 完整 Tracking 事件
function injectVerifications(vastXml, scripts = [], context = {}) {
  if (!vastXml || !scripts.length || String(vastXml).indexOf('<AdVerifications>') !== -1) return vastXml;
  const campaignId = context.campaign_id || context.cid || '';
  const publisher = context.publisher || context.pub || '';
  const nodes = scripts.map(s => {
    const url = s.url.replace(/\{\{impid\}\}/g, encodeURIComponent(context.impid || ''))
                     .replace(/\{\{campaign_id\}\}/g, encodeURIComponent(campaignId))
                     .replace(/\{\{pub\}\}/g, encodeURIComponent(publisher));
    const events = (s.trackingEvents || ['imp', 'end']).map(ev =>
      '<Tracking event="' + ev + '"><![CDATA[' + url + '&ev=' + ev + ']]></Tracking>'
    ).join('');
    return [
      '<Verification vendor="' + s.vendor + '">',
      '<JavaScriptResource apiFramework="omid" browserOptional="true"><![CDATA[' + url + ']]></JavaScriptResource>',
      events,
      '<Tracking event="verificationNotExecuted"><![CDATA[' + url + '&verified=0]]></Tracking>',
      '</Verification>',
    ].join('');
  }).join('');
  return String(vastXml).replace('</InLine>', '<AdVerifications>' + nodes + '</AdVerifications></InLine>');
}
// 验证就绪状态报告（供 /api/console/overview 等查询）
function verificationStatus() {
  const omid = VENDOR_PRESETS.omid;
  const ias = VENDOR_PRESETS.ias;
  const dv = VENDOR_PRESETS.doubleverify;
  const moat = VENDOR_PRESETS.moat;
  return {
    omid: { configured: !!omid.url, url: omid.url || '(not set)' },
    ias: { configured: !!ias.url, url: ias.url || '(not set)' },
    doubleverify: { configured: !!dv.url, url: dv.url || '(not set)' },
    moat: { configured: !!moat.url, url: moat.url || '(not set)' },
    ready: omid.url || ias.url || dv.url || moat.url,
    tier: ias.url || dv.url || moat.url ? 'full' : (omid.url ? 'basic' : 'none'),
  };
}

module.exports = {
  attachPool, initTables, policy, savePolicy, bust, classify, preBid, logEvent, report,
  verificationScripts, injectVerifications, verificationStatus,
  IAB_TAXONOMY, GARM_FLOOR, GARM_TIER, VENDOR_PRESETS, DEFAULT_POLICY,
};
