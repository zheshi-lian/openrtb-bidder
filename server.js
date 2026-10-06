// 程序化广告平台原型 v2 —— 供给端(SSP) + 需求端(DSP) + 意图匹配(inten>eCPM) + 双边账本
const express = require('express');
const mysql = require('mysql2/promise');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
// 轻量加载 .env（无第三方依赖）：仅填充尚未设置的环境变量，不覆盖已注入的环境。
// 让 ALERT_WEBHOOK / LLM_* / ADMIN_TOKEN / PUB_API_KEY 等从 .env 自动复用（飞书告警等依赖它）。
try {
  const ep = path.join(__dirname, '.env');
  if (fs.existsSync(ep)) {
    for (const line of fs.readFileSync(ep, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m || line.trim().startsWith('#') || line.trim() === '') continue;
      const k = m[1], v = m[2].replace(/^["']|["']$/g, '');
      if (process.env[k] === undefined) process.env[k] = v;
    }
  }
} catch (e) {}
const llm = require('./llm');
const cache = require('./cache'); // 可降级缓存(Redis可选) + 指标采集
const ecpm = require('./ecpm_engine'); // eCPM' 引擎（对齐 BP_v7 §2.6）
const bidModel = require('./bid_model'); // 在线转化预测（数据驱动出价）
const creativeAb = require('./creative_ab'); // P1 创意 A/B 多版本 + Thompson Sampling 自动优选
const ksDSP = require('./sdk/kuaishou-dsp/adapter'); // 快手磁力引擎 开放平台 · DSP/买量侧 适配脚手架
const oeDSP = require('./sdk/oceanengine-dsp/adapter'); // 巨量引擎(OceanEngine/抖音) 开放平台 · DSP/买量侧 适配脚手架
const genericDSP = require('./sdk/generic-dsp/adapter'); // 通用 OpenRTB 需求方（自包含，可持续出价）
const mintegralDSP = require('./sdk/mintegral-dsp/adapter'); // Mintegral 外部 Bidding 网络（简化版 Waterfall）
const adcolonyDSP = require('./sdk/adcolony-dsp/adapter');   // AdColony 外部 Bidding 网络（简化版 Waterfall）
const security = require('./security'); // 生产化安全基线：密钥/鉴权/审计/CORS

// ===== 补齐 AppLovin 差距的新增能力层（Tier 0 生产化 + Tier 1 技术竞争力）=====
const trust = require('./trust');            // ads.txt / app-ads.txt / sellers.json 信任层
const pacing = require('./pacing');          // 时段投放 + 频控 + 流量曲线 pace + 预算感知出价
const retarget = require('./retarget');      // 受众分群 / 再营销（设备级再营销池）
const billing = require('./billing');        // 账户/账期/账单/发票/收款/账龄
const brandSafety = require('./brand_safety'); // IAB 分类 + GARM 分级 + pre-bid 屏蔽 + 验证厂商
const campaignStore = require('./campaign_store'); // 竞价热路径内存快照 + 倒排索引（去 DB/redis）
const identity = require('./identity_graph'); // 身份解析图谱（post-ATT 设备图）
const attribution = require('./attribution'); // 多触点归因 + 浏览归因 + SKAN + 增量实验
const creativeAuto = require('./creative');  // 可玩广告 / DCO / 静图转视频 / 多语言
const ml = require('./ml');                  // 特征平台 + 多目标 pLTV + 校准 + Bandit + 注册监控
const neuralBridge = require('./ml/neural_bridge');  // 离线预训练权重(含阿里妈妈 CVR 头)接入在线出价，门控且默认回落 LR
const bidEng = require('./bid');             // 胜率模型 + bid shading + 限流 + deadline
const metrics = require('./metrics');        // p50/p95/p99 分位数 + QPS + SLO
const anticheat = require('./anticheat');    // 反作弊：设备/IP 去重 + Bot 检测 + 点击欺诈 + 黑名单
const oidc = require('./oidc');            // #11 OIDC 单点登录（零依赖：PKCE + state/nonce + RS256/JWKS 校验）

const app = express();
// 素材上传走 JSON(base64)，会比原文件大约 +33%：原先 1mb 限制下原图/视频超过 ~750KB 就被 413 拒掉，
// 且前端只看到 catch 里的报错。放宽到 10mb 以支撑真实素材文件。
app.use(express.json({ limit: '10mb' }));

// 安全响应头 + CORS 分区：第三方 SDK 可跨域调竞价/上报；管理面仅白名单域
app.use(security.secureCors);

// ===== 后台鉴权：本机经隧道公网可达(dellai.xyz)，管理面必须鉴权 =====
// 注意：必须早于业务路由注册，否则会先命中 handler 而绕过鉴权
const ADMIN_PREFIXES = [
  // 注意：'/ssp/report' 已移出本列表 —— 它同时对「媒体」开放（收益报表需要它），
  // 原先被前缀 requireAdmin 先行拦截 → 媒体访问必 401。现由路由自身做 requireAuth('admin','publisher') 隔离。
  '/report', '/api/report', '/api/reports',
  // 注意：/api/creatives(素材库) 由其路由自身用 requireAuth('admin','advertiser') 保护，
  // 不放进管理员前缀——否则前缀 requireAdmin 会先于路由执行、把广告主自己挡在素材库外。
  // 注意：/api/dsp/register（需求方自助注册出价端点）现要求「管理员令牌 或 已入驻平台 api_key」
  // ——防止匿名第三方任意注入需求方污染竞价池（安全）。列表与删除仍要管理员（见各自路由上的 requireAdmin）。
  '/api/demand-partners', '/api/console',
  // 注意：/api/ecpm（eCPM' 演示：eval/rank/feedback/reset/evals）是公开营销演示接口，
  // 只读写 sku_eval/sku_stats 演示表、不含任何账号/经营数据，必须匿名可访问——
  // 与下方 /api/demo/report、/api/public/ecpm-score 同理，避免匿名访问 401/undefined。
  '/api/reward/log',
  // 经营与计费数据一律不得匿名访问
  '/api/billing', '/api/trust'
  // 注：/metrics（Prometheus 抓取端点）不在此列——它必须匿名可访问，供本机 Prometheus 直连各 worker 端口抓取
  // （localhost 抓取无需令牌）；经公网隧道暴露时仅含运营计数(无 PII)，风险可控。
];
// 前缀内的例外路径：这些端点必须对"媒体自己"开放，由路由自身做角色隔离（Bearer/X-Api-Key 均可）。
// Fix-05：/api/reports/publisher 原本被 /api/reports 前缀的 requireAdmin 先拦截 →
// 媒体令牌 401、管理员令牌 403（只认 api_key 查询参数），文档承诺与实现对不上。
// 注意：app.use(p, fn) 内部 req.path 是"去掉挂载前缀后"的路径。
const ADMIN_PREFIX_SKIP = {
  '/api/reports': ['/publisher'],
};
ADMIN_PREFIXES.forEach(p => app.use(p, function (req, res, next) {
  const skips = ADMIN_PREFIX_SKIP[p];
  if (skips && skips.some(s => req.path === s || req.path.startsWith(s + '/'))) return next();
  return security.requireAdmin('admin')(req, res, next);
}));

// 高级能力台 / 归因 等能力面：登录的 admin / 广告主 / 媒体都应可用。
// 原先整段挂在 requireAdmin 下 → 非 admin 一律 401，advanced.html 每个按钮都是空响应，
// 且被前端 .catch(()=>[]) 静默吞掉，看起来像"功能根本没做"。改为角色级鉴权，匿名仍被拒绝。
const ROLE_PREFIXES = ['/api/brand-safety', '/api/pacing', '/api/identity', '/api/ml',
  '/api/bid', '/api/attribution', '/api/incrementality', '/api/anticheat'];
ROLE_PREFIXES.forEach(p => app.use(p, security.requireAuth('admin', 'advertiser', 'publisher')));

// 管理员登录：交换 httpOnly cookie，使现有 dashboard 页面无需改造即可通过鉴权
// 接受三种凭据：① 旧版静态 ADMIN_TOKEN ② 账号体系签发的作用域令牌 ③（仅 token 换 cookie）
// 修掉原缺陷：identify() 只认静态令牌，账号体系令牌被拒 → 账号密码登录后此处写 cookie 返回 401，
//   导致依赖 adm cookie 的旧 dashboard 页面在「账号密码登录」后仍然 401。现补上 verifyToken() 校验。
app.post('/api/admin/login', (req, res) => {
  const t = String((req.body || {}).token || '');
  const valid = t && (security.identify({ headers: { authorization: 'Bearer ' + t } }) || security.verifyToken(t) !== null);
  if (valid) {
    // Secure 仅在实际 HTTPS 连接下下发：本地 HTTP 演示时若带 Secure，浏览器会拒绝随请求回传该 cookie，导致登录永远失效、管理页全 401
    const isHttps = req.secure || String(req.headers['x-forwarded-proto'] || '').split(',').map(s => s.trim()).includes('https');
    res.setHeader('Set-Cookie', `adm=${encodeURIComponent(t)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=86400` + (isHttps ? '; Secure' : ''));
    return res.json({ ok: true });
  }
  security.logAudit(req, 'LOGIN_FAIL', '', '');
  res.status(401).json({ error: 'bad token' });
});
app.post('/api/admin/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'adm=; HttpOnly; Path=/; Max-Age=0');
  res.json({ ok: true });
});

// ===== 三方账号体系：注册 / 登录 / 作用域令牌（对标 AppLovin 三套独立后台）=====
// 仅管理员可注册租客账号（广告主/媒体/子管理员），用于运营给客户开通与演示
// ── 账号标识规范：登录邮箱 / 业务作用域 / 系统唯一码 三者解耦 ──
// 此前登录名、显示名、作用域三个字段都能填邮箱或域名，口径混乱（"媒体登录到底用邮箱还是网址还是名称"）。
// 现在明确：登录=邮箱（唯一、可找回）；作用域=业务口径（媒体是域名、广告主是名称）；唯一码=系统标识（自动生成、不可变）。
const _CODE_ALPHABET = 'ACDEFGHJKLMNPQRTUVWXY34789';   // 去掉 0/O/1/I 等易混字符
const ROLE_CN = { admin: '平台运营', advertiser: '广告主', publisher: '开发者' };
function genAccountCode(type) {
  const p = type === 'admin' ? 'ADM' : type === 'advertiser' ? 'ADV' : 'PUB';
  let s = '';
  for (let i = 0; i < 6; i++) s += _CODE_ALPHABET[crypto.randomBytes(1)[0] % _CODE_ALPHABET.length];
  return p + '-' + s;
}
function isEmail(v) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || '').trim()); }
function isDomain(v) { return /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z]{2,})+$/.test(String(v || '').trim()); }
// 手机号仅作"登录标识"（手机号+密码），不发短信 → 零成本。
// 注意：若要"短信验证码登录/找回密码"才需要接短信网关（按条计费 + 企业实名 + 签名模板报备），那是另一笔钱。
function isPhone(v) { return /^1[3-9]\d{9}$/.test(String(v || '').trim()); }
// 域名归一化：去掉协议 / www / 路径 / 尾斜杠，只留裸域名。
// 用户常填 https://dellai.xyz/ 这类带协议的写法，原样入库后与 bid_win_log.publisher（裸域名）
// 及 publishers.domain 对不上 → 收益报表与集成自检查不到自己的数据（同一站点还会变成多条记录）。
function normalizeDomain(v) {
  let s = String(v || '').trim().toLowerCase();
  s = s.replace(/^[a-z]+:\/\//, '');          // 去协议
  s = String(s).split('/')[0].split('?')[0];  // 去路径与查询串
  s = s.replace(/^www\./, '');                // 去 www 前缀
  s = s.replace(/\.$/, '');                   // 去尾点
  return s;
}

app.post('/api/account/register', security.requireAuth('admin'), async (req, res) => {
  const { type, username, password, scope, display } = req.body || {};
  if (!['admin', 'advertiser', 'publisher'].includes(type)) return res.status(400).json({ error: 'type 必须是 admin/advertiser/publisher' });
  if (!username || !password) return res.status(400).json({ error: 'username,password required' });
  if (String(password).length < 6) return res.status(400).json({ error: 'password 至少 6 位' });
  let sc = (scope || '').toString().trim();
  if (type === 'advertiser' && !sc) return res.status(400).json({ error: 'advertiser 账号需指定 scope=广告主名称（业务作用域）' });
  if (type === 'publisher' && !sc) return res.status(400).json({ error: 'publisher 账号需指定 scope=媒体域名（业务作用域）' });
  // 媒体作用域必须是合法域名：域名是"数据可见范围"，不是登录名（此前把域名当登录名填进 username，导致口径混乱）
  if (type === 'publisher' && !isDomain(sc)) return res.status(400).json({ error: '媒体作用域必须是合法域名（如 dellai.xyz）；域名是数据作用域，登录请用邮箱' });
  if (type === 'admin') sc = '*';
  // 登录账号规范：广告主/媒体用邮箱或手机号（唯一、便于找回）；管理员可用用户名。
  // 手机号是登录标识而非短信通道，"手机号+密码"零成本；短信验证码登录需另接付费网关。
  if (type !== 'admin' && !isEmail(username) && !isPhone(username)) return res.status(400).json({ error: '广告主/媒体的登录账号必须是邮箱或手机号（唯一，便于找回）' });
  try {
    // 唯一性按 (角色, 登录账号)：同一邮箱可分别开广告主与开发者账号
    const [[dup]] = await pool.query('SELECT id FROM accounts WHERE username=? AND type=?', [username, type]);
    if (dup) return res.status(409).json({ error: '该 ' + (ROLE_CN[type] || type) + ' 账号已存在（如需另一角色，可用同一邮箱注册其它角色）' });
    const code = genAccountCode(type);
    await pool.query('INSERT INTO accounts (type,username,pass_hash,scope,display,created_by,account_code) VALUES (?,?,?,?,?,?,?)',
      // display 不再要求填写：未填时自动派生自作用域（广告主=名称 / 媒体=域名），
      // 该字段只作管理员识别用，登录者自己也看不到，没必要让用户多填一项。
      [type, username, security.hashPwd(password), sc, display || sc || username, (req.account && req.account.u) || 'system', code]);
    res.json({ ok: true, type, username, scope: sc, account_code: code });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── 登录防爆破（对标 AppLovin/Trade Desk：失败 N 次锁定）──
// 按 (出口IP | 用户名小写) 计数：5 次失败锁定 15 分钟。内存态、不落敏感日志、重启清零；
// 单实例足够演示与中小规模使用，多实例请改为 Redis（现有 redisadx 可直接复用）。
const _loginFails = new Map();
// 阈值与锁定时长：原「5 次失败锁 15 分钟」过于严苛——用户忘记密码连试几次就被锁，
// 锁定期间【正确密码也进不去】，且错误提示不告知剩余次数 → 越试越锁死（实际故障放大器）。
// 放宽为 8 次 / 锁 5 分钟，并在每次失败时告知剩余次数。
const LOGIN_FAIL_LIMIT = 8;
const LOGIN_LOCK_MS = 5 * 60 * 1000;
function _loginKey(ip, username) { return (ip || '?') + '|' + String(username || '').toLowerCase(); }
function loginGuard(ip, username) {
  const k = _loginKey(ip, username), now = Date.now();
  const rec = _loginFails.get(k) || { n: 0, until: 0 };
  if (rec.until > now) return { lock: true, wait: Math.ceil((rec.until - now) / 1000) };
  rec.n += 1;
  if (rec.n >= LOGIN_FAIL_LIMIT) { rec.until = now + LOGIN_LOCK_MS; rec.n = 0; return { lock: true, wait: Math.round(LOGIN_LOCK_MS / 1000) }; }
  _loginFails.set(k, rec);
  return { lock: false, tries: rec.n, left: LOGIN_FAIL_LIMIT - rec.n };
}
function loginReset(ip, username) { _loginFails.delete(_loginKey(ip, username)); }
setInterval(() => { const now = Date.now(); for (const [k, v] of _loginFails) if (v.until < now - 30 * 60 * 1000) _loginFails.delete(k); }, 30 * 60 * 1000).unref();

app.post('/api/account/login', async (req, res) => {
  const { username, password } = req.body || {};
  const ip = String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
  if (!username || !password) return res.status(400).json({ error: 'username,password required' });
  const g = loginGuard(ip, username);
  if (g.lock) {
    security.logAudit(req, 'LOGIN_LOCKED', String(username), '');
    return res.status(429).json({ error: '尝试次数过多，请稍后再试', wait: g.wait });
  }
  try {
    // 登录账号：支持用「邮箱/手机号」或「唯一码」登录。
    // 同一邮箱可同时拥有广告主与开发者账号（各一套唯一码），因此需要明确登录身份：
    //   · 请求带 type -> 按该角色登录
    //   · 不带 type 且命中多个角色 -> 返回 409 + 可选角色，让前端让用户选择（避免随机登错后台）
    const wantType = String((req.body && req.body.type) || '').trim();
    const codeKey = String(username || '').trim().toUpperCase();
    let a = null;
    if (wantType) {
      const [[x]] = await pool.query('SELECT * FROM accounts WHERE (username=? OR account_code=?) AND type=? LIMIT 1',
        [username, codeKey, wantType]);
      a = x || null;
    } else {
      const [rows] = await pool.query('SELECT * FROM accounts WHERE username=? OR account_code=?', [username, codeKey]);
      if (rows && rows.length > 1) {
        return res.status(409).json({
          error: '该账号存在多个角色，请选择登录身份',
          need_role: true,
          roles: rows.map(r => ({ type: r.type, name: ROLE_CN[r.type] || r.type, account_code: r.account_code })),
        });
      }
      a = (rows && rows[0]) || null;
    }
    if (!a || a.status !== 1 || !security.verifyPwd(password, a.pass_hash)) {
      security.logAudit(req, 'LOGIN_FAIL', String(username), '');
      // 明确告知剩余尝试次数：否则用户不知道快被锁，反复尝试反而把自己锁死
      const left = (g && typeof g.left === 'number') ? g.left : null;
      const tip = (left != null && left > 0)
        ? ('密码错误，还可尝试 ' + left + ' 次（超出将锁定 ' + Math.round(LOGIN_LOCK_MS / 60000) + ' 分钟）')
        : '用户名或密码错误';
      return res.status(401).json({ error: tip, tries_left: left });
    }
    loginReset(ip, username);
    // 旧 sha256 口令在登录成功时透明升级为 scrypt（仅触发一次，不阻断存量账号）
    if (a.pass_hash && !a.pass_hash.startsWith('scrypt$')) {
      pool.query('UPDATE accounts SET pass_hash=? WHERE id=?', [security.hashPwd(password), a.id]).catch(() => {});
    }
    // ⑧ 两步验证：密码正确后还需校验 TOTP 动态码（对标 AppLovin 2-Step Verification）。
    // 先发一个 5 分钟有效的 challenge，校验通过才签发真正的令牌——避免"知道密码就能直接拿到令牌"
    if (Number(a.twofa) === 1 && a.totp_secret) {
      const chal = '2fa_' + crypto.randomBytes(12).toString('hex');
      await cache.set('2fa:' + chal, String(a.username), 300).catch(() => {});
      return res.json({ need2fa: true, challenge: chal, hint: '请输入认证器 App 上的 6 位动态码' });
    }
    const token = security.issueToken({ username: a.username, type: a.type, scope: a.scope });
    // Fix-02：一并返回角色，供后台"账号与权限"页展示与前端按角色裁剪菜单
    const role = a.type === 'admin' ? security.roleOfAccount({ role: a.role, s: a.scope }) : '';
    res.json({ ok: true, token, type: a.type, scope: a.scope, role, role_name: role ? (security.ROLE_CN[role] || role) : '',
      username: a.username, display: a.display, account_code: a.account_code });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 当前登录账号信息
app.get('/api/account/me', security.requireAuth(), async (req, res) => {
  const role = req.account.t === 'admin' ? security.roleOfAccount(req.account) : '';
  res.json({ username: req.account.u, type: req.account.t, scope: req.account.s, role,
    role_name: role ? (security.ROLE_CN[role] || role) : '' });
});

// 当前登录账号自助改密（凭登录态即可改，无需管理员）。
// 此前全站没有任何"改密码"入口：管理员改不了、用户自己也改不了 → 忘记密码只能永久锁死。
app.post('/api/account/password', security.requireAuth(), async (req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  if (!newPassword || String(newPassword).length < 6) return res.status(400).json({ error: '新密码至少 6 位' });
  try {
    const [[a]] = await pool.query('SELECT pass_hash FROM accounts WHERE username=? AND type=?', [req.account.u, req.account.t]);
    if (!a || !security.verifyPwd(oldPassword, a.pass_hash)) return res.status(401).json({ error: '原密码不正确' });
    await pool.query('UPDATE accounts SET pass_hash=? WHERE username=? AND type=?', [security.hashPwd(newPassword), req.account.u, req.account.t]);
    await security.logAudit(req, 'account:change_password', String(req.account.u), '');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 管理员查看所有账号（租客清单）
app.get('/api/accounts', security.requireAuth('admin'), async (_, res) => {
  try { const [rows] = await pool.query('SELECT id,type,username,scope,display,status,created_by,created_at,account_code FROM accounts ORDER BY id DESC'); res.json(rows); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
// 账号维护（管理员）：改状态/显示名/作用域/角色。停用由 requireAuth 中间件即时生效
app.put('/api/accounts/:id', security.requireAuth('admin'), async (req, res) => {
  const id = +req.params.id; const b = req.body || {};
  try {
    const [[a]] = await pool.query('SELECT id,type,username FROM accounts WHERE id=?', [id]);
    if (!a) return res.status(404).json({ error: 'account not found' });
    const set = [], val = [];
    if (b.status != null) { set.push('status=?'); val.push(Number(b.status) ? 1 : 0); }
    if (b.display != null) { set.push('display=?'); val.push(String(b.display).trim()); }
    if (b.scope != null) { set.push('scope=?'); val.push(String(b.scope).trim()); }
    if (b.type != null) {
      const t = String(b.type);
      if (!['admin','advertiser','publisher'].includes(t)) return res.status(400).json({ error: 'type 必须是 admin/advertiser/publisher' });
      // 不允许改自己的角色（防把自己降权后无法再管理）
      if (a.username === req.account.u && a.type === req.account.t) return res.status(400).json({ error: '不能修改当前登录账号自己的角色（防自锁）' });
      set.push('type=?'); val.push(t);
      if (t === 'admin') set.push("scope='*'");
    }
    if (!set.length) return res.status(400).json({ error: '无可更新字段' });
    val.push(id);
    const [r] = await pool.query('UPDATE accounts SET ' + set.join(',') + ' WHERE id=?', val);
    if (!r.affectedRows) return res.status(404).json({ error: 'account not found' });
    await security.logAudit(req, 'account:update', 'account#' + id, JSON.stringify(b).slice(0, 200));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 管理员重置任意账号密码 —— 开发者忘记密码时由管理员在此设置新密码。
// 此前全站无任何密码重置能力，导致「忘记密码→找管理员→管理员也改不了」的死锁。
app.post('/api/accounts/:id/password', security.requireAuth('admin'), async (req, res) => {
  const id = +req.params.id; const password = String((req.body || {}).password || '');
  if (password.length < 6) return res.status(400).json({ error: '密码至少 6 位' });
  try {
    const [r] = await pool.query('UPDATE accounts SET pass_hash=? WHERE id=?', [security.hashPwd(password), id]);
    if (!r.affectedRows) return res.status(404).json({ error: 'account not found' });
    await security.logAudit(req, 'account:reset_password', 'account#' + id, '');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 管理员删除账号（此前只能停用，无法真正删除假/多余账号）
app.delete('/api/accounts/:id', security.requireAuth('admin'), async (req, res) => {
  const id = +req.params.id;
  try {
    const [[a]] = await pool.query('SELECT id,type,username FROM accounts WHERE id=?', [id]);
    if (!a) return res.status(404).json({ error: 'account not found' });
    if (a.username === req.account.u && a.type === req.account.t) return res.status(400).json({ error: '不能删除当前登录的账号' });
    if (a.type === 'admin') {
      const [[c]] = await pool.query("SELECT COUNT(*) n FROM accounts WHERE type='admin' AND status=1 AND id<>?", [id]);
      if (Number(c && c.n) === 0) return res.status(400).json({ error: '不能删除最后一个启用中的管理员' });
    }
    await pool.query('DELETE FROM accounts WHERE id=?', [id]);
    await security.logAudit(req, 'account:delete', 'account#' + id, a.username);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== 运营：审计日志查询 + CSV 导出（#11，管理员）=====
app.get('/api/admin/audit', security.requireAuth('admin'), async (req, res) => {
  try {
    const w = [], v = [];
    if (req.query.actor) { w.push('actor=?'); v.push(String(req.query.actor)); }
    if (req.query.action) { w.push('action LIKE ?'); v.push('%' + String(req.query.action) + '%'); }
    if (req.query.target) { w.push('target LIKE ?'); v.push('%' + String(req.query.target) + '%'); }
    const limit = Math.min(1000, Math.max(1, Number(req.query.limit) || 200));
    const [rows] = await pool.query('SELECT * FROM admin_audit ' + (w.length ? 'WHERE ' + w.join(' AND ') : '') + ' ORDER BY id DESC LIMIT ' + limit, v);
    if (String(req.query.format || '').toLowerCase() === 'csv') {
      const head = 'id,actor,action,target,detail,ip,created_at';
      const esc = (x) => '"' + String(x == null ? '' : x).replace(/"/g, '""') + '"';
      const csv = '﻿' + [head].concat(rows.map(r => [r.id, r.actor, r.action, r.target, r.detail, r.ip, r.created_at].map(esc).join(','))).join('\n');
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="admin_audit_${Date.now()}.csv"`);
      return res.send(csv);
    }
    res.json({ items: rows, total: rows.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== #12 邀请码 / 白名单：受控开通管理员 =====
// 现状问题：管理员只能由现有管理员创建 → 现实中易共用一个 root(admin/admin123)。本模块改为「邀请码」：
// 管理员生成一次性邀请码 → 被邀请人凭码自助开通独立管理员账号（各自强密码 + 各自可开 2FA），全程审计留痕。
// 注意：邀请码不替代根账号强口令——生产仍应由 ADMIN_PASS 注入随机强口令，禁用默认 admin123。
const genInviteCode = () => (crypto.randomBytes(9).toString('base64url').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12)) || ('INV' + Date.now().toString(36).toUpperCase());

// 可选角色清单（供后台"账号与权限"页下拉使用）
app.get('/api/admin/roles', security.requireAuth('admin'), (req, res) => {
  res.json({
    roles: Object.keys(security.ROLE_SCOPES).map((r) => ({ role: r, name: security.ROLE_CN[r] || r, scopes: security.roleScopes(r) })),
    invitable: security.INVITABLE_ROLES.slice(),
    default_invite_role: security.DEFAULT_INVITE_ROLE,
    note: 'admin_owner 为超级管理员，不可通过邀请码发放（防无限裂变）',
  });
});
// Fix-02：生成邀请码 = 高权限写操作，仅超级管理员(scope 含 admin:invite:write 或 *)可执行。
// 子管理员角色一律不含该 scope → 无法再生成邀请码，裂变链路在此断开。
app.post('/api/admin/invites', security.requireAuth('admin'), security.requireScope('admin:invite:write'), async (req, res) => {
  const b = req.body || {};
  const note = String(b.note || '').trim().slice(0, 120);
  const days = Math.min(90, Math.max(1, Number(b.expires_days) || 14));
  // 角色白名单校验：admin_owner 不可被发放（否则等价于复制超级管理员）
  const role = String(b.role || security.DEFAULT_INVITE_ROLE).trim();
  if (!security.INVITABLE_ROLES.includes(role)) {
    return res.status(400).json({ error: 'role 不合法或不可发放', allowed: security.INVITABLE_ROLES });
  }
  const code = genInviteCode();
  try {
    await pool.query('INSERT INTO admin_invites (code,created_by,note,role,expires_at) VALUES (?,?,?,?,DATE_ADD(NOW(),INTERVAL ? DAY))',
      [code, String((req.account && req.account.u) || 'admin'), note, role, days]);
    await security.logAudit(req, 'admin:invite_create', code, 'role=' + role + ' ' + note);
    res.json({ ok: true, code, role, scopes: security.roleScopes(role), expires_in_days: days, note });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/admin/invites', security.requireAuth('admin'), async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT code,created_by,note,role,expires_at,used_by,used_at,created_at FROM admin_invites ORDER BY created_at DESC LIMIT 200');
    res.json({ items: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// 凭邀请码自助开通管理员（公开端点，但必须持一次性有效邀请码）
// Fix-08：字段名同时接受 code / invite_code，username / email —— 文档与页面 hint 怎么写都能通
app.post('/api/account/register-admin', async (req, res) => {
  const b = req.body || {};
  const code = String(b.code || b.invite_code || '').trim().toUpperCase();
  const username = String(b.username || b.email || '').trim().toLowerCase();
  const password = String(b.password || '');
  if (!code || !username || !password) return res.status(400).json({ error: 'code(或 invite_code), username(或 email), password required' });
  if (password.length < 8) return res.status(400).json({ error: '为安全起见，管理员密码至少 8 位' });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(username)) return res.status(400).json({ error: 'username 需为邮箱（作为登录名）' });
  try {
    const [[inv]] = await pool.query('SELECT * FROM admin_invites WHERE code=? FOR UPDATE', [code]);
    if (!inv) return res.status(400).json({ error: '邀请码无效' });
    if (inv.used_by) return res.status(400).json({ error: '邀请码已被使用' });
    if (inv.expires_at && new Date(inv.expires_at).getTime() < Date.now()) return res.status(400).json({ error: '邀请码已过期' });
    const [[dup]] = await pool.query('SELECT id FROM accounts WHERE username=?', [username]);
    if (dup) return res.status(409).json({ error: '该登录名已被占用' });
    // Fix-02：scope 由邀请码携带的角色推导，永不为 '*'
    const role = security.isValidRole(inv.role) ? inv.role : security.DEFAULT_INVITE_ROLE;
    const scope = (role === 'admin_owner' ? security.DEFAULT_INVITE_ROLE : role);
    const scopes = security.roleScopes(scope);
    const accCode = genAccountCode('admin');
    await pool.query('INSERT INTO accounts (type,username,pass_hash,scope,role,display,account_code,created_by) VALUES (?,?,?,?,?,?,?,?)',
      ['admin', username, security.hashPwd(password), scopes.join(','), scope, String(b.display || '').trim() || username, accCode, 'invite:' + code]);
    await pool.query('UPDATE admin_invites SET used_by=?, used_at=NOW() WHERE code=?', [username, code]);
    await pool.query('INSERT INTO admin_audit (actor,action,target,detail,ip) VALUES (?,?,?,?,?)',
      [username, 'admin:invite_redeem', username, 'code=' + code + ' role=' + scope, String(req.ip || '')]);
    res.json({
      ok: true, username, account_code: accCode, role: scope, role_name: security.ROLE_CN[scope] || scope, scope: scopes.join(','),
      scopes,
      note: '管理员账号已开通（角色：' + (security.ROLE_CN[scope] || scope) + '）；请登录后立即开启两步验证(2FA)，并妥善保管本账号',
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== Fix-01 演示账号：服务端开通，前端按真实凭据渲染（杜绝"按钮写着 demo123 却登不上"）=====
// 背景：login.html 曾硬编码 demobrand/demomedia + demo123，而服务端早已删除演示账号 → 按钮点了必然 401，
// 走查报告把它列为"用户按页面引导操作会卡死"的头号问题。
// 现在：演示账号由服务端按开关显式开通并把口令对齐到 DEMO_PASSWORD；
// 前端改为从 /api/demo/accounts 拉真实凭据后再渲染按钮，开关关闭时按钮不出现 —— 页面上不会再有登不上的演示账号。
const DEMO_PASSWORD = process.env.DEMO_PASSWORD || 'demo123';
function demoAccountsEnabled() {
  if (process.env.DISABLE_DEMO_ACCOUNTS === '1' || process.env.ENABLE_DEMO_ACCOUNTS === '0') return false;
  // 生产默认关闭；演示环境（非生产）默认开启
  return !security.IS_PROD || process.env.ENABLE_DEMO_ACCOUNTS === '1';
}
const DEMO_DEFS = [
  { username: 'demobrand', type: 'advertiser', scope: 'DemoBrand', display: '演示广告主', label: '广告主演示账号' },
  { username: 'demomedia', type: 'publisher', scope: 'demo.dellai.xyz', display: '演示媒体', label: '媒体演示账号' },
];
// 幂等开通；已存在则把口令/作用域/启用状态强制对齐（演示账号专用，不影响任何真实账号）
async function ensureDemoAccounts() {
  if (!demoAccountsEnabled()) return [];
  const out = [];
  for (const d of DEMO_DEFS) {
    try {
      const [[row]] = await pool.query('SELECT id,account_code FROM accounts WHERE type=? AND username=?', [d.type, d.username]);
      if (row && row.id) {
        await pool.query('UPDATE accounts SET pass_hash=?, scope=?, display=?, status=1 WHERE id=?',
          [security.hashPwd(DEMO_PASSWORD), d.scope, d.display, row.id]);
        out.push(Object.assign({}, d, { account_code: row.account_code }));
      } else {
        const code = genAccountCode(d.type);
        await pool.query('INSERT INTO accounts (type,username,pass_hash,scope,display,account_code,created_by) VALUES (?,?,?,?,?,?,?)',
          [d.type, d.username, security.hashPwd(DEMO_PASSWORD), d.scope, d.display, code, 'demo-seed']);
        out.push(Object.assign({}, d, { account_code: code }));
      }
      // 演示账号必须"跑得通"：广告主要有余额账户（否则建完计划也参不了竞），
      // 媒体要有 publishers 记录（否则收益报表/集成自检报 invalid api_key or domain）。
      if (d.type === 'advertiser') {
        await pool.query('INSERT IGNORE INTO adv_balance (advertiser,balance_micros) VALUES (?,?)', [d.scope, 50000000]).catch(() => {});
      } else {
        const [[p]] = await pool.query('SELECT domain FROM publishers WHERE domain=?', [d.scope]).catch(() => [[]]);
        if (!p) {
          await pool.query('INSERT INTO publishers (domain,name,contact,payout_rate) VALUES (?,?,?,?)', [d.scope, d.display, 'demo@dellai.xyz', 0.70]).catch(() => {});
        }
      }
    } catch (e) { console.warn('[demo] 演示账号 ' + d.username + ' 开通失败：' + e.message); }
  }
  return out;
}
app.get('/api/demo/accounts', async (req, res) => {
  if (!demoAccountsEnabled()) {
    return res.json({ enabled: false, items: [], note: '演示账号未启用（生产默认关闭；需演示请设 ENABLE_DEMO_ACCOUNTS=1 与强 DEMO_PASSWORD）' });
  }
  try {
    const items = (await ensureDemoAccounts()).map((i) => ({
      username: i.username, password: DEMO_PASSWORD, type: i.type, label: i.label,
      account_code: i.account_code, scope: i.scope,
    }));
    // 超级管理员登录按钮只在「口令真的能对上」时才返回 —— 先拿候选口令去 verifyPwd 校验，
    // 校验不过就不出现在页面上（宁可不显示，也不给一个点了必然 401 的按钮）。
    const adminUser = process.env.ADMIN_USER || 'admin';
    const adminPwd = process.env.DEMO_ADMIN_PASSWORD || 'admin123';
    if (!security.IS_PROD) {
      const [[a]] = await pool.query("SELECT account_code,pass_hash FROM accounts WHERE type='admin' AND username=?", [adminUser]).catch(() => [[]]);
      if (a && a.pass_hash && security.verifyPwd(adminPwd, a.pass_hash)) {
        items.unshift({ username: adminUser, password: adminPwd, type: 'admin', label: '超级管理员演示账号', account_code: a.account_code, scope: '*' });
      }
    }
    res.json({ enabled: items.length > 0, items, note: '演示环境账号，仅供体验；生产环境自动关闭' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 广告主自助开户（公开，对标 AppLovin 自助投放平台）：注册独立账号 + 作用域
// 与媒体入驻同理——注册即开通独立账号，登录后仅看自己作用域
app.post('/api/signup/advertiser', async (req, res) => {
  const { username, password, advertiser, display, company, tax_id, app_category, target_cpm_cny, landing_url, goal } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'username,password required' });
  if (String(password).length < 6) return res.status(400).json({ error: 'password 至少 6 位' });
  const scope = (advertiser || username).toString().trim();
  if (!scope) return res.status(400).json({ error: 'advertiser(作用域) 必填' });
  try {
    // 查重按 (角色,登录账号)：同一邮箱可再注册开发者角色，互不冲突
    const [[dup]] = await pool.query("SELECT id,account_code,api_key FROM accounts WHERE username=? AND type='advertiser'", [username]);
    if (dup) {
      // 幂等：重复开户返回已有账号（不重置 account_code / api_key），避免"重注册即换新码、已嵌 SDK 失效"
      const token = security.issueToken({ username, type: 'advertiser', scope });
      return res.json({ ok: true, idempotent: true, username, scope, token,
        account: { username, account_code: dup.account_code },
        note: '该邮箱已注册广告主账号，返回已有账号（账号码不变）；忘记密码请联系运营重置' });
    }
    const advCode = genAccountCode('advertiser');
    await pool.query('INSERT INTO accounts (type,username,pass_hash,scope,display,created_by,api_key,account_code) VALUES (?,?,?,?,?,?,?,?)',
      ['advertiser', username, security.hashPwd(password), scope, display || scope, 'self-signup', newAdvKey(), advCode]);
    // ②⑥ 开户即建余额账户（初始 0 → 需充值后才参拍）与广告主 API key，避免"开户即可投但账户没钱"
    await pool.query('INSERT IGNORE INTO adv_balance (advertiser,balance_micros) VALUES (?,0)', [scope]).catch(() => {});
    // 开户资料（品类 / 目标CPM / 落地页）落库：建计划时自动回填，避免"开户填一遍、建计划再填一遍"
    await pool.query(`CREATE TABLE IF NOT EXISTS advertiser_profile (
      advertiser VARCHAR(128) PRIMARY KEY,
      company VARCHAR(128) DEFAULT '',
      tax_id VARCHAR(64) DEFAULT '',
      app_category VARCHAR(32) DEFAULT '',
      target_cpm_cny DECIMAL(10,2) DEFAULT 6,
      landing_url VARCHAR(256) DEFAULT '',
      updated_at BIGINT DEFAULT 0)`).catch(() => {});
    await pool.query("ALTER TABLE advertiser_profile ADD COLUMN company VARCHAR(128) DEFAULT ''").catch(() => {});
    await pool.query("ALTER TABLE advertiser_profile ADD COLUMN tax_id VARCHAR(64) DEFAULT ''").catch(() => {});
    // 开户目标（投放目标 install/purchase/retention/brand）+ 账户层合规基线（隐私政策 / DPA / 异常告警）
    await pool.query("ALTER TABLE advertiser_profile ADD COLUMN goal VARCHAR(32) DEFAULT ''").catch(() => {});
    await pool.query("ALTER TABLE advertiser_profile ADD COLUMN privacy_policy_url VARCHAR(512) DEFAULT ''").catch(() => {});
    await pool.query("ALTER TABLE advertiser_profile ADD COLUMN dpa_url VARCHAR(512) DEFAULT ''").catch(() => {});
    await pool.query("ALTER TABLE advertiser_profile ADD COLUMN alert_over_budget TINYINT DEFAULT 1").catch(() => {});
    await pool.query("ALTER TABLE advertiser_profile ADD COLUMN alert_anomaly TINYINT DEFAULT 1").catch(() => {});
    await pool.query("ALTER TABLE advertiser_profile ADD COLUMN alert_email VARCHAR(128) DEFAULT ''").catch(() => {});
    await pool.query("ALTER TABLE advertiser_profile ADD COLUMN terms_url VARCHAR(512) DEFAULT ''").catch(() => {});
    await pool.query("ALTER TABLE advertiser_profile ADD COLUMN coppa_mode TINYINT DEFAULT 0").catch(() => {});
    // SKAN 4.0 转化值建模（conversion value schema）：事件 → coarse/fine 值的映射，供 iOS 侧回填
    await pool.query("ALTER TABLE advertiser_profile ADD COLUMN skan_cv_schema TEXT").catch(() => {});
    await pool.query("ALTER TABLE advertiser_profile ADD COLUMN alert_email VARCHAR(128) DEFAULT ''").catch(() => {});
    await pool.query(`INSERT INTO advertiser_profile (advertiser,company,tax_id,app_category,target_cpm_cny,landing_url,goal,updated_at)
      VALUES (?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE company=VALUES(company), tax_id=VALUES(tax_id),
      app_category=VALUES(app_category), target_cpm_cny=VALUES(target_cpm_cny),
      landing_url=VALUES(landing_url), goal=VALUES(goal), updated_at=VALUES(updated_at)`,
      [scope, String(company || display || scope), String(tax_id || ''), String(app_category || ''), Number(target_cpm_cny) || 6, String(landing_url || ''), String(goal || ''), Date.now()]).catch(() => {});
    // ③ 开户即下发一套示例素材（降低冷启动门槛，对标 AppLovin「自动生成免费素材」）：
    //    默认 approved 可直接绑定参拍，广告主可在「素材库」替换或删除。
    const SAMPLES = [
      ['示例·横幅 Banner', 'banner', '<div style="padding:14px;background:#3b82f6;color:#fff;border-radius:8px;font-size:15px">示例横幅创意 · 点击立即体验</div>', 320, 50],
      ['示例·激励视频 Rewarded', 'rewarded', '<div style="padding:14px;background:#7c3aed;color:#fff;border-radius:8px;font-size:15px">示例激励视频创意 · 看完领奖励</div>', 320, 480],
      ['示例·原生 Native', 'native', '<div style="padding:14px;background:#0ea5e9;color:#fff;border-radius:8px;font-size:15px">示例原生创意 · 自然融入内容</div>', 320, 180],
    ];
    // 必须 await：原先 fire-and-forget 导致"开户后立刻查素材库"只能看到部分示例素材（竞态）
    await Promise.all(SAMPLES.map(function (s) {
      return pool.query("INSERT INTO creatives (advertiser,campaign_id,format,type,title,content,landing_url,width,height,creative_status) VALUES (?,0,?,?,?,?,?,?,?,'approved')",
        [scope, s[1], 'html', s[0], s[2], String(landing_url || ''), s[3], s[4]]).catch(() => {});
    }));
    const token = security.issueToken({ username, type: 'advertiser', scope });
    res.json({ ok: true, username, scope, token, account: { username, password, account_code: advCode }, note: '已开通广告主独立账号，可直接登录广告主后台（campaigns.html）' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 管理员用户名+密码登录统一走 /api/account/login（seed 的 admin 账号 type=admin，scope=*）；
// 旧式静态令牌 → cookie 由上方 /api/admin/login 处理（现已同时接受账号体系签发的作用域令牌）。
// 原有的第二个 /api/admin/login（username/password 分支）因被第一个同名路由完全遮蔽而不可达，已删除。
const PORT = process.env.PORT || 8080;

// 健康检查端点：浏览器/监控直接 GET 即可确认服务与隧道全链路通
app.get('/health', (_, res) => res.json({ ok: true, ts: Date.now() }));

// Prometheus 抓取端点（Grafana 接入）：多 worker 部署时请直连各 worker 端口（如 :8090/metrics），
// 经 LB(:8080/metrics) 仅反映单 worker 视图。复用 metrics.js 的 counter/hist/summary/gauges。
app.get('/metrics', (req, res) => {
  const m = metrics.snapshot();
  const L = [];
  const esc = (s) => String(s).replace(/[^a-zA-Z0-9_]/g, '_');
  for (const [k, v] of Object.entries(m.counters || {})) {
    const name = 'openrtb_' + esc(k);
    L.push(`# HELP ${name} 累计计数`); L.push(`# TYPE ${name} counter`); L.push(`${name} ${v}`);
  }
  for (const [k, v] of Object.entries(m.qps || {})) {
    const name = 'openrtb_' + esc(k);
    L.push(`# HELP ${name} 近10s QPS`); L.push(`# TYPE ${name} gauge`); L.push(`${name} ${v}`);
  }
  for (const [k, v] of Object.entries(m.hist || {})) {
    const name = 'openrtb_' + esc(k);
    L.push(`# HELP ${name} 延迟分布(ms)`); L.push(`# TYPE ${name} summary`);
    L.push(`${name}_count ${v.n}`); L.push(`${name}_sum ${+(v.avg * v.n).toFixed(3)}`);
    L.push(`${name}{quantile="0.5"} ${v.p50}`); L.push(`${name}{quantile="0.9"} ${v.p90}`);
    L.push(`${name}{quantile="0.95"} ${v.p95}`); L.push(`${name}{quantile="0.99"} ${v.p99}`);
  }
  for (const [k, v] of Object.entries(m.gauges || {})) {
    const name = 'openrtb_' + esc(k);
    L.push(`# HELP ${name} 瞬时值`); L.push(`# TYPE ${name} gauge`); L.push(`${name} ${v}`);
  }
  res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
  res.send(L.join('\n') + '\n');
});

// SDK 失败遥测：pub_sdk.js 用 new Image() beacon 上报（GET /sdk/error?slot=..&pub=..）。
// 后端此前根本没有这条路由 → 404 被 beacon 静默吞掉，SDK 失败率数据全丢且无人知晓。
app.get('/sdk/error', (req, res) => {
  try { console.error('[sdk-error]', 'slot=' + String(req.query.slot || ''), 'pub=' + String(req.query.pub || '')); } catch (e) {}
  res.setHeader('Content-Type', 'image/gif');
  res.end(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'));
});

// 反向代理：把 /ms/* 转发到媒体服务端(默认 8081)，便于只暴露 8080 一个端口上公网
// 公网演示时浏览器只连 ADX 域名，媒体结算请求经此代理转发，无需再暴露第二个端口。
const MEDIA_SERVER = process.env.MEDIA_SERVER || 'http://127.0.0.1:8081';
const httpFwd = require('http');
app.use('/ms', (req, res) => {
  const target = MEDIA_SERVER + req.url; // req.url 已去掉 /ms 前缀，如 /api/reward
  const payload = ['POST', 'PUT', 'PATCH'].includes(req.method) ? JSON.stringify(req.body || {}) : null;
  const r = httpFwd.request(target, {
    method: req.method,
    headers: Object.assign({}, req.headers, payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {})
  }, (resp) => {
    res.status(resp.statusCode);
    Object.keys(resp.headers).forEach(h => { if (h.toLowerCase() !== 'transfer-encoding') res.setHeader(h, resp.headers[h]); });
    resp.pipe(res);
  });
  r.on('error', (e) => res.status(502).json({ ok: false, error: 'media_server_unreachable', detail: String(e) }));
  if (payload) r.write(payload);
  r.end();
});

const pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'test',
  password: process.env.DB_PASSWORD || 'test@fftime',
  database: process.env.DB_NAME || 'zhuque',
  connectionLimit: 20,
  charset: 'utf8mb4'
});

// OIDC 单点登录路由（/api/auth/oidc/*）。未配置 OIDC_* 时相关端点返回 404，前端自动隐藏 SSO 按钮。
oidc.initOidc({ app, pool, cache, security, genAccountCode });

const AUCTION = { secondPrice: true }; // 二价拍卖：胜出者付次高价+0.01元

// ── Fix-06：eCPM' 评测库的「广告库存品类」目录 ──
// l1=能力（素材/形态/定向完备度）l2=效果（历史 pCTCVR 表现）l3=口碑（投诉率/拒付/品牌安全）
// 语义必须落在"广告库存"上：此前库里是电子签章/计件工资等外部 SaaS 商品，与本平台业务错位。
const AD_SKU_CATALOG = [
  { skuId: 'casual_game', name: '休闲游戏', l1: 0.82, l2: 0.72, l3: 0.65 },
  { skuId: 'puzzle_game', name: '益智游戏', l1: 0.85, l2: 0.74, l3: 0.68 },
  { skuId: 'hybrid_game', name: '混合变现游戏', l1: 0.91, l2: 0.82, l3: 0.74 },
  { skuId: 'game', name: '游戏（综合）', l1: 0.88, l2: 0.78, l3: 0.70 },
  { skuId: 'ecommerce', name: '电商', l1: 0.78, l2: 0.68, l3: 0.60 },
  { skuId: 'finance', name: '金融', l1: 0.72, l2: 0.55, l3: 0.48 },
  { skuId: 'social', name: '社交', l1: 0.80, l2: 0.70, l3: 0.62 },
  { skuId: 'tools', name: '工具', l1: 0.65, l2: 0.55, l3: 0.50 },
  { skuId: 'education', name: '教育', l1: 0.75, l2: 0.62, l3: 0.55 },
];
// 历史遗留的非广告品类（外部 SaaS 商品目录）：启动时清理，避免 /api/ecpm/evals 再返回错位语义
const LEGACY_NON_AD_SKUS = ['esign', 'jijian', 'kx-learning', 'yxt-course', 'survey', 'cert', 'live-brand',
  'paiban', 'xinchou', 'att-brand', 'feikong', 'fapiao', 'yecai', 'exp-brand',
  'xunyuan', 'hetong', 'shouhuo', 'pur-brand', 'ats', 'beidiao', 'offer', 'hr-brand',
  'crm', 'lv2', 'archive2', 'con-brand',
  // test_ecpm_learning.js 播种的遗留包（同为外部 SaaS 商品目录）
  'tax-month', 'logistics', 'legal', 'archive', 'brand', 'perform', 'supplier'];
// 广告品类目录（供前端/文档对齐枚举；与 docs 里"计划与媒体必须精确等同匹配"的品类口径一致）
app.get('/api/ecpm/catalog', (_, res) => res.json({
  items: AD_SKU_CATALOG.map((s) => Object.assign({}, s, { evalScore: ecpm.composeEvalScore({ l1: s.l1, l2: s.l2, l3: s.l3 }) })),
  note: '广告库存品类目录；/api/ecpm/evals 返回库内实际评测记录（含行为回流样本）',
}));

// 管理员操作审计管道：鉴权中间件落库（含被拒绝的未授权访问）
security.attachAudit(async (req, action, target, detail) => {
  await pool.query('INSERT INTO admin_audit (actor,action,target,detail,ip) VALUES (?,?,?,?,?)',
    [String(req.admin || 'anonymous').slice(0, 64), String(action).slice(0, 64), String(target).slice(0, 255), String(detail).slice(0, 255), String(req.ip || '').slice(0, 64)]).catch(() => {});
});
// 账号停用即时生效：令牌在有效期内签名依然有效，必须由中间件查库确认账号状态，
// 否则后台「停用」只是改了个数字、账号照样能访问（前端假权限）。
security.attachAccountLookup(async (username, type) => {
  const [rows] = await pool.query('SELECT status FROM accounts WHERE username=? AND type=?', [String(username), String(type)]).catch(() => [[]]);
  return (rows && rows[0]) || null;
});

// 需求方(DSP)注册表：可经 /ssp/demand 动态添加外部 DSP
// ≥3 个真实接入的需求方（入站买方 / 来买我们媒体流量）：自有 zhuque-dsp + 巨量引擎(抖音) + 通用 OpenRTB 需求方。
// 三者均为真实适配器实现（sim 模式离线可跑、real 模式走官方开放平台 OAuth 买量），
// 竞价引擎（二价/eCPM'/意图匹配/deadline）原样保留，供演示多需求方拍卖。
// 角色说明：快手/巨量是「买量（帮客户在外部平台投放）」的投放中台能力，经 /api/demand/{kuaishou,oceanengine}/* 演示，
//           不作为本平台入站 DSP 买方参与拍卖（避免与「我们=卖方/广告交易平台」的定位混淆）。
let DEMAND_PARTNERS = [
  { name: 'zhuque-dsp', type: 'local', bid: scoreOwnDemand, payoutRate: 0.70, isOwn: true },
];
// Fix-04：外部需求方参拍此前被绑在 ENABLE_DEMO_ACCOUNTS 上（且生产恒不开），
// 结果实际参拍永远只有自有 zhuque-dsp 一家，首页"4 家同场"当场验证不了。
// 改为独立开关 ENABLE_EXTERNAL_DSP：非生产默认开（这四个适配器是本地 sim 实现，不发外网请求、不拖 p99），
// 生产需显式置 1；置 0 可随时关闭。实际参拍方以 GET /api/dsp/active 为准，首页按它渲染文案。
const EXTERNAL_DSP_ON = process.env.ENABLE_EXTERNAL_DSP === '1' || (!security.IS_PROD && process.env.ENABLE_EXTERNAL_DSP !== '0');
if (EXTERNAL_DSP_ON) {
  DEMAND_PARTNERS.push(
    { name: 'oceanengine-dsp', type: 'oceanengine', payoutRate: 0.60, isOwn: false },
    { name: 'generic-dsp', type: 'generic', payoutRate: 0.58, isOwn: false },
    { name: 'mintegral-dsp', type: 'mintegral', payoutRate: 0.55, isOwn: false },
    { name: 'adcolony-dsp', type: 'adcolony', payoutRate: 0.56, isOwn: false }
  );
}
// 外部 HTTP 需求方熔断：name -> {fails, until}。连续失败达阈值进入冷却，暂不调用。
// 死链/慢 partner 若每次竞价都 fetch，socket 与定时器会持续堆积（且超时留到很后面才释放），
// 并发下迅速吃满事件循环、把 p99 拖到秒级 —— 实测几个失效测试 partner 就能把 /ssp/bid 打到 2s。
const partnerBreaker = new Map();

// SSP 持久账本已改为从 bid_win_log 实时聚合（见 /api/console/overview），不再用内存对象当真相源。
// 仅保留 pubFloor（媒体方近期清盘价 EMA，热路径动态底价用，重启后由 DB 重建）。
const pubFloor = new Map(); // publisher -> 近期清盘价 EMA（P1 动态底价）
function recordSsp(gross, payout, publisher) {
  const prev = pubFloor.get(publisher); pubFloor.set(publisher, prev ? prev * 0.8 + gross * 0.2 : gross);
}

// ── SSP 侧日志批量落库 ──
// 竞价热路径不该为「记日志」付一次 MySQL 往返：原先 bid_req_log / bid_win_log 每请求一次 INSERT，
// 把 /ssp/bid 吞吐钉在百级 QPS。改为内存缓冲 + 定时/满批单条多值 INSERT（RTB 标准异步批量日志）。
// 归因/点击/转化均为独立 HTTP 回调（人为延迟 ≫ 200ms 批量窗口），故无竞态。
const LOG_BATCH_MAX = 300, LOG_FLUSH_MS = 200;
const _logBuf = { req: [], win: [] };
let _logTimer = null;
function enqueueLog(kind, row) {
  const buf = _logBuf[kind];
  buf.push(row);
  if (buf.length >= LOG_BATCH_MAX) { flushLog(kind); return; }
  if (!_logTimer) _logTimer = setTimeout(() => { _logTimer = null; flushLog('req'); flushLog('win'); }, LOG_FLUSH_MS);
}
function flushLog(kind) {
  const buf = _logBuf[kind];
  if (!buf.length) return;
  const rows = buf.splice(0, buf.length);
  const t = kind === 'req' ? 'bid_req_log' : 'bid_win_log';
  const ph = kind === 'req' ? '(?,?,?)' : '(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)';
  const sql = 'INSERT INTO ' + t + ' ' +
    (kind === 'req' ? '(req_id,publisher,ad_unit_id)'
                    : '(campaign_id,creative_id,imp_id,req_id,price_micros,publisher,consent,feat,ad_unit_id,device_type,country,ad_format,os,device_model,device_id)') +
    ' VALUES ' + rows.map(() => ph).join(',');
  pool.query(sql, [].concat.apply([], rows)).catch(() => {});
}

// ===== 反作弊：内存限流 + 回传校验工具 =====
const rlMap = new Map(); // ip -> [timestamp,...]
function rateHit(ip, limit = 60, win = 1000) {
  const t = Date.now(); const a = (rlMap.get(ip) || []).filter(x => t - x < win); a.push(t); rlMap.set(ip, a);
  return a.length > limit; // 单 IP 1 秒内超 60 次请求即限流
}
// 通用限流（按任意 key：publisher / imp / 账号），支撑全 API 限流与用户级限流
function rateHitKey(key, limit = 60, win = 1000) {
  const t = Date.now(); const a = (rlMap.get(key) || []).filter(x => t - x < win); a.push(t); rlMap.set(key, a);
  return a.length > limit;
}
// 数据脱敏：留资联系方式在响应中掩码，避免 PII 明文外泄（存储仍原文，便于回访）
function maskContact(c) {
  if (!c) return c; const s = String(c).trim();
  if (s.indexOf('@') >= 0) { const p = s.split('@'); return (p[0].slice(0, 2) + '***@' + (p[1] || '')); }
  if (/^1\d{10}$/.test(s)) return s.slice(0, 3) + '****' + s.slice(7);
  if (s.length > 4) return s.slice(0, 2) + '***' + s.slice(-2);
  return s;
}

// ===== 激励视频：服务端完播校验（一次性签名令牌）=====
// 前端 SDK 无法自证"完播"，必须由服务端签发令牌并校验后才发放奖励，否则可被伪造刷量。
// 生产环境密钥必须通过环境变量注入，切勿硬编码。
const RW_SECRET = security.RW_SECRET;
const RW_TTL_MS = 5 * 60 * 1000;   // 令牌有效期 5 分钟
const RW_MIN_RATIO = 0.95;         // 完播阈值：观看时长占比 ≥95%
const RW_MAX_RATIO = 1.5;          // 观看时长不可能超过视频时长的 1.5 倍（防伪造时长）

// ===== 设备指纹层：S2S 仍挡不住"多设备构造真实播放"，故在结算侧加设备级风控 =====
// 设备指纹由 SDK/客户端计算并随竞价与结算一并上报；服务端做两件事：
//   1) 令牌与 device_fp 绑定：跨设备重放同一令牌直接拒绝（比单纯 impid 单次更抗农场化）
//   2) 设备级速率/异常检测：同一指纹在窗口内领奖超阈值，判为 DEVICE_FP_RATE_LIMIT（设备农场嫌疑）
const FP_MAX = 30;                 // 单设备 10 分钟内最多结算次数
const FP_WIN_MS = 10 * 60 * 1000;
const fpGrants = new Map();        // device_fp -> [timestamp,...]
function fpRisk(fp) {
  if (!fp) return { ok: true, count: 0 };
  const t = Date.now();
  const a = (fpGrants.get(fp) || []).filter(x => t - x < FP_WIN_MS);
  a.push(t); fpGrants.set(fp, a);
  if (a.length > FP_MAX) return { ok: false, reason: 'DEVICE_FP_RATE_LIMIT', count: a.length };
  return { ok: true, count: a.length };
}

// ===== OMID / 可见性测量：VAST 4.0 标配 AdVerifications，反作弊加分项 =====
// 真实 OMID 由播放器加载 Verification 中的 JavaScriptResource（omsdk）做可见性度量；
// 这里给出本地演示用的 shim（public/omid-session.js），做几何可见性并回传 /vast/omid。
const OMID_JS = process.env.OMID_JS || 'http://127.0.0.1:8080/omid-session.js';

// ===== 多广告形态：插屏 / 开屏 / 原生 / icon / push =====
// ⑦ 补齐移动端常用容器：mrec(300×250 暂停/中插) 与 app_open(开屏，App 冷启动首屏)
const AD_FORMATS = ['banner', 'mrec', 'rewarded', 'interstitial', 'splash', 'app_open', 'native', 'icon', 'push', 'float', 'interactive', 'view'];

// 合成创意的统一字体栈（避免各形态字体不一致、像不同人做的）
const AD_FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif";
// 兜底图标：此前是"蓝底白字 AD"的方块，看起来像故障占位。改为渐变 + 圆角 + 品牌色，
// 至少在"广告主还没上传素材"时不至于把演示页弄丑。
const ICON_SVG = 'data:image/svg+xml;utf8,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120" viewBox="0 0 120 120">' +
  '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">' +
  '<stop offset="0" stop-color="#1e3a8a"/><stop offset="1" stop-color="#0ea5e9"/></linearGradient></defs>' +
  '<rect width="120" height="120" rx="28" fill="url(#g)"/>' +
  '<circle cx="92" cy="26" r="26" fill="rgba(255,255,255,.14)"/>' +
  '<text x="60" y="76" font-size="34" font-weight="700" text-anchor="middle" fill="#fff" ' +
  'font-family="sans-serif">AppLink</text></svg>');

function buildNative(o) {
  return {
    title: o.title || '原生广告标题',
    body: o.body || '原生广告描述，样式完全由 App 自行渲染',
    icon: ICON_SVG, image: ICON_SVG, cta: '立即下载',
    clickUrl: `${PUBLIC_BASE}/ssp/click?cid=${o.cid}&imp=${o.impid}&pub=${encodeURIComponent(o.publisher || '')}`,
    impTrackers: [`${PUBLIC_BASE}/vast/track?impid=${o.impid}&cid=${o.cid}&event=impression`],
    ad_format: 'native'
  };
}
function buildPush(o) {
  return {
    title: o.title || '推送广告标题',
    body: o.body || '推送广告正文，由媒体推送系统下发（不经 SDK 渲染）',
    icon: ICON_SVG,
    clickUrl: `${PUBLIC_BASE}/ssp/click?cid=${o.cid}&imp=${o.impid}&pub=${encodeURIComponent(o.publisher || '')}`,
    impUrl: `${PUBLIC_BASE}/vast/track?impid=${o.impid}&cid=${o.cid}&event=impression`,
    ad_format: 'push'
  };
}
function buildInterstitialHtml(o) {
  return `<div style="position:fixed;left:0;top:0;right:0;bottom:0;background:rgba(3,8,20,.78);display:flex;align-items:center;justify-content:center;z-index:99999;font-family:${AD_FONT}">
  <div style="width:320px;max-width:92vw;border-radius:20px;overflow:hidden;position:relative;color:#fff;
     background:linear-gradient(150deg,#1e3a8a 0%,#0b1020 55%,#0ea5e9 160%);box-shadow:0 24px 60px rgba(0,0,0,.5)">
    <button onclick="this.closest('div').parentNode.remove()" style="position:absolute;right:10px;top:10px;border:0;background:rgba(255,255,255,.18);color:#fff;border-radius:50%;width:28px;height:28px;cursor:pointer;line-height:1">×</button>
    <div style="padding:22px 20px 18px">
      <span style="display:inline-block;background:linear-gradient(92deg,#f59e0b,#ef4444);color:#fff;font-size:11px;font-weight:800;padding:4px 10px;border-radius:999px">限时优惠</span>
      <div style="display:flex;align-items:center;gap:12px;margin-top:14px">
        <img src="${ICON_SVG}" style="width:56px;height:56px;border-radius:14px;flex:none" alt="ad">
        <div style="min-width:0">
          <div style="font-size:18px;font-weight:800;line-height:1.25">${o.title || '插屏广告'}</div>
          <div style="font-size:12px;opacity:.72;margin-top:3px">${o.body || '全屏展示，可随时关闭'}</div>
        </div>
      </div>
      <div style="font-size:11.5px;opacity:.7;margin-top:12px"><span style="color:#fbbf24">★★★★★</span> 4.9 · 高质量广告主</div>
      <a href="${PUBLIC_BASE}/ssp/click?cid=${o.cid}&imp=${o.impid}" target="_blank" style="display:block;margin-top:14px;background:linear-gradient(92deg,#22d3ee,#a7f3d0);color:#04122a;text-align:center;padding:11px;border-radius:14px;text-decoration:none;font-size:14.5px;font-weight:800">立即了解 →</a>
      <div style="margin-top:9px;font-size:10.5px;opacity:.5;text-align:center">广告 · AppLink ADX</div>
    </div>
  </div>
</div>`;
}
function buildSplashHtml(o) {
  return `<div onclick="this.remove()" style="position:fixed;left:0;top:0;right:0;bottom:0;color:#fff;font-family:${AD_FONT};z-index:99999;cursor:pointer;
     background:linear-gradient(165deg,#0b1020 0%,#1e3a8a 55%,#0ea5e9 100%)">
  <div style="position:absolute;right:16px;top:16px;background:rgba(255,255,255,.18);border:1px solid rgba(255,255,255,.25);border-radius:999px;padding:6px 13px;font-size:12px;backdrop-filter:blur(6px)">跳过</div>
  <div style="height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px">
    <img src="${ICON_SVG}" style="width:88px;height:88px;border-radius:22px;box-shadow:0 14px 34px rgba(0,0,0,.4)" alt="icon">
    <div style="font-size:20px;font-weight:800;letter-spacing:-.01em">${o.title || '开屏广告'}</div>
    <div style="font-size:12.5px;opacity:.72">${o.body || '由 AppLink ADX 下发'}</div>
  </div>
  <div style="position:absolute;bottom:16px;left:0;right:0;text-align:center;font-size:10.5px;opacity:.5">广告 · AppLink ADX</div>
</div>`;
}
function buildIconHtml(o) {
  return `<a href="${PUBLIC_BASE}/ssp/click?cid=${o.cid}&imp=${o.impid}" target="_blank" style="display:inline-block;width:120px;text-align:center;text-decoration:none;color:#e8eefc;font-family:${AD_FONT}">
  <img src="${ICON_SVG}" style="width:96px;height:96px;border-radius:22px;display:block;margin:0 auto;box-shadow:0 10px 24px rgba(37,99,235,.35)" alt="icon">
  <div style="font-size:12.5px;font-weight:700;margin-top:6px">${o.title || 'icon 广告'}</div>
  <div style="font-size:10px;color:#64748b;margin-top:2px">广告 · 下载</div>
</a>`;
}
// 浮标广告：右下角悬浮小窗，可关闭
function buildFloatHtml(o) {
  return `<div style="position:fixed;right:16px;bottom:16px;width:220px;z-index:9998;font-family:'Microsoft YaHei',sans-serif">
  <div style="position:relative;background:linear-gradient(135deg,#2563eb,#7c3aed);border-radius:14px;padding:12px 14px;box-shadow:0 6px 20px rgba(37,99,235,.4);color:#fff">
    <button onclick="this.closest('[style*=position]').remove()" style="position:absolute;right:8px;top:8px;border:0;background:rgba(255,255,255,.25);width:22px;height:22px;border-radius:50%;color:#fff;font-size:14px;line-height:22px;cursor:pointer;padding:0">×</button>
    <div style="display:flex;align-items:center;gap:10px">
      <img src="${ICON_SVG}" style="width:44px;height:44px;border-radius:8px;object-fit:cover;background:#fff" alt="float">
      <div style="flex:1;min-width:0">
        <div style="font-size:13px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${o.title || '浮标广告'}</div>
        <div style="font-size:11px;opacity:.85;margin-top:2px">${o.body || '限时活动'}</div>
      </div>
    </div>
    <a href="${PUBLIC_BASE}/ssp/click?cid=${o.cid}&imp=${o.impid}" target="_blank" style="display:block;text-align:center;margin-top:10px;background:#fff;color:#2563eb;font-size:12px;font-weight:700;padding:6px 0;border-radius:6px;text-decoration:none">立即体验</a>
  </div>
</div>`;
}
// 互动广告：富媒体（示例：转盘抽奖）
function buildInteractiveHtml(o) {
  return `<div style="width:320px;background:#fff;border-radius:12px;overflow:hidden;font-family:'Microsoft YaHei',sans-serif;box-shadow:0 4px 14px rgba(0,0,0,.1)">
  <div style="background:linear-gradient(90deg,#f59e0b,#ef4444);padding:8px 12px;color:#fff;font-size:13px;font-weight:700;display:flex;justify-content:space-between;align-items:center">
    <span>🎁 ${o.title || '互动赢好礼'}</span>
    <span style="font-size:10px;opacity:.85">${o.body || '点击参与'}</span>
  </div>
  <div style="padding:14px">
    <div id="ia-wheel" style="width:180px;height:180px;margin:0 auto;background:conic-gradient(#fde68a 0 45deg,#fca5a5 45deg 90deg,#93c5fd 90deg 135deg,#86efac 135deg 180deg,#fde68a 180deg 225deg,#fca5a5 225deg 270deg,#93c5fd 270deg 315deg,#86efac 315deg 360deg);border-radius:50%;display:flex;align-items:center;justify-content:center;cursor:pointer;transition:transform .8s ease-out">
      <div style="width:60px;height:60px;background:#fff;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:24px;box-shadow:0 2px 6px rgba(0,0,0,.2)">🎯</div>
    </div>
    <div style="text-align:center;margin-top:12px">
      <button onclick="document.getElementById('ia-wheel').style.transform='rotate('+(Math.random()*720+360)+'deg)'" style="background:#ef4444;color:#fff;border:0;padding:8px 18px;border-radius:20px;font-size:13px;font-weight:700;cursor:pointer">🎰 立即抽奖</button>
    </div>
    <a href="${PUBLIC_BASE}/ssp/click?cid=${o.cid}&imp=${o.impid}" target="_blank" style="display:block;text-align:center;margin-top:10px;font-size:12px;color:#666;text-decoration:none">查看奖品 → ${o.title || '了解详情'}</a>
  </div>
</div>`;
}
// 应用内 View 广告（Android 原生 AdView / In-app Inlay）：
//   媒体侧 SDK 传 Activity 类名 + 像素坐标(x,y,w,h)，平台返回 HTML，SDK 里 WebView 按坐标
//   addView 到 Activity 的视图树对应位置（非全屏、非右下固定，位置由像素坐标决定）。
//   与 banner/float 区别：位置完全由请求侧像素坐标决定（不是流式插屏/浮标），支持任意容器 Activity。
function buildViewHtml(o) {
  const x = Math.max(0, Number(o.x) || 40);
  const y = Math.max(0, Number(o.y) || 120);
  const w = Math.max(120, Number(o.w) || 300);
  const h = Math.max(60, Number(o.h) || 140);
  const act = String(o.activity || 'com.example.MainActivity');
  return `<div style="position:relative;width:${w}px;height:${h}px;font-family:'Microsoft YaHei',sans-serif;outline:1px dashed #3b82f6;outline-offset:-1px" data-activity="${act}" data-coord="x=${x},y=${y},w=${w},h=${h}">
  <div style="position:absolute;left:-1px;top:-1px;background:rgba(59,130,246,.15);color:#1e40af;font-size:10px;padding:1px 6px;border-radius:2px;font-family:monospace;pointer-events:none;z-index:2">View(${act.split('.').pop()}) @${x},${y} ${w}×${h}</div>
  <div style="width:100%;height:100%;background:linear-gradient(135deg,#0ea5e9,#6366f1);color:#fff;border-radius:8px;overflow:hidden;display:flex;align-items:center;padding:10px;gap:10px;position:relative;box-shadow:0 4px 12px rgba(99,102,241,.3)">
    ${o.mediaUrl ? `<img src="${o.mediaUrl}" style="width:56px;height:56px;border-radius:8px;object-fit:cover;background:#fff;flex:none" alt="view">` : `<div style="width:56px;height:56px;border-radius:8px;background:rgba(255,255,255,.25);display:flex;align-items:center;justify-content:center;font-size:26px;flex:none">🖼</div>`}
    <div style="flex:1;min-width:0">
      <div style="font-size:14px;font-weight:700;line-height:1.3;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical">${o.title || '应用内 View 广告'}</div>
      <div style="font-size:11px;opacity:.9;margin-top:3px;line-height:1.3">${o.body || '由 SDK addView 插入 Activity 视图树'}</div>
      <a href="${PUBLIC_BASE}/ssp/click?cid=${o.cid}&imp=${o.impid}" target="_blank" style="display:inline-block;margin-top:6px;background:#fff;color:#4f46e5;font-size:11px;font-weight:700;padding:4px 10px;border-radius:12px;text-decoration:none">了解详情 →</a>
    </div>
    <button onclick="this.closest('[data-activity]').remove()" style="position:absolute;right:6px;top:6px;border:0;background:rgba(255,255,255,.3);color:#fff;width:20px;height:20px;border-radius:50%;cursor:pointer;font-size:12px;line-height:16px;padding:0">×</button>
  </div>
</div>`;
}
// 应用内 View：把「广告主自己的 HTML 创意」套进坐标容器里。
// 此前 view 形态被强制走合成模板（server 里 `fmt !== 'view'`），广告主上传的设计稿永远不生效 → 演示里只能看到占位图。
// 现在：有真实 HTML 创意就用真实创意，只在外层补 SDK addView 需要的 activity + 像素坐标容器。
function wrapViewAd(inner, o) {
  const x = Math.max(0, Number(o.x) || 40);
  const y = Math.max(0, Number(o.y) || 120);
  const w = Math.max(120, Number(o.w) || 300);
  const h = Math.max(60, Number(o.h) || 140);
  const act = String(o.activity || 'com.example.MainActivity');
  return '<div style="position:relative;width:' + w + 'px;height:' + h + 'px;' +
    "font-family:'Microsoft YaHei',sans-serif;outline:1px dashed #3b82f6;outline-offset:-1px\"" +
    ' data-activity="' + act + '" data-coord="x=' + x + ',y=' + y + ',w=' + w + ',h=' + h + '">' +
    '<div style="position:absolute;left:-1px;top:-1px;background:rgba(59,130,246,.15);color:#1e40af;font-size:10px;' +
    'padding:1px 6px;border-radius:2px;font-family:monospace;pointer-events:none;z-index:3">View(' +
    act.split('.').pop() + ') @' + x + ',' + y + ' ' + w + '×' + h + '</div>' +
    '<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center">' + inner + '</div>' +
    '</div>';
}
function safeJson(s) { if (s == null) return {}; if (typeof s !== 'string') return s; try { return JSON.parse(s); } catch (e) { return {}; } }
// 投放时段：把表单简单选项转成 pacing 的 168 位 daypart 掩码（7天×24小时）
function scheduleToMask(s) {
  s = String(s || '').toLowerCase();
  if (!s || s.includes('all') || s.includes('全天')) return pacing.defaultMask();
  let days = [0, 1, 2, 3, 4, 5, 6];
  if (s.includes('工作日') || s.includes('weekday')) days = [1, 2, 3, 4, 5];
  else if (s.includes('周末') || s.includes('weekend')) days = [0, 6];
  let h0 = 0, h1 = 23;
  const m = s.match(/(\d{1,2})\s*-\s*(\d{1,2})/);
  if (m) { h0 = +m[1]; h1 = +m[2]; }
  return pacing.daypartNormalize({ days, hours: Array.from({ length: Math.max(0, h1 - h0 + 1) }, (_, i) => h0 + i) });
}
// 从前端 {days: [1-7], hours: [0-23]} 数组直接生成 168 位 mask（对齐 AppLovin Dayparting）
// days 约定：1=周一 … 7=周日（ISO），内部 0=周一 … 6=周日
function daypartMaskFromDaysHours(days, hours) {
  const d = Array.isArray(days) ? days.map(Number).filter(x => x >= 1 && x <= 7).map(x => x - 1) : [];
  const h = Array.isArray(hours) ? hours.map(Number).filter(x => x >= 0 && x <= 23) : [];
  // 空数组 = 全选（等价于全天全周）
  const useDays = d.length ? d : [0, 1, 2, 3, 4, 5, 6];
  const useHours = h.length ? h : Array.from({ length: 24 }, (_, i) => i);
  return pacing.daypartNormalize({ days: useDays, hours: useHours });
}
// 素材库选取：按 campaign + 形态返回已上传创意（管理后台上传，优于合成占位）
async function pickCreative(campaignId, format, ctx, pinnedId) {
  if (!campaignId) return null;
  const f = String(format || 'banner').toLowerCase();
  try {
    // ① 优先按请求格式匹配（format=f 或 format='any'），保证 banner/interstitial/float/interactive 等形态各取所用
    const [rows] = await pool.query(
      "SELECT id,title,type,content,media_url,landing_url,width,height,format FROM creatives WHERE campaign_id=? AND creative_status='approved' AND (format=? OR format='any') ORDER BY (format = ?) DESC",
      [campaignId, f, f]);
    if (rows.length) {
      // P1 创意 A/B：按轮播选择（多版本均匀轮播），归因到具体创意用于效果对比
      const n = rows.length;
      const idxKey = `ab:${campaignId}:${f}`;
      const cur = (await cache.get(idxKey)) || 0;
      const pick = rows[cur % n];
      cache.set(idxKey, (cur + 1) % n, 0).catch(() => {});
      const pub = (ctx && ctx.publisher) || '';
      const kw = (ctx && ctx.keyword) || '';
      const sub = (s) => String(s || '').replace(/\$\{PUBLISHER\}/g, pub).replace(/\$\{KEYWORD\}/g, kw).replace(/\$\{CID\}/g, campaignId);
      return {
        id: pick.id, title: sub(pick.title), type: pick.type, format: pick.format, content: sub(pick.content),
        mediaUrl: pick.media_url, landingUrl: sub(pick.landing_url), width: pick.width, height: pick.height, abTotal: n
      };
    }
    // ② format 无匹配 → fallback 到 pinned creative（campaign.creative_id）
    if (pinnedId) {
      const [[pin]] = await pool.query(
        "SELECT id,title,type,content,media_url,landing_url,width,height,format FROM creatives WHERE id=? AND campaign_id=? AND creative_status='approved'",
        [pinnedId, campaignId]);
      if (pin) {
        const pub = (ctx && ctx.publisher) || '';
        const kw = (ctx && ctx.keyword) || '';
        const sub = (s) => String(s || '').replace(/\$\{PUBLISHER\}/g, pub).replace(/\$\{KEYWORD\}/g, kw).replace(/\$\{CID\}/g, campaignId);
        return { id: pin.id, title: sub(pin.title), type: pin.type, format: pin.format, content: sub(pin.content), mediaUrl: pin.media_url, landingUrl: sub(pin.landing_url), width: pin.width, height: pin.height, abTotal: 1 };
      }
    }
    return null;
  } catch (e) { return null; }
}

/** 按 imp.ext.ad_type 生成对应形态创意；返回 null 表示沿用 campaign 自带 creative_html */
function buildFormatAd(format, o) {
  switch (String(format || 'banner').toLowerCase()) {
    case 'rewarded':     return { adm: buildVast(o), admType: 'vast4' };
    case 'interstitial': return { adm: buildInterstitialHtml(o), admType: 'html' };
    case 'splash':       return { adm: buildSplashHtml(o), admType: 'html' };
    case 'icon':         return { adm: buildIconHtml(o), admType: 'html' };
    case 'native':       return { adm: JSON.stringify(buildNative(o)), admType: 'native_json' };
    case 'push':         return { adm: '', admType: 'push', push: buildPush(o) };
    case 'float':        return { adm: buildFloatHtml(o), admType: 'html' };
    case 'interactive':  return { adm: buildInteractiveHtml(o), admType: 'html' };
    case 'view':         return { adm: buildViewHtml(o), admType: 'view_html' };
    default:             return null;
  }
}

// 创意与请求形态是否匹配：native 必须 native 类创意、push 必须 push 类，否则回落到按形态合成
// （避免 'any'/html 创意被当成原生/推送，导致前端 JSON.parse 失败或拿不到 push 载荷）
function creativeFits(cr, fmt) {
  if (!cr) return false;
  if (cr.type === 'vast') return true;
  if (cr.format === 'any') return false; // 'any' 是兜底占位，优先按形态合成（带点击/落地），避免裸占位 div 点了无反应
  // native：原生类(type=native) 或 显式 format=native 的 HTML 创意都算匹配（后者由媒体侧按 HTML 渲染，已兼容）
  if (fmt === 'native') return cr.type === 'native' || cr.format === 'native';
  if (fmt === 'push') return cr.type === 'push';
  return cr.type === 'html';
}

// ===== S2S 服务端回调：客户端不可信，媒体服务端签名回调才是结算权威 =====
// 生产请设 S2S_ENFORCE=1：届时客户端 /ssp/reward 只登记为「待确认」，不计入结算。
const S2S_ENFORCE = process.env.S2S_ENFORCE === '1';
const S2S_TTL_MS = 5 * 60 * 1000;
function s2sSign(secret, impid, cid, watchedMs, durationMs, ts) {
  return crypto.createHmac('sha256', String(secret))
    .update(`${impid}|${cid || 0}|${watchedMs}|${durationMs}|${ts}`).digest('hex');
}

// ===== VAST 4.0 返回（行业标准：广告内容为 XML 而非 HTML）=====
const PUBLIC_BASE = process.env.PUBLIC_BASE || 'https://dellai.xyz';
const RW_MEDIA = process.env.RW_MEDIA || 'https://media.w3.org/2010/05/sintel/trailer.mp4';
const RW_DURATION = '00:00:52';

/** 生成 VAST 4.0 InLine XML：含 Impression/TrackingEvents(start~complete)/MediaFiles */
function buildVast(o) {
  const q = (ev) => `${PUBLIC_BASE}/vast/track?impid=${encodeURIComponent(o.impid)}&cid=${o.cid}&event=${ev}`;
  const T = [[ 'start', 'start' ], [ 'firstQuartile', 'firstQuartile' ], [ 'midpoint', 'midpoint' ], [ 'thirdQuartile', 'thirdQuartile' ], [ 'complete', 'complete' ]]
    .map(([ ev, name ]) => `<Tracking event="${name}"><![CDATA[${q(ev)}]]></Tracking>`).join('\n              ');
  return `<?xml version="1.0" encoding="UTF-8"?>
<VAST xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" version="4.0">
  <Ad id="${o.cid}">
    <InLine>
      <AdSystem version="1.0">applink</AdSystem>
      <AdTitle><![CDATA[${o.title}]]></AdTitle>
      <Impression id="zhuque-imp"><![CDATA[${q('impression')}]]></Impression>
      <AdVerifications>
        <Verification vendor="zhuque-omid">
          <JavaScriptResource apiFramework="omid" browserOptional="true"><![CDATA[${OMID_JS}]]></JavaScriptResource>
          <Tracking event="verificationNotExecuted"><![CDATA[${q('omid_not_executed')}]]></Tracking>
        </Verification>
      </AdVerifications>
      <Creatives>
        <Creative id="${o.cid}" sequence="1" adId="${o.cid}">
          <UniversalAdId idRegistry="Ad-ID">AppLink-${o.cid}</UniversalAdId>
          <Linear>
            <Duration>${o.duration || RW_DURATION}</Duration>
            <TrackingEvents>
              ${T}
            </TrackingEvents>
            <MediaFiles>
              <MediaFile id="1" delivery="progressive" type="video/mp4" bitrate="800" width="1280" height="720" scalable="true" maintainAspectRatio="true">
                <![CDATA[${o.mediaUrl || RW_MEDIA}]]>
              </MediaFile>
            </MediaFiles>
          </Linear>
        </Creative>
      </Creatives>
    </InLine>
  </Ad>
</VAST>`;
}

function rwSign(raw) { return crypto.createHmac('sha256', RW_SECRET).update(raw).digest('hex'); }
function rwPayload(impid, cid, pub, ts) { return `${impid}|${cid || 0}|${pub}|${ts}`; }
function rwIssue(impid, cid, pub, fp) {
  const ts = Date.now();
  return { impid: String(impid), cid: Number(cid) || 0, pub: String(pub), fp: String(fp || ''), ts, token: rwSign(rwPayload(impid, cid, pub, ts)) };
}
function rwVerify(rw, impid, cid, pub) {
  if (!rw || !rw.token) return { ok: false, why: 'MISSING_TOKEN' };
  if (String(rw.impid) !== String(impid)) return { ok: false, why: 'TOKEN_IMPID_MISMATCH' };
  if (String(rw.cid || 0) !== String(cid || 0)) return { ok: false, why: 'TOKEN_CID_MISMATCH' };
  if (String(rw.pub) !== String(pub)) return { ok: false, why: 'TOKEN_PUB_MISMATCH' };
  if (!rw.ts || Date.now() - Number(rw.ts) > RW_TTL_MS) return { ok: false, why: 'TOKEN_EXPIRED' };
  if (rwSign(rwPayload(rw.impid, rw.cid, rw.pub, rw.ts)) !== rw.token) return { ok: false, why: 'BAD_SIGNATURE' };
  return { ok: true };
}

async function init() {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS bid_win_log (
      id BIGINT AUTO_INCREMENT PRIMARY KEY, campaign_id INT, creative_id INT,
      imp_id VARCHAR(64), price_micros BIGINT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
    // 激励视频令牌表：issued 记录签发，used 防重放（同一 impid 只能兑换一次奖励）
    // device_fp：令牌与设备指纹绑定，跨设备重放直接拒绝（S2S 仍挡不住"多设备构造真实播放"，靠指纹层兜底）
    await pool.query(`CREATE TABLE IF NOT EXISTS rw_token (
      id INT AUTO_INCREMENT PRIMARY KEY, imp_id VARCHAR(64) NOT NULL UNIQUE, campaign_id INT,
      publisher VARCHAR(128), used TINYINT DEFAULT 0, device_fp VARCHAR(64) DEFAULT '',
      issued_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, used_at TIMESTAMP NULL)`);
    // 激励视频完播审计日志：既记录发放成功，也记录每一次被拒绝的原因（反作弊可追溯）
    await pool.query(`CREATE TABLE IF NOT EXISTS reward_log (
      id BIGINT AUTO_INCREMENT PRIMARY KEY, imp_id VARCHAR(64), campaign_id INT, publisher VARCHAR(128),
      watched_ms INT DEFAULT 0, duration_ms INT DEFAULT 0, ratio DECIMAL(6,3) DEFAULT 0,
      status VARCHAR(32), remote VARCHAR(64), device_fp VARCHAR(64) DEFAULT '',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
    // VAST 视频事件流水：impression/start/quartile/complete（行业标准可见性与进度度量）
    await pool.query(`CREATE TABLE IF NOT EXISTS vast_event (
      id BIGINT AUTO_INCREMENT PRIMARY KEY, imp_id VARCHAR(64), campaign_id INT, event VARCHAR(32),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
    // OMID / 可见性测量事件流水：viewable / not_viewable / omid_session_start（反作弊加分项）
    await pool.query(`CREATE TABLE IF NOT EXISTS omid_event (
      id BIGINT AUTO_INCREMENT PRIMARY KEY, imp_id VARCHAR(64), campaign_id INT, event VARCHAR(32),
      viewable TINYINT DEFAULT 0, duration_ms INT DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
    // 媒体服务端密钥：S2S 回调签名用（客户端不可信，服务端回调才是结算权威）
    await pool.query("ALTER TABLE publishers ADD COLUMN api_key VARCHAR(64) DEFAULT ''").catch(() => {});
    // 兼容已存在表：补齐设备指纹列（设备绑定 + 设备级风控用）
    await pool.query("ALTER TABLE rw_token ADD COLUMN device_fp VARCHAR(64) DEFAULT ''").catch(() => {});
    await pool.query("ALTER TABLE reward_log ADD COLUMN device_fp VARCHAR(64) DEFAULT ''").catch(() => {});
    await pool.query(`CREATE TABLE IF NOT EXISTS adv_campaign (
      id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(128), advertiser VARCHAR(128),
      budget_micros BIGINT, status TINYINT DEFAULT 1, country VARCHAR(8) DEFAULT '',
      app_category VARCHAR(32) DEFAULT '', creative_html TEXT, landing_url VARCHAR(256),
      target_cpm_micros BIGINT DEFAULT 5000000, intent_tags VARCHAR(128) DEFAULT '', intent_profile TEXT)`);
    await pool.query('ALTER TABLE adv_campaign ADD COLUMN intent_profile TEXT').catch(() => {}); // 兼容已存在表
    await pool.query('ALTER TABLE adv_campaign ADD COLUMN review_status VARCHAR(16) DEFAULT \'approved\'').catch(() => {}); // 素材审核状态: pending/approved/rejected
    // —— 对齐 AppLovin 的 Campaign 层必备字段（"跑真客户"缺一不可）——
    await pool.query("ALTER TABLE adv_campaign ADD COLUMN app_id VARCHAR(128) DEFAULT ''").catch(() => {});              // App ID / Bundle ID
    await pool.query("ALTER TABLE adv_campaign ADD COLUMN conversion_event VARCHAR(32) DEFAULT 'install'").catch(() => {}); // install/purchase/roe/retention
    await pool.query("ALTER TABLE adv_campaign ADD COLUMN attribution_partner VARCHAR(32) DEFAULT ''").catch(() => {});  // adjust/appsflyer/skan/none
    await pool.query("ALTER TABLE adv_campaign ADD COLUMN attribution_key VARCHAR(128) DEFAULT ''").catch(() => {});
    await pool.query("ALTER TABLE adv_campaign ADD COLUMN start_date BIGINT DEFAULT 0").catch(() => {});                 // 起止日期（epoch ms）
    await pool.query("ALTER TABLE adv_campaign ADD COLUMN end_date BIGINT DEFAULT 0").catch(() => {});
    await pool.query("ALTER TABLE adv_campaign ADD COLUMN bid_strategy VARCHAR(16) DEFAULT 'CPM'").catch(() => {});      // CPM/CPA/oCPI/ROAS 统一出价策略
    await pool.query("ALTER TABLE adv_campaign ADD COLUMN bid_value DECIMAL(14,4) DEFAULT 0").catch(() => {});           // 该策略下的目标值
    await pool.query("ALTER TABLE adv_campaign ADD COLUMN exclude_audience VARCHAR(32) DEFAULT 'none'").catch(() => {}); // none/installed/converted/both
    await pool.query(`CREATE TABLE IF NOT EXISTS conv_log (
      id BIGINT AUTO_INCREMENT PRIMARY KEY, type ENUM('click','conversion') NOT NULL,
      campaign_id INT, publisher VARCHAR(128), imp_id VARCHAR(64),
      amount DECIMAL(10,2) DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
    await pool.query('ALTER TABLE conv_log ADD COLUMN amount DECIMAL(10,2) DEFAULT 0').catch(() => {}); // 兼容已存在表：成交金额(元)
    // 通用落地页留资（开发者链路闭环 · 全站落地页通用）：与 ruankao_lead 解耦，按 project 区分来源
    await pool.query(`CREATE TABLE IF NOT EXISTS leads (
      id BIGINT AUTO_INCREMENT PRIMARY KEY, project VARCHAR(32) DEFAULT 'direct',
      contact VARCHAR(128), imp_id VARCHAR(64), campaign_id INT DEFAULT 0,
      publisher VARCHAR(128) DEFAULT '', amount DECIMAL(10,2) DEFAULT 0,
      ip VARCHAR(64) DEFAULT '', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`).catch(() => {});
    await pool.query(`CREATE TABLE IF NOT EXISTS publishers (
      domain VARCHAR(128) PRIMARY KEY, name VARCHAR(128), contact VARCHAR(128),
      payout_rate DECIMAL(4,2) DEFAULT 0.70, status TINYINT DEFAULT 1, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
    // 供给爬虫回填字段（合规：仅抓媒体方自己声明的 site_url）
    await pool.query('ALTER TABLE publishers ADD COLUMN site_url VARCHAR(256)').catch(() => {});
    await pool.query('ALTER TABLE publishers ADD COLUMN cat VARCHAR(32)').catch(() => {});
    await pool.query('ALTER TABLE publishers ADD COLUMN geo VARCHAR(8)').catch(() => {});
    await pool.query('ALTER TABLE publishers ADD COLUMN keywords VARCHAR(128)').catch(() => {});
    await pool.query('ALTER TABLE publishers ADD COLUMN last_crawl BIGINT').catch(() => {});
    // 应用商店链接（对标 AppLovin MAX 注册首屏收 store link）：宽进严管，入驻时即可填，可后置
    await pool.query('ALTER TABLE publishers ADD COLUMN store_url VARCHAR(256)').catch(() => {});
    // eCPM' 三层评测库（§3.3）+ 归因样本统计（§2.6 冷启动燃料）
    // 素材库：广告主/计划上传的多形态创意（banner/rewarded/interstitial/splash/native/icon/push）
    await pool.query(`CREATE TABLE IF NOT EXISTS creatives (
      id INT AUTO_INCREMENT PRIMARY KEY, advertiser VARCHAR(128) DEFAULT '', campaign_id INT DEFAULT 0,
      format VARCHAR(16) DEFAULT 'banner', type VARCHAR(16) DEFAULT 'html',
      title VARCHAR(128) DEFAULT '', content TEXT, media_url VARCHAR(256) DEFAULT '',
      landing_url VARCHAR(256) DEFAULT '', width INT DEFAULT 0, height INT DEFAULT 0,
      status VARCHAR(16) DEFAULT 'active', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
    // 素材审核：与计划审核对齐（pending → approved/rejected）。
    // 此前素材只有 status(active/paused)，被驳回时无任何原因字段 → 广告主看不到"为什么被拒"。
    // 默认 'approved' 保证历史素材不受影响；只有 rejected 的素材不参与投放。
    await pool.query("ALTER TABLE creatives ADD COLUMN review_status VARCHAR(16) DEFAULT 'approved'").catch(() => {});
    await pool.query("ALTER TABLE creatives ADD COLUMN review_note VARCHAR(255) DEFAULT ''").catch(() => {});
    // —— 素材规范校验（对齐 AppLovin 素材规格）——
    await pool.query("ALTER TABLE creatives ADD COLUMN file_size INT DEFAULT 0").catch(() => {});          // 文件大小（bytes，按 format 校验上限）
    await pool.query("ALTER TABLE creatives ADD COLUMN vast_version VARCHAR(8) DEFAULT ''").catch(() => {}); // VAST 3.0/4.0
    await pool.query("ALTER TABLE creatives ADD COLUMN omid TINYINT DEFAULT 0").catch(() => {});          // OMID 可见性测量支持
    await pool.query("ALTER TABLE creatives ADD COLUMN duration_sec INT DEFAULT 0").catch(() => {});      // 视频时长（秒）
    await pool.query("ALTER TABLE creatives ADD COLUMN landing_type VARCHAR(16) DEFAULT 'h5'").catch(() => {}); // h5/appstore/ul/dl
    await pool.query("ALTER TABLE creatives ADD COLUMN deep_link VARCHAR(512) DEFAULT ''").catch(() => {});
    await pool.query("ALTER TABLE creatives ADD COLUMN app_id VARCHAR(128) DEFAULT ''").catch(() => {});
    await pool.query("ALTER TABLE creatives ADD COLUMN skan_source_id VARCHAR(32) DEFAULT ''").catch(() => {}); // SKAN Source ID
    await pool.query("ALTER TABLE creatives ADD COLUMN creative_status VARCHAR(16) DEFAULT 'draft'").catch(() => {});
    // 状态机收敛回填：新增列默认 'draft'，需按旧字段还原历史素材的真实状态
    await pool.query(`UPDATE creatives SET creative_status = CASE
      WHEN review_status='rejected' THEN 'rejected'
      WHEN status='paused' THEN 'paused'
      WHEN (review_status='approved' OR review_status IS NULL) AND (status='active' OR status IS NULL OR status='') THEN 'approved'
      ELSE 'pending' END
      WHERE creative_status IS NULL OR creative_status='' OR creative_status='draft'`).catch(() => {});
    // 三套状态已收敛到 creative_status 单一真源：历史数据回填完成后，下线冗余列 status / review_status。
    // 必须放在回填之后执行（先迁移数据 → 再删列），避免老库数据丢失。
    await pool.query("ALTER TABLE creatives DROP COLUMN status").catch(() => {});
    await pool.query("ALTER TABLE creatives DROP COLUMN review_status").catch(() => {}); // draft/pending/approved/rejected/paused/expired
    // 账户层合规基线（隐私政策 / DPA / 异常告警）；老库在此补齐
    await pool.query("ALTER TABLE advertiser_profile ADD COLUMN goal VARCHAR(32) DEFAULT ''").catch(() => {});
    await pool.query("ALTER TABLE advertiser_profile ADD COLUMN privacy_policy_url VARCHAR(512) DEFAULT ''").catch(() => {});
    await pool.query("ALTER TABLE advertiser_profile ADD COLUMN dpa_url VARCHAR(512) DEFAULT ''").catch(() => {});
    await pool.query("ALTER TABLE advertiser_profile ADD COLUMN alert_over_budget TINYINT DEFAULT 1").catch(() => {});
    await pool.query("ALTER TABLE advertiser_profile ADD COLUMN alert_anomaly TINYINT DEFAULT 1").catch(() => {});
    await pool.query("ALTER TABLE advertiser_profile ADD COLUMN alert_email VARCHAR(128) DEFAULT ''").catch(() => {});
    await pool.query("ALTER TABLE advertiser_profile ADD COLUMN terms_url VARCHAR(512) DEFAULT ''").catch(() => {});
    await pool.query("ALTER TABLE advertiser_profile ADD COLUMN coppa_mode TINYINT DEFAULT 0").catch(() => {});
    // SKAN 4.0 转化值建模（conversion value schema）：事件 → coarse/fine 值的映射，供 iOS 侧回填
    await pool.query("ALTER TABLE advertiser_profile ADD COLUMN skan_cv_schema TEXT").catch(() => {});
    await pool.query("ALTER TABLE advertiser_profile ADD COLUMN alert_email VARCHAR(128) DEFAULT ''").catch(() => {});
    // 外部 DSP 合作方（持久化；重启后自动加载进拍卖，实现"真实需求方连接"）
    await pool.query(`CREATE TABLE IF NOT EXISTS dsp_partners (
      id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(64) UNIQUE, url VARCHAR(256) DEFAULT '',
      payout_rate DECIMAL(4,2) DEFAULT 0.6, type VARCHAR(16) DEFAULT 'http',
      is_own TINYINT DEFAULT 0, status TINYINT DEFAULT 1, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
    // 胜出记录补齐 publisher 维度（结算/报表按媒体方归因，重启后仍可追溯）
    await pool.query("ALTER TABLE bid_win_log ADD COLUMN publisher VARCHAR(128) DEFAULT ''").catch(() => {});
    // 广告单元(Ad Unit)：对标 AppLovin MAX「先建 Ad Unit 拿 ID → 再埋进页面」。
    // 媒体在后台把广告位登记成实体，SDK 用 data-ad-unit 上报，报表才能按广告单元拆收益。
    await pool.query(`CREATE TABLE IF NOT EXISTS ad_units (
      id INT AUTO_INCREMENT PRIMARY KEY,
      ad_unit_id VARCHAR(32) NOT NULL UNIQUE,
      publisher VARCHAR(128) NOT NULL DEFAULT '',
      name VARCHAR(128) DEFAULT '',
      format VARCHAR(16) DEFAULT 'banner',
      floor_cny DECIMAL(10,2) DEFAULT 1.00,
      status TINYINT DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX(publisher))`);
    await pool.query("ALTER TABLE bid_win_log ADD COLUMN ad_unit_id VARCHAR(32) DEFAULT ''").catch(() => {});
    // 受众信号【自动采集】：OS / 机型由服务端解析 UA 得到，完全不需要用户填写、不打扰用户体验。
    // 用途是喂模型与分维度看数（不是让广告主手工勾选细分 → 那会把长尾库存切碎、反而填不满）。
    await pool.query("ALTER TABLE bid_win_log ADD COLUMN os VARCHAR(32) DEFAULT ''").catch(() => {});
    await pool.query("ALTER TABLE bid_win_log ADD COLUMN device_model VARCHAR(64) DEFAULT ''").catch(() => {});
    // 广告主定向：设备类型（''=不限；1=移动/平板；2=桌面；可逗号多选，如 '1,2'）
    await pool.query("ALTER TABLE adv_campaign ADD COLUMN device_type VARCHAR(16) DEFAULT ''").catch(() => {});
    // 广告主定向补齐（对标 AppLovin Audience Targeting）：OS 细分 + 出价底价。默认空/0 = 不限，不增加填写负担。
    await pool.query("ALTER TABLE adv_campaign ADD COLUMN os VARCHAR(16) DEFAULT ''").catch(() => {});
    await pool.query("ALTER TABLE adv_campaign ADD COLUMN bid_floor_micros BIGINT DEFAULT 0").catch(() => {});
    // 再营销：retarget=1 时只对「近 retarget_window_days 天见过本广告主广告」的设备参竞
    await pool.query("ALTER TABLE adv_campaign ADD COLUMN retarget TINYINT DEFAULT 0").catch(() => {});
    await pool.query("ALTER TABLE adv_campaign ADD COLUMN retarget_window_days INT DEFAULT 7").catch(() => {});
    // 受众分群扩展：兴趣定向（匹配自动采集的 app 类目/关键词）+ Lookalike 相似人群（种子画像）
    await pool.query("ALTER TABLE adv_campaign ADD COLUMN interest_target VARCHAR(128) DEFAULT ''").catch(() => {});
    await pool.query("ALTER TABLE adv_campaign ADD COLUMN lookalike TINYINT DEFAULT 0").catch(() => {});
    // 【数据飞轮原料】曝光维度的持久化：此前 bid_win_log 只有 campaign/creative/publisher/ad_unit/时间，
    // 缺 device_type / country / ad_format → 广告主无法按「设备/地域/形态」拆分效果（无法优化），
    // 且竞价时 LR/ML 算了这些特征却没落库（模型拿不到训练原料）。补上后：
    // 分维度看数、ROI 分析、频次分析、离线训练共用同一份事实表。
    await pool.query("ALTER TABLE bid_win_log ADD COLUMN device_type VARCHAR(16) DEFAULT ''").catch(() => {});
    await pool.query("ALTER TABLE bid_win_log ADD COLUMN country VARCHAR(8) DEFAULT ''").catch(() => {});
    await pool.query("ALTER TABLE bid_win_log ADD COLUMN ad_format VARCHAR(16) DEFAULT ''").catch(() => {});
    await pool.query('ALTER TABLE bid_win_log ADD INDEX idx_camp_time (campaign_id, created_at)').catch(() => {});
    await pool.query('ALTER TABLE bid_win_log ADD COLUMN feat TEXT').catch(() => {});            // 在线模型特征向量(回流训练用)
    await pool.query('ALTER TABLE bid_win_log ADD COLUMN model_trained TINYINT DEFAULT 0').catch(() => {}); // 是否已用于模型训练
    await pool.query('ALTER TABLE bid_win_log ADD COLUMN consent VARCHAR(64) DEFAULT \'\'').catch(() => {}); // 隐私同意(GDPR/CCPA)透传
    // 真频次(reach/frequency)：device_id 用 identity_graph 的 canonical_id（加盐哈希设备标识，无原始 PII），
    // 使 bid_win_log 可按「唯一设备」聚合出 reach（去重设备数）与 frequency（人均曝光），支撑跨 worker 持久化频次分析。
    await pool.query('ALTER TABLE bid_win_log ADD COLUMN device_id VARCHAR(80) DEFAULT \'\'').catch(() => {});
    await pool.query('ALTER TABLE bid_win_log ADD INDEX idx_device (device_id, campaign_id)').catch(() => {});
    await pool.query('ALTER TABLE adv_campaign ADD COLUMN intent_embed TEXT').catch(() => {}); // 意图 embedding 向量(异步缓存化相关性)
    await pool.query('ALTER TABLE adv_campaign ADD COLUMN daily_cap_micros BIGINT DEFAULT 0').catch(() => {}); // 日预算上限(0=不限)，用于 pacing
    // 出价目标：CPM(曝光) / CPA(转化成本) / ROAS(投入产出比)——多目标预估需要知道广告主按什么付费
    await pool.query("ALTER TABLE adv_campaign ADD COLUMN goal_type VARCHAR(8) DEFAULT 'CPM'").catch(() => {});
    await pool.query('ALTER TABLE adv_campaign ADD COLUMN target_cpa_micros BIGINT DEFAULT 0').catch(() => {});
    await pool.query('ALTER TABLE adv_campaign ADD COLUMN target_roas DECIMAL(8,3) DEFAULT 1').catch(() => {});
    await pool.query('ALTER TABLE adv_campaign ADD COLUMN creative_id INT DEFAULT 0').catch(() => {}); // 计划锁定的素材库创意（强关联出价/下发）
    await pool.query('ALTER TABLE adv_campaign ADD COLUMN geo_country VARCHAR(8) DEFAULT \'\'').catch(() => {}); // 定向国家（空=不限）
    await pool.query(`CREATE TABLE IF NOT EXISTS daily_spend (
      campaign_id INT, d DATE, micros BIGINT DEFAULT 0, PRIMARY KEY(campaign_id,d))`).catch(() => {});
    await pool.query(`CREATE TABLE IF NOT EXISTS adv_ledger (
      id BIGINT AUTO_INCREMENT PRIMARY KEY, campaign_id INT, imp_id VARCHAR(64),
      req_id VARCHAR(64) DEFAULT '', charge_micros BIGINT DEFAULT 0, insufficient TINYINT DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, UNIQUE KEY uk_imp_req (imp_id, req_id))`).catch(() => {});
    // 幂等键升级为 (imp_id, req_id)：否则不同请求复用同一 slot 名时，第二次扣费会被唯一键吞掉 → 再度账实不符
    await pool.query('ALTER TABLE adv_ledger ADD COLUMN req_id VARCHAR(64) DEFAULT \'\'').catch(() => {});
    await pool.query('ALTER TABLE adv_ledger DROP INDEX uk_imp').catch(() => {});
    await pool.query('ALTER TABLE adv_ledger ADD UNIQUE KEY uk_imp_req (imp_id, req_id)').catch(() => {});
    // Fix-03：账本行"是否计入对账"。历史孤儿扣费（有扣费、无对应胜出记录）经 /reconciliation/repair
    // 标记为 billable=0 后不再污染对账差异 —— 但流水本身保留，账务仍可追溯，不做物理删除。
    await pool.query('ALTER TABLE adv_ledger ADD COLUMN billable TINYINT DEFAULT 1').catch(() => {});
    // 创意 A/B 统计（Thompson Sampling 的后验计数：曝光/点击/转化）
    await pool.query('ALTER TABLE creatives ADD COLUMN impressions INT DEFAULT 0').catch(() => {});
    await pool.query('ALTER TABLE creatives ADD COLUMN clicks INT DEFAULT 0').catch(() => {});
    await pool.query('ALTER TABLE creatives ADD COLUMN conversions INT DEFAULT 0').catch(() => {});
    // 创意累计花费：素材自动轮换时按"预算/曝光公平分配"在多个创意间均摊，需要逐创意花费做闭环
    await pool.query('ALTER TABLE creatives ADD COLUMN spend_micros BIGINT DEFAULT 0').catch(() => {});
    // ===== 素材审核规则引擎（Point 3：关键词/敏感词/落地域名/图片hash + 人工兜底）=====
    await pool.query(`CREATE TABLE IF NOT EXISTS creative_review_rules (
      id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(128) DEFAULT '',
      type VARCHAR(24) DEFAULT 'keyword', pattern TEXT,
      action VARCHAR(16) DEFAULT 'auto_reject', severity VARCHAR(8) DEFAULT 'block',
      enabled TINYINT DEFAULT 1, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`).catch(() => {});
    await pool.query(`CREATE TABLE IF NOT EXISTS review_audit_log (
      id BIGINT AUTO_INCREMENT PRIMARY KEY, target_type VARCHAR(16) DEFAULT 'creative',
      target_id INT DEFAULT 0, action VARCHAR(24) DEFAULT '', actor VARCHAR(64) DEFAULT '',
      note TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, INDEX(target_type,target_id))`).catch(() => {});
    await pool.query("ALTER TABLE creatives ADD COLUMN review_flagged TINYINT DEFAULT 0").catch(() => {});
    await pool.query("ALTER TABLE creatives ADD COLUMN review_matched TEXT").catch(() => {});
    await pool.query("ALTER TABLE creatives ADD COLUMN media_hash VARCHAR(64) DEFAULT ''").catch(() => {});
    // ===== 每日对账自动出账（Point 6）：运行记录 =====
    await pool.query(`CREATE TABLE IF NOT EXISTS reconciliation_runs (
      id BIGINT AUTO_INCREMENT PRIMARY KEY, run_date DATE, rows INT DEFAULT 0,
      total_served_micros BIGINT DEFAULT 0, total_charged_micros BIGINT DEFAULT 0,
      total_diff_micros BIGINT DEFAULT 0, csv_path VARCHAR(256) DEFAULT '',
      emailed TINYINT DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`).catch(() => {});
    // ===== 合同/协议电子签模板（Point 7）=====
    await pool.query(`CREATE TABLE IF NOT EXISTS contract_templates (
      id INT AUTO_INCREMENT PRIMARY KEY, type VARCHAR(24) DEFAULT 'advertiser_service',
      title VARCHAR(128) DEFAULT '', content TEXT, variables JSON, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`).catch(() => {});
    await pool.query(`CREATE TABLE IF NOT EXISTS contracts (
      id INT AUTO_INCREMENT PRIMARY KEY, scope VARCHAR(24) DEFAULT '', scope_id VARCHAR(128) DEFAULT '',
      type VARCHAR(24) DEFAULT '', template_id INT DEFAULT 0, title VARCHAR(128) DEFAULT '',
      rendered TEXT, status VARCHAR(16) DEFAULT 'draft', signer_name VARCHAR(128) DEFAULT '',
      signer_email VARCHAR(128) DEFAULT '', signature VARCHAR(128) DEFAULT '', signed_at TIMESTAMP NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, INDEX(scope,scope_id))`).catch(() => {});
    // ===== 运营工单（Point 8）=====
    await pool.query(`CREATE TABLE IF NOT EXISTS tickets (
      id INT AUTO_INCREMENT PRIMARY KEY, scope VARCHAR(24) DEFAULT '', scope_id VARCHAR(128) DEFAULT '',
      category VARCHAR(32) DEFAULT 'other', priority VARCHAR(8) DEFAULT 'normal',
      subject VARCHAR(256) DEFAULT '', body TEXT, status VARCHAR(16) DEFAULT 'open',
      assignee VARCHAR(64) DEFAULT '', created_by VARCHAR(64) DEFAULT '', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, INDEX(scope,scope_id), INDEX(status))`).catch(() => {});
    await pool.query(`CREATE TABLE IF NOT EXISTS ticket_replies (
      id BIGINT AUTO_INCREMENT PRIMARY KEY, ticket_id INT DEFAULT 0, sender VARCHAR(64) DEFAULT '',
      message TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, INDEX(ticket_id))`).catch(() => {});
    // 广告主自助配置（账户页落库：低余额阈值 / 自动充值 / 支付卡 / 通知偏好），避免此前写在 localStorage 丢失
    await pool.query(`CREATE TABLE IF NOT EXISTS advertiser_settings (
      advertiser VARCHAR(128) PRIMARY KEY,
      low_balance_threshold_cny INT DEFAULT 100,
      auto_recharge TINYINT DEFAULT 0,
      payment_provider VARCHAR(32) DEFAULT '',
      payment_methods JSON,
      notification_prefs JSON,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )`).catch(() => {});
    // 归因窗口配置表（点击/浏览分窗，与 SKAN 对齐）：启动时确保列存在，避免首次归因事件前的竞态
    await ensureAttribCfgTable().catch(() => {});
    // 创意累计花费：素材自动轮换时按"预算/曝光公平分配"在多个创意间均摊，需要逐创意花费做闭环
    await pool.query('ALTER TABLE creatives ADD COLUMN spend_micros BIGINT DEFAULT 0').catch(() => {});

    // ===== 商业化就绪补齐（对标 AppLovin / Mintegral）=====
    // ① 填充率/胜率：分子是胜出(bid_win_log)，分母必须是「请求数」与「各需求方出价次数」
    await pool.query(`CREATE TABLE IF NOT EXISTS bid_req_log (
      id BIGINT AUTO_INCREMENT PRIMARY KEY, req_id VARCHAR(64) DEFAULT '',
      publisher VARCHAR(128) DEFAULT '', ad_unit_id VARCHAR(32) DEFAULT '',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX(publisher), INDEX(ad_unit_id), INDEX(created_at))`).catch(() => {});
    await pool.query(`CREATE TABLE IF NOT EXISTS bid_bid_log (
      id BIGINT AUTO_INCREMENT PRIMARY KEY, req_id VARCHAR(64) DEFAULT '',
      imp_id VARCHAR(64) DEFAULT '', partner VARCHAR(64) DEFAULT '',
      price_micros BIGINT DEFAULT 0, won TINYINT DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX(partner), INDEX(created_at))`).catch(() => {});
    // ② 广告主账户余额 + 充值流水（对标 Mintegral「获取账户余额」）
    await pool.query(`CREATE TABLE IF NOT EXISTS adv_balance (
      advertiser VARCHAR(128) PRIMARY KEY, balance_micros BIGINT DEFAULT 0,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP)`).catch(() => {});
    await pool.query(`CREATE TABLE IF NOT EXISTS adv_recharge (
      id BIGINT AUTO_INCREMENT PRIMARY KEY, advertiser VARCHAR(128) DEFAULT '',
      amount_micros BIGINT DEFAULT 0, operator VARCHAR(64) DEFAULT '',
      note VARCHAR(255) DEFAULT '', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`).catch(() => {});
    // 充值申请单：广告主在线发起 → 运营核验到账后批准入账。
    // 此前广告主后台「申请线下充值」按钮不发任何请求、也不落库 → 充值这一步是断的。
    await pool.query(`CREATE TABLE IF NOT EXISTS adv_recharge_request (
      id BIGINT AUTO_INCREMENT PRIMARY KEY, advertiser VARCHAR(128) DEFAULT '',
      amount_cny DECIMAL(14,2) DEFAULT 0, note VARCHAR(255) DEFAULT '',
      status VARCHAR(16) DEFAULT 'pending', handler VARCHAR(64) DEFAULT '',
      handle_note VARCHAR(255) DEFAULT '', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      handled_at TIMESTAMP NULL, INDEX idx_adv (advertiser), INDEX idx_status (status))`).catch(() => {});
    // ⑥ 广告主 API key（对标 Mintegral 广告主可取 API key）
    await pool.query("ALTER TABLE accounts ADD COLUMN api_key VARCHAR(64) DEFAULT ''").catch(() => {});
    // ⑦ 应用实体（对标 AppLovin「先添加应用」：支持 App bundle，不只 domain）
    await pool.query(`CREATE TABLE IF NOT EXISTS apps (
      id INT AUTO_INCREMENT PRIMARY KEY, publisher VARCHAR(128) DEFAULT '',
      platform VARCHAR(16) DEFAULT 'android', bundle VARCHAR(190) DEFAULT '',
      name VARCHAR(128) DEFAULT '', status TINYINT DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, INDEX(publisher))`).catch(() => {});
    await pool.query('ALTER TABLE ad_units ADD COLUMN app_id INT DEFAULT 0').catch(() => {});
    // ③ 媒体收款信息（对标 AppLovin Payments）
    await pool.query("ALTER TABLE publishers ADD COLUMN payee_name VARCHAR(128) DEFAULT ''").catch(() => {});
    await pool.query("ALTER TABLE publishers ADD COLUMN payee_account VARCHAR(190) DEFAULT ''").catch(() => {});
    await pool.query("ALTER TABLE publishers ADD COLUMN payee_type VARCHAR(32) DEFAULT ''").catch(() => {});
    await pool.query("ALTER TABLE publishers ADD COLUMN invoice_title VARCHAR(190) DEFAULT ''").catch(() => {});
    await pool.query("ALTER TABLE publishers ADD COLUMN tax_no VARCHAR(64) DEFAULT ''").catch(() => {});
    // ④ 审核驳回原因
    await pool.query("ALTER TABLE adv_campaign ADD COLUMN review_note VARCHAR(255) DEFAULT ''").catch(() => {});
    // ⑧ 两步验证 TOTP
    await pool.query("ALTER TABLE accounts ADD COLUMN totp_secret VARCHAR(64) DEFAULT ''").catch(() => {});
    await pool.query('ALTER TABLE accounts ADD COLUMN twofa TINYINT DEFAULT 0').catch(() => {});
    // 存量广告主按在投计划预算初始化余额，保证升级后既有投放不中断、之后按真实余额参拍
    await pool.query(`INSERT IGNORE INTO adv_balance (advertiser,balance_micros)
      SELECT advertiser, COALESCE(SUM(budget_micros),0) FROM adv_campaign WHERE advertiser<>'' GROUP BY advertiser`).catch(() => {});
    // ===== 补齐 1-7：MMP / Waterfall / A-B / 频控 / 黑名单 / 尺寸 =====
    // ① MMP：归因平台配置 + 外发回传日志（AppsFlyer / Adjust / Singular / Kochava / Tenjin / Branch 格式）
    await pool.query(`CREATE TABLE IF NOT EXISTS mmp_configs (
      id INT AUTO_INCREMENT PRIMARY KEY, advertiser VARCHAR(128) NOT NULL,
      provider VARCHAR(32) DEFAULT 'appsflyer', postback_url VARCHAR(512) DEFAULT '',
      app_id VARCHAR(128) DEFAULT '', api_key VARCHAR(512) DEFAULT '',
      skan_source_id INT DEFAULT 1, conversion_window_days INT DEFAULT 7, skan_bucket INT DEFAULT 14,
      enabled TINYINT DEFAULT 1, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`).catch(() => {});
    // 幂等 migration：老表补 SKAN/App ID/API Key/转化窗口/分箱 列
    await pool.query("ALTER TABLE mmp_configs ADD COLUMN app_id VARCHAR(128) DEFAULT ''").catch(() => {});
    await pool.query("ALTER TABLE mmp_configs ADD COLUMN api_key VARCHAR(512) DEFAULT ''").catch(() => {});
    await pool.query("ALTER TABLE mmp_configs ADD COLUMN skan_source_id INT DEFAULT 1").catch(() => {});
    await pool.query("ALTER TABLE mmp_configs ADD COLUMN conversion_window_days INT DEFAULT 7").catch(() => {});
    await pool.query("ALTER TABLE mmp_configs ADD COLUMN skan_bucket INT DEFAULT 14").catch(() => {});
    await pool.query(`CREATE TABLE IF NOT EXISTS mmp_postback_log (
      id BIGINT AUTO_INCREMENT PRIMARY KEY, provider VARCHAR(32) DEFAULT '',
      advertiser VARCHAR(128) DEFAULT '', imp_id VARCHAR(64) DEFAULT '',
      event VARCHAR(64) DEFAULT '', url VARCHAR(512) DEFAULT '', ok TINYINT DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`).catch(() => {});
    // ② Waterfall：需求源排序 + 分国家底价（scope=媒体域名 或 '*' 全局）
    await pool.query(`CREATE TABLE IF NOT EXISTS waterfall_rules (
      id INT AUTO_INCREMENT PRIMARY KEY, scope VARCHAR(128) DEFAULT '*',
      ad_unit_id VARCHAR(32) DEFAULT '', country VARCHAR(8) DEFAULT '*',
      demand_source VARCHAR(64) NOT NULL, position INT DEFAULT 0,
      floor_cny DECIMAL(10,2) DEFAULT 0, enabled TINYINT DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, INDEX(scope, ad_unit_id, country))`).catch(() => {});
    // ③ A/B 实验：bid_floor / demand_source / ecpm_weight 三组
    await pool.query(`CREATE TABLE IF NOT EXISTS ab_experiments (
      id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(128) DEFAULT '',
      kind VARCHAR(24) DEFAULT 'bid_floor', config TEXT, status TINYINT DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`).catch(() => {});
    await pool.query(`CREATE TABLE IF NOT EXISTS ab_exposure (
      id BIGINT AUTO_INCREMENT PRIMARY KEY, exp_id INT DEFAULT 0,
      variant_key VARCHAR(32) DEFAULT '', imp_id VARCHAR(64) DEFAULT '',
      won TINYINT DEFAULT 0, price_micros BIGINT DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, INDEX(exp_id, variant_key))`).catch(() => {});
    // 业务告警表（异常/作弊/业务风险预警）
    await pool.query(`CREATE TABLE IF NOT EXISTS alerts (
      id BIGINT AUTO_INCREMENT PRIMARY KEY, level VARCHAR(8) DEFAULT 'warn',
      kind VARCHAR(32) DEFAULT '', msg TEXT, metric JSON, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`).catch(() => {});
    // 性能优化：关键查询补索引（转化归因 / 媒体方报表 / 落地页到达）
    await pool.query('ALTER TABLE conv_log ADD INDEX idx_imp (imp_id)').catch(() => {});
    await pool.query('ALTER TABLE conv_log ADD INDEX idx_type_time (type, created_at)').catch(() => {});
    await pool.query('ALTER TABLE bid_win_log ADD INDEX idx_imp (imp_id)').catch(() => {});
    await pool.query('ALTER TABLE bid_win_log ADD INDEX idx_pub_time (publisher, created_at)').catch(() => {});
    await pool.query('ALTER TABLE landing_view ADD INDEX idx_imp (imp_id)').catch(() => {});
    await pool.query('ALTER TABLE leads ADD INDEX idx_imp (imp_id)').catch(() => {});
    // ④ 频控 / 刷新 / 尺寸（MREC 300x250 等）
    await pool.query('ALTER TABLE ad_units ADD COLUMN freq_cap INT DEFAULT 0').catch(() => {});
    await pool.query('ALTER TABLE ad_units ADD COLUMN freq_window_hours INT DEFAULT 24').catch(() => {});
    await pool.query('ALTER TABLE ad_units ADD COLUMN refresh_interval INT DEFAULT 0').catch(() => {});
    await pool.query('ALTER TABLE ad_units ADD COLUMN size VARCHAR(16) DEFAULT \'\'').catch(() => {});
    // ⑧ MAX 对齐：需求源 / 国家定向 / 出价策略 / Waterfall 优先级（开发者链路 P0-5）
    await pool.query('ALTER TABLE ad_units ADD COLUMN network VARCHAR(64) DEFAULT \'bidding\'').catch(() => {});    // bidding/waterfall/header_bidding/none
    await pool.query('ALTER TABLE ad_units ADD COLUMN geo VARCHAR(64) DEFAULT \'\'').catch(() => {});                // ISO 国家码逗号分隔（空=不限）
    await pool.query('ALTER TABLE ad_units ADD COLUMN bid_strategy VARCHAR(16) DEFAULT \'bidding\'').catch(() => {});  // bidding/header_bidding/waterfall
    await pool.query('ALTER TABLE ad_units ADD COLUMN waterfall_priority INT DEFAULT 1').catch(() => {});              // Waterfall 优先级 1-N
    // ⑨ AppLovin Payments 对齐：税表 / 币种 / 银行 / SWIFT（开发者链路 P0-6）
    await pool.query('ALTER TABLE publishers ADD COLUMN tax_form_type VARCHAR(32) DEFAULT \'\'').catch(() => {});    // W-9/W-8BEN/VAT/CN_TAX
    await pool.query('ALTER TABLE publishers ADD COLUMN tax_form_url VARCHAR(512) DEFAULT \'\'').catch(() => {});    // 税表文件 URL
    await pool.query('ALTER TABLE publishers ADD COLUMN currency VARCHAR(8) DEFAULT \'CNY\'').catch(() => {});        // CNY/USD/HKD/EUR
    await pool.query('ALTER TABLE publishers ADD COLUMN bank_name VARCHAR(128) DEFAULT \'\'').catch(() => {});        // 开户行
    await pool.query('ALTER TABLE publishers ADD COLUMN swift_iban VARCHAR(64) DEFAULT \'\'').catch(() => {});        // SWIFT 代码或 IBAN
    // ⑤ 品牌安全黑名单：domain / keyword / bundle
    await pool.query(`CREATE TABLE IF NOT EXISTS bs_blacklist (
      id INT AUTO_INCREMENT PRIMARY KEY, kind VARCHAR(16) DEFAULT 'domain',
      value VARCHAR(190) DEFAULT '', scope VARCHAR(128) DEFAULT '*',
      enabled TINYINT DEFAULT 1, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, INDEX(kind, value))`).catch(() => {});

    // 外部 DSP 真实扣账：非自有需求方胜出时记「应收」（对方按清盘价向我们结算）
    await pool.query(`CREATE TABLE IF NOT EXISTS dsp_settlement (
      id BIGINT AUTO_INCREMENT PRIMARY KEY, partner VARCHAR(64) DEFAULT '',
      imp_id VARCHAR(64) DEFAULT '', req_id VARCHAR(64) DEFAULT '',
      gross_micros BIGINT DEFAULT 0, payable_micros BIGINT DEFAULT 0, platform_fee_micros BIGINT DEFAULT 0,
      status VARCHAR(16) DEFAULT 'PENDING', settled_at TIMESTAMP NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uk_partner_imp_req (partner, imp_id, req_id))`).catch(() => {});

    // ===== 运营活动模块（业务层，归属运营；挂在管理后台，独立于竞价/DSP/SSP 引擎）=====
    // 活动配置 / 奖励规则 / 预算与发放 / 参与与防刷
    await pool.query(`CREATE TABLE IF NOT EXISTS activity_campaign (
      id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(128) DEFAULT '',
      status TINYINT DEFAULT 0, start_at DATETIME NULL, end_at DATETIME NULL,
      budget_micros BIGINT DEFAULT 0, spent_micros BIGINT DEFAULT 0,
      owner_role VARCHAR(16) DEFAULT 'operations', created_by VARCHAR(64) DEFAULT '',
      note VARCHAR(255) DEFAULT '', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`).catch(() => {});
    await pool.query(`CREATE TABLE IF NOT EXISTS activity_reward_rule (
      id INT AUTO_INCREMENT PRIMARY KEY, activity_id INT NOT NULL, code VARCHAR(64) DEFAULT '',
      title VARCHAR(128) DEFAULT '', reward_micros BIGINT DEFAULT 0,
      cap_per_user INT DEFAULT 1, daily_cap INT DEFAULT 0,
      conditions JSON, antifraud JSON, status TINYINT DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, INDEX(activity_id))`).catch(() => {});
    await pool.query(`CREATE TABLE IF NOT EXISTS activity_participation (
      id BIGINT AUTO_INCREMENT PRIMARY KEY, activity_id INT NOT NULL, rule_id INT NOT NULL,
      user_key VARCHAR(128) DEFAULT '', device_fp VARCHAR(128) DEFAULT '',
      reward_micros BIGINT DEFAULT 0, status VARCHAR(16) DEFAULT 'GRANTED',
      req_ip VARCHAR(64) DEFAULT '', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX(activity_id), INDEX(user_key), INDEX(device_fp))`).catch(() => {});

    // is_test 列：演示/测试计划标记，/notify 对其只记账不真扣预算与余额（保留列定义以支持运营自测计划）
    await pool.query('ALTER TABLE adv_campaign ADD COLUMN is_test TINYINT DEFAULT 0').catch(() => {});
    await pool.query(`INSERT INTO adv_balance (advertiser,balance_micros)
      SELECT DISTINCT advertiser, 100000000 FROM adv_campaign WHERE is_test=1 AND advertiser<>''
      ON DUPLICATE KEY UPDATE balance_micros = GREATEST(balance_micros, 100000000)`).catch(() => {});
    // 加载持久化的外部 DSP 合作方进入拍卖（真实需求方连接，重启自动恢复）
    try {
      const [ds] = await pool.query("SELECT name,url,payout_rate,is_own FROM dsp_partners WHERE status=1");
      ds.forEach(d => { if (!DEMAND_PARTNERS.find(p => p.name === d.name)) DEMAND_PARTNERS.push({ name: d.name, type: 'http', url: d.url, payoutRate: Number(d.payout_rate) || 0.6, isOwn: !!d.is_own }); });
    } catch (e) {}
    await pool.query(`CREATE TABLE IF NOT EXISTS sku_eval (
      sku_id VARCHAR(64) PRIMARY KEY, name VARCHAR(128),
      l1 DECIMAL(4,3) DEFAULT 0.5, l2 DECIMAL(4,3) DEFAULT 0.5, l3 DECIMAL(4,3) DEFAULT 0.5,
      eval_score DECIMAL(5,4) DEFAULT 0.5,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP)`);
    await pool.query(`CREATE TABLE IF NOT EXISTS sku_stats (
      sku_id VARCHAR(64) PRIMARY KEY, n_samples INT DEFAULT 0,
      successes INT DEFAULT 0, failures INT DEFAULT 0,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP)`);
    // ── Fix-06：eCPM' 评测库必须是「广告库存品类」，不能是别的 SaaS 产品的商品目录 ──
    // 此前 sku_eval 里是 esign(电子签章包)/jijian(计件工资核算) 等 Kx Learning 品类，
    // GET /api/ecpm/evals 返回的内容与本平台广告业务完全错位（走查报告 P1-4 / Fix-06）。
    // 处理：① 清掉历史遗留的非广告品类 ② 播种广告品类目录（INSERT IGNORE，不覆盖已有数据）。
    try {
      await pool.query('DELETE FROM sku_eval WHERE sku_id IN (?)', [LEGACY_NON_AD_SKUS]);
      await pool.query('DELETE FROM sku_stats WHERE sku_id IN (?)', [LEGACY_NON_AD_SKUS]);
    } catch (e) {}
    for (const s of AD_SKU_CATALOG) {
      await pool.query('INSERT IGNORE INTO sku_eval (sku_id,name,l1,l2,l3,eval_score) VALUES (?,?,?,?,?,?)',
        [s.skuId, s.name, s.l1, s.l2, s.l3, ecpm.composeEvalScore({ l1: s.l1, l2: s.l2, l3: s.l3 })]).catch(() => {});
    }
    // SKAdNetwork / 隐私聚合归因回传（P1 隐私与测量）：苹果/Google 聚合归因回传落库
    await pool.query(`CREATE TABLE IF NOT EXISTS skan_postback (
      id BIGINT AUTO_INCREMENT PRIMARY KEY, dsp_domain VARCHAR(64), campaign_id INT,
      source_app VARCHAR(64), postback_version VARCHAR(8), fidelity INT DEFAULT 0,
      conversion_value INT DEFAULT -1, coarse_value VARCHAR(16) DEFAULT '',
      payload JSON, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
    const [[c]] = await pool.query('SELECT COUNT(*) n FROM adv_campaign');
    if (c.n === 0) {
      await pool.query(`INSERT INTO adv_campaign
        (name,advertiser,budget_micros,country,app_category,creative_html,landing_url,target_cpm_micros,intent_tags) VALUES
        ('益智游戏买量','GameCo',2000000000,'','puzzle','<div style="padding:10px;background:#4F8EF7;color:#fff;border-radius:6px">试玩即玩·益智爆款</div>','https://example.com',6000000,'puzzle,game,casual'),
        ('电商促销-北美','ShopUS',3000000000,'US','', '<div style="padding:10px;background:#e74c3c;color:#fff">北美大促 低至5折</div>','https://shop.example.com',8000000,'shop,ecommerce,sale')`);
    }
    // 结算身份修正：以 (请求id, impid) 复合身份区分不同请求重复使用的 slot 名；
    // billable=0 标记"同一身份重复记录"的历史行（非破坏性，保留审计轨迹）
    await pool.query("ALTER TABLE bid_win_log ADD COLUMN req_id VARCHAR(64) DEFAULT ''").catch(() => {});
    await pool.query('ALTER TABLE bid_win_log ADD COLUMN billable TINYINT DEFAULT 1').catch(() => {});
    await pool.query(`CREATE TABLE IF NOT EXISTS admin_audit (
      id BIGINT AUTO_INCREMENT PRIMARY KEY, actor VARCHAR(64), action VARCHAR(64),
      target VARCHAR(255), detail VARCHAR(255), ip VARCHAR(64),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
    // 管理员邀请码（#12）：受控开通管理员，替代"共用 root 账号"；一次性、可设过期、可审计
    await pool.query(`CREATE TABLE IF NOT EXISTS admin_invites (
      code VARCHAR(32) PRIMARY KEY, created_by VARCHAR(128) DEFAULT '', note VARCHAR(160) DEFAULT '',
      expires_at DATETIME NULL, used_by VARCHAR(128) NULL, used_at DATETIME NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
    // ── Fix-02 RBAC：邀请码携带"将被授予的角色"，注册时按角色裁剪 scope ──
    // 缺省 admin_viewonly（最小权限）：历史邀请码按最小权限回填，不会意外获得超管权限。
    await pool.query("ALTER TABLE admin_invites ADD COLUMN role VARCHAR(32) DEFAULT 'admin_viewonly'").catch(() => {});
    await pool.query("UPDATE admin_invites SET role='admin_viewonly' WHERE role IS NULL OR role='' OR role='*'").catch(() => {});
    // 账号表记录角色：登录令牌里的 scope 由角色推导，便于后台"账号与权限"页展示与调整
    await pool.query("ALTER TABLE accounts ADD COLUMN role VARCHAR(32) DEFAULT ''").catch(() => {});
    // 历史回填：scope='*' 的既有管理员 = 超级管理员；其余一律按最小权限，避免出现"无角色却拥有写权限"的僵尸账号
    await pool.query("UPDATE accounts SET role='admin_owner' WHERE type='admin' AND (role IS NULL OR role='') AND scope='*'").catch(() => {});
    await pool.query("UPDATE accounts SET role=? WHERE type='admin' AND (role IS NULL OR role='')", [security.DEFAULT_INVITE_ROLE]).catch(() => {});
    // 三方账号体系：admin / advertiser / publisher 独立账号 + 作用域
    await pool.query(`CREATE TABLE IF NOT EXISTS accounts (
      id INT AUTO_INCREMENT PRIMARY KEY,
      type ENUM('admin','advertiser','publisher') NOT NULL,
      username VARCHAR(128) NOT NULL UNIQUE,
      pass_hash VARCHAR(128) NOT NULL,
      scope VARCHAR(255) DEFAULT '',
      display VARCHAR(128) DEFAULT '',
      status TINYINT DEFAULT 1,
      created_by VARCHAR(128) DEFAULT '',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
    // ── 账号唯一码：与登录邮箱、业务作用域解耦的系统标识（后台识别 / API 对接 / 对账）──
    // 登录用邮箱（唯一、可找回）；作用域是业务口径（媒体=域名，广告主=名称）；唯一码自动生成且不可变。
    await pool.query("ALTER TABLE accounts ADD COLUMN account_code VARCHAR(32) DEFAULT ''").catch(() => {});
    // 口令列扩容：scrypt 散列（scrypt$16384$8$1$<32位盐>$<128位散列>）约 180 字符，
    // 而列原为 VARCHAR(128) → 任何新建账号（含 Fix-01 的演示账号、广告主/媒体自助开户）都会
    // 因 "Data too long for column 'pass_hash'" 静默失败，表现为"注册成功但永远登不上"。
    await pool.query("ALTER TABLE accounts MODIFY pass_hash VARCHAR(255) NOT NULL").catch(() => {});
    // 回填历史账号：唯一码为空的按角色规则补号，保证任何账号都有唯一码
    try {
      const [rows] = await pool.query("SELECT id,type FROM accounts WHERE account_code IS NULL OR account_code=''");
      for (const r of rows || []) await pool.query('UPDATE accounts SET account_code=? WHERE id=?', [genAccountCode(r.type), r.id]);
    } catch (e) {}
    await pool.query('ALTER TABLE accounts ADD UNIQUE INDEX idx_account_code (account_code)').catch(() => {});
    // 三套账号体系（admin / advertiser / publisher）彼此独立：
    // 同一个邮箱应能分别注册「广告主」和「开发者」，各拿各的唯一码（ADV-/PUB-）。
    // 原 username 是【全局唯一】→ 用同一邮箱开第二种角色会被拒（提示"已注册"）。
    // 改为 (type, username) 复合唯一：同一邮箱在每个角色下各一个账号。
    await pool.query('ALTER TABLE accounts DROP INDEX username').catch(() => {});
    await pool.query('ALTER TABLE accounts ADD UNIQUE INDEX idx_type_username (type, username)').catch(() => {});
    // 演示账号只允许出现在非生产环境；生产启动必须显式提供管理员强口令。
    try {
      if (security.IS_PROD && (!process.env.ADMIN_PASS || process.env.ADMIN_PASS.length < 12)) {
        console.error('[FATAL] 生产环境必须设置长度至少 12 位的 ADMIN_PASS');
        process.exit(1);
      }
      // Fix-01：演示账号改为"按开关受控开通"，不再无条件删除。
      // 原实现无条件 DELETE demobrand/demomedia，而 login.html 又硬编码这两个账号 + demo123
      // → 按钮点了必然 401（走查报告 N-P0-1）。现在由 ensureDemoAccounts() 统一决定：
      // 开关关闭时才清理（避免"账号管理"里出现登不上的假账号），开启时把口令对齐到 DEMO_PASSWORD。
      if (!demoAccountsEnabled()) {
        await pool.query("DELETE FROM accounts WHERE username IN ('demobrand','demomedia')").catch(() => {});
      } else {
        await ensureDemoAccounts();
      }
      // 初始管理员仅在"不存在"时创建（INSERT IGNORE）。
      // 原实现用 ON DUPLICATE KEY UPDATE pass_hash=... + status=1：每次启动都会把 admin 密码
      // 重置回 ADMIN_PASS||默认值并强制启用 —— 管理员改过的密码每次重启都被覆盖回去（"改了又变回"）。
      // 改为只播种一次，之后密码完全由管理员通过账号管理/自助改密管理。
      // 生产环境禁用弱默认口令 admin123（#12）：若未注入 ADMIN_PASS，则为首启管理员生成一次性强随机口令，
      // 并仅在启动日志打印一次（既消除固定弱口令，又不会把人锁在门外）。开发环境保留 admin123 便于本地演示。
      const _adminPass = process.env.ADMIN_PASS || (security.IS_PROD ? crypto.randomBytes(12).toString('base64url') : 'admin123');
      await pool.query(
        'INSERT IGNORE INTO accounts (type,username,pass_hash,scope,display,status,account_code) VALUES (?,?,?,?,?,1,?)',
        ['admin', process.env.ADMIN_USER || 'admin', security.hashPwd(_adminPass), '*', '超级管理员', genAccountCode('admin')]
      ).catch(() => {});
      if (security.IS_PROD && !process.env.ADMIN_PASS) {
        console.warn('[SECURITY] 生产未注入 ADMIN_PASS：已为首启管理员生成一次性强口令（见下），请立即登录修改，或在 .env 固定 ADMIN_PASS。');
        console.warn('[SECURITY] 初始管理员口令 = ' + _adminPass);
      }
      // Fix-01：演示账号的开关已改为 demoAccountsEnabled()（不再与 ENABLE_DEMO_ACCOUNTS 绑定），日志同步修正，避免误报"已停用"
      console.warn(demoAccountsEnabled()
        ? '[SEED] 演示账号已启用（demobrand / demomedia，口令对齐 DEMO_PASSWORD）'
        : '[SEED] 演示账号已停用（生产默认关闭；需演示请设 ENABLE_DEMO_ACCOUNTS=1）');
    } catch (e) { console.warn('[WARN] 演示账号 upsert 失败（可忽略）:', e.message); }
    // 演示运营活动已按生产清理要求移除（不再自动播种 act=1）。真实活动请通过管理后台 /api/activity 创建。
    // 在线转化预测模型权重持久化（无论是否有种子数据都初始化）
    await pool.query(`CREATE TABLE IF NOT EXISTS bid_model_weights (
      campaign_id INT PRIMARY KEY, w_json TEXT, n INT DEFAULT 0,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP)`);
    // 软考落地页留资（landing/ruankao/index.html 回传邮箱/微信，免登录、无敏感数据）
    await pool.query(`CREATE TABLE IF NOT EXISTS ruankao_lead (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      contact VARCHAR(128),
      channel VARCHAR(32) DEFAULT 'direct',
      source VARCHAR(128) DEFAULT '',
      ip VARCHAR(64) DEFAULT '',
      delivered TINYINT DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX(channel), INDEX(created_at))`);
    bidModel.attachPool(pool);
    await bidModel.loadAll();
    bidModel.startFlusher();
    bidModel.startSweeper();
    creativeAb.attachPool(pool);
  anticheat.attachPool(pool);

    // ===== 新增能力层初始化 =====
    // 关键修复：原先整段共用一个 try/catch——任何一条建表 SQL 报错都会让后面
    // 所有模块（信任/节奏/计费/品牌安全/身份图谱/归因/创意自动化/ML/竞价工程）被整段跳过初始化，
    // 表现为"高级能力台一片空白、按钮无响应"，而日志只有一句含糊的 init 报错。
    // 现在逐模块独立 try/catch：单点失败只影响该模块，并在日志里点名是谁失败。
    const CAP_MODULES = [
      ['trust', trust], ['pacing', pacing], ['retarget', retarget], ['billing', billing], ['brandSafety', brandSafety],
      ['identity', identity], ['attribution', attribution], ['creativeAuto', creativeAuto],
      ['ml', ml], ['bidEng', bidEng], ['anticheat', anticheat],
    ];
    for (const [nm, mod] of CAP_MODULES) {
      try {
        if (mod.attachPool) mod.attachPool(pool);
        if (mod.initTables) await mod.initTables();
        if (mod.init) await mod.init();
        if (nm === 'identity' && mod.load) await mod.load();
        if (nm === 'identity' && mod.startFlush) mod.startFlush();
        if (nm === 'retarget' && mod.startFlush) mod.startFlush();
        if (nm === 'ml' && mod.startWorkers) mod.startWorkers();
        if (nm === 'bidEng' && mod.startFlusher) mod.startFlusher();
      } catch (e) { console.error('[init] 能力模块 ' + nm + ' 初始化失败：' + e.message); }
    }
    // 竞价热路径内存快照 + 倒排索引（去 DB/redis，冲 <10ms）：后台批量预计算候选 campaign 及其各维度数据
    try { campaignStore.start({ pool, brandSafety, pacing, todaySpend, perfFactor }); }
    catch (e) { console.error('[init] campaignStore 启动失败：' + e.message); }
    console.log('[platform] 信任层/节奏/计费/品牌安全/身份图谱/归因/创意自动化/ML/竞价工程 已就绪');
  } catch (e) { console.error('init', e.message); }
}

// === 意图匹配：上下文与 campaign.intent_tags 重合度 0..1，用于抬高 eCPM ===
function intentScore(campaign, ctx) {
  const tags = (campaign.intent_tags || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!tags.length) return 0;
  const hay = [ctx.app_category, ctx.country, ...(ctx.keywords || [])].map(s => (s || '').toLowerCase());
  let hit = 0;
  tags.forEach(t => { if (hay.some(h => h && (h.includes(t) || t.includes(h)))) hit++; });
  return hit / tags.length;
}

// 用 LLM 给单个 campaign 打相关性（优先 LLM 画像，否则启发式）；返回 {score,reason,llm?}
async function llmRel(c, ctx) {
  if (llm.ENABLED && llm.LIVE_MATCH && c.intent_profile) {
    try { const p = JSON.parse(c.intent_profile); return await llm.scoreRelevance(p, ctx); } catch (e) {}
  }
  return { score: intentScore(c, ctx), reason: '启发式' };
}

// ============ 多特征 LR 相关性（替代 intentScore 纯标签重叠）+ 双塔向量特征 ============
// 行业通用做法：相关性 = 逻辑回归 over 多特征（品类/国家/关键词重叠/历史转化/时段/出价竞争力），
// 同步、无 I/O，热路径直接调用。双塔 cosine 作为可选特征（campaign 塔=intent_embed，
// query 塔=在线编码器；当前未接入 embedding 服务 → 返回 0，接入后即激活）。
function _sig(x) { return 1 / (1 + Math.exp(-x)); }
function _jaccard(a, b) {
  if (!a.length || !b.length) return 0;
  const s = new Set(a), t = new Set(b); let inter = 0;
  for (const x of s) if (t.has(x)) inter++;
  return inter / (s.size + t.size - inter);
}
function _cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
// query 塔占位：返回 null 表示无在线编码器（双塔停用）；接入 embedding 服务后在此编码 ctx 即可激活
function _queryEncode() { return null; }
function twoTowerSim(c, ctx) {
  let emb = null;
  try { emb = typeof c.intent_embed === 'string' ? JSON.parse(c.intent_embed) : c.intent_embed; } catch (e) { emb = null; }
  if (!Array.isArray(emb) || emb.length < 2) return 0;
  const q = _queryEncode();
  return q ? Math.max(0, _cosine(emb, q)) : 0;
}
function lrRelevance(c, ctx, store, floorMicros) {
  const ctxCat = (ctx.app_category || '').toLowerCase();
  const campCat = (c.app_category || '').toLowerCase();
  const catMatch = !campCat || campCat === 'all' || !ctxCat || campCat === ctxCat;
  const geo = (c.geo_country || '').toUpperCase();
  const geoMatch = !geo || (ctx.country && geo === String(ctx.country).toUpperCase());
  const tags = (c.intent_tags || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const kw = _jaccard(tags, (ctx.keywords || []).map(s => String(s).toLowerCase()));
  const perf = store && store.perfOf ? store.perfOf(c.id) : null;
  const perfF = perf != null ? Math.max(-1, Math.min(1, (perf - 1) / 0.3)) : 0;   // 0.7~1.3 -> -1~1
  const h = new Date().getHours();
  const hourF = (h >= 9 && h <= 23) ? 1 : 0.4;
  const base = Math.min(Number(c.target_cpm_micros) || 0, Number(c.budget_micros) || 0);
  const valF = floorMicros > 0 ? Math.max(0, Math.min(1, base / (floorMicros * 1.5))) : 1;
  const embF = twoTowerSim(c, ctx);
  const z = -0.6 + 2.0 * catMatch + 1.2 * geoMatch + 1.5 * kw + 0.6 * perfF + 0.3 * hourF + 0.4 * valF + 0.5 * embF;
  const score = _sig(z * 1.4);
  return { score: +score.toFixed(4), source: 'lr', features: { catMatch, geoMatch, kw, perfF, hourF, valF, embF } };
}

// ============ P0/P1/P2 增强：相关性缓存 + 学习化 eCPM + 反欺诈设备图谱 ============
const MIN_RELEVANCE = 0.05;   // P0 最低相关性门槛：低于此值不参与竞价，避免无关创意抢量
const REL_TTL_MS = 60 * 60 * 1000;

// 上下文签名：品类 + 地区 + 排序后关键词（用于相关性/embedding 缓存）
function ctxSig(ctx) {
  const kw = (ctx.keywords || []).slice().sort().join(',');
  return `${(ctx.app_category || '').toLowerCase()}|${(ctx.country || '').toLowerCase()}|${kw}`;
}

// 异步缓存化相关性：热路径同步返回启发式分数（不阻塞）；并火速(非阻塞)刷新 embedding 分数覆盖缓存
async function relevanceFor(c, ctx) {
  const key = `r:${c.id}:${ctxSig(ctx)}`;
  const cached = await cache.get(key);
  if (cached && Date.now() - cached.ts < REL_TTL_MS) { cache.incr('relcache_hit'); return cached; }
  cache.incr('relcache_miss');
  const h = intentScore(c, ctx);
  const base = { score: h, source: 'heuristic', ts: Date.now() };
  cache.set(key, base, REL_TTL_MS).catch(() => {});
  if (llm.ENABLED && c.intent_embed) setImmediate(() => refreshEmbeddingRel(c, ctx, key).catch(() => {}));
  // LLM 热路径：开启(env LLM_HOT_PATH=1)且有真实意图画像时，同步用 LLM 评分（带 ~900ms 预算，超时/失败回落启发式）。
  // 此前 LLM 只异步回填 embedding、且 llmRel 仅用于演示接口；这里把"算法/LLM 相关性"真正接入出价热路径。
  if (process.env.LLM_HOT_PATH === '1' && llm.ENABLED && c.intent_profile) {
    try {
      const fast = await Promise.race([
        llm.scoreRelevance(JSON.parse(c.intent_profile), ctx),
        new Promise((res) => setTimeout(() => res(null), 900)),
      ]);
      if (fast && typeof fast.score === 'number') {
        const out = { score: fast.score, source: 'llm', reason: fast.reason || 'LLM匹配', ts: Date.now() };
        cache.set(key, out, REL_TTL_MS).catch(() => {});
        return out;
      }
    } catch (e) {}
  }
  return base;
}
async function refreshEmbeddingRel(c, ctx, key) {
  const campEmb = safeJson(c.intent_embed);
  if (!Array.isArray(campEmb) || !campEmb.length) return;
  const text = `${(ctx.app_category || '')} ${(ctx.keywords || []).join(' ')} ${ctx.country || ''}`.trim();
  const ctxEmb = await embedCached(text);
  if (!ctxEmb) return;
  const sc = llm.cosine(campEmb, ctxEmb);
  if (sc <= 0) return;
  await cache.set(key, { score: Math.max(0, Math.min(1, sc)), source: 'embedding', ts: Date.now() }, REL_TTL_MS);
  cache.incr('rel_embed_refresh');
}
async function embedCached(text) {
  const key = 'e:' + crypto.createHash('md5').update(text).digest('hex');
  const c = await cache.get(key);
  if (c) return c;
  const v = await llm.embed(text);
  if (v) await cache.set(key, v, 24 * 60 * 60 * 1000);
  return v;
}

// 学习化 eCPM：基于近 7 天历史转化表现动态调整出价系数（冷启动先验=1，样本足时由行为接管）
const perfCache = new Map();
async function perfFactor(cid) {
  const now = Date.now();
  const c = perfCache.get(cid);
  if (c && now - c.ts < 60000) return c.factor;
  try {
    const [[s]] = await pool.query(
      "SELECT COUNT(*) clicks, COALESCE(SUM(type='conversion'),0) conv FROM conv_log WHERE campaign_id=? AND created_at > NOW()-INTERVAL 7 DAY",
      [cid]);
    const clicks = Number(s.clicks) || 0, conv = Number(s.conv) || 0;
    let factor = 1;
    if (clicks >= 20) factor = Math.max(0.7, Math.min(1.3, 0.7 + (conv / clicks) * 6));
    perfCache.set(cid, { factor, ts: now });
    return factor;
  } catch (e) { return 1; }
}

// P2 反欺诈：设备图谱 + 竞价侧频次风控（跨设备农场/单设备刷量）
const deviceGraph = new Map(); // fp -> { ips:Set, bids:[ts], lastSeen }
const BID_FP_MAX = 300;       // 单设备窗口内最大竞价次数
const BID_FP_WIN = 10 * 60 * 1000;
function bidFpRisk(fp, ip) {
  if (!fp) return { ok: true };
  const t = Date.now();
  const g = deviceGraph.get(fp) || { ips: new Set(), bids: [] };
  g.ips.add(ip);
  g.bids = (g.bids || []).filter(x => t - x < BID_FP_WIN);
  g.bids.push(t); g.lastSeen = t; deviceGraph.set(fp, g);
  if (g.bids.length > BID_FP_MAX) return { ok: false, reason: 'DEVICE_FP_BID_RATE' };
  if (g.ips.size > 50) return { ok: false, reason: 'DEVICE_IP_FARM' };
  return { ok: true };
}

// ============ P1 Pacing：日预算平滑，避免几分钟把预算烧光 ============
// 允许消费上限 = 日预算 × 当日流逝比例（至少保留 15% 兜底，防止凌晨完全停投）
const paceCache = new Map(); // cid -> { micros, ts }
const PACE_TTL = 30 * 1000;
async function todaySpend(cid) {
  const now = Date.now();
  const c = paceCache.get(cid);
  if (c && now - c.ts < PACE_TTL) return c.micros;
  let micros = 0;
  try {
    const [[r]] = await pool.query('SELECT COALESCE(micros,0) micros FROM daily_spend WHERE campaign_id=? AND d=CURDATE()', [cid]);
    micros = Number(r && r.micros) || 0;
  } catch (e) {}
  paceCache.set(cid, { micros, ts: now });
  return micros;
}
function bustPace(cid) { paceCache.delete(cid); }
// true = 在预算节奏内可投放
function withinPace(campaign, spentMicros) {
  const cap = Number(campaign.daily_cap_micros) || 0;
  if (cap <= 0) return true;                       // 未设日预算 → 不限节奏
  const d = new Date();
  const elapsed = (d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds()) / 86400;
  const allowed = cap * Math.max(0.15, elapsed);   // 按当日流逝比例放预算
  return spentMicros < allowed && spentMicros < cap;
}

// 创建 campaign 后用 LLM 抽取意图画像 + embedding 向量并回写（用户已填标签则做并集）
// P2：LLM Creative/意图 Agent 是「可选增强」——未配置任何 LLM Key 时直接 no-op（回落启发式），
// 绝不让"缺 Key"成为创建计划的阻塞点或报错源。
async function enrichCampaign(id) {
  if (!llm.ENABLED) return;
  const [[c]] = await pool.query('SELECT * FROM adv_campaign WHERE id=?', [id]);
  if (!c) return;
  const ex = await llm.extractDemandIntent(c);
  if (!ex) return;
  const userTags = (c.intent_tags || '').split(',').map(s => s.trim()).filter(Boolean);
  const tags = userTags.length ? [...new Set([...userTags, ...ex.tags])] : ex.tags;
  // 计算并存储 intent_embed（异步缓存化 embedding 相关性用；无 embedding Key 时跳过）
  let emb = null;
  if (llm.ENABLED) {
    const text = `${c.name} ${c.advertiser || ''} ${String(c.creative_html || '').replace(/<[^>]*>/g, ' ')} ${c.landing_url || ''} ${c.intent_tags || ''}`.slice(0, 4000);
    emb = await llm.embed(text);
  }
  await pool.query('UPDATE adv_campaign SET intent_tags=?, intent_profile=?, intent_embed=? WHERE id=?',
    [tags.join(','), JSON.stringify(ex.profile), emb ? JSON.stringify(emb) : null, id]);
}

// ── 受众信号自动采集（服务端解析 UA，零用户打扰）──
// 第一性原理：定向信号应当【自动采集后喂给模型】，而不是让用户/广告主手工勾选细分维度。
// 手工细分会把长尾库存切碎导致填不满；模型用信号则既提升精度又不碎片化。
// UA 解析完全在服务端完成，不需要任何用户输入、不影响页面体验与加载。
function parseUA(ua) {
  const s = String(ua || '');
  if (!s) return { os: '', model: '', deviceType: '' };
  let os = '', model = '';
  if (/Windows NT/i.test(s)) os = 'Windows';
  else if (/Android/i.test(s)) { os = 'Android'; const m = s.match(/Android[^;]*;\s*([^;)]+)/i); model = m ? m[1].trim().slice(0, 48) : 'Android'; }
  else if (/iPhone|iPad|iPod/i.test(s)) { os = 'iOS'; model = (/iPad/i.test(s) ? 'iPad' : (/iPod/i.test(s) ? 'iPod' : 'iPhone')); }
  else if (/Mac OS X|Macintosh/i.test(s)) { os = 'macOS'; model = 'Mac'; }
  else if (/Linux/i.test(s)) { os = 'Linux'; model = 'Linux'; }
  const isTablet = /iPad|Tablet|Android.*\bTablet\b/i.test(s);
  const isMobile = isTablet || /Mobile|Android|iPhone|iPod/i.test(s);
  return { os, model, deviceType: isMobile ? '1' : (os ? '2' : '') };
}
// 请求设备类型：优先用 OpenRTB 的 device.devicetype，缺失时由 UA 推断
function reqDeviceType(br) {
  const dt = Number(br && br.device && br.device.devicetype);
  if (dt === 1 || dt === 2 || dt === 3) return dt === 2 ? '2' : '1';
  return parseUA(br && br.device && br.device.ua).deviceType;
}
// 广告主设备定向是否命中（''/空 = 不限）
function deviceTargetMatch(campaignDeviceType, reqType) {
  const want = String(campaignDeviceType || '').trim();
  if (!want || !reqType) return true;
  return want.split(',').map(x => x.trim()).filter(Boolean).indexOf(String(reqType)) >= 0;
}
// 请求 OS（用于 OS 定向，自动采集，零用户打扰）：优先 OpenRTB device.os，其次 UA 推断
function reqOs(br) {
  const raw = String((br && br.device && br.device.os) || '').toLowerCase();
  if (raw) { if (/ios|iphone|ipad/.test(raw)) return 'ios'; if (/android/.test(raw)) return 'android'; return raw; }
  const os = String(parseUA(br && br.device && br.device.ua).os || '').toLowerCase();
  return os; // ios / android / windows / macos ...
}
// 广告主 OS 定向是否命中（''/空 = 不限；可逗号多选 'ios,android'）
function osTargetMatch(campaignOs, reqOsVal) {
  const want = String(campaignOs || '').trim().toLowerCase();
  if (!want || !reqOsVal) return true;
  return want.split(',').map(x => x.trim()).filter(Boolean).indexOf(String(reqOsVal).toLowerCase()) >= 0;
}
// 兴趣定向是否命中：campaign 配了 interest_target（逗号分隔标签）时，
// 与「服务端自动采集的兴趣」= app 类目 + 上下文关键词 做交集匹配（广告主零额外填写）
function interestTargetMatch(campaignInterest, ctxCat, keywords) {
  const want = String(campaignInterest || '').trim().toLowerCase().split(',').map(x => x.trim()).filter(Boolean);
  if (!want.length) return true;
  const tokens = [String(ctxCat || ''), ...(Array.isArray(keywords) ? keywords : [])]
    .map(x => String(x || '').toLowerCase().trim()).filter(Boolean);
  return want.some(w => tokens.includes(w));
}
// 频控入参归一化：{count, windowSec|windowHours, scope} → pacing 认识的 {count, windowSec, scope}
function normalizeFreqCap(fc) {
  if (!fc || typeof fc !== 'object') return null;
  const count = Number(fc.count) || 0;
  if (count <= 0) return null;
  let windowSec = Number(fc.windowSec) || 0;
  if (!windowSec && Number(fc.windowHours)) windowSec = Number(fc.windowHours) * 3600;
  if (windowSec <= 0) windowSec = 86400;   // 默认按天
  const scope = ['device', 'user', 'campaign', 'creative'].indexOf(String(fc.scope)) >= 0 ? String(fc.scope) : 'device';
  return { count, windowSec, scope };
}

// ===== 需求方：DSP 出价引擎（含品类隔离 + 异步相关性 + 学习化 eCPM）=====
// 自有需求方评分内核：既可由 /openrtb2/bid 端点直接调用，也可被 SSP 进程内调用（去掉 zhuque-dsp 自回环 HTTP，
// 消除"1 次竞价 = 2 次 HTTP 往返 + 有效并发翻倍"，对齐 AppLovin 同款进程内拍卖骨架）。
// 返回 OpenRTB bidresponse 对象 {id, seatbid:[...]}，调用方自行 res.json。
async function scoreOwnDemand(brArg, opts = {}) {
  const br = brArg || {};
  // P0 竞价热路径保护：容量节流 + 硬 deadline（对齐 /ssp/bid）。慢隧道/上游堆积时快速 503 失败，避免雪崩拖垮全站。
  // 进程内调用（来自 SSP）时跳过节流：SSP 已在入口统一节流，避免重复计数/误杀。
  if (!opts.internal) {
    const th = bidEng.shouldProcess({ key: 'openrtb', priority: 'high' });
    if (!th.ok) { metrics.incr('throttled'); return { id: br.id, seatbid: [], nbr: 8, retry_after_ms: th.retryAfterMs, _status: 503 }; }
  }
  const deadline = Date.now() + Number(process.env.OPENRTB_DEADLINE_MS || 300);
  const imp = (br.imp && br.imp[0]) || {};
  const floorMicros = Math.round((imp.bidfloor || 1.0) * 1e6);
  // OpenRTB 中 app.cat / imp.ext.cat 是「数组」，需归一化为字符串后再做品类匹配；否则数组.toUpperCase 直接抛错导致 worker 崩溃
  const _appCat = (br.app && br.app.cat) || (imp.ext && imp.ext.cat) || '';
  const appCatStr = Array.isArray(_appCat) ? (_appCat[0] || '') : String(_appCat || '');
  const ctx = {
    app_category: appCatStr,
    country: (br.device && br.device.geo && br.device.geo.country) || '',
    keywords: ((br.site && br.site.keywords) || '').split(',').filter(Boolean)
  };
  const ctxCat = (ctx.app_category || '').toLowerCase();
  const t0 = Date.now();
  // ── 身份解析：一次请求一台设备，解析出 canonical 设备标识供频控/跨App/模型使用 ──
  const idReq = identity.fromOpenRTB(br);
  const idRes = identity.resolve(idReq.ids, idReq.signals, { consented: idReq.consented, bundle: idReq.signals.bundle });
  const unitId = idRes.canonicalId || ((br.device && br.device.ext && br.device.ext.fp) || (br.device && br.device.ip) || '');
  // 受众信号自动采集（服务端，零用户打扰）：OS/机型取自 UA，兴趣取自 app 类目+关键词，仅更新内存累加器（无 I/O、零延迟），由 identity 周期落库
  try {
    const uaInfo = parseUA(br && br.device && br.device.ua);
    identity.observeContext(unitId, { os: uaInfo.os, model: uaInfo.model, app_category: ctxCat, keywords: ctx.keywords, country: ctx.country });
  } catch (e) {}
  // ── 品牌安全 pre-bid（供给侧上下文）：命中 GARM Floor 直接不参竞 ──
  const bsCtx = {
    publisher: (br.site && br.site.domain) || '', domain: (br.site && br.site.domain) || '',
    bundle: (br.app && br.app.bundle) || '', app_category: ctx.app_category, cat: ctxCat,
    keywords: ctx.keywords, title: (br.site && br.site.name) || '', description: (br.site && br.site.keywords) || '',
  };
  const bsSupply = brandSafety.classify(bsCtx);
  try {
    // ① 内存快照 + 倒排索引取候选（按品类/国家预过滤，零 DB / 零逐条 redis）。
    // 余额不足过滤、各 campaign 的品牌安全策略/当日消耗/转化系数/节奏配置/绑定创意均已预计算进快照(≤3s 延迟，RTB 标准做法)。
    if (!campaignStore.ready()) cache.incr('campaign_snapshot_cold');
    const rows = campaignStore.getCandidates(ctxCat, ctx.country);
    let best = null, fallback = null;   // best=相关性达标；fallback=相关性不足但其它均合规（保证合法请求都有应答，不空跑库存）
    for (const c of rows) {
      if (Date.now() > deadline) { cache.incr('openrtb_deadline'); break; } // 硬 deadline：宁可少算候选，也不超时丢标
      // P0 品类(vertical)隔离：campaign 有明确品类但与上下文品类不符 → 不参与，避免错配(游戏抢教育流量)
      const campCat = (c.app_category || '').toLowerCase();
      const catMatch = !campCat || campCat === 'all' || !ctxCat || campCat === ctxCat;
      if (!catMatch) continue;
      // P0 定向国家：campaign 限定国家但与请求国家不符 → 不参竞
      const geo = (c.geo_country || '').toUpperCase();
      if (geo && ctx.country && geo !== String(ctx.country).toUpperCase()) continue;
      // 定向设备类型：campaign 限定设备（1=移动/平板, 2=桌面）但与本次请求不符 → 不参竞
      if (!deviceTargetMatch(c.device_type, reqDeviceType(br))) { cache.incr('skip_device_target'); continue; }
      // 定向 OS（iOS/Android，自动采集）：campaign 限定 OS 但与本次请求不符 → 不参竞
      if (!osTargetMatch(c.os, reqOs(br))) { cache.incr('skip_os_target'); continue; }
      // 再营销：campaign 开启 retarget 时，只对「近 N 天见过本广告主广告」的设备参竞（设备级受众分群池，跨 worker 共享）
      if (Number(c.retarget) === 1 && !(await retarget.inPool(c.advertiser, unitId, c.retarget_window_days))) { cache.incr('retarget_skip'); continue; }
      // 兴趣定向：与自动采集的 app 类目/关键词匹配
      if (!interestTargetMatch(c.interest_target, ctxCat, ctx.keywords)) { cache.incr('interest_skip'); continue; }
      // Lookalike 相似人群：目标是与「见过本广告主广告的设备」画像相似的新设备
      if (Number(c.lookalike) === 1 && !retarget.lookalikeMatch(c.advertiser, reqOs(br), ctx.country)) { cache.incr('lookalike_skip'); continue; }
      // 底价过滤前移：低价计划不做无用的相关性/ML 计算（原 SQL 的 budget_micros>=floor 预裁，改为内存等价）
      if (Math.min(Number(c.target_cpm_micros) || 0, Number(c.budget_micros) || 0) < floorMicros) continue;
      const rel = lrRelevance(c, ctx, campaignStore, floorMicros);   // 同步多特征 LR（无 I/O）
      const score = rel.score;
      // P1 品牌安全：广告主策略（bcat/badv/GARM 分级）未通过 → 不参竞
      const bpol = campaignStore.policyOf(c.id) || { garmMaxTier: 4 };   // 预计算进快照，同步读取
      const bs = brandSafety.preBid(br, bpol, { ...bsCtx, iab: bsSupply.iab });
      if (bs.block) {
        cache.incr('brand_safety_skip');
        if (bs.reasons.some(r => r.code === 'GARM_FLOOR' || r.code === 'GARM_TIER')) brandSafety.logEvent(c.id, bsCtx.publisher, bs.reasons[0]).catch(() => {});
        continue;
      }
      // P1 Pacing v2：时段(daypart) → 频控(freq cap) → 预算节奏（含按流量曲线的软着陆系数）
      const spent = campaignStore.spendOf(c.id);   // 预计算进快照，同步读取
      const gate = await pacing.gate(c, spent, { deviceId: unitId, userId: idReq.ids.login_id, creativeId: 0 }, { delivery: campaignStore.deliveryOf(c.id) });
      if (!gate.ok) { cache.incr(gate.reason === 'FREQ_CAP' ? 'freq_cap_skip' : (gate.reason === 'OUT_OF_DAYPART' ? 'daypart_skip' : 'pacing_skip')); continue; }
      const base = Math.min(c.target_cpm_micros, c.budget_micros);
      if (base < floorMicros) continue;
      // ===== 多目标预估（pCTR / pCVR / pLTV）→ 出价 → 一价拍卖 shading =====
      const mlCtx = {
        campaign: c, cat: campCat, ctxCat, relScore: score,
        kwOverlap: score, format: (imp.ext && imp.ext.ad_type) || 'banner',
        geo: ctx.country, deviceType: (br.device && br.device.devicetype) || 0,
        floorMicros, targetCpm: c.target_cpm_micros, bidMicros: base,
        publisher: bsCtx.publisher, creativeId: 0,
        noPersonalization: !!(br.ext && br.ext.no_personalization),
        stats: { cImps: 0, cClicks: 0, cConv: 0, ageDays: 0 },
        hour: new Date().getHours(),
      };
      const pred = ml.mo.predict(c.id, ml.fs.compute(mlCtx));
      // 离线预训练权重接入在线：用真实公开集训(cold-start 先验)的 pCTR/pCVR 覆盖 LR 先验
      const np = neuralBridge.predict(c, { base, format: (imp.ext && imp.ext.ad_type) || 'banner', hour: mlCtx.hour });
      if (np) {
        pred.pctr = np.pctr; pred.pcvr = np.pcvr; pred.pctcvr = np.pctr * np.pcvr;
        pred.expected_value_micros = Math.round(np.pctr * np.pcvr * (pred.pltv_micros || 0));
        pred.neural = true;
      }
      const goalType = String(c.goal_type || 'CPM').toUpperCase();
      const goal = goalType === 'ROAS' ? { type: 'ROAS', targetRoas: Number(c.target_roas) || 1, targetCpmMicros: base }
        : goalType === 'CPA' ? { type: 'CPA', targetCpaMicros: Number(c.target_cpa_micros) || base, targetCpmMicros: base }
          : { type: 'CPM', targetCpmMicros: base };
      const bd = ml.mo.bidFor({
        pred, goal, floorMicros,
        maxBidMicros: Math.min(Number(c.target_cpm_micros) || 0, Number(c.budget_micros) || 0) * 3,
        // 学习化 eCPM：把「近 7 天点击→转化」表现折算成出价系数(0.7~1.3)真正乘进出价，
        // 打通「转化数据 → 出价」闭环。此前 perfFactor 定义了却从未被调用（死代码），
        // 导致"按历史转化自动校准出价"这最关键的一环是断的。
        bidAdjust: (gate.bidAdjust || 1) * (1 + 0.5 * score) * (campaignStore.perfOf(c.id) || 1) * (campaignStore.goalMultOf(c.id) || 1),
      });
      // 一价拍卖（br.at=1）才需要 shading；二价下 shading 只会降低胜率
      const shaded = bidEng.shade({
        valueMicros: bd.bidMicros, floorMicros, ctx: { publisher: bsCtx.publisher, format: mlCtx.format, country: ctx.country },
        auctionType: Number(br.at || 2),
      });
      const bidMicros = shaded.skipped ? 0 : (shaded.bidMicros || bd.bidMicros);
      if (bidMicros <= 0) { cache.incr('shading_skip'); continue; }
      // 广告主出价底价（bid_floor_micros，默认 0=不限）：低于底价不参竞，保量并守住 eCPM
      if (Number(c.bid_floor_micros || 0) > 0 && bidMicros < Number(c.bid_floor_micros)) { cache.incr('bid_floor_skip'); continue; }
      // 旧模型出价仅作灰度/回退对照，不参与决策；且移出热循环，只对最终赢家算一次
      // （原先对全部候选各算一次 featureVector+modelMul，纯属浪费 CPU）
      const cand = {
        c, bidMicros, score, source: rel.source,
        pcvr: pred.pcvr, pctr: pred.pctr, pltv: pred.pltv_micros, pctcvr: pred.pctcvr,
        shade: shaded.shade, pWin: shaded.pWin, basis: bd.basis, bidAdjust: gate.bidAdjust, lowRel: score < MIN_RELEVANCE,
      };
      // 相关性达标优先；不足时进入兜底（仍出价并标记 lowRel 便于风控/回收），绝不空跑合法请求
      if (score >= MIN_RELEVANCE) { if (!best || bidMicros > best.bidMicros) best = cand; }
      else if (!fallback || bidMicros > fallback.bidMicros) fallback = cand;
    }
    metrics.observe('dsp_latency', Date.now() - t0);
    cache.observe('dsp_latency', Date.now() - t0);
    best = best || fallback;   // 兜底：相关性不足的合规库存也能应答，避免 demo/通用请求空跑
    if (!best) return { id: br.id, seatbid: [], nbr: 2 };   // nbr=2 无效竞价请求（无广告可投）
    // 旧模型对照特征/系数只对赢家算一次（热循环内已对全部候选移除重复计算）
    best.fx = bidModel.featureVector(best.c, { ...ctx, _relScore: best.score });
    best.modelMul = bidModel.modelMul(best.c.id, best.fx);
    // P1 创意引擎：该 campaign 有多个 active 创意时做 A/B 选版（Thompson Sampling 自动优选）
    // 计划↔素材库 强关联：若计划锁定了 creative_id，优先下发该素材库创意（并绑定到本计划）
    let cv = null;
    if (best.c.creative_id) cv = campaignStore.creativeOf(best.c.id);   // 预计算进快照，同步读取（替代原 per-请求 DB 查询）
    if (!cv) cv = await creativeAb.pick(best.c.id, (imp.ext && imp.ext.ad_type) || 'banner').catch(() => null);
    const adm = cv ? (cv.content || best.c.creative_html) : best.c.creative_html;
    const crid = cv ? String(cv.id) : String(best.c.id);      // crid=创意版本 id → 后续统计可归因
    const landing = (cv && cv.landing_url) || best.c.landing_url;
    // 命中即入再营销池：该设备(counted by unitId)后续可被本广告主的再营销计划命中（只更新内存，无 I/O）
    try { if (unitId) retarget.observeExposure(best.c.advertiser, best.c.id, unitId, { os: reqOs(br), country: ctx.country }); } catch (e) {}
    return {
      id: br.id,
      seatbid: [{
        seat: 'zhuque',
        bid: [{
          id: 'bid1', impid: imp.id, price: best.bidMicros,
          adm, crid, cid: String(best.c.id),
          ext: {
            cid: best.c.id, advertiser: best.c.advertiser || '',
            intent_score: best.score, intent_source: best.source,
            model_mul: Number(best.modelMul.toFixed(3)), pcvr: Number(best.pcvr.toFixed(4)), feat: best.fx, landing,
            variant_id: cv ? cv.id : null,
            adm_type: (imp.ext && imp.ext.ad_type) || (cv ? cv.format : 'html'),
            ad_format: cv ? String(cv.format) : (best.c.format || 'html'),
            // 新增：多目标预估与 shading 可解释字段（买方/广告主审计用）
            pctr: best.pctr, pctcvr: best.pctcvr, pltv_micros: best.pltv,
            bid_basis: best.basis, shade: best.shade, p_win: best.pWin, bid_adjust: best.bidAdjust,
            canonical_id: idRes.canonicalId, garm_tier: bsSupply.garmTier,
          }
        }]
      }]
    };
  } catch (e) { return { _error: e.message }; }
}

// 汇总外部需求方（非自有 DSP）出价：供 /openrtb2/bid 与 SSP 复用，体现简化版 Waterfall 的 eCPM 提升。
// 仅拉取已注册的非自有/非 mock 需求方；real 模式下的自有 HTTP 需求方走 SSP 的 /ssp/bid 转发路径。
async function gatherExternalBids(br) {
  const ext = (br.imp && br.imp[0] && br.imp[0].ext) || {};
  const partners = ext.ownOnly ? [] : DEMAND_PARTNERS.filter(p => p.type !== 'local' && p.type !== 'mock');
  const resps = await bidEng.deadlineAll(partners.map(async (p) => {
    try {
      if (p.type === 'oceanengine') return await oeDSP.bid(br);   // 巨量引擎：sim 模拟 / real 开放平台
      if (p.type === 'generic') return await genericDSP.bid(br);  // 通用 OpenRTB 需求方
      if (p.type === 'mintegral') { cache.incr('demand_mintegral'); return await mintegralDSP.bid(br); } // Mintegral 外部 Bidding 网络
      if (p.type === 'adcolony') { cache.incr('demand_adcolony'); return await adcolonyDSP.bid(br); }   // AdColony 外部 Bidding 网络
    } catch (e) { console.error('ext dsp err', p.name, e.message); }
    return null;
  }));
  const out = [];
  resps.forEach(r => { if (r && r.seatbid) r.seatbid.forEach(s => (s.bid || []).forEach(b => out.push({ seat: s.seat, bid: b, micros: b.price || 0 }))); });
  return out;
}
// /openrtb2/bid 端点：把请求转交给进程内评分内核（外部买方/媒体也可直接打此端点）。
// 简化版 Waterfall：自有需求无匹配时（或外部出价更高时）纳入 Mintegral/AdColony/通用 等外部需求方，抬高清算价。
app.post('/openrtb2/bid', async (req, res) => {
  const br = req.body || {};
  const body = await scoreOwnDemand(br);
  if (body._error) return res.status(500).json({ error: body._error });
  if (body._status === 503) return res.status(503).json(body);
  const impid = (br.imp && br.imp[0] && br.imp[0].id) || 'imp';
  const own = (body.seatbid && body.seatbid[0] && body.seatbid[0].bid && body.seatbid[0].bid[0]) || null;
  // Fix-04：把所有参拍方（自有 + 外部）汇成一张候选表，再决定赢家。
  // 此前只把「自有 vs 外部最高价」二选一返回单个 seat，且根本不暴露参拍方 →
  // 首页承诺"4 家 DSP 同场二价拍卖"，用户调用后只看到 1 个 seat，无法当场验证（走查报告 N-P0-6）。
  const cands = [];
  if (own) cands.push({ seat: (body.seatbid[0] && body.seatbid[0].seat) || 'zhuque-dsp', bid: own, micros: Number(own.price) || 0 });
  try {
    (await gatherExternalBids(br)).forEach((e) => cands.push({ seat: e.seat, bid: e.bid, micros: e.micros }));
  } catch (e) { /* 外部需求方失败不阻塞自有出价 */ }
  cands.sort((a, b) => b.micros - a.micros);
  const seats = cands.map((c) => ({ seat: c.seat, bid_micros: c.micros }));
  const waterfall = {
    participants: seats.map((s) => s.seat), participant_count: seats.length,
    seats, winner: cands.length ? cands[0].seat : '',
    second_price_micros: cands.length > 1 ? cands[1].micros : 0,
    auction: AUCTION.secondPrice ? 'second_price' : 'first_price',
    note: 'OpenRTB 响应按规范只回胜出 seat；此处如实回传本次全部参拍方与各自出价，可直接验证"几家同场"',
  };
  if (!cands.length) return res.json(Object.assign({}, body, { ext: { waterfall } }));
  const win = cands[0];
  return res.json({
    id: br.id, cur: 'CNY',
    seatbid: [{ seat: win.seat, bid: [Object.assign({}, win.bid, { impid })] }],
    ext: { waterfall },
  });
});
// Fix-04：首页文案的实时真源 —— 实际接入并参拍的需求方列表（不是写死在 HTML 里的营销话术）
app.get('/api/dsp/active', (_, res) => {
  res.json({
    auction: AUCTION.secondPrice ? 'second_price' : 'first_price',
    count: DEMAND_PARTNERS.length,
    external_count: DEMAND_PARTNERS.filter((p) => !p.isOwn).length,
    partners: DEMAND_PARTNERS.map((p) => ({ name: p.name, type: p.type, isOwn: !!p.isOwn, payoutRate: p.payoutRate })),
    note: '每次 /openrtb2/bid 响应的 ext.waterfall 会回传本次真实参拍座席与各自出价',
  });
});

// ===== 供给方：SSP（OpenRTB 端点，多 DSP 并发拍卖）=====
const pubMetaCache = new Map(); // domain -> {rate,cat,geo,keywords}（内存快取；底层由 cache 持久化到 Redis）
// 竞价热路径配置内存快照：bs_blacklist / waterfall_rules / ab_experiments 变更频率低(秒级)，
// 但原实现每请求同步查库(单次~130ms)，直接决定 p99。改为内存缓存+过期回源，命中即返回。
const _cfgMemo = new Map();
async function memoQuery(key, ttlMs, sql, params) {
  const hit = _cfgMemo.get(key);
  if (hit) {
    if (Date.now() - hit.ts < ttlMs) return hit.val;            // 新鲜：直接返回
    setImmediate(() => {                                        // 过期：后台刷新，本次仍返回旧值(不阻塞)
      pool.query(sql, params || []).then(([rows]) => _cfgMemo.set(key, { ts: Date.now(), val: rows || [] })).catch(() => {});
    });
    return hit.val;
  }
  try {                                                          // 首次：同步加载
    const [rows] = await pool.query(sql, params || []);
    _cfgMemo.set(key, { ts: Date.now(), val: rows || [] });
    return rows || [];
  } catch (e) { return []; }
}
async function getPub(domain) {
  if (pubMetaCache.has(domain)) return pubMetaCache.get(domain);
  const cm = await cache.get('pub:' + domain).catch(() => null); // Redis 命中 → 重启也不丢
  if (cm) { pubMetaCache.set(domain, cm); return cm; }
  try {
    const [[p]] = await pool.query('SELECT payout_rate,cat,geo,keywords FROM publishers WHERE domain=?', [domain]);
    const meta = p ? {
      rate: Number(p.payout_rate) || 0.70,
      cat: p.cat || '', geo: p.geo || '', keywords: (p.keywords || '').split(',').filter(Boolean),
    } : { rate: 0.70, cat: '', geo: '', keywords: [] };
    pubMetaCache.set(domain, meta);
    cache.set('pub:' + domain, meta, 5 * 60 * 1000).catch(() => {});
    return meta;
  } catch (e) { return { rate: 0.70, cat: '', geo: '', keywords: [] }; }
}
app.post('/ssp/bid', async (req, res) => {
  const ip = req.ip || (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (rateHit(ip)) return res.status(429).json({ error: 'rate limited' }); // 反作弊：单 IP 频率限制
  // 容量节流：QPS 超限或 p99 恶化时主动降载，宁可少接也不能把全站拖成超时雪崩
  const th = bidEng.shouldProcess({ key: 'ssp', priority: 'normal' });
  if (!th.ok) { metrics.incr('throttled'); return res.status(503).json({ id: (req.body || {}).id, seatbid: [], nbr: 8, retry_after_ms: th.retryAfterMs }); }
  const t0 = Date.now(); cache.incr('bid_requests'); metrics.incr('bid_requests');
  // 竞价端到端延迟观测（SLO: p99<10ms）：包裹 res.json，任何返回路径都计入，供 /metrics 与 /api/console/slo 断言
  const _respJson = res.json.bind(res);
  res.json = (body) => { try { metrics.observe('bid', Date.now() - t0); } catch (e) {} return _respJson(body); };
  const br = req.body || {};
  if (!br.id) return res.status(400).json({ error: 'missing id' });
  const publisher = (br.site && br.site.domain) || 'unknown';
  const pub = await getPub(publisher);                 // 媒体方画像(含 supply crawler 回填的 cat/geo)
  // ① 竞价请求留痕（填充率的分母）：无论最终有无填充，请求都要计数，否则算不出填充率
  enqueueLog('req', [String(br.id || ''), String(publisher),
    String(((br.imp && br.imp[0] && br.imp[0].ext) ? br.imp[0].ext.ad_unit_id : '') || '').slice(0, 32)]);
  // ⑤ 品牌安全黑名单：命中即不参拍（pre-bid 屏蔽），而不是"先曝光再下架"
  try {
    const [bl] = await memoQuery('bs:' + publisher, 15000, "SELECT kind,value FROM bs_blacklist WHERE enabled=1 AND scope IN ('*',?)", [publisher]);
    const kw = String((br.site && br.site.keywords) || '');
    const hit = (bl || []).find(function (x) {
      if (x.kind === 'domain') return String(publisher).toLowerCase().indexOf(String(x.value).toLowerCase()) >= 0;
      if (x.kind === 'keyword') return kw.toLowerCase().indexOf(String(x.value).toLowerCase()) >= 0;
      return false;
    });
    if (hit) { cache.incr('bs_blacklist_blocked'); return res.json({ id: br.id, seatbid: [], nbr: 3 }); }
  } catch (e) {}
  // P1 隐私同意(GDPR/CCPA)透传：从 OpenRTB regs / user.consent 取，落库用于合规审计
  const consent = (br.user && br.user.consent) || '';
  const regs = br.regs ? JSON.stringify(br.regs) : '';
  // P2 竞价侧设备频次风控：单设备窗口内竞价超阈值 → 设备农场嫌疑
  const devFp = (br.device && br.device.ext && br.device.ext.fp) || (br.imp && br.imp[0] && br.imp[0].ext && br.imp[0].ext.device_fp) || '';
  const fr = bidFpRisk(devFp, ip);
  if (!fr.ok) return res.status(429).json({ error: 'device risk', why: fr.reason });
  // P1 底价优化：媒体方未设底价时，用该媒体方近期清盘价 EMA 作为建议底价（动态底价）
  const imp0 = (br.imp && br.imp[0]) || {};
  if (!imp0.bidfloor || Number(imp0.bidfloor) <= 0) {
    const sf = pubFloor[publisher];
    if (sf) imp0.bidfloor = Math.max(0.5, +(sf * 0.9 / 1e6).toFixed(4));
  }
  // 供给上下文补全：媒体方 SDK 未带 cat/geo 时，用已爬取的画像补全 → 提升意图匹配 eCPM
  const imp = (br.imp && br.imp[0]) || {};
  br.imp = br.imp || [imp];
  if (!imp.ext) imp.ext = {};
  if (!imp.ext.cat && pub.cat) imp.ext.cat = pub.cat;
  if (!(br.device && br.device.geo && br.device.geo.country) && pub.geo) {
    br.device = br.device || {}; br.device.geo = br.device.geo || {}; br.device.geo.country = pub.geo;
  }
  const kw = ((br.site && br.site.keywords) || '').split(',').filter(Boolean);
  if (pub.keywords.length && !kw.length) { br.site = br.site || {}; br.site.keywords = pub.keywords.join(','); }
  // 身份解析（供给侧同样需要：频控、跨 App 识别、设备级反作弊都依赖 canonical 设备标识）
  const idReqS = identity.fromOpenRTB(br);
  const idResS = identity.resolve(idReqS.ids, idReqS.signals, { consented: idReqS.consented, bundle: idReqS.signals.bundle });
  // 品牌安全：供给侧命中 GARM Floor（色情/暴力/仇恨等零容忍内容）→ 直接不卖，保护所有广告主
  const bsSup = brandSafety.classify({
    publisher, domain: publisher, bundle: (br.app && br.app.bundle) || '',
    app_category: imp.ext.cat || '', keywords: kw, title: (br.site && br.site.name) || '',
  });
  if (bsSup.garmTier === 0) {
    metrics.incr('brand_safety_blocked');
    brandSafety.logEvent(0, publisher, { code: 'GARM_FLOOR', detail: bsSup.floorHit }).catch(() => {});
    return res.json({ id: br.id, seatbid: [], nbr: 3 });   // nbr=3 无效请求（未通过审核/政策）
  }
  // 反作弊门禁：黑名单 → bot 信号 → 频率异常 → 曝光上限（平台级流量质量管控）
  try {
    const acResult = await anticheat.check({
      deviceId: (idResS.canonicalId || ''),
      ip: ip,
      publisher: publisher,
      device: br.device || {},
      user: br.user || {},
      ua: (br.device && br.device.ua) || '',
    });
    if (!acResult.ok) {
      cache.incr('anticheat_blocked');
      anticheat.recordBlock(idResS.canonicalId || '', ip).catch(() => {});
      for (const r of acResult.reasons) {
        anticheat.logEvent({
          device_id: idResS.canonicalId || '',
          ip: ip,
          publisher: publisher,
          reason: r.code,
          action: r.severity === 'warn' ? 'warn' : 'block',
          detail: r.detail || '',
        }).catch(() => {});
      }
      return res.json({ id: br.id, seatbid: [], nbr: 3, ext: { anticheat: acResult.detail } });
    }
    for (const r of acResult.reasons) {
      if (r.severity === 'warn') {
        cache.incr('anticheat_warn');
        anticheat.logEvent({
          device_id: idResS.canonicalId || '',
          ip: ip,
          publisher: publisher,
          reason: r.code,
          action: 'warn',
          detail: r.detail || '',
        }).catch(() => {});
      }
    }
  } catch (e) { /* 反作弊检查失败不阻塞竞价（fail-open） */ }
  // 竞价总 deadline：到点即返回已到达的出价，p99 不再被最慢的 partner 决定
  // 库存范围开关：公开落地页广告位带 ownOnly 时，只让「自有」需求方参与，
  // 外部/Kuaishou 演示创意不进公开页面；管理台/演示页走完整多需求方竞价（竞价引擎逻辑不变）。
  let partners = (imp.ext && imp.ext.ownOnly) ? DEMAND_PARTNERS.filter(p => p.isOwn) : DEMAND_PARTNERS.slice();
  // ② Waterfall：按 (scope, ad_unit, country) 的规则给需求源排序——默认并发拍卖，有规则则按 position 定序
  try {
    const auidW = String(((br.imp && br.imp[0] && br.imp[0].ext) ? br.imp[0].ext.ad_unit_id : '') || '');
    const [wr] = await memoQuery('wf:' + publisher + ':' + auidW, 15000, 'SELECT demand_source,position FROM waterfall_rules WHERE enabled=1 AND scope IN (?,?) AND (ad_unit_id=? OR ad_unit_id="") ORDER BY position ASC, id ASC', [publisher, '*', auidW]);
    if (wr && wr.length) {
      const pos = {}; wr.forEach(function (r) { if (pos[r.demand_source] == null) pos[r.demand_source] = Number(r.position); });
      partners = partners.slice().sort(function (a, b) {
        const pa = pos[a.name] != null ? pos[a.name] : 999, pb = pos[b.name] != null ? pos[b.name] : 999;
        return pa - pb;
      });
    }
  } catch (e) {}
  // ③ A/B：按请求 id 稳定分桶，demand_source 组直接裁剪参与方；bid_floor / ecpm_weight 由变体参数生效
  let abExp = null, abVariant = null;
  try {
    const [exps] = await memoQuery('abexp', 30000, 'SELECT * FROM ab_experiments WHERE status=1 ORDER BY id DESC LIMIT 1');
    if (exps && exps[0]) {
      abExp = exps[0];
      const cfg = safeJson(abExp.config) || {};
      const variants = cfg.variants || [];
      if (variants.length) {
        const h = crypto.createHash('sha1').update(String(br.id || '') + String(abExp.id)).digest('hex');
        abVariant = variants[parseInt(h.slice(0, 8), 16) % variants.length];
        if (abVariant && abExp.kind === 'demand_source' && Array.isArray(abVariant.demand_sources)) {
          const allow = abVariant.demand_sources;
          partners = partners.filter(function (p) { return allow.indexOf(p.name) >= 0; });
        }
        // bid_floor 组：把变体倍率写进转发请求的 bidfloor，让自有 DSP 真正按新底价过滤
        // （此前只记录曝光、不改变行为，属于"假实验"）
        if (abVariant && abExp.kind === 'bid_floor' && Number(abVariant.floor_mul) > 0) {
          const mul = Number(abVariant.floor_mul);
          (br.imp || []).forEach(function (x) {
            if (!x) return;
            const base = Number(x.bidfloor) > 0 ? Number(x.bidfloor) : 1.0;
            x.bidfloor = Number((base * mul).toFixed(4));
          });
        }
      }
    }
  } catch (e) {}
  const responses = await bidEng.deadlineAll(partners.map(async (p) => {
    if (p.type === 'mock') {
      const imp = (br.imp && br.imp[0]) || {};
      return { seatbid: [{ seat: p.name, bid: [{ id: 'b-mock', impid: imp.id, price: p.priceMicros, adm: p.adm, crid: p.crid, cid: 0, ext: { cid: 0 } }] }] };
    }
    if (p.type === 'oceanengine') {
      try { return await oeDSP.bid(br); }   // 巨量引擎买量：sim 模拟出价；real 走开放平台
      catch (e) { console.error('oceanengine dsp err', e.message); return null; }
    }
    if (p.type === 'generic') {
      try { return await genericDSP.bid(br); }   // 通用 OpenRTB 需求方：基于估值模型实时出价
      catch (e) { console.error('generic dsp err', e.message); return null; }
    }
    if (p.type === 'mintegral') {
      try { cache.incr('demand_mintegral'); return await mintegralDSP.bid(br); } // Mintegral 外部 Bidding 网络（简化版 Waterfall）
      catch (e) { console.error('mintegral dsp err', e.message); return null; }
    }
    if (p.type === 'adcolony') {
      try { cache.incr('demand_adcolony'); return await adcolonyDSP.bid(br); }   // AdColony 外部 Bidding 网络（简化版 Waterfall）
      catch (e) { console.error('adcolony dsp err', e.message); return null; }
    }
    if (p.type === 'local' && typeof p.bid === 'function') {
      try { return await p.bid(br, { internal: true }); }   // 进程内自有 DSP：去自回环 HTTP，省一次往返 + 并发翻倍
      catch (e) { console.error('local dsp err', p.name, e.message); return null; }
    }
    // 外部 HTTP 需求方：熔断 + 短超时（deadlineAll 只等 100ms，10s 超时毫无意义且堆积资源）
    const pbl = partnerBreaker.get(p.name);
    if (pbl && pbl.until > Date.now()) { cache.incr('demand_breaker_skip'); return null; }
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), Number(process.env.DSP_HTTP_TIMEOUT_MS || 800));
    try {
      const r = await fetch(p.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(br), signal: ctrl.signal });
      clearTimeout(to);
      partnerBreaker.delete(p.name);
      return await r.json();
    } catch (e) {
      clearTimeout(to);
      const cur = partnerBreaker.get(p.name) || { fails: 0, until: 0 };
      cur.fails++;
      if (cur.fails >= 3) { cur.until = Date.now() + 60000; cur.fails = 0; cache.incr('demand_breaker_open'); console.error('[demand] partner 熔断(60s)', p.name, p.url); }
      return null;
    }
  }));
  const allBids = [];
  responses.forEach((resp, idx) => {
    if (!resp) return;
    const partner = partners[idx];
    (resp.seatbid || []).forEach(seat => (seat.bid || []).forEach(bid => allBids.push({ partner, seat, bid, micros: bid.price || 0 })));
  });
  // P1 统一竞价增强：聚合外部 SSP（类 AppLovin MAX 的"中介聚合多供给"）；SUPPLY_PARTNERS 默认空则不生效
  const supplyPartners = safeJson(process.env.SUPPLY_PARTNERS) || [];
  let sres = [];
  if (Array.isArray(supplyPartners) && supplyPartners.length) {
    try {
      sres = await Promise.all(supplyPartners.map(async (sp) => {
        try {
          const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), 10000);
          const r = await fetch(sp.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(br), signal: ctrl.signal });
          clearTimeout(to); return { sp, json: await r.json() };
        } catch (e) { console.error('supply err', sp.name, e.message); return null; }
      }));
      sres.forEach((s) => {
        if (!s || !s.json) return;
        (s.json.seatbid || []).forEach(seat => (seat.bid || []).forEach(bid => allBids.push({ partner: { name: s.sp.name, isOwn: false }, seat, bid, micros: bid.price || 0 })));
      });
    } catch (e) {}
  }
  if (!allBids.length) return res.json({ id: br.id, seatbid: [] });
  allBids.sort((a, b) => b.micros - a.micros);
  const best = allBids[0];
  // ① 各需求方出价留痕（胜率的分母=参与次数）：只记 seat 名与价格，不记素材内容
  (function () {
    const rid = String(br.id || '');
    for (let bi = 0; bi < allBids.length; bi++) {
      const it = allBids[bi];
      pool.query('INSERT INTO bid_bid_log (req_id,imp_id,partner,price_micros,won) VALUES (?,?,?,?,?)',
        [rid, String((it.bid && it.bid.impid) || ''), String((it.partner && it.partner.name) || 'unknown'),
         Number(it.micros) || 0, bi === 0 ? 1 : 0]).catch(() => {});
    }
  })();
  const second = allBids.length > 1 ? allBids[1].micros : best.micros;
  const winMicros = AUCTION.secondPrice ? Math.min(best.micros, second + 10000) : best.micros; // 清盘价
  const grossMicros = winMicros;                              // SSP 向需求方实收(清盘价)
  const payoutMicros = Math.round(winMicros * pub.rate);      // 给媒体分成(媒体方独立费率)
  if (best.partner.isOwn) { // 自有 DSP：广告主按「二价清盘价」付费（不是自己的出价），避免虚高
    try {
      const notifyBody = {
        cid: best.bid.cid || (best.bid.ext && best.bid.ext.cid), crid: best.bid.crid,
        impid: best.bid.impid, reqid: String(br.id || ''), price: winMicros, win: true
      };
      notifyBody.sig = security.notifySignature(notifyBody);
      const notifyResponse = await fetch(`http://127.0.0.1:${PORT}/notify`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        // 带上请求 id：结算去重改按 (req_id, impid) 复合身份，避免"重复使用同一 slot 名的新请求"被误判为重放而漏扣广告主费用
        body: JSON.stringify(notifyBody)
      });
      const notifyResult = await notifyResponse.json().catch(() => ({}));
      if (!notifyResponse.ok || !notifyResult.counted || notifyResult.insufficient) {
        return res.json({ id: br.id, seatbid: [], nbr: 3, note: '账户余额或计划预算不足，未返回广告' });
      }
    } catch (e) {
      return res.status(503).json({ id: br.id, seatbid: [], nbr: 8, note: '计费服务不可用，已停止返回广告' });
    }
  }
  recordSsp(grossMicros, payoutMicros, publisher);
  // 胜率模型：只用已确认计费的结果拟合市场分布。
  bidEng.onAuctionEnd({
    publisher, format: String((imp.ext && imp.ext.ad_type) || 'banner').toLowerCase(),
    country: (br.device && br.device.geo && br.device.geo.country) || '',
  }, winMicros, true, best.micros);
  // 媒体应付累计：仅在广告主扣费确认后计提。
  billing.accruePublisher(publisher, payoutMicros, 'WIN:' + String(br.id || '')).catch(() => {});
  // 外部 DSP 真实扣账：非自有需求方胜出时，按其清盘价记下「应收」（对方按此向我们结算），
  // 不再"暂不开放"。同一 (imp_id, req_id) 复合唯一键保证幂等，重复回放不会重复计应收。
  if (!best.partner.isOwn) {
    pool.query(
      'INSERT INTO dsp_settlement (partner,imp_id,req_id,gross_micros,payable_micros,platform_fee_micros,status) VALUES (?,?,?,?,?,?,?) ' +
      'ON DUPLICATE KEY UPDATE gross_micros=VALUES(gross_micros)',
      [String(best.partner.name || 'unknown'), String(best.bid.impid), String(br.id || ''),
       winMicros, payoutMicros, winMicros - payoutMicros, 'PENDING']).catch(() => {});
  }
  const winBid = { ...best.bid, price: winMicros };
  const bestCid = best.bid.cid || (best.bid.ext && best.bid.ext.cid);
  // 每次胜出均落库（按媒体方归因），用于持久化结算/报表（重启不丢、按 publisher 追溯）
  // 落地特征向量（供在线模型回流训练）；外部 DSP 无 feat 时为 null
  const winFeat = (best.bid.ext && Array.isArray(best.bid.ext.feat)) ? JSON.stringify(best.bid.ext.feat) : null;
  // 广告单元归因：取「本次胜出的那个 imp」上携带的 ad_unit_id（SDK 由 data-ad-unit 上报）
  var winImp = null;
  for (var wi = 0; wi < (br.imp || []).length; wi++) {
    if (String((br.imp[wi] || {}).id) === String(best.bid.impid)) { winImp = br.imp[wi]; break; }
  }
  const adUnitId = String(((winImp && winImp.ext) ? winImp.ext.ad_unit_id : '') || '').slice(0, 32);
  // ④ 频控 / 刷新 / 尺寸：按广告单元下发给 SDK 本地执行（服务端替客户端计数不可靠，只能下发策略）
  // ③ A/B 曝光留痕：把本次曝光与结果记到所属变体，供 /api/ab/results 汇总
  if (abExp && abVariant) {
    pool.query('INSERT INTO ab_exposure (exp_id,variant_key,imp_id,won,price_micros) VALUES (?,?,?,?,?)',
      [abExp.id, String(abVariant.key || 'A'), String(best.bid.impid), 1, winMicros]).catch(() => {});
  }
  // 赢价日志：走内存缓冲批量落库（非阻塞，竞价响应不再等 MySQL 往返）
  // 曝光维度入湖：设备 / 地域 / 广告形态（供分维度看数、ROI 与模型训练）
  const winDevice = reqDeviceType(br) || String((br.device && br.device.devicetype) || 0);
  const winCountry = String((br.device && br.device.geo && br.device.geo.country) || '').toUpperCase();
  const winFormat = String((imp.ext && imp.ext.ad_type) || 'banner').toLowerCase();
  // OS / 机型：服务端解析 UA 自动采集，不需要用户填写、不影响体验
  const _ua = parseUA(br.device && br.device.ua);
  // device_id = canonical 设备标识（identity_graph 加盐哈希）：支撑真频次(reach/frequency)聚合，无原始 PII
  const winDeviceId = idResS && idResS.canonicalId ? idResS.canonicalId : '';
  enqueueLog('win', [Number(bestCid) || 0, Number(best.bid.crid) || 0, String(best.bid.impid), String(br.id || ''), winMicros, publisher, consent, winFeat, adUnitId, winDevice, winCountry, winFormat, _ua.os, _ua.model, winDeviceId]);
  anticheat.observeImpression(winDeviceId).catch(() => {}); // 反作弊：更新设备 24h 曝光计数
  creativeAb.bump(String(best.bid.impid), 'impressions').catch(() => {}); // A/B：本次曝光计入所服务创意版本
  // 素材自动轮换：按创意 id 直接记账曝光+花费，驱动"预算/曝光在多素材间自动分配"（fairness 权重）
  creativeAb.credit(Number(best.bid.crid) || 0, { impressions: 1, spendMicros: winMicros }).catch(() => {});
  // 特征落库（离线训练样本源）：写入即与在线同一套 compute()，天然无 training-serving skew。
  // 采样写入，避免高 QPS 下把特征日志表打爆（采样率随负载自适应）
  if (Math.random() < bidEng.throttle.sampleRate('feature_log', Number(process.env.FEATURE_LOG_RATE || 0.2))) {
    ml.onImpression(String(best.bid.impid), Number(bestCid) || 0, {
      campaign: { app_category: imp.ext && imp.ext.cat, target_cpm_micros: 0 },
      ctxCat: (imp.ext && imp.ext.cat) || '', format: String((imp.ext && imp.ext.ad_type) || 'banner'),
      geo: (br.device && br.device.geo && br.device.geo.country) || '',
      publisher, floorMicros: Math.round((imp0.bidfloor || 0) * 1e6),
      deviceType: (br.device && br.device.devicetype) || 0,
      noPersonalization: !!(br.ext && br.ext.no_personalization),
    }).catch(() => {});
  }
  // 激励视频：服务端签发一次性签名令牌，前端 SDK 只能上报、无法自证完播
  const fmt = String((imp.ext && imp.ext.ad_type) || ((imp.ext && imp.ext.reward) ? 'rewarded' : '') || 'banner');
  // 设备指纹：SDK/客户端随竞价上报，写入令牌实现"设备绑定"，跨设备重放将被拒
  const rwFp = (imp.ext && imp.ext.device_fp) || (br.device && br.device.ext && br.device.ext.fp) || '';
  if (fmt === 'rewarded') {
    const rw = rwIssue(best.bid.impid, bestCid, publisher, rwFp);
    // 行业标准：视频广告返回 VAST 4.0 XML；imp.ext.protocol='html' 时可退回 HTML 创意
    const useVast = imp.ext.protocol !== 'html';
    // 优先用广告主素材库里的真实视频（此前永远硬编码 RW_MEDIA，广告主上传的素材根本不生效）
    let rwMedia = RW_MEDIA, rwDur = RW_DURATION, rwTitle = bestCid ? ('AppLink-' + bestCid + ' 激励视频') : 'rewarded-ad';
    let ownVast = '';
    try {
      const rwCr = await pickCreative(bestCid, 'rewarded', { publisher, keyword: kw.join(',') });
      if (rwCr) {
        if (rwCr.type === 'vast' && rwCr.content) ownVast = rwCr.content;   // 完整 VAST 直接采用
        if (rwCr.mediaUrl) rwMedia = rwCr.mediaUrl;
        if (rwCr.title) rwTitle = rwCr.title;
        if (rwCr.id) winBid.crid = String(rwCr.id);
      }
    } catch (e) {}
    // 外部 DSP 的 sim 模式只回 `<!-- placeholder -->` 这类空壳 adm（演示里就是一个空白视频位）。
    // 胜出方没给出带 <MediaFile> 的可用 VAST 时，用广告主素材 / 平台兜底素材重建，绝不下发空壳。
    const curAdm = String(winBid.adm || '');
    const externalVastOk = curAdm.indexOf('<MediaFile') >= 0;
    if (useVast && (ownVast || !externalVastOk)) {
      let vast = ownVast || buildVast({
        impid: rw.impid, cid: rw.cid,
        title: rwTitle, mediaUrl: rwMedia, duration: rwDur
      });
      // 第三方可见性验证（IAS / DoubleVerify / Moat / OMID）注入 VAST <AdVerifications>
      const bpol = await brandSafety.policy(bestCid).catch(() => brandSafety.DEFAULT_POLICY);
      const vscripts = brandSafety.verificationScripts(bpol, rw.impid);
      if (vscripts.length) vast = brandSafety.injectVerifications(vast, vscripts, { impid: rw.impid, cid: rw.cid, pub: publisher });
      winBid.adm = vast;
    }
    winBid.ext = Object.assign({}, best.bid.ext, {
      rw, rw_min_ratio: RW_MIN_RATIO, rw_ttl_ms: RW_TTL_MS,
      ad_type: 'rewarded', ad_format: 'rewarded', adm_type: useVast ? 'vast4' : 'html'
    });
    await pool.query('INSERT IGNORE INTO rw_token (imp_id,campaign_id,publisher,device_fp) VALUES (?,?,?,?)', [rw.impid, rw.cid, publisher, rw.fp || '']).catch(() => {});
  } else if (fmt !== 'banner') {
    // 其它形态：插屏 / 开屏 / 原生 / icon / push（优先用素材库真实创意，否则合成占位）
    const [[ccRow]] = await pool.query('SELECT creative_id FROM adv_campaign WHERE id=?', [bestCid]).catch(() => [[]]);
    const cr = await pickCreative(bestCid, fmt, { publisher, keyword: kw.join(',') }, ccRow && ccRow.creative_id);
    // 应用内 View 需要的坐标容器：真实创意与合成模板共用同一份几何信息
    const viewGeo = {
      activity: (imp.ext && (imp.ext.activity || imp.ext.activity_name || imp.ext.activityName)) || 'com.example.MainActivity',
      x: (imp.ext && (imp.ext.x || imp.ext.px)) || 40,
      y: (imp.ext && (imp.ext.y || imp.ext.py)) || 120,
      w: (imp.ext && (imp.ext.w || imp.ext.width)) || 300,
      h: (imp.ext && (imp.ext.h || imp.ext.height)) || 140,
    };
    if (creativeFits(cr, fmt)) {
      winBid.crid = String(cr.id); // A/B 归因到具体创意（而非仅 campaign）
      if (cr.type === 'vast') {
        winBid.adm = cr.content;
        winBid.ext = Object.assign({}, best.bid.ext, { ad_format: fmt, adm_type: 'vast4' });
      } else if (cr.type === 'native') {
        const nat = Object.assign(buildNative({ cid: bestCid, publisher, title: cr.title || '原生广告' }), cr.content ? safeJson(cr.content) : {});
        winBid.adm = JSON.stringify(nat);
        winBid.ext = Object.assign({}, best.bid.ext, { ad_format: 'native', adm_type: 'native_json' });
      } else if (cr.type === 'push') {
        winBid.adm = '';
        winBid.ext = Object.assign({}, best.bid.ext, { ad_format: 'push', adm_type: 'push', push: cr.content ? safeJson(cr.content) : null });
      } else {
        // HTML 类创意：若 content 是完整 HTML 则直接用；若是占位符（短字符串/无标签）则用 buildFormatAd 模板重新生成
        // view 形态此前被强制排除（丢掉广告主设计稿，只能看占位图）；现在改为「真实创意 + 坐标容器包裹」，
        // 既保留 SDK addView 需要的 activity/像素坐标，又能用上广告主上传的设计稿。
        const isHtml = cr.content && cr.content.indexOf('<') !== -1 && cr.content.length > 30;
        if (isHtml) {
          winBid.adm = (fmt === 'view') ? wrapViewAd(cr.content, viewGeo) : cr.content;
          winBid.ext = Object.assign({}, best.bid.ext, { ad_format: fmt, adm_type: 'html' });
        } else {
          // 用创意元数据喂给格式模板，生成完整可渲染的 HTML
          const fa = buildFormatAd(fmt, {
            impid: best.bid.impid, cid: bestCid, publisher,
            title: cr.title || ('AppLink-' + bestCid),
            body: (cr.content && cr.content.length > 5 && cr.content.length < 200) ? cr.content : ('由 ADX 下发的 ' + fmt + ' 广告'),
            mediaUrl: cr.mediaUrl || RW_MEDIA, duration: RW_DURATION,
            // 应用内 View：把请求侧 Activity + 像素坐标传给模板（SDK 里 addView 时按坐标嵌视图树）
            activity: (imp.ext && (imp.ext.activity || imp.ext.activity_name || imp.ext.activityName)) || 'com.example.MainActivity',
            x: (imp.ext && (imp.ext.x || imp.ext.px)) || 40,
            y: (imp.ext && (imp.ext.y || imp.ext.py)) || 120,
            w: (imp.ext && (imp.ext.w || imp.ext.width)) || 300,
            h: (imp.ext && (imp.ext.h || imp.ext.height)) || 140,
          });
          if (fa) {
            winBid.adm = fa.adm;
            winBid.ext = Object.assign({}, best.bid.ext, { ad_format: fmt, adm_type: fa.admType, push: fa.push || null });
          } else {
            winBid.adm = cr.content || '';
            winBid.ext = Object.assign({}, best.bid.ext, { ad_format: fmt, adm_type: 'html' });
          }
        }
      }
    } else {
      const fa = buildFormatAd(fmt, {
        impid: best.bid.impid, cid: bestCid, publisher,
        title: bestCid ? ('AppLink-' + bestCid) : 'ad',
        body: '由 ADX 下发的 ' + fmt + ' 广告',
        mediaUrl: RW_MEDIA, duration: RW_DURATION,
        // 应用内 View：请求侧 Activity + 像素坐标
        activity: (imp.ext && (imp.ext.activity || imp.ext.activity_name || imp.ext.activityName)) || 'com.example.MainActivity',
        x: (imp.ext && (imp.ext.x || imp.ext.px)) || 40,
        y: (imp.ext && (imp.ext.y || imp.ext.py)) || 120,
        w: (imp.ext && (imp.ext.w || imp.ext.width)) || 300,
        h: (imp.ext && (imp.ext.h || imp.ext.height)) || 140,
      });
      if (fa) {
        winBid.adm = fa.adm;
        winBid.ext = Object.assign({}, best.bid.ext, { ad_format: fmt, adm_type: fa.admType, push: fa.push || null });
      }
    }
  }
  cache.observe('bid_latency', Date.now() - t0); cache.incr('wins'); metrics.incr('bid_win');
  // 调试透出：?trace=1 时附上各参与方真实调用结果，证明外部 DSP/SSP 真的被调用（不影响正常响应）
  let participants = null;
  if (req.query.trace === '1') {
    participants = DEMAND_PARTNERS.map((p, i) => {
      const resp = responses[i];
      let st = 'timeout', top = 0;
      if (resp && resp.seatbid) {
        st = 'bid';
        resp.seatbid.forEach(s => (s.bid || []).forEach(b => { if ((b.price || 0) > top) top = b.price; }));
      } else if (resp === null) st = 'error';
      return { seat: p.name, type: p.type, status: st, topBidMicros: top, won: !!(best && best.partner.name === p.name) };
    });
    sres.forEach((s) => {
      if (!s || !s.json) return;
      let top = 0; (s.json.seatbid || []).forEach(seat => (seat.bid || []).forEach(b => { if ((b.price || 0) > top) top = b.price; }));
      participants.push({ seat: s.sp.name, type: 'supply', status: 'bid', topBidMicros: top, won: false });
    });
  }
  // ④ 频控 / 刷新 / 尺寸下发：必须放在「形态处理」之后——
  // 形态处理会用 best.bid.ext 重建 winBid.ext，放在它之前会被整段覆盖（已踩坑）。
  try {
    const [[au2]] = await pool.query('SELECT freq_cap,freq_window_hours,refresh_interval,size FROM ad_units WHERE ad_unit_id=? AND publisher=?', [adUnitId, publisher]);
    if (au2) {
      winBid.ext = Object.assign({}, winBid.ext, {
        freq_cap: Number(au2.freq_cap) || 0,
        freq_window_hours: Number(au2.freq_window_hours) || 24,
        refresh_interval: Number(au2.refresh_interval) || 0,
        size: au2.size || ''
      });
    }
  } catch (e) {}
  res.json({ id: br.id, cur: 'CNY', seatbid: [{ seat: best.partner.name, bid: [winBid] }], ...(participants ? { participants } : {}) });
});

// 动态注册外部 DSP（合作方案落地：Appluck 类供给/需求接入）
app.post('/ssp/demand', (req, res) => {
  const { name, url, payoutRate = 0.6 } = req.body || {};
  if (!name || !url) return res.status(400).json({ error: 'name,url required' });
  DEMAND_PARTNERS.push({ name, type: 'http', url, payoutRate, isOwn: false });
  res.json({ ok: true, partners: DEMAND_PARTNERS.map(p => p.name) });
});

// ===== 快手磁力引擎 开放平台 · DSP/买量侧 接入（脚手架）=====
// 仅供 demo 展示与自测；真实模式需 KS_APP_ID/KS_APP_SECRET + 开放平台端点文档
app.get('/api/demand/kuaishou/status', (_, res) => res.json(ksDSP.status()));
app.post('/api/demand/kuaishou/buy', async (req, res) => {
  try { const r = await ksDSP.buy(req.body || {}); res.json(r); }
  catch (e) { res.status(501).json({ ok: false, error: e.message }); }
});
// 快手转化/事件回传（webhook）签名校验：demo 用随机参数+签名演示
app.post('/api/demand/kuaishou/callback', (req, res) => {
  const b = req.body || {};
  const ok = ksDSP.verifyCallback(b, b.sign);
  res.json({ ok, verified: ok, mode: ksDSP.MODE });
});

// 快手 OAuth2 授权（真实模式）：跳转到快手授权页；回调交换 token
app.get('/api/demand/kuaishou/auth', (req, res) => {
  if (ksDSP.MODE !== 'real') return res.json({ mode: 'sim', note: 'sim 模式无需授权；设 KS_MODE=real + KS_APP_ID/SECRET + KS_REDIRECT_URI 后访问此端点完成真实授权' });
  res.redirect(ksDSP.authUrl(req.query.state));
});
app.get('/api/demand/kuaishou/oauth-callback', async (req, res) => {
  try {
    const j = await ksDSP.exchangeCode(req.query.code || '');
    if (j && j.access_token) res.send('<h3>快手授权成功 ✓</h3><p>access_token 已保存，可回到演示页点「测试快手买量(real)」。</p><p><a href="/media-demo.html">返回演示</a></p>');
    else res.status(400).send('<h3>授权失败</h3><pre>' + JSON.stringify(j) + '</pre>');
  } catch (e) { res.status(500).send('授权错误: ' + e.message); }
});

// ===== 巨量引擎（OceanEngine/抖音）开放平台 · DSP/买量侧 接入 =====
app.get('/api/demand/oceanengine/status', (_, res) => res.json(oeDSP.status()));
app.post('/api/demand/oceanengine/buy', async (req, res) => {
  try { const r = await oeDSP.buy(req.body || {}); res.json(r); }
  catch (e) { res.status(501).json({ ok: false, error: e.message }); }
});
app.post('/api/demand/oceanengine/callback', (req, res) => {
  const b = req.body || {};
  const ok = oeDSP.verifyCallback(b, b.sign);
  res.json({ ok, verified: ok, mode: oeDSP.MODE });
});
app.get('/api/demand/oceanengine/auth', (req, res) => {
  if (oeDSP.MODE !== 'real') return res.json({ mode: 'sim', note: 'sim 模式无需授权；设 OE_MODE=real + OE_APP_ID/SECRET + OE_REDIRECT_URI 后访问此端点完成真实授权' });
  res.redirect(oeDSP.authUrl(req.query.state));
});
app.get('/api/demand/oceanengine/oauth-callback', async (req, res) => {
  try {
    const j = await oeDSP.exchangeCode(req.query.code || '');
    if (j && j.data && j.data.access_token) res.send('<h3>巨量引擎授权成功 ✓</h3><p>access_token 已保存。</p><p><a href="/media-demo.html">返回演示</a></p>');
    else res.status(400).send('<h3>授权失败</h3><pre>' + JSON.stringify(j) + '</pre>');
  } catch (e) { res.status(500).send('授权错误: ' + e.message); }
});

// ===== 通用 OpenRTB 需求方（自包含，可持续出价）=====
app.get('/api/demand/generic/status', (_, res) => res.json(genericDSP.status()));

// ===== 聚合：当前所有需求方接入状态 =====
app.get('/api/demand/status', (_, res) => res.json({
  partners: DEMAND_PARTNERS.map(p => ({ name: p.name, type: p.type, isOwn: !!p.isOwn, payoutRate: p.payoutRate })),
  adapters: {
    kuaishou: ksDSP.status(),
    oceanengine: oeDSP.status(),
    generic: genericDSP.status(),
    mintegral: mintegralDSP.status(),
    adcolony: adcolonyDSP.status()
  }
}));


// 媒体方曝光上报（由 pub_sdk.js 自动调用）
const pubImpr = {};
app.get('/ssp/imp', (req, res) => {
  const pub = req.query.pub || 'unknown';
  pubImpr[pub] = (pubImpr[pub] || 0) + 1;
  res.status(204).end();
});
// 媒体方点击上报（pub_sdk 在创意被点击时调用）→ 转化漏斗 + 媒体方点击数
app.get('/ssp/click', async (req, res) => {
  if (rateHit(String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim())) return res.status(429).json({ error: 'rate limited' });
  const pub = req.query.pub || 'unknown';
  const cid = req.query.cid ? +req.query.cid : null;
  const imp = req.query.imp || '';
  if (!imp) return res.status(400).end();
  const [[ex]] = await pool.query('SELECT device_id, created_at FROM bid_win_log WHERE imp_id=?', [imp]);
  if (!ex) return res.status(204).end(); // 反作弊：无对应曝光的点击直接忽略
  const clickDeviceId = (ex && ex.device_id) || '';
  const clickIp = String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
  const impTs = ex && ex.created_at ? new Date(ex.created_at).getTime() : 0;
  anticheat.observeClick(clickDeviceId, clickIp, impTs).catch(() => {});

  // 点击去重 + 归因窗口：conv_log 没有唯一键，INSERT IGNORE 实际不会去重（同一 imp 可重复计点击）。
  // 改为按该广告主的可配规则判定后再写。
  const clickCfg = await getAttribCfg(await advertiserOfImp(imp));
  const [[clickWin]] = await pool.query('SELECT TIMESTAMPDIFF(DAY, created_at, NOW()) AS age_days FROM bid_win_log WHERE imp_id=?', [imp]);
  const clickInWindow = clickWin && Number(clickWin.age_days) <= Number(clickCfg.click_window_days || clickCfg.window_days);
  if (clickInWindow && !(await attribDup(clickCfg.dedup_rule, imp, 'click'))) {
    await pool.query('INSERT INTO conv_log (type,campaign_id,publisher,imp_id) VALUES (?,?,?,?)', ['click', cid, pub, imp]).catch(() => {});
  }
  // ① MMP 外发回传：把点击带到广告主配置的归因平台（AppsFlyer / Adjust / Singular … 的 click 宏）。
  // 宏替换：{impid} {clickid} {cid} {publisher}——无配置则不发，不影响主链路。
  (function () {
    pool.query('SELECT advertiser FROM adv_campaign WHERE id=?', [Number(cid) || 0]).then(function (r) {
      const adv = (r && r[0] && r[0].advertiser) ? r[0].advertiser : '';
      if (!adv) return null;
      return pool.query('SELECT * FROM mmp_configs WHERE advertiser=? AND enabled=1', [adv]);
    }).then(function (r2) {
      const cfgs = (r2 && r2[0]) || [];
      cfgs.forEach(function (c) {
        const url = String(c.postback_url || '')
          .replace(/\{impid\}/g, encodeURIComponent(imp))
          .replace(/\{clickid\}/g, encodeURIComponent(imp))
          .replace(/\{cid\}/g, String(cid || ''))
          .replace(/\{publisher\}/g, encodeURIComponent(pub));
        if (!/^https?:\/\//i.test(url)) return;
        fetch(url, { method: 'GET' }).then(function (resp) {
          pool.query('INSERT INTO mmp_postback_log (provider,advertiser,imp_id,event,url,ok) VALUES (?,?,?,?,?,?)',
            [c.provider, c.advertiser, imp, 'click', url.slice(0, 512), resp.ok ? 1 : 0]).catch(function () {});
        }).catch(function () {
          pool.query('INSERT INTO mmp_postback_log (provider,advertiser,imp_id,event,url,ok) VALUES (?,?,?,?,?,0)',
            [c.provider, c.advertiser, imp, 'click', url.slice(0, 512)]).catch(function () {});
        });
      });
    }).catch(function () {});
  })();
  creativeAb.bump(imp, 'clicks').catch(() => {}); // A/B：点击计入所服务创意版本
  // 多目标模型回流（pCTR）：点击即 CTR 塔的正样本
  ml.onClick(imp).catch(() => {});
  res.status(204).end();
});
// 转化/线索上报（广告主落地页在留资/下单时调用）→ 转化 + 媒体方转化数
app.post('/api/track/conversion', async (req, res) => {
  const { cid, publisher, impid, amount } = req.body || {};
  const pub = publisher || 'unknown';
  const imp = impid || '';
  if (!imp) return res.status(400).json({ error: 'impid required' });
  const amt = Number(amount) || 0;
  if (amt < 0 || amt > 1e7) return res.status(400).json({ error: 'amount out of range' }); // 反作弊：金额区间校验，防刷 GMV
  // 归因窗口 + 去重：改为按该广告主的可配规则判定。
  // 原先：完全没有时间校验（一年后的转化照样归因），且去重规则写死、点击不去重。
  // 新增 CTA/VTA 分窗：先判「点击归因」(click 窗口，默认 7 天)，命中则按点击归因；
  // 否则按「浏览归因」(view 窗口，默认 1 天) 处理——与 SKAN / 行业口径对齐（点击权重 > 浏览，且窗口更短）。
  const [[win]] = await pool.query('SELECT TIMESTAMPDIFF(DAY, created_at, NOW()) AS age_days FROM bid_win_log WHERE imp_id=?', [imp]);
  if (!win) return res.status(400).json({ error: 'unknown impression' }); // 反作弊：转化必须对应真实曝光
  const cfg = await getAttribCfg(await advertiserOfImp(imp));
  const clickWinDays = Number(cfg.click_window_days) || cfg.window_days;
  const viewWinDays = Number(cfg.view_window_days) || 1;
  // 是否存在窗口内的点击（点击归因优先）
  const [[clk]] = await pool.query(
    "SELECT 1 FROM conv_log WHERE type='click' AND imp_id=? AND created_at >= NOW() - INTERVAL ? DAY",
    [imp, clickWinDays]).catch(() => [[]]);
  const attributed = clk ? 'click' : 'view';
  const effWinDays = clk ? clickWinDays : viewWinDays;
  if (Number(win.age_days) > effWinDays) {
    return res.json({ ok: true, amount: 0, rejected: 'ATTRIBUTION_WINDOW_EXPIRED',
      attributed, window_days: effWinDays, age_days: Number(win.age_days) });
  }
  if (await attribDup(cfg.dedup_rule, imp, 'conversion')) {
    return res.json({ ok: true, amount: 0, dup: true, rule: cfg.dedup_rule });
  }

  try {
    await pool.query('INSERT INTO conv_log (type,campaign_id,publisher,imp_id,amount) VALUES (?,?,?,?,?)', ['conversion', cid ? +cid : null, pub, imp, amt]);
    bidModel.trainConversion(imp).catch(() => {}); // 在线模型正样本回流（旧单模型，保留作对照）
    // 多目标模型回流（pCVR + pLTV）：标签回流是"离线训练→在线 serving 一致性"的燃料
    ml.onConversion(imp, Math.round(amt * 1e6)).catch(() => {});
    creativeAb.bump(imp, 'conversions').catch(() => {}); // A/B：转化计入所服务创意版本
    res.json({ ok: true, amount: amt });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== S2S 服务端回调：媒体/App 服务端用 api_key 签名上报观看结果，是结算唯一权威 =====
app.post('/s2s/reward', async (req, res) => {
  const { impid, cid, publisher, watchedMs, durationMs, ts, sig, rewardResult, device_fp } = req.body || {};
  const pub = String(publisher || '');
  const watched = Number(watchedMs) || 0, dur = Number(durationMs) || 0;
  const fp = String(device_fp || '');
  const remote = req.ip || (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  const audit = (status, ratio) =>
    pool.query('INSERT INTO reward_log (imp_id,campaign_id,publisher,watched_ms,duration_ms,ratio,status,remote,device_fp) VALUES (?,?,?,?,?,?,?,?,?)',
      [String(impid || ''), cid ? Number(cid) : null, pub, watched, dur, Number((ratio || 0).toFixed(3)), status, remote, fp]).catch(() => {});
  const deny = (why, code = 403) => { audit('S2S_REJECT_' + why, 0); return res.status(code).json({ ok: false, why, deviceFp: fp }); };

  if (!impid || !pub) return deny('MISSING_FIELDS', 400);
  const age = Math.abs(Date.now() - Number(ts || 0));
  if (!ts || age > S2S_TTL_MS) return deny('TIMESTAMP_EXPIRED');
  const [[pu]] = await pool.query('SELECT api_key FROM publishers WHERE domain=?', [pub]).catch(() => [[]]);
  if (!pu || !pu.api_key) return deny('UNKNOWN_PUBLISHER');
  if (s2sSign(pu.api_key, impid, cid, watchedMs, durationMs, ts) !== sig) return deny('BAD_S2S_SIGNATURE');
  const [[win]] = await pool.query('SELECT campaign_id FROM bid_win_log WHERE imp_id=?', [String(impid)]).catch(() => [[]]);
  if (!win) return deny('NO_IMPRESSION', 400);
  const [[tk]] = await pool.query('SELECT used, device_fp FROM rw_token WHERE imp_id=?', [String(impid)]).catch(() => [[]]);
  if (tk && Number(tk.used) === 1) return deny('TOKEN_ALREADY_SETTLED');
  // ② 设备指纹绑定：令牌签发设备与结算设备不一致 → 跨设备重放（农场化）直接拒绝
  if (tk && tk.device_fp && fp && String(tk.device_fp) !== fp) return deny('DEVICE_FP_MISMATCH');
  // ③ 设备级风控：单设备窗口内领奖超阈值 → 设备农场嫌疑
  const fpr = fpRisk(fp);
  if (!fpr.ok) return deny(fpr.reason, 429);
  if (!dur || dur <= 0) return deny('BAD_DURATION', 400);
  const ratio = watched / dur;
  if (ratio < RW_MIN_RATIO) return deny('INCOMPLETE_WATCH', 400);
  if (ratio > RW_MAX_RATIO) return deny('IMPOSSIBLE_WATCH', 400);
  if (rewardResult === 'skipped' || rewardResult === 'abandoned') return deny('MEDIA_REPORTED_ABANDONED', 400);

  await pool.query('UPDATE rw_token SET used=1, used_at=NOW() WHERE imp_id=?', [String(impid)]).catch(() => {});
  let counted = false;
  try {
    const [dupRows] = await pool.query("SELECT 1 FROM conv_log WHERE type='conversion' AND imp_id=?", [String(impid)]);
    if (!dupRows.length) {
      await pool.query("INSERT INTO conv_log (type,campaign_id,publisher,imp_id,amount) VALUES ('conversion',?,?,?,?)", [cid ? Number(cid) : null, pub, String(impid), 0]);
      bidModel.trainConversion(String(impid)).catch(() => {});
      creativeAb.bump(String(impid), 'conversions').catch(() => {});
      counted = true;
    }
  
  } catch (e) {}
  audit('S2S_GRANTED', ratio);
  res.json({ ok: true, granted: true, counted, ratio: Number(ratio.toFixed(3)), settlement: 'server-authoritative', deviceFp: fp, deviceFpCount: fpr.count });
});

// VAST 视频事件上报：曝光/播放进度/完播由播放器按 XML 中的 tracking URL 回调（行业标准度量）
app.get('/vast/track', async (req, res) => {
  const qy = req.query || {};
  const impid = String(qy.impid || '');
  const cid = qy.cid ? Number(qy.cid) : null;
  const ev = String(qy.event || 'unknown');
  await pool.query('INSERT INTO vast_event (imp_id,campaign_id,event) VALUES (?,?,?)', [impid, cid, ev]).catch(() => {});
  res.status(204).end();
});

// OMID / 可见性测量上报：由 VAST 中 AdVerifications 的 JavaScriptResource（omsdk/本演示 shim）回传
// 事件：omid_session_start / viewable / not_viewable / omid_not_executed（反作弊加分项）
app.post('/vast/omid', async (req, res) => {
  const { impid, cid, event, viewable, durationMs } = req.body || {};
  await pool.query('INSERT INTO omid_event (imp_id,campaign_id,event,viewable,duration_ms) VALUES (?,?,?,?,?)',
    [String(impid || ''), cid ? Number(cid) : null, String(event || 'unknown'), viewable ? 1 : 0, Number(durationMs) || 0]).catch(() => {});
  res.status(204).end();
});
app.get('/vast/omid', async (req, res) => {
  const qy = req.query || {};
  const impid = String(qy.impid || '');
  const cid = qy.cid ? Number(qy.cid) : null;
  const ev = String(qy.event || 'unknown');
  await pool.query('INSERT INTO omid_event (imp_id,campaign_id,event,viewable,duration_ms) VALUES (?,?,?,?,?)',
    [impid, cid, ev, qy.viewable === '1' ? 1 : 0, Number(qy.durationMs) || 0]).catch(() => {});
  res.status(204).end();
});

// ===== 激励视频完播上报：服务端校验令牌后才发放奖励（前端无法自证完播）=====
app.post('/ssp/reward', async (req, res) => {
  const { impid, cid, publisher, rw, watchedMs, durationMs, device_fp } = req.body || {};
  const pub = String(publisher || 'unknown');
  const fp = String(device_fp || '');
  const remote = req.ip || (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  const watched = Number(watchedMs) || 0, dur = Number(durationMs) || 0;
  const audit = (status, ratio) =>
    pool.query('INSERT INTO reward_log (imp_id,campaign_id,publisher,watched_ms,duration_ms,ratio,status,remote,device_fp) VALUES (?,?,?,?,?,?,?,?,?)',
      [String(impid || ''), cid ? Number(cid) : null, pub, watched, dur, Number((ratio || 0).toFixed(3)), status, remote, fp]).catch(() => {});
  const deny = (why, code = 403) => { audit('REJECT_' + why, 0); return res.status(code).json({ ok: false, why, deviceFp: fp }); };

  if (!impid) return deny('MISSING_IMPID', 400);
  // ① 必须对应一次真实曝光（bid_win_log 由竞价成功后落库）
  let winRows = [];
  try { [winRows] = await pool.query('SELECT campaign_id, price_micros FROM bid_win_log WHERE imp_id=?', [String(impid)]); } catch (e) { return deny('DB_ERROR', 500); }
  if (!winRows.length) return deny('NO_IMPRESSION', 400);
  // ② 令牌签名校验（HMAC 绑定 impid+cid+publisher+时间戳）
  const v = rwVerify(rw, impid, cid, pub);
  if (!v.ok) return deny(v.why);
  // ③ 令牌未被兑换过（防重放：同一 impid 只能领一次）
  const [[tk]] = await pool.query('SELECT used, device_fp FROM rw_token WHERE imp_id=?', [String(impid)]).catch(() => [[]]);
  if (tk && Number(tk.used) === 1) return deny('TOKEN_REPLAYED');
  // ③b 设备指纹绑定：令牌签发设备与结算设备不一致 → 跨设备重放直接拒绝
  if (tk && tk.device_fp && fp && String(tk.device_fp) !== fp) return deny('DEVICE_FP_MISMATCH');
  // ③c 设备级风控：单设备窗口内领奖超阈值 → 设备农场嫌疑
  const fpr = fpRisk(fp);
  if (!fpr.ok) return deny(fpr.reason, 429);
  // ④ 完播证据合理性：时长有效 + 观看比例在合法区间
  if (!dur || dur <= 0) return deny('BAD_DURATION', 400);
  const ratio = watched / dur;
  if (ratio < RW_MIN_RATIO) return deny('INCOMPLETE_WATCH', 400);
  if (ratio > RW_MAX_RATIO) return deny('IMPOSSIBLE_WATCH', 400);
  // ⑤ S2S 强校验模式：客户端上报只是「信号」，不计入结算，须等媒体服务端 /s2s/reward 回调
  if (S2S_ENFORCE) {
    audit('CLIENT_CLAIM_AWAITING_S2S', ratio);
    return res.json({ ok: true, granted: false, pending: 'await_s2s', why: 'CLIENT_SIGNAL_ONLY', ratio: Number(ratio.toFixed(3)) });
  }
  // ⑥ 客户端直结模式（H5 演示用；生产应设 S2S_ENFORCE=1）
  await pool.query('UPDATE rw_token SET used=1, used_at=NOW() WHERE imp_id=?', [String(impid)]).catch(() => {});
  let counted = false;
  try {
    const [dupRows] = await pool.query("SELECT 1 FROM conv_log WHERE type='conversion' AND imp_id=?", [String(impid)]);
    if (!dupRows.length) {
      await pool.query("INSERT INTO conv_log (type,campaign_id,publisher,imp_id,amount) VALUES ('conversion',?,?,?,?)", [cid ? Number(cid) : null, pub, String(impid), 0]);
      bidModel.trainConversion(String(impid)).catch(() => {});
      creativeAb.bump(String(impid), 'conversions').catch(() => {});
      counted = true;
    }
  
  } catch (e) {}
  audit('GRANTED', ratio);
  return res.json({ ok: true, granted: true, counted, ratio: Number(ratio.toFixed(3)), campaignId: winRows[0].campaign_id, priceMicros: winRows[0].price_micros, deviceFp: fp, deviceFpCount: fpr.count });
});

// 激励视频审计日志：既看发放成功，也看每一次被拒绝的原因（反作弊可追溯）
app.get('/api/reward/log', async (req, res) => {
  const limit = Math.min(100, Number(req.query.limit) || 20);
  try {
    const [rows] = await pool.query('SELECT imp_id,campaign_id,publisher,watched_ms,duration_ms,ratio,status,created_at FROM reward_log ORDER BY id DESC LIMIT ' + limit);
    const [[agg]] = await pool.query("SELECT SUM(status='GRANTED') AS granted, COUNT(*) AS total FROM reward_log");
    res.json({ rows, agg });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== 控制台：广告主充值 + 双边看板 =====
app.post('/api/campaign/:id/topup', security.requireAdmin('topup'), async (req, res) => {
  const cid = Number(req.params.id);
  const cny = Number((req.body || {}).amount_cny);
  if (!cid || !cny || cny <= 0 || cny > 1e6) return res.status(400).json({ error: 'amount_cny required (0, 1e6]' });
  const micros = Math.round(cny * 1e6);
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS topup_log (
      id BIGINT AUTO_INCREMENT PRIMARY KEY, campaign_id INT, amount_micros BIGINT,
      note VARCHAR(128), created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
    await pool.query('UPDATE adv_campaign SET budget_micros = budget_micros + ? WHERE id=?', [micros, cid]);
    await pool.query('INSERT INTO topup_log (campaign_id,amount_micros,note) VALUES (?,?,?)', [cid, micros, (req.body && req.body.note) || 'recharge']);
    const [[row]] = await pool.query('SELECT id,name,advertiser,budget_micros FROM adv_campaign WHERE id=?', [cid]);
    res.json({ ok: true, campaign: row });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/console/overview', security.requireAuth('admin'), async (_, res) => {
  try {
    // 注意：这里返回的是「计划预算 budget_micros」，不是账户充值余额(adv_balance)。
    // 曾用名 balance_micros 会让运营误以为看到的是钱包余额——已正名，前端列名同步改为「计划预算(元)」。
    // （别在 SQL 模板串里写 // 注释：MySQL 不认 //，会直接语法报错。）
    const [advRows] = await pool.query(`
      SELECT c.id, c.name, c.advertiser, c.app_category, c.review_status, c.status,
             c.budget_micros,
             COALESCE(t.filled_micros,0) AS spend_micros,
             COALESCE(t.impressions,0) AS impressions,
             COALESCE(k.clicks,0) AS clicks,
             COALESCE(v.conversions,0) AS conversions
      FROM adv_campaign c
      LEFT JOIN (SELECT campaign_id, SUM(price_micros) filled_micros, COUNT(*) impressions FROM bid_win_log GROUP BY campaign_id) t ON t.campaign_id=c.id
      LEFT JOIN (SELECT campaign_id, COUNT(*) clicks FROM conv_log WHERE type='click' GROUP BY campaign_id) k ON k.campaign_id=c.id
      LEFT JOIN (SELECT campaign_id, COUNT(*) conversions FROM conv_log WHERE type='conversion' GROUP BY campaign_id) v ON v.campaign_id=c.id
      ORDER BY c.id DESC LIMIT 50`);
    const [[tot]] = await pool.query('SELECT COALESCE(SUM(price_micros),0) AS gross_micros, COUNT(*) AS impressions FROM bid_win_log');
    const [[conv]] = await pool.query("SELECT COALESCE(SUM(type='conversion'),0) AS conversions, COALESCE(SUM(type='click'),0) AS clicks FROM conv_log");
    const [[rw]] = await pool.query("SELECT COALESCE(SUM(status='GRANTED'),0) AS granted, COALESCE(SUM(status LIKE 'REJECT%'),0) AS rejected, COUNT(*) AS total FROM reward_log");
    const [pubRows] = await pool.query('SELECT domain,name,payout_rate,cat,geo FROM publishers ORDER BY domain DESC LIMIT 50');
    const [todayRows] = await pool.query('SELECT COUNT(*) AS impressions, COALESCE(SUM(price_micros),0) AS gross_micros FROM bid_win_log WHERE DATE(created_at)=CURDATE()');
    // SSP 全局账本 + 分媒体账本：改为从 DB 实时聚合。
    // 原先用进程内对象 sspLedger/pubLedger —— 重启即清零、与 DB 数字对不上，本质是"内存假账"。
    const [sspAgg] = await pool.query(`
      SELECT COUNT(*) wins, COALESCE(SUM(w.price_micros),0) gross,
             COALESCE(SUM(ROUND(w.price_micros * COALESCE(p.payout_rate,0.7))),0) payout
      FROM bid_win_log w LEFT JOIN publishers p ON p.domain=w.publisher`);
    const ssp = { wins: Number(sspAgg[0].wins) || 0, grossMicros: Number(sspAgg[0].gross) || 0, payoutMicros: Number(sspAgg[0].payout) || 0 };
    const [pubAgg] = await pool.query(`
      SELECT w.publisher domain, COUNT(DISTINCT w.imp_id) wins,
             COALESCE(SUM(w.price_micros),0) gross,
             COALESCE(SUM(ROUND(w.price_micros * COALESCE(p.payout_rate,0.7))),0) payout,
             COALESCE(k.clicks,0) clicks, COALESCE(v.conversions,0) conversions
      FROM bid_win_log w
      LEFT JOIN publishers p ON p.domain=w.publisher
      LEFT JOIN (SELECT w2.publisher publisher, COUNT(*) clicks FROM conv_log c JOIN bid_win_log w2 ON w2.imp_id=c.imp_id WHERE c.type='click' GROUP BY w2.publisher) k ON k.publisher=w.publisher
      LEFT JOIN (SELECT w3.publisher publisher, COUNT(*) conversions FROM conv_log c3 JOIN bid_win_log w3 ON w3.imp_id=c3.imp_id WHERE c3.type='conversion' GROUP BY w3.publisher) v ON v.publisher=w.publisher
      GROUP BY w.publisher, k.clicks, v.conversions`);
    const publishers = {};
    pubAgg.forEach(r => {
      publishers[r.domain] = { wins: Number(r.wins) || 0, grossMicros: Number(r.gross) || 0,
        payoutMicros: Number(r.payout) || 0, clicks: Number(r.clicks) || 0, conversions: Number(r.conversions) || 0 };
    });
    res.json({
      platform: {
        grossMicros: Number(tot.gross_micros), impressions: Number(tot.impressions),
        conversions: Number(conv.conversions), clicks: Number(conv.clicks),
        todayImpressions: Number(todayRows[0].impressions), todayGrossMicros: Number(todayRows[0].gross_micros),
        ssp, publishers
      },
      reward: { granted: Number(rw.granted) || 0, rejected: Number(rw.rejected) || 0, total: Number(rw.total) || 0 },
      advertisers: advRows, publisherList: pubRows
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
// 运营活动模块（业务层，归属运营）：活动 / 奖励规则 / 预算 / 发放 / 参与与防刷
// 管理端接口需管理员；领奖接口对 H5 公开（靠设备指纹 + 用户标识 + 预算 + 频次做防刷，不暴露经营数据）。
// 与竞价/DSP/SSP 引擎解耦：这是独立的业务模块，挂管理后台但归属运营。
// ============================================================

// ── 管理端：活动 CRUD ──
app.post('/api/activity', security.requireAdmin('admin'), async (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name required' });
  const budget = Math.max(0, Math.round(Number(b.budget_cny || 0) * 1e6));
  try {
    const [r] = await pool.query(
      'INSERT INTO activity_campaign (name,status,start_at,end_at,budget_micros,owner_role,created_by,note) VALUES (?,?,?,?,?,?,?,?)',
      [name, b.status != null ? Number(b.status) : 0, b.start_at || null, b.end_at || null, budget,
       'operations', String(req.admin || 'admin').slice(0, 64), String(b.note || '').slice(0, 255)]);
    res.json({ ok: true, id: r.insertId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/activity', security.requireAdmin('admin'), async (_, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM activity_campaign ORDER BY id DESC');
    for (const a of rows) {
      const [[s]] = await pool.query('SELECT COUNT(*) n, COALESCE(SUM(reward_micros),0) granted, COALESCE(SUM(status LIKE \'REJECT%\'),0) rejected FROM activity_participation WHERE activity_id=?', [a.id]);
      a.participations = Number(s.n) || 0; a.granted_micros = Number(s.granted) || 0; a.rejected = Number(s.rejected) || 0;
    }
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/activity/:id', security.requireAdmin('admin'), async (req, res) => {
  try {
    const [[a]] = await pool.query('SELECT * FROM activity_campaign WHERE id=?', [Number(req.params.id)]);
    if (!a) return res.status(404).json({ error: 'not found' });
    const [rules] = await pool.query('SELECT * FROM activity_reward_rule WHERE activity_id=? ORDER BY id', [a.id]);
    res.json({ activity: a, rules });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/activity/:id', security.requireAdmin('admin'), async (req, res) => {
  const b = req.body || {};
  try {
    const sets = []; const vals = [];
    if (b.name != null) { sets.push('name=?'); vals.push(String(b.name)); }
    if (b.status != null) { sets.push('status=?'); vals.push(Number(b.status)); }
    if (b.start_at != null) { sets.push('start_at=?'); vals.push(b.start_at || null); }
    if (b.end_at != null) { sets.push('end_at=?'); vals.push(b.end_at || null); }
    if (b.budget_cny != null) { sets.push('budget_micros=?'); vals.push(Math.max(0, Math.round(Number(b.budget_cny) * 1e6))); }
    if (b.note != null) { sets.push('note=?'); vals.push(String(b.note).slice(0, 255)); }
    if (!sets.length) return res.status(400).json({ error: 'nothing to update' });
    vals.push(Number(req.params.id));
    await pool.query('UPDATE activity_campaign SET ' + sets.join(',') + ' WHERE id=?', vals);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── 管理端：奖励规则 CRUD ──
app.post('/api/activity/:id/rule', security.requireAdmin('admin'), async (req, res) => {
  const b = req.body || {};
  const code = String(b.code || '').trim();
  if (!code) return res.status(400).json({ error: 'code required' });
  const reward = Math.max(0, Math.round(Number(b.reward_cny || 0) * 1e6));
  try {
    const [r] = await pool.query(
      'INSERT INTO activity_reward_rule (activity_id,code,title,reward_micros,cap_per_user,daily_cap,conditions,antifraud,status) VALUES (?,?,?,?,?,?,?,?,?)',
      [Number(req.params.id), code, String(b.title || code).slice(0, 128), reward,
       Math.max(1, Number(b.cap_per_user) || 1), Number(b.daily_cap) || 0,
       JSON.stringify(b.conditions || {}), JSON.stringify(b.antifraud || {}), b.status != null ? Number(b.status) : 1]);
    res.json({ ok: true, id: r.insertId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/activity/:id/rule/:rid', security.requireAdmin('admin'), async (req, res) => {
  const b = req.body || {};
  try {
    const sets = []; const vals = [];
    if (b.code != null) { sets.push('code=?'); vals.push(String(b.code)); }
    if (b.title != null) { sets.push('title=?'); vals.push(String(b.title).slice(0, 128)); }
    if (b.reward_cny != null) { sets.push('reward_micros=?'); vals.push(Math.max(0, Math.round(Number(b.reward_cny) * 1e6))); }
    if (b.cap_per_user != null) { sets.push('cap_per_user=?'); vals.push(Math.max(1, Number(b.cap_per_user))); }
    if (b.daily_cap != null) { sets.push('daily_cap=?'); vals.push(Number(b.daily_cap)); }
    if (b.conditions != null) { sets.push('conditions=?'); vals.push(JSON.stringify(b.conditions)); }
    if (b.antifraud != null) { sets.push('antifraud=?'); vals.push(JSON.stringify(b.antifraud)); }
    if (b.status != null) { sets.push('status=?'); vals.push(Number(b.status)); }
    if (!sets.length) return res.status(400).json({ error: 'nothing to update' });
    vals.push(Number(req.params.rid), Number(req.params.id));
    await pool.query('UPDATE activity_reward_rule SET ' + sets.join(',') + ' WHERE id=? AND activity_id=?', vals);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── 公开：活动信息（H5 拉取活动 + 生效奖励规则）──
app.get('/api/activity/:id/public', async (req, res) => {
  try {
    const [[a]] = await pool.query('SELECT id,name,status,start_at,end_at,budget_micros,spent_micros FROM activity_campaign WHERE id=?', [Number(req.params.id)]);
    if (!a) return res.status(404).json({ error: 'not found' });
    const [rules] = await pool.query('SELECT code,title,reward_micros,cap_per_user,daily_cap,conditions,status FROM activity_reward_rule WHERE activity_id=? AND status=1', [a.id]);
    const now = new Date();
    const active = Number(a.status) === 1 && (!a.start_at || new Date(a.start_at) <= now) && (!a.end_at || new Date(a.end_at) >= now);
    res.json({
      activity: a, active,
      budget_cny: ((Number(a.budget_micros) - Number(a.spent_micros)) / 1e6).toFixed(2),
      rules: rules.map(r => ({ code: r.code, title: r.title, reward_cny: (Number(r.reward_micros) / 1e6).toFixed(4), cap_per_user: r.cap_per_user, daily_cap: r.daily_cap, conditions: safeJson(r.conditions) })),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── 公开：领奖（替换原 H5 的 grantReward，调用真实活动接口）──
// 防刷：设备指纹速率 + 每用户/规则上限 + 日上限 + 预算校验 + 同一(user,rule)短窗幂等
app.post('/api/activity/:id/grant', async (req, res) => {
  const b = req.body || {};
  const actId = Number(req.params.id);
  const code = String(b.rule_code || b.code || '').trim();
  const userKey = String(b.user_key || '').trim();
  const fp = String(b.device_fp || '').trim();
  const ratio = Number(b.ratio);
  const remote = req.ip || (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (!code || !userKey) return res.status(400).json({ ok: false, why: 'MISSING_FIELDS' });
  let conn;
  try {
    conn = await pool.getConnection();
    await conn.beginTransaction();
    const [[a]] = await conn.query('SELECT * FROM activity_campaign WHERE id=? FOR UPDATE', [actId]);
    if (!a) { await conn.rollback(); return res.status(404).json({ ok: false, why: 'ACTIVITY_NOT_FOUND' }); }
    const now = new Date();
    if (Number(a.status) !== 1 || (a.start_at && new Date(a.start_at) > now) || (a.end_at && new Date(a.end_at) < now)) {
      await conn.rollback(); return res.json({ ok: false, why: 'ACTIVITY_INACTIVE' });
    }
    const [[rule]] = await conn.query('SELECT * FROM activity_reward_rule WHERE activity_id=? AND code=? AND status=1 FOR UPDATE', [actId, code]);
    if (!rule) { await conn.rollback(); return res.json({ ok: false, why: 'RULE_DISABLED' }); }
    const fpr = fpRisk(fp);
    if (!fpr.ok) { await conn.rollback(); return res.json({ ok: false, why: fpr.reason, deviceFpCount: fpr.count }); }
    const af = safeJson(rule.antifraud) || {};
    if (af.minRatio && (!isFinite(ratio) || ratio < Number(af.minRatio))) { await conn.rollback(); return res.json({ ok: false, why: 'RATIO_TOO_LOW' }); }
    const [[uc]] = await conn.query('SELECT COUNT(*) n FROM activity_participation WHERE activity_id=? AND rule_id=? AND user_key=? AND status=\'GRANTED\'', [actId, rule.id, userKey]);
    if (Number(uc.n) >= Number(rule.cap_per_user)) { await conn.rollback(); return res.json({ ok: false, why: 'CAP_PER_USER', granted: Number(uc.n) }); }
    if (Number(rule.daily_cap) > 0) {
      const [[dc]] = await conn.query('SELECT COUNT(*) n FROM activity_participation WHERE activity_id=? AND rule_id=? AND user_key=? AND status=\'GRANTED\' AND DATE(created_at)=CURDATE()', [actId, rule.id, userKey]);
      if (Number(dc.n) >= Number(rule.daily_cap)) { await conn.rollback(); return res.json({ ok: false, why: 'DAILY_CAP' }); }
    }
    const reward = Number(rule.reward_micros) || 0;
    if (reward > 0 && Number(a.budget_micros) - Number(a.spent_micros) < reward) { await conn.rollback(); return res.json({ ok: false, why: 'BUDGET_EXHAUSTED' }); }
    const [[dup]] = await conn.query('SELECT id,reward_micros,status FROM activity_participation WHERE activity_id=? AND rule_id=? AND user_key=? AND created_at > NOW()-INTERVAL 5 MINUTE ORDER BY id DESC LIMIT 1', [actId, rule.id, userKey]);
    if (dup) { await conn.rollback(); return res.json({ ok: true, counted: true, dup: true, reward_micros: Number(dup.reward_micros), why: dup.status }); }
    // ===== S2S 强校验模式（与广告激励视频同一套）：客户端领奖只是「信号」，不发放、不扣预算；
    //       必须等媒体服务端 /api/activity/:id/s2s/confirm 回执（持媒体密钥）确认后才真正发放 —— 二次防刷 =====
    if (S2S_ENFORCE) {
      const receipt = crypto.createHmac('sha256', RW_SECRET).update(`${actId}|${rule.id}|${userKey}|${fp}|${reward}`).digest('hex');
      const [ins] = await conn.query('INSERT INTO activity_participation (activity_id,rule_id,user_key,device_fp,reward_micros,status,req_ip) VALUES (?,?,?,?,?,?,?)',
        [actId, rule.id, userKey, fp, reward, 'PENDING_S2S', remote]);
      await conn.commit();
      cache.incr('activity_pending_s2s');
      return res.json({ ok: true, granted: false, pending: 'await_s2s', receipt_id: ins.insertId, receipt, why: 'CLIENT_SIGNAL_ONLY' });
    }
    await conn.query('INSERT INTO activity_participation (activity_id,rule_id,user_key,device_fp,reward_micros,status,req_ip) VALUES (?,?,?,?,?,?,?)',
      [actId, rule.id, userKey, fp, reward, 'GRANTED', remote]);
    if (reward > 0) await conn.query('UPDATE activity_campaign SET spent_micros=spent_micros+? WHERE id=?', [reward, actId]);
    await conn.commit();
    cache.incr('activity_granted');
    res.json({ ok: true, granted: true, reward_micros: reward, reward_cny: (reward / 1e6).toFixed(4) });
  } catch (e) {
    if (conn) await conn.rollback().catch(() => {});
    res.status(500).json({ ok: false, error: e.message });
  } finally { if (conn) conn.release(); }
});

// ===== 活动领奖 S2S 二次防刷（镜像广告 /s2s/reward）=====
// 客户端领奖信号先到 ADX，ADX 仅做「同源中继」转交真实媒体服务端(持 PUB_API_KEY + device_fp + fpRisk)；
// 媒体服务端权威回执后，再持媒体密钥回 ADX /s2s/settle 完成发放。
// 二次防刷 = 媒体端设备农场拦截 + ADX 回执完整性校验（server-authoritative 在媒体服务端）
app.post('/api/activity/:id/s2s/confirm', async (req, res) => {
  const MEDIA = process.env.MEDIA_S2S_BASE || 'http://127.0.0.1:8081';
  const fwd = Object.assign({}, req.body || {});
  delete fwd.media_token;                 // 客户端不得伪造媒体密钥；由媒体服务端注入
  try {
    const r = await fetch(MEDIA + '/api/activity/' + req.params.id + '/s2s/confirm', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fwd),
    });
    const j = await r.json().catch(() => ({}));
    return res.status(r.status).json(j);
  } catch (e) {
    return res.status(502).json({ ok: false, why: 'MEDIA_S2S_UNREACHABLE', error: e.message });
  }
});

// 服务端到服务端：媒体服务端持媒体密钥回执，是发放唯一权威（对应广告侧 ADX /s2s/reward 的裁决）
app.post('/api/activity/:id/s2s/settle', async (req, res) => {
  const b = req.body || {};
  const actId = Number(req.params.id);
  const receiptId = Number(b.receipt_id);
  const receipt = String(b.receipt || '');
  const fp = String(b.device_fp || '').trim();
  const mt = String(req.headers['x-media-token'] || b.media_token || '');
  const MEDIA_SECRET = process.env.ACCOUNT_SECRET || RW_SECRET;
  if (!MEDIA_SECRET || mt !== MEDIA_SECRET) return res.status(401).json({ ok: false, why: 'MEDIA_AUTH_REQUIRED' });
  if (!receiptId || !receipt) return res.status(400).json({ ok: false, why: 'MISSING_RECEIPT' });
  let conn;
  try {
    conn = await pool.getConnection();
    await conn.beginTransaction();
    const [[p]] = await conn.query('SELECT * FROM activity_participation WHERE id=? AND activity_id=? FOR UPDATE', [receiptId, actId]);
    if (!p) { await conn.rollback(); return res.status(404).json({ ok: false, why: 'RECEIPT_NOT_FOUND' }); }
    if (p.status === 'GRANTED') { await conn.rollback(); return res.json({ ok: true, granted: true, dup: true, reward_micros: Number(p.reward_micros) }); }
    if (p.status !== 'PENDING_S2S') { await conn.rollback(); return res.status(409).json({ ok: false, why: 'RECEIPT_STATE_' + p.status }); }
    if (fp && p.device_fp && fp !== String(p.device_fp)) { await conn.rollback(); return res.status(409).json({ ok: false, why: 'DEVICE_FP_MISMATCH' }); }
    // 回执完整性校验（HMAC 绑定 活动/规则/用户/设备/金额）：防篡改 + 跨设备重放
    const expect = crypto.createHmac('sha256', RW_SECRET).update(`${actId}|${p.rule_id}|${p.user_key}|${String(p.device_fp || '')}|${Number(p.reward_micros)}`).digest('hex');
    if (expect !== receipt) { await conn.rollback(); return res.status(403).json({ ok: false, why: 'BAD_RECEIPT' }); }
    const [[a]] = await conn.query('SELECT budget_micros,spent_micros,status FROM activity_campaign WHERE id=? FOR UPDATE', [actId]);
    if (!a || Number(a.status) !== 1) { await conn.rollback(); return res.status(409).json({ ok: false, why: 'ACTIVITY_INACTIVE' }); }
    const reward = Number(p.reward_micros) || 0;
    if (reward > 0 && Number(a.budget_micros) - Number(a.spent_micros) < reward) { await conn.rollback(); return res.status(409).json({ ok: false, why: 'BUDGET_EXHAUSTED' }); }
    await conn.query("UPDATE activity_participation SET status='GRANTED' WHERE id=?", [receiptId]);
    if (reward > 0) await conn.query('UPDATE activity_campaign SET spent_micros=spent_micros+? WHERE id=?', [reward, actId]);
    await conn.commit();
    cache.incr('activity_granted');
    res.json({ ok: true, granted: true, reward_micros: reward, reward_cny: (reward / 1e6).toFixed(4), settlement: 'server-authoritative' });
  } catch (e) {
    if (conn) await conn.rollback().catch(() => {});
    res.status(500).json({ ok: false, error: e.message });
  } finally { if (conn) conn.release(); }
});

// ===== DSP 赢价回收 =====
// Fix-09：docs.html#settle 明确承诺「广告主扣账仅接受平台服务器生成的 HMAC 签名成交回调」，
// 但此前只注册了 /notify，文档与前端 SDK 里写的 /api/notify 是 404。
// 现把处理逻辑抽成函数，两个路径共用同一套 HMAC 校验 + (impid,reqid) 幂等去重。
async function handleNotify(req, res) {
  const b = req.body || {};
  const { cid, crid, impid, reqid, price, win = true, test, sig } = b;
  if (!security.verifyNotifySignature(b, sig)) return res.status(401).json({ error: 'invalid_notify_signature' });
  if (!win) return res.json({ ok: true, counted: false });
  const imp = String(impid || '');
  if (!imp || !reqid || !Number(cid)) return res.status(400).json({ error: 'cid, impid, reqid required' });
  // 去重改用复合身份 (impid, reqid)：
  // 仅按 impid 去重会把"不同请求复用了同一 slot 名"误判为重放 → 广告主曝光已投放却不扣费（资金漏洞）
  const reqId = String(reqid || '');
  // 去重以 adv_ledger 为准：/notify 自身只写 adv_ledger（唯一键 uk_imp_req 兜底），查 bid_win_log 会漏判导致重复扣费
  const micros = Math.max(0, Number(price) || 0);
  const id = Number(cid) || 0;
  if (!micros) return res.status(400).json({ error: 'price must be positive' });
  let conn;
  try {
    conn = await pool.getConnection();
    await conn.beginTransaction();
    const [ledger] = await conn.query(
      'INSERT IGNORE INTO adv_ledger (campaign_id,imp_id,req_id,charge_micros,insufficient) VALUES (?,?,?,?,0)',
      [id, imp, reqId, micros]
    );
    if (!Number(ledger.affectedRows)) {
      const [[existing]] = await conn.query('SELECT charge_micros,insufficient FROM adv_ledger WHERE imp_id=? AND req_id=?', [imp, reqId]);
      await conn.rollback();
      return res.json({ ok: true, counted: true, dup: true,
        charged: Number(existing && existing.charge_micros) || 0,
        insufficient: Number(existing && existing.insufficient) === 1 });
    }
    const [[crow]] = await conn.query('SELECT advertiser,budget_micros,is_test FROM adv_campaign WHERE id=? FOR UPDATE', [id]);
    if (!crow) {
      await conn.rollback();
      return res.status(404).json({ error: 'campaign not found' });
    }
    // 演示计划只留零金额流水，不触碰账户余额与实际预算。
    if (Number(test) === 1 || (crow && Number(crow.is_test) === 1)) {
      await conn.query('UPDATE adv_ledger SET charge_micros=0 WHERE imp_id=? AND req_id=?', [imp, reqId]);
      await conn.commit();
      return res.json({ ok: true, counted: true, charged: 0, test: true, note: '测试流量：已记账，但不扣预算与余额' });
    }
    let account = null;
    if (crow.advertiser) {
      [[account]] = await conn.query('SELECT balance_micros FROM adv_balance WHERE advertiser=? FOR UPDATE', [crow.advertiser]);
    }
    const insufficient = Number(crow.budget_micros) < micros ||
      (crow.advertiser && (!account || Number(account.balance_micros) < micros));
    if (insufficient) {
      await conn.query('UPDATE adv_ledger SET insufficient=1 WHERE imp_id=? AND req_id=?', [imp, reqId]);
      await conn.commit();
      cache.incr('charge_insufficient');
      return res.json({ ok: true, counted: true, charged: micros, insufficient: true });
    }
    await conn.query('UPDATE adv_campaign SET budget_micros=budget_micros-? WHERE id=?', [micros, id]);
    if (crow.advertiser) {
      await conn.query('UPDATE adv_balance SET balance_micros=balance_micros-? WHERE advertiser=?', [micros, crow.advertiser]);
    }
    await conn.query('INSERT INTO daily_spend (campaign_id,d,micros) VALUES (?,CURDATE(),?) ON DUPLICATE KEY UPDATE micros=micros+VALUES(micros)', [id, micros]);
    await conn.commit();
    bustPace(id);
    res.json({ ok: true, counted: true, charged: micros, insufficient: false });
  } catch (e) {
    if (conn) await conn.rollback().catch(() => {});
    res.status(500).json({ error: e.message });
  } finally {
    if (conn) conn.release();
  }
}
// Fix-09：/notify（历史路径，SDK 已在使用）与 /api/notify（文档/前端写法）等价，均走 HMAC 校验
app.post('/notify', handleNotify);
app.post('/api/notify', handleNotify);

// ===== 媒体方（供给）入驻 API =====
app.post('/api/publisher', async (req, res) => {
  const { name, contact, payout_rate, site_url, cat, geo, keywords, email, store_url } = req.body || {};
  // 域名归一化：https://dellai.xyz/ → dellai.xyz，保证与竞价日志、自检、报表口径一致
  const domain = normalizeDomain((req.body || {}).domain);
  if (!domain) return res.status(400).json({ error: 'domain required' });
  if (!isDomain(domain)) return res.status(400).json({ error: '域名不合法，请填写裸域名（如 dellai.xyz），不要带 http:// 或路径' });
  // 登录账号必须是邮箱（账号规范）：域名是"数据作用域"，不是登录名
  if (!email || !isEmail(email)) return res.status(400).json({ error: '媒体入驻需提供登录邮箱（email）；域名仅作数据作用域，不作登录名' });
  const rate = payout_rate != null ? Math.max(0.1, Math.min(0.95, Number(payout_rate))) : 0.70;
  // 幂等 + 安全：同域名重复入驻，绝不重置 api_key / account_code（否则已嵌入生产 App 的 SDK 直接失效、账号唯一码错乱）
  // 只查 api_key（publishers 无 account_code 列；唯一码在 accounts 表），避免查询报错导致幂等失效
  const [[exist]] = await pool.query('SELECT api_key FROM publishers WHERE domain=?', [domain]).catch(() => [[]]);
  await pool.query('INSERT INTO publishers (domain,name,contact,payout_rate,site_url,cat,geo,keywords,store_url) VALUES (?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE name=VALUES(name),contact=VALUES(contact),payout_rate=VALUES(payout_rate),site_url=VALUES(site_url),cat=VALUES(cat),geo=VALUES(geo),keywords=VALUES(keywords),store_url=VALUES(store_url)',
    [domain, name || domain, contact || '', rate, site_url || '', cat || '', geo || '', keywords || '', store_url || '']);
  pubMetaCache.set(domain, { rate, cat: cat || '', geo: geo || '', keywords: (keywords || '').split(',').filter(Boolean) });
  // 媒体独立账号：登录=邮箱，作用域=域名，生成唯一码（已存在则复用，绝不重置）
  let acctPass = null, accCode = null;
  try {
    const [[acc]] = await pool.query('SELECT id,account_code FROM accounts WHERE type="publisher" AND (username=? OR scope=?)', [email, domain]);
    if (acc && acc.id) {
      accCode = acc.account_code;
      await pool.query('UPDATE accounts SET display=?, scope=? WHERE id=?', [name || domain, domain, acc.id]).catch(() => {});
    } else {
      acctPass = (req.body && req.body.password) ? String(req.body.password) : ('pub_' + crypto.randomBytes(6).toString('hex'));
      accCode = genAccountCode('publisher');
      await pool.query('INSERT INTO accounts (type,username,pass_hash,scope,display,account_code) VALUES (?,?,?,?,?,?)',
        ['publisher', email, security.hashPwd(acctPass), domain, name || domain, accCode]).catch(() => {});
    }
  } catch (e) {}
  // api_key：仅首次（或历史缺失）签发，重复入驻保持原值不变
  const key = (exist && exist.api_key) ? exist.api_key : ('pub_' + crypto.randomBytes(16).toString('hex'));
  if (!exist || !exist.api_key) await pool.query('UPDATE publishers SET api_key=? WHERE domain=?', [key, domain]).catch(() => {});
  const idem = !!exist;
  res.json({ ok: true, idempotent: idem, domain, payout_rate: rate, api_key: idem ? undefined : key, keyIssued: !idem,
    account: { username: email, account_code: accCode, password: acctPass },
    note: idem ? '已入驻，密钥与账号唯一码保持不变（SDK 用 api_key，后台登录用邮箱）。' : '首次入驻：SDK 用 api_key（见 api_key 字段），后台登录用邮箱（初始密码见 account.password，请登录后修改）。' });
});

// 查看 / 轮换媒体服务端密钥（S2S 回调签名用）
app.get('/api/publisher/:domain/key', security.requireAdmin('pubkey'), async (req, res) => {
  const d = String(req.params.domain || '');
  try {
    if (String(req.query.rotate || '') === '1') {
      const k = 'pub_' + crypto.randomBytes(16).toString('hex');
      await pool.query('UPDATE publishers SET api_key=? WHERE domain=?', [k, d]);
      return res.json({ ok: true, domain: d, api_key: k, rotated: true });
    }
    const [[row]] = await pool.query('SELECT api_key FROM publishers WHERE domain=?', [d]);
    res.json({ ok: true, domain: d, api_key: (row && row.api_key) || '' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/publishers', security.requireAdmin('publist'), async (_, res) => {
  try { const [rows] = await pool.query('SELECT domain,name,contact,payout_rate,site_url,cat,geo,keywords,status FROM publishers'); res.json(rows); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
// 合规供给爬虫：抓取媒体方自己声明的 site_url，LLM 提取 cat/geo/keywords 回填（限流+冷却由调用方控制）
app.post('/api/publisher/:domain/crawl', security.requireAdmin('pubcrawl'), async (req, res) => {
  const domain = req.params.domain;
  try {
    const [[p]] = await pool.query('SELECT site_url FROM publishers WHERE domain=?', [domain]);
    if (!p || !p.site_url) return res.status(400).json({ error: '该媒体方未声明 site_url，无法合规爬取' });
    const r = await fetch(p.site_url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SupplyCrawler/1.0)' } });
    if (!r.ok) return res.status(502).json({ error: '抓取失败 ' + r.status });
    const html = await r.text();
    const text = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 2000);
    const prof = await llm.extractSupplyTags(text);
    if (!prof) return res.json({ ok: false, reason: 'LLM 未返回(未配置Key时用启发式)' });
    const kw = [...new Set([...(prof.keywords || []), ...(prof.tags || [])])].join(',');
    await pool.query('UPDATE publishers SET cat=?, geo=?, keywords=?, last_crawl=? WHERE domain=?',
      [prof.category || '', (prof.geo || [])[0] || '', kw, Date.now(), domain]);
    pubMetaCache.set(domain, { rate: (pubMetaCache.get(domain) || {}).rate || 0.70, cat: prof.category || '', geo: (prof.geo || [])[0] || '', keywords: kw.split(',').filter(Boolean) });
    res.json({ ok: true, domain, cat: prof.category, geo: prof.geo, keywords: kw, summary: prof.summary, llm_enabled: llm.ENABLED });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== 广告主控制台 API =====

// 幂等去重缓存：advertiser:name → { id, ts }，5 秒窗口内相同请求直接返回已创建计划
// 第一性原理：同一次意图只能落一次库，friction 不该由"用户不敢点"来承担
var _campaignDedup = new Map();
function _dedupKey(advertiser, name) {
  var bucket = Math.floor(Date.now() / 5000); // 5 秒时间桶
  return advertiser + ':' + name + ':' + bucket;
}
function _checkDedup(advertiser, name) {
  var key = _dedupKey(advertiser, name);
  var entry = _campaignDedup.get(key);
  if (entry) return entry;
  return null;
}
function _setDedup(advertiser, name, id) {
  var key = _dedupKey(advertiser, name);
  _campaignDedup.set(key, { id: id, ts: Date.now() });
  // 定期清理过期条目
  if (_campaignDedup.size > 200) {
    var now = Date.now();
    for (var k of _campaignDedup.keys()) {
      var v = _campaignDedup.get(k);
      if (now - v.ts > 30000) _campaignDedup.delete(k);
    }
  }
}

app.post('/api/campaign', security.requireAuth('admin','advertiser'), async (req, res) => {
  const { name, advertiser: advBody, budget_cny, country, app_category, creative_html, landing_url, target_cpm_cny, intent_tags,
          goal_type, target_cpa_cny, target_roas, daily_cap_cny, geo_country, schedule, creative_id, device_type, os, bid_floor_cny,
          retarget, retarget_window_days, freq_cap, creative_ids, interest_target, lookalike,
          app_id, conversion_event, attribution_partner, attribution_key, start_date, end_date, bid_strategy, bid_value, exclude_audience, exclusion,
          pacing_mode, daypart, fallback_html } = req.body || {};
  const advertiser = (req.account && req.account.t === 'advertiser') ? req.account.s : (advBody || '');
  if (!name) return res.status(400).json({ error: 'name required' });
  // 兜底创意：前端/接口文档可能用 creative_html 或 fallback_html，两种命名都接受（统一口径）
  const creativeHtml = (creative_html != null && String(creative_html).trim()) ? creative_html : (fallback_html || '');

  // ── 幂等校验：5 秒内同 advertiser + 同 name 的重复请求直接返回已创建计划 ──
  const dup = _checkDedup(advertiser, name);
  if (dup) {
    return res.json({ ok: true, id: dup.id, duplicate: true, note: '已在 5 秒内创建，返回已有计划 #' + dup.id });
  }

  // 多素材 A/B：creative_ids 传多个 → 全部绑定到本计划、creative_id 置 0（走 Thompson 自动优选）
  // 单素材仍按原逻辑锁定 creative_id（保底行为不变）
  const cids = Array.isArray(creative_ids) ? creative_ids.map(Number).filter(x => x > 0) : [];
  let cid = Number(creative_id) || 0;
  let hasCreative = cids.length > 0 || cid > 0 || (creativeHtml && String(creativeHtml).trim());
  // 开户即送示例素材：未显式选创意时，自动绑定该广告主首个已审创意（对标 AppLovin 首次登录即送模板，降低冷启动门槛）
  if (!hasCreative) {
    try {
      const [[fc]] = await pool.query("SELECT id FROM creatives WHERE advertiser=? AND creative_status='approved' ORDER BY id ASC LIMIT 1", [advertiser]);
      if (fc && fc.id) { cid = fc.id; hasCreative = true; }
    } catch (e) {}
  }
  const lockCreative = cids.length === 1 ? cids[0] : (cids.length ? 0 : cid);
  if (!hasCreative) return res.status(400).json({ error: '请在素材库选择创意，或填写兜底创意HTML；也可先到「素材库」上传一支素材' });
  // 统一出价策略（对齐 AppLovin / Mintegral）：bid_strategy + bid_value 映射到引擎的 goal_type / target_*
  //   CPM  = 目标千次曝光成本（元）      CPA  = 目标单次转化成本（元）
  //   oCPI = 目标单次安装成本 CPI（元）  ROAS = 目标广告支出回报率（倍数，如 1.5）
  // 未传 bid_strategy 时回退到旧字段 goal_type，保证老调用兼容。
  const strategy = (String(bid_strategy || '').toUpperCase() || String(goal_type || 'CPM').toUpperCase());
  const bv = Number(bid_value) || 0;
  let _cpmCny = Number(target_cpm_cny) || 5;
  let _cpaCny = Number(target_cpa_cny) || 0;
  let _roas = Number(target_roas) || 1;
  if (strategy === 'CPM' && bv > 0) _cpmCny = bv;
  else if ((strategy === 'CPA' || strategy === 'OCPI' || strategy === 'CPI') && bv > 0) _cpaCny = bv;
  else if (strategy === 'ROAS' && bv > 0) _roas = bv;
  const budget_micros = Math.round((budget_cny || 1000) * 1e6);
  const target_cpm_micros = Math.round(_cpmCny * 1e6);
  const daily_cap_micros = Math.round((daily_cap_cny || 0) * 1e6);
  const target_cpa_micros = Math.round(_cpaCny * 1e6);
  const roas = _roas;
  const goal = (strategy === 'OCPI' || strategy === 'CPI') ? 'CPI' : (strategy === 'ROAS' ? 'ROAS' : (strategy === 'CPA' ? 'CPA' : 'CPM'));
  const bid_floor_micros = Math.round((Number(bid_floor_cny) || 0) * 1e6);
  // ① 日期兼容：前端 <input type="date"> 传 "YYYY-MM-DD"（直接 Number() 会得到 NaN → 日期丢失），也可能传 epoch ms
  const _toMs = (v) => { if (!v) return 0; const n = Number(v); if (Number.isFinite(n) && n > 1e12) return n; const t = Date.parse(String(v)); return Number.isFinite(t) ? t : 0; };
  const startMs = _toMs(start_date);
  const endMs = _toMs(end_date);
  // ② 排除受众兼容：前端传 exclusion 对象，也可直接传 exclude_audience 枚举（none/installed/converted/both）
  let exclAud = String(exclude_audience || '').trim().toLowerCase();
  if (!exclAud && exclusion && typeof exclusion === 'object') {
    const ei = Number(exclusion.exclude_installed) ? 1 : 0;
    const ec = Number(exclusion.exclude_converted) ? 1 : 0;
    exclAud = (ei && ec) ? 'both' : (ei ? 'installed' : (ec ? 'converted' : 'none'));
  }
  if (!exclAud) exclAud = 'none';
  const [r] = await pool.query('INSERT INTO adv_campaign (name,advertiser,budget_micros,country,app_category,creative_html,landing_url,target_cpm_micros,intent_tags,review_status,goal_type,target_cpa_micros,target_roas,daily_cap_micros,geo_country,creative_id,device_type,os,bid_floor_micros,retarget,retarget_window_days,interest_target,lookalike,app_id,conversion_event,attribution_partner,attribution_key,start_date,end_date,bid_strategy,bid_value,exclude_audience) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    [name, advertiser || '', budget_micros, country || '', app_category || '', creativeHtml || '', landing_url || '', target_cpm_micros, intent_tags || '', 'pending', goal, target_cpa_micros, roas, daily_cap_micros, geo_country || '', lockCreative, String(device_type || '').trim(), String(os || '').trim().toLowerCase(), bid_floor_micros, Number(retarget) ? 1 : 0, Math.max(1, Number(retarget_window_days) || 7), String(interest_target || '').trim().toLowerCase(), Number(lookalike) ? 1 : 0,
     String(app_id || '').trim(), String(conversion_event || 'install').trim().toLowerCase(), String(attribution_partner || '').trim().toLowerCase(), String(attribution_key || '').trim(), startMs, endMs, strategy, bv, exclAud]);
  // 计划↔素材库 强关联：把所选创意绑定到本计划（campaign_id），bidder 只取素材库
  const bindIds = cids.length ? cids : (cid > 0 ? [cid] : []);
  for (const one of bindIds) await pool.query('UPDATE creatives SET campaign_id=? WHERE id=? AND advertiser=?', [r.insertId, one, advertiser]).catch(() => {});
  // 投放时段(daypart) + 频控(freq_cap)：写入 campaign_delivery（空/全天=默认）
  const fcNorm = normalizeFreqCap(freq_cap);
  // 优先级：① daypart obj（{days, hours}）→ 生成 hex mask；② schedule 字符串预设 → scheduleToMask()；③ 都不填 = null（全天）
  let daypartMask = null;
  if (daypart && (daypart.days || daypart.hours)) {
    const days = Array.isArray(daypart.days) ? daypart.days.map(Number).filter(x => x >= 1 && x <= 7) : [];
    const hours = Array.isArray(daypart.hours) ? daypart.hours.map(Number).filter(x => x >= 0 && x <= 23) : [];
    daypartMask = daypartMaskFromDaysHours(days, hours);
  } else if (schedule && String(schedule).trim()) {
    daypartMask = scheduleToMask(schedule);
  }
  const pm = String(pacing_mode || '').trim().toUpperCase();
  const mode = (pm === 'SMOOTH' || pm === 'ASAP' || pm === 'EVEN') ? pm : 'SMOOTH';
  if (daypartMask || fcNorm) {
    try {
      await pool.query('INSERT INTO campaign_delivery (campaign_id,mode,daypart,freq_cap) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE mode=VALUES(mode), daypart=COALESCE(VALUES(daypart), daypart), freq_cap=COALESCE(VALUES(freq_cap), freq_cap)',
        [r.insertId, mode, daypartMask, fcNorm ? JSON.stringify(fcNorm) : null]);
    } catch (e) { console.error('[pacing]', e.message); }
  }
  enrichCampaign(r.insertId).catch(e => console.error('[enrich]', e.message)); // 异步 LLM 抽意图
  _setDedup(advertiser, name, r.insertId); // 记录幂等键
  res.json({ ok: true, id: r.insertId, llm_enrich: llm.ENABLED, review_status: 'pending' });
});
app.get('/api/campaigns', security.requireAuth('admin','advertiser'), async (req, res) => {
  const acc = req.account;
  const sql = acc.t === 'advertiser'
    ? 'SELECT id,name,advertiser,budget_micros,status,country,app_category,target_cpm_micros,intent_tags,intent_profile,review_status,review_note,goal_type,target_cpa_micros,target_roas,daily_cap_micros,geo_country,creative_id,device_type,os,bid_floor_micros,retarget,retarget_window_days,interest_target,lookalike,app_id,conversion_event,attribution_partner,attribution_key,start_date,end_date,bid_strategy,bid_value,exclude_audience, COALESCE((SELECT 1 FROM creatives cc WHERE cc.campaign_id=c.id LIMIT 1),0) AS has_creative FROM adv_campaign c WHERE advertiser=?'
    : 'SELECT id,name,advertiser,budget_micros,status,country,app_category,target_cpm_micros,intent_tags,intent_profile,review_status,review_note,goal_type,target_cpa_micros,target_roas,daily_cap_micros,geo_country,creative_id,device_type,os,bid_floor_micros,retarget,retarget_window_days,interest_target,lookalike,app_id,conversion_event,attribution_partner,attribution_key,start_date,end_date,bid_strategy,bid_value,exclude_audience, COALESCE((SELECT 1 FROM creatives cc WHERE cc.campaign_id=c.id LIMIT 1),0) AS has_creative FROM adv_campaign c';
  const [rows] = await pool.query(sql, acc.t === 'advertiser' ? [acc.s] : []);
  res.json(rows.map(c => ({
    ...c, budget_cny: c.budget_micros / 1e6, target_cpm_cny: c.target_cpm_micros / 1e6, bid_floor_cny: (c.bid_floor_micros || 0) / 1e6,
    intent_summary: (c.intent_profile && JSON.parse(c.intent_profile).summary) || null,
    intent_source: c.intent_profile ? 'llm' : 'manual',
  })));
});

// 编辑已有 Campaign（inline edit 支持：预算/日预算/出价/目标/日期/受众/排除/意图标签 等）
// 对标 AppLovin：广告主能直接改计划，不需重建。变更 pacing/daypart/freqCap 时同步写 campaign_delivery。
app.put('/api/campaign/:id', security.requireAuth('admin', 'advertiser'), async (req, res) => {
  const id = Number(req.params.id);
  const b = req.body || {};
  try {
    const [[c]] = await pool.query('SELECT id,advertiser FROM adv_campaign WHERE id=?', [id]);
    if (!c) return res.status(404).json({ error: 'not found' });
    if (req.account.t === 'advertiser' && c.advertiser !== req.account.s) return res.status(403).json({ error: '无权修改他人计划' });
    const set = [], val = [];
    const p = (col, v) => { if (v !== undefined && v !== null) { set.push(col + '=?'); val.push(v); } };
    // 基础字段
    p('name', b.name != null ? String(b.name).trim() : null);
    p('budget_micros', b.budget_cny != null ? Math.round(Number(b.budget_cny) * 1e6) : null);
    p('daily_cap_micros', b.daily_cap_cny != null ? Math.round(Number(b.daily_cap_cny) * 1e6) : null);
    p('country', b.country != null ? String(b.country).trim() : null);
    p('geo_country', b.geo_country != null ? String(b.geo_country).trim() : null);
    p('app_category', b.app_category != null ? String(b.app_category).trim() : null);
    p('target_cpm_micros', b.target_cpm_cny != null ? Math.round(Number(b.target_cpm_cny) * 1e6) : null);
    p('target_cpa_micros', b.target_cpa_cny != null ? Math.round(Number(b.target_cpa_cny) * 1e6) : null);
    p('target_roas', b.target_roas != null ? (Number(b.target_roas) || 0) : null);
    p('goal_type', b.goal_type != null ? String(b.goal_type).trim() : null);
    p('bid_floor_micros', b.bid_floor_cny != null ? Math.round(Number(b.bid_floor_cny) * 1e6) : null);
    p('intent_tags', b.intent_tags != null ? String(b.intent_tags).trim() : null);
    p('app_id', b.app_id != null ? String(b.app_id).trim() : null);
    p('conversion_event', b.conversion_event != null ? String(b.conversion_event).trim().toLowerCase() : null);
    p('attribution_partner', b.attribution_partner != null ? String(b.attribution_partner).trim().toLowerCase() : null);
    p('attribution_key', b.attribution_key != null ? String(b.attribution_key).trim() : null);
    p('bid_strategy', b.bid_strategy != null ? String(b.bid_strategy).toUpperCase() : null);
    p('bid_value', b.bid_value != null ? (Number(b.bid_value) || 0) : null);
    p('device_type', b.device_type != null ? String(b.device_type).trim() : null);
    p('os', b.os != null ? String(b.os).trim().toLowerCase() : null);
    p('retarget', b.retarget != null ? (Number(b.retarget) ? 1 : 0) : null);
    p('retarget_window_days', b.retarget_window_days != null ? Math.max(1, Number(b.retarget_window_days) || 7) : null);
    p('interest_target', b.interest_target != null ? String(b.interest_target).trim().toLowerCase() : null);
    p('lookalike', b.lookalike != null ? (Number(b.lookalike) ? 1 : 0) : null);
    // 排除受众：兼容 exclusion obj 和 exclude_audience 枚举
    let exclAud = b.exclude_audience != null ? String(b.exclude_audience).trim().toLowerCase() : null;
    if (!exclAud && b.exclusion && typeof b.exclusion === 'object') {
      const ei = Number(b.exclusion.exclude_installed) ? 1 : 0;
      const ec = Number(b.exclusion.exclude_converted) ? 1 : 0;
      exclAud = (ei && ec) ? 'both' : (ei ? 'installed' : (ec ? 'converted' : 'none'));
    }
    if (exclAud) p('exclude_audience', exclAud);
    // 日期：兼容 YYYY-MM-DD / epoch ms
    const _toMs = (v) => { if (!v) return 0; const n = Number(v); if (Number.isFinite(n) && n > 1e12) return n; const t = Date.parse(String(v)); return Number.isFinite(t) ? t : 0; };
    if (b.start_date !== undefined) p('start_date', _toMs(b.start_date));
    if (b.end_date !== undefined) p('end_date', _toMs(b.end_date));
    // 状态：允许广告主启停（不改审核状态）
    if (b.status !== undefined) p('status', Number(b.status) ? 1 : 0);
    if (!set.length) return res.status(400).json({ error: '无可更新字段' });
    val.push(id);
    await pool.query('UPDATE adv_campaign SET ' + set.join(',') + ' WHERE id=?', val);
    // 同步 pacing/daypart/freqCap 到 campaign_delivery
    const pm = String(b.pacing_mode || '').trim().toUpperCase();
    const daypartObj = b.daypart && (b.daypart.days || b.daypart.hours);
    const fc = b.freq_cap;
    let daypartMask = null;
    if (daypartObj) {
      const days = Array.isArray(b.daypart.days) ? b.daypart.days.map(Number).filter(x => x >= 1 && x <= 7) : [];
      const hours = Array.isArray(b.daypart.hours) ? b.daypart.hours.map(Number).filter(x => x >= 0 && x <= 23) : [];
      daypartMask = daypartMaskFromDaysHours(days, hours);
    }
    const fcNorm = fc ? normalizeFreqCap(fc) : null;
    if (pm || daypartMask || fc) {
      const mode = (pm === 'SMOOTH' || pm === 'ASAP' || pm === 'EVEN') ? pm : null;
      try {
        await pacing.save(id, {
          mode: mode || undefined,
          daypart: daypartMask || undefined,
          freqCap: fcNorm || undefined,
        });
      } catch (e) { console.error('[pacing]', e.message); }
    }
    // 编辑即视为修改了配置，如果原本是 rejected，自动重提审核
    const [[c2]] = await pool.query('SELECT review_status FROM adv_campaign WHERE id=?', [id]);
    if (c2 && c2.review_status === 'rejected') {
      await pool.query("UPDATE adv_campaign SET review_status='pending', review_note='' WHERE id=?", [id]);
    }
    enrichCampaign(id).catch(e => console.error('[enrich]', e.message));
    res.json({ ok: true, id, review_status: c2 && c2.review_status === 'rejected' ? 'pending' : (c2 ? c2.review_status : null) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/intent-match', security.requireAuth('admin', 'advertiser'), async (req, res) => {
  const ctx = req.body || {};
  // 数据隔离：广告主只看自己名下的计划。
  // 【安全修复】此前本接口完全匿名且 SELECT 全量在投计划（名称/预算/目标CPM/意图画像），
  // 任何人一次请求即可枚举所有广告主的商业数据。
  const isAdv = req.account.t === 'advertiser';
  const [rows] = await pool.query(
    isAdv ? 'SELECT * FROM adv_campaign WHERE status=1 AND advertiser=?' : 'SELECT * FROM adv_campaign WHERE status=1',
    isAdv ? [req.account.s] : []);
  const matches = [];
  for (const c of rows) {
    const rel = await llmRel(c, ctx);
    matches.push({
      id: c.id, name: c.name,
      intent_score: rel.score, source: rel.llm ? 'llm' : 'heuristic', reason: rel.reason,
      est_cpm_cny: Math.round(Math.min(c.target_cpm_micros, c.budget_micros) * (1 + 0.5 * rel.score) / 1e4) / 100,
    });
  }
  matches.sort((a, b) => b.intent_score - a.intent_score);
  res.json({ ctx, llm_enabled: llm.ENABLED, llm_hot_path: process.env.LLM_HOT_PATH === '1', matches,
    hint: matches.length ? undefined : (isAdv ? ('当前账户下没有「在投(status=1)」计划；建计划并审核通过后即可看到意图匹配结果（' + (llm.ENABLED ? 'LLM 已配置，热路径开启后自动激活' : 'LLM 未配置，走 LR 启发式') + '）') : '暂无在投计划') });
});

// LLM 抽取意图：单个 campaign 重抽（创建时也会自动抽）
app.post('/api/intent-extract/:id', security.requireAuth('admin','advertiser'), async (req, res) => {
  try {
    const id = +req.params.id;
    if (req.account.t === 'advertiser') {
      const [[c]] = await pool.query('SELECT id FROM adv_campaign WHERE id=? AND advertiser=?', [id, req.account.s]);
      if (!c) return res.status(403).json({ error: '无权操作他人计划' });
    }
    await enrichCampaign(id);
    const [[c]] = await pool.query('SELECT id,name,intent_tags,intent_profile FROM adv_campaign WHERE id=?', [id]);
    res.json({ ok: true, id: c.id, name: c.name, intent_tags: c.intent_tags, intent_profile: c.intent_profile ? JSON.parse(c.intent_profile) : null, llm_enabled: llm.ENABLED });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// LLM 抽取意图：批量重抽所有在投 campaign
app.post('/api/intent-extract', security.requireAdmin('enrich'), async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT id FROM adv_campaign WHERE status=1');
    await Promise.all(rows.map(r => enrichCampaign(r.id)));
    res.json({ ok: true, enriched: rows.length, llm_enabled: llm.ENABLED });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// 并单：更新 campaign 意图标签（意图 Agent 自动撮合时调用）
// 广告主自助视图：只看自己作用域内的计划 + 聚合数据（对标 AppLovin 广告主后台）
// ── 广告主作用域解析（消除运营走查时的 401 / 空数据）──
// 广告主恒为自己；运营(admin)可用 ?advertiser= 指定任意广告主，
// 缺省回退到「最近建过计划的广告主」，避免 admin 以 scope='*' 查询（advertiser='*' 匹配不到任何行）
// 导致前端显示「加载失败 / 加载中…」。
async function resolveAdvScope(req) {
  if (req.account && req.account.t === 'advertiser') return req.account.s;
  const q = String((req.query && req.query.advertiser) || (req.body && req.body.advertiser) || '').trim();
  if (q) return q;
  try {
    const [rows] = await pool.query("SELECT advertiser FROM adv_campaign WHERE advertiser<>'' ORDER BY id DESC LIMIT 1");
    if (rows && rows.length && rows[0].advertiser) return rows[0].advertiser;
  } catch (e) {}
  return '';
}
app.get('/api/advertiser/me', security.requireAuth('admin', 'advertiser'), async (req, res) => {
  const adv = await resolveAdvScope(req);
  try {
    const [rows] = await pool.query('SELECT id,name,advertiser,budget_micros,status,review_status,country,app_category,target_cpm_micros FROM adv_campaign WHERE advertiser=?', [adv]);
    // 概览聚合：对标 AppLovin 首屏 Performance 概览，补齐 clicks/conversions/CTR/ROAS（原先只有曝光/消耗/GMV）。
    // 用子聚合 conv 避免 join 扇出把 bid_win_log 的 price 重复累加。
    const [[agg]] = await pool.query(`
      SELECT COUNT(DISTINCT b.imp_id) impressions,
             COALESCE(SUM(b.price_micros),0)/1e6 spent_cny,
             COALESCE(SUM(c.amount),0) gmv,
             COALESCE(SUM(c.clicks),0) clicks,
             COALESCE(SUM(c.conversions),0) conversions
      FROM adv_campaign a
      LEFT JOIN bid_win_log b ON b.campaign_id=a.id
      LEFT JOIN (
        SELECT campaign_id,
               SUM(type='click') AS clicks,
               SUM(type='conversion') AS conversions,
               SUM(CASE WHEN type='conversion' THEN amount ELSE 0 END) AS amount
        FROM conv_log GROUP BY campaign_id
      ) c ON c.campaign_id = a.id
      WHERE a.advertiser LIKE ?`, [adv]);
    const [[prof]] = await pool.query('SELECT company,tax_id,app_category,target_cpm_cny,landing_url FROM advertiser_profile WHERE advertiser=?', [adv]).catch(() => [[]]);
    const imp = Number(agg.impressions) || 0, spend = Number(agg.spent_cny) || 0, gmv = Number(agg.gmv) || 0;
    const clicks = Number(agg.clicks) || 0, conv = Number(agg.conversions) || 0;
    res.json({ advertiser: adv, profile: prof || null, campaigns: rows.map(c => ({ ...c, budget_cny: c.budget_micros / 1e6 })),
      stats: { impressions: imp, spent_cny: spend, gmv, clicks, conversions: conv,
        ctr: imp ? +(clicks / imp * 100).toFixed(3) : 0,
        cpa_cny: conv ? +(spend / conv).toFixed(4) : 0,
        roas: spend ? +(gmv / spend).toFixed(4) : 0 } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 广告主自助结算/对账：按 campaign 拆分自己的消耗/GMV/转化（对标 AppLovin 广告主看报表，无需管理员令牌）
// 路由前缀 /api/advertiser/* 不在 ADMIN_PREFIXES 的 /api/reports 下，不会被管理员网关拦截 → 广告主可自助查询
app.get('/api/advertiser/settlement', security.requireAuth('admin', 'advertiser'), async (req, res) => {
  const adv = req.account.t === 'advertiser' ? req.account.s : String(req.query.advertiser || '').trim();
  if (!adv) return res.status(400).json({ error: 'advertiser required' });
  try {
    const [rows] = await pool.query(`SELECT c.id,c.name,c.status,c.budget_micros,c.target_cpm_micros,
      COALESCE(SUM(b.price_micros),0)/1e6 spent_cny,
      COALESCE(SUM(cv.amount),0) gmv,
      COUNT(DISTINCT b.imp_id) impressions,
      COALESCE(SUM(cv.clicks),0) clicks,
      COALESCE(SUM(cv.conversions),0) conversions
      FROM adv_campaign c
      LEFT JOIN bid_win_log b ON b.campaign_id=c.id
      LEFT JOIN (SELECT campaign_id, SUM(type='click') clicks, SUM(type='conversion') conversions, SUM(CASE WHEN type='conversion' THEN amount ELSE 0 END) amount FROM conv_log GROUP BY campaign_id) cv ON cv.campaign_id=c.id
      WHERE c.advertiser=? GROUP BY c.id ORDER BY c.id DESC`, [adv]);
    let totalSpent = 0, totalGmv = 0;
    const list = rows.map(function (c) {
      const s = Number(c.spent_cny) || 0, g = Number(c.gmv) || 0; totalSpent += s; totalGmv += g;
      const conv = Number(c.conversions) || 0;
      return { id: c.id, name: c.name, status: c.status, budget_cny: Number(c.budget_micros) / 1e6, target_cpm_cny: Number(c.target_cpm_micros) / 1e6,
        impressions: Number(c.impressions) || 0, spent_cny: s, gmv: g, clicks: Number(c.clicks) || 0, conversions: conv,
        cpa_cny: conv ? +(s / conv).toFixed(4) : 0, roas: s ? +(g / s).toFixed(4) : 0 };
    });
    res.json({ advertiser: adv, total_spent_cny: totalSpent, total_gmv: totalGmv, campaigns: list,
      note: '广告主自助对账：以上为你的计划消耗/GMV，与媒体侧结算相互独立；争议以服务端账本为准。' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── 广告主资料补全（对标 AppLovin/Mintegral：开户后在 Settings 页按需补全，不阻塞建计划）──
// GET /api/advertiser/profile → 返回当前广告主资料
app.get('/api/advertiser/profile', security.requireAuth('admin', 'advertiser'), async (req, res) => {
  const adv = req.account.s;
  try {
    const [[prof]] = await pool.query('SELECT * FROM advertiser_profile WHERE advertiser=?', [adv]);
    res.json(prof || { advertiser: adv, company: '', tax_id: '', app_category: '', target_cpm_cny: 6, landing_url: '',
      goal: '', privacy_policy_url: '', dpa_url: '', alert_over_budget: 1, alert_anomaly: 1, alert_email: '' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/advertiser/profile → 更新广告主资料（公司名、税号、品类、目标CPM、落地页、网站、联系方式）
app.put('/api/advertiser/profile', security.requireAuth('admin', 'advertiser'), async (req, res) => {
  const adv = await resolveAdvScope(req);
  const b = req.body || {};
  try {
    // 只更新"本次传了"的字段：未传的合规字段保持原值，避免被默认值覆盖
    const put2 = [], v2 = [];
    const setF = function (col, val) { if (val !== undefined && val !== null) { put2.push(col + '=?'); v2.push(val); } };
    setF('company', b.company != null ? String(b.company) : null);
    setF('tax_id', b.tax_id != null ? String(b.tax_id) : null);
    setF('app_category', b.app_category != null ? String(b.app_category) : null);
    setF('target_cpm_cny', b.target_cpm_cny != null ? (Number(b.target_cpm_cny) || 6) : null);
    setF('landing_url', b.landing_url != null ? String(b.landing_url) : null);
    // 开户目标（投放目标 install/purchase/retention/brand）属账户资料；
    // 合规字段（privacy_policy_url / dpa_url / terms_url / coppa_mode / alert_*）已统一收敛到
    // /api/advertiser/compliance 单一入口，此处不再重复接收，避免"同一字段两条写入路径"。
    setF('goal', b.goal != null ? String(b.goal) : null);
    if (put2.length) {
      const cols = put2.map(function (s) { return s.split('=')[0]; });
      const insCols = ['advertiser'].concat(cols).concat(['updated_at']);
      const insVals = [adv].concat(v2).concat([Date.now()]);
      // ON DUPLICATE KEY UPDATE 必须用 VALUES(col) 而不是 '?'：
      // 用 '?' 会额外需要一组绑定值（此处只提供了 INSERT 的值）→ 报 SQL 绑定错误。
      const upd = cols.map(function (c) { return c + '=VALUES(' + c + ')'; }).concat(['updated_at=VALUES(updated_at)']);
      await pool.query('INSERT INTO advertiser_profile (' + insCols.join(',') + ') VALUES (' +
        insCols.map(function () { return '?'; }).join(',') + ') ON DUPLICATE KEY UPDATE ' + upd.join(','), insVals);
    }
    res.json({ ok: true, message: '资料已更新' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== 账户层合规基线（对标 AppLovin Account → Data Safety / GDPR / CCPA / COPPA）=====
// adv-account.html「⑦ 合规 & 隐私」面板调用本接口。此前该路由完全缺失（前端调了不存在的地址）
// → 合规信息与异常告警永远保存不成功。
app.get('/api/advertiser/compliance', security.requireAuth('admin', 'advertiser'), async (req, res) => {
  const adv = (req.account.t === 'advertiser') ? req.account.s : String(req.query.advertiser || '').trim();
  if (!adv) return res.status(400).json({ error: 'advertiser 必填' });
  try {
    const [[row]] = await pool.query('SELECT privacy_policy_url,terms_url,dpa_url,coppa_mode,alert_email,alert_over_budget,alert_anomaly,skan_cv_schema FROM advertiser_profile WHERE advertiser=?', [adv]).catch(() => [[]]);
    res.json(row || { privacy_policy_url: '', terms_url: '', dpa_url: '', coppa_mode: 0, alert_email: '', alert_over_budget: 1, alert_anomaly: 1, skan_cv_schema: '' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/advertiser/compliance', security.requireAuth('admin', 'advertiser'), async (req, res) => {
  const adv = (req.account.t === 'advertiser') ? req.account.s : String((req.body || {}).advertiser || '').trim();
  if (!adv) return res.status(400).json({ error: 'advertiser 必填' });
  const b = req.body || {};
  const set = [], val = [];
  const p = function (col, v) { if (v !== undefined && v !== null) { set.push(col + '=?'); val.push(v); } };
  p('privacy_policy_url', b.privacy_policy_url != null ? String(b.privacy_policy_url).trim() : null);
  p('terms_url', b.terms_url != null ? String(b.terms_url).trim() : null);
  p('dpa_url', b.dpa_url != null ? String(b.dpa_url).trim() : null);
  p('coppa_mode', b.coppa_mode != null ? (Number(b.coppa_mode) || 0) : null);
  p('alert_email', b.alert_email != null ? String(b.alert_email).trim() : null);
  p('alert_over_budget', b.alert_over_budget != null ? (Number(b.alert_over_budget) ? 1 : 0) : null);
  p('alert_anomaly', b.alert_anomaly != null ? (Number(b.alert_anomaly) ? 1 : 0) : null);
  p('skan_cv_schema', b.skan_cv_schema != null ? String(b.skan_cv_schema) : null);
  if (!set.length) return res.status(400).json({ error: '无可更新字段' });
  try {
    const cols = set.map(function (s) { return s.split('=')[0]; });
    const insCols = ['advertiser'].concat(cols).concat(['updated_at']);
    const insVals = [adv].concat(val).concat([Date.now()]);
    // 用 VALUES(col) 而非 '?'：'?' 需要额外一组绑定值，否则报 SQL 绑定错误
    const upd = cols.map(function (c) { return c + '=VALUES(' + c + ')'; }).concat(['updated_at=VALUES(updated_at)']);
    await pool.query('INSERT INTO advertiser_profile (' + insCols.join(',') + ') VALUES (' +
      insCols.map(function () { return '?'; }).join(',') + ') ON DUPLICATE KEY UPDATE ' + upd.join(','), insVals);
    res.json({ ok: true, message: '合规信息已保存' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── 自助在线支付（对标 AppLovin 按日扣卡模式）──
// GET /api/advertiser/payment/status → 余额 + 支付方式状态
app.get('/api/advertiser/payment/status', security.requireAuth('admin', 'advertiser'), async (req, res) => {
  const adv = await resolveAdvScope(req);
  try {
    const [[bal]] = await pool.query('SELECT balance_micros FROM adv_balance WHERE advertiser=?', [adv]).catch(() => [[{ balance_micros: 0 }]]);
    res.json({
      balance_cny: ((bal && bal.balance_micros) || 0) / 1e6,
      payment_methods: [],  // 预留：绑卡列表
      auto_recharge: false, // 预留：自动充值
      low_balance_threshold_cny: 100,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 广告主自助配置（账户页）：低余额阈值 / 自动充值 / 支付卡 / 通知偏好 落库（替代原先 localStorage）
const ADV_SETTINGS_DEF = {
  low_balance_threshold_cny: 100, auto_recharge: 0, payment_provider: '',
  payment_methods: [], notification_prefs: { balance: true, review: true, daily: false, weekly: false }
};
function _parseJsonCol(v, def) { if (!v) return def; try { return typeof v === 'string' ? JSON.parse(v) : v; } catch (e) { return def; } }
app.get('/api/advertiser/settings', security.requireAuth('admin', 'advertiser'), async (req, res) => {
  const adv = await resolveAdvScope(req);
  try {
    const [[bal]] = await pool.query('SELECT balance_micros FROM adv_balance WHERE advertiser=?', [adv]).catch(() => [[{ balance_micros: 0 }]]);
    const [[row]] = await pool.query('SELECT * FROM advertiser_settings WHERE advertiser=?', [adv]);
    const merged = row ? { ...ADV_SETTINGS_DEF, ...row,
      payment_methods: _parseJsonCol(row.payment_methods, []),
      notification_prefs: _parseJsonCol(row.notification_prefs, ADV_SETTINGS_DEF.notification_prefs) } : ADV_SETTINGS_DEF;
    res.json({ balance_cny: ((bal && bal.balance_micros) || 0) / 1e6, ...merged });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/advertiser/settings', security.requireAuth('admin', 'advertiser'), async (req, res) => {
  const adv = await resolveAdvScope(req); const b = req.body || {};
  try {
    const fields = {};
    if (b.low_balance_threshold_cny != null) fields.low_balance_threshold_cny = Math.max(0, Math.round(Number(b.low_balance_threshold_cny) || 0));
    if (b.auto_recharge != null) fields.auto_recharge = Number(b.auto_recharge) ? 1 : 0;
    if (b.payment_provider != null) fields.payment_provider = String(b.payment_provider).trim();
    if (b.payment_methods != null) fields.payment_methods = JSON.stringify(Array.isArray(b.payment_methods) ? b.payment_methods : []);
    if (b.notification_prefs != null) fields.notification_prefs = JSON.stringify(b.notification_prefs);
    if (!Object.keys(fields).length) return res.status(400).json({ error: '无可更新字段' });
    const cols = Object.keys(fields), vals = Object.values(fields);
    const insCols = ['advertiser', ...cols], insVals = [adv, ...vals];
    const upd = cols.map(c => c + '=VALUES(' + c + ')').join(',');
    await pool.query('INSERT INTO advertiser_settings (' + insCols.join(',') + ') VALUES (' + insCols.map(() => '?').join(',') + ') ON DUPLICATE KEY UPDATE ' + upd, insVals);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// ── 分维度效果看板（对标 AppLovin Performance Dashboard）──
// 第一性原理：平台的护城河是"ROI 预测比对手更准"，而前提是广告主能看清
// 「哪个素材 / 哪个地域 / 哪种设备 / 哪个时段」真的赚钱 —— 看不清就无法优化，数据飞轮断在这里。
// 原先 /api/advertiser/me 只返回该广告主的聚合值（总曝光/总消耗/总GMV），没有任何拆分维度。
// 依赖 bid_win_log 的 device_type / country / ad_format（本次新增）+ creative_id + created_at。
const PERF_DIMS = {
  creative:  { col: 'creative_id',  label: '素材' },
  campaign:  { col: 'campaign_id',  label: '计划ID' },
  geo:       { col: 'country',      label: '地域' },
  device:    { col: 'device_type',  label: '设备' },
  os:        { col: 'os',           label: '系统' },
  model:     { col: 'device_model', label: '机型' },
  unit:      { col: 'ad_unit_id',   label: '广告单元' },
  format:    { col: 'ad_format',    label: '广告形态' },
  publisher: { col: 'publisher',    label: '媒体' },
  // 注意：含 '(' 的是表达式，不能再加表别名前缀（w.HOUR(...) 会被 MySQL 当成
  // schema 限定的存储函数 → "execute command denied for routine 'w.HOUR'"）。
  hour:      { col: 'HOUR(w.created_at)', expr: true, label: '时段' },
  day:       { col: 'DATE(w.created_at)', expr: true, label: '日期' },
};
function perfDimExpr(d) { return d.expr ? d.col : ('w.' + d.col); }
app.get('/api/advertiser/performance', security.requireAuth('admin', 'advertiser'), async (req, res) => {
  const adv = await resolveAdvScope(req);
  if (!adv) return res.status(400).json({ error: 'advertiser 必填（当前无任何广告主计划）' });
  // 支持多维交叉下钻：?dims=geo,os,creative（也兼容旧的单 ?dim=geo）
  const rawDims = String(req.query.dims || req.query.dim || 'creative').split(',').map(s => s.trim()).filter(s => PERF_DIMS[s]);
  const dims = rawDims.length ? rawDims : ['creative'];
  const days = Math.min(90, Math.max(1, Number(req.query.days) || 7));
  try {
    const exprs = dims.map(k => perfDimExpr(PERF_DIMS[k]));
    const selExprs = exprs.map((e, i) => `${e} AS dk${i}`).join(',');
    // 曝光与消耗来自 bid_win_log；点击/转化/GMV 来自 conv_log（按 imp_id 关联到曝光，保证口径一致）
    const [rows] = await pool.query(`
      SELECT ${selExprs},
             COUNT(*) AS impressions,
             COALESCE(SUM(w.price_micros),0) AS spend_micros,
             COALESCE(SUM(c.clicks),0) AS clicks,
             COALESCE(SUM(c.conversions),0) AS conversions,
             COALESCE(SUM(c.gmv_micros),0) AS gmv_micros
      FROM bid_win_log w
      JOIN adv_campaign a ON a.id = w.campaign_id
      LEFT JOIN (
        SELECT imp_id,
               SUM(type='click') AS clicks,
               SUM(type='conversion') AS conversions,
               SUM(CASE WHEN type='conversion' THEN amount ELSE 0 END) AS gmv_micros
        FROM conv_log GROUP BY imp_id
      ) c ON c.imp_id = w.imp_id
      WHERE a.advertiser = ? AND w.created_at > NOW() - INTERVAL ? DAY AND COALESCE(w.billable,1)=1
      GROUP BY ${exprs.join(',')}
      ORDER BY impressions DESC
      LIMIT 500`, [adv, days]);
    // 素材维度：附上标题/形态/实时疲劳度（创意级 A/B 与疲劳度的可视化）
    const creativeIdx = dims.indexOf('creative');
    let creativeMeta = {};
    if (creativeIdx >= 0) {
      try {
        const [crs] = await pool.query("SELECT id,title,format,COALESCE(impressions,0) impressions,COALESCE(clicks,0) clicks,COALESCE(conversions,0) conversions FROM creatives WHERE advertiser=?", [adv]);
        creativeMeta = {}; creativeAb.computeFatigue(crs || []).forEach(v => { creativeMeta[v.id] = v; });
      } catch (e) {}
    }
    const items = rows.map(r => {
      const imp = Number(r.impressions) || 0;
      const spend = Number(r.spend_micros) || 0;
      const clicks = Number(r.clicks) || 0;
      const conv = Number(r.conversions) || 0;
      const gmv = Number(r.gmv_micros) || 0;
      const keys = dims.map((_, i) => (r['dk' + i] == null || r['dk' + i] === '') ? '(未知)' : String(r['dk' + i]));
      const o = {
        key: keys.join(' / '), dims: Object.fromEntries(dims.map((k, i) => [k, keys[i]])),
        impressions: imp,
        spend_cny: +(spend / 1e6).toFixed(4),
        clicks, conversions: conv,
        gmv_cny: +(gmv / 1e6).toFixed(4),
        cpm_cny: imp ? +(spend / 1e6 / (imp / 1000)).toFixed(4) : 0,
        ctr: imp ? +(clicks / imp * 100).toFixed(3) : 0,
        cpc_cny: clicks ? +(spend / 1e6 / clicks).toFixed(4) : 0,
        cpa_cny: conv ? +(spend / 1e6 / conv).toFixed(4) : 0,
        cvr: imp ? +(conv / imp * 100).toFixed(3) : 0,
        roas: spend ? +(gmv / spend).toFixed(4) : 0,
      };
      if (creativeIdx >= 0) {
        const meta = creativeMeta[Number(r['dk' + creativeIdx])];
        if (meta) { o.creative_title = meta.title; o.creative_format = meta.format; o.fatigue = meta.fatigue; o.creative_ctr = meta.ctr; }
      }
      return o;
    });
    const sum = items.reduce((s, x) => ({
      impressions: s.impressions + x.impressions, spend_cny: +(s.spend_cny + x.spend_cny).toFixed(4),
      clicks: s.clicks + x.clicks, conversions: s.conversions + x.conversions, gmv_cny: +(s.gmv_cny + x.gmv_cny).toFixed(4),
    }), { impressions: 0, spend_cny: 0, clicks: 0, conversions: 0, gmv_cny: 0 });
    // 频次分析：同一 imp_id（一次曝光机会）被曝光 N 次的分布（证明边际效果递减，指导频控设置）。
    // 修复：原先内层 SELECT w.req_id AS cnt 取的是请求 ID 字符串而非次数 → freq 列输出的是 req_id。
    // 正确应为 COUNT(*)：按 imp_id 分组统计该次曝光被 win 的次数。
    const [freq] = await pool.query(`
      SELECT cnt AS freq, COUNT(*) AS users FROM (
        SELECT COUNT(*) AS cnt FROM bid_win_log w JOIN adv_campaign a ON a.id=w.campaign_id
        WHERE a.advertiser LIKE ? AND w.created_at > NOW() - INTERVAL ? DAY GROUP BY w.imp_id
      ) t GROUP BY cnt ORDER BY cnt LIMIT 20`, [adv, days]).catch(() => [[]]);
    // CSV 导出（对标 AppLovin：任意维度报表可下载）。加 UTF-8 BOM 保证 Excel 打开中文不乱码。
    if (String(req.query.format || '').toLowerCase() === 'csv') {
      const head = [...dims.map(k => PERF_DIMS[k].label), '曝光', '点击', '转化', '花费(CNY)', 'CTR(%)', 'CVR(%)', 'CPC', 'CPA', 'CPM', 'ROAS'];
      const esc = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
      const lines = [head.join(',')];
      for (const x of items) {
        lines.push([...dims.map(k => x.dims[k]), x.impressions, x.clicks, x.conversions, x.spend_cny, x.ctr, x.cvr, x.cpc_cny, x.cpa_cny, x.cpm_cny, x.roas].map(esc).join(','));
      }
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="perf_${adv}_${dims.join('-')}_${days}d.csv"`);
      return res.send('\uFEFF' + lines.join('\n'));
    }
    res.json({ advertiser: adv, dim: dims[0], dims, dim_label: dims.map(k => PERF_DIMS[k].label).join('×'), days, total: sum, items,
      frequency: Array.isArray(freq) ? freq.map(f => ({ freq: Number(f.freq), users: Number(f.users) })) : [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── 留存 Cohort（对标 AppLovin Cohort：D0/D7/D14/D28）──
// 第一性原理：广告主打的是"用户终身价值"，只有看清「获客日 → 第 N 日仍活跃」的留存曲线，
// 才能把 CPM/CPA 出价校准到真实 LTV，否则 ROI 预测永远是拍脑袋。
// 锚定：conversion=首次转化日(D0=激活日)；impression=首次曝光日(D0=获客日)。
// 活跃判定：该 device 在 cohort_day + N 当天有任意 bid_win_log 曝光（"被再次看到"=仍活跃）。
// 留存口径对齐 AppLovin：D1 / D7 / D28（D0=激活当日≈100% 不单列，改为更有决策价值的 D1 次留与 D28 长留）
const COHORT_OFFSETS = [1, 7, 28];
app.get('/api/advertiser/cohort', security.requireAuth('admin', 'advertiser'), async (req, res) => {
  const adv = await resolveAdvScope(req);
  if (!adv) return res.status(400).json({ error: 'advertiser 必填（当前无任何广告主计划）' });
  const metric = String(req.query.metric || 'conversion') === 'impression' ? 'impression' : 'conversion';
  try {
    // ① 构建 cohort：device -> 首次(转化|曝光)日
    let cohortSql, cohortParams;
    if (metric === 'impression') {
      cohortSql = `SELECT w.device_id AS device_id, DATE(MIN(w.created_at)) AS cohort_day
        FROM bid_win_log w JOIN adv_campaign a ON a.id=w.campaign_id
        WHERE a.advertiser LIKE ? AND w.created_at > NOW() - INTERVAL 70 DAY
        GROUP BY w.device_id`;
      cohortParams = [adv];
    } else {
      cohortSql = `SELECT x.device_id AS device_id, DATE(MIN(x.conv_ts)) AS cohort_day
        FROM (SELECT bw.device_id AS device_id, c.created_at AS conv_ts
              FROM conv_log c JOIN bid_win_log bw ON bw.imp_id=c.imp_id
              JOIN adv_campaign a ON a.id=bw.campaign_id
              WHERE c.type='conversion' AND a.advertiser LIKE ? AND c.created_at > NOW()-INTERVAL 70 DAY) x
        GROUP BY x.device_id`;
      cohortParams = [adv];
    }
    // ② 活跃日（device 在 advertiser 作用域内被曝光的日期集合，近 120 天）
    const activeSql = `SELECT w.device_id AS device_id, DATE(w.created_at) AS active_day
      FROM bid_win_log w JOIN adv_campaign a ON a.id=w.campaign_id
      WHERE a.advertiser LIKE ? AND w.created_at > NOW()-INTERVAL 120 DAY
      GROUP BY w.device_id, DATE(w.created_at)`;
    // ③ 每个 offset 各 LEFT JOIN 一次活跃表，统计仍留存的设备数
    const joins = COHORT_OFFSETS.map((o, i) =>
      `LEFT JOIN (${activeSql}) ac${i} ON ac${i}.device_id=co.device_id AND ac${i}.active_day = DATE_ADD(co.cohort_day, INTERVAL ${o} DAY)`).join('\n');
    const sel = COHORT_OFFSETS.map((o, i) =>
      `COUNT(DISTINCT CASE WHEN ac${i}.device_id IS NOT NULL THEN co.device_id END) AS d${i}`).join(',\n');
    const sql = `SELECT co.cohort_day, COUNT(DISTINCT co.device_id) AS size, ${sel}
      FROM (${cohortSql}) co ${joins}
      GROUP BY co.cohort_day ORDER BY co.cohort_day DESC LIMIT 12`;
    const [rows] = await pool.query(sql, [...cohortParams, ...COHORT_OFFSETS.map(() => adv)]);
    // ④ eCPI / LTV / ROAS：按 cohort 聚合获客花费与贡献 GMV，补齐"成本/价值"视角
    // eCPI = 获客花费 / 用户数（元）；LTV = 该批用户贡献 GMV / 用户数（元）；ROAS = LTV / eCPI
    const spendMap = {}, gmvMap = {};
    try {
      const [sp] = await pool.query(`SELECT co.cohort_day AS cohort_day, COALESCE(SUM(w.price_micros),0) AS spend_micros
        FROM (${cohortSql}) co JOIN bid_win_log w ON w.device_id=co.device_id AND w.created_at >= co.cohort_day
        GROUP BY co.cohort_day`, cohortParams);
      sp.forEach(r => { spendMap[String(r.cohort_day)] = Number(r.spend_micros) || 0; });
      const [gp] = await pool.query(`SELECT co.cohort_day AS cohort_day, COALESCE(SUM(c.amount),0) AS gmv
        FROM (${cohortSql}) co
        JOIN bid_win_log w ON w.device_id=co.device_id AND w.created_at >= co.cohort_day
        JOIN conv_log c ON c.imp_id=w.imp_id AND c.type='conversion' AND c.created_at >= co.cohort_day
        GROUP BY co.cohort_day`, cohortParams);
      gp.forEach(r => { gmvMap[String(r.cohort_day)] = Number(r.gmv) || 0; });
    } catch (e) {}
    const fmtDate = (x) => { try { const dt = (x instanceof Date) ? x : new Date(String(x)); if (isNaN(+dt)) return String(x); const p = n => String(n).padStart(2, '0'); return dt.getFullYear() + '-' + p(dt.getMonth() + 1) + '-' + p(dt.getDate()); } catch (e) { return String(x); } };
    const matrix = rows.map(r => {
      const size = Number(r.size) || 0;
      const out = { cohort_day: fmtDate(r.cohort_day), size };
      COHORT_OFFSETS.forEach((o, i) => {
        const n = Number(r['d' + i] || 0);
        out['d' + i] = size ? +((n / size) * 100).toFixed(1) : 0;
        out['n' + i] = n;
      });
      const spendMicros = spendMap[String(r.cohort_day)] || 0;
      const gmv = gmvMap[String(r.cohort_day)] || 0;
      out.eCPI_cny = size ? +((spendMicros / 1e6) / size).toFixed(4) : 0;
      out.ltv_cny = size ? +(gmv / size).toFixed(4) : 0;
      out.roas = out.eCPI_cny ? +(out.ltv_cny / out.eCPI_cny).toFixed(2) : 0;
      return out;
    });
    res.json({ advertiser: adv, metric, offsets: COHORT_OFFSETS, matrix });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/campaign/:id/tags', security.requireAdmin('tags'), async (req, res) => {
  try {
    const { intent_tags } = req.body || {};
    await pool.query('UPDATE adv_campaign SET intent_tags=? WHERE id=?', [intent_tags || '', +req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// 素材审核通过（只有通过 approved 的素材才参拍）
app.put('/api/campaign/:id/approve', security.requireAdmin('approve'), async (req, res) => {
  try {
    await pool.query("UPDATE adv_campaign SET review_status='approved', review_note='' WHERE id=?", [+req.params.id]);
    res.json({ ok: true, review_status: 'approved' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// ④ 审核驳回（必须填原因）：与 approve 组成完整流转 pending → approved / rejected，
// 广告主能在后台看到驳回原因并据此修改，而不是"一直 pending 不知道为什么"
app.put('/api/campaign/:id/reject', security.requireAdmin('reject'), async (req, res) => {
  const note = String((req.body && req.body.note) || '').trim();
  if (!note) return res.status(400).json({ error: '驳回必须填写原因（广告主据此修改后重提）' });
  try {
    await pool.query("UPDATE adv_campaign SET review_status='rejected', review_note=? WHERE id=?", [note.slice(0, 255), +req.params.id]);
    res.json({ ok: true, review_status: 'rejected' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// 广告主驳回后「重提审核」：清零驳回原因并回到 pending（与编辑自动送审等价，独立入口便于 UI 一键操作）
app.put('/api/campaign/:id/resubmit', security.requireAuth('admin', 'advertiser'), async (req, res) => {
  const id = +req.params.id;
  try {
    const [[c]] = await pool.query('SELECT id,advertiser,review_status FROM adv_campaign WHERE id=?', [id]);
    if (!c) return res.status(404).json({ error: 'campaign not found' });
    if (req.account.t === 'advertiser' && c.advertiser !== req.account.s) return res.status(403).json({ error: '无权操作他人计划' });
    await pool.query("UPDATE adv_campaign SET review_status='pending', review_note='' WHERE id=?", [id]);
    res.json({ ok: true, review_status: 'pending' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// 计划编辑：广告主可改自己的计划；被驳回的计划修改后自动重新进入审核（pending）。
// 此前没有通用编辑接口，计划被驳回只能整条重建（需求侧漏斗断点）。
app.put('/api/campaign/:id', security.requireAuth('admin', 'advertiser'), async (req, res) => {
  const id = +req.params.id; const b = req.body || {};
  try {
    const [[c]] = await pool.query('SELECT id,advertiser,review_status FROM adv_campaign WHERE id=?', [id]);
    if (!c) return res.status(404).json({ error: 'campaign not found' });
    if (req.account.t === 'advertiser' && c.advertiser !== req.account.s) return res.status(403).json({ error: '无权修改他人计划' });
    const set = [], val = [];
    const put = (col, v) => { if (v != null) { set.push(col + '=?'); val.push(v); } };
    put('name', b.name != null ? String(b.name).trim() : null);
    put('budget_micros', b.budget_cny != null ? Math.round(Number(b.budget_cny) * 1e6) : (b.budget_micros != null ? Number(b.budget_micros) : null));
    put('target_cpm_micros', b.target_cpm_cny != null ? Math.round(Number(b.target_cpm_cny) * 1e6) : (b.target_cpm_micros != null ? Number(b.target_cpm_micros) : null));
    put('target_cpa_micros', b.target_cpa_cny != null ? Math.round(Number(b.target_cpa_cny) * 1e6) : (b.target_cpa_micros != null ? Number(b.target_cpa_micros) : null));
    put('target_roas', b.target_roas != null ? Number(b.target_roas) : null);
    put('bid_floor_micros', b.bid_floor_cny != null ? Math.round(Number(b.bid_floor_cny) * 1e6) : null);
    put('os', b.os != null ? String(b.os).trim().toLowerCase() : null);
    put('retarget', b.retarget != null ? (Number(b.retarget) ? 1 : 0) : null);
    put('retarget_window_days', b.retarget_window_days != null ? Math.max(1, Number(b.retarget_window_days) || 7) : null);
    put('interest_target', b.interest_target != null ? String(b.interest_target).trim().toLowerCase() : null);
    put('lookalike', b.lookalike != null ? (Number(b.lookalike) ? 1 : 0) : null);
    put('app_id', b.app_id != null ? String(b.app_id).trim() : null);
    put('conversion_event', b.conversion_event != null ? String(b.conversion_event).trim().toLowerCase() : null);
    put('attribution_partner', b.attribution_partner != null ? String(b.attribution_partner).trim().toLowerCase() : null);
    put('attribution_key', b.attribution_key != null ? String(b.attribution_key).trim() : null);
    const _ms = (v) => { if (!v) return 0; const n = Number(v); if (Number.isFinite(n) && n > 1e12) return n; const t = Date.parse(String(v)); return Number.isFinite(t) ? t : 0; };
    put('start_date', b.start_date != null ? _ms(b.start_date) : null);
    put('end_date', b.end_date != null ? _ms(b.end_date) : null);
    put('exclude_audience', b.exclude_audience != null ? String(b.exclude_audience).trim().toLowerCase() : null);
    if (b.exclusion && typeof b.exclusion === 'object') {
      const ei = Number(b.exclusion.exclude_installed) ? 1 : 0;
      const ec = Number(b.exclusion.exclude_converted) ? 1 : 0;
      put('exclude_audience', (ei && ec) ? 'both' : (ei ? 'installed' : (ec ? 'converted' : 'none')));
    }
    put('bid_strategy', b.bid_strategy != null ? String(b.bid_strategy).toUpperCase() : null);
    put('bid_value', b.bid_value != null ? (Number(b.bid_value) || 0) : null);
    // 统一出价策略：bid_strategy + bid_value 同步映射到引擎字段（goal_type / target_*）
    if (b.bid_strategy != null) {
      const st = String(b.bid_strategy).toUpperCase();
      const bval = Number(b.bid_value) || 0;
      const nm = (st === 'OCPI' || st === 'CPI') ? 'CPI' : (st === 'ROAS' ? 'ROAS' : (st === 'CPA' ? 'CPA' : 'CPM'));
      set.push('goal_type=?'); val.push(nm);
      if (st === 'CPM' && bval > 0) { set.push('target_cpm_micros=?'); val.push(Math.round(bval * 1e6)); }
      if ((st === 'CPA' || st === 'CPI' || st === 'OCPI') && bval > 0) { set.push('target_cpa_micros=?'); val.push(Math.round(bval * 1e6)); }
      if (st === 'ROAS' && bval > 0) { set.push('target_roas=?'); val.push(bval); }
    }
    put('app_category', b.app_category != null ? String(b.app_category).trim() : null);
    put('country', b.country != null ? String(b.country).trim() : null);
    put('geo_country', b.geo_country != null ? String(b.geo_country).trim() : null);
    put('device_type', b.device_type != null ? String(b.device_type).trim() : null);
    put('landing_url', b.landing_url != null ? String(b.landing_url).trim() : null);
    put('creative_html', b.creative_html != null ? String(b.creative_html) : null);
    put('intent_tags', b.intent_tags != null ? String(b.intent_tags).trim() : null);
    put('goal_type', b.goal_type != null ? String(b.goal_type).toUpperCase() : null);
    put('daily_cap_micros', b.daily_cap_cny != null ? Math.round(Number(b.daily_cap_cny) * 1e6) : null);
    if (!set.length) return res.status(400).json({ error: '无可更新字段' });
    // 驳回后修改 = 重新送审：清掉驳回原因并回到 pending（广告主据此闭环）
    if (c.review_status === 'rejected') { set.push("review_status='pending'"); set.push("review_note=''"); }
    val.push(id);
    await pool.query('UPDATE adv_campaign SET ' + set.join(',') + ' WHERE id=?', val);
    await security.logAudit(req, 'campaign:update', 'campaign#' + id, JSON.stringify(b).slice(0, 200));
    res.json({ ok: true, resubmitted: c.review_status === 'rejected' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== 频控（Freq Cap）设置：广告主可自助设置「同一设备 N 小时内最多看 M 次」=====
// 数据结构与判定逻辑都在 pacing.js（campaign_delivery.freq_cap + gate/freqAllow），
// 这里只补「带归属校验的读写入口」——原 /api/pacing/:cid 无鉴权，任何人可改任意计划节奏，属数据越权面。
async function assertCampaignOwner(req, cid) {
  const [[c]] = await pool.query('SELECT id,advertiser FROM adv_campaign WHERE id=?', [cid]);
  if (!c) return { ok: false, code: 404, msg: 'campaign not found' };
  if (req.account.t === 'advertiser' && c.advertiser !== req.account.s) return { ok: false, code: 403, msg: '无权操作他人计划' };
  return { ok: true, c };
}
app.get('/api/campaign/:id/freqcap', security.requireAuth('admin', 'advertiser'), async (req, res) => {
  const cid = +req.params.id;
  const own = await assertCampaignOwner(req, cid);
  if (!own.ok) return res.status(own.code).json({ error: own.msg });
  const d = await pacing.delivery(cid);
  res.json({ campaign_id: cid, freq_cap: d.freqCap || null, daypart: d.daypart, mode: d.mode });
});
app.post('/api/campaign/:id/freqcap', security.requireAuth('admin', 'advertiser'), async (req, res) => {
  const cid = +req.params.id;
  const own = await assertCampaignOwner(req, cid);
  if (!own.ok) return res.status(own.code).json({ error: own.msg });
  const b = req.body || {};
  // 传 {count:0} 或 {enabled:false} 表示关闭频控
  const fc = (b.enabled === false || Number(b.count) <= 0) ? null : normalizeFreqCap(b);
  const out = await pacing.save(cid, { freqCap: fc });
  await security.logAudit(req, 'campaign:freqcap', 'campaign#' + cid, JSON.stringify(b).slice(0, 120));
  res.json({ ok: true, campaign_id: cid, freq_cap: out.freqCap || null });
});

// ===== 多素材 A/B 管理（单计划 → 多素材，Thompson 自动优选 + 疲劳度）=====
// GET  返回该计划挂着的素材 + 实时疲劳度（供广告主看"哪条素材开始疲劳"）
app.get('/api/campaign/:id/creatives', security.requireAuth('admin', 'advertiser'), async (req, res) => {
  const cid = +req.params.id;
  const own = await assertCampaignOwner(req, cid);
  if (!own.ok) return res.status(own.code).json({ error: own.msg });
  // 直接查库（不走 creativeAb.variants 的 30s 缓存），保证看板看到的曝光/点击/疲劳度是最新值
  const [rowsRaw] = await pool.query("SELECT id,title,format,COALESCE(impressions,0) impressions,COALESCE(clicks,0) clicks,COALESCE(conversions,0) conversions FROM creatives WHERE campaign_id=? AND creative_status='approved'", [cid]).catch(() => [[]]);
  const rows = creativeAb.computeFatigue(rowsRaw || []);
  res.json({ campaign_id: cid, creatives: rows.map(v => ({ id: v.id, title: v.title, format: v.format, impressions: v.impressions, clicks: v.clicks, conversions: v.conversions, ctr: v.ctr, fatigue: v.fatigue })) });
});
// POST 批量挂/换素材：解绑旧集合、挂新集合；挂多个即进入 A/B 模式（解除单素材锁定）
app.post('/api/campaign/:id/creatives', security.requireAuth('admin', 'advertiser'), async (req, res) => {
  const cid = +req.params.id;
  const own = await assertCampaignOwner(req, cid);
  if (!own.ok) return res.status(own.code).json({ error: own.msg });
  const ids = Array.isArray((req.body || {}).creative_ids) ? req.body.creative_ids.map(Number).filter(x => x > 0) : null;
  if (ids === null) return res.status(400).json({ error: 'creative_ids 数组必填（空数组=解绑全部）' });
  // 只允许挂属于自己的素材
  const [mine] = await pool.query('SELECT id FROM creatives WHERE id IN (?) AND advertiser=?', [ids, own.c.advertiser]);
  const okIds = mine.map(m => m.id);
  await pool.query('UPDATE creatives SET campaign_id=0 WHERE campaign_id=?', [cid]);
  for (const one of okIds) await pool.query('UPDATE creatives SET campaign_id=? WHERE id=?', [cid, one]);
  if (okIds.length !== 1) await pool.query('UPDATE adv_campaign SET creative_id=0 WHERE id=?', [cid]); // 多素材→A/B 模式
  creativeAb.bust(cid);
  await security.logAudit(req, 'campaign:creatives', 'campaign#' + cid, JSON.stringify(okIds));
  res.json({ ok: true, campaign_id: cid, attached: okIds, ab_mode: okIds.length !== 1 });
});

// 再营销受众池规模（内存 + 落库），广告主后台展示「我的可再营销受众」
app.get('/api/advertiser/retarget-pool', security.requireAuth('admin', 'advertiser'), async (req, res) => {
  const adv = await resolveAdvScope(req);
  if (!adv) return res.status(400).json({ error: 'advertiser 必填（当前无任何广告主计划）' });
  try { res.json(await retarget.poolStats(adv)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
// 审核队列（按状态拉待审/已驳回计划）
app.get('/api/campaigns/review', security.requireAuth('admin'), async (req, res) => {
  try {
    const st = String(req.query.status || 'pending');
    const [rows] = await pool.query('SELECT id,name,advertiser,app_category,landing_url,target_cpm_micros,review_status,review_note FROM adv_campaign WHERE review_status=? ORDER BY id DESC LIMIT 100', [st]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== 受众自动采集概览（OS/机型/兴趣/地域，均为服务端零打扰采集）=====
// 平台级：跨设备聚合（管理端看数，验证"受众信号自动采集"已生效）
app.get('/api/audience/overview', security.requireAuth('admin'), async (req, res) => {
  try { res.json(await identity.audienceAggregate()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
// 广告主级：本广告主曝光里的设备/地域分布（来自 bid_win_log 自动落库字段，无需任何前端埋点）
app.get('/api/advertiser/audience', security.requireAuth('admin', 'advertiser'), async (req, res) => {
  const adv = await resolveAdvScope(req);
  if (!adv) return res.status(400).json({ error: 'advertiser 必填（当前无任何广告主计划）' });
  try {
    const dim = async (col) => {
      const [rows] = await pool.query(
        // 限定 w. 前缀：bid_win_log 与 adv_campaign 都有 os/country 列，不限定会报 "Column 'os' ... is ambiguous"
        `SELECT w.${col} k, COUNT(*) n FROM bid_win_log w JOIN adv_campaign a ON a.id=w.campaign_id WHERE a.advertiser LIKE ? AND w.${col}<>'' GROUP BY w.${col} ORDER BY n DESC LIMIT 15`,
        [adv]);
      return rows.map(r => ({ key: r.k, count: Number(r.n) }));
    };
    res.json({ advertiser: adv, os: await dim('os'), model: await dim('device_model'), geo: await dim('country'), device_type: await dim('device_type') });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== 报表 =====
// ===== eCPM' 引擎（对齐 BP_v7 §2.6 / §3.3 三层评测冷启动）=====
const numOr = (v, d) => (typeof v === 'number' ? v : d);

// 用 DB 里的三层评测结果 + 归因样本回填候选 SKU：
//   评测分(eval_score) = 冷启动先验；已积累的归因样本 = 行为数据，两者按 α 衰减融合（§2.6）
async function enrichCandidates(candidates) {
  const ids = candidates.map((c) => c.skuId).filter(Boolean);
  if (!ids.length) return candidates;
  const [ev] = await pool.query('SELECT * FROM sku_eval WHERE sku_id IN (?)', [ids]);
  const [st] = await pool.query('SELECT * FROM sku_stats WHERE sku_id IN (?)', [ids]);
  const evMap = {}, stMap = {};
  ev.forEach((r) => (evMap[r.sku_id] = r));
  st.forEach((r) => (stMap[r.sku_id] = r));
  return candidates.map((c) => {
    const o = { ...c };
    const e = evMap[c.skuId];
    if (e) {
      o.evalScore = Number(e.eval_score);
      o.evalDetail = { l1: +e.l1, l2: +e.l2, l3: +e.l3 };
      if (!o.name) o.name = e.name;
    }
    const s = stMap[c.skuId];
    if (s) {
      o.nSamples = s.n_samples;
      o.successes = s.successes;
      o.failures = s.failures;
      // 行为数据 = 归因回流观测到的真实商机率（T+30）
      if (s.n_samples > 0) o.behaviorScore = s.successes / s.n_samples;
    }
    if (o.nSamples == null) o.nSamples = 0;
    if (o.successes == null) o.successes = 0;
    if (o.failures == null) o.failures = 0;
    return o;
  });
}

// ① 注册/更新某服务包的三层评测结果（L1 能力 / L2 效果 / L3 口碑）→ 合成冷启动评测分
app.post('/api/ecpm/eval', async (req, res) => {
  const { skuId, name, l1, l2, l3 } = req.body || {};
  if (!skuId) return res.status(400).json({ error: 'skuId required' });
  const evalScore = ecpm.composeEvalScore({ l1: numOr(l1, 0.5), l2: numOr(l2, 0.5), l3: numOr(l3, 0.5) });
  try {
    await pool.query(
      `INSERT INTO sku_eval (sku_id,name,l1,l2,l3,eval_score) VALUES (?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE name=VALUES(name), l1=VALUES(l1), l2=VALUES(l2), l3=VALUES(l3), eval_score=VALUES(eval_score)`,
      [skuId, name || skuId, numOr(l1, 0.5), numOr(l2, 0.5), numOr(l3, 0.5), evalScore]);
    res.json({ ok: true, skuId, evalScore, alpha: +ecpm.alpha(0).toFixed(3) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ② 评测库一览（含已积累样本与 α 衰减状态）
// 字段语义（避免"表/字段含义"歧义）：l1/l2/l3 = 静态分层评估分（演示表 sku_eval）；nSamples/successes/failures = 行为回流样本（演示表 sku_stats）；alpha = Wilson 置信下界，随样本量升高。两表均为公开营销演示数据，不含任何账号/经营数据。
// 注意：保持顶层为数组（demo 页面按数组消费），仅做「新增字段」式澄清，不改变结构。
app.get('/api/ecpm/evals', async (_, res) => {
  try {
    const [ev] = await pool.query('SELECT * FROM sku_eval');
    const [st] = await pool.query('SELECT * FROM sku_stats');
    const sm = {}; st.forEach((x) => (sm[x.sku_id] = x));
    res.json(ev.map((r) => {
      const s = sm[r.sku_id] || { n_samples: 0, successes: 0, failures: 0 };
      const n = Number(s.n_samples) || 0, suc = Number(s.successes) || 0;
      return {
        skuId: r.sku_id, name: r.name, l1: +r.l1, l2: +r.l2, l3: +r.l3, evalScore: +r.eval_score,
        nSamples: n, successes: suc, failures: Number(s.failures) || 0,
        successRate: n ? +(suc / n).toFixed(4) : null, // 行为成功率（派生字段，n=0 时为 null）
        alpha: +ecpm.alpha(n).toFixed(3),
      };
    }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ③ 归因回流（T+30 商机判定回写）→ 行为数据累积，α 衰减后行为分接管排序
app.post('/api/ecpm/feedback', async (req, res) => {
  const { skuId, converted } = req.body || {};
  if (!skuId) return res.status(400).json({ error: 'skuId required' });
  const ok1 = converted ? 1 : 0;
  try {
    await pool.query(
      `INSERT INTO sku_stats (sku_id,n_samples,successes,failures) VALUES (?,1,?,?)
       ON DUPLICATE KEY UPDATE n_samples=n_samples+1, successes=successes+?, failures=failures+?`,
      [skuId, ok1, 1 - ok1, ok1, 1 - ok1]);
    const [[s]] = await pool.query('SELECT * FROM sku_stats WHERE sku_id=?', [skuId]);
    res.json({
      ok: true, skuId, nSamples: s.n_samples,
      behaviorScore: s.n_samples ? +(s.successes / s.n_samples).toFixed(4) : null,
      alpha: +ecpm.alpha(s.n_samples).toFixed(3),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 清空某 SKU（或全部）的归因样本，便于重复演示"冷启动 → 学习接管"
app.post('/api/ecpm/reset', async (req, res) => {
  const { skuId } = req.body || {};
  try {
    if (skuId) await pool.query('DELETE FROM sku_stats WHERE sku_id=?', [skuId]);
    else await pool.query('DELETE FROM sku_stats');
    res.json({ ok: true, reset: skuId || 'ALL' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ④ 竞价排序：组织需求事件 → 候选服务包 SKU（已回填评测+归因）→ 统一 eCPM' 排序
app.post('/api/ecpm/rank', async (req, res) => {
  const { demand, candidates, slot, opts } = req.body || {};
  if (!Array.isArray(candidates) || !candidates.length) return res.status(400).json({ error: 'candidates[] required' });
  try {
    const enriched = await enrichCandidates(candidates);
    const out = ecpm.selectWinner(demand || {}, enriched, slot || {}, opts || {});
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/report', async (_, res) => {
  try {
    const [rows] = await pool.query('SELECT id,name,budget_micros,status FROM adv_campaign');
    const [[agg]] = await pool.query('SELECT COUNT(*) wins, COALESCE(SUM(price_micros),0) spent FROM bid_win_log');
    res.json({ campaigns: rows.map(c => ({ ...c, budget_cny: c.budget_micros / 1e6 })), wins: agg.wins, spent_cny: Number(agg.spent) / 1e6 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// 多广告主隔离报表：按 advertiser 聚合曝光/花费/GMV（对标 AppLuck 多客户分账）
app.get('/api/report/advertiser', async (_, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT a.advertiser,
        COUNT(DISTINCT b.imp_id) impressions,
        COALESCE(SUM(b.price_micros),0)/1e6 spent_cny,
        COALESCE(SUM(c.amount),0) gmv
      FROM adv_campaign a
      LEFT JOIN bid_win_log b ON b.campaign_id=a.id
      LEFT JOIN conv_log c ON c.campaign_id=a.id AND c.type='conversion'
      GROUP BY a.advertiser`);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// SSP 结算报表：由 bid_win_log（含 publisher 维度）实时聚合，重启不丢、按媒体方归因
// 媒体可用（收益报表需要），但必须按自己的域名隔离：媒体只看自己那一行的收益。
// 【修复】原先挂在 ADMIN_PREFIXES 下，媒体访问必 401；移出前缀后在此做角色+作用域隔离。
app.get('/ssp/report', publisherOrApiKey, async (req, res) => {
  const isPub = req.account.t === 'publisher';
  const myDomain = req.account.s;
  try {
    const [rows] = await pool.query(
      isPub ? 'SELECT publisher, COUNT(*) wins, COALESCE(SUM(price_micros),0) gross FROM bid_win_log WHERE publisher=? GROUP BY publisher'
            : 'SELECT publisher, COUNT(*) wins, COALESCE(SUM(price_micros),0) gross FROM bid_win_log GROUP BY publisher',
      isPub ? [myDomain] : []);
    const [pubs] = await pool.query('SELECT domain, payout_rate FROM publishers');
    const rateMap = {}; pubs.forEach(p => rateMap[p.domain] = Number(p.payout_rate) || 0.7);
    let grossAll = 0, payoutAll = 0;
    const list = rows.map(r => {
      const rate = rateMap[r.publisher] || 0.7; const gross = Number(r.gross);
      const payout = Math.round(gross * rate); grossAll += gross; payoutAll += payout;
      return { publisher: r.publisher, wins: Number(r.wins), gross_cny: gross / 1e6, payout_cny: payout / 1e6, ssp_margin_cny: (gross - payout) / 1e6 };
    });
    const margin = grossAll - payoutAll;
    res.json({ ssp: { wins: list.reduce((a, b) => a + b.wins, 0), gross_cny: grossAll / 1e6, payout_cny: payoutAll / 1e6, ssp_margin_cny: margin / 1e6, margin_rate: grossAll ? margin / grossAll : 0 }, publishers: list });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== 公共（免登录）接口：营销漏斗 / 免费工具 / 演示可信度 =====
// eCPM' 免费打分器（工具钩子）：复用与平台同款的 ecpm_engine，纯计算、不读敏感数据、无鉴权
app.get('/api/public/ecpm-score', async (req, res) => {
  const q = req.query || {};
  const num = (v, d) => (v === undefined || v === '' ? d : Number(v));
  const sku = {
    skuId: 'tool-' + Date.now(),
    bidType: String(q.bidType || 'CPM').toUpperCase(),
    bid: num(q.bid, 1000),              // CPM=元/千次 · CPC=元/次 · CPA=元/商机
    ltvFactor: num(q.ltv, 1.0),         // LTV 预测系数
    svcFactor: num(q.svc, 1.0),         // 服务承诺系数（SLA/赔付）
    nSamples: num(q.nSamples, 0),       // 已回流归因样本数（T+30）
    successes: num(q.successes, 0),
    failures: num(q.failures, 0),
    l1: num(q.l1, 0.5), l2: num(q.l2, 0.5), l3: num(q.l3, 0.5), // 三层评测分
  };
  if (q.evalScore !== undefined && q.evalScore !== '') sku.evalScore = Number(q.evalScore); // 直接给合成评测分则优先
  const slot = { ctr: num(q.ctr, 0.12), leadRate: num(q.leadRate, 0.10) };
  const ranked = ecpm.rankCandidates({ cat: q.cat || '' }, [sku], slot, { deterministic: true });
  const r = ranked[0] || {};
  const unified = Number(r.unifiedEcpm) || 0;
  res.json({
    ok: true,
    ecpmPrime: r.ecpmPrime,               // 排序分（效果×LTV×折算出价×服务承诺）
    pEffect: r.pEffect,                   // 效果预测（贝叶斯融合，冷启动先验+行为数据）
    unifiedEcpm: unified,                 // 折算到"每千次曝光"的期望收入
    alpha: +ecpm.alpha(sku.nSamples).toFixed(3), // 先验权重：样本越多，真实效果越接管
    coldStart: !!r.cold,
    estRange: [+((unified * 0.8) < 1e-9 ? 0 : unified * 0.8).toFixed(3), +((unified * 1.25)).toFixed(3)],
    note: "eCPM' = 效果预测 × LTV × 折算出价 × 服务承诺（与平台同款引擎，纯预估，非收益承诺）。",
  });
});

// Prebid 演示页专用的公共只读报表（/report 需 admin；此接口形状对齐 index.html 期望，避免匿名访问 401/undefined）
app.get('/api/demo/report', async (_, res) => {
  try {
    const [[c]] = await pool.query('SELECT * FROM adv_campaign WHERE status=1 ORDER BY id DESC LIMIT 1');
    const [[agg]] = await pool.query('SELECT COUNT(*) wins, COALESCE(SUM(price_micros),0) spent FROM bid_win_log');
    res.json({
      campaign: c ? { id: c.id, name: c.name, budget: c.budget_micros } : { id: 0, name: 'demo', budget: 0 },
      wins: agg ? Number(agg.wins) : 0,
      spent_cny: agg ? Number(agg.spent) / 1e6 : 0,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // 演示保底填充：官方演示页（index.html 等）在无真实需求时也写一条 win 到 bid_win_log，
  // 让「分媒体方明细（SSP 全局）」与 /api/demo/report（两者都读 bid_win_log）口径一致，避免空表。
  app.post('/api/demo/win', async (req, res) => {
  try {
  const b = req.body || {};
  enqueueLog('win', [Number(b.cid) || 1, Number(b.crid) || 1, String(b.impid || ('demo-' + Date.now())),
    String(b.reqid || ('req-' + Date.now())), Math.max(0, Number(b.price_micros) || 1000000), 'dellai.xyz',
    String(b.consent || ''), String(b.feat || ''), String(b.ad_unit_id || ''), String(b.device_type || ''),
    String(b.country || ''), String(b.ad_format || 'banner'), String(b.os || ''), String(b.device_model || ''), String(b.device_id || '')]);
  res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // 需求侧开户已统一到 /api/signup/advertiser（唯一实现）。
// 原 /api/public/advertiser-open 是第二套开户实现：账号作用域取「邮箱」而非「广告主名称」，
//   与 advertiser_signup.html / 广告主控制台的口径不一致（同一主体两个 scope，数据互相看不见）。
//   按「一个角色=一个开户接口=一个作用域口径」收敛后，此处仅保留明确提示，不再重复建账号。
app.post('/api/public/advertiser-open', (req, res) => {
  res.status(410).json({
    error: '该开户入口已下线',
    hint: '请改用统一开户接口 POST /api/signup/advertiser（字段：username/password/advertiser/display，作用域=广告主名称）',
    ui: '/register.html#advertiser'
  });
});

// 软考留资闭环（landing/ruankao/index.html 提交邮箱/微信时回传）：免登录、纯联系方式，无敏感数据
// 这是"访客→拿到资料包"闭环里唯一真正存下联系方式的一环（之前只记了广告转化，没存人）
// 惰性建表：不依赖 init() 启动时序，端点首次被调用时自动建表（幂等），保证冷启动也稳
let _ruankaoLeadReady = false;
async function ensureRuankaoLeadTable() {
  if (_ruankaoLeadReady) return;
  // 线索表（含归因字段：把线索回连到 imp/计划/创意/媒体方，闭成 loop）
  await pool.query(`CREATE TABLE IF NOT EXISTS ruankao_lead (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    contact VARCHAR(128),
    channel VARCHAR(32) DEFAULT 'direct',
    source VARCHAR(128) DEFAULT '',
    ip VARCHAR(64) DEFAULT '',
    delivered TINYINT DEFAULT 0,
    imp_id VARCHAR(64) DEFAULT '',
    campaign_id INT DEFAULT 0,
    creative_id INT DEFAULT 0,
    publisher VARCHAR(128) DEFAULT '',
    converted TINYINT DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX(channel), INDEX(created_at), INDEX(imp_id), INDEX(campaign_id))`);
  // 兼容已存在表：补齐归因列（幂等）
  for (const col of [
    "ALTER TABLE ruankao_lead ADD COLUMN imp_id VARCHAR(64) DEFAULT ''",
    'ALTER TABLE ruankao_lead ADD COLUMN campaign_id INT DEFAULT 0',
    'ALTER TABLE ruankao_lead ADD COLUMN creative_id INT DEFAULT 0',
    "ALTER TABLE ruankao_lead ADD COLUMN publisher VARCHAR(128) DEFAULT ''",
    'ALTER TABLE ruankao_lead ADD COLUMN converted TINYINT DEFAULT 0',
  ]) await pool.query(col).catch(() => {});
  // 落地页到达埋点（点击≠到达：算到达率 / 落地页质量）
  await pool.query(`CREATE TABLE IF NOT EXISTS landing_view (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    imp_id VARCHAR(64) DEFAULT '',
    campaign_id INT DEFAULT 0,
    publisher VARCHAR(128) DEFAULT '',
    channel VARCHAR(32) DEFAULT 'direct',
    ip VARCHAR(64) DEFAULT '',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX(imp_id), INDEX(campaign_id), INDEX(created_at))`);
  // 线索跟进（运营闭环：新线索→已联系→成交/流失）
  await pool.query(`CREATE TABLE IF NOT EXISTS ruankao_followup (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    lead_id BIGINT NOT NULL,
    stage VARCHAR(32) DEFAULT '',
    note VARCHAR(512) DEFAULT '',
    operator VARCHAR(64) DEFAULT '',   // 原名 by 是 MySQL 保留字 → 建表语法错误（该表目前无其它引用，直接改名）
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX(lead_id))`);
  _ruankaoLeadReady = true;
}

// 软考留资闭环 + 归因回流：免登录、纯联系方式（无敏感数据）。
// SDK 点击时已把 imp/cid/pub 透传到落地页 URL；留资时带回来，服务端以 bid_win_log 为唯一事实源归因，
// 并把"留资=转化"回写 conv_log + 喂 多目标模型(ml) / 在线出价模型(bidModel) / 创意 A/B(creativeAb)。
app.post('/api/public/ruankao-lead', async (req, res) => {
  if (rateHit(String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim())) return res.status(429).json({ error: 'rate limited' });
  const b = req.body || {};
  const contact = String(b.contact || '').trim();
  if (!contact || contact.length > 120) return res.status(400).json({ error: 'contact 必填（120 字内）' });
  const channel = String(b.channel || 'direct').slice(0, 32);
  const source = String(b.source || '').slice(0, 128);
  const ip = String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim().slice(0, 64);
  const imp = String(b.imp || '').slice(0, 64);
  const valueCny = Math.max(0, Number(b.value) || 0);   // 可选：单条线索价值（元），用于 pLTV 回流
  let campaign_id = 0, creative_id = 0, publisher = String(b.pub || '').slice(0, 128), converted = 0, convDup = false;
  try {
    await ensureRuankaoLeadTable();
    let win = null;
    if (imp) {
      const [rows] = await pool.query(
        'SELECT campaign_id, creative_id, publisher FROM bid_win_log WHERE imp_id=? LIMIT 1', [imp]).catch(() => [[]]);
      win = rows[0] || null;
    }
    if (win) { campaign_id = win.campaign_id || 0; creative_id = win.creative_id || 0; publisher = win.publisher || publisher; }
    if (imp && win) {
      const [[dup]] = await pool.query("SELECT 1 FROM conv_log WHERE type='conversion' AND imp_id=?", [imp]);
      convDup = !!dup;
      if (!convDup) {   // 同一 imp 不重复计转化（去重以 conv_log 为准）
        await pool.query('INSERT INTO conv_log (type,campaign_id,publisher,imp_id,amount) VALUES (?,?,?,?,?)',
          ['conversion', campaign_id, publisher, imp, valueCny]).catch(() => {});
        ml.onConversion(imp, Math.round(valueCny * 1e6)).catch(() => {});
        bidModel.trainConversion(imp).catch(() => {});
        creativeAb.bump(imp, 'conversions').catch(() => {});
      }
      converted = 1;
    }
    const [r] = await pool.query(
      'INSERT INTO ruankao_lead (contact,channel,source,ip,imp_id,campaign_id,creative_id,publisher,converted) VALUES (?,?,?,?,?,?,?,?,?)',
      [contact, channel, source, ip, imp, campaign_id, creative_id, publisher, converted]);
    res.json({
      ok: true, id: r.insertId,
      conv: converted === 1 && !convDup, dup: convDup,
      campaign_id, publisher,
      msg: '已记录。资料包也可直接用页内百度云提取码立即领取。',
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 通用转化回传（开发者链路闭环 · 全站落地页通用）：任意落地页凭 impid 归因转化。
// 与 /ssp/click 共用 bid_win_log 事实源 + conv_log 去重/归因窗口，并回流 ml/bidModel/creativeAb。
async function handleConv(b, ip) {
  const imp = String(b.imp || '').slice(0, 64);
  if (!imp) return { status: 400, body: { error: 'imp required' } };
  const pub = String(b.pub || '').slice(0, 128);
  const amount = Math.max(0, Number(b.amount) || Number(b.value) || 0);
  const project = String(b.project || 'direct').slice(0, 32);
  const contact = String(b.contact || '').trim().slice(0, 128);
  let campaign_id = 0, creative_id = 0, publisher = pub, converted = 0, convDup = false, win = null;
  try {
    const [rows] = await pool.query('SELECT campaign_id, creative_id, publisher FROM bid_win_log WHERE imp_id=? LIMIT 1', [imp]).catch(() => [[]]);
    win = rows[0] || null;
    if (win) { campaign_id = win.campaign_id || 0; creative_id = win.creative_id || 0; publisher = win.publisher || pub; }
    if (win) {
      const [[dup]] = await pool.query("SELECT 1 FROM conv_log WHERE type='conversion' AND imp_id=?", [imp]);
      convDup = !!dup;
      if (!convDup) {
        await pool.query('INSERT INTO conv_log (type,campaign_id,publisher,imp_id,amount) VALUES (?,?,?,?,?)',
          ['conversion', campaign_id, publisher, imp, amount]).catch(() => {});
        metrics.incr('conv'); ml.onConversion(imp, Math.round(amount * 1e6)).catch(() => {});
        bidModel.trainConversion(imp).catch(() => {});
        creativeAb.bump(imp, 'conversions').catch(() => {});
      }
      converted = 1;
    }
    if (contact) {
      await pool.query('INSERT INTO leads (project,contact,imp_id,campaign_id,publisher,amount,ip) VALUES (?,?,?,?,?,?,?)',
        [project, contact, imp, campaign_id, publisher, amount, ip]).catch(() => {});
    }
    return { status: 200, body: { ok: true, attributed: !!win, conv: converted === 1 && !convDup, dup: convDup, campaign_id, publisher } };
  } catch (e) { return { status: 500, body: { error: e.message } }; }
}
app.post('/api/public/conv', async (req, res) => {
  const ip = String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim().slice(0, 64);
  if (rateHit(ip)) return res.status(429).json({ error: 'rate limited' });
  const o = await handleConv(req.body || {}, ip);
  res.status(o.status).json(o.body);
});
app.get('/api/public/conv', async (req, res) => {
  const ip = String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim().slice(0, 64);
  if (rateHit(ip)) return res.status(429).json({ error: 'rate limited' });
  const o = await handleConv(req.query || {}, ip);
  res.status(o.status).json(o.body);
});

// 落地页到达埋点：SDK 点击→落地页；落地页 onload 时打一次（1×1 透明 GIF，供 <img> 直埋，不阻塞渲染）
app.get('/api/public/landing-view', async (req, res) => {
  try {
    await ensureRuankaoLeadTable();
    const imp = String(req.query.imp || '').slice(0, 64);
    const channel = String(req.query.channel || 'direct').slice(0, 32);
    const ip = String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim().slice(0, 64);
    let campaign_id = 0, publisher = String(req.query.pub || '').slice(0, 128);
    if (imp) {
      const [rows] = await pool.query('SELECT campaign_id, publisher FROM bid_win_log WHERE imp_id=? LIMIT 1', [imp]).catch(() => [[]]);
      const w = rows[0];
      if (w) { campaign_id = w.campaign_id || 0; publisher = w.publisher || publisher; }
    }
    await pool.query('INSERT INTO landing_view (imp_id,campaign_id,publisher,channel,ip) VALUES (?,?,?,?,?)',
      [imp, campaign_id, publisher, channel, ip]).catch(() => {});
    res.set('Content-Type', 'image/gif');
    res.set('Cache-Control', 'no-store');
    res.end(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')); // 1×1 透明像素
  } catch (e) { res.status(204).end(); }
});

// ===== 验证事件接收（OMID 自有验证脚本上报）=====
app.get('/api/public/verify', async (req, res) => {
  try {
    const event = String(req.query.event || '').slice(0, 32);
    const eventId = String(req.query.event_id || '').slice(0, 64);
    const imp = String(req.query.imp || '').slice(0, 64);
    const ts = Number(req.query.ts) || Date.now();
    const visible = String(req.query.visible || '');
    const ratio = Number(req.query.ratio) || 0;
    const sdk = String(req.query.sdk || '').slice(0, 32);

    // 查询关联的 campaign_id
    let campaign_id = 0, publisher = '';
    if (imp && imp !== 'unknown') {
      const [rows] = await pool.query('SELECT campaign_id, publisher FROM bid_win_log WHERE imp_id=? LIMIT 1', [imp]).catch(() => [[]]);
      const w = rows[0];
      if (w) { campaign_id = w.campaign_id || 0; publisher = w.publisher || ''; }
    }

    // 写入验证事件表
    await pool.query(`CREATE TABLE IF NOT EXISTS verification_event (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      event_type VARCHAR(32), event_id VARCHAR(64), imp_id VARCHAR(64),
      campaign_id BIGINT DEFAULT 0, publisher VARCHAR(128),
      visible VARCHAR(8), ratio DECIMAL(5,2), sdk VARCHAR(32),
      viewport VARCHAR(32), dpr VARCHAR(8), sample INT DEFAULT 0,
      ts BIGINT, created_at BIGINT DEFAULT 0
    )`).catch(() => {});
    await pool.query(`INSERT INTO verification_event
      (event_type, event_id, imp_id, campaign_id, publisher, visible, ratio, sdk, viewport, dpr, sample, ts, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [event, eventId, imp, campaign_id, publisher, visible, ratio, sdk,
       String(req.query.viewport || '').slice(0, 32), String(req.query.dpr || '').slice(0, 8),
       Number(req.query.sample) || 0, ts, Date.now()]).catch(() => {});

    res.set('Content-Type', 'image/gif');
    res.set('Cache-Control', 'no-store');
    res.end(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'));
  } catch (e) { res.status(204).end(); }
});

// 验证就绪状态查询（供后台仪表盘调用）
app.get('/api/verification/status', security.requireAuth('admin'), async (_, res) => {
  res.json(brandSafety.verificationStatus());
});


// 运营侧读软考线索（只看，导出/批量导入邮件群发工具用）
app.get('/api/leads/ruankao', security.requireAuth('admin'), async (req, res) => {
  try {
    await ensureRuankaoLeadTable();
    const [rows] = await pool.query('SELECT id,contact,channel,source,ip,delivered,created_at FROM ruankao_lead ORDER BY id DESC LIMIT 200');
    res.json(rows.map(function (r) { r.contact = maskContact(r.contact); return r; }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// ===== 素材管理（④ 对标真实平台的 Creative Management）=====
// ===== 素材状态机（收敛 status / review_status / creative_status 三套并存 → 单一 creative_status）=====
// creative_status 为唯一真源：draft/pending/approved/rejected/paused/expired
// status + review_status 降级为"兼容镜像"，仅供竞价侧沿用（待全量切换后下线），写入时由真源自动推导。
const CREATIVE_STATUS = ['draft', 'pending', 'approved', 'rejected', 'paused', 'expired'];
function creativeStatusMirror(st) {
  const s = String(st || 'draft').toLowerCase();
  if (!CREATIVE_STATUS.includes(s)) return null;
  if (s === 'approved') return { status: 'active', review_status: 'approved' };
  if (s === 'paused' || s === 'expired') return { status: 'paused', review_status: 'approved' };
  // draft / pending / rejected 均不可投放；rejected 需保留驳回语义
  return { status: 'active', review_status: s === 'rejected' ? 'rejected' : 'pending' };
}
// ===== 素材规范校验（对齐 AppLovin 素材规格）=====
const CREATIVE_SPEC = {
  banner: { maxBytes: 500 * 1024, maxDur: 0 },
  native: { maxBytes: 500 * 1024, maxDur: 0 },
  icon: { maxBytes: 100 * 1024, maxDur: 0 },
  interstitial: { maxBytes: 8 * 1024 * 1024, maxDur: 30 },
  rewarded: { maxBytes: 8 * 1024 * 1024, maxDur: 60 },
  video: { maxBytes: 8 * 1024 * 1024, maxDur: 60 },
  any: { maxBytes: 8 * 1024 * 1024, maxDur: 60 },
};
function validateCreativeSpec(b, fmt) {
  const spec = CREATIVE_SPEC[fmt] || CREATIVE_SPEC.banner;
  const fs = Number(b.file_size) || 0;
  if (fs > 0 && spec.maxBytes && fs > spec.maxBytes) {
    return '文件大小 ' + Math.round(fs / 1024) + 'KB 超过 ' + fmt + ' 上限 ' + Math.round(spec.maxBytes / 1024) + 'KB';
  }
  const dur = Number(b.duration_sec) || 0;
  if (dur > 0 && !spec.maxDur) return 'format=' + fmt + ' 不支持视频时长';
  if (dur > 0 && dur > spec.maxDur) return '视频时长 ' + dur + 's 超过 ' + fmt + ' 上限 ' + spec.maxDur + 's';
  const vv = String(b.vast_version || '').trim();
  if (vv && ['3.0', '4.0', '3', '4'].indexOf(vv) < 0) return 'VAST 版本仅支持 3.0 / 4.0';
  const lt = String(b.landing_type || 'h5').trim().toLowerCase();
  if (['h5', 'appstore', 'ul', 'dl'].indexOf(lt) < 0) return '落地页类型仅支持 h5 / appstore / ul / dl';
  return null;
}
// 兼容素材库前端既用字段名（file_size_kb / video_duration / deeplink_url）→ 统一到
// file_size(bytes) / duration_sec / deep_link，避免规范字段被静默丢弃。
function normCreativeSpec(b) {
  const o = Object.assign({}, b);
  o.file_size = (b.file_size != null) ? (Number(b.file_size) || 0)
    : ((b.file_size_kb != null) ? Math.round(Number(b.file_size_kb) * 1024) || 0 : 0);
  o.duration_sec = (b.duration_sec != null) ? (Number(b.duration_sec) || 0)
    : ((b.video_duration != null) ? (Number(b.video_duration) || 0) : 0);
  o.deep_link = (b.deep_link != null) ? b.deep_link : ((b.deeplink_url != null) ? b.deeplink_url : '');
  // omid_support（前端 adv-media.html 字段名）→ omid（表列名）
  o.omid = (b.omid != null) ? (Number(b.omid) ? 1 : 0) : ((b.omid_support != null) ? (Number(b.omid_support) ? 1 : 0) : 0);
  return o;
}
app.post('/api/creatives', security.requireAuth('admin','advertiser'), async (req, res) => {
  const b = normCreativeSpec(req.body || {});
  if (!b.content && !b.media_url) return res.status(400).json({ error: 'content 或 media_url 必填其一' });
  const fmt = String(b.format || 'banner').toLowerCase();
  if (!AD_FORMATS.includes(fmt) && fmt !== 'any') return res.status(400).json({ error: 'format 不合法: ' + AD_FORMATS.join('/') });
  const specErr = validateCreativeSpec(b, fmt);
  if (specErr) return res.status(400).json({ error: specErr });
  const st = String(b.creative_status || 'pending').toLowerCase();
  const mir = creativeStatusMirror(st);
  if (!mir) return res.status(400).json({ error: 'creative_status 不合法: ' + CREATIVE_STATUS.join('/') });
  const adv = (req.account && req.account.t === 'advertiser') ? req.account.s : (b.advertiser || '');
  try {
    // 新素材进入待审核（与计划审核一致）；通过后才参与投放
    const [r] = await pool.query('INSERT INTO creatives (advertiser,campaign_id,format,type,title,content,media_url,landing_url,width,height,creative_status,file_size,vast_version,omid,duration_sec,landing_type,deep_link,app_id,skan_source_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [adv, Number(b.campaign_id) || 0, fmt, b.type || 'html', b.title || '', b.content || '', b.media_url || '', b.landing_url || '', Number(b.width) || 0, Number(b.height) || 0,
       st,
       Number(b.file_size) || 0, String(b.vast_version || '').trim(), Number(b.omid) ? 1 : 0, Number(b.duration_sec) || 0,
       String(b.landing_type || 'h5').trim().toLowerCase(), String(b.deep_link || '').trim(), String(b.app_id || '').trim(), String(b.skan_source_id || '').trim()]);
    creativeAb.bust(Number(b.campaign_id) || 0); // 变体名单变化立即生效
    res.json({ ok: true, id: r.insertId, creative_status: st });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/creatives', security.requireAuth('admin','advertiser'), async (req, res) => {
  try {
    const acc = req.account; const cid = req.query.campaign_id;
    const [rows] = cid
      ? (acc.t === 'advertiser'
          ? await pool.query('SELECT * FROM creatives WHERE campaign_id=? AND advertiser=? ORDER BY id DESC', [Number(cid), acc.s])
          : await pool.query('SELECT * FROM creatives WHERE campaign_id=? ORDER BY id DESC', [Number(cid)]))
      : (acc.t === 'advertiser'
          ? await pool.query('SELECT * FROM creatives WHERE advertiser=? ORDER BY id DESC LIMIT 200', [acc.s])
          : await pool.query('SELECT * FROM creatives ORDER BY id DESC LIMIT 200'));
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/creatives/:id', security.requireAuth('admin','advertiser'), async (req, res) => {
  const b = normCreativeSpec(req.body || {}); const id = +req.params.id;
  try {
    if (req.account.t === 'advertiser') {
      const [[own]] = await pool.query('SELECT id FROM creatives WHERE id=? AND advertiser=?', [id, req.account.s]);
      if (!own) return res.status(403).json({ error: '无权修改他人素材' });
    }
    const adv = (req.account.t === 'advertiser') ? req.account.s : (b.advertiser || '');
    const fmtU = String(b.format || 'banner').toLowerCase();
    const specErrU = validateCreativeSpec(b, fmtU);
    if (specErrU) return res.status(400).json({ error: specErrU });
    // 部分更新：只更新本次传了的字段，未传的保持原值（避免旧逻辑把未传字段清空成 ''/0）
    const set = [], val = [];
    const p = function (col, v) { if (v !== undefined && v !== null) { set.push(col + '=?'); val.push(v); } };
    p('advertiser', adv);
    p('campaign_id', b.campaign_id != null ? (Number(b.campaign_id) || 0) : null);
    p('format', b.format != null ? fmtU : null);
    p('type', b.type != null ? String(b.type) : null);
    p('title', b.title != null ? String(b.title) : null);
    p('content', b.content != null ? String(b.content) : null);
    p('media_url', b.media_url != null ? String(b.media_url) : null);
    p('landing_url', b.landing_url != null ? String(b.landing_url) : null);
    p('width', b.width != null ? (Number(b.width) || 0) : null);
    p('height', b.height != null ? (Number(b.height) || 0) : null);
    p('file_size', b.file_size != null ? (Number(b.file_size) || 0) : null);
    p('vast_version', b.vast_version != null ? String(b.vast_version).trim() : null);
    p('omid', b.omid != null ? (Number(b.omid) ? 1 : 0) : null);
    p('duration_sec', b.duration_sec != null ? (Number(b.duration_sec) || 0) : null);
    p('landing_type', b.landing_type != null ? String(b.landing_type).trim().toLowerCase() : null);
    p('deep_link', b.deep_link != null ? String(b.deep_link).trim() : null);
    p('app_id', b.app_id != null ? String(b.app_id).trim() : null);
    p('skan_source_id', b.skan_source_id != null ? String(b.skan_source_id).trim() : null);
    if (b.creative_status != null) {
      if (!creativeStatusMirror(String(b.creative_status).toLowerCase())) {
        return res.status(400).json({ error: 'creative_status 不合法: ' + CREATIVE_STATUS.join('/') });
      }
      p('creative_status', String(b.creative_status).toLowerCase());
    }
    if (!set.length) return res.status(400).json({ error: '无可更新字段' });
    val.push(id);
    await pool.query('UPDATE creatives SET ' + set.join(',') + ' WHERE id=?', val);
    creativeAb.bust(Number(b.campaign_id) || 0); // 变体名单变化立即生效
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/creatives/:id', security.requireAuth('admin','advertiser'), async (req, res) => {
  const id = +req.params.id;
  try {
    if (req.account.t === 'advertiser') {
      const [[own]] = await pool.query('SELECT id FROM creatives WHERE id=? AND advertiser=?', [id, req.account.s]);
      if (!own) return res.status(403).json({ error: '无权删除他人素材' });
    }
    await pool.query('DELETE FROM creatives WHERE id=?', [id]); res.json({ ok: true });
  }
  catch (e) { res.status(500).json({ error: e.message }); }
});
// ── 创意自动多版式转换（确定性模板，不依赖 LLM）──
// 第一性原理：CTR 主要由创意决定，多版式覆盖直接提升 eCPM；而"文生图/LLM"并非必需——
// 同一份素材（图/文案/落地页）用确定性模板即可派生 banner / native / icon 等版式，
// 零外部依赖、零成本、结果可预期。LLM Creative Agent 仅作为可选增强（配了 key 才启用）。
function escHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
const FORMAT_TPL = {
  banner: (a) => `<div style="width:100%;background:#fff;border-radius:8px;overflow:hidden;font-family:system-ui,'Microsoft YaHei',sans-serif">
  ${a.media_url ? `<img src="${escHtml(a.media_url)}" style="width:100%;display:block;max-height:180px;object-fit:cover">` : ''}
  <div style="padding:10px 12px;display:flex;align-items:center;gap:10px">
    <div style="flex:1;min-width:0">
      <div style="font-size:14px;font-weight:700;color:#111;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(a.title)}</div>
      ${a.desc ? `<div style="font-size:12px;color:#666;margin-top:3px">${escHtml(a.desc)}</div>` : ''}
    </div>
    <a href="${escHtml(a.landing_url)}" target="_blank" rel="noopener" style="background:#2563eb;color:#fff;padding:7px 14px;border-radius:6px;text-decoration:none;font-size:13px;font-weight:700">${escHtml(a.cta || '了解详情')}</a>
  </div></div>`,
  native: (a) => `<div style="padding:12px;background:#fff;border-radius:8px;font-family:system-ui,'Microsoft YaHei',sans-serif">
  <div style="font-size:11px;color:#999;margin-bottom:6px">赞助内容</div>
  <div style="display:flex;gap:10px;align-items:flex-start">
    ${a.media_url ? `<img src="${escHtml(a.media_url)}" style="width:72px;height:72px;border-radius:6px;object-fit:cover;flex:none">` : ''}
    <div style="flex:1;min-width:0">
      <div style="font-size:15px;font-weight:700;color:#111">${escHtml(a.title)}</div>
      ${a.desc ? `<div style="font-size:12.5px;color:#555;margin-top:4px;line-height:1.5">${escHtml(a.desc)}</div>` : ''}
      <a href="${escHtml(a.landing_url)}" target="_blank" rel="noopener" style="display:inline-block;margin-top:7px;font-size:12.5px;color:#2563eb;text-decoration:none">${escHtml(a.cta || '了解更多')} ›</a>
    </div>
  </div></div>`,
  icon: (a) => `<div style="width:120px;height:120px;border-radius:18px;overflow:hidden;background:#2563eb;font-family:system-ui,'Microsoft YaHei',sans-serif;text-align:center">
  ${a.media_url
    ? `<img src="${escHtml(a.media_url)}" style="width:120px;height:120px;object-fit:cover;display:block">`
    : `<div style="padding:14px;color:#fff;font-size:15px;font-weight:700;line-height:1.3">${escHtml((a.title || 'AD').slice(0, 12))}</div>`}
</div>`,
  mrec: (a) => `<div style="width:300px;height:250px;background:#fff;border-radius:8px;overflow:hidden;font-family:system-ui,'Microsoft YaHei',sans-serif;display:flex;flex-direction:column">
  ${a.media_url ? `<img src="${escHtml(a.media_url)}" style="width:100%;height:150px;object-fit:cover;display:block">` : ''}
  <div style="flex:1;padding:10px 12px;display:flex;flex-direction:column;justify-content:center;gap:6px">
    <div style="font-size:14px;font-weight:700;color:#111">${escHtml(a.title)}</div>
    <a href="${escHtml(a.landing_url)}" target="_blank" rel="noopener" style="background:#2563eb;color:#fff;padding:6px 12px;border-radius:6px;text-decoration:none;font-size:13px;font-weight:700;align-self:flex-start">${escHtml(a.cta || '了解详情')}</a>
  </div></div>`,
  // ⑧ 浮标广告：右下角悬浮小窗，可拖拽、可关闭（典型 web/App 内嵌）
  float: (a) => `<div style="width:220px;font-family:system-ui,'Microsoft YaHei',sans-serif">
  <div style="position:relative;background:linear-gradient(135deg,#2563eb,#7c3aed);border-radius:14px;padding:12px 14px;box-shadow:0 6px 20px rgba(37,99,235,.4);color:#fff">
    <div style="display:flex;align-items:center;gap:10px">
      ${a.media_url ? `<img src="${escHtml(a.media_url)}" style="width:44px;height:44px;border-radius:8px;object-fit:cover;background:#fff" alt="float">` : `<div style="width:44px;height:44px;border-radius:8px;background:rgba(255,255,255,.2);display:flex;align-items:center;justify-content:center;font-size:20px">📣</div>`}
      <div style="flex:1;min-width:0">
        <div style="font-size:13px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(a.title)}</div>
        ${a.desc ? `<div style="font-size:11px;opacity:.85;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(a.desc)}</div>` : ''}
      </div>
      <button style="border:0;background:rgba(255,255,255,.25);width:20px;height:20px;border-radius:50%;color:#fff;font-size:12px;line-height:20px;cursor:pointer;padding:0" title="关闭">×</button>
    </div>
    <a href="${escHtml(a.landing_url)}" target="_blank" rel="noopener" style="display:block;text-align:center;margin-top:10px;background:#fff;color:#2563eb;font-size:12px;font-weight:700;padding:6px 0;border-radius:6px;text-decoration:none">${escHtml(a.cta || '立即体验')}</a>
  </div>
  <div style="text-align:center;font-size:10px;color:#999;margin-top:4px">广告 · 悬停可拖拽</div>
  </div>`,
  // ⑨ 互动广告：可点击/可玩的富媒体（示例：转盘抽奖）
  interactive: (a) => `<div style="width:320px;background:#fff;border-radius:12px;overflow:hidden;font-family:system-ui,'Microsoft YaHei',sans-serif;box-shadow:0 4px 14px rgba(0,0,0,.1)">
  <div style="background:linear-gradient(90deg,#f59e0b,#ef4444);padding:8px 12px;color:#fff;font-size:13px;font-weight:700;display:flex;justify-content:space-between;align-items:center">
    <span>🎁 ${escHtml(a.title || '互动赢好礼')}</span>
    <span style="font-size:10px;opacity:.85">${escHtml(a.desc || '点击参与')}</span>
  </div>
  <div style="padding:14px">
    <div id="ia-wheel" style="width:180px;height:180px;margin:0 auto;background:conic-gradient(#fde68a 0 45deg,#fca5a5 45deg 90deg,#93c5fd 90deg 135deg,#86efac 135deg 180deg,#fde68a 180deg 225deg,#fca5a5 225deg 270deg,#93c5fd 270deg 315deg,#86efac 315deg 360deg);border-radius:50%;display:flex;align-items:center;justify-content:center;cursor:pointer;transition:transform .8s ease-out">
      <div style="width:60px;height:60px;background:#fff;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:24px;box-shadow:0 2px 6px rgba(0,0,0,.2)">🎯</div>
    </div>
    <div style="text-align:center;margin-top:12px">
      <button onclick="document.getElementById('ia-wheel').style.transform='rotate('+(Math.random()*720+360)+'deg)'" style="background:#ef4444;color:#fff;border:0;padding:8px 18px;border-radius:20px;font-size:13px;font-weight:700;cursor:pointer">🎰 立即抽奖</button>
    </div>
    <a href="${escHtml(a.landing_url)}" target="_blank" rel="noopener" style="display:block;text-align:center;margin-top:10px;font-size:12px;color:#666;text-decoration:none">查看奖品 → ${escHtml(a.cta || '了解详情')}</a>
  </div>
  </div>`,
};
// 一份素材 → 多版式（确定性派生，无需 LLM）
app.post('/api/creative/convert', security.requireAuth('admin', 'advertiser'), async (req, res) => {
  const b = req.body || {};
  const adv = (req.account.t === 'advertiser') ? req.account.s : (b.advertiser || '');
  const wantFormats = Array.isArray(b.formats) && b.formats.length ? b.formats : ['banner', 'native', 'icon'];
  let asset = { title: b.title || '', desc: b.desc || '', media_url: b.media_url || '', landing_url: b.landing_url || '', cta: b.cta || '了解详情' };
  // 也可直接复用素材库已有的一条作为源素材
  if (b.source_id) {
    const [[src]] = await pool.query('SELECT * FROM creatives WHERE id=?', [Number(b.source_id)]).catch(() => [[]]);
    if (!src) return res.status(404).json({ error: '源素材不存在' });
    if (req.account.t === 'advertiser' && src.advertiser !== req.account.s) return res.status(403).json({ error: '无权使用他人素材' });
    asset = { title: src.title || '', desc: String(src.content || '').replace(/<[^>]*>/g, '').slice(0, 80),
      media_url: src.media_url || '', landing_url: src.landing_url || '', cta: b.cta || '了解详情' };
  }
  if (!asset.media_url && !asset.title) return res.status(400).json({ error: '需要 media_url 或 title（或指定 source_id）' });
  const out = [];
  try {
    for (const f of wantFormats) {
      const fmt = String(f).toLowerCase();
      if (!AD_FORMATS.includes(fmt) || !FORMAT_TPL[fmt]) continue;
      const [r] = await pool.query('INSERT INTO creatives (advertiser,campaign_id,format,type,title,content,media_url,landing_url,creative_status) VALUES (?,?,?,?,?,?,?,?,?)',
        [adv, Number(b.campaign_id) || 0, fmt, 'html', asset.title || (fmt + ' 版式'), FORMAT_TPL[fmt](asset), asset.media_url, asset.landing_url, 'pending']);
      out.push({ id: r.insertId, format: fmt, creative_status: 'pending' });
    }
    creativeAb.bust(Number(b.campaign_id) || 0);
    res.json({ ok: true, created: out.length, items: out, note: '确定性模板派生，无需 LLM；新素材为待审核' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// 批量上传素材（AppLovin 批量上传对标）：一次提交多条
app.post('/api/creatives/bulk', security.requireAuth('admin', 'advertiser'), async (req, res) => {
  const list = Array.isArray((req.body || {}).items) ? (req.body || {}).items : null;
  if (!list || !list.length) return res.status(400).json({ error: 'items[] required' });
  if (list.length > 50) return res.status(400).json({ error: '一次最多 50 条' });
  const adv = (req.account.t === 'advertiser') ? req.account.s : ((req.body || {}).advertiser || '');
  const out = [], errs = [];
  try {
    for (const it of list) {
      if (!it.content && !it.media_url) { errs.push('缺少 content/media_url'); continue; }
      const fmt = String(it.format || 'banner').toLowerCase();
      if (!AD_FORMATS.includes(fmt)) { errs.push('非法 format: ' + fmt); continue; }
      const [r] = await pool.query('INSERT INTO creatives (advertiser,campaign_id,format,type,title,content,media_url,landing_url,width,height,creative_status) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
        [adv, Number(it.campaign_id) || 0, fmt, it.type || 'html', it.title || '', it.content || '', it.media_url || '', it.landing_url || '', Number(it.width) || 0, Number(it.height) || 0, 'pending']);
      out.push({ id: r.insertId, format: fmt });
      creativeAb.bust(Number(it.campaign_id) || 0);
      autoReviewCreative(r.insertId).catch(() => {}); // Point 3：素材入库即跑规则引擎（自动驳回/通过/标记人工）
    }
    res.json({ ok: true, created: out.length, items: out, errors: errs });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 素材审核（与计划审核同构）：此前素材被拒无原因可展示，广告主不知道为什么被拒。
app.put('/api/creative/:id/approve', security.requireAuth('admin'), async (req, res) => {
  try {
    const id = +req.params.id;
    const [[c]] = await pool.query('SELECT campaign_id FROM creatives WHERE id=?', [id]);
    await pool.query("UPDATE creatives SET creative_status='approved', review_note='' WHERE id=?", [id]);
    if (c) creativeAb.bust(Number(c.campaign_id) || 0);
    await security.logAudit(req, 'creative:approve', 'creative#' + id, '');
    res.json({ ok: true, review_status: 'approved' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/creative/:id/reject', security.requireAuth('admin'), async (req, res) => {
  const note = String((req.body && req.body.note) || '').trim();
  if (!note) return res.status(400).json({ error: '驳回必须填写原因（广告主据此修改后重提）' });
  try {
    const id = +req.params.id;
    const [[c]] = await pool.query('SELECT campaign_id FROM creatives WHERE id=?', [id]);
    await pool.query("UPDATE creatives SET creative_status='rejected', review_note=? WHERE id=?", [note.slice(0, 255), id]);
    if (c) creativeAb.bust(Number(c.campaign_id) || 0); // 立即从投放池移除
    await security.logAudit(req, 'creative:reject', 'creative#' + id, note.slice(0, 200));
    await pool.query("INSERT INTO review_audit_log (target_type,target_id,action,actor,note) VALUES ('creative',?,?,?,?)", [id, 'reject', 'admin', note.slice(0, 200)]);
    res.json({ ok: true, review_status: 'rejected' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== 素材审核规则引擎（Point 3）=====
// 规则类型：keyword(关键词) / sensitive_word(敏感词) / landing_domain(落地域名) / image_hash(图片MD5黑名单)
// 动作：auto_reject(自动驳回) / auto_approve(自动通过) / flag(标记人工)
// 默认无命中 → 保持 pending 人工审核；命中 auto_reject → 驳回（最高优先级）；命中 auto_approve → 通过；命中 flag → 标记待人工。
async function loadReviewRules() {
  const [rows] = await pool.query('SELECT * FROM creative_review_rules WHERE enabled=1');
  return rows || [];
}
function domainOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}
function matchText(text, pattern) {
  const t = String(text || '').toLowerCase();
  return String(pattern || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean).some(p => t.includes(p));
}
function matchDomain(dom, pattern) {
  const d = String(dom || '').toLowerCase();
  return String(pattern || '').split(',').map(s => s.trim().toLowerCase().replace(/^\*\./, '')).filter(Boolean)
    .some(p => d === p || d.endsWith('.' + p));
}
async function computeMediaHash(mediaUrl) {
  if (!mediaUrl || !/^https?:\/\//i.test(mediaUrl)) return null;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    const r = await fetch(mediaUrl, { signal: ctrl.signal, redirect: 'follow' });
    clearTimeout(timer);
    if (!r.ok) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    return crypto.createHash('md5').update(buf).digest('hex');
  } catch { return null; }
}
function runCreativeReview(c, rules, mediaHash) {
  const text = [c.title, c.content, c.landing_url, c.app_id, c.deep_link, c.media_url].join(' ');
  const reasons = [];
  let decision = 'pending'; // pending | auto_reject | auto_approve | flag
  for (const r of rules) {
    let hit = false;
    if (r.type === 'keyword' || r.type === 'sensitive_word') hit = matchText(text, r.pattern);
    else if (r.type === 'landing_domain') hit = matchDomain(domainOf(c.landing_url), r.pattern);
    else if (r.type === 'image_hash') hit = !!(mediaHash && r.pattern && mediaHash === String(r.pattern).trim().toLowerCase());
    if (!hit) continue;
    reasons.push({ id: r.id, name: r.name, type: r.type, action: r.action, severity: r.severity });
    if (r.action === 'auto_reject') decision = 'auto_reject';
    else if (r.action === 'auto_approve' && decision !== 'auto_reject') decision = 'auto_approve';
    else if (r.action === 'flag' && decision === 'pending') decision = 'flag';
  }
  return { decision, reasons };
}
async function autoReviewCreative(id) {
  const [[c]] = await pool.query('SELECT * FROM creatives WHERE id=?', [id]);
  if (!c) return { ok: false, error: 'creative not found' };
  const rules = await loadReviewRules();
  const mediaHash = await computeMediaHash(c.media_url);
  if (mediaHash) await pool.query('UPDATE creatives SET media_hash=? WHERE id=?', [mediaHash, id]).catch(() => {});
  const { decision, reasons } = runCreativeReview(c, rules, mediaHash);
  let status = c.creative_status, note = '', flagged = 0;
  if (decision === 'auto_reject') { status = 'rejected'; note = '规则引擎自动驳回：' + reasons.map(r => r.name).join('; '); }
  else if (decision === 'auto_approve') { status = 'approved'; note = '规则引擎自动通过：' + reasons.map(r => r.name).join('; '); }
  else if (decision === 'flag') { flagged = 1; status = 'pending'; note = '规则命中需人工复核：' + reasons.map(r => r.name).join('; '); }
  await pool.query('UPDATE creatives SET creative_status=?, review_note=?, review_flagged=?, review_matched=? WHERE id=?',
    [status, note, flagged, JSON.stringify(reasons), id]);
  if (c.campaign_id) creativeAb.bust(Number(c.campaign_id) || 0);
  const actor = decision === 'pending' ? 'rule-engine:manual' : 'rule-engine';
  await pool.query('INSERT INTO review_audit_log (target_type,target_id,action,actor,note) VALUES (?,?,?,?,?)',
    ['creative', id, decision === 'pending' ? 'auto_pending' : decision, actor, note]);
  return { ok: true, decision, status, reasons, mediaHash };
}

// 规则管理（运营）
app.get('/api/admin/review-rules', security.requireAuth('admin'), async (req, res) => {
  try { const [rows] = await pool.query('SELECT * FROM creative_review_rules ORDER BY id DESC'); res.json(rows); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/review-rules', security.requireAuth('admin'), async (req, res) => {
  const b = req.body || {};
  if (!String(b.name || '').trim()) return res.status(400).json({ error: 'name 必填' });
  try {
    const [r] = await pool.query(
      'INSERT INTO creative_review_rules (name,type,pattern,action,severity,enabled) VALUES (?,?,?,?,?,?)',
      [b.name.trim(), b.type || 'keyword', String(b.pattern || ''), b.action || 'auto_reject', b.severity || 'block', b.enabled === false ? 0 : 1]);
    res.json({ ok: true, id: r.insertId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/admin/review-rules/:id', security.requireAuth('admin'), async (req, res) => {
  const id = +req.params.id; const b = req.body || {};
  try {
    const set = []; const v = [];
    ['name', 'type', 'pattern', 'action', 'severity'].forEach(f => { if (b[f] !== undefined) { set.push(f + '=?'); v.push(f === 'pattern' ? String(b[f]) : b[f]); } });
    if (b.enabled !== undefined) { set.push('enabled=?'); v.push(b.enabled ? 1 : 0); }
    if (!set.length) return res.json({ ok: true });
    v.push(id);
    await pool.query('UPDATE creative_review_rules SET ' + set.join(',') + ' WHERE id=?', v);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/admin/review-rules/:id', security.requireAuth('admin'), async (req, res) => {
  try { await pool.query('DELETE FROM creative_review_rules WHERE id=?', [+req.params.id]); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
// 单条重新跑规则引擎
app.post('/api/creative/:id/auto-review', security.requireAuth('admin'), async (req, res) => {
  try { res.json(await autoReviewCreative(+req.params.id)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
// 批量对 pending/draft 素材跑规则引擎
app.post('/api/admin/review/auto-all', security.requireAuth('admin'), async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT id FROM creatives WHERE creative_status IN ('draft','pending')");
    let done = 0;
    for (const r of rows || []) { await autoReviewCreative(r.id).catch(() => {}); done++; }
    res.json({ ok: true, scanned: done });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// ===== 批量审核中心（P0 补齐）：单条 + 批量 + 待审列表 =====
function _auditActor(req) {
  const u = (req.account && (req.account.u || req.account.s)) || 'admin';
  const t = (req.account && req.account.t) || 'admin';
  return (t === 'admin') ? u : (t + ':' + u);
}
app.post('/api/admin/review', security.requireAuth('admin'), async (req, res) => {
  const b = req.body || {};
  const kind = String(b.kind || '').toLowerCase();
  const id = +b.id;
  const action = String(b.action || '').toLowerCase();
  const note = String(b.note || '').trim();
  if (!['campaign', 'creative'].includes(kind)) return res.status(400).json({ error: 'kind 必须是 campaign 或 creative' });
  if (!id) return res.status(400).json({ error: 'id 必填' });
  if (!['approve', 'reject'].includes(action)) return res.status(400).json({ error: 'action 必须是 approve 或 reject' });
  try {
    if (kind === 'campaign') {
      const [[c]] = await pool.query('SELECT id,advertiser,review_status FROM adv_campaign WHERE id=?', [id]);
      if (!c) return res.status(404).json({ error: 'campaign not found' });
      const nextStatus = (action === 'approve') ? 'approved' : 'rejected';
      if (c.review_status === nextStatus) {
        return res.json({ ok: true, id, kind, already: true, review_status: c.review_status, advertiser: c.advertiser });
      }
      await pool.query("UPDATE adv_campaign SET review_status=?, review_note=? WHERE id=?", [nextStatus, note.slice(0, 255), id]);
      await pool.query("INSERT INTO review_audit_log (target_type,target_id,action,actor,note,created_at) VALUES (?,?,?,?,?,NOW())",
        ['campaign', id, action, _auditActor(req), note.slice(0, 255)]).catch(() => {});
      res.json({ ok: true, id, kind, action, affected: 1, actor: _auditActor(req) });
    } else {
      const [[cc]] = await pool.query('SELECT id,campaign_id,creative_status FROM creatives WHERE id=?', [id]);
      if (!cc) return res.status(404).json({ error: 'creative not found' });
      const nextStatus = (action === 'approve') ? 'approved' : 'rejected';
      if (cc.creative_status === nextStatus) {
        return res.json({ ok: true, id, kind, already: true, creative_status: cc.creative_status, campaign_id: cc.campaign_id });
      }
      await pool.query("UPDATE creatives SET creative_status=? WHERE id=?", [nextStatus, id]);
      await pool.query("INSERT INTO review_audit_log (target_type,target_id,action,actor,note,created_at) VALUES (?,?,?,?,?,NOW())",
        ['creative', id, action, _auditActor(req), note.slice(0, 255)]).catch(() => {});
      res.json({ ok: true, id, kind, action, affected: 1, actor: _auditActor(req) });
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 审核留痕（Point 11）
app.get('/api/admin/review-audit', security.requireAuth('admin'), async (req, res) => {
  try {
    const w = []; const v = [];
    if (req.query.target_type) { w.push('target_type=?'); v.push(req.query.target_type); }
    if (req.query.target_id) { w.push('target_id=?'); v.push(+req.query.target_id); }
    const [rows] = await pool.query('SELECT * FROM review_audit_log ' + (w.length ? 'WHERE ' + w.join(' AND ') : '') + ' ORDER BY id DESC LIMIT 200', v);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 待审列表：?kind=campaign → adv_campaign 中 review_status='pending'；?kind=creative → creatives 中 creative_status IN ('draft','pending')
app.get('/api/admin/review/pending', security.requireAuth('admin'), async (req, res) => {
  const kind = String(req.query.kind || 'campaign').toLowerCase();
  const limit = Math.min(500, Number(req.query.limit) || 100);
  try {
    if (kind === 'creative') {
      const [rows] = await pool.query(
        "SELECT id,campaign_id,advertiser,creative_status,format,title FROM creatives WHERE creative_status IN ('draft','pending') ORDER BY id DESC LIMIT ?",
        [limit]);
      res.json(rows);
    } else {
      const [rows] = await pool.query(
        "SELECT id,name,advertiser,app_category,review_status,review_note,status FROM adv_campaign WHERE review_status='pending' ORDER BY id DESC LIMIT ?",
        [limit]);
      res.json(rows);
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 批量审核：不传 ids 则审核全部 pending；传 ids 数组则只审核这些
// 幂等：只处理仍为 pending/draft 的行，已 approved/rejected 自动跳过
app.post('/api/admin/review/batch', security.requireAuth('admin'), async (req, res) => {
  const b = req.body || {};
  const kind = String(b.kind || '').toLowerCase();
  const action = String(b.action || '').toLowerCase();
  const note = String(b.note || '').trim();
  const ids = Array.isArray(b.ids) ? b.ids.map(x => +x).filter(x => x > 0) : null;
  if (!['campaign', 'creative'].includes(kind)) return res.status(400).json({ error: 'kind 必须是 campaign 或 creative' });
  if (!['approve', 'reject'].includes(action)) return res.status(400).json({ error: 'action 必须是 approve 或 reject' });
  try {
    const nextStatus = (action === 'approve') ? 'approved' : 'rejected';
    let affected = 0;
    let target_ids = [];
    if (kind === 'campaign') {
      const ph = ids ? ('IN (' + ids.map(() => '?').join(',') + ')') : '';
      const where = "WHERE review_status='pending'" + (ph ? ' AND id ' + ph : '');
      const [r] = await pool.query('UPDATE adv_campaign SET review_status=?, review_note=? ' + where, [nextStatus, note.slice(0, 255), ...(ids || [])]);
      affected = r.affectedRows;
      const [idRows] = ids
        ? await pool.query('SELECT id FROM adv_campaign WHERE id IN (' + ids.map(() => '?').join(',') + ')', ids)
        : await pool.query("SELECT id FROM adv_campaign WHERE review_status=?", [nextStatus]);
      target_ids = (idRows || []).map(x => x.id).slice(0, 50);
    } else {
      const ph = ids ? ('IN (' + ids.map(() => '?').join(',') + ')') : '';
      const where = "WHERE creative_status IN ('draft','pending')" + (ph ? ' AND id ' + ph : '');
      const [r] = await pool.query("UPDATE creatives SET creative_status=? " + where, [nextStatus, ...(ids || [])]);
      affected = r.affectedRows;
      const [idRows] = ids
        ? await pool.query('SELECT id FROM creatives WHERE id IN (' + ids.map(() => '?').join(',') + ')', ids)
        : await pool.query("SELECT id FROM creatives WHERE creative_status=?", [nextStatus]);
      target_ids = (idRows || []).map(x => x.id).slice(0, 50);
    }
    const target_type = (kind === 'campaign') ? 'campaign' : 'creative';
    const batchNote = (note || ('batch-' + action)).slice(0, 255);
    for (const tid of target_ids) {
      await pool.query(
        "INSERT INTO review_audit_log (target_type,target_id,action,actor,note,created_at) VALUES (?,?,?,?,?,NOW())",
        [target_type, tid, action, _auditActor(req), batchNote]).catch(() => {});
    }
    res.json({ ok: true, kind, action, affected, scanned: target_ids.length, actor: _auditActor(req) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== 需求方(DSP)持久化注册（③ 真实需求方连接）=====
// 注册后该 DSP 立即进入拍卖；并写入 dsp_partners 表，重启后由 init() 自动恢复
// 需求方(DSP)注册：需管理员令牌或已入驻平台 api_key —— 防止匿名第三方任意注入需求方（安全）。
// 平台自助开通 DSP：管理员建，或已入驻媒体/合作方用 api_key 自助登记。
app.post('/api/dsp/register', publisherOrApiKey, async (req, res) => {
  const b = req.body || {};
  // 同时兼容 url / endpoint、payoutRate / payout_rate 两种命名，避免前端/接口示例对不上字段名而 400。
  const name = b.name;
  const url = b.url || b.endpoint;
  const payoutRate = b.payoutRate != null ? b.payoutRate : (b.payout_rate != null ? b.payout_rate : 0.6);
  const type = b.type || 'http';
  const isOwn = b.isOwn != null ? b.isOwn : 0;
  if (!name || !url) return res.status(400).json({ error: 'name,url(或 endpoint) required' });
  try {
    await pool.query('INSERT INTO dsp_partners (name,url,payout_rate,type,is_own) VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE url=VALUES(url),payout_rate=VALUES(payout_rate),type=VALUES(type),is_own=VALUES(is_own),status=1',
      [name, url, Number(payoutRate), type, isOwn ? 1 : 0]);
    if (!DEMAND_PARTNERS.find(p => p.name === name)) DEMAND_PARTNERS.push({ name, type, url, payoutRate: Number(payoutRate), isOwn: !!isOwn });
    res.json({ ok: true, partners: DEMAND_PARTNERS.map(p => p.name) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// 需求方列表/删除属运营动作，仍要管理员；注册(/api/dsp/register)需管理员令牌或平台 api_key。
app.get('/api/dsp', security.requireAdmin('admin'), async (_, res) => {
  try { const [rows] = await pool.query('SELECT name,url,payout_rate,type,is_own,status FROM dsp_partners WHERE status=1 ORDER BY id DESC'); res.json(rows); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
// Fix-02：增删需求方会直接改变竞价池构成，必须是具备运营写权限的管理员
app.delete('/api/dsp/:name', security.requireAdmin('admin'), security.requireScope('demand:write'), async (req, res) => {
  const n = req.params.name;
  try { await pool.query('UPDATE dsp_partners SET status=0 WHERE name=?', [n]); DEMAND_PARTNERS = DEMAND_PARTNERS.filter(p => p.name !== n); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== 结算 / 报表闭环（⑤ 对标多客户分账）=====
// SSP 全局结算（由 bid_win_log 聚合，含媒体方分成与 SSP 毛利）
// 广告主侧对账：应收(adv_ledger) vs 已投放(bid_win_log)，diff≠0 需人工核查
app.get('/api/reports/reconciliation', security.requireScope('reconciliation:read'), async (req, res) => {
  try {
    // ── Fix-03 根因：此前把「全部账本行」与「胜出行」直接按 campaign 聚合 ──
    // 于是「有扣费、但没有对应胜出记录」的孤儿账本行被算进 charged，
    // 表现为 win_n=309 / ledger_n=922（差 3 倍）与 AMOUNT_MISMATCH ¥1900 —— 差异被凭空放大。
    // 现在：只有能 JOIN 到真实胜出记录 (imp_id, req_id) 的账本行才计入 charged；
    // 孤儿行单独归为 ORPHAN_LEDGER 并给出金额，可经 /reconciliation/repair 标记为不可计费。
    // 同时对胜出行按 (imp_id, req_id) 去重，避免重复埋点把 served 也放大。
    const [wins] = await pool.query(
      `SELECT campaign_id, COUNT(*) n, SUM(price_micros) served FROM (
         SELECT campaign_id, imp_id, req_id, MAX(price_micros) price_micros
         FROM bid_win_log WHERE campaign_id > 0 AND COALESCE(billable,1)=1
         GROUP BY campaign_id, imp_id, req_id
       ) t GROUP BY campaign_id`);
    const [ledger] = await pool.query(
      `SELECT l.campaign_id, COUNT(*) n, SUM(l.charge_micros) charged, SUM(l.insufficient) bad
       FROM adv_ledger l
       INNER JOIN (SELECT DISTINCT imp_id, req_id FROM bid_win_log WHERE COALESCE(billable,1)=1) w
         ON w.imp_id = l.imp_id AND w.req_id = l.req_id
       WHERE COALESCE(l.billable,1)=1
       GROUP BY l.campaign_id`);
    // 孤儿账本：扣了费但从未有胜出记录（测试回调 / 手工 curl / 重复投递）
    const [orphan] = await pool.query(
      `SELECT l.campaign_id, COUNT(*) n, SUM(l.charge_micros) charged
       FROM adv_ledger l
       LEFT JOIN (SELECT DISTINCT imp_id, req_id FROM bid_win_log) w
         ON w.imp_id = l.imp_id AND w.req_id = l.req_id
       WHERE w.imp_id IS NULL AND COALESCE(l.billable,1)=1
       GROUP BY l.campaign_id`);
    const [[nb]] = await pool.query('SELECT COUNT(*) n FROM bid_win_log WHERE COALESCE(billable,1)=0');
    const [[nb2]] = await pool.query('SELECT COUNT(*) n FROM adv_ledger WHERE COALESCE(billable,1)=0');

    const lMap = new Map(ledger.map(l => [Number(l.campaign_id), l]));
    const oMap = new Map(orphan.map(o => [Number(o.campaign_id), o]));
    const ids = new Set([...wins.map(w => Number(w.campaign_id)), ...ledger.map(l => Number(l.campaign_id)), ...orphan.map(o => Number(o.campaign_id))]);
    const rows = [];
    for (const id of ids) {
      const w = wins.find(x => Number(x.campaign_id) === id);
      const l = lMap.get(id);
      const o = oMap.get(id);
      const served = Number(w && w.served) || 0;
      const charged = l ? (Number(l.charged) || 0) : 0;
      const orphanN = o ? Number(o.n) : 0;
      const orphanMicros = o ? (Number(o.charged) || 0) : 0;
      const issues = [];
      if (Math.abs(charged - served) > 0) issues.push('AMOUNT_MISMATCH');
      if (orphanN > 0) issues.push('ORPHAN_LEDGER');
      if (!l && !w) issues.push('NO_DATA');
      rows.push({
        campaign_id: id, win_n: w ? Number(w.n) : 0, ledger_n: l ? Number(l.n) : 0,
        served_micros: served, charged_micros: charged, diff_micros: charged - served,
        insufficient: l ? (Number(l.bad) || 0) : 0,
        orphan_ledger_n: orphanN, orphan_ledger_micros: orphanMicros,
        issue: issues.join('+'),
      });
    }
    const tCharged = rows.reduce((s, r) => s + r.charged_micros, 0);
    const tServed = rows.reduce((s, r) => s + r.served_micros, 0);
    const tOrphan = rows.reduce((s, r) => s + r.orphan_ledger_micros, 0);
    const bad = rows.filter(r => r.issue && r.issue !== 'NO_DATA');
    res.json({
      rows: rows.sort((a, b) => Math.abs(b.diff_micros) - Math.abs(a.diff_micros)),
      total: { charged_micros: tCharged, served_micros: tServed, diff_micros: tCharged - tServed, orphan_micros: tOrphan },
      summary: {
        campaigns: rows.length,
        amount_mismatch: bad.filter(r => /AMOUNT_MISMATCH/.test(r.issue)).length,
        orphan_ledger: bad.filter(r => /ORPHAN_LEDGER/.test(r.issue)).length,
        diff_cny: +((tCharged - tServed) / 1e6).toFixed(2),
        orphan_cny: +(tOrphan / 1e6).toFixed(2),
      },
      non_billable_rows: { bid_win_log: Number(nb && nb.n) || 0, adv_ledger: Number(nb2 && nb2.n) || 0 },
      hint: bad.length ? ('存在 ' + bad.length + ' 条计划账实不符；ORPHAN_LEDGER 可用 POST /api/reports/reconciliation/repair 标记为不可计费后复核') : '',
      note: 'charged 仅统计能匹配到胜出记录(imp_id,req_id)的账本行；孤儿扣费单独计入 orphan_ledger_micros，不再混入 AMOUNT_MISMATCH',
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// 修复孤儿账本：把「有扣费、无胜出记录」的账本行标记为不可计费（保留流水，不物理删除）
app.post('/api/reports/reconciliation/repair', security.requireAuth('admin'), security.requireScope('reconciliation:read'), async (req, res) => {
  const apply = String(req.query.apply || req.body?.apply || '') === '1';
  try {
    const [[cnt]] = await pool.query(
      `SELECT COUNT(*) n, COALESCE(SUM(l.charge_micros),0) micros FROM adv_ledger l
       LEFT JOIN (SELECT DISTINCT imp_id, req_id FROM bid_win_log) w ON w.imp_id=l.imp_id AND w.req_id=l.req_id
       WHERE w.imp_id IS NULL AND COALESCE(l.billable,1)=1`);
    if (!apply) {
      return res.json({ ok: true, dry_run: true, would_mark: Number(cnt.n) || 0, micros: Number(cnt.micros) || 0,
        hint: '带 ?apply=1 真正执行；只会把 adv_ledger.billable 置 0，不删除流水' });
    }
    const [r] = await pool.query(
      `UPDATE adv_ledger l LEFT JOIN (SELECT DISTINCT imp_id, req_id FROM bid_win_log) w ON w.imp_id=l.imp_id AND w.req_id=l.req_id
       SET l.billable=0 WHERE w.imp_id IS NULL AND COALESCE(l.billable,1)=1`);
    await security.logAudit(req, 'reconciliation:repair', 'adv_ledger', 'marked_non_billable=' + (Number(r.affectedRows) || 0));
    res.json({ ok: true, marked: Number(r.affectedRows) || 0, note: '已标记为不可计费；请重新拉取 /api/reports/reconciliation 复核' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Fix-02：结算金额只对"有结算权限"的管理员开放（财务/超管），只读管理员看不到
app.get('/api/reports/settlement', security.requireScope('reports:settlement'), async (_, res) => {
  try {
    const [rows] = await pool.query('SELECT publisher, COUNT(*) wins, COALESCE(SUM(price_micros),0) gross FROM bid_win_log GROUP BY publisher');
    const [pubs] = await pool.query('SELECT domain, payout_rate FROM publishers');
    const rateMap = {}; pubs.forEach(p => rateMap[p.domain] = Number(p.payout_rate) || 0.7);
    let grossAll = 0, payoutAll = 0;
    const list = rows.map(r => {
      const rate = rateMap[r.publisher] || 0.7; const gross = Number(r.gross);
      const payout = Math.round(gross * rate); grossAll += gross; payoutAll += payout;
      return { publisher: r.publisher, wins: Number(r.wins), gross_cny: gross / 1e6, payout_cny: payout / 1e6, ssp_margin_cny: (gross - payout) / 1e6 };
    });
    const margin = grossAll - payoutAll;
    res.json({ ssp: { wins: list.reduce((a, b) => a + b.wins, 0), gross_cny: grossAll / 1e6, payout_cny: payoutAll / 1e6, ssp_margin_cny: margin / 1e6, margin_rate: grossAll ? margin / grossAll : 0 }, publishers: list });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// 媒体方自助报表（凭 api_key 或 domain/作用域令牌 查看自己的胜出/分成/完播/转化）——抽成公共函数
async function publisherReport(key) {
  // key 可能是 api_key，也可能是媒体账号令牌的作用域(=域名)，两者都支持
  const [[p]] = await pool.query('SELECT domain,name,payout_rate FROM publishers WHERE api_key=? OR domain=?', [String(key || ''), String(key || '')]);
  if (!p) { const e = new Error('invalid api_key or domain'); e.status = 403; throw e; }
  const domain = p.domain; const rate = Number(p.payout_rate) || 0.7;
  const [[w]] = await pool.query('SELECT COUNT(*) wins, COALESCE(SUM(price_micros),0) gross FROM bid_win_log WHERE publisher=?', [domain]);
  const [[rw]] = await pool.query("SELECT COALESCE(SUM(status='GRANTED'),0) granted, COUNT(*) total FROM reward_log WHERE publisher=?", [domain]);
  const [[ck]] = await pool.query("SELECT COUNT(*) clicks FROM conv_log WHERE type='click' AND publisher=?", [domain]);
  const [[cv]] = await pool.query("SELECT COUNT(*) conversions, COALESCE(SUM(amount),0) gmv FROM conv_log WHERE type='conversion' AND publisher=?", [domain]);
  const gross = Number(w.gross) || 0; const payout = Math.round(gross * rate);
  // 按广告单元拆解（对标 AppLovin Advanced Reporting 的「广告资源表现」）
  let adUnits = [];
  try {
    const [defs] = await pool.query('SELECT ad_unit_id,name,format,floor_cny,status FROM ad_units WHERE publisher=? ORDER BY id DESC', [domain]);
    const [stat] = await pool.query('SELECT ad_unit_id, COUNT(*) wins, COALESCE(SUM(price_micros),0) gross FROM bid_win_log WHERE publisher=? GROUP BY ad_unit_id', [domain]);
    const map = {}; stat.forEach(function (s) { map[String(s.ad_unit_id || '')] = s; });
    adUnits = defs.map(function (d) {
      const s = map[d.ad_unit_id] || { wins: 0, gross: 0 };
      const g = Number(s.gross) || 0;
      return { ad_unit_id: d.ad_unit_id, name: d.name, format: d.format, status: Number(d.status) === 1 ? 'active' : 'paused',
        wins: Number(s.wins) || 0, gross_cny: g / 1e6, payout_cny: Math.round(g * rate) / 1e6 };
    });
    // 未挂广告单元的裸埋点曝光单独归一行，避免历史数据凭空消失
    const bare = map[''];
    if (bare && Number(bare.wins) > 0) {
      adUnits.push({ ad_unit_id: '', name: '（未标注广告单元）', format: '-', status: 'active',
        wins: Number(bare.wins), gross_cny: Number(bare.gross) / 1e6, payout_cny: Math.round(Number(bare.gross) * rate) / 1e6 });
    }
  } catch (e) { adUnits = []; }
  // 回执状态：reward_log 中该媒体的结算裁决分布（GRANTED / 待S2S回执 / 各类拒绝）——即媒体对账的"回执"维度
  let receipts = { granted: 0, pending: 0, rejected: 0, byStatus: {} };
  try {
    const [stat] = await pool.query('SELECT status, COUNT(*) n FROM reward_log WHERE publisher=? GROUP BY status', [domain]);
    (stat || []).forEach(function (r) {
      const n = Number(r.n) || 0; const st = String(r.status || '');
      receipts.byStatus[st] = n;
      if (/GRANTED/.test(st)) receipts.granted += n;
      else if (/AWAITING_S2S|PENDING/.test(st)) receipts.pending += n;
      else receipts.rejected += n;
    });
  } catch (e) {}
  return {
    publisher: { domain, name: p.name, payout_rate: rate },
    wins: Number(w.wins), gross_cny: gross / 1e6, payout_cny: payout / 1e6, ssp_margin_cny: (gross - payout) / 1e6,
    rewarded_granted: Number(rw.granted) || 0, rewarded_total: Number(rw.total) || 0,
    clicks: Number(ck.clicks) || 0, conversions: Number(cv.conversions) || 0, gmv: Number(cv.gmv) || 0,
    receipts, s2s_enforce: process.env.S2S_ENFORCE === '1',
    ad_units: adUnits
  };
}
// 媒体收益报表：三种鉴权都通（Fix-05）
//   ① 媒体账号令牌（Bearer）→ 取自己作用域域名，永远只看自己的数据
//   ② 媒体 X-Api-Key 头 或 ?api_key= → 取该 key 对应域名
//   ③ 管理员令牌 → 必须显式指定 domain / api_key / publisher，否则 400（不允许"拉全站"模糊查询）
app.get('/api/reports/publisher', publisherOrApiKey, async (req, res) => {
  try {
    const acc = req.account || {};
    let key = '';
    if (acc.t === 'publisher') {
      key = String(acc.s || '');
    } else {
      key = String(req.query.domain || req.query.api_key || req.query.publisher || '').trim();
      if (!key) return res.status(400).json({ error: '管理员查询需指定 domain 或 api_key（或 publisher）参数' });
    }
    res.json(await publisherReport(key));
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
// 供给方自助（公开，仅 api_key 鉴权，不要求管理员令牌）——真正的「媒体后台」入口，规避管理员网关
app.get('/api/publisher/report', (req, res, next) => {
  const a = security.accountFromReq(req);
  if (a && a.t === 'publisher') { req.pubScope = a.s; return next(); }
  if (req.query.api_key) return next();
  return res.status(401).json({ error: 'unauthorized', hint: '请登录媒体账号或携带 api_key' });
}, async (req, res) => {
  try { res.json(await publisherReport(req.pubScope || req.query.api_key)); }
  catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// ===== ⑧ 两步验证 TOTP（对标 AppLovin 2-Step Verification）=====
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function b32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const b of buf) { value = (value << 8) | b; bits += 8; while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
function b32Decode(s) {
  let bits = 0, value = 0, key = [];
  for (const ch of String(s || '').toUpperCase()) {
    const i = B32.indexOf(ch); if (i < 0) continue;
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { key.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(key);
}
function totpAt(secret, t) {
  const counter = Math.floor(t / 1000 / 30);
  const msg = Buffer.alloc(8);
  msg.writeUInt32BE(Math.floor(counter / 4294967296), 0);
  msg.writeUInt32BE(counter >>> 0, 4);
  const h = crypto.createHmac('sha1', b32Decode(secret)).update(msg).digest();
  const off = h[h.length - 1] & 15;
  const code = ((h[off] & 127) << 24) | ((h[off + 1] & 255) << 16) | ((h[off + 2] & 255) << 8) | (h[off + 3] & 255);
  return String(code % 1000000).padStart(6, '0');
}
// 允许 ±1 个时间窗（30s）漂移，避免手机与服务器轻微时钟差导致永远登不上
function totpValid(secret, code) {
  const c = String(code || '').trim();
  if (!/^\d{6}$/.test(c)) return false;
  const now = Date.now();
  return totpAt(secret, now - 30000) === c || totpAt(secret, now) === c || totpAt(secret, now + 30000) === c;
}
// 绑定：生成密钥（只做一次），返回 otpauth 供认证器扫码
app.post('/api/account/2fa/setup', security.requireAuth('admin', 'advertiser', 'publisher'), async (req, res) => {
  try {
    const secret = b32Encode(crypto.randomBytes(10));
    await pool.query('UPDATE accounts SET totp_secret=? WHERE username=? AND type=?', [secret, req.account.u, req.account.t]);
    res.json({ ok: true, secret, otpauth: 'otpauth://totp/AppLink:' + encodeURIComponent(req.account.u) + '?secret=' + secret + '&issuer=AppLink' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/account/2fa/enable', security.requireAuth('admin', 'advertiser', 'publisher'), async (req, res) => {
  try {
    const [[a]] = await pool.query('SELECT totp_secret FROM accounts WHERE username=? AND type=?', [req.account.u, req.account.t]);
    if (!a || !a.totp_secret) return res.status(400).json({ error: '请先调用 /api/account/2fa/setup 生成密钥' });
    if (!totpValid(a.totp_secret, (req.body || {}).code)) return res.status(400).json({ error: '动态码不正确或已过期' });
    await pool.query('UPDATE accounts SET twofa=1 WHERE username=? AND type=?', [req.account.u, req.account.t]);
    res.json({ ok: true, twofa: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/account/2fa/disable', security.requireAuth('admin', 'advertiser', 'publisher'), async (req, res) => {
  try {
    const [[a]] = await pool.query('SELECT totp_secret FROM accounts WHERE username=? AND type=?', [req.account.u, req.account.t]);
    if (!a || !a.totp_secret || !totpValid(a.totp_secret, (req.body || {}).code)) return res.status(400).json({ error: '动态码不正确' });
    await pool.query('UPDATE accounts SET twofa=0, totp_secret="" WHERE username=? AND type=?', [req.account.u, req.account.t]);
    res.json({ ok: true, twofa: false });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// 登录第二步：用 challenge + 动态码换真正令牌
app.post('/api/account/login/2fa', async (req, res) => {
  const { challenge, code } = req.body || {};
  if (!challenge || !code) return res.status(400).json({ error: 'challenge,code required' });
  try {
    const u = await cache.get('2fa:' + String(challenge)).catch(() => null);
    if (!u) return res.status(401).json({ error: 'challenge 无效或已过期，请重新登录' });
    const [[a]] = await pool.query('SELECT * FROM accounts WHERE username=?', [String(u)]);
    if (!a || a.status !== 1 || !a.totp_secret) return res.status(401).json({ error: '账号不可用' });
    if (!totpValid(a.totp_secret, code)) {
      security.logAudit(req, 'LOGIN_2FA_FAIL', String(u), '');
      return res.status(401).json({ error: '动态码不正确或已过期' });
    }
    await cache.set('2fa:' + String(challenge), '', 1).catch(() => {}); // 一次性
    const token = security.issueToken({ username: a.username, type: a.type, scope: a.scope });
    res.json({ ok: true, token, type: a.type, scope: a.scope, username: a.username, display: a.display });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== ① 填充率 / 胜率（对标 AppLovin Advanced Reporting）=====
function rate(n, d) { return d > 0 ? Number((n / d).toFixed(4)) : null; }
app.get('/api/reports/supply-quality', publisherOrApiKey, async (req, res) => {
  try {
    const acc = req.account;
    const w = (acc.t === 'publisher') ? ' WHERE publisher=?' : '';
    const args = (acc.t === 'publisher') ? [acc.s] : [];
    const [reqs] = await pool.query('SELECT publisher, ad_unit_id, COUNT(*) reqs, MAX(created_at) last_req FROM bid_req_log' + w + ' GROUP BY publisher, ad_unit_id', args);
    const [wins] = await pool.query('SELECT publisher, ad_unit_id, COUNT(*) wins, COALESCE(SUM(price_micros),0) gross FROM bid_win_log' + w + ' GROUP BY publisher, ad_unit_id', args);
    const map = {}; wins.forEach(x => { map[x.publisher + '|' + (x.ad_unit_id || '')] = x; });
    res.json(reqs.map(r => {
      const x = map[r.publisher + '|' + (r.ad_unit_id || '')] || { wins: 0, gross: 0 };
      return { publisher: r.publisher, ad_unit_id: r.ad_unit_id, requests: Number(r.reqs),
        wins: Number(x.wins), fill_rate: rate(Number(x.wins), Number(r.reqs)),
        gross_cny: Number(x.gross) / 1e6, last_request_at: r.last_req };
    }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/reports/demand-quality', security.requireAuth('admin'), async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT partner, COUNT(*) bids, COALESCE(SUM(won),0) wins, ROUND(AVG(price_micros)/1e6,4) avg_cpm_cny FROM bid_bid_log GROUP BY partner ORDER BY bids DESC");
    res.json(rows.map(r => ({ partner: r.partner, bids: Number(r.bids), wins: Number(r.wins),
      win_rate: rate(Number(r.wins), Number(r.bids)), avg_cpm_cny: Number(r.avg_cpm_cny) || 0 })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== ④ 可观测报表（闭环数据可见：归因 / 创意 / A·B / 预算建议）=====
app.get('/api/console/report/attribution', publisherOrApiKey, async (req, res) => {
  try {
    const days = Math.min(60, Math.max(1, +req.query.days || 7));
    const pub = String(req.query.publisher || '').trim();
    const cond = pub ? ' WHERE publisher=? AND created_at > NOW()-INTERVAL ? DAY' : ' WHERE created_at > NOW()-INTERVAL ? DAY';
    const params = pub ? [pub, days] : [days];
    const [imp] = await pool.query('SELECT DATE(created_at) d, COUNT(*) wins, COALESCE(SUM(price_micros),0) gross FROM bid_win_log' + cond + ' GROUP BY DATE(created_at) ORDER BY d', params);
    const [clk] = await pool.query("SELECT DATE(created_at) d, COALESCE(SUM(type='click'),0) clicks, COALESCE(SUM(type='conversion'),0) conv, COALESCE(SUM(amount),0) amt FROM conv_log" + cond + ' GROUP BY DATE(created_at) ORDER BY d', params);
    res.json({ days, publisher: pub || 'all', impressions: imp, conversions: clk });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/console/report/creatives', security.requireAuth('admin'), async (req, res) => {
  try {
    const [rows] = await pool.query(`SELECT c.id, c.campaign_id, c.format, c.title,
      COALESCE(cr.imps,0) impressions, COALESCE(cr.clicks,0) clicks, COALESCE(cr.conversions,0) conversions
      FROM creatives c LEFT JOIN (
        SELECT creative_id, COUNT(*) imps,
          COALESCE(SUM((SELECT 1 FROM conv_log cl WHERE cl.type='click' AND cl.imp_id=bwl.imp_id)),0) clicks,
          COALESCE(SUM((SELECT 1 FROM conv_log cl WHERE cl.type='conversion' AND cl.imp_id=bwl.imp_id)),0) conversions
        FROM bid_win_log bwl GROUP BY creative_id
      ) cr ON cr.creative_id=c.id ORDER BY impressions DESC LIMIT 100`);
    res.json(rows.map(r => ({ id: r.id, campaign_id: r.campaign_id, format: r.format, title: r.title,
      impressions: Number(r.impressions), clicks: Number(r.clicks), conversions: Number(r.conversions),
      ctr: r.impressions ? +(r.clicks / r.impressions).toFixed(4) : 0,
      cvr: r.clicks ? +(r.conversions / r.clicks).toFixed(4) : 0 })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/console/report/ab', security.requireAuth('admin'), async (req, res) => {
  try {
    const [rows] = await pool.query(`SELECT e.id exp_id, e.name, e.kind, v.variant_key,
      COUNT(v.imp_id) exposures, COALESCE(SUM(v.won),0) wins, COALESCE(SUM(v.price_micros),0) gross
      FROM ab_experiments e LEFT JOIN ab_exposure v ON v.exp_id=e.id
      GROUP BY e.id, e.name, e.kind, v.variant_key ORDER BY e.id`);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/console/report/campaigns', security.requireAuth('admin', 'advertiser'), async (req, res) => {
  try {
    const acc = req.account;
    const where = acc.t === 'advertiser' ? ' WHERE advertiser=?' : '';
    const wp = acc.t === 'advertiser' ? [acc.s] : [];
    const [rows] = await pool.query(`SELECT c.id, c.name, c.advertiser, c.status, c.budget_micros,
      COALESCE(w.imps,0) impressions, COALESCE(w.clicks,0) clicks, COALESCE(w.conv,0) conversions, COALESCE(w.spend,0) spend_micros
      FROM adv_campaign c LEFT JOIN (
        SELECT campaign_id, COUNT(*) imps,
          COALESCE(SUM((SELECT 1 FROM conv_log cl WHERE cl.type='click' AND cl.imp_id=bwl.imp_id)),0) clicks,
          COALESCE(SUM((SELECT 1 FROM conv_log cl WHERE cl.type='conversion' AND cl.imp_id=bwl.imp_id)),0) conv,
          COALESCE(SUM(price_micros),0) spend
        FROM bid_win_log bwl GROUP BY campaign_id
      ) w ON w.campaign_id=c.id` + where, wp);
    res.json(rows.map(r => {
      const cpa = r.conversions ? (r.spend_micros / 1e6) / r.conversions : null;
      return { id: r.id, name: r.name, advertiser: r.advertiser, status: r.status,
        impressions: Number(r.impressions), clicks: Number(r.clicks), conversions: Number(r.conversions),
        spend_cny: +(r.spend_micros / 1e6).toFixed(2),
        cpa_cny: cpa ? +cpa.toFixed(2) : null,
        suggestion: cpa && r.budget_micros ? (cpa > (r.budget_micros / 1e6) ? 'CPA 超预算，建议提底价/收窄定向' : '健康') : '样本不足' };
    }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== ⑤ 业务告警 + SLO（异常/作弊/业务风险预警；SLO 可断言）=====
app.get('/api/console/alerts', security.requireAuth('admin'), async (req, res) => {
  try { const [rows] = await pool.query('SELECT id,level,kind,msg,metric,created_at FROM alerts ORDER BY id DESC LIMIT 100'); res.json(rows); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/console/slo', security.requireAuth('admin'), async (req, res) => {
  try {
    const [fr] = await pool.query('SELECT COUNT(*) c FROM bid_req_log WHERE created_at > NOW()-INTERVAL 5 MINUTE');
    const [fw] = await pool.query('SELECT COUNT(*) c FROM bid_win_log WHERE created_at > NOW()-INTERVAL 5 MINUTE');
    const fill = fr[0].c > 0 ? fw[0].c / fr[0].c : 1;
    const m = metrics.snapshot();
    const bid = (m.hist && m.hist.bid) ? m.hist.bid : null;
    const bidP99 = bid ? bid.p99 : null;
    const breaches = [];
    if (fill < 0.05 && fr[0].c > 20) breaches.push('fill_rate');
    if (bidP99 != null && bidP99 > 10) breaches.push('bid_p99');   // 竞价 p99 SLO 真正参与断言
    res.json({
      targets: { bid_p99_ms: 10, fill_rate_min: 0.05, error_rate_max: 0.01 },
      current: { fill_rate_5m: +fill.toFixed(4), bid_req_5m: Number(fr[0].c),
        bid_p99_ms: bidP99, bid_n: bid ? bid.n : 0,
        throttled_5m: (m.counters && m.counters.throttled) || 0 },
      status: breaches.length ? 'breached' : 'ok',
      breaches
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// 运营：手动触发一次测试告警，验证飞书/企微/Slack 推送链路（pushAlertWebhook 自动识别格式）
app.post('/api/admin/alert-test', security.requireAuth('admin'), async (req, res) => {
  try {
    await pushAlertWebhook({ level: 'info', kind: 'test', msg: '这是一条测试告警（验证飞书机器人推送链路是否正常）' });
    res.json({ ok: true, webhook_configured: !!process.env.ALERT_WEBHOOK });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// 业务告警外发（可选）：设置 ALERT_WEBHOOK 后，触发告警同时推送到企业微信/飞书/Slack，
// 否则仅落库 alerts 表（控制台可见）。异常静默不阻塞主流程。
async function pushAlertWebhook(payload) {
  const url = process.env.ALERT_WEBHOOK;
  if (!url) return;
  try {
    // 默认发原始 JSON（Slack 等自行适配）；飞书/企微识别域名后改为各自文本机器人格式
    let body = JSON.stringify(payload), target = url;
    const text = `[ADX 告警] ${payload.level || ''}/${payload.kind || ''}\n${payload.msg || ''}` +
      (payload.metric ? '\n' + JSON.stringify(payload.metric) : '');
    if (/feishu|larksuite/i.test(url)) {                       // 飞书 / 飞书国际版(larksuite.com)
      body = JSON.stringify({ msg_type: 'text', content: { text } });
      const secret = process.env.ALERT_WEBHOOK_SECRET;        // 机器人开启"签名校验"时必填
      if (secret) {
        const ts = Math.floor(Date.now() / 1000);
        const sign = require('crypto').createHmac('sha256', secret).update(ts + '\n' + secret).digest('base64');
        const sep = url.includes('?') ? '&' : '?';
        target = `${url}${sep}timestamp=${ts}&sign=${encodeURIComponent(sign)}`;
      }
    } else if (/qyapi\.weixin/i.test(url)) {                  // 企业微信机器人
      body = JSON.stringify({ msgtype: 'text', content: { content: text } });
    }
    await fetch(target, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(3000) });
  } catch (e) {}
}
// 业务告警巡检：每分钟聚合关键指标，超阈值写 alerts 表（只读，异常不阻塞主流程）
async function checkAlerts() {
  try {
    const [fr] = await pool.query('SELECT COUNT(*) c FROM bid_req_log WHERE created_at > NOW()-INTERVAL 1 MINUTE');
    const [fw] = await pool.query('SELECT COUNT(*) c FROM bid_win_log WHERE created_at > NOW()-INTERVAL 1 MINUTE');
    const fill = fr[0].c > 0 ? fw[0].c / fr[0].c : 1;
    if (fill < 0.05 && fr[0].c > 20) {
      const msg = '填充率骤降 ' + (fill * 100).toFixed(1) + '%';
      const metric = { fill: +fill.toFixed(4), req: Number(fr[0].c) };
      await pool.query("INSERT INTO alerts (level,kind,msg,metric) VALUES ('warn','fill_rate',?,?)", [msg, JSON.stringify(metric)]).catch(() => {});
      pushAlertWebhook({ level: 'warn', kind: 'fill_rate', msg, metric });
    }
    const [cl] = await pool.query("SELECT COUNT(*) c FROM conv_log WHERE type='click' AND created_at > NOW()-INTERVAL 1 MINUTE");
    const [cv] = await pool.query("SELECT COUNT(*) c FROM conv_log WHERE type='conversion' AND created_at > NOW()-INTERVAL 1 MINUTE");
    const cvr = cl[0].c > 0 ? cv[0].c / cl[0].c : 0;
    if (cvr > 0.9 && cl[0].c > 20) {
      const msg = '转化率异常偏高(疑似刷量) ' + (cvr * 100).toFixed(1) + '%';
      const metric = { cvr: +cvr.toFixed(4), clicks: Number(cl[0].c) };
      await pool.query("INSERT INTO alerts (level,kind,msg,metric) VALUES ('warn','cvr_spike',?,?)", [msg, JSON.stringify(metric)]).catch(() => {});
      pushAlertWebhook({ level: 'warn', kind: 'cvr_spike', msg, metric });
    }
    // 广告主预算异常消耗：近 5 分钟消耗 > 前 5 分钟的 3 倍（突增），或单广告主近 5 分钟突发 > ¥500
    const [prevB] = await pool.query("SELECT advertiser, SUM(charge_micros) s FROM adv_ledger WHERE created_at BETWEEN NOW()-INTERVAL 10 MINUTE AND NOW()-INTERVAL 5 MINUTE GROUP BY advertiser");
    const [currB] = await pool.query("SELECT advertiser, SUM(charge_micros) s FROM adv_ledger WHERE created_at > NOW()-INTERVAL 5 MINUTE GROUP BY advertiser");
    const prevMap = new Map(prevB.map(r => [r.advertiser, Number(r.s)]));
    for (const r of currB) {
      const c = Number(r.s), p = prevMap.get(r.advertiser) || 0;
      if ((p > 0 && c > p * 3) || c > 500_000_000) {
        const msg = '广告主预算异常消耗 ' + r.advertiser + '：近5分钟 ¥' + (c / 1e6).toFixed(0) + (p > 0 ? ('（前5分钟 ¥' + (p / 1e6).toFixed(0) + '）') : '');
        const metric = { advertiser: r.advertiser, spend_5m_micros: c, prev_5m_micros: p };
        await pool.query("INSERT INTO alerts (level,kind,msg,metric) VALUES ('warn','budget_anomaly',?,?)", [msg, JSON.stringify(metric)]).catch(() => {});
        pushAlertWebhook({ level: 'warn', kind: 'budget_anomaly', msg, metric });
      }
    }
    // 开发者虚假曝光：单媒体近 1 分钟胜出数异常高（>2000）且填充率≈完美（>0.95），疑似刷量/虚假曝光
    const [impRows] = await pool.query("SELECT publisher, COUNT(*) c FROM bid_win_log WHERE created_at > NOW()-INTERVAL 1 MINUTE GROUP BY publisher HAVING c > 2000");
    for (const r of impRows) {
      const [fr] = await pool.query('SELECT COUNT(*) c FROM bid_req_log WHERE publisher=? AND created_at > NOW()-INTERVAL 1 MINUTE', [r.publisher]);
      const fill = fr[0].c > 0 ? r.c / fr[0].c : 1;
      if (fill > 0.95) {
        const msg = '开发者虚假曝光嫌疑 ' + r.publisher + '：近1分钟胜出 ' + r.c + ' 填充率 ' + (fill * 100).toFixed(1) + '%';
        const metric = { publisher: r.publisher, wins_1m: Number(r.c), fill: +fill.toFixed(3) };
        await pool.query("INSERT INTO alerts (level,kind,msg,metric) VALUES ('warn','fake_impression',?,?)", [msg, JSON.stringify(metric)]).catch(() => {});
        pushAlertWebhook({ level: 'warn', kind: 'fake_impression', msg, metric });
      }
    }
  } catch (e) {}
}
// 多 worker 部署时，仅 leader(worker 0) 跑巡检，避免重复写库/重复外发；单进程部署照常运行
const _runScheduler = process.env.MODE !== 'worker' || process.env.WORKER_INDEX === '0';
if (_runScheduler) setInterval(checkAlerts, 60000).unref();

// ===== ⑥ 每日对账自动出账（Point 6）=====
const RECON_DIR = path.join(__dirname, 'reports');
try { fs.mkdirSync(RECON_DIR, { recursive: true }); } catch (e) {}
// 应收(adv_ledger) vs 已投放(bid_win_log) 按计划聚合，diff≠0 即账实不符
async function buildReconciliation(dateStr) {
  const [ledger] = await pool.query('SELECT campaign_id, COUNT(*) n, SUM(charge_micros) charged FROM adv_ledger WHERE DATE(created_at)=? GROUP BY campaign_id', [dateStr]);
  const [wins] = await pool.query("SELECT campaign_id, COUNT(*) n, SUM(price_micros) served FROM bid_win_log WHERE DATE(created_at)=? AND COALESCE(billable,1)=1 GROUP BY campaign_id", [dateStr]);
  const wMap = new Map(wins.map(w => [Number(w.campaign_id), w]));
  const rows = []; let totalServed = 0, totalCharged = 0;
  const allIds = new Set([...ledger.map(l => Number(l.campaign_id)), ...wins.map(w => Number(w.campaign_id))]);
  for (const id of allIds) {
    const l = ledger.find(x => Number(x.campaign_id) === id);
    const w = wMap.get(id);
    const served = w ? Number(w.served) : 0, charged = l ? Number(l.charged) : 0;
    totalServed += served; totalCharged += charged;
    rows.push({ campaign_id: id, win_n: w ? Number(w.n) : 0, ledger_n: l ? Number(l.n) : 0, served_micros: served, charged_micros: charged, diff_micros: charged - served });
  }
  return { rows, totalServed, totalCharged, totalDiff: totalCharged - totalServed };
}
function reconToCsv(dateStr, data) {
  const head = 'date,campaign_id,win_n,ledger_n,served_micros,charged_micros,diff_micros,served_cny,charged_cny,diff_cny\n';
  const body = data.rows.map(r => [dateStr, r.campaign_id, r.win_n, r.ledger_n, r.served_micros, r.charged_micros, r.diff_micros,
    (r.served_micros / 1e6).toFixed(2), (r.charged_micros / 1e6).toFixed(2), (r.diff_micros / 1e6).toFixed(2)].join(',')).join('\n');
  return head + body + '\n';
}
// 邮件：优先 nodemailer（需安装 + SMTP_* 环境变量）；未配置则仅落盘 CSV 并在控制台提示
async function emailReconCsv(dateStr, csv) {
  let nodemailer; try { nodemailer = require('nodemailer'); } catch { nodemailer = null; }
  const host = process.env.SMTP_HOST, user = process.env.SMTP_USER, pass = process.env.SMTP_PASS, to = process.env.OPS_EMAIL;
  if (!nodemailer || !host || !to) { console.log('[recon] 未配置 SMTP，跳过邮件；CSV 已落盘'); return false; }
  try {
    const t = nodemailer.createTransport({ host, port: Number(process.env.SMTP_PORT || 465), secure: true, auth: { user, pass } });
    await t.sendMail({ from: user, to, subject: '[ADX 每日对账] ' + dateStr, text: '附件为 ' + dateStr + ' 对账明细 CSV。', attachments: [{ filename: 'recon-' + dateStr + '.csv', content: csv }] });
    return true;
  } catch (e) { console.error('[recon] 邮件发送失败', e.message); return false; }
}
async function runDailyReconciliation() {
  const d = new Date(Date.now() - 86400000); const ds = d.toISOString().slice(0, 10);
  try {
    const data = await buildReconciliation(ds);
    const csv = reconToCsv(ds, data);
    const fp = path.join(RECON_DIR, 'recon-' + ds + '.csv');
    fs.writeFileSync(fp, csv);
    const emailed = await emailReconCsv(ds, csv);
    await pool.query('INSERT INTO reconciliation_runs (run_date,rows,total_served_micros,total_charged_micros,total_diff_micros,csv_path,emailed) VALUES (?,?,?,?,?,?,?)',
      [ds, data.rows.length, data.totalServed, data.totalCharged, data.totalDiff, fp, emailed ? 1 : 0]).catch(() => {});
    console.log('[recon] ' + ds + ' 完成 rows=' + data.rows.length + ' diff=' + (data.totalDiff / 1e6).toFixed(2) + ' email=' + emailed);
  } catch (e) { console.error('[recon] 失败', e.message); }
}
// 手动触发 / 后台下载 CSV
app.get('/api/reports/reconciliation/csv', security.requireAuth('admin'), async (req, res) => {
  try {
    const ds = String(req.query.date || new Date(Date.now() - 86400000).toISOString().slice(0, 10));
    const data = await buildReconciliation(ds);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="recon-' + ds + '.csv"');
    res.send(reconToCsv(ds, data));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// 每日 02:10 跑对账（仅 leader worker）；到点后转长期 24h 定时器
if (_runScheduler) {
  const ms = (function () { const now = new Date(), next = new Date(now); next.setHours(2, 10, 0, 0); if (next <= now) next.setDate(next.getDate() + 1); return next - now; })();
  setTimeout(function () { runDailyReconciliation().catch(() => {}); setInterval(runDailyReconciliation, 86400000).unref(); }, ms).unref();
}

// ===== ⑦ 合同 / 协议电子签模板（广告主服务协议 + 开发者分成协议 + 发票）=====
app.get('/api/admin/contract-templates', security.requireAuth('admin'), async (req, res) => {
  try { const [r] = await pool.query('SELECT * FROM contract_templates ORDER BY id DESC'); res.json(r); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/contract-templates', security.requireAuth('admin'), async (req, res) => {
  const b = req.body || {}; if (!b.title || !b.content) return res.status(400).json({ error: 'title,content required' });
  try {
    const [r] = await pool.query('INSERT INTO contract_templates (type,title,content,variables) VALUES (?,?,?,?)',
      [b.type || 'advertiser_service', b.title, b.content, JSON.stringify(b.variables || [])]);
    res.json({ ok: true, id: r.insertId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/admin/contract-templates/:id', security.requireAuth('admin'), async (req, res) => {
  try { await pool.query('DELETE FROM contract_templates WHERE id=?', [+req.params.id]); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
// 由模板生成合同（填变量），状态置为待签署
app.post('/api/contracts', security.requireAuth('admin', 'advertiser', 'publisher'), async (req, res) => {
  const b = req.body || {}; const tplId = +b.template_id; if (!tplId) return res.status(400).json({ error: 'template_id required' });
  try {
    const [[tpl]] = await pool.query('SELECT * FROM contract_templates WHERE id=?', [tplId]);
    if (!tpl) return res.status(404).json({ error: 'template not found' });
    const scope = req.account.t, scopeId = req.account.s, vars = b.variables || {};
    let rendered = tpl.content;
    Object.keys(vars).forEach(k => { rendered = rendered.split('{{' + k + '}}').join(vars[k]); });
    const [r] = await pool.query('INSERT INTO contracts (scope,scope_id,type,template_id,title,rendered,status) VALUES (?,?,?,?,?,?,?)',
      [scope, scopeId, tpl.type, tpl.id, tpl.title, rendered, 'sent']);
    res.json({ ok: true, id: r.insertId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/contracts', security.requireAuth('admin', 'advertiser', 'publisher'), async (req, res) => {
  try {
    const [r] = req.account.t === 'admin'
      ? await pool.query('SELECT * FROM contracts ORDER BY id DESC LIMIT 200')
      : await pool.query('SELECT * FROM contracts WHERE scope=? AND scope_id=? ORDER BY id DESC', [req.account.t, req.account.s]);
    res.json(r);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/contracts/:id', security.requireAuth('admin', 'advertiser', 'publisher'), async (req, res) => {
  try { const [[c]] = await pool.query('SELECT * FROM contracts WHERE id=?', [+req.params.id]); if (!c) return res.status(404).json({ error: 'not found' }); res.json(c); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
// 电子签：记录签署人与 HMAC 签名（内容 + 签署人 + 时间 可验真），状态置为 signed
app.post('/api/contracts/:id/sign', security.requireAuth('admin', 'advertiser', 'publisher'), async (req, res) => {
  const b = req.body || {}; const id = +req.params.id;
  try {
    const [[c]] = await pool.query('SELECT * FROM contracts WHERE id=?', [id]); if (!c) return res.status(404).json({ error: 'not found' });
    if (c.status === 'signed') return res.status(400).json({ error: '已签署' });
    const name = String(b.signer_name || req.account.s || '').trim();
    const email = String(b.signer_email || '').trim();
    const sig = crypto.createHmac('sha256', process.env.CONTRACT_SECRET || 'applink-contract-secret').update(id + '|' + name + '|' + email + '|' + c.rendered).digest('hex');
    await pool.query("UPDATE contracts SET status='signed', signer_name=?, signer_email=?, signature=?, signed_at=NOW() WHERE id=?", [name, email, sig, id]);
    await security.logAudit(req, 'contract:sign', 'contract#' + id, name);
    res.json({ ok: true, signature: sig });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== ⑧ 运营工单系统（简化版：分类 + 流转 + 关闭 + 回复）=====
app.post('/api/tickets', security.requireAuth('admin', 'advertiser', 'publisher'), async (req, res) => {
  const b = req.body || {}; if (!b.subject) return res.status(400).json({ error: 'subject required' });
  try {
    const [r] = await pool.query('INSERT INTO tickets (scope,scope_id,category,priority,subject,body,created_by) VALUES (?,?,?,?,?,?,?)',
      [req.account.t, req.account.s, b.category || 'other', b.priority || 'normal', b.subject, b.body || '', req.account.s]);
    res.json({ ok: true, id: r.insertId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/tickets', security.requireAuth('admin', 'advertiser', 'publisher'), async (req, res) => {
  try {
    const [r] = req.account.t === 'admin'
      ? await pool.query('SELECT * FROM tickets ORDER BY updated_at DESC LIMIT 300')
      : await pool.query('SELECT * FROM tickets WHERE scope=? AND scope_id=? ORDER BY updated_at DESC', [req.account.t, req.account.s]);
    res.json(r);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/tickets/:id', security.requireAuth('admin'), async (req, res) => {
  const id = +req.params.id; const b = req.body || {};
  try {
    const set = []; const v = [];
    ['status', 'assignee', 'priority', 'category'].forEach(f => { if (b[f] !== undefined) { set.push(f + '=?'); v.push(b[f]); } });
    if (b.body !== undefined) { set.push('body=?'); v.push(b.body); }
    if (!set.length) return res.json({ ok: true });
    v.push(id);
    await pool.query('UPDATE tickets SET ' + set.join(',') + ' WHERE id=?', v);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/tickets/:id/reply', security.requireAuth('admin', 'advertiser', 'publisher'), async (req, res) => {
  const id = +req.params.id; const msg = String((req.body || {}).message || '').trim(); if (!msg) return res.status(400).json({ error: 'message required' });
  try {
    await pool.query('INSERT INTO ticket_replies (ticket_id,sender,message) VALUES (?,?,?)', [id, req.account.s, msg]);
    await pool.query('UPDATE tickets SET status=?, updated_at=NOW() WHERE id=?', ['pending', id]).catch(() => {});
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/tickets/:id/replies', security.requireAuth('admin', 'advertiser', 'publisher'), async (req, res) => {
  try { const [r] = await pool.query('SELECT * FROM ticket_replies WHERE ticket_id=? ORDER BY id ASC', [+req.params.id]); res.json(r); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== ② 广告主余额 / 充值（对标 Mintegral「获取账户余额」）=====
app.get('/api/advertiser/balance', security.requireAuth('admin', 'advertiser'), async (req, res) => {
  try {
    const adv = (req.account.t === 'advertiser') ? req.account.s : String(req.query.advertiser || '').trim();
    if (!adv) return res.status(400).json({ error: 'advertiser 必填' });
    const [[b]] = await pool.query('SELECT balance_micros FROM adv_balance WHERE advertiser=?', [adv]);
    const [logs] = await pool.query('SELECT amount_micros,operator,note,created_at FROM adv_recharge WHERE advertiser=? ORDER BY id DESC LIMIT 20', [adv]);
    res.json({ advertiser: adv, balance_cny: ((b && Number(b.balance_micros)) || 0) / 1e6,
      recharges: logs.map(x => ({ amount_cny: Number(x.amount_micros) / 1e6, operator: x.operator, note: x.note, created_at: x.created_at })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/advertiser/recharge', security.requireAuth('admin'), async (req, res) => {
  const b = req.body || {};
  const adv = (req.account.t === 'advertiser') ? req.account.s : String(b.advertiser || '').trim();
  const amountCny = Number(b.amount_cny) || 0;
  const note = String(b.note || '').trim();
  const micros = Math.round(amountCny * 1e6);
  if (!adv) return res.status(400).json({ error: 'advertiser 必填' });
  if (micros <= 0 || amountCny > 1e6) return res.status(400).json({ error: 'amount_cny 必须在 (0, 1000000] 范围内' });
  if (!note) return res.status(400).json({ error: '请填写线下到账凭证号或核验备注' });
  try {
    await pool.query('INSERT INTO adv_balance (advertiser,balance_micros) VALUES (?,?) ON DUPLICATE KEY UPDATE balance_micros=balance_micros+VALUES(balance_micros)', [adv, micros]);
    await pool.query('INSERT INTO adv_recharge (advertiser,amount_micros,operator,note) VALUES (?,?,?,?)', [adv, micros, req.account.u || '', note.slice(0, 200)]);
    const [[row]] = await pool.query('SELECT balance_micros FROM adv_balance WHERE advertiser=?', [adv]);
    await security.logAudit(req, 'advertiser:recharge', adv, 'amount_cny=' + (micros / 1e6));
    res.json({ ok: true, advertiser: adv, balance_cny: Number(row.balance_micros) / 1e6 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── 充值申请单（补上广告主流程第②步「充值」：此前只能线下口头申请，线上按钮不发请求）──
// 广告主在线提交申请 → 运营核验到账 → 批准时真正入账并写充值流水。
app.post('/api/advertiser/recharge-request', security.requireAuth('advertiser'), async (req, res) => {
  const b = req.body || {};
  const adv = req.account.s;
  const amountCny = Number(b.amount_cny) || 0;
  const note = String(b.note || '').trim();
  if (!(amountCny > 0) || amountCny > 1000000) return res.status(400).json({ error: 'amount_cny 必须在 (0, 1000000] 范围内' });
  try {
    const [r] = await pool.query('INSERT INTO adv_recharge_request (advertiser,amount_cny,note,status) VALUES (?,?,?,"pending")',
      [adv, amountCny, note.slice(0, 200)]);
    await security.logAudit(req, 'advertiser:recharge_request', adv, 'amount_cny=' + amountCny);
    res.json({ ok: true, id: r.insertId, advertiser: adv, amount_cny: amountCny, status: 'pending' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/advertiser/recharge-requests', security.requireAuth('admin', 'advertiser'), async (req, res) => {
  try {
    const isAdv = req.account.t === 'advertiser';
    const [rows] = await pool.query(
      isAdv ? 'SELECT * FROM adv_recharge_request WHERE advertiser=? ORDER BY id DESC LIMIT 50'
            : 'SELECT * FROM adv_recharge_request ORDER BY id DESC LIMIT 200',
      isAdv ? [req.account.s] : []);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// 运营处理：approve=核验到账并入账；reject=驳回（必须填原因，广告主可见）
app.post('/api/admin/recharge-requests/:id/handle', security.requireAuth('admin'), async (req, res) => {
  const id = +req.params.id; const b = req.body || {};
  const action = String(b.action || '') === 'reject' ? 'rejected' : 'approved';
  const handleNote = String(b.note || '').trim();
  if (action === 'rejected' && !handleNote) return res.status(400).json({ error: '驳回必须填写原因' });
  try {
    const [[r]] = await pool.query('SELECT id,advertiser,amount_cny,status FROM adv_recharge_request WHERE id=?', [id]);
    if (!r) return res.status(404).json({ error: 'request not found' });
    if (r.status !== 'pending') return res.status(400).json({ error: '该申请已处理（' + r.status + '），不可重复处理' });
    if (action === 'approved') {
      const micros = Math.round(Number(r.amount_cny) * 1e6);
      await pool.query('INSERT INTO adv_balance (advertiser,balance_micros) VALUES (?,?) ON DUPLICATE KEY UPDATE balance_micros=balance_micros+VALUES(balance_micros)', [r.advertiser, micros]);
      await pool.query('INSERT INTO adv_recharge (advertiser,amount_micros,operator,note) VALUES (?,?,?,?)', [r.advertiser, micros, req.account.u || '', ('充值申请#' + id + ' 批准入账').slice(0, 200)]);
    }
    await pool.query('UPDATE adv_recharge_request SET status=?, handler=?, handle_note=?, handled_at=NOW() WHERE id=?',
      [action, req.account.u || '', handleNote.slice(0, 200), id]);
    await security.logAudit(req, 'admin:recharge_' + action, r.advertiser, 'req#' + id + ' amount_cny=' + r.amount_cny);
    res.json({ ok: true, id, status: action });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== ③ 媒体收款信息（对标 AppLovin Payments）=====
// 媒体自服务鉴权：①账户令牌(Bearer/Cookie, role=admin|publisher) ②X-Api-Key（SDK 用 api_key 标识本媒体）
// 让 docs 中"SDK 用 api_key"成为真实可用的鉴权方式，而非哑密钥
async function publisherOrApiKey(req, res, next) {
  const acc = security.accountFromReq(req);
  if (acc && (acc.t === 'admin' || acc.t === 'publisher')) { req.account = acc; return next(); }
  // 兼容旧版静态 ADMIN_TOKEN（requireAuth 原先会走 resolveAdmin，这里补回，避免管理员令牌失效）
  if (security.resolveAdmin(req)) { req.account = { t: 'admin', s: '*', legacy: true }; return next(); }
  const ak = String(req.headers['x-api-key'] || req.query.api_key || '').trim();
  if (!ak) return res.status(401).json({ error: 'unauthorized', hint: '请登录媒体账号或携带 X-Api-Key' });
  try {
    // mysql2/promise 的 query 返回 [rows, fields]，必须解构取 rows
    const [rows] = await pool.query('SELECT domain FROM publishers WHERE api_key=?', [ak]);
    if (rows && rows[0]) { req.account = { t: 'publisher', s: rows[0].domain, viaApiKey: true }; return next(); }
    return res.status(401).json({ error: 'invalid api_key' });
  } catch (e) { return res.status(500).json({ error: 'server error' }); }
}
app.get('/api/publisher/payment', publisherOrApiKey, async (req, res) => {
  try {
    const dom = (req.account.t === 'publisher') ? req.account.s : String(req.query.domain || '').trim();
    if (!dom) return res.status(400).json({ error: 'domain 必填' });
    const [[p]] = await pool.query('SELECT domain,name,payee_name,payee_type,payee_account,invoice_title,tax_no,tax_form_type,tax_form_url,currency,bank_name,swift_iban FROM publishers WHERE domain=?', [dom]);
    if (!p) return res.status(404).json({ error: 'publisher not found' });
    res.json(p);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
async function upsertPublisherPayment(req, res) {
  const b = req.body || {};
  const dom = (req.account.t === 'publisher') ? req.account.s : String(b.domain || '').trim();
  if (!dom) return res.status(400).json({ error: 'domain 必填' });
  try {
    if (req.account.t === 'publisher' && dom !== req.account.s) return res.status(403).json({ error: '无权修改他人收款信息' });
    await pool.query('UPDATE publishers SET payee_name=?,payee_type=?,payee_account=?,invoice_title=?,tax_no=?,tax_form_type=?,tax_form_url=?,currency=?,bank_name=?,swift_iban=? WHERE domain=?',
      [String(b.payee_name || '').trim(), String(b.payee_type || '').trim(), String(b.payee_account || '').trim(),
       String(b.invoice_title || '').trim(), String(b.tax_no || '').trim(),
       String(b.tax_form_type || '').trim().slice(0, 32), String(b.tax_form_url || '').trim().slice(0, 512),
       String(b.currency || 'CNY').trim().toUpperCase().slice(0, 8),
       String(b.bank_name || '').trim().slice(0, 128), String(b.swift_iban || '').trim().slice(0, 64), dom]);
    await security.logAudit(req, 'publisher:payment', dom, '');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
}
app.put('/api/publisher/payment', publisherOrApiKey, upsertPublisherPayment);
app.post('/api/publisher/payment', publisherOrApiKey, upsertPublisherPayment);

// 媒体自服务：查看自己的接入密钥（仅本域；运营支持可带 domain）
app.get('/api/publisher/key', publisherOrApiKey, async (req, res) => {
  try {
    const dom = (req.account.t === 'publisher') ? req.account.s : String(req.query.domain || '').trim();
    if (!dom) return res.status(400).json({ error: 'domain 必填' });
    if (req.account.t === 'publisher' && dom !== req.account.s) return res.status(403).json({ error: '无权查看他人密钥' });
    const [[row]] = await pool.query('SELECT api_key FROM publishers WHERE domain=?', [dom]);
    if (!row) return res.status(404).json({ error: 'publisher not found' });
    res.json({ ok: true, domain: dom, api_key: row.api_key || '' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 媒体自服务：品牌安全创意池（平台已审核通过的创意才可投到你的库存；只读子集，对标 AppLovin Ad Review）
app.get('/api/publisher/creatives', publisherOrApiKey, async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT id,advertiser,campaign_id,format,title,landing_url,creative_status FROM creatives WHERE creative_status='approved' ORDER BY id DESC LIMIT 200");
    res.json(rows || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== ⑤ 集成自检：回答"为什么我的广告位没广告" =====
async function publisherIntegrity(req, res) {
  try {
    const auid = String((req.query && req.query.ad_unit_id) || (req.body && req.body.ad_unit_id) || '').trim();
    const dom = (req.account.t === 'publisher') ? req.account.s : String((req.query && req.query.domain) || (req.body && req.body.domain) || '').trim();
    if (!dom) return res.status(400).json({ error: 'domain required' });
    const checks = [];
    const [[p]] = await pool.query('SELECT domain,name,payout_rate,payee_account FROM publishers WHERE domain=?', [dom]);
    checks.push({ item: '媒体已入驻', ok: !!p, hint: p ? (p.domain + '（分成 ' + p.payout_rate + '）') : '未入驻，请先自助开户取 api_key' });
    checks.push({ item: '收款信息已填写', ok: !!(p && p.payee_account), hint: (p && p.payee_account) ? '已填写' : '未填写 → 有收益也无法结算' });
    if (auid) {
      const [[u]] = await pool.query('SELECT ad_unit_id,name,format,status FROM ad_units WHERE ad_unit_id=? AND publisher=?', [auid, dom]);
      checks.push({ item: '广告单元存在且归属本媒体', ok: !!u, hint: u ? (u.name + '（' + u.format + '）') : 'ad_unit_id 不存在或不属于你' });
      if (u) checks.push({ item: '广告单元已启用', ok: Number(u.status) === 1, hint: Number(u.status) === 1 ? '启用中' : '已暂停 → 不会参拍' });
    } else {
      const [us] = await pool.query('SELECT COUNT(*) n FROM ad_units WHERE publisher=?', [dom]);
      checks.push({ item: '已创建广告单元', ok: Number((us[0] || {}).n) > 0, hint: '共 ' + Number((us[0] || {}).n) + ' 个（指定 ad_unit_id 可精确诊断）' });
    }
    const rqArgs = auid ? [dom, auid] : [dom];
    const [rq] = await pool.query('SELECT COUNT(*) n, MAX(created_at) last FROM bid_req_log WHERE publisher=?' + (auid ? ' AND ad_unit_id=?' : ''), rqArgs);
    const reqN = Number((rq[0] || {}).n) || 0;
    checks.push({ item: '近期收到竞价请求（SDK 已接入）', ok: reqN > 0,
      hint: reqN > 0 ? ('共 ' + reqN + ' 次，最近 ' + (rq[0] || {}).last) : '未收到请求 → 检查页面是否贴了 pub_sdk.js 与 data-ad-unit' });
    const [wn] = await pool.query('SELECT COUNT(*) n, COALESCE(SUM(price_micros),0) gross FROM bid_win_log WHERE publisher=?' + (auid ? ' AND ad_unit_id=?' : ''), rqArgs);
    const winN = Number((wn[0] || {}).n) || 0;
    checks.push({ item: '有胜出（真的填充了广告）', ok: winN > 0,
      hint: winN > 0 ? (winN + ' 次，收入 ' + (Number((wn[0] || {}).gross) / 1e6).toFixed(4) + ' 元')
        : (reqN > 0 ? '有请求但无胜出 → 通常底价过高或该品类暂无匹配需求' : '—') });
    res.json({ domain: dom, ad_unit_id: auid || '', requests: reqN, wins: winN, fill_rate: rate(winN, reqN), checks });
  } catch (e) { res.status(500).json({ error: e.message }); }
}
app.get('/api/publisher/integrity', publisherOrApiKey, publisherIntegrity);
app.post('/api/publisher/integrity', publisherOrApiKey, publisherIntegrity);

// 集成自检「主动触发」：媒体点「加载一支测试广告」时，给自己的域名/广告单元写一条 demo win，
// 让自检的「有胜出」从被动等待变成可主动触发（同时与报表/结算口径统一，都读 bid_win_log）。
app.post('/api/publisher/test-win', publisherOrApiKey, async (req, res) => {
  try {
    const dom = (req.account.t === 'publisher') ? req.account.s : String(req.body.publisher || '').trim();
    if (!dom) return res.status(400).json({ error: 'domain required' });
    const auid = String(req.body.ad_unit_id || '').trim();
    enqueueLog('win', [1, 1, 'test-' + Date.now(), 'test-req-' + Date.now(), 1000000, dom, '', '', auid || '', '', '', 'banner', '', '', '']);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== ⑥ 广告主 API key（对标 Mintegral 广告主取 API key）=====
function newAdvKey() { return 'ak_' + crypto.randomBytes(16).toString('hex'); }
app.get('/api/advertiser/key', security.requireAuth('admin', 'advertiser'), async (req, res) => {
  try {
    const adv = (req.account.t === 'advertiser') ? req.account.s : String(req.query.advertiser || '').trim();
    if (!adv) return res.status(400).json({ error: 'advertiser 必填' });
    const [[a]] = await pool.query("SELECT api_key FROM accounts WHERE type='advertiser' AND scope=?", [adv]);
    res.json({ advertiser: adv, api_key: (a && a.api_key) || '' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/advertiser/key/rotate', security.requireAuth('admin', 'advertiser'), async (req, res) => {
  try {
    const adv = (req.account.t === 'advertiser') ? req.account.s : String((req.body && req.body.advertiser) || '').trim();
    if (!adv) return res.status(400).json({ error: 'advertiser 必填' });
    const k = newAdvKey();
    await pool.query("UPDATE accounts SET api_key=? WHERE type='advertiser' AND scope=?", [k, adv]);
    await security.logAudit(req, 'advertiser:key:rotate', adv, '');
    res.json({ ok: true, api_key: k });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== ⑦ 应用实体（对标 AppLovin「先添加应用」：支持 App bundle，不只 domain）=====
app.post('/api/apps', publisherOrApiKey, async (req, res) => {
  const b = req.body || {};
  const pub = (req.account.t === 'publisher') ? req.account.s : String(b.publisher || '').trim();
  if (!pub) return res.status(400).json({ error: 'publisher(域名) 必填' });
  // 站点型媒体入驻只填了 domain、未填 bundle：回退到域名作为站点标识，避免"入驻只填 domain、建 app 又卡 bundle"
  const bundle = String(b.bundle || '').trim() || pub;
  try {
    const [r] = await pool.query('INSERT INTO apps (publisher,platform,bundle,name,status) VALUES (?,?,?,?,1)',
      [pub, String(b.platform || 'android').toLowerCase(), bundle, String(b.name || '').trim() || bundle]);
    res.json({ ok: true, id: r.insertId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/apps', publisherOrApiKey, async (req, res) => {
  try {
    const rows = (req.account.t === 'publisher')
      ? (await pool.query('SELECT * FROM apps WHERE publisher=? ORDER BY id DESC', [req.account.s]))[0]
      : (await pool.query('SELECT * FROM apps ORDER BY id DESC LIMIT 200'))[0];
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/apps/:id', publisherOrApiKey, async (req, res) => {
  const id = +req.params.id;
  try {
    if (req.account.t === 'publisher') {
      const [[mine]] = await pool.query('SELECT id FROM apps WHERE id=? AND publisher=?', [id, req.account.s]);
      if (!mine) return res.status(403).json({ error: '无权删除他人的应用' });
    }
    await pool.query('DELETE FROM apps WHERE id=?', [id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== ① MMP 归因集成（AppsFlyer / Adjust / Singular / Kochava / Tenjin / Branch / SKAN）=====
// 两个方向：点击时外发 click/impression 给 MMP；MMP 回传转化时由 /api/track/mmp-postback 入账。
// 兼容 adv-account.html 前端字段名：partner（→provider）、app_id、key（→api_key）、skan_source_id、conversion_window_days、skan_bucket。
// postback_url 不再是必填：SKAN/AppsFlyer 场景下用 app_id + api_key 即可，postback_url 可选（S2S 回传由平台侧代理）。
function normMmpConfig(b) {
  const o = Object.assign({}, b);
  if (o.provider == null && o.partner != null) o.provider = String(o.partner).toLowerCase();
  if (o.api_key == null && o.key != null) o.api_key = String(o.key);
  if (o.app_id != null) o.app_id = String(o.app_id).trim().slice(0, 128);
  if (o.api_key != null) o.api_key = String(o.api_key).trim().slice(0, 512);
  if (o.postback_url != null) o.postback_url = String(o.postback_url).trim().slice(0, 512);
  o.skan_source_id = Number(o.skan_source_id) || 1;
  o.conversion_window_days = Number(o.conversion_window_days) || 7;
  o.skan_bucket = Number(o.skan_bucket) || 14;
  return o;
}
app.get('/api/mmp/config', security.requireAuth('admin', 'advertiser'), async (req, res) => {
  try {
    const adv = (req.account.t === 'advertiser') ? req.account.s : String(req.query.advertiser || '').trim();
    if (!adv) return res.status(400).json({ error: 'advertiser 必填' });
    const [rows] = await pool.query('SELECT * FROM mmp_configs WHERE advertiser=? ORDER BY id DESC', [adv]);
    // 前端 adv-account.html 期望单对象；同时兼容数组模式（?all=1 返回全量）
    if (req.query.all === '1') return res.json(rows);
    const r = rows[0] || null;
    if (!r) return res.json(null);
    res.json(Object.assign({}, r, { partner: r.provider || '', key: r.api_key || '' }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/mmp/config', security.requireAuth('admin', 'advertiser'), async (req, res) => {
  const b = normMmpConfig(req.body || {});
  const adv = (req.account.t === 'advertiser') ? req.account.s : String(b.advertiser || '').trim();
  if (!adv) return res.status(400).json({ error: 'advertiser 必填' });
  if (!String(b.provider || b.partner || '').trim() && !String(b.app_id || '').trim() && !String(b.postback_url || '').trim()) {
    return res.status(400).json({ error: '至少需填写 合作方 / App ID / Postback URL 之一' });
  }
  try {
    const provider = String(b.provider || 'appsflyer').toLowerCase();
    const postback_url = String(b.postback_url || '').trim().slice(0, 512);
    // upsert：同 advertiser + provider 只保留一条（SKAN 场景常用）
    const [[exist]] = await pool.query('SELECT id FROM mmp_configs WHERE advertiser=? AND provider=?', [adv, provider]).catch(() => [[]]);
    if (exist) {
      await pool.query('UPDATE mmp_configs SET postback_url=?, app_id=?, api_key=?, skan_source_id=?, conversion_window_days=?, skan_bucket=?, enabled=1 WHERE id=?',
        [postback_url, String(b.app_id || '').trim(), String(b.api_key || '').trim(),
         Number(b.skan_source_id) || 1, Number(b.conversion_window_days) || 7, Number(b.skan_bucket) || 14, exist.id]);
      return res.json({ ok: true, id: exist.id, updated: true });
    }
    const [r] = await pool.query('INSERT INTO mmp_configs (advertiser,provider,postback_url,app_id,api_key,skan_source_id,conversion_window_days,skan_bucket,enabled) VALUES (?,?,?,?,?,?,?,?,?)',
      [adv, provider, postback_url, String(b.app_id || '').trim(), String(b.api_key || '').trim(),
       Number(b.skan_source_id) || 1, Number(b.conversion_window_days) || 7, Number(b.skan_bucket) || 14, 1]);
    res.json({ ok: true, id: r.insertId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/mmp/config/:id', security.requireAuth('admin', 'advertiser'), async (req, res) => {
  const id = +req.params.id; const b = normMmpConfig(req.body || {});
  try {
    const [[row]] = await pool.query('SELECT advertiser FROM mmp_configs WHERE id=?', [id]);
    if (!row) return res.status(404).json({ error: 'not found' });
    if (req.account.t === 'advertiser' && row.advertiser !== req.account.s) return res.status(403).json({ error: '无权修改他人配置' });
    const set = [], val = [];
    if (b.provider != null) { set.push('provider=?'); val.push(String(b.provider).toLowerCase()); }
    if (b.postback_url != null) { set.push('postback_url=?'); val.push(String(b.postback_url).trim().slice(0, 512)); }
    if (b.app_id != null) { set.push('app_id=?'); val.push(String(b.app_id).trim().slice(0, 128)); }
    if (b.api_key != null) { set.push('api_key=?'); val.push(String(b.api_key).trim().slice(0, 512)); }
    if (b.skan_source_id != null) { set.push('skan_source_id=?'); val.push(Number(b.skan_source_id) || 1); }
    if (b.conversion_window_days != null) { set.push('conversion_window_days=?'); val.push(Number(b.conversion_window_days) || 7); }
    if (b.skan_bucket != null) { set.push('skan_bucket=?'); val.push(Number(b.skan_bucket) || 14); }
    if (b.enabled != null) { set.push('enabled=?'); val.push(Number(b.enabled) ? 1 : 0); }
    if (!set.length) return res.status(400).json({ error: '无可更新字段' });
    val.push(id);
    await pool.query('UPDATE mmp_configs SET ' + set.join(',') + ' WHERE id=?', val);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// 前端 adv-account.html「发送测试事件」按钮调用；SKAN 场景是 dry-run（不打真实第三方），AppsFlyer/Adjust 场景实际 POST 到 postback_url。
app.post('/api/mmp/test-event', security.requireAuth('admin', 'advertiser'), async (req, res) => {
  try {
    const adv = (req.account.t === 'advertiser') ? req.account.s : String((req.body || {}).advertiser || '').trim();
    const b = req.body || {};
    const [[cfg]] = await pool.query('SELECT * FROM mmp_configs WHERE advertiser=? AND enabled=1 ORDER BY id DESC LIMIT 1', [adv]).catch(() => [[]]);
    if (!cfg) return res.json({ ok: true, dry_run: true, note: '未配置启用的 MMP，已 dry-run（不会真发）' });
    const payload = { event: String(b.event || 'install'), imp_id: String(b.imp_id || 'test_' + Date.now()), ts: Date.now() };
    if (!cfg.postback_url) {
      return res.json({ ok: true, dry_run: true, provider: cfg.provider, note: '未填 postback_url，仅本地校验通过（SKAN 场景常见）', payload });
    }
    try {
      const r = await fetch(cfg.postback_url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(5000) });
      await pool.query('INSERT INTO mmp_postback_log (provider,advertiser,imp_id,event,url,ok) VALUES (?,?,?,?,?,?)',
        [cfg.provider, adv, payload.imp_id, payload.event, cfg.postback_url, r.ok ? 1 : 0]).catch(() => {});
      return res.json({ ok: true, provider: cfg.provider, status: r.status, dry_run: false, payload });
    } catch (ee) {
      return res.json({ ok: true, provider: cfg.provider, dry_run: true, note: '外发失败已忽略：' + ee.message, payload });
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/mmp/config/:id', security.requireAuth('admin', 'advertiser'), async (req, res) => {
  const id = +req.params.id;
  try {
    const [[row]] = await pool.query('SELECT advertiser FROM mmp_configs WHERE id=?', [id]);
    if (!row) return res.status(404).json({ error: 'not found' });
    if (req.account.t === 'advertiser' && row.advertiser !== req.account.s) return res.status(403).json({ error: '无权删除他人配置' });
    await pool.query('DELETE FROM mmp_configs WHERE id=?', [id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// MMP → 本平台：S2S 转化回传（公开端点；以 bid_win_log 为唯一事实源，无对应曝光直接拒）
app.all('/api/track/mmp-postback', async (req, res) => {
  const q = Object.assign({}, req.query || {}, req.body || {});
  const imp = String(q.impid || q.clickid || q.imp || '').trim();
  if (!imp) return res.status(400).json({ error: 'impid/clickid required' });
  try {
    const [[win]] = await pool.query('SELECT campaign_id, TIMESTAMPDIFF(DAY, created_at, NOW()) AS age_days FROM bid_win_log WHERE imp_id=?', [imp]);
    if (!win) return res.status(404).json({ error: 'unknown impression' });
    // MMP 回传同样受归因窗口与去重规则约束（原先只做 imp 去重、无窗口）
    const mmpCfg = await getAttribCfg(await advertiserOfImp(imp));
    if (Number(win.age_days) > Number(mmpCfg.window_days)) {
      return res.json({ ok: true, dup: false, rejected: 'ATTRIBUTION_WINDOW_EXPIRED', window_days: mmpCfg.window_days, age_days: Number(win.age_days) });
    }
    if (await attribDup(mmpCfg.dedup_rule, imp, 'conversion')) return res.json({ ok: true, dup: true, rule: mmpCfg.dedup_rule });
    await pool.query("INSERT INTO conv_log (type,campaign_id,publisher,imp_id) VALUES ('conversion',?,'',?)", [Number(win.campaign_id) || 0, imp]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== ② Waterfall：需求源排序 + 分国家底价 =====
app.get('/api/waterfall', security.requireAuth('admin'), async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM waterfall_rules ORDER BY scope, country, position, id');
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/waterfall', security.requireAuth('admin'), async (req, res) => {
  const b = req.body || {};
  if (!String(b.demand_source || '').trim()) return res.status(400).json({ error: 'demand_source 必填' });
  try {
    const [r] = await pool.query('INSERT INTO waterfall_rules (scope,ad_unit_id,country,demand_source,position,floor_cny,enabled) VALUES (?,?,?,?,?,?,?)',
      [String(b.scope || '*').trim(), String(b.ad_unit_id || '').trim(), String(b.country || '*').trim(),
       String(b.demand_source).trim(), Number(b.position) || 0, Number(b.floor_cny) || 0, 1]);
    res.json({ ok: true, id: r.insertId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/waterfall/:id', security.requireAuth('admin'), async (req, res) => {
  const id = +req.params.id; const b = req.body || {};
  try {
    const set = [], val = [];
    ['scope', 'ad_unit_id', 'country', 'demand_source'].forEach(k => { if (b[k] != null) { set.push(k + '=?'); val.push(String(b[k]).trim()); } });
    if (b.position != null) { set.push('position=?'); val.push(Number(b.position)); }
    if (b.floor_cny != null) { set.push('floor_cny=?'); val.push(Number(b.floor_cny)); }
    if (b.enabled != null) { set.push('enabled=?'); val.push(Number(b.enabled) ? 1 : 0); }
    if (!set.length) return res.status(400).json({ error: '无可更新字段' });
    val.push(id);
    await pool.query('UPDATE waterfall_rules SET ' + set.join(',') + ' WHERE id=?', val);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/waterfall/:id', security.requireAuth('admin'), async (req, res) => {
  try { await pool.query('DELETE FROM waterfall_rules WHERE id=?', [+req.params.id]); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== ③ A/B 实验（bid_floor / demand_source / ecpm_weight 三组）=====
app.get('/api/ab/experiments', security.requireAuth('admin'), async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM ab_experiments ORDER BY id DESC');
    res.json(rows.map(r => ({ ...r, config: safeJson(r.config) })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/ab/experiments', security.requireAuth('admin'), async (req, res) => {
  const b = req.body || {};
  if (!String(b.name || '').trim()) return res.status(400).json({ error: 'name 必填' });
  if (!['bid_floor', 'demand_source', 'ecpm_weight'].includes(b.kind)) return res.status(400).json({ error: 'kind 必须是 bid_floor / demand_source / ecpm_weight' });
  try {
    const [r] = await pool.query('INSERT INTO ab_experiments (name,kind,config,status) VALUES (?,?,?,?)',
      [String(b.name).trim(), b.kind, JSON.stringify(b.config || {}), 1]);
    res.json({ ok: true, id: r.insertId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/ab/experiments/:id', security.requireAuth('admin'), async (req, res) => {
  const id = +req.params.id; const b = req.body || {};
  try {
    const set = [], val = [];
    if (b.name != null) { set.push('name=?'); val.push(String(b.name).trim()); }
    if (b.config != null) { set.push('config=?'); val.push(JSON.stringify(b.config)); }
    if (b.status != null) { set.push('status=?'); val.push(Number(b.status) ? 1 : 0); }
    if (!set.length) return res.status(400).json({ error: '无可更新字段' });
    val.push(id);
    await pool.query('UPDATE ab_experiments SET ' + set.join(',') + ' WHERE id=?', val);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// 实验结果：按变体汇总曝光 / 胜出 / 收入
app.get('/api/ab/results', security.requireAuth('admin'), async (req, res) => {
  try {
    const [rows] = await pool.query(`SELECT exp_id, variant_key, COUNT(*) exposures,
      COALESCE(SUM(won),0) wins, COALESCE(SUM(price_micros),0)/1e6 revenue_cny
      FROM ab_exposure GROUP BY exp_id, variant_key ORDER BY exp_id, variant_key`);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 真频次(reach/frequency)：基于 bid_win_log.device_id（canonical 设备标识，无原始 PII）聚合
// reach=去重设备数，frequency=人均曝光数；同时给出频次分布（1/2-3/4-5/6+ 次），支撑频次上限决策。
async function reachFrequency({ campaignId, publisher, days = 7 } = {}) {
  if (!pool) return { reach: 0, impressions: 0, frequency: 0, dist: {} };
  const where = []; const params = [];
  if (campaignId) { where.push('campaign_id=?'); params.push(Number(campaignId)); }
  if (publisher) { where.push('publisher=?'); params.push(String(publisher)); }
  if (days > 0) { where.push('created_at >= NOW() - INTERVAL ? DAY'); params.push(Number(days)); }
  const wsql = where.length ? 'WHERE ' + where.join(' AND ') + ' AND device_id<>\'\'' : "WHERE device_id<>''";
  const [[agg]] = await pool.query(
    `SELECT COUNT(*) impressions, COUNT(DISTINCT device_id) reach FROM bid_win_log ${wsql}`, params).catch(() => [[]]);
  const impressions = Number(agg && agg.impressions) || 0;
  const reach = Number(agg && agg.reach) || 0;
  const dist = {};
  if (reach > 0) {
    const [buckets] = await pool.query(
      `SELECT CASE WHEN c<=1 THEN '1' WHEN c<=3 THEN '2-3' WHEN c<=5 THEN '4-5' ELSE '6+' END b,
              COUNT(*) devices FROM (
        SELECT device_id, COUNT(*) c FROM bid_win_log ${wsql} GROUP BY device_id
      ) t GROUP BY b`, params).catch(() => [[]]);
    buckets.forEach(r => { dist[r.b] = Number(r.devices); });
  }
  return { impressions, reach, frequency: reach ? +(impressions / reach).toFixed(3) : 0, dist };
}
app.get('/api/analytics/reach', security.requireAuth('admin', 'advertiser', 'publisher'), async (req, res) => {
  const acc = req.account || {};
  const cid = Number(req.query.campaign_id) || 0;
  const pub = req.query.publisher ? String(req.query.publisher) : (acc.t === 'publisher' ? acc.s : '');
  const days = Math.min(365, Math.max(1, Number(req.query.days) || 7));
  // 广告主只能看自己的计划
  if (acc.t === 'advertiser' && cid) {
    const [[c]] = await pool.query('SELECT advertiser FROM adv_campaign WHERE id=?', [cid]).catch(() => [[]]);
    if (!c || c.advertiser !== acc.s) return res.status(403).json({ error: 'forbidden' });
  }
  try { res.json(await reachFrequency({ campaignId: cid || null, publisher: pub || null, days })); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// 素材自动轮换分配快照：各创意的目标占比 vs 实际占比 + 公平权重，验证"预算/曝光自动均摊"生效
app.get('/api/creative/allocation/:campaignId', security.requireAuth('admin', 'advertiser'), async (req, res) => {
  const cid = Number(req.params.campaignId) || 0;
  const acc = req.account || {};
  try {
    if (acc.t === 'advertiser') {
      const [[c]] = await pool.query('SELECT advertiser FROM adv_campaign WHERE id=?', [cid]).catch(() => [[]]);
      if (!c || c.advertiser !== acc.s) return res.status(403).json({ error: 'forbidden' });
    }
    const list = await creativeAb.variants(cid);
    res.json({ campaign_id: cid, variants: list.length, allocation: creativeAb.allocationOf(list) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== ⑤ 品牌安全黑名单（domain / keyword / bundle）=====
app.get('/api/bs/blacklist', security.requireAuth('admin'), async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM bs_blacklist ORDER BY id DESC');
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/bs/blacklist', security.requireAuth('admin'), async (req, res) => {
  const b = req.body || {};
  if (!['domain', 'keyword', 'bundle'].includes(b.kind)) return res.status(400).json({ error: 'kind 必须是 domain / keyword / bundle' });
  if (!String(b.value || '').trim()) return res.status(400).json({ error: 'value 必填' });
  try {
    const [r] = await pool.query('INSERT INTO bs_blacklist (kind,value,scope,enabled) VALUES (?,?,?,1)',
      [b.kind, String(b.value).trim().slice(0, 190), String(b.scope || '*').trim()]);
    res.json({ ok: true, id: r.insertId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/bs/blacklist/:id', security.requireAuth('admin'), async (req, res) => {
  try { await pool.query('DELETE FROM bs_blacklist WHERE id=?', [+req.params.id]); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
// ── 短链接跳转：/s/ruankao → 落地页（方便在微信/QQ/贴吧/私信里分享短链）──
app.get('/s/ruankao', (req, res) => res.redirect('/landing/ruankao/'));

// ── 二维码分享页：/landing/ruankao/share → 供微信/QQ群截图转发 ──
app.get('/landing/ruankao/share', (req, res) => {
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>扫码领取软考高项冲刺精华</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#060b18;color:#e6edf7;font:15px/1.65 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:40px 20px}
.logo{font-size:12px;letter-spacing:.14em;color:#22d3ee;border:1px solid #1c2942;border-radius:999px;padding:4px 14px;margin-bottom:22px}
h1{font-size:24px;font-weight:700;margin-bottom:6px;text-align:center}
h1 b{background:linear-gradient(92deg,#3b82f6,#22d3ee);-webkit-background-clip:text;background-clip:text;color:transparent}
.sub{font-size:13px;color:#8ea0bd;margin-bottom:28px;text-align:center}
.qr-box{background:#fff;padding:20px;border-radius:16px;margin-bottom:18px;box-shadow:0 8px 40px rgba(0,0,0,.3)}
.qr-box img{display:block;border-radius:6px}
.url-bar{background:#0e1626;border:1px solid #1c2942;border-radius:10px;padding:10px 18px;font-size:13px;color:#22d3ee;margin-bottom:24px;word-break:break-all;text-align:center}
.tips{background:#0e1626;border:1px solid #1c2942;border-radius:14px;padding:16px 20px;font-size:13px;color:#8ea0bd;line-height:2;max-width:420px;text-align:left}
.tips b{color:#e6edf7;display:block;margin-bottom:6px;font-size:14px}
.tips li{list-style:none;padding-left:4px}
.tips li::before{content:"📌 ";font-size:12px}
footer{margin-top:32px;font-size:11px;color:#4d5c78;text-align:center}
</style>
</head>
<body>
<div class="logo">2025 软考高项 · 冲刺精华</div>
<h1>软考高项 <b>冲刺精华</b></h1>
<p class="sub">68 个高频考点 + 12 套真题解析 · 电子版免费领</p>
<div class="qr-box">
  <img src="https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=https://dellai.xyz/landing/ruankao/" width="300" height="300" alt="扫码领取">
</div>
<div class="url-bar">https://dellai.xyz/landing/ruankao/</div>
<div class="tips">
  <b>使用方法</b>
  <li>微信/QQ 扫上方二维码 → 直接进入领取页</li>
  <li>截图保存后转发到微信群/QQ群/朋友圈</li>
  <li>填写姓名 + 手机号 → 获取百度网盘提取码</li>
</div>
<footer>Powered by AppLink · dellai.xyz</footer>
</body>
</html>`;
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

// ===== ⑥ LLM 意图引擎状态（首页要显示真实接入状态，不能嘴上说 LLM 实际是 heuristic）=====
app.get('/api/config/llm', async (req, res) => {
  const hot = String(process.env.LLM_HOT_PATH || '0') !== '0';
  res.json({ llm_enabled: !!llm.ENABLED, provider: llm.ENABLED ? 'configured' : 'none', hot_path: hot,
    note: hot ? 'LLM 已接入竞价热路径' : 'LLM 已配置但未进热路径（默认回落启发式，避免 p99 抖动）' });
});

// ===== 广告单元（Ad Unit）：对标 AppLovin MAX「建 Ad Unit → 拿 ID → 埋 SDK」=====
// 一个角色一条路：开发者在后台登记广告位实体，SDK 用 data-ad-unit 上报，
// 胜出日志记 ad_unit_id，报表即可按广告单元拆收益（否则所有广告位混成一坨）。
// ad_unit_id 是公开标识（同 AppLovin 的广告单元 ID，会明文出现在页面里），非密钥，无需加密随机。
function genAdUnitId() { return 'au_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
app.post('/api/ad-units', publisherOrApiKey, async (req, res) => {
  const b = req.body || {};
  const pub = (req.account.t === 'publisher') ? req.account.s : String(b.publisher || '').trim();
  if (!pub) return res.status(400).json({ error: 'publisher(域名) 必填' });
  const fmt = String(b.format || 'banner').toLowerCase();
  const floor = Number(b.floor_cny);
  const adUnitId = genAdUnitId();
  // ⑤ P1：广告单元强制绑定应用，消灭「归属（不绑定）」的孤儿单元，保证后续按应用归集
  const appId = Number(b.app_id) || 0;
  if (!appId) return res.status(400).json({ error: 'app_id 必填：广告单元必须归属一个应用（先到「应用与版位」创建应用）' });
  try {
    // ④⑦ 频控 / 刷新 / 尺寸一并落库：这些是 SDK 侧执行策略，必须随广告单元一起配置
    // 列数 15，其中 status 为字面量 1 → 占位符应为 14 个（此前写成 16 个，导致 "SQL syntax error near '?)'"）
    await pool.query('INSERT INTO ad_units (ad_unit_id,publisher,app_id,name,format,floor_cny,status,freq_cap,freq_window_hours,refresh_interval,size,network,geo,bid_strategy,waterfall_priority) VALUES (?,?,?,?,?,?,1,?,?,?,?,?,?,?,?)',
      [adUnitId, pub, appId, String(b.name || '').trim() || ('广告单元-' + fmt), fmt, (floor >= 0 ? floor : 1),
       Number(b.freq_cap) || 0, Number(b.freq_window_hours) || 24, Number(b.refresh_interval) || 0, String(b.size || '').slice(0, 16),
       String(b.network || 'bidding').toLowerCase().slice(0, 64), String(b.geo || '').slice(0, 64),
       String(b.bid_strategy || 'bidding').toLowerCase().slice(0, 16), Number(b.waterfall_priority) || 1]);
    res.json({
      ok: true, ad_unit_id: adUnitId, publisher: pub, format: fmt,
      snippet: '<div class="ad-slot" data-ad-unit="' + adUnitId + '" data-format="' + fmt + '" data-floor="' + (floor >= 0 ? floor : 1) + '"></div>\n<script src="' + PUBLIC_BASE + '/pub_sdk.js"></script>'
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/ad-units', publisherOrApiKey, async (req, res) => {
  try {
    const rows = (req.account.t === 'publisher')
      ? (await pool.query('SELECT * FROM ad_units WHERE publisher=? ORDER BY id DESC', [req.account.s]))[0]
      : (await pool.query('SELECT * FROM ad_units ORDER BY id DESC LIMIT 200'))[0];
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/ad-units/:id', publisherOrApiKey, async (req, res) => {
  const id = +req.params.id; const b = req.body || {};
  try {
    if (req.account.t === 'publisher') {
      const [[mine]] = await pool.query('SELECT id FROM ad_units WHERE id=? AND publisher=?', [id, req.account.s]);
      if (!mine) return res.status(403).json({ error: '无权修改他人的广告单元' });
    }
    const set = [], val = [];
    if (b.name != null) { set.push('name=?'); val.push(String(b.name).trim()); }
    if (b.format != null) { set.push('format=?'); val.push(String(b.format).toLowerCase()); }
    if (b.floor_cny != null) { set.push('floor_cny=?'); val.push(Number(b.floor_cny)); }
    if (b.status != null) { set.push('status=?'); val.push(Number(b.status) ? 1 : 0); }
    // ④⑦ 频控 / 刷新 / 尺寸
    if (b.freq_cap != null) { set.push('freq_cap=?'); val.push(Number(b.freq_cap)); }
    if (b.freq_window_hours != null) { set.push('freq_window_hours=?'); val.push(Number(b.freq_window_hours)); }
    if (b.refresh_interval != null) { set.push('refresh_interval=?'); val.push(Number(b.refresh_interval)); }
    if (b.size != null) { set.push('size=?'); val.push(String(b.size).slice(0, 16)); }
    if (b.network != null) { set.push('network=?'); val.push(String(b.network).toLowerCase().slice(0, 64)); }
    if (b.geo != null) { set.push('geo=?'); val.push(String(b.geo).slice(0, 64)); }
    if (b.bid_strategy != null) { set.push('bid_strategy=?'); val.push(String(b.bid_strategy).toLowerCase().slice(0, 16)); }
    if (b.waterfall_priority != null) { set.push('waterfall_priority=?'); val.push(Math.max(1, Number(b.waterfall_priority) || 1)); }
    if (!set.length) return res.status(400).json({ error: '无可更新字段' });
    val.push(id);
    await pool.query('UPDATE ad_units SET ' + set.join(',') + ' WHERE id=?', val);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/ad-units/:id', publisherOrApiKey, async (req, res) => {
  const id = +req.params.id;
  try {
    if (req.account.t === 'publisher') {
      const [[mine]] = await pool.query('SELECT id FROM ad_units WHERE id=? AND publisher=?', [id, req.account.s]);
      if (!mine) return res.status(403).json({ error: '无权删除他人的广告单元' });
    }
    await pool.query('DELETE FROM ad_units WHERE id=?', [id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== P1 隐私与测量：多触点归因 + SKAN 聚合回传 =====
// 多触点归因：给定 impid，返回 曝光→点击→转化 全链路触点，并按指定模型分配功劳
// model: last_touch | first_touch | linear | time_decay | position_based | data_driven | compare
// ===== 归因配置：归因窗口 + 去重规则（可配置）=====
// 原先问题（与业界口径不符）：
//   ① 转化入账完全没有时间校验——一年后的转化照样归因（只有硬编码的衰减半衰期常量）；
//   ② 去重只有 imp 级且不可配；
//   ③ 点击根本不去重（conv_log 无唯一键，INSERT IGNORE 无冲突可忽略）。
// 现在：按广告主可配，回退到全局默认 '*'；窗口外的转化拒绝入账；去重规则可选。
const ATTR_DEFAULT = { window_days: 7, click_window_days: 7, view_window_days: 1, dedup_rule: 'imp' };
let attribCfgCache = { ts: 0, map: {} };
async function ensureAttribCfgTable() {
  await pool.query(`CREATE TABLE IF NOT EXISTS attribution_config (
    advertiser VARCHAR(128) PRIMARY KEY,
    window_days INT DEFAULT 7,
    click_window_days INT DEFAULT 7,
    view_window_days INT DEFAULT 1,
    dedup_rule VARCHAR(16) DEFAULT 'imp',
    updated_at BIGINT DEFAULT 0)`).catch(() => {});
  await pool.query('ALTER TABLE attribution_config ADD COLUMN click_window_days INT DEFAULT 7').catch(() => {});
  await pool.query('ALTER TABLE attribution_config ADD COLUMN view_window_days INT DEFAULT 1').catch(() => {});
}
async function getAttribCfg(adv) {
  const key = String(adv || '*');
  const now = Date.now();
  if (now - attribCfgCache.ts < 60000 && attribCfgCache.map[key]) return attribCfgCache.map[key];
  await ensureAttribCfgTable();
  let row = null;
  if (key !== '*') {
    const [[r1]] = await pool.query('SELECT window_days,click_window_days,view_window_days,dedup_rule FROM attribution_config WHERE advertiser=?', [key]).catch(() => [[]]);
    row = r1 || null;
  }
  if (!row) {
    const [[r2]] = await pool.query("SELECT window_days,click_window_days,view_window_days,dedup_rule FROM attribution_config WHERE advertiser='*'").catch(() => [[]]);
    row = r2 || null;
  }
  const clickWin = (row && Number(row.click_window_days)) || (row && Number(row.window_days)) || ATTR_DEFAULT.window_days;
  const cfg = {
    window_days: clickWin,                 // 兼容旧引用：默认等同点击窗口
    click_window_days: clickWin,
    view_window_days: (row && Number(row.view_window_days)) || ATTR_DEFAULT.view_window_days,
    dedup_rule: (row && row.dedup_rule) || ATTR_DEFAULT.dedup_rule,
    source: row ? 'db' : 'default',
  };
  attribCfgCache.map[key] = cfg; attribCfgCache.ts = now;
  return cfg;
}
/** 去重判定：返回 true 表示「已存在、应丢弃」 */
async function attribDup(rule, imp, type) {
  if (rule === 'none') return false;
  if (rule === 'imp_day') {
    const [[d]] = await pool.query('SELECT 1 FROM conv_log WHERE type=? AND imp_id=? AND created_at >= CURDATE()', [type, imp]).catch(() => [[]]);
    return !!d;
  }
  const [[d]] = await pool.query('SELECT 1 FROM conv_log WHERE type=? AND imp_id=?', [type, imp]).catch(() => [[]]);
  return !!d;
}
/** 取某次曝光所属广告主（用于解析该广告主的归因配置） */
async function advertiserOfImp(imp) {
  try {
    const [[w]] = await pool.query('SELECT campaign_id FROM bid_win_log WHERE imp_id=?', [imp]);
    if (!w || !w.campaign_id) return '';
    const [[c]] = await pool.query('SELECT advertiser FROM adv_campaign WHERE id=?', [w.campaign_id]);
    return (c && c.advertiser) || '';
  } catch (e) { return ''; }
}

app.get('/api/attribution/config', security.requireAuth('admin', 'advertiser'), async (req, res) => {
  const adv = (req.account && req.account.t === 'advertiser') ? req.account.s : '*';
  try { res.json({ advertiser: adv, ...(await getAttribCfg(adv)) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/attribution/config', security.requireAdmin('admin'), async (req, res) => {
  const { advertiser, window_days, click_window_days, view_window_days, dedup_rule, sync_skan } = req.body || {};
  const scope = String(advertiser || '*');
  const rule = String(dedup_rule || 'imp');
  if (['imp', 'imp_day', 'none'].indexOf(rule) < 0) return res.status(400).json({ error: 'dedup_rule 需为 imp / imp_day / none' });
  // 兼容单窗口参数：只给 window_days 时同时作为点击窗口；否则各自校验
  let clickWin = Number(click_window_days || window_days);
  let viewWin = Number(view_window_days);
  if (!click_window_days && !view_window_days && window_days != null) viewWin = Number(window_days) > 1 ? 1 : 1; // 单窗默认 view=1
  clickWin = Number.isFinite(clickWin) && clickWin >= 1 && clickWin <= 90 ? clickWin : ATTR_DEFAULT.click_window_days;
  viewWin = Number.isFinite(viewWin) && viewWin >= 1 && viewWin <= 30 ? viewWin : ATTR_DEFAULT.view_window_days;
  try {
    await ensureAttribCfgTable();
    await pool.query(`INSERT INTO attribution_config (advertiser,window_days,click_window_days,view_window_days,dedup_rule,updated_at) VALUES (?,?,?,?,?,?)
      ON DUPLICATE KEY UPDATE window_days=VALUES(window_days), click_window_days=VALUES(click_window_days),
        view_window_days=VALUES(view_window_days), dedup_rule=VALUES(dedup_rule), updated_at=VALUES(updated_at)`,
      [scope, clickWin, clickWin, viewWin, rule, Date.now()]);
    attribCfgCache = { ts: 0, map: {} };   // 立即失效缓存
    // SKAN 对齐：把该广告主的归因窗口同步成一份可用的 SKAN conversion-value schema，
    // 让 App 侧编码与服务器侧窗口一致（避免历史数据口径错乱）。
    let skan = null;
    if (sync_skan) {
      skan = await attribution.skan.defineSchema(scope, {
        version: '4.0',
        events: [
          { name: 'click', value: 1, coarse: 'low', priority: 10, valueMicros: 0 },
          { name: 'install', value: 8, coarse: 'medium', priority: 40, valueMicros: 0 },
          { name: 'purchase', value: 32, coarse: 'high', priority: 100, valueMicros: 0 },
        ],
        coarseThresholds: { low: 0, medium: 1000000, high: 10000000 },
      });
    }
    res.json({ ok: true, advertiser: scope, window_days: clickWin, click_window_days: clickWin, view_window_days: viewWin, dedup_rule: rule, skan: skan ? 'synced' : null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// SKAN 对齐视图：给定计划，返回与服务器侧归因窗口一致的 SKAN conversion-value schema 建议，
// 让 App 侧编码(0~63 整数)与服务端窗口严格对齐（避免历史数据口径错乱）。SKAN 4 回传窗为固定的 2/7/35 天。
app.get('/api/attribution/skan/:campaignId', security.requireAuth('admin', 'advertiser'), async (req, res) => {
  const cid = Number(req.params.campaignId) || 0;
  try {
    const [[c]] = await pool.query('SELECT advertiser,goal_type,target_roas,target_cpa_micros FROM adv_campaign WHERE id=?', [cid]);
    if (!c) return res.status(404).json({ error: 'campaign not found' });
    const cfg = await getAttribCfg(c.advertiser);
    const SKAN_WINDOWS = [2, 7, 35];
    const skanWindow = SKAN_WINDOWS.reduce((a, b) => Math.abs(b - (cfg.click_window_days || 7)) < Math.abs(a - (cfg.click_window_days || 7)) ? b : a, 7);
    const cpa = Math.round((Number(c.target_cpa_micros) || 0));
    res.json({
      campaign_id: cid, version: '4.0',
      click_window_days: cfg.click_window_days, view_window_days: cfg.view_window_days,
      skan_postback_windows_days: SKAN_WINDOWS, aligned_skan_window_days: skanWindow,
      note: 'SKAN 为聚合+延迟+带噪数据，仅作模型弱信号；本平台确定性归因窗口已对齐到最近的 SKAN 回传窗，App 侧 conversion-value 编码需与下方 events 严格一致',
      events: [
        { name: 'click', value: 1, coarse: 'low', priority: 10, valueMicros: 0 },
        { name: 'install', value: 8, coarse: 'medium', priority: 40, valueMicros: 0 },
        { name: 'purchase', value: 32, coarse: 'high', priority: 100, valueMicros: cpa },
      ],
      coarse_thresholds: { low: 0, medium: 1000000, high: 10000000 },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/attribution', async (req, res) => {
  let imp = String(req.query.impid || '');
  const model = String(req.query.model || 'last_touch');
  // 未指定 impid 时回退到最近一次曝光：此前前端「拉取归因样本」无参调用恒定 400，
  // 用户只会看到报错。留空也能看样例，有曝光即可用。
  if (!imp) {
    const [[last]] = await pool.query('SELECT imp_id FROM bid_win_log ORDER BY id DESC LIMIT 1').catch(() => [[]]);
    imp = last ? String(last.imp_id) : '';
    if (!imp) return res.status(400).json({ error: 'impid required（平台暂无曝光记录，请先跑一次竞价演示）' });
  }
  try {
    const [[win]] = await pool.query('SELECT campaign_id, publisher, price_micros, created_at FROM bid_win_log WHERE imp_id=?', [imp]);
    if (!win) return res.status(404).json({ error: 'no impression' });
    const [clicks] = await pool.query("SELECT id, created_at FROM conv_log WHERE type='click' AND imp_id=?", [imp]);
    const [convs] = await pool.query("SELECT id, amount, created_at FROM conv_log WHERE type='conversion' AND imp_id=?", [imp]);
    // 构造触点链：曝光 + 点击按时间排序，转化时间作为归因基准
    const journey = attribution.multiTouch.buildJourney([
      { imp_id: imp, campaign_id: win.campaign_id, publisher: win.publisher, price_micros: win.price_micros, created_at: win.created_at, type: 'impression' },
      ...clicks.map(c => ({ imp_id: imp, campaign_id: win.campaign_id, publisher: win.publisher, created_at: c.created_at, type: 'click' })),
    ]);
    const convTs = convs.length ? new Date(convs[convs.length - 1].created_at).getTime() : undefined;
    const attr = attribution.multiTouch.attribute(journey, model, {
      convTs, vta: { enabled: req.query.vta !== '0', factor: Number(req.query.vta_factor) || undefined },
    });
    if (model === 'compare') {
      return res.json({ impid: imp, campaign_id: win.campaign_id, publisher: win.publisher,
        impression: { price_micros: win.price_micros, at: win.created_at }, clicks, conversions: convs,
        models: attribution.multiTouch.compare(journey, { convTs }) });
    }
    res.json({ impid: imp, campaign_id: win.campaign_id, publisher: win.publisher,
      impression: { price_micros: win.price_micros, at: win.created_at }, clicks, conversions: convs,
      attribution: attr });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// SKAN conversion schema 管理：事件→conversion value 的编码必须版本化，否则历史数据不可比
app.post('/api/skan/schema', async (req, res) => {
  const b = req.body || {};
  if (!b.campaign_id) return res.status(400).json({ error: 'campaign_id required' });
  try { res.json(await attribution.skan.defineSchema(b.campaign_id, b)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/skan/schema/:cid', async (req, res) => {
  try { res.json((await attribution.skan.getSchema(Number(req.params.cid), String(req.query.version || '4.0'), String(req.query.app_id || ''))) || { none: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/skan/aggregate', async (req, res) => {
  try { res.json(await attribution.skan.aggregate({ campaignId: Number(req.query.campaign_id) || 0, days: Number(req.query.days) || 7 })); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
// SKAN 回传接收：验签（Apple ECDSA P-256）+ 解码 + 多窗口去重
app.post('/api/skan/postback', async (req, res) => {
  const b = req.body || {};
  if (!b.dsp_domain && !b.campaign_id) return res.status(400).json({ error: 'dsp_domain/campaign_id required' });
  try { res.json(await attribution.skan.ingest(b, { campaignId: b.campaign_id, skipVerify: process.env.SKAN_SKIP_VERIFY === '1' })); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== 增量度量：holdout / ghost ads / geo-lift =====
app.post('/api/incrementality/create', async (req, res) => {
  try { res.json(await attribution.incrementality.create(req.body || {})); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/incrementality', async (req, res) => {
  try { res.json(await attribution.incrementality.list()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/incrementality/:id/analyze', async (req, res) => {
  try { res.json(await attribution.incrementality.analyze(Number(req.params.id))); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/incrementality/:id/record', async (req, res) => {
  const b = req.body || {};
  try {
    await attribution.incrementality.record(Number(req.params.id), String(b.unit_id || ''), String(b.bucket || 'treat'), b);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/incrementality/:id/stop', async (req, res) => {
  try { res.json(await attribution.incrementality.stop(Number(req.params.id), String((req.body || {}).status || 'stopped'))); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== 身份解析图谱 =====
app.post('/api/identity/resolve', (req, res) => {
  const b = req.body || {};
  try { res.json(identity.resolve(b.ids || {}, b.signals || {}, b)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/identity/stats', (_, res) => res.json(identity.stats()));
app.get('/api/identity/:canonical/apps', async (req, res) => {
  try { res.json({ canonical_id: req.params.canonical, apps: await identity.apps(req.params.canonical) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== 信任层：ads.txt / app-ads.txt / sellers.json（公网只读，买方采买前必查）=====
app.get('/ads.txt', (_, res) => { res.type('text/plain'); res.send(trust.adsTxtContent()); });
app.get('/app-ads.txt', (_, res) => { res.type('text/plain'); res.send(trust.appAdsTxtContent()); });
app.get('/sellers.json', async (_, res) => { res.json(await trust.sellersJson()); });
app.post('/api/trust/crawl/:domain', async (req, res) => {
  const d = decodeURIComponent(req.params.domain);
  try {
    const a = await trust.crawl(d, 'ads.txt');
    const b = await trust.crawl(d, 'app-ads.txt');
    res.json({ ads_txt: a, app_ads_txt: b, supply_chain: await trust.supplyChainStatus(d) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/trust/status/:domain', async (req, res) => {
  try { res.json(await trust.supplyChainStatus(decodeURIComponent(req.params.domain))); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== Pacing：时段 / 频控 / 预算节奏（已加鉴权：原先无鉴权，任何人可读写任意计划节奏）=====
app.get('/api/pacing/:cid', security.requireAuth('admin', 'advertiser'), async (req, res) => {
  const own = await assertCampaignOwner(req, Number(req.params.cid));
  if (!own.ok) return res.status(own.code).json({ error: own.msg });
  try { res.json(await pacing.delivery(Number(req.params.cid))); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/pacing/:cid', security.requireAuth('admin', 'advertiser'), async (req, res) => {
  const own = await assertCampaignOwner(req, Number(req.params.cid));
  if (!own.ok) return res.status(own.code).json({ error: own.msg });
  try { res.json(await pacing.save(Number(req.params.cid), req.body || {})); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== 计费闭环：账户 / 充值 / 开票 / 收款 / 账龄 =====
app.post('/api/billing/account', async (req, res) => {
  const b = req.body || {};
  if (!b.party) return res.status(400).json({ error: 'party required' });
  try { res.json(await billing.ensureAccount(b.partyType || 'advertiser', b.party, b)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/billing/accounts', async (req, res) => {
  try { res.json(await billing.listAccounts(req.query.partyType || 'advertiser')); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/billing/topup', async (req, res) => {
  const b = req.body || {};
  try { res.json(await billing.topUp(b.partyType || 'advertiser', b.party, b.micros || 0, b.ref || '')); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/billing/invoice', async (req, res) => {
  const b = req.body || {};
  if (!b.party || !b.start || !b.end) return res.status(400).json({ error: 'party,start,end required' });
  try { res.json(await billing.issueInvoice(b.partyType || 'advertiser', b.party, b.start, b.end, b)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/billing/close-period', async (req, res) => {
  const b = req.body || {};
  if (!b.start || !b.end) return res.status(400).json({ error: 'start,end required' });
  try { res.json(await billing.closePeriod(b.start, b.end, b)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/billing/invoices', async (req, res) => {
  try { res.json(await billing.listInvoices({ partyType: req.query.partyType, party: req.query.party, status: req.query.status })); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/billing/invoice/:no', async (req, res) => {
  try {
    const inv = await billing.getInvoice(req.params.no);
    if (!inv) return res.status(404).json({ error: 'not found' });
    res.json(inv);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/billing/pay', async (req, res) => {
  const b = req.body || {};
  try { res.json(await billing.pay(b.invoice_no, b.micros, b.method || 'transfer', b.ref || '')); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/billing/aging', async (_, res) => {
  try { res.json(await billing.aging()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== 品牌安全策略 =====
app.get('/api/brand-safety/:cid', async (req, res) => {
  try { res.json(await brandSafety.policy(Number(req.params.cid))); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/brand-safety/:cid', async (req, res) => {
  try { res.json(await brandSafety.savePolicy(Number(req.params.cid), req.body || {})); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/brand-safety/report', async (_, res) => {
  try { res.json(await brandSafety.report()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/brand-safety/classify', (req, res) => {
  const b = req.body || {};
  try { res.json(brandSafety.classify(b)); } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== 反作弊：统计 / 事件 / 黑名单 / 配置 =====
app.get('/api/anticheat/stats', async (_, res) => {
  try { res.json(await anticheat.stats()); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/anticheat/events', async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const pageSize = parseInt(req.query.pageSize) || 50;
  const filter = {};
  if (req.query.action) filter.action = req.query.action;
  if (req.query.reason) filter.reason = req.query.reason;
  if (req.query.device_id) filter.device_id = req.query.device_id;
  if (req.query.ip) filter.ip = req.query.ip;
  try { res.json(await anticheat.eventList(page, pageSize, filter)); } catch (e) { res.status(500).json({ error: e.message, items: [] }); }
});
app.get('/api/anticheat/blacklist', async (_, res) => {
  try { res.json(await anticheat.blacklistList()); } catch (e) { res.status(500).json({ error: e.message, items: [] }); }
});
app.post('/api/anticheat/blacklist', async (req, res) => {
  const b = req.body || {};
  const createdBy = (req.account && req.account.u) || 'api';
  try { res.json(await anticheat.blacklistAdd(b.kind, b.value, b.reason, b.auto === true, createdBy)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/anticheat/blacklist', async (req, res) => {
  const b = req.body || {};
  try { res.json(await anticheat.blacklistRemove(b.kind, b.value)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/anticheat/config', async (_, res) => {
  try { res.json(await anticheat.getConfig()); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/anticheat/config', async (req, res) => {
  const b = req.body || {};
  try {
    if (b.key) {
      res.json(await anticheat.setConfig(b.key, b.value));
    } else {
      // 批量更新
      const results = {};
      for (const [k, v] of Object.entries(b)) {
        results[k] = (await anticheat.setConfig(k, v)).ok;
      }
      res.json({ ok: true, results });
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== ML 平台：快照 / 校准 / 漂移 / 健康度 / 模型注册 =====
app.get('/api/ml/snapshot', (_, res) => res.json(ml.snapshot()));
app.post('/api/ml/calibrate', async (_, res) => { try { res.json(await ml.refitCalibration()); } catch (e) { res.status(500).json({ error: e.message }); } });
app.get('/api/ml/drift', async (_, res) => { try { res.json(await ml.fs.driftReport()); } catch (e) { res.status(500).json({ error: e.message }); } });
app.get('/api/ml/health', async (_, res) => { try { res.json(await ml.registry.health()); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post('/api/ml/model', async (req, res) => {
  const b = req.body || {};
  try {
    if (b.action === 'promote') return res.json(await ml.registry.promote(b.modelId, b.status, b.trafficPct));
    return res.json(await ml.registry.register(b));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/ml/models', (_, res) => res.json(ml.registry.list()));

// ===== 创意自动化：可玩广告 / 视频 / DCO / 本地化 =====
// 创意自动化 = 广告主投放链路的一环（对标 AppLovin 创意自动化）：管理员或广告主本人可调用。
// 原先整段挂在 ADMIN_PREFIXES 下，广告主点任何按钮都 401 → 需求侧漏斗断点。
app.use('/api/creative-auto', security.requireAuth('admin', 'advertiser'));

app.post('/api/creative-auto/generate', async (req, res) => {
  try { res.json(await creativeAuto.generate(req.body || {})); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/creative-auto/playable', (req, res) => {
  const b = req.body || {};
  try { res.json({ html: creativeAuto.playable.render(b), bytes: creativeAuto.playable.estimateBytes(b) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/creative-auto/video', (req, res) => {
  const b = req.body || {};
  try {
    const sb = creativeAuto.videogen.storyboard(b.images || [], b);
    res.json({ storyboard: sb, html: creativeAuto.videogen.htmlFallback(sb, b.cta), ffmpeg: creativeAuto.videogen.ffmpegCommand(sb, b.out || 'out.mp4') });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/creative-auto/dco', async (req, res) => {
  const b = req.body || {};
  try {
    const tpl = b.template || creativeAuto.dco.DEFAULT_TEMPLATE;
    const pick = await creativeAuto.dco.pick(tpl, b.item || {}, b.ctx || {}, b.stats || []);
    res.json(pick || { none: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/creative-auto/i18n', async (req, res) => {
  const b = req.body || {};
  try {
    if (b.action === 'translate') {
      const r = await creativeAuto.i18n.autoTranslate(b.copy || {}, b.locales || [], null);
      return res.json(r);
    }
    await creativeAuto.i18n.setText(b.scope || {}, b.locale, b.field, b.text, b.source || 'human');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// P2：LLM Creative Agent 是【可选增强】。capabilities 返回 llm_ready（只给布尔值，不泄露 key），
// 前端据此提示"未配置 LLM"，避免用户点了才发现 401/失败。确定性能力（版式派生/可玩/DCO/i18n）无需 LLM。
app.get('/api/creative-auto/capabilities', async (_, res) => {
  const snap = creativeAuto.snapshot();
  let llmReady = false;
  try {
    const cfg = await creativeAuto.getGenConfig();
    llmReady = !!(cfg && (cfg.api_key || cfg.apiKey));
  } catch (e) {}
  res.json(Object.assign({}, snap, { llm_ready: llmReady, deterministic: ['playable', 'videogen', 'dco', 'i18n', 'format_convert'] }));
});

// ===== 真实生成式模型接入：配置 / 文生图 / 图生视频（落在 /api/creative-auto 管理员前缀下）=====
// 生成模型配置是【平台级】配置（含 api_key、模型端点等密钥），只允许管理员读写。
// 【安全修复】此前整段只受 requireAuth('admin','advertiser') 保护 → 任一广告主租户都能读写
// 平台全局生成配置、拿到 api_key。这里再加一层 admin 收口（生成能力本身仍对广告主开放）。
// 生成模型配置为【平台级】基础设施配置（含 api_key、模型端点等），仍限管理员读写。
// 【第一性原理修复】广告主调此接口时，后端返回 403 + 明确错误码（而非裸 401），
// 前端据此区分「会话过期(401)」与「权限不足(403)」，分别给出可读提示。
app.get('/api/creative-auto/gen-config', security.requireAuth('admin'), async (_, res) => {
  try { res.json(await creativeAuto.getGenConfig()); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/creative-auto/gen-config', security.requireAuth('admin'), async (req, res) => {
  try { res.json(await creativeAuto.setGenConfig(req.body || {})); } catch (e) { res.status(500).json({ error: e.message }); }
});
// 广告主调用 gen-config 时返回 403 + 明确提示（而非裸 401）
// 此路由在 requireAuth('admin') 之前注册，专门处理广告主误调用
app.all('/api/creative-auto/gen-config', security.requireAuth('admin', 'advertiser'), async (req, res, next) => {
  // 此路由实际不会到达，因为 requireAuth('admin') 已先匹配
  // 留作 fallback：若广告主到达此，返回 403 明确提示
  if (req.account && req.account.t === 'advertiser') {
    return res.status(403).json({ error: '生成模型配置为管理员专用，请联系平台管理员配置', code: 'FORBIDDEN_ADMIN_ONLY' });
  }
  next();
});
app.post('/api/creative-auto/generate-image', async (req, res) => {
  try {
    const r = await creativeAuto.generateImage(req.body.prompt || '', req.body || {});
    if (!r.ok) return res.status(400).json(r);
    res.json(r);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/creative-auto/generate-video', async (req, res) => {
  try { res.json(await creativeAuto.imageToVideo(req.body.images || [], req.body.prompt || '')); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
// 真实素材文件上传（base64 → public/uploads → 可入库下发）
app.post('/api/creatives/upload', security.requireAuth('admin', 'advertiser'), async (req, res) => {
  try {
    let { data, name, mime } = req.body || {};
    if (data && typeof data === 'string' && data.startsWith('data:')) data = data.split(',')[1] || '';
    if (!data) return res.status(400).json({ error: 'data(base64) required' });
    const dir = path.join(__dirname, 'public', 'uploads');
    fs.mkdirSync(dir, { recursive: true });
    const ext = (mime && mime.split('/')[1]) || (name && name.split('.').pop()) || 'bin';
    const fname = 'upl_' + crypto.randomBytes(6).toString('hex') + '.' + String(ext).replace(/[^a-z0-9]/gi, '');
    fs.writeFileSync(path.join(dir, fname), Buffer.from(data, 'base64'));
    res.json({ ok: true, url: '/uploads/' + fname, filename: fname });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== 竞价工程：胜率分布 / shading / 节流状态 =====
app.get('/api/bid/winrate', (_, res) => res.json(bidEng.winrate.snapshot()));
app.get('/api/bid/throttle', (_, res) => res.json(bidEng.throttle.snapshot()));
app.post('/api/bid/shade', (req, res) => {
  const b = req.body || {};
  try { res.json(bidEng.shade({ valueMicros: b.valueMicros, floorMicros: b.floorMicros || 0, ctx: b.ctx || {}, auctionType: b.auctionType || 1 })); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== 可观测性：分位数指标 + SLO（P0 规模化底座）=====
app.get('/metrics', (_, res) => res.json(Object.assign(cache.snapshot(), metrics.snapshot(), { llm: llm.status() })));
app.get('/metrics/slo', (_, res) => res.json({
  bid_latency: metrics.slo('bid_latency', Number(process.env.BID_P99_TARGET_MS || 10)),
  dsp_latency: metrics.slo('dsp_latency', Number(process.env.DSP_P99_TARGET_MS || 50)),
}));
// 管理员：LLM 端点健康与放白信息（被 Cloudflare 拦截时给出出口 IP，用于在其 Cloudflare 加白名单）
app.get('/api/admin/llm-status', security.requireAdmin('llmstatus'), (_, res) =>
  res.json(Object.assign(llm.status(), { s2sEnforce: process.env.S2S_ENFORCE === '1' })));

app.use('/landing', express.static('landing'));   // 平台自托管落地页：广告主 landing_url 可指向 /landing/<项目>/，不再依赖外部托管
app.use('/sdk-files', express.static(path.join(__dirname, 'sdk'))); // 原生 SDK 源码可下载（iOS/Android/各 DSP 适配）

// 营销首页：/、/home、/home.html 统一指向 public/home.html（/index.html 仍保留为 Prebid 演示）
// 禁用静态资源缓存：前端 JS/HTML 改完后必须让浏览器立即拉新文件，否则会跑旧代码导致会话/角色错乱
// （例如管理员登录后仍被旧 login.html 显示成广告主）。仅作用于未被 API 路由匹配的静态/首页请求。
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});
const HOME_HTML = path.join(__dirname, 'public', 'home.html');
app.get(['/', '/home', '/home.html'], (req, res) => res.sendFile(HOME_HTML));

app.use(express.static('public'));
// worker 模式下监听独立端口（由 cluster.js 编排），否则监听 PORT；保证单进程直接 node server.js 仍可用
const LISTEN_PORT = process.env.MODE === 'worker' ? (parseInt(process.env.WORKER_PORT) || 8090) : PORT;
let srv;
init().then(() => {
  srv = app.listen(LISTEN_PORT, () =>
  console.log(`[platform v2] http://0.0.0.0:${LISTEN_PORT} | SSP /ssp/bid | DSP /openrtb2/bid | 控制台 /campaigns.html | 媒体报表 /publisher_report.html | 意图 /api/intent-match
  ${process.env.MODE === 'worker' ? '（worker#' + (process.env.WORKER_INDEX || '?') + '）' : ''}意图Agent LLM: ${llm.ENABLED ? `已接入(${llm.PROVIDER.keyEnv}/${llm.MODEL}, 热路径匹配=${process.env.LLM_HOT_PATH === '1' ? '开' : '关'})` : '未配置Key(启发式回落, 复制.env.example为.env填入Key启用)'}`));
  llm.startProbe();   // 启动 LLM 端点周期探活：被放白/换端点后自动解除熔断、恢复热路径真实评分
  // ── 反代(Cloudflare Tunnel)后的连接调优 ──
  // Node 默认 keepAliveTimeout 仅 5s：上游复用稍久一点的空闲连接时，Node 已单方面关闭，
  // 请求会卡到超时（表现为"随机某些端点 15~20s 超时"）。这里放宽以匹配上游保活。
  srv.keepAliveTimeout = Number(process.env.KEEPALIVE_TIMEOUT_MS || 65000);
  srv.headersTimeout = srv.keepAliveTimeout + 5000;            // 必须 > keepAliveTimeout
  srv.requestTimeout = Number(process.env.REQUEST_TIMEOUT_MS || 120000);
  srv.setTimeout(0);                                           // 禁用 socket 空闲超时，交由上游控制
})
// 优雅退出：收到 SIGTERM/SIGINT 先停接收新连接并释放连接池，避免强杀丢事务/连接泄漏
let _shutting = false;
async function shutdown(sig) {
  if (_shutting) return; _shutting = true;
  console.error(`[platform] received ${sig}, graceful shutdown...`);
  try { if (srv) srv.close(); } catch (e) {}
  try { await pool.end(); } catch (e) {}
  setTimeout(() => process.exit(0), 300).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
