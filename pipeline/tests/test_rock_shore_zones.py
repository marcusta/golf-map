"""rock_shore_zones — the rocky lake shore: grass in the cracks, heath, scrub against the
rock and grass under it (pipeline/rock_shore_zones.py). Synthetic 120 m square at 0.5 m
cells: a lake along the west edge, a rock slab on its shore, deep rough inland."""

import json

import numpy as np
from rasterio.transform import Affine

import rock_shore_zones as rs
from grass_zones import S_DEEP, S_SLAB, S_WATER

CELL = 0.5
N = 240
GREEN, FAIRWAY = 5, 4


def at(x, y):
    """Row, column of the cell x metres east and y metres south of the grid's north-west corner."""
    return int(y / CELL), int(x / CELL)


def block(x0, x1, y0, y1):
    return slice(int(y0 / CELL), int(y1 / CELL)), slice(int(x0 / CELL), int(x1 / CELL))


def shore(lake_m=20):
    """The lake west of `lake_m` m, a slab 20..40 m east and 30..90 m south, deep rough elsewhere."""
    cls = np.full((N, N), S_DEEP, dtype=np.uint8)
    cls[:, : int(lake_m / CELL)] = S_WATER
    cls[block(20, 40, 30, 90)] = S_SLAB
    return cls


def flat():
    return np.zeros((N, N), dtype=np.float32)


def weights(*args, **kw):
    """shore_weights with a lake the size of this little grid (the default wants 2 ha)."""
    kw.setdefault("lake_min_m2", 1000.0)
    return rs.shore_weights(*args, **kw)


def slab_mask(cls):
    return cls == S_SLAB


def test_crack_grass_grows_on_about_a_third_of_the_slab_and_its_edge_and_nowhere_else_inland():
    cls = shore()
    w = weights(cls, CELL, flat())
    crack = w[rs.CRACK]
    slab = slab_mask(cls)
    covered = float((crack[slab] >= 0.5).mean())
    assert 0.33 < covered < 0.6                              # the patches' 35 % plus the fringe over the edge
    # the fringe: the slab's edge cells are under grass nearly all the way round (0 .. 2x by noise)
    edge = slab.copy()
    edge[1:-1, 1:-1] &= ~(slab[:-2, 1:-1] & slab[2:, 1:-1] & slab[1:-1, :-2] & slab[1:-1, 2:])
    assert (crack[edge] > 0.99).mean() > 0.85
    # beyond the skirt (at most twice CRACK_SKIRT_M off the rock) no crack grass on land
    assert crack[block(43, 120, 0, 120)].max() == 0
    assert crack[cls == S_WATER].max() == 0


def test_cracks_favour_ledges_and_leave_the_faces_bare():
    cls = shore()
    z = flat()
    # the slab's southern half is a 50 degree slope, a 2 m strip in it a 75 degree face
    rows = np.arange(N)[:, None] * CELL
    z += np.where(rows > 60, (rows - 60) * np.tan(np.radians(50)), 0.0).astype(np.float32)
    w = weights(cls, CELL, z)
    crack = w[rs.CRACK]
    ledge, steep = block(24, 36, 34, 56), block(24, 36, 64, 86)
    assert crack[ledge].mean() > 2 * crack[steep].mean()

    z2 = flat() + np.where(rows > 60, (rows - 60) * np.tan(np.radians(75)), 0.0).astype(np.float32)
    w = weights(cls, CELL, z2)
    assert w[rs.CRACK][block(22, 38, 64, 86)].max() == 0      # a face: nothing grows on it
    assert w[rs.HEATH][block(22, 38, 64, 86)].max() == 0


def test_scrub_hugs_the_rock_on_land_thinning_inland_with_grass_under_it():
    cls = shore()
    w = weights(cls, CELL, flat())
    scrub, grass = w[rs.SCRUB], w[rs.GRASS]
    assert scrub[slab_mask(cls)].max() == 0 and scrub[cls == S_WATER].max() == 0
    near, far = block(41.5, 43, 35, 85), block(46, 48, 35, 85)    # 1.5-3 m and 6-8 m off the slab's east edge
    assert scrub[near].mean() > 0.6
    assert scrub[near].mean() > 1.8 * scrub[far].mean() > 0
    assert scrub[block(52, 120, 0, 120)].max() == 0              # beyond the band (and 10 m from the slab)
    # the grass is everywhere the scrub is, and between its clumps too
    band = block(41, 48, 35, 85)
    assert (grass[band] >= scrub[band] - 1e-6).all()
    assert (grass[band] > 0.3).mean() > (scrub[band] > 0.3).mean()
    # heath on the thin soil just outside the rock, not out in the band
    assert w[rs.HEATH][block(40.5, 43, 30, 90)].max() > 0.9
    assert w[rs.HEATH][block(44.5, 120, 0, 120)].max() == 0


def test_a_rock_away_from_the_lake_or_by_a_pond_gets_nothing():
    cls = np.full((N, N), S_DEEP, dtype=np.uint8)
    cls[:, :40] = S_WATER                                        # the lake
    cls[block(95, 110, 40, 60)] = S_SLAB                         # 55 m from it: a rock in the woods
    w = weights(cls, CELL, flat())
    assert all(v.max() == 0 for v in w.values())

    cls = shore(lake_m=0)
    cls[block(10, 18, 50, 60)] = S_WATER                         # 80 m2: a pond is no lake
    w = weights(cls, CELL, flat())
    assert all(v.max() == 0 for v in w.values())

    cls = shore()
    cls[cls == S_SLAB] = S_DEEP                                  # no rock: no rocky shore
    w = weights(cls, CELL, flat())
    assert all(v.max() == 0 for v in w.values())


def test_along_the_lake_the_scrub_runs_beside_the_rock_but_stops_ten_metres_from_it():
    cls = shore()
    w = weights(cls, CELL, flat())
    scrub = w[rs.SCRUB]
    assert scrub[block(20, 30, 92, 98)].mean() > 0.2           # the shore just south of the slab
    assert scrub[block(20, 40, 103, 120)].max() == 0            # more than 10 m from the slab


def test_the_shore_keeps_off_play():
    cls = shore()
    cls[block(44, 60, 50, 70)] = GREEN                           # a green 4 m off the rock
    w = weights(cls, CELL, flat())
    for k in rs.VARIANTS:
        assert w[k][cls == GREEN].max() == 0
        assert w[k][block(41, 43.5, 52, 68)].max() == 0          # within 4 m of the green: nothing
    assert w[rs.CRACK][block(20, 39, 52, 68)].max() == 1.0       # the rock further off keeps its cracks

    blocked = np.zeros((N, N), dtype=bool)
    blocked[block(42, 50, 30, 90)] = True                        # a house beside the rock
    w = weights(shore(), CELL, flat(), blocked)
    assert w[rs.SCRUB][block(42, 50, 30, 90)].max() == 0


def test_bands_nest_and_the_crack_and_grass_layers_are_mix_zones():
    w = weights(shore(), CELL, flat())
    transform = Affine(CELL, 0, 500000.0, 0, -CELL, 6400000.0)
    slots = [(k, rs.bands(w[k], transform, rs.MIN_AREA_M2[k])) for k in rs.VARIANTS]
    for _, b in slots:
        assert [level for level, _ in b] == [0.1, 0.3, 0.5, 0.7, 1.0]
        areas = [g.area for _, g in b]
        assert areas == sorted(areas, reverse=True) and areas[0] > 0
    fc = rs.feature_collection(slots, "rock-shore")
    json.dumps(fc)
    by = {}
    for f in fc["features"]:
        p = f["properties"]
        assert p["zoneType"] == "rock_shore" and p["source"] == "rock-shore"
        by.setdefault(p["zoneVariant"], []).append(p)
    assert set(by) == set(rs.VARIANTS)
    assert all(p["blend"] == "mix" for k in rs.MIX_LAYERS for p in by[k])
    assert all("blend" not in p for k in (rs.SCRUB, rs.HEATH) for p in by[k])
    # the stack: scrub at the bottom, the heath patches above it, then the mix layers
    order = [f["properties"]["zoneVariant"] for f in fc["features"]]
    assert order.index(rs.HEATH) > max(i for i, v in enumerate(order) if v == rs.SCRUB)
