/**
 * 写入演示竞价数据到 zhuque 库（advertiser / campaign / ad_group / creative）
 * 运行：node seed.js
 */
const mysql = require('mysql2/promise');
const DB = {
  host: '127.0.0.1', port: 3306,
  user: 'test', password: 'test@fftime', database: 'zhuque'
};

(async () => {
  const pool = mysql.createPool(DB);
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS bid_win_log (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      campaign_id INT,
      creative_id INT,
      imp_id VARCHAR(64),
      price_micros BIGINT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);
    const [[{ c: advCount }]] = await pool.query(
      "SELECT COUNT(*) c FROM advertiser WHERE name='演示广告主'"
    );
    if (advCount > 0) {
      console.log('演示数据已存在，跳过。');
      return;
    }
    const [r1] = await pool.query(
      "INSERT INTO advertiser(name,status) VALUES('演示广告主',1)"
    );
    const advId = r1.insertId;
    const [r2] = await pool.query(
      'INSERT INTO campaign(advertiser_id,name,budget,status) VALUES(?,?,?,1)',
      [advId, '演示推广活动', 1000000]
    );
    const campId = r2.insertId;
    const [r3] = await pool.query(
      `INSERT INTO ad_group(campaign_id,name,status,bid_price,cost_type,target_os,
        target_terminal,promotion_type,deliver_method,begin_time,end_time,landing_page)
       VALUES(?,?,2,500,2,0,0,1,0,NOW(),DATE_ADD(NOW(),INTERVAL 30 DAY),'https://example.com')`,
      [campId, '演示广告单元']
    );
    const agId = r3.insertId;
    await pool.query(
      `INSERT INTO creative(ad_group_id,name,status,audit_status,creative_url,html_snippet)
       VALUES(?,?,1,1,?,?)`,
      [agId, '演示创意', 'https://example.com/ad.png',
       '<div style="padding:10px;background:#4F8EF7;color:#fff;border-radius:6px">演示广告 · 立即体验</div>']
    );
    console.log(`已写入演示数据 -> advertiser=${advId} campaign=${campId} ad_group=${agId}`);
  } catch (e) {
    console.error('seed error:', e.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
