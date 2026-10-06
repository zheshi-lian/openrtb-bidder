/* onboarding.js —— 上手引导清单（对标 AppLovin / 汇量 Mintegral 的 Onboarding Checklist）
 *
 * 设计要点：
 *   ① 明确分步：把"开户后该干什么"固化成一条可见链路，而不是让用户面对空白后台。
 *   ② 完成态自动判定：能查接口的一律查接口（充值余额 / 归因配置 / 素材 / 计划 / 审核），
 *      查不到的（SDK 接入、自检、收款）允许手动勾选，状态持久化到 localStorage。
 *   ③ 深链：每一步直达对应设置页，不做"只提示不给入口"。
 *
 * 用法：
 *   <div id="onb"></div> ... <script src="/onboarding.js"></script>
 *   Onboarding.mount('advertiser', 'onb');   // 或 Onboarding.mount('publisher', 'onb');
 */
window.Onboarding = (function () {
  function authJson(url) {
    var t = (window.Auth && Auth.get && Auth.get()) || {};
    return fetch(url, { headers: { Authorization: 'Bearer ' + (t.token || '') } })
      .then(function (r) { return r.json().catch(function () { return null; }); })
      .catch(function () { return null; });
  }
  function lsKey(role, id) { return 'applink_onb_' + role + '_' + id; }
  function n(v) { return Array.isArray(v) ? v.length : 0; }

  var STEPS = {
    advertiser: [
      { id: 'recharge', title: '账户充值', desc: '充值「账户余额（钱包）」后计划才会参拍；计划预算只是单条计划的花费上限',
        link: '/adv-account.html#sec-billing', linkText: '去充值',
        check: function () {
          return authJson('/api/advertiser/settings').then(function (d) {
            var b = (d && d.balance_cny) || 0;
            return { done: b > 0, hint: b > 0 ? ('余额 ¥' + Number(b).toFixed(2)) : '当前余额 ¥0.00' };
          });
        } },
      { id: 'attrib', title: '像素 / 归因接入', desc: '配置 AppsFlyer / Adjust / SKAN 回传与追踪链接，ROAS 与 oCPI 才有真实转化口径',
        link: '/adv-account.html#sec-attribution', linkText: '去配置',
        check: function () {
          return authJson('/api/mmp/config').then(function (d) {
            var c = n(d);
            return { done: c > 0, hint: c ? (c + ' 个归因平台已配置') : '未配置（将回退到平台内部统计）' };
          });
        } },
      { id: 'creative', title: '上传 / 生成素材', desc: '开户已自动下发一套示例素材；也可在素材库上传或用 AI 生成',
        link: '/adv-media.html', linkText: '去素材库',
        check: function () {
          return authJson('/api/creatives').then(function (d) {
            var all = n(d), ok = Array.isArray(d) ? d.filter(function (c) { return c.creative_status === 'approved'; }).length : 0;
            return { done: all > 0, hint: all ? (all + ' 个素材，其中 ' + ok + ' 个已通过') : '暂无素材' };
          });
        } },
      { id: 'campaign', title: '创建广告计划', desc: '设置出价策略（CPM / CPA / oCPI / Target ROAS）与定向、频控',
        link: '/campaigns.html', linkText: '去建计划',
        check: function () {
          return authJson('/api/campaigns').then(function (d) {
            var c = n(d);
            return { done: c > 0, hint: c ? (c + ' 个计划') : '尚未创建计划' };
          });
        } },
      { id: 'review', title: '通过审核', desc: '计划与素材都需审核通过才会真实投放；驳回会显示原因，可修改后重提',
        link: '/campaigns.html', linkText: '查看审核状态',
        check: function () {
          return Promise.all([authJson('/api/campaigns'), authJson('/api/creatives')]).then(function (r) {
            var cs = r[0], cr = r[1];
            var cOk = Array.isArray(cs) && cs.some(function (c) { return c.review_status === 'approved'; });
            var kOk = Array.isArray(cr) && cr.some(function (c) { return c.creative_status === 'approved'; });
            return { done: !!(cOk && kOk), hint: (cOk ? '计划已通过' : '计划待审/被驳回') + ' · ' + (kOk ? '素材已通过' : '素材待审/被驳回') };
          });
        } }
    ],
    publisher: [
      { id: 'key', title: '获取 api_key', desc: '入驻即自动生成；SDK 埋点与服务端对接都用它', link: '/pub-account.html', linkText: '查看密钥', manual: true },
      { id: 'units', title: '创建应用与广告单元', desc: '定义版位形态（横幅 / 激励视频 / 原生…）与底价', link: '/ad_units.html', linkText: '去创建',
        check: function () {
          return Promise.all([authJson('/api/apps'), authJson('/api/ad-units')]).then(function (r) {
            var an = n(r[0]), un = n(r[1]);
            return { done: an > 0 && un > 0, hint: an + ' 个应用 / ' + un + ' 个广告单元' };
          });
        } },
      { id: 'sdk', title: 'SDK 接入 / 埋点', desc: '在页面或 App 放置广告位容器并引入 SDK，即可自动竞价与渲染', link: '/sdk-guide.html', linkText: '接入指南', manual: true },
      { id: 'check', title: '集成自检', desc: '验证竞价请求已到达并有胜出，确认能真实产生填充', link: '/integrity.html', linkText: '运行自检', manual: true },
      { id: 'payout', title: '收款与结算信息', desc: '补全收款方式后，收益才会进入结算打款流程', link: '/pub-account.html', linkText: '去补全', manual: true }
    ]
  };

  var TITLES = { advertiser: '上手引导 · 开通清单', publisher: '上手引导 · 接入清单' };
  var SUBS = {
    advertiser: '按 充值 → 归因接入 → 素材 → 建计划 → 审核 的顺序完成即可开始投放；已完成项自动勾选（对标 AppLovin ADVERTISE Onboarding）。',
    publisher: '按 取密钥 → 建版位 → SDK 接入 → 自检 → 收款 的顺序完成即可开始变现（对标 AppLovin MAX Onboarding）。'
  };

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  async function mount(role, elId) {
    var host = document.getElementById(elId);
    var steps = STEPS[role];
    if (!host || !steps) return;
    var hiddenKey = 'applink_onb_hidden_' + role;
    if (localStorage.getItem(hiddenKey) === '1') return;

    host.innerHTML = '<div class="onb-card"><div class="onb-hd"><b>' + TITLES[role] + '</b>' +
      '<span class="onb-prog" id="onb-prog">检查中…</span>' +
      '<button class="onb-x" id="onb-x" title="不再显示">✕</button></div>' +
      '<div class="onb-sub">' + SUBS[role] + '</div><div class="onb-steps" id="onb-steps"></div></div>';

    document.getElementById('onb-x').onclick = function () {
      localStorage.setItem(hiddenKey, '1');
      host.innerHTML = '';
    };

    // 并行判定完成态
    var results = await Promise.all(steps.map(function (s) {
      if (!s.check) return Promise.resolve(null);   // manual
      return s.check().catch(function () { return { done: false, hint: '状态获取失败' }; });
    }));

    var box = document.getElementById('onb-steps');
    box.innerHTML = steps.map(function (s, i) {
      var manualDone = s.manual && localStorage.getItem(lsKey(role, s.id)) === '1';
      var r = results[i] || {};
      var done = s.manual ? manualDone : !!r.done;
      var hint = s.manual ? (manualDone ? '已手动标记完成' : '无法自动检测，完成后请手动勾选') : (r.hint || '');
      return '<div class="onb-step' + (done ? ' done' : '') + '" data-i="' + i + '">' +
        '<span class="onb-dot" data-toggle="' + (s.manual ? s.id : '') + '" title="' + (s.manual ? '点击标记完成/未完成' : '') + '">' + (done ? '✓' : '') + '</span>' +
        '<div class="onb-body"><div class="onb-t">' + esc(s.title) + '</div>' +
        '<div class="onb-d">' + esc(s.desc) + '</div>' +
        (hint ? '<div class="onb-hint">' + esc(hint) + '</div>' : '') + '</div>' +
        '<a class="onb-go" href="' + s.link + '">' + esc(s.linkText) + ' →</a></div>';
    }).join('');

    // 手动步骤：点圆点切换完成态
    box.querySelectorAll('.onb-dot[data-toggle]').forEach(function (d) {
      d.onclick = function () {
        var id = d.getAttribute('data-toggle'); if (!id) return;
        var k = lsKey(role, id);
        var cur = localStorage.getItem(k) === '1';
        if (cur) localStorage.removeItem(k); else localStorage.setItem(k, '1');
        mount(role, elId);
      };
    });

    var doneCount = steps.filter(function (s, i) {
      return s.manual ? localStorage.getItem(lsKey(role, s.id)) === '1' : !!(results[i] && results[i].done);
    }).length;
    document.getElementById('onb-prog').textContent = doneCount + ' / ' + steps.length + ' 已完成';
  }

  // 样式注入（只注入一次）
  (function inject() {
    if (document.getElementById('onb-css')) return;
    var st = document.createElement('style'); st.id = 'onb-css';
    st.textContent =
      '.onb-card{background:#16203a;border:1px solid #26355c;border-radius:10px;padding:14px 16px;margin:12px 0}' +
      '.onb-hd{display:flex;align-items:center;gap:10px;font-size:14px;color:#e8eefc}' +
      '.onb-hd b{font-size:15px}' +
      '.onb-prog{font-size:12px;color:#93a3c4}' +
      '.onb-x{margin-left:auto;background:transparent;border:0;color:#93a3c4;cursor:pointer;font-size:13px}' +
      '.onb-x:hover{color:#f87171}' +
      '.onb-sub{font-size:12px;color:#93a3c4;line-height:1.6;margin:4px 0 10px}' +
      '.onb-steps{display:flex;flex-direction:column;gap:8px}' +
      '.onb-step{display:flex;align-items:flex-start;gap:10px;padding:9px 11px;border:1px solid #26355c;border-radius:8px;background:#0d1730}' +
      '.onb-step.done{border-color:#234a35;background:#12241a}' +
      '.onb-dot{flex:none;width:20px;height:20px;border-radius:50%;border:1px solid #2f4170;color:#34d399;font-size:12px;line-height:19px;text-align:center;margin-top:1px}' +
      '.onb-step.done .onb-dot{background:#16321f;border-color:#234a35}' +
      '.onb-dot[data-toggle]{cursor:pointer}' +
      '.onb-dot[data-toggle]:hover{border-color:#3b82f6}' +
      '.onb-body{flex:1;min-width:0}' +
      '.onb-t{font-size:13px;color:#e8eefc;font-weight:600}' +
      '.onb-step.done .onb-t{color:#86efac}' +
      '.onb-d{font-size:12px;color:#93a3c4;margin-top:2px}' +
      '.onb-hint{font-size:11.5px;color:#7f8c8d;margin-top:3px}' +
      '.onb-go{flex:none;font-size:12px;color:#7fd1ff;text-decoration:none;align-self:center;white-space:nowrap}' +
      '.onb-go:hover{text-decoration:underline}';
    document.head.appendChild(st);
  })();

  return { mount: mount, STEPS: STEPS };
})();
