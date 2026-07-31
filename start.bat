@echo off

:: Re-open in persistent window on double-click
if "%~1"=="RUN" goto main
cmd /k ""%~f0" RUN"
exit /b

:main
setlocal enabledelayedexpansion
title Discord Quest Bot

echo ==========================================
echo   Discord Quest Bot
echo ==========================================
echo.

node --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js not found. Download: https://nodejs.org/
    goto end
)
echo Node.js: OK

if not exist "%~dp0tokens.txt" (
    echo [ERROR] tokens.txt not found in this folder
    goto end
)

set TOKEN_COUNT=0
for /f "usebackq delims=" %%i in ("%~dp0tokens.txt") do set /a TOKEN_COUNT+=1
echo Tokens: %TOKEN_COUNT%
echo.

cd /d "%~dp0"

:: ── Pick package manager: pnpm preferred, npm fallback ─────────────────────
set PKG=
pnpm --version >nul 2>&1
if not errorlevel 1 set PKG=pnpm

if "%PKG%"=="" (
    npm --version >nul 2>&1
    if not errorlevel 1 set PKG=npm
)

if "%PKG%"=="" (
    echo [ERROR] No package manager found. Install pnpm:
    echo         Open PowerShell and run:
    echo         iwr https://get.pnpm.io/install.ps1 -useb ^| iex
    goto end
)
echo Package manager: %PKG%

:: ── Install dependencies ────────────────────────────────────────────────────
if not exist node_modules\playwright (
    echo [Init] Installing playwright via %PKG%...
    %PKG% install
    if errorlevel 1 (
        echo [ERROR] Install failed.
        if "%PKG%"=="npm" (
            echo [TIP]  npm is broken on your system. Fix:
            echo        Open PowerShell and run:
            echo        iwr https://get.pnpm.io/install.ps1 -useb ^| iex
            echo        Then restart this window.
        )
        goto end
    )
)
echo Packages: OK

:: ── Install Chromium ────────────────────────────────────────────────────────
if not exist "%LOCALAPPDATA%\ms-playwright\chromium*" (
    echo [Init] Downloading Chromium (~300MB)...
    if "%PKG%"=="pnpm" (
        pnpm exec playwright install chromium
    ) else (
        npx playwright install chromium
    )
    if errorlevel 1 (
        echo [ERROR] Chromium download failed
        goto end
    )
)
echo Chromium: OK
echo.

:: ── Mode ───────────────────────────────────────────────────────────────────
echo Select mode:
echo   [1] Browser - finds ALL quests (recommended)
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
echo ==========================================
echo  Done. Press any key to close.
echo ==========================================
pause
