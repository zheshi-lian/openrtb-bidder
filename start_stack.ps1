# ============================================================
#  zhuque ADX 全栈自启（幂等，可重复执行）
#  职责：① 启动基础存储 MySQL / redis  →  ② 拉起 Node 主服务
#  说明：被「启动服务.bat」「开机计划任务 ADX_Stack_AutoStart」共用，
#        本身已含 MySQL 启动；bat 里也额外补了一句 net start 便于手动。
# ============================================================
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $MyInvocation.MyCommand.Definition
Set-Location $root

function Ensure-Service($name) {
  try {
    $s = Get-Service -Name $name -ErrorAction SilentlyContinue
    if (-not $s) { Write-Host "  ⚠ 未找到服务 [$name]（跳过）"; return }
    if ($s.Status -eq 'Running') { Write-Host "  ✓ $name 已在运行"; return }
    Write-Host "  启动服务 [$name] ..."
    Start-Service -Name $name -ErrorAction Stop
    Start-Sleep -Seconds 3
    $s2 = Get-Service -Name $name
    Write-Host "    -> $($s2.Status)"
  } catch {
    Write-Host "  ⚠ 启动 [$name] 失败（通常需要管理员权限）：$_"
  }
}

Write-Host '=== ① 基础存储服务 ==='
Ensure-Service 'MySQL267'
Ensure-Service 'redisadx'
Ensure-Service 'Cloudflared'   # 隧道不通不阻断本地链，失败仅告警

# ② 离线「公开集预训练」ESMM 权重切入在线出价热路径（provenance=real-public，经白名单放行）
$env:NEURAL_ENGINE = '1'
$env:NEURAL_MODEL  = 'd:/训练数据/AI广告/ml-pipeline/models/reallog_merged.esmm.json'

Write-Host '=== ② 拉起 ADX 主服务 (node server.js) ==='
$log  = Join-Path $root 'server_run.log'
$err  = Join-Path $root 'server_run.err'
$pidf = Join-Path $root 'server.pid'
# 清空旧日志，保留可读
if (Test-Path $log) { Clear-Content $log }
if (Test-Path $err) { Clear-Content $err }
$p = Start-Process -FilePath 'node' -ArgumentList 'server.js' -WorkingDirectory $root `
      -RedirectStandardOutput $log -RedirectStandardError $err -PassThru
$p.Id | Out-File -FilePath $pidf -Encoding ascii
Write-Host "  已启动 PID=$($p.Id)  日志=$log"

# ③ 健康检查（最多等 30s）
$ok = $false
for ($i = 0; $i -lt 30; $i++) {
  try {
    $r = Invoke-RestMethod -Uri 'http://127.0.0.1:8080/health' -TimeoutSec 2
    if ($r.ok) { $ok = $true; break }
  } catch {}
  Start-Sleep -Seconds 1
}
if ($ok) {
  Write-Host '  ✓ ADX 健康：http://127.0.0.1:8080   （媒体端 8081 同进程静态）'
} else {
  Write-Host '  ✗ 健康检查失败，请查看 server_run.log'
}
