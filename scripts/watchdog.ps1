# ============================================================
#  zhuque ADX —— 外层看门狗（兜底 cluster.js 主进程崩溃）
#  每 20s 探活 :8080；若端口掉且本地没有 cluster.js 进程在拉起，则重跑 start_stack.ps1
#  （start_stack 幂等：已监听的端口会跳过，仅补起缺失的 cluster.js）。
#  由 ScheduledTask "ADX_Watchdog" 在 SYSTEM 下常驻运行。
# ============================================================
$root = Split-Path -Parent $MyInvocation.MyCommand.Definition          # scripts/
$proj = Split-Path -Parent $root
$stack = Join-Path $proj 'start_stack.ps1'

# 避免重复实例：重复部署/重启 start_stack 时可能再拉起一个看门狗，需去重
$others = Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.CommandLine -like '*watchdog.ps1*' -and $_.ProcessId -ne $PID }
if ($others) { Write-Host '[watchdog] another instance already running, exit'; exit 0 }

while ($true) {
  $up = $false
  try { if (Get-NetTCPConnection -LocalPort 8080 -State Listen -ErrorAction SilentlyContinue) { $up = $true } } catch {}
  if (-not $up) {
    # 是否已有 cluster.js 正在拉起（避免重复启动产生双主）
    $launching = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*cluster.js*' }
    if (-not $launching) {
      Write-Host ("[watchdog $(Get-Date -Format 'HH:mm:ss')] 8080 down & no cluster.js -> restart stack")
      & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $stack
    } else {
      Write-Host ("[watchdog] 8080 down but cluster.js starting, wait...")
    }
  }
  Start-Sleep -Seconds 20
}
