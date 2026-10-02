// smoke_test.js —— 端到端冒烟：起服务 → 打真实请求 → 校验新增能力均已生效
// 跑法：node smoke_test.js（会占用 PORT，默认 8099；跑完自动退出）
process.env.PORT = process.env.PORT || '8099';
process.env.ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'smoke-test-token-0123456789';
process.env.BID_QPS_LIMIT = '0';          // 冒烟不做限流
const PORT = process.env.PORT;
// 注意：llm.js 会在启动时加载 .env 并【覆盖】同名环境变量（仓库既定设计），
// 因此必须在 require('./server') 之后再取实际生效的令牌，否则会拿到被覆盖前的值。
require('./server'); // 启动（含 init 建表）
const TOKEN = require('./security').ADMIN_TOKEN;
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? ' → ' + JSON.stringify(extra).slice(0, 300) : '')); }
}
const admin = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN };
async function get(p) { const r = await fetch(BASE + p, { headers: admin }); return { status: r.status, body: await r.json().catch(() => null) }; }
async function post(p, b) {
  const r = await fetch(BASE + p, { method: 'POST', headers: admin, body: JSON.stringify(b) });
  return { status: r.status, body: await r.json().catch(() => null) };
}
async function postPub(p, b) {
  const r = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
  return { status: r.status, body: await r.json().catch(() => null) };
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
(async () => {
  await sleep(2500);

  console.log('\n[公开端点]');
  const health = await fetch(BASE + '/health').then(r => r.json());
  check('GET /health', health.ok === true);
  const ads = await fetch(BASE + '/ads.txt').then(r => r.text());
  check('GET /ads.txt 含 DIRECT 声明', ads.includes('DIRECT') && ads.includes('dellai.xyz'));
  const appAds = await fetch(BASE + '/app-ads.txt').then(r => r.text());
  check('GET /app-ads.txt 可访问', typeof appAds === 'string' && appAds.includes('app-ads.txt'));
  const sj = await fetch(BASE + '/sellers.json').then(r => r.json());
  check('GET /sellers.json 结构合规', sj.version === '1' && Array.isArray(sj.identifiers) && sj.identifiers.length > 0);

  // 自愈：上一轮冒烟写进库的时段/频控/品牌安全策略会影响本轮出价，先恢复默认
  const RUN = Date.now();
  await fetch(BASE + '/api/brand-safety/1', {
    method: 'PUT', headers: admin,
    body: JSON.stringify({ garmMaxTier: 2, floorStrict: true, bcat: [], badv: [], bapp: [], blocklist: [], allowlist: [] }),
  });
  await post('/api/pacing/1', { mode: 'SMOOTH', daypart: { days: [0, 1, 2, 3, 4, 5, 6], hours: Array.from({ length: 24 }, (_, i) => i) }, freqCap: null });

  console.log('\n[竞价链路]');
  const sspReq = {
    id: 'smoke-' + RUN, at: 2,
    site: { domain: 'smoke.test', page: 'https://smoke.test/' },
    device: { ua: 'Mozilla/5.0 (iPhone)', ip: '1.2.3.4', geo: { country: 'US' }, devicetype: 1, ext: { fp: 'fp-smoke-' + RUN } },
    imp: [{ id: 'slot1', bidfloor: 1.0, ext: { ad_type: 'banner' }, banner: { w: 320, h: 50 } }],
  };
  const ssp = await postPub('/ssp/bid', sspReq);
  check('POST /ssp/bid 返回胜出广告', ssp.status === 200 && !!(ssp.body.seatbid || []).length, ssp.body);
  const dspReq = {
    id: 'smoke-dsp-' + RUN, at: 1,
    site: { domain: 'smoke.test', keywords: 'game,puzzle' },
    device: { geo: { country: 'US' }, devicetype: 1, ext: { fp: 'fp-dsp-' + RUN } },
    imp: [{ id: 'slot1', bidfloor: 1.0, ext: { ad_type: 'banner', cat: 'puzzle' } }],
  };
  const dsp = await postPub('/openrtb2/bid', dspReq);
  const bid = dsp.body && dsp.body.seatbid && dsp.body.seatbid[0] && dsp.body.seatbid[0].bid && dsp.body.seatbid[0].bid[0];
  check('POST /openrtb2/bid 有出价', !!bid, dsp.body);
  if (bid) {
    const e = bid.ext || {};
    check('出价含多目标预估 pctr/pctcvr/pltv', typeof e.pctr === 'number' && typeof e.pctcvr === 'number' && typeof e.pltv_micros === 'number', e);
    check('一价拍卖已做 shading（shade<1 且 p_win 有值）', e.shade <= 1 && typeof e.p_win === 'number', { shade: e.shade, p_win: e.p_win });
    check('出价带 GARM 分级', typeof e.garm_tier === 'number', e.garm_tier);
  }

  console.log('\n[管理端点 · 新增能力]');
  const idStats = await get('/api/identity/stats');
  check('GET /api/identity/stats', idStats.status === 200 && typeof idStats.body.nodes === 'number', idStats.body);
  const thr = await get('/api/bid/throttle');
  check('GET /api/bid/throttle', thr.status === 200, thr.body);
  const wr = await get('/api/bid/winrate');
  check('GET /api/bid/winrate 胜率分布已积累', wr.status === 200 && typeof wr.body === 'object', wr.body);
  const caps = await get('/api/creative-auto/capabilities');
  check('GET /api/creative-auto/capabilities', caps.status === 200 && Array.isArray(caps.body.playable_modes), caps.body);
  const mls = await get('/api/ml/snapshot');
  check('GET /api/ml/snapshot 含特征版本与维度', mls.status === 200 && !!mls.body.feature_version && mls.body.dim > 0, { v: mls.body.feature_version, dim: mls.body.dim });
  const health2 = await get('/api/ml/health');
  check('GET /api/ml/health', health2.status === 200, health2.body);
  const bs = await get('/api/brand-safety/1');
  check('GET /api/brand-safety/:cid', bs.status === 200 && typeof bs.body.garmMaxTier === 'number', bs.body);
  const pc = await get('/api/pacing/1');
  check('GET /api/pacing/:cid', pc.status === 200 && !!pc.body.mode, pc.body);
  const inv = await get('/api/billing/invoices');
  check('GET /api/billing/invoices', inv.status === 200 && Array.isArray(inv.body), inv.body);
  const aging = await get('/api/billing/aging');
  check('GET /api/billing/aging 账龄桶完整', aging.status === 200 && !!aging.body.buckets, aging.body);
  const incrList = await get('/api/incrementality');
  check('GET /api/incrementality', incrList.status === 200 && Array.isArray(incrList.body), incrList.body);

  console.log('\n[写操作 · 关键回路]');
  const exp = await post('/api/incrementality/create', { name: 'smoke-holdout', type: 'holdout', campaignId: 1, controlPct: 20 });
  check('POST /api/incrementality/create', exp.status === 200 && !!exp.body.id, exp.body);
  if (exp.body && exp.body.id) {
    const an = await get('/api/incrementality/' + exp.body.id + '/analyze');
    check('实验可分析（样本不足时给 INCONCLUSIVE 而非硬结论）', an.status === 200 && an.body.ok === true, an.body);
  }
  const play = await post('/api/creative-auto/playable', { mode: 'tap_target', title: '烟测', ctaText: '下载' });
  check('POST /api/creative-auto/playable 产出可玩广告', play.status === 200 && String(play.body.html || '').includes('<canvas'), play.body && play.body.bytes);
  const vid = await post('/api/creative-auto/video', { images: ['https://x/a.jpg', 'https://x/b.jpg'], sceneMs: 2000 });
  check('POST /api/creative-auto/video 产出分镜与渲染方式', vid.status === 200 && vid.body.storyboard.scenes.length === 2 && String(vid.body.ffmpeg).startsWith('ffmpeg'), vid.body && vid.body.storyboard);
  // 每次用独立账户名，保证可重复执行（不依赖上一次跑完的状态）
  const party = 'smoke-advertiser-' + RUN;
  const acc = await post('/api/billing/account', { party, partyType: 'advertiser', terms: 'prepay', invoiceTitle: '烟测科技', taxId: '91310000XXXX' });
  check('POST /api/billing/account 建户', acc.status === 200 && acc.body.party === party, acc.body);
  const before = Number((acc.body || {}).balance_micros) || 0;
  const top = await post('/api/billing/topup', { party, partyType: 'advertiser', micros: 100000000 });
  check('POST /api/billing/topup 充值入账', top.status === 200 && top.body.balance_micros === before + 100000000, top.body);
  const inc = await post('/api/billing/invoice', { party, partyType: 'advertiser', start: '2026-01-01', end: '2026-02-01' });
  check('POST /api/billing/invoice 开票', inc.status === 200 && !!inc.body.invoice_no, inc.body && { no: inc.body.invoice_no, total: inc.body.total_micros, tax: inc.body.tax_micros });
  if (inc.body && inc.body.invoice_no) {
    const got = await get('/api/billing/invoice/' + inc.body.invoice_no);
    check('GET 发票含明细行与税额', got.status === 200 && Array.isArray(got.body.lines) && typeof got.body.tax_micros === 'number',
      got.body && { lines: (got.body.lines || []).length, total: got.body.total_micros, tax: got.body.tax_micros });
  }
  const skanSchema = await post('/api/skan/schema', { campaign_id: 1, version: '4.0', events: [{ name: 'purchase', value: 32, priority: 100, coarse: 'high', valueMicros: 60000000 }] });
  check('POST /api/skan/schema 定义转换值编码', skanSchema.status === 200 && skanSchema.body.events.length === 1, skanSchema.body);
  const skanGet = await get('/api/skan/schema/1');
  check('GET /api/skan/schema 可读回', skanGet.status === 200 && skanGet.body.campaignId === 1, skanGet.body);
  // 写操作打到专用 campaign(999999)，避免污染真实 campaign 1 的投放策略
  const bsSave = await fetch(BASE + '/api/brand-safety/999999', { method: 'PUT', headers: admin, body: JSON.stringify({ garmMaxTier: 1, bcat: ['IAB11'] }) }).then(r => r.json());
  check('PUT /api/brand-safety 保存策略', bsSave.garmMaxTier === 1, bsSave);
  const pcSave = await post('/api/pacing/999999', { mode: 'SMOOTH', daypart: { days: [1, 2, 3, 4, 5], hours: [9, 10, 11, 12, 13, 14, 15, 16, 17, 18] }, freqCap: { count: 3, windowSec: 86400, scope: 'device' } });
  check('POST /api/pacing 保存时段与频控', pcSave.status === 200 && pcSave.body.freqCap.count === 3, pcSave.body);

  console.log('\n[可观测性]');
  const m = await get('/metrics');
  check('GET /metrics 含分位数与 QPS', m.status === 200 && !!m.body.hist && !!m.body.qps, Object.keys(m.body || {}));
  const slo = await get('/metrics/slo');
  check('GET /metrics/slo 返回 SLO 判定', slo.status === 200 && !!slo.body.bid_latency, slo.body);

  console.log(`\n冒烟通过 ${pass} / 失败 ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('smoke error', e); process.exit(2); });
