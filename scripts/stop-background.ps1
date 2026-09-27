$ProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
& node.exe (Join-Path $PSScriptRoot 'stop-background.mjs')
if ($LASTEXITCODE -ne 0) { throw '停止请求失败' }
