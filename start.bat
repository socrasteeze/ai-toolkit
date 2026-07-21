@echo off
setlocal
title AI Toolkit UI
rem Fork addition (see FORK_NOTES.md). Double-click to launch the UI at
rem http://localhost:8675. First run installs and builds; after pulling new
rem code from upstream, run "start.bat rebuild" to rebuild before launching.
cd /d "%~dp0ui"

where npm >nul 2>nul
if errorlevel 1 (
    echo npm was not found. Install Node.js from https://nodejs.org and try again.
    pause
    exit /b 1
)

if /i "%~1"=="rebuild" goto full
if not exist "node_modules" goto full
if not exist ".next" goto full
if not exist "dist\cron\worker.js" goto full

echo Starting AI Toolkit UI at http://localhost:8675 (Ctrl+C to stop^)
call npm run start
if errorlevel 1 pause
exit /b

:full
echo First run or rebuild requested - installing dependencies and building.
echo This can take a few minutes...
call npm install --no-audit --no-fund
if errorlevel 1 goto fail
call npm run update_db
if errorlevel 1 goto fail
call npm run build
if errorlevel 1 goto fail
echo Build complete. Starting AI Toolkit UI at http://localhost:8675 (Ctrl+C to stop^)
call npm run start
if errorlevel 1 pause
exit /b

:fail
echo.
echo Setup failed - see the output above.
pause
exit /b 1
