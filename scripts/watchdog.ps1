# Keeps Conduit running: if the database or the app has stopped, start it again.
# Run by the "Conduit watchdog" task (see keep-running.ps1) every few minutes,
# and safe to run by hand. It does nothing while Conduit was stopped on purpose
# ("Stop Conduit" leaves a .data\stopped file; "Start Conduit" removes it).
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$data = Join-Path $root ".data"
$log = Join-Path $data "watchdog.log"
New-Item -ItemType Directory -Force $data | Out-Null

function Write-Log([string]$msg) {
  "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $msg" | Out-File -FilePath $log -Append -Encoding utf8
  # Keep the log small.
  if ((Get-Item $log).Length -gt 512KB) { Get-Content $log -Tail 2000 | Set-Content $log -Encoding utf8 }
}
function Test-Port([int]$port) {
  [bool](Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
}
function Wait-Port([int]$port, [int]$seconds) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while (-not (Test-Port $port) -and (Get-Date) -lt $deadline) { Start-Sleep -Seconds 2 }
  Test-Port $port
}

if (Test-Path (Join-Path $data "stopped")) { exit 0 }

# Only one watchdog at a time (a slow start can overlap the next check).
$lock = Join-Path $data "watchdog.lock"
if ((Test-Path $lock) -and ((Get-Date) - (Get-Item $lock).LastWriteTime).TotalMinutes -lt 20) { exit 0 }
Set-Content $lock (Get-Date) -Encoding utf8
try {
  if (-not (Test-Port 27018)) {
    Write-Log "Database was down: starting it"
    Start-Process cmd -ArgumentList "/c", "title Conduit database (keep open) && npm run db >> .data\db.log 2>&1" -WorkingDirectory $root -WindowStyle Minimized
    if (Wait-Port 27018 300) { Write-Log "Database is back" } else { Write-Log "Database didn't start within 5 minutes; see .data\db.log" }
  }
  if (-not (Test-Port 3000) -and (Test-Port 27018)) {
    Write-Log "App was down: starting it"
    # Production build when set up (rebuilt first if the code changed), development mode otherwise.
    & (Join-Path $PSScriptRoot "run-app.ps1") -Log $log | Out-Null
    if (Wait-Port 3000 180) { Write-Log "App is back" } else { Write-Log "App didn't start within 3 minutes; see .data\app.log" }
  }
} finally {
  Remove-Item $lock -ErrorAction SilentlyContinue
}
