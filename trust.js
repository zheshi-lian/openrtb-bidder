// trust.js —— 供给信任层：ads.txt / app-ads.txt / sellers.json（IAB 标准）
//
// 为什么这是 Tier 0 而不是"锦上添花"：
//   买方（尤其 AppLovin/Google/Meta 这类大 DSP）在采买前会做 supply chain 校验。
//   没有 ads.txt / sellers.json，你的流量在买方眼里是"未授权库存"——
//   结果不是"不买"，而是"压价买"或"只投放低价值广告"。这是真金白银的 eCPM 折损。
//
// 三件套分工：
//   · ads.txt      —— 由【媒体方】在自己域名根路径声明"谁有权卖我的库存"（权威在媒体）
//   · app-ads.txt  —— 同上，面向 App（多一个 App Store ID 维度）
//   · sellers.json —— 由【交易所/中介】声明"我代表哪些媒体在卖"（权威在我们）
//   三者交叉校验：媒体 ads.txt 里有我们的域名+seller_id，且我们的 sellers.json 里有该媒体，
//   这条供给才算 authorized。缺任一半 = 未授权库存。

const crypto = require('crypto');

const OUR_DOMAIN = process.env.EXCHANGE_DOMAIN || 'dellai.xyz';
const OUR_SELLER_ID = process.env.EXCHANGE_SELLER_ID || '1';
const CONTACT_EMAIL = process.env.TRUST_CONTACT || 'adops@dellai.xyz';
const CERT_AUTHORITY = process.env.TRUST_CERT_AUTHORITY || 'iabtechlab.com';

let pool = null;
function attachPool(p) { pool = p; }

async function initTables() {
  if (!pool) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS supply_trust (
    domain VARCHAR(160) PRIMARY KEY,
    app_id VARCHAR(128) DEFAULT '',
    seller_id VARCHAR(64) DEFAULT '',
    seller_type VARCHAR(24) DEFAULT 'PUBLISHER',
    is_confidential TINYINT DEFAULT 0,
    ads_txt_status VARCHAR(16) DEFAULT 'unknown',
    app_ads_txt_status VARCHAR(16) DEFAULT 'unknown',
    relationship VARCHAR(16) DEFAULT '',
    tag_id VARCHAR(64) DEFAULT '',
    raw TEXT, checked_at BIGINT DEFAULT 0, note VARCHAR(255) DEFAULT ''
  )`).catch(() => {});
  // 媒体声明的"授权卖方"记录（我们爬到对方 ads.txt 后落库，供交叉校验）
  await pool.query(`CREATE TABLE IF NOT EXISTS supply_auth_line (
    id BIGINT AUTO_INCREMENT PRIMARY KEY, domain VARCHAR(160), file VARCHAR(16),
    seller_domain VARCHAR(160), account_id VARCHAR(64), relationship VARCHAR(16),
    tag_id VARCHAR(64), app_id VARCHAR(128) DEFAULT '', checked_at BIGINT DEFAULT 0,
    UNIQUE KEY uk_line (domain, file, seller_domain, account_id, app_id)
  )`).catch(() => {});
}

// ───────── 解析 ─────────
// ads.txt 规范：
//   每行： <域名>, <账号ID>, <关系 DIRECT|RESELLER>, <TAG-ID(可选)>
//   # 开头为注释；key=value 行为变量（contact / subdomain / marketplaceurl / inventorypartnerdomain）
function parseAdsTxt(text) {
  const out = { records: [], variables: {}, errors: [] };
  String(text || '').split(/\r?\n/).forEach((rawLine, i) => {
    const line = rawLine.split('#')[0].trim();
    if (!line) return;
    if (/^[a-zA-Z_]+=/.test(line) && line.indexOf(',') === -1) {
      const idx = line.indexOf('=');
      out.variables[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
      return;
    }
    const p = line.split(',').map(s => s.trim()).filter((s, j, arr) => j < 3 || s !== '');
    if (p.length < 3) { out.errors.push({ line: i + 1, text: rawLine, why: 'FIELD_COUNT' }); return; }
    const rec = { domain: p[0].toLowerCase(), accountId: p[1], relationship: String(p[2] || '').toUpperCase() };
    if (rec.relationship !== 'DIRECT' && rec.relationship !== 'RESELLER') {
      out.errors.push({ line: i + 1, text: rawLine, why: 'BAD_RELATIONSHIP' }); return;
    }
    if (p[3]) rec.tagId = p[3];
    out.records.push(rec);
  });
  return out;
}

// app-ads.txt：字段1=广告系统域名，字段2=媒体 App Store ID（数字），字段3=关系，字段4=证书颁发机构
function parseAppAdsTxt(text) {
  const out = { records: [], variables: {}, errors: [] };
  String(text || '').split(/\r?\n/).forEach((rawLine, i) => {
    const line = rawLine.split('#')[0].trim();
    if (!line) return;
    if (/^[a-zA-Z_]+=/.test(line) && line.indexOf(',') === -1) {
      const idx = line.indexOf('=');
      out.variables[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
      return;
    }
    const p = line.split(',').map(s => s.trim());
    if (p.length < 3) { out.errors.push({ line: i + 1, text: rawLine, why: 'FIELD_COUNT' }); return; }
    const rec = { domain: p[0].toLowerCase(), appId: p[1], relationship: String(p[2] || '').toUpperCase() };
    if (rec.relationship !== 'DIRECT' && rec.relationship !== 'RESELLER') {
      out.errors.push({ line: i + 1, text: rawLine, why: 'BAD_RELATIONSHIP' }); return;
    }
    if (!/^\d+$/.test(rec.appId)) { out.errors.push({ line: i + 1, text: rawLine, why: 'BAD_APP_ID' }); return; }
    if (p[3]) rec.certAuthority = p[3];
    out.records.push(rec);
  });
  return out;
}

// ───────── 生成（我方对外提供的文件）─────────
// ads.txt：声明"我(dellai.xyz)的库存由谁卖"——我们自己就是交易所，所以 DIRECT 指向自己
function adsTxtContent(extraRecords = []) {
  const lines = [
    `# ads.txt — ${OUR_DOMAIN}`,
    `# 由 ADX 自动生成；更新时间 ${new Date().toISOString()}`,
    `contact=${CONTACT_EMAIL}`,
    `${OUR_DOMAIN}, ${OUR_SELLER_ID}, DIRECT, ${CERT_AUTHORITY}`,
  ];
  extraRecords.forEach(r => lines.push(`${r.domain}, ${r.accountId}, ${r.relationship}${r.tagId ? ', ' + r.tagId : ''}`));
  return lines.join('\n') + '\n';
}

function appAdsTxtContent(extraRecords = []) {
  const lines = [
    `# app-ads.txt — ${OUR_DOMAIN}`,
    `# 由 ADX 自动生成；更新时间 ${new Date().toISOString()}`,
    `contact=${CONTACT_EMAIL}`,
  ];
  extraRecords.forEach(r => lines.push(`${r.domain || OUR_DOMAIN}, ${r.appId}, ${r.relationship}${r.certAuthority ? ', ' + r.certAuthority : ''}`));
  return lines.join('\n') + '\n';
}

// sellers.json：宣告我们作为交易所代表哪些卖方在卖库存（买方据此校验 ads.txt）
async function sellersJson() {
  const identifiers = [];
  if (pool) {
    try {
      const [rows] = await pool.query(
        "SELECT domain, name, seller_id, seller_type, is_confidential FROM supply_trust WHERE ads_txt_status IN ('authorized','unknown') OR seller_id<>''");
      rows.forEach(r => identifiers.push({
        'seller_id': r.seller_id || shortId(r.domain),
        'seller_type': r.seller_type || 'PUBLISHER',
        'is_confidential': Number(r.is_confidential) ? 1 : 0,
        'name': r.name || r.domain,
        'domain': r.domain,
      }));
      // 未在 supply_trust 登记但已入驻的媒体也要出现，否则买方校验会判"未授权"
      const [pubs] = await pool.query('SELECT domain, name FROM publishers WHERE status=1');
      const seen = new Set(identifiers.map(i => i.domain));
      pubs.forEach(p => {
        if (seen.has(p.domain)) return;
        identifiers.push({
          'seller_id': shortId(p.domain), 'seller_type': 'PUBLISHER', 'is_confidential': 0,
          'name': p.name || p.domain, 'domain': p.domain,
        });
      });
    } catch (e) {}
  }
  if (!identifiers.length) {
    identifiers.push({ 'seller_id': OUR_SELLER_ID, 'seller_type': 'PUBLISHER', 'is_confidential': 0, 'name': OUR_DOMAIN, 'domain': OUR_DOMAIN });
  }
  // 我们自己作为 INTERMEDIARY 也要登记：否则下游 DSP 无法沿供应链追溯
  identifiers.unshift({
    'seller_id': OUR_SELLER_ID, 'seller_type': 'INTERMEDIARY', 'is_confidential': 0,
    'name': OUR_DOMAIN, 'domain': OUR_DOMAIN,
    'ext': { 'supply_chain_object': true },
  });
  return {
    'version': '1',
    'contact_email': CONTACT_EMAIL,
    'identifiers': identifiers,
    'ext': { 'generated_at': Date.now(), 'exchange_domain': OUR_DOMAIN },
  };
}

function shortId(domain) {
  return 'S' + crypto.createHash('sha1').update(String(domain)).digest('hex').slice(0, 10);
}

// ───────── 校验（我方爬取媒体方文件）──────────
// 判定"我们是否被该媒体授权卖其库存"：对方 ads.txt 中必须出现 OUR_DOMAIN + 我们的账号ID
function verifyRecords(records, accountId = OUR_SELLER_ID) {
  const mine = records.filter(r => r.domain === OUR_DOMAIN || OUR_DOMAIN.endsWith('.' + r.domain));
  if (!mine.length) return { authorized: false, reason: 'NO_ENTRY' };
  const exact = mine.find(r => String(r.accountId) === String(accountId));
  if (!exact) return { authorized: false, reason: 'ACCOUNT_MISMATCH', found: mine.map(r => r.accountId) };
  return { authorized: true, relationship: exact.relationship, tagId: exact.tagId || '', accountId: exact.accountId };
}

async function crawl(domain, kind = 'ads.txt') {
  const d = String(domain || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase();
  if (!d) return { ok: false, status: 'invalid_domain' };
  const url = `https://${d}/${kind}`;
  let status = 'error', parsed = null, note = '';
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 8000);
    const r = await fetch(url, { signal: ctrl.signal, redirect: 'follow' });
    clearTimeout(to);
    if (!r.ok) { status = 'missing'; note = 'http ' + r.status; }
    else {
      const text = await r.text();
      parsed = kind === 'app-ads.txt' ? parseAppAdsTxt(text) : parseAdsTxt(text);
      const v = verifyRecords(parsed.records);
      status = v.authorized ? 'authorized' : 'unauthorized';
      note = v.reason || '';
      await persistLines(d, kind, parsed.records);
    }
  } catch (e) { status = 'unreachable'; note = String(e.message || e).slice(0, 120); }

  const col = kind === 'app-ads.txt' ? 'app_ads_txt_status' : 'ads_txt_status';
  if (pool) {
    try {
      await pool.query(
        `INSERT INTO supply_trust (domain, ${col}, checked_at, note, raw, relationship, tag_id)
         VALUES (?,?,?,?,?,?,?)
         ON DUPLICATE KEY UPDATE ${col}=VALUES(${col}), checked_at=VALUES(checked_at), note=VALUES(note), raw=VALUES(raw), relationship=VALUES(relationship), tag_id=VALUES(tag_id)`,
        [d, status, Date.now(), note, parsed ? JSON.stringify(parsed.records).slice(0, 60000) : '', parsed ? '' : '', '']);
    } catch (e) {}
  }
  return { ok: status === 'authorized', domain: d, kind, status, note, records: parsed ? parsed.records.length : 0, errors: parsed ? parsed.errors.length : 0 };
}

async function persistLines(domain, kind, records) {
  if (!pool || !records.length) return;
  for (const r of records.slice(0, 500)) {
    await pool.query(
      `INSERT IGNORE INTO supply_auth_line (domain,file,seller_domain,account_id,relationship,tag_id,app_id,checked_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      [domain, kind, r.domain, r.accountId, r.relationship, r.tagId || '', r.appId || '', Date.now()]).catch(() => {});
  }
}

// 交叉校验：对方授权我们 + 我们在 sellers.json 声明对方 → 该供给可被采买
async function supplyChainStatus(domain) {
  const sj = await sellersJson();
  const inSellers = sj.identifiers.some(i => i.domain === String(domain).toLowerCase());
  let trust = null;
  if (pool) {
    try {
      const [[t]] = await pool.query('SELECT * FROM supply_trust WHERE domain=?', [String(domain).toLowerCase()]);
      trust = t || null;
    } catch (e) {}
  }
  const adsOk = trust && trust.ads_txt_status === 'authorized';
  const appOk = !trust || !trust.app_id || trust.app_ads_txt_status === 'authorized';
  return {
    domain, in_sellers_json: inSellers, ads_txt: (trust && trust.ads_txt_status) || 'unknown',
    app_ads_txt: (trust && trust.app_ads_txt_status) || 'unknown',
    authorized: !!inSellers && !!adsOk && appOk,
    gaps: [!inSellers && 'NOT_IN_SELLERS_JSON', !adsOk && 'ADS_TXT_NOT_AUTHORIZED', !appOk && 'APP_ADS_TXT_NOT_AUTHORIZED'].filter(Boolean),
  };
}

module.exports = {
  attachPool, initTables,
  parseAdsTxt, parseAppAdsTxt, verifyRecords,
  adsTxtContent, appAdsTxtContent, sellersJson,
  crawl, supplyChainStatus, shortId,
  OUR_DOMAIN, OUR_SELLER_ID,
};
