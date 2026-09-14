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

`__main__.py` + `commands.py` (CLI) · `stac.py` (Lantmäteriet STAC search/download, needs `LANTMATERIET_USER`/`PASS`) · `raster.py`, `grid_dem.py` (LAS/LAZ lidar → DEM via laspy; `DEFAULT_CLASSES` 2, 9, 17 = ground, water, bridge deck — OPCD's CloudCompare filter, so a bridge is not a trench) · `terrain_rgb.py` (16-bit terrain PNG) · `canopy.py` (lidar nDSM → canopy height / colour ramp / DSM for the `canopy` command) · `trees_features.py` (cleaned canopy grid → tree polygons + height stats for `trees-features` / `canopy --trees-out`) · `tiling.py` (reproject → Web Mercator, XYZ pyramid) · `aoi.py`/`bbox_course.py` (area: `--bbox west,south,east,north` WGS84 **or** `--aoi file.geojson`) · `manifest.py`.

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
  which the terrain shader would otherwise wash out.
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
