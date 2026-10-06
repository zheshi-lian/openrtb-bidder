# AppLink ADX · Android Native Ad SDK

An all-in-one SDK for rewarded video (VAST 4.0) + native `AdView` (banner / interstitial / splash / native / push).
**Zero third-party dependencies** (Android SDK + Kotlin stdlib only); produces `applink-adsdk-release.aar`.

> **Security boundary (client is untrusted)**: the SDK only does bidding → parse → render → tracking → hand over view evidence.
> **The SDK never decides rewards locally.** Rewarding is judged by your App server via S2S callback to ADX `/s2s/reward` (HMAC signed), then delivered server-to-server — the client cannot forge completed views.

## Quick start

```kotlin
// ① Init once in Application.onCreate()
AdSdk.init(this, AdSdk.Config(
    appKey = "YOUR_APPKEY",
    serverUrl = "https://ssp.your-adx.com",
    siteDomain = "mygame.example.com",
    appServerRewardUrl = "https://your-server/reward"
))

// ② Banner / Interstitial: HTML → WebView
val adView = AdView(context)
adView.adUnitId = "home-banner"
adView.loadBanner(
    AdView.Listener { ad -> adView.setBannerHtml(ad.html) },
    AdView.FailListener { err -> Log.w("Ad", "banner: ${err.code} ${err.reason}") }
)

// ③ Rewarded: VAST → S2S reward after complete
RewardedAdSdk.load("casual,rewarded", object : RewardedAdSdk.LoadCallback {
    override fun onLoaded(ad: RewardedAdSdk.Ad) { RewardedAdSdk.show(videoView, ad, cb) }
    override fun onFailed(error: AdError) {}
})

// ④ Preload for instant show
adView.preload("banner")
adView.loadFromCache("home-banner", AdView.Listener { /* ... */ }, AdView.FailListener { /* ... */ })
```

## Integration
- **A. AAR**: download `applink-adsdk-release.aar` from Releases / Actions Artifacts → drop in `app/libs/` → `implementation fileTree(dir: 'libs', include: ['*.aar'])`.
- **B. Source**: copy `src/main/java/com/zhuque/adsdk/*.kt`.
- **C. Local build**: `./gradlew assembleRelease` → `build/outputs/aar/applink-adsdk-release.aar`.

## Ad formats
banner / interstitial / splash (HTML→WebView) · rewarded (VAST→VideoView, S2S reward) · native (JSON, render yourself) · push (server delivered).

## Error codes (AdError)
1001 NO_FILL · 1002 BAD_VAST · 1003 BAD_URL · 1004 VIDEO_ERROR · 1005 NO_REWARD_URL · 1006 NETWORK · 1007 SERVER_DENIED · 1099 UNKNOWN.

## Reward S2S contract
```
POST {ADX}/s2s/reward
body: { impid, cid, token, watchedMs, durationMs, ts, sig }
sig  = HMAC_SHA256(api_key, "impid|cid|token|watchedMs|durationMs|ts")
```
`api_key` lives only on your App server (never in the SDK). ADX verifies signature → token not replayed → completion ratio → grants.

## Connecting a real OpenRTB SSP (closed loop)
The SDK only does the client side; bidding must run on a real SSP server.
- **Local**: run `server/ssp.py` (ADX side, `:8080`) + `server/app_server.py` (your side, `:8090`); point `serverUrl`/`appServerRewardUrl` at them. See `server/README.md`.
- **Production**: implement `POST /ssp/bid` (OpenRTB subset from `AdSdk.buildBidRequest`) and your App `/reward` that HMAC-signs and forwards to ADX. Use HTTPS + your domain; keep `api_key` server-side only.

See [`server/README.md`](server/README.md) for the full request/response JSON contract.
