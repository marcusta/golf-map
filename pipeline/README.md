# golfpipe — golf-map tile pipeline

Turns Lantmäteriet elevation (DEM) and orthophoto GeoTIFFs into the XYZ tile
pyramids the golf-map server serves from
`data/tiles/{courseId}/{layer}/{z}/{x}/{y}.<ext>` (`layer` is `ortho` →
`.jpg` or `terrain` → `.png`; see `server/services/assets.service.ts`
`resolveTilePath`).

Pure Python, self-contained venv, **no system GDAL required** — all raster
I/O goes through `rasterio`, whose wheels bundle their own GDAL build.

## Setup

```sh
cd pipeline
./setup.sh          # idempotent: creates/reuses pipeline/.venv, installs requirements.txt
source .venv/bin/activate
python -m golfpipe --help
```

## Commands

Every command that takes an area accepts **either** `--bbox` **or** `--aoi`
(mutually exclusive):

- `--bbox west,south,east,north` — WGS84 degrees.
- `--aoi path/to/area.geojson` — a GeoJSON file (`Feature`,
  `FeatureCollection`, or a bare geometry object), WGS84. The combined
  bounding box of every coordinate in the file is used. Parsed with stdlib
  `json` only (no fiona/pyshp — GeoJSON was chosen over shapefile
  deliberately to avoid that dependency). Coordinates that look like a
  projected CRS (e.g. SWEREF99 TM metres) instead of lon/lat are rejected
  with a clear error.

### `fetch-dem` — download + mosaic elevation data

```sh
python -m golfpipe fetch-dem --bbox 15.55,58.39,15.58,58.41 \
    --workdir work/dem-src --out work/dem.tif
# or: --aoi course-area.geojson
```

STAC-searches `dtm-cog` on `https://api.lantmateriet.se/stac-hojd/v1`
(anonymous), downloads the matching COG(s) with HTTP Basic auth, mosaics
and crops to bbox + `--buffer` metres (default 250) via a rasterio
`WarpedVRT`/`merge`. Output stays in the source CRS (SWEREF99 TM +
RH2000 height, `EPSG:5845`/`EPSG:3006` depending on the item) — tiling
reprojects to Web Mercator later, so there's no reason to reproject twice.

Requires `LANTMATERIET_USER` / `LANTMATERIET_PASS` env vars (free
Lantmäteriet account). Without them the command fails immediately with a
clear message before making any authenticated request.

### `fetch-ortho` — download + mosaic the newest orthophoto coverage

```sh
python -m golfpipe fetch-ortho --bbox 15.55,58.39,15.58,58.41 \
    --workdir work/ortho-src --out work/ortho.tif
```

Same shape as `fetch-dem`, against `https://api.lantmateriet.se/stac-bild/v1`.
See "STAC findings" below for why this searches across all collections
rather than pinning one. Source assets are 4-band RGBI; only the first 3
bands (RGB) are kept in the output.

### `tile-ortho` — orthophoto GeoTIFF → JPEG XYZ pyramid

```sh
python -m golfpipe tile-ortho --input ortho.tif --out tiles/ortho \
    --minzoom 14 --maxzoom 20
```

Works standalone on **any** georeferenced GeoTIFF (any CRS) — this is the
command the next agent tiling the home course from local `ortho.tif` will
run directly, skipping `fetch-ortho` entirely. Reprojects to EPSG:3857 via
`WarpedVRT` (bilinear resampling), cuts 256px tiles, saves JPEG
(`--jpeg-quality`, default 85) at `{out}/{z}/{x}/{y}.jpg`. Tiles that are
fully nodata (or fully zero, if the source has no nodata value set) are
skipped rather than written as blank JPEGs.

### `tile-terrain` — DEM GeoTIFF → Terrain-RGB PNG XYZ pyramid

```sh
python -m golfpipe tile-terrain --input dem.tif --out tiles/terrain \
    --minzoom 12 --maxzoom 16
```

Also standalone on any georeferenced single-band GeoTIFF. Same tiling
approach as `tile-ortho`, bilinear resampling, encoded as
**Mapbox/MapLibre Terrain-RGB**:

```
height = -10000 + (R * 65536 + G * 256 + B) * 0.1
```

**Terrain nodata decision**: a DEM can have nodata pixels for two different
reasons, handled differently:

- **Interior nodata** — holes *inside* the raster's real coverage (e.g. a
  PDAL polygon-crop step leaves a corridor or ragged edge of nodata pixels
  surrounded by valid data on all sides). Filling these with a flat 0 m
  height is wrong: it carves a canyon/cliff-wall straight through real
  terrain (this happened in practice with a Landeryd DTM whose lidar
  boundary crop left a nodata corridor through the course). By default
  (`--fill-nodata`, on unless `--no-fill-nodata` is passed), these are
  inpainted via `rasterio.fill.fillnodata` (GDAL conic-search
  interpolation from surrounding valid pixels) *before* reprojection/
  tiling, so the tiled output has continuous, plausible heights there.
- **Outside-coverage padding** — the WarpedVRT's virtual extent is grown
  to cover the full XYZ tile pyramid bounds (tile grids rarely align to a
  source raster's extent), so boundary/overlap tiles reach past where the
  DEM has real data. 0-filling that area used to be the whole story here,
  but that produced a 40-90 m sea-level cliff wall ringing the real
  terrain (observed at Landeryd, whose DEM only covers the ~2300 m course
  box). Instead, `tile-terrain` now pre-pads the DEM by `--edge-pad`
  metres (default 250) with **edge-replicated heights**
  (`golfpipe.raster.edge_pad_dem`: `numpy.pad(..., mode="edge")`, i.e. the
  outermost real row/column of the DEM is repeated outward, expanding the
  transform to match) *before* the WarpedVRT is built. Boundary/overlap
  tiles within that padded margin sample plausible (flat-continuation)
  terrain instead of a hard 0 m floor. This is a tiling-time convenience
  only: the tile pyramid's z/x/y enumeration and `manifest.json`'s bounds
  are still computed from the DEM's *original*, unpadded extent — edge
  padding never changes which tiles get written or what bounds get
  reported, only what heights the outermost tiles contain. Area beyond
  even the padded margin (more than `--edge-pad` metres past real
  coverage) is still 0-filled at encode time as a last resort; pass
  `--edge-pad 0` to restore the old 0-fill-everywhere behavior.

### `manifest` — write manifest.json

```sh
python -m golfpipe manifest --course my-course --tiles-dir tiles \
    --dem work/dem.tif
```

Scans `{tiles-dir}/ortho` and `{tiles-dir}/terrain` for their actual
min/max zoom directories, samples elevation min/max from `--dem`, and
writes:

```json
{
  "courseId": "my-course",
  "bounds": { "west": ..., "south": ..., "east": ..., "north": ... },
  "layers": { "ortho": { "minzoom": 14, "maxzoom": 20 }, "terrain": { "minzoom": 12, "maxzoom": 16 } },
  "elevation": { "min": 87.3, "max": 142.9 },
  "generatedAt": "2026-07-03T12:00:00Z",
  "attribution": "© Lantmäteriet, CC BY 4.0"
}
```

### `install` — copy into the server's data directory

```sh
python -m golfpipe install --course my-course \
    --ortho tiles/ortho --terrain tiles/terrain --manifest tiles/manifest.json \
    --data-dir ../data
```

Copies into `{data-dir}/tiles/{courseId}/{ortho,terrain}/` and
`{data-dir}/tiles/{courseId}/manifest.json`, matching what
`server/services/tiles.ts` serves. Prints one JSON line per
`/assets/register` payload (`{courseId, kind, filename}` with
`kind ∈ ortho_cog | dem_cog | tile_manifest`, matching
`server/api/assets.api.ts` `RegisterAssetInput` exactly). Pass `--api-url`
(and optionally `--cookie` with a session cookie) to actually POST them;
otherwise printing is enough to hand off to a human or another script.

### `bbox-from-course` — derive a bbox from existing course data

```sh
python -m golfpipe bbox-from-course --db ../data/app.sqlite --course <courseId> --buffer 250
# prints: west,south,east,north
```

Read-only (`sqlite3` stdlib, opened as `file:...?mode=ro`), no server
involvement. Reads `tees.lat/lon`, `greens.center_lat/lon` +
`front_lat/lon` + `back_lat/lon`, and `aim_points.lat/lon` for every hole
belonging to `--course`, and expands the resulting bbox by `--buffer`
metres (default 250) in every direction. Pipe straight into `fetch-dem`/
`fetch-ortho`:

```sh
BBOX=$(python -m golfpipe bbox-from-course --db ../data/app.sqlite --course my-course)
python -m golfpipe fetch-dem --bbox "$BBOX" --workdir work/dem-src --out work/dem.tif
```

## Tests

```sh
.venv/bin/python -m pytest -q
```

All tests build synthetic in-memory/tmpdir GeoTIFFs — no network required
— **except** `tests/test_stac_live.py`, which does one live anonymous STAC
search against the real API to confirm the verified Linköping-bbox/`647_53`
result still holds. Skip it in offline environments with:

```sh
GOLFPIPE_SKIP_NETWORK_TESTS=1 .venv/bin/python -m pytest -q
```

## STAC findings

- **Elevation**: `https://api.lantmateriet.se/stac-hojd/v1`, collection
  `dtm-cog`. Anonymous search confirmed live: bbox
  `15.55,58.39,15.58,58.41` → item `647_53`
  (`https://dl1.lantmateriet.se/hojd/data/grid/mhm/64_5/m647_53.tif`,
  `proj:code EPSG:5845` = SWEREF99 TM + RH2000 height compound CRS,
  10000×10000 px, 1 m grid).
- **Orthophoto**: `https://api.lantmateriet.se/stac-bild/v1` has **no
  single canonical "best RGB" collection** — coverage is split into ~400
  collections by municipality/region and capture year (e.g. `orto-l2-2025`,
  `orto-l2-2023`, `orto-l2-2021`, ...). Searching `/search` **without** a
  `collections` filter returns items across all of them, and the API
  already orders results newest-`datetime`-first for a given bbox (verified
  live: the same bbox above returned `orto-l2-2025` tiles before
  `orto-l2-2023` before `orto-l2-2021`). `golfpipe.stac.search_ortho`
  exploits this directly: search with no collection filter, then keep only
  the leading run of results that share the first (newest) result's
  `collection` — that's the freshest coverage for the bbox without having
  to hardcode or guess a "best" collection name. Source assets are 4-band
  RGBI (`spektraltyp: rgbi`); `fetch-ortho` keeps only the first 3 bands.
- **Auth**: both catalogs' `/search` endpoints are anonymous; asset
  downloads from `dl1.lantmateriet.se` return `401` with
  `WWW-Authenticate: Basic` and require a free Lantmäteriet account.
  `golfpipe.stac.download_asset` reads `LANTMATERIET_USER` /
  `LANTMATERIET_PASS` and raises `MissingCredentialsError` (fail-fast, no
  request attempted) if either is unset.

## Usage: tiling the home course from local source rasters

The next agent has `dem.tif` + `ortho.tif` already georeferenced (from
golf-map-2 / QGIS export) and does **not** need `fetch-dem`/`fetch-ortho`
at all — `tile-ortho` and `tile-terrain` work standalone on any
georeferenced GeoTIFF input, regardless of CRS or how it was produced:

```sh
cd pipeline
source .venv/bin/activate

python -m golfpipe tile-ortho   --input /path/to/ortho.tif --out /tmp/home-course/ortho   --minzoom 14 --maxzoom 20
python -m golfpipe tile-terrain --input /path/to/dem.tif   --out /tmp/home-course/terrain --minzoom 12 --maxzoom 16

python -m golfpipe manifest --course home-course \
    --tiles-dir /tmp/home-course --dem /path/to/dem.tif

python -m golfpipe install --course home-course \
    --ortho /tmp/home-course/ortho \
    --terrain /tmp/home-course/terrain \
    --manifest /tmp/home-course/manifest.json \
    --data-dir /Users/marcust/dev/github/golf-map/data
```

The `install` step prints the `/assets/register` payloads to POST
(`ortho_cog`, `dem_cog`, `tile_manifest`) once the server's course record
for `home-course` exists. If the course's exact bbox isn't already known,
derive it first from the DB instead of guessing:

```sh
BBOX=$(python -m golfpipe bbox-from-course \
    --db /Users/marcust/dev/github/golf-map/data/app.sqlite \
    --course <courseId> --buffer 250)
```
and pass `--bbox "$BBOX"` to whichever fetch/tile step needs an explicit
area (tile-ortho/tile-terrain infer their area from the input raster
itself, so this only matters if re-cropping the source rasters first).
