# GSPro export — reference

**Path transition sidecar extension.** `golfmap-path-regions-v1` optionally adds top-level
`transitions`, one entry per feature/merged shape: `{featureId, shape, surface, widthM,
lengthM, centerline3006, transitions}`. `centerline3006` is a deterministic 5 cm flattened
centerline as `[easting,northing]` pairs in EPSG:3006 metres. Each transition carries the
stored controls plus resolved `startM` and `direction`; length follows that sampled curve.
`ending: grass` stays grass after its final marker, whereas `continue` keeps the pattern
without final fading through the directional endpoint. Their occupied footprint extends
to that endpoint (including the tongue before start); marker distances remain nominal.
SVG piece rings retain their existing SVG coordinates. To map centerline points into the
Blender model, subtract the terrain square's west/south origin and use its existing
metres-to-model transform (local X=easting offset, local Y=northing offset); do not apply
the SVG Y inversion to `centerline3006`. Missing transitions preserve old exports.
`--paths-only` reports transition changes too. `shaping-global` emits
`paths-transitions` / `golfmap.path_transition` after `paths-edge-fade` when an eligible
gravel/dirt centerline has valid transitions; Blender reads this sidecar and deterministically
paints the existing path/fringe meshes before Unity refresh.

Detail moved out of `server/AGENTS.md` and `pipeline/AGENTS.md`; those keep the summary.
Chain: web export dialog (`web/src/export/`: tabs Terrain, Textures, Course, Tees, GreenKeeper, plus the SVG test-variant panel beside the map) → `GsproExportService` (`server/services/gspro-export.service.ts`)
→ `pipeline/gspro.py <kind>` → files in the course's export folder → Unity importers (`unity/`).

## Server: `GsproExportService` (builder mode only)

Migration 016 adds nullable `courses.gspro_export_dir` — the folder `GsproExportService` writes the course's OPCD SVG, orthophoto JPEGs and DEM GeoTIFFs into. NULL means the OS Downloads folder (`GSPRO_EXPORT_DIR` overrides the server-wide default), so an untouched course needs no row and the default can move without a data migration. Mounted only in `builder` mode: it writes to an operator-chosen path and needs the pipeline, neither of which exists on the VPS.

**Terrain squares** (`terrain-square.ts`). A GSPro course is two squares in EPSG:3006 metres: the **inner terrain** — the map area, its side always a whole multiple of `TERRAIN_SIDE_STEP_M` (10 m: 2010 m, never 2009.37 m) on whole-metre edges — and the **outer terrain**, `OUTER_TERRAIN_SIDE_M` (5 km) centred on the inner (or inner + 1 km margin all round when the inner is too big for 5 km). The inner square is derived ONCE, at map-build time, from the drawn WGS84 area (`innerSquareFromWgs84`: corner-reprojected envelope, longer side snapped to the nearest 10 m, centred) and is what `grid-dem --bbox-3006` cuts the DEM to — so the tile manifest's `bounds` are that square's WGS84 envelope and the build writes it verbatim as `manifest.terrain.inner.square3006` (+ `sideM`; `refreshManifestAsset` carries it through re-terrain/trees). `resolveCourseMapBbox` returns it as `terrainSquare`; the exports render over it and derive the outer with `courseTerrainFor`. A site built before that field existed (or a georeference-bbox course) gets its bounds squared and snapped the same way on the fly. The web picker snaps to the same 10 m step in its own approximate metres, but the server's square is the authority.

**Jobs.** Every export runs through `start(courseId, request)` → `GsproExportJob` (`running`/`succeeded`/`failed`, in memory, one running per course — a second `start` is a 409 naming the running one; `job(id)`, `current(courseId)` = running else latest finished; `whenIdle` for tests), because the fetch-first exports (outer ortho: nine 700 MB tiles; outer DEM; outer trees) run for minutes and a request that timed out in the browser left the operator guessing. The API exposes only `start`/`job`/`current`; the per-kind methods below are what a job performs. The service resolves the squares through the same `resolveCourseMapBbox` chain the hydro/OSM fetches use, then shells out via an injectable runner (same seam as `MapBuildService`) to `pipeline/gspro.py svg` / `ortho` / `dem` with `--square-3006 x0,y0,x1,y1` — never `--bbox` — so every file lands on the exact same square and overlays in GSPro; the palette and curve math stay pinned by the pipeline's own tests. `terrain(courseId)` describes both squares for the panel (409 with no map area). The inner orthophoto comes from the site's persisted `sources/<siteId>/ortho-*.tif` (`orthoSources` lists them, newest first, the cleaned photo `ortho-<collection>.cleaned.tif` flagged `cleaned`; `exportOrtho` only accepts one of those names, so no request can reach outside the folder) as `<course>-<collection>[-cleaned]-8192.jpg`, 8192 px square at JPEG quality 92 (`ORTHO_EXPORT_SIZE` / `ORTHO_EXPORT_QUALITY`; OPCD uses 95, Unity recompresses anyway) **plus a `-terrain.jpg` twin** (`terrainTextureFileName`) dimmed in LINEAR light by `TERRAIN_TEXTURE_DARKEN` (0.4 — a sun-lit photo down to about grass albedo; ×0.25 on the sRGB bytes was ×0.05 in linear light and rendered muddy) or the request's own `darken` (0.05–1, `TERRAIN_TEXTURE_DARKEN_RANGE`, the panel's "Terrain texture brightness" field) in the same render (`--terrain-out`/`--darken`/`--darken-space linear`); the twin is JPEG q97 4:4:4 (`TERRAIN_JPEG_QUALITY`) since its reduced tonal range makes q92 blocking visible — Unity's terrain shader lights the photo a second time, so the plain one washes out on the terrain; the Unity importer picks the twin by default for the inner terrain, and the `-meshes` variant for the outer (whose export adds `--darken-tint`, `TerrainTintOptions.darkenTint`: the tint colour darkened like the photo, so that file is the twin's darkness plus the colouring — and `--tint-grade` `OUTER_TERRAIN_GRADE`, per-channel linear multipliers that make the terrain shader render it like the course meshes beside it; re-measure from a screenshot and multiply in when the seam still shows). With the request's `tint` (the panel's "Tint the grass surfaces", on by default) the same render also writes a **`-meshes.jpg`** (`meshTextureFileName`), the texture for the course meshes: the darkened twin with the course's grass surfaces tinted by its own drawn features — the Photoshop overlay step OPCD builders do from the SVG — via `--tint-out`/`--tint-course <courseId>`/`--tint-opacity` (`TERRAIN_TINT_OPACITY` 0.5 or the request's `tintOpacity`, 0–1, `TERRAIN_TINT_OPACITY_RANGE`), softened first by `--soften-m` (`MESH_TEXTURE_SOFTEN_M` 1 m, bunkers and paths stay sharp) and written at `--tint-size` (`MESH_TEXTURE_SIZE` 8192: the grass would fit in 4096, but a 2-3.5 m path at 4096 was 4-7 texels wide and its diagonal edges stepped, 2 m teeth after Unity's BC1) so it doesn't read as a satellite photo in game; the colours, the water layer (brown, feathered shoreline) and which types are tinted or cut out are the pipeline's defaults; the Unity importer lists it for the terrain overlay only after the `-terrain` twins, since it is meant for the meshes. The **outer orthophoto** (`exportOuterOrtho(courseId, collection)`) is fetched with golfpipe `fetch-ortho` over the outer square's WGS84 envelope the first time and kept as `sources/<siteId>/outer-ortho-<collection>.tif` (not listed by `orthoSources`), then rendered as `<course>-outer-<collection>-8192.jpg`. **DEMs / heightmaps** (`exportDem(courseId, 'inner'|'outer')`) go out as square float32 EPSG:3006 GeoTIFFs **plus the Unity `.raw` heightmap** (OPCD's TIF→RAW step, done by `gspro.py dem`: 4097² uint16) and a `.json` sidecar (height range + Unity terrain/import settings), named `<course>-<inner|outer>-dem-<side>m.tif` / `.raw` / `.tif.json`; the pipeline gets `--terrain <kind>`, and an outer export passes `--inner-sidecar` when the inner's sidecar is already in the export folder (`demSidecarName`) so the outer sidecar carries the outer terrain's Unity position — else the report says to export the inner first. **Hillshades** (`exportHillshade(courseId, kind)`, `<course>-<kind>-hillshade-8192.jpg`) render the same DEM (`demSource`, same inner/outer rules) through `gspro.py hillshade` for checking overlays against the relief. **Trees** (`exportTrees(courseId, kind)`, `<course>-<kind>-trees.json`, unity-trees-v1 via `gspro.py trees`): the inner from the trees job's installed `tree-stems.json` (409 until it has run), the outer detected once with golfpipe `trees-stems --no-kind --resolution 2` (`OUTER_TREES_RESOLUTION_M`: background trees, four times fewer cells) over the outer lidar + DEM into `sources/<siteId>/outer-trees/` (`OUTER_TREES_DIR`) and written with `--exclude-square <inner>`; both need that terrain's heightmap sidecar in the export folder (409 otherwise) for the plot's height range. The DEM rules: the inner from `sources/<siteId>/dem-edited.tif` when present else `dem.tif` (D-TE2 — the export shows what the map shows) at `DEM_EXPORT_RESOLUTION_M.inner` (0.5 m); the outer gridded once from **Laserdata Skog lidar** — the same `fetch-lidar` → `grid-dem` route the build takes for the inner, never the licensed DTM product (`fetch-dem` 403s on these credentials) — into `sources/<siteId>/outer-dem.tif` (`OUTER_DEM_SOURCE`) at 1 m. The outer square's `.laz` tiles are kept in `sources/<siteId>/outer-lidar/` (`OUTER_LIDAR_DIR`), separate from the build's `lidar/` so the trees job's input does not grow; the inner tiles are hard-linked in first so `fetch-lidar`'s size-match skip spares re-downloading them. The fetch runs with `--skip-forbidden`: Lantmäteriet withholds some tiles (HTTP 403 though STAC lists them — Vreta's 5 km square hits `649_53`) and for scenery a flat, mean-filled patch beats no outer DEM; the pipeline's `warning:` line is passed through in the report. A fetch that fails leaves no half file (the ortho workdir is a temp dir and `--out` is only written on success). **Cleaned orthophotos** are their own export: the plain inner/outer buttons send neither of the next two options, and the panel's "Cleaned orthophoto textures" section sends them from its two boxes; a request with either writes `<course>-<collection>[-cleaned]-clean-8192.jpg` / `<course>-outer-<collection>-clean-8192.jpg` (+ their `-terrain`/`-meshes`), so the plain files are never overwritten. **Forest floor** (the request's `forestFloor`, the panel's "Forest floor under woodland stands" box, on by default in that section; `floorColor` `#rrggbb`, `floorMix` 0–1, both optional) adds `--floor-course <courseId>` (+ `--floor-color`/`--floor-mix`) to both orthophoto renders: the pipeline paints the course's `woodland_floor` zones as forest floor on the square before the plain file, the `-terrain` twin and the `-meshes` variant are written (D-VZ10). **Remove buildings** (the request's `removeBuildings`, the cleaned section's box, on by default) adds `--remove-buildings` with `--roofs sources/<siteId>/roofs.tif` and/or `--buildings-survey sources/<siteId>/buildings.geojson`, whichever is on disk; with neither the render goes ahead and the report's first line says to run Regenerate trees. **Vegetation zones** (`exportZones(courseId, kind)`, `<course>-<kind>-zones.json` + `-zones-<n>.png`, `zonesExportFileName`, unity-zones-v2 via `gspro.py zones --course <courseId>`) need that terrain's heightmap sidecar like trees; the outer passes `--exclude-square <inner>`. **Creeks** (`exportCreeks(courseId)`, `<course>-inner-creeks.json`, `creeksExportFileName`, unity-creeks-v1 via `gspro.py creeks`) are R.A.M. splines for the inner terrain only: each `water_creek` feature's line (drawn centerline, else the line found down its polygon) with control points at its water surface, read from the **raw** `sources/<siteId>/dem.tif`. The edited DEM has the creek beds dug (`creek-digs`), and the water belongs above them. They need the inner heightmap sidecar for the terrain's zero. **Heightmap into Unity** (`exportUnityTerrain(courseId, kind)`, kind `unity-terrain`, the panel's **Inner/Outer heightmap → Unity**) runs the heightmap export, then `golfmap.terrain.update` in the open Unity editor whose active GolfMap course's export folder is this course's (`services/unity-bridge.ts`, the MCP server's bridge client; 409 naming the open editors when none matches, before anything is exported). Unity updates that terrain in place with a backup. The report lists what moved, a warning when the sidecar's `minM` (the terrain's zero) moved, and when the outer plot now shows through the inner. **Stale inner heightmap:** the inner exports read the `dem-edited.tif` that "Apply to terrain" last wrote (D-TE2), while the outer replays the edits fresh. So when enabled terrain edits changed after that Apply (or were never applied), the inner heightmap export warns, and `unity-terrain` refuses, because the two terrains would disagree under the changed edits. On Vreta a regenerated building pad left the outer 2.3 m above the inner. **Unity sculpt back to golf-map** (`exportUnitySculpt(courseId, kind)`, kind `unity-sculpt`) runs `golfmap.terrain.capture` in the same editor, converts the capture with `golfpipe sculpt-tif` into `sources/<siteId>/terrain-sculpt/<kind>-sculpt.tif`, and stores it as that terrain's one `delta` terrain edit (origin `unity-sculpt-<kind>`, dated 2999 so it replays after every other edit, hand-drawn included). A capture with nothing sculpted removes it. The heightmap export passes the site's enabled sculpt GeoTIFFs as `gspro.py dem --sculpt`, so the sidecar's `sculptIn` tells Unity how much of the heights is sculpt (see unity/README.md). **Cleaned photo into Unity** (`exportUnityOrtho(courseId, source, …)`, kind `unity-ortho`, the panel's **Inner cleaned photo → Unity meshes**) finds the editor the same way (409 before anything is rendered), runs the inner orthophoto export with the request's options and the `-meshes` file always on, then `golfmap.orthos.apply file=<that -meshes file>`: Unity overwrites the texture its course meshes sample as `_Satellite` in place, whatever the project's copy is called, the old one backed up. The panel sends the picked vintage's cleaned photo (`.cleaned.tif`, CleanedPhotoService) when the site has one and the cleaned section's two boxes as ticked; both off is allowed here.

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
  semi/rough, deep_rough) get `--tint-color` (`DEFAULT_TINT_COLOR` #4c5f30, the olive fill of the colourists' Sat_Shader PSD; a sun-lit colour that lifts the darkened photo, right for the course meshes — `--darken-tint` puts it under `--darken` too, so the file stays as dark as the twin, which the app asks for on the outer terrain, together with `--tint-grade R,G,B`: linear-light multipliers on the finished file, because Unity's terrain shader lights the same texture differently from the mesh shaders; the app's values are for the outer terrain on Built In Legacy Diffuse, which the terrain importer sets) at `--tint-opacity`
  (`DEFAULT_TINT_OPACITY` 0.5 — the GSPro colourists' "satellite at 50 % over green"). Before the tint the
  twin is softened by `--soften-m` (`DEFAULT_SOFTEN_M` 1.0: a Gaussian that drops detail finer than that many
  metres, what a 2048 px texture would hold; 0 = off) everywhere except where a masked-off type is on top, so
  turf and undrawn ground lose the "it's a satellite photo" detail while sand edges stay crisp, and the file is
  written at `--tint-size` (`DEFAULT_TINT_SIZE` 8192, never above `--size`); `TINT_MASK_TYPES` (bunker, path) are painted at opacity 0 in
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
  **Edge fill** (`--edge-fill TYPES`, default `bunker,path`; `none` = the old file, as photographed): the
  course meshes sample this file as the base colour of every MAHS channel set to *Use Satellite for Base* (rough,
  blend, the bunker's own sand) and the Stix 3D grass colours every blade by it (`_ColorMap`), so the photo's sand
  running past the drawn outline (misregistration, the soften blur, bilinear sampling) painted a pale strip round
  every bunker and white blades next to it. Measured on Vreta (35 bunkers, 4096 px file): luma 82 vs 75 on the
  grass 0.5-1 m outside the outline; paths the same in grey gravel (+4 luma on average, the long ones +5..9 and
  +6..8 blue within 1.5 m). After the resize, a band from the type's inset (`EDGE_FILL_INSET_M`: bunker 0.5, the
  first 0.5 m texel inside the outline; path 0, since a ~2 m path's `_Sat` concrete samples the file
  too; `--edge-fill-inset-m` sets one for all) to `--edge-fill-m` (1.25) outside each feature is filled from the ground beyond it (`building_removal.nearest_fill`: nearest clean
  1 m cell at least 0.5 m past the band, blurred 2 m). Both ends are linear ramps on each pixel centre's exact
  distance to the drawn outline (STRtree over the outline's segments): fill 0.5 at the inset over
  `EDGE_FILL_INNER_RAMP_M` 1 m, and a fade from 1.25 to 2.25 m out (`EDGE_FILL_FEATHER_M`). A raster edge on
  0.5 m texels is a staircase, and along a long path at a shallow angle every texel row showed in Unity as a
  step in a pale strip; a one-texel ramp still aliases (along-path std 10-14 on a 4 degree test path, 2-5 with the
  two-texel ramps). The rest of the bunker (and the whole path) stays
  photographed: its sand channels sample this file too, and a filled bunker would turn green at a distance. Only
  the `-meshes` file; the plain photo and the `-terrain` twin are unchanged. Into Unity: `golfmap.orthos.update`
  copies the re-exported file over the project's copy in place (unity/README.md, "3D grass on the roughs").
  **Path fill** (`--path-fill`, on by default; `--no-path-fill` = the shadows as photographed): OPCD's Satellite-theme
  path concrete (`OPCD MAHS Concrete - Asphalt_Sat`, red/green *Use Satellite for Base*) takes its colour from this file,
  so every tree shadow the photo caught on a path showed in Unity as dark blue blocks on the path (Vreta: path luma
  median 95, p10 36; shadow pixels (B-R)/luma 0.4-1, sunlit gravel -0.05, dark asphalt ~0). Before the edge fill, inside
  every `path` (roads included; not `surface: bridge` decks or `grass` tracks) a pixel is shadow by smoothstep weights
  when it is darker than `PATH_FILL_RATIO` (0.6-0.85) of the sunlit path near it, blue (`PATH_FILL_BLUE`), or in a
  mostly blue stretch (`PATH_FILL_BLUE_SHARE` within 2 m: a path shaded all along has no sunlit pixel to compare with).
  Shadow becomes the sunlit path colour round it - normalised Gaussians of the sunlit pixels at `PATH_FILL_NEAR_M` 6 m
  plus 0.05 x `PATH_FILL_FAR_M` 30 m on a 2 m grid, the course's sunlit path colour as the last resort - times the
  pixel's own relief against its shadow neighbours (1 m, clipped to +/-20 %), so gravel keeps its grain and roads their
  own colour. Neutral dark asphalt is left alone. Vreta: 102 paths, 7 900 m² lifted, +2 s. Compared in Unity with a
  satellite-free path material (`golfmap.paths.materials look=plain`, unity/README.md "Cart paths"): the fill kept
  gravel vs asphalt and the photo's variation, the plain material made every path one flat pinkish grey.
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
  terrain; `--exclude-square` drops the inner square's stems from an outer file. With `--course`
  (out of `--db`; the web export passes it), the course's `tree_area` features
  (`shared/features/tree-areas.ts`: `species` `"oak=9, birch"`, optional `name`/`ignoreKind`) go
  into `areas[]` (`{id, name, ignoreKind, species: [{species, weight}], stems, rings}`, the outline
  clipped to the square minus `--exclude-square`, simplified 0.5 m, plot-local like the zones' rings)
  and each stem inside one gets `area: <id>`. Where areas overlap, the one higher in the web editor's
  stack wins; an area without a usable mix is skipped with a warning.
  Stems that are no trees are left out (report line `left out: N ... on a rock slab or placed rock, M in a
  power line's corridor`): every stem inside a `power_line` feature's corridor or within 3 m of it
  (`TREE_POWER_LINE_CLEARANCE_M`)
  (`shared/features/power-line.ts`: the lidar reads the wires as tall thin trees), and stems under 6 m
  (`TREE_ROCK_MAX_HEIGHT_M`) on a `rock_slab` feature (+0.5 m) or within half the length of a placed rock
  of `--rocks <stone-walls.json>` (golfmap-walls-v1 `boulders`; the web export passes
  `docs/gspro/<course slug>/stone-walls.json` when the course has one). A taller stem on a rock is a
  real tree and stays.
- `zones` — a course's `vegetation_zone` features (`--course` out of `--db`, `attributes_json` keys
  `zoneType`/`zoneVariant`/`weight`/`feather`/`noise`/`blend`/`extraPalettes`) rasterized into VSPro texture masks for one terrain
  square, the `docs/feature-vegetation-zones.md` §6 rasterizer with D-VZ11's per-item projection. It writes
  one RGBA PNG per four VSP items next to `--out` (`<stem>-<texture>.png`, `--resolution` default 4096,
  and stale higher-numbered PNGs are removed). Channels are allocated per item in the order the course's
  `course_zone_types` table first names it (Default items, then each variant's), and the table must exist.
  It also writes the `unity-zones-v2` JSON (§7): `plot` from `--sidecar` as `trees`, `masks[]`, `items[]`
  (item, texture, channel, the `sources` slots that bind it), `zoneTypes[]` with Default and variant
  bindings, and `zones[]` (with `variant`) as plot-local polygons simplified to `--simplify` 1 m for the
  Scene-view overlay. Per zone: even-odd fill in the tint's pixel frame, signed distance from two
  `distance_transform_edt`s, value noise (`--seed`) on the distance, then
  `clamp(0.5 - d/feather, 0, 1) × weight`. Drawn zones come first and add up in any order (the
  same slot takes the maximum); a drawn replace zone's weight is taken from the ground left to the
  generated zones (D-VZ14). The generated zones share the rest with a per-pixel budget, processed from
  the last to the first (`render_zone_masks`) and keyed by slot (`type` or `type/variant`): a later one
  claims first, same-slot zones take the maximum, and nothing is scaled up. Each item's channel is
  then `min(1, Σ slot weight × maxDensity)` over the slots that bind it. It is a sum and not one rule
  per slot, because VSPro multiplies an item's density rules. Zones are processed in bounding-box crops.
  The accumulators are one float32 frame per slot plus the budget (64 MB each at 4096). `--exclude-square`
  works as for trees: zeroed in the masks and cut from the polygons. Unknown zone types are warned about
  and skipped. An unknown variant is warned about and falls back to Default.
- `zones-patch` — the quick path for some zones (the web's **Update for GSPro**, `bun run zones -- update`):
  `--zones-json` (a terrain's zones export) `--ids` (zone ids) `--course` re-rasterizes only the window those
  zones cover, now and in that export (its rows), plus any exported zone the course no longer has.
  `render_zone_masks(window=)` gives exactly the full render's pixels there, since each zone's crop is only
  clipped to the window plus its `feather/2 + noise` margin. Only the textures whose pixels change are
  rewritten, and only the zones' rows in the JSON. `--result` writes a `unity-zones-patch-v1` record (changed
  textures, the window in plot-local metres) for Unity's `golfmap.zones.patch`. When the zones reach the square
  and the zone types' item bindings differ from the export's, the channels may have moved: it exits 3 before
  writing anything, and the square needs a full export. The zones JSON carries `seed` and `simplifyM` so a
  patch rasterizes and simplifies like the export did. Zones the export has not seen (drawn since, or a
  re-run generator's new ids) are matched to vanished rows by content: identical ones are renamed in the
  JSON and patch nothing (`renamed` in the record), the others are patched in. Hand-drawn `creek_bank`
  zones are creek sections (left out) only near a creek or water (`creek_section_ids`).
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
  `--sidecar`'s own GeoTIFF) so they sit on the imported heightmap. A tee goes on the GKD set
  its course tee set says (`course_tee_sets.gspro_tee`, migration 030, picked in the export dialog's Tees tab; NULL = not exported), whatever the club calls the set; a tee without a set, or a
  database from before the column, is matched by name then colour (`--tee-map NAME=TEESET` overrides both); a tee's
  `Distance` is the walk through the aim points the tee has not already passed to the green centre
  (the `Par3` set goes straight there), and `TeeTypeTotalDistance` sums them. A set a hole has no tee
  for (and a missing aim point) is a disabled row, a hole with no tee a disabled hole; tees under 1 m
  apart share the position furthest from the hole and tees within 6 m that stand under 0.7 m off the
  line of play are put on it (`_gkd_tidy_tees`, see `pipeline/README.md`). Four pins per green,
  the green centre standing in for the days a green has no pin for. The file is **merged**: the header
  (range, wind, stimp, scene folder) is carried over from the file at `--out` or `--template`, and the
  original is kept once as `<out>.GKD.bak`. The **course details** — name, city/state/country, designer,
  homage, description (`CourseInfo`), keywords, difficulty — round-trip:
  `GsproCourseMeta` (`shared/gspro-course-meta.ts`) in migration 028's nullable `courses.gspro_meta_json`,
  edited in the panel's "Course details" (`setMeta`, saved per field) and written into the header by the
  export; `readGkdMeta` ("Read the course details from the .GKD") stores the ones in the folder's `.GKD`
  after an edit in GreenKeeper. `settings` returns both (`meta`, `gkdMeta`) and the panel names what
  differs. NULL = none kept: the form shows the file's and the export leaves them alone. Each tee set's
  **rating/slope** (`<set>SR`) comes from the course's tee sets instead — `course_tee_sets` (migration 029,
  `TeeSetsService`, Furniture › Tee sets): a men's and a women's course rating and slope per set and
  `gspro_rating` saying which of the two the GKD gets; a set lands on the GKD set its tees do
  (`gspro_tee`, `_load_gkd_ratings`), sets without that rating leave the file's value. `readGkdMeta` also writes the
  file's ratings back onto the sets (`settings.gkdRatings` lists the ones that differ); `readGkdRatings`
  (the Tees tab's "Read the ratings from the .GKD") takes the ratings alone and leaves the kept details. A set marked
  `gspro_only` (Furniture › Tee sets, "GSPro only": a Junior or Par3 set the club does not have) is
  exported like any other; the mark, copied onto its tees (`tees.gspro_only`), is for the course guide
  to leave it out, and the course length (`CoursesService.loadHoleGeometry`) already does.
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
  `hole_<hole>_<number>` (`others_<number>` off-hole), the number being the feature's per-course
  `feature_no` in hex (server migration 026: a counter that only goes up, so never reused; 3 hex digits
  cover 4095 shapes; the export panel lists each feature under this name). A feature without one -
  generated rows, or a database from before 026 - takes 5 characters of its id instead (`_shape_ids`;
  more where an older shape already has that name). The feature id is in `data-feature-id` and the
  golf-map type in `data-type`, since the mesh already carries the material from the fill. OPCD keeps
  the name (`Spline_hole_18_1c_Bunker_-_Mesh`), so
  a mesh keeps its name when other features on the hole change, and Unity-side edits can be keyed to
  it (until 2026-09 it was the feature's index on the hole, which renumbered the hole's bunkers on
  almost any edit there; the first export after that renames every mesh once, so the next Unity mesh
  sync re-adds them all: run it with `prune`). The roads and paths go to a `Roads` layer on top, every
  touching piece (kerb fillets, tapers, a drawn lot) of every surface merged into **one shape per
  connected network** (`_merged_roads`, `data-feature-id` = the pieces' ids, space-separated), as OPCD
  builds them best: the fillets of "Round kerbs at junctions" dissolve inside the one shape. The pieces
  are cleaned as one network (slits and gaps under 0.6 m closed, `ROADS_CLOSE_M`; hairline spurs
  opened, `ROADS_OPEN_M`; holes under `ROADS_MIN_HOLE_M2` filled; a shape under `PATH_SURFACE_MIN_M2`,
  1 m², dropped) and carry no `data-surface`: which part is gravel and which asphalt is not the SVG's
  business. A piece without a surface (a kerb fillet, an OSM way without the tag) has `surface: null`
  in the sidecar and does not count towards its shape's dominant surface.
  **Grass tracks** (`surface: grass`) are not hard ground: they are written as their own shapes with
  the rough fill (`GRASS_TRACK_FILL`, merged among themselves) under every hard road, so OPCD makes
  them rough, not a path mesh; they carry `data-surface="grass"`, the only road shapes that do. A
  track is written minus the hard network eroded by `PATH_SURFACE_OVERLAP_M` (it reaches 5 cm under a
  road and no further; cut by a road along its edge, a whole track left a sliver of rough), opened by
  half of `GRASS_TRACK_MIN_WIDTH_M` (a track thinner than 30 cm is no track), and a track a road
  crosses becomes one shape per side. With `--map` giving the path type another OPCD surface the
  type is one fill and the tracks stay in the one shape.
  **The sidecar `<stem>-paths.json`** (`path_surfaces_file`, `_road_regions`, format
  `golfmap-path-regions-v1`) holds the surfaces, in two parts: `shapes` = `{"roads_124": "asphalt",
  ...}`, each shape's dominant surface by area (what Unity's `golfmap.paths.materials` reads to give
  each `Spline_roads_<n>_...` mesh its material; grass tracks included), and `regions` = per shape
  `{surface, mixed, pieces: [{id, featureNo, surface, source, for, rings}]}`: every piece with its
  surface and its outline in SVG units (`for` = the roads a junction piece was made for), the input of
  the Blender step that cuts a mixed shape's OPCD meshes along the surface seams and separates one
  object per surface, `Spline_roads_<n>_<surface>_...` (`golfmap.split_surfaces`, blender/README.md
  "Shaping: surfaces of a merged road"; the layer op comes from `shaping-global`, below).
  `svg --paths-only` rewrites just this sidecar for the SVG already at `--out` (the SVG untouched; refused
  when there is none) and reports what changed against the one it replaces: the shapes whose pieces
  changed surface, and warnings for what the meshes cannot follow without a new SVG and OPCD build (a
  road shape that came or went, an outline that moved, a grass track made a hard path or back). The
  web's **Update paths in Unity** runs it first (docs/workflows.md section 5).
  **History**: on 2026-10-04/05 the export wrote one shape per surface (`_surface_regions`, with a
  `data-surface` on every road, the higher surface keeping the contested bits, the lower written first
  and reaching 5 cm under it, slivers handed between the shares). It was dropped: a seam through a
  junction cut the kerb fillets into slivers, every repair of those left its own bumps (wedges, thorns,
  tapering tongues, hairlines that snapped into spikes), and OPCD's build failed on the result. The
  per-surface split now happens in Blender, on the mesh, where the junction is already dissolved.
  A shape is named `roads_<number>` after the **lowest**
  `feature_no` among its pieces (`_road_names`), so a road drawn elsewhere, or a piece added to this
  one, never renames it; a road of generated pieces only takes its oldest piece's id-derived name, and
  two roads that would share a name (one piece reaching into both) keep them unique (the next piece's
  number, else `_2`…). Until 2026-09 they were `roads_<i>` in paint order and renumbered whenever a
  road was added before them. Within a layer the paint order is the
  app's own, except that `TOP_TYPES` (green, tee, bunker) are lifted to the top so nothing
  on the hole cuts them — `--stack app` keeps it verbatim; **fills are `OPCD_PALETTE`, transcribed from the
  installed `OPCD Palette.gpl`** — fill colour is how OPCD is told what a shape is, so
  don't touch those hexes. Every path is `stroke:none`. B-spline rings expand to the
  identical beziers the app draws (`web/src/geo/bspline.ts`). A type OPCD has no surface
  for (`trees`, `penalty_*`, `oob`) is skipped rather than guessed at, until `--map
  trees=pinestraw` gives it one. A `rock_slab` is skipped by design (counted on its own report line): its mesh
  comes from a Blender cut-out, see `shaping-global`. `--flatten TOL` swaps the curves for polylines.
  **Nothing leaves the square**: Blender cuts the meshes out of the terrain, so a shape overhanging
  the square's edge breaks the build. A shape whose curve (not just a control point) reaches past
  the edge is written cut to the square (flattened, `_clip_to_square`); merged roads and road-sliver
  fills the same; one wholly outside is left out. Both are counted in the report. Vreta's three
  Lantmäteriet creeks overhung by 6–8 m.
  **The report** has a roads line, e.g. `roads: 107 road piece(s) merged into 15 shape(s), slits and gaps
  under 0.6 m closed; 4 grass track(s) written as rough` (the grass part only when there are tracks),
  and `wrote vreta-paths.json (15 road shape(s) with a surface; 1 of mixed surfaces, for Blender to cut:
  roads_124)` (the mixed part only when a shape holds more than one surface).
  **Left out, not ground**: bridge decks (`path` with the attribute `surface: bridge`, the props'
  deck outlines kept only so vegetation zones clear them; with their kerb fillets) and any drawn,
  non-road shape under `MIN_SHAPE_AREA_M2` (1 m²: a click or drag that collapsed while drawing -
  Vreta's 0 m² bunker broke the Blender build). Both are named in the report.
  **Road-edge slivers** (`_road_edge_fills`): a gap under 1 m between a road and a rough/semi/deep/
  fairway/trees surface goes to that surface, written flattened. A "gap" thinner than 1 cm on average
  is closing noise along the kerb and is not filled (filled plus the 2 cm overlap it became a 16 m
  needle); where a surface edge leaves the road at a slant, the wedge is filled only up to a cut square
  to the road (`_square_off_wedge`) - the closing's slanted end ran along the kerb into a spike
  beside a notch.
  **Bisect against earlier states** (`bun run gspro:bisect`, see AGENTS.md): every full SVG export is
  kept in `<export dir>/export-history/`, and the edit history rebuilds the course at any time since
  migration 025; variants are exported from a copy of the database.
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

- `shaping-global` — the generated Blender shaping layer (`blender/SHAPING-PLAN.md`) for a course:
  `--course` out of `--db` (opened read-only, the `svg` loaders), written to
  `docs/gspro/<course slug>/shaping/00-global.gen.json` (`--out` to override), format
  `golfmap-shaping-layer-v1`, `generated: true`. Ops in replay order: `tees` (`afrod.flattentees`,
  `select: {type: tee}`, `SHAPING_TEE_PARAMS`), `paths-cut` (`afrod.cutcartpaths`, `select: {feature: [<concrete path ids>]}`: the cut is the
  concrete-slab look, so only concrete paths; none for asphalt, gravel, dirt..., and none when the course
  has a mixed road shape, because the cut runs before the split on the whole merged mesh - stats
  `concrete_paths` / `concrete_cut_skipped`; its paint is decided per road shape in Blender: a grass track's
  `data-surface`, else the op's `pathSurfaces`, else the database; see blender/README.md "The cut's paint")
  + `paths-smooth` (`afrod.smoothcartpaths`, `select: {type: path}`, `SHAPING_PATH_SMOOTH_PARAMS`, all
  paths; the cut and the smoothing together left 3-4 cm kinks every ~4 m on Vreta's asphalt and gravel),
  then, when a
  merged road shape holds more than one surface, `paths-surfaces` (`golfmap.split_surfaces`, `select:
  {shape: [<roads_n>, ...]}`: the shapes the SVG export's `<stem>-paths.json` marks `mixed`, worked out
  from the same rows the same way, `_mixed_road_shapes`; Blender cuts their meshes along the seams and
  separates one object per surface, after the cut and smooth and before the footprints, which level the
  parts alike since they share the seam vertices; the report says `1 road shape(s) of mixed surfaces
  split per surface in Blender: roads_124`), then `golfmap.flatten_footprint` per **lot** (`lot-<shape name>`, `featureId`, `seed` =
  `feature_no`, `level: plane`, `falloffM` 2: a hand-made `path` polygon, not a centerline road,
  generated fillet or bridge deck, with 4πA/P² ≥ 0.15 - the server's road-grading rule for a lot
  plane) and per **pad** (`pad-<origin_ref slug>`, else `pad-<edit id>`: the site's enabled `plane`
  terrain edits other than the lots graded from a feature, `level: median` when `flat`, else
  `plane`). `footprint3006` (EPSG:3006, cm, open ring) is the area that ends up level and `falloffM`
  the blend band outside it: a terrain edit feathers inside its ring, so its ring is shrunk by its
  `featherM` (a building pad = footprint + 1.5 m apron, falloff 4 m). Pads whose falloff edge is over
  `SHAPING_PAD_REACH_M` (10 m) from every course shape move no mesh and are left out, counted in the
  report, as are lot edits of this course's features and stale ones (deleted features). No timestamps,
  sorted stable ids: regenerating diffs cleanly (pad rows get new ids on every re-import; their
  `origin_ref` doesn't change). Last, when the course has a gravel or dirt path (`stats.edge_fade_paths`),
  `paths-edge-fade` (`golfmap.path_edge_fade`, `select: {type: path}`): on the final heights, those paths'
  fringe strips are widened 0.5 m into the path and painted as a noisy red (grass) / green (path) ramp so they
  break up into the grass (blender/README.md "Shaping: path edge fade"; Unity reads the paint:
  `golfmap.paths.materials` and `golfmap.roughgrass.plant`).
  After every other op, one **`golfmap.cut_out` per `rock_slab` feature** (Swedish berghäll; blender/README.md
  "Shaping: cut-outs (rock slabs)"; `_rock_slab_ops`): the slab is no OPCD surface, so the SVG leaves it out
  (the report counts them: `rock slabs left out`) and its mesh `Spline_hall_<feature number in hex>_Rock_-_Mesh`
  comes from the cut. Op `id` `hall-<hex>`, `name` `hall_<hex>` (from the feature number, never its id; an
  unnumbered slab takes a hash of its id), `featureId`, `origin: rock_slab`, `outline3006` = the drawn outline
  (largest piece, outer ring) buffered outward by the feature's `marginM` (attribute, 0-5 m, default 1.5: an
  outline traced tight to the rock reads too small in game) with rounded joins, simplified within 0.15 m and
  rounded to cm; `uvM` (attribute, > 0, default 4) only when it differs from the default. Slabs go in feature-number
  order and a later one whose outline would come within 0.8 m of an earlier written outline is trimmed by that
  outline buffered 0.81 m (0.8 plus the cm rounding); when that leaves nothing, several pieces or a hole it is skipped
  with a warning. An attribute the server would refuse falls back to its default with a warning. The report counts
  `N rock slab(s) cut out ... M trimmed ... K skipped` (no line for a course without slabs, and its layer is
  byte-identical to before). Drawn in Draw mode (type picker "Rock slab"); the two Vreta slabs are still the
  hand layer `20-rocks.json`.

  The same run writes **`10-features.gen.json`** next to it (`--out-dir <folder>` puts both files
  there; `--library` names the recipe library, default `$GOLFMAP_RECIPE_LIBRARY`, else
  `blender/recipes/library.json`): layer id `features`, one `afrod.recipe` op per course feature with a
  shaping recipe, ordered by feature number: `id` `recipe-<shape name>` (the `feature_no` in hex),
  `select: {feature: <id>}`, `recipe` = the library entry's `file`, `seed` = `feature_no`, `note` =
  `<library id> (recipe edit)` or `(default for <surface>)`. Which recipe: the feature's enabled
  **recipe terrain edit** (`op: recipe`, origin `feature`, origin_ref `feature:<id>` of a feature on
  THIS course; `recipe: none` = no op at all), else for every `bunker`, `water` (surface `lake`) and
  `water_creek` (`creek`) the library's default for its surface (`default: true`, or the surfaces
  listed). Paths get a recipe only from an edit (the library's path default is not applied); bridge
  decks never. A disabled recipe edit counts as none: the feature gets the default. Unknown ids, a
  recipe not made for the surface (used anyway), edits of other courses' or deleted features, and
  surfaces without a default are reported. Without a library the layer is written with no ops (so a
  sync drops recipe ops applied before). **Overrides**: the edit's `overrides` go where the engine
  (`blender/tools/shape_layers.py` `OPS["afrod.recipe"]`) takes them: whole into an `overrides` key
  when its op spec has one, else the keys its `params` spec knows into `params`; the rest are
  reported and not written (today `afrod.recipe` takes neither, so every override is reported: a key
  the engine does not know would make it reject the whole layer). Vreta (2026-09-28): 70 ops, all
  course defaults - 35 bunkers (`cesimgolf-conway`), 22 lakes (`kaustin-lake-gradual`), 13 creeks
  (`kaustin-creek`).

### Shaping from the Terrain editor (server, builder only)

`ShapingService` (`server/services/shaping.service.ts`, API `server/api/shaping.api.ts`):

- `GET /api/shaping/recipes?surface=bunker|lake|creek|path` — the recipe library's entries
  `{id, name, file, author, surfaces, default?, notes?, params}` for that surface (`default` = the course
  default for it); `[]` while there is no library file. `params` = the entry's declared knobs
  `{id, label, unit?, min, max, step?, default}` (blender/SHAPING-PLAN.md, "Composite and
  parameterised recipes"; the engine's `maps` are not served; malformed ones dropped), `[]` without any.
- A feature's recipe is a terrain edit through the ordinary terrain-edits API: `create {siteId, op:
  'recipe', featureId, params: {recipe, overrides?}}` (no rings), `update` (params / enabled),
  `remove`; history as for every edit. One per feature (a second create is a 409 naming the first); `overrides` takes only the recipe's param ids, each a number within its min..max, plus `seed` (an integer; `none` and a recipe without params take only the seed; with no library file values need only be numbers). A refused recipe edit (unknown recipe, wrong surface, feature not on the site, bad overrides) is a 400 (`InvalidRecipeEditError`; other terrain-edit errors are unchanged).
- `POST /api/courses/:courseId/shaping/apply {dryRun?, skipUnity?}` → a job (in memory, one at a time
  on the machine: one worker; 409 while one runs): (a) `gspro.py shaping-global --course <id>
  --out-dir docs/gspro/<course slug>/shaping --library <library> [--db $DB_PATH]`; (b) the shaping
  worker on `GOLFMAP_SHAPING_URL` (default `http://127.0.0.1:8766`) — started when nothing answers
  there (`<blender> -b --python blender/tools/shape_worker.py -- --port <p> --blend <blend> --layers
  <dir> --fbx-folder <fbx>`, output in `<data>/shaping-worker.log` + `.err`; it outlives a server
  restart), `POST /load {blend, layersDir, fbxFolder}` when it holds another .blend or layer folder
  (or is in error), then `POST /sync {dryRun?}`; (c) `golfmap.course.refresh only=<changedObjects + removed FBX names without .fbx>` (meshes.sync prunes a named object whose FBX is gone)
  (+ `dryRun`) in the Unity editor whose active course exports to the course's folder, skipped when
  nothing changed or no editor is open (a warning, not a failure; a bridge that rejects `only` gets
  the whole refresh); (d) result `{changedObjects, exported, removed, warnings, places, seams,
  unityReport, unityError, layers, blend, layersDir, fbxFolder, dryRun, seconds}`.
- `GET /api/courses/:courseId/shaping/status` → `{worker: {url, reachable, state, blend, conformed,
  layersDir, appliedOps, lastRun, error, spawnedPid}, job}`; `GET /api/shaping/job?jobId=`.
- Paths (env): `GOLFMAP_SHAPING_BLEND` (absolute or a name in the export folder; default the newest
  `*.conformed.blend` there, else the newest source `.blend` — a source newer than the cache is a
  warning), `GOLFMAP_SHAPING_FBX_FOLDER` (default `<Unity project>/Assets/fbx` of the course's open
  editor; a worker that must load with neither is a 409), `GOLFMAP_SHAPING_LAYERS_ROOT` (replaces
  `docs/gspro`), `GOLFMAP_BLENDER` (default Blender 4.5's install path, else `blender`),
  `GOLFMAP_RECIPE_LIBRARY`.
- Recipe edits are not DEM edits: `TerrainEditsService.listDemEdits` (every DEM replay: map build,
  inner staleness check, outer DEM) leaves them out.

### The GSPro status board: `GsproSyncService` (server, builder only)

`GsproSyncService` (`server/services/gspro-sync.service.ts`, API `server/api/gspro-sync.api.ts`,
CLI `bun run gspro:status` / `bun run gspro:update`). The export panel grew one button per file, and
knowing which to press, in what order, after an edit was the operator's job (heightmap before the
trees, SVG before Blender, zones before the Arborist file). The board turns that round: one row per
**target** — the thing you changed in the editor — with *last updated / what changed since /
Update*.

**Targets** are `shared/gspro-targets.ts` (shared so the web uses the same ids and words):
`terrain`, `photo`, `shapes`, `meshes`, `vegetation`, `trees`, `buildings`, `creeks`, `course-file`,
each with `label`, a one-line `description`, `manual` (the step a human must still do: `shapes` →
"Build the SVG in Blender (OPCD), then Update meshes"; `buildings` → the Unity planter menu; the
rest null) and `featureTypes` (the `course_features.type`s whose edits make it stale).
`SVG_FEATURE_TYPES` lives there too — the pipeline's `TYPE_SURFACE` plus `trees` — and
`web/src/export/svg-exclusions.ts` re-exports it.

**One verb: Update.** `update(courseId, target | 'stale')` runs the whole chain for a target: both
terrains, the files on the way, and the push into the open Unity editor that has the course active.
No matching editor is a **skipped** phase (`Not in Unity: …`), never a failure — the files are
written either way. `'stale'` runs every target with `stale` true and `blocked` null, in board
order. The chains:

| Target | Phases |
|---|---|
| `terrain` | `apply` (the re-terrain bake, `MapBuildService.reTerrain`, only when `innerDemStale` says the exported heightmap lacks an edit) → `dem` (`exportDem` inner + outer) → `unity` (`pushUnityTerrain` inner + outer — the DEM is not rendered twice) → `dependents` (re-export the trees/buildings/zones/creeks/GKD files **already in the folder**; a course that never exported buildings does not get them now). Terrain › Export To OBJ for Blender and the terrain conform stay manual, and the report says so. |
| `photo` | `inner` (`exportOrtho` of the newest `.cleaned.tif`, else the newest plain, with the panel's defaults: the surface tint, the forest floor, the roofs filled) → `unity` (`pushUnityOrtho` of that `-meshes.jpg`) → `outer` (`exportOuterOrtho` of the newest collection; the file is written and reported — there is no Unity push for the outer terrain). |
| `shapes` | `svg` (the full SVG, kept as an export snapshot), then Blender by hand. |
| `meshes` | `ShapingService.apply(courseId, {})` — layers → worker → Unity refresh → the grass round a changed rock slab — with its job's five phases mirrored into this one's while it runs. |
| `vegetation` | `plantVegetation` inner, and outer when the outer already has a zones export. |
| `trees` | `files` (`exportTrees` inner + outer) → `unity` (`golfmap.trees.plant` per terrain). |
| `buildings` | `files` (`exportBuildings` inner + outer) → `unity` **skipped**: no `[BridgeCommand]` plants buildings, so the report names `GolfMap › Buildings › Plant from assignments`. |
| `creeks` | `file` (`exportCreeks`) → `unity` (`golfmap.creeks.import`). |
| `course-file` | `gkd` (`exportGkd`). |

**Jobs queue per course** (FIFO) instead of 409ing: a second Update while one runs comes back
`status: 'queued'` and shows in `status().queue`; its first phase is `wait` ("Waiting for …"). A sync
job also waits for a running legacy `GsproExportService` job or `ShapingService` apply of the course
(`whenIdle` on both) — they touch the same files and the one machine-wide Blender worker. Phases are
the same bookkeeping as `ShapingJob`, extracted into `server/services/job-phases.ts` (`JobPhases`:
`add`/`begin`/`note`/`end`/`skip`/`skipPending`/`failCurrent`/`snapshot`/`step`), which
`ShapingService` now uses too.

**Staleness.** `stale = changedSince.count > 0 || lastRun === null`.

- **`lastRun`** comes from `<export dir>/gspro-sync.json` (`golfmap-gspro-sync-v1`:
  `{targets: {[id]: {lastRun, seconds, report?}}}`), written per target after each successful update
  with the **job's start time**, so an edit made while it ran counts as "since"; `seconds` lets the
  board say "about 40 s" next time. With no entry it falls back to the mtime of what that target
  writes, so a course exported before the board existed does not read "never": the inner DEM sidecar
  (`terrain`), the newest inner `-meshes.jpg` (`photo`), the newest `export-history/` snapshot
  (`FeatureHistoryService.latestSnapshot`, `shapes`), `<layers dir>/00-global.gen.json` (`meshes`),
  the inner zones / trees / buildings / creeks file, and the `.GKD` in the course's GSPro folder.
- **`changedSince`** = `{count, kinds}` since `lastRun` (empty when it is null — there is nothing to
  count from). `FeatureHistoryService.countChangesSince(courseId, since, types?)` and
  `TerrainEditsService.countChangesSince(siteId, since, {ops?, exceptOps?, origins?})` each take two
  sources, deduplicated by id: a row whose `updated_at` moved (created, edited, restacked, toggled —
  and the only way to see a fresh *generated* terrain edit, whose `created_at` is pinned at the epoch
  to fix its replay slot) and the migration-025 history (the only trace a DELETED row leaves).
  **`generated = 1` features are not counted** in either source: they are pipeline output the next
  run replaces wholesale — the planting rewrites its own vegetation zones — so counting them would
  leave rows permanently stale. Per target, on top of the feature types: `terrain` = terrain edits
  except `recipe`, plus `unapplied edits` when `GsproExportService.innerDemStale` says so; `meshes` =
  `recipe` edits; `buildings` = `building-pads` edits; `vegetation` = `course_zone_types.updated_at`;
  `photo` = the cleaned photo's mtime; `course-file` = holes/tees/greens/pins/aim points/tee sets
  (`courses.gspro_meta_json` has no time of its own, so a details-only edit does not show).
- **`blocked`** is why an update cannot run now (and so is left out of a `'stale'` run): "Build the
  map first", "Set the GSPro course folder first", `No .blend in <folder> …`, `Run "Generate building
  pads" …`, or the map-area 409's own words. Only the cheap, certain reasons — the chains still throw
  their own 409s for the rest.

**API** (builder only, `requireAuth()`): `GET /api/gspro-sync/status?courseId` →
`{unity: {editors, matched, exportDir}, worker, targets, job, queue}`,
`POST /api/gspro-sync/update {courseId, target}` → the job, `GET /api/gspro-sync/job?jobId`,
`GET /api/unity/editors?courseId` → the `unity` part alone (the command bar's chip).
`unityEditorsFor` (`services/unity-bridge.ts`) probes EVERY open editor —
`{projectName, projectPath, activeCourse, exportFolder, matches, error}` — and `editorForExportDir`
is the same probe stopping at the first match (30 s cap per editor either way).

**Exports do their own prerequisites** (the same change): `exportTrees`, `exportZones`,
`exportBuildings`, `exportCreeks` and `exportGkd` export the heightmap whose sidecar they read
(`ensureDemSidecar`; the inner one for creeks and the GKD) instead of 409ing "Export the … heightmap
first"; `exportDem('outer')` exports the inner first, for the outer terrain's Unity position, instead
of leaving a note asking for it; and `updateZones` runs the whole `plantVegetation` (inner, plus
outer when it has a zones export) when there is no zones export to patch at all, or when every
terrain's item bindings moved — with a report line saying why the fast path was not taken. The 409s
that remain are the ones the server cannot do anything about: no DEM at all, no map area, no building
survey, no tree stems, no GSPro course folder.
