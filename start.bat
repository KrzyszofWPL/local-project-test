@echo off
if "%~1"=="RUN" goto main
cmd /k ""%~f0" RUN"
exit /b

:main
title Discord Quest Bot
cd /d "%~dp0"

echo ==========================================
echo   Discord Quest Bot
echo ==========================================
echo.

set TOKEN_COUNT=0
for /f "usebackq delims=" %%i in ("tokens.txt") do set /a TOKEN_COUNT+=1
echo Tokens: %TOKEN_COUNT%
echo.

set /p CONC="Concurrency (press Enter for 5): "
if "%CONC%"=="" set CONC=5
set CONCURRENCY=%CONC%

echo.
echo Starting - tokens=%TOKEN_COUNT% concurrency=%CONC%
echo ==========================================
echo.

node browser.js

echo.
echo ==========================================
echo  Done. Press any key to close.
pause
