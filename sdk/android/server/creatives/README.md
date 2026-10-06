# 自托管创意素材目录

把真实素材放进本目录，`ssp.py` 会自动识别并通过 `GET /media/<文件名>` 对外提供：

| 文件名 | 用途 |
|---|---|
| `default.mp4` | 所有 rewarded / interstitial / splash 计划找不到显式 `media_url` 时的兜底视频 |
| `<cid>.mp4` | 指定计划专用视频，例如 `camp_rwd_game.mp4` |
| `<cid>.jpg` | 计划专用图片素材（图片形态） |

示例：把 `camp_rwd_game.mp4` 放进来后，`campaigns.json` 里该计划的 `media_url` 可留空或写 `${ADX_VIDEO_URL}`
（未设置时脚本会优先取 `<cid>.mp4`，再退回 `default.mp4`）。

生产环境请把素材放到 CDN / 对象存储，并在 `campaigns.json` 里写绝对 HTTPS URL —— 本目录仅用于本地联调。
本目录不追踪二进制文件（见 `.gitignore`）。
