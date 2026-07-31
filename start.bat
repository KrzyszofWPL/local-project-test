@echo off
setlocal enabledelayedexpansion
title Discord Quest Bot

echo ==========================================
echo   Discord Quest Bot - start.bat
echo ==========================================
echo.

:: ── Node.js check ──────────────────────────────────────────────────────────
node --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js not found. Download: https://nodejs.org/
    goto end
)
echo Node.js: OK

:: ── tokens.txt check ───────────────────────────────────────────────────────
if not exist "%~dp0tokens.txt" (
    echo [ERROR] tokens.txt not found in: %~dp0
    goto end
)

set TOKEN_COUNT=0
for /f "usebackq delims=" %%i in ("%~dp0tokens.txt") do set /a TOKEN_COUNT+=1
echo Tokens found: %TOKEN_COUNT%
if "%TOKEN_COUNT%"=="0" (
    echo [ERROR] tokens.txt is empty.
    goto end
)
echo.

:: ── npm install ─────────────────────────────────────────────────────────────
if not exist "%~dp0node_modules\playwright" (
    echo [Init] Installing dependencies (playwright)...
    echo        This may take 1-2 minutes on first run.
    echo.
    npm cache clean --force 2>nul
    cd /d "%~dp0"
    npm install
    if errorlevel 1 (
        echo.
        echo [RETRY] Trying with --legacy-peer-deps...
        npm install --legacy-peer-deps
        if errorlevel 1 (
            echo [ERROR] npm install failed. Check your internet connection.
            goto end
        )
    )
    echo.
)
echo node_modules: OK

:: ── Playwright / Chromium ──────────────────────────────────────────────────
if not exist "%LOCALAPPDATA%\ms-playwright\chromium*" (
    echo [Init] Downloading Chromium (~300 MB, one-time only)...
    cd /d "%~dp0"
    npx playwright install chromium
    if errorlevel 1 (
        echo [ERROR] Chromium download failed.
        goto end
    )
    echo.
)
echo Chromium: OK
echo.

:: ── Mode selection ─────────────────────────────────────────────────────────
echo Select mode:
echo   [1] Browser - finds ALL quests (recommended)
echo   [2] API     - only enrolled quests
echo.
set MODE=1
set /p MODE="Choice (1/2): "

if "%MODE%"=="2" goto run_api

:: ── Browser mode ───────────────────────────────────────────────────────────
:run_browser
echo.
echo Concurrency (accounts at once):
echo   5=safe  10=medium  20=fast  50=max
set CONC=5
set /p CONC="How many at once (default 5): "

echo.
echo --- Starting browser.js | tokens=%TOKEN_COUNT% | concurrency=%CONC% ---
set CONCURRENCY=%CONC%
cd /d "%~dp0"
node browser.js
goto end

:: ── API mode ───────────────────────────────────────────────────────────────
:run_api
echo.
echo --- Starting index.js | tokens=%TOKEN_COUNT% ---
cd /d "%~dp0"
node index.js

:: ── End ────────────────────────────────────────────────────────────────────
:end
echo.
echo ==========================================
echo  Finished. Press any key to close.
echo ==========================================
pause
