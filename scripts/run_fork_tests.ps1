# Fork-only tool (see FORK_NOTES.md). One command for the fork's whole validation
# checklist, so a sync report can say which gates actually ran instead of re-deriving
# PYTHONPATH and the suite list by hand every time (CLAUDE.md's list covers the Node
# half by command only; the Python suites run as bare unittest scripts because the
# venv has no pytest).
#
#   pwsh scripts/run_fork_tests.ps1              # everything available
#   pwsh scripts/run_fork_tests.ps1 -Quick       # skip `next build` (the slow one)
#   pwsh scripts/run_fork_tests.ps1 -SkipBuild   # same thing, explicit
#
# Every gate is optional-by-environment: a missing .venv, missing torch, or missing
# node_modules is reported as SKIP, never as a pass. Exit code is 1 if any gate FAILED.

[CmdletBinding()]
param(
    [switch]$Quick,
    [switch]$SkipBuild
)

$ErrorActionPreference = 'Continue'
$repo = Split-Path -Parent $PSScriptRoot
$results = [System.Collections.Generic.List[object]]::new()

function Add-Result($name, $status, $detail = '') {
    $results.Add([pscustomobject]@{ Gate = $name; Status = $status; Detail = $detail })
    $color = switch ($status) { 'PASS' { 'Green' } 'FAIL' { 'Red' } default { 'Yellow' } }
    Write-Host ("  {0,-6} {1}{2}" -f $status, $name, $(if ($detail) { " - $detail" } else { '' })) -ForegroundColor $color
}

function Invoke-Gate($name, [scriptblock]$body, $skipReason = $null) {
    if ($skipReason) { Add-Result $name 'SKIP' $skipReason; return }
    $out = & $body 2>&1
    if ($LASTEXITCODE -eq 0) {
        Add-Result $name 'PASS'
    } else {
        Add-Result $name 'FAIL' "exit $LASTEXITCODE"
        $out | Select-Object -Last 15 | ForEach-Object { Write-Host "         $_" -ForegroundColor DarkGray }
    }
}

$python = Join-Path $repo '.venv\Scripts\python.exe'
$hasPython = Test-Path $python
$env:PYTHONPATH = $repo
# The Python suites import toolkit; some need torch. Probe once so a missing dep is a
# SKIP with a reason rather than a wall of import errors.
$hasTorch = $false
if ($hasPython) {
    & $python -c "import torch" 2>&1 | Out-Null
    $hasTorch = ($LASTEXITCODE -eq 0)
}

Write-Host "`nFork validation ($repo)" -ForegroundColor Cyan
Write-Host "--- fork surface ---"
Invoke-Gate 'verify_fork' { & $python (Join-Path $repo 'scripts\verify_fork.py') } `
    $(if (-not $hasPython) { 'no .venv' })

Write-Host "--- python ---"
$pySuites = @(
    @{ name = 'test_dataset_selection'; torch = $false },
    @{ name = 'test_fork_speed';        torch = $true  },
    @{ name = 'test_ideogram4_prompt';  torch = $false },
    @{ name = 'test_lora_compile_scalars'; torch = $true },
    @{ name = 'test_qol_scripts';       torch = $false },
    @{ name = 'test_presets';           torch = $true  }
)
foreach ($suite in $pySuites) {
    $reason = if (-not $hasPython) { 'no .venv' } elseif ($suite.torch -and -not $hasTorch) { 'torch not installed' } else { $null }
    $path = Join-Path $repo "testing\$($suite.name).py"
    if (-not $reason -and -not (Test-Path $path)) { $reason = 'suite not found' }
    Invoke-Gate $suite.name { & $python $path } $reason
}

$touchedPy = @('scripts\qol_common.py', 'scripts\preflight.py', 'scripts\auto_caption.py',
               'scripts\smart_prep.py', 'scripts\bench_speed.py', 'scripts\verify_fork.py',
               'scripts\dump_lora_keys.py') |
    ForEach-Object { Join-Path $repo $_ } | Where-Object { Test-Path $_ }
Invoke-Gate 'py_compile (fork scripts)' { & $python -m py_compile @touchedPy } `
    $(if (-not $hasPython) { 'no .venv' })

Write-Host "--- ui ---"
$ui = Join-Path $repo 'ui'
$hasModules = Test-Path (Join-Path $ui 'node_modules')
Push-Location $ui
try {
    $reason = if (-not $hasModules) { 'no node_modules (run npm ci in ui/)' } else { $null }
    Invoke-Gate 'npm test' { & npm test --silent } $reason
    Invoke-Gate 'tsc --noEmit' { & npx tsc --noEmit } $reason
    Invoke-Gate 'tsc (worker)' { & npx tsc -p tsconfig.worker.json --noEmit } $reason
    $buildReason = if ($reason) { $reason } elseif ($Quick -or $SkipBuild) { '-Quick' } else { $null }
    Invoke-Gate 'next build' { & npx next build } $buildReason
} finally {
    Pop-Location
}

Write-Host "`nSummary" -ForegroundColor Cyan
$results | Format-Table -AutoSize | Out-String | Write-Host
$failed = @($results | Where-Object Status -eq 'FAIL')
$skipped = @($results | Where-Object Status -eq 'SKIP')
if ($skipped) {
    Write-Host ("NOT COVERED: " + (($skipped | ForEach-Object { "$($_.Gate) ($($_.Detail))" }) -join '; ')) -ForegroundColor Yellow
}
# Runtime-only paths no gate here can reach — say so, so a sync report does not imply them.
Write-Host "Never covered by this script: the cron worker's runtime paths, a real training run (GPU), and the Dataset Tools CLIs end-to-end (model downloads)." -ForegroundColor DarkGray
if ($failed) {
    Write-Host ("FAILED: " + (($failed | ForEach-Object { $_.Gate }) -join ', ')) -ForegroundColor Red
    exit 1
}
Write-Host "All available gates passed." -ForegroundColor Green
exit 0
