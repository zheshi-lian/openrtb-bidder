#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
AppLink ADX · 参考 App 服务端（媒体侧）

SDK 把「观看证据」POST 到这里，本服务：
  1. 用 api_key 对证据做 HMAC-SHA256 签名
  2. 带着签名回调 ADX 的 /s2s/reward
  3. 把 ADX 的裁决结果原样回给 SDK

★ api_key 只存在于本服务端，绝不进 SDK（SDK 不可信，不能让它自己签名）。

运行：  python app_server.py        # 默认监听 :8090
依赖：  python 标准库 + 能访问 ADX（默认 http://127.0.0.1:8080）
"""
import hashlib
import hmac
import json
import os
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse
import urllib.request

# 密钥与地址一律从环境变量注入，不再写死在仓库里（与 ssp.py 保持一致）
API_KEY = os.environ.get("ADX_API_KEY", "demo_api_key")
ADX_BASE = os.environ.get("ADX_BASE", "http://127.0.0.1:8080").rstrip("/")
PORT = int(os.environ.get("APP_SERVER_PORT", "8090"))


def _sign(impid, cid, token, watched_ms, duration_ms, ts) -> str:
    msg = "|".join(str(x) for x in (impid, cid, token, watched_ms, duration_ms, ts))
    return hmac.new(API_KEY.encode(), msg.encode(), hashlib.sha256).hexdigest()


class Handler(BaseHTTPRequestHandler):
    def _send(self, obj, code=200):
        data = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length) if length else b"{}"
        try:
            ev = json.loads(raw or b"{}")
        except Exception:
            self._send({"ok": False, "reason": "BAD_JSON"}, 400)
            return

        # 缺字段早失败：别把残缺证据签名转发出去，白白消耗一次 ADX 往返
        for k in ("impid", "cid", "token", "watchedMs", "durationMs"):
            if k not in ev:
                self._send({"ok": False, "reason": "MISSING_FIELD:" + k}, 400)
                return

        # 1) 本服务端用 api_key 签名（SDK 只给原始证据，不签名）
        ts = int(time.time())
        sig = _sign(
            ev.get("impid", ""), ev.get("cid", ""), ev.get("token", ""),
            ev.get("watchedMs", 0), ev.get("durationMs", 0), ts,
        )
        payload = {
            "impid": ev.get("impid", ""),
            "cid": ev.get("cid", ""),
            "token": ev.get("token", ""),
            "watchedMs": ev.get("watchedMs", 0),
            "durationMs": ev.get("durationMs", 0),
            "ts": ts,
            "sig": sig,
        }

        # 2) 服务端到服务端回调 ADX
        try:
            req = urllib.request.Request(
                ADX_BASE + "/s2s/reward",
                data=json.dumps(payload).encode(),
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=5) as resp:
                result = json.loads(resp.read().decode())
        except Exception as e:
            self._send({"ok": False, "reason": "ADX_UNREACHABLE"}, 502)
            return

        # 3) 把裁决回给 SDK（真实业务里这里还应把 reward 发放到用户账户）
        self._send(result)


if __name__ == "__main__":
    print(f"App server listening on :{PORT}  -> forwards to ADX {ADX_BASE}/s2s/reward")
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
