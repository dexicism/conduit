# Starts everything Conduit needs on this PC, then opens it in the browser.
# Safe to run again: anything already running is left alone.
#   Ollama (local AI)  -> 11434
#   MongoDB (data)     -> 27018
#   Conduit app        -> 3000
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Test-Port([int]$port) {
  [bool](Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
}
function Wait-Port([int]$port, [int]$seconds, [string]$name) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while (-not (Test-Port $port)) {
    if ((Get-Date) -gt $deadline) { throw "$name didn't start within $seconds seconds. Look at its window for the error." }
    Start-Sleep -Seconds 1
  }
}

Write-Host ""
Write-Host "  Starting Conduit..." -ForegroundColor Cyan
# Started on purpose: the watchdog (if it's on) may keep it running again.
Remove-Item (Join-Path $root ".data\stopped") -ErrorAction SilentlyContinue

# Which AI is set in apps\web\.env.local? Ollama is only started when it's the one in use.
$envFile = Join-Path $root "apps\web\.env.local"
$provider = ""
if (Test-Path $envFile) {
  $line = Select-String -Path $envFile -Pattern '^\s*AI_PROVIDER\s*=\s*(\S+)' | Select-Object -First 1
  if ($line) { $provider = $line.Matches[0].Groups[1].Value.Trim('"').ToLower() }
}
$useOllama = ($provider -eq "ollama")

if (-not (Test-Path "$root\node_modules")) {
  Write-Host "  First run: installing packages (a few minutes)..."
  npm install
}

# 1. Local AI (only when AI_PROVIDER=ollama)
if (-not $useOllama) {
  Write-Host "  [ok] AI: $(if ($provider) { $provider } else { 'not set' }) (no local model needed)"
} elseif (Test-Port 11434) {
  Write-Host "  [ok] AI (Ollama) already running"
} else {
  $ollama = Join-Path $env:LOCALAPPDATA "Programs\Ollama\ollama app.exe"
  if (Test-Path $ollama) {
    # This laptop's GPU needs Ollama's CUDA 12 build (the default one crashes).
    if (-not $env:OLLAMA_LLM_LIBRARY) { $env:OLLAMA_LLM_LIBRARY = "cuda_v12" }
    Start-Process $ollama
    Write-Host "  [..] Starting AI (Ollama)"
    $deadline = (Get-Date).AddSeconds(20)
    while (-not (Test-Port 11434) -and (Get-Date) -lt $deadline) { Start-Sleep -Seconds 1 }
    if (-not (Test-Port 11434)) {
      # The tray app sometimes doesn't start its server; run the server directly.
      Start-Process (Join-Path $env:LOCALAPPDATA "Programs\Ollama\ollama.exe") -ArgumentList "serve" -WindowStyle Hidden
      Wait-Port 11434 30 "Ollama"
    }
    Write-Host "  [ok] AI (Ollama) running"
  } else {
    Write-Host "  [!!] Ollama isn't installed, so AI steps won't work. Get it free at https://ollama.com" -ForegroundColor Yellow
  }
}

# 2. Database
if (Test-Port 27018) {
  Write-Host "  [ok] Database already running"
} else {
  Write-Host "  [..] Starting database"
  Start-Process cmd -ArgumentList "/k", "title Conduit database (keep open) && npm run db" -WorkingDirectory $root -WindowStyle Minimized
  Wait-Port 27018 300 "The database"
  Write-Host "  [ok] Database ready"
}

# 3. App (also runs workflows, schedules and the Telegram bot)
if (Test-Port 3000) {
  Write-Host "  [ok] App already running"
} else {
  Write-Host "  [..] Starting app (first start takes about a minute)"
  Start-Process cmd -ArgumentList "/k", "title Conduit app (keep open) && npm run dev" -WorkingDirectory $root -WindowStyle Minimized
  Wait-Port 3000 180 "The app"
}

# Wait until pages load (the first one compiles), then open it.
$deadline = (Get-Date).AddSeconds(180)
while ($true) {
  try {
    $r = Invoke-WebRequest "http://localhost:3000/login" -UseBasicParsing -TimeoutSec 60
    if ($r.StatusCode -eq 200) { break }
  } catch {}
  if ((Get-Date) -gt $deadline) { throw "The app didn't answer. Look at the 'Conduit app' window for the error." }
  Start-Sleep -Seconds 2
}
# Warm up the AI model so the first reply is quick.
if ($useOllama -and (Test-Port 11434)) {
  try {
    $body = '{"model":"qwen3:8b","prompt":"hi","think":false,"stream":false,"keep_alive":"30m","options":{"num_predict":1,"num_ctx":16384}}'
    Invoke-RestMethod "http://127.0.0.1:11434/api/generate" -Method Post -Body $body -ContentType "application/json" -TimeoutSec 120 | Out-Null
    Write-Host "  [ok] AI model loaded"
  } catch {
    Write-Host "  [!!] AI model didn't load yet: $($_.Exception.Message)" -ForegroundColor Yellow
  }
}

Start-Process "http://localhost:3000/app"
Write-Host ""
Write-Host "  Conduit is running at http://localhost:3000" -ForegroundColor Green
Write-Host "  Keep the two minimized 'Conduit' windows open. To stop everything, run 'Stop Conduit'."
if (-not (Get-ScheduledTask -TaskName "Conduit watchdog" -ErrorAction SilentlyContinue)) {
  Write-Host "  Tip: run 'Keep Conduit running' once, so it starts at sign-in and restarts itself if it stops." -ForegroundColor Yellow
}
Write-Host ""
