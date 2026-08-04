$ErrorActionPreference = "Stop"
$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..\..")).Path
$hostManifest = Join-Path $PSScriptRoot "native\Cargo.toml"
$referenceManifest = Join-Path $PSScriptRoot "gigatoken-reference\Cargo.toml"
$referenceLock = Join-Path $PSScriptRoot "gigatoken-reference\Cargo.lock"
$referenceVerifier = Join-Path $PSScriptRoot "verify_reference.mjs"
$wasmManifest = Join-Path $root "Cargo.toml"
$wasmRunner = Join-Path $PSScriptRoot "measure_wasm.mjs"
$assembler = Join-Path $PSScriptRoot "assemble.mjs"
$publisher = Join-Path $PSScriptRoot "publish.mjs"
$vocab = if ($env:HYPERTOK_SOURCE_RANKS) {
    $env:HYPERTOK_SOURCE_RANKS
} else {
    throw "set HYPERTOK_SOURCE_RANKS or pass --source-ranks to the public benchmark command"
}
$htk = if ($env:HYPERTOK_HTK_PATH) {
    $env:HYPERTOK_HTK_PATH
} else {
    Join-Path $root "hypertok-vocab\o200k\vocab.htk"
}
$corpus = Join-Path $root "benches\corpus"
$output = Join-Path $root "results\script-measurement"
$n = if ($env:HYPERTOK_SCRIPT_N) { [int]$env:HYPERTOK_SCRIPT_N } else { 11 }
$warmup = if ($env:HYPERTOK_SCRIPT_WARMUP) { [int]$env:HYPERTOK_SCRIPT_WARMUP } else { 2 }
$targetBytes = if ($env:HYPERTOK_SCRIPT_TARGET_BYTES) {
    [int]$env:HYPERTOK_SCRIPT_TARGET_BYTES
} else {
    4194304
}
$target = "wasm32-unknown-unknown"
$env:RUSTC_BOOTSTRAP = "1"

if ($n -lt 1 -or $warmup -lt 0 -or $targetBytes -lt 1) {
    throw "invalid script-measurement configuration"
}
foreach ($path in @(
    $hostManifest,$referenceManifest,$referenceLock,$wasmManifest,$wasmRunner,$assembler,$referenceVerifier,
    $publisher,$vocab,$htk,$corpus
)) {
    if (-not (Test-Path -LiteralPath $path)) { throw "script-measurement input is absent: $path" }
}
if ((Get-FileHash -Algorithm SHA256 -LiteralPath $vocab).Hash.ToLowerInvariant() -ne
    "446a9538cb6c348e3516120d7c08b09f57c36495e2acfffe59a5bf8b0cfb1a2d") {
    throw "script-measurement vocabulary digest mismatch"
}
if ((Get-FileHash -Algorithm SHA256 -LiteralPath $htk).Hash.ToLowerInvariant() -ne
    "a583ea153eee0f3547df36f1ad2f38e3d1e92c16942f4ddbafa4b7a9979cb111") {
    throw "script-measurement .htk digest mismatch"
}
node -e "import('./benches/script-measurement/corpus.mjs').then(({loadScriptCorpus}) => console.log('corpus workloads=' + loadScriptCorpus().length))"
if ($LASTEXITCODE -ne 0) { throw "frozen corpus validation failed" }

$hostScalarTarget = Join-Path $output "host-scalar-target"
$hostSimdTarget = Join-Path $output "host-simd-target"
$referenceTarget = Join-Path $output "gigatoken-reference-target"
$wasmScalarTarget = Join-Path $output "wasm-scalar-target"
$wasmSimdTarget = Join-Path $output "wasm-simd-target"
$wasmScalarPackage = Join-Path $output "wasm-scalar-package"
$wasmSimdPackage = Join-Path $output "wasm-simd-package"
$hostScalarRows = Join-Path $output "host-scalar.json"
$hostSimdRows = Join-Path $output "host-simd.json"
$referenceRows = Join-Path $output "gigatoken-reference.json"
$hostAgreement = Join-Path $output "host-agreement.json"
$referenceAgreement = Join-Path $output "gigatoken-reference-agreement.json"
$wasmRows = Join-Path $output "wasm.json"
$report = Join-Path $output "report.json"
New-Item -ItemType Directory -Force -Path $output,$wasmScalarPackage,$wasmSimdPackage | Out-Null

function Invoke-HypertokHost([bool]$Scalar, [string]$TargetDirectory, [string]$OutputPath) {
    $arguments = @(
        "+stable-x86_64-pc-windows-msvc", "run", "--quiet", "--offline", "--release",
        "--manifest-path", $hostManifest, "--target-dir", $TargetDirectory
    )
    if ($Scalar) { $arguments += @("--features", "scalar") }
    $arguments += @("--", $htk, $corpus, $n, $warmup, $targetBytes)
    $json = & cargo @arguments
    if ($LASTEXITCODE -ne 0) { throw "hypertok host script measurement failed" }
    [System.IO.File]::WriteAllLines($OutputPath, [string[]]$json)
}

function Invoke-HostAgreement([string]$TargetDirectory, [string]$OutputPath) {
    $json = cargo +stable-x86_64-pc-windows-msvc run --quiet --offline --release `
        --manifest-path $hostManifest --target-dir $TargetDirectory -- --agreement $htk $corpus
    if ($LASTEXITCODE -ne 0) { throw "hypertok host agreement failed" }
    [System.IO.File]::WriteAllLines($OutputPath, [string[]]$json)
}

function Invoke-GigatokenReference([bool]$Agreement, [string]$OutputPath) {
    $arguments = @(
        "+nightly-2025-11-15-x86_64-pc-windows-msvc", "-Z", "profile-rustflags",
        "run", "--quiet", "--locked", "--release",
        "--manifest-path", $referenceManifest, "--target-dir", $referenceTarget, "--"
    )
    if ($Agreement) {
        $arguments += @("--agreement", $vocab, $corpus)
    } else {
        $arguments += @($vocab, $corpus, $n, $warmup, $targetBytes)
    }
    $json = & cargo @arguments
    if ($LASTEXITCODE -ne 0) { throw "gigatoken reference measurement failed" }
    [System.IO.File]::WriteAllLines($OutputPath, [string[]]$json)
}

function Build-Wasm([string]$RustFlags, [string]$TargetDirectory, [string]$PackageDirectory) {
    $env:RUSTFLAGS = $RustFlags
    cargo +stable-x86_64-pc-windows-msvc build --quiet --offline --release `
        --manifest-path $wasmManifest --features htk,source-loaders --target $target --target-dir $TargetDirectory
    if ($LASTEXITCODE -ne 0) { throw "WebAssembly script-measurement build failed: $RustFlags" }
    $raw = Join-Path $TargetDirectory "$target\release\hypertok.wasm"
    wasm-bindgen --target nodejs --out-dir $PackageDirectory --out-name hypertok_wasm_core $raw
    if ($LASTEXITCODE -ne 0) { throw "wasm-bindgen failed: $RustFlags" }
    return $raw
}

Remove-Item Env:RUSTFLAGS -ErrorAction SilentlyContinue
Invoke-HostAgreement $hostSimdTarget $hostAgreement
Invoke-GigatokenReference $true $referenceAgreement
node $referenceVerifier $hostAgreement $referenceAgreement $referenceManifest $referenceLock "gate"
if ($LASTEXITCODE -ne 0) { throw "gigatoken reference agreement failed" }
node $referenceVerifier $hostAgreement $referenceAgreement $referenceManifest $referenceLock "mutation-revision"
if ($LASTEXITCODE -eq 0) { throw "gigatoken revision mutation did not make agreement RED" }
node $referenceVerifier $hostAgreement $referenceAgreement $referenceManifest $referenceLock "mutation-id"
if ($LASTEXITCODE -eq 0) { throw "gigatoken ID mutation did not make agreement RED" }
Write-Output "gigatoken reference mutations RED=2/2"

Invoke-HypertokHost $true $hostScalarTarget $hostScalarRows
Invoke-HypertokHost $false $hostSimdTarget $hostSimdRows
Invoke-GigatokenReference $false $referenceRows

$scalarRaw = Build-Wasm "-Dwarnings" $wasmScalarTarget $wasmScalarPackage
$simdRaw = Build-Wasm "-Dwarnings -C target-feature=+simd128" $wasmSimdTarget $wasmSimdPackage
if ((Get-FileHash -Algorithm SHA256 -LiteralPath $scalarRaw).Hash -eq
    (Get-FileHash -Algorithm SHA256 -LiteralPath $simdRaw).Hash) {
    throw "scalar and simd128 measurement artifacts are identical"
}

node $wasmRunner `
    (Join-Path $wasmScalarPackage "hypertok_wasm_core.js") `
    (Join-Path $wasmSimdPackage "hypertok_wasm_core.js") `
    $vocab $wasmRows $n $warmup $targetBytes
if ($LASTEXITCODE -ne 0) { throw "WebAssembly script measurement failed" }

node $assembler $hostScalarRows $hostSimdRows $referenceRows $wasmRows $report "gate"
if ($LASTEXITCODE -ne 0) { throw "script-measurement baseline assembly failed" }
node $assembler $hostScalarRows $hostSimdRows $referenceRows $wasmRows (Join-Path $output "mutation.json") "mutation-probe"
if ($LASTEXITCODE -eq 0) { throw "agreement mutation did not make script measurement RED" }
Write-Output "script-measurement mutation RED=1/1"
node $assembler $hostScalarRows $hostSimdRows $referenceRows $wasmRows $report "gate"
if ($LASTEXITCODE -ne 0) { throw "script-measurement final assembly failed" }

$hostScalarExe = Join-Path $hostScalarTarget "release\hypertok-script-measurement-host.exe"
$hostSimdExe = Join-Path $hostSimdTarget "release\hypertok-script-measurement-host.exe"
$referenceExe = Join-Path $referenceTarget "release\hypertok-gigatoken-reference.exe"
node $publisher $report $scalarRaw $simdRaw $hostScalarExe $hostSimdExe $referenceExe $vocab $htk
if ($LASTEXITCODE -ne 0) { throw "script-measurement public report failed" }

$reportHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $report).Hash.ToLowerInvariant()
Write-Output "script-measurement PASS: workloads=10/10 configurations=9/9 rows=90/90 agreement=90/90 mutations RED=3/3 report_sha256=$reportHash"
