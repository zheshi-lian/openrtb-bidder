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
Start-Node 'server_8080' 'server.js' 8080 $root
Start-Node 'media_8081' 'sdk/media-server/appServer.js' 8081 $root

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
  Start-Node 'server_8080' 'server.js' 8080 $root
}
Write-Host ('  8080(main) healthy: ' + $ok8080)
$ok8081 = $false
try { Invoke-RestMethod -Uri 'http://127.0.0.1:8081/api/selftest' -TimeoutSec 3 | Out-Null; $ok8081 = $true } catch {}
Write-Host ('  8081(media) reachable: ' + $ok8081)
Write-Host '=== DONE ==='
