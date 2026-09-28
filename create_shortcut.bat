@echo off
setlocal
rem Fork addition (see FORK_NOTES.md). Creates a desktop shortcut that launches
rem start-rebuild.bat using the project's favicon as its icon, instead of a
rem bare .bat file.
rem
rem The target is start-rebuild.bat (2026-09-28), so a double-click always
rem fast-forwards from origin, rebuilds, and starts the UI. It runs in a normal
rem window (WindowStyle 1): the server stays in that console, and the script
rem can stop on a dirty tree, a failed fetch, or the 30s requirements prompt,
rem all of which need to be seen. stop.bat stops it.

set "ROOT=%~dp0"
set "ICON=%ROOT%ui\src\app\favicon.ico"
set "TARGET=%ROOT%start-rebuild.bat"

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
    "$s.WindowStyle = 1;" ^
    "$s.Description = 'Update, rebuild and launch AI Toolkit UI';" ^
    "$s.Save()"

if errorlevel 1 (
    echo Failed to create shortcut.
    pause
    exit /b 1
)

echo Shortcut created on your Desktop: "AI Toolkit.lnk"
pause
