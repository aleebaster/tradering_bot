@echo off
setlocal
cd /d "%~dp0"
if not exist node_modules (
  call npm install
  if errorlevel 1 exit /b 1
)
start "Trading Bot Local API" cmd /k "npm run local:api"
timeout /t 4 /nobreak >nul
start "Trading Bot Dashboard" cmd /k "npm run dev"
timeout /t 6 /nobreak >nul
start http://localhost:3000
endlocal
