$ErrorActionPreference = "Stop"
$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..\..")).Path
$formatManifest = Join-Path $root "hypertok-format\Cargo.toml"
$converterManifest = Join-Path $root "hypertok-converter\Cargo.toml"
$toolchain = "+stable-x86_64-pc-windows-msvc"

cargo $toolchain fmt --manifest-path $formatManifest --all -- --check
if ($LASTEXITCODE -ne 0) { throw "format rustfmt failed" }
cargo $toolchain fmt --manifest-path $converterManifest --all -- --check
if ($LASTEXITCODE -ne 0) { throw "converter rustfmt failed" }

cargo $toolchain test --manifest-path $formatManifest --offline
if ($LASTEXITCODE -ne 0) { throw "format tests failed" }
cargo $toolchain test --manifest-path $converterManifest --offline
if ($LASTEXITCODE -ne 0) { throw "converter tests failed" }

cargo $toolchain clippy --manifest-path $formatManifest --all-targets --offline -- -D warnings
if ($LASTEXITCODE -ne 0) { throw "format clippy failed" }
cargo $toolchain clippy --manifest-path $converterManifest --all-targets --offline -- -D warnings
if ($LASTEXITCODE -ne 0) { throw "converter clippy failed" }

cargo $toolchain check --manifest-path $formatManifest --target wasm32-unknown-unknown --offline
if ($LASTEXITCODE -ne 0) { throw "format wasm check failed" }
cargo $toolchain check --manifest-path $converterManifest --target wasm32-unknown-unknown --offline
if ($LASTEXITCODE -ne 0) { throw "converter wasm check failed" }

Write-Output "format-foundation PASS: 12 native tests; clippy clean; format and converter wasm checks clean"
