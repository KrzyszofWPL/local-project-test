@echo off
if "%~1"=="RUN" goto main
cmd /k ""%~f0" RUN"
exit /b

:main
title Discord Quest Bot - Panel
cd /d "%~dp0"

echo ==========================================
echo   Discord Quest Bot - Panel sterowania
echo ==========================================
echo.

node --version >nul 2>&1
if errorlevel 1 (
    echo [BLAD] Node.js nie znaleziony: https://nodejs.org/
    pause
    exit /b 1
)

if not exist tokens.txt (
    echo [BLAD] Brak pliku tokens.txt
    pause
    exit /b 1
)

if not exist node_modules\playwright (
    echo [Init] Instalowanie zaleznosci...
    where pnpm >nul 2>&1
    if errorlevel 1 (
        npm install
    ) else (
        pnpm install
    )
    echo.
)

echo Otwieranie panelu: http://localhost:3000
start "" http://localhost:3000
echo.

node server.js

echo.
echo Panel zatrzymany. Nacisnij dowolny klawisz.
pause
