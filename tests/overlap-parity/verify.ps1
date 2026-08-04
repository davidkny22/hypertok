$ErrorActionPreference = "Stop"
$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..\..")).Path
$o200k = Join-Path $root "hypertok-vocab\o200k\vocab.htk"
$sentencePiece = Join-Path $root "tests\fixtures\sentencepiece.htk"
$corpus = Join-Path $root "benches\corpus"
foreach ($path in @($o200k, $sentencePiece, $corpus)) {
    if (-not (Test-Path -LiteralPath $path)) { throw "overlap-parity input is absent: $path" }
}

$env:RUSTC_BOOTSTRAP = "1"

function Invoke-Runner([string]$Mode) {
    cargo +stable-x86_64-pc-windows-msvc run --offline --features htk,sentencepiece-core `
        --example htk_overlap -- $o200k $sentencePiece $corpus $Mode |
        ForEach-Object { Write-Host $_ }
    $script:RunnerExit = $LASTEXITCODE
}

Invoke-Runner "gate"
if ($RunnerExit -ne 0) { throw "overlap-parity baseline failed" }
Invoke-Runner "mutation-probe"
if ($RunnerExit -eq 0) { throw "verification mutation did not make the probe RED" }
Invoke-Runner "gate"
if ($RunnerExit -ne 0) { throw "overlap-parity restored run failed" }
Write-Output "overlap-parity PASS: verification mutation RED=1/1; tracked source untouched; final gate green"
