param(
    [Parameter(Mandatory = $true)][string]$Build,
    [Parameter(Mandatory = $true)][string]$UnityProject,
    [Parameter(Mandatory = $true)][string]$CourseFolder,
    [string]$BlenderDestination,
    [switch]$DryRun
)

# Install this authored set without replacing unrelated props or hand-move records.
$ErrorActionPreference = 'Stop'
$sourceRoot = (Resolve-Path -LiteralPath $Build).Path
$projectRoot = (Resolve-Path -LiteralPath $UnityProject).Path
$propsRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot "Assets/GolfMap/$CourseFolder/Props"))
if (-not $propsRoot.StartsWith($projectRoot.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'CourseFolder must resolve inside the Unity project.'
}
$incoming = Get-Content -LiteralPath (Join-Path $sourceRoot 'props.json') -Raw | ConvertFrom-Json -AsHashtable
if ($incoming.format -ne 'golfmap-props-v1') { throw 'Unsupported props manifest.' }
$targetManifest = Join-Path $propsRoot 'props.json'
$merged = if (Test-Path -LiteralPath $targetManifest) {
    Get-Content -LiteralPath $targetManifest -Raw | ConvertFrom-Json -AsHashtable
} else {
    @{ format = 'golfmap-props-v1'; materials = @{}; assets = @{}; instances = @() }
}
if ($merged.format -ne 'golfmap-props-v1') { throw 'Unsupported existing props manifest.' }
$incomingIds = @($incoming.assets.Keys)
foreach ($key in $incoming.materials.Keys) { $merged.materials[$key] = $incoming.materials[$key] }
foreach ($key in $incomingIds) { $merged.assets[$key] = $incoming.assets[$key] }
$merged.instances = @($merged.instances | Where-Object { $_.asset -notin $incomingIds }) + @($incoming.instances)
$files = @()
foreach ($dir in @('Models', 'Textures')) {
    $path = Join-Path $sourceRoot $dir
    if (Test-Path -LiteralPath $path) {
        $files += @(Get-ChildItem -LiteralPath $path -File -Recurse)
    }
}
foreach ($asset in $incoming.assets.Values) {
    if ($asset.fbx -and -not (Test-Path -LiteralPath (Join-Path $sourceRoot $asset.fbx))) {
        throw "Missing FBX: $($asset.fbx)"
    }
}
$blends = @(Get-ChildItem -LiteralPath $sourceRoot -Filter '*.blend' -File)
if ($BlenderDestination -and $blends.Count -ne 1) { throw 'Expected one authored .blend in the build folder.' }
$summary = @{
    source = $sourceRoot; destination = $propsRoot; assets = $incomingIds
    instances = $incoming.instances.Count; files = $files.Count
    blenderDestination = $BlenderDestination; dryRun = [bool]$DryRun
}
if ($DryRun) { $summary | ConvertTo-Json -Depth 8; return }

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
$backupRoot = Join-Path $projectRoot "Backups/clubhouse/$stamp"
foreach ($file in $files) {
    $relative = [IO.Path]::GetRelativePath($sourceRoot, $file.FullName)
    $target = Join-Path $propsRoot $relative
    if (Test-Path -LiteralPath $target) {
        $backup = Join-Path $backupRoot $relative
        New-Item -ItemType Directory -Path (Split-Path $backup) -Force | Out-Null
        Copy-Item -LiteralPath $target -Destination $backup
    }
    New-Item -ItemType Directory -Path (Split-Path $target) -Force | Out-Null
    Copy-Item -LiteralPath $file.FullName -Destination $target -Force
}
if (Test-Path -LiteralPath $targetManifest) {
    New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
    Copy-Item -LiteralPath $targetManifest -Destination (Join-Path $backupRoot 'props.json')
}
$merged | ConvertTo-Json -Depth 50 | Set-Content -LiteralPath $targetManifest -Encoding utf8
if ($BlenderDestination) {
    New-Item -ItemType Directory -Path $BlenderDestination -Force | Out-Null
    $blendTarget = Join-Path $BlenderDestination $blends[0].Name
    if (Test-Path -LiteralPath $blendTarget) {
        Copy-Item -LiteralPath $blendTarget -Destination ($blendTarget + ".$stamp.bak")
    }
    Copy-Item -LiteralPath $blends[0].FullName -Destination $blendTarget -Force
}
$summary | ConvertTo-Json -Depth 8
