# pipeline — AGENTS

`golfpipe` — Python CLI turning Lantmäteriet elevation (DEM) + orthophoto GeoTIFFs into the XYZ tile pyramids the server serves (`data/tiles/{courseId}/{layer}/{z}/{x}/{y}.<ext>`).

Pure Python, self-contained venv. **No system GDAL** — rasterio wheels bundle their own. Don't add `gdal`/`pygdal` to requirements.

## Setup

```sh
cd pipeline
./setup.sh              # idempotent: creates/reuses .venv, installs requirements.txt
source .venv/bin/activate
python -m golfpipe --help
pytest                  # tests
```

## Layout (`golfpipe/`)

`__main__.py` + `commands.py` (CLI) · `stac.py` (Lantmäteriet STAC search/download, needs `LANTMATERIET_USER`/`PASS`) · `raster.py`, `grid_dem.py` (LAS/LAZ lidar → DEM via laspy) · `terrain_rgb.py` (16-bit terrain PNG) · `tiling.py` (reproject → Web Mercator, XYZ pyramid) · `aoi.py`/`bbox_course.py` (area: `--bbox west,south,east,north` WGS84 **or** `--aoi file.geojson`) · `manifest.py`.

## Notes

- Areas: `--bbox` and `--aoi` are mutually exclusive. GeoJSON parsed with stdlib `json` (no fiona/pyshp); projected-CRS coords rejected.
- DEM output stays in source CRS (SWEREF99 TM / RH2000); tiling reprojects to Web Mercator once.
- Tile layers: `ortho` → `.jpg`, `terrain` → `.png` (matches server `assets.service.ts` `resolveTilePath`).
