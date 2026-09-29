// 意图 Agent 原型（演示"去需求方检索意图 -> 提升 eCPM"）
// 真实版：用 LLM/爬虫去电商/应用商店/论坛/社媒检索广告主意图，
// 命中后自动在 adv_campaign 建 campaign 或上调 intent_tags，让 bidder 出价更高。
// 这里用"模拟意图信号"演示匹配与 eCPM 抬升。

const SAMPLES = [
  { source: 'Reddit r/puzzlegames', text: '我们刚上线一款益智解谜游戏，正在找北美用户量', ctx: { app_category: 'puzzle', country: 'US', keywords: ['puzzle', 'game', 'casual'] } },
  { source: '淘宝卖家社群', text: '北美站大促，求性价比流量', ctx: { app_category: '', country: 'US', keywords: ['shop', 'ecommerce', 'sale'] } },
  { source: '独立工具开发者论坛', text: 'utility app 想买量装机', ctx: { app_category: 'tools', country: '', keywords: ['tools', 'utility', 'install'] } }
];

// 极简关键词意图抽取（真实用 LLM 抽取 entity+intent）
function extractIntent(text) {
  const kw = [];
  if (/puzzle|game|益智|解谜/i.test(text)) kw.push('puzzle', 'game', 'casual');
  if (/shop|电商|大促|sale|促销/i.test(text)) kw.push('shop', 'ecommerce', 'sale');
  if (/utility|工具|装机|install/i.test(text)) kw.push('tools', 'utility', 'install');
  return kw;
}

async function run() {
  for (const s of SAMPLES) {
    const ctx = { ...s.ctx, keywords: [...(s.ctx.keywords || []), ...extractIntent(s.text)] };
    try {
      const r = await fetch('http://127.0.0.1:8080/api/intent-match', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ctx)
      });
      const d = await r.json();
      const top = d.matches[0];
      console.log(`\n[信号] ${s.source}\n  文本: ${s.text}`);
      console.log(`  最佳匹配广告主: #${top.id} ${top.name} | 意图匹配度=${(top.intent_score*100).toFixed(0)}% | 预估eCPM=${top.est_cpm_cny}元`);
      console.log(`  → 命中后该广告主出价上浮，对应库存 eCPM 更高`);
    } catch (e) { console.error('err', e.message); }
  }
}
run();
