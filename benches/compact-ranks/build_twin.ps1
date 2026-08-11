param(
    [string]$OutputRoot = "results/week-campaign/increment3/compact-ranks"
)

$ErrorActionPreference = "Stop"

$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "../..")).Path
$manifest = Join-Path $root "Cargo.toml"
$output = [IO.Path]::GetFullPath((Join-Path $root $OutputRoot))
$target = Join-Path $output "no-compact-target"
$binding = Join-Path $output "no-compact"
$features = @(
    "portable-json"
    "wasm-binding"
    "htk"
    "sentencepiece-core"
    "opt-marshalling"
    "opt-chunk-prescan"
    "opt-scan-two-phase"
    "opt-level-select"
    "opt-cold-diet"
    "opt-fused-pair-ranks"
    "opt-decode-assembly"
    "opt-decode-borrowed-output"
    "opt-decode-utf16-output"
) -join ","

New-Item -ItemType Directory -Force -Path $binding | Out-Null
$previousRustFlags = $env:RUSTFLAGS
try {
    $env:RUSTFLAGS = "-C target-feature=+simd128"
    & cargo +stable-x86_64-pc-windows-msvc build `
        --manifest-path $manifest `
        --target wasm32-unknown-unknown `
        --release `
        --locked `
        --no-default-features `
        --features $features `
        --target-dir $target
    if ($LASTEXITCODE -ne 0) { throw "no-compact WebAssembly build failed" }
} finally {
    $env:RUSTFLAGS = $previousRustFlags
}

$raw = Join-Path $target "wasm32-unknown-unknown/release/hypertok.wasm"
& wasm-bindgen $raw --out-dir $binding --target web --no-typescript --out-name hypertok_wasm_core
if ($LASTEXITCODE -ne 0) { throw "no-compact wasm-bindgen failed" }

$bound = Join-Path $binding "hypertok_wasm_core_bg.wasm"
[pscustomobject]@{
    path = $bound
    bytes = (Get-Item -LiteralPath $bound).Length
    sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $bound).Hash.ToLowerInvariant()
    features = $features
} | ConvertTo-Json | Write-Output
