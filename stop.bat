@echo off
setlocal
title AI Toolkit - Stop Server
rem Fork addition (see FORK_NOTES.md). Companion to start.bat: stops the AI Toolkit
rem UI server (the Next.js UI on port 8675 and the cron worker) even when the terminal
rem that launched it is gone, frozen (Windows QuickEdit selection), or unresponsive.
rem
rem By default this does NOT stop an in-progress training run - training runs as a
rem separate detached python process that intentionally survives the server, so you can
rem restart the UI without interrupting a job. Pass "stop.bat all" to also stop any
rem running training (you lose progress since the last checkpoint save).
rem
rem Targets only THIS checkout's processes (see scripts\stop_aitk.ps1 for how), never
rem unrelated node/python programs.

set "PORT=8675"

echo Stopping AI Toolkit server (UI port %PORT% + cron worker)...

if /i "%~1"=="all" (
  echo WARNING: also stopping any running training - progress since the last
  echo          checkpoint save will be lost.
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\stop_aitk.ps1" -All
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\stop_aitk.ps1"
)

echo.
echo Done. Port %PORT% should now be free for a fresh start.bat.
pause
endlocal
