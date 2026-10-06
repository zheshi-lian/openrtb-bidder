// creative/index.js —— 创意自动化统一入口：可玩广告 / DCO / 静图转视频 / 多语言 / 真实文生图·图生视频
const playable = require('./playable');
const dco = require('./dco');
const videogen = require('./videogen');
const i18n = require('./i18n');
const genClient = require('./genClient');

function attachPool(pool) { dco.attachPool(pool); i18n.attachPool(pool); genClient.attachPool(pool); }
async function init() { await dco.initTables(); await i18n.initTables(); await genClient.initTables(); }

/**
 * 一键生成：给几张图 + 文案 → 产出可玩广告 / 视频 / DCO 组合
 * @param {object} spec {images, title, subtitle, ctaText, landingUrl, locales, formats, genPrompt, size}
 *   若传 genPrompt 且已配置生成模型，会先用文生图产出底图再组装。
 */
async function generate(spec = {}) {
  const out = { playable: null, video: null, html: null, ffmpeg: null, localized: null };
  let images = spec.images || [];
  if (spec.genPrompt && !images.length) {
    try { const g = await genClient.generateImage(spec.genPrompt, { size: spec.size }); if (g.ok) images = [g.url]; out.generated = g; }
    catch (e) { out.genError = String(e.message || e); }
  }
  // 可玩广告：有图用图，无图用文案兜底 —— 始终产出可入库 HTML，避免"空壳"
  if ((spec.formats || ['playable']).includes('playable') || !spec.formats) {
    const play = images.length
      ? playable.fromAssets({ images, title: spec.title, subtitle: spec.subtitle, ctaText: spec.ctaText, landingUrl: spec.landingUrl, trackBase: spec.trackBase })
      : { html: textPlayable(spec), bytes: Buffer.byteLength(textPlayable(spec)) };
    out.playable = play;
    out.playable_bytes = (play && (play.bytes || (play.html ? Buffer.byteLength(play.html) : 0))) || 0;
    out.html = (play && play.html) || null;
  }
  if (images.length && (spec.formats || ['video']).includes('video')) {
    const sb = videogen.storyboard(images, { sceneMs: spec.sceneMs || 3000, width: spec.width || 720, height: spec.height || 1280, endText: spec.title || '', copy: spec.sceneCopy || [], musicUrl: spec.musicUrl || '' });
    out.video = sb;
    out.html = videogen.htmlFallback(sb, { cta: spec.ctaText ? { text: spec.ctaText, url: spec.landingUrl } : null });
    out.ffmpeg = videogen.ffmpegCommand(sb, (spec.outFile || 'out') + '.mp4');
  }
  if (spec.locales && spec.locales.length) {
    out.localized = {};
    const baseCopy = spec.copy || { title: spec.title, subtitle: spec.subtitle, cta: spec.ctaText };
    spec.locales.forEach(l => { out.localized[i18n.normalize(l)] = i18n.localize(baseCopy, l); });
  }
  return out;
}

// 无素材时的兜底可玩 HTML：用文案直接产出可入库、可预览的互动落地页（不依赖真实文生图模型）
function textPlayable(spec) {
  const t = (spec && spec.title) || '示例互动创意';
  const s = (spec && spec.subtitle) || '';
  const c = (spec && spec.ctaText) || '立即体验';
  const u = (spec && spec.landingUrl) || '#';
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + t + '</title></head>' +
    '<body style="margin:0;font-family:system-ui;background:linear-gradient(135deg,#1e3a8a,#0ea5e9);color:#fff;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:24px">' +
    '<div style="font-size:22px;font-weight:700">' + t + '</div>' +
    (s ? '<div style="opacity:.9;margin-top:8px">' + s + '</div>' : '') +
    '<a href="' + u + '" style="margin-top:20px;display:inline-block;padding:12px 28px;background:#fff;color:#1e3a8a;border-radius:10px;font-weight:700;text-decoration:none">' + c + '</a>' +
    '</body></html>';
}

function snapshot() {
  return {
    playable_modes: playable.MODES,
    video_motions: videogen.MOTIONS,
    locales: Object.keys(i18n.LOCALES),
    dco_slots: Object.keys(dco.DEFAULT_TEMPLATE.slots),
  };
}

// ── 真实生成式模型（需配置 gen_config）──
function generateImage(prompt, opts) { return genClient.generateImage(prompt, opts); }
function imageToVideo(images, prompt) { return genClient.imageToVideo(images, prompt); }
function getGenConfig() { return genClient.getConfig(); }
function setGenConfig(c) { return genClient.setConfig(c); }

module.exports = {
  attachPool, init, generate, snapshot,
  generateImage, imageToVideo, getGenConfig, setGenConfig,
  playable, dco, videogen, i18n,
};
