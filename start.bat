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
        call npm install
    ) else (
        call pnpm install
    )
    echo.
)

REM Full Chromium build. Without it Playwright's headless mode falls back to
REM chromium-headless-shell, which does not composite cross-origin iframes -
REM the hCaptcha challenge then screenshots as blank background and the solver
REM has nothing to look at. The command is idempotent: it exits immediately
REM when the build is already present.
echo [Init] Checking the Chromium build...
call npx --yes playwright install chromium
if errorlevel 1 (
    echo.
    echo [WARN] Could not install the Chromium build. Headless mode will not
    echo        render the CAPTCHA challenge. Fix it with:
    echo            npx playwright install chromium
)
echo.

REM Local GPU solver. Started only when the file is here, Python is available
REM and port 5000 is still free - otherwise a second instance would fight the
REM first one for the same port and for VRAM.
if not exist solver.py goto no_solver
netstat -ano | findstr /c:"127.0.0.1:5000 " | findstr /i "LISTENING" >nul 2>&1
if not errorlevel 1 goto solver_running
call :start_solver
goto solver_done

:solver_running
echo [Solver] Something is ALREADY listening on 127.0.0.1:5000.
echo.
echo     ^>^> This start.bat will NOT restart it, so that process is still
echo        running the solver.py it was started with. If you have just
echo        pulled new code, it is STALE and your fixes are not live.
echo.
echo        Close the "hCaptcha solver" window (or: taskkill /f /im python.exe)
echo        and run start.bat again.
echo.
echo        The panel log prints the solver version on every account start -
echo        check it matches the SOLVER_VERSION in solver.py.
echo.
goto solver_done

:no_solver
echo [Note] solver.py not found next to start.bat - CAPTCHA solving will be
echo        unavailable and rewards needing verification stay unclaimed.
echo.

:solver_done
echo Opening the panel: http://localhost:3000
start "" http://localhost:3000
echo.

node server.js

echo.
echo Panel stopped. The solver keeps running in its own window - close it
echo separately if you are done.
pause
exit /b

REM ---------------------------------------------------------------------------
REM Python is called `python` on most installs and `py` when only the Windows
REM launcher is on PATH. Try both before giving up.
:start_solver
python --version >nul 2>&1
if not errorlevel 1 (
    echo [Solver] Starting solver.py in its own window...
    start "hCaptcha solver" cmd /k python solver.py
    echo.
    goto :eof
)
py --version >nul 2>&1
if not errorlevel 1 (
    echo [Solver] Starting solver.py in its own window ^(py launcher^)...
    start "hCaptcha solver" cmd /k py solver.py
    echo.
    goto :eof
)
echo [WARN] Python not found - solver.py will not start, so CAPTCHA solving
echo        will be unavailable. Install Python 3 and re-run start.bat.
echo.
goto :eof
