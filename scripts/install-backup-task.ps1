param([string]$At = '08:10')
$ErrorActionPreference = 'Stop'
if ($At -notmatch '^([01]\d|2[0-3]):[0-5]\d$') { throw 'Use HH:mm' }
$bobRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$bobPowerShell = (Get-Command powershell.exe -ErrorAction Stop).Source
$bobName = 'Assistant_BOB Daily Backup'
$bobScript = Join-Path $bobRoot 'scripts\run-backup.ps1'
$bobArgs = '-NoProfile -NonInteractive -WindowStyle Hidden -File "' + $bobScript + '"'
$bobExisting = Get-ScheduledTask -TaskName $bobName -ErrorAction SilentlyContinue
if ($bobExisting -and $bobExisting.Actions.Arguments -ne $bobArgs) { throw 'A different task already uses this name' }
$bobAction = New-ScheduledTaskAction -Execute $bobPowerShell -Argument $bobArgs -WorkingDirectory $bobRoot
$bobTrigger = New-ScheduledTaskTrigger -Daily -At $At
$bobSettings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$bobPrincipal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $bobName -Action $bobAction -Trigger $bobTrigger -Settings $bobSettings -Principal $bobPrincipal -Description 'Encrypted local BOB backups; credentials loaded only from excluded .env' -Force | Out-Null
Write-Output ('Registered daily local backup at ' + $At + '; requires this Windows user session and internet.')
