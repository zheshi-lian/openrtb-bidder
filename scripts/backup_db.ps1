# ============================================================
#  zhuque ADX —— MySQL 自动备份（每日定时，保留 14 天）
#  由 ScheduledTask "ADX_DB_Backup" 调用；幂等、失败不阻塞。
#
#  ★ 完全一致快照需要的专用备份账号（用 root 执行一次）：
#    CREATE USER IF NOT EXISTS 'bkp'@'127.0.0.1' IDENTIFIED BY 'StrongBackupPass!';
#    GRANT RELOAD, FLUSH_TABLES, LOCK TABLES, PROCESS, SELECT, SHOW VIEW, EVENT, TRIGGER ON *.* TO 'bkp'@'127.0.0.1';
#    GRANT ALL PRIVILEGES ON zhuque.* TO 'bkp'@'127.0.0.1';
#    FLUSH PRIVILEGES;
#    然后在本机 .env 设 BACKUP_DB_USER=bkp / BACKUP_DB_PASS=StrongBackupPass!
#    —— 脚本会优先 --single-transaction（一致快照）；无 RELOAD/FLUSH_TABLES 权限则自动降级为无锁快照。
# ============================================================
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $MyInvocation.MyCommand.Definition          # scripts/
$proj = Split-Path -Parent $root                                      # 项目根
$MYSQLDUMP = 'C:\Program Files\MySQL\MySQL Server 26.7\bin\mysqldump.exe'
$BAKDIR = Join-Path $proj 'backups'
if (-not (Test-Path $BAKDIR)) { New-Item -ItemType Directory -Path $BAKDIR | Out-Null }
Start-Transcript -Path (Join-Path $BAKDIR 'backup.log') -Append | Out-Null

$stamp = Get-Date -Format 'yyyyMMdd_HHmmss'
$out = Join-Path $BAKDIR ("zhuque_$stamp.sql")
$err = Join-Path $BAKDIR ("zhuque_$stamp.err")

# 取备份凭据：环境变量 > .env 的 BACKUP_DB_* > 业务默认 test
function Get-EnvVal($key, $def) {
  if (Test-Path (Join-Path $proj '.env')) {
    $line = Get-Content (Join-Path $proj '.env') | Where-Object { $_ -match "^$key=" } | Select-Object -First 1
    if ($line) { return ($line -split '=', 2)[1].Trim() }
  }
  return $def
}
$BU = if ($env:BACKUP_DB_USER) { $env:BACKUP_DB_USER } else { Get-EnvVal 'BACKUP_DB_USER' 'test' }
$BP = if ($env:BACKUP_DB_PASS) { $env:BACKUP_DB_PASS } else { Get-EnvVal 'BACKUP_DB_PASS' 'test@fftime' }
$env:MYSQL_PWD = $BP

Write-Host ("[$stamp] dumping zhuque (user=$BU) -> $out")
$baseArgs = @('-h', '127.0.0.1', '-P', '3306', '-u', $BU, '--quick', '--no-tablespaces')
# 先尝试一致快照（需要 RELOAD/FLUSH_TABLES 权限）
& $MYSQLDUMP @baseArgs --single-transaction zhuque 2> $err | Out-File -Encoding utf8 $out
# 一致快照需要 RELOAD/FLUSH_TABLES 权限；当前 test 账号无该权限时只导出表头(远小于 100KB)。
# 以"产出文件是否足够大"判定是否成功，失败则降级为无锁非一致快照（灾难恢复足够）。
$singleOk = (Test-Path $out) -and ((Get-Item $out).Length -gt 100KB)
if (-not $singleOk) {
  Write-Host '  [warn] 一致快照未产出有效文件，降级为 --lock-tables=false 无锁快照'
  & $MYSQLDUMP @baseArgs --lock-tables=false zhuque 2> $err | Out-File -Encoding utf8 $out
}

# MySQL 8 数据脱敏组件会让 mysqldump 探 mysql.column_masking_policy（非业务表，权限不足报错可忽略）；
# SELECT ON *.* 的专用账号不会出现该报错。以下仅为"真实失败"判定时剔除良性报错。
$realErr = Get-Content -Encoding utf8 $err -ErrorAction SilentlyContinue | Where-Object { $_ -match 'Error:' -and $_ -notmatch 'column_masking_policy' -and $_ -notmatch 'GTID' -and $_ -notmatch 'consistent backup' }
$ok = (Test-Path $out) -and ((Get-Item $out).Length -gt 100KB) -and (-not $realErr)
if ($ok) { Write-Host ("  -> OK, size=$((Get-Item $out).Length) bytes") }
else { Write-Host ("  -> FAILED; realErr=$($realErr -join ' | '); see $err") }

# 清理 14 天前的备份
Get-ChildItem $BAKDIR -Filter 'zhuque_*.sql' | Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-14) } | ForEach-Object {
  Write-Host ('  prune old: ' + $_.Name); Remove-Item $_.FullName -Force
}
Stop-Transcript | Out-Null
