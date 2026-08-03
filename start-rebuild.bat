@echo off
setlocal
title AI Toolkit - Update and Rebuild
rem Fork addition (see FORK_NOTES.md). Double-click to fetch + fast-forward this repo
rem from origin, reinstall/rebuild the UI, and launch it at http://localhost:8675.
rem
rem Use this instead of start.bat after new code has landed on origin. It does the
rem full "start.bat rebuild" work plus the git update, and stops an already-running
rem server first (a rebuild against a live server fails with EPERM on the locked
rem prisma/sqlite native files).
rem
rem It only ever fast-forwards from ORIGIN on the current branch. Merging upstream
rem (ostris/ai-toolkit) is a separate, manual job - this script will never do it.
rem An in-progress training run is left alone (it is a detached python process).

cd /d "%~dp0"

where git >nul 2>nul
if errorlevel 1 (
    echo git was not found. Install Git from https://git-scm.com and try again.
    pause
    exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
    echo npm was not found. Install Node.js from https://nodejs.org and try again.
    pause
    exit /b 1
)

rem --- 1. refuse to touch a dirty tree -------------------------------------
set "DIRTY="
for /f "delims=" %%i in ('git status --porcelain') do set "DIRTY=1"
if defined DIRTY (
    echo.
    echo You have uncommitted changes. Commit or stash them first - this script
    echo will not pull over a dirty working tree.
    echo.
    git status --short
    pause
    exit /b 1
)

for /f "delims=" %%b in ('git rev-parse --abbrev-ref HEAD') do set "BRANCH=%%b"
for /f "delims=" %%h in ('git rev-parse HEAD') do set "BEFORE=%%h"

rem --- 2. fetch + fast-forward from origin ---------------------------------
echo Fetching origin...
git fetch origin
if errorlevel 1 (
    echo.
    echo Could not fetch from origin - check your network connection.
    pause
    exit /b 1
)

echo Fast-forwarding %BRANCH% ...
git pull --ff-only origin %BRANCH%
if errorlevel 1 (
    echo.
    echo Could not fast-forward %BRANCH%. Your branch has local commits that origin
    echo does not, or the histories diverged. Resolve it by hand - this script will
    echo not merge, rebase, or force anything.
    pause
    exit /b 1
)

for /f "delims=" %%h in ('git rev-parse HEAD') do set "AFTER=%%h"

if "%BEFORE%"=="%AFTER%" (
    echo Already up to date - rebuilding anyway.
) else (
    echo.
    echo New commits:
    git --no-pager log --oneline %BEFORE%..%AFTER%
    echo.
    git diff --name-only %BEFORE% %AFTER% > "%TEMP%\aitk_changed.txt"
    findstr /i "requirements" "%TEMP%\aitk_changed.txt" >nul
    if not errorlevel 1 (
        echo NOTE: python requirements changed in this update. This script only
        echo       rebuilds the UI - reinstall the training deps yourself:
        echo           .venv\Scripts\activate ^&^& pip install -r requirements.txt
        echo.
    )
    del "%TEMP%\aitk_changed.txt" >nul 2>nul
)

rem --- 3. stop a running server (same matcher as stop.bat) -----------------
echo.
echo Stopping any running AI Toolkit server (UI port 8675 + cron worker)...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$port=8675; $ids=@(); $ids += (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue).OwningProcess; $ids += (Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -and (($_.CommandLine -match ('--port ' + $port)) -or ($_.CommandLine -match 'cron[\\/]+worker\.js') -or (($_.CommandLine -match 'concurrently') -and ($_.CommandLine -match [string]$port))) }).ProcessId; $ids = $ids | Where-Object { $_ } | Select-Object -Unique; if (-not $ids) { Write-Host '  Nothing running.' } else { foreach ($id in $ids) { try { Stop-Process -Id $id -Force -ErrorAction Stop; Write-Host ('  stopped node PID ' + $id) } catch { Write-Host ('  could not stop PID ' + $id + ' : ' + $_.Exception.Message) } } ; Start-Sleep -Seconds 2 }"

rem --- 4. reinstall + rebuild + launch -------------------------------------
cd /d "%~dp0ui"

echo.
echo Installing dependencies and building. This can take a few minutes...
call npm ci --no-audit --no-fund
if errorlevel 1 goto fail
call npm run update_db
if errorlevel 1 goto fail
call npm run build
if errorlevel 1 goto fail

echo.
echo Build complete. Starting AI Toolkit UI at http://localhost:8675 (Ctrl+C to stop^)
call npm run start
if errorlevel 1 pause
exit /b

:fail
echo.
echo Update/rebuild failed - see the output above. The repo is already updated;
echo you can retry with start.bat rebuild once the problem is fixed.
pause
exit /b 1
