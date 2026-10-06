#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
AppLink ADX · 参考 SSP 服务端（ADX 侧）—— 真实竞价 / 持久化 / 反作弊版

端点：
  POST /ssp/bid       SDK → ADX：真实多广告主竞价（eCPM 预估 → 定向 → 频次 → 二价清算）
  POST /s2s/reward    App 服务端 → ADX：HMAC 签名 + 一次性令牌 + 反作弊裁决是否发奖
  GET  /track         曝光/进度/完播 beacon（落 SQLite，供学习出价与反作弊交叉验证）
  GET  /click         点击跳转（记录 click 事件后 302 到广告主落地页）
  GET  /health        健康检查 + 持久化统计
  GET  /media/<file>  自托管创意素材目录（./creatives/）

本版相对「上一版参考实现」修掉的四个问题：
  1) /ssp/bid 不再是硬编码固定价 1500000 / 3000000 micros；改为：
     候选计划 → 相关性 → eCPM 折算(CPM/CPC/CPA) → 学习系数 → floor 过滤 → 排序 → 二价清算。
  2) 素材不再写死 BigBuckBunny；创意 URL 由投放计划(campaigns.json)声明，
     支持 ${ENV} 占位符与自托管 ./creatives/；缺素材的计划不参竞并给出明确告警。
  3) 全链路持久化：SQLite(adx_ssp.db) 落 bid_log / events / rewards / ad_tokens / fraud_hits / blacklist，
     + 结构化滚动日志(ssp.log)。进程重启不丢，可复盘可审计。
  4) 反作弊不止「防重放」：含 appKey 鉴权、UA/设备指纹校验、模拟器识别、IP+媒体级频控、
     impid 重放、token 一次性+过期、完播时长合理性、视频时长不符、太快完播(TOO_FAST)、
     无机票(无 impression 事件)不给奖、单位时间发奖上限、自动拉黑。

配置（环境变量）：
  ADX_API_KEY         HMAC 密钥（生产必须注入，勿用默认值）
  SSP_PORT            监听端口，默认 8080（注意与 Node 版 ADX 8080 冲突时可改）
  ADX_DB              SQLite 路径，默认 ./adx_ssp.db
  ADX_LOG             滚动日志路径，默认 ./ssp.log
  ADX_PUBLIC_BASE     beacon 绝对地址基址，如 https://ssp.your-adx.com（留空则用请求 Host 拼）
  ADX_AUCTION         second_price（默认，二价）| first_price（一价对照）
  ADX_VIDEO_URL       视频素材 URL（campaigns.json 里的 ${ADX_VIDEO_URL} 占位符）
  ADX_IMAGE_URL       图片素材 URL
  ADX_CLICK_URL       点击落地页 URL
  ADX_STRICT          1=开启严格反作弊阻挡（默认 1）

运行：python ssp.py
"""
import hashlib
import hmac
import json
import logging
import os
import re
import sqlite3
import threading
import time
import urllib.parse
import uuid
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from logging.handlers import RotatingFileHandler
from typing import Any, Dict, List, Optional, Tuple

# ============================ 配置 ============================
HERE = os.path.dirname(os.path.abspath(__file__))
API_KEY = os.environ.get("ADX_API_KEY", "demo_api_key")
SSP_PORT = int(os.environ.get("SSP_PORT", "8080"))
DB_PATH = os.environ.get("ADX_DB", os.path.join(HERE, "adx_ssp.db"))
LOG_PATH = os.environ.get("ADX_LOG", os.path.join(HERE, "ssp.log"))
CONFIG_JSON = os.environ.get("ADX_CONFIG", os.path.join(HERE, "campaigns.json"))
CREATIVE_DIR = os.environ.get("ADX_CREATIVE_DIR", os.path.join(HERE, "creatives"))
PUBLIC_BASE = os.environ.get("ADX_PUBLIC_BASE", "").rstrip("/")
AUCTION_MODE = os.environ.get("ADX_AUCTION", "second_price")
STRICT = os.environ.get("ADX_STRICT", "1") == "1"

REWARD_WINDOW_SEC = 300          # 签名时效
MIN_INCREMENT_MICROS = 10_000    # 二价加价：¥0.01
TOKEN_TTL_SEC = 30 * 60          # 一次性令牌有效期
COMPLETE_RATIO = 0.95            # 完播阈值
RISK_BLOCK = 60                  # 风险分≥此值直接不填充
CREATIVE_AD_TYPES = {"rewarded", "interstitial", "splash", "native", "banner", "icon"}

# ============================ 日志 ============================
log = logging.getLogger("adx.ssp")
log.setLevel(logging.INFO)
log.handlers.clear()
_fmt = logging.Formatter("%(asctime)s %(levelname)s %(message)s")
_sh = logging.StreamHandler()
_sh.setFormatter(_fmt)
log.addHandler(_sh)
try:
    _fh = RotatingFileHandler(LOG_PATH, maxBytes=5 * 1024 * 1024, backupCount=3, encoding="utf-8")
    _fh.setFormatter(_fmt)
    log.addHandler(_fh)
except Exception as e:  # 无写权限时仍可运行
    log.warning("日志文件不可用：%s", e)


def audit(event: str, **fields: Any) -> None:
    """结构化审计日志：<event> k=v k=v（便于 grep / 接入 ELK）"""
    pairs = " ".join(f"{k}={json.dumps(v, ensure_ascii=False) if isinstance(v, (dict, list)) else v}"
                    for k, v in fields.items())
    log.info("%s %s", event, pairs)


# ============================ 持久化（SQLite） ============================
SCHEMA = """
CREATE TABLE IF NOT EXISTS apps(
  app_key TEXT PRIMARY KEY, bundle TEXT, name TEXT, rate REAL DEFAULT 0.7,
  daily_req_cap INTEGER DEFAULT 0, status INTEGER DEFAULT 1, created_at INTEGER);
CREATE TABLE IF NOT EXISTS campaigns(
  cid TEXT PRIMARY KEY, advertiser TEXT, ad_type TEXT, bid_type TEXT, bid_micros INTEGER,
  pctr REAL DEFAULT 0.02, pcvr REAL DEFAULT 0.05, budget_micros INTEGER, spent_micros INTEGER DEFAULT 0,
  daily_cap_micros INTEGER, day TEXT DEFAULT '', day_spent_micros INTEGER DEFAULT 0,
  country TEXT DEFAULT '', cats TEXT DEFAULT '', keywords TEXT DEFAULT '',
  media_url TEXT DEFAULT '', adm_html TEXT DEFAULT '', click_url TEXT DEFAULT '', duration_sec INTEGER DEFAULT 0,
  status INTEGER DEFAULT 1, note TEXT DEFAULT '', created_at INTEGER);
CREATE TABLE IF NOT EXISTS bid_log(
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, req_id TEXT, impid TEXT, app_key TEXT, bundle TEXT,
  ad_unit_id TEXT, ad_type TEXT, country TEXT, cat TEXT, kw TEXT, ip TEXT, ua TEXT, device_sig TEXT,
  floor_micros INTEGER, n_eligible INTEGER DEFAULT 0, n_bid INTEGER DEFAULT 0, winner_cid TEXT,
  bid_micros INTEGER, second_micros INTEGER, clear_micros INTEGER, winner_ecpm REAL,
  risk INTEGER DEFAULT 0, blocked TEXT DEFAULT '', nbr INTEGER DEFAULT 0, latency_ms INTEGER, ext TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS events(
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, impid TEXT, app_key TEXT, cid TEXT,
  ev TEXT, ip TEXT, ua TEXT, extra TEXT DEFAULT '');
CREATE INDEX IF NOT EXISTS ix_events_imp ON events(impid, ev);
CREATE TABLE IF NOT EXISTS creative_stats(
  cid TEXT PRIMARY KEY, imps INTEGER DEFAULT 0, clicks INTEGER DEFAULT 0, conv INTEGER DEFAULT 0, updated_at INTEGER);
CREATE TABLE IF NOT EXISTS ad_tokens(
  token TEXT PRIMARY KEY, impid TEXT, cid TEXT, app_key TEXT, created_at INTEGER,
  expires_at INTEGER, used_at INTEGER, ip TEXT, device_sig TEXT);
CREATE TABLE IF NOT EXISTS rewards(
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, impid TEXT, app_key TEXT, cid TEXT, token TEXT,
  watched_ms INTEGER, duration_ms INTEGER, ok INTEGER DEFAULT 0, reason TEXT, risk INTEGER DEFAULT 0, ip TEXT);
CREATE INDEX IF NOT EXISTS ix_rewards_imp ON rewards(impid);
CREATE TABLE IF NOT EXISTS fraud_hits(
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, endpoint TEXT, subject TEXT, rule TEXT,
  detail TEXT DEFAULT '', ip TEXT DEFAULT '');
CREATE INDEX IF NOT EXISTS ix_fraud_subject ON fraud_hits(subject, ts);
CREATE TABLE IF NOT EXISTS blacklist(
  subject TEXT PRIMARY KEY, until_ts INTEGER, reason TEXT, hits INTEGER DEFAULT 1);
"""

DB_LOCK = threading.RLock()
_conn = sqlite3.connect(DB_PATH, check_same_thread=False)
_conn.row_factory = sqlite3.Row


def db() -> sqlite3.Connection:
    return _conn


def q(sql: str, args: Tuple = ()) -> List[sqlite3.Row]:
    with DB_LOCK:
        cur = db().execute(sql, args)
        rows = cur.fetchall()
        cur.close()
        return rows


def x(sql: str, args: Tuple = ()) -> sqlite3.Cursor:
    with DB_LOCK:
        cur = db().execute(sql, args)
        db().commit()
        return cur


def init_db() -> None:
    with DB_LOCK:
        db().executescript(SCHEMA)
        db().commit()


# ============================ 配置加载 ============================
DEFAULT_CONFIG: Dict[str, Any] = {
    "apps": [
        {"app_key": "demo_appkey", "bundle": "com.zhuque.adsdk.demo", "name": "Demo App", "rate": 0.7},
    ],
    "campaigns": [
        # bid_micros 语义随 bid_type 变化：CPM=每千次曝光、CPC=每次点击、CPA=每次转化
        {"cid": "camp_rwd_game", "advertiser": "示例广告主-游戏", "ad_type": "rewarded",
         "bid_type": "CPA", "bid_micros": 45_000_000, "pctr": 0.035, "pcvr": 0.06,
         "budget_micros": 200_000_000, "country": "CN", "cats": "gaming", "duration_sec": 52,
         "media_url": "${ADX_VIDEO_URL}", "click_url": "${ADX_CLICK_URL}"},
        {"cid": "camp_rwd_ecom", "advertiser": "示例广告主-电商", "ad_type": "rewarded",
         "bid_type": "CPC", "bid_micros": 900_000, "pctr": 0.028, "pcvr": 0.04,
         "budget_micros": 120_000_000, "country": "CN", "cats": "ecommerce", "duration_sec": 30,
         "media_url": "${ADX_VIDEO_URL}", "click_url": "${ADX_CLICK_URL}"},
        {"cid": "camp_int_tool", "advertiser": "示例广告主-工具", "ad_type": "interstitial",
         "bid_type": "CPM", "bid_micros": 2_600_000, "pctr": 0.02, "pcvr": 0.02,
         "budget_micros": 80_000_000, "country": "CN", "cats": "tools", "keywords": "tool,utility"},
        {"cid": "camp_ban_edu", "advertiser": "示例广告主-教育", "ad_type": "banner",
         "bid_type": "CPC", "bid_micros": 420_000, "pctr": 0.015, "pcvr": 0.02,
         "budget_micros": 50_000_000, "country": "CN", "cats": "education"},
    ],
}


def _expand(value: Any) -> str:
    """把 ${VAR} 展开成环境变量值；未设置则展开为空串（由调用方据此判定素材缺失）。"""
    s = str(value or "")
    return re.sub(r"\$\{([A-Z0-9_]+)\}", lambda m: os.environ.get(m.group(1), ""), s)


def _self_creative(name: str) -> str:
    """自托管素材：./creatives/<name> 存在则对外暴露为 /media/<name>"""
    return f"/media/{name}" if os.path.isfile(os.path.join(CREATIVE_DIR, name)) else ""


def load_config() -> None:
    cfg = DEFAULT_CONFIG
    if os.path.isfile(CONFIG_JSON):
        try:
            with open(CONFIG_JSON, "r", encoding="utf-8") as f:
                cfg = json.load(f)
        except Exception as e:
            log.error("读取 %s 失败：%s（回退内置默认配置）", CONFIG_JSON, e)

    for a in cfg.get("apps", []):
        x("INSERT OR IGNORE INTO apps(app_key,bundle,name,rate,status,created_at) VALUES(?,?,?,?,1,?)",
          (a["app_key"], a.get("bundle", ""), a.get("name", a["app_key"]), float(a.get("rate", 0.7)), int(time.time())))

    missing_creative = 0
    for c in cfg.get("campaigns", []):
        ad_type = c.get("ad_type", "banner")
        media = _expand(c.get("media_url"))
        click = _expand(c.get("click_url"))
        adm = _expand(c.get("adm_html"))
        # 视频/图片形态必须有素材，否则该计划不参与竞价（不再用全局写死的演示素材兜底）
        needs_media = ad_type in {"rewarded", "interstitial", "splash"}
        if needs_media and not media:
            self_hosted = _self_creative(c["cid"] + ".mp4") or _self_creative("default.mp4")
            media = self_hosted
        if needs_media and not media:
            missing_creative += 1
            log.warning("计划 %s 缺少 video 素材，已置为暂停：设置环境变量 ADX_VIDEO_URL，"
                        "或把 mp4 放到 %s，或在 %s 里写死 media_url", c["cid"], CREATIVE_DIR, CONFIG_JSON)
        status = 1 if (not needs_media or media) else 0
        x("""INSERT INTO campaigns(cid,advertiser,ad_type,bid_type,bid_micros,pctr,pcvr,budget_micros,spent_micros,
             daily_cap_micros,country,cats,keywords,media_url,adm_html,click_url,duration_sec,status,note,created_at)
             VALUES(?,?,?,?,?,?,?,?,0,?,?,?,?,?,?,?,?,?,?,?)
             ON CONFLICT(cid) DO UPDATE SET advertiser=excluded.advertiser,ad_type=excluded.ad_type,
             bid_type=excluded.bid_type,bid_micros=excluded.bid_micros,pctr=excluded.pctr,pcvr=excluded.pcvr,
             budget_micros=excluded.budget_micros,country=excluded.country,cats=excluded.cats,
             keywords=excluded.keywords,media_url=excluded.media_url,adm_html=excluded.adm_html,
             click_url=excluded.click_url,duration_sec=excluded.duration_sec,status=excluded.status,
             note=excluded.note""",
          (c["cid"], c.get("advertiser", ""), ad_type, c.get("bid_type", "CPM"), int(c.get("bid_micros", 0)),
           float(c.get("pctr", 0.02)), float(c.get("pcvr", 0.05)), int(c.get("budget_micros", 0)),
           int(c.get("daily_cap_micros", 0)), c.get("country", ""), c.get("cats", ""), c.get("keywords", ""),
           media, adm, click, int(c.get("duration_sec", 0)), status, c.get("note", ""), int(time.time())))
    if missing_creative:
        log.warning("共 %d 条计划因缺素材未启用", missing_creative)


# ============================ 工具 ============================
def hhmmss(sec: int) -> str:
    sec = max(0, int(sec or 0))
    h, r = divmod(sec, 3600)
    m, s = divmod(r, 60)
    return f"{h:02d}:{m:02d}:{s:02d}"


def device_sig_of(body: Dict[str, Any]) -> str:
    d = body.get("device") or {}
    raw = "|".join(str(d.get(k, "")) for k in ("ua", "make", "model", "osv", "w", "h", "ip"))
    return hashlib_sha256(raw)[:16]


def hashlib_sha256(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8", "ignore")).hexdigest()


# ============================ 反作弊 ============================
EMU_HINTS = ("goldfish", "ranchu", "sdk_gphone", "emulator", "genymotion", "vbox86", "nox")
_window: Dict[str, deque] = {}
_window_lock = threading.RLock()


def _hit(method: str, path: str, subject: str, rule: str, detail: str = "", ip: str = "") -> None:
    """记录一次风控命中；同一主体短时间多次命中自动拉黑。"""
    now = int(time.time())
    x("INSERT INTO fraud_hits(ts,endpoint,subject,rule,detail,ip) VALUES(?,?,?,?,?,?)",
      (now, path, subject, rule, detail, ip))
    rows = q("SELECT COUNT(*) c FROM fraud_hits WHERE subject=? AND ts>?", (subject, now - 600))
    cnt = int(rows[0]["c"]) if rows else 0
    if cnt >= 5:
        x("INSERT INTO blacklist(subject,until_ts,reason,hits) VALUES(?,?,?,?) "
          "ON CONFLICT(subject) DO UPDATE SET until_ts=excluded.until_ts,reason=excluded.reason,hits=excluded.hits",
          (subject, now + 3600, rule, cnt))
        audit("BLACKLIST", subject=subject, rule=rule, hits=cnt)


def _rate(key: str, limit: int, window: int) -> bool:
    """滑动窗口计数：返回 True 表示超限。生产请换成 Redis（多实例共享）。"""
    now = time.time()
    with _window_lock:
        dq = _window.setdefault(key, deque())
        while dq and now - dq[0] > window:
            dq.popleft()
        dq.append(now)
        return len(dq) > limit


def _blacklisted(subject: str) -> bool:
    rows = q("SELECT until_ts FROM blacklist WHERE subject=?", (subject,))
    return bool(rows) and int(rows[0]["until_ts"]) > time.time()


class RiskResult:
    def __init__(self) -> None:
        self.score = 0
        self.rules: List[str] = []
        self.block: Optional[str] = None

    def add(self, score: int, rule: str, detail: str = "") -> None:
        self.score += score
        self.rules.append(rule + ((": " + detail) if detail else ""))

    def as_dict(self) -> Dict[str, Any]:
        return {"risk": self.score, "rules": self.rules, "block": self.block}


def check_bid_risk(body: Dict[str, Any], ip: str, app_key: str) -> Tuple[RiskResult, Optional[int], str]:
    """竞价前风控。返回 (风险结果, nbr, 说明)。nbr 非 None 时直接无填充。"""
    r = RiskResult()
    dev = body.get("device") or {}
    ua = str(dev.get("ua", ""))
    sig = device_sig_of(body)
    path = "/ssp/bid"

    if _blacklisted(f"app:{app_key}") or _blacklisted(f"dev:{sig}") or _blacklisted(f"ip:{ip}"):
        r.block = "BLACKLISTED"
        return r, 102, "blacklisted"

    # appKey 鉴权：改为查库，不再是代码里写死的字符串
    rows = q("SELECT status FROM apps WHERE app_key=?", (app_key,))
    if not rows:
        _hit("POST", path, f"app:{app_key}", "APP_KEY_UNKNOWN", ip=ip)
        r.block = "APP_KEY_UNKNOWN"
        return r, 2, "unknown app_key"
    if int(rows[0]["status"]) != 1:
        r.block = "APP_DISABLED"
        return r, 2, "app disabled"

    if not ua or ("Dalvik" not in ua and "Android" not in ua and "okhttp" not in ua.lower()):
        r.add(30, "BAD_UA", ua[:60])
        _hit("POST", path, f"dev:{sig}", "BAD_UA", ua[:80], ip)
    low = (str(dev.get("make", "")) + " " + str(dev.get("model", ""))).lower()
    if any(h in low for h in EMU_HINTS):
        r.add(30, "EMULATOR", low[:40])
        _hit("POST", path, f"dev:{sig}", "EMULATOR", low[:60], ip)
    if not dev.get("make") or not dev.get("model"):
        r.add(10, "NO_DEVICE_INFO")
    if not str(dev.get("ip", "")):
        r.add(5, "NO_IP")

    if _rate(f"bid:{app_key}:{ip}", 120, 60):
        r.add(50, "RATE_LIMIT_APP_IP")
        _hit("POST", path, f"ip:{ip}", "RATE_LIMIT", app_key, ip)
    if _rate(f"biddev:{sig}", 40, 60):
        r.add(40, "RATE_LIMIT_DEVICE")
        _hit("POST", path, f"dev:{sig}", "RATE_LIMIT_DEVICE", app_key, ip)

    impid = str((body.get("imp") or [{}])[0].get("id", ""))
    if impid:
        seen = q("SELECT id FROM bid_log WHERE impid=? AND ts>?", (impid, int(time.time()) - 120))
        if seen:
            r.add(60, "REPLAY_IMPID", impid)
            _hit("POST", path, f"imp:{impid}", "REPLAY_IMPID", impid, ip)

    if r.score >= RISK_BLOCK and STRICT:
        r.block = "FRAUD_BLOCK"
        return r, 102, "risk_blocked"
    return r, None, ""


def check_reward_risk(payload: Dict[str, Any], ip: str, token_row: sqlite3.Row) -> RiskResult:
    """发奖前风控：在「签名 + 一次性令牌」之外补上时长/时序/频次/交叉校验。"""
    r = RiskResult()
    path = "/s2s/reward"
    impid = str(payload.get("impid", ""))
    cid = str(payload.get("cid", ""))
    watched = int(payload.get("watchedMs", 0) or 0)
    duration = int(payload.get("durationMs", 0) or 0)
    app_key = str(token_row["app_key"]) if token_row is not None else ""
    sig = str(token_row["device_sig"]) if token_row is not None else ""

    if app_key and (_blacklisted(f"app:{app_key}") or _blacklisted(f"dev:{sig}") or _blacklisted(f"ip:{ip}")):
        r.block = "BLACKLISTED"
        return r

    if duration <= 0 or watched <= 0:
        r.block = "BAD_PARAMS"
        return r

    # 观看时长不能超过视频总时长太多（篡改 durationMs / 伪造播放进度）
    if watched > int(duration * 1.05):
        r.block = "SUSPECT_TIME"
        _hit("POST", path, f"imp:{impid}", "SUSPECT_TIME", f"{watched}/{duration}", ip)
        return r

    # 上报时长与计划声明时长不符（换素材/重放别的广告的证据）
    cro = q("SELECT duration_sec FROM campaigns WHERE cid=?", (cid,))
    declared = int(cro[0]["duration_sec"]) * 1000 if cro and cro[0]["duration_sec"] else 0
    if declared > 0 and abs(duration - declared) > declared * 0.2:
        r.block = "SUSPECT_DURATION"
        _hit("POST", path, f"cid:{cid}", "SUSPECT_DURATION", f"{duration}/{declared}", ip)
        return r

    # 太快完播：从广告曝光到 reportedly 完播，物理上不可能在 90% 时长内完成
    ev_rows = q("SELECT MIN(ts) t FROM events WHERE impid=? AND ev='impression'", (impid,))
    t0 = int(ev_rows[0]["t"]) if ev_rows and ev_rows[0]["t"] else 0
    if t0 == 0:
        r.block = "NO_IMPRESSION"
        _hit("POST", path, f"imp:{impid}", "NO_IMPRESSION", cid, ip)
        return r
    if int(time.time()) - t0 < duration / 1000.0 * 0.9:
        r.block = "TOO_FAST"
        _hit("POST", path, f"imp:{impid}", "TOO_FAST", f"elapsed={int(time.time()) - t0}s need>={duration / 1000.0 * 0.9}s", ip)
        return r

    # 单位时间发奖上限（同一 IP / 同一 app）
    now = int(time.time())
    cnt_row = q("SELECT COUNT(*) c FROM rewards WHERE ip=? AND ts>? AND ok=1", (ip, now - 3600))
    if int(cnt_row[0]["c"]) > 200:
        r.block = "CAP_EXCEEDED"
        _hit("POST", path, f"ip:{ip}", "CAP_EXCEEDED", app_key, ip)
        return r
    cnt_row2 = q("SELECT COUNT(*) c FROM rewards WHERE impid=? AND ts>?", (impid, now - 3600))
    if int(cnt_row2[0]["c"]) > 20:
        r.block = "IMP_CAP"
        _hit("POST", path, f"imp:{impid}", "IMP_CAP", cid, ip)
        return r

    return r


# ============================ 竞价引擎 ============================
def _learning_factor(cid: str, base_ctr: float) -> float:
    """学习系数：用真实落到 events 的曝光/点击折算 pCTR，贝叶斯式平滑后再反算倍数（0.7~1.3）。"""
    rows = q("SELECT imps,clicks FROM creative_stats WHERE cid=?", (cid,))
    if not rows or not rows[0]["imps"] or rows[0]["imps"] < 20:
        return 1.0
    imps = int(rows[0]["imps"])
    clicks = int(rows[0]["clicks"])
    real = clicks / max(1, imps)
    # 先验 20 次曝光（a=20）：样本少时向配置值收敛
    a = 20.0
    smoothed = (clicks + a * base_ctr) / (imps + a)
    if base_ctr <= 0:
        return 1.0
    return max(0.7, min(1.3, smoothed / base_ctr))


def _relevance(camp: sqlite3.Row, cat: str, kw: str, ad_type: str) -> float:
    """相关性：广告形态必须匹配；品类/关键词命中给正向系数。"""
    if str(camp["ad_type"]) != ad_type:
        return 0.0
    rel = 1.0
    cats = [c for c in str(camp["cats"] or "").split(",") if c]
    if cats and cat:
        rel = 1.25 if cat in cats else 0.85
    kws = [k for k in str(camp["keywords"] or "").split(",") if k]
    if kws and kw:
        hit = any(k.lower() in kw.lower() for k in kws)
        rel += 0.1 if hit else -0.05
    return max(0.5, min(1.5, rel))


def _ecpm_micros(camp: sqlite3.Row, rel: float, learn: float) -> float:
    """出价折算成 eCPM(micros)：CPM 直接用，CPC=pCTR*bid*1000，CPA=pCTR*pCVR*bid*1000。"""
    bid = float(camp["bid_micros"])
    t = str(camp["bid_type"] or "CPM").upper()
    pctr = float(camp["pctr"] or 0) * learn
    pcvr = float(camp["pcvr"] or 0)
    base = bid if t == "CPM" else (bid * pctr * 1000 if t == "CPC" else bid * pctr * pcvr * 1000)
    return base * rel


def eligible_campaigns(ad_type: str, country: str) -> List[sqlite3.Row]:
    today = time.strftime("%Y-%m-%d")
    return q(
        "SELECT * FROM campaigns WHERE status=1 AND ad_type=? AND budget_micros>spent_micros "
        "AND (country='' OR country=?) AND (daily_cap_micros=0 OR day<>? OR day_spent_micros<daily_cap_micros)",
        (ad_type, country, today))


def run_auction(body: Dict[str, Any], app_key: str) -> Dict[str, Any]:
    imp = (body.get("imp") or [{}])[0]
    imp_ext = imp.get("ext") or {}
    impid = str(imp.get("id", "") or ("imp_" + uuid.uuid4().hex))
    req_id = str(body.get("id", "") or impid)
    ad_unit = str(imp_ext.get("ad_unit_id", ""))
    ad_type = str(imp_ext.get("ad_type", "banner") or "banner")
    cat = str(imp_ext.get("cat", "") or "")
    kw = str(imp_ext.get("keywords", "") or "")
    country = str(((body.get("device") or {}).get("geo") or {}).get("country", "CN") or "CN")
    floor = float(imp.get("bidfloor") or 0) * 1_000_000
    trace = bool(body.get("ext", {}).get("trace") or body.get("trace"))

    eligible = eligible_campaigns(ad_type, country)
    cands = []
    for c in eligible:
        rel = _relevance(c, cat, kw, ad_type)
        if rel <= 0:
            continue
        learn = _learning_factor(c["cid"], float(c["pctr"] or 0))
        e = _ecpm_micros(c, rel, learn)
        if e < floor:
            continue
        cands.append({"cid": c["cid"], "row": c, "ecpm": e, "rel": rel, "learn": learn})
    cands.sort(key=lambda x: x["ecpm"], reverse=True)

    if not cands:
        return {"ok": False, "nbr": 101, "impid": impid, "req_id": req_id, "ad_type": ad_type,
                "n_eligible": len(eligible), "n_bid": 0, "floor": floor,
                "reason": "below_floor" if eligible else "no_eligible_campaign"}

    top = cands[0]
    second = cands[1]["ecpm"] if len(cands) > 1 else None
    if AUCTION_MODE == "first_price" or second is None:
        clear = top["ecpm"]
    else:
        clear = min(top["ecpm"], second + MIN_INCREMENT_MICROS)
    clear = max(clear, floor)
    clear_micros = int(round(clear))

    return {"ok": True, "impid": impid, "req_id": req_id, "ad_type": ad_type, "ad_unit": ad_unit,
            "country": country, "cat": cat, "kw": kw, "floor": int(floor),
            "n_eligible": len(eligible), "n_bid": len(cands),
            "top": top, "second_micros": int(second) if second is not None else clear_micros,
            "clear_micros": clear_micros, "bid_micros": int(top["ecpm"]),
            "trace_cands": cands if trace else None}


# ============================ 创意构建 ============================
def base_url(headers: Any) -> str:
    if PUBLIC_BASE:
        return PUBLIC_BASE
    host = str(headers.get("Host", f"127.0.0.1:{SSP_PORT}"))
    scheme = "https" if str(headers.get("X-Forwarded-Proto", "")) == "https" else "http"
    return f"{scheme}://{host}"


def tracking_urls(base: str, impid: str, cid: str) -> Dict[str, str]:
    common = f"{base}/track?impid={urllib.parse.quote(impid)}&cid={urllib.parse.quote(cid)}"
    return {
        "impression": common + "&ev=impression",
        "start": common + "&ev=start",
        "firstQuartile": common + "&ev=firstQuartile",
        "midpoint": common + "&ev=midpoint",
        "thirdQuartile": common + "&ev=thirdQuartile",
        "complete": common + "&ev=complete",
    }


def build_vast(camp: sqlite3.Row, impid: str, token: str, tr: Dict[str, str]) -> str:
    dur = hhmmss(int(camp["duration_sec"] or 0))
    click = camp["click_url"] or f"{PUBLIC_BASE}/click"
    return (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<VAST version="4.0"><Ad><InLine>'
        f'<AdSystem>{APP_NAME}</AdSystem>'
        f'<AdTitle>{xml_escape(str(camp["advertiser"]))}</AdTitle>'
        f'<Impression><![CDATA[{tr["impression"]}]]></Impression>'
        '<Creatives><Creative><Linear>'
        f'<Duration>{dur}</Duration>'
        '<TrackingEvents>'
        + "".join(f'<Tracking event="{k}"><![CDATA[{v}]]></Tracking>' for k, v in tr.items() if k != "impression")
        + '</TrackingEvents>'
        f'<VideoClicks><ClickThrough><![CDATA[{click}]]></ClickThrough></VideoClicks>'
        '<MediaFiles>'
        f'<MediaFile type="video/mp4" delivery="progressive" width="1280" height="720">{xml_escape(str(camp["media_url"]))}</MediaFile>'
        '</MediaFiles>'
        '</Linear></Creative></Creatives>'
        '</InLine></Ad></VAST>'
    )


def build_html_adm(camp: sqlite3.Row, impid: str, tr: Dict[str, str], click_url: str) -> str:
    tpl = str(camp["adm_html"] or "").strip()
    if tpl:
        return (tpl.replace("{CLICK_URL}", click_url)
                   .replace("{IMPID}", impid)
                   .replace("{ADVERTISER}", str(camp["advertiser"]))
                   .replace("{TRACKING}", tr["impression"]))
    return (
        '<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">'
        '<style>html,body{margin:0;height:100%}a{display:flex;height:100%;align-items:center;justify-content:center;'
        'text-decoration:none;color:#fff;background:linear-gradient(135deg,#1a73e8,#22d3ee);font:600 20px system-ui;'
        'text-align:center}</style></head><body>'
        f'<a href="{click_url}">{xml_escape(str(camp["advertiser"]))}</a>'
        f'<img src="{tr["impression"]}" width="1" height="1" style="position:absolute;left:-1px" alt="">'
        '</body></html>'
    )


def xml_escape(s: str) -> str:
    return (s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
             .replace('"', "&quot;").replace("'", "&apos;"))


APP_NAME = "AppLinkADX"


# ============================ 端点处理 ============================
def handle_bid(body: Dict[str, Any], headers: Any, ip: str) -> Dict[str, Any]:
    t0 = time.time()
    app = body.get("app") or {}
    pub = app.get("publisher") or {}
    app_key = str(pub.get("id") or (body.get("ext") or {}).get("app_key") or "")
    bundle = str(app.get("bundle", ""))
    bext = body.get("ext") or {}

    risk, nbr, why = check_bid_risk(body, ip, app_key)
    if nbr is not None:
        audit("BID_BLOCK", app_key=app_key, ip=ip, reason=risk.block, detail=why, rules=risk.rules)
        return {"id": body.get("id", ""), "seatbid": [],
                "ext": {"nbr": nbr, "reason": risk.block, **risk.as_dict()}}

    res = run_auction(body, app_key)
    latency = int((time.time() - t0) * 1000)
    if not res["ok"]:
        x("INSERT INTO bid_log(ts,req_id,impid,app_key,bundle,ad_unit_id,ad_type,country,cat,kw,ip,ua,device_sig,"
          "floor_micros,n_eligible,n_bid,risk,blocked,nbr,latency_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
          (int(time.time()), res["req_id"], res["impid"], app_key, bundle, "", "", "", res.get("cat", ""),
           res.get("kw", ""), ip, str((body.get("device") or {}).get("ua", ""))[:200], device_sig_of(body),
           int(res["floor"]), 0, 0, risk.score, "NO_FILL:" + str(res.get("reason")), 101, latency))
        audit("BID_NOFILL", app_key=app_key, impid=res["impid"], reason=res.get("reason"), floor=res["floor"])
        return {"id": body.get("id", ""), "seatbid": [],
                "ext": {"nbr": 101, "reason": res.get("reason"), **risk.as_dict()}}

    top = res["top"]
    camp = top["row"]
    impid = res["impid"]
    base = base_url(headers)
    tr = tracking_urls(base, impid, camp["cid"])
    click_url = camp["click_url"] or f"{base}/click?impid={urllib.parse.quote(impid)}&cid={urllib.parse.quote(camp['cid'])}"

    ext_common: Dict[str, Any] = {
        "cid": camp["cid"], "ad_format": res["ad_type"], "advertiser": camp["advertiser"],
        "bid_type": camp["bid_type"], "auction": AUCTION_MODE,
    }

    if res["ad_type"] == "rewarded":
        token = uuid.uuid4().hex
        now = int(time.time())
        device_sig = device_sig_of(body)
        x("INSERT INTO ad_tokens(token,impid,cid,app_key,created_at,expires_at,used_at,ip,device_sig) "
          "VALUES(?,?,?,?,?,?,NULL,?,?)", (token, impid, camp["cid"], app_key, now, now + TOKEN_TTL_SEC, ip, device_sig))
        adm = build_vast(camp, impid, token, tr)
        ext_common["adm_type"] = "vast4"
        ext_common["rw"] = {"token": token, "expires_at": now + TOKEN_TTL_SEC}
    else:
        adm = build_html_adm(camp, impid, tr, click_url)
        ext_common["adm_type"] = "html"

    bid = {
        "id": "bid_" + camp["cid"] + "_" + impid,
        "impid": impid,
        "price": res["clear_micros"],          # 二价清算价，非写死的出价
        "adm": adm,
        "crid": "cr_" + camp["cid"],
        "cid": camp["cid"],
        "adomain": [str(pub.get("domain", "") or "")],
        "ext": ext_common,
    }
    x("INSERT INTO bid_log(ts,req_id,impid,app_key,bundle,ad_unit_id,ad_type,country,cat,kw,ip,ua,device_sig,"
      "floor_micros,n_eligible,n_bid,winner_cid,bid_micros,second_micros,clear_micros,winner_ecpm,risk,blocked,nbr,latency_ms,ext)"
      " VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      (int(time.time()), res["req_id"], impid, app_key, bundle, res["ad_unit"], res["ad_type"], res["country"],
       res["cat"], res["kw"], ip, str((body.get("device") or {}).get("ua", ""))[:200], device_sig_of(body),
       int(res["floor"]), int(res["n_eligible"]), int(res["n_bid"]), camp["cid"], res["bid_micros"],
       res["second_micros"], res["clear_micros"], round(float(top["ecpm"]), 2), risk.score, "", 0, latency,
       json.dumps({"rel": round(top["rel"], 3), "learn": round(top["learn"], 3)}, ensure_ascii=False)))

    out_ext: Dict[str, Any] = {
        "participants": [c["cid"] for c in (res["trace_cands"] or [])],
        "participant_count": int(res["n_bid"]),
        "winner": camp["cid"], "winner_ecpm": round(float(top["ecpm"]), 2),
        "second_price_micros": int(res["second_micros"]), "clearing_price_micros": int(res["clear_micros"]),
        "auction": AUCTION_MODE,
    }
    if res["trace_cands"]:
        out_ext["waterfall"] = [{"cid": c["cid"], "ecpm_micros": int(c["ecpm"]),
                                 "rel": round(c["rel"], 3), "learn": round(c["learn"], 3)}
                                for c in res["trace_cands"]]
    if risk.score:
        out_ext.update(risk.as_dict())

    audit("BID", app_key=app_key, impid=impid, cid=camp["cid"], price=res["clear_micros"],
          bid=res["bid_micros"], n_bid=res["n_bid"], latency_ms=latency, risk=risk.score)
    return {"id": body.get("id", ""), "cur": "CNY",
            "seatbid": [{"seat": "applink", "bid": [bid]}], "ext": out_ext}


def _verify_sig(payload: Dict[str, Any]) -> bool:
    sig = str(payload.get("sig", ""))
    ts = int(payload.get("ts", 0) or 0)
    if abs(time.time() - ts) > REWARD_WINDOW_SEC:
        return False
    msg = "|".join(str(payload.get(k, "")) for k in ("impid", "cid", "token", "watchedMs", "durationMs", "ts"))
    expect = hmac.new(API_KEY.encode(), msg.encode(), hashlib.sha256).hexdigest()
    return hmac.compare_digest(expect, sig)


def handle_reward(payload: Dict[str, Any], ip: str) -> Dict[str, Any]:
    token = str(payload.get("token", ""))
    watched = int(payload.get("watchedMs", 0) or 0)
    duration = int(payload.get("durationMs", 0) or 0)
    impid = str(payload.get("impid", ""))
    cid = str(payload.get("cid", ""))
    now = int(time.time())

    def deny(reason: str, risk_score: int = 0) -> Dict[str, Any]:
        x("INSERT INTO rewards(ts,impid,app_key,cid,token,watched_ms,duration_ms,ok,reason,risk,ip)"
          " VALUES(?,?,?,?,?,?,?,0,?,?,?)", (now, impid, "", cid, token, watched, duration, reason, risk_score, ip))
        audit("REWARD_DENY", impid=impid, cid=cid, reason=reason, risk=risk_score, ip=ip)
        return {"ok": False, "reason": reason}

    if not _verify_sig(payload):
        _hit("POST", "/s2s/reward", f"ip:{ip}", "BAD_SIG", impid, ip)
        return deny("BAD_SIG")

    rows = q("SELECT * FROM ad_tokens WHERE token=?", (token,))
    if not rows:
        return deny("TOKEN_UNKNOWN")
    trow = rows[0]
    if int(trow["used_at"] or 0):
        _hit("POST", "/s2s/reward", f"imp:{impid}", "REPLAY", cid, ip)
        return deny("TOKEN_REPLAY")
    if int(trow["expires_at"]) < now:
        return deny("TOKEN_EXPIRED")
    if str(trow["cid"]) != cid or str(trow["impid"]) != impid:
        _hit("POST", "/s2s/reward", f"imp:{impid}", "TOKEN_MISMATCH", cid, ip)
        return deny("TOKEN_MISMATCH")

    risk = check_reward_risk(payload, ip, trow)
    if risk.block:
        return deny(risk.block, risk.score)

    if duration and watched / duration < COMPLETE_RATIO:
        return deny("INCOMPLETE", risk.score)

    x("UPDATE ad_tokens SET used_at=? WHERE token=?", (now, token))
    x("INSERT INTO rewards(ts,impid,app_key,cid,token,watched_ms,duration_ms,ok,reason,risk,ip)"
      " VALUES(?,?,?,?,?,?,?,1,'OK',?,?)", (now, impid, str(trow["app_key"]), cid, token, watched, duration, risk.score, ip))
    # 消耗预算（按清算价记账）
    rows2 = q("SELECT clear_micros FROM bid_log WHERE impid=? ORDER BY id DESC LIMIT 1", (impid,))
    cost = int(rows2[0]["clear_micros"]) if rows2 else 0
    today = time.strftime("%Y-%m-%d")
    if cost:
        x("UPDATE campaigns SET spent_micros=spent_micros+?, day=CASE WHEN day<>? THEN ? ELSE day END,"
          " day_spent_micros=CASE WHEN day<>? THEN ? ELSE day_spent_micros+? END WHERE cid=?",
          (cost, today, today, today, cost, cost, cid))
    x("UPDATE creative_stats SET conv=conv+1,updated_at=? WHERE cid=?", (now, cid))
    audit("REWARD_OK", impid=impid, cid=cid, app_key=str(trow["app_key"]), cost=cost,
          watched=watched, duration=duration, risk=risk.score)
    return {"ok": True, "reward": "100金币", "charged_micros": cost}


def record_event(params: Dict[str, str], ip: str, ua: str) -> None:
    impid = params.get("impid", "")
    cid = params.get("cid", "")
    ev = params.get("ev", "unknown")
    now = int(time.time())
    x("INSERT INTO events(ts,impid,app_key,cid,ev,ip,ua,extra) VALUES(?,?,?,?,?,?,?,?)",
      (now, impid, params.get("ak", ""), cid, ev, ip, ua[:200], params.get("extra", "")))
    if ev in ("impression", "click"):
        rows = q("SELECT 1 FROM bid_log WHERE impid=? LIMIT 1", (impid,))
        if rows:
            x("INSERT INTO creative_stats(cid,imps,clicks,conv,updated_at) VALUES(?,?,?,0,?) "
              "ON CONFLICT(cid) DO UPDATE SET imps=imps+?, clicks=clicks+?, updated_at=?",
              (cid, 1 if ev == "impression" else 0, 1 if ev == "click" else 0, now,
               1 if ev == "impression" else 0, 1 if ev == "click" else 0, now))
    audit("EVENT", impid=impid, cid=cid, ev=ev, ip=ip)


# ============================ HTTP ============================
class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _send(self, obj: Any, code: int = 200, extra: Optional[Dict[str, str]] = None) -> None:
        if isinstance(obj, bytes):
            data = obj
        else:
            data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        ctype = (extra or {}).get("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        for k, v in (extra or {}).items():
            if k != "Content-Type":
                self.send_header(k, v)
        self.end_headers()
        try:
            self.wfile.write(data)
        except Exception:
            pass

    def _client_ip(self) -> str:
        fwd = self.headers.get("X-Forwarded-For", "")
        return (fwd.split(",")[0].strip() if fwd else "") or self.client_address[0]

    def do_POST(self) -> None:
        length = int(self.headers.get("Content-Length", 0) or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            body = json.loads(raw or b"{}")
        except Exception:
            self._send({"error": "bad json"}, 400)
            return
        path = urllib.parse.urlparse(self.path).path
        ip = self._client_ip()
        try:
            if path == "/ssp/bid":
                self._send(handle_bid(body, self.headers, ip))
            elif path == "/s2s/reward":
                self._send(handle_reward(body, ip))
            else:
                self._send({"error": "not found"}, 404)
        except Exception as e:
            log.exception("处理 %s 异常", path)
            self._send({"error": "server error", "detail": str(e)}, 500)

    def do_GET(self) -> None:
        u = urllib.parse.urlparse(self.path)
        path, params = u.path, {k: v[0] for k, v in urllib.parse.parse_qs(u.query).items()}
        ip = self._client_ip()
        ua = str(self.headers.get("User-Agent", ""))[:200]
        try:
            if path == "/track":
                record_event(params, ip, ua)
                self._send(b"", 204)
            elif path == "/click":
                record_event(dict(params, ev="click"), ip, ua)
                target = None
                if params.get("cid"):
                    rows = q("SELECT click_url FROM campaigns WHERE cid=?", (params["cid"],))
                    if rows and rows[0]["click_url"]:
                        target = str(rows[0]["click_url"])
                self._send(b"", 302, {"Location": target or "about:blank"})
            elif path == "/health":
                c = lambda t: int(q(f"SELECT COUNT(*) c FROM {t}")[0]["c"])
                self._send({"ok": True, "ts": int(time.time()), "db": DB_PATH, "auction": AUCTION_MODE,
                            "counts": {"bid_log": c("bid_log"), "events": c("events"), "rewards": c("rewards"),
                                       "fraud_hits": c("fraud_hits"), "blacklist": c("blacklist"),
                                       "campaigns": c("campaigns")},
                            "campaigns_active": int(q("SELECT COUNT(*) c FROM campaigns WHERE status=1")[0]["c"])})
            elif path.startswith("/media/"):
                self._serve_media(path[len("/media/"):])
            else:
                self._send({"error": "not found"}, 404)
        except Exception as e:
            log.exception("处理 GET %s 异常", path)
            self._send({"error": "server error"}, 500)

    def _serve_media(self, name: str) -> None:
        safe = os.path.basename(name)
        fp = os.path.join(CREATIVE_DIR, safe)
        if not os.path.isfile(fp):
            self._send({"error": "creative not found"}, 404)
            return
        ctype = "video/mp4" if safe.lower().endswith(".mp4") else "application/octet-stream"
        with open(fp, "rb") as f:
            data = f.read()
        self._send(data, 200, {"Content-Type": ctype, "Accept-Ranges": "none"})

    def log_message(self, fmt: str, *args: Any) -> None:  # 交给结构化日志统一处理
        log.debug("http %s", fmt % args if args else fmt)


if __name__ == "__main__":
    init_db()
    load_config()
    active = int(q("SELECT COUNT(*) c FROM campaigns WHERE status=1")[0]["c"])
    log.info("SSP 监听 :%s | DB=%s | auction=%s | 启用计划=%d | API_KEY=%s", SSP_PORT, DB_PATH,
             AUCTION_MODE, active, "默认(demo_api_key，生产请改 ADX_API_KEY)" if API_KEY == "demo_api_key" else "已注入")
    ThreadingHTTPServer(("0.0.0.0", SSP_PORT), Handler).serve_forever()
