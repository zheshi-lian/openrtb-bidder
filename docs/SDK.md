# SDK 说明（Android / iOS 激励视频 + 多形态）

SDK 只做「**竞价 → 解析 VAST 4.0 → 播放 → 上报 tracking → 把观看证据交服务端**」，
**绝不自行判定是否发奖**（防客户端刷量）。发奖由媒体服务端 S2S 回调平台裁决。

## 关键约定

| 项 | 值 |
|---|---|
| ADX 竞价端点 | `https://dellai.xyz/ssp/bid`（OpenRTB POST） |
| 默认 `adxBase` | `https://dellai.xyz`（留空自动回落） |
| `siteDomain` | 必须与入驻时 `domain` 完全一致，否则结算/归因失败 |
| 支持的 `format` | `rewarded / interstitial / splash / native / icon / push / banner` |
| `adm_type` | `vast4 / html / native_json / push` |
| 完播阈值 | 观看比例 ≥ 95% 才发奖（平台侧 `RW_MIN_RATIO`） |
| S2S 结算签名 | `sig = HMAC_SHA256(api_key, "impid|cid|watchedMs|durationMs|ts")` |

## 多形态渲染分工

- `rewarded` → VideoView 播放 VAST（SDK 内建 VAST 4.0 解析 + 四分位 tracking 上报）
- `interstitial / splash / icon / banner` → WebView 渲染 `adm`(HTML)
- `native` → 返回 `nativeJson`，由 App 自行渲染（样式由 App 决定）
- `push` → 创意由媒体推送系统下发，不经 SDK 渲染

## 安全边界（客户端不可信）

1. SDK 拿到的是一次性签名令牌（`/ssp/bid` 返回 `ext.rw`），仅用于上报，无法自证完播。
2. 完播证据（watchedMs/durationMs）上报到 **你的服务端**，由你的服务端用 `api_key` 签名后回调 `/s2s/reward`。
3. 平台校验：签名 → 令牌未重放 → 设备指纹绑定 → 完播比例合法 → 才 `granted`。
4. 设备级风控：单设备窗口内领奖超阈值判为设备农场（DEVICE_FP_RATE_LIMIT）。

## 生产建议

- 设 `S2S_ENFORCE=1`：让 `/ssp/reward`（客户端直结）仅作信号，必须等 `/s2s/reward` 才计入结算。
- `RW_SECRET` 经环境变量注入，切勿硬编码。
- 落地页域名加入 `pub_sdk.js` 的 `landingAllow` 白名单防违规外跳；**平台自托管落地页**（与 ADX 同 origin，如 `/landing/<项目>/`）已自动放行，无需加入白名单。
- 自托管落地页放在项目 `landing/<项目>/index.html`，由 `server.js` 的 `app.use('/landing', express.static('landing'))` 挂载；留资 `POST /api/public/ruankao-lead` 变同源请求，CORS 自动消失。
