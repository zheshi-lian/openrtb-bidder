package com.zhuque.adsdk

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Xml
import android.net.Uri
import org.xmlpull.v1.XmlPullParser
import android.util.DisplayMetrics
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.VideoView
import android.webkit.WebView
import android.webkit.WebViewClient
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.UUID
import java.util.concurrent.Executors

/**
 * AdView —— 极简原生广告 SDK（Android），对标商业闭环产品。
 *
 * 【设计原则】
 *   · 单文件、零第三方依赖（仅 Android SDK + Kotlin stdlib），产出 applink-adsdk-release.aar
 *   · 多形态 load：loadBanner / loadInterstitial / loadRewarded / loadNative / loadPush
 *   · HTTP 调用：POST /ssp/bid（OpenRTB 2.5），与 SSP 竞价引擎直连
 *   · 客户端不可信：SDK 只负责 竞价→解析→渲染→tracking 上报→交付观看证据；发奖由 App 服务端 S2S 回调裁决
 *
 * 【安全边界｜客户端不可信】
 *   1. SDK 拿到一次性签名令牌（/ssp/bid 返回 ext.rw.token），仅用于上报，无法自证完播。
 *   2. 激励视频发奖：SDK 把「观看证据」(impid/cid/crid/token/watchedMs/durationMs) 交给 App 服务端；
 *      服务端用 api_key 做 HMAC-SHA256 签名后回调 /s2s/reward，平台校验 签名→令牌未重放→完播比例→才 granted。
 *   3. SDK 本身不持有 api_key、也不本地发奖，杜绝客户端伪造完播刷量。
 *
 * 【用法】
 *   AdSdk.init(application, AdSdk.Config(appKey="...", serverUrl="https://ssp.your-adx.com", siteDomain="mygame.example.com"))
 *   val adView = AdView(context)
 *   adView.adUnitId = "首页-banner"
 *   adView.loadBanner(
 *       AdView.Listener { ad -> adView.setBannerHtml(ad.html) },
 *       AdView.FailListener { err -> Log.w("Ad", "banner: ${err.code} ${err.reason}") }
 *   )
 *   // 预加载后秒出：
 *   adView.preload("banner") { }
 *   adView.loadFromCache("首页-banner", AdView.Listener { ... }, AdView.FailListener { ... })
 */
class AdView(context: Context) : FrameLayout(context) {

    // ---------- 配置（留空则自动取 AdSdk 全局配置） ----------
    var adUnitId: String = ""
    var siteDomain: String = ""           // 留空则用 AdSdk.config.siteDomain
    var adxBase: String = ""              // 留空则用 AdSdk.serverBase()
    var appServerRewardUrl: String = ""   // 留空则用 AdSdk.config.appServerRewardUrl

    // ---------- 数据模型 ----------
    data class Ad(
        val impId: String,
        val cid: String,            // 计划 ID（归因用）
        val crid: String,           // 创意 ID（归因到具体素材）
        val price: Long,            // 价格（micros，1 元 = 1_000_000）
        val format: String,         // banner / interstitial / splash / rewarded / native / icon / push
        val admType: String,        // html / vast4 / native_json / push
        val html: String = "",      // admType=html 时的 HTML 创意
        val vastUrl: String = "",   // admType=vast4 时的视频地址
        val vastDuration: String = "",
        val nativeJson: String = "",// admType=native_json 时的结构化 JSON
        val pushJson: String = "",  // admType=push 时的推送内容（由推送系统下发）
        val rwToken: String = "",   // 激励视频一次性令牌（仅上报用，不可本地发奖）
        val tracking: Map<String, String> = emptyMap(), // VAST tracking events
        val advertiser: String = "" // 创意归属广告主（归因展示用）
    )

    // ---------- 回调 ----------
    fun interface Listener { fun onAdLoaded(ad: Ad) }
    fun interface FailListener { fun onFailed(error: AdError) }
    interface RewardListener { fun onRewardGranted(reward: String); fun onRewardDenied(error: AdError) }

    // ---------- 内部 ----------
    private val io = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())
    private var currentBannerWebView: WebView? = null

    // ========== ① 竞价请求（统一走 AdSdk.buildBidRequest） ==========
    fun loadBanner(onAd: Listener, onFail: FailListener) = load("banner", onAd, onFail)
    fun loadInterstitial(onAd: Listener, onFail: FailListener) = load("interstitial", onAd, onFail)
    fun loadRewarded(onAd: Listener, onFail: FailListener) = load("rewarded", onAd, onFail)
    fun loadNative(onAd: Listener, onFail: FailListener) = load("native", onAd, onFail)
    fun loadPush(onAd: Listener, onFail: FailListener) = load("push", onAd, onFail)

    /** 通用入口：adType = banner/interstitial/splash/rewarded/native/icon/push */
    fun load(adType: String, onAd: Listener, onFail: FailListener) {
        val base = if (adxBase.isBlank()) AdSdk.serverBase() else adxBase.removeSuffix("/")
        val site = if (siteDomain.isBlank()) AdSdk.config.siteDomain else siteDomain
        val impId = "imp_${UUID.randomUUID()}"
        io.execute {
            try {
                val body = AdSdk.buildBidRequest(impId, adUnitId, adType, site)
                val res = JSONObject(postJson(base + "/ssp/bid", body.toString()))
                val seat = res.optJSONArray("seatbid")?.optJSONObject(0) ?: throw AdException(AdError.NO_FILL)
                val bid = seat.optJSONArray("bid")?.optJSONObject(0) ?: throw AdException(AdError.NO_FILL)
                val adm = bid.optString("adm", "")
                if (adm.isBlank()) throw AdException(AdError.NO_FILL)
                val ext = bid.optJSONObject("ext") ?: JSONObject()
                val fmt = ext.optString("ad_format", adType)
                val admType = ext.optString("adm_type", "html")
                val cid = ext.optString("cid", "")
                val crid = bid.optString("crid", "")
                val advertiser = ext.optString("advertiser", "")

                val (vastUrl, vastDuration, tracking) = if (fmt == "rewarded" && admType == "vast4") {
                    val v = parseVast(adm) ?: throw AdException(AdError.BAD_VAST)
                    Triple(v.mediaUrl, v.duration, v.tracking)
                } else Triple("", "", emptyMap())

                val rw = ext.optJSONObject("rw") ?: JSONObject()
                val ad = Ad(
                    impId = impId, cid = cid, crid = crid, price = bid.optLong("price", 0),
                    format = fmt, admType = admType,
                    html = if (admType == "html") adm else "",
                    vastUrl = vastUrl, vastDuration = vastDuration, tracking = tracking,
                    nativeJson = if (admType == "native_json") adm else "",
                    pushJson = if (admType == "push") (ext.optJSONObject("push")?.toString() ?: "") else "",
                    rwToken = rw.optString("token", ""),
                    advertiser = advertiser
                )
                AdCache.put(adUnitId, ad)   // 自动预缓存，供 loadFromCache 秒出
                main.post { onAd.onAdLoaded(ad) }
            } catch (e: AdException) {
                main.post { onFail.onFailed(e.error) }
            } catch (e: Exception) {
                main.post { onFail.onFailed(AdError.NETWORK) }
            }
        }
    }

    /** 预加载（仅填充 AdCache，不直接渲染）；展示时再用 loadFromCache 秒出 */
    fun preload(adType: String, onReady: (Ad?) -> Unit = { _ -> }) {
        load(adType,
            AdView.Listener { onReady(it) },
            AdView.FailListener { onReady(null) })
    }

    /** 命中预缓存直接展示；未命中回调 NO_FILL */
    fun loadFromCache(adUnitId: String, onAd: Listener, onFail: FailListener) {
        val ad = AdCache.get(adUnitId)
        if (ad != null) onAd.onAdLoaded(ad) else onFail.onFailed(AdError.NO_FILL)
    }

    // ========== ② 渲染 ==========
    /** 渲染 Banner（HTML 创意到内置 WebView） */
    fun setBannerHtml(html: String) {
        val webView = currentBannerWebView ?: WebView(context).also {
            it.layoutParams = LayoutParams(LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
            it.setBackgroundColor(0x00000000)
            addView(it); currentBannerWebView = it
        }
        webView.settings.javaScriptEnabled = true
        webView.settings.loadsImagesAutomatically = true
        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, url: String): Boolean = false
        }
        webView.loadDataWithBaseURL(null, html, "text/html", "UTF-8", null)
    }

    /** 展示全屏插屏（返回 WebView 供调用方添加到 Activity） */
    fun showInterstitial(html: String): WebView {
        val webView = WebView(context)
        webView.layoutParams = FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT)
        webView.setBackgroundColor(0xFFFFFFFF.toInt())
        webView.settings.javaScriptEnabled = true
        webView.settings.loadsImagesAutomatically = true
        webView.loadDataWithBaseURL(null, html, "text/html", "UTF-8", null)
        return webView
    }

    /** 播放激励视频（VideoView + VAST 4.0 tracking）；完播后把观看证据交给 App 服务端 S2S 裁决 */
    fun playRewarded(videoView: VideoView, ad: Ad, onReward: RewardListener) {
        if (ad.vastUrl.isBlank()) { main.post { onReward.onRewardDenied(AdError.BAD_URL) }; return }
        val startMs = System.currentTimeMillis()
        val durationMs = parseDurationMs(ad.vastDuration)
        fireTracking(ad.tracking["impression"], ad)
        videoView.setVideoURI(Uri.parse(ad.vastUrl))
        videoView.setOnPreparedListener {
            fireTracking(ad.tracking["start"], ad)
            videoView.start()
        }
        videoView.setOnCompletionListener {
            val watchedMs = (System.currentTimeMillis() - startMs).toInt()
            fireTracking(ad.tracking["complete"], ad)
            reportToAppServer(ad, watchedMs, durationMs.toInt(), onReward) // ★ 不本地发奖
        }
        videoView.setOnErrorListener { _, _, _ ->
            main.post { onReward.onRewardDenied(AdError.VIDEO_ERROR) }; true
        }
    }

    // ========== ③ VAST 4.0 解析 ==========
    private data class VastAd(val mediaUrl: String, val duration: String, val tracking: Map<String, String>)
    private fun parseVast(xml: String): VastAd? {
        val p = Xml.newPullParser(); p.setInput(xml.reader())
        var mediaUrl = ""; var duration = ""; val tracking = HashMap<String, String>()
        var event = p.eventType; var curEvent: String? = null
        while (event != XmlPullParser.END_DOCUMENT) {
            when (event) {
                XmlPullParser.START_TAG -> when (p.name) {
                    "Duration" -> duration = p.nextText()
                    "Tracking" -> curEvent = p.getAttributeValue(null, "event")
                    "Impression" -> tracking["impression"] = p.nextText()
                }
                XmlPullParser.TEXT -> {
                    val text = p.text.trim()
                    if (text.startsWith("http")) {
                        if (curEvent != null) tracking[curEvent!!] = text
                        else if (mediaUrl.isBlank()) mediaUrl = text
                    }
                }
                XmlPullParser.END_TAG -> if (p.name == "Tracking") curEvent = null
            }
            event = p.next()
        }
        return if (mediaUrl.isBlank()) null else VastAd(mediaUrl, duration, tracking)
    }

    // ========== ④ 结算：上报观看证据给 App 服务端（真正的裁决在服务端） ==========
    private fun reportToAppServer(ad: Ad, watchedMs: Int, durationMs: Int, onReward: RewardListener) {
        val url = if (appServerRewardUrl.isBlank()) AdSdk.config.appServerRewardUrl else appServerRewardUrl
        if (url.isBlank()) { main.post { onReward.onRewardDenied(AdError.NO_REWARD_URL) }; return }
        io.execute {
            try {
                val body = JSONObject().apply {
                    put("impid", ad.impId); put("cid", ad.cid); put("crid", ad.crid)
                    put("token", ad.rwToken)
                    put("watchedMs", watchedMs); put("durationMs", durationMs)
                }
                val r = JSONObject(postJson(url, body.toString()))
                val ok = r.optBoolean("ok", false)
                val reward = r.optString("reward", "")
                val reason = r.optString("reason", "SERVER_DENIED")
                main.post {
                    if (ok) onReward.onRewardGranted(reward) else onReward.onRewardDenied(AdError.SERVER_DENIED)
                }
            } catch (e: Exception) {
                main.post { onReward.onRewardDenied(AdError.NETWORK) }
            }
        }
    }

    // ========== ⑤ 工具方法 ==========
    private fun parseDurationMs(d: String): Long {
        val parts = d.split(":").map { it.toLongOrNull() ?: 0L }
        return if (parts.size == 3) (parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000L else 0L
    }
    private fun fireTracking(url: String?, ad: Ad) {
        if (url.isNullOrBlank()) return
        io.execute {
            try {
                val conn = URL(url).openConnection() as HttpURLConnection
                conn.requestMethod = "GET"; conn.connectTimeout = 5000; conn.responseCode; conn.disconnect()
            } catch (e: Exception) { /* fire-and-forget */ }
        }
    }
    private fun postJson(urlStr: String, body: String): String {
        val conn = URL(urlStr).openConnection() as HttpURLConnection
        return try {
            conn.requestMethod = "POST"
            conn.setRequestProperty("Content-Type", "application/json")
            conn.connectTimeout = 5000; conn.readTimeout = 5000
            conn.doOutput = true
            conn.outputStream.write(body.toByteArray())
            conn.inputStream.bufferedReader().readText()
        } finally { conn.disconnect() }
    }
}
