// creative/playable.js —— 可玩广告（Playable Ads）模板引擎
//
// 这是"汇量/AppLovin 系"真正的强项，也是我们最现实的楔子：
//   可玩广告的 CTR/CVR 通常是静态素材的 3~10 倍，而中小广告主没有能力自己做。
//   谁把"上传几张图 → 自动生成可玩广告"做出来，谁就拿到了素材侧的差异化。
//
// 产出：单文件 HTML5（无外部依赖），可直接作为 adm 下发，内含：
//   ① 试玩环节（canvas 小游戏，可配置玩法）
//   ② 结束卡（endcard）：CTA + 商店跳转 + 点击埋点
//   ③ MRAID / postMessage 桥：与容器通信（关闭、跳转、可玩结束事件）
//   ④ 曝光/交互埋点：impression、playable_start、playable_end、install_click
//
// 玩法模板：tap_target（打靶） / three_card（三选一） / spin（转盘） / swipe_gallery（滑动浏览）

const AD_FORMATS = ['tap_target', 'three_card', 'spin', 'swipe_gallery'];

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function escJs(s) { return esc(s).replace(/\n/g, ' '); }

function endcardHtml(s) {
  return [
    '<div id="adx-end" style="display:none;position:absolute;inset:0;flex-direction:column;align-items:center;justify-content:center;',
    'background:linear-gradient(160deg,' + esc(s.bgFrom || '#1e293b') + ',' + esc(s.bgTo || '#0f172a') + ');color:#fff;font-family:system-ui,-apple-system,sans-serif;padding:24px;text-align:center">',
    '<div style="width:88px;height:88px;border-radius:20px;overflow:hidden;background:#fff;margin-bottom:14px">',
    s.iconUrl ? '<img src="' + esc(s.iconUrl) + '" style="width:100%;height:100%;object-fit:cover" alt="">' : '',
    '</div>',
    '<div style="font-size:20px;font-weight:700;margin-bottom:6px">' + esc(s.title || '立即体验') + '</div>',
    '<div style="font-size:13px;opacity:.85;margin-bottom:18px">' + esc(s.subtitle || '你已试玩完成，下载继续') + '</div>',
    '<button id="adx-cta" style="background:' + esc(s.ctaColor || '#2563eb') + ';color:#fff;border:0;border-radius:999px;',
    'padding:13px 34px;font-size:16px;font-weight:700;cursor:pointer;box-shadow:0 8px 20px rgba(0,0,0,.3)">' + esc(s.ctaText || '立即下载') + '</button>',
    '</div>',
  ].join('');
}

// 试玩逻辑：一份通用引擎，按 mode 切换玩法（保持单文件体积可控）
function gameScript(mode, s) {
  return [
    '(function(){',
    'var cv=document.getElementById("adx-cv"),ctx=cv.getContext("2d"),W=cv.width,H=cv.height;',
    'var score=0,started=false,ended=false,t0=Date.now();',
    'function rnd(a,b){return a+Math.random()*(b-a);}',
    'function post(o){try{parent.postMessage(Object.assign({adxPlayable:1},o),"*");}catch(e){}',
    'function track(ev){var i=new Image();i.src="' + esc(s.trackBase || '') + '&event="+encodeURIComponent(ev);}',
    'var targets=[],card=null,angle=0,spinning=false;',
    'function spawn(){targets.push({x:rnd(40,W-40),y:rnd(60,H-120),r:rnd(22,34),c:"#f43f5e"});}',
    'function draw(dt){ctx.clearRect(0,0,W,H);',
    '  ctx.fillStyle="' + esc(s.stageBg || '#e2e8f0') + '";ctx.fillRect(0,0,W,H);',
    '  if("' + mode + '"==="tap_target"){',
    '    if(targets.length<3&&Math.random()<0.04)spawn();',
    '    targets.forEach(function(t){ctx.beginPath();ctx.arc(t.x,t.y,t.r,0,6.28);ctx.fillStyle=t.c;ctx.fill();',
    '      ctx.lineWidth=4;ctx.strokeStyle="#fff";ctx.stroke();});',
    '  } else if("' + mode + '"==="three_card"){',
    '    for(var i=0;i<3;i++){var w=W/3-14;ctx.fillStyle=i===card?"#2563eb":"#fff";ctx.fillRect(8+i*(W/3),H/2-70,w,140);',
    '      ctx.strokeStyle="#cbd5e1";ctx.lineWidth=2;ctx.strokeRect(8+i*(W/3),H/2-70,w,140);',
    '      ctx.fillStyle=i===card?"#fff":"#334155";ctx.font="bold 22px sans-serif";ctx.textAlign="center";ctx.fillText("?",8+i*(W/3)+w/2,H/2+8);}',
    '  } else if("' + mode + '"==="spin"){',
    '    ctx.save();ctx.translate(W/2,H/2);ctx.rotate(angle);',
    '    for(var k=0;k<6;k++){ctx.beginPath();ctx.moveTo(0,0);ctx.arc(0,0,90,k*1.047,(k+1)*1.047);ctx.closePath();',
    '      ctx.fillStyle=k%2?"#2563eb":"#38bdf8";ctx.fill();}',
    '    ctx.restore();ctx.fillStyle="#fff";ctx.beginPath();ctx.moveTo(W/2-12,H/2-100);ctx.lineTo(W/2+12,H/2-100);ctx.lineTo(W/2,H/2-78);ctx.fill();',
    '    if(spinning)angle+=0.22;',
    '  }',
    '  ctx.fillStyle="#0f172a";ctx.font="bold 15px sans-serif";ctx.textAlign="left";ctx.fillText("得分 "+score,12,26);',
    '  ctx.fillStyle="#64748b";ctx.font="12px sans-serif";ctx.fillText("试玩中 · ' + escJs(s.hint || '点一点试试') + '",12,44);',
    '}',
    'function end(){if(ended)return;ended=true;track("playable_end");post({event:"playable_end",score:score});',
    '  document.getElementById("adx-stage").style.display="none";',
    '  var e=document.getElementById("adx-end");e.style.display="flex";',
    '  var b=document.getElementById("adx-cta");',
    '  b.onclick=function(){track("install_click");post({event:"install_click"});',
    '    if(window.mraid&&window.mraid.open)window.mraid.open("' + esc(s.landingUrl || '') + '");',
    '    else window.open("' + esc(s.landingUrl || '') + '","_blank");};',
    '}',
    'function loop(){draw(Date.now()-t0);',
    '  if(!ended&&Date.now()-t0>' + Number(s.trialMs || 15000) + ')end();',
    '  requestAnimationFrame(loop);}',
    'cv.addEventListener("pointerdown",function(e){',
    '  if(!started){started=true;track("playable_start");post({event:"playable_start"});}',
    '  var r=cv.getBoundingClientRect(),x=(e.clientX-r.left)*(W/r.width),y=(e.clientY-r.top)*(H/r.height);',
    '  if("' + mode + '"==="tap_target"){',
    '    for(var i=targets.length-1;i>=0;i--){var t=targets[i];var d=Math.hypot(x-t.x,y-t.y);if(d<t.r){targets.splice(i,1);score++;break;}}',
    '  } else if("' + mode + '"==="three_card"){',
    '    card=Math.min(2,Math.floor(x/(W/3)));score++;setTimeout(end,420);',
    '  } else if("' + mode + '"==="spin"){',
    '    spinning=!spinning;score++;setTimeout(function(){spinning=false;end();},1600);',
    '  }',
    '});',
    'track("playable_impression");post({event:"playable_impression"});loop();',
    '})();',
  ].join('\n');
}

/**
 * 生成可玩广告 HTML
 * @param {object} spec {
 *   mode, width, height, trialMs, title, subtitle, ctaText, ctaColor,
 *   iconUrl, landingUrl, trackBase, stageBg, bgFrom, bgTo, hint
 * }
 */
function render(spec = {}) {
  const s = {
    mode: AD_FORMATS.includes(spec.mode) ? spec.mode : 'tap_target',
    width: Number(spec.width) || 320, height: Number(spec.height) || 480,
    trialMs: Number(spec.trialMs || 15000),
    title: spec.title || '试玩一下', subtitle: spec.subtitle || '', ctaText: spec.ctaText || '立即下载',
    ctaColor: spec.ctaColor || '#2563eb', iconUrl: spec.iconUrl || '', landingUrl: spec.landingUrl || '#',
    trackBase: spec.trackBase || '', stageBg: spec.stageBg || '#e2e8f0',
    bgFrom: spec.bgFrom || '#1e293b', bgTo: spec.bgTo || '#0f172a',
    hint: spec.hint || '点一点试试',
  };
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">',
    '<title>' + esc(s.title) + '</title>',
    '<style>html,body{margin:0;padding:0;height:100%;overflow:hidden;background:#0f172a}',
    '#adx-wrap{position:relative;width:100%;height:100%;font-family:system-ui,-apple-system,sans-serif}',
    '#adx-stage{position:absolute;inset:0;display:flex;flex-direction:column}',
    '#adx-cv{width:100%;height:100%;display:block;touch-action:none}</style></head>',
    '<body><div id="adx-wrap">',
    '<div id="adx-stage"><canvas id="adx-cv" width="' + s.width + '" height="' + s.height + '"></canvas></div>',
    endcardHtml(s),
    '</div><script>',
    gameScript(s.mode, s),
    '<\/script></body></html>',
  ].join('');
}

// 体积预估：可玩广告通常有 100KB~2MB 的硬上限（各家交易所不同），超限直接拒收
function estimateBytes(spec) { return Buffer.byteLength(render(spec), 'utf8'); }

// 从"素材库的一张图 + 一段文案"快速生成默认可玩广告（对应"上传即产出"的产品体验）
function fromAssets(spec = {}) {
  return render({
    mode: spec.mode || (spec.images && spec.images.length >= 3 ? 'swipe_gallery' : 'tap_target'),
    iconUrl: (spec.images && spec.images[0]) || spec.iconUrl || '',
    title: spec.title || '', subtitle: spec.subtitle || '',
    ctaText: spec.ctaText || '立即下载', landingUrl: spec.landingUrl || '#',
    trackBase: spec.trackBase || '',
  });
}

module.exports = { render, estimateBytes, fromAssets, endcardHtml, AD_FORMATS, MODES: AD_FORMATS };
