# Builds the player bridge against the player's own assemblies and installs it:
#   unity/ArboristMod/build.ps1 [-App <folder with Arborist.exe>]
# Core/     -> GolfMapPlayerBridge.dll (+ the BepInEx loader): the HTTP bridge. Locked while the
#              app runs; a change here needs the app restarted.
# Commands/ -> GolfMapPlayerCommands-<stamp>.dll in the plugin's commands folder: picked up by the
#              running app with `bun unity/ArboristMod/call.ts reload`.
param(
    [string]$App = 'D:/gspro/Arborist_Launcher/Data/Application',
    [string]$OutDir = (Join-Path $PSScriptRoot '../../tree-export/arborist-mod'),
    [string]$UnityData = 'C:/Program Files/Unity/Hub/Editor/2018.2.8f1/Editor/Data'
)
$ErrorActionPreference = 'Stop'
$csc = Join-Path $UnityData 'Tools/Roslyn/csc.exe'
$managed = (Get-ChildItem -LiteralPath $App -Directory -Filter '*_Data' | Select-Object -First 1).FullName + '/Managed'
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$references = Get-ChildItem -LiteralPath $managed -Filter '*.dll' | Where-Object { $_.Name -match '^(mscorlib|netstandard|System(\.Core)?|UnityEngine(\..+)?)\.dll$' } | ForEach-Object { '/reference:' + $_.FullName }
$base = @('/nologo', '/noconfig', '/nostdlib+', '/target:library', '/langversion:6', '/optimize+', '/deterministic+')

function Sources($folder) { Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot $folder) -Filter '*.cs' | ForEach-Object { $_.FullName } }
function Compile($out, $extra, $sources) {
    & $csc @base ('/out:' + $out) @references @extra @sources
    if ($LASTEXITCODE -ne 0) { throw "Compilation of $(Split-Path $out -Leaf) failed" }
}

$core = Join-Path $OutDir 'GolfMapPlayerBridge.dll'
$shared = @('BridgeJson.cs', 'BridgeCommands.cs') | ForEach-Object { Join-Path $PSScriptRoot ('../Editor/GolfMapBridge/' + $_) }
Compile $core @() (@($shared) + @(Sources 'Core'))

# Every reference to the app's own code and to VSP is the commands' business, never the core's.
$appReferences = Get-ChildItem -LiteralPath $managed -Filter '*.dll' | Where-Object { $_.Name -match '^(Assembly-CSharp(-firstpass)?|AwesomeTechnologies\..+|Utf8Json)\.dll$' } | ForEach-Object { '/reference:' + $_.FullName }
$commands = Join-Path $OutDir ('GolfMapPlayerCommands-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.dll')
Compile $commands (@('/reference:' + $core) + @($appReferences)) (Sources 'Commands')
Write-Output ("Built " + (Split-Path $core -Leaf) + " and " + (Split-Path $commands -Leaf))

$bepinex = Join-Path $App 'BepInEx/core/BepInEx.dll'
if (-not (Test-Path $bepinex)) { Write-Output 'BepInEx is not installed next to the app: nothing installed.'; return }
$plugins = Join-Path $App 'BepInEx/plugins/GolfMapPlayerBridge'
New-Item -ItemType Directory -Force -Path (Join-Path $plugins 'commands') | Out-Null
$loader = Join-Path $OutDir 'GolfMapPlayerBridge.Loader.dll'
Compile $loader @(('/reference:' + $bepinex), ('/reference:' + $core)) @(Join-Path $PSScriptRoot 'Loader/BepInExLoader.cs')

Get-ChildItem -LiteralPath (Join-Path $plugins 'commands') -Filter 'GolfMapPlayerCommands*.dll' | Remove-Item -Force -ErrorAction SilentlyContinue
Copy-Item -LiteralPath $commands -Destination (Join-Path $plugins 'commands') -Force
Get-ChildItem -LiteralPath $OutDir -Filter 'GolfMapPlayerCommands-*.dll' | Where-Object { $_.FullName -ne (Resolve-Path $commands).Path } | Remove-Item -Force -ErrorAction SilentlyContinue
$sameCore = (Test-Path (Join-Path $plugins 'GolfMapPlayerBridge.dll')) -and ((Get-FileHash $core).Hash -eq (Get-FileHash (Join-Path $plugins 'GolfMapPlayerBridge.dll')).Hash)
if ($sameCore) { Write-Output 'Commands installed (core unchanged): call reload.' }
else {
    try { Copy-Item -LiteralPath $core, $loader -Destination $plugins -Force; Write-Output 'Core and commands installed: start the app.' }
    catch { Write-Output 'Commands installed. The CORE changed but is locked by the running app: close the app and run this again.' }
}
