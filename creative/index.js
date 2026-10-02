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
  if ((spec.formats || ['playable']).includes('playable') || !spec.formats) {
    out.playable = playable.fromAssets({ images, title: spec.title, subtitle: spec.subtitle, ctaText: spec.ctaText, landingUrl: spec.landingUrl, trackBase: spec.trackBase });
    out.playable_bytes = playable.estimateBytes({ iconUrl: images[0] || '', landingUrl: spec.landingUrl || '#' });
  }
  if (images.length && (spec.formats || ['video']).includes('video')) {
    const sb = videogen.storyboard(images, { sceneMs: spec.sceneMs || 3000, width: spec.width || 720, height: spec.height || 1280, endText: spec.title || '', copy: spec.sceneCopy || [], musicUrl: spec.musicUrl || '' });
    out.video = sb;
    out.html = videogen.htmlFallback(sb, { cta: spec.ctaText ? { text: spec.ctaText, url: spec.landingUrl } : null });
    out.ffmpeg = videogen.ffmpegCommand(sb, (spec.outFile || 'out') + '.mp4');
  }
  if (spec.locales && spec.locales.length) {
    out.localized = {};
    spec.locales.forEach(l => { out.localized[i18n.normalize(l)] = i18n.localize(spec.copy || { title: spec.title, subtitle: spec.subtitle, cta: spec.ctaText }, l); });
  }
  return out;
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
