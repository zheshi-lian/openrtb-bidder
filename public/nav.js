/* nav.js —— LinkOS 全站唯一顶部导航（v2：按角色分组，替代各页散落的旧 header 导航）
 * 用法：页面 </body> 前引入 <script src="/nav.js"></script>
 * 架构：广告主 · 投放（买量） / 开发者 · 变现（流量） / 平台运营 / 演示与示例
 */
(function () {
  // 已登录开发者 vs 未入驻访客：开发者链路的首个入口不同。
  // 对标竞品（AppLovin / 汇量）：入驻是一次性动作，入驻完成后不再展示"去入驻"，只给入驻与接入信息。
  function curTop(k) { return localStorage.getItem(k) || sessionStorage.getItem(k) || ''; }
  var _meTop = null;
  try { _meTop = curTop('linkos_admin') ? JSON.parse(curTop('linkos_admin')) : null; } catch (e) { _meTop = null; }
  var mePub = !!(_meTop && _meTop.type === 'publisher' && _meTop.token);
  var GROUPS = [
    // 与控制台顶栏「取并集」：这里列出的 = 该角色进去后实际能看到的全部模块，避免"外面4个、进去6个"
    { label: '广告主 · 投放', desc: '开户 → 充值 → 建计划 → 传素材 → 创意自动化 → 审核 → 投放看数（对标 AppLovin ADVERTISE / AppDiscovery）', items: [
      { href: '/register.html#advertiser', label: '自助开户' },
      { href: '/advertiser.html',     label: '工作台（充值 / 建计划 / 审核 / 看数）' },
      { href: '/creative.html',       label: '素材管理' },
      { href: '/creative-auto.html',  label: '创意自动化' },
    ]},
    { label: '开发者 · 变现', desc: '入驻 → 添加应用 → 建广告单元 → 埋 SDK → 集成自检 → 看收益（对标 AppLovin MAX / 汇量 Mintegral）', items: [
      // 未入驻给公共入驻入口；已登录即已入驻，给只读的入驻与接入信息（条件显示，避免重复引导）
      mePub ? { href: '/publisher.html', label: '入驻与接入' } : { href: '/register.html#publisher', label: '开发者入驻' },
      { href: '/apps.html',             label: '应用' },
      { href: '/ad_units.html',         label: '广告单元' },
      { href: '/sdk-guide.html',        label: '原生 SDK 接入' },
      { href: '/integrity.html',        label: '集成自检' },
      { href: '/publisher_report.html', label: '收益报表' },
    ]},
    // 平台运营【不进公共导航】：对标 AppLovin / 汇量——官网导航只放「角色入口（广告主/开发者）+ 文档/定价/登录」，
    // 内部运营模块（控制台 / 大盘 / 结算 / 审核台）只在登录后的控制台顶栏出现。
    // 否则它既与右上角「进入广告主投放 / 开发者变现」语义重叠，又把内部运营入口暴露在官网导航上。
    { label: '演示与示例', items: [
      { href: '/media-demo.html', label: '平台演示' },
      { href: '/index.html',      label: 'Prebid 演示' },
      { href: '/ecpm_demo.html',  label: 'eCPM 演示' },
      { href: '/advanced.html',   label: '高级能力台' },
      // 外部需求方接入 = 让买方来买我们的流量（我们是卖方），属高级/商务对接，不进任何角色的日常链路
      { href: '/dsp.html',        label: '外部 DSP 接入' },
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
    '#linkos-nav{position:sticky;top:0;z-index:99999;display:flex;align-items:center;gap:4px;background:#1f2430;' +
    'padding:6px 12px;font:13px/1.4 system-ui,"Microsoft YaHei",sans-serif;box-shadow:0 1px 4px rgba(0,0,0,.25)}' +
    '#linkos-nav .brand{color:#fff;font-weight:700;margin-right:10px;letter-spacing:.5px;text-decoration:none}' +
    '#linkos-nav .grp{position:relative}' +
    '#linkos-nav .glabel{display:inline-block;color:#cfd6e4;padding:5px 12px;border-radius:4px;cursor:pointer;user-select:none}' +
    '#linkos-nav .grp:hover .glabel,#linkos-nav .glabel:hover{background:#323a4d;color:#fff}' +
    '#linkos-nav .grp.on .glabel{color:#fff;font-weight:600;box-shadow:inset 0 -2px 0 #3b82f6}' +
    '#linkos-nav .menu{display:none;position:absolute;top:100%;left:0;min-width:150px;background:#262d3d;border:1px solid #3a4358;' +
    'border-radius:6px;padding:4px;box-shadow:0 6px 16px rgba(0,0,0,.35)}' +
    '#linkos-nav .grp:hover .menu,#linkos-nav .grp.open .menu{display:block}' +
    '#linkos-nav .menu a{display:block;color:#cfd6e4;text-decoration:none;padding:6px 12px;border-radius:4px;white-space:nowrap}' +
    '#linkos-nav .menu a:hover{background:#323a4d;color:#fff}' +
    '#linkos-nav .menu a.on{background:#3b82f6;color:#fff;font-weight:600}' +
    '#linkos-nav .gdesc{font-size:11px;color:#8a93a6;padding:4px 12px 2px;line-height:1.35;border-bottom:1px solid #3a4358;margin-bottom:2px}';
  document.head.appendChild(style);

  var html = '<a class="brand" href="/home.html">LinkOS</a>';
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
  // 复用已有的 #linkos-nav（如 home.html 的静态容器），避免与 nav.js 注入的再叠加成两条导航；
  // 没有时才新建并插到 body 顶部（其余营销页走这条）。
  var existing = document.getElementById('linkos-nav');
  var nav = existing || document.createElement('div');
  nav.id = 'linkos-nav';
  nav.innerHTML = html +
    '<span style="flex:1"></span>' +
    '<span id="linkos-auth">' +
      '<a href="/register.html" style="color:#9aa6c0;text-decoration:none;padding:4px 11px;white-space:nowrap">注册</a>' +
      '<a id="平台-login" href="/login.html" style="color:#7fd1ff;text-decoration:none;padding:4px 11px;border:1px solid #3a4358;border-radius:5px;white-space:nowrap">登录</a>' +
    '</span>';
  if (!existing) document.body.insertBefore(nav, document.body.firstChild);
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
  // 只认 admin.js 的会话键 linkos_admin（旧 auth_token/auth_user 键是遗留垃圾，已停读）。
  (function () {
    var box = document.getElementById('linkos-auth'); if (!box) return;
    var cur = function (k) { return localStorage.getItem(k) || sessionStorage.getItem(k) || ''; };
    var me = null;
    try { me = cur('linkos_admin') ? JSON.parse(cur('linkos_admin')) : null; } catch (e) { me = null; }
    if (me && me.token) {
      var home = me.type === 'advertiser' ? '/advertiser.html'
               : (me.type === 'publisher' ? '/publisher_report.html' : '/console.html');
      var authLabel = me.type === 'advertiser' ? '进入广告主投放'
                    : (me.type === 'publisher' ? '进入开发者变现' : '管理后台');
      box.innerHTML = '<a href="' + home + '" style="color:#04122a;text-decoration:none;padding:4px 12px;border-radius:5px;background:linear-gradient(92deg,#3b82f6,#22d3ee);white-space:nowrap;font-weight:600">' + authLabel + '</a>';
    }
  })();
})();
