'use strict';
// verify_vast.js —— 端到端验证：VAST 4.0 返回 / tracking 回调 / 客户端令牌校验 / S2S 服务端结算
// 用法: node verify_vast.js
const BASE = process.env.BASE || 'http://127.0.0.1:8080';
const crypto = require('crypto');

const post = async (path, payload) => {
  const r = await fetch(BASE + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
  });
  const body = await r.json().catch(() => ({}));
  return { status: r.status, body };
};
const line = (l, r) => console.log(
  String(l).padEnd(24), 'HTTP', r.status,
  r.body.ok ? (r.body.granted ? 'GRANTED' + (r.body.settlement ? '(' + r.body.settlement + ')' : '') : 'PENDING:' + r.body.why)
            : 'REJECT:' + r.body.why);

const requestBid = async (id) => {
  const r = await post('/ssp/bid', {
    id, site: { domain: 'dellai.xyz', keywords: '休闲游戏,激励视频,rewarded' },
    imp: [{ id, bidfloor: 2.0, ext: { cat: 'gaming', ad_type: 'rewarded' } }],
    device: { geo: { country: 'CN' } }
  });
  const s = r.body && r.body.seatbid && r.body.seatbid[0];
  return s && s.bid && s.bid[0];
};

(async () => {
  // 0) 拿到媒体服务端密钥（S2S 签名用）
  const kr = await fetch(BASE + '/api/publisher/dellai.xyz/key?rotate=1').then(r => r.json());
  const apiKey = kr.api_key || '';
  console.log('PUBLISHER_KEY =', apiKey ? apiKey.slice(0, 14) + '...' : '(empty)');
  const sign = (impid, cid, w, d, ts) =>
    crypto.createHmac('sha256', apiKey).update(`${impid}|${cid}|${w}|${d}|${ts}`).digest('hex');

  // ===== A: 客户端上报路径（令牌校验） =====
  console.log('\n--- A 客户端 /ssp/reward ---');
  const aId = 'rwA_' + Date.now();
  const A = await requestBid(aId);
  if (!A) return console.log('NO_FILL');
  const cidA = A.ext && A.ext.cid, rwA = A.ext && A.ext.rw;
  console.log('ADM_TYPE =', A.ext && A.ext.adm_type, '| VAST4 =', /<VAST[^>]*version="4\.0"/.test(A.adm),
              '| CID =', cidA, '| PRICE =', A.price);
  const tk = await fetch(`${BASE}/vast/track?impid=${aId}&cid=${cidA}&event=complete`);
  console.log('VAST_TRACK =', tk.status);
  const baseA = { impid: aId, cid: cidA, publisher: 'dellai.xyz', watchedMs: 52000, durationMs: 52000 };
  await line('无令牌', await post('/ssp/reward', baseA));
  await line('谎报时长(800ms)', await post('/ssp/reward', Object.assign({}, baseA, { rw: rwA, watchedMs: 800 })));
  await line('正常完播', await post('/ssp/reward', Object.assign({}, baseA, { rw: rwA })));
  await line('重放令牌', await post('/ssp/reward', Object.assign({}, baseA, { rw: rwA })));

  // ===== B: S2S 服务端回调路径（服务端签名 → 权威结算） =====
  console.log('\n--- B 服务端 /s2s/reward ---');
  const bId = 'rwB_' + Date.now();
  const B = await requestBid(bId);
  if (!B) return console.log('NO_FILL_B');
  const cidB = B.ext && B.ext.cid;
  const W = 52000, D = 52000, ts = Date.now();
  const baseB = { impid: bId, cid: cidB, publisher: 'dellai.xyz', watchedMs: W, durationMs: D, ts };
  await line('无签名', await post('/s2s/reward', baseB));
  await line('错误签名', await post('/s2s/reward', Object.assign({}, baseB, { sig: 'deadbeef' })));
  await line('服务端合法回调', await post('/s2s/reward', Object.assign({}, baseB, { sig: sign(bId, cidB, W, D, ts) })));
  await line('重复结算', await post('/s2s/reward', Object.assign({}, baseB, { sig: sign(bId, cidB, W, D, ts) })));
  await line('过期时间戳', await post('/s2s/reward', Object.assign({}, baseB, { ts: ts - 10 * 60 * 1000, sig: sign(bId, cidB, W, D, ts - 10 * 60 * 1000) })));
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
