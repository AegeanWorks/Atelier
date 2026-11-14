@echo off
setlocal
cd /d "%~dp0"
title Atelier

where node >nul 2>nul
if errorlevel 1 (
  echo What: Node.js was not found.
  echo Why: atelier needs Node.js 22.12 or newer.
  echo Fix: install it from https://nodejs.org and double-click start.bat again.
  echo.
  pause
  exit /b 1
)

node scripts\start.mjs %*
if errorlevel 1 (
  echo.
  pause
)

endlocal
