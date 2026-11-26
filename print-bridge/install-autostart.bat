@echo off
title Madinah Market - Print Bridge autostart setup
cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -Command "$ws = New-Object -ComObject WScript.Shell; $sc = $ws.CreateShortcut([IO.Path]::Combine($env:APPDATA, 'Microsoft\Windows\Start Menu\Programs\Startup\Madinah Print Bridge.lnk')); $sc.TargetPath = [IO.Path]::Combine('%~dp0', 'start-bridge.bat'); $sc.WorkingDirectory = '%~dp0'; $sc.Save()"

if errorlevel 1 (
  echo.
  echo Something went wrong creating the startup shortcut.
  echo The bridge still works - just run start-bridge.bat yourself.
) else (
  echo.
  echo Done - the print bridge will now start by itself
  echo every time this computer starts Windows.
)
echo.
pause
