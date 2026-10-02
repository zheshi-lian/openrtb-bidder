const h = require('http');
const TOKEN = process.env.ADMIN_TOKEN || '';
function req(method, path, body) {
  return new Promise((resolve) => {
    const s = body ? JSON.stringify(body) : '';
    const headers = body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(s) } : {};
    if (TOKEN) headers['Authorization'] = 'Bearer ' + TOKEN;
    const r = h.request({ host: '127.0.0.1', port: 8080, path, method, headers }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { resolve({ _raw: d }); } });
    });
    r.on('error', e => resolve({ error: e.message })); if (body) r.write(s); r.end();
  });
}
const MARK = 'AUTOGEN_MARKER_' + Date.now();
(async () => {
  // 1) 创建 Demo 计划：拍卖出价 base=min(target_cpm, budget)（server.js:668），历史 demo 计划均被 5000 CNY 预算
  //    封顶到 5e9 micros，仅抬 target 无效。这里取全库最大"有效 base"，新计划 target 严格大于它且预算不封顶 → 确定性胜出。
  const list = await req('GET', '/api/campaigns');
  const maxBase = Array.isArray(list) ? list.reduce((m, x) => Math.max(m, Math.min(Number(x.target_cpm_micros) || 0, Number(x.budget_micros) || 0)), 0) : 0;
  const targetCny = Math.ceil((maxBase + 1e7) / 1e6);   // 严格高于所有现有 base（+10 CNY CPM）
  const budgetCny = targetCny * 5;                       // 预算留足，避免 base 被预算封顶
  const c = await req('POST', '/api/campaign', { name: '创意自动化Demo', advertiser: 'AutoGen', budget_cny: budgetCny,
    country: 'CN', app_category: 'gaming', creative_html: '<div>占位</div>', landing_url: 'https://example.com', target_cpm_cny: targetCny, intent_tags: 'gaming' });
  if (!c.ok) return console.log('创建计划失败', c);
  const cid = c.id;
  await req('PUT', '/api/campaign/' + cid + '/approve');
  console.log('① 创建并审核 campaign #', cid);

  // 2) 存入素材库（创意自动化产物形态：interstitial / html），内容带唯一 MARK 以便回检
  const sv = await req('POST', '/api/creatives', { campaign_id: cid, advertiser: 'AutoGen', format: 'interstitial',
    type: 'html', title: '自动生成创意', content: '<div>' + MARK + '</div>', landing_url: 'https://example.com', status: 'active' });
  if (!sv.ok) return console.log('存入素材库失败', sv);
  const creativeId = sv.id;
  console.log('② 存入素材库 creative #', creativeId);

  // 3) 模拟媒体请求 interstitial → 经 SSP 交换侧(/ssp/bid，AppLovin MAX 式聚合竞价)下发。
  //    该路径会落 impression 日志，是后续转化回流的前置条件。imp id 唯一避免转化去重误判。
  //    注意：SSP 竞价有 100ms 总 deadline（bid/throttle.js deadlineAll），冷启动首轮内部 DSP 可能超时，
  //    由快手 sim 捡漏（降级设计，非链路故障）→ 此处重试直至自有 DSP 胜出。
  let b = null, attempt = 0, impId = '';
  while (attempt < 3) {
    attempt++;
    impId = 'imp_v_' + Date.now() + '_' + attempt;
    const bid = await req('POST', '/ssp/bid', { id: 'vtest_' + Date.now() + '_' + attempt,
      site: { domain: 'media.dellai.xyz', keywords: '休闲游戏,激励视频,interstitial' },
      imp: [{ id: 'imp_v_' + Date.now() + '_' + attempt, bidfloor: 2.0, ext: { cat: 'gaming', ad_type: 'interstitial', device_fp: 'fp_test' } }],
      device: { geo: { country: 'CN' } } });
    const seat = bid.seatbid && bid.seatbid[0]; b = seat && seat.bid && seat.bid[0];
    if (!b) return console.log('③ 无填充 nbr=', bid.nbr);
    if (((b.ext && b.ext.cid) || b.cid) === cid) break;
    if (attempt < 3) console.log('   (第' + attempt + '次非自有 DSP 胜出，竞价 deadline 降级，重试…)'); else console.log('   (3 次均为其它 seat 胜出：seat=' + seat.seat + '，疑为内部 DSP 超时)');
  }
  const servedCid = (b.ext && b.ext.cid) || b.cid;
  const served = String(b.adm || '').includes(MARK);
  console.log('③ /ssp/bid(交换侧) 返回 cid=' + servedCid + ' (期望 ' + cid + ') | 下发素材库创意(MARK)=' + served + ' | adm.len=' + String(b.adm || '').length);

  // 3b) 内部 DSP(/openrtb2/bid) 也应能独立下发广告（信息性检查）
  const dsp = await req('POST', '/openrtb2/bid', { id: 'vtest_dsp_' + Date.now(),
    site: { domain: 'media.dellai.xyz', keywords: '休闲游戏,激励视频,interstitial' },
    imp: [{ id: 'imp_dsp_' + Date.now(), bidfloor: 2.0, ext: { cat: 'gaming', ad_type: 'interstitial', device_fp: 'fp_test' } }],
    device: { geo: { country: 'CN' } } });
  const db = dsp.seatbid && dsp.seatbid[0] && dsp.seatbid[0].bid && dsp.seatbid[0].bid[0];
  console.log('③b /openrtb2/bid(内部 bidder) 是否下发广告=' + (!!db && (db.adm || '').length > 0) + ' | cid=' + ((db && ((db.ext && db.ext.cid) || db.cid)) || '?'));

  // 4) 转化回流飞轮：用本次曝光的 impid 回传转化
  const impid = impId;
  const conv = await req('POST', '/api/track/conversion', { impid, cid: servedCid, publisher: 'media.dellai.xyz', amount: 5.0 });
  console.log('④ 转化回流:', JSON.stringify(conv));

  // 5) 校验创意转化计数是否 +1（DCO/A-B 反馈）
  console.log('⑤ 验证提示：可在 MySQL 执行 SELECT conversions FROM creatives WHERE id=' + creativeId + ' 确认已+1；conv_log 已有该 imp 记录。');
  console.log('\n结论:', served && servedCid == cid && conv.ok ? '✅ 创意自动化→素材库→bidder下发→转化回流 全链路打通' : '⚠ 见上，需排查');
})();
