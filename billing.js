// billing.js —— 计费闭环：账户（预付/后付）→ 账期 → 账单明细 → 发票 → 收款 → 账龄
//
// v1 只有"广告主扣费账本 + 媒体分成比例 + 对账"，缺的是"钱怎么进门、怎么开票、怎么催"：
//   广告主要预付/月结，媒体要月结付款单，财务要发票（含税号/抬头），老板要看账龄。
//   平台没有这套东西，BD 拿不下品牌广告主——对方财务流程走不通就一单都签不了。
//
// 单位统一：micros = 1e-6 元（与竞价侧一致），避免浮点误差。

const TAX_RATE = Number(process.env.INVOICE_TAX_RATE || 0.06); // 现代服务业增值税 6%
const TERMS_DAYS = Number(process.env.PAYMENT_TERMS_DAYS || 30);

let pool = null;
function attachPool(p) { pool = p; }

async function initTables() {
  if (!pool) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS billing_account (
    id BIGINT AUTO_INCREMENT PRIMARY KEY, party_type VARCHAR(16) NOT NULL, party VARCHAR(128) NOT NULL,
    currency VARCHAR(8) DEFAULT 'CNY', terms VARCHAR(16) DEFAULT 'prepay',
    credit_limit_micros BIGINT DEFAULT 0, balance_micros BIGINT DEFAULT 0,
    invoice_title VARCHAR(128) DEFAULT '', tax_id VARCHAR(64) DEFAULT '',
    billing_cycle VARCHAR(16) DEFAULT 'monthly', status TINYINT DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uk_party (party_type, party)
  )`).catch(() => {});
  await pool.query(`CREATE TABLE IF NOT EXISTS invoice (
    invoice_no VARCHAR(32) PRIMARY KEY, party_type VARCHAR(16), party VARCHAR(128),
    period_start DATE, period_end DATE, currency VARCHAR(8) DEFAULT 'CNY',
    subtotal_micros BIGINT DEFAULT 0, tax_micros BIGINT DEFAULT 0, total_micros BIGINT DEFAULT 0,
    status VARCHAR(16) DEFAULT 'draft', invoice_title VARCHAR(128) DEFAULT '', tax_id VARCHAR(64) DEFAULT '',
    issued_at DATETIME NULL, due_at DATETIME NULL, paid_at DATETIME NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uk_period (party_type, party, period_start, period_end)
  )`).catch(() => {});
  await pool.query(`CREATE TABLE IF NOT EXISTS invoice_line (
    id BIGINT AUTO_INCREMENT PRIMARY KEY, invoice_no VARCHAR(32), dimension VARCHAR(64), label VARCHAR(128),
    impressions INT DEFAULT 0, clicks INT DEFAULT 0, conversions INT DEFAULT 0,
    unit VARCHAR(16) DEFAULT 'CPM', amount_micros BIGINT DEFAULT 0
  )`).catch(() => {});
  await pool.query(`CREATE TABLE IF NOT EXISTS payment (
    id BIGINT AUTO_INCREMENT PRIMARY KEY, invoice_no VARCHAR(32), amount_micros BIGINT DEFAULT 0,
    method VARCHAR(32) DEFAULT 'transfer', ref VARCHAR(128) DEFAULT '', paid_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`).catch(() => {});
  await pool.query(`CREATE TABLE IF NOT EXISTS billing_txn (
    id BIGINT AUTO_INCREMENT PRIMARY KEY, party_type VARCHAR(16), party VARCHAR(128),
    kind VARCHAR(24), amount_micros BIGINT DEFAULT 0, ref VARCHAR(128) DEFAULT '',
    balance_after_micros BIGINT DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`).catch(() => {});
}

function micros(n) { return Math.round(Number(n) || 0); }

async function ensureAccount(partyType, party, patch = {}) {
  if (!pool) return null;
  await pool.query(
    `INSERT INTO billing_account (party_type,party,terms,credit_limit_micros,invoice_title,tax_id,billing_cycle)
     VALUES (?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE id=LAST_INSERT_ID(id)`,
    [partyType, party, patch.terms || 'prepay', micros(patch.creditLimitMicros), patch.invoiceTitle || party, patch.taxId || '', patch.billingCycle || 'monthly']);
  if (Object.keys(patch).length) {
    const sets = [], vals = [];
    const map = { terms: 'terms', creditLimitMicros: 'credit_limit_micros', invoiceTitle: 'invoice_title', taxId: 'tax_id', billingCycle: 'billing_cycle' };
    for (const k in map) if (patch[k] !== undefined) { sets.push(`${map[k]}=?`); vals.push(patch[k]); }
    if (sets.length) { vals.push(partyType, party); await pool.query(`UPDATE billing_account SET ${sets.join(',')} WHERE party_type=? AND party=?`, vals); }
  }
  const [[a]] = await pool.query('SELECT * FROM billing_account WHERE party_type=? AND party=?', [partyType, party]);
  return a;
}
async function getAccount(partyType, party) {
  if (!pool) return null;
  const [[a]] = await pool.query('SELECT * FROM billing_account WHERE party_type=? AND party=?', [partyType, party]);
  return a || null;
}
async function listAccounts(partyType) {
  if (!pool) return [];
  const [rows] = await pool.query('SELECT * FROM billing_account WHERE party_type=? ORDER BY id DESC', [partyType]);
  return rows;
}

// 充值（广告主预付）/ 授信调整
async function topUp(partyType, party, amountMicros, ref = '') {
  const a = await ensureAccount(partyType, party);
  const amt = micros(amountMicros);
  const bal = micros(a.balance_micros) + amt;
  await pool.query('UPDATE billing_account SET balance_micros=? WHERE party_type=? AND party=?', [bal, partyType, party]);
  await pool.query('INSERT INTO billing_txn (party_type,party,kind,amount_micros,ref,balance_after_micros) VALUES (?,?,?,?,?,?)',
    [partyType, party, 'TOPUP', amt, ref, bal]);
  return { ok: true, balance_micros: bal };
}

// 广告主扣费：预付扣余额；后付走授信额度（balance 可为负，下限 = -credit_limit）
async function chargeAdvertiser(partyType, party, amountMicros, ref = '') {
  const a = await ensureAccount(partyType, party);
  const amt = micros(amountMicros);
  const bal = micros(a.balance_micros) - amt;
  const floor = (String(a.terms) === 'postpay') ? -micros(a.credit_limit_micros) : 0;
  if (bal < floor) {
    return { ok: false, reason: 'INSUFFICIENT_FUNDS', balance_micros: micros(a.balance_micros), floor_micros: floor, short_micros: floor - bal };
  }
  await pool.query('UPDATE billing_account SET balance_micros=? WHERE party_type=? AND party=?', [bal, partyType, party]);
  await pool.query('INSERT INTO billing_txn (party_type,party,kind,amount_micros,ref,balance_after_micros) VALUES (?,?,?,?,?,?)',
    [partyType, party, 'CHARGE', -amt, ref, bal]);
  return { ok: true, balance_micros: bal };
}

// 媒体应付累计（我们欠媒体的钱）：balance 记为正数
async function accruePublisher(party, amountMicros, ref = '') {
  const a = await ensureAccount('publisher', party);
  const bal = micros(a.balance_micros) + micros(amountMicros);
  await pool.query('UPDATE billing_account SET balance_micros=? WHERE party_type=? AND party=?', [bal, 'publisher', party]);
  await pool.query('INSERT INTO billing_txn (party_type,party,kind,amount_micros,ref,balance_after_micros) VALUES (?,?,?,?,?,?)',
    ['publisher', party, 'ACCRUE', micros(amountMicros), ref, bal]);
  return { ok: true, balance_micros: bal };
}

// ───────── 账单聚合 ─────────
// 广告主：按 campaign 聚合投放量与扣费（以 adv_ledger 为准；缺失则回退 bid_win_log）
async function advertiserLines(party, start, end) {
  const [rows] = await pool.query(
    `SELECT a.id campaign_id, a.name,
       COUNT(DISTINCT l.imp_id) impressions,
       COALESCE(SUM(l.charge_micros),0) amount_micros
     FROM adv_campaign a
     LEFT JOIN adv_ledger l ON l.campaign_id=a.id AND l.created_at>=? AND l.created_at<?
     WHERE a.advertiser=? GROUP BY a.id, a.name`, [start, end, party]);
  const [cv] = await pool.query(
    `SELECT a.id campaign_id, COUNT(*) clicks, COALESCE(SUM(c.type='conversion'),0) conversions
     FROM adv_campaign a LEFT JOIN conv_log c ON c.campaign_id=a.id AND c.created_at>=? AND c.created_at<?
     WHERE a.advertiser=? GROUP BY a.id`, [start, end, party]);
  const cvMap = new Map(cv.map(r => [Number(r.campaign_id), r]));
  return rows.map(r => ({
    dimension: 'campaign:' + r.campaign_id, label: r.name || ('campaign ' + r.campaign_id),
    impressions: Number(r.impressions) || 0,
    clicks: Number((cvMap.get(Number(r.campaign_id)) || {}).clicks) || 0,
    conversions: Number((cvMap.get(Number(r.campaign_id)) || {}).conversions) || 0,
    unit: 'CPM', amount_micros: micros(r.amount_micros),
  }));
}
// 媒体：按 publisher 聚合胜出与分成（应付）
async function publisherLines(party, start, end) {
  const [[p]] = await pool.query('SELECT payout_rate FROM publishers WHERE domain=?', [party]);
  const rate = Number(p && p.payout_rate) || 0.70;
  const [[w]] = await pool.query(
    `SELECT COUNT(*) impressions, COALESCE(SUM(price_micros),0) gross FROM bid_win_log
     WHERE publisher=? AND created_at>=? AND created_at<?`, [party, start, end]);
  const gross = micros(w && w.gross);
  return [{
    dimension: 'publisher:' + party, label: `${party} 分成(${Math.round(rate * 100)}%)`,
    impressions: Number(w && w.impressions) || 0, clicks: 0, conversions: 0,
    unit: 'REVSHARE', amount_micros: Math.round(gross * rate),
  }];
}

function nextInvoiceNo(partyType, periodStart) {
  const prefix = partyType === 'advertiser' ? 'AR' : 'AP';
  const ym = String(periodStart).replace(/-/g, '').slice(0, 6);
  const rnd = Math.floor(Math.random() * 9000 + 1000);
  return `${prefix}${ym}${rnd}`;
}

async function buildInvoice(partyType, party, start, end, opts = {}) {
  const account = await ensureAccount(partyType, party);
  const lines = partyType === 'advertiser' ? await advertiserLines(party, start, end) : await publisherLines(party, start, end);
  const subtotal = lines.reduce((s, l) => s + micros(l.amount_micros), 0);
  const tax = Math.round(subtotal * Number(opts.taxRate != null ? opts.taxRate : TAX_RATE));
  const total = subtotal + tax;
  return {
    party_type: partyType, party,
    period_start: start, period_end: end,
    invoice_title: account.invoice_title || party, tax_id: account.tax_id || '',
    lines: lines.filter(l => l.amount_micros !== 0 || l.impressions),
    subtotal_micros: subtotal, tax_micros: tax, total_micros: total, tax_rate: TAX_RATE,
  };
}

async function issueInvoice(partyType, party, start, end, opts = {}) {
  const draft = await buildInvoice(partyType, party, start, end, opts);
  const no = opts.invoiceNo || nextInvoiceNo(partyType, start);
  const dueDays = Number(opts.termsDays || TERMS_DAYS);
  await pool.query(
    `INSERT INTO invoice (invoice_no,party_type,party,period_start,period_end,subtotal_micros,tax_micros,total_micros,status,invoice_title,tax_id,issued_at,due_at)
     VALUES (?,?,?,?,?,?,?,?,'issued',?,?,NOW(),DATE_ADD(NOW(), INTERVAL ? DAY))
     ON DUPLICATE KEY UPDATE subtotal_micros=VALUES(subtotal_micros), tax_micros=VALUES(tax_micros), total_micros=VALUES(total_micros),
       status='issued', issued_at=NOW(), due_at=VALUES(due_at), invoice_title=VALUES(invoice_title), tax_id=VALUES(tax_id)`,
    [no, partyType, party, start, end, draft.subtotal_micros, draft.tax_micros, draft.total_micros, draft.invoice_title, draft.tax_id, dueDays]);
  await pool.query('DELETE FROM invoice_line WHERE invoice_no=?', [no]);
  for (const l of draft.lines) {
    await pool.query(
      `INSERT INTO invoice_line (invoice_no,dimension,label,impressions,clicks,conversions,unit,amount_micros) VALUES (?,?,?,?,?,?,?,?)`,
      [no, l.dimension, l.label, l.impressions, l.clicks, l.conversions, l.unit, l.amount_micros]);
  }
  return Object.assign({ invoice_no: no, status: 'issued', due_days: dueDays }, draft);
}

async function getInvoice(no) {
  const [[inv]] = await pool.query('SELECT * FROM invoice WHERE invoice_no=?', [no]);
  if (!inv) return null;
  const [lines] = await pool.query('SELECT * FROM invoice_line WHERE invoice_no=?', [no]);
  const [pays] = await pool.query('SELECT * FROM payment WHERE invoice_no=?', [no]);
  const paid = pays.reduce((s, p) => s + micros(p.amount_micros), 0);
  return { ...inv, lines, payments: pays, paid_micros: paid, outstanding_micros: micros(inv.total_micros) - paid };
}
async function listInvoices({ partyType, party, status, limit = 100 } = {}) {
  const where = [], vals = [];
  if (partyType) { where.push('party_type=?'); vals.push(partyType); }
  if (party) { where.push('party=?'); vals.push(party); }
  if (status) { where.push('status=?'); vals.push(status); }
  vals.push(Number(limit) || 100);
  const [rows] = await pool.query(`SELECT * FROM invoice ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT ?`, vals);
  return rows;
}
async function pay(no, amountMicros, method = 'transfer', ref = '') {
  const inv = await getInvoice(no);
  if (!inv) return { ok: false, reason: 'NOT_FOUND' };
  const amt = micros(amountMicros) || inv.outstanding_micros;
  await pool.query('INSERT INTO payment (invoice_no,amount_micros,method,ref) VALUES (?,?,?,?)', [no, amt, method, ref]);
  const paid = micros(inv.paid_micros) + amt;
  const done = paid >= micros(inv.total_micros);
  await pool.query('UPDATE invoice SET status=?, paid_at=? WHERE invoice_no=?', [done ? 'paid' : 'partial', done ? new Date() : null, no]);
  // 收款入账：广告主回款增加可用余额；媒体付款减少应付
  if (inv.party_type === 'advertiser') await topUp('advertiser', inv.party, amt, 'PAY:' + no);
  else await accruePublisher(inv.party, -amt, 'PAY:' + no);
  return { ok: true, invoice_no: no, paid_micros: paid, status: done ? 'paid' : 'partial' };
}
async function voidInvoice(no, reason = '') {
  await pool.query("UPDATE invoice SET status='void' WHERE invoice_no=? AND status<>'paid'", [no]);
  return { ok: true, invoice_no: no, reason };
}

// 账龄：应收账款按逾期天数分桶（0-30 / 31-60 / 61-90 / 90+）
async function aging() {
  const [rows] = await pool.query("SELECT * FROM invoice WHERE status IN ('issued','partial')");
  const buckets = { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0 };
  let total = 0;
  const now = Date.now();
  for (const inv of rows) {
    const [pays] = await pool.query('SELECT COALESCE(SUM(amount_micros),0) paid FROM payment WHERE invoice_no=?', [inv.invoice_no]);
    const out = micros(inv.total_micros) - micros(pays[0] && pays[0].paid);
    if (out <= 0) continue;
    total += out;
    const days = inv.due_at ? Math.floor((now - new Date(inv.due_at).getTime()) / 86400000) : 0;
    if (days <= 0) buckets.current += out;
    else if (days <= 30) buckets.d1_30 += out;
    else if (days <= 60) buckets.d31_60 += out;
    else if (days <= 90) buckets.d61_90 += out;
    else buckets.d90_plus += out;
  }
  return { total_outstanding_micros: total, buckets, count: rows.length };
}

// 月结：对一个账期内所有广告主/媒体批量开票
async function closePeriod(start, end, opts = {}) {
  const out = { advertisers: [], publishers: [] };
  const [advs] = await pool.query('SELECT DISTINCT advertiser FROM adv_campaign WHERE advertiser IS NOT NULL AND advertiser<>""');
  for (const a of advs) {
    const inv = await issueInvoice('advertiser', a.advertiser, start, end, opts);
    if (inv.total_micros > 0) out.advertisers.push(inv);
  }
  const [pubs] = await pool.query('SELECT domain FROM publishers WHERE status=1');
  for (const p of pubs) {
    const inv = await issueInvoice('publisher', p.domain, start, end, opts);
    if (inv.total_micros > 0) out.publishers.push(inv);
  }
  return out;
}

module.exports = {
  attachPool, initTables,
  ensureAccount, getAccount, listAccounts, topUp, chargeAdvertiser, accruePublisher,
  buildInvoice, issueInvoice, getInvoice, listInvoices, pay, voidInvoice, aging, closePeriod,
  TAX_RATE, TERMS_DAYS,
};
