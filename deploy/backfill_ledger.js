// 历史投放补记账 + 账单身份治理：让对账真正为 0
//
// 背景：<｜hy_place▁holder▁no▁813｜> postgres mysql
//   1) adv_ledger（广告主账务）后于 bid_win_log 建立 → 历史投放缺流水
//   2) bid_win_log 存在重复 imp_id（不同请求复用了同一 slot 名），而旧版去重仅按 imp_id
//      → 后续请求"已投放但不扣费"，造成资金漏洞且对账永远不平
//
// 处置（非破坏性，保留全部审计轨迹）：
//   ① 每个 imp_id 仅保留最小 id 的历史行为 billable=1，其余重复行标记 billable=0
//   ② 以 billable 行为事实源补写 adv_ledger（唯一键 imp_id 保证幂等）
//   ③ 由 billable 行重算 daily_spend（pacing 依赖它）
//
// 用法：node deploy/backfill_ledger.js

require('../llm'); // 加载 .env（含 DB 凭据）
const mysql = require('mysql2/promise');

const CONF = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'test',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'zhuque',
};
function chunk(arr, n) { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; }

(async () => {
  const c = await mysql.createConnection(CONF);

  // ① 标记重复（同一 imp_id 的非最小 id 行）——仅对尚无 req_id 的历史数据生效
  const [res] = await c.query(`
    UPDATE bid_win_log w LEFT JOIN (
      SELECT imp_id, MIN(id) min_id FROM bid_win_log WHERE COALESCE(req_id,'')='' GROUP BY imp_id
    ) m ON m.imp_id = w.imp_id
    SET w.billable = 0
    WHERE COALESCE(w.req_id,'')='' AND w.id > m.min_id`);
  console.log('标记不可计费的重复历史行:', Number(res.affectedRows) || 0);

  // ② 以 billable 行补记账（幂等：adv_ledger.imp_id 唯一键）
  const [wins] = await c.query('SELECT campaign_id, imp_id, COALESCE(req_id,\'\') req_id, price_micros FROM bid_win_log WHERE campaign_id > 0 AND COALESCE(billable,1)=1');
  let inserted = 0;
  for (const part of chunk(wins, 500)) {
    const ph = part.map(() => '(?,?,?,?,0)').join(',');
    const vals = part.flatMap(w => [Number(w.campaign_id) || 0, String(w.imp_id), String(w.req_id), Math.max(0, Number(w.price_micros) || 0)]);
    const [r] = await c.query(`INSERT IGNORE INTO adv_ledger (campaign_id, imp_id, req_id, charge_micros, insufficient) VALUES ${ph}`, vals);
    inserted += Number(r.affectedRows) || 0;
  }

  // ③ 重算 daily_spend
  await c.query('DELETE FROM daily_spend');
  await c.query(`INSERT INTO daily_spend (campaign_id, d, micros)
    SELECT campaign_id, DATE(created_at), SUM(price_micros) FROM bid_win_log
    WHERE campaign_id > 0 AND COALESCE(billable,1)=1 GROUP BY campaign_id, DATE(created_at)`);

  const [[chg]] = await c.query('SELECT COALESCE(SUM(charge_micros),0) charged FROM adv_ledger');
  const [[srv]] = await c.query('SELECT COALESCE(SUM(price_micros),0) served FROM bid_win_log WHERE campaign_id > 0 AND COALESCE(billable,1)=1');
  const [[nb]] = await c.query('SELECT COUNT(*) n FROM bid_win_log WHERE COALESCE(billable,1)=0');
  await c.end();
  const diff = Number(chg.charged) - Number(srv.served);
  console.log(`可计费投放 ${wins.length} 条，补记账 ${inserted} 条；不可计费(历史重复) ${Number(nb.n) || 0} 条`);
  console.log(`应收 charged=${chg.charged}  应投 served=${srv.served}  差额=${diff}`);
  console.log(diff === 0 ? '→ 账务已与投放对齐 ✓' : '→ 仍有差额，需核查');
})().catch(e => { console.error('补记账失败:', e.message); process.exit(1); });
