// admin.js —— 通用鉴权模块：账号密码登录 + 同源请求自动注入 Bearer（角色无关）
// 用法：页面 <script src="/admin.js"></script>；可选 window.AUTH_TITLE 自定义标题。
// 登录后把作用域令牌存入 sessionStorage，所有同域 fetch 自动带 Authorization: Bearer。
// 兼容旧代码：window.admToken / window.admApi 仍可用。
(function () {
  var TITLE = window.AUTH_TITLE || '平台';
  var bar = document.createElement('div');
  bar.id = 'auth-bar';
  bar.style.cssText = 'padding:8px 14px;background:#10182e;border-bottom:1px solid #26304a;display:flex;gap:8px;align-items:center;font:13px system-ui;flex-wrap:wrap';
  bar.innerHTML = '<b style="color:#7fd1ff">' + TITLE + '</b>' +
    '<input id="auth_u" placeholder="用户名" style="width:130px;background:#0a0f1d;border:1px solid #26304a;color:#e5e9f2;border-radius:6px;padding:6px 9px">' +
    '<input id="auth_p" type="password" placeholder="密码" style="width:130px;background:#0a0f1d;border:1px solid #26304a;color:#e5e9f2;border-radius:6px;padding:6px 9px">' +
    '<button id="auth_btn" style="background:#3b82f6;color:#fff;border:0;border-radius:6px;padding:6px 12px;cursor:pointer">登录</button>' +
    '<span id="auth_status" style="color:#8a93a6"></span>' +
    '<button id="auth_out" style="background:#26304a;color:#cbd5e1;border:0;border-radius:6px;padding:6px 10px;cursor:pointer;display:none">登出</button>';
  if (document.body) document.body.prepend(bar);
  else document.addEventListener('DOMContentLoaded', function () { document.body.prepend(bar); });

  var callbacks = [];
  function setStatus(t, bad) { var s = document.getElementById('auth_status'); if (s) { s.textContent = t; s.style.color = bad ? '#ef4444' : '#8a93a6'; } }
  function flag401() { var b = document.getElementById('auth-bar'); if (b) b.style.background = '#2a1212'; setStatus('⚠ 401 未授权：请登录', true); }
  function showBar() { var b = document.getElementById('auth-bar'); if (b) b.style.display = 'flex'; }

  // 会话可读 localStorage 或 sessionStorage：login.html 勾选「记住我」写 localStorage，未勾选写 sessionStorage，
  // 两种都必须在任意后台页读到（原来只读 sessionStorage，关掉标签页/新开标签页就丢会话 → 反复要求登录）。
  function get(k) { return localStorage.getItem(k) || sessionStorage.getItem(k) || ''; }
  function setAll(k, v) { sessionStorage.setItem(k, v); localStorage.setItem(k, v); }
  function wipeAll(k) { localStorage.removeItem(k); sessionStorage.removeItem(k); }
  function persist(tk, role, scope, user) {
    // 两个存储都写，避免「记住我」的 localStorage 与页面自身 sessionStorage 不一致，导致部分页面拿不到令牌而 401
    setAll('auth_token', tk || '');
    setAll('auth_role', role || '');
    setAll('auth_scope', scope || '');
    setAll('auth_user', user || '');
    var st = document.getElementById('auth_status'); if (st) st.textContent = '已登录：' + (user || role) + (scope ? '（' + scope + '）' : '');
    var out = document.getElementById('auth_out'); if (out) out.style.display = '';
  }
  function clearAuth() {
    ['auth_token', 'auth_role', 'auth_scope', 'auth_user'].forEach(wipeAll);
    fetch('/api/admin/logout', { method: 'POST' }).catch(function () {});  // 同步清服务端 adm cookie
    var out = document.getElementById('auth_out'); if (out) out.style.display = 'none';
    setStatus('已登出', false);
  }

  async function login(username, password) {
    if (!username || !password) { setStatus('请输入用户名和密码', true); return null; }
    try {
      var r = await fetch('/api/account/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: username, password: password }) });
      var d = await r.json().catch(function () { return {}; });
      if (r.ok && d.token) {
        persist(d.token, d.type, d.scope, d.username);
        // 同时写 admin cookie（兼容旧 dashboard 等仍读 cookie 的页面）
        fetch('/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: d.token }) }).catch(function () {});
        callbacks.forEach(function (fn) { try { fn(d); } catch (e) {} });
        return d;
      }
      setStatus(d.error || '登录失败', true);
      return null;
    } catch (e) { setStatus('网络错误', true); return null; }
  }

  setTimeout(function () {
    var btn = document.getElementById('auth_btn');
    if (btn) btn.onclick = function () { login(document.getElementById('auth_u').value.trim(), document.getElementById('auth_p').value); };
    var out = document.getElementById('auth_out');
    if (out) out.onclick = clearAuth;
    var tk = get('auth_token');
    if (tk) {
      fetch('/api/account/me').then(function (r) { return r.ok ? r.json() : null; }).then(function (m) {
        if (m) persist(tk, m.type, m.scope, m.username); else showBar();
      }).catch(function () { showBar(); });
    } else showBar();
  }, 0);

  window.Auth = {
    token: function () { return get('auth_token'); },
    role: function () { return get('auth_role'); },
    scope: function () { return get('auth_scope'); },
    user: function () { return get('auth_user'); },
    ready: function () { return !!get('auth_token'); },
    login: login,
    logout: clearAuth,
    onAuth: function (fn) { if (typeof fn === 'function') callbacks.push(fn); },
    api: function (p, body, method) {
      return (async function () {
        var h = { 'Content-Type': 'application/json' };
        var t = window.Auth.token(); if (t) h['Authorization'] = 'Bearer ' + t;
        var r = await fetch(p, { method: method || (body !== undefined ? 'POST' : 'GET'), headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
        if (r.status === 401) { flag401(); throw new Error('401 未授权：请登录'); }
        return r;
      })();
    }
  };
  // 兼容旧代码
  window.admToken = window.Auth.token;
  window.admApi = window.Auth.api;

  // 全局包裹 fetch：同源请求自动注入 Bearer，消除静默 401
  var _fetch = window.fetch ? window.fetch.bind(window) : null;
  if (_fetch) {
    window.fetch = function (input, init) {
      init = init || {};
      try {
        var url = (typeof input === 'string') ? input : (input && input.url);
        var sameOrigin = !url || url.charAt(0) === '/' || (typeof location !== 'undefined' && url.indexOf(location.origin) === 0);
        if (sameOrigin) {
          init.headers = init.headers || {};
          var hasAuth = (init.headers instanceof Headers) ? init.headers.has('Authorization') : !!(init.headers && (init.headers.Authorization || init.headers.authorization));
          var t = window.Auth.token();
          if (t && !hasAuth) {
            if (init.headers instanceof Headers) init.headers.set('Authorization', 'Bearer ' + t);
            else init.headers['Authorization'] = 'Bearer ' + t;
          }
        }
      } catch (e) {}
      return _fetch(input, init);
    };
  }
})();
