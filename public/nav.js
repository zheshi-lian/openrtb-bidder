/* nav.js —— LinkOS ADX 全站唯一顶部导航（v2：按角色分组，替代各页散落的旧 header 导航）
 * 用法：页面 </body> 前引入 <script src="/nav.js"></script>
 * 架构：需求侧（买量） / 供给侧（流量） / 平台运营 / 演示与示例
 */
(function () {
  var GROUPS = [
    { label: '需求侧(买量)', desc: '广告主后台：自助开户 → 建计划/充值 → 传素材 → 创意自动化 → 看投放', items: [
      { href: '/advertiser.html',     label: '广告主控制台' },
      { href: '/creative.html',       label: '素材管理' },
      { href: '/creative-auto.html',  label: '创意自动化' },
      { href: '/dsp.html',            label: 'DSP 接入' },
    ]},
    { label: '供给侧(流量)', desc: '媒体后台：入驻申请 → 嵌入广告位 → 看自己的收益报表', items: [
      { href: '/publisher.html',        label: '媒体入驻' },
      { href: '/publisher_report.html', label: '媒体收益' },
    ]},
    { label: '平台运营(管理员)', desc: '管理员后台：ADX 控制台 / 运营看板 / 结算报表', items: [
      { href: '/console.html',   label: 'ADX 控制台' },
      { href: '/dashboard.html', label: '运营看板' },
      { href: '/reports.html',   label: '结算报表' },
    ]},
    { label: '演示与示例', items: [
      { href: '/media-demo.html', label: '平台演示' },
      { href: '/index.html',      label: 'Prebid 演示' },
      { href: '/ecpm_demo.html',  label: 'eCPM 演示' },
    ]},
    { label: '开户·文档', items: [
      { href: '/register.html',        label: '自助开户' },
      { href: '/pricing.html',         label: '定价' },
      { href: '/docs.html',            label: '接入文档' },
      { href: '/tool/ecpm-score.html', label: '免费eCPM工具' },
    ]},
  ];
  var path = location.pathname;
  var style = document.createElement('style');
  style.textContent =
    '#adx-nav{position:sticky;top:0;z-index:99999;display:flex;align-items:center;gap:4px;background:#1f2430;' +
    'padding:6px 12px;font:13px/1.4 system-ui,"Microsoft YaHei",sans-serif;box-shadow:0 1px 4px rgba(0,0,0,.25)}' +
    '#adx-nav .brand{color:#fff;font-weight:700;margin-right:10px;letter-spacing:.5px;text-decoration:none}' +
    '#adx-nav .grp{position:relative}' +
    '#adx-nav .glabel{display:inline-block;color:#cfd6e4;padding:5px 12px;border-radius:4px;cursor:pointer;user-select:none}' +
    '#adx-nav .grp:hover .glabel,#adx-nav .glabel:hover{background:#323a4d;color:#fff}' +
    '#adx-nav .grp.on .glabel{color:#fff;font-weight:600;box-shadow:inset 0 -2px 0 #3b82f6}' +
    '#adx-nav .menu{display:none;position:absolute;top:100%;left:0;min-width:150px;background:#262d3d;border:1px solid #3a4358;' +
    'border-radius:6px;padding:4px;box-shadow:0 6px 16px rgba(0,0,0,.35)}' +
    '#adx-nav .grp:hover .menu,#adx-nav .grp.open .menu{display:block}' +
    '#adx-nav .menu a{display:block;color:#cfd6e4;text-decoration:none;padding:6px 12px;border-radius:4px;white-space:nowrap}' +
    '#adx-nav .menu a:hover{background:#323a4d;color:#fff}' +
    '#adx-nav .menu a.on{background:#3b82f6;color:#fff;font-weight:600}' +
    '#adx-nav .gdesc{font-size:11px;color:#8a93a6;padding:4px 12px 2px;line-height:1.35;border-bottom:1px solid #3a4358;margin-bottom:2px}';
  document.head.appendChild(style);

  var html = '<a class="brand" href="/home.html">LinkOS ADX</a>';
  for (var g = 0; g < GROUPS.length; g++) {
    var grp = GROUPS[g];
    var grpOn = false;
    for (var j = 0; j < grp.items.length; j++) {
      if (path === grp.items[j].href || (grp.items[j].href === '/media-demo.html' && path === '/')) grpOn = true;
    }
    html += '<div class="grp' + (grpOn ? ' on' : '') + '"><span class="glabel">' + grp.label + '</span><div class="menu"><div class="gdesc">' + (grp.desc || '') + '</div>';
    for (var i = 0; i < grp.items.length; i++) {
      var it = grp.items[i];
      var on = path === it.href || (it.href === '/media-demo.html' && path === '/');
      html += '<a href="' + it.href + '"' + (on ? ' class="on"' : '') + '>' + it.label + '</a>';
    }
    html += '</div></div>';
  }
  var nav = document.createElement('div');
  nav.id = 'adx-nav';
  nav.innerHTML = html +
    '<span style="flex:1"></span>' +
    '<span id="adx-auth">' +
      '<a href="/register.html" style="color:#9aa6c0;text-decoration:none;padding:4px 11px;white-space:nowrap">注册</a>' +
      '<a id="adx-login" href="/login.html" style="color:#7fd1ff;text-decoration:none;padding:4px 11px;border:1px solid #3a4358;border-radius:5px;white-space:nowrap">登录</a>' +
    '</span>';
  document.body.insertBefore(nav, document.body.firstChild);
  // 点击切换（兼容不响应 hover 的环境）；点击其它区域收起
  nav.addEventListener('click', function (e) {
    var grp = e.target.closest ? e.target.closest('.grp') : null;
    var open = nav.querySelectorAll('.grp.open');
    for (var k = 0; k < open.length; k++) if (open[k] !== grp) open[k].classList.remove('open');
    if (grp && e.target.classList && e.target.classList.contains('glabel')) grp.classList.toggle('open');
  });
  document.addEventListener('click', function (e) {
    if (!nav.contains(e.target)) {
      var open = nav.querySelectorAll('.grp.open');
      for (var k = 0; k < open.length; k++) open[k].classList.remove('open');
    }
  });
  // 右上角：公共站导航只显示入口，不显示身份。
  // 身份（账号 + 作用域 + 登出）属于控制台，由 console_top.js 渲染——绝不污染营销页。
  // 只认 admin.js 的会话键 adx_admin（旧 auth_token/auth_user 键是遗留垃圾，已停读）。
  (function () {
    var box = document.getElementById('adx-auth'); if (!box) return;
    var cur = function (k) { return localStorage.getItem(k) || sessionStorage.getItem(k) || ''; };
    var me = null;
    try { me = cur('adx_admin') ? JSON.parse(cur('adx_admin')) : null; } catch (e) { me = null; }
    if (me && me.token) {
      var home = me.type === 'advertiser' ? '/advertiser.html'
               : (me.type === 'publisher' ? '/publisher_report.html' : '/console.html');
      box.innerHTML = '<a href="' + home + '" style="color:#04122a;text-decoration:none;padding:4px 12px;border-radius:5px;background:linear-gradient(92deg,#3b82f6,#22d3ee);white-space:nowrap;font-weight:600">进入我的后台</a>';
    }
  })();
})();
