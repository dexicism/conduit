# Turns the watchdog on (or off with -Remove): a Windows task for your user that,
# at sign-in and every 5 minutes, starts Conduit's database and app if they've
# stopped. No admin rights needed. Undo any time with "Keep Conduit running.cmd -Remove"
# or Task Scheduler > "Conduit watchdog" > Delete.
param([switch]$Remove)
$name = "Conduit watchdog"
$script = Join-Path $PSScriptRoot "watchdog.ps1"

if ($Remove) {
  Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "  The watchdog is off. Conduit only runs while you start it." -ForegroundColor Green
  exit 0
}

$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$script`""
$atLogon = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$every5 = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5)
# Run on battery too, and catch up after the laptop wakes up.
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $name -Action $action -Trigger @($atLogon, $every5) -Settings $settings -Principal $principal -Force | Out-Null
Write-Host ""
Write-Host "  The watchdog is on: Conduit starts at sign-in and is restarted within 5 minutes if it stops." -ForegroundColor Green
Write-Host "  What it did is in .data\watchdog.log. 'Stop Conduit' still stops it for good (until 'Start Conduit')."
Write-Host ""
