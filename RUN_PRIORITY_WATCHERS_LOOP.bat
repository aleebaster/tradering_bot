@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist logs mkdir logs
:loop
powershell -NoProfile -ExecutionPolicy Bypass -Command "if (Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'priority-watchers\.ts' }) { exit 0 } else { exit 1 }"
if not errorlevel 1 (
  timeout /t 30 /nobreak >nul
  goto loop
)
call npm run priority:watchers >> logs\priority-watchers.log 2>&1
timeout /t 5 /nobreak >nul
goto loop
