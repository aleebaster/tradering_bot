@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
set TASK_NAME=OPENCODE_AI_TRADING_BOT
set START_BAT=%~dp0START_BOT.bat
set VBS_LAUNCHER=%~dp0AUTOSTART_MINIMIZED.vbs
echo Installing Windows auto-start for %TASK_NAME%...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$startup=[Environment]::GetFolderPath('Startup'); $ws=New-Object -ComObject WScript.Shell; $lnk=$ws.CreateShortcut((Join-Path $startup 'OPENCODE_AI_TRADING_BOT.lnk')); $lnk.TargetPath='wscript.exe'; $lnk.Arguments='""%VBS_LAUNCHER%""'; $lnk.WorkingDirectory='%~dp0'; $lnk.WindowStyle=7; $lnk.Description='OPENCODE AI Trading Bot delayed minimized launcher'; $lnk.Save()"
if errorlevel 1 echo Startup folder shortcut failed; continuing with Task Scheduler fallback.
powershell -NoProfile -ExecutionPolicy Bypass -Command "$action=New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('""' + '%VBS_LAUNCHER%' + '""') -WorkingDirectory '%~dp0'; $t1=New-ScheduledTaskTrigger -AtStartup; $t1.Delay='PT15S'; $t2=New-ScheduledTaskTrigger -AtLogOn; $t2.Delay='PT15S'; $settings=New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable -MultipleInstances IgnoreNew; $user=('{0}\{1}' -f $env:USERDOMAIN,$env:USERNAME); $principal=New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Highest; Register-ScheduledTask -TaskName '%TASK_NAME%' -Action $action -Trigger @($t1,$t2) -Settings $settings -Principal $principal -Description 'Starts OPENCODE AI Trading Bot with delayed minimized launcher and recovery loops' -Force"
if errorlevel 1 (
  echo Task Scheduler install failed. Startup folder shortcut remains as fallback.
  exit /b 1
)
echo Auto-start installed successfully.
endlocal
