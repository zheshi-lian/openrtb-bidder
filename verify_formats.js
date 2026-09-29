'use strict';
// verify_formats.js —— 验证 ADX 支持的多广告形态返回
// 用法: node verify_formats.js
const BASE = process.env.BASE || 'http://127.0.0.1:8080';
const FORMATS = ['rewarded', 'interstitial', 'splash', 'native', 'icon', 'push', 'banner'];

(async () => {
  for (const f of FORMATS) {
    const id = `fmt_${f}_${Date.now()}`;
    const body = {
      id,
      site: { domain: 'dellai.xyz', keywords: '休闲游戏,激励视频,rewarded' },
      imp: [{ id, bidfloor: 2.0, ext: { cat: 'gaming', ad_type: f } }],
      device: { geo: { country: 'CN' } }
    };
    const r = await fetch(BASE + '/ssp/bid', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    }).then(x => x.json());
    const s = r.seatbid && r.seatbid[0];
    const b = s && s.bid && s.bid[0];
    if (!b) { console.log(String(f).padEnd(13), 'NO_FILL'); continue; }
    const ext = b.ext || {};
    const adm = String(b.adm || '');
    const preview = adm.replace(/\s+/g, ' ').slice(0, 58);
    console.log(
      String(f).padEnd(13),
      'admType=' + String(ext.adm_type || '-').padEnd(12),
      'format=' + String(ext.ad_format || '-').padEnd(12),
      'len=' + String(adm.length).padEnd(6),
      preview
    );
    if (f === 'native' && ext.adm_type === 'native_json') {
      try { const n = JSON.parse(adm); console.log('   native fields:', Object.keys(n).join(',')); } catch (e) {}
    }
    if (f === 'push' && ext.push) console.log('   push fields:', Object.keys(ext.push).join(','));
  }
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
