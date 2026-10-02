// creative/genClient.js —— 真实生成式模型接入（文生图 / 图生视频）
// 配置来源：DB 表 gen_config（UI 可配）优先，回落到环境变量 GEN_BASE_URL / GEN_API_KEY / GEN_MODEL / GEN_VIDEO_ENDPOINT
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let pool = null;
function attachPool(p) { pool = p; }

const TABLE = `CREATE TABLE IF NOT EXISTS gen_config (
  id INT PRIMARY KEY DEFAULT 1,
  provider VARCHAR(32) DEFAULT 'openai',
  base_url VARCHAR(256) DEFAULT '',
  api_key VARCHAR(512) DEFAULT '',
  model VARCHAR(128) DEFAULT 'gpt-image-1',
  video_endpoint VARCHAR(256) DEFAULT '',
  extra VARCHAR(1024) DEFAULT '{}',
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
)`;

async function initTables() { if (pool) await pool.query(TABLE).catch(() => {}); }

async function getRow() {
  if (!pool) return null;
  const [rows] = await pool.query('SELECT * FROM gen_config WHERE id=1').catch(() => [[]]);
  return rows && rows[0] ? rows[0] : null;
}

async function getConfig() {
  const row = await getRow();
  const env = {
    provider: process.env.GEN_PROVIDER || 'openai',
    base_url: process.env.GEN_BASE_URL || '',
    api_key: process.env.GEN_API_KEY || '',
    model: process.env.GEN_MODEL || '',
    video_endpoint: process.env.GEN_VIDEO_ENDPOINT || '',
  };
  const src = row ? 'db' : (env.base_url ? 'env' : 'none');
  const cfg = row
    ? { provider: row.provider, base_url: row.base_url, api_key: row.api_key, model: row.model, video_endpoint: row.video_endpoint }
    : env;
  return { ok: !!cfg.base_url, source: src, provider: cfg.provider, base_url: cfg.base_url, model: cfg.model, video_endpoint: cfg.video_endpoint, hasKey: !!cfg.api_key };
}

async function setConfig(c = {}) {
  const provider = c.provider || 'openai';
  const base_url = c.base_url || '';
  const api_key = c.api_key || '';
  const model = c.model || 'gpt-image-1';
  const video_endpoint = c.video_endpoint || '';
  if (pool) {
    await pool.query(
      `INSERT INTO gen_config (id,provider,base_url,api_key,model,video_endpoint) VALUES (1,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE provider=VALUES(provider),base_url=VALUES(base_url),api_key=VALUES(api_key),model=VALUES(model),video_endpoint=VALUES(video_endpoint)`,
      [provider, base_url, api_key, model, video_endpoint]).catch(() => {});
  }
  return { ok: true, provider, base_url, model, video_endpoint, hasKey: !!api_key };
}

function uploadsDir() { return path.join(__dirname, '..', 'public', 'uploads'); }
function saveToUploads(buf, ext) {
  const dir = uploadsDir();
  fs.mkdirSync(dir, { recursive: true });
  const fname = 'gen_' + crypto.randomBytes(8).toString('hex') + '.' + (ext || 'png').replace(/[^a-z0-9]/gi, '');
  fs.writeFileSync(path.join(dir, fname), buf);
  return '/uploads/' + fname;
}
function extOf(u) { const m = /\.([a-z0-9]+)(?:\?|$)/i.exec(u); return m ? m[1] : 'png'; }

// 文生图：调用 OpenAI 兼容 /images/generations，返回本地可访问 URL
async function generateImage(prompt, opts = {}) {
  if (!prompt) return { ok: false, reason: 'NO_PROMPT' };
  const cfg = await getConfig();
  if (!cfg.ok) return { ok: false, reason: 'NO_GEN_CONFIG', hint: '请在「生成模型配置」填写 base_url / api_key / model，或设置 GEN_* 环境变量' };
  const size = opts.size || '1024x1024';
  const model = opts.model || cfg.model || 'gpt-image-1';
  const body = { model, prompt, n: 1, size, response_format: 'b64_json' };
  let resp;
  try {
    resp = await fetch((cfg.base_url.replace(/\/$/, '')) + '/images/generations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.api_key },
      body: JSON.stringify(body),
    });
  } catch (e) { return { ok: false, reason: 'FETCH_FAILED', error: String(e && e.message || e) }; }
  if (!resp.ok) { let t = ''; try { t = await resp.text(); } catch {} return { ok: false, reason: 'UPSTREAM_' + resp.status, error: t.slice(0, 500) }; }
  const j = await resp.json().catch(() => ({}));
  let b64 = null, url = null;
  if (j.data && j.data[0]) { b64 = j.data[0].b64_json; url = j.data[0].url; }
  else if (j.choices && j.choices[0]) { const c = (j.choices[0].message && j.choices[0].message.content) || j.choices[0].text || ''; if (c.startsWith('http')) url = c; else b64 = c; }
  if (url) {
    try { const u = await fetch(url); const buf = Buffer.from(await u.arrayBuffer()); return { ok: true, url: saveToUploads(buf, extOf(url)), source: 'url' }; }
    catch (e) { return { ok: true, url, source: 'remote', note: '远程图未落本地' }; }
  }
  if (b64) return { ok: true, url: saveToUploads(Buffer.from(b64, 'base64'), 'png'), source: 'b64' };
  return { ok: false, reason: 'NO_IMAGE_RETURNED', raw: JSON.stringify(j).slice(0, 300) };
}

// 图生视频：配置了 video_endpoint 才调用；否则由 videogen 的 ffmpeg 分镜兜底
async function imageToVideo(images, prompt) {
  const cfg = await getConfig();
  if (!cfg.video_endpoint) return { ok: false, reason: 'NO_VIDEO_ENDPOINT', hint: '未配置 video_endpoint；「静图转视频」将用 ffmpeg 分镜兜底（需本机装 ffmpeg 才出 mp4，否则给 HTML5 预览）' };
  try {
    const resp = await fetch((cfg.video_endpoint.replace(/\/$/, '')), {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.api_key },
      body: JSON.stringify({ images, prompt }),
    });
    const j = await resp.json().catch(() => ({}));
    return { ok: resp.ok, status: resp.status, data: j };
  } catch (e) { return { ok: false, reason: 'FETCH_FAILED', error: String(e && e.message || e) }; }
}

module.exports = { attachPool, initTables, getConfig, setConfig, generateImage, imageToVideo };
