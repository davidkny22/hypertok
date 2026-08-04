$ErrorActionPreference = "Stop"
$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..\..")).Path
$entry = Join-Path $root "benches\script-measurement\measure.ps1"
if (-not (Test-Path -LiteralPath $entry)) { throw "script-measurement entry point is absent" }

powershell.exe -NoProfile -ExecutionPolicy Bypass -File $entry
if ($LASTEXITCODE -ne 0) { throw "script-measurement gate failed" }
