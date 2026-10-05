# Unity tool notes (agent-facing)

Per-tool behaviour notes moved out of unity/AGENTS.md. They complement [unity/README.md](../unity/README.md), which has the user-facing sections (Bunker Materials, Cart paths, Vertex paint, FBX sync, Creeks, Water planes, Course props, Stone walls); read the matching section there too.

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

Course meshes after a Blender export: `golfmap.meshes.sync` (GolfMap > Meshes > Sync from FBX folder,
`GolfMapCourseMeshes.cs`) deletes and re-adds the object of every FBX that changed since the last sync (file size+time),
adds new ones (collider + OPCD's `GameObject/Set Default Materials`, run on the selection), reports/prunes objects that
show no current FBX, then re-applies vertex paint (which reshapes stone-wall ground) and rebuilds the stone walls standing
on a replaced mesh. Do not rely on Unity updating an overwritten FBX's scene object in
place: in Marcus's scene that left old geometry (z-fighting, gaps) and only replacing the objects fixed it. Test sync
changes with real geometry changes (not timestamp touches), checked in the scene. Blender side: `blender/tools/fbx_sync.py` exports only changed meshes.

Blender shaping loop ([SHAPING-PLAN](../blender/SHAPING-PLAN.md)): `golfmap.course.refresh` (`GolfMapCourseRefresh.cs`) chains
mesh sync, bunker convention, paint, `golfmap.terrain.conform mode=match` (terrain both ways under the meshes, feathered),
water planes, creeks, walls and surfaces; `dryRun` plans only. `GolfMap > Review` (`GolfMapReview.cs`, bridge
`golfmap.review.list|goto|load`) walks the shaping report's changed places (default `<export folder>/shaping-staging/shaping-report.json`; `goto object=` frames one object). `only=<object names>` is the per-feature path (README "Per feature"): just those FBX imported and swapped, bunker sets, paint and a terrain window around them. Blender -> Unity FBX coordinates: `(x, y, z) -> (-x, z, -y)`.

Where a view is: every Scene view shows a position box top right (`GolfMapViewInfo.cs`, toggle `GolfMap > Scene View >
Position overlay`): eye in SWEREF 99 TM + elevation + WGS84, heading/tilt, and the surface point under the view centre
with its object, all from the inner DEM sidecar (x = E - square3006[0], z = N - square3006[1], y = H - minM). The user's
screenshots carry it; `golfmap.view` returns it as data, and with `e`/`n` (+ `heading`/`tilt` or `atE`/`atN`) moves the
view to a place read off a screenshot.

Terrains after the first import: `golfmap.terrain.update` (GolfMap > Terrain > Update heights from export) puts a new heightmap export onto the existing terrains in place (backup, VSP refresh, outer sink kept); golf-map's "Heightmap → Unity" calls it.

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
the generator before any rebuild.

Buildings (`GolfMapBuildingPlanter.cs`, `building-matching.mjs` + `match-building-palette.mjs`) follow the
tree assignment pattern — offline matcher writes a report keyed by stable id, overrides persist, the Unity
window validates then applies — but plant plain GameObjects under the terrain, never VSP (colliders). The
flat pad under each building is a pipeline terrain edit baked into the heightmap, not a Unity step; the
planter's corner probe warns when it is missing (expected for outer buildings: pads are inner terrain only). Matcher tests: `bun test unity/building-matching.test.mjs`
(node:test files run under `bun test`; `node` is not on this machine's PATH).

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
