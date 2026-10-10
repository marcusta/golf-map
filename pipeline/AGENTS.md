# pipeline — AGENTS

`golfpipe` — Python CLI turning Lantmäteriet elevation (DEM) + orthophoto GeoTIFFs into the XYZ tile pyramids the server serves (`data/tiles/{courseId}/{layer}/{z}/{x}/{y}.<ext>`).

Pure Python, self-contained venv. **No system GDAL** — rasterio wheels bundle their own. Don't add `gdal`/`pygdal` to requirements.

## Setup

```sh
# from the repo root; runs pipeline/.venv/Scripts/python.exe with cwd pipeline/
bun run py -m golfpipe --help
bun run py gspro.py --help
bun run py -m pytest    # tests — synthetic in-memory GeoTIFF fixtures, no mocks; see root TESTING.md
```

Venv missing (fresh machine): `python -m venv .venv` in `pipeline/`, then `bun run py -m pip install -r requirements.txt`. (`setup.sh` targets `.venv/bin` and python3 — Linux/macOS only.)

## Layout (`golfpipe/`)

`__main__.py` + `commands.py` (CLI) · `stac.py` (Lantmäteriet STAC search/download, needs `LANTMATERIET_USER`/`PASS`) · `raster.py`, `grid_dem.py` (LAS/LAZ lidar → DEM via laspy; `DEFAULT_CLASSES` 2, 9, 17 = ground, water, bridge deck — OPCD's CloudCompare filter, so a bridge is not a trench) · `terrain_rgb.py` (16-bit terrain PNG) · `canopy.py` (lidar nDSM → canopy height / colour ramp / DSM for the `canopy` command) · `trees_features.py` (cleaned canopy grid → tree polygons + height stats for `trees-features` / `canopy --trees-out`) · `lowveg_features.py` (`vegetation_zone` shrub proposals, source `lidar-lowveg`, for `lowveg-features`: with `--lidar` it counts returns 0.5..3 m above the ground grid per cell, `--min-points` over 3x3 cells, trees and roofs from the canopy grid, nothing within `--roof-buffer` 10 m of a roof since garden objects read as shrubs; `--canopy-tif` uses the grid's cells, which never go under 1 m; D-VZ7 in `docs/feature-vegetation-zones.md`) · `woodland_features.py` (`vegetation_zone` woodland-floor proposals, source `lidar-woodland`, for `woodland-features`: one polygon per closed stand of the canopy grid, weight from 0.5..3 m understory returns, `floorColor` sampled from the ortho between the crowns; D-VZ10) · `woodland_floor.py` (`clean-ortho --woodland`: repaints stands as forest floor outside the corridor and `--keep` polygons) · `building_removal.py` (`gspro.py ortho --remove-buildings`: lidar roof heights from canopy `--roofs-out` plus building-survey footprints, shadow direction and length measured from the photo, holes filled from the nearest ground) · `tiling.py` (reproject → Web Mercator, XYZ pyramid) · `aoi.py`/`bbox_course.py` (area: `--bbox west,south,east,north` WGS84 **or** `--aoi file.geojson`) · `osm.py` (Overpass golf/land-cover polygons, `fetch-osm`) · `roads.py` (Overpass highway centerlines → buffered, per-class-unioned road corridor polygons, `fetch-roads`; width from the `width` tag, else `lanes`, else `CLASS_WIDTH_M`; `--near` keeps only roads within 200 m of the course features; `--centerlines-out` keeps the clipped centerlines + widths, which `road-grades` turns into one `corridor` terrain edit per road — smooth along, flat across — as the D-TE5 edits handoff) · `nvdb.py` (Trafikverket NVDB via the open data API, `TRAFIKVERKET_API_KEY`: fuses measured widths, paved/unpaved and OSM-missing roads into `fetch-roads`; OSM geometry kept, OSM-only when no key) · `buildings.py` (Overpass building footprints + minimum rotated rectangle + lidar nDSM eave/ridge heights → the building survey, `fetch-buildings`; the survey → one flat `plane` terrain edit per footprint as the D-TE5 edits handoff, `building-pads` — a building is not an app feature type, it is a pad on the terrain plus a prefab the Unity planter places) · `manifest.py` · `cleaned.py` (the cleaned photo: one 8192 px RGB GeoTIFF per site on the inner terrain square, edited in place by `cleaned-init` / `cleaned-bake` / `cleaned-replace` / `cleaned-export`; the edit entries and bake math are `patches.py`'s; `docs/workflows.md` section 6).

## `grass_zones.py` — tall-grass zones by rule

Whole-course `vegetation_zone` features (source `tall-grass`) from the Unity surface map
(`golfmap.surfaces.export`) or, without one, the app's features in OPCD paint order: deep rough +
Outer_Deep, a little spill into rough, within 75 m of play, clear of tees/fairways/greens/semi/bunkers/
water/blends, roads (OSM centerlines + `path`) and buildings (`fetch-buildings` survey). Run through
`bun run grass:zones -- <course>` (imports + re-exports zones). Rules and loop:
`.claude/skills/grass-planting/SKILL.md`; tests `tests/test_grass_zones.py`.

## `gspro.py` — GSPro/OPCD assets (not part of the tile pipeline)

Standalone CLI the server's GSPro export shells out to. Full reference: [docs/gspro/export.md](../docs/gspro/export.md).
Everything renders over one square EPSG:3006 extent (`--square-3006` verbatim from the app, or `--bbox` squared up to a 10 m side) so outputs overlay.

| Subcommand | Output |
|---|---|
| `svg` | Layered fill-only SVG from `data/app.sqlite` for Inkscape/Blender (OPCD). Layers `Hole1`…/`Others`, shapes `hole_<h>_<feature_no hex>`; `Roads` on top, every touching road/fillet/taper (of every surface) merged into one `roads_<lowest feature_no hex among its pieces>` per network (slits < 0.6 m closed, `data-feature-id` lists the pieces, no `data-surface`; OPCD needs the junction fillets dissolved in one shape, a per-surface split in the SVG was tried 2026-10-04/05 and dropped), `surface: grass` tracks written as separate shapes with the rough fill (`data-surface="grass"`, under the roads), plus the sidecar `<stem>-paths.json` (`golfmap-path-regions-v1`: `shapes` = each road shape's dominant surface, read by Unity's `golfmap.paths.materials`; `regions` = every piece with surface and outline in SVG units, for the Blender step that cuts a mixed shape's mesh along the surface seams), and a rough/fairway drawn < 1 m short of a road grown to it (written flattened). **Fills are `OPCD_PALETTE` (from `OPCD Palette.gpl`) — fill colour tells OPCD what a shape is; never change those hexes.** |
| `ortho` | 8192 px JPEG + `--terrain-out` darkened twin + `--tint-out` course-tinted `-meshes` texture (with the bunker/path edge fill: `--edge-fill`, default `bunker,path`, `none` = as photographed); `--floor-course`, `--remove-buildings` |
| `dem` | float32 GeoTIFF + Unity `.raw` (4097² uint16) + `.json` sidecar (height range, Unity import values, outer position); `--sculpt <tif>` (repeatable) adds `<stem>-sculpt-in.raw` + `sculptIn`: the Unity sculpt layers the DEM contains, on the .raw's pixel grid (`golfpipe/sculpt.py`) |
| `hillshade` | JPEG for checking overlays |
| `trees` / `buildings` | `unity-trees-v1` / `unity-buildings-v1` JSON (plot-local metres, `plot` from the DEM sidecar, `--exclude-square` for outer) |
| `zones` | `vegetation_zone` features → VSPro RGBA mask PNGs, **one channel per VSP item** (4 per PNG; density = Σ slot weight × maxDensity over the type Default / `<type>/<variant>` slots binding it, clipped — VSP multiplies an item's density rules, so never one channel per zone type) + `unity-zones-v2` JSON |
| `creeks` | `water_creek` features → unity-creeks-v1 R.A.M. splines for the inner terrain: the drawn centerline (or `golfpipe.creeks.ribbon_centerline` down a polygon) with points at the water surface (`creeks.surface_profile` over the **raw** DEM: lowest across, turned downstream, only falling), plot-local, y above the sidecar's `minM` |
| `gkd` | GreenKeeper's `<scene>.GKD` for the GSPro course folder: holes, tee boxes, pins, green centres, aim points from the app's tables, penalty areas + OOB ring from its drawn features, as Unity world positions. Water hazard lines are staked at least 0.5 m outside the water (nodes and the lines between them) and out to the end of its bank. **Merged into the existing file** (GreenKeeper keeps the course metadata), `.GKD.bak` on the first run. |
| `shaping-global` | `golfmap-shaping-layer-v1` JSON for Blender (`blender/SHAPING-PLAN.md`), default `docs/gspro/<course>/shaping/00-global.gen.json`: tees flattened, concrete paths cut (select by feature id; none for asphalt/gravel/dirt, none when a mixed road shape exists) and all paths smoothed (select by type), then last `paths-edge-fade` (`golfmap.path_edge_fade`: gravel and dirt paths break up into the grass; only when the course has one), paved lots (`level: plane`) and the site's building pads / plane terrain edits near the course (`level: median`) as `golfmap.flatten_footprint` footprints, and after everything one `golfmap.cut_out` per `rock_slab` feature (drawn outline grown by its `marginM`, 1.5 m default, 0.8 m kept between slabs; the SVG leaves slabs out). Read-only DB, deterministic output. |

## Notes

- `trees-stems` leaves out solid low objects (rocks, sheds, walls: `trees_stems.SOLID_MAX_HEIGHT_M` and the comment above it for the rule and the Vreta numbers it was set from) and writes them beside `--out` as `<out stem>-solid.geojson`: rock candidates. It needs the leaf-off ortho; `--no-kind` runs (the outer square) leave nothing out. What the detector still plants on a known rock or under a wire is dropped at export (`gspro.py trees`: `rock_slab` and `power_line` features, `--rocks`).
- `trees-stems` performance: the crown-top search used to rescan the whole grid once per plateau (quadratic; 120 of 168 s on Vreta's 2050 m square, hours on a 5 km forest square) — it now looks inside each plateau's `find_objects` box, byte-identical output, 22 s. `--tile-m N` splits the box into ~N m tiles (+30 m margin, cell-aligned) detected in a process pool and merged (stem-identical on Vreta); it is off by default because reading the LAZ files dominates and is re-done per tile while lazrs already uses every core (9 tiles: 60 s vs 22 s). Use it only for boxes where detection itself dominates.

- Areas: `--bbox` and `--aoi` are mutually exclusive. GeoJSON parsed with stdlib `json` (no fiona/pyshp); projected-CRS coords rejected.
- DEM output stays in source CRS (SWEREF99 TM / RH2000); tiling reprojects to Web Mercator once.
- Tile layers: `ortho` → `.webp` (PIL WebP q80; use `reencode_webp` to convert legacy `.jpg` trees), `terrain`, `canopy`, `surface` (Terrain-RGB) and `canopy-color` (RGBA) → `.png` (matches server `assets.service.ts` `resolveTilePath`).
