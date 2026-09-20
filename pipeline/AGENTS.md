# pipeline — AGENTS

`golfpipe` — Python CLI turning Lantmäteriet elevation (DEM) + orthophoto GeoTIFFs into the XYZ tile pyramids the server serves (`data/tiles/{courseId}/{layer}/{z}/{x}/{y}.<ext>`).

Pure Python, self-contained venv. **No system GDAL** — rasterio wheels bundle their own. Don't add `gdal`/`pygdal` to requirements.

## Setup

```sh
cd pipeline
./setup.sh              # idempotent: creates/reuses .venv, installs requirements.txt
source .venv/bin/activate
python -m golfpipe --help
pytest                  # tests — synthetic in-memory GeoTIFF fixtures, no mocks; see root TESTING.md
```

## Layout (`golfpipe/`)

`__main__.py` + `commands.py` (CLI) · `stac.py` (Lantmäteriet STAC search/download, needs `LANTMATERIET_USER`/`PASS`) · `raster.py`, `grid_dem.py` (LAS/LAZ lidar → DEM via laspy; `DEFAULT_CLASSES` 2, 9, 17 = ground, water, bridge deck — OPCD's CloudCompare filter, so a bridge is not a trench) · `terrain_rgb.py` (16-bit terrain PNG) · `canopy.py` (lidar nDSM → canopy height / colour ramp / DSM for the `canopy` command) · `trees_features.py` (cleaned canopy grid → tree polygons + height stats for `trees-features` / `canopy --trees-out`) · `lowveg_features.py` (the same grid's 0.5..3 m cells minus trees and a `--tree-buffer` → `vegetation_zone` shrub proposals, source `lidar-lowveg`, for `lowveg-features`; D-VZ7 in `docs/feature-vegetation-zones.md`) · `tiling.py` (reproject → Web Mercator, XYZ pyramid) · `aoi.py`/`bbox_course.py` (area: `--bbox west,south,east,north` WGS84 **or** `--aoi file.geojson`) · `osm.py` (Overpass golf/land-cover polygons, `fetch-osm`) · `roads.py` (Overpass highway centerlines → buffered, per-class-unioned road corridor polygons, `fetch-roads`; width from the `width` tag, else `lanes`, else `CLASS_WIDTH_M`; `--centerlines-out` keeps the clipped centerlines + widths, which `road-grades` turns into one `corridor` terrain edit per road — smooth along, flat across — as the D-TE5 edits handoff) · `buildings.py` (Overpass building footprints + minimum rotated rectangle + lidar nDSM eave/ridge heights → the building survey, `fetch-buildings`; the survey → one flat `plane` terrain edit per footprint as the D-TE5 edits handoff, `building-pads` — a building is not an app feature type, it is a pad on the terrain plus a prefab the Unity planter places) · `manifest.py`.

## `gspro.py` — GSPro/OPCD assets (not part of the tile pipeline)

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
  selections, a dark-green layer at ~30 %), computed from the app's own features instead
  (`--tint-course <id|name>` out of `--db`, same loader as `svg`). `TINT_TYPES` (fairway, green, tee,
  semi/rough, deep_rough) get `--tint-color` (`DEFAULT_TINT_COLOR` #1e5a2c) at `--tint-opacity`
  (`DEFAULT_TINT_OPACITY` 0.3); `TINT_MASK_TYPES` (bunker, path) are painted at opacity 0 in
  the SVG's `opcd` stacking order so they cut the tint out of what is under them; `TINT_WATER_TYPES`
  (water, water_creek) are a second layer composited over the grass result — `--water-color`
  (`DEFAULT_WATER_COLOR` #4a3d22, a dark brown) at `--water-opacity` (0.4) on the darkened photo, its
  coverage box-blurred by `--water-feather` metres (`DEFAULT_WATER_FEATHER_M` 4, converted to px at
  render time, symmetric about the drawn edge) so the shoreline runs from the water tint into the
  green (or the untouched photo) instead of cutting it; undrawn ground is
  untouched; `--tint TYPE=#rrggbb[@a]|@a|none` overrides per type. Masks are rasterised from the same
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
  `zoneType`/`weight`/`feather`/`noise`) rasterized into VSPro texture masks for one terrain square, the
  `docs/feature-vegetation-zones.md` §6 rasterizer: one RGBA PNG per four zone types next to `--out`
  (`<stem>-<texture>.png`, `--resolution` default 4096, channel from the course's `course_zone_types`
  table, which must exist), plus the `unity-zones-v1` JSON (§7) with `plot` from `--sidecar` as `trees`,
  `masks[]`, `zoneTypes[]` with item bindings, and `zones[]` as plot-local polygons simplified to
  `--simplify` 1 m for the Scene-view overlay. Per zone: even-odd fill in the tint's pixel frame, signed
  distance from two `distance_transform_edt`s, value noise (`--seed`) on the distance,
  `clamp(0.5 - d/feather, 0, 1) × weight`; overlaps are a per-pixel budget of 1 processed from the last
  zone to the first (`render_zone_masks`): a later zone claims first, same-type zones take the maximum,
  nothing is scaled up. Zones are processed in bounding-box crops; the accumulators are one float32
  frame per zone type plus the budget (64 MB each at 4096). `--exclude-square` as for trees, zeroed in
  the masks and cut from the polygons. Unknown zone types are warned about and skipped.
- `buildings` — a building survey (`--survey buildings.geojson`, golfpipe `fetch-buildings` output) as the
  `unity-buildings-v1` file the Unity building planter reads, over the square, the same way `trees` does it:
  rectangle centre as `x`/`z` from the south-west corner, the footprint ring in the same local metres,
  `lengthM`/`widthM` and `yawDeg` (the Unity Y rotation, clockwise from above, that turns a prefab's local +x
  onto the footprint's long axis — the planter adds 90/180 for the prefab's own axis and the facade side),
  `eaveM`/`ridgeM` from the lidar, `heightM` + `heightSource` (`lidar` ridge, else the OSM `tag`, else
  `levels` × 3 m), `plot` from `--sidecar`; `--exclude-square` as for trees. Ids are the OSM element ids.
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

## Notes

- `trees-stems` performance: the crown-top search used to rescan the whole grid once per plateau (quadratic; 120 of 168 s on Vreta's 2050 m square, hours on a 5 km forest square) — it now looks inside each plateau's `find_objects` box, byte-identical output, 22 s. `--tile-m N` splits the box into ~N m tiles (+30 m margin, cell-aligned) detected in a process pool and merged (stem-identical on Vreta); it is off by default because reading the LAZ files dominates and is re-done per tile while lazrs already uses every core (9 tiles: 60 s vs 22 s). Use it only for boxes where detection itself dominates.

- Areas: `--bbox` and `--aoi` are mutually exclusive. GeoJSON parsed with stdlib `json` (no fiona/pyshp); projected-CRS coords rejected.
- DEM output stays in source CRS (SWEREF99 TM / RH2000); tiling reprojects to Web Mercator once.
- Tile layers: `ortho` → `.webp` (PIL WebP q80; use `reencode_webp` to convert legacy `.jpg` trees), `terrain`, `canopy`, `surface` (Terrain-RGB) and `canopy-color` (RGBA) → `.png` (matches server `assets.service.ts` `resolveTilePath`).
