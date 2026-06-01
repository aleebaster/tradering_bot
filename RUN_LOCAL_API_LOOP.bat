@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist logs mkdir logs
:loop
powershell -NoProfile -ExecutionPolicy Bypass -Command "if (Get-NetTCPConnection -LocalPort 4000 -State Listen -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }"
if not errorlevel 1 (
  timeout /t 30 /nobreak >nul
  goto loop
)
call npm run local:api >> logs\local-api.log 2>&1
timeout /t 5 /nobreak >nul
goto loop
