import Foundation
import AVKit
import UIKit

/// RewardedAdSdk —— 激励视频原生 SDK（iOS 原型）
///
/// 【责任边界｜客户端不可信原则】
///   1. SDK 负责：向 ADX 竞价 → 解析 VAST 4.0 → 播放视频 → 上报 tracking → 把「观看证据」交给 App 服务端
///   2. SDK **绝不自行判定是否发奖**；由 App 服务端 S2S 回调 ADX `/s2s/reward`（HMAC 签名）裁决
///   3. 奖励由 App 服务端下发到用户账户（服务端到服务端，客户端无法伪造）
///
/// 【服务端约定】App 服务端收到观看证据后调用：
///   POST {ADX}/s2s/reward  body: { impid, cid, publisher, watchedMs, durationMs, ts, sig }
///   sig = HMAC_SHA256(api_key, "impid|cid|watchedMs|durationMs|ts")
///
/// 【用法】
///   RewardedAdSdk.shared.load(cfg: cfg, keywords: "休闲游戏,激励视频") { result in
///       switch result {
///       case .success(let ad):
///           RewardedAdSdk.shared.show(from: self, ad: ad) { granted, rewardOrReason in
///               granted ? grantItem(rewardOrReason) : print("拒绝:", rewardOrReason)
///           }
///       case .failure(let e): print(e)
///       }
///   }
public final class RewardedAdSdk {

    public struct Config {
        public let adxBase: String            // 例 "https://calendar.dellai.xyz"
        public let siteDomain: String         // 须与 ADX 注册的 publisher 域名一致
        public let appServerRewardUrl: String // App 服务端接口：由它做 S2S 签名回调
        public init(adxBase: String, siteDomain: String, appServerRewardUrl: String) {
            self.adxBase = adxBase; self.siteDomain = siteDomain; self.appServerRewardUrl = appServerRewardUrl
        }
    }

    public struct Ad {
        public let impid: String
        public let cid: String
        public let priceMicros: Int64
        public let mediaUrl: URL
        public let duration: String
        public let tracking: [String: String]   // impression/start/firstQuartile/midpoint/thirdQuartile/complete
        public let appServerRewardUrl: String
    }

    public static let shared = RewardedAdSdk()
    private init() {}

    // ---------- 竞价：向 ADX 请求激励视频（OpenRTB） ----------
    public func load(cfg: Config, keywords: String, completion: @escaping (Result<Ad, Error>) -> Void) {
        let impid = "rw_ios_\(Int(Date().timeIntervalSince1970 * 1000))"
        let body: [String: Any] = [
            "id": impid,
            "site": ["domain": cfg.siteDomain, "keywords": keywords],
            "imp": [["id": impid, "bidfloor": 2.0, "ext": ["cat": "gaming", "ad_type": "rewarded"]]],
            "device": ["geo": ["country": "CN"]]
        ]
        guard let url = URL(string: cfg.adxBase + "/ssp/bid"),
              let data = try? JSONSerialization.data(withJSONObject: body) else {
            completion(.failure(NSError(domain: "sdk", code: -1, userInfo: [NSLocalizedDescriptionKey: "bad request"])))
            return
        }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = data
        URLSession.shared.dataTask(with: req) { d, _, err in
            if let err = err { return completion(.failure(err)) }
            guard let d = d,
                  let json = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
                  let seat = (json["seatbid"] as? [[String: Any]])?.first,
                  let bid = (seat["bid"] as? [[String: Any]])?.first,
                  let adm = bid["adm"] as? String else {
                return completion(.failure(NSError(domain: "sdk", code: -2, userInfo: [NSLocalizedDescriptionKey: "NO_FILL"])))
            }
            guard let vast = VastParser.parse(adm), let media = URL(string: vast.mediaUrl) else {
                return completion(.failure(NSError(domain: "sdk", code: -3, userInfo: [NSLocalizedDescriptionKey: "BAD_VAST"])))
            }
            let ext = bid["ext"] as? [String: Any]
            let ad = Ad(
                impid: impid,
                cid: (ext?["cid"] as? String) ?? "",
                priceMicros: (bid["price"] as? NSNumber)?.int64Value ?? 0,
                mediaUrl: media,
                duration: vast.duration,
                tracking: vast.tracking,
                appServerRewardUrl: cfg.appServerRewardUrl
            )
            completion(.success(ad))
        }.resume()
    }

    // ---------- 播放：渲染 VAST 素材并按进度上报 tracking ----------
    public func show(from vc: UIViewController, ad: Ad, cb: @escaping (_ granted: Bool, _ rewardOrReason: String) -> Void) {
        var fired = Set<String>()
        func track(_ ev: String) {
            if fired.contains(ev) { return }
            guard let u = ad.tracking[ev], let url = URL(string: u) else { return }
            fired.insert(ev)
            URLSession.shared.dataTask(with: url).resume()
        }
        track("impression")

        let player = AVPlayer(url: ad.mediaUrl)
        let pvc = AVPlayerViewController()
        pvc.player = player
        vc.present(pvc, animated: true) {
            player.play()
            track("start")
        }

        // 播放进度 → 四分位上报
        let obs = player.addPeriodicTimeObserver(forInterval: CMTime(value: 1, timescale: 4), queue: .main) { t in
            guard let dur = player.currentItem?.duration.seconds, dur > 0 else { return }
            let r = t.seconds / dur
            if r >= 0.25 { track("firstQuartile") }
            if r >= 0.50 { track("midpoint") }
            if r >= 0.75 { track("thirdQuartile") }
        }

        // 完播 → 不自己发奖，交 App 服务端裁决
        NotificationCenter.default.addObserver(forName: .AVPlayerItemDidPlayToEndTime,
                                               object: player.currentItem, queue: .main) { _ in
            track("complete")
            player.removeTimeObserver(obs)
            let total = player.currentItem?.duration.seconds ?? 0
            pvc.dismiss(animated: true) {
                self.reportToAppServer(ad: ad, watchedMs: Int(total * 1000), durationMs: Int(total * 1000), cb: cb)
            }
        }
    }

    // ---------- 结算：上报观看证据给 App 服务端（真正的裁决在服务端） ----------
    private func reportToAppServer(ad: Ad, watchedMs: Int, durationMs: Int,
                                   cb: @escaping (_ granted: Bool, _ rewardOrReason: String) -> Void) {
        let body: [String: Any] = ["impid": ad.impid, "cid": ad.cid,
                                   "watchedMs": watchedMs, "durationMs": durationMs]
        guard let url = URL(string: ad.appServerRewardUrl),
              let data = try? JSONSerialization.data(withJSONObject: body) else {
            cb(false, "BAD_CONFIG"); return
        }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = data
        URLSession.shared.dataTask(with: req) { d, _, err in
            if let err = err { return cb(false, err.localizedDescription) }
            guard let d = d, let json = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else {
                return cb(false, "BAD_RESPONSE")
            }
            let ok = (json["ok"] as? Bool) ?? false
            cb(ok, ok ? ((json["reward"] as? String) ?? "") : ((json["reason"] as? String) ?? "SERVER_DENIED"))
        }.resume()
    }
}

// ---------- VAST 4.0 解析 ----------
private final class VastParser: NSObject, XMLParserDelegate {
    var mediaUrl = "", duration = ""
    var tracking: [String: String] = [:]
    private var curEvent: String?, curTag = "", buf = ""

    static func parse(_ xml: String) -> (mediaUrl: String, duration: String, tracking: [String: String])? {
        let p = VastParser()
        let parser = XMLParser(data: Data(xml.utf8))
        parser.delegate = p
        guard parser.parse(), !p.mediaUrl.isEmpty else { return nil }
        return (p.mediaUrl, p.duration, p.tracking)
    }

    func parser(_ parser: XMLParser, didStartElement elementName: String,
                namespaceURI: String?, qualifiedName qName: String?, attributes: [String: String] = [:]) {
        curTag = elementName; buf = ""
        if elementName == "Tracking" { curEvent = attributes["event"] }
    }
    func parser(_ parser: XMLParser, foundCharacters string: String) { buf += string }
    func parser(_ parser: XMLParser, didEndElement elementName: String,
                namespaceURI: String?, qualifiedName qName: String?) {
        let t = buf.trimmingCharacters(in: .whitespacesAndNewlines)
        switch elementName {
        case "MediaFile":  mediaUrl = t
        case "Duration":   duration = t
        case "Impression": tracking["impression"] = t
        case "Tracking":   if let e = curEvent { tracking[e] = t }
        default: break
        }
        buf = ""; curEvent = nil
    }
}
