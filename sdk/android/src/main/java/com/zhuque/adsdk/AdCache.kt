package com.zhuque.adsdk

import java.util.LinkedHashMap

/**
 * 简单 LRU 广告缓存（按 adUnitId 预加载，展示时命中即秒出，对标商业 SDK 的 AdLoader 预缓存）。
 * 所有形态（banner/interstitial/native/push/rewarded）统一缓存为 AdView.Ad，便于 AdView.loadFromCache 命中。
 */
object AdCache {
    private const val MAX = 20
    private val map = LinkedHashMap<String, AdView.Ad>(MAX + 1, 0.75f, true)

    @Synchronized
    fun put(adUnitId: String, ad: AdView.Ad) {
        map[adUnitId] = ad
        if (map.size > MAX) map.remove(map.keys.first())
    }

    @Synchronized
    fun get(adUnitId: String): AdView.Ad? = map[adUnitId]

    @Synchronized
    fun remove(adUnitId: String) { map.remove(adUnitId) }

    @Synchronized
    fun clear() = map.clear()
}
