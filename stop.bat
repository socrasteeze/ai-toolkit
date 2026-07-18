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
rem Targets only THIS app's processes (matched by the --port 8675 UI command line and
rem the cron/worker.js worker command line), never unrelated node/python programs.

set "PORT=8675"

echo Stopping AI Toolkit server (UI port %PORT% + cron worker)...

powershell -NoProfile -ExecutionPolicy Bypass -Command "$port=%PORT%; $ids=@(); $ids += (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue).OwningProcess; $ids += (Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -and (($_.CommandLine -match ('--port ' + $port)) -or ($_.CommandLine -match 'cron[\\/]+worker\.js') -or (($_.CommandLine -match 'concurrently') -and ($_.CommandLine -match [string]$port))) }).ProcessId; $ids = $ids | Where-Object { $_ } | Select-Object -Unique; if (-not $ids) { Write-Host '  No AI Toolkit UI server appears to be running.' } else { foreach ($id in $ids) { try { Stop-Process -Id $id -Force -ErrorAction Stop; Write-Host ('  stopped node PID ' + $id) } catch { Write-Host ('  could not stop PID ' + $id + ' : ' + $_.Exception.Message) } } }"

if /i "%~1"=="all" (
  echo.
  echo WARNING: also stopping any running training - progress since the last
  echo          checkpoint save will be lost.
  powershell -NoProfile -ExecutionPolicy Bypass -Command "$t = Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'python.exe' -or $_.Name -eq 'python3.exe') -and $_.CommandLine -and ($_.CommandLine -match 'run\.py') }; if (-not $t) { Write-Host '  No training process found.' } else { foreach ($p in $t) { try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop; Write-Host ('  stopped training PID ' + $p.ProcessId) } catch { Write-Host ('  could not stop PID ' + $p.ProcessId) } } }"
)

echo.
echo Done. Port %PORT% should now be free for a fresh start.bat.
pause
endlocal
