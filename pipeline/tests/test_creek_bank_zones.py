"""creek_bank_zones — tall grass on marked creeks' banks and in their water
(pipeline/creek_bank_zones.py). Synthetic grids: a straight creek along x,
2 m wide, in a channel whose banks rise at a known slope to a known top."""

import math

import numpy as np
from shapely.geometry import box

import creek_bank_zones as cb

CELL = 0.25
ROWS, COLS = 120, 240          # 30 m x 60 m
CENTRE_ROW = ROWS // 2
HALF_WATER_M = 1.0


def grid(bank_m=1.5, bank_deg=35.0):
    """(water, z, dist_m): the water is |y| <= 1 m; the ground rises at `bank_deg`
    from the water's edge for `bank_m`, then stays flat (the top of the bank)."""
    y = (np.arange(ROWS)[:, None] - CENTRE_ROW + 0.5) * CELL * np.ones((1, COLS))
    out = np.abs(y) - HALF_WATER_M
    water = out <= 0
    z = np.clip(out, 0, bank_m) * math.tan(math.radians(bank_deg))
    return water, z.astype(np.float32), out


def row_at(metres_out):
    """A row `metres_out` beyond the water's edge (north side)."""
    return CENTRE_ROW + int(round((HALF_WATER_M + metres_out) / CELL))


def test_bank_runs_from_the_water_to_the_top_of_the_bank():
    water, z, _ = grid(bank_m=3.0)
    bank = cb.bank_region(water, z, CELL, max_m=6)
    assert bank[row_at(0.5)].all() and bank[row_at(2.5)].all()
    assert not bank[row_at(4.0)].any()          # flat ground above the top
    assert not (bank & water).any()


def test_flat_banks_still_get_the_minimum_strip_and_the_cap_holds():
    water, z, _ = grid(bank_m=0.0)
    bank = cb.bank_region(water, z, CELL, max_m=6)
    assert bank[row_at(0.5)].all()
    assert not bank[row_at(cb.MIN_BANK_M + 0.5)].any()

    water, z, _ = grid(bank_m=20.0, bank_deg=20)  # a long hillside: capped
    bank = cb.bank_region(water, z, CELL, max_m=4)
    assert bank[row_at(3.5)].all()
    assert not bank[row_at(5.0)].any()


def test_water_cover_matches_the_ask_and_grows_in_from_the_shore():
    water, _, out = grid()
    noise = cb.smooth_noise(water.shape, CELL, cb.WATER_NOISE_FEATURE_M, 7)
    for cover in (0.3, 0.5, 0.7):
        clumps = cb.water_clumps(water, CELL, cover, noise)
        assert not (clumps & ~water).any()
        assert abs(clumps.sum() / water.sum() - cover) < 0.05, cover
        shore = water & (out > -0.3)
        middle = water & (out < -0.7)
        assert clumps[shore].mean() > clumps[middle].mean(), cover
    assert not cb.water_clumps(water, CELL, 0.0, noise).any()


def test_weight_is_full_on_the_bank_and_gone_past_the_top():
    water, z, _ = grid(bank_m=2.0)
    cls = np.full(water.shape, 1, dtype=np.uint8)
    cls[water] = cb.S_WATER
    w = cb.creek_weight(water, z, cls, None, None, CELL, 0.5, 6.0, seed=3)
    assert (w[row_at(1.0)] == 1.0).all()
    assert (w[row_at(2.0 + cb.FADE_M + cb.TOP_NOISE_M + 0.5)] == 0.0).all()
    # The top edge is ragged: along the creek the grass reaches different distances.
    reach = [(w[CENTRE_ROW:, c] > 0.5).sum() for c in range(COLS)]
    assert max(reach) - min(reach) >= 2


def test_kept_off_fairways_greens_and_blocked_ground():
    water, z, _ = grid(bank_m=2.0)
    cls = np.full(water.shape, 1, dtype=np.uint8)
    cls[water] = cb.S_WATER
    cls[:, :60] = np.where(water[:, :60], cb.S_WATER, 5)       # a green up to the water on the west
    blocked = np.zeros_like(water)
    blocked[:, 200:] = True                                   # a road crossing on the east
    w = cb.creek_weight(water, z, cls, blocked, None, CELL, 0.7, 6.0, seed=3)
    assert w[:, :60].max() == 0.0
    assert w[:, 200:].max() == 0.0
    assert w[row_at(1.0), 120:160].min() == 1.0


def creek_on_grid(palette="reed", variants=frozenset()):
    west, north = 1000.0, 2000.0
    y_top = north - (CENTRE_ROW * CELL - HALF_WATER_M)
    return cb.Creek("abc", box(west + 5, y_top - 2 * HALF_WATER_M, west + 55, y_top), palette, 0.5, 6.0, frozenset(variants)), west, north, y_top


def test_bands_become_creek_bank_zones_with_the_palette_as_variant():
    _, z, _ = grid(bank_m=2.0)
    cls = np.full(z.shape, 1, dtype=np.uint8)
    creek, west, north, _ = creek_on_grid()
    slots, stats = cb.creek_bands(creek, cls, z, CELL, west, north, [], [])
    assert [variant for variant, _ in slots] == ["reed"]
    bands = slots[0][1]
    assert [lvl for lvl, _ in bands] == [0.15, 0.4, 0.65, 1.0]
    for (_, lower), (_, upper) in zip(bands, bands[1:]):
        assert upper.difference(lower.buffer(0.3)).area < 1.0     # nested
    assert 0.4 < stats["coverShare"] < 0.6
    fc = cb.feature_collection([(creek, slots)], "creek-bank")
    props = fc["features"][0]["properties"]
    assert props["zoneType"] == "creek_bank" and props["zoneVariant"] == "reed" and props["source"] == "creek-bank"
    default_slots, _ = cb.creek_bands(cb.Creek("d", creek.geometry, "default", 0.5, 6.0), cls, z, CELL, west, north, [], [])
    assert [variant for variant, _ in default_slots] == [""]


def test_a_wet_variant_takes_the_water_and_lower_bank_the_palette_the_rest():
    _, z, _ = grid(bank_m=3.0)
    cls = np.full(z.shape, 1, dtype=np.uint8)
    creek, west, north, y_top = creek_on_grid(variants={"reed", "reed_wet"})
    slots, _ = cb.creek_bands(creek, cls, z, CELL, west, north, [], [])
    assert [variant for variant, _ in slots] == ["reed", "reed_wet"]
    upper, wet = (dict(slots)[k][-1][1] for k in ("reed", "reed_wet"))   # the full-weight bands
    water = creek.geometry
    assert wet.intersection(water).area > 0.3 * water.area and upper.intersection(water).area == 0
    far = box(west + 10, y_top + cb.WET_M + cb.WET_RAMP_M + cb.WET_NOISE_M + 0.3, west + 50, y_top + 2.5)
    assert upper.intersection(far).area > 0.9 * far.area and wet.intersection(far).area == 0


def test_never_within_the_path_clearance():
    water, z, _ = grid(bank_m=2.0)
    cls = np.full(water.shape, 1, dtype=np.uint8)
    paths = np.zeros_like(water)
    paths[row_at(2.5):row_at(4.0), :] = True                  # a cart path along the top of the bank
    w = cb.creek_weight(water, z, cls, None, None, CELL, 0.5, 6.0, seed=3, paths=paths)
    edge = row_at(2.5)
    assert w[edge - int(cb.PATH_CLEARANCE_M / CELL) + 1:, :].max() == 0.0
    assert w[row_at(0.3), :].min() == 1.0


def test_a_section_gives_its_stretch_its_own_palette():
    _, z, _ = grid(bank_m=2.0)
    cls = np.full(z.shape, 1, dtype=np.uint8)
    creek, west, north, y_top = creek_on_grid(palette="lush")
    east_half = box(west + 30, y_top - 20, west + 70, y_top + 20)
    slots, _ = cb.creek_bands(creek, cls, z, CELL, west, north, [], [], sections=[cb.Section(east_half, "thicket")])
    full = {variant: bands[-1][1] for variant, bands in slots}
    assert set(full) == {"lush", "thicket"}
    west_bank = box(west + 6, y_top + 0.2, west + 26, y_top + 1.5)
    east_bank = box(west + 34, y_top + 0.2, west + 54, y_top + 1.5)
    assert full["lush"].intersection(west_bank).area > 0.9 * west_bank.area and full["lush"].intersection(east_bank).area == 0
    assert full["thicket"].intersection(east_bank).area > 0.9 * east_bank.area and full["thicket"].intersection(west_bank).area == 0

    # An unmarked creek is planted inside its sections only.
    unmarked = cb.Creek("u", creek.geometry, None, 0.5, 6.0)
    slots, _ = cb.creek_bands(unmarked, cls, z, CELL, west, north, [], [], sections=[cb.Section(east_half, "thicket")])
    assert [variant for variant, _ in slots] == ["thicket"]
    assert slots[0][1][0][1].intersection(west_bank).area == 0


def test_a_water_polygon_is_planted_like_a_creek_when_marked_or_in_a_section():
    assert cb.planted("water_creek", marked=True, in_section=False)
    assert cb.planted("water", marked=True, in_section=False)
    assert cb.planted("water_creek", marked=False, in_section=True)
    assert cb.planted("water", marked=False, in_section=True)
    assert not cb.planted("water", marked=False, in_section=False)
    assert not cb.planted("bunker", marked=True, in_section=True)


def test_the_wet_mix_reach_up_the_bank_is_per_creek():
    water, _, out = grid(bank_m=3.0)
    default = cb.wet_share(water, CELL, 5)
    edge = cb.wet_share(water, CELL, 5, wet_m=0.3)
    assert (default[water] == 1).all() and (edge[water] == 1).all()
    # The default reaches ~1 m up the bank; a 0.3 m reach stops right at the water's edge.
    assert default[row_at(0.6)].mean() > 0.9
    assert edge[row_at(0.6)].mean() < 0.15      # a ragged edge, mostly gone
    assert edge[row_at(0.9)].max() == 0.0
    assert edge[row_at(0.1)].mean() > 0.9
    assert (edge <= default + 1e-6).all()
