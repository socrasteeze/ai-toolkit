@echo off
setlocal
rem Fork addition (see FORK_NOTES.md). Creates a desktop shortcut that launches
rem start-detached.bat using the project's favicon as its icon, instead of a
rem bare .bat file.
rem
rem The target is start-detached.bat, not start.bat, so a double-click leaves
rem no console on screen. Setup still runs visibly on a first run or a rebuild;
rem only the server is hidden. stop.bat stops it either way.
rem
rem WindowStyle 7 is minimized, not hidden. A .bat target always spawns a
rem console host, and 1 put it on screen for the life of the launcher. Windows
rem offers no style that suppresses it.

set "ROOT=%~dp0"
set "ICON=%ROOT%ui\src\app\favicon.ico"
set "TARGET=%ROOT%start-detached.bat"

if not exist "%ICON%" (
    echo Could not find icon at "%ICON%"
    pause
    exit /b 1
)

if not exist "%TARGET%" (
    echo Could not find launcher at "%TARGET%"
    pause
    exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "$ws = New-Object -ComObject WScript.Shell;" ^
    "$s = $ws.CreateShortcut((Join-Path $ws.SpecialFolders('Desktop') 'AI Toolkit.lnk'));" ^
    "$s.TargetPath = '%TARGET%';" ^
    "$s.WorkingDirectory = '%ROOT%';" ^
    "$s.IconLocation = '%ICON%';" ^
    "$s.WindowStyle = 7;" ^
    "$s.Description = 'Launch AI Toolkit UI';" ^
    "$s.Save()"

if errorlevel 1 (
    echo Failed to create shortcut.
    pause
    exit /b 1
)

echo Shortcut created on your Desktop: "AI Toolkit.lnk"
pause
