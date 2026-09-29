@echo off
rem 若 8080 已被占用（bidder 已运行）则直接退出，避免重复实例 EADDRINUSE
netstat -ano | findstr :8080 >nul && exit /b 0
cd /d "d:\训练数据\AI广告\openrtb-bidder"
node server.js
