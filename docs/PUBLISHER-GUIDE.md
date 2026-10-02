# 媒体方（Publisher）接入指南

本平台 = **DSP + SSP + ADX**，媒体方（App / 网站开发者）通过以下步骤把广告位流量接入，参与程序化广告分成。

## 1. 入驻并获取 api_key（S2S 密钥）

调用后端接口（或在 `/publisher.html` 页面填写）：

```http
POST /api/publisher
Content-Type: application/json

{
  "domain": "mygame.example.com",   // 你的广告位域名（须与 SDK 上报的 siteDomain 一致）
  "name": "MyGame Studio",
  "contact": "me@x.com",
  "payout_rate": 0.70,              // 你与平台的分成率(0.1~0.95)
  "site_url": "https://mygame.example.com"  // 用于合规供给爬虫补全 cat/geo，提升 eCPM
}
```

返回 `api_key`（如 `pub_xxx`）。**它用于结算回调签名，务必保密，仅在你的服务端使用。**

## 2. 网页端接入（一行代码）

在你的页面放广告位标签，并引入 SDK：

```html
<div class="ad-slot" data-floor="1.0" data-cat="puzzle" data-geo="US"></div>
<script src="https://dellai.xyz/pub_sdk.js"></script>
```

SDK 会自动向 `https://dellai.xyz/ssp/bid` 发起 OpenRTB 竞价，用沙箱 iframe 渲染创意并上报曝光/点击。
参数：`data-floor` 底价(元)、`data-cat` APP 品类、`data-geo` 国家、`data-kw` 关键词（逗号分隔）。

## 3. 移动端接入（Android / iOS SDK）

SDK 默认指向 `https://dellai.xyz`（可传 `adxBase` 覆盖）。**客户端不可信**：SDK 只负责「竞价→播放→上报观看证据」，
发奖由你的**服务端**用 `api_key` 签名后回调平台 `/s2s/reward` 裁决。

### Android
```kotlin
val cfg = RewardedAdSdk.Config(
    adxBase = "https://dellai.xyz",
    siteDomain = "mygame.example.com",          // 必须与入驻 domain 一致
    appServerRewardUrl = "https://你的服务端/reward" // 由它做 S2S 签名回调
)
RewardedAdSdk.load(cfg, "休闲游戏,激励视频") { ad ->
    RewardedAdSdk.show(videoView, ad) { reward -> /* 发道具 */ }
}
```

### iOS
```swift
let cfg = RewardedAdSdk.Config(
    adxBase: "https://dellai.xyz",
    siteDomain: "mygame.example.com",
    appServerRewardUrl: "https://你的服务端/reward")
RewardedAdSdk.shared.load(cfg: cfg, keywords: "休闲游戏,激励视频") { result in
    if case .success(let ad) = result { RewardedAdSdk.shared.show(from: self, ad: ad) { granted, _ in } }
}
```

### 你的服务端 S2S 回调（发奖裁决）
```http
POST /s2s/reward
Content-Type: application/json

{
  "impid": "<ADX 返回的 impid>", "cid": "<campaign id>", "publisher": "mygame.example.com",
  "watchedMs": 52000, "durationMs": 52000, "ts": 1690000000000,
  "sig": "HMAC_SHA256(api_key, \"impid|cid|watchedMs|durationMs|ts\")",
  "device_fp": "<设备指纹>"
}
```
平台校验签名 + 完播阈值(≥95%) + 设备指纹绑定后返回 `{ok:true, granted:true}`，你据此下发奖励。

## 4. 查看你的收益报表

- 页面：打开 `https://dellai.xyz/publisher_report.html`，填入你的 `api_key`。
- 接口：`GET /api/reports/publisher?api_key=pub_xxx` → 返回胜出/分成/完播发奖/点击/转化/GMV。

## 5. 上传广告素材（让你的广告位展示真实创意）

广告主/运营在 `https://dellai.xyz/creative.html` 上传多形态素材（banner/rewarded/interstitial/splash/native/icon/push），
竞价时优先使用素材库真实创意（优于系统合成占位）。
