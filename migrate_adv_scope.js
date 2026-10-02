'use strict';
// migrate_adv_scope.js —— 把「作用域=邮箱」的存量广告主账号统一为「作用域=广告主名称」
// 背景：旧 /api/public/advertiser-open 建号时 scope=邮箱、adv_campaign.advertiser 也=邮箱，
//   与 /api/signup/advertiser（scope=广告主名称）两套口径并存 → 同一主体两个 scope、数据互相看不见。
// 迁移：accounts.scope 改为 display（即当时填的广告主名称/主体，无则回落 username），
//   并把 adv_campaign 中 advertiser=旧邮箱 的行同步改成新 scope，保证计划归属不断裂。
// 幂等：只动 scope 含 '@' 的 advertiser 账号，重复执行无副作用。
// 用法：在 openrtb-bidder 目录下 node migrate_adv_scope.js
const mysql = require('mysql2/promise');
const DB = { host: '127.0.0.1', port: 3306, user: 'test', password: 'test@fftime', database: 'zhuque' };

(async () => {
  const p = mysql.createPool(DB);
  const [rows] = await p.query("SELECT id, username, scope, display FROM accounts WHERE type='advertiser' AND scope LIKE '%@%'");
  if (!rows.length) {
    console.log('[migrate] 没有「作用域=邮箱」的存量广告主账号 → 无需迁移 ✓');
    await p.end(); return;
  }
  console.log('[migrate] 发现 ' + rows.length + ' 个「作用域=邮箱」的存量广告主账号，开始统一口径：');
  for (const r of rows) {
    const newScope = (r.display && String(r.display).trim()) ? String(r.display).trim() : r.username;
    console.log('  #' + r.id + '  username=' + r.username + '   scope: ' + r.scope + '  ->  ' + newScope);
    await p.query('UPDATE accounts SET scope=? WHERE id=?', [newScope, r.id]);
    const [c2] = await p.query('UPDATE adv_campaign SET advertiser=? WHERE advertiser=?', [newScope, r.scope]);
    console.log('     账号 scope 已更新；关联计划同步 ' + c2.affectedRows + ' 条（advertiser 改为 ' + newScope + '）');
  }
  await p.end();
  console.log('[migrate] 完成：广告主作用域口径已统一为「广告主名称」');
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
