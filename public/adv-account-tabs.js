/* adv-account-tabs.js —— 账户页「分区导航」（收起式，一次只显示一个分区）
 *
 * 为什么这么做（对标 AppLovin / Mintegral）：
 *   · 这些内容属于「账户」页内的**设置分区**，不是投放流程；流程在首页「上手引导」（充值→归因→素材→建计划→审核）。
 *   · 竞品把它们放在账户页的标签条 / 左侧栏，一次只展示一个分区，并用角标区分「必填 / 建议 / 可选」，
 *     避免一个页面堆 7 个大块导致"不知道哪些必须填"。
 *
 * 依赖：页面里每个分区的标题形如 <h3 id="sec-xxx">，其祖先 .panel 即该分区容器。
 */
(function () {
  var META = {
    'sec-profile': { label: '① 账户信息', level: 'req', tip: '开户资料，建议补全' },
    'sec-billing': { label: '② 计费与支付', level: 'req', tip: '投放必填：账户余额为 0 不会参拍' },
    'sec-team': { label: '③ 团队与权限', level: 'opt', tip: '可选' },
    'sec-keys': { label: '④ API 密钥', level: 'opt', tip: '可选：Open API 对接用' },
    'sec-notif': { label: '⑤ 通知偏好', level: 'opt', tip: '可选' },
    'sec-attribution': { label: '⑥ 归因 & 事件', level: 'rec', tip: '效果投放（ROAS / oCPI）建议配置' },
    'sec-compliance': { label: '⑦ 合规 & 隐私', level: 'rec', tip: 'App 类投放建议配置' }
  };
  var LEVEL = {
    req: { text: '必填', bg: '#3a1d24', fg: '#f87171' },
    rec: { text: '建议', bg: '#2a2410', fg: '#fbbf24' },
    opt: { text: '可选', bg: '#15203a', fg: '#93a3c4' }
  };

  function build() {
    var host = document.getElementById('acct-tabs');
    if (!host) return;
    // 收集分区（标题带 sec- 前缀的 h3，其 .panel 祖先即分区容器）
    var secs = [];
    Array.prototype.forEach.call(document.querySelectorAll('h3[id^="sec-"]'), function (h) {
      var panel = h.closest ? h.closest('.panel') : null;
      if (!panel) return;
      secs.push({ id: h.id, panel: panel, meta: META[h.id] || { label: h.textContent, level: 'opt', tip: '可选' } });
    });
    if (!secs.length) return;

    // 清理：仅移除本脚本此前可能生成的动态节点（静态 pill 已从 HTML 删除，由本脚本统一渲染，避免 removeChild 抛错阻断 build）
    var prevList = host.querySelector('#acct-tablist'); if (prevList) prevList.remove();
    var prevTip = host.querySelector('#acct-tip'); if (prevTip) prevTip.remove();

    var list = document.createElement('div');
    list.id = 'acct-tablist';
    list.style.cssText = 'display:flex;gap:7px;flex-wrap:wrap';
    secs.forEach(function (s, i) {
      var lv = LEVEL[s.meta.level] || LEVEL.opt;
      var b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('data-sec', s.id);
      b.innerHTML = s.meta.label + ' <span style="font-size:10px;padding:1px 6px;border-radius:8px;background:' + lv.bg + ';color:' + lv.fg + '">' + lv.text + '</span>';
      b.style.cssText = 'margin:0;padding:6px 12px;border-radius:16px;border:1px solid #26355c;background:#0d1730;color:#93a3c4;font-size:12.5px;cursor:pointer;font-family:inherit';
      b.title = s.meta.tip;
      b.onclick = function () { activate(s.id, true); };
      list.appendChild(b);
      s.btn = b;
    });
    host.appendChild(list);

    var tip = document.createElement('div');
    tip.id = 'acct-tip';
    tip.style.cssText = 'font-size:12px;color:#93a3c4;margin-top:7px';
    host.appendChild(tip);

    window.__acctSecs = secs;
    function activate(id, push) {
      secs.forEach(function (s) {
        var on = s.id === id;
        s.panel.style.display = on ? '' : 'none';
        if (s.btn) {
          s.btn.style.background = on ? '#1d3a5c' : '#0d1730';
          s.btn.style.color = on ? '#e8eefc' : '#93a3c4';
          s.btn.style.borderColor = on ? '#3b82f6' : '#26355c';
        }
        if (on) tip.textContent = s.meta.tip + '（本页分区为设置项，不是投放流程；流程见首页「上手引导」）';
      });
      if (push && location.hash !== '#' + id) {
        try { history.replaceState(null, '', '#' + id); } catch (e) { location.hash = id; }
      }
    }
    window.__acctActivate = activate;

    var initial = (location.hash || '').replace('#', '');
    var found = secs.some(function (s) { return s.id === initial; });
    activate(found ? initial : secs[0].id, false);

    window.addEventListener('hashchange', function () {
      var h = (location.hash || '').replace('#', '');
      if (h && secs.some(function (s) { return s.id === h; })) activate(h, false);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build);
  else build();
})();
