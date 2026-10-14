# Unity tool notes (agent-facing)

Per-tool behaviour notes moved out of unity/AGENTS.md. They complement [unity/README.md](../unity/README.md), which has the user-facing sections (Bunker Materials, Cart paths, Vertex paint, FBX sync, Creeks, Water planes, Course props, Stone walls); read the matching section there too.

Saving: every command takes `save=false` (`GolfMapSceneSave.cs`, README "Saving what a command changed"). With
`save: true` the open dirty scenes and `AssetDatabase.SaveAssets()` are saved **after** the command has succeeded
and reported as `saved: {scenes, seconds}`; a dry run and a failed run never save (`saved.skipped` says why), a
dirty scene with no file of its own is left as `saved.skippedScenes`, and `golfmap.course.refresh` saves once at
the end rather than per chained step. It is the bridge dispatcher that does this - it runs the registered command
`golfmap.scene.save` after any job whose args carry `save: true` - so no command can ignore the argument any more
(a dozen of them used to: `roughgrass.plant`, `look.apply`, `paint.apply`, `vegpalette.*`, `walls.colors` ...).
Without it nothing changed: the scene is marked dirty and the user is asked (or `golfmap.scene.save`). Pass it
when a run is unattended or long - the 2026-10-09 editor crash lost 13 meshes that were only in memory. The one
odd one out is `golfmap.course.build`, whose `saveBefore=true` saves **before** the build (the bundle comes from
the file on disk).

Bunkers: `GolfMap > Bunker Materials` (`GolfMapBunkerMaterials.cs` + `GolfMapBunkerChannels.cs`) checks
vertex paint and builds copies of OPCD's `ChannelMaterials` from `bunker-channels.json` (owned by
[blender/](../blender/AGENTS.md); copy into `Assets/GolfMap/<Course>/` after an edit), with restore.

Vertex paint: `GolfMap > Vertex Paint` (`GolfMapVertexPaint.cs`, bridge `golfmap.paint.apply|restore|survey|probe`)
generates paint from `<course>/paint.json` into mesh copies under `<course>/PaintedMeshes/` and rebuilds the Stix
cache (the "bake"). Stix grass on rough reads only the **red** channel (blade chance); never paint the FBX meshes
in place. A rule in mode `overlay` raises its channel and keeps red (colour only, grass stays); `enabled: false` keeps a
rule unpainted - Vreta's `bunker-surround` is off (the rough's blue and black are both the dirt base with roots). OPCD
hand paint lives in VertexPainterPro streams the renderer draws instead of the mesh colours: `golfmap.paint.streams`
(`remove=true`), `golfmap.paint.probe` reports them. See [README.md](README.md#vertex-paint).

Bunker edges (README "Bunker Materials", table "Bunker edges like the references"): the pale strip / white blades
came from the `-meshes` ortho (MAHS `_Satellite` and Stix `_ColorMap` both sample it) - the pipeline's edge fill
paints the sand halo out, and the gravel one along paths (`gspro.py ortho --edge-fill`), `golfmap.orthos.update` copies a re-export over the project's
copy in place. `golfmap.roughgrass.plant` also plants the bunker blends (lip material, even density) and red-lipped
bunker meshes; `golfmap.course.refresh` runs it (step `roughgrass.plant`).

Cart paths: `golfmap.paths.materials` (`GolfMapPathMaterials.cs`, README "Cart paths"; refresh step `paths.materials`,
`pathLook=surface|photo`) draws each path mesh as its surface (from the SVG export's `<prefix>-paths.json`) on OPCD's
own MAHS shader, satellite off - a copy of `OPCD MAHS Concrete - Asphalt default` whose four channels draw the
surface's textures, appended as slices to copies of OPCD's arrays (`GolfMapTextureArrays.cs`, shared with the stone
walls' rock; `golfmap.walls.material-check rebuild=true` proves the walls' arrays unchanged). Every fringe strip fades:
a copy of the material of the mesh beside it (found by raycasts past its far edge), path channel (red, checked per
strip) = the surface, far channel (black) = the neighbour's painted channel; road-to-road strips fade into the other
road's surface except `sharpPairs`. Spec `<course>/Paths/path-surfaces.json` (`golfmap-path-looks-v2`); never tune
the built materials by hand, they are rebuilt from the spec. Tree shadows in the photo only matter for `look=photo`
(OPCD's satellite concrete), lifted by the path fill (`--path-fill`, default).
Old arrays in the build (2026-10-11, ~324 MB per stale pair against the 4 GB limit): a new spec texture means a new
`Paths/Arrays/Path detail|normals <key>.asset` pair, and a run only rebuilds the materials its plans target. A material
in `Paths/Surfaces/` from an earlier plan keeps the arrays of its day, and OPCD's helper components keep it in the
scene with no renderer wearing it (`MeshChannelMaterialsStore.MeshChannelMaterials` -> a ChannelMaterials asset OPCD
writes to `Assets/Resources/Materials/SOs/`, `BlendTarget.BlendSourceMaterialRed` / `BlendToMaterialBlack`). A whole
run (no `only`) therefore: points those components on every path mesh at the worn material (`opcdStoresUpdated`),
moves each `Surfaces/` material it did not build and nothing in the scene holds to the trash with its ChannelMaterials
asset (`orphanMaterialsDeleted`; held ones stay and move to the current arrays when the slice count matches,
`orphanMaterialsKept`), then deletes the arrays no material under `Paths/` references (`oldArraysKept` names the
material keeping one - hand-made ones such as `Paths/EndTrials/` count and are never touched). `dryRun` lists
`orphanMaterials`. Check after saving the scene (the commands read the saved scene's dependencies):
`golfmap.build.size {type: "Texture2DArray"}` lists one Path detail/normals pair, `golfmap.build.usedby {asset: "<array
or material path part>"}` shows the components holding it.

Course meshes after a Blender export: `golfmap.meshes.sync` (GolfMap > Meshes > Sync from FBX folder,
`GolfMapCourseMeshes.cs`) deletes and re-adds the object of every FBX that changed since the last sync (file size+time),
adds new ones (collider + OPCD's `GameObject/Set Default Materials`, run on the selection), reports/prunes objects that
show no current FBX, then re-applies vertex paint (which reshapes stone-wall ground) and rebuilds the stone walls standing
on a replaced mesh. Do not rely on Unity updating an overwritten FBX's scene object in
place: in Marcus's scene that left old geometry (z-fighting, gaps) and only replacing the objects fixed it. Test sync
changes with real geometry changes (not timestamp touches), checked in the scene. Blender side: `blender/tools/fbx_sync.py` exports only changed meshes.

Two retries the bridge does for you, so a command that is run twice must cost time only (ours all re-read the scene
and the exported files): a command whose own `AssetDatabase.Refresh()` reloads the scripts loses its job with the
domain and answers "Unknown job (jobs do not survive a script reload)" or "The editor is reloading scripts; call
again" - `unity/mcp/bridge.ts` waits up to 90 s for the bridge and submits it once more (`retried: true` in the
result, a stderr line, a second failure surfaces); a command that throws VSP's "previously scheduled job ...
JobHandle.Complete()" makes the editor run `golfmap.vsp.reset` and the command once more (`vspReset: true`,
[unity-gotchas.md](unity-gotchas.md)). Neither covers a command that is still `pending`: that one is still running in
the editor.

Course build: `golfmap.course.build` holds the main thread for ~12 minutes, so poll
`golfmap.course.build.status` from a second process - or read `GolfMapSpelunk/<Course>_build-status.json` without the
bridge at all (`bun unity/mcp/build-status.ts`, also folded into `unity_status` as `courseBuild`) - instead of
watching the `.gspcrse` mtime. Phases: `starting`, `saving-scene`, `preparing`, `building-bundle` (the long one),
`refreshing-vegetation` or `failed-restoring-wind`, `done`, `failed`; `seconds` of a running build counts from `startedAt`, `lastResult` is the
previous build's result or error (README "Course build"). A build holds the main thread to its end, so it can never
write "I stopped": the file carries the editor's `pid`, and a `running` file whose process is gone reads as phase
`interrupted` (running false) rather than building for ever. `saveBefore=true` (not `save`) saves the scene before
the build - the bundle is built from the file on disk.

`unity_status` is one shape, always: the off-thread snapshot (`scenes` with `dirty`, `compiling`, `updating`,
`busy`, `queued`, `consoleSeq`, `jobStamp`) merged with the main-thread `status` command (`activeScene`,
`selection`, `sceneView`). A command holding the main thread leaves the second half out and adds `commandError`;
it no longer nests everything under `.snapshot`.

Blender shaping loop ([SHAPING-PLAN](../blender/SHAPING-PLAN.md)): `golfmap.course.refresh` (`GolfMapCourseRefresh.cs`) chains
mesh sync, bunker convention, paint, `golfmap.terrain.conform mode=match` (terrain both ways under the meshes, feathered),
water planes, creeks, walls and surfaces; `dryRun` plans only; `save` saves once at the end, never per step, and not
when a step failed. `GolfMap > Review` (`GolfMapReview.cs`, bridge
`golfmap.review.list|goto|load`) walks the shaping report's changed places (default `<export folder>/shaping-staging/shaping-report.json`; `goto object=` frames one object). `only=<object names>` is the per-feature path (README "Per feature"): just those FBX imported and swapped, bunker sets, paint and a terrain window around them. Blender -> Unity FBX coordinates: `(x, y, z) -> (-x, z, -y)`.

Where a view is: every Scene view shows a position box top right (`GolfMapViewInfo.cs`, toggle `GolfMap > Scene View >
Position overlay`): eye in SWEREF 99 TM + elevation + WGS84, heading/tilt, and the surface point under the view centre
with its object, all from the inner DEM sidecar (x = E - square3006[0], z = N - square3006[1], y = H - minM). The user's
screenshots carry it; `golfmap.view` returns it as data, and with `e`/`n` (+ `heading`/`tilt` or `atE`/`atN`) moves the
view to a place read off a screenshot.

Getting to a hole: `golfmap.holes {hole, point: tee|aim1..|green}` (`GolfMapHoleNavigator.cs`, window `GolfMap > Scene View >
Hole navigator`) puts the view 5 m over that point looking along the direction of play; without `hole` it lists the holes.
Reads `<export folder>/<prefix>-holes.json`; after tees, aim points or greens move in golf-map, write it again:
`bun run py gspro.py holes --course <course> --out <export folder>/<prefix>-holes.json`.

Terrains after the first import: `golfmap.terrain.update` (GolfMap > Terrain > Update heights from export) puts a new heightmap export onto the existing terrains in place (backup, VSP refresh, outer sink kept); golf-map's **Update terrain** calls it.

Creeks: `GolfMap > Creeks` (`GolfMapCreeks.cs`, bridge `golfmap.creeks.import`) builds one R.A.M. `RamSpline` per creek
from `<prefix>-inner-creeks.json`: the export's line, fitted to the course meshes in the scene (water just above the bed,
edges run `bankM` into the banks, ends into the bank, crossings bridged). Refit after changing creeks, heightmap or meshes =
export creeks again + import again. `trace=<id>` explains a bad fit. R.A.M. types are resolved by name. The creeks wear
the lakes' AQUAS water by default (`water=lake`: `<course>/Creeks/Creek water (lake).mat`, copied once from OPCD's plane
material, probe anchored to the nearest lake's); `golfmap.creeks.water water=lake|profile` switches the look without a refit.
See [README.md](README.md#creeks-ram).

Lake water planes: `GolfMap > Waterplanes` (`GolfMapWaterplanes.cs`, bridge `golfmap.waterplanes.build`) does OPCD's Blender
"Add Water Plane" in Unity from the scene's `*_Water_Base_Lake_-_Mesh`, or one selected mesh of any name (`Build for selected
mesh`, bridge `selected=true`) (flat at lowest rim − 0.05, 2 m outset, raised 0.3 m
under `Waterplanes`), then OPCD's Set Default Materials adds the AQUAS material, `GSPwater` physics and the anchored
`Default Reflection Probe`, which the build then moves over open water above the banks and renders (a probe inside a bank
turns the whole plane black; `golfmap.waterplanes.probes` fixes existing planes, OPCD's too). Planes are `Spline_*` named but not ground: keep `IsWaterPlane` out of every ground/course-mesh
filter. See [README.md](README.md#water-planes-lakes).

Hand-modelled props near the course (clubhouse area: buildings, shelters, range, flags, cars) are built in Blender from a
measured spec (`blender/tools/build_props.py`, `docs/gspro/<course>/*-props.gen.py`) and placed by `golfmap.props.place`
(`GolfMapProps.cs`, README "Course props"): EPSG:3006 positions on the highest collider, Standard materials from the
manifest, no custom components on placed objects (GSPro loads them as missing scripts; they are found by name).
A re-place **keeps what was moved by hand** (`GolfMapPropsPlaced.cs`, README "A re-place keeps what was moved by
hand"; mirror + tests `unity/props-matching.mjs`, `bun test unity/props-matching.test.mjs`): every place records the
transform it set per instance in `<course>/Props/placed.json`, and the next one keeps the user's transform for any
instance that is not where the tool left it (1 cm / 0.5° on any axis / 0.1 % of scale), unless that instance's spec
entry moved by more than the same tolerance since - then the `.gen.py` is the newer intent and wins (`rule:
spec-moved`, listed in the result's `specWon`). Instances pair per asset by nearest position, one to one, closest
pair first and with no radius (`GolfMapPropsPlaced.PairNearest`), never by `#i`: that is the index the spec had when
the prop was placed, so one `place(...)` call added or removed shifts every later one (a first version of
`props.record` that trusted the names read 88 of Vreta's props as hand-moved - one index shift per asset).
The result's `kept`/`handPlaced` and the report's `KEPT (hand-placed)` lines are what to carry into the spec: nothing
is written back into `docs/gspro/<course>/*-props.gen.py`, and only the spec survives another machine or a
`props.clear` + rebuilt spec. `keepHandEdits=false` restores the old replace-everything behaviour.
Two lists cover what has no spec entry at all. An instance **no record made** (a Ctrl+D duplicate in Unity,
`<asset>#3 (1)`) is left standing where it is: result `handAdded`, and kept out of `placed.json` on purpose, since
"no record claims it" is the rule that finds it and a `spec: null` record would make the next place drop it
(it used to pair with nothing and be destroyed without a word; `keepHandEdits=false` still removes it). A
hand-placed instance the spec - or the whole asset in the manifest - no longer has does go, because the spec is the
intent, but its asset, name and transform are listed under `droppedHand` and as a report warning first.
A scene from before this existed has no record: run `golfmap.props.record` once (`mark=moved|all`, touches no prop)
before the first place, or the hand moves go one last time. Read its `pairing` (`indexStillRight` vs
`pairedByPosition`), `unpairedInstances`, `notInScene` and per-asset `assets` before trusting its `handPlaced`.

Vehicles are prefab assets of the spec, and never the vehicle pack's own prefabs (43 / 29 / 8 renderers for the
hatchback / sedan / golf cart, every one a shadow caster): the spec points at merged copies in
`<course>/Props/VehiclesLowPoly/` (2 renderers each, the pack's materials, no shadows; sedan 11 177 and hatchback
10 405 triangles, golf cart 3 956).
- Regenerate: `blender/tools/vehicle_prefabs.py` -> `vehicle_models.py` -> `vehicle_models_10k.py`
  (blender/README.md "Low-poly vehicles"), copy the FBX files + `vehicles.json` into the course folder,
  `golfmap.vehicles.build`, then `golfmap.props.measure` old against new (the hatchback is 2.6 cm lower: its wipers
  are gone; the others are equal).
- Shadows: `castShadows` per object in `vehicles.json` (`--shadows none|body` when generating). Vreta has `none`:
  without a shadow the cars look pasted on at 15 m, which the owner chose for frame rate.
- How many: the generator places one car per entry of `docs/gspro/<course>/clubhouse-cars.json` (every stall the
  ortho shows a car in); `"parked": false` leaves a stall empty. Vreta keeps 30 of 89. Model (hatchback/sedan) and
  the odd reversed car are hashed from the stall position, so flipping the flag changes nothing else.
- Stall lines: the same generator derives the stall grid from the rows of `clubhouse-cars.json` (2.5 m pitch, 5 m
  deep, double rows by their two stall lines) and paints it as `stall_lines_<row><n>` props (`props_kit` `markings`:
  flat strips draped on the DEM, 3 cm up, no skirt), 4 stalls a piece: each piece is grounded at its own origin, and
  Vreta's car park surface is the DEM tilted ~1 cm in 10 m, so a row-long mesh would sink at one end. Cars are
  placed at their stall's centre, nose in (`NOSE` for the single rows); a car moved to another stall by hand goes
  into `HAND_STALL`. Rebuild with `build_props.py --only <the stall_lines ids>` and place lines and cars together.
- After a change, place only the vehicles (`golfmap.props.place only=<vehicle asset ids> materials=false`) and
  check with `golfmap.props.stats group=Vehicles transforms=true`. `build_props.py --only <a prefab asset>` rewrites
  `props.json` without re-exporting any model (it does regenerate `Textures/`).
- Measuring triangles in a built course: static batching (on in the project, and props are `BatchingStatic`) hands
  every renderer the combined mesh, so `sharedMesh.triangles` summed over renderers reported 181.6 M for cars that
  were 2.0 M. Count submesh index ranges, or measure in the editor with `golfmap.props.stats`.

Stone walls (the stone-faced banks of raised tees) are built by `golfmap.walls.build` (`GolfMapWalls.cs`, README
"Stone walls") from `<course>/stone-walls.json` (`docs/gspro/<course>/stone-walls.gen.py`: banks traced on the DEM)
with Blender-built stones (`props_kit` `boulder`, `<course>/Walls/Stones/`). The ~1.2 m OPCD meshes flatten a wall to
a ~35 deg bank, and no placement of stones on that reads as a wall: `GolfMapWallGround.cs` reshapes the meshes first
(subdivided, raised into a terrace with a steep face, the face painted as stone through a copy of the rough material),
inside `golfmap.paint.apply`, which also moves the MeshCollider to the reshaped copy. Two styles, both wanted: `wall`
(a dry-stone wall: flat-faced stones fitted into the face's plane) and `rose` (a stenröse: a heap of rounded stones).
Pack rocks read as rubble; judge changes from the photo viewpoints (`golfmap.view`). Klippor are big closed rocks sunk
into the lidar knoll, not reshaped ground (README "Stone walls"). Stone colliders need GSPro's `GSPstone` physics
material (`physicMaterial` in the spec, `golfmap.walls.colliders`). Stones Marcus moves by hand are captured as `pose` in
the generator before any rebuild: unlike props, a wall's stones get no `placed.json` record, because they are generated
from the wall's seed and have no identity in the spec to key a hand move to (a `pose` boulder is that identity).

Buildings (`GolfMapBuildingPlanter.cs`, `building-matching.mjs` + `match-building-palette.mjs`) follow the
tree assignment pattern — offline matcher writes a report keyed by stable id, overrides persist, the Unity
window validates then applies — but plant plain GameObjects under the terrain, never VSP (colliders). The
flat pad under each building is a pipeline terrain edit baked into the heightmap, not a Unity step; the
planter's corner probe warns when it is missing (expected for outer buildings: pads are inner terrain only). Matcher tests: `bun test unity/building-matching.test.mjs`
(node:test files run under `bun test`; `node` is not on this machine's PATH).

Performance ranking (`GolfMapPerf.cs` + `GolfMapPerfWindow.cs`, bridge `golfmap.perf.report|hide|show`; game side
`unity/ArboristMod/perf.ts --rank`; README "Performance ranking"): one category model for both, rules in
`Editor/GolfMap/GolfMapPerfCategories.json` (first matching regex on the hierarchy path, else `other:<root>`), pure
model and tests in `unity/perf-rank.ts` / `.test.ts`. Three places apply the rules and must agree: `GolfMapPerf.GroupOf`,
the mod's `SceneCommands.GroupOf` (`scene.geometry groups=`, `scene.hide groups= group=`) and `categoryOf` in
`perf-rank.ts`; the statistics exist twice (`GolfMapPerf.Costs` / `Ranking`, `viewCosts` / `ranking`). Change them together.
- The editor run switches scene and project state (renderer and component `enabled`, VSP `BillboardLayer` +
  `Tools.visibleLayers`, `QualitySettings.shadows`) and puts it back after each case, before a scene save, a script
  reload and quit. If a run is killed mid-case: `golfmap.perf.show`.
- Timing and VSP item hides are `GolfMapVegPerf`'s (`Measure`, `SetHidden`); the vegetation-only sweep
  (`golfmap.vegperf.sweep`, packages and single items) stays the tool for looking inside the VSP rows.
- The course-mesh rules repeat `GolfMapSurfaces.Classify` (the game cannot call it); the editor report compares the two
  on every course mesh and lists disagreements in `conditions.notes`.
- Traps: editor numbers rank, the game's are the fps; the 120 fps vSync cap ("at the cap", `>=`); a 5 s reading swings
  several fps (raise `--rounds`); static batching makes the game's triangles upper bounds; never measure after a
  `veg.set` refresh.

## Course exports and zone import from the command line

Course exports (the app's GSPro Export panel) run from the command line too, through the same
service: `bun run gspro:export -- status <course>` shows the export folder, ortho vintages and
exported files; `bun run gspro:export -- <course> dem zones trees:outer ...` exports (no terrain =
both, `dem` first on a new course). Then import in Unity with bridge commands, e.g.
`golfmap.zones.check` / `golfmap.zones.import` with `terrain: inner|outer` (the window's Load and
check / Import without the window; `dryRun: true` on import returns the plan without writing). Check
before import: it reports missing packages and items and the groups/rules the import would change.
`golfmap.zones.patch` (`GolfMapZoneImporterPatch.cs`, terrain + `patch`: a `gspro.py zones-patch` record)
takes a patch of an imported export: it copies and reimports only the changed mask PNGs and respawns VSP only
inside the patch window (`VegetationSystemPro.ClearCache(Bounds)`). VSP reads the mask pixels live
(`GetRawTextureData` per spawn), so no refresh is needed. It changes no groups or rules, and refuses when the
package does not hold that export's import (a group missing, or on another texture or channel).

## Tuning palettes (Vegetation Palettes window, bridge)

Tuning palettes: `GolfMap > Vegetation Palettes` (`GolfMapVegPalette*.cs`, `GolfMapVegLive.cs`, `GolfMapVegBake.cs`, `GolfMapVegSession.cs`,
[README](README.md#vegetation-palettes-palette-editor)) edits `grass-palette.json` items and `palette.json` tree looks as one
list with shared settings, grades a selection across palettes together, and pushes every change into the scene live (no
apply/replant). Agents use the same working copy through `golfmap.vegpalette.list|adjust|save|revert|spots|look|rebuild|show`:
e.g. `adjust {select: "creek_bank/*", brightness: -0.1}`, screenshot, then `save` or `revert`. An item several palettes list
is one VSP item (one entry; only `maxDensity` is per palette), so change it everywhere or give it a new name.
