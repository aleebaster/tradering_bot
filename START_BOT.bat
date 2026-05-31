@echo off
chcp 65001 >nul
setlocal
set LANG=uk_UA.UTF-8
set LC_ALL=uk_UA.UTF-8
set PYTHONIOENCODING=utf-8
set npm_config_unicode=true
cd /d "%~dp0"
if not exist logs mkdir logs
if not exist node_modules (
  call npm install
  if errorlevel 1 exit /b 1
)
start "Trading Bot Local API" /min "%~dp0RUN_LOCAL_API_LOOP.bat"
timeout /t 5 /nobreak >nul
start "Trading Bot Dashboard" /min "%~dp0RUN_DASHBOARD_LOOP.bat"
timeout /t 5 /nobreak >nul
start "Priority Pair Watchers" /min "%~dp0RUN_PRIORITY_WATCHERS_LOOP.bat"
timeout /t 8 /nobreak >nul
call npm run startup:notify >> logs\startup-notify.log 2>>&1
start http://localhost:3000
endlocal
