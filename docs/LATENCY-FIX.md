# RTB 延迟定位与优化（A）

## 结论先行：引擎没慢，慢的是"桌面机 + cloudflared 隧道"这条链路

对 `POST /openrtb2/bid` 做了本地直连 vs 公网两条路径的基准测试（`dellai.xyz`）：

| 路径 | 中位 | 尾部 | 说明 |
|---|---|---|---|
| 本地 `127.0.0.1:8080` | 30ms | 90ms | 引擎真实计算耗时 |
| 公网 `dellai.xyz`（cloudflared） | ~609ms | 冷启动 ~1.4s | 隧道 + Cloudflare + 跨境 RTT |

`/metrics` 也印证了这一点（实时采样）：

```
hist.dsp_latency: p50=22.7ms  p90=64ms  p95=72ms  p99=78.4ms  max=57ms
backend: redis
counters: { bid_requests: 13, deadline_timeout: 1 }
```

**引擎计算 p99 < 80ms**，完全在正常 RTB `tmax`（200–500ms）之内。之前看到 1.4s，几乎全部来自传输层，不是竞价逻辑。

## 技术栈定位（从代码 + 进程 + 日志推得）

- **语言/框架**：Node.js + Express（`server.js`，监听 8080）；媒体端 `sdk/media-server/appServer.js`（监听 8081）。
- **数据**：MySQL（`mysql2/promise`，库 `zhuque`，`DB_NAME`）+ Redis（`ioredis`，服务 `RedisADX`）。
- **LLM（意图 Agent）**：`llm.js` 接 DashScope 通义 `qwen-plus`（`DASHSCOPE_API_KEY`）。**关键：竞价热路径默认不用 LLM**——`.env` 里 `LLM_LIVE_MATCH=0`，LLM 只在"建计划抽意图"时用；热路径走 `relevanceFor()` 的启发式 + Redis 缓存，命中即用，未命中先返回启发式分数、异步刷 embedding。
- **部署**：cloudflared Argo Tunnel（token 远程管理，`~/.cloudflared` 证书），域名 `dellai.xyz` 指到 `localhost:8080`。开机由计划任务 `ADX_Stack_AutoStart` 拉起，日志在 `logs/`。

## 2.4s 的三个真实原因（按影响排序）

1. **cloudflared 隧道 + 跨境 RTT（主因，~600ms 稳态 + 冷启动 1.4s）**
   桌面 Windows 机跑 `node`，出口走单条 Argo Tunnel 到 Cloudflare 边缘再到你。这条链路既慢又不稳——**之前的 502 就是隧道掉线**。这是架构层问题，不是代码问题。

2. **`/openrtb2/bid` 之前没有容量节流 / 硬 deadline（已修）**
   只有 `/ssp/bid` 有 `bidEng.shouldProcess()` + deadline，DSP 侧 `/openrtb2/bid` 裸奔。慢隧道堆积时会把单机拖垮并级联超时。
   **已加**：`/openrtb2/bid` 顶部接入 `shouldProcess({key:'openrtb',priority:'high'})` + 硬 `deadline`（`OPENRTB_DEADLINE_MS`，默认 300ms），候选循环里超线即 `break`。

3. **候选循环里每个 campaign 串行 await 多次 Redis/MySQL（潜在，随规模恶化）**
   `/openrtb2/bid` 里对每个 campaign 依次 `await todaySpend` / `pacing.gate` / `brandSafety.policy` / `relevanceFor`（`cache.get`）。现在 campaign 少所以 p99 才 78ms；**campaign 数上百后会线性变慢**。这是真要上量后必须处理的第二梯队问题。

> 附注：`deadline_timeout=1` 说明 deadline 保护机制已生效过。`Cloudflare 会缓存静态资源`——旧版 `nav.js` 被边缘缓存（加 `?nocache=` 才返回新版），用户看到的"页面没更新"多半是缓存，不是代码。

## 优化清单（代码级）

### 已做（本次，低风险、直接可用）
- `server.js`：`/openrtb2/bid` 加容量节流 + 硬 deadline（`OPENRTB_DEADLINE_MS`，默认 300ms），对齐 `/ssp/bid`。
- `server.js`：候选循环超 deadline 即 `break`（`cache.incr('openrtb_deadline')`），宁可少算不超时。
- `public/index.html`：Prebid 演示的 `/report` 401 → 改调免登录的 `/api/demo/report`；`/notify` 补全 `reqid`（去重身份 = `impid+reqid`，修复固定 slot 名复用的漏扣费隐患）。
- 新增公共接口：`GET /api/public/ecpm-score`（C 工具用）、`GET /api/demo/report`（演示）、`POST /api/public/advertiser-open`（B 需求侧自助开户）。

### 上量前必做（P0/P1）
- **P0 换出口**：RTB 热路径**不要用 cloudflared 消费级隧道**。把 `dellai.xyz`（或独立竞价域名）直接指到一台有固定出口、靠近流量/买量侧的服务器（或 Cloudflare Spectrum / 原生低延迟接入）。cloudflared 只留作**控制台/运维**用，不进竞价路径。这一步做完，公网延迟会从 600ms 级降到 <100ms。
- **P0 双隧道 HA**：`cloudflared` 配 `--ha` / 两个并行隧道实例 + 健康检查，避免单点 502（历史上多次出现）。
- **P1 候选循环批量化**：把每个 campaign 的串行 `await` 改成"一次批量查（`IN (?)`）+ 并行 `Promise.all`（控制并发）"，把 `todaySpend` / `pacing` / `brandSafety.policy` 提到循环外或用 Map 预取。campaign 到 100+ 前完成。
- **P1 相关性/embedding 全走缓存**：`relevanceFor` 命中即返回，未命中用启发式 + 后台 `setImmediate` 刷 embedding（已实现），确认线上 `relcache_hit` 比例；embedding 预热线（热门 ctx 签名）可再压 p99。
- **P1 关 Cloudflare 对竞价 API 的缓存**：`/openrtb2/bid`、`/notify`、`/s2s/reward` 必须 `Cache-Control: no-store`（竞价请求绝不能被 CDN 缓存复用，会导致错价/漏扣费）。静态资源可缓存但给版本号。

### 观测
- 把 `dsp_latency` 分位数 + `deadline_timeout` / `openrtb_deadline` 打到 `/metrics/slo` 的告警阈值上（p99 > tmax*0.9 即报警）。
- 上线后在买量侧网关记录"到 ADX 的端到端延迟"与"ADX 内部 dsp_latency"分离统计，两者差值 = 网络层成本，直接量化隧道贡献。

## 验证方式
```
# 1) 引擎侧（本地）——应在 20~90ms
node -e "global.fetch=require('undici').fetch" 或直接用下面的 curl
curl -o /dev/null -s -w "%{time_total}\n" -X POST http://127.0.0.1:8080/openrtb2/bid \
  -H "Content-Type: application/json" -d '{"id":"b","imp":[{"id":"i","banner":{"w":300,"h":250},"bidfloor":0.5}],"site":{"domain":"dellai.xyz"},"device":{"ip":"0.0.0.0"},"at":2}'

# 2) 公网侧——换出口后应从 ~600ms 降到 <100ms
curl -o /dev/null -s -w "%{time_total}\n" -X POST https://dellai.xyz/openrtb2/bid \
  -H "Content-Type: application/json" -d '{"id":"b","imp":[{"id":"i","banner":{"w":300,"h":250}}],"site":{"domain":"dellai.xyz"},"at":2}'

# 3) 分位数（需 ADMIN_TOKEN）
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" http://127.0.0.1:8080/metrics | jq '.hist.dsp_latency'
```

> ⚠️ 本次改动都在源码里（`server.js` / `public/*`），**需要重启 8080 的 node 进程才会生效**（`node` 不会热加载）。重启方式见 `start_stack.ps1`（先杀 8080/8081 再拉起，隧道由 cloudflared 服务自管，不用动）。
