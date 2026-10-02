// security.js —— 生产化安全基线
// 职责：① 密钥必须来自环境（绝不硬编码兜底）② 后台鉴权 + 审计 ③ 安全响应头 + CORS 白名单
//
// 重要背景：本机 8080 经 Cloudflare Tunnel 暴露为 https://dellai.xyz，
// 因此所有 /api/* 与报表路径都是公网可达面，鉴权不是可选项。

const crypto = require('crypto');

const IS_PROD = (process.env.NODE_ENV || '').toLowerCase() === 'production';

// ── ① 密钥：生产必须显式提供；开发随机生成（每次启动失效旧令牌，宁可不方便也不能用已知值）──
function requireSecret(name, devGenerate = false) {
  const v = process.env[name];
  if (v && String(v).length >= 16) return String(v);
  if (IS_PROD) {
    console.error(`[FATAL] 生产环境缺少 ${name}（且长度需 ≥16）。请在环境变量中设置后重启。`);
    process.exit(1);
  }
  if (devGenerate) {
    const gen = crypto.randomBytes(32).toString('hex');
    console.warn(`[WARN] 未设置 ${name}，本次启动随机生成（重启后旧签名令牌失效）。生产必须显式配置。`);
    return gen;
  }
  return '';
}
const RW_SECRET = requireSecret('RW_SECRET', true);

const ADMIN_TOKEN = (() => {
  const v = process.env.ADMIN_TOKEN;
  if (v && v.length >= 16) return v;
  const gen = crypto.randomBytes(24).toString('hex');
  console.warn('[WARN] 未设置 ADMIN_TOKEN，本次随机生成（见下方 token，重启即变）。生产必须显式配置。');
  console.warn(`[ADMIN_TOKEN] ${gen}`);
  return gen;
})();

// ── ②-b 三方账号体系：admin / advertiser / publisher 独立账号 + 作用域令牌 ──
const ACCOUNT_SECRET = process.env.ACCOUNT_SECRET || RW_SECRET;
function hashPwd(password) {
  return crypto.createHash('sha256').update(ACCOUNT_SECRET + ':' + String(password)).digest('hex');
}
// 作用域令牌：payload {u:用户名, t:角色, s:作用域, exp} + HMAC 签名
function issueToken(account) {
  const payload = { u: account.username, t: account.type, s: account.scope || '', exp: Date.now() + 1000 * 60 * 60 * 24 * 7 };
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

// 生产 DB 凭据不得使用代码内默认值
if (IS_PROD && (!process.env.DB_PASSWORD || !process.env.DB_USER)) {
  console.error('[FATAL] 生产环境必须设置 DB_USER / DB_PASSWORD（禁止使用代码内默认值）');
  process.exit(1);
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
const OPEN_CORS = ['/ssp/', '/vast/', '/notify', '/api/track/', '/openrtb2/', '/ms/', '/api/public/'];

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

module.exports = { IS_PROD, RW_SECRET, ADMIN_TOKEN, ACCOUNT_SECRET, requireAdmin, secureCors, identify, attachAudit, logAudit, ALLOWED, hashPwd, issueToken, verifyToken, accountFromReq, resolveAccount, resolveAdmin, requireAuth, attachAccountLookup };
