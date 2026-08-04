$ErrorActionPreference = "Stop"
$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..\..")).Path
$source = Join-Path $root "results\sources\tinyllama-tokenizer.json"
$output = Join-Path $root "results\phase2\converted\llama2.htk"

$sourceHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $source).Hash.ToLowerInvariant()
if ($sourceHash -ne "bcd04f0eadf90287bd26e1a183ac487d8a141b09b06aecb7725bbdd343640f2e") {
    throw "pinned Llama 2 representative digest mismatch: $sourceHash"
}
& (Join-Path $PSScriptRoot "verify-o200k.ps1")
if ($LASTEXITCODE -ne 0) { throw "o200k gate failed" }

cargo +stable-x86_64-pc-windows-msvc run `
    --manifest-path (Join-Path $root "hypertok-converter\Cargo.toml") `
    --release --offline --example llama2 -- $source $output
if ($LASTEXITCODE -ne 0) { throw "Llama 2 conversion failed" }

$outputHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $output).Hash.ToLowerInvariant()
$outputSize = (Get-Item -LiteralPath $output).Length
Write-Output "bijection-round-trip PASS: converted=2/2 llama2_bytes=$outputSize llama2_sha256=$outputHash"
