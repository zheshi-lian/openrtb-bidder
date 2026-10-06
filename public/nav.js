/* nav.js —— AppLink 全站唯一顶部导航（v2：按角色分组，替代各页散落的旧 header 导航）
 * 用法：页面 </body> 前引入 <script src="/nav.js"></script>
 * 架构：广告主 · 投放（买量） / 开发者 · 变现（流量） / 平台运营 / 演示与示例
 */
(function () {
  // 已登录开发者 vs 未入驻访客：开发者链路的首个入口不同。
  // 对标竞品（AppLovin / 汇量）：入驻是一次性动作，入驻完成后不再展示"去入驻"，只给入驻与接入信息。
  // 角色链路（竞品口径：AppLovin ADVERTISE / MAX、汇量 Mintegral 都是「买量」与「变现」两套独立账号体系）。
  // 已登录某角色后，另一条链路的工作台入口在导航里置灰并说明原因 ——
  // 而不是让人点进去、页面加载出来再被一脚踢回本职工作台（闪一下就跳走，像坏了）。
  function curTop(k) { return localStorage.getItem(k) || sessionStorage.getItem(k) || ''; }
  var ROLE = {
    admin:      { cn: '平台运营', tone: '#f59e0b', home: '/console.html',          flow: '平台运营' },
    advertiser: { cn: '广告主',   tone: '#3b82f6', home: '/campaigns.html',        flow: '广告主投放' },
    publisher:  { cn: '开发者',   tone: '#22c55e', home: '/publisher_report.html', flow: '开发者变现' },
  };
  var _meTop = null;
  try { _meTop = curTop('applink_admin') ? JSON.parse(curTop('applink_admin')) : null; } catch (e) { _meTop = null; }
  var myType = (_meTop && _meTop.token && ROLE[_meTop.type]) ? _meTop.type : '';   // '' = 未登录
  // 登录者视觉标识：未登录不显示徽标，避免误导"我已经是XX角色"
  var myLabel = myType ? ROLE[myType].cn : '';
  var mePub = !!(_meTop && _meTop.type === 'publisher' && _meTop.token);
  // item.roles 未声明 = 全角色可用；'guest' 代表未登录也可见
  function allowed(item) {
    if (!item.roles) return true;
    if (!myType) return item.roles.indexOf('guest') >= 0;
    return item.roles.indexOf(myType) >= 0;
  }
  var ADV_ROLES = ['advertiser', 'admin', 'guest'];
  var PUB_ROLES = ['publisher', 'admin', 'guest'];
  var GROUPS = [
    // 与控制台顶栏「取并集」：这里列出的 = 该角色进去后实际能看到的全部模块，避免"外面4个、进去6个"
    { label: 'Advertiser · 广告主投放', flow: '广告主投放', desc: '开户 → 充值 → 建计划 → 传素材 → 创意自动化 → 审核 → 归因 → 投放看数（对标 AppLovin ADVERTISE）', items: [
      { href: '/register.html', label: '自助开户', roles: ['advertiser', 'guest'] },
      { href: '/campaigns.html',     label: '广告系列 Campaigns', roles: ADV_ROLES },
      { href: '/adv-media.html',      label: '素材库 Media Library', roles: ADV_ROLES },
      { href: '/analytics.html',      label: '报表 Analytics', roles: ADV_ROLES },
      { href: '/adv-account.html',    label: '账户 Account', roles: ADV_ROLES },
    ]},
    { label: 'Publisher · 开发者变现', flow: '开发者变现', desc: '入驻链路：注册开发者 → 创建应用 → 集成 SDK → 添加广告单元 → 集成自检 → 审核/品牌安全 → 看收益与结算（对标 AppLovin MAX Onboarding / Mintegral Monetization）', items: [
      // 未入驻给公共入驻入口；已登录即已入驻，给只读的接入引导向导（条件显示，避免重复引导）
      mePub ? { href: '/publisher.html', label: '接入引导向导', roles: PUB_ROLES }
            : { href: '/register.html#publisher', label: '开发者入驻', roles: ['publisher', 'guest'] },
      { href: '/publisher_report.html', label: '概览/报表', roles: PUB_ROLES },
      { href: '/ad_units.html',         label: '应用与版位（运营区）', roles: PUB_ROLES },
      { href: '/pub-review.html',       label: '审核/品牌安全', roles: PUB_ROLES },
      { href: '/pub-account.html',      label: '账户与结算', roles: PUB_ROLES },
    ]},
    // 平台运营【不进公共导航】：对标 AppLovin / 汇量——官网导航只放「角色入口（广告主/开发者）+ 文档/定价/登录」，
    // 内部运营模块（控制台 / 大盘 / 结算 / 审核台）只在登录后的控制台顶栏出现。
    // 否则它既与右上角「进入广告主投放 / 开发者变现」语义重叠，又把内部运营入口暴露在官网导航上。
    { label: '演示与示例', items: [
      { href: '/media-demo.html', label: '平台演示' },
      { href: '/index.html',      label: 'Prebid 演示' },
      { href: '/ecpm_demo.html',  label: 'eCPM 演示' },
    ]},
    { label: '开户·文档', items: [
      { href: '/register.html',    label: '自助开户' },
      { href: '/pricing.html',         label: '定价' },
      { href: '/docs.html',            label: '接入文档' },
      { href: '/sdk-guide.html',       label: '原生 SDK 接入（iOS/Android）' },
      { href: '/dsp.html',             label: '外部 DSP 接入（需求方）' },
      { href: '/tool/ecpm-score.html', label: '免费eCPM工具' },
    ]},
  ];
  function lockTip(flow) {
    if (!myType) return '';
    return '当前登录身份为「' + myLabel + '」，' + flow + '属于另一条独立链路，需要用对应的 ' + flow + ' 账号登录。点击菜单项查看原因与下一步。';
  }
  // 跨链路被挡时给「说明 + 下一步」，而不是静默跳走或直接踢回本职后台
  function showLocked(flow, item) {
    if (!myType || !ROLE[myType]) return;   // 未登录不存在"跨链路被挡"，永不弹这个框
    var old = document.getElementById('applink-lock'); if (old) old.remove();
    var want = (flow.indexOf('开发者') >= 0 || flow.indexOf('Publisher') >= 0) ? 'publisher' : 'advertiser';
    var wantCn = ROLE[want].cn;
    var isSameLogin = (_meTop && ROLE[want]);
    var ov = document.createElement('div');
    ov.id = 'applink-lock';
    ov.style.cssText = 'position:fixed;inset:0;z-index:1000000;background:rgba(3,8,20,.72);display:flex;align-items:center;justify-content:center;padding:20px';
    ov.innerHTML =
      '<div style="max-width:460px;background:#16203a;border:1px solid #26355c;border-radius:14px;padding:20px 22px;' +
      'font:13.5px/1.75 system-ui,\'Microsoft YaHei\',sans-serif;color:#e8eefc;box-shadow:0 16px 44px rgba(0,0,0,.55)">' +
        '<div style="font-size:15px;font-weight:700;margin-bottom:10px">当前账号无权进入「' + flow + '」</div>' +
        '<div style="color:#b8c6e2">你正以 <b style="color:' + ROLE[myType].tone + '">' + myLabel + '</b>' +
          (isSameLogin ? '（' + (_meTop.username || '') + '）' : '') + ' 身份登录，刚刚点击的是 <b>' + item + '</b>。<br>' +
          '买量（广告主投放）与变现（开发者变现）是<b>两套互相隔离的账号体系</b>：各自有独立的账号、数据与结算，' +
          '一个账号只能看到自己链路内的数据（对标 AppLovin ADVERTISE / MAX、汇量 Mintegral）。</div>' +
        '<div style="margin-top:16px;display:flex;gap:8px;flex-wrap:wrap">' +
          '<a href="/login.html" style="flex:1;min-width:150px;text-align:center;background:linear-gradient(92deg,#3b82f6,#22d3ee);' +
            'color:#04122a;border:0;border-radius:8px;padding:9px 14px;font-weight:700;text-decoration:none">切换 / 登录' + wantCn + '账号</a>' +
          '<a href="/register.html#' + want + '" style="flex:1;min-width:150px;text-align:center;background:#1f2942;' +
            'color:#e8eefc;border:1px solid #26355c;border-radius:8px;padding:9px 14px;text-decoration:none">还没有？免费' +
            (want === 'publisher' ? '入驻开发者' : '开广告主户') + '</a>' +
        '</div>' +
        '<div style="margin-top:12px;display:flex;gap:8px">' +
          '<a href="' + ROLE[myType].home + '" style="flex:1;text-align:center;background:#10182e;color:#9fb4dc;border:1px solid #26355c;' +
            'border-radius:8px;padding:8px 14px;text-decoration:none">回我的' + ROLE[myType].flow + '工作台</a>' +
          '<button type="button" style="flex:1;background:transparent;color:#8a93a6;border:1px solid #26355c;border-radius:8px;' +
            'padding:8px 14px;cursor:pointer;font:inherit" data-close>知道了</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(ov);
    ov.addEventListener('click', function (e) {
      if (e.target === ov || (e.target.dataset && e.target.dataset.close !== undefined)) ov.remove();
    });
  }

  var path = location.pathname;
  var style = document.createElement('style');
  style.textContent =
    '#applink-nav{position:sticky;top:0;z-index:99999;display:flex;align-items:center;gap:2px;' +
    'padding:0 16px;height:56px;font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;' +
    'background:linear-gradient(180deg,rgba(14,20,40,.97),rgba(9,13,28,.92));' +
    'backdrop-filter:blur(16px) saturate(160%);-webkit-backdrop-filter:blur(16px) saturate(160%);' +
    'border-bottom:1px solid rgba(255,255,255,.07);' +
    'box-shadow:inset 0 1px 0 rgba(255,255,255,.04),0 12px 32px -20px rgba(0,0,0,.75)}' +
    '#applink-nav .brand{color:#fff;font-weight:800;margin-right:18px;letter-spacing:.3px;text-decoration:none;font-size:15.5px}' +
    '#applink-nav .grp{position:relative}' +
    '#applink-nav .glabel{display:inline-flex;align-items:center;color:#a3aec8;padding:8px 13px;border-radius:9px;cursor:pointer;' +
    'user-select:none;font-weight:500;transition:color .16s ease,background .16s ease}' +
    '#applink-nav .grp:hover .glabel,#applink-nav .glabel:hover{background:rgba(255,255,255,.07);color:#fff}' +
    '#applink-nav .grp.on .glabel{color:#fff;font-weight:600;background:rgba(56,189,248,.13)}' +
    '#applink-nav .menu{display:none;position:absolute;top:calc(100% + 9px);left:0;min-width:196px;' +
    'background:rgba(19,26,48,.97);backdrop-filter:blur(18px) saturate(160%);-webkit-backdrop-filter:blur(18px) saturate(160%);' +
    'border:1px solid rgba(255,255,255,.1);border-radius:13px;padding:6px;' +
    'box-shadow:0 22px 48px -16px rgba(0,0,0,.7),0 2px 10px rgba(0,0,0,.32)}' +
    '#applink-nav .grp:hover .menu,#applink-nav .grp.open .menu{display:block}' +
    '#applink-nav .menu a{display:block;color:#b6c1da;text-decoration:none;padding:8px 12px;border-radius:9px;white-space:nowrap;' +
    'transition:color .16s ease,background .16s ease}' +
    '#applink-nav .menu a:hover{background:rgba(255,255,255,.07);color:#fff}' +
    '#applink-nav .menu a.on{background:linear-gradient(92deg,rgba(56,189,248,.92),rgba(34,211,238,.86));color:#04122a;font-weight:700}' +
    '#applink-nav .gdesc{font-size:11px;color:#77839d;padding:6px 12px 8px;line-height:1.5;' +
    'border-bottom:1px solid rgba(255,255,255,.07);margin-bottom:4px}' +
    /* 跨链路项：置灰但可见。参考 AppLovin/汇量——另一条链路的入口仍展示（说明平台有这条能力），
       只是明确"当前账号不能进"，并给下一步。不做"直接消失"，否则用户会以为什么功能都没有。 */
    '#applink-nav .menu .dis{display:block;color:#5c6680;text-decoration:none;padding:8px 12px;border-radius:9px;' +
    'white-space:nowrap;cursor:help;font-size:13px;opacity:.85;transition:color .16s ease,background .16s ease,opacity .16s ease}' +
    '#applink-nav .menu .dis:hover{background:rgba(255,255,255,.045);color:#7c88a5;opacity:1}' +
    '#applink-nav .grp.locked .glabel{color:#66708a}' +
    '#applink-nav .grp.locked .glabel:hover{background:rgba(255,255,255,.05);color:#8994b0}' +
    /* 右上角账号菜单（切换账号 / 登出）：登录后必须能退出，否则用户被困在当前账号里 */
    '#applink-nav .navm{position:relative}' +
    '#applink-nav .navm-btn{background:linear-gradient(92deg,#38bdf8,#22d3ee);color:#04122a;border:0;border-radius:9px;' +
    'padding:7px 13px;font-weight:700;font-size:13px;cursor:pointer;white-space:nowrap;font-family:inherit;' +
    'box-shadow:0 6px 18px -6px rgba(34,211,238,.55);transition:transform .16s ease,box-shadow .16s ease}' +
    '#applink-nav .navm-btn:hover{transform:translateY(-1px);box-shadow:0 10px 24px -6px rgba(34,211,238,.7)}' +
    '#applink-nav .navm-caret{font-size:10px;opacity:.75}' +
    '#applink-nav .navm-menu{display:none;position:absolute;right:0;top:calc(100% + 8px);min-width:216px;' +
    'background:rgba(19,26,48,.98);backdrop-filter:blur(18px) saturate(160%);-webkit-backdrop-filter:blur(18px) saturate(160%);' +
    'border:1px solid rgba(255,255,255,.1);border-radius:13px;padding:6px;' +
    'box-shadow:0 22px 48px -16px rgba(0,0,0,.7);z-index:100000}' +
    '#applink-nav .navm-menu.open{display:block}' +
    '#applink-nav .navm-hd{padding:8px 10px 6px;font-weight:700;font-size:12.5px;color:#fff}' +
    '#applink-nav .navm-it{display:block;width:100%;text-align:left;padding:8px 10px;border:0;background:transparent;' +
    'color:#b6c1da;text-decoration:none;font-size:12.5px;border-radius:9px;cursor:pointer;font-family:inherit;' +
    'transition:color .16s ease,background .16s ease}' +
    '#applink-nav .navm-it:hover{background:rgba(255,255,255,.07);color:#fff}' +
    '#applink-nav .navm-out{color:#fb7185;margin-top:4px;border-top:1px solid rgba(255,255,255,.08);' +
    'border-radius:0 0 9px 9px;padding-top:10px}' +
    '#applink-nav .navm-out:hover{color:#fb7185;background:rgba(251,113,133,.13)}';
  document.head.appendChild(style);

  var html = '<a class="brand" href="/home.html">AppLink</a>';
  for (var g = 0; g < GROUPS.length; g++) {
    var grp = GROUPS[g];
    var grpOn = false, locked = 0;
    for (var j = 0; j < grp.items.length; j++) {
      if (path === grp.items[j].href || (grp.items[j].href === '/media-demo.html' && path === '/')) grpOn = true;
      if (!allowed(grp.items[j])) locked++;
    }
    // 整组都被当前角色锁住 → 组标签也降亮度并给出原因；部分锁住则只锁对应项。
    var grpLocked = locked > 0 && locked === grp.items.length;
    html += '<div class="grp' + (grpOn ? ' on' : '') + (grpLocked ? ' locked' : '') + '">' +
      '<span class="glabel"' + (grpLocked ? ' title="' + lockTip(grp.flow || grp.label) + '"' : '') + '>' +
      grp.label + '</span>' +
      '<div class="menu"><div class="gdesc">' + (grp.desc || '') + '</div>';
    for (var i = 0; i < grp.items.length; i++) {
      var it = grp.items[i];
      var on = path === it.href || (it.href === '/media-demo.html' && path === '/');
      if (!allowed(it)) {
        html += '<span class="dis" data-flow="' + (grp.flow || grp.label) + '" data-item="' + it.label + '" title="点击了解原因与下一步">' +
          it.label + '</span>';
        continue;
      }
      html += '<a href="' + it.href + '"' + (on ? ' class="on"' : '') + '>' + it.label + '</a>';
    }
    html += '</div></div>';
  }
  // 复用已有的 #applink-nav（如 home.html 的静态容器），避免与 nav.js 注入的再叠加成两条导航；
  // 没有时才新建并插到 body 顶部（其余营销页走这条）。
  var existing = document.getElementById('applink-nav');
  var nav = existing || document.createElement('div');
  nav.id = 'applink-nav';
  nav.innerHTML = html +
    '<span style="flex:1"></span>' +
    '<span id="applink-auth">' +
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
  // 跨链路项被点击：拦下来，弹出「为什么 + 下一步」，绝不真的导航过去（避免进页面再被弹回的闪跳）
  nav.addEventListener('click', function (e) {
    var el = e.target && e.target.closest ? e.target.closest('.dis') : null;
    if (!el) return;
    e.preventDefault(); e.stopPropagation();
    showLocked(el.getAttribute('data-flow') || '', el.getAttribute('data-item') || '');
  });
  // 右上角：公共站导航只显示入口，不显示身份。
  // 身份（账号 + 作用域 + 登出）属于控制台，由 console_top.js 渲染——绝不污染营销页。
  // 只认 admin.js 的会话键 applink_admin（旧 auth_token/auth_user 键是遗留垃圾，已停读）。
  (function () {
    var box = document.getElementById('applink-auth'); if (!box) return;
    var cur = function (k) { return localStorage.getItem(k) || sessionStorage.getItem(k) || ''; };
    var me = null;
    try { me = cur('applink_admin') ? JSON.parse(cur('applink_admin')) : null; } catch (e) { me = null; }
    if (!me || !me.token) return;   // 未登录：保留「注册 / 登录」链接
    var esc = function (s) {
      return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
      });
    };
    var home = me.type === 'advertiser' ? '/campaigns.html'
             : (me.type === 'publisher' ? '/publisher_report.html' : '/console.html');
    var homeLabel = me.type === 'advertiser' ? '进入广告主投放'
                  : (me.type === 'publisher' ? '进入开发者变现' : '管理后台');
    // 原先登录后只有一个「进入XX」芯片：已在该工作台时点了只是刷新自己（像没用），
    // 而且全站没有任何登出/切换账号入口 → 用户被困在当前账号里。这里补成真正的账号菜单。
    var homeItem = (location.pathname === home) ? ''
      : '<a class="navm-it" href="' + home + '">' + homeLabel + '</a>';
    box.innerHTML =
      '<div class="navm">' +
        '<button class="navm-btn" type="button">' + esc(me.username || me.type) + ' <span class="navm-caret">▾</span></button>' +
        '<div class="navm-menu">' +
          '<div class="navm-hd"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;' +
            'background:' + ((ROLE[me.type] || {}).tone || '#64748b') + ';margin-right:6px"></span>' +
            esc((ROLE[me.type] || {}).cn || me.type || '') + ' · ' + esc(me.username || '') + '</div>' +
          '<div style="padding:2px 10px 8px;font-size:11.5px;color:#8a93a6;line-height:1.5">' +
            '本账号仅可访问「' + esc((ROLE[me.type] || {}).flow || '') + '」链路；另一条链路的入口在导航里已置灰。</div>' +
          homeItem +
          '<a class="navm-it" href="/login.html">切换 / 登录其他账号</a>' +
          '<button class="navm-it navm-out" type="button">登出</button>' +
        '</div>' +
      '</div>';
    var btn = box.querySelector('.navm-btn');
    var menu = box.querySelector('.navm-menu');
    var outBtn = box.querySelector('.navm-out');
    if (btn && menu) {
      btn.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); menu.classList.toggle('open'); });
      menu.addEventListener('click', function (e) { e.stopPropagation(); });   // 点菜单内部不关闭
    }
    document.addEventListener('click', function () { if (menu) menu.classList.remove('open'); });
    if (outBtn) outBtn.addEventListener('click', function (e) {
      e.preventDefault(); e.stopPropagation();
      try { localStorage.removeItem('applink_admin'); sessionStorage.removeItem('applink_admin'); } catch (err) {}
      ['auth_token', 'auth_role', 'auth_scope', 'auth_user'].forEach(function (k) {
        try { localStorage.removeItem(k); sessionStorage.removeItem(k); } catch (err) {}
      });
      fetch('/api/admin/logout', { method: 'POST' }).catch(function () {});
      location.href = '/login.html';   // 落到登录页，方便直接换账号（与控制台顶栏登出行为一致）
    });
  })();
})();
