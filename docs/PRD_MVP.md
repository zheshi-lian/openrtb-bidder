# MVP 一页式 PRD 骨架 · AI 广告交易与创意自动化平台

> 目标：把"造得出创意 → 存得进素材库 → 投得出去 → 效果回得来 → 模型越来越准"闭合成一条可演示、可验证的链路。
> 对标精髓：**AppLovin 的 One Engine（统一 AI 引擎）+ 数据飞轮**；创意自动化对标 SparkLabs（创意即服务，降 CAC）。

---

## 1. 一句话定位
面向广告主 / 媒体方 / DSP 的 **AI 驱动广告交易 + 创意自动化** 平台：用统一优化引擎连接需求与供给，用创意自动化降低素材生产成本，用真实转化回流持续抬高 ROI。

## 2. 端到端闭环（目标态）
```
广告主预算
  → [创意自动化 SparkLabs] 生产多形态/多语言/可玩创意
  → [素材管理 CMS] 入库、绑定 campaign_id、审核、A/B 版本治理
  → [Exchange/Bidder] 统一竞价清算（对标 ALX/MAX）
  → [One Engine] pCTR/pCVR/pLTV 出价 + 创意优选（对标 AXON）
  → 媒体渲染（6 形态：rewarded/interstitial/splash/native/icon/push）
  → 曝光/点击/转化 → [归因 Attribution]
  → 标签回流 One Engine（飞轮）→ 出价与创意优选持续变准
  → 结算/报表按媒体方归因
```

## 3. 模块职责与成熟度（现状盘点）
| 模块 | 对标 | 现状 | 成熟度 |
|---|---|---|---|
| 创意自动化 `creative-auto.html` + `creative/` | SparkLabs | 5 能力齐全，但产物**只预览不入库** | 🟡 已打通入库(本次) |
| 素材管理 `creative.html` | CMS | 增删改查 + A/B 列表 | 🟢 可用 |
| 创意 A/B 优选 `creative_ab.js` | — | Thompson Sampling，转化回流 `bump` | 🟢 可用 |
| 竞价清算 `/ssp/bid` `/openrtb2/bid` | ALX / MAX | 二价/一价、shading、pacing、品牌安全 pre-bid | 🟢 可用 |
| **统一优化引擎 `ml/`** | **AXON** | `multi_objective` ESMM + `feature_store` + `calibration` + `bandit` + `registry` | 🟢 骨架在 / 🟡 预训练未灌入 |
| 归因 `attribution/` | Adjust | 多触点/SKAN/增量/浏览归因 | 🟢 可用 |
| 转化回流 `/api/track/conversion` `/ssp/click` | — | 点击/转化 → `ml.onConversion` + `creativeAb.bump` | 🟢 已接通(本次验证) |
| 离线预训练 `ml-pipeline/` | — | Criteo(CTR)+阿里妈妈(CVR/DIN) ESMM 预训练 | 🟡 CVR 真实集缺失 |
| 品牌安全 `brand_safety.js` | — | IAB 分类 + GARM + 词边界匹配 | 🟢 可用(已修 rewarded 误杀) |
| 结算/报表 | — | SSP 毛利 + 媒体方分成 + 对账 | 🟢 可用 |

## 4. 创意自动化 vs 素材管理：明确关系
- **创意自动化 = 生产侧（Factory）**：输入素材/文案/参数 → 生成多形态/多语言/可玩/视频/DCO 创意。本质是**降低创意生产成本、提升创意供给**。
- **素材管理 = 资产侧（Library / 治理）**：创意入库、绑定 `campaign_id`、审核状态、版本/A-B 管理。本质是**创意的单一可信源（single source of truth）**。
- **正确关系**：自动化是素材管理的**上游产能**，素材管理是自动化的**下游仓储与治理**；二者靠"存入素材库"动作打通（creative-auto 生成 → 一键 POST `/api/creatives` 绑定 campaign → bidder 下发 → 回流效果）。
- **本次修复**：`creative-auto.html` 新增「创建 Demo 计划」「存入素材库」；`/ssp/bid` 早已通过 `pickCreative(cid, fmt)` 读素材库并按形态下发——只需把创意绑定到能赢下拍卖的 campaign 即可生效（已验证 campaign #160 压过默认 109 胜出）。

## 5. One Engine 概念设计（统一竞价/优化引擎，对标 AXON）
**定位**：一个统一 AI 引擎贯穿"出价—定向—创意优选—归因回填"，而非割裂服务。

```
            ┌──────────── 在线热路径（每次竞价 <ms）────────────┐
请求 → feature_store.compute(x) → mo.predict(pCTR/pCVR/pLTV)
     → calibration → bidFor(目标CPM/CPA/ROAS) → shade(预算/节奏)
     → bandit.choose(上下文感知创意优选) → 下发
            └─────────────────────────────────────────────┘
   ↓ 行为回流                                    ↑ 离线预训练
click/conversion → ml.learn(SGD)              ml-pipeline (Criteo/阿里妈妈 ESMM)
   → 周期 refitCalibration → feature PSI 监控     → 导出 weights → 在线 load
   → registry 灰度(promote/trafficPct)
```
- **特征层** `feature_store.compute()`：训练/serving **单一实现**，从根上消灭 training-serving skew；在线特征落库即离线样本源。
- **预估层** `multi_objective.predict`：ESMM 结构 `pCTCVR = pCTR × pCVR`，叠加 `pLTV`；冷启动用全局模型按 `α=N0/(N0+n)` 融合。
- **出价层** `bidFor`：ROAS 出价 `evalue/roas`、CPA `pctcvr*cpa`、CPM 兜底；shading 按拍卖类型与预算节奏调节。
- **创意层** `bandit`：上下文感知 Thompson Sampling，替代无上下文轮询。
- **治理层** `registry`：模型 promote / 灰度流量百分比，支持对照回退。
- **离线→在线闭环**：`ml-pipeline` 预训练 → 导出权重 → 在线 `mo.load()`。**当前缺口见 §6**。

## 6. 归因 & 预训练：真实状态（诚实盘点）
- **在线学习飞轮已存在且已验证**：`/ssp/click`、`/api/track/conversion` 触发 `ml.onConversion` 与 `creativeAb.bump('conversions')`；`multi_objective.learn` 每曝光/点击/转化做 SGD；周期 `refitCalibration`；特征 PSI 监控。→ **"真实数据进来越来越准"成立（在线层）**。
- **离线预训练 `ml-pipeline/` 真实存在**：用 **Criteo（CTR 塔）+ 阿里妈妈 IJCAI-18（CVR 塔，DIN 注意力）** 训 ESMM，`finetune.js` 支持"Criteo 头 + 阿里妈妈头"合并热启动到真实日志。
- **三个边界（必须知道）**：
  1. **阿里妈妈真实数据集缺失**：工作区仅有合成 `sample/alimama_sample.txt`；`README` 明确"视为合成，不得服务"，`models/` 只保留真实公开集训出的 `criteo.esmm.json`。→ CVR 头真实预训练待补真实 IJCAI-18 `round.txt`。
  2. **在线竞价器未自动加载预训练权重**：`server.js` 的 `ml.mo` 是 `ml/multi_objective.js`（JS 逻辑回归式在线 SGD），`ml-pipeline` 训出的神经网络权重走独立 `serve_predict.js` / `ctr_cvr.json` 契约（给 `marketing-agent` 用），**未灌入在线 `ml.mo`**——这是真实集成断点。
  3. **缺口补齐顺序**：① 把 `ml-pipeline` 导出的权重接入 `ml.mo.load()`；② 补齐阿里妈妈真实集训 CVR 头；③ 用真实曝光→点击→转化日志 `finetune` 热启动。

## 7. 关键数据契约（接口）
| 动作 | 端点 | 关键字段 |
|---|---|---|
| 创意自动化生成 | `POST /api/creative-auto/{generate,playable,video,dco,i18n}` | 鉴权：Bearer `ADMIN_TOKEN` |
| 存入素材库 | `POST /api/creatives` | `campaign_id,format,type,title,content,landing_url,status` |
| 创建计划 | `POST /api/campaign` | `name,creative_html,app_category,budget_cny,target_cpm_cny` → 返回 `id`（默认 `review_status=pending`） |
| 审核通过 | `PUT /api/campaign/:id/approve` | 置 `review_status=approved` 方可参拍 |
| 媒体请求 | `POST /ssp/bid` | `imp[].ext.ad_type/cat`，经 `pickCreative(cid,fmt)` 读素材库 |
| 转化回流 | `POST /api/track/conversion` | `impid,cid,publisher,amount` → 回流 `ml.onConversion` + `creativeAb.bump` |

## 8. 下一步缺口清单（按价值排序）
1. 🔴 **预训练权重接入在线引擎**：`ml-pipeline` 导出 → `ml.mo.load()`，否则离线训练成果未生效。
2. 🔴 **阿里妈妈真实 CVR 预训练**：提供 IJCAI-18 `round.txt`，替换合成头。
3. 🟡 创意自动化产物支持按形态**自动**选 `format/type`（当前需用户在 UI 选），并支持直接"生成即入指定 campaign"。
4. 🟡 外部 DSP（快手 `sdk/kuaishou-dsp`）从 `sim` 切 `real` 需真实 `KS_APP_ID/SECRET/REDIRECT`。
5. 🟢 其余（6 形态下发、归因、结算、品牌安全）已可用，本次已验证闭环。

## 9. 验收标准（MVP 通顺定义）
- [x] 一键生成创意 → 一键存入素材库（绑定真实 campaign）
- [x] 媒体请求该形态 → 返回的是素材库中的真实创意（非占位）
- [x] 点击/转化 → 创意 A/B 计数 + 模型标签回流
- [ ] 离线预训练权重在线生效（断点 6.2）
- [ ] 阿里妈妈真实 CVR 头上线（断点 6.1）
