/* console_top.js —— 控制台统一定位栏（所有受控后台页共用）
 *
 * 第一性原理：
 *   ① 控制台必须有「持久导航」——品牌(回官网) + 本角色可访问的模块 + 官网出口。
 *   ② 身份永远在右上角（对标 AppLovin / 汇量），左上角只放品牌。
 *   ③ 权限不由这里决定，真闸门在 server.js 的 requireAuth(...)。
 *   ④ 【链路 ≠ 账号权限】两者必须分开：
 *        flow = 业务链路上的环节（投放链路 / 变现链路 / 运营审核链路），按角色不同；
 *        acct = 账号与权限、账号安全——是"账号维度"的东西，不属于任何业务链路，
 *              放在右上角账号菜单里，不混进链路 tab，否则会让人以为"变现链路里有一环叫账号权限"。
 *
 * 用法：<body> 后放 <div id="ctop"></div>，</body> 前引入本脚本（需先引入 /admin.js）
 */
window.ConsoleTop = (function () {
  var META = {
    admin: {
      label: '平台运营', tone: '#f59e0b', home: '/console.html',
      // 运营不是业务链路，是"审核 + 看数 + 结算 + 接入管控"：
      // 审核台与素材管理分开（对标汇量：创意素材=广告主侧，素材审核标准=平台侧）
      // 外部需求方接入(dsp.html)属「演示/高级接入」，不是运营日常链路环节 → 不占 tab
      flow: [['/console.html', '控制台'], ['/dashboard.html', '实时大盘'],
             ['/reports.html', '结算报表'], ['/review.html', '审核台'], ['/strategy.html', '策略配置'], ['/advanced.html', '高级能力']],
      acct: [['/account.html', '账号与权限'], ['/security.html', '账号安全']]
    },
    advertiser: {
      label: '广告主', tone: '#3b82f6', home: '/advertiser.html',
      // 投放链路：建计划 → 素材 → 创意自动化
      flow: [['/advertiser.html', '工作台'], ['/creative.html', '素材管理'],
             ['/creative-auto.html', '创意自动化']],
      acct: [['/security.html', '账号安全']]
    },
    publisher: {
      label: '开发者', tone: '#22c55e', home: '/publisher_report.html',
      // 变现链路（对标 AppLovin MAX / 汇量 Mintegral）：
      // 入驻取密钥 → 添加应用 → 建广告单元 → 埋 SDK 并自检 → 看收益收款
      flow: [['/publisher.html', '入驻与接入'], ['/apps.html', '应用'], ['/ad_units.html', '广告单元'],
             ['/integrity.html', '集成自检'], ['/sdk-guide.html', '原生 SDK 接入'], ['/publisher_report.html', '收益报表']],
      acct: [['/security.html', '账号安全']]
    }
  };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function isDark() {
    var m = (getComputedStyle(document.body).backgroundColor || '').match(/\d+/g);
    if (!m) return true;
    return (0.299 * (+m[0]) + 0.587 * (+m[1]) + 0.114 * (+((m[2] != null) ? m[2] : 0))) < 140;
  }
  function setTheme(h, dark, chip) {
    h.className = 'ctop ' + (chip ? 'chip' : 'bar');
    h.style.setProperty('--ct-bg', dark ? '#0d1526' : '#ffffff');
    h.style.setProperty('--ct-bd', dark ? '#26355c' : '#e2e8f0');
    h.style.setProperty('--ct-fg', dark ? '#e8eefc' : '#0f172a');
    h.style.setProperty('--ct-mut', dark ? '#93a3c4' : '#64748b');
    h.style.setProperty('--ct-chip', dark ? '#132038' : '#f1f5f9');
  }
  // ④ 导航按「当前页面所在业务链路」决定，而不是按登录角色：
  //   广告主漏斗页 → 投放链路 tab；开发者漏斗页 → 变现链路 tab；
  //   运营/平台/账号类页面才按角色（默认平台运营）。
  var ADV_PAGES = ['/advertiser.html', '/creative.html', '/creative-auto.html'];
  var PUB_PAGES = ['/publisher.html', '/apps.html', '/ad_units.html', '/integrity.html', '/sdk-guide.html', '/publisher_report.html'];
  function pickMeta(me) {
    var p = location.pathname;
    if (ADV_PAGES.indexOf(p) >= 0) return META.advertiser;
    if (PUB_PAGES.indexOf(p) >= 0) return META.publisher;
    return (me && me.type && META[me.type]) || META.admin;
  }
  function render() {
    var h = document.getElementById('ctop');
    if (!h) return;
    var bodyMargin = parseFloat(getComputedStyle(document.body).marginTop) || 0;
    setTheme(h, isDark(), bodyMargin > 0);

    var me = (window.Auth && Auth.get()) || null;
    var here = location.pathname;

    // 未登录：品牌 + 官网出口 + 登录
    if (!me || !me.token) {
      h.innerHTML = '<div class="ct-in">' +
        '<a class="ct-brand" href="/home.html" title="回到官网首页">◀ LinkOS</a>' +
        '<span class="ct-sp"></span>' +
        '<a class="ct-home" href="/home.html">官网首页</a>' +
        '<a class="ct-lnk" href="/login.html">登录</a>' +
        '</div>';
      return;
    }

    var m = pickMeta(me) || { label: me.type, tone: '#8aa0c8', home: '/console.html', flow: [], acct: [] };
    // ④ 业务链路 tab
    var tabs = (m.flow || []).map(function (t) {
      return '<a href="' + t[0] + '" class="ct-tab' + (here === t[0] ? ' on' : '') + '">' + t[1] + '</a>';
    }).join('');
    // ④ 账号维度入口（不进链路 tab，进右上账号菜单）
    var acctItems = (m.acct || []).map(function (a) {
      return '<a class="ct-menu-it" href="' + a[0] + '">' + a[1] + '</a>';
    }).join('');

    h.innerHTML =
      '<div class="ct-in">' +
        '<a class="ct-brand" href="/home.html" title="回到官网首页">◀ LinkOS</a>' +
        '<span class="ct-tabs">' + tabs + '</span>' +
        '<span class="ct-sp"></span>' +
        '<a class="ct-home" href="/home.html" title="回到官网首页">官网首页</a>' +
        '<button class="ct-acc-btn" onclick="ConsoleTop.toggle(event)" title="账号与权限">' +
          '<span class="ct-dot" style="background:' + m.tone + '"></span>' +
          '<span class="ct-accname">' + esc(me.username) + '</span>' +
          '<span class="ct-caret">▾</span>' +
        '</button>' +
        '<div class="ct-menu" id="ct-menu">' +
          '<div class="ct-menu-hd">' + esc(m.label) + ' · ' + esc(me.username) + '</div>' +
          '<div class="ct-menu-row">数据作用域：<b>' + esc(me.scope || '*') + '</b></div>' +
          '<div class="ct-menu-row ct-menu-dim">只能看到该作用域内的数据</div>' +
          '<a class="ct-menu-it" href="' + m.home + '">' + (me.type === 'advertiser' ? '我的广告主投放台' : (me.type === 'publisher' ? '我的开发者变现台' : '我的运营台')) + '</a>' +
          acctItems +
          '<a class="ct-menu-it" href="/home.html">返回官网首页</a>' +
          '<a class="ct-menu-it" href="/login.html">切换 / 登录其他账号</a>' +
          '<button class="ct-menu-it ct-menu-out" onclick="ConsoleTop.logout()">登出</button>' +
        '</div>' +
      '</div>';
  }
  function toggle(e) {
    if (e) { e.preventDefault(); e.stopPropagation(); }
    var m = document.getElementById('ct-menu');
    if (m) m.classList.toggle('open');
  }
  function logout() {
    try { localStorage.removeItem('linkos_admin'); sessionStorage.removeItem('linkos_admin'); } catch (e) {}
    ['auth_token', 'auth_role', 'auth_scope', 'auth_user'].forEach(function (k) {
      try { localStorage.removeItem(k); sessionStorage.removeItem(k); } catch (e) {}
    });
    fetch('/api/admin/logout', { method: 'POST' }).catch(function () {});
    location.href = '/login.html';
  }
  return { render: render, logout: logout, toggle: toggle, META: META };
})();

(function () {
  function injectStyle() {
    // 始终以本脚本的权威样式为准：若页面自带旧版 #ctop-css（不含 .ct-tabs/.ct-tab 等新规则），
    // 会导致后台 tab 退化为浏览器默认紫色链接、无间距 → 先移除再注入，保证所有后台页视觉一致。
    var ex = document.getElementById('ctop-css');
    if (ex && ex.getAttribute('data-ctop') === 'authored') return;
    if (ex && ex.parentNode) ex.parentNode.removeChild(ex);
    var st = document.createElement('style');
    st.id = 'ctop-css';
    st.setAttribute('data-ctop', 'authored');
    st.textContent =
      '.ctop{color:var(--ct-fg);font:12.5px/1.4 system-ui,"Microsoft YaHei",sans-serif;box-sizing:border-box}' +
      '.ctop.bar{background:var(--ct-bg);border-bottom:1px solid var(--ct-bd);position:sticky;top:0;z-index:60}' +
      '.ctop.chip{background:var(--ct-bg);border:1px solid var(--ct-bd);border-radius:10px;margin-bottom:14px}' +
      '.ct-in{max-width:1500px;margin:0 auto;padding:7px 18px;display:flex;align-items:center;gap:9px;flex-wrap:wrap}' +
      '.ct-sp{flex:1}' +
      '.ct-brand{flex:none;font-weight:800;color:var(--ct-fg);text-decoration:none;letter-spacing:.3px;white-space:nowrap}' +
      '.ct-brand:hover{color:#7dd3fc}' +
      '.ct-tabs{display:inline-flex;gap:2px;background:var(--ct-chip);border:1px solid var(--ct-bd);border-radius:8px;padding:3px}' +
      '.ct-tab{padding:4px 10px;border-radius:6px;color:var(--ct-mut);text-decoration:none;font-size:12px;font-weight:600;white-space:nowrap}' +
      '.ct-tab:hover{color:var(--ct-fg)}' +
      '.ct-tab.on{background:linear-gradient(92deg,#3b82f6,#22d3ee);color:#04122a}' +
      '.ct-home{padding:5px 11px;border-radius:7px;border:1px solid var(--ct-bd);background:var(--ct-chip);color:var(--ct-fg);text-decoration:none;font-weight:700;font-size:12px;white-space:nowrap}' +
      '.ct-home:hover{border-color:#3b82f6;color:#7dd3fc}' +
      '.ct-acc-btn{position:relative;display:inline-flex;align-items:center;gap:6px;padding:5px 10px;border:1px solid var(--ct-bd);background:var(--ct-chip);color:var(--ct-fg);border-radius:8px;cursor:pointer;font-size:12px;font-weight:600;white-space:nowrap}' +
      '.ct-acc-btn:hover{border-color:#3b82f6}' +
      '.ct-dot{width:8px;height:8px;border-radius:50%;flex:none}' +
      '.ct-accname{font-family:ui-monospace,Consolas,monospace}' +
      '.ct-caret{color:var(--ct-mut);font-size:10px}' +
      '.ct-menu{display:none;position:absolute;right:18px;top:calc(100% + 4px);min-width:230px;background:var(--ct-bg);border:1px solid var(--ct-bd);border-radius:10px;box-shadow:0 10px 26px rgba(0,0,0,.28);padding:6px;z-index:70}' +
      '.ct-menu.open{display:block}' +
      '.ct-menu-hd{padding:7px 10px 4px;font-weight:800;font-size:12.5px;color:var(--ct-fg)}' +
      '.ct-menu-row{padding:2px 10px;font-size:11.5px;color:var(--ct-mut)}' +
      '.ct-menu-row b{font-family:ui-monospace,Consolas,monospace;color:var(--ct-fg)}' +
      '.ct-menu-dim{padding-bottom:6px;border-bottom:1px solid var(--ct-bd);margin-bottom:4px}' +
      '.ct-menu-it{display:block;width:100%;text-align:left;padding:7px 10px;border:0;background:transparent;color:var(--ct-fg);text-decoration:none;font-size:12.5px;border-radius:7px;cursor:pointer;font-family:inherit}' +
      '.ct-menu-it:hover{background:var(--ct-chip);color:#7dd3fc}' +
      '.ct-menu-out{color:#f87171;margin-top:4px;border-top:1px solid var(--ct-bd);border-radius:0 0 7px 7px;padding-top:9px}' +
      '.ct-menu-out:hover{color:#f87171;background:rgba(248,113,113,.12)}' +
      '.ct-lnk{padding:5px 11px;border-radius:7px;background:linear-gradient(92deg,#3b82f6,#22d3ee);color:#04122a;text-decoration:none;font-weight:700;font-size:12px}' +
      '@media (max-width:900px){.ct-tabs{display:none}.ct-brand{font-size:12px}}';
    document.head.appendChild(st);
  }
  document.addEventListener('click', function () {
    var m = document.getElementById('ct-menu');
    if (m) m.classList.remove('open');
  });
  function boot() { injectStyle(); ConsoleTop.render(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
