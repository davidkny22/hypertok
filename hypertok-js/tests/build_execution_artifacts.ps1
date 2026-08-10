param(
    [string]$OutputRoot = "",
    [string]$ArtifactManifest = ""
)

$ErrorActionPreference = "Stop"

$root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$manifest = Join-Path $root "Cargo.toml"
$resultRoot = if ($OutputRoot) {
    [IO.Path]::GetFullPath((Join-Path $root $OutputRoot))
} else {
    Join-Path $root "results\execution-tiers"
}
$singleTarget = Join-Path $resultRoot "single-target"
$singleSourceTarget = Join-Path $resultRoot "single-source-target"
$singleShippingScalarTarget = Join-Path $resultRoot "single-shipping-scalar-target"
$sharedTarget = Join-Path $resultRoot "shared-target"
$singleOutput = Join-Path $resultRoot "single"
$singleSourceOutput = Join-Path $resultRoot "single-source"
$singleShippingScalarOutput = Join-Path $resultRoot "single-shipping-scalar"
$sharedOutput = Join-Path $resultRoot "shared"
$singleSimdTarget = Join-Path $resultRoot "single-simd-target"
$sharedSimdTarget = Join-Path $resultRoot "shared-simd-target"
$singleSimdOutput = Join-Path $resultRoot "single-simd"
$sharedSimdOutput = Join-Path $resultRoot "shared-simd"
$shippingOptimizations = @(
    "opt-marshalling"
    "opt-chunk-prescan"
    "opt-scan-two-phase"
    "opt-level-select"
    "opt-cold-diet"
    "opt-fused-pair-ranks"
    "opt-compact-ranks"
)
$shippingSingleOptimizations = @($shippingOptimizations) + @(
    "opt-decode-assembly"
    "opt-decode-borrowed-output"
)
$shippingSingleFeatures = (@(
    "portable-json"
    "wasm-binding"
    "htk"
    "sentencepiece-core"
) + $shippingSingleOptimizations) -join ","
$shippingSharedFeatures = (@(
    "portable-json"
    "threaded-wasm"
    "sentencepiece-core"
) + $shippingOptimizations) -join ","

New-Item -ItemType Directory -Force `
    $singleOutput, $singleSourceOutput, $singleShippingScalarOutput, `
    $sharedOutput, $singleSimdOutput, $sharedSimdOutput | Out-Null

& cargo +stable-x86_64-pc-windows-msvc build `
    --manifest-path $manifest `
    --target wasm32-unknown-unknown `
    --release `
    --locked `
    --no-default-features `
    --features portable-json,wasm-binding,htk,sentencepiece-core `
    --target-dir $singleTarget
if ($LASTEXITCODE -ne 0) { throw "unthreaded WebAssembly build failed" }

$singleWasm = Join-Path $singleTarget "wasm32-unknown-unknown\release\hypertok.wasm"
& wasm-bindgen $singleWasm --out-dir $singleOutput --target web --no-typescript `
    --out-name hypertok_wasm_core
if ($LASTEXITCODE -ne 0) { throw "unthreaded wasm-bindgen failed" }

& cargo +stable-x86_64-pc-windows-msvc build `
    --manifest-path $manifest `
    --target wasm32-unknown-unknown `
    --release `
    --locked `
    --no-default-features `
    --features portable-json,wasm-binding,htk,sentencepiece-core,source-loaders `
    --target-dir $singleSourceTarget
if ($LASTEXITCODE -ne 0) { throw "source-loader WebAssembly build failed" }

$singleSourceWasm = Join-Path $singleSourceTarget "wasm32-unknown-unknown\release\hypertok.wasm"
& wasm-bindgen $singleSourceWasm --out-dir $singleSourceOutput --target web --no-typescript `
    --out-name hypertok_wasm_core
if ($LASTEXITCODE -ne 0) { throw "source-loader wasm-bindgen failed" }

& cargo +stable-x86_64-pc-windows-msvc build `
    --manifest-path $manifest `
    --target wasm32-unknown-unknown `
    --release `
    --locked `
    --no-default-features `
    --features $shippingSingleFeatures `
    --target-dir $singleShippingScalarTarget
if ($LASTEXITCODE -ne 0) { throw "shipping scalar WebAssembly build failed" }

$singleShippingScalarWasm = Join-Path $singleShippingScalarTarget "wasm32-unknown-unknown\release\hypertok.wasm"
& wasm-bindgen $singleShippingScalarWasm --out-dir $singleShippingScalarOutput --target web --no-typescript `
    --out-name hypertok_wasm_core
if ($LASTEXITCODE -ne 0) { throw "shipping scalar wasm-bindgen failed" }

$previousRustFlags = $env:RUSTFLAGS
try {
    $env:RUSTFLAGS = @(
        "-C target-feature=+atomics,+bulk-memory"
        "-C link-arg=--shared-memory"
        "-C link-arg=--max-memory=1073741824"
        "-C link-arg=--import-memory"
        "-C link-arg=--export=__wasm_init_tls"
        "-C link-arg=--export=__tls_size"
        "-C link-arg=--export=__tls_align"
        "-C link-arg=--export=__tls_base"
    ) -join " "
    & cargo +nightly-2025-11-15-x86_64-pc-windows-msvc build `
        --manifest-path $manifest `
        --target wasm32-unknown-unknown `
        --release `
        --locked `
        --no-default-features `
        --features portable-json,threaded-wasm,sentencepiece-core `
        -Z build-std=std,panic_abort `
        --target-dir $sharedTarget
    if ($LASTEXITCODE -ne 0) { throw "threaded WebAssembly build failed" }
} finally {
    $env:RUSTFLAGS = $previousRustFlags
}

$sharedWasm = Join-Path $sharedTarget "wasm32-unknown-unknown\release\hypertok.wasm"
& wasm-bindgen $sharedWasm --out-dir $sharedOutput --target web --no-typescript `
    --out-name hypertok_wasm_core
if ($LASTEXITCODE -ne 0) { throw "threaded wasm-bindgen failed" }

$previousRustFlags = $env:RUSTFLAGS
try {
    $env:RUSTFLAGS = "-C target-feature=+simd128"
    & cargo +stable-x86_64-pc-windows-msvc build `
        --manifest-path $manifest `
        --target wasm32-unknown-unknown `
        --release `
        --locked `
        --no-default-features `
        --features $shippingSingleFeatures `
        --target-dir $singleSimdTarget
    if ($LASTEXITCODE -ne 0) { throw "simd128 unthreaded WebAssembly build failed" }
} finally {
    $env:RUSTFLAGS = $previousRustFlags
}

$singleSimdWasm = Join-Path $singleSimdTarget "wasm32-unknown-unknown\release\hypertok.wasm"
& wasm-bindgen $singleSimdWasm --out-dir $singleSimdOutput --target web --no-typescript `
    --out-name hypertok_wasm_core
if ($LASTEXITCODE -ne 0) { throw "simd128 unthreaded wasm-bindgen failed" }

$previousRustFlags = $env:RUSTFLAGS
try {
    $env:RUSTFLAGS = @(
        "-C target-feature=+atomics,+bulk-memory,+simd128"
        "-C link-arg=--shared-memory"
        "-C link-arg=--max-memory=1073741824"
        "-C link-arg=--import-memory"
        "-C link-arg=--export=__wasm_init_tls"
        "-C link-arg=--export=__tls_size"
        "-C link-arg=--export=__tls_align"
        "-C link-arg=--export=__tls_base"
    ) -join " "
    & cargo +nightly-2025-11-15-x86_64-pc-windows-msvc build `
        --manifest-path $manifest `
        --target wasm32-unknown-unknown `
        --release `
        --locked `
        --no-default-features `
        --features $shippingSharedFeatures `
        -Z build-std=std,panic_abort `
        --target-dir $sharedSimdTarget
    if ($LASTEXITCODE -ne 0) { throw "simd128 threaded WebAssembly build failed" }
} finally {
    $env:RUSTFLAGS = $previousRustFlags
}

$sharedSimdWasm = Join-Path $sharedSimdTarget "wasm32-unknown-unknown\release\hypertok.wasm"
& wasm-bindgen $sharedSimdWasm --out-dir $sharedSimdOutput --target web --no-typescript `
    --out-name hypertok_wasm_core
if ($LASTEXITCODE -ne 0) { throw "simd128 threaded wasm-bindgen failed" }

function Relative-To-Repository([string]$Path) {
    $resolved = [IO.Path]::GetFullPath($Path)
    if (-not $resolved.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "artifact path escapes the repository: $resolved"
    }
    return $resolved.Substring($root.Length + 1).Replace("\", "/")
}

function Artifact-File([string]$Role, [string]$Path) {
    $file = Get-Item -LiteralPath $Path
    return [ordered]@{
        role = $Role
        path = Relative-To-Repository $file.FullName
        bytes = $file.Length
        sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $file.FullName).Hash.ToLowerInvariant()
    }
}

$artifacts = @(
    [ordered]@{
        id = "single-scalar"
        threading = "single"
        simdLevel = "scalar"
        features = @("portable-json", "wasm-binding", "htk", "sentencepiece-core")
        files = @(
            Artifact-File "raw-wasm" $singleWasm
            Artifact-File "javascript" (Join-Path $singleOutput "hypertok_wasm_core.js")
            Artifact-File "bound-wasm" (Join-Path $singleOutput "hypertok_wasm_core_bg.wasm")
        )
    }
    [ordered]@{
        id = "single-source-scalar"
        threading = "single"
        simdLevel = "scalar"
        features = @("portable-json", "wasm-binding", "htk", "sentencepiece-core", "source-loaders")
        files = @(
            Artifact-File "raw-wasm" $singleSourceWasm
            Artifact-File "javascript" (Join-Path $singleSourceOutput "hypertok_wasm_core.js")
            Artifact-File "bound-wasm" (Join-Path $singleSourceOutput "hypertok_wasm_core_bg.wasm")
        )
    }
    [ordered]@{
        id = "single-scalar-shipping"
        threading = "single"
        simdLevel = "scalar"
        features = @("portable-json", "wasm-binding", "htk", "sentencepiece-core") + $shippingSingleOptimizations
        files = @(
            Artifact-File "raw-wasm" $singleShippingScalarWasm
            Artifact-File "javascript" (Join-Path $singleShippingScalarOutput "hypertok_wasm_core.js")
            Artifact-File "bound-wasm" (Join-Path $singleShippingScalarOutput "hypertok_wasm_core_bg.wasm")
        )
    }
    [ordered]@{
        id = "shared-scalar"
        threading = "shared"
        simdLevel = "scalar"
        features = @("portable-json", "threaded-wasm", "sentencepiece-core")
        files = @(
            Artifact-File "raw-wasm" $sharedWasm
            Artifact-File "javascript" (Join-Path $sharedOutput "hypertok_wasm_core.js")
            Artifact-File "bound-wasm" (Join-Path $sharedOutput "hypertok_wasm_core_bg.wasm")
        )
    }
    [ordered]@{
        id = "single-simd128-shipping"
        threading = "single"
        simdLevel = "simd128"
        features = @("portable-json", "wasm-binding", "htk", "sentencepiece-core") + $shippingSingleOptimizations
        files = @(
            Artifact-File "raw-wasm" $singleSimdWasm
            Artifact-File "javascript" (Join-Path $singleSimdOutput "hypertok_wasm_core.js")
            Artifact-File "bound-wasm" (Join-Path $singleSimdOutput "hypertok_wasm_core_bg.wasm")
        )
    }
    [ordered]@{
        id = "shared-simd128-shipping"
        threading = "shared"
        simdLevel = "simd128"
        features = @("portable-json", "threaded-wasm", "sentencepiece-core") + $shippingOptimizations
        files = @(
            Artifact-File "raw-wasm" $sharedSimdWasm
            Artifact-File "javascript" (Join-Path $sharedSimdOutput "hypertok_wasm_core.js")
            Artifact-File "bound-wasm" (Join-Path $sharedSimdOutput "hypertok_wasm_core_bg.wasm")
        )
    }
)
$artifactManifestPath = if ($ArtifactManifest) {
    [IO.Path]::GetFullPath((Join-Path $root $ArtifactManifest))
} else {
    Join-Path $resultRoot "artifacts.json"
}
$artifactManifestParent = Split-Path -Parent $artifactManifestPath
New-Item -ItemType Directory -Force $artifactManifestParent | Out-Null
$document = [ordered]@{
    schemaVersion = 1
    artifacts = $artifacts
}
$json = $document | ConvertTo-Json -Depth 8
[IO.File]::WriteAllText(
    $artifactManifestPath,
    $json + [Environment]::NewLine,
    [Text.UTF8Encoding]::new($false)
)

Write-Output "single=$singleOutput"
Write-Output "single-source=$singleSourceOutput"
Write-Output "single-shipping-scalar=$singleShippingScalarOutput"
Write-Output "shared=$sharedOutput"
Write-Output "single-simd=$singleSimdOutput"
Write-Output "shared-simd=$sharedSimdOutput"
Write-Output "artifact-manifest=$artifactManifestPath"
