// pub_sdk.js —— 媒体方(供给)一键接入广告位标签（安全版：沙箱 iframe 渲染 + 点击/曝光上报）
// 用法：在页面放 <div class="ad-slot" data-floor="1.0" data-cat="education" data-geo="CN" data-kw="教育,机器人"></div>
//       然后 <script src="https://你的SSP域名/pub_sdk.js"></script>
// SDK 自动向【本脚本所在域名】的 /ssp/bid 发 OpenRTB 请求（跨域嵌入任意媒体站都可用），
// 用沙箱 iframe 渲染胜出创意（隔离广告主脚本），并上报曝光/点击。
(function () {
  // 自动取“本 SDK 脚本所在域名”作为接口基址 → 跨域嵌入到任意媒体站都能正确请求你的 SSP
  function sspBase() {
    const tags = document.querySelectorAll('script[src]');
    for (const t of tags) {
      if (t.src && t.src.indexOf('pub_sdk.js') !== -1) {
        try { return new URL(t.src).origin; } catch (e) {}
      }
    }
    return location.origin; // 兜底：同源
  }
  const BASE = sspBase();

  function buildBid(slot) {
    const domain = location.host || 'unknown';
    const floor = parseFloat(slot.dataset.floor || '1.0');
    const cat = slot.dataset.cat || '';
    const geo = slot.dataset.geo || '';
    const kw = (slot.dataset.kw || '').split(',').filter(Boolean);
    return {
      id: 'ssp-' + Math.random().toString(36).slice(2),
      site: { domain: domain, page: location.href },
      app: cat ? { cat: cat } : undefined,
      device: { geo: geo ? { country: geo } : {} },
      imp: [{ id: slot.id || 'slot', bidfloor: floor, ext: { cat: cat }, banner: { w: slot.clientWidth || 320, h: slot.clientHeight || 90 } }],
      ext: { keywords: kw.join(',') }
    };
  }
  // 信任域名白名单（落地页必须在此内才允许跳转，防钓鱼/违规外跳）
  // ⚠️ 对外正式投放前，把合作广告主的落地页域名加进来
  const LANDING_ALLOW = ['example.com', 'xiaohongshu.com', 'your-landing.com'];
  function safeLanding(u) {
    try { const h = new URL(u); return LANDING_ALLOW.some(d => h.hostname === d || h.hostname.endsWith('.' + d)); } catch (e) { return false; }
  }
  async function fill(slot) {
    try {
      const br = buildBid(slot);
      const r = await fetch(BASE + '/ssp/bid', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(br) });
      const resp = await r.json();
      const seat = resp.seatbid && resp.seatbid[0];
      const bid = seat && seat.bid && seat.bid[0];
      if (!bid) { slot.innerHTML = '<div style="color:#999;font-size:12px">暂无广告填充</div>'; return; }
      const landing = (bid.ext && bid.ext.landing) || '#';
      const ok = safeLanding(landing);
      const href = ok ? landing : '#';
      const rel = ok ? 'nofollow' : 'nofollow';
      // 创意包进沙箱 iframe 的 srcdoc：广告主 JS 无法访问媒体主页面（防 cookie 窃取/DOM 篡改）
      const srcdoc =
        '<a href="' + href + '" target="_blank" rel="' + rel + '"' +
        (ok ? ' onclick="navigator.sendBeacon&&navigator.sendBeacon(\'' + BASE + '/ssp/click?cid=' + encodeURIComponent(bid.ext && bid.ext.cid || 0) + '&imp=' + encodeURIComponent(bid.impid) + '&pub=' + encodeURIComponent(br.site.domain) + '\')"' : '') +
        ' style="text-decoration:none;display:block;color:inherit">' + bid.adm + '</a>';
      const f = document.createElement('iframe');
      f.sandbox = 'allow-scripts allow-popups allow-popups-to-escape-sandbox';
      f.setAttribute('title', 'advertisement');
      f.style.cssText = 'border:0;width:100%;height:100%;display:block;overflow:hidden';
      f.srcdoc = srcdoc;
      slot.innerHTML = '';
      slot.appendChild(f);
      f.addEventListener('load', function () {
        new Image().src = BASE + '/ssp/imp?imp=' + encodeURIComponent(bid.impid) + '&price=' + bid.price + '&pub=' + encodeURIComponent(br.site.domain);
      });
    } catch (e) { /* 静默失败，不影响媒体页面 */ }
  }
  function init() { document.querySelectorAll('.ad-slot,[data-ad-slot]').forEach(fill); }
  if (document.readyState !== 'loading') init(); else document.addEventListener('DOMContentLoaded', init);
})();
