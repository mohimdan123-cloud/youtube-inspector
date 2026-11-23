@echo off
title Tube Inspector (local)
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Node.js is not installed yet.
  echo  1. Download the LTS version from https://nodejs.org and install it.
  echo  2. Double-click this file again.
  echo.
  pause
  exit /b 1
)
if not exist ".dev.vars" (
  echo.
  echo  The file named .dev.vars is missing.
  echo  Copy .dev.vars.example to .dev.vars and paste your API keys into it.
  echo.
  pause
  exit /b 1
)
node server.mjs --open %*
echo.
echo  The server stopped.
pause
