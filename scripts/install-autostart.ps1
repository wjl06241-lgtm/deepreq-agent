$ErrorActionPreference = 'Stop'
$ProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$NodeBinary = (Get-Command node.exe).Source
$VbsPath = Join-Path $ProjectRoot 'data\start-assistant.vbs'
$Command = '"' + $NodeBinary + '" "' + (Join-Path $PSScriptRoot 'background.mjs') + '"'
$Vbs = 'CreateObject("WScript.Shell").Run "' + $Command.Replace('"','""') + '", 0, False'
[IO.File]::WriteAllText($VbsPath, $Vbs, [Text.Encoding]::Unicode)
$Startup = [Environment]::GetFolderPath('Startup')
$Shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $Startup '需求助手.lnk'))
$Shortcut.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
$Shortcut.Arguments = '"' + $VbsPath + '"'
$Shortcut.WorkingDirectory = $ProjectRoot
$Shortcut.Save()
Write-Output '已设置当前用户登录后自动后台启动（无需管理员权限）。'
