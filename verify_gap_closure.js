// verify_gap_closure.js —— 差距补齐自测（纯逻辑，无需 DB / 网络）
// 跑法：node verify_gap_closure.js
// 目的：新增的每个能力层都要有可断言的行为，而不是"能 require 进来"就算完成。
const assert = require('assert');

const trust = require('./trust');
const pacing = require('./pacing');
const metrics = require('./metrics');
const brandSafety = require('./brand_safety');
const identity = require('./identity_graph');
const attribution = require('./attribution');
const creative = require('./creative');
const ml = require('./ml');
const bidEng = require('./bid');

let pass = 0, fail = 0;
const results = [];
function t(name, fn) {
  try { fn(); pass++; results.push('  ✓ ' + name); }
  catch (e) { fail++; results.push('  ✗ ' + name + ' → ' + e.message); }
}
async function ta(name, fn) {
  try { await fn(); pass++; results.push('  ✓ ' + name); }
  catch (e) { fail++; results.push('  ✗ ' + name + ' → ' + e.message); }
}
function section(s) { results.push('\n[' + s + ']'); }

(async () => {
  // ───────── 1. 信任层 ─────────
  section('Tier0 信任层 ads.txt / app-ads.txt / sellers.json');
  t('解析 ads.txt：合法行 + 非法关系 + 变量', () => {
    const txt = ['# comment', 'contact=adops@dellai.xyz',
      'google.com, pub-123, RESELLER, f08c47fec0942fa0',
      'dellai.xyz, 1, DIRECT, iabtechlab.com',
      'bad.com, 2, MAYBE'].join('\n');
    const p = trust.parseAdsTxt(txt);
    assert.strictEqual(p.records.length, 2, '两条合法记录');
    assert.strictEqual(p.errors.length, 1, '一条非法(MAYBE)');
    assert.strictEqual(p.variables.contact, 'adops@dellai.xyz');
  });
  t('校验授权：DIRECT + 匹配 seller_id 才通过', () => {
    const recs = [{ domain: 'dellai.xyz', accountId: '1', relationship: 'DIRECT' }];
    assert.strictEqual(trust.verifyRecords(recs, '1').authorized, true);
    assert.strictEqual(trust.verifyRecords(recs, '9').reason, 'ACCOUNT_MISMATCH');
    assert.strictEqual(trust.verifyRecords([], '1').reason, 'NO_ENTRY');
  });
  t('app-ads.txt 校验 App Store ID 必须为数字', () => {
    const p = trust.parseAppAdsTxt('dellai.xyz, 1234567890, DIRECT, iabtechlab.com\ndellai.xyz, abc, DIRECT');
    assert.strictEqual(p.records.length, 1);
    assert.strictEqual(p.errors[0].why, 'BAD_APP_ID');
  });
  await ta('sellers.json 至少包含自身 INTERMEDIARY 条目', async () => {
    const sj = await trust.sellersJson();
    assert.ok(Array.isArray(sj.identifiers) && sj.identifiers.length >= 1);
    assert.strictEqual(sj.identifiers[0].seller_type, 'INTERMEDIARY');
    assert.strictEqual(sj.version, '1');
  });
  t('我方 ads.txt 内容含自身 DIRECT 声明', () => {
    assert.ok(trust.adsTxtContent().includes(trust.OUR_DOMAIN));
    assert.ok(trust.adsTxtContent().includes('DIRECT'));
  });

  // ───────── 2. Pacing ─────────
  section('Tier0 Pacing：时段 + 频控 + 流量曲线');
  t('daypart：掩码可精确控制星期/小时', () => {
    const mask = pacing.daypartNormalize({ days: [1, 2, 3, 4, 5], hours: [9, 10] }); // 工作日 9-10 点
    assert.strictEqual(mask.length, 42, '42 个 hex = 168 位');
    const mon9 = new Date(2026, 0, 5, 9, 0);  // 2026-01-05 是周一
    const mon11 = new Date(2026, 0, 5, 11, 0);
    const sat9 = new Date(2026, 0, 10, 9, 0); // 周六
    assert.strictEqual(pacing.inDaypart(mask, mon9), true, '周一9点在时段内');
    assert.strictEqual(pacing.inDaypart(mask, mon11), false, '周一11点不在');
    assert.strictEqual(pacing.inDaypart(mask, sat9), false, '周六不在');
  });
  t('流量曲线：期望消耗比例随时间单调递增且收敛到 1', () => {
    let prev = -1;
    for (let h = 0; h < 24; h++) {
      const f = pacing.expectedFraction(new Date(2026, 0, 1, h, 30));
      assert.ok(f > prev, 'h=' + h);
      prev = f;
    }
    assert.ok(Math.abs(pacing.expectedFraction(new Date(2026, 0, 1, 23, 59)) - 1) < 0.02);
  });
  t('paceEval：超日预算停投 / 超前于节奏停投 / 落后则提价', () => {
    const c = { daily_cap_micros: 1000 };
    assert.strictEqual(pacing.paceEval(c, 1000, { now: new Date(2026, 0, 1, 12) }).allowed, false);
    const ahead = pacing.paceEval(c, 900, { now: new Date(2026, 0, 1, 3) }); // 凌晨花掉 90%
    assert.strictEqual(ahead.allowed, false, '凌晨花 90% 属超前');
    assert.ok(ahead.bidAdjust <= 1);
    const behind = pacing.paceEval(c, 10, { now: new Date(2026, 0, 1, 20) });
    assert.strictEqual(behind.allowed, true);
    assert.ok(behind.bidAdjust > 1, '落后节奏应提价抢量');
  });
  await ta('频控：窗口内超次数即拦截', async () => {
    const cfg = { freqCap: { count: 2, windowSec: 60, scope: 'device' } };
    const ids = { deviceId: 'dev-verify-1' };
    assert.strictEqual((await pacing.freqAllow(1, cfg, ids)).ok, true);
    assert.strictEqual((await pacing.freqAllow(1, cfg, ids)).ok, true);
    const third = await pacing.freqAllow(1, cfg, ids);
    assert.strictEqual(third.ok, false);
    assert.strictEqual(third.reason, 'FREQ_CAP');
  });

  // ───────── 3. 竞价工程 ─────────
  section('Tier1 竞价工程：胜率模型 / shading / 限流 / p99');
  t('清盘价分布：CDF 单调，P50 落在样本中位', () => {
    const d = new bidEng.winrate.ClearingDist();
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].forEach(x => d.observe(x * 1e6));
    assert.ok(d.cdf(1e6) < d.cdf(5e6));
    assert.ok(d.cdf(10.5e6) >= d.cdf(5e6));
    assert.ok(Math.abs(d.quantile(0.5) / 1e6 - 5.5) <= 1, 'P50≈5.5 元');
  });
  t('bid shading：一价下出价 < 估值且 ≥ 底价，且最大化期望利润', () => {
    const ctx = { publisher: 'shade.test', format: 'banner', country: 'US' };
    // 需要 ≥30 个样本才会启用清盘价分布（否则走冷启动保守系数，属预期行为）
    for (let i = 0; i < 100; i++) bidEng.winrate.observeClearing(ctx, (1 + (i % 20)) * 1e6);
    const value = 12e6, floor = 1e6;
    const r = bidEng.shade({ valueMicros: value, floorMicros: floor, ctx, auctionType: 1, exploreEps: 0 });
    assert.ok(r.bidMicros < value, '一价必须低于估值（shading 生效）');
    assert.ok(r.bidMicros >= floor, '不得低于底价');
    // 网格最优：邻近档位的期望利润不应更高
    const profitAt = (b) => (value - b) * (bidEng.winrate.pWin(ctx, b).p || 0);
    assert.ok(profitAt(r.bidMicros) + 1e-6 >= profitAt(Math.max(floor, r.bidMicros * 0.85)), '比更低价更优');
    assert.ok(profitAt(r.bidMicros) + 1e-6 >= profitAt(Math.min(value, r.bidMicros * 1.15)), '比更高价更优');
  });
  t('二价拍卖不做 shading（付次高价）', () => {
    const r = bidEng.shade({ valueMicros: 10e6, floorMicros: 1e6, ctx: {}, auctionType: 2 });
    assert.strictEqual(r.bidMicros, 10e6);
    assert.strictEqual(r.shade, 1);
  });
  t('分位数：p99 ≥ p95 ≥ p50，且能识别尾部毛刺', () => {
    const h = new metrics.Histogram();
    for (let i = 0; i < 1000; i++) h.observe(2 + Math.random());
    for (let i = 0; i < 40; i++) h.observe(500);   // 约 4% 请求被打成 500ms
    const s = h.snapshot();
    assert.ok(s.p50 < s.p95 && s.p95 <= s.p99, JSON.stringify(s));
    assert.ok(s.p99 > 50, '尾部毛刺应体现在 p99，而 avg 会掩盖它');
    assert.ok(s.avg < 25, '均值看起来还行（这正是只看均值会漏掉尾部的陷阱）: avg=' + s.avg);
  });
  t('SLO：p99 超阈值即判定违约', () => {
    const name = 'slo.test';
    for (let i = 0; i < 200; i++) metrics.observe(name, 3);
    assert.strictEqual(metrics.slo(name, 10).ok, true);
    for (let i = 0; i < 20; i++) metrics.observe(name, 80);
    assert.strictEqual(metrics.slo(name, 10).ok, false);
  });
  await ta('deadlineAll：超时返回已到达结果，不被最慢者拖死', async () => {
    const slow = new Promise(r => setTimeout(() => r('slow'), 500));
    const fast = Promise.resolve('fast');
    const out = await bidEng.deadlineAll([fast, slow], 50);
    assert.strictEqual(out[0], 'fast');
    assert.strictEqual(out[1], undefined, '慢的那个被 deadline 丢弃');
  });

  // ───────── 4. ML 平台 ─────────
  section('Tier1 ML：特征平台 / 校准 / 多目标 pLTV / Bandit / 注册');
  t('特征平台：维度固定、在线离线同一实现、缺失字段有默认值', () => {
    const x1 = ml.fs.compute({ cat: 'puzzle', ctxCat: 'puzzle', relScore: 0.5, format: 'rewarded', geo: 'US' });
    const x2 = ml.fs.compute({ cat: 'puzzle', ctxCat: 'puzzle', relScore: 0.5, format: 'rewarded', geo: 'US' });
    assert.strictEqual(x1.length, ml.fs.DIM);
    assert.deepStrictEqual(x1, x2, '同输入必须同输出（可复现）');
    assert.ok(x1.every(v => Number.isFinite(v)), '不得出现 NaN/Infinity');
    assert.strictEqual(ml.fs.compute({}).length, ml.fs.DIM, '空上下文也要出向量');
  });
  t('漂移监控 PSI：同分布≈0，异分布显著大于 0', () => {
    const a = Array.from({ length: 500 }, () => Math.random());
    const b = Array.from({ length: 500 }, () => Math.random());
    const c = Array.from({ length: 500 }, () => 5 + Math.random());
    assert.ok(ml.fs.psi(a, b) < 0.1, '同分布 PSI 应很小');
    assert.ok(ml.fs.psi(a, c) > 0.25, '异分布 PSI 应显著');
  });
  t('校准：Platt 能显著降低未校准模型的 ECE', () => {
    // 构造"系统性高估"的模型输出：真实概率 = 预测/3
    const pairs = Array.from({ length: 1200 }, () => {
      const p = Math.random() * 0.6 + 0.1;
      return { score: p, label: Math.random() < p / 3 ? 1 : 0 };
    });
    const before = ml.cal.ece(pairs).ece;
    const m = ml.cal.fitPlatt(pairs);
    const after = ml.cal.ece(pairs.map(p => ({ score: ml.cal.platt(m, p.score), label: p.label }))).ece;
    assert.ok(after < before, `校准后 ECE 应下降 (${before} → ${after})`);
    assert.ok(after < 0.05, '校准后 ECE 应进入可用区间');
  });
  t('校准：Isotonic 输出保持单调', () => {
    const pairs = Array.from({ length: 800 }, () => {
      const s = Math.random();
      return { score: s, label: Math.random() < s * s ? 1 : 0 };
    });
    const m = ml.cal.fitIsotonic(pairs);
    let prev = -1;
    for (let i = 0; i <= 10; i++) {
      const v = ml.cal.isotonic(m, i / 10);
      assert.ok(v >= prev - 1e-9, '保序');
      prev = v;
    }
  });
  t('多目标：pCTR/pCVR/pLTV 输出合法，学习后估值上升', () => {
    const ctx = { cat: 'game', ctxCat: 'game', relScore: 0.8, format: 'rewarded', geo: 'US', floorMicros: 3e6 };
    const x = ml.fs.compute(ctx);
    const before = ml.mo.predict(999, x);
    assert.ok(before.pctr > 0 && before.pctr < 1);
    assert.ok(before.pcvr > 0 && before.pcvr < 1);
    assert.ok(before.pltv_micros >= 0);
    assert.ok(Math.abs(before.pctcvr - before.pctr * before.pcvr) < 1e-9, 'ESMM: pCTCVR = pCTR×pCVR');
    for (let i = 0; i < 300; i++) ml.mo.learn(999, x, { click: 1, conv: 1, valueMicros: 50e6 });
    const after = ml.mo.predict(999, x);
    assert.ok(after.pctr > before.pctr, '正样本回流后 pCTR 应上升');
    assert.ok(after.pltv_micros > before.pltv_micros, 'pLTV 应学到价值');
  });
  t('出价：ROAS / CPA / CPM 三种目标口径正确', () => {
    const pred = { pctr: 0.02, pcvr: 0.1, pctcvr: 0.002, pltv_micros: 100e6, expected_value_micros: 200000, cold: false };
    const roas = ml.mo.bidFor({ pred, goal: { type: 'ROAS', targetRoas: 2 }, floorMicros: 0 });
    assert.strictEqual(roas.bidMicros, 100000, '出价 = 期望价值 / 目标 ROAS');
    const cpa = ml.mo.bidFor({ pred, goal: { type: 'CPA', targetCpaMicros: 50e6 }, floorMicros: 0 });
    assert.strictEqual(cpa.bidMicros, 100000, '出价 = pCTCVR × 目标 CPA');
    const cpm = ml.mo.bidFor({ pred, goal: { type: 'CPM', targetCpmMicros: 5e6 }, floorMicros: 6e6 });
    assert.strictEqual(cpm.bidMicros, 6e6, 'CPM 目标也要过底价');
  });
  t('LinUCB：能学会"在给定上下文下哪个 arm 更好"', () => {
    const ctxA = { cat: 'game', ctxCat: 'game', relScore: 0.9, format: 'rewarded', geo: 'US', hour: 20 };
    const ctxB = { cat: 'edu', ctxCat: 'edu', relScore: 0.2, format: 'banner', geo: 'IN', hour: 3 };
    // 训练：arm1 在 ctxA 好，arm2 在 ctxB 好
    for (let i = 0; i < 60; i++) {
      ml.bandit.update('vt:arm1', ctxA, 1); ml.bandit.update('vt:arm1', ctxB, 0);
      ml.bandit.update('vt:arm2', ctxA, 0); ml.bandit.update('vt:arm2', ctxB, 1);
    }
    const pickA = ml.bandit.choose([{ key: 'vt:arm1', ctx: ctxA }, { key: 'vt:arm2', ctx: ctxA }]);
    const pickB = ml.bandit.choose([{ key: 'vt:arm1', ctx: ctxB }, { key: 'vt:arm2', ctx: ctxB }]);
    assert.strictEqual(pickA.key, 'vt:arm1', '游戏/晚间上下文应选 arm1');
    assert.strictEqual(pickB.key, 'vt:arm2', '教育/凌晨上下文应选 arm2');
  });
  t('模型注册：特征版本不匹配必须拒绝注册', async () => {
    const r = ml.registry.register({ name: 'pCVR', version: '1', featureVersion: 'WRONG', params: {} });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'FEATURE_VERSION_MISMATCH');
  });
  t('模型注册：promote 后同一 name 只允许一个 active', () => {
    ml.registry.register({ name: 'regTest', version: 'v1' });
    ml.registry.register({ name: 'regTest', version: 'v2' });
    ml.registry.promote('regTest:v1', 'active', 100);
    ml.registry.promote('regTest:v2', 'active', 100);
    const active = ml.registry.list().filter(m => m.name === 'regTest' && m.status === 'active');
    assert.strictEqual(active.length, 1, '只能有一个全量模型');
    assert.strictEqual(active[0].version, 'v2');
  });

  // ───────── 5. 身份图谱 ─────────
  section('Tier1 身份图谱：哈希标识 / 概率连边 / 跨 App');
  t('哈希标识：稳定、按类型隔离、原值不可反解', () => {
    const h1 = identity.hashId('idfa', 'AAAA-BBBB');
    const h2 = identity.hashId('idfa', 'AAAA-BBBB');
    const h3 = identity.hashId('gaid', 'AAAA-BBBB');
    assert.strictEqual(h1, h2, '同输入同输出');
    assert.notStrictEqual(h1, h3, '不同类型不同哈希');
    assert.ok(!h1.includes('AAAA'), '不得包含原始 ID');
  });
  t('邮箱/手机号归一：大小写与格式不影响哈希', () => {
    assert.strictEqual(identity.hashId('email_sha', 'User@Example.COM'), identity.hashId('email_sha', 'user@example.com'));
    assert.strictEqual(identity.hashId('phone_sha', '+86 138-0013-8000'), identity.hashId('phone_sha', '13800138000'));
  });
  t('同一请求内多 ID 必连同一设备簇', () => {
    const r = identity.resolve(
      { idfa: 'IDFA-XYZ', gaid: 'GAID-ABC', login_id: 'user-7' },
      { install_id: 'inst-1', ip: '1.2.3.4', ua: 'iPhone', lang: 'zh', tz: '8' },
      { consented: true, bundle: 'com.demo.game' });
    assert.ok(r.canonicalId, '应解析出 canonical');
    assert.strictEqual(identity.find(identity.hashId('idfa', 'IDFA-XYZ')), identity.find(identity.hashId('gaid', 'GAID-ABC')));
  });
  t('无同意时不使用确定性 ID（ATT/GDPR 红线）', () => {
    const r = identity.resolve({ idfa: 'IDFA-NOCONSENT' }, { device_fp: 'fp-noconsent' }, { consented: false });
    assert.strictEqual(r.strong, 0, '确定性 ID 权重≥0.6 的不应出现');
    assert.ok(r.canonicalId.includes('device_fp') || r.canonicalId.includes('ip_ua'), '只剩弱信号');
  });
  t('概率连边：信号不足不合并，信号充分才连', () => {
    const weak = identity.linkScore({ ip_subnet: '1.2.3' });
    const strong = identity.linkScore({ install_id: 'x', device_fp: 'y', ua: 'z' });
    assert.ok(weak.score < identity.LINK_THRESHOLD, '单一 IP 子网不足以判定同设备');
    assert.ok(strong.score >= identity.LINK_THRESHOLD, '强信号组合应过阈值');
  });
  await ta('跨 App 识别：同一设备出现在多个 bundle 可被查到', async () => {
    const r = identity.resolve({ gaid: 'GAID-APPTEST' }, { device_fp: 'fp-apptest' }, { consented: true, bundle: 'com.a.game' });
    identity.resolve({ gaid: 'GAID-APPTEST' }, { device_fp: 'fp-apptest' }, { consented: true, bundle: 'com.b.news' });
    const apps = await identity.apps(r.canonicalId);
    assert.ok(apps.includes('com.a.game') && apps.includes('com.b.news'), '跨 App 应被识别: ' + apps.join(','));
  });

  // ───────── 6. 归因与增量 ─────────
  section('Tier1 归因：多触点 / 浏览归因 / SKAN / 增量');
  const journey = [
    { imp_id: 'i1', publisher: 'pubA', created_at: '2026-01-01T10:00:00Z', type: 'impression' },
    { imp_id: 'i2', publisher: 'pubB', created_at: '2026-01-03T10:00:00Z', type: 'impression' },
    { imp_id: 'i3', publisher: 'pubC', created_at: '2026-01-05T10:00:00Z', type: 'click' },
  ];
  t('last-touch 把全部功劳给最后一个触点', () => {
    const r = attribution.multiTouch.attribute(journey, 'last_touch', { vta: { enabled: false } });
    assert.strictEqual(r.touchpoints[2].credit, 1);
    assert.strictEqual(r.touchpoints[0].credit, 0);
  });
  t('linear 均分 / position_based 40-20-40（关闭浏览归因看纯模型）', () => {
    const noVta = { vta: { enabled: false } };
    const lin = attribution.multiTouch.attribute(journey, 'linear', noVta);
    assert.ok(Math.abs(lin.touchpoints[0].credit - 1 / 3) < 1e-6);
    const pos = attribution.multiTouch.attribute(journey, 'position_based', noVta);
    assert.ok(Math.abs(pos.touchpoints[0].credit - 0.4) < 1e-6);
    assert.ok(Math.abs(pos.touchpoints[1].credit - 0.2) < 1e-6);
  });
  t('time_decay：越接近转化的触点权重越高', () => {
    const r = attribution.multiTouch.attribute(journey, 'time_decay', { convTs: new Date('2026-01-06T10:00:00Z').getTime() });
    assert.ok(r.touchpoints[2].credit > r.touchpoints[1].credit);
    assert.ok(r.touchpoints[1].credit > r.touchpoints[0].credit);
  });
  t('所有模型功劳之和恒为 1（不会凭空造功劳）', () => {
    for (const m of Object.keys(attribution.multiTouch.MODELS)) {
      if (m === 'data_driven') continue;
      const r = attribution.multiTouch.attribute(journey, m);
      const sum = r.touchpoints.reduce((s, x) => s + x.credit, 0);
      assert.ok(Math.abs(sum - 1) < 1e-6, m + ' 总和=' + sum);
    }
  });
  t('浏览归因：有点击路径时曝光只拿折权（防虚高）', () => {
    const r = attribution.multiTouch.attribute(journey, 'linear', { vta: { enabled: true, factor: 0.3 } });
    const imp = r.touchpoints.filter(x => x.type === 'impression');
    const clk = r.touchpoints.filter(x => x.type === 'click');
    assert.ok(clk[0].credit > imp[0].credit, '点击功劳应高于纯曝光');
  });
  t('Shapley（data_driven）能区分"真正起作用"的触点', () => {
    const outcomeFn = (set) => set.some(x => x.publisher === 'pubC'); // 只有 pubC 能带来转化
    const r = attribution.multiTouch.attribute(journey, 'data_driven', { outcomeFn });
    const c = r.touchpoints.find(x => x.publisher === 'pubC').credit;
    const a = r.touchpoints.find(x => x.publisher === 'pubA').credit;
    assert.ok(c > a, `pubC(${c}) 应显著高于 pubA(${a})`);
  });
  t('SKAN：编码/解码可逆，coarse 值可估价值', () => {
    const schema = { encoding: 'priority', coarseThresholds: { low: 0, medium: 1e6, high: 10e6 },
      events: [{ name: 'purchase', value: 32, priority: 100, coarse: 'high', valueMicros: 60e6 }, { name: 'register', value: 8, priority: 10 }] };
    const enc = attribution.skan.encode(schema, ['purchase']);
    assert.strictEqual(enc.conversionValue, 32);
    const dec = attribution.skan.decode(schema, { conversion_value: 32, fidelity: 0 });
    assert.deepStrictEqual(dec.events, ['purchase']);
    assert.strictEqual(dec.estimatedValueMicros, 60e6);
    const noisy = attribution.skan.decode(schema, { conversion_value: -1, coarse_value: 'high', fidelity: 1 });
    assert.strictEqual(noisy.noisy, true, 'fidelity=1 应标记带噪');
    assert.ok(noisy.estimatedValueMicros > 0, '粗粒度也要能估出价值量级');
  });
  t('SKAN 验签：无公钥时明确拒绝而非放行', () => {
    const v = attribution.skan.verifyPostback('{}', 'abc');
    assert.strictEqual(v.verified, false);
    assert.strictEqual(v.reason, 'NO_PUBKEY');
  });
  t('增量实验：分桶稳定且比例近似设定值', () => {
    const buckets = { control: 0, treat: 0 };
    for (let i = 0; i < 5000; i++) buckets[attribution.incrementality.bucket(1, 'u' + i, 20)]++;
    assert.ok(Math.abs(buckets.control / 5000 - 0.2) < 0.02, '控制组应≈20%: ' + buckets.control / 5000);
    assert.strictEqual(attribution.incrementality.bucket(1, 'u42', 20), attribution.incrementality.bucket(1, 'u42', 20), '同一 unit 永远同组');
  });
  t('统计检验：显著差异能检出，无差异不误报', () => {
    const sig = attribution.incrementality.twoProportionZ(300, 5000, 200, 5000);
    assert.ok(sig.pValue < 0.05, '应显著');
    const nul = attribution.incrementality.twoProportionZ(250, 5000, 248, 5000);
    assert.ok(nul.pValue > 0.05, '不应显著');
    const need = attribution.incrementality.requiredSampleSize(0.02, 0.002);
    assert.ok(need > 10000, '2% 基线检测 0.2pp 提升需要大量样本: ' + need);
  });

  // ───────── 7. 创意自动化 ─────────
  section('Tier1 创意自动化：可玩广告 / DCO / 视频 / 本地化');
  t('可玩广告：产出单文件 HTML，含试玩 + 结束卡 + CTA', () => {
    const html = creative.playable.render({ mode: 'tap_target', title: '试试手气', ctaText: '立即下载', landingUrl: 'https://example.com' });
    assert.ok(html.includes('<canvas'), '有试玩画布');
    assert.ok(html.includes('adx-end'), '有结束卡');
    assert.ok(html.includes('立即下载'), '有 CTA');
    assert.ok(html.includes('playable_start'), '有试玩埋点');
    assert.ok(html.includes('parent.postMessage'), '与容器通信(MRAID 桥)');
    assert.ok(creative.playable.estimateBytes({}) > 1000, '体积可预估');
  });
  t('DCO：多 slot 笛卡尔组合 + 规则过滤', () => {
    const tpl = { slots: { headline: { variants: ['A', 'B'] }, cta: { variants: ['下载', '试玩', '了解'] }, background: { variants: ['#fff'] } } };
    const combos = creative.dco.combinations(tpl, {});
    assert.strictEqual(combos.length, 6, '2×3×1');
    const filtered = creative.dco.filterByRules(combos, { geo: 'US' }, [{ geo: ['US'], allow: { cta: ['下载'] } }]);
    assert.ok(filtered.every(c => c.cta === '下载'), '规则应限制 CTA');
    const html = creative.dco.render(tpl, { headline: 'A', cta: '下载', background: '#fff' }, { title: '商品', target_url: 'https://x.com' });
    assert.ok(html.includes('下载') && html.includes('https://x.com'));
  });
  t('静图转视频：分镜 + FFmpeg 命令 + 无依赖 HTML 兜底', () => {
    const sb = creative.videogen.storyboard(['a.jpg', 'b.jpg', 'c.jpg'], { sceneMs: 2000, endText: '立即下载' });
    assert.strictEqual(sb.scenes.length, 3);
    assert.strictEqual(sb.totalMs, 6000);
    const cmd = creative.videogen.ffmpegCommand(sb, 'o.mp4');
    assert.ok(cmd.startsWith('ffmpeg'), '生成可用命令');
    assert.ok(cmd.includes('zoompan'), '含运镜滤镜');
    const html = creative.videogen.htmlFallback(sb, { cta: { text: '下载', url: 'https://x.com' } });
    assert.ok(html.includes('@keyframes'), 'CSS 动画兜底');
    assert.ok(html.includes('下载'));
  });
  t('本地化：回退链 + 复数规则 + RTL', () => {
    const copy = { title: { 'en-US': 'Download', 'ja-JP': 'ダウンロード' } };
    assert.strictEqual(creative.i18n.localize(copy, 'ja-JP').title, 'ダウンロード');
    assert.strictEqual(creative.i18n.localize(copy, 'de-DE').title, 'Download', '缺失回退到默认');
    assert.strictEqual(creative.i18n.pluralCategory('en-US', 1), 'one');
    assert.strictEqual(creative.i18n.pluralCategory('zh-CN', 5), 'other');
    assert.strictEqual(creative.i18n.pluralCategory('ru-RU', 3), 'few', '俄语有 few 类');
    assert.strictEqual(creative.i18n.pluralCategory('ar-SA', 0), 'zero', '阿拉伯语有 zero 类');
    assert.strictEqual(creative.i18n.isRtl('ar-SA'), true);
    assert.strictEqual(creative.i18n.localize({}, 'ar-SA')._rtl, true);
    assert.ok(creative.i18n.formatMoney('en-US', 12345678).includes('12'), '货币格式化');
  });

  // ───────── 8. 品牌安全 ─────────
  section('Tier1 品牌安全：IAB 分类 / GARM / pre-bid');
  t('内容分类：普通内容归到 IAB 类目', () => {
    assert.strictEqual(brandSafety.classify({ keywords: ['nba', 'sports'] }).iab[0], 'IAB17');
    assert.strictEqual(brandSafety.classify({ keywords: ['游戏'] }).iab[0], 'IAB21');
  });
  t('GARM Floor：零容忍内容必须判 Tier 0', () => {
    assert.strictEqual(brandSafety.classify({ keywords: ['porn'] }).garmTier, 0);
    assert.strictEqual(brandSafety.classify({ keywords: ['战争'] }).garmTier, 0);
  });
  t('未知内容保守处理（不给"安全"结论）', () => {
    const c = brandSafety.classify({ keywords: ['不存在的品类xyz'] });
    assert.strictEqual(c.unknown, true);
    assert.ok(c.garmTier >= 3, '未知内容默认高风险');
  });
  t('pre-bid：GARM 分级 + bcat + badv + 白名单 均可拦截', () => {
    const ctx = { publisher: 'example.com', domain: 'example.com', keywords: ['politics'] };
    const p1 = { garmMaxTier: 2, floorStrict: true, bcat: [], badv: [], bapp: [], blocklist: [], allowlist: [] };
    assert.strictEqual(brandSafety.preBid({}, p1, ctx).block, true, '政治内容超出 Tier2 上限');
    const p2 = { ...p1, garmMaxTier: 4 };
    assert.strictEqual(brandSafety.preBid({}, p2, ctx).block, false);
    const p3 = { ...p2, bcat: ['IAB11'] };
    assert.strictEqual(brandSafety.preBid({}, p3, ctx).block, true, 'bcat 屏蔽生效');
    const p4 = { ...p2, badv: ['example.com'] };
    assert.strictEqual(brandSafety.preBid({}, p4, ctx).block, true, 'badv 屏蔽生效');
    const p5 = { ...p2, allowlist: ['other.com'] };
    assert.strictEqual(brandSafety.preBid({}, p5, ctx).block, true, '不在白名单内');
  });
  t('VAST 注入第三方验证（OMID AdVerifications）', () => {
    const vast = '<VAST><InLine></InLine></VAST>';
    const out = brandSafety.injectVerifications(vast, [{ vendor: 'ias', url: 'https://ias.example/v.js' }]);
    assert.ok(out.includes('<AdVerifications>'));
    assert.ok(out.includes('ias.example'));
    assert.strictEqual(brandSafety.injectVerifications(out, [{ vendor: 'ias', url: 'x' }]), out, '不重复注入');
  });

  // ───────── 9. 计费（无 DB 时的边界）─────────
  section('Tier0 计费闭环（结构自检）');
  t('计费模块导出完整的账务 API', () => {
    ['ensureAccount', 'topUp', 'chargeAdvertiser', 'accruePublisher', 'issueInvoice',
      'buildInvoice', 'getInvoice', 'pay', 'aging', 'closePeriod'].forEach(k => {
        assert.strictEqual(typeof require('./billing')[k], 'function', k);
      });
  });

  console.log(results.join('\n'));
  console.log(`\n通过 ${pass} / 失败 ${fail}`);
  process.exit(fail ? 1 : 0);
})();
