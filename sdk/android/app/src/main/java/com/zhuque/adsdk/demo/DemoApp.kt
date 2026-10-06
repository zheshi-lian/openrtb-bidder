package com.zhuque.adsdk.demo

import android.app.Application
import com.zhuque.adsdk.AdSdk

/**
 * 演示用 Application：在 onCreate 做一次全局初始化（对标商业 SDK 的 MobileAds.initialize）。
 * 真实接入时把 appKey / serverUrl / siteDomain / appServerRewardUrl 换成你自己的 ADX 配置。
 */
class DemoApp : Application() {
    override fun onCreate() {
        super.onCreate()
        AdSdk.init(
            this,
            AdSdk.Config(
                appKey = "demo_appkey",
                serverUrl = "https://dellai.xyz",          // 接真实 SSP 时改成你的 SSP 基址
                siteDomain = "demo.example.com",
                appServerRewardUrl = "https://demo.example.com/reward" // 仅激励视频发奖需要
            )
        )
    }
}
