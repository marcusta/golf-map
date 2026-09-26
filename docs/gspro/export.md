# GSPro export — reference

Detail moved out of `server/AGENTS.md` and `pipeline/AGENTS.md`; those keep the summary.
Chain: web export panel (`web/src/export/`) → `GsproExportService` (`server/services/gspro-export.service.ts`)
→ `pipeline/gspro.py <kind>` → files in the course's export folder → Unity importers (`unity/`).

## Server: `GsproExportService` (builder mode only)

Migration 016 adds nullable `courses.gspro_export_dir` — the folder `GsproExportService` writes the course's OPCD SVG, orthophoto JPEGs and DEM GeoTIFFs into. NULL means the OS Downloads folder (`GSPRO_EXPORT_DIR` overrides the server-wide default), so an untouched course needs no row and the default can move without a data migration. Mounted only in `builder` mode: it writes to an operator-chosen path and needs the pipeline, neither of which exists on the VPS.

**Terrain squares** (`terrain-square.ts`). A GSPro course is two squares in EPSG:3006 metres: the **inner terrain** — the map area, its side always a whole multiple of `TERRAIN_SIDE_STEP_M` (10 m: 2010 m, never 2009.37 m) on whole-metre edges — and the **outer terrain**, `OUTER_TERRAIN_SIDE_M` (5 km) centred on the inner (or inner + 1 km margin all round when the inner is too big for 5 km). The inner square is derived ONCE, at map-build time, from the drawn WGS84 area (`innerSquareFromWgs84`: corner-reprojected envelope, longer side snapped to the nearest 10 m, centred) and is what `grid-dem --bbox-3006` cuts the DEM to — so the tile manifest's `bounds` are that square's WGS84 envelope and the build writes it verbatim as `manifest.terrain.inner.square3006` (+ `sideM`; `refreshManifestAsset` carries it through re-terrain/trees). `resolveCourseMapBbox` returns it as `terrainSquare`; the exports render over it and derive the outer with `courseTerrainFor`. A site built before that field existed (or a georeference-bbox course) gets its bounds squared and snapped the same way on the fly. The web picker snaps to the same 10 m step in its own approximate metres, but the server's square is the authority.

**Jobs.** Every export runs through `start(courseId, request)` → `GsproExportJob` (`running`/`succeeded`/`failed`, in memory, one running per course — a second `start` is a 409 naming the running one; `job(id)`, `current(courseId)` = running else latest finished; `whenIdle` for tests), because the fetch-first exports (outer ortho: nine 700 MB tiles; outer DEM; outer trees) run for minutes and a request that timed out in the browser left the operator guessing. The API exposes only `start`/`job`/`current`; the per-kind methods below are what a job performs. The service resolves the squares through the same `resolveCourseMapBbox` chain the hydro/OSM fetches use, then shells out via an injectable runner (same seam as `MapBuildService`) to `pipeline/gspro.py svg` / `ortho` / `dem` with `--square-3006 x0,y0,x1,y1` — never `--bbox` — so every file lands on the exact same square and overlays in GSPro; the palette and curve math stay pinned by the pipeline's own tests. `terrain(courseId)` describes both squares for the panel (409 with no map area). The inner orthophoto comes from the site's persisted `sources/<siteId>/ortho-*.tif` (`orthoSources` lists them, newest first, `.patched.tif` flagged; `exportOrtho` only accepts one of those names, so no request can reach outside the folder) as `<course>-<collection>[-patched]-8192.jpg`, 8192 px square at JPEG quality 92 (`ORTHO_EXPORT_SIZE` / `ORTHO_EXPORT_QUALITY`; OPCD uses 95, Unity recompresses anyway) **plus a `-terrain.jpg` twin** (`terrainTextureFileName`) dimmed in LINEAR light by `TERRAIN_TEXTURE_DARKEN` (0.4 — a sun-lit photo down to about grass albedo; ×0.25 on the sRGB bytes was ×0.05 in linear light and rendered muddy) or the request's own `darken` (0.05–1, `TERRAIN_TEXTURE_DARKEN_RANGE`, the panel's "Terrain texture brightness" field) in the same render (`--terrain-out`/`--darken`/`--darken-space linear`); the twin is JPEG q97 4:4:4 (`TERRAIN_JPEG_QUALITY`) since its reduced tonal range makes q92 blocking visible — Unity's terrain shader lights the photo a second time, so the plain one washes out on the terrain; the Unity importer picks the twin by default for the inner terrain, and the `-meshes` variant for the outer (whose export adds `--darken-tint`, `TerrainTintOptions.darkenTint`: the tint colour darkened like the photo, so that file is the twin's darkness plus the colouring — and `--tint-grade` `OUTER_TERRAIN_GRADE`, per-channel linear multipliers that make the terrain shader render it like the course meshes beside it; re-measure from a screenshot and multiply in when the seam still shows). With the request's `tint` (the panel's "Tint the grass surfaces", on by default) the same render also writes a **`-meshes.jpg`** (`meshTextureFileName`), the texture for the course meshes: the darkened twin with the course's grass surfaces tinted by its own drawn features — the Photoshop overlay step OPCD builders do from the SVG — via `--tint-out`/`--tint-course <courseId>`/`--tint-opacity` (`TERRAIN_TINT_OPACITY` 0.5 or the request's `tintOpacity`, 0–1, `TERRAIN_TINT_OPACITY_RANGE`), softened first by `--soften-m` (`MESH_TEXTURE_SOFTEN_M` 1 m, bunkers and paths stay sharp) and written at `--tint-size` (`MESH_TEXTURE_SIZE` 4096) so it doesn't read as a satellite photo in game; the colours, the water layer (brown, feathered shoreline) and which types are tinted or cut out are the pipeline's defaults; the Unity importer lists it for the terrain overlay only after the `-terrain` twins, since it is meant for the meshes. The **outer orthophoto** (`exportOuterOrtho(courseId, collection)`) is fetched with golfpipe `fetch-ortho` over the outer square's WGS84 envelope the first time and kept as `sources/<siteId>/outer-ortho-<collection>.tif` (not listed by `orthoSources`), then rendered as `<course>-outer-<collection>-8192.jpg`. **DEMs / heightmaps** (`exportDem(courseId, 'inner'|'outer')`) go out as square float32 EPSG:3006 GeoTIFFs **plus the Unity `.raw` heightmap** (OPCD's TIF→RAW step, done by `gspro.py dem`: 4097² uint16) and a `.json` sidecar (height range + Unity terrain/import settings), named `<course>-<inner|outer>-dem-<side>m.tif` / `.raw` / `.tif.json`; the pipeline gets `--terrain <kind>`, and an outer export passes `--inner-sidecar` when the inner's sidecar is already in the export folder (`demSidecarName`) so the outer sidecar carries the outer terrain's Unity position — else the report says to export the inner first. **Hillshades** (`exportHillshade(courseId, kind)`, `<course>-<kind>-hillshade-8192.jpg`) render the same DEM (`demSource`, same inner/outer rules) through `gspro.py hillshade` for checking overlays against the relief. **Trees** (`exportTrees(courseId, kind)`, `<course>-<kind>-trees.json`, unity-trees-v1 via `gspro.py trees`): the inner from the trees job's installed `tree-stems.json` (409 until it has run), the outer detected once with golfpipe `trees-stems --no-kind --resolution 2` (`OUTER_TREES_RESOLUTION_M`: background trees, four times fewer cells) over the outer lidar + DEM into `sources/<siteId>/outer-trees/` (`OUTER_TREES_DIR`) and written with `--exclude-square <inner>`; both need that terrain's heightmap sidecar in the export folder (409 otherwise) for the plot's height range. The DEM rules: the inner from `sources/<siteId>/dem-edited.tif` when present else `dem.tif` (D-TE2 — the export shows what the map shows) at `DEM_EXPORT_RESOLUTION_M.inner` (0.5 m); the outer gridded once from **Laserdata Skog lidar** — the same `fetch-lidar` → `grid-dem` route the build takes for the inner, never the licensed DTM product (`fetch-dem` 403s on these credentials) — into `sources/<siteId>/outer-dem.tif` (`OUTER_DEM_SOURCE`) at 1 m. The outer square's `.laz` tiles are kept in `sources/<siteId>/outer-lidar/` (`OUTER_LIDAR_DIR`), separate from the build's `lidar/` so the trees job's input does not grow; the inner tiles are hard-linked in first so `fetch-lidar`'s size-match skip spares re-downloading them. The fetch runs with `--skip-forbidden`: Lantmäteriet withholds some tiles (HTTP 403 though STAC lists them — Vreta's 5 km square hits `649_53`) and for scenery a flat, mean-filled patch beats no outer DEM; the pipeline's `warning:` line is passed through in the report. A fetch that fails leaves no half file (the ortho workdir is a temp dir and `--out` is only written on success). **Cleaned orthophotos** are their own export: the plain inner/outer buttons send neither of the next two options, and the panel's "Cleaned orthophoto textures" section sends them from its two boxes; a request with either writes `<course>-<collection>[-patched]-clean-8192.jpg` / `<course>-outer-<collection>-clean-8192.jpg` (+ their `-terrain`/`-meshes`), so the plain files are never overwritten. **Forest floor** (the request's `forestFloor`, the panel's "Forest floor under woodland stands" box, on by default in that section; `floorColor` `#rrggbb`, `floorMix` 0–1, both optional) adds `--floor-course <courseId>` (+ `--floor-color`/`--floor-mix`) to both orthophoto renders: the pipeline paints the course's `woodland_floor` zones as forest floor on the square before the plain file, the `-terrain` twin and the `-meshes` variant are written (D-VZ10). **Remove buildings** (the request's `removeBuildings`, the cleaned section's box, on by default) adds `--remove-buildings` with `--roofs sources/<siteId>/roofs.tif` and/or `--buildings-survey sources/<siteId>/buildings.geojson`, whichever is on disk; with neither the render goes ahead and the report's first line says to run Regenerate trees. **Vegetation zones** (`exportZones(courseId, kind)`, `<course>-<kind>-zones.json` + `-zones-<n>.png`, `zonesExportFileName`, unity-zones-v2 via `gspro.py zones --course <courseId>`) need that terrain's heightmap sidecar like trees; the outer passes `--exclude-square <inner>`. **Creeks** (`exportCreeks(courseId)`, `<course>-inner-creeks.json`, `creeksExportFileName`, unity-creeks-v1 via `gspro.py creeks`) are R.A.M. splines for the inner terrain only: each `water_creek` feature's line (drawn centerline, else the line found down its polygon) with control points at its water surface, read from the **raw** `sources/<siteId>/dem.tif`. The edited DEM has the creek beds dug (`creek-digs`), and the water belongs above them. They need the inner heightmap sidecar for the terrain's zero. **Heightmap into Unity** (`exportUnityTerrain(courseId, kind)`, kind `unity-terrain`, the panel's **Inner/Outer heightmap → Unity**) runs the heightmap export, then `golfmap.terrain.update` in the open Unity editor whose active GolfMap course's export folder is this course's (`services/unity-bridge.ts`, the MCP server's bridge client; 409 naming the open editors when none matches, before anything is exported). Unity updates that terrain in place with a backup. The report lists what moved, a warning when the sidecar's `minM` (the terrain's zero) moved, and when the outer plot now shows through the inner. **Stale inner heightmap:** the inner exports read the `dem-edited.tif` that "Apply to terrain" last wrote (D-TE2), while the outer replays the edits fresh. So when enabled terrain edits changed after that Apply (or were never applied), the inner heightmap export warns, and `unity-terrain` refuses, because the two terrains would disagree under the changed edits. On Vreta a regenerated building pad left the outer 2.3 m above the inner. **Unity sculpt back to golf-map** (`exportUnitySculpt(courseId, kind)`, kind `unity-sculpt`) runs `golfmap.terrain.capture` in the same editor, converts the capture with `golfpipe sculpt-tif` into `sources/<siteId>/terrain-sculpt/<kind>-sculpt.tif`, and stores it as that terrain's one `delta` terrain edit (origin `unity-sculpt-<kind>`, dated 2999 so it replays after every other edit, hand-drawn included). A capture with nothing sculpted removes it. The heightmap export passes the site's enabled sculpt GeoTIFFs as `gspro.py dem --sculpt`, so the sidecar's `sculptIn` tells Unity how much of the heights is sculpt (see unity/README.md).

## Pipeline: `gspro.py` (standalone CLI, not part of the tile pipeline)


Standalone CLI next to `golfpipe`, for the Unity/GSPro side. Everything renders over
one square EPSG:3006 extent so the outputs overlay exactly. The square comes in two ways
(`_resolve_area`, mutually exclusive): `--square-3006 x0,y0,x1,y1` is used verbatim — this is
what the app passes, its inner or outer **terrain square** (see `server/services/terrain-square.ts`:
the inner is the map area snapped to a 10 m side step, the outer 5 km centred on it) — and
`--bbox` (WGS84) is reprojected and squared by `_square_3006_extent`, the side rounded UP to
the next 10 m (`SIDE_STEP_M`) so a hand-typed area is never a decimal-metre terrain either:

- `ortho` / `hillshade` — square JPEGs (default 8192 px, `--quality`, default 92) from orthophoto
  vintages or a DEM. `ortho --ortho <tif>` renders an already-persisted GeoTIFF instead of
  fetching (cubic resampling — the 0.16 m source is downsampled, and OPCD's own overlay step is a
  cubic 16000→8192); with a single source, `--out` names the exact file (what the app's export
  uses) instead of `--out-dir`'s `ortho_<stem>_<size>px.jpg`, and `--terrain-out` adds a second
  JPEG of the same render dimmed by `--darken` (`DEFAULT_TERRAIN_DARKEN` 0.4) in `--darken-space` `linear`
  (default: sRGB-decode, multiply the light, re-encode — hue-preserving, an albedo-like result) or `srgb`
  (multiply the bytes, the brightness-slider look); encoded at `TERRAIN_JPEG_QUALITY` 97 with no chroma
  subsampling since the reduced tonal range makes q92 blocking visible. For the Unity terrain texture,
  which the terrain shader would otherwise wash out. `--tint-out` adds a third JPEG (the app names it `-meshes`, the texture for the course meshes): that twin with the
  course's grass surfaces tinted — the Photoshop step OPCD builders do by hand (SVG shapes as
  selections, a dark-green layer over the turf), computed from the app's own features instead
  (`--tint-course <id|name>` out of `--db`, same loader as `svg`). `TINT_TYPES` (fairway, green, tee,
  semi/rough, deep_rough) get `--tint-color` (`DEFAULT_TINT_COLOR` #4c5f30, the olive fill of the colourists' Sat_Shader PSD; a sun-lit colour that lifts the darkened photo, right for the course meshes — `--darken-tint` puts it under `--darken` too, so the file stays as dark as the twin, which the app asks for on the outer terrain, together with `--tint-grade R,G,B`: linear-light multipliers on the finished file, because Unity's terrain shader renders the same texture ~2× brighter and greyer than the mesh shaders) at `--tint-opacity`
  (`DEFAULT_TINT_OPACITY` 0.5 — the GSPro colourists' "satellite at 50 % over green"). Before the tint the
  twin is softened by `--soften-m` (`DEFAULT_SOFTEN_M` 1.0: a Gaussian that drops detail finer than that many
  metres, what a 2048 px texture would hold; 0 = off) everywhere except where a masked-off type is on top, so
  turf and undrawn ground lose the "it's a satellite photo" detail while sand edges stay crisp, and the file is
  written at `--tint-size` (`DEFAULT_TINT_SIZE` 4096, never above `--size`); `TINT_MASK_TYPES` (bunker, path) are painted at opacity 0 in
  the SVG's `opcd` stacking order so they cut the tint out of what is under them; `TINT_WATER_TYPES`
  (water, water_creek) are a second layer composited over the grass result — `--water-color`
  (`DEFAULT_WATER_COLOR` #4a3d22, a dark brown) at `--water-opacity` (0.4) on the darkened photo, its
  coverage box-blurred by `--water-feather` metres (`DEFAULT_WATER_FEATHER_M` 4, converted to px at
  render time, symmetric about the drawn edge) so the shoreline runs from the water tint into the
  green (or the untouched photo) instead of cutting it; undrawn ground is the
  pseudo-type `ground` (`TINT_GROUND`) and gets the same colour and opacity — the whole photo at half strength
  over the green, so drawn shapes don't stand out as patches (`--tint ground=none` leaves it alone); `--tint TYPE=#rrggbb[@a]|@a|none` overrides per type. Masks are rasterised from the same
  bezier expansion as the SVG (even-odd for rings-with-holes), feathered `TINT_FEATHER_PX` 1 px, and
  composited as a normal blend in sRGB like the Photoshop layer it replaces, in `TINT_CHUNK_ROWS` row
  chunks so the 8192² texture never goes float32 in one piece. Vreta at 8192 px (194 features): ~3 s on top of the ~45 s render.
- `dem` — clip + bilinear-resample a DEM GeoTIFF (`--dem`, e.g. `sources/<id>/dem-edited.tif`
  or the outer `outer-dem.tif` golfpipe `grid-dem` built from lidar) to the square at `--resolution`
  m/px (default 1; the side must be a whole number of cells) as a float32 EPSG:3006 GeoTIFF,
  **and** do OPCD's TIF→RAW step: `<stem>.raw`, the Unity heightmap — `--raw-size`² (default
  `UNITY_HEIGHTMAP_RESOLUTION` 4097, 0 = skip) uint16 little-endian north-up, `[min,max]→[0,65535]`,
  resampled straight from the source DEM (the same one gdal_translate call the `.bat` makes).
  The `<out>.json` sidecar has `terrain` (`--terrain inner|outer`), `square3006`, `centre3006`,
  `sideM`, `resolution`, `size`, `minM`/`maxM`/`heightRangeM` (one range for TIF and RAW), `raw`
  (file/size/dtype/byteOrder/rowOrder) and `unity` (Width/Length/Height, import dialog values,
  `position`: `0,0,0` for the inner; for an outer given `--inner-sidecar <inner .tif.json>`, the
  outer terrain's transform with the inner at the origin — half the side difference to the
  south-west, y = difference in minima — what OPCD's MinMax sheet computes by hand). The Unity
  importer (`unity/`) reads that sidecar. Voids are mean-filled like the hillshade's.
- `trees` — a tree-stems asset (`--stems tree-stems.json`, golfpipe `trees-stems` output) as the
  `unity-trees-v1` file the Unity Tree Planter reads, over the square: `x`/`z` metres from the
  south-west corner, `id` `epsg3006:<x>:<y>`, `bush` when the crown radius exceeds 0.35 × height,
  `plot.terrain` from `--terrain`, `plot.minM/maxM` copied from `--sidecar` (that terrain's
  heightmap sidecar, which must be for the same square) so the planter's ground check matches the
  terrain; `--exclude-square` drops the inner square's stems from an outer file.
- `zones` — a course's `vegetation_zone` features (`--course` out of `--db`, `attributes_json` keys
  `zoneType`/`zoneVariant`/`weight`/`feather`/`noise`) rasterized into VSPro texture masks for one terrain
  square, the `docs/feature-vegetation-zones.md` §6 rasterizer with D-VZ11's per-item projection. It writes
  one RGBA PNG per four VSP items next to `--out` (`<stem>-<texture>.png`, `--resolution` default 4096,
  and stale higher-numbered PNGs are removed). Channels are allocated per item in the order the course's
  `course_zone_types` table first names it (Default items, then each variant's), and the table must exist.
  It also writes the `unity-zones-v2` JSON (§7): `plot` from `--sidecar` as `trees`, `masks[]`, `items[]`
  (item, texture, channel, the `sources` slots that bind it), `zoneTypes[]` with Default and variant
  bindings, and `zones[]` (with `variant`) as plot-local polygons simplified to `--simplify` 1 m for the
  Scene-view overlay. Per zone: even-odd fill in the tint's pixel frame, signed distance from two
  `distance_transform_edt`s, value noise (`--seed`) on the distance, then
  `clamp(0.5 - d/feather, 0, 1) × weight`. Overlaps use a per-pixel budget of 1, processed from the
  last zone to the first (`render_zone_masks`) and keyed by slot (`type` or `type/variant`). A later
  zone claims first, same-slot zones take the maximum, and nothing is scaled up. Each item's channel is
  then `min(1, Σ slot weight × maxDensity)` over the slots that bind it. It is a sum and not one rule
  per slot, because VSPro multiplies an item's density rules. Zones are processed in bounding-box crops.
  The accumulators are one float32 frame per slot plus the budget (64 MB each at 4096). `--exclude-square`
  works as for trees: zeroed in the masks and cut from the polygons. Unknown zone types are warned about
  and skipped. An unknown variant is warned about and falls back to Default.
- `buildings` — a building survey (`--survey buildings.geojson`, golfpipe `fetch-buildings` output) as the
  `unity-buildings-v1` file the Unity building planter reads, over the square, the same way `trees` does it:
  rectangle centre as `x`/`z` from the south-west corner, the footprint ring in the same local metres,
  `lengthM`/`widthM` and `yawDeg` (the Unity Y rotation, clockwise from above, that turns a prefab's local +x
  onto the footprint's long axis — the planter adds 90/180 for the prefab's own axis and the facade side),
  `eaveM`/`ridgeM` from the lidar, `heightM` + `heightSource` (`lidar` ridge, else the OSM `tag`, else
  `levels` × 3 m), `plot` from `--sidecar`; `--exclude-square` as for trees. Ids are the OSM element ids.
- `gkd` — GreenKeeper's course-description file (`<scene>.GKD` in the GSPro course folder) for a
  course (`--course` out of `--db`) over the INNER terrain square. Holes (par, stroke index), tee
  boxes, pin positions, green centres and aim points from the app's `holes`/`tees`/`greens`/`pins`/
  `aim_points` tables; the `Hazards` from its `water`, `water_creek`, `penalty_yellow` and
  `penalty_red` features, and `pOOB` from the largest `oob` ring (any other `oob` shape is a hazard
  with `innerOOB`), outlines expanded like the SVG's and clipped to the square. Water is staked
  OUTSIDE the water: at least `--water-margin` (0.5 m) for every node and the straight lines between
  them, and out to where its bank ends (ground steeper than `--bank-slope` 8° starting within 2 m of
  the shore, followed up to `--bank-max` 3 m), with a node every `--node-spacing` (3 m) or closer;
  water whose lines would run within 2 m of each other is one hazard. A water body the drawn penalty
  areas hold (allowing 1 m of it past the line, `GKD_PENALTY_HOLDS_WATER_M`) gets no line of its own,
  however tight to the shore the drawn one runs; decided per body, so a creek out of a penalty-held pond
  is still staked, alone. Penalty areas go in as drawn and
  the OOB rings within `--simplify` (1 m); nothing is ever straightened inwards. Every hazard is held strictly inside the course boundary (GSPro's rule): cut 0.25 m
  (`GKD_OOB_INSET_M`) inside the drawn `oob` ring or, with none drawn, the file's own `pOOB`; one
  entirely beyond it is left out. Positions are Unity world metres exactly as `trees` writes them — x/z from the
  square's south-west corner, y the ground above the terrain's zero, read off `--dem` (default: the
  `--sidecar`'s own GeoTIFF) so they sit on the imported heightmap. The app's free-form tee names map
  onto the GKD's eight sets by name then colour (`--tee-map NAME=TEESET` for the rest); a tee's
  `Distance` is the walk through the aim points the tee has not already passed to the green centre
  (the `Par3` set goes straight there), and `TeeTypeTotalDistance` sums them. Four pins per green,
  the green centre standing in for the days a green has no pin for. The file is **merged**: everything
  GreenKeeper owns (name, location, designer, keywords, ratings, range, scene folder) is carried over
  from the file at `--out` or `--template`, and the original is kept once as `<out>.GKD.bak`;
  `--no-merge` starts from a bare v4.1 file. The app runs it as the `gkd` export kind (`exportGkd`, the
  panel's "GreenKeeper course file" section, `bun run gspro:export -- <course> gkd [--course-dir <folder>]`):
  it writes into the course's **GSPro course folder** — migration 021's nullable `courses.gspro_course_dir`,
  set with `setCourseDir` (must be an existing folder; no default, since the scene folder is named when
  the course is built in Unity) — not the export folder, as the `.GKD` already there (`gkdFileIn`, any
  case) or `<folder name>.GKD`, and needs the inner heightmap sidecar in the export folder (409 otherwise).
- `svg` — a course's drawn features straight out of `data/app.sqlite` as a layered,
  fill-only SVG for the Inkscape/Blender leg of OPCD. One layer per hole (`Hole1`…, the
  unpadded spelling the course files use), anything not on a hole on `Others` (not the
  reserved `Hole99` — that changes how Blender cuts); shapes named
  `hole_<hole>_<index>` (`others_<n>` off-hole) with the golf-map type kept in `data-type`,
  since the mesh already carries the material from the fill; within a layer the paint order is the
  app's own, except that `TOP_TYPES` (green, tee, bunker) are lifted to the top so nothing
  on the hole cuts them — `--stack app` keeps it verbatim; **fills are `OPCD_PALETTE`, transcribed from the
  installed `OPCD Palette.gpl`** — fill colour is how OPCD is told what a shape is, so
  don't touch those hexes. Every path is `stroke:none`. B-spline rings expand to the
  identical beziers the app draws (`web/src/geo/bspline.ts`). A type OPCD has no surface
  for (`trees`, `penalty_*`, `oob`) is skipped rather than guessed at, until `--map
  trees=pinestraw` gives it one. `--flatten TOL` swaps the curves for polylines.
  **Nothing leaves the square**: Blender cuts the meshes out of the terrain, so a shape overhanging
  the square's edge breaks the build. A shape whose curve (not just a control point) reaches past
  the edge is written cut to the square (flattened, `_clip_to_square`); merged roads and road-sliver
  fills the same; one wholly outside is left out. Both are counted in the report. Vreta's three
  Lantmäteriet creeks overhung by 6–8 m.
  **Test variants** (for finding the shape the Blender build chokes on): `--exclude-ids FILE` (a JSON array
  of feature ids, or one per line) and `--exclude-type TYPE` (repeatable) leave features out before the
  road merge; excluding a road also drops the stored kerb fillets / tapers (`source = road-junctions`)
  whose `source_ref` names it, and ids the course doesn't have are warned about. The app sends them
  as the `svg` request's `excludeFeatureIds` (written to a temp file, never argv) plus `variant`,
  which names the file `<course>-<variant>.svg` (`exportFileName`) so the full SVG is kept. The web
  panel's "Leave features out" section picks them from a filtered list (only the types the SVG writes:
  `SVG_FEATURE_TYPES` in `web/src/export/svg-exclusions.ts`, mirror `TYPE_SURFACE` + trees) or from
  the Draw selection, marks them red/dashed on the map while open (`FeaturesService.exportExcludedIds`),
  and keeps them per course in the browser's localStorage. **Bisect** (`web/src/export/svg-bisect.ts`):
  the list's current filter becomes the suspects, in Z-order of their centres so each half is a compact
  patch (road pieces merged into one SVG shape mostly stay on one side); each step leaves the first half
  of the remaining suspects out of a `bisect-<step>` variant, the operator builds it in Blender and
  answers (built OK = culprit in the half left out, failed = in the half kept), and the answer exports
  the next step. At one suspect a last export leaves out only it: built = confirmed, failed = it breaks
  only together with others. ⌈log2 n⌉ + 1 builds; undo per answer; the state survives a reload.

