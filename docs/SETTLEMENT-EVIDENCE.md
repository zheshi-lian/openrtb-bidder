# 全链路本地跑通 · 结算证据（Settlement Evidence）

> 验证日期：2026-09-30
> 组件：ADX（`server.js`，`:8080`）+ 媒体服务端（`sdk/media-server/appServer.js`，`:8081`）
> 媒体方：`dellai.xyz`（已入驻，payout_rate=0.70，api_key=`pub_7ade5a95...`）
> 演示广告主/创意：软考 campaign **#159**（advertiser=自有软考，landing=https://dellai.xyz/ruankao）

## 链路概览（S2S 结算权威模型）
1. 媒体方 App SDK 发起 `/ssp/bid` → ADX 二价拍卖 → 自有 DSP `zhuque-dsp` 中标。
2. ADX 落库 `bid_win_log`（胜出记录）+ 签发一次性 `rw_token`（绑定 impid/设备指纹，前端无法伪造完播）。
3. 客户端播放完 → 媒体**服务端**（非客户端）用 `api_key` 做 HMAC 签名，回调 ADX `/s2s/reward`。
4. ADX 权威裁决：签名校验 / 时间戳 / 曝光存在性 / 令牌未用 / 设备指纹 / 完播比例 → 通过才 `GRANTED` 并记 `reward_log`+`conv_log`。
5. 媒体服务端仅当 ADX `granted=true` 才下发用户奖励（内存账本，生产落库）。

## 一、软考 campaign #159 真实参拍并中标（教育上下文）
请求（cat=education, keywords=软考,exam,education）：
```json
{ "seat":"zhuque-dsp", "cid":159, "price":16000000,
  "intent_score":0.46, "intent_source":"heuristic",
  "rw_token":"3d39130dc361e959706a6479..." }
```
- 清盘价 16,000,000 micros = **¥16.00 CPM（二价）**；出价基数 13e6，意图加成 +23%。
- `bid_win_log` 审计：impid=`ruankao_chain_...`, campaign_id=159, price_micros=16000000, publisher=dellai.xyz。

## 二、媒体服务端 S2S 结算 + ADX 裁决（权威）
### 2.1 正常完播（watched 30000 / duration 30000，ratio=1.0）
```
POST /api/reward -> { "ok":true, "reward":"复活道具×1", "balance":1,
  "adx":{ "ok":true, "granted":true, "counted":true, "ratio":1,
          "settlement":"server-authoritative", "deviceFpCount":1 } }
```
`reward_log` 落：`status=S2S_GRANTED, ratio=1.000`；`conv_log` 落：`type=conversion`。

### 2.2 反作弊裁决（media-server `/api/selftest` 四类用例）
| 用例 | 结果 |
|---|---|
| 正常回调（ratio=1.0） | HTTP 200 **GRANTED** |
| 错误签名（badSig） | HTTP 403 REJECT **BAD_S2S_SIGNATURE** |
| 过期时间戳（ts−10min） | HTTP 403 REJECT **TIMESTAMP_EXPIRED** |
| 谎报时长（800/52000） | HTTP 400 REJECT **INCOMPLETE_WATCH**（ratio<0.95） |

### 2.3 单独反例（软考链路上验证）
- 谎报完播 800/30000 → `INCOMPLETE_WATCH` 拒绝。
- 同 impid 重复领奖 → `TOKEN_ALREADY_SETTLED`（重放保护）拒绝。
- 客户端永远拿不到 `api_key`，无法伪造 HMAC 签名 → 杜绝客户端自证完播刷量。

## 三、结算审计轨迹（DB 证据）
```
reward_log (campaign 159)
  {"imp_id":"ruankao_chain_...","campaign_id":159,"publisher":"dellai.xyz","ratio":"1.000","status":"S2S_GRANTED"}
  {"imp_id":"ruankao_cheat_...","campaign_id":159,"publisher":"dellai.xyz","ratio":"0.000","status":"S2S_REJECT_INCOMPLETE_WATCH"}
  {"imp_id":"ruankao_chain_...","campaign_id":159,"publisher":"dellai.xyz","ratio":"0.000","status":"S2S_REJECT_TOKEN_ALREADY_SETTLED"}
bid_win_log (campaign 159)  -> price_micros=16000000, publisher=dellai.xyz
conv_log   (campaign 159)  -> type=conversion, publisher=dellai.xyz
```

## 四、复跑命令
```bash
# 终端1：ADX
node server.js
# 终端2：媒体服务端（自动从 ADX 拉取 dellai.xyz 的 api_key）
PUBLISHER=dellai.xyz node sdk/media-server/appServer.js
# 结算裁决自检
curl http://127.0.0.1:8081/api/selftest
# 媒体服务端奖励账本
curl http://127.0.0.1:8081/api/ledger
```

## 结论
- 整条链路（竞价 → 中标 → 完播 → 媒体服务端 S2S 回调 → ADX 权威裁决 → 账本记账）**本地跑通**。
- S2S 结算模型有效：客户端无法伪造完播，四类异常（错签/过期/谎报/重放）均被 ADX 正确拒绝。
- 真实软考 campaign #159（advertiser + creative id=8）已激活，并在教育上下文**胜出并成功结算**。
