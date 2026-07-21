@echo off
setlocal
rem Fork addition (see FORK_NOTES.md). Creates a desktop shortcut that launches
rem start.bat using the project's favicon as its icon, instead of a bare .bat file.

set "ROOT=%~dp0"
set "ICON=%ROOT%ui\src\app\favicon.ico"
set "TARGET=%ROOT%start.bat"

if not exist "%ICON%" (
    echo Could not find icon at "%ICON%"
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
    "$s.Description = 'Launch AI Toolkit UI';" ^
    "$s.Save()"

if errorlevel 1 (
    echo Failed to create shortcut.
    pause
    exit /b 1
)

echo Shortcut created on your Desktop: "AI Toolkit.lnk"
pause
