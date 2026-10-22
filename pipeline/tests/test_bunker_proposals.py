"""bunker_proposals: the surface model's bunker pieces, edges redrawn from the NIR band. Synthetic rasters only: a
photo with sand ellipses on grass, a coarser model raster whose pieces are a little too big, drawn bunkers."""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest
import rasterio
from rasterio.crs import CRS
from rasterio.transform import from_origin
from shapely.geometry import Point, Polygon
from shapely.affinity import scale

from golfpipe import bunker_proposals as bp
from golfpipe.surface_model import CLASSES

CRS3006 = CRS.from_epsg(3006)
X0, Y0 = 533000.0, 6475000.0
SIZE_M = 80.0
BUNKER = CLASSES.index("bunker")
FAIRWAY = CLASSES.index("fairway")

# (centre, semi-axes) of the sand in the photo, metres from the top-left corner
SAND = {"found": ((20.0, 20.0), (4.0, 2.5)), "outside": ((60.0, 20.0), (3.0, 2.0)),
        "drawn": ((20.0, 60.0), (3.5, 2.5))}
GRASS_ONLY = ((60.0, 60.0), (3.0, 2.0))  # the model says bunker, the photo shows grass


def ellipse(centre, axes, grow=0.0) -> Polygon:
    (cx, cy), (a, b) = centre, axes
    return scale(Point(X0 + cx, Y0 - cy).buffer(1.0, 64), a + grow, b + grow)


def write(path: Path, bands: np.ndarray, res: float) -> Path:
    with rasterio.open(path, "w", driver="GTiff", width=bands.shape[2], height=bands.shape[1], count=bands.shape[0],
                       dtype=bands.dtype, crs=CRS3006, transform=from_origin(X0, Y0, res, res)) as d:
        d.write(bands)
    return path


def inside(shape_px, res, poly: Polygon) -> np.ndarray:
    from rasterio.features import rasterize
    return rasterize([(poly, 1)], out_shape=shape_px, transform=from_origin(X0, Y0, res, res), dtype="uint8") > 0


@pytest.fixture
def site(tmp_path: Path) -> dict:
    n = int(SIZE_M / 0.16)
    rgb = np.empty((3, n, n), dtype=np.uint8)
    rgb[0], rgb[1], rgb[2] = 70, 110, 60
    nir = np.full((1, n, n), 150, dtype=np.uint8)
    for centre, axes in SAND.values():
        m = inside((n, n), 0.16, ellipse(centre, axes))
        rgb[:, m] = np.array([220, 210, 180])[:, None]
        nir[0, m] = 200
    ortho = write(tmp_path / "ortho.tif", rgb, 0.16)
    write(tmp_path / "ortho.nir.tif", nir, 0.16)
    k = int(SIZE_M / 0.32)
    cls = np.full((k, k), FAIRWAY, dtype=np.uint8)
    course = cls.copy()
    for name, (centre, axes) in list(SAND.items()) + [("grass", GRASS_ONLY)]:
        m = inside((k, k), 0.32, ellipse(centre, axes, grow=0.5))  # the model's piece: a little too big
        course[m] = BUNKER
        cls[m] = BUNKER
    cls[inside((k, k), 0.32, ellipse(SAND["outside"][0], (8.0, 8.0)))] = 0  # the model: not course here
    conf = np.full((k, k), 200, dtype=np.uint8)
    surfaces = write(tmp_path / "surfaces.tif", np.stack([cls, conf, course, conf]), 0.32)
    return {"ortho": ortho, "nir": tmp_path / "ortho.nir.tif", "surfaces": surfaces}


def test_found_bunker_gets_the_sands_edge_not_the_models(site):
    known = [ellipse(*SAND["drawn"])]
    fc = bp.propose(site["surfaces"], site["ortho"], site["nir"], known)
    by_edge = {f["properties"]["edge"]: f for f in fc["features"]}
    sand = ellipse(*SAND["found"])
    nir_one = Polygon(by_edge["nir"]["geometry"]["coordinates"][0])
    assert nir_one.intersection(sand).area / nir_one.union(sand).area > 0.9
    assert abs(nir_one.area - sand.area) / sand.area < 0.12  # the model's piece is ~25 % bigger
    assert by_edge["nir"]["properties"]["id"].startswith("bk-")
    assert 0.0 < by_edge["nir"]["properties"]["confidence"] <= 1.0


def test_left_out_drawn_and_not_course(site):
    fc = bp.propose(site["surfaces"], site["ortho"], site["nir"], [ellipse(*SAND["drawn"])])
    assert fc["skipped"]["drawn"] == 1
    assert fc["skipped"]["notCourse"] == 1
    centres = [Polygon(f["geometry"]["coordinates"][0]).centroid for f in fc["features"]]
    assert all(c.distance(ellipse(*SAND["drawn"]).centroid) > 5 for c in centres)


def test_no_sand_in_the_photo_keeps_the_models_outline(site):
    fc = bp.propose(site["surfaces"], site["ortho"], site["nir"], [])
    grass = [f for f in fc["features"]
             if Polygon(f["geometry"]["coordinates"][0]).centroid.distance(ellipse(*GRASS_ONLY).centroid) < 1]
    assert len(grass) == 1
    assert grass[0]["properties"]["edge"] == "model"


def test_small_pieces_are_left_out(site):
    fc = bp.propose(site["surfaces"], site["ortho"], site["nir"], [], min_area_m2=100.0)
    assert fc["features"] == []
    assert fc["skipped"]["small"] >= 3


def test_known_reads_epsg3006_geojson(tmp_path):
    poly = ellipse(*SAND["drawn"])
    path = tmp_path / "known.geojson"
    path.write_text(json.dumps({"type": "FeatureCollection", "features": [
        {"type": "Feature", "properties": {}, "geometry": {"type": "Polygon",
                                                           "coordinates": [list(poly.exterior.coords)]}}]}))
    (got,) = bp.load_known(path)
    assert got.symmetric_difference(poly).area < 1e-6
