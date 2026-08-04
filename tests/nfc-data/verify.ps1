param(
    [Parameter(Mandatory = $true)]
    [string]$UcdDir
)

$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$ucd = (Resolve-Path -LiteralPath $UcdDir).Path
$resultDir = Join-Path $root "results\nfc-data"
New-Item -ItemType Directory -Force -Path $resultDir | Out-Null

function Invoke-Checked {
    param([string]$Label, [scriptblock]$Command)
    & $Command
    if ($LASTEXITCODE -ne 0) {
        throw "$Label failed with exit code $LASTEXITCODE"
    }
}

$expectedInputs = [ordered]@{
    "CompositionExclusions.txt" = "2f239196ef3b5b61db5cc476e9bd80f534d15aa1b74e1be1dea5d042a344c85f"
    "DerivedNormalizationProps.txt" = "71fd6a206a2c0cdd41feb6b7f656aa31091db45e9cedc926985d718397f9e488"
    "NormalizationTest.txt" = "5019ffd530751a741900c849c0e010332f142a3612234639bd200b82138a87db"
    "UnicodeData.txt" = "2e1efc1dcb59c575eedf5ccae60f95229f706ee6d031835247d843c11d96470c"
}
foreach ($entry in $expectedInputs.GetEnumerator()) {
    $path = Join-Path $ucd $entry.Key
    $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToLowerInvariant()
    if ($actual -ne $entry.Value) {
        throw "$($entry.Key) has SHA-256 $actual, expected $($entry.Value)"
    }
}

$generated = Join-Path $resultDir "nfc_unicode_17_0_0.bin"
Invoke-Checked "NFC generator" {
    cargo +stable-x86_64-pc-windows-msvc run `
        --manifest-path (Join-Path $root "tools\unicode-nfc-gen\Cargo.toml") `
        --offline -- $ucd $generated
}
$committed = Join-Path $root "src\bpe\generated\nfc_unicode_17_0_0.bin"
$generatedHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $generated).Hash.ToLowerInvariant()
$committedHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $committed).Hash.ToLowerInvariant()
if ((Get-Item -LiteralPath $generated).Length -ne 19011 -or $generatedHash -ne $committedHash) {
    throw "generated NFC image differs from the committed 19,011-byte image"
}

$env:HYPERTOK_UCD_DIR = $ucd
Remove-Item Env:HYPERTOK_NFC_MUTATION -ErrorAction SilentlyContinue
Invoke-Checked "exhaustive Unicode NFC verification" {
    cargo +nightly-2025-11-15-x86_64-pc-windows-msvc test `
        --manifest-path (Join-Path $root "Cargo.toml") `
        --lib bpe::nfc::tests::exhaustive_unicode_17 --offline -- --ignored --nocapture
}

$mutationEvidence = [ordered]@{}
foreach ($mutation in @("decomposition", "quick-check")) {
    $env:HYPERTOK_NFC_MUTATION = $mutation
    $ErrorActionPreference = "Continue"
    $output = & cargo +nightly-2025-11-15-x86_64-pc-windows-msvc test `
        --manifest-path (Join-Path $root "Cargo.toml") `
        --lib bpe::nfc::tests::exhaustive_unicode_17 --offline -- --ignored 2>&1
    $exitCode = $LASTEXITCODE
    $ErrorActionPreference = "Stop"
    if ($exitCode -eq 0) {
        throw "$mutation mutation stayed green"
    }
    $failure = ($output | Select-String -Pattern "mismatch|assertion" | Select-Object -First 1).Line
    $mutationEvidence[$mutation] = [ordered]@{ exit_code = $exitCode; failure = $failure }
}
Remove-Item Env:HYPERTOK_NFC_MUTATION -ErrorAction SilentlyContinue

Invoke-Checked "restored exhaustive Unicode NFC verification" {
    cargo +nightly-2025-11-15-x86_64-pc-windows-msvc test `
        --manifest-path (Join-Path $root "Cargo.toml") `
        --lib bpe::nfc::tests::exhaustive_unicode_17 --offline -- --ignored --nocapture
}
Invoke-Checked "focused native NFC tests" {
    cargo +nightly-2025-11-15-x86_64-pc-windows-msvc test `
        --manifest-path (Join-Path $root "Cargo.toml") --lib nfc --offline
}
Invoke-Checked "portable NFC loader tests" {
    cargo +stable-x86_64-pc-windows-msvc test `
        --manifest-path (Join-Path $root "Cargo.toml") `
        --test portable_boundaries --features htk,source-loaders --offline
}
Invoke-Checked "portable NFC WebAssembly build" {
    cargo +stable-x86_64-pc-windows-msvc check `
        --manifest-path (Join-Path $root "Cargo.toml") `
        --lib --target wasm32-unknown-unknown --features htk --offline
}

$tree = & cargo +stable-x86_64-pc-windows-msvc tree `
    --manifest-path (Join-Path $root "Cargo.toml") `
    --target wasm32-unknown-unknown --features htk --edges normal --offline 2>&1
if ($LASTEXITCODE -ne 0) {
    throw "portable dependency graph failed"
}
$forbidden = @($tree | Select-String -Pattern "icu v|icu_|unicode-segmentation")
if ($forbidden.Count -ne 0) {
    throw "portable dependency graph contains ICU normalization dependencies: $($forbidden -join '; ')"
}

Invoke-Checked "generator format" {
    cargo +stable-x86_64-pc-windows-msvc fmt `
        --manifest-path (Join-Path $root "tools\unicode-nfc-gen\Cargo.toml") --all -- --check
}
Invoke-Checked "generator lint" {
    cargo +stable-x86_64-pc-windows-msvc clippy `
        --manifest-path (Join-Path $root "tools\unicode-nfc-gen\Cargo.toml") `
        --all-targets --offline -- -D warnings
}
Invoke-Checked "portable NFC lint" {
    cargo +stable-x86_64-pc-windows-msvc clippy `
        --manifest-path (Join-Path $root "Cargo.toml") `
        --lib --target wasm32-unknown-unknown --features htk --offline -- `
        -D warnings `
        -A clippy::too-many-arguments `
        -A clippy::collapsible-if `
        -A clippy::nonminimal-bool `
        -A clippy::needless-return `
        -A clippy::infallible-destructuring-match `
        -A clippy::needless-range-loop
}

$safeRoot = $root.Replace('\', '/')
$commit = (& git -c "safe.directory=$safeRoot" -C $root rev-parse HEAD).Trim()
$report = [ordered]@{
    gate = "nfc-data"
    status = "PASS"
    commit = $commit
    unicode_version = "17.0.0"
    input_digests = $expectedInputs
    image = [ordered]@{
        bytes = 19011
        sha256 = $committedHash
        generator_reproduced = $true
    }
    inventory = [ordered]@{
        canonical_decompositions = 2081
        nonzero_combining_classes = 968
        explicit_exclusions = 81
        permitted_compositions = 961
    }
    verification = [ordered]@{
        unicode_scalars = 1112064
        assigned_scalars = 297334
        normalization_rows = 20034
        normalization_columns = 100170
        portable_loaders = 2
        original_span_paths = 2
        wasm_builds = 1
        forbidden_dependencies = 0
    }
    mutations_red = $mutationEvidence
}
$reportPath = Join-Path $resultDir "report.json"
$report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $reportPath -Encoding UTF8
$reportHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $reportPath).Hash.ToLowerInvariant()
Write-Output "NFC_DATA_PASS commit=$commit image_bytes=19011 image_sha256=$committedHash report_sha256=$reportHash"
