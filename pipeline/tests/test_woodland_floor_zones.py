"""woodland_floor_zones — the floor under the trees by tree kind and terrain
(pipeline/woodland_floor_zones.py). Synthetic 120 m square of deep rough at
0.5 m cells with blocks of trees planted on a 4 m grid."""

import json

import numpy as np
from rasterio.transform import Affine

import woodland_floor_zones as wf
from grass_zones import S_DEEP
from terrain_fields import Fields

CELL = 0.5
N = 240
FAIRWAY, GREEN = 4, 5


def stand(x0, x1, y0, y1, kind, spacing=4.0, radius=2.5):
    """Trees every `spacing` m over the block (metres from the grid's north-west corner)."""
    xs, ys = np.meshgrid(np.arange(x0, x1 + 0.1, spacing), np.arange(y0, y1 + 0.1, spacing))
    n = xs.size
    return wf.Trees(xs.ravel() / CELL, ys.ravel() / CELL, np.full(n, radius), np.full(n, kind))


def lone(x, y, kind=wf.KIND_CONIFER):
    return wf.Trees(np.array([x / CELL]), np.array([y / CELL]), np.array([3.0]), np.array([kind]))


def both(a, b):
    return wf.Trees(*(np.concatenate([getattr(a, f), getattr(b, f)]) for f in ("col", "row", "radius", "kind")))


def course():
    """Deep rough everywhere, a fairway along the west edge (so play is within reach)."""
    cls = np.full((N, N), S_DEEP, dtype=np.uint8)
    cls[:, :10] = FAIRWAY
    return cls


def flat(tpi=0.0, twi=6.0, slope=1.0):
    return Fields(*(np.full((N, N), v, dtype=np.float32) for v in (slope, tpi, twi)))


def weights(*args, reach=200, **kw):
    """floor_weights with play in reach of the whole grid, unless the test is about reach."""
    return wf.floor_weights(*args, reach=reach, **kw)


def share(w, key, x0, x1, y0=40, y1=80):
    """A floor type's share of the floor over a block (a point may sit in a pocket of another)."""
    block = (slice(int(y0 / CELL), int(y1 / CELL)), slice(int(x0 / CELL), int(x1 / CELL)))
    return float(w[key][block].sum() / sum(w[k][block] for k in wf.FLOORS).sum())


def at(x, y):
    return int(y / CELL), int(x / CELL)


def test_the_floor_follows_the_stand_and_lone_trees_keep_the_tall_rough():
    trees = both(stand(40, 80, 40, 80, wf.KIND_CONIFER), lone(105, 105))
    w = weights(course(), CELL, None, trees, fields=flat())
    floor = sum(w[k] for k in wf.FLOORS)
    assert floor[at(60, 60)] > 0.95                       # inside the stand
    assert floor[at(105, 105)] == 0                       # under the lone tree
    assert floor[at(20, 60)] == 0 and floor[at(60, 105)] == 0   # open ground beside the stand
    assert float(floor.max()) <= 1.0 + 1e-5


def test_conifers_on_level_ground_get_bilberry_and_broadleaves_get_herb():
    trees = both(stand(30, 60, 30, 90, wf.KIND_CONIFER), stand(80, 110, 30, 90, wf.KIND_BROADLEAF))
    w = weights(course(), CELL, None, trees, fields=flat())
    assert share(w, wf.BILBERRY, 35, 55) > 0.6 and share(w, wf.HERB, 35, 55) < 0.2
    assert share(w, wf.HERB, 85, 105) > 0.6 and share(w, wf.BILBERRY, 85, 105) < 0.2


def test_a_knoll_under_pines_is_heath_and_a_wet_hollow_is_fern_under_any_trees():
    trees = both(stand(30, 60, 30, 90, wf.KIND_CONIFER), stand(80, 110, 30, 90, wf.KIND_BROADLEAF))
    w = weights(course(), CELL, None, trees, fields=flat(tpi=2.0, twi=4.0))
    assert share(w, wf.HEATH, 35, 55) > 0.6
    assert share(w, wf.HERB, 85, 105) > 0.4                   # a broadleaf knoll stays a dry herb slope

    w = weights(course(), CELL, None, trees, fields=flat(twi=11.0))
    assert share(w, wf.FERN, 35, 55) > 0.6 and share(w, wf.FERN, 85, 105) > 0.6
    w = weights(course(), CELL, None, trees, fields=flat(twi=11.0, slope=15.0))
    assert share(w, wf.FERN, 35, 55) < 0.2                 # water does not stay on a slope


def test_a_floor_holds_pockets_of_the_other_floors():
    trees = stand(20, 110, 20, 110, wf.KIND_CONIFER)
    w = weights(course(), CELL, None, trees, fields=flat())
    inside = (slice(int(40 / CELL), int(90 / CELL)),) * 2
    floor = sum(w[k][inside] for k in wf.FLOORS)
    part = {k: float(w[k][inside].sum() / floor.sum()) for k in wf.FLOORS}
    assert 0.6 < part[wf.BILBERRY] < 0.9                  # still a bilberry floor, with something else in it
    assert sum(1 for k in wf.FLOORS if part[k] > 0.02) >= 3
    assert np.allclose(floor, 1.0, atol=1e-4)             # the pockets take weight, they add none


def test_forest_brush_stands_in_drifts_inside_a_wood_and_not_in_a_corridor():
    # Half the ground under crowns, as in a real stand (Vreta's planted floor: 0.31 over 25 m at the median).
    wood = stand(20, 110, 60, 115, wf.KIND_BROADLEAF, spacing=5.0, radius=2.0)
    corridor = stand(20, 110, 8, 18, wf.KIND_BROADLEAF, spacing=5.0, radius=2.0)     # three rows of trees between two holes
    w = weights(course(), CELL, None, both(wood, corridor), fields=flat())
    brush = w[wf.BRUSH]
    inside = brush[int(75 / CELL):int(110 / CELL), int(40 / CELL):int(100 / CELL)]
    assert inside.max() > 0.9 and 0.2 < float((inside > 0.5).mean()) < 0.8     # here and there
    assert brush[int(4 / CELL):int(20 / CELL)].max() < 0.1
    assert sum(w[k] for k in wf.FLOORS)[at(60, 13)] > 0.5                       # the corridor still has its floor


def test_the_edge_brush_rings_the_stand_and_not_a_lone_tree():
    trees = both(stand(40, 80, 40, 80, wf.KIND_BROADLEAF), lone(110, 110, wf.KIND_BROADLEAF))
    edge = weights(course(), CELL, None, trees, fields=flat())[wf.EDGE]
    row = edge[at(60, 60)[0]]
    assert row[int(60 / CELL)] == 0                       # none in the middle of the stand
    assert row[int(80 / CELL):int(95 / CELL)].max() > 0.6     # a band along its east rim
    assert row[int(105 / CELL):].max() == 0               # gone a stand's width out
    assert edge[at(110, 110)] < 0.1                       # the lone tree has no brush


def test_the_floor_keeps_off_play_and_stays_within_reach():
    cls = course()
    cls[100:140, 100:140] = GREEN                         # 50..70 m
    trees = stand(20, 100, 20, 100, wf.KIND_CONIFER)
    floor = sum(weights(cls, CELL, None, trees, fields=flat())[k] for k in wf.FLOORS)
    assert floor[cls == GREEN].max() == 0
    assert floor[at(47, 60)] == 0                         # 4 m clearance from the green
    assert floor[at(30, 30)] > 0.9
    assert wf.DEFAULT_REACH_M == 50                       # the floor is geometry: not far out from play

    floor = sum(weights(course(), CELL, None, trees, fields=flat(), reach=40)[k] for k in wf.FLOORS)
    assert floor[at(25, 60)] > 0.5                        # 20 m from the fairway: on the reach ramp
    assert floor[at(60, 60)] == 0                         # 55 m from it


def test_bands_nest_and_the_edge_is_written_as_a_mix_zone():
    trees = stand(40, 80, 40, 80, wf.KIND_CONIFER)
    w = weights(course(), CELL, None, trees, fields=flat())
    transform = Affine(CELL, 0, 500000.0, 0, -CELL, 6400000.0)
    slots = [(k, wf.bands(w[k], transform)) for k in (wf.BILBERRY, wf.EDGE)]
    assert [level for level, _ in slots[0][1]] == [0.2, 0.5, 1.0]
    areas = [g.area for _, g in slots[0][1]]
    assert areas == sorted(areas, reverse=True) and areas[-1] > 1000
    fc = wf.feature_collection(slots, "woodland-floor")
    json.dumps(fc)
    by = {}
    for f in fc["features"]:
        by.setdefault(f["properties"]["zoneVariant"], []).append(f["properties"])
    assert all(p["zoneType"] == "woodland_floor" and "blend" not in p for p in by[wf.BILBERRY])
    assert by[wf.EDGE] and all(p["blend"] == "mix" for p in by[wf.EDGE])


def test_a_tree_area_of_one_kind_overrides_the_stems_inside_it(tmp_path):
    doc = {"format": "unity-trees-v1", "plot": {"originX": 500000.0, "originY": 6399880.0},
           "trees": [{"x": 30.0, "z": 90.0, "r": 2.0, "k": 0}, {"x": 90.0, "z": 30.0, "r": 2.0, "k": 0}],
           "areas": [{"species": [{"species": "pine", "weight": 1.0}],
                      "rings": [{"nodes": [{"x": 20, "z": 80}, {"x": 40, "z": 80}, {"x": 40, "z": 100}, {"x": 20, "z": 100}]}]}]}
    path = tmp_path / "t-inner-trees.json"
    path.write_text(json.dumps(doc))
    trees = wf.load_trees(path, CELL, 500000.0, 6400000.0, (N, N))
    assert list(trees.kind) == [wf.KIND_CONIFER, wf.KIND_BROADLEAF]
    assert (trees.col[0], trees.row[0]) == (60.0, 60.0)      # 30 m east, 90 m north of the south-west corner
