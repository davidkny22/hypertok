param(
    [string]$OutputDirectory = "results/hash-portability",
    [int]$KeyCount = 65536
)

$ErrorActionPreference = "Stop"
$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..\..")).Path
$output = [System.IO.Path]::GetFullPath((Join-Path $root $OutputDirectory))
$hashCrate = Join-Path $root "hypertok-hash"
$wasmCrate = Join-Path $PSScriptRoot "wasm"

New-Item -ItemType Directory -Force -Path $output | Out-Null

Push-Location $hashCrate
try {
    cargo +stable-x86_64-pc-windows-msvc fmt --check
    if ($LASTEXITCODE -ne 0) { throw "rustfmt failed" }
    cargo +stable-x86_64-pc-windows-msvc test --features builder
    if ($LASTEXITCODE -ne 0) { throw "native hash tests failed" }
    cargo +stable-x86_64-pc-windows-msvc check --target wasm32-unknown-unknown
    if ($LASTEXITCODE -ne 0) { throw "default wasm build failed" }
    $tree = cargo +stable-x86_64-pc-windows-msvc tree --target wasm32-unknown-unknown -e features
    if ($LASTEXITCODE -ne 0) { throw "wasm feature tree failed" }
    $forbidden = @("gxhash", "ptr_hash", "sucds", "ph v", "rayon", "voracious_radix_sort")
    foreach ($name in $forbidden) {
        if ($tree -match [regex]::Escape($name)) { throw "forbidden wasm dependency: $name" }
    }
    $tree | Set-Content -LiteralPath (Join-Path $output "wasm-feature-tree.txt") -Encoding utf8
    cargo +stable-x86_64-pc-windows-msvc run --release --features builder --example portable_fixture -- $output $KeyCount
    if ($LASTEXITCODE -ne 0) { throw "fixture generation failed" }
} finally {
    Pop-Location
}

$env:HYPERTOK_HASH_FIXTURE_DIR = $output.Replace("\", "/")
Push-Location $wasmCrate
try {
    cargo +stable-x86_64-pc-windows-msvc build --release --target wasm32-unknown-unknown
    if ($LASTEXITCODE -ne 0) { throw "wasm probe build failed" }
} finally {
    Pop-Location
}

$wasm = Join-Path $wasmCrate "target\wasm32-unknown-unknown\release\hypertok_hash_wasm_probe.wasm"
node (Join-Path $PSScriptRoot "verify.mjs") $wasm (Join-Path $output "image.bin") (Join-Path $output "inputs.bin")
if ($LASTEXITCODE -ne 0) { throw "cross-architecture verifier failed" }

Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $output "image.bin"),(Join-Path $output "inputs.bin"),$wasm |
    ForEach-Object { "{0}`t{1}" -f $_.Hash.ToLowerInvariant(),$_.Path }
