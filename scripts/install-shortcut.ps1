# Creates a Start Menu shortcut that launches the Kiro proxy into the tray.
#
# Run once. Idempotent: re-running just overwrites the .lnk.

$ErrorActionPreference = 'Stop'

$vbs = Join-Path $PSScriptRoot 'kiro-tray.vbs'
if (-not (Test-Path $vbs)) { throw "Missing $vbs" }

$startMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
$lnk = Join-Path $startMenu 'Kiro Proxy.lnk'

$node = (Get-Command node -ErrorAction SilentlyContinue).Source

$shell = New-Object -ComObject WScript.Shell
$sc = $shell.CreateShortcut($lnk)
$sc.TargetPath = "$env:SystemRoot\System32\wscript.exe"
$sc.Arguments = "`"$vbs`""
$sc.WorkingDirectory = Split-Path -Parent $PSScriptRoot
$sc.Description = 'Start the Kiro proxy in the notification area'
$sc.WindowStyle = 7
if ($node) { $sc.IconLocation = "$node,0" }
$sc.Save()

Write-Host "Created: $lnk"
Write-Host "Search 'Kiro Proxy' in the Start Menu to launch it."
Write-Host ''
Write-Host 'To start it automatically at login, copy the shortcut to:'
Write-Host "  $env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup"
