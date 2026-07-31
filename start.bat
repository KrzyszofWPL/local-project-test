@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul
title Discord Quest Bot

echo ╔══════════════════════════════════════════════════╗
echo ║         Discord Quest Bot  –  start.bat          ║
echo ╚══════════════════════════════════════════════════╝
echo.

:: ── Sprawdź czy Node.js jest zainstalowany ─────────────────────────────────
node --version >nul 2>&1
if errorlevel 1 (
    echo [BŁĄD] Node.js nie jest zainstalowany.
    echo        Pobierz ze strony: https://nodejs.org/
    pause
    exit /b 1
)

:: ── Sprawdź czy tokens.txt istnieje i ile ma kont ──────────────────────────
if not exist tokens.txt (
    echo [BŁĄD] Brak pliku tokens.txt
    echo        Utwórz plik tokens.txt i wklej tokeny Discord, po jednym w linii.
    pause
    exit /b 1
)

:: Policz niepuste linie w tokens.txt
set TOKEN_COUNT=0
for /f "usebackq delims=" %%i in (tokens.txt) do (
    set "line=%%i"
    if not "!line!"=="" set /a TOKEN_COUNT+=1
)

:: Fallback jeśli delayed expansion nie działa (tryb alternatywny)
if "%TOKEN_COUNT%"=="0" (
    for /f %%c in ('find /c /v "" tokens.txt') do set TOKEN_COUNT=%%c
)

echo Wykryto tokenów : %TOKEN_COUNT%
echo.

if "%TOKEN_COUNT%"=="0" (
    echo [BŁĄD] Plik tokens.txt jest pusty.
    pause
    exit /b 1
)

:: ── Zainstaluj zależności jeśli brak node_modules ─────────────────────────
if not exist node_modules (
    echo [Init] Instalowanie zależności npm...
    npm install
    if errorlevel 1 (
        echo [BŁĄD] npm install nie powiódł się.
        pause
        exit /b 1
    )
    echo.
)

:: ── Zainstaluj Chromium jeśli brak ────────────────────────────────────────
if not exist "%LOCALAPPDATA%\ms-playwright" (
    echo [Init] Pobieranie przeglądarki Chromium (jednorazowo ~300 MB)...
    npx playwright install chromium
    if errorlevel 1 (
        echo [BŁĄD] Instalacja Chromium nie powiodła się.
        pause
        exit /b 1
    )
    echo.
)

:: ── Menu wyboru skryptu ────────────────────────────────────────────────────
echo Wybierz tryb:
echo   [1] Przeglądarka (zalecane) – wykrywa WSZYSTKIE questy automatycznie
echo   [2] API (szybszy start)     – tylko questy do których jesteś zapisany
echo.
set /p MODE="Twój wybór (1/2, domyślnie 1): "
if "%MODE%"=="" set MODE=1
if "%MODE%"=="2" goto run_api

:: ── Tryb przeglądarki ──────────────────────────────────────────────────────
:run_browser
echo.
echo Ile kont ma działać jednocześnie?
echo   Zalecenia RAM:
echo     5  kont  → ~1-2 GB RAM
echo     10 kont  → ~2-4 GB RAM
echo     20 kont  → ~4-8 GB RAM
echo     50 kont  → ~10-20 GB RAM
echo.
set /p CONC="Współbieżność (domyślnie 5, maks %TOKEN_COUNT%): "
if "%CONC%"=="" set CONC=5

echo.
echo Uruchamianie browser.js | kont: %TOKEN_COUNT% | równolegle: %CONC%
echo ──────────────────────────────────────────────────────────────────────
set CONCURRENCY=%CONC%
node browser.js
goto done

:: ── Tryb API ───────────────────────────────────────────────────────────────
:run_api
echo.
echo Uruchamianie index.js | kont: %TOKEN_COUNT% (sekwencyjnie)
echo ──────────────────────────────────────────────────────────────────────
node index.js
goto done

:: ── Koniec ─────────────────────────────────────────────────────────────────
:done
echo.
echo ══════════════════════════════════════════════════════
echo  Zakończono. Naciśnij dowolny klawisz, aby zamknąć.
echo ══════════════════════════════════════════════════════
pause >nul
