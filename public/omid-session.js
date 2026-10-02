/**
 * omid-session.js —— 可见性测量 shim（演示用，对标 IAB OMID / omsdk）
 *
 * 真实 OMID 由播放器在解析到 VAST <AdVerifications><Verification><JavaScriptResource apiFramework="omid">
 * 时加载此脚本，脚本通过 OMID API 取得 session 上下文（impressionId / 创意坐标等），用几何法判定
 * "可见曝光"（≥50% 像素连续可见 ≥1 秒），并回传测量结果。
 *
 * 本演示的简化实现：从 window.__OMID__ 读取注入的会话上下文（impid/cid/base/el），
 * 用 IntersectionObserver 做几何可见性判定，结果 POST 到 平台 的 /vast/omid。
 * 真实生产应改用官方 omsdk 提供的 SessionClient / AdSession，并接入第三方验证厂商。
 */
(function () {
  var cfg = window.__OMID__ || {};
  if (!cfg.impid) { return; }                       // 无会话上下文则跳过（等同 verificationNotExecuted）
  var base = cfg.base || 'http://127.0.0.1:8080';
  var el = cfg.el || document.querySelector('video');

  function report(ev, viewable, dur) {
    var url = base + '/vast/omid?impid=' + encodeURIComponent(cfg.impid) +
      '&cid=' + encodeURIComponent(cfg.cid || '') + '&event=' + ev +
      '&viewable=' + (viewable ? 1 : 0) + '&durationMs=' + (dur || 0);
    try { new Image().src = url; } catch (e) {}
    if (window.__OMID_LOG__) window.__OMID_LOG__(ev, viewable, dur);
  }

  report('omid_session_start', 0, 0);

  if (!el || !('IntersectionObserver' in window)) {
    report('omid_not_executed', 0, 0);
    return;
  }

  // 几何可见性：≥50% 像素进入视口且连续维持 ≥1s 才算一次"可见曝光"
  var viewableSince = 0, lastState = false, fired = false;
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      var visible = e.intersectionRatio >= 0.5;
      if (visible && !lastState) { viewableSince = Date.now(); }
      if (visible && !fired && Date.now() - viewableSince >= 1000) {
        report('viewable', 1, Date.now() - viewableSince); fired = true; lastState = true;
      }
      if (!visible && lastState) { report('not_viewable', 0, 0); lastState = false; }
    });
  }, { threshold: [0, 0.5, 1] });
  io.observe(el);
})();
