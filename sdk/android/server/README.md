# 参考服务端（P2 · 真实闭环 · 真实竞价版）

SDK 只做客户端。**竞价必须由真实 SSP 服务端完成**，发奖必须由服务端裁决。本目录给一套可跑的参考实现，
让你在本地把 SDK 的「竞价 → 展示 → 完播 → 发奖」整条链路跑通，再平滑替换成生产服务。

```
 Android SDK ──/ssp/bid──▶  ADX (ssp.py :8080)
     │                            │
     ├──/track  /click──▶ 事件落 SQLite（曝光/进度/完播/点击）
     └──/reward(证据)──▶ App 服务端 (app_server.py :8090) ──HMAC签名──▶ ADX /s2s/reward
```

## 本版修掉的四个问题

| # | 问题 | 现在的实现 |
|---|---|---|
| 1 | `/ssp/bid` 出价硬编码（`1500000` / `3000000`） | **真实竞价**：候选计划 → 相关性(品类/关键词) → eCPM 折算(CPM/CPC/CPA) → 学习系数 → 底价过滤 → 排序 → **二价清算**（`second+¥0.01`） |
| 2 | 素材写死 BigBuckBunny 演示视频 | 素材由**投放计划声明**（`campaigns.json` 的 `media_url`，支持 `${ENV}` 占位符与自托管 `./creatives/`）；缺素材的计划不参竞并给出告警 |
| 3 | 无持久化 / 无日志 | SQLite（`adx_ssp.db`）落 `bid_log` / `events` / `rewards` / `ad_tokens` / `fraud_hits` / `blacklist` / `creative_stats`，外加滚动日志 `ssp.log` 与结构化 audit 行 |
| 4 | 反作弊只有「防重放」 | 10 条规则 + 风险分 + 自动拉黑，见下 |

## 1. 本地联调

```bash
export ADX_VIDEO_URL=https://你的CDN/app.mp4     # 视频素材（必填，否则 rewarded 类计划不参竞）
export ADX_CLICK_URL=https://你的落地页           # 可选
export ADX_API_KEY=$(openssl rand -hex 32)       # 生产必须注入，勿用默认 demo_api_key
python ssp.py                                     # ADX 侧：:8080
python app_server.py                              # App 侧：:8090 接收 SDK 证据并签名转发
```

> 若 Node 版 ADX 已占用 8080，用 `SSP_PORT=8091 python ssp.py` 换个端口。

然后把 mp4 丢进 `./creatives/` 也可以：`ssp.py` 会自动把 `creatives/c_<cid>.mp4` / `creatives/default.mp4`
映射成 `http://host/media/<name>` 并填入 VAST。

## 2. 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `ADX_API_KEY` | `demo_api_key` | HMAC 密钥，**生产必须注入** |
| `SSP_PORT` | `8080` | 监听端口 |
| `ADX_DB` | `./adx_ssp.db` | SQLite 路径 |
| `ADX_LOG` | `./ssp.log` | 滚动日志（5MB × 3） |
| `ADX_CONFIG` | `./campaigns.json` | 投放计划与媒体 App |
| `ADX_CREATIVE_DIR` | `./creatives` | 自托管素材目录 |
| `ADX_PUBLIC_BASE` | 空（取请求 Host） | beacon 绝对地址，如 `https://ssp.your-adx.com` |
| `ADX_AUCTION` | `second_price` | 二价清算；设 `first_price` 做对照 |
| `ADX_STRICT` | `1` | 风险分 ≥60 直接不填充（关掉则仅记录不拦截） |

## 3. 竞价逻辑（`POST /ssp/bid`）

```
eCPM = bid × 折算系数 × 相关性 × 学习系数
  CPM : bid                        (bid = 每千次曝光报价)
  CPC : bid × pCTR × 1000
  CPA : bid × pCTR × pCVR × 1000
相关性  = 广告形态必须匹配；品类命中 ×1.25 / 不命中 ×0.85；关键词命中 ±(0.1/0.05)，钳制在 [0.5,1.5]
学习系数 = 用 SQLite 里真实曝光/点击做贝叶斯平滑(先验 20 次曝光)反算，钳制在 [0.7,1.3]
清算价  = min(最高eCPM, 次高eCPM + ¥0.01)，且不低于 bidfloor
```

响应 `ext` 回传本次竞价的可验证信息：

```json
{ "participant_count": 2, "winner": "c_game", "second_price_micros": 21420000,
  "clearing_price_micros": 21430000, "auction": "second_price",
  "waterfall": [{"cid":"c_game","ecpm_micros":118125000}] }   // 请求带 "trace": true 时给出
```

不填充时给出 OpenRTB 风格原因：`nbr=2`(appKey/请求无效) / `101`(无满足底价的计划) / `102`(风控拦截)。

## 4. 反作弊规则

竞价期：

| 规则 | 触发 | 风险分 |
|---|---|---|
| `APP_KEY_UNKNOWN` / `APP_DISABLED` | appKey 不在 `apps` 表（改为查库，不再写死白名单） | 直接拦截 `nbr=2` |
| `BAD_UA` | UA 不像 Dalvik/Android/okhttp | +30 |
| `EMULATOR` | make/model 含 goldfish/ranchu/sdk_gphone/genymotion/nox 等 | +30 |
| `NO_DEVICE_INFO` | 缺 make/model | +10 |
| `RATE_LIMIT_APP_IP` | 同一 (app,ip) 60s 内 >120 次 | +50 |
| `RATE_LIMIT_DEVICE` | 同一设备指纹 60s 内 >40 次 | +40 |
| `REPLAY_IMPID` | 同一 impid 120s 内重复竞价 | +60 |

风险分 ≥ 60 且 `ADX_STRICT=1` → 返回 `nbr=102` 不填充。

发奖期（在原有「HMAC 签名 + 5 分钟时效 + 一次性令牌」之外）：

| reason | 含义 |
|---|---|
| `TOKEN_UNKNOWN` / `TOKEN_REPLAY` / `TOKEN_EXPIRED` / `TOKEN_MISMATCH` | 令牌不存在 / 已用过 / 过期 / 与 cid·impid 不符 |
| `SUSPECT_TIME` | `watchedMs > durationMs × 1.05`（篡改播放进度） |
| `SUSPECT_DURATION` | 上报时长与计划声明时长偏差 >20% |
| `TOO_FAST` | 曝光到主张完播的间隔 < 视频时长 × 0.9（物理上不可能） |
| `NO_IMPRESSION` | 没有该 impid 的曝光事件（无机票不发奖） |
| `CAP_EXCEEDED` / `IMP_CAP` | 同 IP 每小时 >200 次发奖 / 同 impid 每小时 >20 次 |
| `INCOMPLETE` | 完播比 < 0.95 |

同一主体 10 分钟内命中 ≥5 次 → 自动写入 `blacklist` 封禁 1 小时。

## 5. 数据落库（可复盘 / 可审计）

- `bid_log`：每次竞价的 floor / 候选数 / 参拍数 / 胜出 / 出价 / 次高价 / 清算价 / 延迟 / 风险分
- `events`：曝光 / start / 四分位 / 完播 / 点击 beacon（`GET /track`）
- `rewards`：每次发奖裁决（含拒绝原因与风险分）
- `creative_stats`：按计划的曝光/点击/转化累计 → 回流为出价的学习系数
- `fraud_hits` / `blacklist`：风控命中与自动封禁

`GET /health` 返回各表行数与启用计划数，方便冒烟检查。

## 6. 接口契约

### `POST /ssp/bid`（SDK → ADX，OpenRTB 2.5 子集）

请求（`AdSdk.buildBidRequest` 产出）不变；响应新增 `cid`/`auction` 等字段，价格已是**竞价清算价**：

```json
{ "id": "imp_xxx", "cur": "CNY",
  "seatbid": [ { "seat": "applink", "bid": [ {
    "id": "bid_c_game_imp_xxx", "impid": "imp_xxx", "price": 21430000,
    "adm": "<HTML 或 VAST XML>", "crid": "cr_c_game", "cid": "c_game",
    "ext": { "cid": "c_game", "ad_format": "rewarded", "adm_type": "vast4",
             "advertiser": "示例广告主", "bid_type": "CPA", "auction": "second_price",
             "rw": { "token": "<一次性令牌>", "expires_at": 1791000000 } }
  } ] } ],
  "ext": { "participant_count": 2, "winner": "c_game",
           "second_price_micros": 21420000, "clearing_price_micros": 21430000 } }
```

### `POST /s2s/reward`（App 服务端 → ADX）

请求不变（`impid|cid|token|watchedMs|durationMs|ts` 的 HMAC 签名）；
成功返回 `{"ok":true,"reward":"100金币","charged_micros":21430000}`，拒绝返回 `{"ok":false,"reason":"..."}`。

## 7. 生产替换清单

1. **替换 `/ssp/bid`**：用你的真实 SSP 实现同样的竞价逻辑（`app.publisher.id` 鉴权、`imp.ext.ad_type` 区分形态），价格必须是竞价结果，不能是常量。
2. **保留 `app_server.py`**（或自有 App 服务端）：持有 `api_key`、做 HMAC 签名、转发 `/s2s/reward`。**`api_key` 只能在服务端，SDK 永不持有**。
3. **素材**：真实投放素材由计划配置注入，`ADX_VIDEO_URL` 之类只作占位符，不要提交真实 CDN 地址以外的硬编码演示 URL。
4. **持久化**：SQLite 仅适合单机参考实现；多实例请换成 MySQL/Redis，尤其是滑动窗口频控。
5. **HTTPS + KMS**：`api_key` 通过环境变量/KMS 注入，全部端点走 HTTPS。

## 8. 安全要点

- 客户端不可信：SDK 只转发「观看证据」，不判定、不签名、不持有 `api_key`。
- 防刷是多层叠加：令牌一次性 + 5 分钟时效 + 完播阈值 + 时长合理性 + 时序校验 + 频控 + 自动拉黑，而非单点。
- 所有拒绝原因都落 `rewards` / `fraud_hits`，可对账、可调阈值。
