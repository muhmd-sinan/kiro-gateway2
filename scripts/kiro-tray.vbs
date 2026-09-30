' Launches kiro-tray.ps1 with no visible window.
'
' WScript.Shell .Run with intWindowStyle 0 is what actually suppresses the
' console; PowerShell's own -WindowStyle Hidden still flashes a window briefly.
Dim shell, fso, here, ps1
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
ps1 = here & "\kiro-tray.ps1"
shell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & ps1 & """", 0, False
