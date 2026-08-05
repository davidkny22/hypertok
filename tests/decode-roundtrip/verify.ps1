$ErrorActionPreference = "Stop"
$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..\..")).Path
$o200k = Join-Path $root "hypertok-vocab\o200k\vocab.htk"
$sentencePiece = Join-Path $root "tests\fixtures\sentencepiece.htk"
$manifestPath = Join-Path $root "benches\corpus\manifest.json"
$corpus = @()
$manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
foreach ($workload in $manifest.workloads) {
    if ($null -eq $workload.compression) {
        $corpus += Join-Path (Join-Path $root "benches\corpus") $workload.path
    }
}
foreach ($path in @($o200k, $sentencePiece) + $corpus) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "decode input is absent: $path"
    }
}

$env:RUSTC_BOOTSTRAP = "1"
cargo +stable-x86_64-pc-windows-msvc run --release --offline --features htk,sentencepiece-core `
    --example htk_decode_roundtrip -- $o200k $sentencePiece @corpus
if ($LASTEXITCODE -ne 0) { throw "native decode verifier failed" }
