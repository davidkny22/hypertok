param(
    [string]$OutputDirectory = "results/load-measurement",
    [Parameter(Mandatory = $true)]
    [string]$O200kPath,
    [Parameter(Mandatory = $true)]
    [string]$LlamaPath,
    [int]$Samples = 31,
    [int]$Warmups = 3,
    [int]$ProbeCount = 500000
)

$ErrorActionPreference = "Stop"
$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..\..")).Path
$o200k = [System.IO.Path]::GetFullPath((Join-Path $root $O200kPath))
$llama = [System.IO.Path]::GetFullPath((Join-Path $root $LlamaPath))
$expected = @{
    $o200k = "a583ea153eee0f3547df36f1ad2f38e3d1e92c16942f4ddbafa4b7a9979cb111"
    $llama = "059d0ebbfb48745fea77a6ac81673444e6c3d9088e94caef1d768083e54995d0"
}

foreach ($path in @($o200k, $llama)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "Missing verified input: $path"
    }
    $observed = (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToLowerInvariant()
    if ($observed -ne $expected[$path]) {
        throw "Input digest mismatch: $path"
    }
}

Push-Location $root
try {
    cargo +stable-x86_64-pc-windows-msvc fmt --manifest-path hypertok-hash/Cargo.toml --all -- --check
    if ($LASTEXITCODE -ne 0) { throw "hash rustfmt failed" }
    cargo +stable-x86_64-pc-windows-msvc fmt --manifest-path benches/load-measurement/Cargo.toml --all -- --check
    if ($LASTEXITCODE -ne 0) { throw "load worker rustfmt failed" }
    cargo +stable-x86_64-pc-windows-msvc test --manifest-path hypertok-hash/Cargo.toml --features builder --offline
    if ($LASTEXITCODE -ne 0) { throw "hash regression tests failed" }
    cargo +stable-x86_64-pc-windows-msvc check --manifest-path hypertok-hash/Cargo.toml --target wasm32-unknown-unknown --offline
    if ($LASTEXITCODE -ne 0) { throw "hash wasm check failed" }
    cargo +stable-x86_64-pc-windows-msvc test --manifest-path benches/load-measurement/Cargo.toml --offline
    if ($LASTEXITCODE -ne 0) { throw "load worker tests failed" }
    cargo +stable-x86_64-pc-windows-msvc clippy --manifest-path benches/load-measurement/Cargo.toml --all-targets --offline -- -D warnings
    if ($LASTEXITCODE -ne 0) { throw "load worker clippy failed" }
    node --check benches/measure_htk_load.mjs
    if ($LASTEXITCODE -ne 0) { throw "load harness syntax check failed" }
    node benches/measure_htk_load.mjs --decision-self-check gate
    if ($LASTEXITCODE -ne 0) { throw "load decision self-check failed" }
    node benches/measure_htk_load.mjs --decision-self-check mutation-probe
    if ($LASTEXITCODE -eq 0) { throw "load decision mutation did not turn RED" }

    $env:HYPERTOK_LOAD_N = [string]$Samples
    $env:HYPERTOK_LOAD_WARMUP_N = [string]$Warmups
    $env:HYPERTOK_MISS_PROBES = [string]$ProbeCount
    $env:HYPERTOK_LOAD_OUTPUT_DIRECTORY = $OutputDirectory.Replace('\', '/')
    node benches/measure_htk_load.mjs $o200k $llama
    if ($LASTEXITCODE -ne 0) { throw "load measurement failed" }

    $reportPath = Join-Path $root "$OutputDirectory\load-measurement.json"
    $report = Get-Content -Raw -LiteralPath $reportPath | ConvertFrom-Json
    if ($report.rows.Count -ne 10) { throw "Expected 10 candidate rows" }
    if ($report.mutationChecks.Count -ne 2) { throw "Expected mutation checks for both inputs" }
    $red = ($report.mutationChecks | Measure-Object -Property red -Sum).Sum
    $total = ($report.mutationChecks | Measure-Object -Property total -Sum).Sum
    if ($red -ne 8 -or $total -ne 8) { throw "Mutation checks were not 8/8 RED" }
    foreach ($row in $report.rows) {
        if ($row.transfer.n -ne $Samples -or $row.decompression.n -ne $Samples -or
            $row.materialisation.n -ne $Samples -or $row.missProbe.n -ne $Samples) {
            throw "$($row.vocabulary)/$($row.candidate): incomplete statistics"
        }
        if ($row.missCount * 20 -ne $row.probeCount * 19) {
            throw "$($row.vocabulary)/$($row.candidate): workload is not exactly 95% misses"
        }
        if ($row.resident.n -ne 1 -or $row.resident.variance -ne 0) {
            throw "$($row.vocabulary)/$($row.candidate): invalid exact resident row"
        }
        if ($row.resident.median -le 0 -or $row.materialisation.median -le 0) {
            throw "$($row.vocabulary)/$($row.candidate): non-positive measurement"
        }
    }
    if ($report.decision.hashScheme -notin @(0, 1)) { throw "No hash_scheme decision" }
    if ($report.decision.hashScheme -ne 0 -or $report.decision.selectedCandidate -ne "table-850") {
        throw "Measured decision no longer supports shipped scheme 0 at density 0.85"
    }
    $selected = $report.rows | Where-Object { $_.candidate -eq $report.decision.selectedCandidate }
    if ($selected.Count -ne 2) { throw "Selected candidate is missing a structural class" }

    $summary = @(
        "rows=$($report.rows.Count)"
        "samples=$Samples"
        "probes_per_row=$ProbeCount"
        "mutations_red=$($red + 1)/$($total + 1)"
        "hash_scheme=$($report.decision.hashScheme)"
        "candidate=$($report.decision.selectedCandidate)"
        "mph_miss_geomean_ms=$($report.decision.missHeavyGeometricMedianMilliseconds.mph)"
        "table_miss_geomean_ms=$($report.decision.missHeavyGeometricMedianMilliseconds.table)"
    )
    $summary | Set-Content -LiteralPath (Join-Path $root "$OutputDirectory\summary.txt") -Encoding utf8
    $summary
} finally {
    Pop-Location
}
