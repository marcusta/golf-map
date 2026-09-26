"""grass_zones — where tall grass may grow, by rule (pipeline/grass_zones.py).

Plain shapely geometry in metres; each test states one rule of the module doc.
"""

from shapely.geometry import LineString, Point, box

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


def test_one_gradient_from_deep_into_rough_no_dip():
    """Deep rough meeting a narrow rough band next to a semi: the weight never dips at the
    deep/rough border, and falls monotonically to 0 before the semi."""
    import numpy as np
    cls = np.full((100, 100), gz.S_DEEP, dtype=np.uint8)
    cls[:, 0:10] = 3                                            # semi, west
    cls[:, 10:16] = gz.S_ROUGH                                  # 6 m of rough between semi and deep
    rules = gz.Rules(max_distance=75, spill=6, min_area=1, simplify=0)
    w = gz.weight_field(cls, 1.0, None, rules)[50]              # one row, west to east
    assert w[:12].max() == 0                                    # semi and 2 m clearance
    assert all(w[i] <= w[i + 1] + 1e-6 for i in range(10, 40)) # rises monotonically into the deep
    assert w[30] == 1.0


def test_tees_get_the_widest_clearance():
    import numpy as np
    cls = np.full((100, 100), gz.S_DEEP, dtype=np.uint8)
    cls[40:60, 40:60] = 6                                       # a tee in the deep rough
    w = gz.weight_field(cls, 1.0, None, gz.Rules(min_area=1, simplify=0))[50]
    assert w[36] == 0 and w[37] == 0                            # 3 m from the tee: still nothing
    assert 0 < w[34] < 1                                        # 5.5 m: ramping
    assert w[30] == 1.0                                         # 9.5 m: full
