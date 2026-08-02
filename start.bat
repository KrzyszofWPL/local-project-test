@echo off
if "%~1"=="RUN" goto main
cmd /k ""%~f0" RUN"
exit /b

:main
title Discord Quest Bot - Control Panel
cd /d "%~dp0"

echo ==========================================
echo   Discord Quest Bot - Control Panel
echo ==========================================
echo.

node --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js not found: https://nodejs.org/
    pause
    exit /b 1
)

if not exist tokens.txt (
    echo [ERROR] tokens.txt is missing - add one token per line
    pause
    exit /b 1
)

if not exist ip.txt (
    echo [Note] No ip.txt - every account will use your own IP address.
    echo        Add one proxy per line to ip.txt to give each account its own IP.
    echo.
)

if not exist node_modules\playwright (
    echo [Init] Installing dependencies...
    where pnpm >nul 2>&1
    if errorlevel 1 (
        npm install
    ) else (
        pnpm install
    )
    echo.
)

echo Opening the panel: http://localhost:3000
start "" http://localhost:3000
echo.

node server.js

echo.
echo Panel stopped. Press any key to close.
pause
