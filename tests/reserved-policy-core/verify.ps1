$ErrorActionPreference = "Stop"
$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..\..")).Path
$o200k = Join-Path $root "hypertok-vocab\o200k\vocab.htk"
$sentencePiece = Join-Path $root "tests\fixtures\sentencepiece.htk"
if (-not (Test-Path -LiteralPath $o200k -PathType Leaf)) {
    throw "reserved-policy input is absent: $o200k"
}
if (-not (Test-Path -LiteralPath $sentencePiece -PathType Leaf)) {
    throw "reserved-policy SentencePiece input is absent: $sentencePiece"
}
$env:RUSTC_BOOTSTRAP = "1"
cargo +stable-x86_64-pc-windows-msvc test --offline --features htk,sentencepiece-core `
    load_tokenizer::htk_reserved::tests::
if ($LASTEXITCODE -ne 0) { throw "reserved-policy structural-class verifier failed" }
cargo +stable-x86_64-pc-windows-msvc run --offline --features htk `
    --example htk_reserved_policy -- $o200k
if ($LASTEXITCODE -ne 0) { throw "native reserved-policy verifier failed" }

node (Join-Path $root "hypertok-js\tests\verify_reserved_policy.mjs")
if ($LASTEXITCODE -ne 0) { throw "resident-single reserved-policy verifier failed" }
