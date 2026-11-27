# Starts the Conduit app (not the database) in its own minimized window.
# Production build when CONDUIT_LOCAL=1 is set in apps\web\.env.local: lighter and faster.
# It builds first when the code changed since the last build, and falls back to
# development mode if a build fails, so the app always comes up.
# Used by start.ps1 and watchdog.ps1. Returns "production", "development" or an error.
param([string]$Log)
$root = Split-Path -Parent $PSScriptRoot
$data = Join-Path $root ".data"
New-Item -ItemType Directory -Force $data | Out-Null
function Say([string]$m) { if ($Log) { "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $m" | Out-File -FilePath $Log -Append -Encoding utf8 } else { Write-Host "  $m" } }

$envFile = Join-Path $root "apps\web\.env.local"
$local = (Test-Path $envFile) -and [bool](Select-String -Path $envFile -Pattern '^\s*CONDUIT_LOCAL\s*=\s*1\s*$' -Quiet)

$mode = "development"
if ($local) {
  # What the code looks like now: the commit plus any changes not committed yet.
  Push-Location $root
  $head = (git rev-parse HEAD 2>$null)
  $dirty = (git status --porcelain -- apps packages 2>$null) -join "`n"
  Pop-Location
  $stamp = "$head`n$dirty"
  $stampFile = Join-Path $data "build-stamp.txt"
  $buildId = Join-Path $root "apps\web\.next\BUILD_ID"
  $built = (Test-Path $buildId) -and (Test-Path $stampFile) -and ((Get-Content $stampFile -Raw) -eq $stamp)
  if (-not $built) {
    Say "Building the production version (a few minutes)..."
    Push-Location $root
    $env:NEXT_TELEMETRY_DISABLED = "1"
    cmd /c "npm run build -w web > .data\build.log 2>&1"
    $ok = ($LASTEXITCODE -eq 0) -and (Test-Path $buildId)
    Pop-Location
    if ($ok) { Set-Content $stampFile $stamp -NoNewline -Encoding utf8; $built = $true; Say "Build done" }
    else { Say "Build failed (see .data\build.log): starting in development mode instead" }
  }
  if ($built) { $mode = "production" }
}

$cmd = if ($mode -eq "production") { "npm run start -w web" } else { "npm run dev" }
Start-Process cmd -ArgumentList "/c", "title Conduit app (keep open) && $cmd >> .data\app.log 2>&1" -WorkingDirectory $root -WindowStyle Minimized
Say "App starting in $mode mode"
$mode
