param(
    [switch]$BuildRuntime
)

$ErrorActionPreference = "Stop"

$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$runtimeOutput = Join-Path $root "results\execution-tiers"
if ($BuildRuntime) {
    & (Join-Path $PSScriptRoot "tests\build_execution_artifacts.ps1")
    if ($LASTEXITCODE -ne 0) { throw "runtime artifact build failed" }
}

$copies = [ordered]@{
    "single-simd\hypertok_wasm_core.js" = "wasm\single\hypertok_wasm_core.js"
    "single-simd\hypertok_wasm_core_bg.wasm" = "wasm\single\hypertok_wasm_core_bg.wasm"
    "shared-simd\hypertok_wasm_core.js" = "wasm\shared\hypertok_wasm_core.js"
    "shared-simd\hypertok_wasm_core_bg.wasm" = "wasm\shared\hypertok_wasm_core_bg.wasm"
}
foreach ($entry in $copies.GetEnumerator()) {
    $source = Join-Path $runtimeOutput $entry.Key
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
        throw "required runtime artifact is missing: $source"
    }
    $destination = Join-Path $PSScriptRoot $entry.Value
    New-Item -ItemType Directory -Force -Path (Split-Path $destination) | Out-Null
    Copy-Item -LiteralPath $source -Destination $destination -Force
}

$snippetSource = Join-Path $runtimeOutput "shared-simd\snippets"
if (-not (Test-Path -LiteralPath $snippetSource -PathType Container)) {
    throw "required shared runtime snippets are missing: $snippetSource"
}
$snippetDestination = Join-Path $PSScriptRoot "wasm\shared\snippets"
if (Test-Path -LiteralPath $snippetDestination) {
    $resolvedDestination = (Resolve-Path -LiteralPath $snippetDestination).Path
    if (-not $resolvedDestination.StartsWith($PSScriptRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "refusing to replace snippets outside the package root: $resolvedDestination"
    }
    Remove-Item -LiteralPath $resolvedDestination -Recurse -Force
}
Copy-Item -LiteralPath $snippetSource -Destination $snippetDestination -Recurse -Force

$workerHelpers = @(Get-ChildItem -Recurse -File -Filter workerHelpers.js -LiteralPath $snippetDestination)
if ($workerHelpers.Count -ne 1) {
    throw "expected exactly one shared worker helper, found $($workerHelpers.Count)"
}
$workerSource = [System.IO.File]::ReadAllText($workerHelpers[0].FullName)
$directoryImport = "import('../../..')"
if (-not $workerSource.Contains($directoryImport)) {
    throw "shared worker helper no longer contains the expected directory import"
}
$workerSource = $workerSource.Replace($directoryImport, "import('../../../hypertok_wasm_core.js')")
[System.IO.File]::WriteAllText(
    $workerHelpers[0].FullName,
    $workerSource,
    [System.Text.UTF8Encoding]::new($false)
)

Get-ChildItem -Recurse -File -LiteralPath (Join-Path $PSScriptRoot "wasm") |
    Sort-Object FullName |
    ForEach-Object { "$($_.FullName) $($_.Length)" }
