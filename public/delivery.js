// delivery.js - 投放监控页面逻辑
const $ = id => document.getElementById(id);

async function load() {
  try {
    const d = await (await fetch('/api/advertiser/me')).json();
    if (!d || !d.stats) return;
    
    // ① 投放概览
    $('totalImp').textContent = (d.stats.impressions || 0).toLocaleString();
    $('totalSpend').textContent = '¥' + (d.stats.spent_cny || 0).toFixed(2);
    $('totalCvr').textContent = (d.stats.conversions || 0).toLocaleString();
    
    // ② 投放检查清单
    const checklist = $('checklist');
    checklist.innerHTML = '';
    const checks = [];
    
    // 检查 1: 是否有计划
    const camps = d.campaigns || [];
    if (camps.length > 0) {
      checks.push({ok: true, text: '✓ 已创建投放计划 (' + camps.length + ' 个)'});
    } else {
      checks.push({ok: false, text: '✗ 未创建投放计划 → <a href="/campaigns.html" style="color:#7fd1ff">去创建</a>'});
    }
    
    // 检查 2: 是否有已审核通过的计划
    const approvedCamp = camps.filter(c => c.review_status === 'approved');
    if (approvedCamp.length > 0) {
      checks.push({ok: true, text: '✓ 计划已审核通过 (' + approvedCamp.length + ' 个)'});
    } else if (camps.length > 0) {
      checks.push({ok: false, text: '⏳ 计划待审核 → 联系平台运营审核'});
    }
    
    // 检查 3: 账户余额
    const bal = Number(d.profile && d.profile.balance_cny) || 0;
    if (bal > 0) {
      checks.push({ok: true, text: '✓ 账户余额充足 (¥' + bal.toFixed(2) + ')'});
    } else {
      checks.push({ok: false, text: '⚠ 账户余额不足 → <a href="/adv-account.html" style="color:#7fd1ff">去充值</a>'});
    }
    
    // 检查 4: 是否有曝光
    const imp = d.stats.impressions || 0;
    if (imp > 0) {
      checks.push({ok: true, text: '✓ 广告正在投放中 (已曝光 ' + imp.toLocaleString() + ' 次)'});
    } else {
      checks.push({ok: false, text: '⚠ 暂无曝光 → 确认素材已审核通过且落地页可访问'});
    }
    
    checks.forEach(c => {
      const li = document.createElement('li');
      li.className = c.ok ? 'ok' : 'no';
      li.innerHTML = c.text;
      checklist.appendChild(li);
    });
    
    // ③ 计划详情
    const campTbl = document.querySelector('#campTbl tbody');
    campTbl.innerHTML = '';
    camps.forEach(c => {
      const tr = document.createElement('tr');
      const rs = c.review_status || 'pending';
      const rsTag = rs === 'approved' ? '<span class="tag ok">已通过</span>' : 
                     rs === 'rejected' ? '<span class="tag no">已驳回</span>' : 
                     '<span class="tag warn">待审核</span>';
      const statusTag = c.status === 1 ? '<span class="tag ok">启用</span>' : '<span class="tag no">停用</span>';
      tr.innerHTML = '<td>' + c.id + '</td><td>' + c.name + '</td><td>¥' + (Number(c.budget_cny) || 0).toFixed(0) + '</td><td>' + statusTag + '</td><td>' + rsTag + '</td>';
      campTbl.appendChild(tr);
    });
    if (!camps.length) campTbl.innerHTML = '<tr><td colspan="5">暂无计划</td></tr>';
    
  } catch(e) { console.error('load failed:', e); }
}

async function loadPerf() {
  const dim = $('perfDim').value;
  const days = $('perfDays').value;
  try {
    const d = await (await fetch('/api/advertiser/performance?dim=' + dim + '&days=' + days)).json();
    const tb = document.querySelector('#perfTbl tbody');
    tb.innerHTML = '';
    
    if (d.total) {
      const tr = document.createElement('tr');
      tr.style.fontWeight = '700';
      tr.style.background = '#132043';
      const ctr = d.total.impressions ? (d.total.clicks / d.total.impressions * 100).toFixed(2) : '0';
      const cpm = d.total.impressions ? (d.total.spend_cny / d.total.impressions * 1000).toFixed(2) : '0';
      tr.innerHTML = '<td>合计</td><td>' + d.total.impressions.toLocaleString() + '</td><td>' + d.total.clicks + '</td><td>' + ctr + '%</td><td>¥' + d.total.spend_cny.toFixed(2) + '</td><td>' + cpm + '</td><td>' + d.total.conversions + '</td><td>' + (d.total.spend_cny ? (d.total.gmv_cny / d.total.spend_cny).toFixed(2) : '0') + '</td>';
      tb.appendChild(tr);
    }
    
    (d.items || []).forEach(item => {
      const tr = document.createElement('tr');
      tr.innerHTML = '<td>' + item.key + '</td><td>' + item.impressions.toLocaleString() + '</td><td>' + item.clicks + '</td><td>' + item.ctr + '%</td><td>¥' + item.spend_cny.toFixed(2) + '</td><td>' + item.cpm_cny.toFixed(2) + '</td><td>' + item.conversions + '</td><td>' + (item.spend_cny ? (item.gmv_cny / item.spend_cny).toFixed(2) : '0') + '</td>';
      tb.appendChild(tr);
    });
    if (!(d.items || []).length) tb.innerHTML = '<tr><td colspan="8">暂无数据</td></tr>';
  } catch(e) { 
    document.querySelector('#perfTbl tbody').innerHTML = '<tr><td colspan="8">加载失败</td></tr>';
  }
}

// 初始化 — 带 3 秒超时兜底
if (Auth.ready()) {
  load();
  loadPerf();
} else {
  Auth.onAuth(function() {
    load();
    loadPerf();
  });
}
// 3 秒后若 checklist 仍为"加载中..."，显示超时兜底
setTimeout(function() {
  var checklist = $('checklist');
  if (checklist && checklist.textContent && checklist.textContent.indexOf('加载中') >= 0) {
    checklist.innerHTML = '<li class="no">⏱ 数据加载超时 — <a href="javascript:load()" style="color:#7fd1ff">点击重试</a></li>';
  }
  // 投放概览超时兜底
  var totalImp = $('totalImp');
  if (totalImp && totalImp.textContent === '0') {
    var wrap = totalImp.parentElement.parentElement;
    if (wrap && wrap.textContent.indexOf('0') >= 0 && wrap.textContent.indexOf('¥0') >= 0) {
      wrap.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:20px;color:#93a3c4">⏱ 数据加载超时 — <a href="javascript:load()" style="color:#7fd1ff">点击重试</a></div>';
    }
  }
}, 3000);

// 每 60 秒自动刷新
setInterval(function() {
  if (Auth.ready()) {
    load();
    loadPerf();
  }
}, 60000);