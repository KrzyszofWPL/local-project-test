@echo off
setlocal enabledelayedexpansion
title Discord Quest Bot

echo ==========================================
echo   Discord Quest Bot
echo ==========================================
echo.

node --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js not found. Download: https://nodejs.org/
    pause
    exit /b 1
)
echo Node.js: OK

if not exist "%~dp0tokens.txt" (
    echo [ERROR] tokens.txt not found
    pause
    exit /b 1
)

set TOKEN_COUNT=0
for /f "usebackq delims=" %%i in ("%~dp0tokens.txt") do set /a TOKEN_COUNT+=1
echo Tokens found: %TOKEN_COUNT%
echo.

cd /d "%~dp0"

if not exist node_modules\playwright (
    echo [Init] Installing playwright...
    npm cache clean --force 2>nul
    npm install
    if errorlevel 1 npm install --legacy-peer-deps
    if errorlevel 1 (
        echo [ERROR] npm install failed
        pause
        exit /b 1
    )
)
echo npm: OK

if not exist "%LOCALAPPDATA%\ms-playwright\chromium*" (
    echo [Init] Downloading Chromium (~300MB)...
    npx playwright install chromium
    if errorlevel 1 (
        echo [ERROR] Chromium download failed
        pause
        exit /b 1
    )
)
echo Chromium: OK
echo.

echo Select mode:
echo   [1] Browser - all quests (recommended)
echo   [2] API     - enrolled quests only
echo.
set MODE=1
set /p MODE="Choice (1/2, default=1): "

if "%MODE%"=="2" goto run_api

:run_browser
set CONC=5
set /p CONC="Concurrency (default=5): "
set CONCURRENCY=%CONC%
echo.
echo Starting browser.js - tokens=%TOKEN_COUNT% concurrency=%CONC%
echo ------------------------------------------
node browser.js
goto end

:run_api
echo.
echo Starting index.js - tokens=%TOKEN_COUNT%
echo ------------------------------------------
node index.js

:end
echo.
echo Done. Press any key to close.
pause
