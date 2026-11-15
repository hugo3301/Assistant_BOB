$ErrorActionPreference = 'Stop'
$bobRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$bobNode = (Get-Command node -ErrorAction Stop).Source
$bobScript = Join-Path $bobRoot 'scripts\backup.mjs'
New-Item -ItemType Directory -Path (Join-Path $bobRoot 'work') -Force | Out-Null
$bobProcess = Start-Process -FilePath $bobNode -ArgumentList ('--env-file=.env "' + $bobScript + '" create --all') -WorkingDirectory $bobRoot -WindowStyle Hidden -Wait -PassThru -RedirectStandardOutput (Join-Path $bobRoot 'work\backup-last-run.log') -RedirectStandardError (Join-Path $bobRoot 'work\backup-last-error.log')
exit $bobProcess.ExitCode
