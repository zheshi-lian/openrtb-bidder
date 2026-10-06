# ============================================================
#  zhuque ADX —— 日志轮转（copytruncate 语义）
#  node 经 Start-Process 重定向持有文件句柄，直接 rename 不会让 node 写新文件，
#  故采用「先拷贝归档、再原地截断」：node 继续往同一句柄写，文件清零但不丢句柄。
#  由 ScheduledTask "ADX_LogRotate" 每日调用；仅轮转大于 10MB 的 *.log/*.err。
# ============================================================
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $MyInvocation.MyCommand.Definition          # scripts/
$proj = Split-Path -Parent $root
$BAKDIR = Join-Path $proj 'backups\logs'
if (-not (Test-Path $BAKDIR)) { New-Item -ItemType Directory -Path $BAKDIR | Out-Null }
$stamp = Get-Date -Format 'yyyyMMdd_HHmmss'

Get-ChildItem $proj -File -Include '*.log', '*.err' | Where-Object { $_.Length -gt 10MB } | ForEach-Object {
  $arc = Join-Path $BAKDIR ($_.BaseName + '_' + $stamp + $_.Extension)
  try {
    Copy-Item $_.FullName $arc -ErrorAction Stop                       # 归档当前内容
    $fs = [System.IO.File]::Open($_.FullName, 'Open', 'Write', 'ReadWrite')
    $fs.SetLength(0); $fs.Close()                                      # 原地截断，node 续写
    Write-Host ("rotated $($_.Name) -> $arc ($([math]::Round($_.Length/1MB,1))MB)")
  } catch { Write-Host ("rotate failed $($_.Name): $_") }
}
# 日志归档也只留 14 天
Get-ChildItem $BAKDIR -File | Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-14) } | Remove-Item -Force
