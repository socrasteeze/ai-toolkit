@echo off
setlocal
title AI Toolkit - Start Detached
rem Fork addition (see FORK_NOTES.md). Start the UI with no window left on
rem screen. ASCII only, no BOM, CRLF endings.
rem
rem Usage:
rem   start-detached.bat            Start hidden.
rem   start-detached.bat rebuild    Install and build first, then start hidden.
rem
rem The difference from start.bat is the window, not the server. Same port,
rem same npm script, same cron worker.
rem
rem Setup runs VISIBLE and only the server is hidden. start.bat calls `pause`
rem on every failure branch, and a hidden `pause` waits forever on a keypress
rem nobody can send -- a silent hang with no window to close. So the install
rem and build stay on screen, and the console closes once the server is up.
rem
rem Where the output goes:
rem
rem   logs\ui-out.log   Startup lines from the UI and the cron worker.
rem   logs\ui-err.log   A stack trace, if the server refuses to start.
rem
rem Two files, never one: Start-Process refuses the same path for both
rem streams. Named files rather than an inherited handle, because a console
rem child given no explicit handles allocates its own console -- visible,
rem which is the one thing this mode exists to avoid.
rem
rem stop.bat stops this exactly as it stops a windowed server: it matches the
rem listening port and the command line, never a window title, so a hidden
rem process is found the same way a visible one is.

set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"
cd /d "%ROOT%\ui"

where npm >nul 2>nul
if errorlevel 1 goto nonpm

if /i "%~1"=="rebuild" goto full
if not exist "node_modules" goto full
if not exist ".next" goto full
if not exist "dist\cron\worker.js" goto full
goto launch

:full
echo Installing dependencies and building. This can take a few minutes...
call npm ci --no-audit --no-fund
if errorlevel 1 goto buildfailed
call npm run update_db
if errorlevel 1 goto buildfailed
call npm run build
if errorlevel 1 goto buildfailed
echo Build complete.

:launch
if not exist "%ROOT%\logs" mkdir "%ROOT%\logs" >nul 2>&1
echo Starting AI Toolkit UI at http://localhost:8675 with no window.
echo Output goes to logs\ui-out.log. Stop it with stop.bat.
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "Start-Process -FilePath 'cmd.exe' -ArgumentList '/c','npm','run','start' -WorkingDirectory '%ROOT%\ui' -WindowStyle Hidden -RedirectStandardOutput '%ROOT%\logs\ui-out.log' -RedirectStandardError '%ROOT%\logs\ui-err.log'"
if errorlevel 1 goto hiddenfailed
endlocal
exit /b 0

:nonpm
echo npm was not found. Install Node.js from https://nodejs.org and try again.
pause
endlocal
exit /b 1

:buildfailed
echo.
echo Setup failed - see the output above. Nothing was started.
pause
endlocal
exit /b 1

:hiddenfailed
echo.
echo FAILED: could not start the hidden server.
echo Check logs\ui-err.log, then run start.bat to see the error on screen.
pause
endlocal
exit /b 1
