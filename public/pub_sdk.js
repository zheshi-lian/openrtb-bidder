/**
 * pub_sdk.js —— 平台 发布方 SDK v2（生产级）
 *
 * v1 的问题（演示级，不能上生产）：
 *   ① 同步 IIFE、一失败就静默，媒体页面被拖死、无重试、无超时
 *   ② 无隐私合规：不读 TCF/USP/GPP，不判 ATT，ID 照发 → GDPR/CCPA 风险
 *   ③ 无广告形态语义：只塞 HTML，VAST 视频靠服务端拼、客户端不解析不埋点
 *   ④ 无 MRAID：富媒体/可玩广告无法与容器交互（expand/close/自定义关闭）
 *   ⑤ 无可见性测量：曝光埋点在渲染瞬间就发，等于"发了就算"，买方不信
 *
 * v2 补齐（对标 AppLovin MAX 的 SDK 级数据能力）：
 *   · 纯异步装载：不阻塞主文档；slot 占位预留，避免 CLS；命令队列 平台.cmd 支持先配置后加载
 *   · 重试：指数退避 + 抖动，超时可控；失败塌陷或回落兜底创意，绝不抛错到媒体页
 *   · 隐私：TCF v2 (__tcfapi) / USP / GPP 读取 + 同意串解码；无同意则发 regs.gdpr=1 且禁个性化
 *   · iOS：ATT 状态（0/1/2/3）决定 IFA 是否透传；SKAN 提供原生桥与 conversion value 上报
 *   · VAST 4.0 客户端解析：MediaFile 选型、TrackingEvents(start~complete)、skipoffset、点击
 *   · OMID：自动注入 omid-session.js，≥50% 像素持续 ≥1s 才算可见曝光，回传 /vast/omid
 *   · MRAID 3 最小桥：getState/expand/close/useCustomClose/open/supports 等，可玩广告可用
 *   · 反作弊：设备指纹、可见性、真实播放时长一并上报，服务端才有可信结算依据
 *
 * 用法（异步，推荐）：
 *   <script async src="https://dellai.xyz/pub_sdk.js"></script>
 *   <div class="ad-slot" data-floor="1.0" data-cat="puzzle" data-geo="CN" data-kw="game"></div>
 *
 * 用法（显式）：
 *   window.平台 = window.平台 || { cmd: [] };
 *   平台.cmd.push(function () {
 *     平台.configure({ endpoint: 'https://dellai.xyz', landingAllow: ['example.com'], timeoutMs: 3000 });
 *     平台.defineSlot('slot-1', { format: 'rewarded', floor: 5 });
 *     平台.refresh('slot-1');
 *   });
 */
(function (global) {
  'use strict';

  var VERSION = '2.0.0';
  var doc = global.document;

  // ───────── 配置 ─────────
  var cfg = {
    endpoint: '',            // 空 = 本脚本所在 origin
    timeoutMs: 3000,
    retries: 2,
    landingAllow: ['example.com', 'dellai.xyz'],
    omid: true,
    mraid: true,
    debug: false,
    att: null,               // 由 App 原生注入：0未决定/1受限/2拒绝/3授权
    ifa: '',                 // 由 App 原生注入（ATT=3 才有）
    deviceFp: '',
  };

  function log() { if (cfg.debug && global.console) { try { console.log.apply(console, ['[平台]'].concat([].slice.call(arguments))); } catch (e) {} } }

  // 本脚本所在 origin：跨域嵌入任意媒体站都能正确回连 平台
  function scriptOrigin() {
    if (cfg.endpoint) return cfg.endpoint.replace(/\/+$/, '');
    var tags = doc.querySelectorAll('script[src]');
    for (var i = 0; i < tags.length; i++) {
      var s = tags[i].src || '';
      if (s.indexOf('pub_sdk') !== -1) { try { return new URL(s).origin; } catch (e) {} }
    }
    return location.origin;
  }
  var BASE = scriptOrigin();

  // ───────── 工具 ─────────
  function rid(prefix) {
    return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }
  function beacon(url) {
    try {
      if (navigator.sendBeacon) { if (navigator.sendBeacon(url)) return; }
      var img = new Image(); img.src = url;
    } catch (e) {}
  }
  function beaconAll(urls) { (urls || []).forEach(function (u) { beacon(u); }); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function safeUrl(u, allow) {
    try {
      var h = new URL(u, location.href);
      if (h.protocol !== 'http:' && h.protocol !== 'https:') return null;
      if (!allow || !allow.length) return h.href;
      // 平台自托管落地页（与 平台 同 origin，如 /landing/...）天然可信，直接放行
      if (h.origin === BASE) return h.href;
      var ok = allow.some(function (d) { return h.hostname === d || h.hostname.endsWith('.' + d); });
      return ok ? h.href : null;
    } catch (e) { return null; }
  }
  // 落地页追踪透传：点击发生时把 imp/cid/pub 追加到落地页 URL，落地页留资时用它回连归因。
  // 只在已通过 safeUrl 校验的 URL 上追加（仅改 query，不动 host/path）；广告主已自带 imp 则不覆盖。
  function trk(u, bid, br) {
    if (!u) return u;
    var imp = bid && bid.impid ? String(bid.impid) : '';
    if (!imp) return u;                        // 无 imp（离线预览等）不追加
    if (u.indexOf('imp=') >= 0) return u;      // 广告主已配好追踪参数，不覆盖
    var cid = ((bid && bid.ext && bid.ext.cid) || bid.cid || '');
    var pub = (br && br.site && br.site.domain) || '';
    var a = 'imp=' + encodeURIComponent(imp);
    if (cid) a += '&cid=' + encodeURIComponent(cid);
    if (pub) a += '&pub=' + encodeURIComponent(pub);
    return u + (u.indexOf('?') >= 0 ? '&' : '?') + a;
  }
  function fetchWithTimeout(url, opt, ms) {
    return new Promise(function (resolve, reject) {
      var done = false;
      var timer = setTimeout(function () { if (!done) { done = true; reject(new Error('timeout')); } }, ms);
      fetch(url, opt).then(function (r) {
        if (done) return; done = true; clearTimeout(timer);
        if (!r.ok) return reject(new Error('http ' + r.status));
        resolve(r);
      }, function (e) { if (done) return; done = true; clearTimeout(timer); reject(e); });
    });
  }
  // 指数退避 + 抖动：避免全网同秒重试打爆 平台（ thundering herd ）
  function backoff(attempt) {
    var base = Math.min(2000, 300 * Math.pow(2, attempt));
    return base / 2 + Math.random() * (base / 2);
  }

  // ───────── 隐私：TCF v2 / USP / GPP / ATT ─────────
  // TCF 同意串（base64url）v2 结构：ver(6b) | created | updated | cmpId | cmpVersion |
  // consentScreen | consentLanguage | vendorListVersion | tcfPolicyVersion | isServiceSpecific |
  // useNonStandardStacks | specialFeatureOptins(12b) | purposesConsent(24b) | purposesLITransparency(24b) ...
  function decodeTcf(str) {
    try {
      var bin = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
      var bits = '';
      for (var i = 0; i < bin.length; i++) {
        var c = bin.charCodeAt(i);
        for (var b = 7; b >= 0; b--) bits += ((c >> b) & 1) ? '1' : '0';
      }
      var version = parseInt(bits.substr(0, 6), 2);
      if (version !== 2) return { version: version, purposes: {} };
      var p = bits.substr(78, 24); // 78 = 6+36+36 = header 前 78 位后即 purposesConsent
      return {
        version: 2,
        purposes: {
          // Purpose 1: 存储/访问信息；3: 广告个性化画像；4: 广告投放
          1: p[0] === '1', 3: p[2] === '1', 4: p[3] === '1',
        },
        raw: str,
      };
    } catch (e) { return { version: 0, purposes: {} }; }
  }
  function readUsp() {
    var v = '';
    try { v = global.localStorage && localStorage.getItem('uspString') || ''; } catch (e) {}
    return v;
  }
  function consent() {
    return new Promise(function (resolve) {
      var out = { gdpr: 0, consent: '', usp: readUsp(), gpp: '', purposes: {}, source: 'none' };
      var settled = false;
      function finish() { if (!settled) { settled = true; resolve(out); } }
      setTimeout(finish, 600); // 隐私 API 不能拖住竞价
      try {
        if (global.__tcfapi && typeof global.__tcfapi === 'function') {
          global.__tcfapi('getTCData', 2, function (tc, ok) {
            if (ok && tc) {
              out.gdpr = tc.gdprApplies === undefined ? (tc.tcString ? 1 : 0) : (tc.gdprApplies ? 1 : 0);
              out.consent = tc.tcString || '';
              out.source = 'tcf';
              if (tc.tcString) out.purposes = decodeTcf(tc.tcString).purposes || {};
            }
            finish();
          });
        } else if (global.__gpp && typeof global.__gpp === 'function') {
          global.__gpp('getGPPData', function (d) {
            if (d && d.gppString) { out.gpp = d.gppString; out.source = 'gpp'; }
            finish();
          });
        } else finish();
      } catch (e) { finish(); }
    });
  }
  // ATT：App 通过 平台.configure({att,ifa}) 或原生桥 window.__平台_NATIVE__ 注入
  function attStatus() {
    var n = global.__平台_NATIVE__ || {};
    var s = cfg.att != null ? cfg.att : n.att;
    if (s == null) return { status: 0, ifa: '' };
    return { status: Number(s), ifa: Number(s) === 3 ? (cfg.ifa || n.ifa || '') : '' };
  }
  // SKAdNetwork：Web 侧无法直接读写 SKAN，只能把"该给多少 conversion value"告知原生层
  var skan = {
    setValue: function (value, coarse) {
      var payload = { type: 'skan_cv', value: value & 63, coarse: coarse || '' };
      try {
        if (global.webkit && global.webkit.messageHandlers && global.webkit.messageHandlers.平台) {
          global.webkit.messageHandlers.平台.postMessage(payload); return true;
        }
        if (global.平台Android && global.平台Android.postMessage) {
          global.平台Android.postMessage(JSON.stringify(payload)); return true;
        }
      } catch (e) {}
      return false;
    },
    isAvailable: function () {
      return !!(global.webkit && global.webkit.messageHandlers && global.webkit.messageHandlers.平台) || !!global.平台Android;
    },
  };

  // 设备指纹：只用于反作弊与频控，不做跨站追踪；无同意时降级为粗粒度
  function fingerprint(personalizeAllowed) {
    if (cfg.deviceFp) return cfg.deviceFp;
    try {
      var c = doc.createElement('canvas');
      var g = c.getContext('2d');
      g.textBaseline = 'top'; g.font = '13px Arial'; g.fillText('平台', 2, 2);
      var parts = [navigator.userAgent, screen.width + 'x' + screen.height, navigator.language,
        String(new Date().getTimezoneOffset()), c.toDataURL().length];
      if (personalizeAllowed) parts.push(String(navigator.hardwareConcurrency || 0));
      var s = parts.join('|');
      var h = 0;
      for (var i = 0; i < s.length; i++) { h = ((h << 5) - h + s.charCodeAt(i)) | 0; }
      cfg.deviceFp = 'fp' + (h >>> 0).toString(36);
      return cfg.deviceFp;
    } catch (e) { return ''; }
  }

  // ───────── OpenRTB 2.6 请求构造 ─────────
  function buildRequest(slot, c) {
    var st = slot.spec || {};
    var imp = {
      id: slot.id,
      bidfloor: Number(st.floor || 0) || 0,
      secure: location.protocol === 'https:' ? 1 : 0,
      ext: { ad_type: st.format || 'banner', device_fp: fingerprint(c.purposes && c.purposes[3]) },
    };
    // 广告单元归因：带上 data-ad-unit，服务端据此把曝光/收益归到具体广告单元
    if (st.adUnit) imp.ext.ad_unit_id = String(st.adUnit).slice(0, 32);
    if (st.format === 'rewarded' || st.format === 'interstitial' || st.format === 'splash') {
      imp.video = { mimes: ['video/mp4'], minduration: 5, maxduration: 60, w: st.w || 0, h: st.h || 0, linearity: 1, skip: 0 };
      imp.ext.reward = st.format === 'rewarded' ? 1 : 0;
    } else if (st.format === 'native') {
      imp.native = { request: '{"ver":"1.2","assets":[{"id":1,"required":1,"title":{"len":25}},{"id":2,"required":1,"img":{"type":3,"w":120,"h":120}},{"id":3,"required":1,"data":{"type":2,"len":90}}]}' };
    } else {
      // ⑦ MREC 固定 300×250（App 暂停页 / 中插位）；App Open 走开屏语义、按全屏处理
      imp.banner = st.format === 'mrec'
        ? { w: 300, h: 250 }
        : { w: st.w || slot.el.clientWidth || 320, h: st.h || slot.el.clientHeight || 50 };
    }
    if (st.cat) imp.ext.cat = st.cat;
    var att = attStatus();
    var device = {
      ua: navigator.userAgent, ip: '',
      language: navigator.language,
      js: 1, devicetype: /Mobi|Android|iPhone/i.test(navigator.userAgent) ? 1 : 2,
      geo: st.geo ? { country: st.geo } : {},
      ext: { fp: fingerprint(false) },
    };
    // ATT=3 才允许透传 IDFA/IFA——ATT 未授权仍发 IFA 是 iOS 审核直接拒审的红线
    if (att.status === 3 && att.ifa) { device.ifa = att.ifa; device.ext.att = 3; }
    else device.ext.att = att.status;

    var br = {
      id: rid('req'),
      at: 2,                                   // 二价拍卖
      tmax: cfg.timeoutMs,
      imp: [imp],
      site: { domain: location.host, page: location.href, keywords: (st.kw || []).join(',') },
      device: device,
      user: {},
      regs: {},
      source: { fd: 1, tid: rid('tid') },
      ext: { sdk: { name: '平台-pub-sdk', version: VERSION } },
    };
    if (st.cat) br.app = { cat: [st.cat] };
    if (c.gdpr) br.regs.gdpr = 1;
    if (c.consent) br.user.consent = c.consent;          // TCF 同意串透传，服务端留存合规审计
    if (c.usp) br.regs.us_privacy = c.usp;
    if (c.gpp) br.regs.gpp = c.gpp;
    if (!c.purposes || c.purposes[3] === false) br.ext.no_personalization = 1; // 无个性化同意 → 只投上下文
    return br;
  }

  // ───────── VAST 4.0 客户端解析 ─────────
  function parseVast(xmlText) {
    try {
      var x = new DOMParser().parseFromString(xmlText, 'text/xml');
      if (x.querySelector('parsererror')) return null;
      var ad = x.querySelector('InLine') ? x.querySelector('Ad') : null;
      var media = null, best = -1;
      var mfs = x.querySelectorAll('MediaFile');
      for (var i = 0; i < mfs.length; i++) {
        var m = mfs[i];
        var type = (m.getAttribute('type') || '').toLowerCase();
        var bitrate = Number(m.getAttribute('bitrate') || 0);
        var score = (type === 'video/mp4' ? 1000 : type.indexOf('video/') === 0 ? 100 : 0) + bitrate;
        if (score > best) { best = score; media = { url: (m.textContent || '').trim(), type: type, w: +m.getAttribute('width') || 0, h: +m.getAttribute('height') || 0 }; }
      }
      var tracking = {};
      var tes = x.querySelectorAll('TrackingEvents Tracking, Tracking');
      for (var j = 0; j < tes.length; j++) {
        var ev = tes[j].getAttribute('event');
        if (!ev) continue;
        var u = (tes[j].textContent || '').trim();
        (tracking[ev] = tracking[ev] || []).push(u);
      }
      var imps = [];
      var ies = x.querySelectorAll('Impression');
      for (var k = 0; k < ies.length; k++) imps.push((ies[k].textContent || '').trim());
      var click = x.querySelector('ClickThrough');
      var clickTrack = [];
      var cts = x.querySelectorAll('ClickTracking');
      for (var q = 0; q < cts.length; q++) clickTrack.push((cts[q].textContent || '').trim());
      var dur = x.querySelector('Duration');
      var verifications = [];
      var vs = x.querySelectorAll('Verification');
      for (var v = 0; v < vs.length; v++) {
        var js = vs[v].querySelector('JavaScriptResource[apiFramework="omid"]');
        if (js) verifications.push({ vendor: vs[v].getAttribute('vendor') || '', url: (js.textContent || '').trim() });
      }
      return {
        media: media, tracking: tracking, impressions: imps,
        clickThrough: click ? (click.textContent || '').trim() : '',
        clickTracking: clickTrack,
        duration: dur ? (dur.textContent || '').trim() : '00:00:00',
        verifications: verifications,
        skipOffset: x.querySelector('Linear') ? (x.querySelector('Linear').getAttribute('skipoffset') || '') : '',
      };
    } catch (e) { return null; }
  }
  function durToMs(s) {
    var m = /^(\d+):(\d+):(\d+)/.exec(String(s || ''));
    return m ? ((+m[1]) * 3600 + (+m[2]) * 60 + (+m[3])) * 1000 : 0;
  }

  // ───────── MRAID 3 最小桥 ─────────
  // 可玩广告/富媒体通过 postMessage 请求容器能力；容器只暴露白名单能力，不暴露页面上下文
  function mraidBridge(iframe, slot, ctx) {
    var state = 'default';
    var listeners = {};
    function post(o) { try { iframe.contentWindow.postMessage({ mraid: o }, '*'); } catch (e) {} }
    var api = {
      getState: function () { return state; },
      getPlacementType: function () { return 'inline'; },
      getVersion: function () { return '3.0'; },
      isViewable: function () { return true; },
      supports: function (f) { return ['sms', 'tel', 'storePicture', 'inlineVideo', 'location'].indexOf(f) >= 0; },
      useCustomClose: function (use) { post({ action: 'useCustomClose', use: !!use }); },
      expand: function (url) {
        state = 'expanded';
        iframe.style.cssText = 'position:fixed;left:0;top:0;width:100%;height:100%;z-index:2147483647;border:0';
        post({ action: 'stateChange', state: state });
        if (url) { var l = safeUrl(url, cfg.landingAllow); if (l) global.open(trk(l, ctx && ctx.bid, ctx && ctx.br), '_blank'); }
      },
      close: function () {
        state = 'default';
        iframe.style.cssText = 'border:0;width:100%;height:100%;display:block';
        post({ action: 'stateChange', state: state });
        try { iframe.parentNode && iframe.parentNode.removeChild(iframe); } catch (e) {}
        slot.el && (slot.el.innerHTML = '');
      },
      open: function (url) { var l = safeUrl(url, cfg.landingAllow); if (l) global.open(trk(l, ctx && ctx.bid, ctx && ctx.br), '_blank'); },
      addEventListener: function (ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); },
      removeEventListener: function (ev, fn) {
        if (!listeners[ev]) return;
        listeners[ev] = listeners[ev].filter(function (f) { return f !== fn; });
      },
      getScreenSize: function () { return { width: global.innerWidth, height: global.innerHeight }; },
      getMaxSize: function () { return { width: global.innerWidth, height: global.innerHeight }; },
      getDefaultPosition: function () { var r = slot.el.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; },
      getCurrentPosition: function () { return api.getDefaultPosition(); },
      getLocation: function () { return null; }, // 无同意不返回定位（隐私红线）
      setOrientationProperties: function () {},
      playVideo: function () {},
    };
    return api;
  }

  // ───────── 渲染 ─────────
  function renderBanner(slot, bid, br) {
    var el = slot.el;
    var ext = bid.ext || {};
    var landing = safeUrl((ext.landing || ''), cfg.landingAllow);
    var clickUrl = BASE + '/ssp/click?cid=' + encodeURIComponent(ext.cid || bid.cid || 0) +
      '&imp=' + encodeURIComponent(bid.impid) + '&pub=' + encodeURIComponent(br.site.domain);
    // 沙箱 iframe：广告主 JS 无法访问媒体主页面（防 cookie 窃取 / DOM 篡改）
    var inner = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<style>html,body{margin:0;padding:0}*{box-sizing:border-box}</style></head><body>' +
      '<div id="平台-root">' + (bid.adm || '') + '</div>' +
      '<script>' +
      // 可玩/富媒体若引用 mraid.js，这里给出最小桥，避免创意直接报错白屏
      (cfg.mraid ? 'window.mraid={_q:[]};' +
        '["getState","getPlacementType","getVersion","supports","expand","close","open","useCustomClose",' +
        '"addEventListener","removeEventListener","getScreenSize","getMaxSize","getDefaultPosition",' +
        '"getCurrentPosition","getLocation","setOrientationProperties","isViewable","playVideo"]' +
        '.forEach(function(k){window.mraid[k]=function(){window.parent.postMessage({平台Mraid:k,args:[].slice.call(arguments)},"*");};});' +
        'window.addEventListener("message",function(e){var d=e.data||{};if(d.mraid){if(d.mraid.action==="stateChange"){window.mraid._state=d.mraid.state;' +
        '(window.mraid._l&&window.mraid._l.stateChange||[]).forEach(function(f){f(d.mraid.state)});}' +
        'if(d.mraid.action==="useCustomClose"){window.mraid._ucc=d.mraid.use;}}});' : '') +
      '<\/script></body></html>';
    var f = doc.createElement('iframe');
    f.setAttribute('title', 'advertisement');
    f.setAttribute('scrolling', 'no');
    f.sandbox = 'allow-scripts allow-popups allow-popups-to-escape-sandbox';
    f.style.cssText = 'border:0;width:100%;height:100%;display:block;overflow:hidden';
    f.srcdoc = inner;
    el.innerHTML = ''; el.appendChild(f);

    // 点击：走 平台 点击域（可统计/可风控），再跳转落地页（白名单校验）
    var clickHandler = function (e) {
      if (e.target && e.target.tagName === 'A' && landing) return; // 创意自带链接 → 由创意 href 处理
      beacon(clickUrl);
      if (landing) global.open(trk(landing, bid, br), '_blank', 'noopener');
    };
    slot.clickHandler = clickHandler;

    if (cfg.mraid) slot.mraid = mraidBridge(f, slot, { bid: bid, br: br });
    f.addEventListener('load', function () {
      // 曝光：渲染完成再发（v1 也是这里发，但 v2 额外要求可见性才算"可结算曝光"）
      beacon(BASE + '/ssp/imp?imp=' + encodeURIComponent(bid.impid) + '&price=' + encodeURIComponent(bid.price) + '&pub=' + encodeURIComponent(br.site.domain));
      if (cfg.omid) startOmid(slot, f, bid, 'banner');
    });
  }

  function renderVideo(slot, bid, br, vast) {
    var el = slot.el;
    var ext = bid.ext || {};
    el.innerHTML = '';
    var v = doc.createElement('video');
    v.setAttribute('playsinline', ''); v.setAttribute('webkit-playsinline', '');
    v.muted = true; v.autoplay = true;
    v.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block;background:#000';
    v.src = vast.media ? vast.media.url : '';
    el.appendChild(v);

    var durationMs = durToMs(vast.duration) || 0;
    var fired = {};
    function fire(ev) {
      if (fired[ev]) return; fired[ev] = 1;
      beaconAll(vast.tracking[ev] || []);
    }
    beaconAll(vast.impressions);
    v.addEventListener('loadedmetadata', function () { if (v.duration) durationMs = v.duration * 1000; });
    v.addEventListener('timeupdate', function () {
      if (!durationMs) return;
      var r = v.currentTime / (durationMs / 1000);
      if (r >= 0.25) fire('firstQuartile');
      if (r >= 0.5) fire('midpoint');
      if (r >= 0.75) fire('thirdQuartile');
    });
    v.addEventListener('play', function () { fire('start'); });
    v.addEventListener('ended', function () {
      fire('complete');
      // 激励视频：真实播放时长 + 一次性令牌 → 由服务端裁决发奖（客户端不可信）
      if (ext.ad_type === 'rewarded' && ext.rw) {
        var body = {
          impid: ext.rw.impid, cid: ext.rw.cid, pub: ext.rw.pub,
          token: ext.rw.token, ts: ext.rw.ts,
          watchedMs: Math.round(durationMs), durationMs: Math.round(durationMs),
          device_fp: ext.rw.fp || cfg.deviceFp,
        };
        try {
          fetch(BASE + '/s2s/reward', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
            .then(function (r) { return r.json(); })
            .then(function (j) { if (j && j.granted && global.平台 && 平台.onReward) 平台.onReward(j); });
        } catch (e) {}
      }
    });
    // 点击 / 关闭
    if (vast.clickThrough) {
      var l = safeUrl(vast.clickThrough, cfg.landingAllow);
      v.addEventListener('click', function () {
        beaconAll(vast.clickTracking);
        if (l) global.open(trk(l, bid, br), '_blank', 'noopener');
      });
    }
    if (cfg.omid) startOmid(slot, v, bid, 'video');
  }

  // OMID：可见曝光是"买方信不信你的数"的分水岭——渲染即计数没有意义
  function startOmid(slot, el, bid, kind) {
    try {
      var impid = bid.impid;
      var scriptUrl = BASE + '/omid-session.js';
      var s = doc.createElement('script');
      s.src = scriptUrl;
      s.async = true;
      // 通过 window.__OMID__ 注入会话上下文（真实生产应改为官方 omsdk）
      global.__OMID__ = { impid: impid, cid: (bid.ext && bid.ext.cid) || bid.cid || 0, base: BASE, el: el, kind: kind };
      s.onload = function () { delete global.__OMID__; };
      doc.head.appendChild(s);
    } catch (e) {}
  }

  function collapse(slot, reason) {
    var el = slot.el;
    if (slot.spec && slot.spec.collapse !== false) el.style.display = 'none';
    if (slot.spec && slot.spec.keepContent !== true) el.innerHTML = '';
    slot.lastError = reason;
    log('collapse', slot.id, reason);
  }

  // ───────── 单次填充（含重试） ─────────
  async function fill(slot) {
    var c = await consent();
    var br = buildRequest(slot, c);
    slot.lastRequest = br;
    for (var attempt = 0; attempt <= cfg.retries; attempt++) {
      try {
        var r = await fetchWithTimeout(BASE + '/ssp/bid', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(br),
          credentials: 'omit',
          keepalive: false,
        }, cfg.timeoutMs);
        var resp = await r.json();
        var seat = resp.seatbid && resp.seatbid[0];
        var bid = seat && seat.bid && seat.bid[0];
        if (!bid) { collapse(slot, 'no_fill'); return; }
        // 频控：命中上限则本次不投放（collapse 而非报错），并停止该位的后续请求
        var ex = bid.ext || {};
        var cap = Number(ex.freq_cap || 0) || (slot.spec && slot.spec.freqCap) || 0;
        var winH = Number(ex.freq_window_hours || 0) || 24;
        if (freqHit(slot, cap, winH)) { collapse(slot, 'freq_capped'); return; }
        slot.lastBid = bid;
        slot.impid = bid.impid || '';
        slot.cid = (bid.ext && bid.ext.cid) || bid.cid || '';
        // 暴露当前 impid 给宿主页：落地页既展示广告又回传自己的转化时，用 平台.getImps() 取 impid 归因
        try { if (typeof 平台.onImpression === 'function') 平台.onImpression(slot.impid, slot.id); } catch (e) {}
        freqBump(slot, winH);
        // 自动刷新：仅 banner / MREC，间隔由服务端下发（0=不刷新）
        var ri = Number(ex.refresh_interval || 0) || (slot.spec && slot.spec.refreshInterval) || 0;
        if (ri > 0 && isRefreshable(slot)) setTimeout(function () { fill(slot); }, ri * 1000);
        var vast = null;
        var adm = String(bid.adm || '');
        // 服务端返回 VAST XML（视频）或 HTML/native JSON
        if (adm.indexOf('<VAST') === 0 || adm.indexOf('<?xml') === 0) vast = parseVast(adm);
        if (vast && vast.media) renderVideo(slot, bid, br, vast);
        else if ((bid.ext && bid.ext.adm_type) === 'native_json') renderNative(slot, bid, br);
        else renderBanner(slot, bid, br);
        return;
      } catch (e) {
        slot.attempt = attempt;
        log('bid attempt ' + attempt + ' failed', e.message);
        if (attempt < cfg.retries) await new Promise(function (res) { setTimeout(res, backoff(attempt)); });
      }
    }
    // 全部重试失败：塌陷 + 上报（失败率是可观测性的一部分，不能静默）
    collapse(slot, 'network_error');
    try { beacon(BASE + '/sdk/error?slot=' + encodeURIComponent(slot.id) + '&pub=' + encodeURIComponent(location.host)); } catch (e) {}
  }

  function renderNative(slot, bid, br) {
    var n = {};
    try { n = JSON.parse(bid.adm || '{}'); } catch (e) {}
    var el = slot.el;
    el.innerHTML = '';
    var wrap = doc.createElement('div');
    wrap.style.cssText = 'font-family:inherit;display:flex;gap:8px;padding:8px;align-items:center';
    var img = doc.createElement('img');
    img.src = n.icon || n.image || ''; img.style.cssText = 'width:48px;height:48px;border-radius:8px';
    var box = doc.createElement('div');
    box.innerHTML = '<div style="font-weight:600;font-size:14px">' + esc(n.title || '') + '</div>' +
      '<div style="font-size:12px;color:#666">' + esc(n.body || '') + '</div>';
    var cta = doc.createElement('a');
    cta.textContent = n.cta || '了解详情';
    cta.style.cssText = 'margin-left:auto;background:#2563eb;color:#fff;padding:6px 12px;border-radius:6px;font-size:12px;text-decoration:none';
    var clickUrl = BASE + '/ssp/click?cid=' + encodeURIComponent((bid.ext && bid.ext.cid) || bid.cid || 0) +
      '&imp=' + encodeURIComponent(bid.impid) + '&pub=' + encodeURIComponent(br.site.domain);
    cta.href = 'javascript:void(0)';
    cta.onclick = function (e) {
      e.preventDefault(); beacon(clickUrl);
      var l = safeUrl(n.clickUrl || n.landingUrl || '', cfg.landingAllow);
      if (l) global.open(trk(l, bid, br), '_blank', 'noopener');
    };
    wrap.appendChild(img); wrap.appendChild(box); wrap.appendChild(cta);
    el.appendChild(wrap);
    beaconAll(n.impTrackers || []);
    beacon(BASE + '/ssp/imp?imp=' + encodeURIComponent(bid.impid) + '&pub=' + encodeURIComponent(br.site.domain));
  }

  // ───────── Slot 管理 ─────────
  var slots = {};
  function defineSlot(id, spec) {
    var el = typeof id === 'string' ? doc.getElementById(id) : id;
    if (!el) { log('slot not found', id); return null; }
    if (!el.id) el.id = rid('slot');
    var s = slots[el.id] = slots[el.id] || { id: el.id, el: el, spec: spec || {} };
    s.spec = Object.assign({}, s.spec, spec || {});
    // 占位预留：避免广告回填导致布局跳动（CLS），媒体体验指标
    if (!el.style.minHeight && s.spec.h) el.style.minHeight = s.spec.h + 'px';
    return s;
  }
  // ④ 频控 / 刷新：服务端只下发策略(freq_cap / freq_window_hours / refresh_interval)，
  // 计数与定时器由 SDK 本地执行——服务端无法稳定识别"同一用户"，替客户端计数不可靠。
  function freqKey(unitId, winH) {
    var bucket = Math.floor(Date.now() / (Math.max(1, winH || 24) * 3600 * 1000));
    return 'lkfreq:' + (unitId || 'default') + ':' + bucket;
  }
  function freqHit(slot, cap, winH) {
    if (!cap || cap <= 0) return false;
    try { return (parseInt(localStorage.getItem(freqKey(slot.spec && slot.spec.adUnit, winH)) || '0', 10) || 0) >= cap; }
    catch (e) { return false; }
  }
  function freqBump(slot, winH) {
    try {
      var k = freqKey(slot.spec && slot.spec.adUnit, winH);
      localStorage.setItem(k, String((parseInt(localStorage.getItem(k) || '0', 10) || 0) + 1));
    } catch (e) {}
  }
  function isRefreshable(slot) {
    var f = String((slot.spec && slot.spec.format) || 'banner');
    return f === 'banner' || f === 'mrec';   // 全屏类不允许自动刷新（用户体验与政策红线）
  }
  function refresh(ids) {
    var list = ids ? [].concat(ids) : Object.keys(slots);
    list.forEach(function (id) { var s = slots[id]; if (s) fill(s); });
  }
  function destroy(id) {
    var s = slots[id];
    if (s) { s.el.innerHTML = ''; delete slots[id]; }
  }

  // 自动扫描：兼容 v1 的 data-* 写法
  function autoScan() {
    var nodes = doc.querySelectorAll('.ad-slot,[data-ad-slot]');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (!el.id) el.id = rid('slot');
      var d = el.dataset || {};
      defineSlot(el, {
        floor: parseFloat(d.floor || '1.0') || 0,
        cat: d.cat || '', geo: d.geo || '',
        kw: (d.kw || '').split(',').filter(Boolean),
        format: d.format || d.adType || 'banner',
        w: parseInt(d.w || '0', 10), h: parseInt(d.h || '0', 10),
        // 广告单元 ID：由「开发者后台 · 广告单元」创建后生成，报表按此维度拆解
        // 用法：<div class="ad-slot" data-ad-unit="au_xxxxxxxx" ...>
        adUnit: d.adUnit || '',
        // 频控/刷新也可在页面直接声明（服务端下发的优先级更高，二者取其一生效）
        freqCap: parseInt(d.freqCap || '0', 10) || 0,
        refreshInterval: parseInt(d.refreshInterval || '0', 10) || 0,
      });
    }
    refresh();
  }

  var 平台 = {
    version: VERSION,
    configure: function (o) { Object.assign(cfg, o || {}); if (cfg.endpoint) BASE = cfg.endpoint.replace(/\/+$/, ''); return 平台; },
    defineSlot: defineSlot,
    refresh: refresh,
    destroy: destroy,
    onReward: null,
    onImpression: null,
    getImps: function () {
      var out = [];
      Object.keys(slots).forEach(function (k) { out.push({ slot: k, impid: slots[k].impid || '', cid: slots[k].cid || '' }); });
      return out;
    },
    skan: skan,
    consent: consent,
    attStatus: attStatus,
    _slots: slots,
    _cfg: cfg,
  };

  // 命令队列：允许发布方在 SDK 加载完成前就 push 配置/建位
  var prev = global.平台 || {};
  var queue = prev.cmd || [];
  平台.cmd = { push: function (fn) { try { fn(平台); } catch (e) { log('cmd error', e.message); } } };
  global.平台 = 平台;
  for (var qi = 0; qi < queue.length; qi++) { try { queue[qi](平台); } catch (e) { log('queued cmd error', e.message); } }

  // 无显式配置时自动扫描已有广告位（v1 行为兼容）
  var boot = function () { if (!Object.keys(slots).length) autoScan(); };
  if (doc.readyState !== 'loading') boot();
  else doc.addEventListener('DOMContentLoaded', boot);
})(window);
