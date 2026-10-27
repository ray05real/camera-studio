@echo off
rem Starts Camera Studio on this PC: double-click this file (or the Camera Studio shortcut on the desktop).
rem It opens the Camera Studio window. The small black window waits minimised in the taskbar;
rem closing the Camera Studio window quits everything after a few seconds.
if not "%~1"=="--min" (
  start "Camera Studio" /min cmd /c ""%~f0" --min"
  exit /b
)
title Camera Studio (leave this open while filming)
cd /d "%~dp0pc"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed on this PC. Install it from https://nodejs.org and try again.
  pause
  exit /b 1
)
node server.js
if errorlevel 1 pause
