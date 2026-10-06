@echo off
chcp 65001 >nul
REM ============================================================
REM  zhuque ADX 唯一手动启动入口（与开机自启共用 start_stack.ps1，幂等不冲突）
REM
REM  服务架构（唯一链路，各层职责）：
REM   0) 显式声明生产环境，避免生产护栏（强口令/密钥必填/演示账号禁用）被旁路
set NODE_ENV=production
REM   1) MySQL267 / redisadx    - Windows 服务（数据库/缓存），下方 net start 兜底拉起
REM   2) cloudflared 服务       - Windows 服务自启（dellai.xyz 隧道，token 远程管理）
REM   3) ADX(8080)/媒体端(8081) - 本入口 - start_stack.ps1 拉起
REM        开机路径：计划任务 ADX_Stack_AutoStart(ONSTART, SYSTEM, 无需登录)
REM   4) 隧道不通时             - Get-Service cloudflared 查状态 / 重启服务；
REM        勿手工 cloudflared tunnel run（会与服务的 token 隧道重复）
REM ============================================================
REM 兜底拉起 MySQL（服务未起时启动；已运行则静默跳过）
net start MySQL267 >nul 2>&1
net start redisadx >nul 2>&1
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start_stack.ps1"
echo.
echo 本地: http://127.0.0.1:8080/media-demo.html
echo 线上: https://dellai.xyz/media-demo.html
pause
