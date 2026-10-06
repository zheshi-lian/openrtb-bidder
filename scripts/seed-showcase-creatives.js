#!/usr/bin/env node
// seed-showcase-creatives.js —— 以「广告主」身份登录（不存在则自助注册），
// 为演示实际会胜出的计划写入一套**设计师级**多形态素材（插屏/开屏/原生/浮标/互动/图标/应用内View/banner/mrec/推送）。
//
// 背景：此前演示里展示的广告之所以难看，是因为素材库里命中的是早期占位素材
// （一行 `<div style="background:#0ea5e9">软考高项 · 限时 5 折</div>` 这种），
// 没有命中时更会落到 server.js 的 buildXxxHtml 合成模板（蓝底白字 "AD" SVG）。
// 本脚本产出的是可投放级别的设计稿：品牌主视觉 + 层级排版 + 社会证明 + 玻璃拟态 + 明确 CTA + 广告披露与关闭按钮。
//
// 用法：
//   node scripts/seed-showcase-creatives.js                      # 自动探测演示胜出计划并写入
//   node scripts/seed-showcase-creatives.js --cid=99026          # 指定计划
//   node scripts/seed-showcase-creatives.js --user=x --pass=y    # 指定广告主账号
//
// 幂等：标题带 [SHOWCASE] 标记的旧素材会先删除再写入，可反复运行。
'use strict';

const BASE = process.env.BASE || 'http://127.0.0.1:8080';
const ADV_USER = process.env.ADV_USER || 'demobrand';
const ADV_PASS = process.env.ADV_PASS || 'demo123';
const ADV_NAME = process.env.ADV_NAME || 'DemoBrand';
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin123';
const MARK = '[SHOWCASE]';
const LANDING = process.env.SHOWCASE_LANDING || 'https://dellai.xyz/landing/ruankao';

const arg = (k, d) => {
  const hit = process.argv.find((a) => a.startsWith('--' + k + '='));
  return hit ? hit.split('=')[1] : d;
};

async function api(p, body, token, method) {
  const h = { 'Content-Type': 'application/json' };
  if (token) h.Authorization = 'Bearer ' + token;
  const r = await fetch(BASE + p, {
    method: method || (body !== undefined ? 'POST' : 'GET'),
    headers: h,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let d = null;
  try { d = await r.json(); } catch (e) { d = null; }
  return { status: r.status, d };
}

/* ============================ 设计系统 ============================ */
// 统一色板 / 字体 / 圆角：整套素材看起来像同一个品牌出的，而不是拼凑的。
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif";
const svgIcon = (glyph, c1, c2) =>
  'data:image/svg+xml;utf8,' + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120" viewBox="0 0 120 120">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient></defs>` +
    `<rect width="120" height="120" rx="28" fill="url(#g)"/>` +
    `<text x="60" y="78" font-size="52" font-family="sans-serif" font-weight="700" text-anchor="middle" fill="#fff">${glyph}</text></svg>`);
const svgWide = (t1, t2, c1, c2) =>
  'data:image/svg+xml;utf8,' + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="314" viewBox="0 0 600 314">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient></defs>` +
    `<rect width="600" height="314" fill="url(#g)"/>` +
    `<circle cx="520" cy="40" r="120" fill="rgba(255,255,255,.10)"/>` +
    `<circle cx="60" cy="300" r="90" fill="rgba(255,255,255,.08)"/>` +
    `<text x="40" y="150" font-size="40" font-weight="800" fill="#fff" font-family="sans-serif">${t1}</text>` +
    `<text x="40" y="200" font-size="22" fill="rgba(255,255,255,.85)" font-family="sans-serif">${t2}</text></svg>`);

const ICON = svgIcon('考', '#2563eb', '#7c3aed');
const WIDE = svgWide('软考高项 · 2026 教材上新', '信息系统项目管理师 · 一次上岸', '#1e3a8a', '#0ea5e9');

// 每种形态一套完整设计稿。全部自包含（内联 SVG + CSS 渐变），不依赖任何外网图片。
const TPL = {};

TPL.interstitial = {
  type: 'html', width: 360, height: 640,
  title: MARK + ' 插屏 · 软考高项冲刺班',
  content: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>
  *{box-sizing:border-box;margin:0}
  html,body{height:100%}
  body{font-family:${FONT};background:#0b1020;color:#fff;overflow:hidden}
  .wrap{height:100%;position:relative;display:flex;align-items:center;justify-content:center;padding:14px;
    background:radial-gradient(120% 90% at 20% 0%,#1e3a8a 0%,#0b1020 60%),linear-gradient(135deg,#0ea5e9,#6366f1)}
  .glow{position:absolute;width:220px;height:220px;border-radius:50%;filter:blur(60px)}
  .card{position:relative;width:100%;max-width:320px;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.16);
    border-radius:20px;padding:22px 20px 18px;backdrop-filter:blur(14px);box-shadow:0 24px 60px rgba(0,0,0,.45)}
  .close{position:absolute;right:10px;top:10px;width:28px;height:28px;border:0;border-radius:50%;
    background:rgba(255,255,255,.16);color:#fff;font-size:16px;line-height:1;cursor:pointer}
  .badge{display:inline-flex;align-items:center;gap:6px;background:linear-gradient(92deg,#f59e0b,#ef4444);
    color:#fff;font-size:11px;font-weight:800;padding:4px 10px;border-radius:999px;letter-spacing:.04em}
  .hero{display:flex;align-items:center;gap:12px;margin-top:14px}
  .hero img{width:56px;height:56px;border-radius:14px;box-shadow:0 6px 18px rgba(0,0,0,.35)}
  h1{font-size:20px;font-weight:800;line-height:1.25;letter-spacing:-.01em}
  .sub{font-size:12.5px;color:rgba(255,255,255,.7);margin-top:3px}
  .proof{display:flex;align-items:center;gap:8px;margin-top:14px;font-size:11.5px;color:rgba(255,255,255,.72)}
  .stars{color:#fbbf24;letter-spacing:1px}
  .cta{display:block;margin-top:16px;text-align:center;text-decoration:none;font-size:15px;font-weight:800;
    padding:12px;border-radius:14px;color:#04122a;background:linear-gradient(92deg,#22d3ee,#a7f3d0);
    box-shadow:0 8px 22px rgba(34,211,238,.32)}
  .fine{margin-top:10px;font-size:10.5px;color:rgba(255,255,255,.45);text-align:center}
</style></head><body>
<div class="wrap"><div class="glow" style="background:#22d3ee;left:-40px;top:-40px"></div>
  <div class="glow" style="background:#f472b6;right:-50px;bottom:-60px"></div>
  <div class="card">
    <button class="close" onclick="document.querySelector('.card').style.display='none'">&times;</button>
    <span class="badge">限时 5 折 · 今日截止</span>
    <div class="hero">
      <img src="${ICON}" alt="icon">
      <div><h1>软考高项 · 冲刺班</h1><div class="sub">2026 教材上新 · 一次上岸</div></div>
    </div>
    <div class="proof"><span class="stars">★★★★★</span><span>4.9 分 · 12,483 人已报名</span></div>
    <a class="cta" href="${LANDING}?utm_source=adx&utm_medium=interstitial" target="_blank" rel="noopener">立即领取 5 折 →</a>
    <div class="fine">广告 · AppLink ADX &nbsp;|&nbsp; 点击跳转第三方落地页</div>
  </div>
</div></body></html>`,
};

TPL.splash = {
  type: 'html', width: 360, height: 640,
  title: MARK + ' 开屏 · 软考高项',
  content: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>
  *{box-sizing:border-box;margin:0}
  html,body{height:100%}
  body{font-family:${FONT};color:#fff;overflow:hidden;
    background:linear-gradient(160deg,#0b1020 0%,#1e3a8a 55%,#0ea5e9 100%)}
  .wrap{height:100%;position:relative;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px}
  .skip{position:absolute;right:14px;top:14px;background:rgba(255,255,255,.18);border:1px solid rgba(255,255,255,.25);
    color:#fff;border-radius:999px;padding:5px 12px;font-size:12px;cursor:pointer;backdrop-filter:blur(6px)}
  .logo{width:84px;height:84px;border-radius:22px;box-shadow:0 14px 34px rgba(0,0,0,.4)}
  .brand{font-size:22px;font-weight:800;letter-spacing:-.01em}
  .slogan{font-size:13px;color:rgba(255,255,255,.75)}
  .pulse{margin-top:18px;display:inline-block;background:linear-gradient(92deg,#22d3ee,#a7f3d0);color:#04122a;
    font-size:13px;font-weight:800;padding:9px 20px;border-radius:999px;text-decoration:none;
    box-shadow:0 8px 22px rgba(34,211,238,.3)}
  .foot{position:absolute;bottom:16px;font-size:10.5px;color:rgba(255,255,255,.5)}
</style></head><body>
<div class="wrap">
  <div class="skip" onclick="document.querySelector('.wrap').style.display='none'">跳过 3s</div>
  <img class="logo" src="${ICON}" alt="icon">
  <div class="brand">软考高项</div>
  <div class="slogan">2026 教材上新 · 冲刺一次上岸</div>
  <a class="pulse" href="${LANDING}?utm_source=adx&utm_medium=splash" target="_blank" rel="noopener">了解详情</a>
  <div class="foot">广告 · AppLink ADX</div>
</div>
<script>setTimeout(function(){var s=document.querySelector('.skip');if(s)s.textContent='跳过';},3000);</script>
</body></html>`,
};

TPL.float = {
  type: 'html', width: 220, height: 120,
  title: MARK + ' 浮标 · 软考高项',
  content: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>
  *{box-sizing:border-box;margin:0}
  html,body{height:100%}
  body{font-family:${FONT};background:transparent;display:flex;align-items:flex-end;justify-content:flex-end;padding:8px}
  .card{position:relative;width:212px;background:linear-gradient(135deg,rgba(37,99,235,.96),rgba(124,58,237,.96));
    border-radius:16px;padding:12px 13px;color:#fff;box-shadow:0 12px 30px rgba(37,99,235,.42)}
  .x{position:absolute;right:8px;top:7px;width:20px;height:20px;border:0;border-radius:50%;
    background:rgba(255,255,255,.24);color:#fff;font-size:13px;line-height:18px;cursor:pointer;padding:0}
  .row{display:flex;align-items:center;gap:10px}
  .row img{width:42px;height:42px;border-radius:11px;flex:none;box-shadow:0 4px 12px rgba(0,0,0,.3)}
  .t{font-size:13px;font-weight:800;line-height:1.25}
  .d{font-size:11px;opacity:.85;margin-top:2px}
  .cta{display:block;margin-top:10px;text-align:center;background:#fff;color:#2563eb;font-size:12px;font-weight:800;
    padding:7px 0;border-radius:9px;text-decoration:none}
</style></head><body>
<div class="card">
  <button class="x" onclick="document.querySelector('.card').style.display='none'">&times;</button>
  <div class="row"><img src="${ICON}" alt="icon">
    <div><div class="t">软考高项 · 冲刺班</div><div class="d">教材上新 · 限时 5 折</div></div>
  </div>
  <a class="cta" href="${LANDING}?utm_source=adx&utm_medium=float" target="_blank" rel="noopener">立即抢名额</a>
</div></body></html>`,
};

TPL.interactive = {
  type: 'html', width: 320, height: 260,
  title: MARK + ' 互动 · 答题闯关（可玩广告）',
  content: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>
  *{box-sizing:border-box;margin:0}
  html,body{height:100%}
  body{font-family:${FONT};background:#0f172a;color:#fff;display:flex;align-items:center;justify-content:center;padding:8px}
  .box{width:100%;max-width:320px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.14);
    border-radius:16px;padding:14px;text-align:center}
  .hd{display:flex;align-items:center;justify-content:space-between;font-size:12.5px;font-weight:800;margin-bottom:8px}
  .score{font-family:ui-monospace,monospace;color:#22d3ee}
  .q{font-size:14.5px;font-weight:700;line-height:1.4;margin:6px 0 12px}
  .opts{display:grid;grid-template-columns:1fr 1fr;gap:8px}
  .opt{border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.05);color:#fff;border-radius:11px;
    padding:10px 6px;font-size:12.5px;cursor:pointer;font-family:inherit;font-weight:600}
  .opt:hover{background:rgba(34,211,238,.16);border-color:#22d3ee}
  .opt.ok{background:#16a34a;border-color:#22c55e}
  .opt.no{background:#b91c1c;border-color:#ef4444}
  .tip{margin-top:10px;font-size:11.5px;color:rgba(255,255,255,.6);min-height:16px}
  .cta{display:block;margin-top:10px;background:linear-gradient(92deg,#22d3ee,#a7f3d0);color:#04122a;
    font-weight:800;font-size:13px;padding:10px;border-radius:12px;text-decoration:none}
</style></head><body>
<div class="box">
  <div class="hd"><span>🎮 30 秒测测你的通关率</span><span class="score" id="sc">0 / 3</span></div>
  <div class="q" id="q">高项考试中，WBS 分解的最小单元是？</div>
  <div class="opts" id="opts">
    <button class="opt" data-ok="0">里程碑</button>
    <button class="opt" data-ok="1">工作包</button>
    <button class="opt" data-ok="0">活动</button>
    <button class="opt" data-ok="0">控制账户</button>
  </div>
  <div class="tip" id="tip">答对 2 题即可解锁 5 折名额</div>
  <a class="cta" href="${LANDING}?utm_source=adx&utm_medium=interactive" target="_blank" rel="noopener">查看我的通关报告 →</a>
</div>
<script>
var n=0,i=0;
var QS=[['高项考试中，WBS 分解的最小单元是？',['里程碑','工作包','活动','控制账户'],1],
        ['挣值分析中，SV = EV − ?',['AC','BAC','PV','ETC'],2],
        ['配置管理的核心活动不包括？',['配置标识','配置审计','风险识别','状态报告'],2]];
function load(){var q=QS[i];document.getElementById('q').textContent=q[0];
  var bs=document.getElementById('opts').children;
  for(var k=0;k<4;k++){bs[k].textContent=q[1][k];bs[k].className='opt';bs[k].onclick=pick;}}
function pick(){var self=this,idx=[].indexOf.call(this.parentNode.children,this),ok=QS[i][2];
  if(idx===ok){this.className='opt ok';n++;}else{this.className='opt no';
    this.parentNode.children[ok].className='opt ok';}
  document.getElementById('sc').textContent=n+' / 3';
  document.getElementById('tip').textContent= idx===ok?'答对了！':'正确答案是「'+QS[i][1][ok]+'」';
  var bs=this.parentNode.children;for(var k=0;k<4;k++)bs[k].onclick=null;
  i++;if(i<QS.length)setTimeout(load,650);
  else setTimeout(function(){document.getElementById('tip').textContent='通关率 '+Math.round(n/3*100)+'% · 已解锁 5 折名额';},650);}
load();
</script></body></html>`,
};

TPL.view = {
  type: 'html', width: 300, height: 140,
  title: MARK + ' 应用内 View · 信息流卡片',
  content: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>
  *{box-sizing:border-box;margin:0}
  html,body{height:100%}
  body{font-family:${FONT};background:transparent;display:flex;align-items:center;justify-content:center;padding:4px}
  .card{width:100%;max-width:300px;height:132px;display:flex;gap:11px;align-items:center;padding:11px;
    background:linear-gradient(135deg,#111c3a,#0d1730);border:1px solid #26355c;border-radius:12px;
    box-shadow:0 8px 22px rgba(0,0,0,.35);position:relative;overflow:hidden}
  .card img{width:58px;height:58px;border-radius:12px;flex:none}
  .t{font-size:14px;font-weight:800;color:#e8eefc;line-height:1.3}
  .d{font-size:11.5px;color:#93a3c4;margin-top:3px;line-height:1.35}
  .meta{font-size:10.5px;color:#64748b;margin-top:5px}
  .cta{margin-left:auto;flex:none;background:linear-gradient(92deg,#3b82f6,#22d3ee);color:#04122a;font-size:11.5px;
    font-weight:800;padding:7px 12px;border-radius:999px;text-decoration:none;white-space:nowrap}
  .tag{position:absolute;right:0;top:0;background:rgba(148,163,184,.18);color:#94a3b8;font-size:9.5px;
    padding:2px 7px;border-radius:0 0 0 7px}
</style></head><body>
<div class="card"><span class="tag">广告</span>
  <img src="${ICON}" alt="icon">
  <div style="flex:1;min-width:0">
    <div class="t">软考高项 · 2026 教材上新</div>
    <div class="d">信息系统项目管理师冲刺班，重点串讲 + 真题库</div>
    <div class="meta">4.9 ★ · 12,483 人已报名</div>
  </div>
  <a class="cta" href="${LANDING}?utm_source=adx&utm_medium=view" target="_blank" rel="noopener">去看看</a>
</div></body></html>`,
};

TPL.icon = {
  type: 'html', width: 120, height: 150,
  title: MARK + ' 图标 · 软考高项',
  content: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>
  *{box-sizing:border-box;margin:0}
  body{font-family:${FONT};background:transparent;display:flex;flex-direction:column;align-items:center;gap:6px;padding:6px}
  .ic{width:88px;height:88px;border-radius:22px;box-shadow:0 10px 24px rgba(37,99,235,.35);position:relative}
  .ic span{position:absolute;left:0;right:0;bottom:-2px;text-align:center;font-size:9px;color:#64748b}
  .nm{font-size:12px;color:#e8eefc;font-weight:700}
  .sub{font-size:10px;color:#93a3c4}
</style></head><body>
<a href="${LANDING}?utm_source=adx&utm_medium=icon" target="_blank" rel="noopener" style="text-decoration:none;text-align:center">
  <img class="ic" src="${ICON}" alt="icon">
  <div class="nm">软考高项</div><div class="sub">广告 · 下载</div>
</a></body></html>`,
};

TPL.banner = {
  type: 'html', width: 300, height: 250,
  title: MARK + ' Banner · 软考高项',
  content: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>
  *{box-sizing:border-box;margin:0}
  html,body{height:100%}
  body{font-family:${FONT};background:#0b1020;display:flex;align-items:center;justify-content:center;padding:6px}
  .b{width:100%;height:100%;max-width:300px;border-radius:12px;overflow:hidden;position:relative;
    background:linear-gradient(135deg,#1e3a8a,#0ea5e9);color:#fff;padding:14px;display:flex;flex-direction:column}
  .b::after{content:'';position:absolute;right:-40px;top:-40px;width:150px;height:150px;border-radius:50%;
    background:rgba(255,255,255,.12)}
  .badge{align-self:flex-start;background:rgba(255,255,255,.2);font-size:10px;font-weight:800;
    padding:3px 9px;border-radius:999px;backdrop-filter:blur(4px)}
  .hero{display:flex;align-items:center;gap:10px;margin-top:auto}
  .hero img{width:46px;height:46px;border-radius:12px;flex:none}
  h1{font-size:16.5px;font-weight:800;line-height:1.25}
  .sub{font-size:11px;opacity:.82;margin-top:2px}
  .cta{margin-top:11px;display:block;text-align:center;background:#fff;color:#0b3a8a;font-size:13px;
    font-weight:800;padding:9px;border-radius:10px;text-decoration:none}
  .fine{margin-top:7px;font-size:9.5px;opacity:.6;text-align:center}
</style></head><body>
<div class="b">
  <span class="badge">限时 5 折</span>
  <div class="hero"><img src="${ICON}" alt="icon">
    <div><h1>软考高项冲刺班</h1><div class="sub">2026 教材上新 · 4.9★</div></div>
  </div>
  <a class="cta" href="${LANDING}?utm_source=adx&utm_medium=banner" target="_blank" rel="noopener">立即领取 →</a>
  <div class="fine">广告 · AppLink ADX</div>
</div></body></html>`,
};

TPL.mrec = {
  type: 'html', width: 300, height: 250,
  title: MARK + ' MREC · 软考高项',
  content: TPL.banner.content.replace('utm_medium=banner', 'utm_medium=mrec'),
};

// 原生：JSON（媒体侧按自己的样式渲染，平台只给结构化物料 + 高质量图）
TPL.native = {
  type: 'native', width: 1200, height: 628,
  title: MARK + ' 原生 · 软考高项',
  content: JSON.stringify({
    title: '软考高项 · 2026 教材上新',
    body: '信息系统项目管理师冲刺班：重点串讲 + 近 5 年真题库 + 论文批改，一次上岸。',
    icon: ICON,
    image: WIDE,
    cta: '免费试听',
    rating: 4.9,
    advertiser: '软考高项',
    sponsored: '广告 · AppLink ADX',
    clickUrl: LANDING + '?utm_source=adx&utm_medium=native',
    impTrackers: [],
    ad_format: 'native',
  }),
};

// 推送：JSON（不渲染 adm，由媒体推送系统下发）
TPL.push = {
  type: 'push', width: 96, height: 96,
  title: MARK + ' 推送 · 软考高项',
  content: JSON.stringify({
    title: '你的 5 折名额今天到期',
    body: '软考高项冲刺班 · 2026 教材已上新，限时 5 折剩余 3 小时',
    icon: ICON,
    clickUrl: LANDING + '?utm_source=adx&utm_medium=push',
    impUrl: '',
    ad_format: 'push',
  }),
};

// 激励视频：VAST 4.0（此前走外部 DSP 的 mock 广告 + 硬编码的三方示例视频，与广告主素材库无关）
TPL.rewarded = {
  type: 'vast', width: 1280, height: 720, duration_sec: 30,
  title: MARK + ' 激励视频 · 软考高项',
  media_url: '/uploads/demo-trailer.mp4',
  content: `<?xml version="1.0" encoding="UTF-8"?>
<VAST version="4.0"><Ad id="showcase-rewarded"><InLine>
<AdSystem version="1.0">AppLinkADX</AdSystem>
<AdTitle><![CDATA[软考高项 · 2026 冲刺班]]></AdTitle>
<Impression id="zhuque-imp"><![CDATA[https://dellai.xyz/vast/track?event=impression&cid=99026]]></Impression>
<Creatives><Creative id="showcase-rewarded-cre" sequence="1"><Linear skipoffset="00:00:05">
<Duration>00:00:30</Duration>
<TrackingEvents>
<Tracking event="start"><![CDATA[https://dellai.xyz/vast/track?event=start&cid=99026]]></Tracking>
<Tracking event="firstQuartile"><![CDATA[https://dellai.xyz/vast/track?event=firstQuartile&cid=99026]]></Tracking>
<Tracking event="midpoint"><![CDATA[https://dellai.xyz/vast/track?event=midpoint&cid=99026]]></Tracking>
<Tracking event="thirdQuartile"><![CDATA[https://dellai.xyz/vast/track?event=thirdQuartile&cid=99026]]></Tracking>
<Tracking event="complete"><![CDATA[https://dellai.xyz/vast/track?event=complete&cid=99026]]></Tracking>
</TrackingEvents>
<VideoClicks><ClickThrough><![CDATA[${LANDING}?utm_source=adx&utm_medium=rewarded]]></ClickThrough></VideoClicks>
<MediaFiles>
<MediaFile delivery="progressive" type="video/mp4" width="1280" height="720" scalable="true" maintainAspectRatio="true"><![CDATA[/uploads/demo-trailer.mp4]]></MediaFile>
</MediaFiles>
</Linear></Creative></Creatives>
</InLine></Ad></VAST>`,
};

const ORDER = ['interstitial', 'splash', 'native', 'float', 'interactive', 'view', 'icon', 'banner', 'mrec', 'push', 'rewarded'];

/* ============================ 主流程 ============================ */
async function loginOrRegister() {
  let r = await api('/api/account/login', { username: ADV_USER, password: ADV_PASS });
  if (r.status === 200 && r.d && r.d.token) return { token: r.d.token, fresh: false };
  // 账号不存在 → 以广告主身份自助注册（与页面「自助开户」同一条链路）
  const su = await api('/api/signup/advertiser', {
    email: ADV_USER, password: ADV_PASS, name: ADV_NAME, advertiser: ADV_NAME,
  });
  if (!(su.status === 200 && su.d && su.d.ok)) {
    throw new Error('广告主登录失败(' + r.status + ')，自助注册也失败(' + su.status + ')：' + JSON.stringify(su.d));
  }
  r = await api('/api/account/login', { username: ADV_USER, password: ADV_PASS });
  if (!(r.status === 200 && r.d && r.d.token)) throw new Error('注册后仍登录失败：' + JSON.stringify(r.d));
  return { token: r.d.token, fresh: true };
}

// 探测演示实际会胜出的计划：以真实竞价请求问一次，取胜出的 cid。
// 素材必须挂在"会赢的计划"上才会被下发，挂在别的计划上等于白做。
async function probeWinningCid(token) {
  for (const fmt of ['interstitial', 'splash', 'native']) {
    const body = {
      id: 'probe_' + fmt, site: { domain: 'dellai.xyz', keywords: '休闲游戏,激励视频,' + fmt },
      imp: [{ id: 'probe_' + fmt, bidfloor: 2.0, ext: { cat: 'game', ad_type: fmt, device_fp: 'seed-probe' } }],
      device: { ua: 'Mozilla/5.0 (Linux; Android 14)', os: 'Android', w: 1080, h: 2400, geo: { country: 'CN' } },
    };
    try {
      const r = await fetch(BASE + '/ssp/bid', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json();
      const b = j.seatbid && j.seatbid[0] && j.seatbid[0].bid && j.seatbid[0].bid[0];
      if (b && b.ext && Number(b.ext.cid) > 0) return Number(b.ext.cid);
    } catch (e) { /* 继续下一个形态 */ }
  }
  return 0;
}

(async () => {
  const cidArg = arg('cid', '');
  let cid = Number(cidArg) || 0;
  const { token, fresh } = await loginOrRegister();
  console.log('广告主登录：' + ADV_USER + (fresh ? '（本次新注册）' : '（已有账号）'));
  if (!cid) cid = await probeWinningCid(token);
  if (!cid) throw new Error('未能探测到演示胜出计划，请用 --cid=<计划ID> 指定');
  console.log('写入目标计划 campaign_id = ' + cid);

  // 列表用管理员令牌：广告主令牌会被 `advertiser=?` 过滤掉历史占位素材（它们可能挂在别的广告主名下），
  // 那样就清理不到真正让演示变丑的那些行。
  const admLogin = await api('/api/account/login', { username: ADMIN_USER, password: ADMIN_PASS });
  const admTok = (admLogin.d && admLogin.d.token) || '';
  // 幂等：先清掉上一轮 [SHOWCASE] 素材
  const list = await api('/api/creatives?campaign_id=' + cid, undefined, admTok || token);
  const olds = (Array.isArray(list.d) ? list.d : []).filter((c) => String(c.title || '').indexOf(MARK) === 0);
  for (const o of olds) await api('/api/creatives/' + o.id, undefined, token, 'DELETE');
  console.log('清理旧展示素材：' + olds.length + ' 条');

  // 关键：素材库里同一形态若还留着老的占位素材，创意 A/B 会轮播到它们上（演示就会一会儿好看一会儿丑）。
  // 把"内容短到明显是占位"的老素材置为 paused（不删除，可随时恢复），让设计稿稳定胜出。
  // --keep-legacy=1 可跳过这一步。
  if (arg('keep-legacy', '') !== '1') {
    if (!admTok) console.log('（跳过 legacy 清理：管理员登录不可用，旧占位素材仍会参与 A/B 轮播）');
    else {
      let paused = 0;
      for (const c of (Array.isArray(list.d) ? list.d : [])) {
        if (String(c.title || '').indexOf(MARK) === 0) continue;          // 本次新写入的
        if (String(c.creative_status || '') !== 'approved') continue;      // 本来就不参与投放
        const s = String(c.content || '');
        const isPlaceholder = s.length < 400 || s.indexOf('示例') >= 0 || s.indexOf('>AD</text>') >= 0;
        if (!isPlaceholder) continue;
        const r = await api('/api/creatives/' + c.id, { creative_status: 'paused' }, admTok, 'PUT');
        if (r.status === 200) { paused++; console.log('  ⏸ 占位素材 #' + c.id + ' (' + (c.format || '') + ') 已暂停'); }
      }
      console.log('暂停旧占位素材：' + paused + ' 条');
    }
  }

  let ok = 0;
  for (const fmt of ORDER) {
    const t = TPL[fmt];
    const r = await api('/api/creatives', {
      campaign_id: cid, format: fmt, type: t.type, title: t.title, content: t.content,
      media_url: t.media_url || '',
      landing_url: LANDING + '?utm_source=adx&utm_medium=' + fmt,
      width: t.width, height: t.height,
      duration_sec: t.duration_sec || 0,
      creative_status: 'approved',   // 只有 approved 才参与投放
      landing_type: 'h5',
    }, token);
    if (r.status === 200 && r.d && r.d.ok) { ok++; console.log('  ✓ ' + fmt + ' -> creative #' + r.d.id); }
    else console.log('  ✗ ' + fmt + ' -> HTTP ' + r.status + ' ' + JSON.stringify(r.d));
  }
  console.log('\n完成：' + ok + '/' + ORDER.length + ' 条设计师级素材已写入计划 #' + cid + '（状态 approved，可立即投放）');

  // 演示稳定性：素材再好看，计划预算/账户余额耗尽时平台会直接返回 nbr=3 无填充。
  // 这里保证演示计划有充足预算与账户余额（走正规充值接口并留审计记录，不是偷偷改数据）。
  if (admTok && arg('skip-budget', '') !== '1') {
    try {
      const ov = await fetch(BASE + '/api/console/overview', { headers: { Authorization: 'Bearer ' + admTok } });
      const j = await ov.json();
      const c = ((j && j.advertisers) || []).find((x) => Number(x.id) === cid);
      if (c) {
        const left = ((Number(c.budget_micros) || 0) - (Number(c.spend_micros) || 0)) / 1e6;
        console.log('计划 #' + cid + ' 剩余预算 ≈ ¥' + left.toFixed(2));
        if (left < 200) {
          const t = await api('/api/campaign/' + cid + '/topup', { amount_cny: 500, note: '演示保障：补齐计划预算' }, admTok);
          console.log('  充值计划预算：' + (t.status === 200 ? '✓ +¥500' : '✗ HTTP ' + t.status));
        }
        const adv = String(c.advertiser || '');
        if (adv) {
          const r = await api('/api/advertiser/recharge', { advertiser: adv, amount_cny: 500, note: '演示保障：补齐账户余额' }, admTok);
          console.log('  充值账户余额(' + adv + ')：' + (r.status === 200 ? ('✓ 余额 ¥' + r.d.balance_cny) : '✗ HTTP ' + r.status + ' ' + JSON.stringify(r.d)));
        }
      }
    } catch (e) { console.log('（预算保障步骤跳过：' + e.message + '）'); }
  }
  console.log('提示：激励视频若由外部 DSP 胜出，素材库 VAST 不生效；已在 .env 设 RW_MEDIA=/uploads/demo-trailer.mp4 兜底。');
})().catch((e) => { console.error('失败：' + e.message); process.exit(1); });
