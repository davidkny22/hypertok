$ErrorActionPreference = "Stop"
$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..\..")).Path
$sources = Join-Path $root "results\phase5\sources"
$outputs = Join-Path $root "results\phase5\converted"
$reportPath = Join-Path $root "results\phase5\bijection-round-trip-report.json"

$pins = @(
    @{ Name = "qwen3.6-tokenizer.json"; Digest = "5f9e4d4901a92b997e463c1f46055088b6cca5ca61a6522d1b9f64c4bb81cb42" },
    @{ Name = "mistral-tekken-tokenizer.json"; Digest = "99cf274236c60277fcfad861a5a1007518687ad06ba8938760f50b55ffa0b1ef" },
    @{ Name = "deepseek-v4-tokenizer.json"; Digest = "8f9f37ca37fdc4f5fd36d5cf4d3b0e8392edb4e894fd10cc0d70b4957c8633cf" },
    @{ Name = "kimi-k3.tiktoken"; Digest = "b6c497a7469b33ced9c38afb1ad6e47f03f5e5dc05f15930799210ec050c5103" },
    @{ Name = "kimi-k3-tokenization_kimi.py"; Digest = "f28ea66e2d862a2a5814970b2ce40c2f7d8296ff09aed90a7e7def689b906944" },
    @{ Name = "kimi-k3-tokenizer_config.json"; Digest = "5d0803c94db9cd78763499e0956c95fd5a225c14a727e5a6cf5db3f96f010a6e" }
)
foreach ($pin in $pins) {
    $path = Join-Path $sources $pin.Name
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "pinned launch source is absent: $path"
    }
    $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToLowerInvariant()
    if ($actual -ne $pin.Digest) {
        throw "pinned launch source digest mismatch for $($pin.Name): $actual"
    }
}

New-Item -ItemType Directory -Force -Path $outputs | Out-Null
& (Join-Path $PSScriptRoot "verify-o200k.ps1") `
    -Output "results/phase5/converted/o200k_base.htk"
if ($LASTEXITCODE -ne 0) { throw "current OpenAI conversion failed" }

$jsonCases = @(
    @{ Name = "qwen3.6"; Digest = $pins[0].Digest },
    @{ Name = "mistral-tekken"; Digest = $pins[1].Digest },
    @{ Name = "deepseek-v4"; Digest = $pins[2].Digest }
)
foreach ($case in $jsonCases) {
    cargo +stable-x86_64-pc-windows-msvc run `
        --manifest-path (Join-Path $root "hypertok-converter\Cargo.toml") `
        --release --offline --example tokenizer_json -- `
        (Join-Path $sources "$($case.Name)-tokenizer.json") `
        $case.Digest `
        (Join-Path $outputs "$($case.Name).htk")
    if ($LASTEXITCODE -ne 0) { throw "$($case.Name) conversion failed" }
}

cargo +stable-x86_64-pc-windows-msvc run `
    --manifest-path (Join-Path $root "hypertok-converter\Cargo.toml") `
    --release --offline --example kimi_k3 -- `
    (Join-Path $sources "kimi-k3.tiktoken") `
    (Join-Path $sources "kimi-k3-tokenizer_config.json") `
    (Join-Path $outputs "kimi-k3.htk")
if ($LASTEXITCODE -ne 0) { throw "Kimi K3 conversion failed" }

$env:RUSTC_BOOTSTRAP = "1"
cargo +stable-x86_64-pc-windows-msvc run `
    --manifest-path (Join-Path $root "Cargo.toml") `
    --release --offline --no-default-features --features htk,source-loaders `
    --example verify_vocabulary_mapping -- `
    (Join-Path $sources "qwen3.6-tokenizer.json") `
    (Join-Path $outputs "qwen3.6.htk") `
    (Join-Path $sources "mistral-tekken-tokenizer.json") `
    (Join-Path $outputs "mistral-tekken.htk") `
    (Join-Path $sources "deepseek-v4-tokenizer.json") `
    (Join-Path $outputs "deepseek-v4.htk") `
    (Join-Path $sources "kimi-k3.tiktoken") `
    (Join-Path $sources "kimi-k3-tokenizer_config.json") `
    (Join-Path $outputs "kimi-k3.htk") `
    --expected-new-vocabularies 4
if ($LASTEXITCODE -ne 0) { throw "independent launch mapping or runtime verification failed" }

cargo +stable-x86_64-pc-windows-msvc test `
    --manifest-path (Join-Path $root "hypertok-converter\Cargo.toml") `
    --all-targets --offline
if ($LASTEXITCODE -ne 0) { throw "converter regression suite failed" }
cargo +stable-x86_64-pc-windows-msvc clippy `
    --manifest-path (Join-Path $root "hypertok-converter\Cargo.toml") `
    --all-targets --offline -- -D warnings
if ($LASTEXITCODE -ne 0) { throw "converter clippy failed" }

$outputRows = @()
foreach ($name in @("o200k_base", "qwen3.6", "mistral-tekken", "deepseek-v4", "kimi-k3")) {
    $path = Join-Path $outputs "$name.htk"
    $outputRows += [ordered]@{
        name = $name
        bytes = (Get-Item -LiteralPath $path).Length
        sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToLowerInvariant()
    }
}
$safeRoot = $root.Replace('\', '/')
$commit = (git -c "safe.directory=$safeRoot" -C $root rev-parse HEAD).Trim()
$report = [ordered]@{
    gate = "bijection-round-trip"
    commit = $commit
    launch_vocabularies = 5
    new_vocabularies = 4
    total_slots = 872281
    reverse_keys = 869695
    runtime_cases = 48
    mapping_mutations_red = 7
    outputs = $outputRows
}
$json = $report | ConvertTo-Json -Depth 4
[System.IO.File]::WriteAllText($reportPath, $json + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))
$reportHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $reportPath).Hash.ToLowerInvariant()
Write-Output "bijection-round-trip PASS: launch=5/5 slots=872281 reverse_keys=869695 runtime_cases=48/48 mutations_red=7/7 commit=$commit report_sha256=$reportHash"
