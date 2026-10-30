param([Parameter(Mandatory = $true)][string]$Source)
$ErrorActionPreference = 'Stop'
try {
    $workerSpec = ConvertFrom-Json -InputObject $env:DSH_BRIDGE_WORKER_SPEC
    if (-not $workerSpec.executable) { throw 'Missing worker executable' }
    Add-Type -Path $Source
    [Environment]::SetEnvironmentVariable('DSH_BRIDGE_WORKER_SPEC', $null)
    $workerExitCode = [DshBridge.JobHost]::Run([string]$workerSpec.executable, [string[]]$workerSpec.args)
    exit $workerExitCode
} catch {
    [Console]::Error.WriteLine('DSH worker host: ' + $_.Exception.Message)
    exit 125
}
