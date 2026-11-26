@echo off
title Madinah Market - Print Bridge
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js is not installed on this computer.
  echo Please install the LTS version from https://nodejs.org
  echo and then run this file again.
  echo.
  pause
  exit /b 1
)

node bridge.js

echo.
echo The print bridge has stopped. Press any key to close this window.
pause >nul
