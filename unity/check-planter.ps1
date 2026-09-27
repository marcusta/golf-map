param([string]$UnityProject='D:/gspro_courses/vreta_v4_2025_12_02',[string]$UnityData='')
$ErrorActionPreference='Stop'
# The editor that matches the project: ProjectSettings/ProjectVersion.txt names it.
if(-not $UnityData){$version=(Select-String -LiteralPath (Join-Path $UnityProject 'ProjectSettings/ProjectVersion.txt') -Pattern 'm_EditorVersion: (\S+)').Matches[0].Groups[1].Value;$UnityData="C:/Program Files/Unity/Hub/Editor/$version/Editor/Data"}
$checkOutput=Join-Path $PSScriptRoot '../tree-export/GolfMapPlanterCheck.dll'
$references=Get-ChildItem -LiteralPath (Join-Path $UnityData 'Managed') -Filter '*.dll'
$references+=Get-ChildItem -LiteralPath (Join-Path $UnityData 'Managed/UnityEngine') -Filter '*.dll'
$references+=Get-ChildItem -LiteralPath (Join-Path $UnityProject 'Library/ScriptAssemblies') -Filter '*.dll' | Where-Object { $_.Name -notlike 'Assembly-CSharp*' }
$compilerArgs=@('/nologo','/target:library','/langversion:6','/define:UNITY_EDITOR,UNITY_2018_2_OR_NEWER',('/out:'+$checkOutput))
$compilerArgs+=$references | ForEach-Object { '/reference:'+ $_.FullName }
$compilerArgs+=@('mscorlib.dll','System.dll','System.Core.dll') | ForEach-Object { '/reference:'+(Join-Path $UnityData ('MonoBleedingEdge/lib/mono/4.5/'+$_)) }
$compilerArgs+=@('BridgeJson.cs','BridgeCommands.cs','BridgeConsole.cs','BridgeServer.cs','BridgeBuiltins.cs') | ForEach-Object { Join-Path $PSScriptRoot ('Editor/GolfMapBridge/'+$_) }
$compilerArgs+=@('GolfMapBridgeCommands.cs','GolfMapCourses.cs','GolfMapJsonDoc.cs','GolfMapBiome.cs','GolfMapTreePalette.cs','GolfMapTreeLooks.cs','GolfMapTreePlanter.cs','GolfMapTreePlanterVsp.cs','GolfMapTreeEdits.cs','GolfMapTreeEditor.cs','GolfMapTreeVerification.cs','GolfMapTreesInspector.cs','GolfMapVegetationRefresh.cs','GolfMapCtiTrial.cs','GolfMapTreeRenderingTests.cs','GolfMapVspRig.cs','GolfMapBuildingPlanter.cs','GolfMapZones.cs','GolfMapZoneImporter.cs','GolfMapZoneImporterVsp.cs','GolfMapZoneImporterBridge.cs','GolfMapGrass.cs','GolfMapVspStatus.cs','GolfMapSurfaces.cs','GolfMapTerrainConform.cs','GolfMapJson.cs','GolfMapBunkerChannels.cs','GolfMapBunkerMaterials.cs','GolfMapRoughGrass.cs','GolfMapVertexPaint.cs','GolfMapCreeks.cs','GolfMapTerrainSculpt.cs','GolfMapCourseMeshes.cs','GolfMapTerrainImporter.cs','GolfMapViewInfo.cs','GolfMapProps.cs','GolfMapWalls.cs','GolfMapWallGround.cs','GolfMapWaterplanes.cs','GolfMapVegPalette.cs','GolfMapVegLive.cs','GolfMapVegSession.cs','GolfMapVegPaletteWindow.cs') | ForEach-Object { Join-Path $PSScriptRoot ('Editor/GolfMap/'+$_) }
$compilerArgs+=@('GolfMapTrees.cs','GolfMapCourse.cs') | ForEach-Object { Join-Path $PSScriptRoot ('Runtime/GolfMap/'+$_) }
& (Join-Path $UnityData 'Tools/Roslyn/csc.exe') @compilerArgs
if($LASTEXITCODE -ne 0){throw 'Planter compilation failed'}
Write-Output 'Compiled planter against installed Unity/VSP assemblies (C# 6).'
