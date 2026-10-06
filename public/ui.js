/**
 * ui.js — 统一 UI 工具组件：Toast / 防重复提交 / 超时兜底 / 会话过期
 * 用法：页面 </body> 前引入 <script src="/ui.js"></script>
 */
(function () {
  var _container = null;
  function ensureContainer() {
    if (_container) return _container;
    _container = document.createElement('div');
    _container.id = 'ui-toast-container';
    _container.style.cssText = 'position:fixed;bottom:24px;right:24px;z-index:999999;display:flex;flex-direction:column;gap:8px;pointer-events:none';
    document.body.appendChild(_container);
    return _container;
  }
  var COLORS = {
    ok:   { bg: '#16321f', bd: '#234a35', fg: '#34d399', icon: '\u2713' },
    err:  { bg: '#3a1d24', bd: '#4a2630', fg: '#f87171', icon: '\u2715' },
    info: { bg: '#1f2942', bd: '#26355c', fg: '#7dd3fc', icon: '\u2139' },
    warn: { bg: '#2a2410', bd: '#4a3f1a', fg: '#fbbf24', icon: '!' },
  };
  function toast(msg, type, duration) {
    type = type || 'info'; duration = duration || 3500;
    var c = COLORS[type] || COLORS.info;
    var el = document.createElement('div');
    el.style.cssText = 'background:' + c.bg + ';border:1px solid ' + c.bd + ';color:' + c.fg +
      ';padding:10px 16px;border-radius:8px;font:13px/1.4 system-ui,"Microsoft YaHei",sans-serif;' +
      'max-width:380px;pointer-events:auto;box-shadow:0 4px 14px rgba(0,0,0,.35);' +
      'opacity:0;transform:translateY(10px);transition:all .25s ease';
    el.innerHTML = '<span style="margin-right:6px;font-weight:700">' + c.icon + '</span>' + msg;
    ensureContainer().appendChild(el);
    requestAnimationFrame(function () { el.style.opacity = '1'; el.style.transform = 'translateY(0)'; });
    setTimeout(function () {
      el.style.opacity = '0'; el.style.transform = 'translateY(10px)';
      setTimeout(function () { el.remove(); }, 300);
    }, duration);
  }
  function withLoading(btn, asyncFn) {
    if (!btn || btn.disabled) return;
    btn.disabled = true;
    var orig = btn.textContent;
    btn.classList.add('ui-loading');
    btn.textContent = '\u5904\u7406\u4e2d\u2026';
    var done = false;
    function finish(err) {
      if (done) return; done = true;
      btn.disabled = false; btn.classList.remove('ui-loading'); btn.textContent = orig;
      if (err) toast(String(err.message || err), 'err');
    }
    Promise.resolve(asyncFn(btn)).then(finish, finish);
  }
  function withTimeout(promise, ms, onTimeout) {
    ms = ms || 3000;
    return new Promise(function (resolve, reject) {
      var timer;
      Promise.race([promise, new Promise(function (_, rej) { timer = setTimeout(function () { rej(new Error('timeout')); }, ms); })])
        .then(function (val) { clearTimeout(timer); resolve(val); },
              function (err) { clearTimeout(timer); if (err.message === 'timeout' && onTimeout) { onTimeout(); } reject(err); });
    });
  }
  function handleAuthError() {
    // 仅当确实没有可用令牌时才弹「会话已过期」硬横幅；
    // 若令牌仍存在（说明会话有效，个别请求 401 多为瞬时/权限），只提示不弹横幅，避免与「操作成功」矛盾。
    if (window.Auth && Auth.ready && Auth.ready()) {
      if (window.UI && window.UI.toast) window.UI.toast('部分请求未授权(401)：若持续出现请刷新页面或重新登录', 'warn', 4000);
      return;
    }
    if (document.getElementById('ui-auth-banner')) return;
    var el = document.createElement('div');
    el.id = 'ui-auth-banner';
    el.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:999998;background:#3a1d24;border-bottom:1px solid #4a2630;color:#f87171;padding:10px 20px;font:13px/1.4 system-ui;display:flex;align-items:center;justify-content:space-between;gap:12px';
    el.innerHTML = '<span><b>\u4f1a\u8bdd\u5df2\u8fc7\u671f</b>\uff0c\u8bf7\u91cd\u65b0\u767b\u5f55\u540e\u7ee7\u7eed\u64cd\u4f5c\u3002</span>' +
      '<button style="background:#f87171;color:#fff;border:0;border-radius:6px;padding:5px 14px;cursor:pointer;font:inherit">\u91cd\u65b0\u767b\u5f55</button>';
    el.querySelector('button').onclick = function () {
      try { localStorage.removeItem('applink_admin'); sessionStorage.removeItem('applink_admin'); } catch (e) {}
      ['auth_token','auth_role','auth_scope','auth_user'].forEach(function (k) { try { localStorage.removeItem(k); sessionStorage.removeItem(k); } catch(e){} });
      location.href = '/login.html';
    };
    document.body.appendChild(el);
  }
  // 页内模态输入框（替代原生 prompt，避免无头/截图环境下原生弹窗阻塞页面导致"冻结"）
  function prompt(title, def, opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;background:rgba(3,8,20,.6);z-index:9999999;display:flex;align-items:center;justify-content:center';
      var box = document.createElement('div');
      box.style.cssText = 'background:#16203a;border:1px solid #26355c;border-radius:12px;padding:18px;min-width:300px;max-width:90vw;box-shadow:0 12px 40px rgba(0,0,0,.5)';
      box.innerHTML = '<div style="font-size:14px;color:#e8eefc;margin-bottom:10px">' + (title || '请输入') + '</div>' +
        '<input id="ui-prompt-input" style="width:100%;background:#0d1730;border:1px solid #26355c;color:#e8eefc;border-radius:8px;padding:8px 10px;font-size:13px" value="' + (def || '') + '">' +
        '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px">' +
        '<button id="ui-prompt-cancel" style="background:#1f2942;color:#e8eefc;border:0;border-radius:8px;padding:7px 14px;cursor:pointer;font:inherit">取消</button>' +
        '<button id="ui-prompt-ok" style="background:#34d399;color:#04122a;border:0;border-radius:8px;padding:7px 14px;cursor:pointer;font:inherit;font-weight:700">确定</button></div>';
      overlay.appendChild(box);
      document.body.appendChild(overlay);
      var input = box.querySelector('#ui-prompt-input');
      setTimeout(function () { try { input.focus(); input.select(); } catch (e) {} }, 30);
      function close(v) { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); resolve(v); }
      box.querySelector('#ui-prompt-cancel').onclick = function () { close(null); };
      box.querySelector('#ui-prompt-ok').onclick = function () { close(input.value); };
      overlay.onclick = function (e) { if (e.target === overlay) close(null); };
      input.onkeydown = function (e) { if (e.key === 'Enter') close(input.value); else if (e.key === 'Escape') close(null); };
    });
  }
  var _cacheCallbacks = [];
  function onCreativeChange(fn) { if (typeof fn === 'function') _cacheCallbacks.push(fn); }
  function invalidateCreativeCache() { _cacheCallbacks.forEach(function (fn) { try { fn(); } catch (e) {} }); }
  var st = document.createElement('style');
  st.id = 'ui-css';
  st.textContent = '.ui-loading{opacity:.55;cursor:not-allowed}';
  document.head.appendChild(st);
  window.UI = {
    toast: toast, withLoading: withLoading, withTimeout: withTimeout, prompt: prompt,
    handleAuthError: handleAuthError, onCreativeChange: onCreativeChange,
    invalidateCreativeCache: invalidateCreativeCache,
  };
})();