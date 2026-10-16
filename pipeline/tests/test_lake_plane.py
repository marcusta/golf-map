"""golfpipe lake-plane: a big lake's water surface as Unity meshes (golfpipe/lake_plane.py)."""

import json

import numpy as np
from shapely.geometry import Polygon, box

from golfpipe import lake_plane


def _signed_area_xz(verts, tris):
    a, b, c = verts[tris[0::3]], verts[tris[1::3]], verts[tris[2::3]]
    return (b[:, 0] - a[:, 0]) * (c[:, 1] - a[:, 1]) - (c[:, 0] - a[:, 0]) * (b[:, 1] - a[:, 1])


def _cell_centres(mesh):
    v = np.asarray(mesh["vertices"]).reshape(-1, 2)
    t = np.asarray(mesh["triangles"]).reshape(-1, 6)
    # Each cell is two triangles sw-nw-se, nw-ne-se: its centre is the mean of sw, nw, ne, se.
    corners = v[t[:, [0, 1, 4, 2]]]
    return {tuple(np.round(c, 3)) for c in corners.mean(axis=1)}


def test_cells_wind_clockwise_from_above_in_the_unity_frame():
    verts, tris, cells = lake_plane.cell_mesh(box(100, 200, 110, 206), (100, 200), (10, 6), 2.0, (100, 200))
    assert cells == 15
    assert len(verts) == 6 * 4
    assert (_signed_area_xz(verts, tris) < 0).all()   # Unity: clockwise seen from +y is the front
    assert verts[:, 0].min() == 0 and verts[:, 1].max() == 6


def test_exclude_drops_the_finer_zones_cells():
    _, _, cells = lake_plane.cell_mesh(box(0, 0, 100, 100), (0, 0), (100, 100), 10.0, (0, 0), exclude=(20, 20, 60, 60))
    assert cells == 100 - 16


def _squares():
    inner = {"square": [1000.0, 1000.0, 1300.0, 1300.0], "minM": 80.0, "y": 0.0}
    outer = {"square": [0.0, 0.0, 2300.0, 2300.0], "minM": 80.0, "y": -1.2}
    return inner, outer


def test_zones_tile_the_lake_without_overlap_and_the_surface_sits_on_the_level():
    inner, outer = _squares()
    lake = box(-2000, -2000, 1100, 4000)            # the west half: open water past both squares
    doc = lake_plane.build_lake_plane(lake, None, inner, outer, 88.0, name="T", radius_m=2000,
                                      near_margin_m=40, near_cell_m=2, outer_cell_m=10, far_cell_m=25, log=lambda *_: None)
    assert doc["surfaceY"] == 8.0
    roles = [m["role"] for m in doc["meshes"]]
    assert roles == ["near", "outer", "far"]
    near, outer_m, far = doc["meshes"]
    nv = np.asarray(near["vertices"]).reshape(-1, 2)
    # The near zone is the inner square plus the margin, snapped out to the 10 m grid.
    assert nv[:, 0].min() >= -50 and nv[:, 1].max() <= 350
    # No coarse cell centre lies inside a finer zone's box.
    nb = (nv[:, 0].min(), nv[:, 1].min(), nv[:, 0].max(), nv[:, 1].max())
    for c in _cell_centres(outer_m):
        assert not (nb[0] < c[0] < nb[2] and nb[1] < c[1] < nb[3])
    for c in _cell_centres(far):
        assert not (-1000 < c[0] < 1300 and -1000 < c[1] < 1300)   # the outer square in the frame
    # The plane runs under the bank: up to under_bank_m + a cell past the shore at E 1100, never far onto land.
    assert nv[:, 0].max() <= 1100 + lake_plane.DEFAULT_UNDER_BANK_M + 2 - 1000
    assert doc["collider"]["role"] == "collider"
    assert 0 < doc["probe"]["x"] < 100 and doc["probe"]["y"] == 8.0 + lake_plane.PROBE_ABOVE_M


def test_hydro_takes_over_outside_the_known_squares():
    inner, outer = _squares()
    shore = box(0, 0, 1100, 2300)                  # worked out inside the outer square only
    hydro = Polygon([(-3000, -3000), (1100, -3000), (1100, 5000), (-3000, 5000)])
    doc = lake_plane.build_lake_plane(shore, hydro, inner, outer, 88.0, name="T", radius_m=2000, log=lambda *_: None)
    far = next(m for m in doc["meshes"] if m["role"] == "far")
    fv = np.asarray(far["vertices"]).reshape(-1, 2)
    assert fv[:, 1].min() < -1000 - 500            # south of the outer square, from Hydrografi
    assert doc["areaKm2"] > 3


def test_read_shore_takes_the_dte5_edit_and_its_level(tmp_path):
    from rasterio.warp import transform_geom
    from shapely.geometry import mapping
    poly = box(477000, 6457000, 477200, 6457300)
    wgs = transform_geom("EPSG:3006", "EPSG:4326", mapping(poly))
    path = tmp_path / "shore-edits.geojson"
    path.write_text(json.dumps({"type": "FeatureCollection", "features": [
        {"type": "Feature", "geometry": wgs, "properties": {"op": "shore", "levelM": 88.762}}]}))
    shore, level = lake_plane.read_shore(path)
    assert level == 88.762
    assert abs(shore.area - poly.area) < 1.0


def test_shore_distance_grid_measures_from_land_islands_included():
    import base64
    lake = box(0, 0, 100, 100).difference(box(60, 40, 70, 50))   # a 10 m island
    g = lake_plane.shore_distance_grid(lake, box(-50, -50, 150, 150), (0, 0))
    q = np.frombuffer(base64.b64decode(g["data"]), np.uint8).reshape(g["height"], g["width"]) * g["stepM"]
    def at(x, z):
        return q[int((z - g["z0"]) / g["cellM"]), int((x - g["x0"]) / g["cellM"])]
    assert at(-0.5, 50) == 0                      # outside the lake: land
    assert 9 <= at(10.5, 50) <= 11.5              # 10 m in from the west shore
    assert at(65, 45) == 0                        # on the island
    assert 4 <= at(75.5, 45) <= 6                 # 5 m off the island
    assert at(50, 98.5) < 2.5                     # the north shore


def test_low_ground_beside_the_lake_is_covered_an_inland_hollow_is_not(tmp_path):
    import rasterio
    from rasterio.transform import from_origin
    z = np.full((40, 40), 90.0, np.float32)          # 1 m cells, E 0..40, N 0..40, ground 90 m
    z[:, :10] = 87.0                                  # the lake, E 0..10
    z[10:20, 10:16] = 88.5                            # a low bank beside it, under the 88.76 surface
    z[30:34, 30:34] = 88.0                            # a hollow inland, not touching the lake
    path = tmp_path / "dem.tif"
    with rasterio.open(path, "w", driver="GTiff", width=40, height=40, count=1, dtype="float32",
                       crs="EPSG:3006", transform=from_origin(0, 40, 1, 1)) as dst:
        dst.write(z, 1)
    low = lake_plane.low_ground(path, 88.76, box(0, 0, 10, 40))
    assert low is not None
    assert abs(low.area - 60) < 1                     # the bank, 6 x 10 m
    assert not low.intersects(box(30, 6, 34, 10))     # the hollow (rows 30-34 = N 6-10)
    sunk = lake_plane.low_ground(path, 88.76, box(0, 0, 10, 40), sink_m=1.5)   # 90 - 1.5 < 88.76: all of it
    assert sunk.area > 1000
