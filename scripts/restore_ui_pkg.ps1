# Fork-only tool (see FORK_NOTES.md "Sync procedure"). The ui/package.json +
# package-lock.json restore dance, which every upstream merge needs and which was
# previously done by hand:
#
#   1. take upstream's ui/package.json and ui/package-lock.json verbatim
#   2. re-apply the fork's single `test` script line to package.json
#   3. verify the lockfile is byte-identical to upstream's
#
# The lockfile must come from upstream untouched: `npm install` rewrites optional-dep
# metadata differently per npm version, which produces a huge spurious diff and a
# conflict on the next sync. Only `npm ci` is safe afterwards, and this script tells
# you to run it rather than running it for you (it deletes node_modules, which fails
# with EPERM while the UI is running).
#
#   pwsh scripts/restore_ui_pkg.ps1              # restore from upstream/main
#   pwsh scripts/restore_ui_pkg.ps1 -Ref origin/main
#   pwsh scripts/restore_ui_pkg.ps1 -Check       # verify only, change nothing

[CmdletBinding()]
param(
    [string]$Ref = 'upstream/main',
    [switch]$Check
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

# The one fork line in ui/package.json's "scripts" block. Keep in step with
# FORK_NOTES.md's ui/package.json row.
$forkTestScript = '    "test": "node --import ./tests/register.mjs --test \"tests/*.test.mjs\"",'
$anchor = '"scripts": {'

git rev-parse --verify -q "$Ref" *> $null
if ($LASTEXITCODE -ne 0) {
    Write-Host "No such ref: $Ref. For upstream, add the remote first:" -ForegroundColor Red
    Write-Host "  git remote add upstream https://github.com/ostris/ai-toolkit.git"
    Write-Host "  git remote set-url --push upstream DISABLED"
    exit 1
}

function Test-LockMatchesRef {
    $ours = git hash-object ui/package-lock.json
    $theirs = git rev-parse "${Ref}:ui/package-lock.json"
    return $ours -eq $theirs
}

if ($Check) {
    $pkg = Get-Content ui/package.json -Raw
    $hasTest = $pkg -match '"test":\s*"node --import \./tests/register\.mjs'
    $lockOk = Test-LockMatchesRef
    Write-Host ("  {0}  fork test script present in ui/package.json" -f $(if ($hasTest) { 'OK  ' } else { 'FAIL' }))
    Write-Host ("  {0}  ui/package-lock.json is byte-identical to ${Ref}" -f $(if ($lockOk) { 'OK  ' } else { 'FAIL' }))
    if ($hasTest -and $lockOk) { Write-Host "`npackage files OK" -ForegroundColor Green; exit 0 }
    Write-Host "`npackage files need a restore: pwsh scripts/restore_ui_pkg.ps1 -Ref $Ref" -ForegroundColor Red
    exit 1
}

Write-Host "Restoring ui/package.json + ui/package-lock.json from $Ref ..."
git checkout $Ref -- ui/package.json ui/package-lock.json
if ($LASTEXITCODE -ne 0) { Write-Host "checkout failed" -ForegroundColor Red; exit 1 }

$pkg = Get-Content ui/package.json -Raw
if ($pkg -match '"test":') {
    Write-Host "  upstream now defines its own 'test' script — resolve by hand:" -ForegroundColor Yellow
    ($pkg -split "`n" | Select-String '"test":').Line | ForEach-Object { Write-Host "    $_" }
    Write-Host "  The fork's line is:" -ForegroundColor Yellow
    Write-Host "  $forkTestScript"
    exit 1
}
if ($pkg -notmatch [regex]::Escape($anchor)) {
    Write-Host "  could not find the scripts block in ui/package.json — add the fork test line by hand:" -ForegroundColor Red
    Write-Host "  $forkTestScript"
    exit 1
}

# Insert directly after the scripts opening brace, preserving the file's line endings.
$nl = if ($pkg -match "`r`n") { "`r`n" } else { "`n" }
$pkg = $pkg -replace [regex]::Escape($anchor), ($anchor + $nl + $forkTestScript.TrimEnd())
Set-Content ui/package.json -Value $pkg -NoNewline
Write-Host "  re-applied the fork 'test' script" -ForegroundColor Green

if (Test-LockMatchesRef) {
    Write-Host "  ui/package-lock.json is byte-identical to $Ref" -ForegroundColor Green
} else {
    Write-Host "  ui/package-lock.json still differs from $Ref — do NOT 'npm install' to fix it" -ForegroundColor Red
    exit 1
}

Write-Host "`nNow run (with the UI stopped, so node_modules can be replaced):" -ForegroundColor Cyan
Write-Host "  cd ui; npm ci"
exit 0
