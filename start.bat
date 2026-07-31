@echo off
setlocal enabledelayedexpansion
title Discord Quest Bot

echo ==========================================
echo   Discord Quest Bot - start.bat
echo ==========================================
echo.

:: Check Node.js
node --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js is not installed.
    echo         Download from: https://nodejs.org/
    pause
    exit /b 1
)

:: Check Node.js version (need 18+)
for /f %%v in ('node -e "process.stdout.write(String(process.versions.node.split(\".\")[0]))"') do set NODE_MAJOR=%%v
if %NODE_MAJOR% LSS 18 (
    echo [ERROR] Node.js too old. Found: v%NODE_MAJOR%.x  Need: v18+
    echo         Download LTS from: https://nodejs.org/
    pause
    exit /b 1
)
echo Node.js v%NODE_MAJOR%.x OK

:: Check tokens.txt
if not exist tokens.txt (
    echo [ERROR] tokens.txt not found.
    echo         Create tokens.txt with one Discord token per line.
    pause
    exit /b 1
)

:: Count tokens
set TOKEN_COUNT=0
for /f "usebackq delims=" %%i in (tokens.txt) do (
    set /a TOKEN_COUNT+=1
)

echo Tokens found : %TOKEN_COUNT%
echo.

if "%TOKEN_COUNT%"=="0" (
    echo [ERROR] tokens.txt is empty.
    pause
    exit /b 1
)

:: Install npm deps if missing
if not exist node_modules (
    echo [Init] Running npm install...
    npm install
    if errorlevel 1 (
        echo [ERROR] npm install failed.
        pause
        exit /b 1
    )
    echo.
)

:: Install Chromium if missing
if not exist "%LOCALAPPDATA%\ms-playwright" (
    echo [Init] Downloading Chromium browser (one-time, ~300 MB)...
    npx playwright install chromium
    if errorlevel 1 (
        echo [ERROR] Chromium install failed.
        pause
        exit /b 1
    )
    echo.
)

:: Mode selection
echo Select mode:
echo   [1] Browser (recommended) - auto-detects ALL quests
echo   [2] API only              - only quests you are enrolled in
echo.
set /p MODE="Your choice (1/2, default=1): "
if "%MODE%"=="" set MODE=1
if "%MODE%"=="2" goto run_api

:: Browser mode
:run_browser
echo.
echo How many accounts should run at the same time?
echo   RAM guide:
echo     5  accounts = ~1-2 GB RAM
echo     10 accounts = ~2-4 GB RAM
echo     20 accounts = ~4-8 GB RAM
echo     50 accounts = ~10-20 GB RAM
echo.
set /p CONC="Concurrency (default=5, max=%TOKEN_COUNT%): "
if "%CONC%"=="" set CONC=5

echo.
echo Starting browser.js  Tokens: %TOKEN_COUNT%  Concurrency: %CONC%
echo ------------------------------------------
set CONCURRENCY=%CONC%
node browser.js
goto done

:: API mode
:run_api
echo.
echo Starting index.js  Tokens: %TOKEN_COUNT%  (sequential)
echo ------------------------------------------
node index.js
goto done

:done
echo.
echo ==========================================
echo  Done. Press any key to exit.
echo ==========================================
pause >nul
