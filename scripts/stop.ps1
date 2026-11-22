# Stops the Conduit app and its database. Ollama keeps running (it uses little when idle).
$root = Split-Path -Parent $PSScriptRoot
# Ask the database to shut down cleanly first, so the next start doesn't need a recovery.
if (Get-NetTCPConnection -LocalPort 27018 -State Listen -ErrorAction SilentlyContinue) {
  Push-Location $root
  node -e "require('mongodb').MongoClient.connect('mongodb://127.0.0.1:27018/?directConnection=true').then(c=>c.db('admin').command({shutdown:1,force:true}).catch(()=>{}).finally(()=>process.exit(0))).catch(()=>process.exit(0))" 2>$null
  Pop-Location
  $deadline = (Get-Date).AddSeconds(20)
  while ((Get-NetTCPConnection -LocalPort 27018 -State Listen -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
}
foreach ($port in 3000, 27018) {
  $owners = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique
  foreach ($procId in $owners) {
    # Stop the whole process tree (cmd window -> npm -> node / mongod).
    & taskkill /PID $procId /T /F | Out-Null
  }
}
# Close the launcher's windows too.
Get-Process cmd -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like "Conduit *(keep open)*" } | ForEach-Object { & taskkill /PID $_.Id /T /F | Out-Null }
Write-Host "  Conduit stopped." -ForegroundColor Green
