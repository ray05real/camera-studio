@echo off
rem Starts Camera Studio on this PC: double-click this file (or the Camera Studio shortcut on the desktop).
rem It opens the Camera Studio window and runs in the background with no window of its own.
rem Closing the Camera Studio window quits it (after it has finished copying any video).
cd /d "%~dp0pc"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed on this PC. Install it from https://nodejs.org and try again.
  pause
  exit /b 1
)
node server.js
