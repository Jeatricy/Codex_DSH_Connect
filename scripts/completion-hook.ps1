param(
  [Parameter(Mandatory=$true)][string]$NodePath,
  [Parameter(Mandatory=$true)][string]$StateDir
)
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8
$hookInput = [Console]::In.ReadToEnd()
$hookScript = Join-Path $PSScriptRoot 'completion-hook.mjs'
$hookInput | & $NodePath --no-warnings $hookScript --state-dir $StateDir
exit $LASTEXITCODE
