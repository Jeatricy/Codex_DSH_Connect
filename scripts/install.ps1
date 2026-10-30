param([string]$Name = 'deepseek_harness')
$ErrorActionPreference = 'Stop'
if ($Name -notmatch '^[A-Za-z0-9_-]+$') { throw 'Invalid MCP server name' }
$bridgeRoot = Split-Path -Parent $PSScriptRoot
$nodeExecutable = (Get-Command node -ErrorAction Stop).Source
$codexExecutable = (Get-Command codex -ErrorAction Stop).Source
$serverPath = Join-Path $bridgeRoot 'server.mjs'
$configPath = Join-Path $bridgeRoot 'bridge.config.json'
$existingConfigPath = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.codex\config.toml'
if ((Test-Path -LiteralPath $existingConfigPath) -and
    ((Get-Content -LiteralPath $existingConfigPath -Raw) -match ('(?m)^\s*\[mcp_servers\.' + [regex]::Escape($Name) + '\]\s*$'))) {
    $existingJson = & $codexExecutable mcp get $Name --json
    if ($LASTEXITCODE -ne 0) { throw 'Unable to inspect the existing MCP entry.' }
    $existing = ($existingJson -join "`n") | ConvertFrom-Json
    $existingTransport = if ($existing.transport) { $existing.transport } else { $existing }
    if (($existingTransport.command -eq $nodeExecutable) -and
        (($existingTransport.args -join "`n") -eq (@($serverPath, '--config', $configPath) -join "`n"))) {
        Write-Output "MCP server already registered: $Name"
        exit 0
    }
    throw "A different MCP server named '$Name' already exists; it was not overwritten."
}
& $codexExecutable mcp add $Name -- $nodeExecutable $serverPath --config $configPath
if ($LASTEXITCODE -ne 0) { throw "Codex MCP registration failed (exit $LASTEXITCODE)." }
Write-Output "Registered MCP server: $Name"
Write-Output 'Reload the MCP server in Codex settings, or start a new chat to load the tools.'
