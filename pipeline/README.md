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

### `trees-stems`

Extract individual crown estimates from local COPC lidar without downloading data.
This command uses an EPSG:3006 metre bbox, or the extent of `--dem`.

```sh
python -m golfpipe trees-stems \
    --lidar /path/to/tile.copc.laz \
    --bbox 540677,6467116,543845,6470284 \
    --course-id COURSE_ID --tiles-dir ../data/tiles/SITE_ID \
    --out /path/to/session-scratch/tree-stems.geojson \
    --workdir /path/to/session-scratch/stems
```

Repeat `--lidar` for multiple tiles. `--workdir` is optional and stores the
roof-suppressed nDSM, ground raster, roof mask and the surface / multi-return
count rasters for inspection. `--leaf-off-ortho DIR` names the XYZ webp pyramid the
crown kind is read from (default: the newest Oct-Apr vintage in the tiles-dir
manifest, `ortho/<collection>` or `ortho` when it is the active one);
`--no-kind` skips the classifier. Existing ortho and terrain tiles are never
written by this command; the leaf-off pyramid is only read.

The detector uses the roof-suppressed nDSM before the canopy layer's 7x7 spread.
That raster has no height floor (the 1 m floor belongs to `clean_canopy`, which
this command does not use), so the thresholds below are free choices.
A 0.8 m Gaussian smooths sampling noise. Peak windows grow with height, then
marker-controlled watershed assigns crown area. Support is two-tier: cells
join the candidate mask at `--min-height` (default 1.0 m) in components of at
least `--min-area` (default 4 m²); a segmented crown whose top is at or above
`--tall-height` (default 3 m) needs `--tall-min-area` (default 2 m²) of
support, and when that support is under 12 m² it must also lie more than
3 m from any cell the roof suppressor zeroed (the roof guard). Radius is
the equal-area circle, capped at 35% of height but never below 1.5 m (bushes are wider than they are tall), and at 10 m.
Heights are clamped to 40 m. Positions estimate visible crown tops;
they are not surveyed trunk locations.

#### Crown kind

Each stem carries `kind`: 0 broadleaf, 1 conifer, 2 unknown. The feature is
crown colour in a leaf-off ortho: the mean of (G - R) / (R + G + B) over the
upper crown (segment cells at or above half the segment's top height), sampled
from the z18 tiles of the newest ortho vintage flown in Oct-Apr (Landeryd and
Linkan: `orto-l2-2023`, 2023-04-21/22). A crown that is green in April is a
conifer; a bare grey one is broadleaf. Greenness maps linearly onto a conifer
score, 0 at 0.02 and 1 at 0.12; the threshold is 0.5 (greenness 0.07). A stem
is unknown when its top is under 4 m (drawn as a shrub anyway), when the
leaf-off pyramid covers less than half of its upper-crown cells, or when the
score is within 0.05 of the threshold (greenness 0.065-0.075).

Lidar-only features were tried first and dropped. On 40 Landeryd stems >= 8 m
(seed 20260908) labelled by eye from the 2023 leaf-off ortho (20 broadleaf,
20 conifer), crown radius / height, apex sharpness (mean smoothed height within
1 m of the top / top), the fraction of the segment above 70% of the top, the
mean of the three, the multi-return fraction and the return density had AUC
0.31-0.65; the lidar is leaf-off (gps_time March-April 2021) at about 2.6
surface returns/m², so bare broadleaf crowns and spruce look alike on a 1 m
nDSM. Leaf-off greenness had AUC 0.985 on the same stems. The threshold was
picked on that Landeryd sample (every greenness in 0.064-0.074 gives 39/40):

| Landeryd, 40 stems | pred. broadleaf | pred. conifer | unknown |
|---|---|---|---|
| labelled broadleaf | 20 | 0 | 0 |
| labelled conifer | 1 | 19 | 0 |

Linkan was not used for tuning; 20 stems >= 8 m (seed 20260908, 14 broadleaf,
6 conifer) give 16/19 on decided stems, one unknown:

| Linkan, 20 stems | pred. broadleaf | pred. conifer | unknown |
|---|---|---|---|
| labelled broadleaf | 13 | 1 | 0 |
| labelled conifer | 2 | 3 | 1 |

The Linkan misses: labelled conifers at greenness 0.059 and 0.004 (the second
a low-confidence label), a labelled broadleaf at 0.105, and the unknown is a
conifer at exactly 0.070.
Counts after regeneration: Landeryd 44,638 stems, 15,442 broadleaf, 7,981
conifer, 21,215 unknown (6,583 under 4 m, 13,228 tall stems outside the 2023
pyramid, which covers the course area only, 1,374 inside the band); Linkan
5,886 stems, 3,499 broadleaf, 1,597 conifer, 790 unknown (481 under 4 m, 299
inside the band). Positions, heights, radii and ground values are identical
to the previous asset.

Limits: the classifier needs a leaf-off vintage in the tiles-dir manifest and
labels nothing outside its tiles; merged crowns (a spruce under a birch canopy,
or two touching crowns segmented as one) get one kind for the whole segment;
larch, dead spruce and evergreen broadleaf are misread; the sample sizes above
are small, so the accuracy is indicative. Species beyond conifer / broadleaf is
not inferred.

The defaults come from Landeryd measurements. An isolated 7 m² bush on
Masters hole 5 (EPSG:3006 542275, 6469434) tops out at 1.96 m and was missed
by the earlier single-tier 2 m / 12 m² rule. On the Landeryd grid, components
of the >= 1 m nDSM with a top in [1, 2) m number 1,867 with a median area of
5 m²; 90% are under 12 m². Eight random orthophoto checks of those showed
bushes, young plantation and understory in six, silage bales and a residential
yard in the other two. Roof-edge fragments that survive multi-return
suppression are tall, and a 12 m² requirement for crowns from 3 m up removed
them, but it also removed thin birches: with few coarse branches they give 1
to 2 returns per m² at this density, and five of them in the east corner of
Masters hole 5 (8.9 to 13.3 m tall, return-height spread 4.7 to 8.2 m) occupy
4, 6, 6, 8 and 11 cells. Distance to a roof separates the two. At 4 m² the
300 m clubhouse window gains 69 tall stems, 52 of them within 3 m of a
roof-suppressed cell; the kept 17 are planted trees along the parking rows
and the range fence. The 200 m hole 5 window gains 31, 6 near roofs, and all
five birches survive. A forest holdout window gains 32, 16 near roofs (the
suppressor also fires inside dense stands, where neighbouring stems already
cover the spot). Young 2 to 3 m birches stay under the low-crown rule: at
1 to 3 returns they look like a parked car, and a 2 m² floor added 84
detections in the clubhouse window, mostly on cars.
Lowering the mask floor also widens existing crowns: on Landeryd 36,892 of
the earlier 36,894 stems 4 m and taller keep their position, 8,269 of them
gain crown radius (mean +0.22 m, still under the 35% cap), and 1,161 tall
crowns whose support fell short of 12 m² at a 2 m floor now qualify. The
apps split rendering by height: stems under 4 m draw as shrubs, taller ones
as trees.

The compact `tree-stems.json` asset has version 2, CRS `EPSG:3006`, fields
`["x","y","heightM","crownRadiusM","groundM","kind"]`, and a `trees` array of
numeric rows; `kind` is the integer above. Readers in shared, web and iOS also
accept version 1 (five fields, kind read as unknown). The manifest descriptor
format stays `tree-stems-v1`.
Ground elevations use the class-2 ground raster in RH2000 metres. Coordinates
and ground elevations retain two decimals; crown height and radius retain one.
The companion GeoJSON contains points with named properties and CC0 attribution.
The command merges `assets["tree-stems"]` into `manifest.json`, preserving tile
layers and other metadata while advancing `generatedAt`.

Roof-edge returns can survive multi-return suppression. The roof guard keeps
small tall crowns 3 m away from suppressed cells but cannot identify a roof
the suppressor missed. Dense crowns and understory can split or merge, and
leaf-off imagery cannot verify hidden stems.

#### Regenerating a course

`bun run trees:regen -- <courseId|siteId>` from the repo root runs `canopy` (tiles and
`trees.geojson`) and `trees-stems` against `data/sources/<siteId>` and
re-registers the manifest. The Create-mode actions menu has the same job as
"Regenerate trees".

### Area arguments for other commands

Fetch and tile commands accept **either** `--bbox` **or** `--aoi`
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

### `clean-ortho` — inpaint canopy + shadows out of the playable corridor

```sh
python -m golfpipe clean-ortho \
    --ortho data/sources/<mapKey>/ortho-orto-l2-2025.tif \
    --trees trees.geojson \            # trees-features (preferred) or detect-trees output, or an exported features file
    --features features.geojson \      # typed course features (EPSG:3006 contract or WGS84 export)
    --shadow-azimuth 15 --shadow-length 18
```

Batch orthophoto cleaning for game-engine (Unity/GSPro) texture export:
replaces tree crowns and the shadows they cast — plus anything in an
optional `--manual-mask` GeoJSON (players, carts, blemishes) — with
LaMa-inpainted grass, but **only inside the playable corridor** (union of
`--corridor-types`, default `fairway,semi_rough,rough,tee,green`). Real
forest outside the corridor stays as flown. The mask is
`((canopy ∪ shadow) ∩ corridor) ∪ manual`, dilated `--margin` (default
0.5 m); the shadow band is the canopy offset toward `--shadow-azimuth`
(compass degrees the shadow falls toward — measure a tree in the source
image) in sub-offsets up to `--shadow-length` metres, so the whole penumbra
is covered. Output is written **alongside** the source as
`<stem>.clean.tif` (never overwrites; same CRS/transform/compression, so
`tile-ortho` can be pointed straight at it). `--mask-out mask.tif` writes
the rasterized mask for eyeballing before a long run.

Heavy deps are opt-in — the base env has no torch:

```sh
./.venv/bin/pip install -r requirements-inpaint.txt
curl -LO https://github.com/Sanster/models/releases/download/add_big_lama/big-lama.pt
export GOLFPIPE_LAMA_WEIGHTS=$PWD/big-lama.pt     # or pass --weights
```

The weights are the TorchScript export of the official big-lama checkpoint
(Suvorov et al., WACV 2022; original training checkpoint at
`https://huggingface.co/smartywu/big-lama` — the TorchScript export above is
the same artifact lama-cleaner/IOPaint run). Inpainting processes the mask
as overlapping crops (`--crop` 512, `--overlap` 64) with a feathered stitch,
so memory stays bounded for arbitrary-size orthos. Device: cuda if
available, else CPU (fine for batch use; `--device mps` tries the Apple GPU,
which needs torch's MPS FFT support, torch ≥ 2.1). The reusable seam lives
in `golfpipe/inpaint.py` (`inpaint_tiled(image, mask, inpaint_fn)`), kept
CLI-free so interactive editor cleaning can consume it directly.

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

### `canopy` — lidar → canopy / canopy-color / surface tile pyramids

```sh
python -m golfpipe canopy --lidar work/lidar/m21c011-646_54.copc.laz \
    --dem data/dem/<courseId>.tif --course-id <courseId> \
    --tiles-dir data/tiles/<courseId> --workdir work/canopy \
    [--bbox w,s,e,n | --aoi area.geojson] [--minzoom 12 --maxzoom 17] \
    [--trees-out trees.geojson] [--min-hole-area 50]
```

Builds a 1 m canopy height grid from classified COPC lidar (the
detect-trees nDSM: mean-z ground of classes 2/9 vs max-z of every non-noise
return) and tiles three layers under `--tiles-dir`, zoom range as
`tile-terrain` (default 12-17 here via flags; 12-16 without):

- `canopy/{z}/{x}/{y}.png` — Terrain-RGB, value = height above ground in
  metres, 0 where no canopy.
- `canopy-color/{z}/{x}/{y}.png` — RGBA display ramp: transparent under
  1 m, then 1 m yellow (255,255,0) → 8 m orange (255,140,0) → 15 m red
  (230,30,30) → 25 m magenta (200,0,200) → 35 m+ blue-violet (80,40,255).
- `surface/{z}/{x}/{y}.png` — Terrain-RGB DSM: `--dem` ground (resampled
  to the 1 m grid; lidar ground where the DEM has no data) + canopy height,
  shaped per `--surface-shape` (below).

Processing (`golfpipe/canopy.py`): Lantmäteriet has no building class, so
roofs are removed by return count — cells >= 2 m where under 10 % of the
points have `number_of_returns > 1` are zeroed (a roof returns once, a
crown splits the pulse). Then clamp to [0, 40] m, drop < 1 m, 3x3
8-connected binary closing (filled cells take their 3x3 max) and a 7x7
maximum filter so each cell holds its crown top. `canopy.tif`, `roof.tif`
(1 where a cell was zeroed as roof) and `surface.tif` (float32, EPSG:3006)
are left in `--workdir`; `canopy.tif`
holds the cleaned canopy height in metres above ground with nodata 0 and is
the input `trees-features` reads. The area is `--bbox`/`--aoi` if given,
else the `--dem` extent.

`--trees-out trees.geojson` also writes the `trees-features` GeoJSON
(default thresholds, `source_ref` = the lidar basenames) from the same
cleaned grid, so one run yields tiles and polygons that agree.
`--min-hole-area` (default 50 m²) is passed through to it.

`--surface-shape {crown,flat}` (default `crown`) controls only the
`surface` layer; `canopy` and `canopy-color` are identical either way.
`flat` adds the cleaned canopy as is, which renders as flat-topped mesas
with 1 m vertical walls when draped in 3D. `crown`
(`golfpipe.canopy.crown_shape`) rounds each footprint before adding it to
the ground: distance-to-edge taper `sqrt(d / r)` with `r = 4 m` (or the
crown's own half-width when smaller, so a lone spike keeps its top; edge
cells of a broad crown drop to about 35 %), a dip of up to 25 % between the
raw nDSM's local maxima so plateaus are not flat, then a footprint-
normalised Gaussian blur (sigma 1 m). The result is re-masked to the
footprint (no bleed onto fairways) and capped at 1.02x the cleaned canopy.

`manifest.json` in `--tiles-dir` is backed up to `manifest.json.bak`
(`.bak2`, `.bak3`, ... if that name is taken; backups are never overwritten)
and rewritten with `canopy`, `canopy-color` and `surface` layer entries
added; every other field (including server-written
`orthoVintages`/`activeOrtho`) is kept and `generatedAt` is set to now (iOS
keys its tile cache on it).

### `trees-features` — tree polygons from the cleaned canopy grid

```sh
python -m golfpipe trees-features --canopy-tif work/canopy/canopy.tif \
    --course-id <courseId> --out trees.geojson \
    [--roof-tif work/canopy/roof.tif] \
    [--min-height 2.0] [--min-area 4] [--min-hole-area 50] [--close 1.0] [--round 1.5] [--simplify 0.3] \
    [--source-ref m21c011-646_54.copc.laz] [--bbox e_min,n_min,e_max,n_max]
# or grid the canopy in-process, exactly as `canopy` does:
python -m golfpipe trees-features --lidar a.copc.laz --lidar b.copc.laz \
    --dem data/dem/<courseId>.tif --course-id <courseId> --out trees.geojson
```

Derives one Polygon per connected canopy patch from the cleaned canopy grid
the `canopy` command tiles (`canopy.tif` in its `--workdir`, or the same
gridding + roof suppression + `clean_canopy` run on `--lidar`, area from
`--bbox`, EPSG:3006 metres, else the `--dem` extent). Because the input is
the grid behind the `canopy` / `canopy-color` layers, polygons and layers
agree. Prefer it over `detect-trees` (raw nDSM closing + opening, no roof
suppression) whenever canopy tiles exist for the course.

Polygons under 12 m² (thin birches are 4 to 11 cells at 1.4 points/m²) need
the roof mask: `--lidar` builds it, `--canopy-tif` needs `--roof-tif` from
the same canopy workdir. With the mask, a polygon under 12 m² is kept when no
roof-suppressed cell lies within 3 m of it; without the mask the minimum
area is 12 m² and the command says so. The numbers behind the rule are in
the `trees-stems` section.

Steps (`golfpipe/trees_features.py`): cells with canopy >= `--min-height`
form the mask; binary closing with a disk of radius `--close` (1.0 m at 1 m
cells = the 3x3 cross; bridges 1-cell gaps; `0` disables), then 8-connected
components under `--min-area` are dropped. There is no opening, so every
cell of a component that is large enough stays in a polygon (a 2 m wide
hedge or a 3x3 crown survives). 8-connected polygonize with interior
clearings as holes; interior rings under `--min-hole-area` (default 50 m²;
`0` keeps every hole) are filled, larger clearings stay holes. Outline
rounding with `--round` = r (default 1.5 m; `0` keeps the cell staircase):
a vector closing of all polygons together (dilate r, union, erode r, round
joins) fills notches and slits narrower than 2r and merges neighbours
closer than 2r; a vector opening per part (erode r, dilate r) rounds convex
corners; parts the opening removed come back when they are >= `--min-area`
and >= 1 m wide, so thin hedges keep their footprint; then two Chaikin
corner-cutting iterations per ring, topology-preserving simplify by
`--simplify` (default 0.3 m; bounds the vertex count), `make_valid`, and a
union so output polygons never overlap. Polygons under `--min-area` are
dropped. Height stats come from the canopy cells inside each final polygon
(>= min height; the polygon is rasterized once against the grid), so filled
holes, whose cells are below min height, do not enter `heightMaxM` /
`heightP90M` / `heightMeanM`. `areaM2` is the polygon area and does include
filled holes. On Landeryd (3.1 x 3.1 km, 2.68 M canopy cells >= 2 m) the
defaults put 98.4 % of those cells inside a polygon (99.3 % with `--round
0`; what is left are corner shavings and stubs under 12 m²). The earlier
open-close smoothing with a 3x3 disk covered 93.9 % and removed 7,200
components outright, 7,100 of them isolated crowns under 25 m².

Output: a GeoJSON FeatureCollection in EPSG:3006 with the legacy `crs`
member (`urn:ogc:def:crs:EPSG::3006`, same as `detect-trees` /
`fetch-water`), top-level `attribution` and `courseId`, and per feature
exactly these properties:

| property      | value                                                       |
|---------------|-------------------------------------------------------------|
| `type`        | `"trees"`                                                   |
| `source`      | `"lidar-canopy"`                                            |
| `source_ref`  | `--source-ref`, default the canopy tif basename or the comma-joined lidar basenames |
| `license`     | `"CC0-1.0"`                                                 |
| `heightMaxM`  | max canopy height inside the polygon, metres, 1 decimal     |
| `heightP90M`  | 90th percentile, 1 decimal                                  |
| `heightMeanM` | mean, 1 decimal                                             |
| `areaM2`      | polygon area in m² (filled holes included), integer         |

The server imports this body as is:
`PUT /api/courses/:courseId/features/generated?source=lidar-canopy`
(endpoint built separately from this pipeline).

### `manifest` — write manifest.json

```sh
python -m golfpipe manifest --course my-course --tiles-dir tiles \
    --dem work/dem.tif
```

Scans `{tiles-dir}/ortho`, `terrain`, `hillshade`, `canopy`, `canopy-color`
and `surface` for their actual min/max zoom directories, samples elevation
min/max from `--dem`, and writes (merging over an existing manifest.json the
same way `canopy` does: backup to `.bak`/`.bak2`/..., unknown fields kept,
`generatedAt` bumped):

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

## Source recipe (sources.json)

Every `fetch-lidar`, `fetch-ortho` and `fetch-dem` run records what it downloaded into
`sources/<siteId>/sources.json`: STAC collection, item ids, output files, WGS84 bbox and
crop buffer. Ortho vintages are keyed by collection so several coexist. The recipe lets
another machine fetch the same bytes instead of the newest coverage:

```sh
python -m golfpipe fetch-lidar --bbox W,S,E,N --out-dir data/sources/<siteId>/lidar --items m21c011-647_53
python -m golfpipe fetch-ortho --bbox W,S,E,N --collection orto-l2-2023 --items <id,id> --workdir work/ortho-src --out data/sources/<siteId>/ortho-orto-l2-2023.tif
```

Pinning matters for replay steps: terrain edits replay onto the gridded DEM (same lidar
tiles and grid parameters give the same raster) and ortho patches are baked onto one
vintage. See docs/feature-site-transfer.md.
