@echo off
title Tube Inspector (local, phone on Wi-Fi)
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Node.js is not installed yet. Download the LTS version from https://nodejs.org , install it, then run this again.
  echo.
  pause
  exit /b 1
)
echo.
echo  Phone mode: your phone must be on the same Wi-Fi as this computer.
echo  If Windows asks about the firewall, choose "Private networks" and Allow.
echo.
node server.mjs --lan %*
echo.
echo  The server stopped.
pause
