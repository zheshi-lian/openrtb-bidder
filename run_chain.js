// 全链路演示（真实 LLM 版）：商汤 Sensenova 意图 Agent + 小红书媒体 + 真实广告主推 SLAM 教育机器人
// 用法：先把服务跑起来（npm start，已配 .env 接 Sensenova），再 node run_chain.js
const BASE = 'http://127.0.0.1:8080';

const CREATIVE = `<div style="width:300px;font-family:'Microsoft YaHei',sans-serif;background:linear-gradient(135deg,#0f2027,#203a43,#2c5364);color:#fff;border-radius:10px;padding:14px;box-shadow:0 4px 14px rgba(0,0,0,.3)">
  <div style="font-size:13px;opacity:.8">面向高校 / 教培 · 小红书首发</div>
  <div style="font-size:18px;font-weight:700;margin:4px 0">SLAM 教育机器人</div>
  <div style="font-size:12px;line-height:1.5;opacity:.9">建图定位 · 点对点导航 · 线激光+超声波避障<br>一套套件，开箱即做导航实验</div>
  <div style="margin-top:10px;display:inline-block;background:#16a085;padding:6px 12px;border-radius:6px;font-size:13px;font-weight:600">免费申请教学套件 →</div>
</div>`;

const log = (t, o) => { console.log('\n=== ' + t + ' ==='); console.log(typeof o === 'string' ? o : JSON.stringify(o, null, 2)); };
const post = (p, b) => fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(r => r.json());
const get = (p) => fetch(BASE + p).then(r => r.json());
const put = (p) => fetch(BASE + p, { method: 'PUT', headers: { 'Content-Type': 'application/json' } }).then(r => r.json());

(async () => {
  // 0) 确认 LLM 已接入
  const meta0 = await post('/api/intent-match', {});
  log('0) 意图 Agent LLM 状态', { llm_enabled: meta0.llm_enabled });

  // 1) 供给端：注册「小红书」作为媒体方（受众=年轻家长/学生/STEM教育兴趣）
  const pub = await post('/api/publisher', {
    domain: 'xiaohongshu.com', name: '小红书(媒体方)', contact: 'bd@xiaohongshu.com',
    payout_rate: 0.65, site_url: 'https://www.xiaohongshu.com',
    cat: 'social', geo: 'CN',
    keywords: '教育,机器人,STEM,编程,数码,母婴,高校,教培,科技,创客'
  });
  log('① 媒体方入驻（供给=小红书）', pub);

  // 2) 需求端：真实广告主推 SLAM 教育机器人（若已存在则复用）
  let camps = await get('/api/campaigns');
  let slam = camps.find(c => (c.name || '').includes('SLAM'));
  if (!slam) {
    const c = await post('/api/campaign', {
      name: 'SLAM教育机器人-小红书招商', advertiser: '真实广告主-XX机器人',
      budget_cny: 5000, country: 'CN', app_category: 'education',
      creative_html: CREATIVE, landing_url: 'https://example.com/slam-edu',
      target_cpm_cny: 12, intent_tags: 'SLAM,机器人,教育,高校,教培,导航,创客'
    });
    slam = { id: c.id };
    log('② 广告主建 campaign（需求）', c);
  } else {
    log('② 复用已有 SLAM campaign', { id: slam.id });
  }

  // 3) 审核通过（新素材默认 pending，必须 approved 才参拍）
  const ap = await put('/api/campaign/' + slam.id + '/approve');
  log('③ 素材审核通过', ap);

  // 4) LLM 抽取真实意图画像（替代启发式）
  const ex = await post('/api/intent-extract/' + slam.id, {});
  log('④ LLM 抽取意图画像', { tags: ex.intent_tags, profile: ex.intent_profile, llm_enabled: ex.llm_enabled });

  // 5) 一次真实曝光：模拟用户刷小红书（cat=social/education, 兴趣含 机器人/STEM/教育）
  const ctx = {
    id: 'imp-xhs-001',
    site: { domain: 'xiaohongshu.com', keywords: '教育,机器人,STEM,编程' },
    imp: [{ id: 'imp-xhs-001', bidfloor: 2.0, ext: { cat: 'social' } }],
    device: { geo: { country: 'CN' } }
  };
  const ssp = await post('/ssp/bid', ctx);
  const bid = ssp.seatbid?.[0]?.bid?.[0];
  log('⑤ 小红书曝光 → SSP 二价竞价胜出', {
    seat: ssp.seatbid?.[0]?.seat,
    win_price_cny: bid?.price / 1e6,
    intent_score: bid?.ext?.intent_score,
    intent_source: bid?.ext?.intent_source,
    intent_reason: bid?.ext?.intent_reason,
    landing: bid?.ext?.landing,
    creative_returned: !!bid?.adm
  });

  // 模拟用户点击创意 + 落地页转化（线索留资）
  await fetch(BASE + `/ssp/click?cid=${bid?.ext?.cid || slam.id}&imp=imp-xhs-001&pub=xiaohongshu.com`).then(() => {});
  await post('/api/track/conversion', { cid: slam.id, publisher: 'xiaohongshu.com', impid: 'imp-xhs-001' });
  log('⑥ 转化漏斗', { click: '已上报 /ssp/click', conversion: '已上报 /api/track/conversion' });

  // 7) 意图检索排序（真实 LLM 相关性）
  const im = await post('/api/intent-match', { app_category: 'social', country: 'CN', keywords: ['教育', '机器人', 'STEM', '编程'] });
  log('⑦ 意图检索排序（小红书上下文）', {
    llm_enabled: im.llm_enabled,
    matches: im.matches.map(m => ({ id: m.id, name: m.name, score: m.intent_score, source: m.source, reason: m.reason, est_cpm: m.est_cpm_cny }))
  });

  // 8) 账本
  const rep = await get('/report');
  const sspRep = await get('/ssp/report');
  log('⑧ 广告主报表', { wins: rep.wins, spent_cny: rep.spent_cny, campaigns: rep.campaigns.length });
  log('⑨ SSP / 媒体方双边账本 + 转化', sspRep);

  console.log('\n=== 结论 ===');
  console.log('小红书(媒体)曝光 → 自有 DSP 用 Sensenova LLM 语义匹配命中 SLAM 教育机器人 → 二价清盘 → 沙箱 iframe 渲染创意 → 广告主按清盘价扣费/媒体方分成 → 点击+转化漏斗可追踪。');
})().catch(e => { console.error('CHAIN ERROR', e); process.exit(1); });
