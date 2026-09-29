@echo off
cd /d "%~dp0"

echo ===============================================
echo  程序化广告平台 (openrtb-bidder) 启动器
echo ===============================================
echo.
echo [1/3] 检查 Node.js ...
where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未检测到 Node.js，请先安装: https://nodejs.org (LTS 版)
  pause
  exit /b 1
)
node -v

echo.
echo [2/3] 安装依赖 (已安装会自动跳过) ...
call npm install
if errorlevel 1 (
  echo [错误] 依赖安装失败，请检查网络后重试
  pause
  exit /b 1
)

echo.
echo [3/3] 启动服务 ...
echo -------------------------------------------------
echo  前置条件: 请确保 MySQL 已运行，且存在数据库 zhuque
echo  账号 test / 密码 test@fftime  (见 server.js 第10行)
echo -------------------------------------------------
echo  启动后访问:
echo    广告主控制台 : http://127.0.0.1:8080/advertiser.html
echo    媒体方全链路 : http://127.0.0.1:8080/publisher.html
echo    媒体方收益   : http://127.0.0.1:8080/publisher_report.html
echo    SDK 文件     : http://127.0.0.1:8080/pub_sdk.js
echo  按 Ctrl+C 停止服务
echo -------------------------------------------------
echo.
call npm start
pause
