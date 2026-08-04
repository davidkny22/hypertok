param(
    [string]$Profile = "quick",
    [switch]$List
)

$ErrorActionPreference = "Stop"

$repository = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$manifestPath = Join-Path $PSScriptRoot "suites\manifest.json"
$manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
$profiles = @{}
$commands = @{}

foreach ($entry in $manifest.profiles.PSObject.Properties) {
    $profiles[$entry.Name] = $entry.Value
}
foreach ($command in $manifest.commands) {
    if ($commands.ContainsKey($command.id)) {
        throw "duplicate suite command: $($command.id)"
    }
    $commands[$command.id] = $command
}

if ($List) {
    foreach ($name in ($profiles.Keys | Sort-Object)) {
        Write-Output $name
    }
    exit 0
}
if (-not $profiles.ContainsKey($Profile)) {
    throw "unknown suite profile '$Profile'; available: $($profiles.Keys -join ', ')"
}

$selected = @()
$visiting = [System.Collections.Generic.HashSet[string]]::new()
$expanded = [System.Collections.Generic.HashSet[string]]::new()

function Expand-Profile([string]$Name) {
    if ($expanded.Contains($Name)) { return }
    if (-not $profiles.ContainsKey($Name)) { throw "unknown included profile: $Name" }
    if (-not $visiting.Add($Name)) { throw "suite profile cycle at $Name" }
    foreach ($include in @($profiles[$Name].includes)) {
        Expand-Profile $include
    }
    foreach ($commandId in @($profiles[$Name].commands)) {
        if (-not $commands.ContainsKey($commandId)) {
            throw "profile $Name names unknown command $commandId"
        }
        if ($selected -notcontains $commandId) { $script:selected += $commandId }
    }
    $visiting.Remove($Name) | Out-Null
    $expanded.Add($Name) | Out-Null
}

Expand-Profile $Profile
if ($selected.Count -eq 0) { throw "suite profile $Profile has no commands" }

$passed = 0
foreach ($commandId in $selected) {
    $command = $commands[$commandId]
    $workingDirectory = (Resolve-Path (Join-Path $repository $command.cwd)).Path
    if (-not $workingDirectory.StartsWith($repository, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "suite command $commandId escapes the repository"
    }
    $arguments = @($command.arguments | ForEach-Object {
        $_.Replace("{repository}", $repository)
    })
    Write-Output "> [$commandId] $($command.executable) $($arguments -join ' ')"
    Push-Location $workingDirectory
    try {
        & $command.executable @arguments
        if ($LASTEXITCODE -ne 0) {
            throw "suite command $commandId failed with exit code $LASTEXITCODE"
        }
    } finally {
        Pop-Location
    }
    $passed += 1
}

Write-Output "suite $Profile PASS ($passed/$($selected.Count) commands)"
