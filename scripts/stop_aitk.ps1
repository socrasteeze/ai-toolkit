# Fork addition (see FORK_NOTES.md). Stops THIS checkout's AI Toolkit UI server
# (Next.js file server on port 8675 + cron worker), and with -All its training runs.
# Shared by stop.bat and start-rebuild.bat so the two can never drift apart.
#
# Scoping: `npm run start` is `concurrently ... "node dist/cron/worker.js"
# "node dist/cron/fileServer.js start --port 8675"`. The two children carry only
# RELATIVE paths, so their command lines cannot say which app they belong to.
# The concurrently process can: it runs from <repo>\ui\node_modules\. So we find
# that process and stop its whole tree. Fallback for an orphaned file server: the
# port-8675 listener, but only if it is node running dist\cron\fileServer.js.
# Training runs pythonw.exe on Windows (see ui/cron/actions/startJob.ts), launched
# as <repo>\run.py with an absolute path, so it is matched on that path.
param([switch]$All)

$port = 8675
$root = Split-Path -Parent $PSScriptRoot
$uiModules = (Join-Path $root 'ui\node_modules\').ToLower()
$runPy = (Join-Path $root 'run.py').ToLower()

$procs = @(Get-CimInstance Win32_Process)

function Has-Text($p, $text) { $p.CommandLine -and $p.CommandLine.ToLower().Contains($text) }

# A process plus its descendants, children first. The CreationDate check skips a
# process whose recorded parent PID has since been reused by an unrelated process.
function Get-Tree($p) {
    foreach ($k in $procs | Where-Object { $_.ParentProcessId -eq $p.ProcessId -and $_.CreationDate -ge $p.CreationDate }) {
        Get-Tree $k
    }
    $p
}

function Stop-Tree($roots, $label) {
    $targets = @($roots | ForEach-Object { Get-Tree $_ }) | Sort-Object ProcessId -Unique
    foreach ($t in $targets) {
        try {
            Stop-Process -Id $t.ProcessId -Force -ErrorAction Stop
            Write-Host ("  stopped {0} PID {1} ({2})" -f $label, $t.ProcessId, $t.Name)
        } catch [Microsoft.PowerShell.Commands.ProcessCommandException] {
            # already gone - its parent's exit took it down
        } catch {
            Write-Host ("  could not stop PID {0} : {1}" -f $t.ProcessId, $_.Exception.Message)
        }
    }
    $targets.Count
}

$supervisors = @($procs | Where-Object {
    $_.Name -eq 'node.exe' -and (Has-Text $_ $uiModules) -and (Has-Text $_ 'concurrently') -and (Has-Text $_ "--port $port")
})
$listenIds = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique)
$servers = @($procs | Where-Object {
    $listenIds -contains $_.ProcessId -and $_.Name -eq 'node.exe' -and $_.CommandLine -match 'dist[\\/]cron[\\/]fileServer\.js'
})
$foreign = @($listenIds | Where-Object { $servers.ProcessId -notcontains $_ -and $_ })

$stopped = Stop-Tree ($supervisors + $servers) 'server'
if ($stopped -eq 0) { Write-Host '  No AI Toolkit UI server from this checkout is running.' }
foreach ($id in $foreign) {
    Write-Host ("  NOTE: port $port is held by PID $id, which is not AI Toolkit - left alone.")
}

if ($All) {
    $jobs = @($procs | Where-Object { $_.Name -match '^pythonw?3?\.exe$' -and (Has-Text $_ $runPy) })
    if ((Stop-Tree $jobs 'training') -eq 0) { Write-Host '  No training process found.' }
}

# Let Windows release the port and the locked prisma/sqlite files before a rebuild.
if ($stopped -gt 0) { Start-Sleep -Seconds 2 }
