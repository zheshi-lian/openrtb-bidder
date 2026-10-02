// creative/videogen.js —— 静图转视频：分镜脚本 → FFmpeg 命令 / 无 FFmpeg 的 HTML5 兜底
//
// 场景：广告主手里只有商品图/截图（90% 的中小广告主就是这样），但激励视频和信息流
// 视频位收益远高于静图。把"几张图 → 15 秒视频"自动化，是素材供给侧的刚需。
//
// 产出两层：
//   ① 分镜 spec（结构化、可存储、可复现）
//   ② FFmpeg 命令行（有 FFmpeg 时直接渲染）；同时给出 HTML5/CSS 动画版本——
//      后者不依赖任何二进制，任何环境都能立即预览，且本身就是个可用的"动图广告"。
//
// 运镜：ken_burns（缓慢推拉）/ pan_left / pan_right / zoom_out；转场：fade / slide

const MOTIONS = ['ken_burns', 'pan_left', 'pan_right', 'zoom_out'];
const TRANSITIONS = ['fade', 'slide', 'none'];

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * 生成分镜
 * @param {Array<string>} images 图片 URL
 * @param {object} opts {durationMs, fps, width, height, copy:[{scene,text}], musicUrl, motionCycle}
 */
function storyboard(images = [], opts = {}) {
  const per = Number(opts.sceneMs || 3000);
  const w = Number(opts.width || 720), h = Number(opts.height || 1280);
  const motions = Array.isArray(opts.motions) && opts.motions.length ? opts.motions : MOTIONS;
  const copy = opts.copy || [];
  return {
    width: w, height: h, fps: Number(opts.fps || 30),
    musicUrl: opts.musicUrl || '',
    scenes: images.map((url, i) => ({
      index: i, image: url, durationMs: per,
      motion: motions[i % motions.length],
      transition: i === images.length - 1 ? 'none' : (opts.transition || 'fade'),
      text: (copy[i] && copy[i].text) || (i === images.length - 1 && opts.endText) || '',
      subText: (copy[i] && copy[i].subText) || '',
    })),
    totalMs: images.length * per,
  };
}

// ───────── FFmpeg 渲染命令 ─────────
// 说明：zoompan 是 FFmpeg 里做 Ken Burns 的标准滤镜；这里按场景拼接后 concat
function ffmpegCommand(spec, out = 'out.mp4') {
  if (!spec || !spec.scenes || !spec.scenes.length) return '';
  const fps = spec.fps || 30;
  const d = (ms) => Math.max(1, Math.round((Number(ms) / 1000) * fps));
  const parts = spec.scenes.map((s, i) => {
    const frames = d(s.durationMs);
    let z;
    if (s.motion === 'zoom_out') z = `zoompan=z='if(lte(zoom,1.0),1.6,max(1.001,zoom-0.0012))':d=${frames}:s=${spec.width}x${spec.height}:fps=${fps}`;
    else if (s.motion === 'pan_left') z = `zoompan=z='1.35':x='iw-(iw/zoom)*(on/${frames})':d=${frames}:s=${spec.width}x${spec.height}:fps=${fps}`;
    else if (s.motion === 'pan_right') z = `zoompan=z='1.35':x='(iw-(iw/zoom))*(on/${frames})':d=${frames}:s=${spec.width}x${spec.height}:fps=${fps}`;
    else z = `zoompan=z='min(zoom+0.0012,1.6)':d=${frames}:s=${spec.width}x${spec.height}:fps=${fps}`;
    const scale = `scale=${spec.width}:${spec.height}:force_original_aspect_ratio=increase,crop=${spec.width}:${spec.height},setsar=1`;
    let txt = '';
    if (s.text) {
      const t = String(s.text).replace(/'/g, "\\\\'").replace(/:/g, '\\\\:');
      txt = `,drawtext=text='${t}':fontcolor=white:fontsize=${Math.round(spec.width / 16)}:x=(w-text_w)/2:y=h*0.78:borderw=3:bordercolor=black@0.5`;
    }
    return `[${i}:v]${scale},${z}${txt},fade=t=in:st=0:d=0.4,fade=t=out:st=${(Number(s.durationMs) / 1000) - 0.4}:d=0.4[v${i}]`;
  });
  const inputs = spec.scenes.map(s => `-loop 1 -t ${(Number(s.durationMs) / 1000).toFixed(2)} -i "${s.image}"`).join(' ');
  const audio = spec.musicUrl ? ` -i "${spec.musicUrl}" -shortest` : '';
  const maps = spec.scenes.map((_, i) => `[v${i}]`).join('');
  return [
    `ffmpeg -y ${inputs}${audio} -filter_complex "${parts.join(';')};${maps}concat=n=${spec.scenes.length}:v=1:a=0[outv]"`,
    `-map "[outv]"${spec.musicUrl ? ' -map ' + spec.scenes.length + ':a -c:a aac' : ''}`,
    `-c:v libx264 -pix_fmt yuv420p -r ${fps} -movflags +faststart "${out}"`,
  ].join(' ');
}

// ───────── HTML5 兜底（无需任何二进制，立即可用）─────────
// 用 CSS keyframes 模拟同样的运镜与转场；既是预览，也是可直接投放的"动态创意"
function htmlFallback(spec, opts = {}) {
  if (!spec || !spec.scenes || !spec.scenes.length) return '';
  const total = spec.scenes.reduce((s, x) => s + Number(x.durationMs), 0) || 1000;
  const css = spec.scenes.map((s, i) => {
    const start = spec.scenes.slice(0, i).reduce((a, x) => a + Number(x.durationMs), 0);
    const a = (start / total) * 100, b = ((start + Number(s.durationMs)) / total) * 100;
    let anim;
    if (s.motion === 'zoom_out') anim = 'adxZoomOut';
    else if (s.motion === 'pan_left') anim = 'adxPanLeft';
    else if (s.motion === 'pan_right') anim = 'adxPanRight';
    else anim = 'adxKenBurns';
    return `.adx-s${i}{animation:${anim} ${Number(s.durationMs)}ms linear ${start}ms both, adxFade ${Number(s.durationMs)}ms linear ${start}ms both}`;
  }).join('\n');
  const scenes = spec.scenes.map((s, i) => {
    const start = spec.scenes.slice(0, i).reduce((a, x) => a + Number(x.durationMs), 0);
    return '<div class="adx-scene adx-s' + i + '" style="animation-delay:' + start + 'ms,' + start + 'ms;background-image:url(\'' + esc(s.image) + '\')">' +
      (s.text ? '<div class="adx-cap"><b>' + esc(s.text) + '</b>' + (s.subText ? '<span>' + esc(s.subText) + '</span>' : '') + '</div>' : '') +
      '</div>';
  }).join('');
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<style>',
    '.adx-v{position:relative;width:100%;aspect-ratio:' + spec.width + '/' + spec.height + ';overflow:hidden;background:#000}',
    '.adx-scene{position:absolute;inset:0;background-size:cover;background-position:center;opacity:0}',
    '@keyframes adxKenBurns{from{transform:scale(1)}to{transform:scale(1.18)}}',
    '@keyframes adxZoomOut{from{transform:scale(1.6)}to{transform:scale(1)}}',
    '@keyframes adxPanLeft{from{transform:scale(1.35) translateX(12%)}to{transform:scale(1.35) translateX(-12%)}}',
    '@keyframes adxPanRight{from{transform:scale(1.35) translateX(-12%)}to{transform:scale(1.35) translateX(12%)}}',
    '@keyframes adxFade{0%{opacity:0}8%{opacity:1}92%{opacity:1}100%{opacity:0}}',
    '.adx-cap{position:absolute;left:0;right:0;bottom:12%;text-align:center;color:#fff;font-family:system-ui,sans-serif;text-shadow:0 2px 8px rgba(0,0,0,.6)}',
    '.adx-cap b{display:block;font-size:5vw}.adx-cap span{font-size:3vw;opacity:.9}',
    css,
    '</style></head><body><div class="adx-v">',
    scenes,
    opts.cta ? '<a href="' + esc(opts.cta.url || '#') + '" style="position:absolute;left:50%;transform:translateX(-50%);bottom:6%;background:#2563eb;color:#fff;padding:10px 26px;border-radius:999px;text-decoration:none;font-family:system-ui;font-weight:700">' + esc(opts.cta.text || '立即下载') + '</a>' : '',
    '</div></body></html>',
  ].join('');
}

function estimateBytes(spec, mode = 'html') {
  return Buffer.byteLength(mode === 'html' ? htmlFallback(spec) : ffmpegCommand(spec), 'utf8');
}

module.exports = { storyboard, ffmpegCommand, htmlFallback, estimateBytes, MOTIONS, TRANSITIONS };
