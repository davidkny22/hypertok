$ErrorActionPreference = "Stop"

$root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$packageRoot = Join-Path $root "hypertok-js"
$scripts = @(
    "build:test:vite"
    "build:test:webpack"
    "build:test:mutation:reorder"
    "build:test:mutation:corrupt"
    "build:test:mutation:transfer-corrupt"
    "build:test:mutation:source-digest"
    "build:test:mutation:source-rebuild"
    "build:test:mutation:pool-reload"
    "build:test:mutation:resident-replace"
    "build:test:mutation:decode-drop"
)

foreach ($script in $scripts) {
    & npm.cmd --prefix $packageRoot run $script
    if ($LASTEXITCODE -ne 0) {
        throw "browser fixture build failed: $script"
    }
}

Write-Output "browser fixtures PASS ($($scripts.Count)/$($scripts.Count) builds)"
