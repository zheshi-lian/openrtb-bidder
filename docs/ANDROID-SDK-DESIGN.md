# Android SDK 设计文档（AdView.kt）

## 1. 目标

为 OpenRTB 竞价平台提供最小可用的 Android SDK，覆盖全部广告形态：

| 格式 | 渲染方式 | 典型场景 |
|------|---------|---------|
| `banner` | WebView 渲染 HTML 创意 | 信息流内嵌、底部横幅 |
| `interstitial` | 全屏 WebView 渲染 HTML 创意 | 页面切换、关卡间隙 |
| `splash` | 全屏 WebView 渲染 HTML 创意 | App 启动页 |
| `icon` | WebView 渲染 HTML 创意 | 应用商店式小图下载位 |
| `rewarded` | VideoView 播放 VAST 4.0 视频 | 激励视频（看广告得奖励） |
| `native` | 返回结构化 JSON，由 App 自渲染 | 原生信息流，样式完全由 App 决定 |
| `push` | 创意由媒体推送系统下发，不经 SDK 渲染 | 服务端推送 |

> `banner / interstitial / splash / icon` 在 SDK 内统一走 `admType=html` 的 WebView 渲染；`rewarded` 走 VAST；`native` 走 JSON；`push` 不渲染。

## 2. 设计原则

- **客户端不可信**：SDK 只负责竞价、解析、渲染、上报。发奖裁决由 App 服务端 S2S 回调完成，**SDK 绝不本地判定是否发奖**（旧版 `AdView.kt` 曾直接把 `rwToken` 交给 App 本地发奖，属于安全隐患，已改为上报证据）。
- **单文件**：一个 `AdView.kt`（约 240 行），无外部依赖（仅 Android SDK + Kotlin stdlib + `org.json`）。
- **最小 API**：五个 `load*` 方法（`loadBanner / loadInterstitial / loadRewarded / loadNative / loadPush`）+ 一个 `AdView` 控件，媒体方几行代码即可接入。
- **HTTP 调用**：`POST /ssp/bid`（OpenRTB 2.5+），与平台竞价引擎直连，不经过中间层。

## 3. API 设计

### 3.1 AdView 控件

```kotlin
// 继承 FrameLayout，可嵌套到任意布局中
val adView = AdView(context)
adView.adUnitId = "首页-banner"           // 广告单元名称（须与平台注册一致）
adView.siteDomain = "mygame.example.com"  // 媒体域名（须与平台注册一致）
adView.adxBase = "https://dellai.xyz"    // 平台地址（可选，默认 dellai.xyz）
adView.appServerRewardUrl = "https://你的服务端/reward"  // S2S 发奖回调（仅 rewarded 需要）

// Banner：加载并渲染
adView.loadBanner(AdView.Listener { ad -> adView.setBannerHtml(ad.html) },
                 { reason -> Log.w("Ad", "banner fail: $reason") })

// Interstitial：加载并全屏展示
adView.loadInterstitial(AdView.Listener { ad ->
    activity?.addContentView(adView.showInterstitial(ad.html),
        ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,
                              ViewGroup.LayoutParams.MATCH_PARENT))
}, { reason -> Log.w("Ad", "interstitial fail: $reason") })

// Rewarded：加载并播放视频（完播后 S2S 发奖）
adView.loadRewarded(AdView.Listener { ad ->
    adView.playRewarded(videoView, ad) { reward -> /* 发奖 */ }
}, { reason -> Log.w("Ad", "rewarded fail: $reason") })

// Native：结构化 JSON，由 App 自渲染
adView.loadNative(AdView.Listener { ad -> renderMyOwn(ad.nativeJson) },
                 { reason -> Log.w("Ad", "native fail: $reason") })
```

### 3.2 Ad 数据模型

```kotlin
data class Ad(
    val impId: String,        // 曝光 ID
    val cid: String,          // 计划 ID（归因用）
    val crid: String,         // 创意 ID（归因到具体素材）
    val price: Long,          // 价格（micros，1 元 = 1_000_000）
    val format: String,       // banner / interstitial / splash / rewarded / native / icon / push
    val admType: String,      // html / vast4 / native_json / push
    val html: String = "",    // admType=html 时的 HTML 创意
    val vastUrl: String = "", // admType=vast4 时的视频地址
    val vastDuration: String = "",
    val nativeJson: String = "",  // admType=native_json 时的结构化 JSON
    val pushJson: String = "",    // admType=push 时的推送内容
    val rwToken: String = "",     // 激励视频一次性令牌（仅上报用，不可本地发奖）
    val tracking: Map<String, String> = emptyMap(), // VAST tracking events
    val advertiser: String = ""   // 创意归属广告主（归因展示用）
)
```

### 3.3 请求/响应协议

**请求**（`POST /ssp/bid`）：

```json
{
  "id": "imp-12345",
  "site": { "domain": "mygame.example.com" },
  "imp": [{
    "id": "imp-12345",
    "bidfloor": 1.0,
    "ext": { "ad_unit_id": "首页-banner", "ad_type": "banner" }
  }],
  "device": {
    "ua": "...", "os": "Android", "osv": "14",
    "w": 1080, "h": 1920, "make": "Pixel", "model": "8",
    "geo": { "country": "CN" }
  }
}
```

**响应**（OpenRTB BidResponse）：

```json
{
  "id": "imp-12345",
  "seatbid": [{ "bid": [{
    "id": "b1", "impid": "imp-12345", "price": 1200000,
    "crid": "c_7", "cid": "12", "adm": "<html>...</html>",
    "ext": {
      "ad_format": "banner", "adm_type": "html",
      "cid": "12", "advertiser": "示例广告主",
      "rw": { "impid": "imp-12345", "token": "..." }
    }
  }]}]
}
```

> `ext.advertiser` 与 `crid` 用于客户端归因展示（"本素材由广告主 X 生产"）。

### 3.4 安全边界（客户端不可信）

- `siteDomain` 必须与平台入驻时一致，否则反作弊引擎标记 `INVALID_PUBLISHER`。
- 激励视频发奖：**SDK 把观看证据（impid/cid/crid/watchedMs/durationMs）POST 给 `appServerRewardUrl`**；App 服务端用 `api_key` 做 HMAC-SHA256 签名后回调 `/s2s/reward`，平台校验 签名→令牌未重放→设备指纹→完播比例→才 `granted`。
- SDK 不持有 `rwToken` 也不本地发奖，杜绝客户端伪造完播刷量。
- 设备级风控：平台 `anticheat` 模块自动按 `device_id` 24h 曝光 > N 次过滤。

## 4. 文件结构

```
sdk/android/
├── AdView.kt          ← 主 SDK（本设计文档对应的实现，支持全部 7 种形态 + S2S 发奖）
└── RewardedAdSdk.kt   ← 旧版激励视频专用 SDK（保留兼容，仅 rewarded）
```

## 5. 与现有 SDK 的关系

| 维度 | RewardedAdSdk.kt（旧） | AdView.kt（新） |
|------|----------------------|----------------|
| 格式 | 仅 rewarded | banner + interstitial + splash + icon + rewarded + native + push |
| 渲染 | VideoView + WebView | WebView（html 类）+ VideoView（rewarded）+ 原生 JSON 自渲染 |
| API | `load` + `show` | `loadBanner` / `loadInterstitial` / `loadRewarded` / `loadNative` / `loadPush` |
| 广告单元 | 无（用 keywords） | 支持 `ad_unit_id` 定向 |
| 发奖 | S2S（App 服务端回调） | S2S（App 服务端回调，`appServerRewardUrl`） |
| 依赖 | 单文件 | 单文件（无外部依赖） |

两者可共存：已有激励视频接入的媒体方继续用 `RewardedAdSdk.kt`；新接入的媒体方用 `AdView.kt`（推荐）。
