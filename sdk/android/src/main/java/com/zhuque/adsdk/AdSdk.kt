package com.zhuque.adsdk

import android.content.Context
import android.os.Build
import org.json.JSONArray
import org.json.JSONObject

/**
 * AdSdk —— 全局初始化与隐私合规单例（对标商业 SDK 的 SdkConfiguration / MobileAds.initialize）。
 *
 * 在 Application.onCreate() 调一次 AdSdk.init(...) 即可；之后所有 AdView / RewardedAdSdk 自动共用该配置。
 * 隐私开关用 AdSdk.setConsent(...)。
 *
 * 用法：
 *   AdSdk.init(this, AdSdk.Config(
 *       appKey            = "你的媒体AppKey",
 *       serverUrl         = "https://ssp.your-adx.com",   // OpenRTB SSP 竞价服务基址
 *       appServerRewardUrl = "https://你的服务端/reward",  // 仅激励视频发奖需要
 *       siteDomain        = "mygame.example.com"          // 在 ADX 注册的媒体域名
 *   ))
 */
object AdSdk {

    data class Config(
        val appKey: String,                   // ADX 分配的媒体 AppKey（参与竞价鉴权与发奖 HMAC 签名）
        val serverUrl: String,                // SSP 竞价服务基址，如 https://ssp.your-adx.com
        val appServerRewardUrl: String = "",  // App 自有服务端发奖回调地址（仅激励视频需要）
        val siteDomain: String = "",          // 在 ADX 注册的媒体域名（投放定向 / 归因）
        val appId: String = "",              // 应用ID（归因用，留空取包名）
        val geoCountry: String = "CN",        // 国家码（GDPR 区域判定 / 投放定向）
        val testMode: Boolean = false         // 测试模式：不下发真实计费广告
    )

    /** 隐私合规：GDPR / CCPA / COPPA（对标商业 SDK 的 Consent / Mediation 合规开关） */
    data class Consent(
        val gdprApplies: Boolean = false,     // 是否适用 GDPR（欧洲用户）
        val consentString: String = "",       // TCF v2 同意字符串，或 "1" / "0"
        val ccpaOptOut: Boolean = false,      // CCPA：用户选择退出个性化广告（us_privacy=1---）
        val isChild: Boolean = false          // COPPA：面向儿童，禁止行为定向
    )

    private var _config: Config? = null
    private var _consent: Consent = Consent()
    private var _context: Context? = null

    val isInitialized: Boolean get() = _config != null
    val config: Config
        get() = _config ?: throw IllegalStateException("AdSdk 未初始化：请先在 Application.onCreate() 调用 AdSdk.init(context, config)")
    val consent: Consent get() = _consent
    val appContext: Context
        get() = _context ?: throw IllegalStateException("AdSdk 未初始化：请先在 Application.onCreate() 调用 AdSdk.init(context, config)")

    fun init(context: Context, config: Config) {
        _context = context.applicationContext
        _config = config
    }

    fun setConsent(consent: Consent) { _consent = consent }

    /** SSP 基址（去尾部斜杠） */
    fun serverBase(): String = config.serverUrl.removeSuffix("/")

    /** 是否允许个性化广告（隐私合规闸门；SDK 据此在竞价请求里收窄定向字段） */
    fun allowPersonalization(): Boolean = !consent.ccpaOptOut && !consent.isChild

    /**
     * 构造 OpenRTB 2.5 竞价请求（被 AdView / RewardedAdSdk 复用，保证字段一致）。
     * 结构：app(bundle+publisher.id=appKey) / device(geo) / user(consent) / regs(gdpr,coppa) / imp.ext(ad_unit_id,ad_type) / ext。
     */
    fun buildBidRequest(
        impId: String,
        adUnitId: String,
        adType: String,
        siteDomain: String,
        keywords: String = "",
        bidfloor: Double = 1.0,
        cat: String = ""
    ): JSONObject {
        val c = config
        val ctx = _context!!
        val dm = ctx.resources.displayMetrics
        return JSONObject().apply {
            put("id", impId)
            put("app", JSONObject().apply {
                put("bundle", ctx.packageName)
                put("publisher", JSONObject().apply {
                    put("id", c.appKey)
                    if (siteDomain.isNotBlank()) put("domain", siteDomain)
                })
            })
            put("device", JSONObject().apply {
                put("ua", System.getProperty("http.agent") ?: "")
                put("os", "Android"); put("osv", Build.VERSION.RELEASE)
                put("w", dm.widthPixels); put("h", dm.heightPixels)
                put("make", Build.MANUFACTURER); put("model", Build.MODEL)
                put("geo", JSONObject().put("country", c.geoCountry))
            })
            put("user", JSONObject().put("consent", consent.consentString))
            put("regs", JSONObject().apply {
                put("gdpr", if (consent.gdprApplies) 1 else 0)
                put("coppa", if (consent.isChild) 1 else 0)
            })
            put("imp", JSONArray().put(JSONObject().apply {
                put("id", impId)
                put("bidfloor", bidfloor)
                put("ext", JSONObject().apply {
                    put("ad_unit_id", adUnitId)
                    put("ad_type", adType)
                    if (cat.isNotBlank()) put("cat", cat)
                    if (keywords.isNotBlank()) put("keywords", keywords)
                })
            }))
            put("ext", JSONObject().apply {
                put("app_key", c.appKey)
                put("ccpa_opt_out", if (consent.ccpaOptOut) 1 else 0)
                put("test", c.testMode)
                put("consent", consent.consentString)
            })
        }
    }
}
