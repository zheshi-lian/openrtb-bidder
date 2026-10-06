'use strict';
/**
 * OIDC 单点登录（SSO）—— 零外部依赖实现
 *
 * 设计要点（安全优先）：
 *  1) 标准授权码流程 + PKCE(S256)：即使 client_secret 泄露也无法被重放。
 *  2) state（防 CSRF）+ nonce（防重放），均存 cache 并一次性消费。
 *  3) ID Token 用 IdP 的 RS256 公钥（JWKS）校验；**显式拒绝 alg=none / HS256**，
 *     防止「算法混淆」攻击（用我们的 HMAC 公钥去验 HS256 签名）。
 *  4) 严格校验 iss / aud / exp（容忍 60s 时钟漂移）。
 *  5) 邮箱域名白名单（OIDC_ALLOWED_DOMAINS），防止任意 IdP 账号混入。
 *  6) 不把长效 token 放进 URL：回调只回传 一次性 code(60s)，前端再换 token。
 *  7) 自动开通的账号默认角色由 OIDC_DEFAULT_ROLE 决定（默认 advertiser，安全），
 *     不会因为 SSO 而自动产生管理员。
 *
 * 环境变量：
 *   OIDC_ISSUER=https://accounts.google.com            (必填)
 *   OIDC_CLIENT_ID=...                                 (必填)
 *   OIDC_CLIENT_SECRET=...                              (公开客户端可留空，配合 PKCE)
 *   OIDC_REDIRECT_URI=https://<域名>/api/auth/oidc/callback  (必填，需在 IdP 后台登记)
 *   OIDC_SCOPES=openid email profile
 *   OIDC_ALLOWED_DOMAINS=example.com,corp.com         (留空=不限制，但不建议)
 *   OIDC_PROVIDER_NAME=Google                          (登录按钮文案)
 *   OIDC_AUTO_PROVISION=1                              (首次登录自动建号)
 *   OIDC_DEFAULT_ROLE=advertiser                       (自动建号的角色)
 *   OIDC_POST_LOGIN_REDIRECT=/login.html               (认证后回跳)
 */

const crypto = require('crypto');

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function initOidc(deps) {
  const { app, pool, cache, security, genAccountCode } = deps || {};

  const CFG = {
    get issuer() { return String(process.env.OIDC_ISSUER || '').replace(/\/+$/, ''); },
    get clientId() { return String(process.env.OIDC_CLIENT_ID || ''); },
    get clientSecret() { return String(process.env.OIDC_CLIENT_SECRET || ''); },
    get redirectUri() { return String(process.env.OIDC_REDIRECT_URI || (this.issuer ? this.issuer.replace(/\/+$/, '') + '/api/auth/oidc/callback' : '')); },
    get scopes() { return String(process.env.OIDC_SCOPES || 'openid email profile'); },
    get allowedDomains() {
      return String(process.env.OIDC_ALLOWED_DOMAINS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    },
    get providerName() { return String(process.env.OIDC_PROVIDER_NAME || 'SSO'); },
    get autoProvision() { return String(process.env.OIDC_AUTO_PROVISION || '1') === '1'; },
    get defaultRole() {
      const r = String(process.env.OIDC_DEFAULT_ROLE || 'advertiser').toLowerCase();
      return ['admin', 'advertiser', 'publisher'].includes(r) ? r : 'advertiser';
    },
    get postLoginRedirect() { return String(process.env.OIDC_POST_LOGIN_REDIRECT || '/login.html'); },
  };
  const enabled = () => !!(CFG.issuer && CFG.clientId && CFG.redirectUri);

  // ── discovery / JWKS 缓存 ──
  let disco = null, discoAt = 0;
  let jwks = null, jwksAt = 0;
  const TTL = 10 * 60 * 1000;

  async function getDisco() {
    if (disco && Date.now() - discoAt < TTL) return disco;
    const r = await fetch(CFG.issuer + '/.well-known/openid-configuration');
    if (!r.ok) throw new Error('oidc_discovery_' + r.status);
    disco = await r.json();
    if (!disco.authorization_endpoint || !disco.token_endpoint || !disco.jwks_uri) throw new Error('oidc_discovery_incomplete');
    discoAt = Date.now();
    return disco;
  }
  async function getJwks() {
    if (jwks && Date.now() - jwksAt < TTL) return jwks;
    const d = await getDisco();
    const r = await fetch(d.jwks_uri);
    if (!r.ok) throw new Error('oidc_jwks_' + r.status);
    jwks = await r.json();
    jwksAt = Date.now();
    return jwks;
  }

  // ── RS256 ID Token 校验（显式只接受 RS256）──
  function verifyIdToken(idToken, expect) {
    if (!idToken || typeof idToken !== 'string') return null;
    const parts = idToken.split('.');
    if (parts.length !== 3) return null;
    let header, payload;
    try {
      header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
      payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    } catch (e) { return null; }
    if (!header || header.alg !== 'RS256') return null; // 防 alg=none / HS256 混淆
    const keys = (jwks && jwks.keys) || [];
    const jwk = keys.find((k) => (!k.kid || k.kid === header.kid) && (!k.alg || k.alg === 'RS256') && k.kty === 'RSA');
    if (!jwk) return null;
    try {
      const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
      const ok = crypto.verify('RSA-SHA256', Buffer.from(parts[0] + '.' + parts[1]), key, Buffer.from(parts[2], 'base64url'));
      if (!ok) return null;
    } catch (e) { return null; }
    if (expect) {
      if (payload.iss !== CFG.issuer && payload.iss !== expect.issuer) return null;
      const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
      if (!aud.includes(CFG.clientId)) return null;
      if (payload.exp && (Date.now() / 1000) > Number(payload.exp) + 60) return null; // 容忍 60s 漂移
      if (expect.nonce && payload.nonce !== expect.nonce) return null;
    }
    return payload;
  }

  function emailOf(payload) {
    let email = payload && (payload.email || '');
    if (!email && payload && payload.claims) email = payload.claims.email || '';
    email = String(email || '').trim().toLowerCase();
    return email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? email : '';
  }
  function domainOk(email) {
    const allow = CFG.allowedDomains;
    if (!allow.length) return true;
    const d = email.split('@')[1] || '';
    return allow.includes(d);
  }

  // ── 账号解析 / 开通（SSO 登录后映射到本地账号）──
  async function resolveAccountByEmail(email) {
    const [[a]] = await pool.query('SELECT id,username,type,scope,display,account_code,status FROM accounts WHERE username=? LIMIT 1', [email]).catch(() => [[]]);
    if (a && a.id) return { account: a, created: false };
    if (!CFG.autoProvision) return { account: null, created: false, reason: 'no_account' };
    const type = CFG.defaultRole;
    const scope = type === 'publisher' ? email.split('@')[1] : email.split('@')[1];
    const code = genAccountCode ? genAccountCode(type) : '';
    const [r] = await pool.query(
      'INSERT INTO accounts (type,username,pass_hash,scope,display,account_code,created_by) VALUES (?,?,?,?,?,?,?)',
      [type, email, security.hashPwd('oidc:' + crypto.randomBytes(16).toString('hex')), scope, email.split('@')[0], code, 'oidc']).catch(() => [{}]);
    if (!r || !r.insertId) return { account: null, created: false, reason: 'provision_failed' };
    const [[na]] = await pool.query('SELECT id,username,type,scope,display,account_code,status FROM accounts WHERE id=?', [r.insertId]).catch(() => [[]]);
    return { account: na, created: true };
  }

  // ── 路由 ──
  if (!app) return { enabled };

  // 前端探测：是否展示「SSO 登录」按钮
  app.get('/api/auth/oidc/status', async (req, res) => {
    res.json({
      enabled: enabled(),
      provider: CFG.providerName,
      // 即使开启也先做一次 discovery 探测，避免配置错误时用户点进去才炸
      reachable: enabled() ? await getDisco().then(() => true).catch(() => false) : false,
    });
  });

  // 发起登录：302 到 IdP
  app.get('/api/auth/oidc/login', async (req, res) => {
    if (!enabled()) return res.status(404).json({ error: 'oidc_not_configured', hint: '请配置 OIDC_ISSUER / OIDC_CLIENT_ID / OIDC_REDIRECT_URI' });
    try {
      const d = await getDisco();
      const state = b64u(crypto.randomBytes(16));
      const nonce = b64u(crypto.randomBytes(16));
      const verifier = b64u(crypto.randomBytes(32));
      const challenge = b64u(crypto.createHash('sha256').update(verifier).digest());
      // 一次性存 5 分钟；存 code_verifier 供回调换 token 用
      await cache.set('oidc:st:' + state, JSON.stringify({ nonce, verifier, u: String(req.query.u || '') }), 300).catch(() => {});
      const url = new URL(d.authorization_endpoint);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('client_id', CFG.clientId);
      url.searchParams.set('redirect_uri', CFG.redirectUri);
      url.searchParams.set('scope', CFG.scopes);
      url.searchParams.set('state', state);
      url.searchParams.set('nonce', nonce);
      url.searchParams.set('code_challenge', challenge);
      url.searchParams.set('code_challenge_method', 'S256');
      res.redirect(url.toString());
    } catch (e) { res.status(502).json({ error: 'oidc_discovery_failed', detail: e.message }); }
  });

  // 回调：换 token → 校验 → 映射账号 → 回跳一次性 code
  app.get('/api/auth/oidc/callback', async (req, res) => {
    const back = (err) => res.redirect(CFG.postLoginRedirect + '#sso_error=' + encodeURIComponent(err));
    if (!enabled()) return back('oidc_not_configured');
    if (req.query.error) return back(String(req.query.error));
    const code = String(req.query.code || ''), state = String(req.query.state || '');
    if (!code || !state) return back('missing_code_or_state');
    try {
      const raw = await cache.get('oidc:st:' + state).catch(() => null); // 一次性消费
      await cache.set('oidc:st:' + state, '', 1).catch(() => {});
      if (!raw) return back('state_invalid_or_expired');
      const st = JSON.parse(raw);
      const d = await getDisco();
      // 换 token（client_secret_basic 或 form，按是否配置 secret 自适应）
      const form = new URLSearchParams();
      form.set('grant_type', 'authorization_code');
      form.set('code', code);
      form.set('redirect_uri', CFG.redirectUri);
      form.set('client_id', CFG.clientId);
      form.set('code_verifier', st.verifier);
      const headers = { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' };
      if (CFG.clientSecret) {
        const basic = Buffer.from(CFG.clientId + ':' + CFG.clientSecret).toString('base64');
        headers.Authorization = 'Basic ' + basic;
      }
      const tr = await fetch(d.token_endpoint, { method: 'POST', headers, body: form.toString() });
      if (!tr.ok) return back('token_exchange_failed_' + tr.status);
      const tk = await tr.json();
      await getJwks(); // 确保 jwks 已加载
      const payload = verifyIdToken(tk.id_token, { nonce: st.nonce });
      if (!payload) return back('id_token_invalid');
      const email = emailOf(payload);
      if (!email) return back('email_missing_in_id_token');
      if (!domainOk(email)) return back('email_domain_not_allowed');
      const { account, created, reason } = await resolveAccountByEmail(email);
      if (!account || Number(account.status) === 0) return back(reason === 'no_account' ? 'no_local_account' : (reason || 'account_disabled'));
      // 发一次性 code（60s），前端用它换本平台 token——避免长效 token 出现在 URL
      const ssoCode = b64u(crypto.randomBytes(24));
      await cache.set('oidc:code:' + ssoCode, JSON.stringify({
        u: account.username, t: account.type, s: account.scope || '', a: account.account_code || '',
      }), 60).catch(() => {});
      try {
        await pool.query('INSERT INTO admin_audit (actor,action,target,detail,ip) VALUES (?,?,?,?,?)',
          [account.username, 'sso:login', account.username, (created ? 'provisioned ' : '') + 'via ' + CFG.providerName, String(req.ip || '')]);
      } catch (e) {}
      res.redirect(CFG.postLoginRedirect + '#sso_code=' + encodeURIComponent(ssoCode));
    } catch (e) { back('oidc_error:' + String(e.message || e)); }
  });

  // 一次性 code → 本平台 token
  app.post('/api/auth/oidc/exchange', async (req, res) => {
    const ssoCode = String((req.body || {}).code || '');
    if (!ssoCode) return res.status(400).json({ error: 'code required' });
    const raw = await cache.get('oidc:code:' + ssoCode).catch(() => null);
    await cache.set('oidc:code:' + ssoCode, '', 1).catch(() => {}); // 一次性
    if (!raw) return res.status(400).json({ error: 'code invalid or expired' });
    const a = JSON.parse(raw);
    const token = security.issueToken({ username: a.u, type: a.t, scope: a.s });
    res.json({ ok: true, token, type: a.t, scope: a.s, username: a.u, account_code: a.a });
  });

  return { enabled, CFG };
}

module.exports = { initOidc };
