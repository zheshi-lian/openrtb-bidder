package com.zhuque.adsdk

import android.os.Handler
import android.os.Looper
import android.util.Xml
import android.widget.VideoView
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

/**
 * RewardedAdSdk —— 激励视频原生 SDK（Android 原型）
 *
 * 【责任边界｜客户端不可信原则】
 *   1. SDK 负责：向 ADX 竞价 → 解析 VAST 4.0 → 播放视频 → 上报 tracking → 把「观看证据」交给 App 服务端
 *   2. SDK **绝不自行判定是否发奖**；由 App 服务端 S2S 回调 ADX `/s2s/reward`（HMAC 签名）裁决
 *   3. 奖励由 App 服务端下发到用户账户（服务端到服务端，客户端无法伪造）
 *
 * 【服务端约定】App 服务端收到观看证据后应调用：
 *   POST {ADX}/s2s/reward  body: { impid, cid, publisher, watchedMs, durationMs, ts, sig }
 *   sig = HMAC_SHA256(api_key, "impid|cid|watchedMs|durationMs|ts")
 *
 * 【用法】
 *   RewardedAdSdk.load(cfg, "休闲游戏,激励视频", object : RewardedAdSdk.LoadCallback {
 *       override fun onLoaded(ad: RewardedAdSdk.Ad) {
 *           RewardedAdSdk.show(videoView, ad, object : RewardedAdSdk.RewardCallback {
 *               override fun onGranted(reward: String) { /* 发道具 */ }
 *               override fun onDenied(reason: String) { /* 不给 */ }
 *           })
 *       }
 *       override fun onFailed(reason: String) {}
 *   })
 */
object RewardedAdSdk {

    data class Config(
        val adxBase: String,            // 例 "https://calendar.dellai.xyz"
        val siteDomain: String,         // 须与 ADX 注册的 publisher 域名一致
        val appServerRewardUrl: String  // App 服务端接口：由它做 S2S 签名回调
    )

    data class Ad(
        val impid: String,
        val cid: String,
        val priceMicros: Long,
        val mediaUrl: String,
        val duration: String,
        val tracking: Map<String, String>,   // impression/start/firstQuartile/midpoint/thirdQuartile/complete
        val rawVast: String,
        val appServerRewardUrl: String
    )

    interface LoadCallback { fun onLoaded(ad: Ad); fun onFailed(reason: String) }
    interface RewardCallback { fun onGranted(reward: String); fun onDenied(reason: String) }

    private val io = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())

    // ---------- 竞价：向 ADX 请求激励视频（OpenRTB） ----------
    fun load(cfg: Config, keywords: String, cb: LoadCallback) {
        io.execute {
            try {
                val impid = "rw_and_${System.currentTimeMillis()}"
                val body = JSONObject().apply {
                    put("id", impid)
                    put("site", JSONObject().put("domain", cfg.siteDomain).put("keywords", keywords))
                    put("imp", JSONArray().put(JSONObject().apply {
                        put("id", impid)
                        put("bidfloor", 2.0)
                        put("ext", JSONObject().put("cat", "gaming").put("ad_type", "rewarded"))
                    }))
                    put("device", JSONObject().put("geo", JSONObject().put("country", "CN")))
                }
                val res = JSONObject(postJson(cfg.adxBase + "/ssp/bid", body.toString()))
                val bids = res.optJSONArray("seatbid")?.optJSONObject(0)?.optJSONArray("bid")
                val bid = bids?.optJSONObject(0) ?: run { fail(cb, "NO_FILL"); return@execute }
                val adm = bid.optString("adm", "")
                val vast = parseVast(adm)
                if (vast == null || vast.mediaUrl.isBlank()) { fail(cb, "BAD_VAST"); return@execute }
                val ext = bid.optJSONObject("ext")
                val ad = Ad(
                    impid = impid,
                    cid = ext?.optString("cid", "") ?: "",
                    priceMicros = bid.optLong("price"),
                    mediaUrl = vast.mediaUrl,
                    duration = vast.duration,
                    tracking = vast.tracking,
                    rawVast = adm,
                    appServerRewardUrl = cfg.appServerRewardUrl
                )
                main.post { cb.onLoaded(ad) }
            } catch (e: Exception) {
                fail(cb, e.message ?: "ERROR")
            }
        }
    }

    // ---------- 播放：渲染 VAST 素材并按进度上报 tracking ----------
    fun show(videoView: VideoView, ad: Ad, cb: RewardCallback) {
        val fired = HashSet<String>()
        fun track(ev: String) {
            val url = ad.tracking[ev] ?: return
            if (fired.add(ev)) io.execute { fireGet(url) }
        }
        track("impression")

        videoView.setVideoPath(ad.mediaUrl)
        videoView.setOnPreparedListener { mp ->
            mp.setOnVideoSizeChangedListener { _, _, _, _, _ -> }
            videoView.start()
            track("start")
        }

        val progressHandler = Handler(Looper.getMainLooper())
        val ticker = object : Runnable {
            override fun run() {
                val dur = videoView.duration
                if (dur > 0) {
                    val r = videoView.currentPosition.toFloat() / dur
                    if (r >= 0.25f) track("firstQuartile")
                    if (r >= 0.50f) track("midpoint")
                    if (r >= 0.75f) track("thirdQuartile")
                    if (r >= 0.95f) return  // 交由 OnCompletionListener 处理结算，避免重复
                }
                progressHandler.postDelayed(this, 250)
            }
        }
        progressHandler.post(ticker)

        videoView.setOnCompletionListener {
            progressHandler.removeCallbacks(ticker)
            track("complete")
            // ★ 不自己发奖：把观看证据交给 App 服务端，由它 S2S 回调 ADX 裁决
            reportToAppServer(ad, videoView.duration, videoView.duration, cb)
        }
    }

    // ---------- 结算：上报观看证据给 App 服务端（真正的裁决在服务端） ----------
    private fun reportToAppServer(ad: Ad, watchedMs: Int, durationMs: Int, cb: RewardCallback) {
        io.execute {
            try {
                val body = JSONObject().apply {
                    put("impid", ad.impid)
                    put("cid", ad.cid)
                    put("watchedMs", watchedMs)
                    put("durationMs", durationMs)
                }
                val r = JSONObject(postJson(ad.appServerRewardUrl, body.toString()))
                val ok = r.optBoolean("ok", false)
                val reward = r.optString("reward", "")
                val reason = r.optString("reason", "SERVER_DENIED")
                main.post { if (ok) cb.onGranted(reward) else cb.onDenied(reason) }
            } catch (e: Exception) {
                main.post { cb.onDenied("NETWORK") }
            }
        }
    }

    // ---------- VAST 4.0 解析 ----------
    private data class VastAd(val mediaUrl: String, val duration: String, val tracking: Map<String, String>)

    private fun parseVast(xml: String): VastAd? {
        val p = Xml.newPullParser()
        p.setInput(xml.reader())
        var mediaUrl = ""
        var duration = ""
        val tracking = HashMap<String, String>()
        var event = p.eventType
        var curEvent: String? = null
        while (event != XmlPullParser.END_DOCUMENT) {
            when (event) {
                XmlPullParser.START_TAG -> when (p.name) {
                    "MediaFile" -> { /* CDATA 作为 text 出现在下个 TEXT 事件 */ }
                    "Duration" -> duration = p.nextText()
                    "Tracking" -> curEvent = p.getAttributeValue(null, "event")
                    "Impression" -> tracking["impression"] = p.nextText()
                }
                XmlPullParser.TEXT -> {
                    val text = p.text.trim()
                    if (text.startsWith("http")) {
                        if (curEvent != null) tracking[curEvent!!] = text else if (mediaUrl.isBlank()) mediaUrl = text
                    }
                }
                XmlPullParser.END_TAG -> if (p.name == "Tracking") curEvent = null
            }
            event = p.next()
        }
        return if (mediaUrl.isBlank()) null else VastAd(mediaUrl, duration, tracking)
    }

    // ---------- HTTP ----------
    private fun postJson(urlStr: String, body: String): String {
        val conn = URL(urlStr).openConnection() as HttpURLConnection
        return try {
            conn.requestMethod = "POST"
            conn.setRequestProperty("Content-Type", "application/json")
            conn.doOutput = true
            conn.outputStream.write(body.toByteArray())
            conn.inputStream.bufferedReader().readText()
        } finally { conn.disconnect() }
    }

    private fun fireGet(urlStr: String) {
        val conn = URL(urlStr).openConnection() as HttpURLConnection
        try { conn.requestMethod = "GET"; conn.responseCode } finally { conn.disconnect() }
    }

    private fun fail(cb: LoadCallback, reason: String) { main.post { cb.onFailed(reason) } }
}
