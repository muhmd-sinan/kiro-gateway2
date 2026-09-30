# Tray host for the Kiro proxy.
#
# Runs `node dist/server/cli.js` as a hidden child process and surfaces it as a
# notification-area icon instead of a console window. Windows puts new tray icons
# in the overflow ("hidden icons") flyout by default, which is where this lands.
#
# Launched via kiro-tray.vbs so no console flashes on start.

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$ErrorActionPreference = 'Stop'

$repo    = Split-Path -Parent $PSScriptRoot
$entry   = Join-Path $repo 'dist\server\cli.js'
$logDir  = Join-Path $env:LOCALAPPDATA 'KiroProxy'
$logFile = Join-Path $logDir 'proxy.log'
$errFile = Join-Path $logDir 'proxy.err.log'

New-Item -ItemType Directory -Path $logDir -Force | Out-Null

if (-not (Test-Path $entry)) {
  [System.Windows.Forms.MessageBox]::Show(
    "Build output missing:`n$entry`n`nRun 'npm run build' in the repo first.",
    'Kiro Proxy', 'OK', 'Error') | Out-Null
  exit 1
}

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) {
  [System.Windows.Forms.MessageBox]::Show(
    'node was not found on PATH.', 'Kiro Proxy', 'OK', 'Error') | Out-Null
  exit 1
}

# Start hidden, with output redirected straight to files.
#
# Letting the OS write the files beats draining the pipes from PowerShell event
# handlers: those run concurrently, and two handlers appending to the same file
# lose lines to lock contention (the startup banner, which carries the bearer
# token, is written as one burst and disappears entirely).
$proc = Start-Process -FilePath $node -ArgumentList "`"$entry`"" `
  -WorkingDirectory $repo -WindowStyle Hidden -PassThru `
  -RedirectStandardOutput $logFile -RedirectStandardError $errFile

$tokenFile = Join-Path $env:APPDATA 'opencode\kiro-proxy-token'
$port = if ($env:KIRO_PROXY_PORT) { $env:KIRO_PROXY_PORT } else { '19899' }
$url  = "http://127.0.0.1:$port"

$icon = New-Object System.Windows.Forms.NotifyIcon
$icon.Icon = [System.Drawing.Icon]::ExtractAssociatedIcon($node)
$icon.Text = "Kiro Proxy - $url"
$icon.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip

$miStatus = $menu.Items.Add('Check health')
$miStatus.Add_Click({
  try {
    $r = Invoke-RestMethod -Uri "$url/health" -TimeoutSec 5
    $icon.ShowBalloonTip(4000, 'Kiro Proxy', ($r | ConvertTo-Json -Compress), 'Info')
  } catch {
    $icon.ShowBalloonTip(4000, 'Kiro Proxy', "Not responding on $url", 'Error')
  }
})

$miToken = $menu.Items.Add('Copy bearer token')
$miToken.Add_Click({
  if (Test-Path $tokenFile) {
    (Get-Content $tokenFile -Raw).Trim() | Set-Clipboard
    $icon.ShowBalloonTip(3000, 'Kiro Proxy', 'Token copied to clipboard.', 'Info')
  } else {
    $icon.ShowBalloonTip(3000, 'Kiro Proxy', 'No token file yet.', 'Warning')
  }
})

$miLog = $menu.Items.Add('Open log')
$miLog.Add_Click({ Start-Process notepad.exe $logFile })

$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null

$miQuit = $menu.Items.Add('Stop proxy and exit')
$miQuit.Add_Click({
  try { if (-not $proc.HasExited) { $proc.Kill() } } catch {}
  $icon.Visible = $false
  $icon.Dispose()
  [System.Windows.Forms.Application]::Exit()
})

$icon.ContextMenuStrip = $menu
$icon.Add_MouseDoubleClick({ Start-Process notepad.exe $logFile })

# If the child dies on its own, don't leave a dead icon behind.
$proc.EnableRaisingEvents = $true
Register-ObjectEvent -InputObject $proc -EventName Exited -Action {
  $icon.Visible = $false
  $icon.Dispose()
  [System.Windows.Forms.Application]::Exit()
} | Out-Null

[System.Windows.Forms.Application]::Run()
