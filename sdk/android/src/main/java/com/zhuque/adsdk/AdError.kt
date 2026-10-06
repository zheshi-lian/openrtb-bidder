package com.zhuque.adsdk

/**
 * 标准化错误码（对标商业 SDK 的 AdError / ErrorCode）。
 * 回调统一返回 AdError，便于媒体按 code 做分类处理与埋点。
 */
enum class AdError(val code: Int, val reason: String) {
    NO_FILL(1001, "没有可用广告（竞价未胜出）"),
    BAD_VAST(1002, "VAST 解析失败"),
    BAD_URL(1003, "素材地址无效"),
    VIDEO_ERROR(1004, "视频播放出错"),
    NO_REWARD_URL(1005, "未配置发奖服务端地址（appServerRewardUrl）"),
    NETWORK(1006, "网络错误"),
    SERVER_DENIED(1007, "服务端拒绝发奖"),
    UNKNOWN(1099, "未知错误");

    companion object {
        fun from(msg: String): AdError =
            entries.firstOrNull { it.reason == msg } ?: UNKNOWN
    }

    override fun toString(): String = "AdError($code, $reason)"
}

/** 可抛出的 SDK 异常（携带 AdError），用于在 load 内部中断并回传标准化错误码 */
class AdException(val error: AdError) : Exception(error.reason)
