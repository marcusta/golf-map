param([string]$UnityProject='D:/gspro_courses/vreta_v4_2025_12_02',[string]$UnityData='C:/Program Files/Unity/Hub/Editor/2018.2.8f1/Editor/Data')
$ErrorActionPreference='Stop'
$checkOutput=Join-Path $PSScriptRoot '../tree-export/GolfMapPlanterCheck.dll'
$references=Get-ChildItem -LiteralPath (Join-Path $UnityData 'Managed') -Filter '*.dll'
$references+=Get-ChildItem -LiteralPath (Join-Path $UnityData 'Managed/UnityEngine') -Filter '*.dll'
$references+=Get-ChildItem -LiteralPath (Join-Path $UnityProject 'Library/ScriptAssemblies') -Filter '*.dll' | Where-Object { $_.Name -notlike 'Assembly-CSharp*' }
$compilerArgs=@('/nologo','/target:library','/langversion:6','/define:UNITY_EDITOR,UNITY_2018_2_OR_NEWER',('/out:'+$checkOutput))
$compilerArgs+=$references | ForEach-Object { '/reference:'+ $_.FullName }
$compilerArgs+=@('mscorlib.dll','System.dll','System.Core.dll') | ForEach-Object { '/reference:'+(Join-Path $UnityData ('MonoBleedingEdge/lib/mono/4.5/'+$_)) }
$compilerArgs+=@('GolfMapBiome.cs','GolfMapTreePlanter.cs','GolfMapTreePlanterVsp.cs') | ForEach-Object { Join-Path $PSScriptRoot ('Editor/GolfMap/'+$_) }
& (Join-Path $UnityData 'Tools/Roslyn/csc.exe') @compilerArgs
if($LASTEXITCODE -ne 0){throw 'Planter compilation failed'}
Write-Output 'Compiled planter against installed Unity/VSP assemblies (C# 6).'
