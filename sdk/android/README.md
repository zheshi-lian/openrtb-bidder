# AppLink ADX · Android 原生广告 SDK

激励视频（VAST 4.0）+ 原生 `AdView`（横幅 / 插屏 / 开屏 / 原生 / 推送）一体化 SDK。
**零第三方依赖**（仅 Android SDK + Kotlin stdlib），可产出 `applink-adsdk-release.aar`。

> **安全边界（客户端不可信）**：SDK 只负责「竞价 → 解析 → 渲染 → tracking 上报 → 交付观看证据」；
> **SDK 绝不自行判定是否发奖**。发奖由你的 App 服务端 S2S 回调 ADX `/s2s/reward`（HMAC 签名）裁决，
> 再由服务端下发奖励，客户端无法伪造完播。

---

## 目录结构

```
.
├── build.gradle                      # 根项目即 library（产出 AAR）
├── settings.gradle                   # 多模块：根(library) + :app(演示)
├── gradle.properties
├── gradle/wrapper/                   # Gradle wrapper（本地构建用，无需另装 Gradle）
├── .github/workflows/build-aar.yml   # 自动出包（push → Actions 取 AAR；打 v* tag → Releases 发布）
├── src/main/java/com/zhuque/adsdk/  # SDK 源码
│   ├── AdSdk.kt                      # 全局初始化 + 隐私合规单例
│   ├── AdView.kt                     # 多形态广告控件
│   ├── RewardedAdSdk.kt              # 激励视频（VAST）
│   ├── AdError.kt                    # 标准化错误码
│   └── AdCache.kt                    # LRU 预加载缓存
├── app/                              # 可运行 Demo 宿主工程
├── server/                           # 参考 OpenRTB SSP + App 服务端（P2 闭环样例）
├── README.md / README-EN.md         # 中文 / 英文文档
└── QUICKSTART.md                     # GitHub 自动出包手把手
```

---

## 集成方式（三选一）

### A. 直接用 AAR（推荐）
1. 取包：Releases 页下载 `applink-adsdk-release.aar`，或 Actions → Artifacts `applink-adsdk-aar`。
2. 放入宿主工程 `app/libs/`。
3. 宿主 `app/build.gradle`：
   ```gradle
   dependencies { implementation fileTree(dir: 'libs', include: ['*.aar']) }
   ```
4. 宿主 `AndroidManifest.xml` 声明权限（SDK 已声明，建议显式一次）：
   ```xml
   <uses-permission android:name="android.permission.INTERNET" />
   <uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />
   ```

### B. 源码集成
用 Android Studio 打开本仓库作为多模块工程，或把 `src/main/java/com/zhuque/adsdk/` 下 `.kt` 拷进你的工程（包名 `com.zhuque.adsdk`）。

### C. 本地自行出包（用 wrapper，无需另装 Gradle）
```powershell
./gradlew assembleRelease        # Windows (PowerShell)
# 或
./gradlew assembleRelease        # macOS / Linux
# 产物：build/outputs/aar/applink-adsdk-release.aar
```

---

## 快速开始

```kotlin
// ① 在 Application.onCreate() 做一次全局初始化（必须）
AdSdk.init(this, AdSdk.Config(
    appKey             = "你的媒体AppKey",
    serverUrl          = "https://ssp.your-adx.com",   // OpenRTB SSP 竞价服务基址
    siteDomain         = "mygame.example.com",         // ADX 注册的媒体域名
    appServerRewardUrl = "https://你的服务端/reward"     // 仅激励视频发奖需要
))

// ② 横幅 / 插屏：HTML 创意 → WebView
val adView = AdView(context)
adView.adUnitId = "首页-banner"
adView.loadBanner(
    AdView.Listener { ad -> adView.setBannerHtml(ad.html) },
    AdView.FailListener { err -> Log.w("Ad", "banner: ${err.code} ${err.reason}") }
)

// ③ 激励视频：VAST → 完播后 App 服务端 S2S 裁决发奖
RewardedAdSdk.load("休闲游戏,激励视频", object : RewardedAdSdk.LoadCallback {
    override fun onLoaded(ad: RewardedAdSdk.Ad) { RewardedAdSdk.show(videoView, ad, cb) }
    override fun onFailed(error: AdError) { /* 拉不到广告 */ }
})

// ④ 预加载（提升展示速度）：先 preload，展示时 loadFromCache 秒出
adView.preload("banner")
adView.loadFromCache("首页-banner", AdView.Listener { ... }, AdView.FailListener { ... })

// ⑤ 隐私合规（GDPR / CCPA / COPPA）
AdSdk.setConsent(AdSdk.Consent(gdprApplies = true, consentString = "CONSENT_STRING"))
```

---

## 支持的广告形态

| 形态 | 渲染方式 | 说明 |
|---|---|---|
| banner | HTML → WebView | 横幅 |
| interstitial | HTML → WebView（全屏） | 插屏 |
| splash | HTML → WebView | 开屏 |
| rewarded | VAST 4.0 → VideoView | 激励视频，**发奖走 S2S** |
| native | 结构化 JSON | 由 App 自渲染样式 |
| push | 推送系统下发 | 不经 SDK 渲染 |

---

## 标准化错误码（AdError）

| code | reason | 含义 |
|---|---|---|
| 1001 | NO_FILL | 没有可用广告（竞价未胜出） |
| 1002 | BAD_VAST | VAST 解析失败 |
| 1003 | BAD_URL | 素材地址无效 |
| 1004 | VIDEO_ERROR | 视频播放出错 |
| 1005 | NO_REWARD_URL | 未配置发奖服务端地址 |
| 1006 | NETWORK | 网络错误 |
| 1007 | SERVER_DENIED | 服务端拒绝发奖 |
| 1099 | UNKNOWN | 未知错误 |

---

## 服务端发奖回调（你 → ADX，S2S + HMAC）

```
POST {ADX}/s2s/reward
body: { impid, cid, token, watchedMs, durationMs, ts, sig }
sig  = HMAC_SHA256(api_key, "impid|cid|token|watchedMs|durationMs|ts")
```
- `api_key` 只存在你的 **App 服务端**，绝不进 SDK（SDK 不可信）。
- ADX 校验：签名 → 令牌未重放 → 完播比例（watchedMs/durationMs ≥ 阈值）→ 才 `granted`。

---

## 如何接入真实 OpenRTB SSP（形成真正闭环）— P2

SDK 只负责客户端，**竞价必须由真实 SSP 服务端完成**。两种方式：

### 方式一：跑本仓库自带的参考服务（本地联调）
```bash
cd server
python ssp.py          # ADX 侧：:8080 提供 /ssp/bid 与 /s2s/reward
python app_server.py   # 你的 App 侧：:8090 接收 SDK 证据并签名转发
```
然后把 `AdSdk.init` 的 `serverUrl` 指向 `http://<你的机器IP>:8080`，
`appServerRewardUrl` 指向 `http://<你的机器IP>:8090/reward`。
细节见 [`server/README.md`](server/README.md)。

### 方式二：接入你自己的 SSP（生产）
1. 你的 SSP 实现 `POST /ssp/bid`，请求体就是 `AdSdk.buildBidRequest` 产出的 OpenRTB 子集
   （`app.publisher.id=appKey` 用于鉴权，`imp.ext.ad_type` 区分形态，`regs/ext` 带隐私信号）。
2. 返回 `seatbid[0].bid[0]`，其中 `adm` 为 HTML（banner/interstitial）或 VAST XML（rewarded），
   `ext` 里带 `cid / ad_format / adm_type / advertiser / rw.token（rewarded 时）`。
3. 你的 App 服务端实现 `/reward`：收 SDK 证据 → 用 `api_key` 算 HMAC → 调 ADX `/s2s/reward` → 回 SDK。
4. **生产务必 HTTPS + 域名化**；`api_key` 只放在 App 服务端，SDK 永不持有。

> 竞价请求 / 响应字段契约见 [`server/README.md`](server/README.md) 的 JSON 示例。

---

## 常见问题
- **拉不到广告**：确认 `AdSdk.init` 的 `serverUrl` 可达、`siteDomain` 与 SSP 注册一致、`adUnitId` 有效。
- **收益为 0**：确认 App 服务端 `/reward` 已正确签名并打通 ADX `/s2s/reward`。
- **Actions 没出包**：进仓库 **Actions** 看日志；多半是 `src/` 或 `build-aar.yml` 没推上去。详见 `QUICKSTART.md`。
