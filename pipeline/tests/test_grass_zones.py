"""grass_zones — where tall grass may grow, by rule (pipeline/grass_zones.py).

Plain shapely geometry in metres; each test states one rule of the module doc.
"""

from shapely.geometry import LineString, Point, box, shape

import pytest

import grass_zones as gz

RULES = gz.Rules(max_distance=75, spill=5, building_margin=4, road_margin=1.5, min_area=1, simplify=0, clearance=0)


def area_of(surfaces, buildings=(), roads=(), rules=RULES):
    return gz.tall_grass_area(list(surfaces), list(buildings), list(roads), rules).area


def test_grows_on_visible_deep_rough_only():
    deep = box(0, 0, 100, 40)
    a = area_of([("rough", box(-50, -50, 150, 90)), ("deep_rough", deep)])
    assert a.buffer(-0.01).within(deep.buffer(5.01))
    assert a.contains(Point(50, 20))


def test_surfaces_painted_on_top_cut_it_out():
    deep = box(0, 0, 100, 40)
    for kind in ("tee", "fairway", "green", "semi_rough", "bunker", "path", "water", "rough"):
        on_top = box(40, 10, 60, 30)
        a = area_of([("deep_rough", deep), (kind, on_top), ("rough", box(200, 0, 210, 10))])
        assert not a.contains(Point(50, 20)), kind


def test_deep_rough_painted_over_a_fairway_is_deep_rough():
    a = area_of([("fairway", box(0, 0, 100, 40)), ("deep_rough", box(20, 0, 80, 40))])
    assert a.contains(Point(50, 20))


def test_spills_a_little_into_rough_but_not_into_other_surfaces():
    deep = box(0, 0, 100, 40)
    a = area_of([("rough", box(-50, 0, 0, 40)), ("fairway", box(100, 0, 150, 40)), ("deep_rough", deep)])
    assert a.contains(Point(-3, 20))        # 3 m into the rough
    assert not a.contains(Point(-7, 20))    # beyond the 5 m spill
    assert not a.contains(Point(102, 20))   # never onto the fairway


def test_not_further_than_max_distance_from_play():
    deep = box(0, 0, 300, 40)                # runs 300 m away from the only fairway
    a = area_of([("fairway", box(-20, 0, 0, 40)), ("deep_rough", deep)])
    assert a.contains(Point(70, 20))
    assert not a.contains(Point(80, 20))


def test_keeps_off_buildings_and_roads():
    deep = box(0, 0, 100, 100)
    house = box(40, 40, 50, 50)
    road = (LineString([(0, 80), (100, 80)]), 6.0)
    a = area_of([("rough", box(-10, -10, 110, 110)), ("deep_rough", deep)], [house], [road])
    assert not a.contains(Point(45, 45))
    assert not a.contains(Point(47, 53))    # within the 4 m building margin
    assert not a.contains(Point(20, 80))    # on the road
    assert not a.contains(Point(20, 84))    # 3 m half width + 1.5 m margin
    assert a.contains(Point(20, 60))


def test_feature_collection_is_one_zone_per_polygon_with_holes():
    deep = box(0, 0, 100, 100)
    a = area_of([("rough", box(-10, -10, 110, 110)), ("deep_rough", deep), ("green", box(40, 40, 60, 60)),
                 ("deep_rough", box(300, 0, 320, 20)), ("fairway", box(330, 0, 340, 20))])
    fc = gz.feature_collection(a, "rough_tall", "tall-grass", 1.0, 4.0, 2.0)
    assert len(fc["features"]) == 2
    big = fc["features"][0]
    assert len(big["geometry"]["coordinates"]) == 2          # exterior + the green's hole
    assert big["properties"] == {**big["properties"], "type": "vegetation_zone", "source": "tall-grass",
                                 "zoneType": "rough_tall", "feather": 4.0, "noise": 2.0}


def test_surface_map_rules():
    """The Unity surface-map path: 1 m cells, 200 x 200 m, north-up rows."""
    import numpy as np
    cls = np.full((200, 200), gz.S_DEEP, dtype=np.uint8)       # Outer_Deep everywhere
    cls[:, 0:20] = 4                                           # a fairway strip on the west edge
    cls[:, 20:30] = 2                                          # rough beside it
    cls[90:110, 50:60] = 6                                     # a tee inside the deep rough
    rules = gz.Rules(max_distance=75, spill=5, building_margin=4, road_margin=1.5, min_area=1, simplify=0, clearance=0)
    house = box(70, 120, 80, 130)                              # world metres: west=0, north=200
    r = gz.tall_grass_from_surfaces(cls, 1.0, 0.0, 200.0, [house], [], rules)
    a = r.area
    assert a.contains(Point(40, 100))           # deep rough near play
    assert a.contains(Point(27, 150))           # 3 m spill into the rough
    assert not a.contains(Point(22, 150))       # rough beyond the spill
    assert not a.contains(Point(10, 150))       # fairway
    assert not a.contains(Point(55, 100))       # the tee (row 100 -> y 100)
    assert a.contains(Point(110, 100))          # 50 m from the tee: within reach
    assert not a.contains(Point(140, 40))       # 80 m from the tee, 110 m from the rough
    assert not a.contains(Point(75, 125))       # the house
    assert not a.contains(Point(75, 132))       # its 4 m margin


def test_weight_ramps_to_zero_before_forbidden_surfaces_and_the_reach_limit():
    import numpy as np
    cls = np.full((200, 200), gz.S_DEEP, dtype=np.uint8)
    cls[:, 0:20] = 4                                           # fairway, west edge
    rules = gz.Rules(max_distance=75, spill=5, min_area=1, simplify=0, clearance=2.5)
    a = gz.tall_grass_from_surfaces(cls, 1.0, 0.0, 200.0, [], [], rules).area
    assert not a.contains(Point(21.5, 100))     # within 2.5 m of the fairway
    assert a.contains(Point(24, 100))
    assert a.contains(Point(90, 100))           # 70 m from the fairway
    assert not a.contains(Point(96, 100))       # 76 m: past the reach limit


def test_grass_grows_up_to_the_rough_and_spills_a_foot_in():
    """Deep rough behind a band of mown rough next to a semi: the rough is the buffer, so the
    deep rough is full right up to it (no dip, no semi clearance reaching through), and the
    grass spills raggedly into the rough's first cell or two - never near the semi."""
    import numpy as np
    cls = np.full((200, 200), gz.S_DEEP, dtype=np.uint8)
    cls[:, 0:20] = 3                                            # semi, west
    cls[:, 20:32] = gz.S_ROUGH                                  # 6 m of rough between semi and deep
    w = gz.weight_field(cls, 0.5, None, gz.Rules(min_area=1, simplify=0, far_weight=1.0))
    assert (w[:, 32:120] == 1).all()                            # deep: full from the first cell
    assert w[:, :29].max() == 0                                 # nothing beyond 1.5 m into the rough
    first = w[:, 31]                                            # the rough's cell at the deep border
    assert 0.3 < (first == 1).mean() < 0.95 and ((first == 0) | (first == 1)).all()   # here and there


def test_a_rock_slab_is_bare_but_for_a_fringe_over_its_edge_and_patches():
    """A slab cut out of the deep rough: the grass around it is full up to it, most of its edge
    cells are under grass (no mesh edge shows), the inside is mostly bare with a few patches,
    and the patches survive the minimum zone area."""
    import numpy as np
    cls = np.full((200, 200), gz.S_DEEP, dtype=np.uint8)
    cls[:, 0:4] = gz.S_ROUGH                                    # play nearby (reach)
    cls[60:100, 80:120] = gz.S_SLAB                             # 20 x 20 m at 0.5 m cells
    w = gz.weight_field(cls, 0.5, None, gz.Rules(min_area=1, simplify=0, far_weight=1.0))
    on = w[60:100, 80:120]
    assert ((on == 0) | (on == 1)).all()
    ring =np.zeros_like(cls, dtype=bool)
    ring[58:102, 78:122] = True
    ring[60:100, 80:120] = False
    assert (w[ring] == 1).all()                                 # the ground around: no clearance
    edge = np.zeros_like(ring)
    edge[60:100, 80:120] = True
    edge[61:99, 81:119] = False
    assert (w[edge] == 1).mean() > 0.65                         # most of the edge is under grass (the rest: blades leaning in)
    core = w[64:96, 84:116]                                     # 2 m in from the edge: patches only
    assert 0.05 < (core == 1).mean() < 0.3
    r = gz.tall_grass_from_surfaces(cls, 0.5, 0.0, 100.0, [], [], gz.Rules(min_area=25, simplify=0, far_weight=1.0))
    inner = box(42, 52, 58, 68)                                 # the core in world metres (north = 100)
    assert 0.05 < r.bands[-1][1].intersection(inner).area / inner.area < 0.3
    # no slab on a map without one: the rule changes nothing
    assert gz.slab_grass(np.full((40, 40), gz.S_DEEP, dtype=np.uint8), 0.5) is None


def test_a_rock_slab_in_mown_rough_gets_a_ragged_skirt_of_grass_outside_its_edge():
    """A slab lying in mown rough: tufts grow against the rock on the rough side too (most of the
    first cells outside its edge), and none of it further out than twice SLAB_SKIRT_M."""
    import numpy as np
    cls = np.full((200, 200), gz.S_ROUGH, dtype=np.uint8)
    cls[60:100, 80:120] = gz.S_SLAB                             # 20 x 20 m at 0.5 m cells
    w = gz.weight_field(cls, 0.5, None, gz.Rules(min_area=1, simplify=0, far_weight=1.0))
    ring = np.zeros_like(cls, dtype=bool)
    ring[59:101, 79:121] = True
    ring[60:100, 80:120] = False
    assert 0.65 < (w[ring] == 1).mean() < 1                     # most of it, not a solid line
    far = np.ones_like(ring)
    far[57:103, 77:123] = False                                 # 1.5 m and more outside the slab
    assert (w[far] == 0).all()


def test_a_tee_without_rough_around_it_keeps_its_clearance_next_to_one_with():
    import numpy as np
    cls = np.full((100, 100), gz.S_DEEP, dtype=np.uint8)
    cls[40:60, 40:60] = 6                                       # a tee ...
    cls[40:60, 60:63] = gz.S_ROUGH                              # ... with 3 m of rough on its east side only
    w = gz.weight_field(cls, 1.0, None, gz.Rules(min_area=1, simplify=0))[50]
    assert w[63] == 1.0                                         # east: full behind the rough
    assert w[37] == 0 and 0 < w[34] < 1                         # west: the tee's own clearance


def test_grass_stands_at_the_path_edge_with_tufts_onto_gravel_only():
    """The path's drawn outline is the grass's edge, wherever it falls in the 0.5 m cells."""
    import numpy as np
    cls = np.full((400, 100), gz.S_DEEP, dtype=np.uint8)
    cls[:, 0] = gz.S_ROUGH                                      # play nearby (reach)
    cls[:, 40:44] = gz.S_OTHER                                  # the path mesh as the surface map sees it
    cls[::3, 39] = gz.S_BLEND                                   # OPCD seam cells along its west edge
    path = box(20.2, 0.0, 21.9, 200.0)                          # x 20.2 .. 21.9: off the cell grid
    rules = gz.Rules(min_area=1, simplify=0, path_margin=0.0)

    def full(surface):
        return gz.tall_grass_from_surfaces(cls, 0.5, 0.0, 200.0, [], [], rules, paths=[(path, surface)]).bands[-1][1]

    hard = full("asphalt")
    assert hard.intersection(path).area < 1e-6                  # none on the path
    strips = box(19.2, 0.0, 20.2, 200.0).union(box(21.9, 0.0, 22.9, 200.0))
    assert hard.intersection(strips).area > 0.999 * strips.area   # and no bare strip beside it

    gravel = full("gravel")
    on_path = gravel.intersection(path)
    assert 0.001 * path.area < on_path.area < 0.05 * path.area  # a tuft here and there
    assert on_path.intersection(path.buffer(-0.45)).is_empty    # a foot or so onto the path, no further
    assert gravel.intersection(strips).area > 0.999 * strips.area


def test_tees_get_the_widest_clearance():
    import numpy as np
    cls = np.full((100, 100), gz.S_DEEP, dtype=np.uint8)
    cls[40:60, 40:60] = 6                                       # a tee in the deep rough
    w = gz.weight_field(cls, 1.0, None, gz.Rules(min_area=1, simplify=0))[50]
    assert w[36] == 0 and w[37] == 0                            # 3 m from the tee: still nothing
    assert 0 < w[34] < 1                                        # 5.5 m: ramping
    assert w[30] == 1.0                                         # 9.5 m: full


def test_a_road_that_is_also_drawn_as_a_path_is_cut_by_the_drawing_alone():
    from shapely.geometry import LineString
    path = box(20.0, 0.0, 23.0, 100.0)                          # the drawn road, 3 m wide
    centerline = LineString([(22.3, 0.0), (22.3, 100.0)])       # the survey's line, 0.8 m off its middle
    rules = gz.Rules(path_margin=0.0)
    cut = gz.ways_cut([(centerline, 3.5)], [(path, "asphalt")], rules)
    assert cut.symmetric_difference(path).area < 1e-6           # the drawing, nothing more
    alone = gz.ways_cut([(centerline, 3.5)], [], rules)         # not drawn: centerline + width + margin
    assert alone.area == pytest.approx(100 * (3.5 + 2 * rules.road_margin), rel=0.01)



def test_a_gravel_path_gets_a_ragged_verge_in_deep_rough_only_and_off_the_path():
    """An unmown strip beside a loose path: mixed over what grows there, with gaps, off the play surfaces."""
    import numpy as np
    cls = np.full((800, 100), gz.S_DEEP, dtype=np.uint8)
    cls[:, :42] = gz.S_ROUGH                                    # mown rough west of the path, deep rough east
    cls[:, 0:4] = 4                                             # a fairway 18 m west of it
    cls[:120, 50:56] = 4                                        # and one 3 m east of it along the first 60 m (north)
    cls[:, 40:44] = gz.S_OTHER
    path = box(20.0, 0.0, 22.0, 400.0)
    rules = gz.Rules(min_area=1, simplify=0, path_margin=0.0)

    def verge(surface):
        return gz.tall_grass_from_surfaces(cls, 0.5, 0.0, 400.0, [], [], rules, paths=[(path, surface)]).verge

    assert verge("asphalt") is None
    v = verge("gravel")
    west, east = box(17.0, 0.0, 20.0, 400.0), box(22.0, 0.0, 26.0, 400.0)
    assert 0.4 * 1.8 * 340 * 0.75 < v.intersection(east).area < 1.3 * 1.8 * 340 * 0.75   # ~1.8 m, 3/4 of the length
    assert v.intersection(west).area == 0                                               # mown rough is cut to the gravel
    assert v.intersection(box(20.0, 341.0, 30.0, 400.0)).area == 0                      # none beside the near fairway
    assert v.intersection(box(26.5, 0.0, 50.0, 400.0)).area == 0                        # a strip, not a field
    assert v.intersection(path.buffer(0.3)).area == 0                                   # a card's lean off the path
    doc = gz.feature_collection(v, "rough_tall", "tall-grass", 1.0, 0.5, 0.0, [(1.0, box(0, 0, 1, 1))], v)
    zones = [f["properties"] for f in doc["features"] if f["properties"].get("zoneVariant") == "verge"]
    assert zones and all(z["blend"] == "mix" and z["source"] == "tall-grass" for z in zones)
    assert "zoneVariant" not in doc["features"][0]["properties"]


def test_grass_far_from_play_is_thinner():
    """Beyond 30 m from the playing field the weight falls to far_weight over 10 m; nearer it is whole."""
    import numpy as np
    cls = np.full((40, 200), gz.S_DEEP, dtype=np.uint8)
    cls[:, :20] = gz.S_ROUGH
    w = gz.weight_field(cls, 1.0, None, gz.Rules(min_area=1, simplify=0, spill=0, max_distance=150))[20]
    assert w[20 + 25] == pytest.approx(1.0)                 # 25 m from the rough
    assert w[20 + 60] == pytest.approx(0.56, abs=0.01)      # 60 m: thinned
    assert 0.56 < w[20 + 35] < 1.0                          # on the ramp
    off = gz.weight_field(cls, 1.0, None, gz.Rules(min_area=1, simplify=0, spill=0, max_distance=150, far_weight=1.0))[20]
    assert off[20 + 60] == pytest.approx(1.0)


def test_a_course_can_halve_the_tall_grass_beyond_ten_metres_from_play():
    """Vreta's rule (vegetation-rules.json: near-start 8, near-ramp 4, near-weight 0.5): whole near play,
    a ramp centred on 10 m, and beyond it the zones are written at exactly half weight - the mask
    value is VSP's density, so half the instances (not the 0.4 band, which would be 60 % fewer).
    It multiplies with the far rule (30 / 10 / 0.56), so beyond 40 m it is 0.28: never thicker than before."""
    import numpy as np
    cls = np.full((40, 200), gz.S_DEEP, dtype=np.uint8)
    cls[:, :20] = gz.S_ROUGH
    rules = gz.Rules(min_area=1, simplify=0, spill=0, max_distance=150, near_start=8, near_ramp=4, near_weight=0.5)
    w = gz.weight_field(cls, 1.0, None, rules)[20]
    assert w[20 + 6] == pytest.approx(1.0)                  # 7 m from the rough: whole
    assert w[20 + 9] == pytest.approx(0.75, abs=0.02)       # 10 m: half-way down the ramp
    assert w[20 + 25] == pytest.approx(0.5)                 # 26 m: half
    assert w[20 + 60] == pytest.approx(0.28)                # 61 m: half of the far rule's 0.56

    r = gz.tall_grass_from_surfaces(cls, 1.0, 0.0, 40.0, [], [], rules)
    doc = gz.feature_collection(r.area, "rough_tall", "tall-grass", 1.0, 0.5, 0.0, r.bands)

    def weight_at(x):
        return max(f["properties"]["weight"] for f in doc["features"]
                   if shape(f["geometry"]).contains(Point(x, 20)))
    assert weight_at(20 + 5) == 1.0
    assert weight_at(20 + 25) == 0.5
    assert weight_at(20 + 100) == 0.28


def test_far_from_play_the_far_mix_takes_over_when_the_course_has_one():
    """With Rules.far_variant the ordinary mix hands over to <type>/far across 40-50 m from play:
    the two add up to the unthinned field, and the far bands are written above the ordinary ones."""
    import numpy as np
    cls = np.full((40, 200), gz.S_DEEP, dtype=np.uint8)
    cls[:, :20] = gz.S_ROUGH
    rules = gz.Rules(min_area=1, simplify=0, spill=0, max_distance=150, far_variant=True)
    near, far = (f[20] for f in gz.weight_field(cls, 1.0, None, rules, split=True))
    assert near[20 + 25] == pytest.approx(1.0) and far[20 + 25] == 0          # near play: the ordinary mix alone
    assert near[20 + 38] == pytest.approx(0.56 + 0.44 * 0.1, abs=0.01)        # 39 m: thinned, before the hand-over
    assert 0 < far[20 + 45] < 1 and 0 < near[20 + 45] < 0.56                  # 45 m: both, cross-fading
    assert far[20 + 60] == pytest.approx(1.0) and near[20 + 60] == 0          # 60 m: the far mix alone
    assert gz.weight_field(cls, 1.0, None, rules).shape == cls.shape          # unsplit: the ordinary mix
    off = gz.weight_field(cls, 1.0, None, gz.Rules(min_area=1, simplify=0, spill=0, max_distance=150), split=True)[1]
    assert not off.any()                                                      # no far variant bound: none

    r = gz.tall_grass_from_surfaces(cls, 1.0, 0.0, 40.0, [], [], rules)
    assert r.far_bands[-1][1].contains(Point(20 + 60, 20)) and not r.bands[0][1].contains(Point(20 + 60, 20))
    doc = gz.feature_collection(r.area, "rough_tall", "tall-grass", 1.0, 0.5, 0.0, r.bands, None, r.far_bands)
    variants = [f["properties"].get("zoneVariant") for f in doc["features"]]
    first_far = variants.index("far")
    assert first_far > 0 and all(v is None for v in variants[:first_far]) and all(v == "far" for v in variants[first_far:])
    assert len({f["properties"]["source_ref"] for f in doc["features"]}) == len(doc["features"])
