@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist logs mkdir logs
:loop
call npm run dev >> logs\dashboard.log 2>&1
timeout /t 5 /nobreak >nul
goto loop
