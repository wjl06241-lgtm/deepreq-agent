param([switch]$Start)
$ErrorActionPreference = 'Stop'
$ProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$RuntimeHome = Join-Path $ProjectRoot 'data\codex-home'
$CodexBinary = (Get-Command codex.exe -ErrorAction Stop).Source
$NodeBinary = (Get-Command node.exe -ErrorAction Stop).Source
New-Item -ItemType Directory -Path $RuntimeHome -Force | Out-Null
# Dedicated runtime configuration; only the existing account login is reused.
# Never print authentication contents.
$SourceHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }
$SourceAuth = Join-Path $SourceHome 'auth.json'
$TargetAuth = Join-Path $RuntimeHome 'auth.json'
if (!(Test-Path -LiteralPath $TargetAuth)) {
  if (!(Test-Path -LiteralPath $SourceAuth)) { throw '未找到本机 Codex 登录，请先登录 Codex。' }
  Copy-Item -LiteralPath $SourceAuth -Destination $TargetAuth
}
$Identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
& icacls.exe $RuntimeHome /inheritance:r /grant:r "${Identity}:(OI)(CI)F" 'SYSTEM:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE -ne 0) { throw '无法设置 Codex 运行目录访问权限' }
$RuntimeConfig = @'
approval_policy = "never"
sandbox_mode = "read-only"
web_search = "disabled"
project_doc_max_bytes = 0
[features]
shell_tool = false
unified_exec = false
code_mode = false
code_mode_host = true
apps = false
plugins = false
browser_use = false
computer_use = false
hooks = false
multi_agent = false
view_image = false
skill_search = false
'@
[IO.File]::WriteAllText((Join-Path $RuntimeHome 'config.toml'), $RuntimeConfig, [Text.UTF8Encoding]::new($false))
$EnvFile = Join-Path $ProjectRoot '.env'
$EnvText = if (Test-Path -LiteralPath $EnvFile) { [IO.File]::ReadAllText($EnvFile) } else { '' }
$Values = @{ ASSISTANT_BACKEND='codex'; CODEX_BIN=$CodexBinary; REQ_CODEX_HOME=$RuntimeHome }
foreach ($Key in $Values.Keys) {
  $Line = $Key + '=' + $Values[$Key]
  $Pattern = '(?m)^' + [regex]::Escape($Key) + '=.*$'
  if ([regex]::IsMatch($EnvText, $Pattern)) {
    $EnvText = [regex]::Replace($EnvText, $Pattern, [Text.RegularExpressions.MatchEvaluator]{ param($m) $Line })
  } else { $EnvText += "`r`n" + $Line }
}
[IO.File]::WriteAllText($EnvFile, $EnvText, [Text.UTF8Encoding]::new($false))
Write-Output '已配置独立 Codex 运行目录和本机后端。'
if ($Start) {
  Start-Process -FilePath $NodeBinary -ArgumentList ('"' + (Join-Path $PSScriptRoot 'background.mjs') + '"') -WorkingDirectory $ProjectRoot -WindowStyle Hidden
  Write-Output '已启动后台守护进程。'
}
