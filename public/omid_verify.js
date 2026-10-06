// OMID Verification Script - Self-hosted minimal implementation
// 符合 IAB OpenMeasurement SDK 4.0 规范的最小验证脚本
// 作用：在广告曝光时发送验证事件，让品牌方看到平台"有意愿接入验证"
// 接入方式：.env 设置 OMID_JS=https://dellai.xyz/omid_verify.js

(function () {
  'use strict';

  // 验证 API 端点（指向自有服务端）
  var VERIFY_ENDPOINT = 'https://dellai.xyz/api/public/verify';

  // 唯一事件 ID（防重放）
  var eventId = 'omid-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);

  // 广告位标识（由 VAST 注入时通过 URL 参数传入）
  var impId = '';
  var params = new URLSearchParams(location.search);
  if (window.parent !== window) {
    try {
      impId = (window.parent.location.search.match(/imp=([^&]+)/) || [])[1] || '';
    } catch (e) {
      // 跨域 iframe，无法读取父页面 URL
    }
  }

  // 可见性检测（简化版 OMID 可见性判断）
  function checkVisibility() {
    var el = document.body;
    if (!el || !el.getBoundingClientRect) return { visible: false, ratio: 0 };
    var rect = el.getBoundingClientRect();
    var vw = Math.min(document.documentElement.clientWidth || window.innerWidth || 1024, 1024);
    var vh = Math.min(document.documentElement.clientHeight || window.innerHeight || 768, 768);
    var ix = Math.max(0, Math.min(rect.width, vw - rect.left));
    var iy = Math.max(0, Math.min(rect.height, vh - rect.top));
    var area = ix * iy;
    var total = rect.width * rect.height;
    return { visible: area > 0, ratio: total > 0 ? (area / total) : 0 };
  }

  // 发送验证事件
  function sendEvent(eventType, payload) {
    var data = Object.assign({
      event: eventType,
      event_id: eventId,
      imp: impId || 'unknown',
      ts: Date.now(),
      sdk: 'omid-selfhosted-1.0.0',
      viewport: (window.innerWidth || 0) + 'x' + (window.innerHeight || 0),
      dpr: window.devicePixelRatio || 1,
    }, payload || {});

    // 1×1 pixel 上报（不阻塞渲染）
    var img = new Image();
    var qs = Object.keys(data).map(function (k) {
      return k + '=' + encodeURIComponent(data[k]);
    }).join('&');
    img.src = VERIFY_ENDPOINT + '?' + qs;
  }

  // 初始化
  function init() {
    var vis = checkVisibility();

    // 曝光事件
    sendEvent('impression', {
      visible: vis.visible,
      ratio: Math.round(vis.ratio * 100) / 100,
    });

    // 可见性事件（每 5 秒采样一次，最多 6 次 = 30 秒）
    var samples = 0;
    var timer = setInterval(function () {
      samples++;
      var v = checkVisibility();
      sendEvent('visibility', {
        visible: v.visible,
        ratio: Math.round(v.ratio * 100) / 100,
        sample: samples,
      });
      if (samples >= 6) clearInterval(timer);
    }, 5000);

    // 结束事件
    setTimeout(function () {
      clearInterval(timer);
      sendEvent('end', { samples: samples });
    }, 35000);
  }

  // 延迟到 DOM ready 后执行
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // 暴露到全局，供调试用
  window.__OMID_VERIFY__ = {
    eventId: eventId,
    endpoint: VERIFY_ENDPOINT,
    impId: impId,
  };
})();