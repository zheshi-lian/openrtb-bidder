/* console_nav.js —— 页面级「当前业务链路」注册表（glue 层）
 * register.html / console 等页面用 LinkOSNav.override(role) 告知顶栏：
 *   本页当前处于哪条漏斗（advertiser / publisher），让导航高亮正确分组。
 * nav.js 与 console_top.js 渲染时会读取这里登记的状态。
 */
window.LinkOSNav = (function () {
  var _role = null;
  function override(role) {
    _role = role;
    try { window.dispatchEvent(new CustomEvent('linkos:override', { detail: { role: role } })); } catch (e) {}
    if (window.ConsoleTop && typeof window.ConsoleTop.render === 'function') {
      try { window.ConsoleTop.render(); } catch (e) {}
    }
  }
  function getRole() { return _role; }
  return { override: override, getRole: getRole };
})();
