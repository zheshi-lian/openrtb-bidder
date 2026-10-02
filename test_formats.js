const h = require('http');
function post(b) {
  return new Promise(r => {
    const s = JSON.stringify(b);
    const req = h.request({ host: '127.0.0.1', port: 8080, path: '/ssp/bid', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(s) } }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => r(d));
    });
    req.on('error', e => r('ERR ' + e.message)); req.write(s); req.end();
  });
}
(async () => {
  for (const fmt of ['rewarded','interstitial','splash','native','icon','push','banner']) {
    const id = 'demo_' + fmt + '_' + Date.now();
    const b = { id, site: { domain: 'media.dellai.xyz', keywords: '休闲游戏,激励视频,' + fmt },
      imp: [{ id, bidfloor: 2.0, ext: { cat: 'gaming', ad_type: fmt, device_fp: 'fp123' } }],
      device: { geo: { country: 'CN' } } };
    const r = await post(b);
    let js; try { js = JSON.parse(r); } catch (e) { console.log(fmt, '-> PARSE FAIL', r.slice(0,120)); continue; }
    const seat = js.seatbid && js.seatbid[0];
    const bid = seat && seat.bid && seat.bid[0];
    if (!bid) { console.log(fmt, '-> NO_FILL nbr:', js.nbr); continue; }
    const ext = bid.ext || {};
    console.log(fmt, '-> cid=' + ext.cid, 'adm_type=' + ext.adm_type, 'price=' + (bid.price/1e6).toFixed(2),
      'pcvr=' + ext.pcvr, 'adm.len=' + String(bid.adm||'').length);
  }
})();
