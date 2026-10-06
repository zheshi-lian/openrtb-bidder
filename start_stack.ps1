# ============================================================
#  zhuque ADX full-stack auto-start (idempotent, re-runnable)
#  Designed to run as Task Scheduler "ADX_Stack_AutoStart" under SYSTEM at boot.
#  - never relies on PATH: node / powershell use absolute paths
#  - starts MySQL267 / redisadx / Cloudflared(tunnel) + node server.js(8080) + media-server(8081)
#  - waits for MySQL port before launching node; health-checks; retry once
# ============================================================
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $MyInvocation.MyCommand.Definition
$NODE = 'C:\Program Files\nodejs\node.exe'
Set-Location $root
# 显式声明生产环境：避免生产护栏（强口令/密钥必填/演示账号禁用）被旁路（见 security.js 启动自检）
$env:NODE_ENV = if ($env:NODE_ENV) { $env:NODE_ENV } else { 'production' }

# ── 生产就绪环境变量（持久层 / 竞价热路径 / 外部 DSP）──
# Redis：启用后 /metrics backend 由 memory 切到 redis，热数据跨重启不丢；
#        若 redisadx 未起，cache.js 会安全降级为内存并持续重连，不会崩溃。
$env:REDIS_URL = if ($env:REDIS_URL) { $env:REDIS_URL } else { 'redis://127.0.0.1:6379' }
# LLM 热路径：与 .env 的 LLM_LIVE_MATCH 保持一致（单一事实来源：=1 开，=0 关）。
# 开启后竞价相关性同步走真实 LLM 评分（带预算超时，回落启发式）；关闭后竞价走纯启发式评分，p99 最低。
$env:LLM_HOT_PATH = if ($env:LLM_HOT_PATH) { $env:LLM_HOT_PATH } else {
  $lm = (Get-Content -Encoding utf8 (Join-Path $root '.env') -ErrorAction SilentlyContinue | Where-Object { $_ -match '^LLM_LIVE_MATCH=' } | Select-Object -First 1)
  if ($lm -and ($lm -split '=', 2)[1].Trim() -eq '1') { '1' } else { '0' }
}
# 外部 DSP：开放 oceanengine/generic 真实需求方参与拍卖（真实出价/真实参拍）。
# Fix-04：此前这一开关被绑在 ENABLE_DEMO_ACCOUNTS 上且写法为「非生产才生效」→ 生产实际永远只跑自有 DSP 一家，
# 与首页"多 DSP 同场二价清算"的承诺不一致。现改为独立开关，默认值=原来的 ENABLE_DEMO_ACCOUNTS 取值以保持行为一致。
$env:ENABLE_EXTERNAL_DSP = if ($env:ENABLE_EXTERNAL_DSP) { $env:ENABLE_EXTERNAL_DSP } else { '1' }
# 演示账号（demobrand/demomedia）：生产默认关闭；置 1 才会被开通，口令对齐 DEMO_PASSWORD。
$env:ENABLE_DEMO_ACCOUNTS = if ($env:ENABLE_DEMO_ACCOUNTS) { $env:ENABLE_DEMO_ACCOUNTS } else { '1' }
# 节点级负载均衡：cluster.js 拉起多 worker 进程 + 健康检查 + 自动重启（见 cluster.js）
$env:WORKERS = if ($env:WORKERS) { $env:WORKERS } else { '4' }
# 告警外发（可选）：优先用已注入的环境变量；否则从 .env 读取（与 server.js 内的 .env 加载器共用 ALERT_WEBHOOK 单一事实来源）。
# 注意：此前这里默认置为 ''，会覆盖 server.js 的 .env 加载器，导致飞书/企微告警在生产始终不生效；现改为从 .env 读取。
$env:ALERT_WEBHOOK = if ($env:ALERT_WEBHOOK) { $env:ALERT_WEBHOOK } else {
  $aw = (Get-Content -Encoding utf8 (Join-Path $root '.env') -ErrorAction SilentlyContinue | Where-Object { $_ -match '^ALERT_WEBHOOK=' } | Select-Object -First 1)
  if ($aw) { ($aw -split '=', 2)[1].Trim() } else { '' }
}

function Ensure-Service($name) {
  try {
    $s = Get-Service -Name $name -ErrorAction SilentlyContinue
    if (-not $s) { Write-Host "  [skip] service not found: $name"; return }
    if ($s.Status -eq 'Running') { Write-Host "  [ok] $name already running"; return }
    Write-Host "  [start] $name ..."
    Start-Service -Name $name -ErrorAction Stop
    Start-Sleep -Seconds 3
    Write-Host "    -> $((Get-Service -Name $name).Status)"
  } catch { Write-Host "  [warn] start $name failed: $_" }
}

function Wait-Port($port, $secs = 40) {
  for ($i = 0; $i -lt $secs; $i++) {
    try { $c = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue; if ($c) { return $true } } catch {}
    Start-Sleep -Seconds 1
  }
  return $false
}

function Start-Node($label, $script, $port, $workdir) {
  $up = $false
  try { $c = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue; if ($c) { $up = $true } } catch {}
  if ($up) { Write-Host "  [ok] $label already listening on :$port, skip"; return }
  Write-Host "  [start] $label -> $script on :$port"
  try {
    $safe = $label -replace '[^a-z0-9]', '_'
    $log = Join-Path $root ($safe + '.log')
    $err = Join-Path $root ($safe + '.err')
    if (Test-Path $log) { Clear-Content $log }
    if (Test-Path $err) { Clear-Content $err }
    $p = Start-Process -FilePath $NODE -ArgumentList $script -WorkingDirectory $workdir `
         -WindowStyle Hidden -RedirectStandardOutput $log -RedirectStandardError $err -PassThru
    Write-Host "    -> PID=$($p.Id)  log=$log"
  } catch { Write-Host "    [fail] $label start failed: $_" }
}

# 1) base storage + tunnel (Windows services, auto-start; idempotent fallback here)
Write-Host '=== 1) base services / tunnel ==='
Ensure-Service 'MySQL267'
Ensure-Service 'redisadx'
Ensure-Service 'Cloudflared'

# 2) wait for MySQL port so node does not start too early
Write-Host '=== 2) wait MySQL(3306) ==='
if (Wait-Port 3306) { Write-Host '  [ok] 3306 ready' } else { Write-Host '  [warn] 3306 not ready, still trying (node will reconnect)' }

# 3) launch node services
Write-Host '=== 3) launch ADX node services ==='
Start-Node 'server_8080' 'cluster.js' 8080 $root
Start-Node 'media_8081' 'sdk/media-server/appServer.js' 8081 $root

# 3.5) 启动外层看门狗（常驻后台，兜底 cluster.js 主进程崩溃；脚本内含重复实例去重）
try {
  $wd = Join-Path $root 'scripts\watchdog.ps1'
  if (Test-Path $wd) {
    Start-Process -FilePath 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' `
      -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$wd`"" -WindowStyle Hidden -ErrorAction Stop
    Write-Host '  [ok] watchdog launched'
  }
} catch { Write-Host "  [warn] watchdog launch failed: $_" }

# 4) health check (retry 8080 once)
Write-Host '=== 4) health check ==='
$ok8080 = $false
for ($attempt = 1; $attempt -le 2; $attempt++) {
  for ($i = 0; $i -lt 20; $i++) {
    try { $r = Invoke-RestMethod -Uri 'http://127.0.0.1:8080/health' -TimeoutSec 2; if ($r.ok) { $ok8080 = $true; break } } catch {}
    Start-Sleep -Seconds 1
  }
  if ($ok8080) { break }
  Write-Host '  [retry] 8080 not ready, re-launch...'
  Start-Node 'server_8080' 'cluster.js' 8080 $root
}
Write-Host ('  8080(main) healthy: ' + $ok8080)
$ok8081 = $false
try { Invoke-RestMethod -Uri 'http://127.0.0.1:8081/api/selftest' -TimeoutSec 3 | Out-Null; $ok8081 = $true } catch {}
Write-Host ('  8081(media) reachable: ' + $ok8081)
Write-Host '=== DONE ==='
