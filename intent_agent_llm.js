// intent_agent_llm.js —— 接真实 LLM 的意图检索 Agent（"去需求方检索意图 → 自动撮合"）
// 真实信号源（监听潜在广告主的需求意图）：
//   1) Reddit 板块搜索 JSON（开发者求量/买量帖）
//   2) Hacker News "Show HN"（创始人刚上线产品，需获客）
//   3) Apple App Store RSS（新上架 App，开发者即潜在广告主）
// 每条信号经 LLM 抽意图 → 匹配现有广告主则并单(出价上浮→eCPM更高)，否则自动建 campaign。
// 运行：先配 .env（LLM API Key），再 `npm run agent:llm`。
//       未配 Key 会自动提示改用启发式版 `npm run agent`。

const llm = require('./llm');
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8080';

// ===== 真实爬虫配置（可按需增删）=====
const REDDIT_SUBS = (process.env.REDDIT_SUBS || 'puzzlegames,androiddev,indiegames,gamedev,SideProject').split(',');
const REDDIT_QUERY = process.env.REDDIT_QUERY || 'user acquisition OR buy traffic OR looking for users OR marketing';
const HN_QUERY = process.env.HN_QUERY || 'launch';
const APPLE_COUNTRY = process.env.APPLE_COUNTRY || 'us';
const APPLE_GENRE = process.env.APPLE_GENRE || '6014'; // 6014=Games, 6007=Music, 6023=Social
const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; IntentAgent/1.0)' };

// ===== 各信号源实现（均无需登录，返回 {source,text}[]）=====
async function crawlReddit() {
  const out = [];
  for (const sub of REDDIT_SUBS) {
    const url = `https://www.reddit.com/r/${sub}/search.json?q=${encodeURIComponent(REDDIT_QUERY)}&restrict_sr=1&sort=new&limit=15&raw_json=1`;
    try {
      const r = await fetch(url, { headers: UA });
      if (!r.ok) continue;
      const j = await r.json();
      (j.data && j.data.children || []).forEach(c => {
        const d = c.data || {};
        const text = `${d.title || ''} ${d.selftext || ''}`.slice(0, 600);
        if (text.trim()) out.push({ source: `Reddit r/${sub}`, text });
      });
    } catch (e) { console.log(`  [reddit r/${sub}] 抓取失败: ${e.message}`); }
  }
  return out;
}

async function crawlHackerNews() {
  // Show HN：创始人刚上线产品，天然有获客需求
  const since = Math.floor(Date.now() / 1000) - 7 * 24 * 3600; // 近 7 天
  const url = `https://hn.algolia.com/api/v1/search_by_date?tags=show_hn&query=${encodeURIComponent(HN_QUERY)}&numericFilters=created_at_i>${since}&hitsPerPage=25`;
  try {
    const r = await fetch(url);
    if (!r.ok) return [];
    const j = await r.json();
    return (j.hits || []).map(h => ({
      source: 'HackerNews Show HN',
      text: `${h.title || ''} ${h.story_text ? h.story_text.replace(/<[^>]*>/g, ' ').slice(0, 400) : ''}`,
    })).filter(x => x.text.trim());
  } catch (e) { console.log(`  [HN Show HN] 抓取失败: ${e.message}`); return []; }
}

async function crawlAppleStore() {
  // 新上架 App：开发者即潜在广告主（要装机/买量）
  const url = `https://itunes.apple.com/${APPLE_COUNTRY}/rss/topfreeapplications/genre=${APPLE_GENRE}/limit=25/json`;
  try {
    const r = await fetch(url);
    if (!r.ok) return [];
    const j = await r.json();
    const entries = (j.feed && j.feed.entry) || [];
    return entries.map(e => {
      const name = (e['im:name'] && e['im:name'].label) || '';
      const summary = (e.summary && e.summary.label) || '';
      const cat = (e.category && e.category.attributes && e.category.attributes.label) || '';
      return { source: `Apple AppStore(${cat})`, text: `新上架App: ${name}。类目:${cat}。简介:${summary}`.slice(0, 500) };
    });
  } catch (e) { console.log(`  [Apple Store] 抓取失败: ${e.message}`); return []; }
}

const SOURCES = [
  { name: 'Reddit', fn: crawlReddit },
  { name: 'HackerNews', fn: crawlHackerNews },
  { name: 'AppleStore', fn: crawlAppleStore },
];

// 兜底演示信号（全部爬虫失败且无网络时用，保证可演示）
const FALLBACK = [
  { source: 'Reddit r/puzzlegames', text: '我们刚上线一款益智解谜游戏 PuzzleMaster，正在北美找休闲用户量，预算充足想买量' },
  { source: '淘宝卖家社群', text: '北美站 9 月大促，求性价比电商流量，受众是价格敏感的家庭用户' },
  { source: '独立工具开发者论坛', text: '我做了一款清理加速 utility app，想在东南亚买装机量' },
];

async function getCampaigns() {
  const r = await fetch(`${BASE}/api/campaigns`);
  return r.json();
}

async function extractSignal(text) {
  const sys = '你是广告需求意图抽取器，只输出 JSON，不要解释。';
  const user = `从下面"需求方原话"抽取投放意图，返回 JSON: {"tags":["意图标签"],"category":"类目slug","audience":"目标人群","geo":["US"],"summary":"一句话概括","keywords":["扩展关键词"],"budget_hint":"高/中/低"}
文本: ${text}`;
  return llm.chat(sys, user, true);
}

async function autoCouple(signal) {
  const intent = await extractSignal(signal.text);
  if (!intent) { console.log(`  (LLM 未返回意图，跳过该信号)`); return; }
  const camps = await getCampaigns();
  let best = null;
  for (const c of camps) {
    const prof = c.intent_tags ? { tags: c.intent_tags.split(',').map(s => s.trim()).filter(Boolean) } : null;
    const rel = await llm.scoreRelevance(prof, {
      app_category: intent.category, country: (intent.geo || [])[0] || '', keywords: intent.keywords || [],
    });
    if (!best || rel.score > best.score) best = { c, rel };
  }
  console.log(`\n[信号] ${signal.source}`);
  console.log(`  原文: ${signal.text.slice(0, 120)}`);
  console.log(`  LLM抽取意图: ${intent.summary} | tags=${intent.tags} | geo=${intent.geo} | 预算=${intent.budget_hint}`);
  if (best && best.rel.score >= 0.5) {
    console.log(`  → 撮合到现有广告主 #${best.c.id} ${best.c.name} (相关度 ${(best.rel.score * 100).toFixed(0)}%，${best.rel.reason})`);
    console.log(`  → 已将该需求方意图并入其 intent_tags，bidder 对此库存出价上浮 → 对应 eCPM 更高`);
    const merged = [...new Set([...(c.intent_tags ? c.intent_tags.split(',') : []), ...intent.tags])].join(',');
    await fetch(`${BASE}/api/campaign/${best.c.id}/tags`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ intent_tags: merged }),
    }).catch(() => {});
  } else {
    console.log(`  → 无现成匹配，自动建新 campaign（接真实流量后可提升填充与 eCPM）`);
    const r = await fetch(`${BASE}/api/campaign`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: `LLM自动建单-${intent.summary.slice(0, 14)}`,
        advertiser: signal.source,
        budget_cny: intent.budget_hint === '高' ? 5000 : intent.budget_hint === '中' ? 2000 : 1000,
        country: (intent.geo || [])[0] || '',
        app_category: intent.category || '',
        creative_html: `<div style="padding:10px;background:#16a085;color:#fff;border-radius:6px">${intent.summary}</div>`,
        landing_url: 'https://example.com',
        target_cpm_cny: 6,
        intent_tags: intent.tags.join(','),
      }),
    });
    const j = await r.json();
    console.log(`  → 已自动建 campaign id=${j.id}`);
  }
}

// ===== 供给侧：合规爬虫（仅抓媒体方"自己声明"的 site_url + 应用商店招募线索）=====
const crawlDelay = (ms) => new Promise(r => setTimeout(r, ms));
async function enrichPublishers() {
  if (!llm.ENABLED) { console.log('\n[供给] 未配置 LLM，跳过 site_url 爬取（可用 /api/publisher/:domain/crawl 手动触发）'); return; }
  let list = [];
  try { const r = await fetch(`${BASE}/api/publishers`); list = await r.json(); } catch { return; }
  const ttl = (Number(process.env.CRAWL_TTL_H) || 24) * 3600 * 1000; // 冷却：同一媒体方 24h 内只爬一次
  for (const p of list) {
    if (!p.site_url) continue;
    if (p.last_crawl && Date.now() - p.last_crawl < ttl) { console.log(`  [供给] ${p.domain} 冷却中，跳过`); continue; }
    console.log(`  [供给] 合规爬取 ${p.domain} ← ${p.site_url}`);
    await fetch(`${BASE}/api/publisher/${encodeURIComponent(p.domain)}/crawl`, { method: 'POST' })
      .then(r => r.json()).then(d => console.log(`     → cat=${d.cat} geo=${JSON.stringify(d.geo)} kw=${d.keywords} (${(d.summary || '').slice(0, 40)})`))
      .catch(e => console.log('     失败', e.message));
    await crawlDelay(Number(process.env.CRAWL_MIN_INTERVAL_MS) || 1500); // 限流，防封
  }
}
async function supplyLeads() {
  const url = `https://itunes.apple.com/${APPLE_COUNTRY}/rss/topfreeapplications/genre=${APPLE_GENRE}/limit=20/json`;
  try {
    const r = await fetch(url); if (!r.ok) return;
    const j = await r.json(); const entries = (j.feed && j.feed.entry) || [];
    console.log(`\n[供给招募线索] 扫描 App Store 新 App ${entries.length} 个，潜在可招募媒体方（发"免费变现诊断"引流）：`);
    entries.slice(0, 6).forEach(e => {
      const name = (e['im:name'] && e['im:name'].label) || '';
      const cat = (e.category && e.category.attributes && e.category.attributes.label) || '';
      console.log(`  · ${name}（${cat}）`);
    });
  } catch (e) { console.log('[供给招募] 扫描失败', e.message); }
}

(async () => {
  if (!llm.ENABLED) {
    console.log('未配置 LLM API Key（或 LLM_PROVIDER）。\n请复制 .env.example 为 .env 并填入 Key；\n或先跑启发式版：npm run agent');
    process.exit(0);
  }
  console.log(`[意图Agent-LLM] 使用 ${llm.PROVIDER.keyEnv} / ${llm.MODEL}，开始真实检索需求方意图...\n`);
  let signals = [];
  for (const s of SOURCES) {
    const got = await s.fn();
    console.log(`[源] ${s.name}: 抓到 ${got.length} 条信号`);
    signals = signals.concat(got);
  }
  if (!signals.length) { console.log('全部爬虫无收获，改用兜底演示信号。'); signals = FALLBACK; }
  console.log(`共 ${signals.length} 条需求方信号，开始 LLM 撮合...\n`);
  for (const sig of signals) await autoCouple(sig);
  // ——— 供给侧：合规爬取已入驻媒体方的 site_url 补全供给标签 + 应用商店招募线索 ———
  console.log('\n=== 供给侧：合规爬虫阶段 ===');
  await enrichPublishers();
  await supplyLeads();
  console.log('\n[意图Agent-LLM] 完成。可在 /campaigns.html 查看自动建/并的 campaign；媒体方供给标签已补全→其库存被意图匹配时 eCPM 更高。');
})();
