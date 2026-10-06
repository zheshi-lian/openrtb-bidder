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
      label: '广告主', tone: '#3b82f6', home: '/campaigns.html',
      // 投放链路（对标 AppLovin ADVERTISE）：广告系列 / 报表 / 素材库(含创意自动化) / 账户
      // 归因/追踪【不占一级导航、也不做账户子 tab】：
      // 对标 AppLovin —— 归因合作方是「账户」页内的一个 section（Integrated Partners），顶栏不重复挂子入口。
      // 本平台账户页已平铺 ①–⑦ 个 section（含 ⑥ 归因 & 事件），顶栏只保留 4 个一级模块。
      flow: [['/campaigns.html', '广告系列'], ['/analytics.html', '报表'],
             ['/adv-media.html', '素材库'], ['/adv-account.html', '账户']],
      acct: [['/security.html', '账号安全']]
    },
    publisher: {
      label: '开发者', tone: '#22c55e', home: '/publisher_report.html',
      // 变现四域（对标 AppLovin MAX / 汇量 Mintegral，统一为 4 个一级导航）：
      //   概览/报表 ← ⑥收益报表
      //   应用与版位 ← ②应用 + ③广告单元 + ④SDK接入 + ⑤集成自检（后两者降为域内子入口）
      //   审核/品牌安全 ← 新增（对标 AppLovin Ad Review）
      //   账户与结算 ← 新增（密钥/收款/结算，对标两家 Account 域）
      // ①开发者入驻下沉为「引导向导」，不做一级导航（接入是一次性动作，属 onboarding）
      flow: [
        ['/publisher_report.html', '概览/报表'],
        ['/ad_units.html', '应用与版位'],
        ['/pub-review.html', '审核/品牌安全'],
        ['/pub-account.html', '账户与结算']
      ],
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
  var ADV_PAGES = ['/campaigns.html', '/analytics.html', '/adv-media.html', '/adv-attribution.html', '/adv-account.html'];
  // apps.html 已被 ad_units.html（应用与版位）取代，从路由表移除
  var PUB_PAGES = ['/publisher.html', '/publisher_report.html', '/ad_units.html', '/integrity.html', '/sdk-guide.html', '/pub-review.html', '/pub-account.html'];
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
        '<a class="ct-brand" href="/home.html" title="回到官网首页">◀ AppLink</a>' +
        '<span class="ct-sp"></span>' +
        '<a class="ct-home" href="/home.html">官网首页</a>' +
        '<a class="ct-lnk" href="/login.html">登录</a>' +
        '</div>';
      return;
    }

    var m = pickMeta(me) || { label: me.type, tone: '#8aa0c8', home: '/console.html', flow: [], acct: [] };
    // ④ 业务链路 tab（支持 [href,label,sub[]] 的三段式：第三段为域内子入口，降权为次级导航）
    var tabs = (m.flow || []).map(function (t) {
      var href = t[0], label = t[1], sub = t[2] || [];
      var active = here === href;
      if (sub.length && sub.some(function (s) { return s[0] === here; })) active = true;
      return '<a href="' + href + '" class="ct-tab' + (active ? ' on' : '') + '">' + label + '</a>';
    }).join('');
    // ④ 域内子导航：当前页落在某域的子入口时，渲染次级 tab 行（如 应用与版位 → 应用/广告单元/SDK接入/集成自检）
    var subRow = '';
    (m.flow || []).forEach(function (t) {
      var href = t[0], sub = t[2] || [];
      if (sub.length && (here === href || sub.some(function (s) { return s[0] === here; }))) {
        subRow = '<span class="ct-subtabs">' + sub.map(function (s) {
          return '<a href="' + s[0] + '" class="ct-subtab' + (here === s[0] ? ' on' : '') + '">' + s[1] + '</a>';
        }).join('') + '</span>';
      }
    });
    // ④ 账号维度入口（不进链路 tab，进右上账号菜单）
    var acctItems = (m.acct || []).map(function (a) {
      return '<a class="ct-menu-it" href="' + a[0] + '">' + a[1] + '</a>';
    }).join('');
    // 已经在本角色工作台时，不再显示"进入我的XX台"——否则点了只是刷新当前页，看着像按钮没用。
    // 【身份 ≠ 链路】身份永远取登录角色(me.type)；模块 tab 才按"当前页面所在业务链路"(m) 切换。
    //   此前 home 取 m.home → admin 浏览广告主页时，「我的运营台」却链到广告主的 campaigns.html。
    var ident = (me && me.type && META[me.type]) || META.admin;
    var homeLabel = me.type === 'advertiser' ? '我的广告主投放台'
      : (me.type === 'publisher' ? '我的开发者变现台' : '我的运营台');
    var homeItem = (location.pathname === ident.home) ? ''
      : ('<a class="ct-menu-it" href="' + ident.home + '">' + homeLabel + '</a>');
    // admin 跨角色查看他人链路时显式提示：身份不会因浏览页面而改变
    var viewingRow = (ident !== m)
      ? ('<div class="ct-menu-row ct-menu-dim">你以 <b>' + esc(ident.label) + '</b> 身份浏览 <b>' + esc(m.label) + '</b> 链路（身份不会改变）</div>')
      : '';

    h.innerHTML =
      '<div class="ct-in">' +
        '<a class="ct-brand" href="/home.html" title="回到官网首页">◀ AppLink</a>' +
        '<span class="ct-tabs">' + tabs + (subRow ? ' ' + subRow : '') + '</span>' +
        '<span class="ct-sp"></span>' +
        '<a class="ct-home" href="/home.html" title="回到官网首页">官网首页</a>' +
        '<button class="ct-acc-btn" title="账号与权限">' +
          '<span class="ct-dot" style="background:' + ident.tone + '"></span>' +
          '<span class="ct-accname">' + esc(me.username) + '</span>' +
          '<span class="ct-caret">▾</span>' +
        '</button>' +
        '<div class="ct-menu" id="ct-menu">' +
          '<div class="ct-menu-hd">' + esc(ident.label) + ' · ' + esc(me.username) + '</div>' +
          '<div class="ct-menu-row">数据作用域：<b>' + esc(me.scope || '*') + '</b></div>' +
          '<div class="ct-menu-row ct-menu-dim">只能看到该作用域内的数据</div>' +
          viewingRow +
          homeItem +
          acctItems +
          '<a class="ct-menu-it" href="/home.html">返回官网首页</a>' +
          '<a class="ct-menu-it" href="/login.html">切换 / 登录其他账号</a>' +
          '<button class="ct-menu-it ct-menu-out" onclick="ConsoleTop.logout()">登出</button>' +
        '</div>' +
      '</div>';
    // 账号菜单开合改由 JS 绑定，并在菜单内部阻止冒泡：
    // 否则点菜单里的项会冒泡到下方 document 的关闭逻辑，菜单刚打开就被关掉（表现=点了没反应）。
    var accBtn = h.querySelector('.ct-acc-btn');
    if (accBtn) accBtn.addEventListener('click', function (e) {
      e.preventDefault(); e.stopPropagation();
      var mm = document.getElementById('ct-menu'); if (mm) mm.classList.toggle('open');
    });
    var mn = document.getElementById('ct-menu');
    if (mn) mn.addEventListener('click', function (e) { e.stopPropagation(); });
  }
  function toggle(e) {
    if (e) { e.preventDefault(); e.stopPropagation(); }
    var m = document.getElementById('ct-menu');
    if (m) m.classList.toggle('open');
  }
  function logout() {
    try { localStorage.removeItem('applink_admin'); sessionStorage.removeItem('applink_admin'); } catch (e) {}
    ['auth_token', 'auth_role', 'auth_scope', 'auth_user'].forEach(function (k) {
      try { localStorage.removeItem(k); sessionStorage.removeItem(k); } catch (e) {}
    });
    fetch('/api/admin/logout', { method: 'POST' }).catch(function () {});
    location.href = '/login.html';
  }
  // 页面级角色门禁：三角色链路隔离。当前页面要求某角色时，登录角色不匹配（且非 admin）即重定向回本职后台。
  // 注意：这只是前端 UX 闸门；真正的经营数据隔离仍由 server.js 的 requireAuth(...) 在接口层强制。
  var PAGE_ROLE = {
    '/campaigns.html': 'advertiser', '/analytics.html': 'advertiser', '/adv-media.html': 'advertiser',
    '/adv-account.html': 'advertiser', '/adv-attribution.html': 'advertiser',
    '/publisher.html': 'publisher', '/publisher_report.html': 'publisher', '/ad_units.html': 'publisher',
    '/integrity.html': 'publisher', '/sdk-guide.html': 'publisher', '/pub-review.html': 'publisher', '/pub-account.html': 'publisher',
    '/console.html': 'admin', '/dashboard.html': 'admin', '/reports.html': 'admin', '/review.html': 'admin',
    '/strategy.html': 'admin', '/advanced.html': 'admin', '/account.html': 'admin'
  };
  // 跨链路拦截（不当 Asshole Sysadmin 式"静默弹回"）：
  // 旧实现 location.replace(home) 会让目标页先渲染出来、再被一脚踢回本职后台 —— 用户看到的就是"闪一下又跳回来"，
  // 既不知道发生了什么，也以为系统坏了。现在改为原地盖一层说明层：讲清楚链路归属 + 给下一步按钮，且不再发生导航。
  function blockCross(me, req) {
    var mine = META[me.type] || { label: me.type, tone: '#64748b', home: '/home.html', flow: '工作台' };
    var want = META[req] || { label: req, flow: '该链路' };
    if (document.getElementById('ct-gate')) return;
    var ov = document.createElement('div');
    ov.id = 'ct-gate';
    ov.style.cssText = 'position:fixed;inset:0;z-index:9999990;background:#0b1020;overflow:auto;padding:28px 20px;' +
      'font:14px/1.8 system-ui,\'Microsoft YaHei\',sans-serif;color:#e8eefc';
    ov.innerHTML =
      '<div style="max-width:560px;margin:8vh auto;background:#16203a;border:1px solid #26355c;border-radius:14px;padding:24px 26px;box-shadow:0 16px 44px rgba(0,0,0,.5)">' +
        '<div style="font-size:16px;font-weight:800;margin-bottom:10px">当前账号无权访问本页</div>' +
        '<div style="color:#b8c6e2">' +
          '本页属于 <b style="color:' + (want.tone || '#22d3ee') + '">' + (want.flow || want.label) + '</b> 链路，' +
          '而你当前以 <b style="color:' + (mine.tone || '#64748b') + '">' + (mine.label || me.type) + '</b>' +
          '（<code style="background:#0d1730;border:1px solid #223358;border-radius:5px;padding:1px 6px">' + esc(me.username || '') + '</code>）身份登录。<br>' +
          '广告主（买量）与开发者（变现）是两套互相隔离的账号与数据体系，一个账号只能看到自己链路内的经营数据' +
          '（对标 AppLovin ADVERTISE / MAX、汇量 Mintegral）。这不是故障，是权限隔离。' +
        '</div>' +
        '<div style="margin-top:18px;display:flex;gap:9px;flex-wrap:wrap">' +
          '<a href="' + (mine.home || '/home.html') + '" style="flex:1;min-width:160px;text-align:center;background:linear-gradient(92deg,#3b82f6,#22d3ee);color:#04122a;border:0;border-radius:9px;padding:10px 16px;font-weight:800;text-decoration:none">回到我的' + (mine.flow || '工作台') + '</a>' +
          '<a href="/login.html" style="flex:1;min-width:160px;text-align:center;background:#1f2942;color:#e8eefc;border:1px solid #26355c;border-radius:9px;padding:10px 16px;text-decoration:none">切换 / 登录' + (want.label || '') + '账号</a>' +
        '</div>' +
        '<div style="margin-top:10px">' +
          '<a href="/register.html#' + (req === 'publisher' ? 'publisher' : (req === 'advertiser' ? 'advertiser' : 'admin')) + '" style="display:block;text-align:center;background:#10182e;color:#9fb4dc;border:1px solid #26355c;border-radius:9px;padding:9px 16px;text-decoration:none">还没有该身份账号？去开通 / 入驻</a>' +
        '</div>' +
        '<div style="margin-top:14px;font-size:12px;color:#64748b">服务端接口层另有 requireAuth(...) 强制隔离，前端这道gate只是 UX 提示，不是安全边界。</div>' +
      '</div>';
    document.body.appendChild(ov);
  }
  function gate() {
    var req = PAGE_ROLE[location.pathname];
    if (!req) return true; // 未列入门禁的页面（官网/登录/注册/文档等）对所有角色开放
    var me = (window.Auth && Auth.get()) || null;
    if (!me || !me.token) { location.replace('/login.html'); return false; }
    if (req !== 'admin' && me.type !== req && me.type !== 'admin') {
      blockCross(me, req);
      return false;
    }
    return true;
  }
  return { render: render, logout: logout, toggle: toggle, gate: gate, META: META };
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
      '.ct-subtabs{display:inline-flex;gap:2px;background:var(--ct-chip);border:1px solid var(--ct-bd);border-radius:8px;padding:3px;margin-left:2px}' +
      '.ct-subtab{padding:4px 9px;border-radius:6px;color:var(--ct-mut);text-decoration:none;font-size:12px;font-weight:600;white-space:nowrap}' +
      '.ct-subtab:hover{color:var(--ct-fg)}' +
      '.ct-subtab.on{background:rgba(34,197,94,.20);color:#86efac}' +
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
  function boot() { injectStyle(); if (!ConsoleTop.gate()) return; ConsoleTop.render(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
