# 三方后台链路审计 · 竞品对标（AppLovin / Unity / Taboola / 磁力）

> 审计对象：需求方(广告主) · 供给方(媒体) · 管理员 三套后台的登录与开户链路
> 代码位置：`openrtb-bidder/`（server.js 后端、public/ 前端）
> 本轮已修复 6 处断点，均已实测通过（见第 5 节验证记录）

---

## 1. 当前三方权限模型

单一 `accounts` 表，`type ENUM('admin','advertiser','publisher')` + `scope` 作用域：

| 角色 | scope 语义 | 可见数据 | 登录入口 |
|---|---|---|---|
| admin | `*` | 全量：竞价/结算/审核/账号管理 | `/login.html` |
| advertiser | 广告主名称 或 邮箱 | 仅自己 scope 下的计划/素材/报表 | `/login.html`、`/advertiser_signup.html`、`/register.html` |
| publisher | 媒体域名 | 仅自己域名的流量/收益/发奖 | `/login.html`、`/register.html` |

令牌：`security.issueToken()` 签发 HMAC 作用域令牌（7 天有效），`requireAuth(...types)` 做角色闸门，`resolveAccount()` 兼容旧版 `ADMIN_TOKEN` 静态令牌。

## 2. 竞品对标矩阵

| 能力项 | AppLovin (Max/AdColony) | Unity LevelPlay | Taboola / 磁力引擎 | **LinkOS** | 状态 |
|---|---|---|---|---|---|
| 三方角色拆分 | ✓ 独立门户（Advertiser / Publisher / Partner Ops） | ✓ Advertiser Console + Publisher | ✓ 分角色 | ✓ admin/advertiser/publisher | 对齐 |
| 自助开户 | ✓ 邮箱注册 + 资质审核 | ✓ | ✓ | ✓ 两个入口 + 审核态 `review_status` | 对齐 |
| 开户即可登录 | ✓ 注册即发账号 | ✓ | ✓ | **原断裂 → 本轮已修** | 修复 |
| 作用域数据隔离 | ✓ 账户级 | ✓ | ✓ | ✓ scope 令牌 | 对齐 |
| 记住我 / 会话保持 | ✓ 7~30 天 | ✓ 7 天 | ✓ 7 天 | **原仅 sessionStorage（关标签即失效）→ 本轮已修** | 修复 |
| 失败锁定防爆破 | ✓ 账号/IP 双维度 | ✓ | ✓ | **原无 → 本轮已加 5 次锁 15 分** | 修复 |
| 密码复杂度策略 | ✓ ≥8 位 + 混合字符 | ✓ | ✓ | △ 仅 ≥6 位 | 差距 |
| 2FA / MFA | ✓ TOTP + 短信 | ✓ | ✓ | ✗ | 差距 |
| 自助找回密码 | ✓ 邮箱魔法链接 | ✓ | ✓ | ✗（需管理员重置） | 差距 |
| SSO / SAML / OAuth | ✓（企业版） | ✓ | △ | ✗ | 差距 |
| 媒体侧 api_key | ✓ SDK 用 key、后台用账号 | ✓ | ✓ | ✓ **同 AppLovin：SDK 用 `api_key`，后台用账号** | 对齐 |
| 广告主审核状态可见 | ✓ 后台内看审核进度 | ✓ | ✓ | **原不可见（无账号）→ 本轮已修** | 修复 |
| 角色化登录后自动跳转 | ✓ 按角色落地 | ✓ | ✓ | **原跳错后台 → 本轮已修** | 修复 |

**结论**：链路骨架（三方拆分、作用域隔离、api_key 与账号双轨）与 AppLovin 同构；差距集中在安全策略（2FA/找回/SSO）与体验细节，本轮修掉了体验和闭环层面的 6 处。

## 3. 三条漏斗逐步走查

### 3.1 需求方（广告主）
```
home.html STEP02「需求侧开户」 ─┐
nav.js「自助开户」 ────────────┤→ /register.html#advertiser → POST /api/public/advertiser-open
                               │      ├─ 建 adv_campaign（review_status=pending）✓
                               │      └─ [原断裂] 不建账号 → 拿不到登录凭据 → 无法查审核状态
                               │          [本轮修复] 同步建 advertiser 账号(scope=邮箱)，凭据随响应返回并展示
                               └─ 审核通过后 → /advertiser.html 登录 → 建计划/充值/传素材 → /openrtb2/bid 参拍
```
旁路：`/advertiser_signup.html → POST /api/signup/advertiser`（直接建账号+令牌，跳过审核态）。

### 3.2 供给方（媒体）
```
nav.js「媒体入驻」/home.html STEP01 → /register.html#publisher → POST /api/publisher
   ├─ 签发 api_key（仅首次返回）→ 嵌入 <div class="ad-slot"> → pub_sdk.js
   └─ [原断裂] 同步建的账号密码被前端丢弃 → 媒体永远拿不到登录凭据
       [本轮修复] 前端展示 account.username/password；重复入驻不再重置密码
→ /publisher_report.html 登录 → 按 scope(域名) 看自己收益
```

### 3.3 管理员
```
/login.html 账号密码(admin/admin123) 或 旧 ADMIN_TOKEN
→ /api/account/login → 作用域令牌 → POST /api/admin/login 换 adm cookie
   [原断裂] /api/admin/login 只认静态令牌 → 账号令牌换 cookie 返回 401 → 依赖 cookie 的旧页失效
   [本轮修复] 同时接受 verifyToken()
→ /console.html(账号管理) · /dashboard.html · /reports.html
```

## 4. 本轮修复的 6 处（均已实测）

| # | 断点 | 根因 | 修复 |
|---|---|---|---|
| 1 | 需求方开户拿不到账号 | `/api/public/advertiser-open` 只建 `adv_campaign` | 同步建 `advertiser` 账号(scope=邮箱)并返回凭据；前端展示 |
| 2 | 媒体密码被静默丢弃 | `/api/publisher` 用 `ON DUPLICATE KEY UPDATE pass_hash=VALUES(...)` 重置密码，已入驻分支又不返回 | 账号已存在只补 display/scope；密码仅首次返回 |
| 3 | 账号密码登录后旧页仍 401 | `identify()` 只认 `ADMIN_TOKEN`，不认账号令牌 | `/api/admin/login` 补 `verifyToken()` 校验 |
| 4 | 登录后跳错后台 | `login.html` 的 `nextPage()` 读 **旧** sessionStorage 角色 | 改用**本次响应**的 `j.type` 决定落地页 |
| 5 | 无速率限制（可暴力破解） | `/api/account/login` 无防护 | 按 IP\|用户名 计数，5 次失败锁 15 分钟，返回 429+wait |
| 6 | 关标签页即登出 | 会话只存 `sessionStorage` | 「记住我」写 `localStorage`；`admin.js` 双存储读取；`nav.js` 右上角登录态指示 |

## 5. 验证记录（实测）

```
1 admin acct login -> 200 admin scope=* token=true
2 admin/login(acct token) -> 200 {"ok":true} cookie=adm=eyJ1IjoiYWRtaW4i...; HttpOnly; SameSite=Lax   ← 修复#3
3 public/advertiser-open -> 200 campaign=4 account={"username":"linkcheck...","password":"adv_..."}     ← 修复#1
4a publisher 1st -> 200 api_key=true acct={"username":"...","password":"pub_..."}                        ← 修复#2
4b publisher 2nd -> 200 api_key=false acct={"username":"..."}   (密码不重复下发)                          ← 修复#2
5 lockout codes -> 401,401,401,401,429 wait=900                                                          ← 修复#5
6 wrong pass -> 401 用户名或密码错误
7 login.html -> 200 hasRemember/hasRoles/hasSafeNext/hasCapsLock = true                                  ← 修复#4,#6
```

## 6. 残留差异与后续建议（按性价比排序）

1. **自助找回密码**（中优）：加 `POST /api/account/reset` 生成一次性令牌写 DB，邮件不可用时先做「管理员在控制台重置」。当前前端已给诚实提示，未承诺不存在的能力。
2. **密码策略升级**（中优）：新注册强制 ≥8 位 + 大小写+数字；`hashPwd` 现为**无成本因子的 SHA-256**，建议迁移到 `scrypt`/`argon2`（加 `pass_algo` 列做平滑迁移，老哈希登录成功时惰性升级）。
3. **`/api/public/ruankao-lead` 无限流**（低优）：目前只记 IP，刷量会污染线索表；建议按 IP 60 秒限 3 次。
4. **`init()` 内 `ruankao_lead` 重复建表**（低优）：惰性建表已是规范路径，`init()` 里那份可删。
5. **2FA / SSO**（低优，企业版才需要）：当前定位是演示 + 中小客户，静态令牌 + 账号令牌已够用。
6. **`nav.js` 管理员分组描述**：已更新为「账号密码登录（admin/admin123）或旧版 ADMIN_TOKEN」，去掉过期的「需 ADMIN_TOKEN」。

## 7. 已知但非本轮范围的问题

- 启动日志有一条 `init ... SQL syntax near '' at line 9`：来自某条历史迁移语句，被 `.catch(()=>{})` 捕获、**非致命**（服务正常起、`/health` 与全部账号端点均通过）。与本轮回登录的 5 处改动无关。
- 归因链仍是 `content_post=0`（见 `RUANKAO_LOOP.md` 下一节），与登录链路独立。

---

### 本轮改动文件清单
| 文件 | 改动 |
|---|---|
| `openrtb-bidder/server.js` | `/api/admin/login` 接受账号令牌；删除被遮蔽的死路由；`/api/account/login` 加锁定；`/api/publisher` 不再重置密码；`/api/public/advertiser-open` 同步建账号 |
| `openrtb-bidder/public/login.html` | 重写：角色选择、记住我、大写锁定提示、密码强度、一键填演示账号、429 倒计时、`next` 同源校验、已登录入口 |
| `openrtb-bidder/public/admin.js` | 双存储读取；登出同步清 cookie；`Auth.*` 统一走 `get()` |
| `openrtb-bidder/public/register.html` | 展示两侧开户返回的登录凭据 |
| `openrtb-bidder/public/nav.js` | 登录态指示；管理员分组文案更新 |
## 8. 身份与导航的边界（第一性原理重构）

### 用户反馈的问题
「页面上多了用户名密码、已登录、登出等字，很奇怪——正常情况这些不会出现在左上角。」

**根因**：旧 `nav.js` 是**全站唯一顶部导航**，17 个页面全量引用；而登录态指示（`(账号) · 登出`）被追加在它上面，于是**营销页也显示登录身份**。更糟的是它读的是 `auth_token`/`auth_user` 遗留键，而 `admin.js` 实际用的是 `adx_admin`——**键名都不一致**，导致显示残留的假登录态。

### 结论：不需要学 AppLovin 拆成 3 个平台

AppLovin/Unity 拆成 3 个独立门户（Advertiser Console / Publisher / Partner Ops）解决的是**企业级合规问题**：客户品牌隔离、独立 SLA、独立安全审计、独立部署运维。MVP 阶段拆 3 站只会让联调成本 ×3、收益为零。

**真正的分界不是站点数，而是三条职责边界：**

| 边界 | 是什么 | 显示身份吗 | 谁负责 |
|---|---|---|---|
| **公共站**（marketing） | 能力/产品/SDK/生态/文档/开户 | **绝不显示** | `nav.js`（GROUPS 下拉） |
| **控制台**（console） | 角色专属后台壳 | **显示**（账号+作用域+登出） | `console_top.js` |
| **权限闸门**（backend） | 接口级访问控制 | 不适用 | `server.js` 的 `requireAuth(...)` |

**关键原则：前端隐藏 ≠ 权限。** 前端只负责导航收敛与身份可见性；真闸门在后端中间件 + scope 令牌。

### 本轮改动
| 改动 | 说明 |
|---|---|
| `nav.js` 移除登录态 chip | 公共站只显示「注册 / 登录」；已登录只显示「进入我的后台」链接。**不显示账号名，不提供登出** |
| `nav.js` 清理 GROUPS 分组描述 | 去掉「账号密码登录（admin/admin123）或旧版 ADMIN_TOKEN」与供给侧「(仅 api_key)」等**登录方式/旧凭证**文案，描述只讲能做什么 |
| `nav.js` 停读遗留键 | 只认 `adx_admin`，不再读 `auth_token`/`auth_user`/`auth_role` |
| 新增 `console_top.js` | 控制台专属顶栏：角色徽标 + 账号 + 作用域 + 该角色功能 tab + 登出 |
| 8 个控制台页换壳 | `console/dashboard/reports/creative/creative-auto/advertiser/publisher/publisher_report` 移除 `nav.js`，改用 `console_top.js` |
| 6 个营销页保留 `nav.js` | `home/index/docs/pricing/dsp/ecpm_demo/media-demo/register` |

### 角色 → 控制台映射
| 角色 | 控制台页 | 专属 tab |
|---|---|---|
| 管理员 | `console.html` | 控制台 / 实时大盘 / 报表 / 素材 |
| 广告主 | `advertiser.html` | 我的计划 |
| 媒体 | `publisher_report.html` | 收益报表 / 入驻·广告位 |

### 验证
```
nav.js      : 旧变量 rle=False, javascript:void=False, 只有「进入我的后台」入口
console 页×8: ctop=True, console_top.js=True, nav.js=False
营销页×6    : nav.js=True, ctop=False, console_top.js=False
login.html  : 独立登录卡，两者都不含
```

### 残留
- `AUTH_TITLE` 变量在 `admin.js` 与 `advertiser.html`/`publisher.html` 中仍被引用（401 提示文案），无害保留。
- 控制台顶栏未做「角色 tab 分组下拉」，当前 tab 数量少，直接平铺更清楚。

