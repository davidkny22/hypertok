param(
    [switch]$BuildRuntime
)

$ErrorActionPreference = "Stop"

$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$resultsRoot = (Resolve-Path (Join-Path $root "results")).Path
$output = Join-Path $resultsRoot "demo"

if (Test-Path -LiteralPath $output) {
    $resolvedOutput = (Resolve-Path -LiteralPath $output).Path
    $requiredPrefix = $resultsRoot.TrimEnd("\") + "\"
    if (-not $resolvedOutput.StartsWith($requiredPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "refusing to replace output outside results: $resolvedOutput"
    }
    Remove-Item -LiteralPath $resolvedOutput -Recurse -Force
}

if ($BuildRuntime) {
    & (Join-Path $root "hypertok-js\build_package.ps1") -BuildRuntime
    if ($LASTEXITCODE -ne 0) { throw "runtime package build failed" }
}

$packageWasm = Join-Path $root "hypertok-js\wasm"
$vocabSources = [ordered]@{
    "o200k_base.htk" = Join-Path $root "hypertok-vocab\o200k\vocab.htk"
    "qwen3.6.htk" = Join-Path $root "hypertok-vocab\qwen3-6\vocab.htk"
    "mistral-tekken.htk" = Join-Path $root "hypertok-vocab\mistral-tekken\vocab.htk"
    "deepseek-v4.htk" = Join-Path $root "hypertok-vocab\deepseek-v4\vocab.htk"
    "kimi-k3.htk" = Join-Path $root "hypertok-vocab\kimi-k3\vocab.htk"
    "gpt2.htk" = Join-Path $root "hypertok-vocab\gpt2\vocab.htk"
}
$required = @(
    (Join-Path $packageWasm "single\hypertok_wasm_core.js"),
    (Join-Path $packageWasm "single\hypertok_wasm_core_bg.wasm"),
    (Join-Path $packageWasm "shared\hypertok_wasm_core.js"),
    (Join-Path $packageWasm "shared\hypertok_wasm_core_bg.wasm")
)
$required += @(
    (Join-Path $PSScriptRoot "incumbents\js-tiktoken-gpt2.mjs"),
    (Join-Path $PSScriptRoot "incumbents\gpt-tokenizer-gpt2.mjs"),
    (Join-Path $PSScriptRoot "incumbents\dqbd-tiktoken-gpt2.mjs"),
    (Join-Path $PSScriptRoot "incumbents\data\gpt-2.tokenizer.json"),
    (Join-Path $PSScriptRoot "incumbents\data\gpt-2.tokenizer_config.json")
)
$required += $vocabSources.Values
foreach ($path in $required) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "required demo artifact is missing: $path"
    }
}
$workerHelpers = @(Get-ChildItem -Recurse -File -Filter workerHelpers.js -LiteralPath (Join-Path $packageWasm "shared\snippets"))
if ($workerHelpers.Count -ne 1) {
    throw "expected exactly one packaged shared worker helper, found $($workerHelpers.Count)"
}

$expectedVocabHashes = [ordered]@{
    "o200k_base.htk" = "a583ea153eee0f3547df36f1ad2f38e3d1e92c16942f4ddbafa4b7a9979cb111"
    "qwen3.6.htk" = "ddf38305ea3f18a2aee3a073f4fac54b99b9f2aa08ec1967eda2f7ff3fabfb0d"
    "mistral-tekken.htk" = "0f3aaad13e639abe29323c87e75c08159e1fa9d34f96e0b519cf189bfc62f763"
    "deepseek-v4.htk" = "33d3a40a01a6df36bbf98f2be967eef442e7fff0b6ffe766c2b7f987134a06f3"
    "kimi-k3.htk" = "4e0cce4ec2b4b78733882d10756703bdb99db1cada31fc2c3280b0e05c71ab36"
    "gpt2.htk" = "17e4cc7df1f4d95b80c43df52ecc31f9e5931a319e9964cffbf9dc4ed88c9da2"
}
foreach ($entry in $expectedVocabHashes.GetEnumerator()) {
    $path = $vocabSources[$entry.Key]
    $actual = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $entry.Value) {
        throw "vocabulary digest mismatch for $($entry.Key): $actual"
    }
}

$runtimeSource = Join-Path $root "hypertok-js\src"
$esbuildScript = Join-Path $root "benches\node_modules\esbuild\bin\esbuild"
if (-not (Test-Path -LiteralPath $esbuildScript -PathType Leaf)) {
    throw "demo runtime bundler is missing: $esbuildScript"
}
New-Item -ItemType Directory -Force `
    $output, `
    (Join-Path $output "runtime"), `
    (Join-Path $output "wasm\single"), `
    (Join-Path $output "wasm\shared"), `
    (Join-Path $output "vocab") | Out-Null

Copy-Item -LiteralPath (Join-Path $PSScriptRoot "index.html") -Destination $output
Copy-Item -LiteralPath (Join-Path $PSScriptRoot "app.mjs") -Destination $output
Copy-Item -LiteralPath (Join-Path $PSScriptRoot "span-map.mjs") -Destination $output
Copy-Item -LiteralPath (Join-Path $PSScriptRoot "fonts") -Destination (Join-Path $output "fonts") -Recurse
Copy-Item -LiteralPath (Join-Path $PSScriptRoot "incumbents") -Destination (Join-Path $output "incumbents") -Recurse
Copy-Item -LiteralPath (Join-Path $PSScriptRoot "preview.svg") -Destination $output
Copy-Item -LiteralPath (Join-Path $PSScriptRoot "preview.png") -Destination $output
Copy-Item -LiteralPath (Join-Path $PSScriptRoot "budgets.json") -Destination $output
Copy-Item -LiteralPath (Join-Path $root "README.md") -Destination $output
& node $esbuildScript `
    (Join-Path $runtimeSource "index.mjs") `
    "--bundle" `
    "--format=esm" `
    "--platform=browser" `
    "--target=chrome100" `
    "--outfile=$(Join-Path $output 'runtime\index.mjs')"
if ($LASTEXITCODE -ne 0) { throw "demo runtime bundle failed" }
Copy-Item -LiteralPath (Join-Path $runtimeSource "tier-worker.mjs") -Destination (Join-Path $output "runtime")
Copy-Item -LiteralPath (Join-Path $runtimeSource "shared-controller.mjs") -Destination (Join-Path $output "runtime")
Copy-Item -LiteralPath (Join-Path $packageWasm "single\hypertok_wasm_core.js") -Destination (Join-Path $output "wasm\single")
Copy-Item -LiteralPath (Join-Path $packageWasm "single\hypertok_wasm_core_bg.wasm") -Destination (Join-Path $output "wasm\single")
Copy-Item -LiteralPath (Join-Path $packageWasm "shared\hypertok_wasm_core.js") -Destination (Join-Path $output "wasm\shared")
Copy-Item -LiteralPath (Join-Path $packageWasm "shared\hypertok_wasm_core_bg.wasm") -Destination (Join-Path $output "wasm\shared")
Copy-Item -LiteralPath (Join-Path $packageWasm "shared\snippets") -Destination (Join-Path $output "wasm\shared\snippets") -Recurse
foreach ($name in $expectedVocabHashes.Keys) {
    Copy-Item -LiteralPath $vocabSources[$name] -Destination (Join-Path $output "vocab\$name")
}

$files = Get-ChildItem -Recurse -File -LiteralPath $output
$bytes = ($files | Measure-Object -Property Length -Sum).Sum
Write-Output "demo=$output"
Write-Output "files=$($files.Count)"
Write-Output "bytes=$bytes"
