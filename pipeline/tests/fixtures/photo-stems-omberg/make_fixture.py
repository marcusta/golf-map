"""Cut the photo-stems acceptance fixtures from Omberg's site data (run once; the output is committed).

Two cut-outs, each a folder laid out like a site's own data so a test can install it as one:

- rough-1-10/: the rough between greens 1 and 10, a 180 m square centred on SWEREF99 TM
  E 477738 N 6457326 (Unity inner (717, 590)); 20 lidar stems, about 22 young trees without one
- lone-conifer/: a 60 m square round the one lone conifer Omberg has in open rough (lidar stem
  E 477354.5 N 6457191.5, 9.2 m, k=1), with that stem LEFT OUT of tree-stems.json: a conifer the
  lidar missed, green in the leaf-off photo

Each folder gets:

- ortho-orto-l2-2025.tif / ortho-orto-l2-2023.tif: the summer (2025-06-14) and leaf-off (2023-04-22)
  photos at their own 0.16 m, JPEG-compressed GeoTIFFs in EPSG:3006 (named as in data/sources/<site>/)
- manifest.json: the tiles manifest's ortho vintages (data/tiles/<site>/manifest.json)
- tree-stems.json: the site's lidar stems (tree-stems asset v2) within the square + 20 m
- features.json: the course's features crossing the square (+ 20 m) as the app stores them (EPSG:3006
  geometry): a list of {type, source, attributes, geometry}; of the vegetation zones only the woodland floor

    bun run py tests/fixtures/photo-stems-omberg/make_fixture.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import rasterio
from rasterio.windows import from_bounds
from shapely.geometry import box

HERE = Path(__file__).resolve().parent
PIPELINE = HERE.parents[2]
sys.path.insert(0, str(PIPELINE))
import gspro  # noqa: E402

REPO = PIPELINE.parent
SITE = "317d1f83-3ade-431c-8201-605ac0bd2871"
COURSE = "ce4629e1-042d-4ea7-b31e-9226e2742a56"
STEM_MARGIN = 20.0
CUTS = {
    "rough-1-10": {"e": 477738.0, "n": 6457326.0, "half": 90.0, "drop": []},
    "lone-conifer": {"e": 477354.5, "n": 6457191.5, "half": 30.0, "drop": [(477354.5, 6457191.5)]},
}


def cut_photo(out_dir: Path, bounds, year: str) -> None:
    name = f"ortho-orto-l2-{year}.tif"
    with rasterio.open(REPO / "data" / "sources" / SITE / name) as ds:
        win = from_bounds(*bounds, ds.transform).round_offsets().round_lengths()
        data = ds.read([1, 2, 3], window=win)
        profile = dict(driver="GTiff", width=data.shape[2], height=data.shape[1], count=3, dtype="uint8",
                       crs=ds.crs, transform=ds.window_transform(win), compress="JPEG", jpeg_quality=92,
                       photometric="YCBCR", tiled=True, blockxsize=256, blockysize=256)
    with rasterio.open(out_dir / name, "w", **profile) as out:
        out.write(data)


def cut_manifest(out_dir: Path) -> None:
    manifest = json.loads((REPO / "data" / "tiles" / SITE / "manifest.json").read_text())
    keep = {k: manifest[k] for k in ("orthoVintages", "activeOrtho", "builtOrtho") if k in manifest}
    (out_dir / "manifest.json").write_text(json.dumps(keep, indent=2) + "\n")


def cut_stems(out_dir: Path, bounds, drop) -> None:
    west, south, east, north = bounds
    asset = json.loads((REPO / "data" / "tiles" / SITE / "tree-stems.json").read_text())
    asset["trees"] = [t for t in asset["trees"]
                      if west - STEM_MARGIN <= t[0] <= east + STEM_MARGIN and south - STEM_MARGIN <= t[1] <= north + STEM_MARGIN
                      and (t[0], t[1]) not in drop]
    (out_dir / "tree-stems.json").write_text(json.dumps(asset, separators=(",", ":")) + "\n")


def cut_features(out_dir: Path, bounds) -> None:
    west, south, east, north = bounds
    _, rows = gspro._load_course_features(REPO / "data" / "app.sqlite", COURSE, "opcd")
    square = box(west - STEM_MARGIN, south - STEM_MARGIN, east + STEM_MARGIN, north + STEM_MARGIN)
    features = []
    for r in rows:
        attrs = json.loads(r["attributes_json"]) if r["attributes_json"] else None
        if r["type"] == "vegetation_zone" and (attrs or {}).get("zoneType") != "woodland_floor":
            continue  # the tall grass and the shore scrub are planting, not ground; only the woodland matters here
        geometry = json.loads(r["geometry_json"])
        geom = gspro._zone_geometry_m(geometry)
        if geom is None or geom.is_empty or not geom.intersects(square):
            continue
        features.append({"type": r["type"], "source": r["source"], "attributes": attrs, "geometry": geometry})
    (out_dir / "features.json").write_text(json.dumps(features, separators=(",", ":")) + "\n")


if __name__ == "__main__":
    for name, cut in CUTS.items():
        out_dir = HERE / name
        out_dir.mkdir(exist_ok=True)
        bounds = (cut["e"] - cut["half"], cut["n"] - cut["half"], cut["e"] + cut["half"], cut["n"] + cut["half"])
        for year in ("2025", "2023"):
            cut_photo(out_dir, bounds, year)
        cut_manifest(out_dir)
        cut_stems(out_dir, bounds, cut["drop"])
        cut_features(out_dir, bounds)
        for p in sorted(out_dir.iterdir()):
            print(f"{name}/{p.name:28} {p.stat().st_size:>9}")
