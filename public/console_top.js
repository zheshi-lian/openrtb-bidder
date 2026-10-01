/* console_top.js —— 控制台专属顶栏（仅受控后台页引用；公共站用 nav.js）
 *
 * 第一性原理：
 *   ① 身份只出现在控制台。营销页永远不显示账号名与「登出」。
 *   ② 每个角色自己的壳，不共用营销导航。管理员/广告主/媒体各有自己的功能 tab。
 *   ③ 权限不由这里决定。真闸门在 server.js 的 requireAuth(...)，这里只负责导航收敛与身份可见。
 *
 * 用法：<body> 后放 <div id="ctop"></div>，并在 </body> 前引入本脚本（需先引入 /admin.js）
 */
window.ConsoleTop = (function () {
  var META = {
    admin: {
      label: '管理员', tone: '#f59e0b', home: '/console.html',
      tabs: [ ['/console.html', '控制台'], ['/dashboard.html', '实时大盘'], ['/reports.html', '报表'], ['/creative.html', '素材'] ]
    },
    advertiser: {
      label: '广告主', tone: '#3b82f6', home: '/advertiser.html',
      tabs: [ ['/advertiser.html', '我的计划'] ]
    },
    publisher: {
      label: '媒体', tone: '#22c55e', home: '/publisher_report.html',
      tabs: [ ['/publisher_report.html', '收益报表'], ['/publisher.html', '入驻 / 广告位'] ]
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
  function render() {
    var h = document.getElementById('ctop');
    if (!h) return;
    var bodyMargin = parseFloat(getComputedStyle(document.body).marginTop) || 0;
    var chip = bodyMargin > 0;          // 内容有外边距的浅底页用圆角卡片样式，满铺页用通栏样式
    setTheme(h, isDark(), chip);

    var me = (window.Auth && Auth.get()) || null;
    var here = location.pathname;

    if (!me || !me.token) {
      h.innerHTML = '<div class="ct-in">' +
        '<a class="ct-lnk" href="/login.html">登录</a>' +
        '<span class="ct-mut">当前是公共视图，登录后可查看自己作用域的数据</span></div>';
      return;
    }
    var m = META[me.type] || { label: me.type, tone: '#8aa0c8', home: '/console.html', tabs: [] };
    var tabs = (m.tabs || []).map(function (t) {
      return '<a href="' + t[0] + '" class="ct-tab' + (here === t[0] ? ' on' : '') + '">' + t[1] + '</a>';
    }).join('');
    h.innerHTML =
      '<div class="ct-in">' +
        '<a class="ct-logo" href="/home.html" title="回到官网">L</a>' +
        '<span class="ct-dot" style="background:' + m.tone + '"></span>' +
        '<span class="ct-role">' + esc(m.label) + '</span>' +
        '<span class="ct-acc">' + esc(me.username) + '</span>' +
        '<span class="ct-scope" title="数据作用域：只能看到自己这部分数据">' + esc(me.scope || '*') + '</span>' +
        '<span class="ct-tabs">' + tabs + '</span>' +
        '<button class="ct-out" onclick="ConsoleTop.logout()" title="退出登录">登出</button>' +
      '</div>';
  }
  function logout() {
    try {
      localStorage.removeItem('adx_admin');
      sessionStorage.removeItem('adx_admin');
    } catch (e) { }
    fetch('/api/admin/logout', { method: 'POST' }).catch(function () { });
    location.href = '/login.html';
  }
  return { render: render, logout: logout, META: META };
})();

(function () {
  function injectStyle() {
    if (document.getElementById('ctop-css')) return;
    var st = document.createElement('style');
    st.id = 'ctop-css';
    st.textContent =
      '.ctop{color:var(--ct-fg);font:12.5px/1.4 system-ui,"Microsoft YaHei",sans-serif;box-sizing:border-box}' +
      '.ctop.bar{background:var(--ct-bg);border-bottom:1px solid var(--ct-bd);position:sticky;top:0;z-index:60}' +
      '.ctop.chip{background:var(--ct-bg);border:1px solid var(--ct-bd);border-radius:10px;margin-bottom:14px}' +
      '.ct-in{max-width:1500px;margin:0 auto;padding:7px 18px;display:flex;align-items:center;gap:9px;flex-wrap:wrap}' +
      '.ct-logo{flex:none;width:26px;height:26px;border-radius:7px;display:flex;align-items:center;justify-content:center;font-weight:800;color:#04122a;background:linear-gradient(135deg,#3b82f6,#22d3ee);text-decoration:none}' +
      '.ct-dot{width:8px;height:8px;border-radius:50%;flex:none}' +
      '.ct-role{font-weight:700;font-size:12.5px}' +
      '.ct-acc{font-family:ui-monospace,Consolas,monospace;font-size:12px;color:var(--ct-fg);background:var(--ct-chip);border:1px solid var(--ct-bd);padding:2px 8px;border-radius:11px}' +
      '.ct-scope{font-family:ui-monospace,Consolas,monospace;font-size:11.5px;color:var(--ct-mut);background:var(--ct-chip);border:1px solid var(--ct-bd);padding:2px 8px;border-radius:11px;max-width:230px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
      '.ct-tabs{display:inline-flex;gap:2px;margin-left:6px;background:var(--ct-chip);border:1px solid var(--ct-bd);border-radius:8px;padding:3px}' +
      '.ct-tab{padding:4px 10px;border-radius:6px;color:var(--ct-mut);text-decoration:none;font-size:12px;font-weight:600}' +
      '.ct-tab:hover{color:var(--ct-fg)}' +
      '.ct-tab.on{background:linear-gradient(92deg,#3b82f6,#22d3ee);color:#04122a}' +
      '.ct-out{margin-left:auto;padding:5px 11px;border:1px solid var(--ct-bd);background:transparent;color:var(--ct-mut);border-radius:7px;cursor:pointer;font-size:12px}' +
      '.ct-out:hover{color:#f87171;border-color:#f87171}' +
      '.ct-lnk{padding:5px 11px;border-radius:7px;background:linear-gradient(92deg,#3b82f6,#22d3ee);color:#04122a;text-decoration:none;font-weight:700;font-size:12px}' +
      '.ct-mut{color:var(--ct-mut);font-size:12px}' +
      '@media (max-width:820px){.ct-tabs{display:none}.ct-scope{max-width:120px}}';
    document.head.appendChild(st);
  }
  function boot() { injectStyle(); ConsoleTop.render(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();