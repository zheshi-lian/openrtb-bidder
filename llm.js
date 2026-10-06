// llm.js —— 意图 Agent 真实 LLM 接入层（OpenAI 兼容协议）
// 支持 通义千问(DashScope) / OpenAI / DeepSeek / 商汤 Sensenova，通过环境变量切换；
// 未配置 API Key 时自动回落到本地启发式，保证原型在没有 Key 时也能跑。
// 不依赖 dotenv：自带极简 .env 解析，免去额外安装。
const fs = require('fs');
const path = require('path');

// 极简 .env 加载（免装 dotenv）。.env 为权威配置：显式覆盖同名 OS 环境变量，
// 便于本地/演示用 .env 锁定关键开关（如 LLM_LIVE_MATCH=0），不受遗留 OS 环境变量干扰。
try {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
      const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
      if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    });
  }
} catch (e) {}

const PROVIDERS = {
  dashscope: { baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', keyEnv: 'DASHSCOPE_API_KEY' },
  openai:    { baseURL: 'https://api.openai.com/v1', model: 'gpt-4o-mini', keyEnv: 'OPENAI_API_KEY' },
  deepseek:  { baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-chat', keyEnv: 'DEEPSEEK_API_KEY' },
  sensenova: { baseURL: 'https://token.sensenova.cn/v1', model: 'sensenova-6.8-flash-lite', keyEnv: 'SENSENOVA_API_KEY' },
  // 自定义 OpenAI 兼容端点（任意 /v1/chat/completions 实现，如第三方代理/私有化部署）
  custom:    { baseURL: (process.env.LLM_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''), model: process.env.LLM_MODEL || 'gpt-4o-mini', keyEnv: 'LLM_API_KEY' },
};

// 主供应商：LLM_PROVIDER 指定；未指定则用 dashscope(通义千问/Qwen)
const PRIMARY = PROVIDERS[process.env.LLM_PROVIDER || 'dashscope'] || PROVIDERS.dashscope;
// 多供应商回退：主供应商额度耗尽/故障时，自动切换到其它已配置 Key 的供应商，避免单点失效
function availableProviders() {
  const list = [];
  if (process.env[PRIMARY.keyEnv]) list.push(PRIMARY);
  for (const k of Object.keys(PROVIDERS)) {
    const p = PROVIDERS[k];
    if (p !== PRIMARY && process.env[p.keyEnv]) list.push(p);
  }
  return list;
}
const PROVIDER_LIST = availableProviders();
const ENABLED = PROVIDER_LIST.length > 0;                  // 是否至少配置了一个可用 LLM
const LIVE_MATCH = ENABLED && process.env.LLM_LIVE_MATCH === '1'; // 竞价热路径是否用 LLM 评分（默认关，仅创建/演示时用 LLM，更稳更省）
const MODEL = process.env.LLM_MODEL || PRIMARY.model;
const PROVIDER = PRIMARY;
// 可选代理（绕过 Cloudflare 等 WAF 拦截）：LLM_PROXY 或 HTTPS_PROXY。无 undici 依赖时降级为直连。
let _dispatcher = null;
(function setupProxy() {
  const proxy = process.env.LLM_PROXY || process.env.HTTPS_PROXY || process.env.https_proxy || '';
  if (!proxy) return;
  try {
    const undici = require('undici');
    if (undici && undici.ProxyAgent) { _dispatcher = new undici.ProxyAgent(proxy); console.warn('[llm] 已启用代理访问:', proxy); }
  } catch (e) { console.warn('[llm] 未安装 undici，无法走代理（请 npm i undici，或改用可达端点）:', e.message); }
})();

// 每个供应商独立熔断器：连续 3 次失败熔断 60s，避免单供应商抖动拖垮竞价
const providerState = {};
function pstate(keyEnv) { return providerState[keyEnv] || (providerState[keyEnv] = { failures: 0, brokenUntil: 0 }); }

async function chat(system, user, jsonMode = true) {
  if (!ENABLED) return null;
  const candidates = PROVIDER_LIST.filter(p => Date.now() >= pstate(p.keyEnv).brokenUntil);
  if (!candidates.length) return null; // 全部熔断中：快速回落启发式，避免拖垮竞价
  let lastErr = null;
  for (const p of candidates) {
    const st = pstate(p.keyEnv);
    const model = process.env.LLM_MODEL || p.model;
    const body = {
      model,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      temperature: 0.2,
    };
    if (jsonMode) body.response_format = { type: 'json_object' };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3500);
    try {
      const r = await fetch(`${p.baseURL}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env[p.keyEnv]}` },
        body: JSON.stringify(body),
        signal: ctrl.signal,
        ...(_dispatcher ? { dispatcher: _dispatcher } : {}),
      });
      if (!r.ok) { st.failures++; if (st.failures >= 3) st.brokenUntil = Date.now() + 60000; lastErr = `LLM ${r.status} (${p.keyEnv})`; continue; }
      st.failures = 0;
      const j = await r.json();
      const content = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
      // 非 JSON（如 Cloudflare 拦截页/HTML 错误页）说明端点不可用：计入熔断，避免反复空耗竞价延迟
      if (jsonMode && /^\s*<(!doctype|html)/i.test(content)) { st.failures++; if (st.failures >= 3) st.brokenUntil = Date.now() + 60000; lastErr = 'LLM 返回非 JSON(疑似被拦截)'; continue; }
      return jsonMode ? parseJsonRobust(content) : content;
    } catch (e) {
      st.failures++; if (st.failures >= 3) st.brokenUntil = Date.now() + 60000; lastErr = e.message + ` (${p.keyEnv})`; continue;
    } finally {
      clearTimeout(timer);
    }
  }
  console.error('[llm] 所有供应商均不可用, last=', lastErr);
  return null;
}

// ===== Embedding：用于"异步缓存化"相关性（热路径不阻塞）=====
// 仅 OpenAI / DashScope 支持 embeddings；优先用它们，仍走多供应商回退与熔断。
const EMBED_SUPPORT = { openai: 'text-embedding-3-small', dashscope: 'text-embedding-v2' };
function embedProviders() { return PROVIDER_LIST.filter(p => EMBED_SUPPORT[p.keyEnv]); }
async function embed(text) {
  if (!text) return null;
  const ps = embedProviders(); if (!ps.length) return null; // 无 embedding 供应商 → 回落启发式
  for (const p of ps) {
    const st = pstate(p.keyEnv);
    if (Date.now() < st.brokenUntil) continue;
    const model = process.env.EMBED_MODEL || EMBED_SUPPORT[p.keyEnv];
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3500);
    try {
      const r = await fetch(`${p.baseURL}/embeddings`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env[p.keyEnv]}` },
        body: JSON.stringify({ model, input: String(text).slice(0, 4000) }), signal: ctrl.signal,
        ...(_dispatcher ? { dispatcher: _dispatcher } : {}),
      });
      if (!r.ok) { st.failures++; if (st.failures >= 3) st.brokenUntil = Date.now() + 60000; continue; }
      st.failures = 0;
      const j = await r.json();
      const v = j.data && j.data[0] && j.data[0].embedding;
      if (Array.isArray(v) && v.length) return v;
    } catch (e) { st.failures++; if (st.failures >= 3) st.brokenUntil = Date.now() + 60000; continue; }
    finally { clearTimeout(timer); }
  }
  return null;
}
function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return (na && nb) ? d / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
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

// ===== 出口 IP 探测（供 Cloudflare 等 WAF 加白名单；best-effort，不阻塞启动）=====
let egressIp = '';
async function detectEgressIp() {
  for (const url of ['https://api.ipify.org', 'https://ifconfig.me/ip', 'https://icanhazip.com']) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (r.ok) {
        const t = (await r.text()).trim();
        const m = t.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}|[0-9a-fA-F:]+:[0-9a-fA-F:]+)/);
        if (m) { egressIp = m[1]; break; }
      }
    } catch (e) {}
  }
  if (egressIp) console.warn('[llm] 服务出口 IP = ' + egressIp + '（若 LLM 端点被 Cloudflare 拦截，请将其加入该端点 Cloudflare 白名单，或设置 LLM_PROXY / 切换 LLM_BASE_URL）');
  return egressIp;
}

// ===== 周期探活：端点恢复（被放白/换端点/走代理）时自动解除熔断，无需等 3 次竞价失败 =====
let lastProbe = { at: 0, ok: null, err: '' };
async function probeOnce() {
  const st = pstate(PRIMARY.keyEnv);
  st.brokenUntil = 0; st.failures = 0;   // 探活绕过熔断，真实探测端点是否恢复
  try {
    const r = await chat('只回复 ok', 'ok', false);
    if (r) { lastProbe = { at: Date.now(), ok: true, err: '' }; console.warn('[llm] 端点探活成功 → 已恢复热路径真实评分'); return lastProbe; }
    lastProbe = { at: Date.now(), ok: false, err: 'empty' };
  } catch (e) { lastProbe = { at: Date.now(), ok: false, err: e.message }; }
  st.failures = 3; st.brokenUntil = Date.now() + 60000;   // 失败则保持熔断，热路径立即回落启发式
  console.warn('[llm] 端点探活失败（保持熔断/启发式降级）: ' + lastProbe.err);
  return lastProbe;
}
function startProbe(intervalMs = 30000) {
  detectEgressIp();
  probeOnce();
  setInterval(probeOnce, intervalMs);
}
function status() {
  const breakerBroken = Object.values(providerState).some(s => Date.now() < s.brokenUntil);
  const probeBroken = lastProbe.at && lastProbe.ok === false;
  return { enabled: ENABLED, liveMatch: LIVE_MATCH, provider: PRIMARY.keyEnv, model: MODEL, baseURL: PRIMARY.baseURL,
    broken: breakerBroken || !!probeBroken, healthy: !!(lastProbe.at && lastProbe.ok === true), egressIp, lastProbe };
}

module.exports = { ENABLED, LIVE_MATCH, PROVIDER, MODEL, extractDemandIntent, extractSupplyTags, scoreRelevance, heuristicRelevance, chat, embed, cosine, startProbe, status };
