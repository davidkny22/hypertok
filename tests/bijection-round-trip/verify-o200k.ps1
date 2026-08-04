param(
    [string]$Source = "results/sources/o200k_base.tiktoken",
    [string]$Output = "results/phase2/converted/o200k_base.htk"
)

$ErrorActionPreference = "Stop"
$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..\..")).Path
$sourcePath = [System.IO.Path]::GetFullPath((Join-Path $root $Source))
$specialsPath = Join-Path $PSScriptRoot "o200k-specials.json"
$outputPath = [System.IO.Path]::GetFullPath((Join-Path $root $Output))
$expectedSourceHash = "446a9538cb6c348e3516120d7c08b09f57c36495e2acfffe59a5bf8b0cfb1a2d"

if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
    throw "pinned o200k source is absent: $sourcePath"
}
$sourceHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $sourcePath).Hash.ToLowerInvariant()
if ($sourceHash -ne $expectedSourceHash) {
    throw "pinned o200k source digest mismatch: $sourceHash"
}
$specials = Get-Content -Raw -LiteralPath $specialsPath | ConvertFrom-Json
if ($specials.sourceSha256 -ne $expectedSourceHash) {
    throw "o200k special-token metadata names a different source digest"
}
if ($specials.specialTokens.'<|endoftext|>' -ne 199999 -or $specials.specialTokens.'<|endofprompt|>' -ne 200018) {
    throw "o200k special-token metadata no longer carries the expected ids"
}
$exampleText = Get-Content -Raw -LiteralPath (Join-Path $root "hypertok-converter\examples\o200k_base.rs")
if ($exampleText -notmatch 'bytes:\s*b"<\|endoftext\|>",\s*id:\s*199_999' -or $exampleText -notmatch 'bytes:\s*b"<\|endofprompt\|>",\s*id:\s*200_018') {
    throw "o200k converter special ids disagree with the independent metadata"
}

New-Item -ItemType Directory -Force -Path ([System.IO.Path]::GetDirectoryName($outputPath)) | Out-Null
& (Join-Path $root "tests\format-foundation\verify.ps1")
if ($LASTEXITCODE -ne 0) { throw "format foundation failed" }

cargo +stable-x86_64-pc-windows-msvc run `
    --manifest-path (Join-Path $root "hypertok-converter\Cargo.toml") `
    --release --offline --example o200k_base -- $sourcePath $outputPath
if ($LASTEXITCODE -ne 0) { throw "o200k conversion or independent verification failed" }

$outputHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $outputPath).Hash.ToLowerInvariant()
$outputSize = (Get-Item -LiteralPath $outputPath).Length
Write-Output "bijection-round-trip PASS: o200k_base bytes=$outputSize sha256=$outputHash"
