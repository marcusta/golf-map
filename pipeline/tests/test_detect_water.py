"""detect-water tests — fully offline. Synthetic LAS point clouds (the
offset-safe _write_las pattern from test_detect_trees.py) model the class-9
reality over open water: returns are SPARSE (water absorbs NIR), so ponds
show up as scattered presence cells that the generous binary closing must
knit into one polygon each.

Scene: two sparse ponds that must stay two polygons, a compact class-9
speck under --min-area, and class-2 ground everywhere (which must never
become water).
"""

from __future__ import annotations

import json
from pathlib import Path

import laspy
import numpy as np
import pytest
from shapely.geometry import Polygon

from golfpipe import detect_water, grid_dem
from golfpipe.__main__ import main
from golfpipe.commands import cmd_detect_water

# Scene anchored at realistic SWEREF99 TM coordinates so the "output is
# EPSG:3006 metres" assertions are meaningful.
E0, N0 = 531000.0, 6473000.0
SIZE = 40  # 40x40 m scene at 1 m resolution
BBOX_3006 = (E0, N0, E0 + SIZE, N0 + SIZE)

GROUND_Z = 10.0
POND_Z = 9.4  # water surface below the banks


def _write_las(path: Path, x, y, z, classification, point_format: int = 3) -> Path:
    header = laspy.LasHeader(point_format=point_format, version="1.2")
    # Offsets at the data minimum so realistic EPSG:3006 coordinates
    # (~6.47e6 m northing) fit int32 at 1 mm scale.
    header.offsets = [float(np.min(np.asarray(v, dtype=np.float64))) for v in (x, y, z)]
    header.scales = [0.001, 0.001, 0.001]

    las = laspy.LasData(header)
    las.x = np.asarray(x, dtype=np.float64)
    las.y = np.asarray(y, dtype=np.float64)
    las.z = np.asarray(z, dtype=np.float64)
    las.classification = np.asarray(classification, dtype=np.uint8)
    las.write(str(path))
    return path


def _block(x0: int, x1: int, y0: int, y1: int, step: int = 1) -> tuple[np.ndarray, np.ndarray]:
    """Cell-center coordinates for the cell block [x0,x1) x [y0,y1) (cell
    units relative to the scene origin), optionally subsampled every `step`
    cells to model sparse water returns."""
    xs, ys = np.meshgrid(np.arange(x0, x1, step) + 0.5, np.arange(y0, y1, step) + 0.5)
    return E0 + xs.ravel(), N0 + ys.ravel()


@pytest.fixture
def scene_las(tmp_path: Path) -> Path:
    """Sparse-water scene at 1 m resolution:
    - ground (class 2) at z=10 everywhere — must never become water;
    - pond A (class 9, z=9.4): SPARSE returns every 3rd cell over
      [5,17)x[5,17) — 16 scattered presence cells the 3 m closing must knit
      into ONE polygon;
    - pond B (class 9, z=9.6): sparse returns every 3rd cell over
      [26,38)x[24,36) — more than 2x the closing radius from pond A, so it
      must stay a SEPARATE polygon;
    - speck (class 9, z=9.5): solid 4x4 block [24,28)x[3,7) = 16 m² —
      survives morphology but falls under the 50 m² --min-area filter.
    """
    xs, ys, zs, cls = [], [], [], []

    def add(bx, by, z, c):
        xs.append(bx)
        ys.append(by)
        zs.append(np.full(bx.shape, z))
        cls.append(np.full(bx.shape, c, dtype=np.uint8))

    add(*_block(0, SIZE, 0, SIZE), GROUND_Z, 2)
    add(*_block(5, 17, 5, 17, step=3), POND_Z, 9)
    add(*_block(26, 38, 24, 36, step=3), 9.6, 9)
    add(*_block(24, 28, 3, 7), 9.5, 9)

    return _write_las(
        tmp_path / "scene.las",
        np.concatenate(xs), np.concatenate(ys), np.concatenate(zs), np.concatenate(cls),
    )


# ─── water_mask building block ───────────────────────────────────────────────

def test_water_mask_closes_sparse_returns_and_kills_strays():
    count = np.zeros((30, 30))
    # Sparse pond: presence every 3rd cell in [5,17) x [5,17).
    count[5:17:3, 5:17:3] = 1.0
    # Lone stray class-9 return far from anything.
    count[25, 25] = 3.0

    mask = detect_water.water_mask(count, resolution=1.0, closing_radius_m=3.0)

    # The scattered pond cells knit into ONE solid body: the interior of the
    # sampled extent is filled (the final opening scallops the outermost
    # sample ring — fine, min-area works on the body) and it is a single
    # 8-connected component.
    assert mask[6:14, 6:14].all()
    from scipy.ndimage import label

    _, n_components = label(mask, structure=np.ones((3, 3)))
    assert n_components == 1
    # The stray single cell cannot merge with anything — opening kills it.
    assert not mask[20:30, 20:30].any()


def test_water_mask_small_closing_radius_leaves_sparse_cells_apart():
    count = np.zeros((30, 30))
    count[5:17:3, 5:17:3] = 1.0

    # Radius below half the sampling gap: nothing bridges, and the 3x3
    # opening then wipes the isolated single cells entirely.
    mask = detect_water.water_mask(count, resolution=1.0, closing_radius_m=1.0)
    assert not mask.any()


def test_disk_structure_is_round():
    disk = detect_water.disk_structure(3)
    assert disk.shape == (7, 7)
    assert disk[3, 3] and disk[0, 3] and disk[3, 0]
    assert not disk[0, 0]  # corners outside the radius


# ─── flatness sanity check (report-only) ─────────────────────────────────────

def test_flatness_spreads_reports_but_never_filters(tmp_path: Path, capsys):
    """A tilted 'pond' (z ramps 1 m across it) must trigger the printed
    warning yet still appear in the output collection."""
    bx, by = _block(4, 18, 4, 18, step=2)
    z = 9.0 + 0.1 * (bx - E0 - 4.0)  # 0 .. ~1.2 m ramp — way over 0.3 m
    gx, gy = _block(0, 20, 0, 20)
    las = _write_las(
        tmp_path / "tilted.las",
        np.concatenate([gx, bx]), np.concatenate([gy, by]),
        np.concatenate([np.full(gx.shape, GROUND_Z), z]),
        np.concatenate([np.full(gx.shape, 2, dtype=np.uint8), np.full(bx.shape, 9, dtype=np.uint8)]),
    )

    out = tmp_path / "water.geojson"
    cmd_detect_water([las], (E0, N0, E0 + 20, N0 + 20), out, resolution=1.0)

    printed = capsys.readouterr().out
    assert "z-spread" in printed and "kept anyway" in printed
    collection = json.loads(out.read_text(encoding="utf-8"))
    assert len(collection["features"]) == 1  # warned about, NOT dropped


# ─── end-to-end command ──────────────────────────────────────────────────────

def test_cmd_detect_water_end_to_end(tmp_path: Path, scene_las: Path, capsys):
    out = tmp_path / "water.geojson"
    cmd_detect_water([scene_las], BBOX_3006, out, resolution=1.0)

    collection = json.loads(out.read_text(encoding="utf-8"))
    assert collection["crs"]["properties"]["name"].endswith("EPSG::3006")
    assert "Laserdata Skog" in collection["attribution"]

    # Exactly two ponds: sparse pond A closed into one polygon, pond B a
    # separate one, the 16 m² speck dropped by min-area, and the class-2
    # ground contributing nothing.
    assert len(collection["features"]) == 2
    polygons = []
    for feature in collection["features"]:
        assert feature["properties"]["type"] == "water"
        assert feature["properties"]["source"] == "lidar-class9"
        rings = feature["geometry"]["coordinates"]
        polygons.append(Polygon(rings[0], rings[1:]))
        # Output coordinates are EPSG:3006 metres inside the scene bbox.
        for ring in rings:
            for x, y in ring:
                assert E0 <= x <= E0 + SIZE and N0 <= y <= N0 + SIZE

    polygons.sort(key=lambda p: p.centroid.x)
    pond_a, pond_b = polygons
    # Pond A returns span [5,15]x[5,15]; the closed body covers that extent
    # (loose bounds — closing rounds the outline).
    assert pond_a.area >= 50.0
    assert E0 + 5 <= pond_a.centroid.x <= E0 + 17
    assert N0 + 5 <= pond_a.centroid.y <= N0 + 17
    assert pond_b.area >= 50.0
    assert E0 + 24 <= pond_b.centroid.x <= E0 + 38

    # Flat ponds: no flatness warning fired.
    printed = capsys.readouterr().out
    assert "z-spread" not in printed
    assert "Wrote" in printed


def test_cmd_detect_water_ground_only_is_empty(tmp_path: Path, capsys):
    gx, gy = _block(0, 20, 0, 20)
    las = _write_las(tmp_path / "ground.las", gx, gy, np.full(gx.shape, GROUND_Z), np.full(gx.shape, 2, dtype=np.uint8))

    out = tmp_path / "water.geojson"
    cmd_detect_water([las], (E0, N0, E0 + 20, N0 + 20), out, resolution=1.0)

    collection = json.loads(out.read_text(encoding="utf-8"))
    assert collection["features"] == []
    assert "no water found" in capsys.readouterr().out


def test_detect_water_cli_dispatch(tmp_path: Path, scene_las: Path):
    out = tmp_path / "water.geojson"
    code = main([
        "detect-water",
        "--lidar", str(scene_las),
        "--bbox-3006", ",".join(str(v) for v in BBOX_3006),
        "--resolution", "1.0",
        "--closing-radius", "3.0",
        "--out", str(out),
    ])
    assert code == 0
    assert out.exists()
    # grid_dem's DEFAULT_CLASSES still includes water — detect-water and
    # grid-dem read the same class 9, one as terrain, one as presence.
    assert 9 in grid_dem.DEFAULT_CLASSES
