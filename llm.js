// llm.js —— 意图 Agent 真实 LLM 接入层（OpenAI 兼容协议）
// 支持 通义千问(DashScope) / OpenAI / DeepSeek / 商汤 Sensenova，通过环境变量切换；
// 未配置 API Key 时自动回落到本地启发式，保证原型在没有 Key 时也能跑。
// 不依赖 dotenv：自带极简 .env 解析，免去额外安装。
const fs = require('fs');
const path = require('path');

// 极简 .env 加载（免装 dotenv）
try {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
      const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    });
  }
} catch (e) {}

const PROVIDERS = {
  dashscope: { baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', keyEnv: 'DASHSCOPE_API_KEY' },
  openai:    { baseURL: 'https://api.openai.com/v1', model: 'gpt-4o-mini', keyEnv: 'OPENAI_API_KEY' },
  deepseek:  { baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-chat', keyEnv: 'DEEPSEEK_API_KEY' },
  sensenova: { baseURL: 'https://token.sensenova.cn/v1', model: 'sensenova-6.8-flash-lite', keyEnv: 'SENSENOVA_API_KEY' },
};

const cfg = PROVIDERS[process.env.LLM_PROVIDER || 'dashscope'] || PROVIDERS.dashscope;
const API_KEY = process.env[cfg.keyEnv] || '';
const MODEL = process.env.LLM_MODEL || cfg.model;
const ENABLED = !!API_KEY;                                   // 是否真接了 LLM
const LIVE_MATCH = ENABLED && process.env.LLM_LIVE_MATCH !== '0'; // 竞价热路径是否用 LLM 评分

async function chat(system, user, jsonMode = true) {
  if (!API_KEY) return null;
  const body = {
    model: MODEL,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    temperature: 0.2,
  };
  if (jsonMode) body.response_format = { type: 'json_object' };
  const r = await fetch(`${cfg.baseURL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`LLM ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  const content = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
  if (!jsonMode) return content;
  return parseJsonRobust(content);
}

// 容错解析：去 ```json 围栏、截取首尾 {} 之间的内容，避免 Sensenova 在 JSON 前后夹带说明文字
function parseJsonRobust(text) {
  if (!text) return null;
  let s = String(text).trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const a = s.indexOf('{'); const b = s.lastIndexOf('}');
  if (a >= 0 && b > a) s = s.slice(a, b + 1);
  try { return JSON.parse(s); } catch (e) { return null; }
}

function stripHtml(s) {
  return String(s || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500);
}

// 从广告主 campaign 抽取意图画像（真实 LLM）
async function extractDemandIntent(campaign) {
  const sys = '你是程序化广告平台的意图理解专家，只输出 JSON，不要任何解释文字。';
  const user = `分析以下广告主投放信息，抽取其真实购买意图画像，必须返回 JSON：
{"tags":["意图标签/关键词"],"category":"APP品类或商品类目(英文slug)","audience":"目标人群一句话","geo":["国家代码如US,CN"],"summary":"一句话意图概括","keywords":["扩展关键词"]}
Campaign:
名称: ${campaign.name}
广告主: ${campaign.advertiser || ''}
素材: ${stripHtml(campaign.creative_html)}
落地页: ${campaign.landing_url || ''}
品类: ${campaign.app_category || ''}
地区: ${campaign.country || ''}`;
  const r = await chat(sys, user, true);
  if (!r) return null;
  const tags = [...new Set([...(r.tags || []), ...(r.keywords || [])].map(String))].filter(Boolean);
  return {
    profile: { tags, category: r.category || '', audience: r.audience || '', geo: r.geo || [], summary: r.summary || '' },
    tags,
  };
}

// 从媒体方落地页文本抽取供给画像（合规 supply crawler：仅抓对方声明的 site_url）
async function extractSupplyTags(text) {
  const sys = '你是广告供给端(媒体方)理解专家，只输出 JSON，不要解释。';
  const user = `分析以下媒体方落地页文本，抽取其流量/受众画像，返回 JSON:
{"category":"APP或内容品类(英文slug)","geo":["国家代码如US,CN"],"keywords":["受众/内容关键词"],"tags":["意图标签"],"summary":"一句话受众概括"}
文本: ${String(text || '').slice(0, 2000)}`;
  const r = await chat(sys, user, true);
  if (!r) return null;
  return {
    category: r.category || '', geo: r.geo || [], keywords: r.keywords || [],
    tags: r.tags || [], summary: r.summary || '',
  };
}

// 启发式回落（无 LLM 或解析失败时）
function heuristicRelevance(tags, ctx) {
  if (!tags || !tags.length) return { score: 0, reason: '无意图标签' };
  const hay = [ctx.app_category, ctx.country, ...(ctx.keywords || [])].map(s => String(s || '').toLowerCase());
  let hit = 0;
  tags.forEach(t => { if (hay.some(h => h && (h.includes(t) || t.includes(h)))) hit++; });
  return { score: hit / tags.length, reason: '关键词重合(启发式)' };
}

const matchCache = new Map();
function cacheKey(profile, ctx) {
  return JSON.stringify({ p: profile, c: { app_category: ctx.app_category, country: ctx.country, keywords: ctx.keywords } });
}

// 供给上下文 vs 广告主意图画像 → 相关性打分（真实 LLM，带缓存 + 启发式回落）
async function scoreRelevance(profile, ctx) {
  if (!ENABLED || !profile) return heuristicRelevance(profile ? profile.tags : [], ctx);
  const key = cacheKey(profile, ctx);
  if (matchCache.has(key)) return matchCache.get(key);
  const sys = '你是广告撮合相关性打分器，只输出 JSON，不要解释。';
  const user = `判断"供给上下文"与"广告主意图画像"的相关性，返回 JSON: {"score":0到1,"reason":"简短中文理由"}。越相关 score 越接近 1。
广告主意图画像: ${JSON.stringify(profile)}
供给上下文: ${JSON.stringify({ app_category: ctx.app_category, country: ctx.country, keywords: ctx.keywords })}`;
  try {
    const r = await chat(sys, user, true);
    if (r && typeof r.score === 'number') {
      const out = { score: Math.max(0, Math.min(1, r.score)), reason: r.reason || 'LLM匹配', llm: true };
      if (matchCache.size > 5000) matchCache.clear();
      matchCache.set(key, out);
      return out;
    }
  } catch (e) { console.error('[llm] match err', e.message); }
  return heuristicRelevance(profile.tags, ctx);
}

module.exports = { ENABLED, LIVE_MATCH, PROVIDER: cfg, MODEL, extractDemandIntent, extractSupplyTags, scoreRelevance, heuristicRelevance, chat };
