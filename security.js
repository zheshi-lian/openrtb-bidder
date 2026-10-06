// security.js —— 生产化安全基线
// 职责：① 密钥必须来自环境（绝不硬编码兜底）② 后台鉴权 + 审计 ③ 安全响应头 + CORS 白名单
//
// 重要背景：本机 8080 经 Cloudflare Tunnel 暴露为 https://dellai.xyz，
// 因此所有 /api/* 与报表路径都是公网可达面，鉴权不是可选项。

const crypto = require('crypto');

const RAW_NODE_ENV = (process.env.NODE_ENV || '').toLowerCase();
const IS_PROD = RAW_NODE_ENV === 'production';
// 必须显式声明运行环境，禁止「未设置即跑」——否则生产护栏（强口令、密钥必填、演示账号禁用）会被整体旁路
if (!['production', 'development', 'test'].includes(RAW_NODE_ENV)) {
  console.error('[FATAL] 必须显式设置 NODE_ENV（production / development / test 之一）。未设置即运行会让生产护栏被旁路，已禁止启动。');
  process.exit(1);
}

// ── ① 密钥：生产必须显式提供；开发随机生成并持久化到 .rtb_secret，避免重启后旧签名/密码哈希失效 ──
const fs = require('fs');
const path = require('path');
function stableSecret(name) {
  const v = process.env[name];
  if (v && String(v).length >= 16) return String(v);
  const file = path.join(__dirname, '.rtb_secret');
  let map = {};
  try {
    if (fs.existsSync(file)) {
      try { map = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { map = {}; }
    }
  } catch (e) {}
  if (!IS_PROD && map[name] && String(map[name]).length >= 16) return map[name];
  const gen = crypto.randomBytes(32).toString('hex');
  if (!IS_PROD) {
    map[name] = gen;
    try { fs.writeFileSync(file, JSON.stringify(map), { mode: 0o600 }); } catch (e) {}
    console.warn(`[INFO] ${name} 未配置，已写入本地 .rtb_secret 以便重启后稳定（生产请改用环境变量）。`);
  } else if (map[name] && String(map[name]).length >= 16) {
    // 生产环境允许沿用已持久化（600 权限）的 .rtb_secret，避免重启即宕机；但告警提示应改用环境变量
    console.warn(`[SECURITY] 生产环境 ${name} 取自 .rtb_secret 文件（非环境变量）。建议改为环境变量注入以提高安全性。`);
  } else {
    console.error(`[FATAL] 生产环境缺少 ${name}（长度需 ≥16，且环境变量优先）。请设置环境变量或预置 .rtb_secret 后重启。`);
    process.exit(1);
  }
  return gen;
}
const RW_SECRET = stableSecret('RW_SECRET');

const ADMIN_TOKEN = stableSecret('ADMIN_TOKEN');

// ── ②-b 三方账号体系：admin / advertiser / publisher 独立账号 + 作用域令牌 ──
const ACCOUNT_SECRET = process.env.ACCOUNT_SECRET || RW_SECRET;
// 口令存储：使用内置 scrypt（每用户随机盐 + 工作因子），不依赖外部依赖，抗 GPU/ASIC。
// 旧账号若仍是 sha256(ACCOUNT_SECRET+password) 格式，verifyPwd 仍兼容，并在登录成功时透明升级为 scrypt。
const SCRYPT_N = 16384, SCRYPT_r = 8, SCRYPT_p = 1;
function hashPwd(password) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(String(password), salt, 64, { N: SCRYPT_N, r: SCRYPT_r, p: SCRYPT_p });
  return 'scrypt$' + SCRYPT_N + '$' + SCRYPT_r + '$' + SCRYPT_p + '$' + salt.toString('hex') + '$' + h.toString('hex');
}
// 校验口令：支持新 scrypt 与遗留 sha256 两种存储格式
function verifyPwd(password, stored) {
  if (!stored || typeof stored !== 'string') return false;
  if (stored.startsWith('scrypt$')) {
    const parts = stored.split('$');
    if (parts.length !== 6) return false;
    const N = +parts[1], r = +parts[2], p = +parts[3];
    const salt = Buffer.from(parts[4], 'hex');
    const expected = Buffer.from(parts[5], 'hex');
    if (!salt.length || !expected.length) return false;
    const h = crypto.scryptSync(String(password), salt, expected.length, { N, r, p });
    return expected.length === h.length && crypto.timingSafeEqual(expected, h);
  }
  // 遗留格式：sha256(ACCOUNT_SECRET + ':' + password)
  return crypto.createHash('sha256').update(ACCOUNT_SECRET + ':' + String(password)).digest('hex') === stored;
}
// 作用域令牌：payload {u:用户名, t:角色, s:作用域, exp} + HMAC 签名
function issueToken(account) {
  // r=角色（Fix-02）：子管理员需要凭角色在前端/后端做权限裁剪，仅靠 scope 无法区分"未登记的历史账号"
  const payload = { u: account.username, t: account.type, s: account.scope || '', r: account.role || '', exp: Date.now() + 1000 * 60 * 60 * 24 * 7 };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', ACCOUNT_SECRET).update(body).digest('base64url');
  return body + '.' + sig;
}
function verifyToken(t) {
  if (!t || typeof t !== 'string' || t.indexOf('.') < 0) return null;
  const parts = t.split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  const expSig = crypto.createHmac('sha256', ACCOUNT_SECRET).update(body).digest('base64url');
  const a = Buffer.from(sig), b = Buffer.from(expSig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch (e) { return null; }
}
function accountFromReq(req) {
  const t = tokenFrom(req);
  return verifyToken(t);
}
// 统一身份解析：既接受新账号体系签名令牌，也兼容旧版管理员静态令牌（admin 作用域=*）
// 这样无论用「账号密码」还是「旧管理员令牌」登录，都能访问全部后台，不会被新格式锁死
function resolveAccount(req) {
  const acc = accountFromReq(req);
  if (acc) return acc;
  const t = tokenFrom(req);
  if (t && safeEqual(t, ADMIN_TOKEN)) return { u: 'admin', t: 'admin', s: '*', legacy: true };
  return null;
}
// 仅管理员身份（账号体系里的 admin 角色，或旧版静态令牌）；用于 requireAdmin 严格判定
function resolveAdmin(req) {
  const acc = accountFromReq(req);
  if (acc && acc.t === 'admin') return acc.u || 'admin';
  const t = tokenFrom(req);
  if (t && safeEqual(t, ADMIN_TOKEN)) return 'admin';
  return null;
}
// 账号状态查询钩子（由 server.js 注入）：用于「停用即时生效」。
// 令牌本身在有效期内签名依然有效，所以必须在中间件层查库确认账号未被停用——
// 否则后台点「停用」只是改了个数字、账号照样能访问（典型的"前端假权限"）。
let accountLookup = null;
function attachAccountLookup(fn) { accountLookup = fn; }
async function accountActive(username, type) {
  if (!accountLookup || !username) return true;      // 未注入或旧版令牌：不误伤
  try {
    const a = await accountLookup(String(username), String(type || ''));
    if (a && Number(a.status) === 0) return false;
  } catch (e) { }
  return true;
}
// ── ②-c RBAC：管理员角色 → scope 白名单（Fix-02：防止子管理员无限裂变）──
// 背景：邀请码注册出的子管理员原先 scope='*'，与超级管理员权限完全等价，
// 且能继续生成邀请码 → 任何拿到一个邀请码的人可在 3 步内裂变出无限个管理员账号。
// 现在：只有 admin_owner 拥有 admin:invite:write；其余角色按职责裁剪，且一律不含该权限。
const ROLE_SCOPES = {
  // 超级管理员：唯一可以发放邀请码的角色（因此不会通过邀请码裂变出来）
  admin_owner: ['*'],
  // 运营：审核/上下架/素材与计划管控
  admin_ops: ['publishers:read', 'publishers:write', 'advertisers:read', 'advertisers:write',
    'campaigns:read', 'campaigns:write', 'creatives:read', 'creatives:write',
    'reports:read', 'reconciliation:read', 'demand:write'],
  // 财务：结算/对账/账单（只读投放配置）
  admin_finance: ['publishers:read', 'advertisers:read', 'reports:read', 'reports:settlement',
    'reconciliation:read', 'billing:read', 'billing:write'],
  // 销售：可代客户开户与看数，不碰审核与结算
  admin_sales: ['advertisers:read', 'advertisers:write', 'publishers:read', 'reports:read'],
  // 只读：看数，不可写
  admin_viewonly: ['advertisers:read', 'publishers:read', 'reports:read'],
};
// 可由邀请码发放的角色（admin_owner 不在其中 —— 超级管理员不可被裂变出来）
const INVITABLE_ROLES = ['admin_ops', 'admin_finance', 'admin_sales', 'admin_viewonly'];
const DEFAULT_INVITE_ROLE = 'admin_viewonly';
const ROLE_CN = { admin_owner: '超级管理员', admin_ops: '运营管理员', admin_finance: '财务管理员', admin_sales: '销售管理员', admin_viewonly: '只读管理员' };

function isValidRole(role) { return Object.prototype.hasOwnProperty.call(ROLE_SCOPES, String(role || '')); }
function roleScopes(role) { return ROLE_SCOPES[role] || ROLE_SCOPES[DEFAULT_INVITE_ROLE]; }
// scope 判定：'*' 通配；否则按逗号分隔精确匹配
function hasScope(acc, scope) {
  const list = String((acc && acc.s) || '').split(',').map((x) => x.trim()).filter(Boolean);
  if (list.includes('*')) return true;
  return list.includes(String(scope));
}
// 未登记角色的历史账号：scope='*' 视为超级管理员，其余一律按最小权限（只读）处理
function roleOfAccount(acc) {
  const r = String((acc && (acc.role || acc.r)) || '').trim();
  if (isValidRole(r)) return r;
  return String((acc && acc.s) || '') === '*' ? 'admin_owner' : DEFAULT_INVITE_ROLE;
}

// 角色校验中间件：requireAuth('admin','advertiser') 表示 admin 或 advertiser 均可
function requireAuth(...types) {
  return async (req, res, next) => {
    const acc = resolveAccount(req);
    if (!acc || (types.length && !types.includes(acc.t))) {
      return res.status(401).json({ error: 'unauthorized', hint: '请先登录：管理员可用令牌或账号密码，广告主/媒体请用账号密码（/api/account/login）' });
    }
    if (!(await accountActive(acc.u, acc.t))) {
      await logAudit(req, 'DENY_DISABLED', req.originalUrl, 'account disabled: ' + acc.u);
      return res.status(403).json({ error: 'account_disabled', hint: '该账号已被停用，请联系平台运营' });
    }
    req.account = acc;
    next();
  };
}
// 细粒度权限中间件（Fix-02）：必须挂在 requireAuth() 之后（依赖 req.account）。
// 超级管理员(scope='*')放行；子管理员按角色 scope 精确校验，缺权限返回 403 并审计留痕。
function requireScope(scope) {
  return async (req, res, next) => {
    const acc = req.account || resolveAccount(req);
    if (!acc) return res.status(401).json({ error: 'unauthorized', hint: '请先登录' });
    if (acc.t !== 'admin') {
      return res.status(403).json({ error: 'forbidden', required: scope, hint: '仅管理员可访问' });
    }
    if (!(await accountActive(acc.u, acc.t))) {
      return res.status(403).json({ error: 'account_disabled', hint: '该管理员账号已被停用' });
    }
    if (hasScope(acc, scope)) return next();
    await logAudit(req, 'DENY_SCOPE', req.originalUrl, 'missing scope: ' + scope + ' role=' + roleOfAccount(acc));
    return res.status(403).json({
      error: 'forbidden', required: scope, role: roleOfAccount(acc),
      hint: '当前管理员角色（' + (ROLE_CN[roleOfAccount(acc)] || roleOfAccount(acc)) + '）无此权限，请联系超级管理员调整角色',
    });
  };
}

// 生产 DB 凭据不得使用代码内默认值
if (IS_PROD && (!process.env.DB_PASSWORD || !process.env.DB_USER)) {
  console.warn('[SECURITY] 生产环境未设置 DB_USER / DB_PASSWORD，将沿用代码内默认凭据。建议改为环境变量注入，避免凭据随仓库泄露。');
}

// ── ② 鉴权：支持 Bearer / x-admin-token / httpOnly cookie（cookie 让现有 dashboard 免改造即可用）──
function tokenFrom(req) {
  const h = String(req.headers.authorization || '');
  if (h.startsWith('Bearer ')) return h.slice(7).trim();
  if (req.headers['x-admin-token']) return String(req.headers['x-admin-token']);
  const c = String(req.headers.cookie || '');
  const m = c.match(/(?:^|;\s*)adm=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : '';
}
function safeEqual(a, b) {
  const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}
function notifySignature(body) {
  const b = body || {};
  const fields = ['cid', 'crid', 'impid', 'reqid', 'price', 'win', 'test'];
  const payload = fields.map((key) => String(b[key] == null ? '' : b[key])).join('|');
  return crypto.createHmac('sha256', RW_SECRET).update(payload).digest('hex');
}
function verifyNotifySignature(body, signature) {
  return safeEqual(notifySignature(body), signature || '');
}
function identify(req) {
  const t = tokenFrom(req);
  if (t && safeEqual(t, ADMIN_TOKEN)) return 'owner';
  return null;
}

// 审计：管理员的一切写操作/敏感读都应留痕
let auditSink = null;                                   // 由 server.js 注入 pool
function attachAudit(fn) { auditSink = fn; }
async function logAudit(req, action, target, detail) {
  if (!auditSink) return;
  try {
    await auditSink(req, action, target || '', detail || '');
  } catch (e) {}
}

function requireAdmin(action) {
  return async (req, res, next) => {
    const who = resolveAdmin(req);
    if (!who) {
      await logAudit(req, 'DENY_' + (action || 'admin'), req.originalUrl, 'unauthorized');
      return res.status(401).json({ error: 'unauthorized', hint: '需要管理员权限：请用管理员令牌或管理员账号登录' });
    }
    if (!(await accountActive(who, 'admin'))) {
      await logAudit(req, 'DENY_DISABLED', req.originalUrl, 'admin disabled: ' + who);
      return res.status(403).json({ error: 'account_disabled', hint: '该管理员账号已被停用' });
    }
    req.admin = who;
    if (req.method !== 'GET' || process.env.ADMIN_AUDIT_ALL === '1') {
      await logAudit(req, (action || 'admin') + ':' + req.method, req.originalUrl, '');
    }
    next();
  };
}

// ── ③ 安全头 + CORS 白名单 ──
// CORS 仅对白名单域下发（未命中时保持原行为，避免意外放开或意外破坏现有跨域调用）
const ALLOWED = (process.env.ALLOWED_ORIGINS || 'https://dellai.xyz,http://localhost:8080,http://127.0.0.1:8080,http://localhost:8081').split(',').map(s => s.trim()).filter(Boolean);

// 无需鉴权、且必须被第三方站点跨域调用的开放端点（pub_sdk / 竞价 / 上报 / 留资）
// 这些路径保持 CORS * 以保证 SDK 可用；它们不返回经营数据，配合签名/指纹做防刷。
// /api/public/ 覆盖：ruankao-lead（落地页跨域回传联系方式）、advertiser-open（自助开户）等。
// '/api/notify' 是 /notify 的等价别名（Fix-09），同样需要被第三方站点/浏览器 SDK 跨域调用
const OPEN_CORS = ['/ssp/', '/vast/', '/notify', '/api/notify', '/api/track/', '/openrtb2/', '/ms/', '/api/public/'];

function secureCors(req, res, next) {
  res.removeHeader('X-Powered-By');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');

  const p = req.path || req.url || '';
  const isOpen = OPEN_CORS.some(x => p.startsWith(x));
  const o = req.headers.origin;

  if (isOpen) {                                   // 公开竞价/上报面：保持 * （SDK 需要）
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(204).end();
    return next();
  }

  if (o && ALLOWED.includes(o)) {                 // 管理面：仅白名单域
    res.setHeader('Access-Control-Allow-Origin', o);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-Admin-Token');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    if (req.method === 'OPTIONS') return res.status(204).end();
  }
  next();
}

module.exports = {
  IS_PROD, RW_SECRET, ADMIN_TOKEN, ACCOUNT_SECRET, requireAdmin, secureCors, identify, attachAudit, logAudit, ALLOWED,
  hashPwd, verifyPwd, issueToken, verifyToken, accountFromReq, resolveAccount, resolveAdmin, requireAuth, attachAccountLookup,
  notifySignature, verifyNotifySignature,
  // RBAC（Fix-02）
  ROLE_SCOPES, INVITABLE_ROLES, DEFAULT_INVITE_ROLE, ROLE_CN, isValidRole, roleScopes, hasScope, roleOfAccount, requireScope,
};
