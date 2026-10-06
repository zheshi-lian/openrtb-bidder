#!/usr/bin/env node
// Layer 1: 系统内置模拟广告主 —— 软考高项精品课堂（教育 / 虚拟商品）
// 用法: node scripts/seed-ruankao.js
'use strict';

const mysql = require('mysql2/promise');
const crypto = require('crypto');

const DB = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASS || '',
  database: process.env.DB_NAME || 'openrtb_bidder',
};

const ADV = {
  username: 'ruankao-gaoxiang@app.com',
  password: 'Ruankao2025!',
  scope: '软考高项精品课堂',
  display: '软考高项精品课堂',
  company: '高项冲刺教育科技',
  tax_id: '91310000MA1K288X3R',
  app_category: 'education',
  target_cpm: 8,
  landing_url: '/landing/ruankao/index.html',
  goal: 'install',
};

const AD_UNITS = [
  ['软考高项-横幅Banner', 'banner', 320, 50, 8],
  ['软考高项-激励视频Rewarded', 'rewarded', 320, 480, 12],
  ['软考高项-原生Native', 'native', 320, 180, 10],
];

const CAMPAIGNS = [
  { name: '软考高项-冲刺精华引流', desc: '推广电子版冲刺资料包，小红书笔记引流至落地页留资', cpm: 8, budget: 5000, days: 30, goal: 'install' },
  { name: '软考高项-真题精讲引流', desc: '真题视频精讲课程引流', cpm: 10, budget: 3000, days: 14, goal: 'install' },
  { name: '软考高项-考试日历引流', desc: '考试日历 + 备考规划引流', cpm: 6, budget: 2000, days: 60, goal: 'brand' },
];

const CREATIVES = [
  { ci: 0, format: 'banner', title: '软考高项冲刺精华·68个高频考点',
    html: '<div style="padding:10px 16px;background:linear-gradient(90deg,#3b82f6,#6366f1);color:#fff;border-radius:8px;font-size:14px;text-align:center"><b>📚 软考高项冲刺精华</b><br><span style="font-size:12px">68个高频考点·12套真题·免费电子版</span></div>', w: 320, h: 50 },
  { ci: 1, format: 'rewarded', title: '软考真题精讲·看视频领资料',
    html: '<div style="padding:16px;background:#7c3aed;color:#fff;border-radius:12px;text-align:center;font-size:15px"><div style="font-size:28px;margin-bottom:6px">🎬</div><b>软考真题精讲</b><br><span style="font-size:12px;opacity:.9">看完视频免费领冲刺资料包</span></div>', w: 320, h: 480 },
  { ci: 2, format: 'native', title: '软考高项考试日历·备考规划',
    html: '<div style="padding:12px;background:#0ea5e9;color:#fff;border-radius:10px;font-size:13px"><b>📅 2025软考高项考试日历</b><br><span style="font-size:11px">剩余XX天·点击下载备考规划+冲刺精华</span></div>', w: 320, h: 180 },
];

const TEST_LEADS = [
  { contact: '小李 | wechat | Ruankao_xiaoli', channel: 'xhs', source: 'xiaohongshu' },
  { contact: '张三 | phone | 13800138001', channel: 'xhs', source: 'xiaohongshu' },
  { contact: '王五 | email | wangwu@example.com', channel: 'xhs', source: 'xiaohongshu' },
  { contact: '赵六 | wechat | Ruankao_zhaoliu', channel: 'direct', source: 'xhs_post' },
];

async function main() {
  const conn = await mysql.createConnection(DB);
  console.log('🔌 数据库连接成功\n');

  // Step 1: 广告主账号
  console.log('━━━ Step 1: 创建广告主账号 ━━━');
  const passHash = crypto.pbkdf2Sync(ADV.password, 'salt', 1000, 32, 'sha256').toString('hex');
  await conn.query(
    'INSERT INTO accounts (type,username,pass_hash,scope,display,created_by,api_key,account_code) VALUES (?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE display=VALUES(display)',
    ['advertiser', ADV.username, passHash, ADV.scope, ADV.display, 'seed', 'sk_live_' + Date.now().toString(36) + Math.random().toString(36).slice(2,8), 'ADV' + Math.random().toString(36).slice(2,8).toUpperCase()]
  );
  await conn.query('INSERT IGNORE INTO adv_balance (advertiser,balance_micros) VALUES (?,?)', [ADV.scope, 10000000000]).catch(() => {});
  await conn.query('CREATE TABLE IF NOT EXISTS advertiser_profile (advertiser VARCHAR(128) PRIMARY KEY, company VARCHAR(128) DEFAULT \'\', tax_id VARCHAR(64) DEFAULT \'\', app_category VARCHAR(32) DEFAULT \'\', target_cpm_cny DECIMAL(10,2) DEFAULT 6, landing_url VARCHAR(256) DEFAULT \'\', goal VARCHAR(32) DEFAULT \'\', updated_at BIGINT DEFAULT 0)').catch(() => {});
  await conn.query(
    'INSERT INTO advertiser_profile (advertiser,company,tax_id,app_category,target_cpm_cny,landing_url,goal,updated_at) VALUES (?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE company=VALUES(company),tax_id=VALUES(tax_id),app_category=VALUES(app_category),target_cpm_cny=VALUES(target_cpm_cny),landing_url=VALUES(landing_url),goal=VALUES(goal),updated_at=VALUES(updated_at)',
    [ADV.scope, ADV.company, ADV.tax_id, ADV.app_category, ADV.target_cpm, ADV.landing_url, ADV.goal, Date.now()]
  );
  console.log('  ✅ 广告主: ' + ADV.scope + ' | 品类: ' + ADV.app_category);

  // Step 2: 广告位
  console.log('\n━━━ Step 2: 创建广告位 ━━━');
  for (const au of AD_UNITS) {
    await conn.query('INSERT INTO ad_units (advertiser,name,format,width,height,bidfloor_cny) VALUES (?,?,?,?,?,?)',
      [ADV.scope, au[0], au[1], au[3], au[4], au[2]]).catch(() => {});
    console.log('  ✅ ' + au[0]);
  }

  // Step 3: 计划
  console.log('\n━━━ Step 3: 创建广告计划 ━━━');
  const campaignIds = [];
  for (const c of CAMPAIGNS) {
    const start = new Date();
    const end = new Date(Date.now() + c.days * 86400000);
    const [r] = await conn.query(
      'INSERT INTO campaigns (advertiser,name,description,landing_url,category,goal,status,cpm_target_cny,daily_budget_cny,total_budget_cny,start_date,end_date) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      [ADV.scope, c.name, c.desc, ADV.landing_url, '', c.goal, 'active', c.cpm, c.budget, c.budget, start.toISOString().slice(0,10), end.toISOString().slice(0,10)]
    );
    campaignIds.push(r.insertId);
    console.log('  ✅ 计划 #' + r.insertId + ': ' + c.name);
  }

  // Step 4: 素材
  console.log('\n━━━ Step 4: 创建创意素材 ━━━');
  for (const cr of CREATIVES) {
    await conn.query(
      "INSERT INTO creatives (advertiser,campaign_id,format,type,title,content,landing_url,width,height,creative_status) VALUES (?,?,'html',?,?,?,?,?,?,?)",
      [ADV.scope, campaignIds[cr.ci], cr.format, cr.title, cr.html, ADV.landing_url, cr.w, cr.h, 'approved']
    );
    console.log('  ✅ 素材: ' + cr.title);
  }
  // Step 5: 测试数据
  console.log('\n━━━ Step 5: 模拟测试数据 ━━━');
  const now = Date.now();
  for (let i = 0; i < 10; i++) {
    const impId = 'imp_rk_' + (now + i);
    const cid = campaignIds[i % campaignIds.length];
    await conn.query('INSERT IGNORE INTO bid_win_log (imp_id,auction_id,campaign_id,creative_id,advertiser,publisher,bid_price_micros,price_micros,ts) VALUES (?,?,?,?,?,?,?,?,?)',
      [impId, 'auc_rk_' + i, cid, 0, ADV.scope, 'xiaohongshu-adx', 100000 + i * 5000, 100000 + i * 5000, now - (10 - i) * 60000]);
  }
  console.log('  ✅ 竞价胜出: 10 条');

  for (let i = 0; i < 5; i++) {
    const impId = 'imp_rk_' + (now + i);
    const cid = campaignIds[i % campaignIds.length];
    await conn.query('INSERT INTO landing_view (imp_id,campaign_id,publisher,channel,ip) VALUES (?,?,?,?,?)',
      [impId, cid, 'xiaohongshu-adx', 'xhs', '127.0.0.1']);
  }
  console.log('  ✅ 落地页到达: 5 条');

  await conn.query('CREATE TABLE IF NOT EXISTS ruankao_lead (id BIGINT AUTO_INCREMENT PRIMARY KEY, contact VARCHAR(255) NOT NULL, channel VARCHAR(32) DEFAULT \'\', source VARCHAR(128) DEFAULT \'\', ip VARCHAR(64) DEFAULT \'\', delivered TINYINT DEFAULT 0, campaign_id INT DEFAULT 0, creative_id INT DEFAULT 0, publisher VARCHAR(128) DEFAULT \'\', converted TINYINT DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, INDEX(contact),INDEX(campaign_id),INDEX(created_at))').catch(() => {});

  for (let i = 0; i < TEST_LEADS.length; i++) {
    const l = TEST_LEADS[i];
    const impId = 'imp_rk_' + (now + i);
    const cid = campaignIds[i % campaignIds.length];
    await conn.query('INSERT INTO ruankao_lead (contact,channel,source,ip,imp_id,campaign_id,creative_id,publisher,converted) VALUES (?,?,?,?,?,?,?,?,1)',
      [l.contact, l.channel, l.source, '127.0.0.1', impId, cid, 0, 'xiaohongshu-adx']);
    await conn.query("INSERT INTO conv_log (type,campaign_id,publisher,imp_id,amount) VALUES ('conversion',?,?,?,?)",
      [cid, 'xiaohongshu-adx', impId, 5000000]).catch(() => {});
  }
  console.log('  ✅ 留资: ' + TEST_LEADS.length + ' 条 | 转化: ' + TEST_LEADS.length + ' 条');

  // 汇总
  console.log('\n═══ 数据闭环总结 ═══');
  console.log('  广告主: ' + ADV.scope);
  console.log('  广告位: ' + AD_UNITS.length + ' | 计划: ' + CAMPAIGNS.length + ' | 素材: ' + CREATIVES.length + '(approved)');
  console.log('  竞价胜出: 10 | 落地页: 5 | 留资: ' + TEST_LEADS.length + ' | 转化: ' + TEST_LEADS.length);
  console.log('\n  数据闭环: XHS笔记 → 落地页 → 留资 → 转化 → 模型训练 ✅');
  console.log('  投放账号: ' + ADV.username + ' / ' + ADV.password);
  console.log('  落地页:   ' + ADV.landing_url);
  console.log('══════════════════════════\n');

  await conn.end();
  console.log('🔌 数据库连接已关闭');
}

main().catch((e) => {
  console.error('❌ 脚本执行失败:', e.message);
  console.error(e.stack);
  process.exit(1);
});

