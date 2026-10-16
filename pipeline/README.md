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

`bun run trees:regen -- <courseId>` from the repo root (the app's job; `scripts/regen-trees.sh` is the bash version) runs `canopy` (tiles and
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

### `fetch-roads` — OSM (+ NVDB) road centerlines → road corridor polygons

```sh
python -m golfpipe fetch-roads --bbox 15.47,58.50,15.56,58.55 --out roads.geojson
# only roads within 200 m of the course's features (a GeoJSON of them, WGS84 or EPSG:3006):
python -m golfpipe fetch-roads --bbox 15.47,58.50,15.56,58.55 --near course-features.geojson --near-m 200 --out roads.geojson
# per-course width overrides, repeatable:
python -m golfpipe fetch-roads --aoi course-area.geojson --out roads.geojson --class-width service=4 --class-width track=3.5
```

OSM maps a road as a centerline; this turns every `highway=*` way (and
`golf=cartpath`) in the area into a road-surface polygon. Width comes from
the way's `width` tag when it parses, else `lanes` × 3.25 m, else a
per-class table (`roads.CLASS_WIDTH_M`: tertiary 6, residential 5,
service 3.5, track 3, footway 1.5 …). Each centerline is buffered by half
its width (round joins) into its own polygon — an OSM offset is nearly
always one whole way traced off other imagery, and a way that is its own
feature is fixed with a single drag in the app; junction overlaps are the
same surface twice, harmless. `--merge` unions each class group into
road-network polygons instead (no overlaps, but one feature of thousands of
vertices). Either way the corridors are clipped to the area (Overpass
returns whole ways that cross it), simplified and de-slivered.

Output is the usual EPSG:3006 typed GeoJSON draft for the web import wizard:
every feature is `type: path` (gspro's OPCD `concrete`) with
`road_class` = `road` / `track` / `path` so the wizard can bucket on that
and import the roads while dropping the footpaths. Provenance: `osm_ids` of
the ways merged into each polygon, plus the ODbL `attribution` on the
collection. Tunnels and steps are skipped; bridges are painted like any
road. `--no-clip` keeps whole ways.

**Centerline for the app.** A polygon that is one way's corridor (not
`--merge`, not an `area=yes` surface or a parking lot) also carries
`centerline`: that way's clipped, smoothed line, Douglas-Peucker'd at
`roads.CENTERLINE_SIMPLIFY_M` (0.25 m — the app draws a curve *through* the
kept points, which hugs the 1 m-sampled line much closer than the chords do),
next to its `widthM`. The wizard imports such a road as a **centerline
feature**: the line + width is the shape and the corridor is derived from it
(`shared/features/centerline.ts`), so moving a road is dragging points on one
line. The polygon stays in the file as the fallback.

**Parking lots.** `amenity=parking` areas (closed ways and multipolygon relations;
not `parking=underground` / `multi-storey` / `rooftop` / garages) come along as
`path` features with `road_class: parking`, used as mapped. `service` ways lying
inside a lot (80 % of their length) are its aisles and are absorbed — the lot
polygon already covers them — lending it their surface when it has none. The
centerlines file carries each lot as a Polygon (`road_class: parking`), and
`road-grades` fits it one tilted `plane` edit (outlier-rejected least squares, so a
lot on a slope stays evenly sloped) grown by a 2 m feather, replayed **before**
the road corridors. A corridor takes its profile from the heights as they are when
it replays, so a road ending at a lot runs into the lot's plane, and a road passing
through or along one stays one smooth line. Replayed after, a lot overwrote the
graded road inside it, and its feather left a 1.5 m step beside Vreta's gravel yard.
Across generators the replay order is fixed (`GENERATED_ORDER` in
`terrain-edits.service.ts`): building pads, pond, bunker and creek digs, then road
grades last, so nothing generated cuts a graded road. Hand-drawn edits replay after
all of them. At Vreta the clubhouse lot went
from 10 cm RMS of lidar noise to an even 3.8 % plane. A lot OSM lacks is drawn in
the app as a `path` polygon; it is painted, and Grade roads fits it a plane too.

Overpass is a shared public service and turns requests away at random when busy
(HTTP 429/502/503/504, tiny and large queries alike), so every Overpass command
retries a refused request every 2 s for up to 60 s (`osm.with_retries`) before
giving up with "Overpass is busy, try again in a while".

Cart paths inside a course are almost never in OSM — those are drawn in the
app (the draw tool's path mode: `P`, click down the middle, Enter), as
centerline features like the imported roads.

**NVDB** (`golfpipe/nvdb.py`). With `TRAFIKVERKET_API_KEY` set (free key from
data.trafikverket.se; `--no-nvdb` opts out) the OSM ways are fused with
Trafikverket's national road database through its open data API: one POST
for the network (`Vägtrafiknät`), measured width (`Vägbredd`), surface
(`Slitlager`) and road type (`Vägslag`) in the area's box. An OSM way that
runs along an NVDB link of a matching network (roads/tracks ↔ bilnät,
paths ↔ cykel-/gångnät; within 6 m, within 30°, over half its length) keeps
its OSM geometry — the two agree to a few decimetres — and takes the
measured width (beats every OSM tag), else, when OSM only had a class guess,
the NVDB road-type width (`nvdb.VAGSLAG_WIDTH_M`: Småväg enkel standard 3,
Småväg 3.5 …), and `surface` (paved → `asphalt`, gravel → `gravel`). NVDB links no OSM way covers
(≥ 25 m) are added as their own roads (`source: nvdb`, CC0). At Vreta:
63 of 104 OSM ways matched, the gravel `unclassified` lanes went from the
class table's 5 m to a measured 2.9–3.5 m, one missing 190 m gravel road
was added. Without a key, or when the API fails, the run is OSM only and
says so. Properties added: `surface` (one of `roads.PATH_SURFACES`: asphalt, concrete,
paving, gravel, dirt, grass, wood — from NVDB, else the OSM `surface` tag; null when unknown),
`widthM` + `widthSource` (`nvdb` / `nvdb type` / `width tag` / … / `class`),
`nvdb_ids`; NVDB-only features carry `license: CC0-1.0` and
`source_ref: nvdb:<element>`.

In the app: **Import GeoJSON → Fetch roads** runs this over the inner terrain
square, clipped to the exact EPSG:3006 square (`--square-3006`; the `--bbox`
is its WGS84 envelope, 10-15 m larger per side from the grid's rotation),
limited to 200 m around the course's mapped playing features
(`--near`; `roads.NEAR_TYPES` — greens, tees, fairways, roughs, bunkers,
penalty areas — never water or creeks, which run far off the course, nor deep
rough/outside/OOB, generated features or existing roads),
and loads the result straight into the wizard; the outer terrain is scenery
and gets none. The fetch runs as a server job (`/course-features/fetch-roads/start`, then
`job` / `current`, polled by the wizard) since Overpass retries can take a minute. The centerlines land in
`sources/<siteId>/roads-centerlines.geojson` for the road grading.

`--centerlines-out roads-centerlines.geojson` also writes the clipped
centerlines with their resolved widths (EPSG:3006 LineStrings) — the input
for `road-grades`.

### `road-grades` — grade the roads into the DEM

```sh
python -m golfpipe road-grades --centerlines roads-centerlines.geojson --out road-grades.geojson [--classes road,track]
python -m golfpipe apply-dem-edits --input dem.tif --edits site-edits.geojson --edits road-grades.geojson --out dem-edited.tif
cd ../server && bun run import-terrain-edits <site> ../pipeline/road-grades.geojson
```

One `corridor` terrain edit per centerline (see `dem_edit.py`): the DEM is
smoothed *along* the road over `--smooth` 25 m and made level *across* the
pavement, feathered `--feather` 2 m beyond it. The isotropic `smooth` op
can't do this — wide enough to take out 10–20 m undulations it smears the
surrounding grade into the road; narrow, it leaves them. Same D-TE5 handoff
and origin-scoped server import as `building-pads` (origin `road-grades`).

In the app: the terrain tool's **Grade roads** button grades the course's own
`path` features — the server writes them as a centerlines file: each centerline
path a LineString (the roads as imported, moved and drawn in the editor), each
paved polygon (a lot, a yard at a junction) a `road_class: parking` Polygon,
so it gets a plane; long thin path polygons (old road outlines) are skipped
and reported — → road-grades → import, then **Apply to terrain** bakes them.
A course with no paths of its own falls back to the fetched centerlines
(fetch-roads first when there are none).

### `fetch-buildings` — building footprints + roof heights → building survey

```sh
python -m golfpipe fetch-buildings --bbox 15.47,58.50,15.56,58.55 \
    --lidar sources/<id>/lidar/*.laz --out buildings.geojson
```

A building is not an app feature type: on the GSPro side it is a flat pad
on the terrain plus a prefab the Unity building planter places, and both
need one record. This writes that record for every OSM `building=*` way
and multipolygon in the area (whole footprints, even across the edge), as
an EPSG:3006 FeatureCollection (`type: building`) with per feature:

- `id` — `osm:way/123` (a real source id, so authored choices survive a
  refresh), `kind` (the `building` value: detached, garage, apartments …),
  `name`, `levels`, `heightTagM`, `fallbackHeightM` (height tag, else
  levels × 3 m).
- `rect` — the minimum rotated rectangle: `cx`/`cy`, `lengthM`, `widthM`,
  `angleDeg` (long-axis bearing, CCW from east in [0, 180)) — what the
  planter matches a prefab on and rotates it by.
- `eaveM` / `ridgeM` / `roofCells` — from the lidar when `--lidar` is given:
  the same nDSM detect-trees builds (max return − ground, 1 m cells,
  `--resolution`), read inside the footprint inset by 0.75 m; eave = p20,
  ridge = p95 of the cells ≥ 1.5 m. Under 4 such cells → no measurement
  (a shed at 1 m cells). Vreta: 1,004 of 1,038 measured, median eave
  4.2 m, ridge 6.4 m.

Not for the web import wizard (it would show an unmapped bucket); the
consumers are `building-pads` and `gspro.py buildings`.

### `building-pads` — the flat ground under each building, as terrain edits

```sh
python -m golfpipe building-pads --survey buildings.geojson --out building-pads.geojson
python -m golfpipe apply-dem-edits --input dem.tif --edits site-edits.geojson --edits building-pads.geojson --out dem-edited.tif
cd ../server && bun run import-terrain-edits <site> ../pipeline/building-pads.geojson
```

One `plane` edit per footprint, dead flat (`--sloped` fits a tilt instead),
over the footprint plus `--buffer` 1.5 m of apron, blending out over
`--feather` 4 m beyond that (dem_edit feathers *inside* the polygon, so the
edit polygon is grown by buffer + feather). Written as the D-TE5 edits
handoff (WGS84 FeatureCollection, `origin: building-pads`, `originRef`
= building id), which both `apply-dem-edits --edits` (repeatable now) and
the server's `import-terrain-edits` read. The import replaces the previous
`building-pads` generation only — hand-drawn edits are untouched, a pad the
user disabled stays disabled — and dates generated rows at the epoch so
they replay before every hand-drawn edit (manual wins on overlap). Flatten
here, in the DEM: the Unity heightmap, the Blender mesh and the web map all
derive from it, and a vector edit survives a lidar refetch.

In the app: the terrain tool's **Generate building pads** button runs
fetch-buildings (over the outer square, on every persisted lidar tile) →
building-pads `--square-3006 <inner square>` → import. Only the buildings whose
footprint centre is on the inner terrain get a pad (89 of Vreta's 1,038). The
outer plot is scenery, and a pad there only cuts and fills ground nobody plays on.
The survey it writes to `sources/<siteId>/buildings.geojson` still covers the outer square:
it is what the GSPro export panel's **Export inner/outer buildings** reads, so
outer buildings are placed on unflattened ground. The outer heightmap export
replays the site's enabled edits onto the outer DEM too, so the inner pads
(and digs) are in the outer under the inner terrain, and it can't show through
where they cut.

### Pond and bunker digs (`dig` edits)

Lidar sees a pond's surface and smooths a bunker's hollow away, so both come
out of the DEM too shallow for GSPro. The `dig` op (`dem_edit.py`) digs a
polygon below a reference, never filling: a depth profile in metres from the
edge (optional shelf, a bank at `bankSlopeDeg` rounding into a floor at
`depthM`), a steeper face towards `faceBearingDeg` when `faceSlopeDeg` is set,
seeded perimeter `variation`.

- **Ponds** (`reference: level`): the water level is the 25th percentile of
  the in-polygon cells within `rimM` of the shore. Bank the outline takes in
  above the level tapers down to it across that band; the dig proper starts
  where it gets there. The shoreline stays at the water level, which matters
  because OPCD's **Add Water Plane** puts the plane at a water mesh's lowest
  rim vertex minus 5 cm.
- **Bunkers** (`reference: plane`): a plane fitted to the ground in a `rimM`
  band outside the outline, not the smoothed hollow inside it.

- **Creeks** (`reference: stream`): the water surface along the creek's line
  (`golfpipe/creeks.py`: the lowest height across the creek per metre, the
  line turned to run downhill, heights forced to only fall, smoothed), each
  cell dug below its nearest station. The line is the edit's `centerline`, or
  the medial axis of the creek polygon when it has none (a Hydrografi ribbon).
  `gspro.py creeks` puts the R.A.M. water on the same profile, read from the
  raw DEM. The outline is the water's edge. Inside it everything is dug below
  the surface; where the creek is too narrow for `bankSlopeDeg` to reach
  `depthM` by its line (most Hydrografi creeks, ~2 m wide on the 0.5 m DEM)
  the bank steepens, up to 60°. Outside it, bank above the water comes down
  to the surface at the outline over `rimM` (a smoothstep, only lowering).
  On Vreta this takes the water depth along the creek lines from a median of
  2 cm (the rim taper inside the outline used up the whole channel, and half
  the stations had ground above the water) to the preset's 0.35 m at every
  station; the banks outside drop a median 8 cm.

A narrow pond or bunker never reaches full depth: the banks meet first.

In the app, the terrain tool's **Dig ponds** and **Dig bunkers** buttons write
one `dig` per `water` / `bunker` feature (origins `water-digs` /
`bunker-digs`, no pipeline run). Ponds use the feature's `digPreset`
(`parkland_shelf`, `natural_pond` (the default), `cove_point`, `deep_water`:
Shoreline Studio's lake bank slopes and depths). Bunkers get 0.45 m, an 18°
entry and a 40° face towards their hole's green, or the nearest green. A
feature's `digDepthM`, `digBankSlopeDeg` and `digFaceSlopeDeg` override
these, and `dig: false` skips it. **Dig creeks** does the same for `water_creek`
features (origin `creek-digs`, `digPreset` from Shoreline's creek set:
`maintained_drain` (default: 18°, 0.35 m), `meadow_brook`, `estate_stream`,
`pool_riffle`, `rocky_runnel`, `eroded_gully`). It sends a drawn centerline's
line and width; a polygon creek's line is found by the pipeline. **Edits on
this site** groups the edits by kind (yours, ponds, bunkers, creeks, pads,
roads, Unity sculpt; digs of features on another course apart), names each
after its feature and hole ("Bunker · hole 3"), highlights a hovered row's
outline on the map and zooms there on a click. The pencil on a generated
dig's row edits these attributes on
its feature (preset, depth, bank/entry slope, bunker face) and re-runs that
generator; deleting the row sets `dig: false` on the feature, so a re-run
leaves it out. Hand-drawn plane/smooth edits change their own op and params
there.

The same generators run from the command line, so a pond's profile is set
and dug in one step (`--dry-run` writes nothing and lists each dig as new,
changed or the same as the stored one):

    bun run terrain:generate -- "Ombergs Golfklubb" water-digs --feature hole_14_53 --preset deep_water --depth 1 --bank 32 --dry-run

A run re-digs every feature of that kind on the course, as the button does.
`--feature` takes the shape name, the feature number or its id. `--no-dig`
leaves a feature out, and `--reset` drops its dig settings.

**Far shore** (`golfpipe/horizon.py`): a big lake's planes end at `radiusM` (4 km),
so past them GSPro shows bare sky. `golfpipe horizon` puts a low hazy ridge 3.9 km
out wherever the far plane's water reaches that edge (hills 30-70 m, about
0.4-0.9 deg over the horizon from the course; the foot under the water, the ends
sinking into it), with a haze texture. Unity's `golfmap.horizon.build` draws it
unlit and without depth (`GolfMap/FarShore`), so OPCD's gradient fog does not
fog it into the sky:

    python -m golfpipe horizon --lake-plane <prefix>-inner-lake-plane.json --out <prefix>-inner-horizon.json
    bun unity/mcp/call.ts golfmap.horizon.build '{}'

**Pond edges** (`golfpipe/water_edge.py`, server `PondEdgeService`): neither
the lidar nor a drawn or Hydrografi outline is the water's edge. The lidar's
0.5 m grid smears a steep bank a metre or two out over the water; the outline
follows the visible shore, often the top of the bank or the reed line. Each
outline point walks in along its normal, from 1 m outside the drawn line to the
lidar's open water, and stops where the orthophoto turns from land to water.
The photo is read through a two-class model taught on this pond (water inside
the lidar's sheet, land in a ring outside the outline), and the summer and
leaf-off photos vote. Where neither shows a clear turn (reeds, lily pads,
shade) the drawn line stays, and those stretches are reported. In the web:
Terrain edit > **Fit pond edges (lidar + photo)**, or **Fit edge to water** in a
pond dig's form. The proposal shows on the map (red, with the lidar's water
yellow), and Accept stores it as a B-spline (Undo puts the old one back). From
the command line, on the same service:

    bun run water:edge -- "Ombergs Golfklubb" --all --dry-run
    bun run water:edge -- "Ombergs Golfklubb" --feature hole_14_53 --image check.png

A pond dug with `bankAboveDeg` (`--bank-above`) has its outline at the water's
edge, so OPCD's lake mesh rim ends on the dug bank below the water. apply-dem-edits
writes each such dig's level next to the edited DEM
(`sources/<site>/dem-edited.water-levels.json`), and the GSPro terrain update
turns them into `<export folder>/<slug>-inner-water-levels.json` (level + 5 cm,
Unity Y, keyed `Spline_<shape name>_WaterPlane`), which golfmap.waterplanes.build
puts those planes at; a hand-set `<course folder>/water-levels.json` still wins. On Vreta the digs change about 112 000 cells. The shorelines move
at most 4 cm, every bunker ends at least 0.45 m below its surroundings, and
11 of 21 ponds are too narrow for Natural Pond's 11° banks to reach 1 m.

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

`--woodland woodland.geojson` (woodland-features output, or a features
export with `woodland_floor` zones) first repaints every stand as forest
floor, outside the corridor: `--floor-color` (default a moss and litter
brown-green) mixed with the stand's `floorColor` at `--floor-mix` (0 =
palette only, 1 = the photo's colour only, default 0.5), plus world-anchored
fractal noise (`--seed`), faded in over `--floor-feather` metres from the outline
(`golfpipe/woodland_floor.py`). No torch, and processed in row blocks, so
any ortho size works. `--keep roads.geojson` (repeatable, e.g. `fetch-roads`
output) protects polygons from the repaint, so a forest track stays a
track. Houses inside a stand are painted over on purpose: Unity puts a
prefab on the pad.

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

### `cleaned-init` / `cleaned-patch` / `cleaned-replace` / `cleaned-export` — the cleaned photo

A site's cleaned photo is ONE file, `ortho-<vintage>.cleaned.tif`: 8192 x 8192 px RGB in
EPSG:3006 on the inner terrain square (`golfpipe/cleaned.py`). The web Clean tool and its
server service (`CleanedPhotoService`) run these; operator steps:
[docs/workflows.md](../docs/workflows.md) section 6. Each prints one JSON line on stdout, last.

```sh
# Make it (once): cubic resample of the pristine photo onto the square. Refuses to replace one.
bun run py -m golfpipe cleaned-init \
    --ortho ../data/sources/<siteId>/ortho-<vintage>.tif \
    --square-3006 x0,y0,x1,y1 \
    --out ../data/sources/<siteId>/ortho-<vintage>.cleaned.tif

# Write rectangles of finished pixels into it: the Clean tool's strokes, painted in the browser.
# <dir>/patches.json is [{x, y, w, h, file}]; each file is w*h*4 raw RGBA bytes (alpha ignored).
bun run py -m golfpipe cleaned-patch --cleaned <cleaned.tif> --patches-dir <dir> \
    --tiles-out ../data/tiles/<siteId>/ortho-sim --pristine-tiles ../data/tiles/<siteId>/ortho

# Make it show any image of the same pixel size (PNG/JPEG/TIFF, or an undo snapshot .tif).
bun run py -m golfpipe cleaned-replace --cleaned <cleaned.tif> --image edited.png \
    --tiles-out ../data/tiles/<siteId>/ortho-sim --pristine-tiles ../data/tiles/<siteId>/ortho

# Write it out.
bun run py -m golfpipe cleaned-export --cleaned <cleaned.tif> --out cleaned.png [--format jpg|rgb]
```

`cleaned-replace` takes the image whatever it shows: only another pixel size is refused. A
partly transparent image is laid over the photo. It writes only the bounding box of the pixels
that differ and retiles under the 256 px cells that hold one, so two edits at opposite ends
of the photo cost their own tiles; an identical image changes nothing (`changed: false`).
`cleaned-patch` computes nothing: it writes the bytes and retiles under them, per 256 px cell
like `cleaned-replace`. `--format rgb` is the raw pixels (3 bytes each, row by row) the Clean
tool loads. Without `--tiles-out` no tile is touched. The pristine ortho is never modified.

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
`--woodland-out woodland.geojson` does the same for `woodland-features`
(default thresholds; the understory returns are counted in one more pass
over the lidar), with floor colours from `--woodland-ortho <ortho.tif>` when
given. The app's "Regenerate trees" job runs it and imports the result.
`--roofs-out roofs.tif` keeps the roof heights (lidar nDSM on the cells
`suppress_buildings` took for roofs, 0 elsewhere) for
`gspro.py ortho --remove-buildings`; the app's job writes it to
`sources/<siteId>/roofs.tif`.

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

### `lowveg-features` — shrub-zone proposals from the cleaned canopy grid

```sh
python -m golfpipe lowveg-features --canopy-tif work/canopy/canopy.tif \
    --course-id <courseId> --out lowveg.geojson \
    [--trees trees.geojson] [--tree-buffer 1.0] \
    [--min-height 0.5] [--max-height 3.0] [--min-area 20] [--min-hole-area 20] \
    [--close 1.0] [--round 1.5] [--simplify 0.5] [--bbox e_min,n_min,e_max,n_max]
# or grid the canopy in-process, exactly as `canopy` / `trees-features` do:
python -m golfpipe lowveg-features --lidar a.copc.laz --dem data/dem/<courseId>.tif \
    --course-id <courseId> --out lowveg.geojson
```

Lidar does not place bushes — VSPro does, from rules — but it can say where
bushes and tall scrub already stand (`docs/feature-vegetation-zones.md`,
D-VZ7). Cells of the same cleaned canopy grid `trees-features` reads whose
height is between `--min-height` and `--max-height` and which are not trees
are cleaned and polygonised the way `trees-features` does it
(`golfpipe/lowveg_features.py` reuses its closing, hole filling and outline
rounding) and written as `vegetation_zone` features of zone type `shrub`.
Once imported they are ordinary zones: editable, deletable, re-importable by
source. Trees are cut out two ways: every cell above `--max-height` plus
everything within `--tree-buffer` of it (the crown edge of a 12 m birch
reads as 2 m of "low vegetation" in a max-z grid), and, with `--trees`, the
polygons of a trees GeoJSON (`trees-features` output, or the app's exported
`trees` features; EPSG:3006 metres) buffered by the same distance. The
default `--min-area` is 20 m²: a zone is a VSPro rule area, and a single
4 m² bush is better left to the biome's own scatter.

Output: an EPSG:3006 FeatureCollection like `trees-features`'s, per feature:

| property      | value                                                     |
|---------------|-----------------------------------------------------------|
| `type`        | `"vegetation_zone"`                                       |
| `source`      | `"lidar-lowveg"`                                          |
| `source_ref`  | `--source-ref`, default the canopy tif / lidar basenames   |
| `license`     | `"CC0-1.0"`                                               |
| `zoneType`    | `"shrub"`                                                 |
| `weight`      | `1`                                                       |
| `feather`     | `2` (metres)                                              |
| `noise`       | `0` (metres)                                              |
| `heightP90M`  | 90th percentile of the low-vegetation cells inside, 1 decimal |
| `heightMaxM`  | their maximum, 1 decimal                                  |
| `areaM2`      | polygon area in m², integer                               |

Import: `PUT /api/courses/:courseId/features/generated?source=lidar-lowveg`;
the server turns the non-reserved scalar properties (`zoneType`, `weight`,
`feather`, `noise`, the stats) into the feature's attributes.

### `woodland-features` — woodland-floor zones per closed stand

```sh
python -m golfpipe woodland-features --lidar a.copc.laz --dem data/dem/<courseId>.tif     --ortho data/sources/<mapKey>/ortho.tif --course-id <courseId> --out woodland.geojson
# or from a canopy workdir (no understory counts, every weight 1):
python -m golfpipe woodland-features --canopy-tif work/canopy/canopy.tif --roof-tif work/canopy/roof.tif     --ortho ortho.tif --course-id <courseId> --out woodland.geojson     [--min-height 3] [--close 5] [--min-area 2500] [--min-cover 0.5] [--edge 2] [--roof-buffer 5]
```

One polygon per closed stand of the cleaned canopy grid
(`docs/feature-vegetation-zones.md` D-VZ10, `golfpipe/woodland_features.py`):
cells of `--min-height` and up, closed by `--close` so crowns up to about twice
that apart join one stand, nothing within `--roof-buffer` of a roof, stands
under `--min-area` or under `--min-cover` canopy cover dropped, grown
`--edge` metres past the outer crowns. With `--lidar` the returns 0.5..3 m
above ground are counted as `lowveg-features` does; the share of cells with
one is `understoryPct` and sets the weight (1 at 20 %, never under
`--min-weight` 0.3; Vreta's leaf-off scan measures 1 to 13 %). With `--ortho`
(EPSG:3006 RGB; use the ortho you will clean) each stand gets `floorColor`:
the median of its ground-coloured pixels (warm, not leaf green, not blue
shade, not grey gravel, not deep shadow) at least 3 m inside the outline,
those in lidar gaps first. Under closed spruce the photo rarely shows the
floor, so on Vreta the colour comes from tracks and clearings. Stands
without enough ground pixels have no colour, and clean-ortho uses
`--floor-color` for them.

| property        | value                                              |
|-----------------|----------------------------------------------------|
| `type`          | `"vegetation_zone"`                                |
| `source`        | `"lidar-woodland"`                                 |
| `zoneType`      | `"woodland_floor"`                                 |
| `weight`        | from the understory with `--lidar`, else `1`       |
| `feather`       | `4` (metres)                                       |
| `noise`         | `2` (metres)                                       |
| `coverPct`      | canopy cover inside the polygon, %                 |
| `heightP90M`    | 90th percentile canopy height, 1 decimal           |
| `areaM2`        | polygon area in m², integer                        |
| `understoryPct` | `--lidar` only: cells with a 0.5..3 m return, %    |
| `floorColor`    | `--ortho` only: `#rrggbb`                          |
| `floorStdev`    | `--ortho` only: per-channel spread of the floor    |

Import: `PUT /api/courses/:courseId/features/generated?source=lidar-woodland`
(or `bun scripts/import-generated-features.ts <courseId> woodland.geojson --source lidar-woodland`).
The zone type `woodland_floor` is a default from this change on; an existing
course gets it from the zone-type panel's add-defaults button.

### `gspro.py ortho --floor-course` — forest floor on the exported textures

`--floor-course <course id or name>` paints the course's `woodland_floor`
zones from the app database (`--db`) as forest floor on the rendered square
before any file is written, so the plain JPEG, the `--terrain-out` twin and
the `--tint-out` variant all carry it. The drawn fairway, semi rough, rough,
tee, green, bunker, path, water and creek features are kept as photographed.
`--floor-color`, `--floor-mix`, `--floor-feather` and `--floor-seed` are the
`clean-ortho --woodland` knobs (`golfpipe/woodland_floor.py`). A course with
no woodland-floor zones exports the photo unchanged, with a note. The app's
orthophoto exports pass it when "Forest floor under woodland stands" is on.

### `gspro.py ortho --remove-buildings` — roofs and shadows out of the textures

`--remove-buildings` with `--roofs roofs.tif` (canopy `--roofs-out`) and/or
`--buildings-survey buildings.geojson` (fetch-buildings, what "Generate
building pads" writes) fills every roof and the shadow it casts from the
ground round it, before the forest floor and before any file is written
(`golfpipe/building_removal.py`). The survey matters for buildings newer
than the lidar: on Vreta the clubhouse was built after the March 2021 scan
and has no returns at all. Survey footprints are grown 2 m (OSM offsets,
roof lean in a non-true ortho). The shadow runs toward an azimuth for
height × ratio metres; both are measured from the photo (the darkest band
next to the roofs, and where it turns as bright as the sunny side) unless
`--shadow-azimuth` / `--shadow-ratio` are given; Vreta's 2025 photo
measures 45°. The fill is the colour of the nearest ground at least 2 m
outside the hole, on a 1 m grid, blurred, with world-anchored grain; an
inverse-distance fill averaged lawn and car park into grey haze. Car
parks, roads and paths are ground and stay, cars on them too.

### `gspro.py zones` — vegetation zones → VSPro texture masks (per terrain)

```sh
python gspro.py zones --square-3006 x0,y0,x1,y1 --course Vreta \
    --sidecar out/vreta-inner.tif.json --terrain inner --out out/vreta-inner-zones.json \
    [--resolution 4096] [--simplify 1.0] [--seed 0] [--db ../data/app.sqlite]
# the outer terrain, leaving the inner square to the inner file:
python gspro.py zones --square-3006 ... --terrain outer --exclude-square <inner x0,y0,x1,y1> ...
```

The `vegetation_zone` features of a course, rasterized into the densities
VSPro's texture-mask rules sample (`docs/feature-vegetation-zones.md`,
sections 6 and 7): **one mask channel per VSP item**, four items per RGBA PNG
(`<out stem>-<texture>.png`, `--resolution`², 8 bits per channel, the same
north-up frame as the terrain texture), plus the `unity-zones-v2` JSON at
`--out`. One channel per item, not per zone type, because VSP multiplies an
item's texture-mask density rules together: an item bound to two channels
would only spawn where both are non-zero.

- **Zone types and variants** come from the course's zone-type table
  (`course_zone_types`: `items_json` is a type's Default mix, `variants_json`
  its named variants, each its own item mix; a database without the
  `variants_json` column reads as no variants, malformed JSON as none with a
  warning; `texture_index`/`channel` are no longer read). A zone picks a type
  (`zoneType`) and optionally a variant (`zoneVariant`, absent or `""` =
  Default). A zone whose `zoneType` is not in the table is skipped with a
  warning; a variant its type does not have falls back to the Default mix
  with a warning.
- **Slots.** A type's Default mix paints slot `<type>`, a variant slot
  `<type>/<variant>`. Per zone, in the app's paint order: rings filled
  even-odd, a signed distance in metres from two Euclidean distance
  transforms (negative inside, zero on the drawn edge), optional value noise
  on that distance (`noise` metres, deterministic from `--seed`), then
  `clamp(0.5 - d / feather, 0, 1) × weight` (feather 0 = hard edge). Overlaps
  run from the last zone to the first with a per-pixel budget of 1: a later
  zone claims its weight first, an earlier zone of another slot keeps only
  what is left, same-slot zones combine as a maximum, nothing is ever scaled
  up, so the slots never sum above 1.
- **Drawn over generated** (D-VZ14). The overlap rule above holds among the
  generated zones (`course_features.generated`). Drawn zones are applied first,
  in any order: each paints its palettes (the same palette twice: the
  maximum), so overlapping drawn zones all grow, and a drawn replace zone's
  weight (the largest where several overlap) is taken from the budget the
  generated zones then share. A drawn zone's hole or stack position changes
  nothing.
- **Mix and extra palettes** (D-VZ12). A zone with `blend: "mix"` raises its
  slot the same way but takes nothing out of the budget: the zones below it
  keep their share and both palettes grow there; a replace zone above still
  cuts it. `extraPalettes` (`"shrub/rocks=0.4, fern"`, comma-separated
  `<type>[/<variant>][=<weight 0..1>]`, the format of
  `shared/features/zone-layers.ts`) are mix layers on the zone's own
  footprint at `weight × factor`. An extra whose type is not in the table is
  skipped with a warning, an unknown variant falls back to Default. The JSON
  rows carry `blend` and `extraPalettes` (`[{zoneType, variant, weight}]`).
- **Items.** Every non-blank `item` name the table binds, in order of first
  appearance walking the types in sort order (Default items, then each
  variant's), gets a channel — even with no zone on this terrain (an
  all-zero channel: spawns nowhere), so Unity always rebinds it. Its density
  is `clip(Σ W_slot × maxDensity, 0, 1)` over every slot binding it (an item
  listed twice in one slot counts twice); `minDensity` is carried in the
  JSON only. Written as `round(d × 255)`. Stale `<out stem>-<n>.png` past the
  last texture are removed.

```json
{
  "format": "unity-zones-v2",
  "plot": { "crs": "EPSG:3006", "terrain": "inner", "originX": 0, "originY": 0, "sizeM": 2050, "minM": 0, "maxM": 0 },
  "masks": [ { "file": "x-inner-zones-0.png", "resolution": 4096,
               "channels": ["Tall rough - green base", "Tall rough - tall green", "", ""] } ],
  "items": [ { "item": "Tall rough - green base", "texture": 0, "channel": 0,
               "sources": ["rough_tall", "rough_tall/lush"] } ],
  "zoneTypes": [ { "key": "rough_tall", "name": "Tall rough", "color": "#8a9a3c",
                   "items": [ { "item": "...", "minDensity": 0, "maxDensity": 1 } ],
                   "variants": [ { "key": "dry", "name": "Dry straw", "items": [ ... ] } ] } ],
  "zones": [ { "id": "...", "zoneType": "rough_tall", "variant": "dry", "weight": 1,
               "feather": 2, "noise": 0, "rings": [ { "nodes": [ { "x": 0, "z": 0 } ] } ] } ]
}
```

`items[].sources` are the slots binding the item; `zones[].variant` is `""`
for the Default mix (and for a fallen-back unknown variant). `zones[]` are
the same polygons as plot-local metres (x east, z north from the square's
south-west corner, like `unity-trees-v1`), flattened, clipped to the square
minus `--exclude-square`, simplified to `--simplify`, for the Unity
Scene-view overlay only. `plot` is copied from `--sidecar` field for field
as `trees` does. The summary prints the zones per slot and each item's
texture/channel with its sources.

### `gspro.py gkd` — the GreenKeeper course file (`<scene>.GKD`)

```sh
python gspro.py gkd --square-3006 x0,y0,x1,y1 --course Vreta     --sidecar out/vreta-inner-dem-2050m.tif.json     --out "C:/GSProV1/Core/GSP/Courses/<scene>/<scene>.GKD"     [--dem out/vreta-inner-dem-2050m.tif] [--simplify 1.0]     [--water-margin 0.5] [--bank-max 3.0] [--bank-slope 8] [--node-spacing 3.0]     [--tee-map Silver=Blue] [--altitude 79.9] [--template other.GKD] [--no-merge]
```

The JSON GSPro reads for everything about a course that is not geometry, as
GreenKeeper writes it. Holes (par, stroke index), tee boxes, pin positions,
green centres and aim points come from the app's own tables; the penalty
areas and the out-of-bounds ring from its drawn features. Positions are
**Unity world metres on the INNER terrain** — x east, z north from the
square's south-west corner like `unity-trees-v1`, y the ground above the
terrain's own zero (`minM` from `--sidecar`, where the importer's `0,0,0`
puts it) — read off `--dem` (by default the sidecar's own GeoTIFF), so every
point lands on the imported heightmap.

- **Tee sets.** The GKD has eight (`Black White Green Blue Yellow Red Junior
  Par3`); the app names a tee whatever the course calls it, so each tee
  goes on the set its course tee set says (`course_tee_sets.gspro_tee`,
  picked in the app's GSPro export panel; empty = not exported). A tee
  without a set, or a database from before that column, is matched on its
  name and then its colour, with a few aliases (`championship`→Black,
  `ladies`→Red, …). Anything left is skipped with a warning naming it;
  `--tee-map NAME=TEESET` overrides all of it.
- **No tee, no row to play.** A set the hole has no tee for, and an aim point
  it does not have, is written disabled with no position (GreenKeeper's own
  form), so GSPro offers only the tees the app has. A hole with no tee at all
  is written disabled, with a warning.
- **Tidy tees.** So the tee markers look kept: tees drawn under 1 m apart
  (`GKD_TEE_SAME_M`) are one tee box and all get the position of the one
  furthest from the hole; then tees within 6 m of each other (`GKD_TEE_ROW_M`,
  chains count) that stand under 0.7 m (`GKD_TEE_ROW_OFFSET_M`) off the line
  from the longest of them to its first aim point — the green centre where it
  has none — are moved sideways onto that line. Only the GKD moves; the app's
  tees stay as drawn. Distances are measured from the tidied positions.
- **Distances.** A tee's scorecard distance is the walk on the ground plane
  from the tee through the hole's aim points to the green centre. An aim
  point the tee is already past (no closer to the green than the tee itself)
  drops out, so a forward tee does not detour to a dogleg marker meant for
  the back tees, and the `Par3` set — the whole course played as par 3s —
  ignores them entirely. `TeeTypeTotalDistance` sums the holes. Both rules
  reproduce the distances in GreenKeeper's own files.
- **Pins.** GreenKeeper keeps four per green, one per tournament day; a pin
  the course named after a day takes that day, the rest fill what is left in
  order, and a green with fewer than four has the green centre stand in (with
  a warning) so GSPro always has a cup.
- **Water hazards are staked outside the water.** Water is drawn where the
  water is, so its line never touches it: every node and every straight
  line GSPro draws between two nodes is at least `--water-margin` (0.5 m)
  outside, checked against the drawn water after straightening. Where the
  water has a bank the line goes where the bank ends: rays are cast straight
  out from the shore every 0.5 m over the export DEM (smoothed 0.5 m so
  single lidar returns don't count), and a run of ground steeper than
  `--bank-slope` (8°) that starts within 2 m of the water is the bank; the
  line goes to its first flatter ground, never further than `--bank-max`
  (3 m). The offsets are median-filtered over neighbouring rays (single-ray
  outliers out) and then Gaussian-smoothed over 3 m of shore: along a ditch
  the bank reading flickers on and off, and without that the line was
  notched in and out along a straight creek. Steeper ground further back is the
  next slope, not the bank. The outline is a variable-width buffer (a disc
  of the local offset on every shore sample, neighbours joined by their
  convex hull), so a concave shore or a narrow channel cannot fold the line
  back over the water. Water whose lines would run closer than 2 m (a creek
  into a pond, a pond drawn in pieces) is one hazard. Lines are straightened
  within 0.2 m, only ever outwards, and get a node at least every
  `--node-spacing` (3 m) so the markings follow the ground. On Vreta about a
  quarter of the shoreline has no bank and is staked at the margin; the rest
  follows a bank, typically 2-3 m out.
- **Penalty areas and OOB.** `penalty_yellow` and `penalty_red` features are
  drawn where the line is and go in as drawn (never straightened inwards);
  water entirely inside one is left to it. The largest `oob` ring is the
  course boundary (`pOOB`), any other `oob` shape a hazard with the
  `innerOOB` flag; they are straightened within `--simplify` (1 m), outwards
  only, and not densified. Everything is clipped to the square, and **every hazard line lies
  strictly inside the course boundary** (GSPro forbids one on or beyond it, and GreenKeeper misdraws
  it): hazards are cut 0.25 m inside the drawn `oob` ring, or the `pOOB` already in the file when
  none is drawn, and one entirely beyond it is left out, with the counts in the report; a piece
  under 1 m wide left along the line by the cut is a sliver, not a hazard, and is dropped. Where water
  runs up to the boundary the margin yields to it. A GKD outline
  is one flat point list, so an island in a pond is inside its hazard, which
  is what the Rules say anyway. Drop zones and island greens stay
  GreenKeeper's to place.
- **Merging.** The header is carried over from the file at `--out` (or
  `--template`) untouched, except the course details the app keeps for the
  course in `courses.gspro_meta_json` — name, location (`CityTown`,
  `StateCountyProvince`, `Country` and the joined `Location`), designer,
  homage, `CourseInfo`, the `Keyword*` flags with `KeywordsString` and
  `DifficultyRating` — which are written from there (`_gkd_apply_meta`). A
  course with none kept (NULL) leaves those to the file too. The `<set>SR`
  ratings come from the course's tee sets (`course_tee_sets`: men's and
  women's rating and slope, `gspro_rating` picks which; `_load_gkd_ratings`),
  each on the GKD set its tees map to; a set without that rating leaves the
  file's. The driving range, wind, stimp, firmness and the scene
  folder name are always GreenKeeper's. Besides that only `Holes`, `Hazards`, `pOOB`,
  `TeeTypeTotalDistance`, the counts, `CoursePar` and `altitudeV2` are
  replaced. The original is kept as `<out>.GKD.bak` on the first run and
  never overwritten after that. `--no-merge` starts from a bare v4.1 file
  instead. Close the course in GreenKeeper before running, or it will write
  its own copy back over this one.

Holes past 18, aim points past the second and points outside the square are
left out, each with a warning.

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
