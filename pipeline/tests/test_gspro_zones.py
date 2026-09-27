"""gspro zones — vegetation zones out of the app DB as VSPro texture masks,
one channel per VSP item, and the unity-zones-v2 JSON
(docs/feature-vegetation-zones.md, sections 6, 7).

Real SQLite databases built in tmp_path (no mocks): courses / holes /
course_features with attributes_json (migration 015) and course_zone_types
(migration 019, variants_json from 022 — one test keeps a database without
that column). A 200 m square rendered at 200 px, so one pixel is one metre
and the feather and noise numbers below are metres.
"""

import json
import sqlite3

import numpy as np
import pytest
from PIL import Image

import gspro

COURSE = "22222222-2222-2222-2222-222222222222"
E0, N0 = 600000.0, 6400000.0
SIDE = 200.0
EXTENT = (E0, N0, E0 + SIDE, N0 + SIDE)
SIZE = 200

def _item(name, max_density=1.0, min_density=0.0):
    return {"item": name, "minDensity": min_density, "maxDensity": max_density}


TYPES = [
    # (key, name, color, texture, channel, sort_order, items, variants) — texture/channel are
    # legacy columns the pipeline no longer reads (unity-zones-v2 is one channel per item).
    ("rough_tall", "Tall rough", "#8a9a3a", 0, 0, 0, [_item("Tall grass")], [
        {"key": "dry", "name": "Dry straw", "items": [_item("Tall grass", 0.4), _item("Straw")]},
        {"key": "lush", "name": "Lush", "items": [_item("Tall grass"), _item("Clover", 0.5)]},
    ]),
    ("shrub", "Shrubs", "#6b8f3a", 0, 1, 1, [_item("Hazel bush", 1.0, 0.2)], []),
    ("fern", "Ferns", "#3a7a4a", 0, 2, 2, [], []),
    ("meadow", "Meadow", "#c0b040", 1, 0, 3, [_item("Meadow flowers", 0.8)], []),
]
# Items in first-appearance order: Tall grass, Straw, Clover, Hazel bush | Meadow flowers.
TALL, STRAW, CLOVER, HAZEL = range(4)


def _rect(x0, y0, x1, y1):
    """A straight-edged ring over metres from the square's south-west corner."""
    return {"points": [{"x": E0 + x0, "y": N0 + y0}, {"x": E0 + x1, "y": N0 + y0},
                       {"x": E0 + x1, "y": N0 + y1}, {"x": E0 + x0, "y": N0 + y1}]}


def _zone(zone_type, rings, weight=None, feather=0.0, noise=0.0, zone_id=None, hole=None, order=0, variant=None,
          blend=None, extras=(), generated=False):
    """extras: (zoneType, variant, weight) per extra palette, stored as the
    `extraPalettes` string (shared/features/zone-layers.ts)."""
    attrs = {"zoneType": zone_type, "feather": feather, "noise": noise}
    if weight is not None:
        attrs["weight"] = weight
    if variant is not None:
        attrs["zoneVariant"] = variant
    if blend is not None:
        attrs["blend"] = blend
    if extras:
        attrs["extraPalettes"] = ", ".join(t + (f"/{v}" if v else "") + (f"={w:g}" if w != 1 else "") for t, v, w in extras)
    return gspro.ZoneSpec(id=zone_id or f"z-{zone_type}-{order}", zone_type=zone_type,
                          weight=1.0 if weight is None else weight, feather=feather, noise=noise,
                          geometry={"crs": "EPSG:3006", "curveType": "bezier", "rings": rings},
                          variant=variant or "", blend=blend or gspro.ZONE_BLEND_REPLACE,
                          extras=[gspro.ZonePalette(t, v, w) for t, v, w in extras],
                          generated=generated), attrs, hole, order


def _make_db(path, zones, types=TYPES, with_table=True, extra_features=(), with_variants=True):
    """zones: [(ZoneSpec, attrs, hole_number|None, sort_order)] as _zone returns.
    with_variants=False builds course_zone_types as before migration 022."""
    conn = sqlite3.connect(path)
    conn.executescript(
        """CREATE TABLE courses (id TEXT PRIMARY KEY, name TEXT);
           CREATE TABLE holes (id TEXT PRIMARY KEY, course_id TEXT, number INTEGER);
           CREATE TABLE course_features (
               id TEXT PRIMARY KEY, course_id TEXT, hole_id TEXT, type TEXT,
               geometry_json TEXT, sort_order INTEGER, attributes_json TEXT);"""
    )
    if with_table:
        conn.executescript(
            """CREATE TABLE course_zone_types (
                   id TEXT PRIMARY KEY, course_id TEXT NOT NULL, key TEXT NOT NULL, name TEXT NOT NULL,
                   color TEXT NOT NULL, texture_index INTEGER NOT NULL, channel INTEGER NOT NULL,
                   sort_order INTEGER NOT NULL, items_json TEXT NOT NULL DEFAULT '[]',
                   created_at TEXT NOT NULL DEFAULT (datetime('now')),
                   updated_at TEXT NOT NULL DEFAULT (datetime('now')));"""
        )
        if with_variants:
            conn.execute("ALTER TABLE course_zone_types ADD COLUMN variants_json TEXT NOT NULL DEFAULT '[]'")
        for i, (key, name, color, texture, channel, order, items, *rest) in enumerate(types):
            conn.execute(
                "INSERT INTO course_zone_types (id, course_id, key, name, color, texture_index, channel, sort_order, items_json) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (f"zt-{i}", COURSE, key, name, color, texture, channel, order, json.dumps(items)),
            )
            if with_variants and rest:
                conn.execute("UPDATE course_zone_types SET variants_json = ? WHERE id = ?",
                             (json.dumps(rest[0]), f"zt-{i}"))
    conn.execute("INSERT INTO courses VALUES (?, ?)", (COURSE, "Zonbana"))
    for number in (1, 2):
        conn.execute("INSERT INTO holes VALUES (?, ?, ?)", (f"h{number}", COURSE, number))
    for spec, attrs, hole, order in zones:
        conn.execute(
            "INSERT INTO course_features VALUES (?, ?, ?, ?, ?, ?, ?)",
            (spec.id, COURSE, f"h{hole}" if hole else None, "vegetation_zone",
             json.dumps(spec.geometry), order, json.dumps(attrs)),
        )
    for fid, kind, rings in extra_features:
        conn.execute(
            "INSERT INTO course_features VALUES (?, ?, ?, ?, ?, ?, ?)",
            (fid, COURSE, None, kind, json.dumps({"crs": "EPSG:3006", "curveType": "bezier", "rings": rings}), 0, None),
        )
    conn.commit()
    conn.close()


def _sidecar(path, extent=EXTENT, terrain="inner"):
    path.write_text(json.dumps({"terrain": terrain, "square3006": list(extent), "minM": 12.3, "maxM": 71.8}))
    return path


def _at(arr, x_m, y_m):
    """A weight at metres east/north of the square's south-west corner."""
    return float(arr[SIZE - 1 - int(y_m), int(x_m)])


def _render(zones, **kw):
    channels, outside = gspro.render_zone_masks([z for z, *_ in zones], EXTENT, SIZE, **kw)
    return channels, outside


# --- rasterizer semantics ---------------------------------------------------

def test_a_lone_zone_at_weight_0_3_stays_0_3_with_a_hard_edge():
    channels, outside = _render([_zone("shrub", [_rect(50, 50, 150, 150)], weight=0.3)])
    shrub = channels["shrub"]
    assert outside == 0 and set(channels) == {"shrub"}
    assert _at(shrub, 100, 100) == pytest.approx(0.3)
    assert _at(shrub, 51, 51) == pytest.approx(0.3) and _at(shrub, 148, 148) == pytest.approx(0.3)
    assert _at(shrub, 20, 100) == 0.0 and _at(shrub, 100, 160) == 0.0
    assert shrub.max() == pytest.approx(0.3)  # never scaled up


def test_a_feather_is_a_ramp_centred_on_the_drawn_edge():
    """Feather 20 m: the weight runs from 1 ten metres inside the edge to 0
    ten metres outside, through 0.5 on the edge itself (x = 150)."""
    channels, _ = _render([_zone("fern", [_rect(50, 50, 150, 150)], feather=20.0)])
    fern = channels["fern"]
    row = fern[SIZE - 1 - 100]  # y = 100 m, across the east edge at x = 150
    assert _at(fern, 100, 100) == pytest.approx(1.0)
    assert _at(fern, 135, 100) == pytest.approx(1.0)
    assert _at(fern, 165, 100) == pytest.approx(0.0)
    # PIL fills the boundary column inclusively (column 150 is inside), the
    # same fill the tint step uses, so the drawn edge sits between pixels 150
    # and 151: those two average 0.5, and the ramp is linear in the distance
    # from that edge (pixel 145 is 5.5 px inside it, pixel 154 3.5 px outside).
    assert (row[150] + row[151]) / 2 == pytest.approx(0.5, abs=0.02)
    assert row[145] == pytest.approx(0.5 + 5.5 / 20, abs=0.02)
    assert row[154] == pytest.approx(0.5 - 3.5 / 20, abs=0.02)
    ramp = row[138:162]
    assert np.all(np.diff(ramp) <= 1e-6)  # monotone, still a ramp: nothing renormalised it
    assert 0.6 < row[147] < 0.9 and 0.1 < row[153] < 0.45  # 3.5 px inside, 2.5 px outside


def test_a_later_zone_of_another_type_claims_first_and_the_sum_never_exceeds_one():
    """Among generated zones: tall rough at weight 1 first, shrubs at 0.6 over part of it:
    in the overlap the shrubs hold 0.6 and the rough keeps 0.4; where only the
    rough is, it stays 1."""
    channels, _ = _render([
        _zone("rough_tall", [_rect(20, 20, 120, 120)], generated=True, order=0),
        _zone("shrub", [_rect(80, 80, 180, 180)], generated=True, weight=0.6, order=1),
    ])
    rough, shrub = channels["rough_tall"], channels["shrub"]
    assert _at(shrub, 100, 100) == pytest.approx(0.6) and _at(rough, 100, 100) == pytest.approx(0.4)
    assert _at(rough, 40, 40) == pytest.approx(1.0) and _at(shrub, 40, 40) == 0.0
    assert _at(shrub, 160, 160) == pytest.approx(0.6) and _at(rough, 160, 160) == 0.0
    assert (rough + shrub).max() <= 1.0 + 1e-6


def test_the_first_generated_zone_keeps_nothing_where_the_later_one_is_full_weight():
    channels, _ = _render([
        _zone("rough_tall", [_rect(20, 20, 120, 120)], generated=True, order=0),
        _zone("shrub", [_rect(80, 80, 180, 180)], generated=True, order=1),
    ])
    assert _at(channels["shrub"], 100, 100) == pytest.approx(1.0)
    assert _at(channels["rough_tall"], 100, 100) == 0.0


def test_zones_of_the_same_type_combine_as_a_maximum():
    channels, _ = _render([
        _zone("shrub", [_rect(20, 20, 120, 120)], generated=True, weight=0.8, order=0),
        _zone("shrub", [_rect(80, 80, 180, 180)], generated=True, weight=0.3, order=1),
    ])
    shrub = channels["shrub"]
    assert _at(shrub, 100, 100) == pytest.approx(0.8)
    assert _at(shrub, 40, 40) == pytest.approx(0.8) and _at(shrub, 160, 160) == pytest.approx(0.3)


def test_a_ramp_over_another_type_crossfades_with_a_constant_total():
    """A feathered shrub zone over full-weight rough: across the feather the
    rough gives up exactly what the shrubs take."""
    channels, _ = _render([
        _zone("rough_tall", [_rect(0, 0, 200, 200)], generated=True, order=0),
        _zone("shrub", [_rect(50, 50, 150, 150)], generated=True, feather=20.0, order=1),
    ])
    total = channels["rough_tall"] + channels["shrub"]
    assert np.allclose(total, 1.0, atol=1e-5)
    row = channels["shrub"][SIZE - 1 - 100]
    assert 0.6 < row[147] < 0.9 and 0.1 < row[153] < 0.45  # 3.5 px inside, 2.5 px outside


def test_a_ring_inside_a_ring_is_a_hole():
    channels, _ = _render([_zone("meadow", [_rect(20, 20, 180, 180), _rect(80, 80, 120, 120)])])
    meadow = channels["meadow"]
    assert _at(meadow, 100, 100) == 0.0 and _at(meadow, 50, 50) == pytest.approx(1.0)


def test_noise_moves_the_edge_deterministically_from_the_seed():
    plain, _ = _render([_zone("shrub", [_rect(50, 50, 150, 150)], feather=4.0)])
    a, _ = _render([_zone("shrub", [_rect(50, 50, 150, 150)], feather=4.0, noise=3.0)], seed=1)
    b, _ = _render([_zone("shrub", [_rect(50, 50, 150, 150)], feather=4.0, noise=3.0)], seed=1)
    c, _ = _render([_zone("shrub", [_rect(50, 50, 150, 150)], feather=4.0, noise=3.0)], seed=2)
    assert np.array_equal(a["shrub"], b["shrub"])
    assert not np.array_equal(a["shrub"], c["shrub"])
    # The edge wanders along the east side: the crossing point of 0.5 varies by row.
    crossings = [100 + int(np.argmax(a["shrub"][r, 100:] < 0.5)) for r in range(SIZE - 140, SIZE - 60)]
    assert len(set(crossings)) > 1 and all(143 <= cx <= 157 for cx in crossings)
    # Deep inside and far outside the noise changes nothing.
    assert _at(a["shrub"], 100, 100) == pytest.approx(1.0) and _at(a["shrub"], 20, 100) == 0.0
    assert not np.array_equal(plain["shrub"], a["shrub"])


def test_exclude_square_is_zeroed_and_zones_off_the_square_are_counted():
    channels, outside = _render([
        _zone("shrub", [_rect(0, 0, 200, 200)], order=0),
        _zone("fern", [_rect(500, 500, 600, 600)], order=1),
    ], exclude=(E0 + 50, N0 + 50, E0 + 100, N0 + 100))
    assert outside == 1 and "fern" not in channels
    assert _at(channels["shrub"], 75, 75) == 0.0 and _at(channels["shrub"], 25, 25) == pytest.approx(1.0)


def test_a_variant_zone_lands_in_its_own_slot_under_the_same_budget():
    """Default rough drawn first, its Dry variant at 0.6 over part of it: two
    slots, and the later one claims first exactly as another type would."""
    channels, _ = _render([
        _zone("rough_tall", [_rect(20, 20, 120, 120)], generated=True, order=0),
        _zone("rough_tall", [_rect(80, 80, 180, 180)], generated=True, weight=0.6, order=1, variant="dry"),
    ])
    assert set(channels) == {"rough_tall", "rough_tall/dry"}
    default, dry = channels["rough_tall"], channels["rough_tall/dry"]
    assert _at(dry, 100, 100) == pytest.approx(0.6) and _at(default, 100, 100) == pytest.approx(0.4)
    assert _at(default, 40, 40) == pytest.approx(1.0) and _at(dry, 40, 40) == 0.0
    assert _at(dry, 160, 160) == pytest.approx(0.6) and _at(default, 160, 160) == 0.0
    assert (default + dry).max() <= 1.0 + 1e-6


def test_a_mix_zone_grows_over_the_zone_below_without_taking_its_share():
    """A pond's palette over the whole pond, reeds mixed over part of it:
    in the overlap both are at full weight; outside it the pond is alone."""
    channels, _ = _render([
        _zone("meadow", [_rect(20, 20, 180, 180)], order=0),
        _zone("shrub", [_rect(80, 80, 140, 140)], weight=0.7, order=1, blend="mix"),
    ])
    meadow, shrub = channels["meadow"], channels["shrub"]
    assert _at(meadow, 100, 100) == pytest.approx(1.0) and _at(shrub, 100, 100) == pytest.approx(0.7)
    assert _at(meadow, 40, 40) == pytest.approx(1.0) and _at(shrub, 40, 40) == 0.0


def test_a_feathered_mix_zone_fades_in_over_the_zone_below_which_stays_whole():
    channels, _ = _render([
        _zone("rough_tall", [_rect(0, 0, 200, 200)], order=0),
        _zone("shrub", [_rect(50, 50, 150, 150)], feather=20.0, order=1, blend="mix"),
    ])
    assert np.allclose(channels["rough_tall"], 1.0)
    row = channels["shrub"][SIZE - 1 - 100]
    assert 0.6 < row[147] < 0.9 and 0.1 < row[153] < 0.45  # the same ramp a replace zone gets


def test_a_replace_zone_above_a_mix_zone_still_cuts_it():
    channels, _ = _render([
        _zone("rough_tall", [_rect(0, 0, 200, 200)], generated=True, order=0),
        _zone("shrub", [_rect(20, 20, 180, 180)], generated=True, order=1, blend="mix"),
        _zone("meadow", [_rect(80, 80, 120, 120)], generated=True, order=2),
    ])
    assert _at(channels["meadow"], 100, 100) == pytest.approx(1.0)
    assert _at(channels["shrub"], 100, 100) == 0.0 and _at(channels["rough_tall"], 100, 100) == 0.0
    assert _at(channels["shrub"], 40, 40) == pytest.approx(1.0) and _at(channels["rough_tall"], 40, 40) == pytest.approx(1.0)


def test_a_zone_plants_its_extra_palettes_on_its_own_footprint_at_their_weight():
    """Tall rough with rocks (shrub here) at 0.4 and the Dry variant at full
    weight, all in one zone at weight 0.5 with a feather: every palette
    follows the zone's ramp, scaled by its factor."""
    channels, _ = _render([
        _zone("rough_tall", [_rect(50, 50, 150, 150)], weight=0.5, feather=20.0,
              extras=[("shrub", "", 0.4), ("rough_tall", "dry", 1.0)]),
    ])
    rough, shrub, dry = channels["rough_tall"], channels["shrub"], channels["rough_tall/dry"]
    assert _at(rough, 100, 100) == pytest.approx(0.5)
    assert _at(shrub, 100, 100) == pytest.approx(0.2) and _at(dry, 100, 100) == pytest.approx(0.5)
    assert np.allclose(shrub, rough * 0.4, atol=1e-6) and np.allclose(dry, rough, atol=1e-6)


def test_extra_palettes_do_not_take_ground_from_the_zones_below_but_the_primary_does():
    channels, _ = _render([
        _zone("meadow", [_rect(0, 0, 200, 200)], order=0, generated=True),
        _zone("rough_tall", [_rect(50, 50, 150, 150)], weight=0.6, order=1, extras=[("shrub", "", 1.0)]),
    ])
    assert _at(channels["rough_tall"], 100, 100) == pytest.approx(0.6)
    assert _at(channels["shrub"], 100, 100) == pytest.approx(0.6)
    assert _at(channels["meadow"], 100, 100) == pytest.approx(0.4)  # only the primary's 0.6 came out of it


def test_an_item_in_a_mix_zone_and_the_zone_below_sums_its_densities():
    items = gspro.zone_items(_types([
        ("pond", [_item("Sedge", 0.5)], []),
        ("reeds", [_item("Sedge", 0.3), _item("Reed")], []),
    ]))
    channels, _ = _render([
        _zone("pond", [_rect(0, 0, 200, 200)], order=0),
        _zone("reeds", [_rect(50, 50, 150, 150)], order=1, blend="mix"),
    ])
    sedge = gspro.zone_item_density(items[0], channels, SIZE)
    assert _at(sedge, 100, 100) == pytest.approx(0.8) and _at(sedge, 20, 20) == pytest.approx(0.5)


def _types(rows):
    return [gspro.ZoneType(key, key, "#000000", items,
                           [gspro.ZoneVariant(v["key"], v["name"], v["items"]) for v in variants])
            for key, items, variants in rows]


def test_items_in_first_appearance_order_four_per_texture_with_their_sources():
    items = gspro.zone_items(_types([
        ("rough_tall", [_item("Tall grass"), _item("  ")], [
            {"key": "dry", "name": "Dry", "items": [_item("Tall grass", 0.4), _item("Straw"), _item("Straw", 0.3)]},
        ]),
        ("shrub", [_item("Hazel bush"), _item("Tall grass", 0.2)], []),
        ("fern", [_item("Fern a"), _item("Fern b")], []),
    ]))
    assert [(i.item, i.texture, i.channel) for i in items] == [
        ("Tall grass", 0, 0), ("Straw", 0, 1), ("Hazel bush", 0, 2), ("Fern a", 0, 3), ("Fern b", 1, 0)]
    assert items[0].sources == ["rough_tall", "rough_tall/dry", "shrub"]
    assert items[0].bindings == [("rough_tall", 1.0), ("rough_tall/dry", 0.4), ("shrub", 0.2)]
    assert items[1].sources == ["rough_tall/dry"] and items[1].bindings == [("rough_tall/dry", 1.0), ("rough_tall/dry", 0.3)]


def test_an_item_density_is_the_sum_of_its_bindings_clipped_to_one():
    """Summed, never multiplied: VSP multiplies an item's density rules, so
    an item in two slots gets ONE channel carrying both. Listed twice in one
    slot sums both; the total clips at 1; a slot with no zone adds nothing."""
    full = np.ones((4, 4), dtype=np.float32)
    left = np.zeros((4, 4), dtype=np.float32)
    left[:, :2] = 0.6
    right = np.zeros((4, 4), dtype=np.float32)
    right[:, 1:] = 0.4
    slots = {"a": left, "a/v": right, "b": full * 0.0}
    item = gspro.ZoneItem("Tall grass", 0, 0, [("a", 1.0), ("a/v", 0.5), ("missing", 1.0)])
    d = gspro.zone_item_density(item, slots, 4)
    assert d[0].tolist() == pytest.approx([0.6, 0.8, 0.2, 0.2])  # 0.6 | 0.6+0.2 | 0.2 | 0.2
    twice = gspro.zone_item_density(gspro.ZoneItem("x", 0, 0, [("a", 1.0), ("a", 1.0), ("a/v", 1.0)]), slots, 4)
    assert twice[0].tolist() == pytest.approx([1.0, 1.0, 0.4, 0.4])  # 1.2 and 1.6 clip to 1
    none = gspro.zone_item_density(gspro.ZoneItem("y", 0, 1, [("missing", 1.0)]), slots, 4)
    assert none.dtype == np.float32 and not none.any()


# --- the command ------------------------------------------------------------

def _run(tmp_path, zones, out_name="zones.json", **kw):
    db = tmp_path / "app.sqlite"
    _make_db(db, zones, **{k: kw.pop(k) for k in ("types", "with_table", "extra_features", "with_variants") if k in kw})
    sidecar = _sidecar(tmp_path / "inner.tif.json")
    out = tmp_path / out_name
    kw.setdefault("resolution", SIZE)
    gspro.cmd_zones(None, db, "Zonbana", sidecar, out, extent=EXTENT, **kw)
    return out, json.loads(out.read_text())


def _px(im, x_m, y_m):
    return im[SIZE - 1 - int(y_m), int(x_m)].tolist()


def _near(value, expected):
    return abs(int(value) - round(expected * 255)) <= 1


def test_command_writes_one_channel_per_item_and_the_unity_zones_v2_json(tmp_path, capsys):
    out, doc = _run(tmp_path, [
        _zone("rough_tall", [_rect(20, 20, 120, 120)], hole=1, order=0),
        _zone("rough_tall", [_rect(80, 80, 180, 180)], weight=0.5, feather=2.0, hole=1, order=1, variant="dry"),
        _zone("meadow", [_rect(0, 150, 50, 200)], hole=None, order=0),
    ])
    assert doc["format"] == "unity-zones-v2"
    assert doc["plot"] == {"crs": "EPSG:3006", "terrain": "inner", "originX": E0, "originY": N0,
                           "sizeM": SIDE, "minM": 12.3, "maxM": 71.8}
    assert doc["masks"] == [
        {"file": "zones-0.png", "resolution": SIZE, "channels": ["Tall grass", "Straw", "Clover", "Hazel bush"]},
        {"file": "zones-1.png", "resolution": SIZE, "channels": ["Meadow flowers", "", "", ""]},
    ]
    assert doc["items"] == [
        {"item": "Tall grass", "texture": 0, "channel": 0, "sources": ["rough_tall", "rough_tall/dry", "rough_tall/lush"]},
        {"item": "Straw", "texture": 0, "channel": 1, "sources": ["rough_tall/dry"]},
        {"item": "Clover", "texture": 0, "channel": 2, "sources": ["rough_tall/lush"]},
        {"item": "Hazel bush", "texture": 0, "channel": 3, "sources": ["shrub"]},
        {"item": "Meadow flowers", "texture": 1, "channel": 0, "sources": ["meadow"]},
    ]
    assert [t["key"] for t in doc["zoneTypes"]] == ["rough_tall", "shrub", "fern", "meadow"]
    assert doc["zoneTypes"][0] == {
        "key": "rough_tall", "name": "Tall rough", "color": "#8a9a3a", "items": [_item("Tall grass")],
        "variants": [{"key": "dry", "name": "Dry straw", "items": [_item("Tall grass", 0.4), _item("Straw")]},
                     {"key": "lush", "name": "Lush", "items": [_item("Tall grass"), _item("Clover", 0.5)]}]}
    assert doc["zoneTypes"][1] == {"key": "shrub", "name": "Shrubs", "color": "#6b8f3a",
                                   "items": [_item("Hazel bush", 1.0, 0.2)], "variants": []}
    assert doc["zoneTypes"][2]["items"] == [] and doc["zoneTypes"][2]["variants"] == []

    im0 = np.asarray(Image.open(tmp_path / "zones-0.png"))
    im1 = np.asarray(Image.open(tmp_path / "zones-1.png"))
    assert im0.shape == (SIZE, SIZE, 4) and im0.dtype == np.uint8 and im1.shape == (SIZE, SIZE, 4)
    # Only the Default rough: Tall grass at its full 1.0, nothing else.
    assert _px(im0, 40, 40) == [255, 0, 0, 0]
    # The overlap: Dry (drawn later) claims 0.5, the Default keeps 0.5. Tall grass is bound by
    # both, so its ONE channel carries the sum 0.5 × 1.0 + 0.5 × 0.4 = 0.7; Straw only Dry's 0.5.
    px = _px(im0, 100, 100)
    # Two drawn zones add up: Default rough 1 + Dry 0.5 x 0.4 (clipped), and Dry's straw.
    assert px[TALL] == 255 and _near(px[STRAW], 0.5) and px[CLOVER] == 0 and px[HAZEL] == 0
    # Only Dry: Tall grass 0.5 × 0.4, Straw 0.5.
    px = _px(im0, 160, 160)
    assert _near(px[TALL], 0.2) and _near(px[STRAW], 0.5) and px[CLOVER] == 0 and px[HAZEL] == 0
    # Clover (Lush) and Hazel bush (shrub) have no zones here: bound, so present, but all zero.
    assert not im0[..., CLOVER].any() and not im0[..., HAZEL].any()
    assert _px(im1, 25, 175) == [204, 0, 0, 0] and _px(im1, 40, 40) == [0, 0, 0, 0]  # meadow 0.8

    zones = {z["id"]: z for z in doc["zones"]}
    assert list(zones) == ["z-rough_tall-0", "z-rough_tall-1", "z-meadow-0"]  # editor stack (D28): hole 1, then course-level on top
    assert zones["z-rough_tall-0"]["variant"] == "" and zones["z-meadow-0"]["variant"] == ""
    dry = zones["z-rough_tall-1"]
    assert list(dry) == ["id", "zoneType", "variant", "weight", "feather", "noise", "blend", "extraPalettes", "rings"]
    assert dry["blend"] == "replace" and dry["extraPalettes"] == []
    assert dry["zoneType"] == "rough_tall" and dry["variant"] == "dry"
    assert dry["weight"] == 0.5 and dry["feather"] == 2.0 and dry["noise"] == 0.0
    nodes = {(n["x"], n["z"]) for n in dry["rings"][0]["nodes"]}
    assert nodes == {(80.0, 80.0), (180.0, 80.0), (180.0, 180.0), (80.0, 180.0)}  # plot-local metres
    assert all(len(r["nodes"]) >= 3 for z in doc["zones"] for r in z["rings"])
    report = capsys.readouterr().out
    assert "3 zones on the 200 m inner square (rough_tall 1, rough_tall/dry 1, meadow 1)" in report
    assert "5 item(s) in 2 texture(s)" in report
    assert "zones-0.png R: Tall grass <- rough_tall, rough_tall/dry, rough_tall/lush" in report
    assert "zones-1.png R: Meadow flowers <- meadow" in report


def test_an_unknown_variant_falls_back_to_the_default_mix_with_a_warning(tmp_path, capsys):
    out, doc = _run(tmp_path, [
        _zone("rough_tall", [_rect(20, 20, 120, 120)], order=0, variant="wet"),
        _zone("rough_tall", [_rect(130, 130, 180, 180)], order=1, variant="lush"),
    ])
    assert [(z["id"], z["variant"]) for z in doc["zones"]] == [("z-rough_tall-0", ""), ("z-rough_tall-1", "lush")]
    im = np.asarray(Image.open(tmp_path / "zones-0.png"))
    assert _px(im, 40, 40) == [255, 0, 0, 0]          # Default: Tall grass only
    assert _px(im, 150, 150) == [255, 0, 128, 0]      # Lush: Tall grass 1.0, Clover 0.5
    report = capsys.readouterr().out
    assert "1 zone(s) of zone type 'rough_tall' with variant 'wet' not in its variants; using its Default mix" in report
    assert "(rough_tall 1, rough_tall/lush 1)" in report


def test_a_database_without_variants_reads_every_zone_as_its_default_mix(tmp_path, capsys):
    """course_zone_types before migration 022: no variants_json column."""
    out, doc = _run(tmp_path, [
        _zone("rough_tall", [_rect(20, 20, 120, 120)], order=0, variant="dry"),
        _zone("shrub", [_rect(130, 130, 180, 180)], weight=0.5, order=1),
    ], with_variants=False)
    assert all(t["variants"] == [] for t in doc["zoneTypes"])
    assert doc["masks"] == [{"file": "zones-0.png", "resolution": SIZE,
                             "channels": ["Tall grass", "Hazel bush", "Meadow flowers", ""]}]
    assert [i["sources"] for i in doc["items"]] == [["rough_tall"], ["shrub"], ["meadow"]]
    assert doc["zones"][0]["variant"] == ""
    im = np.asarray(Image.open(tmp_path / "zones-0.png"))
    assert _px(im, 40, 40) == [255, 0, 0, 0] and _px(im, 150, 150) == [0, 128, 0, 0]
    assert "with variant 'dry' not in its variants; using its Default mix" in capsys.readouterr().out


def test_malformed_variants_json_reads_as_no_variants(tmp_path, capsys):
    db = tmp_path / "app.sqlite"
    _make_db(db, [])
    conn = sqlite3.connect(db)
    conn.execute("UPDATE course_zone_types SET variants_json = '{not json' WHERE key = 'rough_tall'")
    conn.execute("UPDATE course_zone_types SET variants_json = ? WHERE key = 'shrub'",
                 (json.dumps([{"key": "a", "name": "A", "items": [_item("Rose")]}, {"key": "a", "items": []},
                              {"name": "no key"}, "junk"]),))
    conn.commit()
    conn.close()
    _, types, _ = gspro._load_zones(db, "Zonbana")
    by_key = {t.key: t for t in types}
    assert by_key["rough_tall"].variants == []
    assert by_key["shrub"].variants == [gspro.ZoneVariant("a", "A", [_item("Rose")])]
    report = capsys.readouterr().out
    assert "zone type 'rough_tall': variants_json is not JSON; no variants" in report
    assert "zone type 'shrub': skipped a variant with a repeated key 'a'" in report
    assert report.count("zone type 'shrub': skipped a variant with no key") == 2


def test_items_pack_four_per_texture_and_stale_textures_are_removed(tmp_path, capsys):
    types = [("t", "T", "#000000", 0, 0, 0, [_item(f"Item {n}") for n in range(4)],
              [{"key": "v", "name": "V", "items": [_item("Item 1"), _item("Item 4"), _item("Item 5")]}])]
    (tmp_path / "zones-2.png").write_bytes(b"stale")
    (tmp_path / "other-zones-2.png").write_bytes(b"not ours")
    out, doc = _run(tmp_path, [_zone("t", [_rect(20, 20, 80, 80)], order=0, variant="v")], types=types)
    assert doc["masks"] == [
        {"file": "zones-0.png", "resolution": SIZE, "channels": ["Item 0", "Item 1", "Item 2", "Item 3"]},
        {"file": "zones-1.png", "resolution": SIZE, "channels": ["Item 4", "Item 5", "", ""]},
    ]
    assert [(i["item"], i["texture"], i["channel"]) for i in doc["items"]][4:] == [("Item 4", 1, 0), ("Item 5", 1, 1)]
    im0 = np.asarray(Image.open(tmp_path / "zones-0.png"))
    im1 = np.asarray(Image.open(tmp_path / "zones-1.png"))
    assert _px(im0, 50, 50) == [0, 255, 0, 0] and _px(im1, 50, 50) == [255, 255, 0, 0]
    assert not (tmp_path / "zones-2.png").exists() and (tmp_path / "other-zones-2.png").exists()
    assert "removed stale mask zones-2.png" in capsys.readouterr().out


def test_zones_are_clipped_to_the_square_minus_the_excluded_inner_square(tmp_path, capsys):
    inner = (E0 + 50, N0 + 50, E0 + 100, N0 + 100)
    out, doc = _run(tmp_path, [
        _zone("shrub", [_rect(-50, -50, 120, 120)], order=0),   # reaches outside the square
        _zone("fern", [_rect(60, 60, 90, 90)], order=1),       # entirely inside the inner square
        _zone("meadow", [_rect(300, 300, 400, 400)], order=2),  # off the square
    ], exclude=inner, terrain="outer")
    assert doc["plot"]["terrain"] == "outer"
    assert [z["zoneType"] for z in doc["zones"]] == ["shrub"]
    xs = [n["x"] for r in doc["zones"][0]["rings"] for n in r["nodes"]]
    zs = [n["z"] for r in doc["zones"][0]["rings"] for n in r["nodes"]]
    assert min(xs) >= 0 and min(zs) >= 0 and max(xs) <= 120 and max(zs) <= 120
    # The inner square is cut out of the polygon: a hole (or a notch) with its corners.
    assert (50.0, 50.0) in {(x, z) for x, z in zip(xs, zs)}
    im = np.asarray(Image.open(tmp_path / "zones-0.png"))
    assert im[SIZE - 1 - 75, 75].tolist() == [0, 0, 0, 0]  # excluded, and the fern zone there is gone too
    assert im[SIZE - 1 - 25, 25].tolist() == [0, 0, 0, 255]  # Hazel bush, the shrub's item
    report = capsys.readouterr().out
    assert "1 zones on the 200 m outer square (shrub 1); 1 outside the square, 1 left to the inner terrain" in report


def test_unknown_zone_types_are_skipped_with_a_warning_and_other_feature_types_ignored(tmp_path, capsys):
    out, doc = _run(tmp_path, [
        _zone("shrub", [_rect(20, 20, 80, 80)], order=0),
        _zone("heather", [_rect(100, 100, 180, 180)], order=1),
        _zone("", [_rect(100, 20, 180, 80)], order=2),
    ], extra_features=[("fw", "fairway", [_rect(0, 0, 200, 200)])])
    assert [z["zoneType"] for z in doc["zones"]] == ["shrub"]
    im = np.asarray(Image.open(tmp_path / "zones-0.png"))
    assert im[SIZE - 1 - 140, 140].tolist() == [0, 0, 0, 0]
    report = capsys.readouterr().out
    assert "1 zone(s) with zone type 'heather' not in the course's table; skipped" in report
    assert "1 zone(s) with zone type '(none)' not in the course's table; skipped" in report
    assert "2 skipped (unknown zone type)" in report


def test_blend_and_extra_palettes_are_read_checked_and_exported(tmp_path, capsys):
    out, doc = _run(tmp_path, [
        _zone("meadow", [_rect(20, 20, 180, 180)], order=0,
              extras=[("rough_tall", "dry", 0.5), ("nope", "", 1.0), ("shrub", "gone", 1.0)]),
        _zone("shrub", [_rect(80, 80, 140, 140)], order=1, blend="mix"),
    ])
    meadow, shrub = doc["zones"]
    assert meadow["blend"] == "replace" and shrub["blend"] == "mix"
    assert meadow["extraPalettes"] == [{"zoneType": "rough_tall", "variant": "dry", "weight": 0.5},
                                       {"zoneType": "shrub", "variant": "", "weight": 1.0}]
    report = capsys.readouterr().out
    assert "1 extra palette(s) with zone type 'nope' not in the course's table; skipped" in report
    assert "1 zone(s) of zone type 'shrub' with variant 'gone' not in its variants; using its Default mix" in report
    assert "1 zone(s) mix over the zones below them, 2 extra palette(s) on zone footprints" in report
    straw = next(m for m in doc["masks"] if "Straw" in m["channels"])
    png = np.asarray(Image.open(out.with_name(straw["file"])))[..., straw["channels"].index("Straw")]
    assert png[SIZE - 1 - 100, 100] == 128  # Dry's Straw at 1.0 x the extra's 0.5


def test_extra_palettes_parse_the_shared_string_format_and_skip_what_does_not(capsys):
    assert gspro._zone_extra_palettes(" shrub/rocks=0.4, fern ,, meadow=0 ", "z") == [
        gspro.ZonePalette("shrub", "rocks", 0.4), gspro.ZonePalette("fern", "", 1.0), gspro.ZonePalette("meadow", "", 0.0)]
    assert gspro._zone_extra_palettes("Fern, shrub=2, fern", "z") == [gspro.ZonePalette("fern", "", 1.0)]
    assert gspro._zone_extra_palettes(None, "z") == [] and gspro._zone_extra_palettes(["fern"], "z") == []
    report = capsys.readouterr().out
    assert "zone z: extra palette 'Fern' is not" in report and "zone z: extra palette 'shrub=2' is not" in report


def test_attribute_defaults_and_clamping(tmp_path):
    db = tmp_path / "app.sqlite"
    spec, attrs, hole, order = _zone("shrub", [_rect(20, 20, 80, 80)])
    _make_db(db, [(spec, {"zoneType": "shrub", "weight": 1.7}, None, 0)])
    conn = sqlite3.connect(db)
    conn.execute("INSERT INTO course_features VALUES (?, ?, NULL, 'vegetation_zone', ?, 1, NULL)",
                 ("bare", COURSE, json.dumps(spec.geometry)))
    conn.commit()
    conn.close()
    _, _, zones = gspro._load_zones(db, "Zonbana")
    assert [(z.id, z.zone_type, z.weight, z.feather, z.noise) for z in zones] == [
        (spec.id, "shrub", 1.0, gspro.DEFAULT_ZONE_FEATHER_M, 0.0),
        ("bare", "", 1.0, gspro.DEFAULT_ZONE_FEATHER_M, 0.0),
    ]


def test_missing_zone_type_table_and_missing_types_fail_clearly(tmp_path):
    db = tmp_path / "app.sqlite"
    _make_db(db, [_zone("shrub", [_rect(20, 20, 80, 80)])], with_table=False)
    with pytest.raises(SystemExit, match="no course_zone_types table"):
        gspro.cmd_zones(None, db, "Zonbana", _sidecar(tmp_path / "s.json"), tmp_path / "z.json", extent=EXTENT)
    db2 = tmp_path / "app2.sqlite"
    _make_db(db2, [_zone("shrub", [_rect(20, 20, 80, 80)])], types=[])
    with pytest.raises(SystemExit, match="has no zone types"):
        gspro.cmd_zones(None, db2, "Zonbana", _sidecar(tmp_path / "s.json"), tmp_path / "z.json", extent=EXTENT)


def test_the_sidecar_must_be_for_the_same_square(tmp_path):
    db = tmp_path / "app.sqlite"
    _make_db(db, [_zone("shrub", [_rect(20, 20, 80, 80)])])
    other = _sidecar(tmp_path / "s.json", extent=(E0 + 10, N0, E0 + 210, N0 + 200))
    with pytest.raises(SystemExit, match="is for square"):
        gspro.cmd_zones(None, db, "Zonbana", other, tmp_path / "z.json", extent=EXTENT)


def test_cli(tmp_path):
    db = tmp_path / "app.sqlite"
    _make_db(db, [_zone("shrub", [_rect(20, 20, 80, 80)], feather=4.0, noise=1.0)])
    sidecar = _sidecar(tmp_path / "inner.tif.json")
    out = tmp_path / "vreta-inner-zones.json"
    code = gspro.main([
        "zones", "--square-3006", ",".join(f"{v:.1f}" for v in EXTENT), "--db", str(db), "--course", "Zonbana",
        "--sidecar", str(sidecar), "--out", str(out), "--terrain", "inner", "--resolution", "100",
        "--simplify", "0.5", "--seed", "7",
    ])
    assert code == 0 and out.exists()
    doc = json.loads(out.read_text())
    assert doc["masks"][0]["file"] == "vreta-inner-zones-0.png" and doc["masks"][0]["resolution"] == 100
    assert Image.open(tmp_path / "vreta-inner-zones-0.png").size == (100, 100)
    assert (tmp_path / "vreta-inner-zones-1.png").exists()


def test_hand_drawn_creek_bank_zones_near_water_are_creek_sections_the_rest_plant(tmp_path, capsys):
    """A hand-drawn creek_bank zone within a creek's bank reach (4.5 m) + 10 m
    of it picks that creek's bank palette (creek_bank_zones.py plants it) and
    is left out of the masks; one away from any creek or water plants its
    palette like any zone. Generated creek-bank zones always plant."""
    types = TYPES + [("creek_bank", "Creek bank", "#5f8a4a", 1, 1, 4, [_item("Creek grass")], [])]
    db = tmp_path / "app.sqlite"
    _make_db(db, [_zone("shrub", [_rect(20, 20, 80, 80)], order=0)], types=types)
    conn = sqlite3.connect(db)
    conn.execute("ALTER TABLE course_features ADD COLUMN generated INTEGER NOT NULL DEFAULT 0")
    geom = lambda r: json.dumps({"crs": "EPSG:3006", "curveType": "bezier", "rings": [r]})
    attrs = json.dumps({"zoneType": "creek_bank", "feather": 0, "noise": 0})
    # A creek along x = 190..195; `near` stops 10 m short of it, `far` is 100 m away.
    conn.execute("INSERT INTO course_features VALUES ('creek', ?, NULL, 'water_creek', ?, 0, NULL, 0)",
                 (COURSE, geom(_rect(190, 0, 195, 200))))
    conn.execute("INSERT INTO course_features VALUES ('near', ?, NULL, 'vegetation_zone', ?, 1, ?, 0)",
                 (COURSE, geom(_rect(100, 100, 180, 180)), attrs))
    conn.execute("INSERT INTO course_features VALUES ('far', ?, NULL, 'vegetation_zone', ?, 2, ?, 0)",
                 (COURSE, geom(_rect(20, 120, 90, 190)), attrs))
    conn.execute("INSERT INTO course_features VALUES ('gen', ?, NULL, 'vegetation_zone', ?, 3, ?, 1)",
                 (COURSE, geom(_rect(100, 20, 180, 80)), attrs))
    conn.commit()
    conn.close()
    out = tmp_path / "zones.json"
    gspro.cmd_zones(None, db, "Zonbana", _sidecar(tmp_path / "inner.tif.json"), out, extent=EXTENT, resolution=SIZE)
    doc = json.loads(out.read_text())
    assert sorted(z["id"] for z in doc["zones"]) == ["far", "gen", "z-shrub-0"]
    assert "1 creek section(s) (hand-drawn creek_bank zones near a creek or water) not rasterized" in capsys.readouterr().out
    creek = next(m for m in doc["masks"] if "Creek grass" in m["channels"])
    png = np.asarray(Image.open(out.with_name(creek["file"])))[..., creek["channels"].index("Creek grass")]
    assert png[SIZE - 1 - 150, 50] == 255 and png[SIZE - 1 - 140, 140] == 0


# --- zones-patch -------------------------------------------------------------

def test_a_window_render_is_exactly_that_part_of_the_full_render():
    zones = [z for z, *_ in [
        _zone("rough_tall", [_rect(0, 0, 200, 200)], feather=6.0, noise=2.0, order=0, generated=True),
        _zone("shrub", [_rect(40, 40, 130, 120)], feather=10.0, order=1, extras=[("fern", "", 0.5)]),
        _zone("meadow", [_rect(90, 60, 170, 150)], weight=0.7, feather=4.0, noise=3.0, order=2, blend="mix"),
    ]]
    full, _ = gspro.render_zone_masks(zones, EXTENT, SIZE, seed=3, exclude=(E0 + 150, N0 + 0, E0 + 200, N0 + 30))
    window = (37, 121, 55, 181)
    part, _ = gspro.render_zone_masks(zones, EXTENT, SIZE, seed=3, exclude=(E0 + 150, N0 + 0, E0 + 200, N0 + 30),
                                      window=window)
    y0, y1, x0, x1 = window
    assert set(part) == set(full)
    for slot in full:
        assert np.array_equal(part[slot], full[slot][y0:y1, x0:x1]), slot


def _set_zone(db, zone_id, attrs=None, rings=None, delete=False):
    conn = sqlite3.connect(db)
    if delete:
        conn.execute("DELETE FROM course_features WHERE id = ?", (zone_id,))
    if attrs is not None:
        conn.execute("UPDATE course_features SET attributes_json = ? WHERE id = ?", (json.dumps(attrs), zone_id))
    if rings is not None:
        conn.execute("UPDATE course_features SET geometry_json = ? WHERE id = ?",
                     (json.dumps({"crs": "EPSG:3006", "curveType": "bezier", "rings": rings}), zone_id))
    conn.commit()
    conn.close()


def _masks(out, doc):
    return [np.asarray(Image.open(out.with_name(m["file"]))) for m in doc["masks"]]


BASE_ZONES = [
    _zone("rough_tall", [_rect(0, 0, 200, 200)], feather=4.0, noise=2.0, zone_id="base", order=0),
    _zone("shrub", [_rect(20, 20, 70, 70)], feather=6.0, zone_id="a", order=1),
    _zone("meadow", [_rect(120, 120, 180, 180)], feather=2.0, zone_id="b", order=2),
    _zone("rough_tall", [_rect(130, 20, 180, 60)], variant="dry", zone_id="c", order=3),
]


def test_a_patch_of_the_edited_zones_gives_exactly_the_full_export(tmp_path, capsys):
    out, doc = _run(tmp_path, BASE_ZONES, seed=5)
    db = tmp_path / "app.sqlite"
    # a moves (the old spot must clear), b now mixes and plants ferns too, c is deleted,
    # d is new; `base` is untouched and not selected.
    _set_zone(db, "a", rings=[_rect(40, 30, 95, 85)])
    _set_zone(db, "b", attrs={"zoneType": "meadow", "feather": 2.0, "noise": 0.0, "blend": "mix", "extraPalettes": "shrub=0.5"})
    _set_zone(db, "c", delete=True)
    conn = sqlite3.connect(db)
    conn.execute("INSERT INTO course_features VALUES (?, ?, NULL, 'vegetation_zone', ?, 9, ?)",
                 ("d", COURSE, json.dumps({"crs": "EPSG:3006", "curveType": "bezier", "rings": [_rect(10, 150, 40, 190)]}),
                  json.dumps({"zoneType": "shrub", "feather": 3.0, "noise": 1.0})))
    conn.commit()
    conn.close()
    before_json = json.loads(out.read_text())

    record = gspro.cmd_zones_patch(db, "Zonbana", out, ["a", "b", "d"], tmp_path / "patch.json")
    patched = _masks(out, doc)
    patched_doc = json.loads(out.read_text())
    assert record["changed"] and record["removed"] == ["c"] and record["zones"] == ["a", "b", "d"]
    assert json.loads((tmp_path / "patch.json").read_text()) == record
    assert "Patched zones.json: 3 zone(s), 1 removed" in capsys.readouterr().out

    fresh_dir = tmp_path / "fresh"
    fresh_dir.mkdir()
    sidecar = _sidecar(tmp_path / "inner.tif.json")
    gspro.cmd_zones(None, db, "Zonbana", sidecar, fresh_dir / "zones.json", extent=EXTENT, resolution=SIZE, seed=5)
    fresh_doc = json.loads((fresh_dir / "zones.json").read_text())
    for a, b in zip(patched, _masks(fresh_dir / "zones.json", fresh_doc)):
        assert np.array_equal(a, b)
    # The rows follow the course: a and b updated, c gone, d added, base kept as exported.
    assert patched_doc["zones"] == fresh_doc["zones"]
    assert patched_doc["zones"][0] == before_json["zones"][0]
    # The region (plot-local metres) covers a's old and new spot, b, c's old spot and d.
    r = record["region"]
    assert r["x0"] <= 7 and r["z0"] <= 17 and r["x1"] >= 181 and r["z1"] >= 191


def test_a_patch_that_changes_nothing_rewrites_nothing(tmp_path):
    out, doc = _run(tmp_path, BASE_ZONES)
    files = [out] + [out.with_name(m["file"]) for m in doc["masks"]]
    stamps = [f.stat().st_mtime_ns for f in files]
    record = gspro.cmd_zones_patch(tmp_path / "app.sqlite", "Zonbana", out, ["a"])
    assert record["changed"] is False and record["textures"] == [] and record["window"] is not None
    assert [f.stat().st_mtime_ns for f in files] == stamps


def test_a_square_the_zones_do_not_reach_needs_no_layout_check(tmp_path, capsys):
    """The outer terrain's export is often older than the zone types (planting
    refreshes the inner one): zones inside the excluded inner square, or off
    the square, patch nothing there instead of failing on the old layout."""
    inner = (E0 + 10, N0 + 10, E0 + 100, N0 + 100)
    out, _ = _run(tmp_path, BASE_ZONES, exclude=inner)
    conn = sqlite3.connect(tmp_path / "app.sqlite")
    conn.execute("UPDATE course_zone_types SET items_json = ? WHERE key = 'shrub'", (json.dumps([_item("Hazel bush", 0.5)]),))
    conn.commit()
    conn.close()
    record = gspro.cmd_zones_patch(tmp_path / "app.sqlite", "Zonbana", out, ["a"], exclude=inner)
    assert record["changed"] is False and record["window"] is None
    assert "Nothing to patch" in capsys.readouterr().out
    with pytest.raises(gspro.ZonesLayoutChanged):   # b is outside the inner square
        gspro.cmd_zones_patch(tmp_path / "app.sqlite", "Zonbana", out, ["b"], exclude=inner)


def test_a_patch_only_rewrites_the_textures_whose_items_changed(tmp_path):
    out, doc = _run(tmp_path, BASE_ZONES)
    meadow_png = out.with_name(doc["masks"][1]["file"])
    stamp = meadow_png.stat().st_mtime_ns
    _set_zone(tmp_path / "app.sqlite", "a", attrs={"zoneType": "shrub", "feather": 6.0, "noise": 0.0, "weight": 0.5})
    record = gspro.cmd_zones_patch(tmp_path / "app.sqlite", "Zonbana", out, ["a"])
    assert record["textures"] == [doc["masks"][0]["file"]]  # Hazel bush lives in texture 0; meadow's untouched
    assert meadow_png.stat().st_mtime_ns == stamp


def test_a_patch_stops_when_the_item_bindings_changed(tmp_path, capsys):
    out, _ = _run(tmp_path, BASE_ZONES)
    conn = sqlite3.connect(tmp_path / "app.sqlite")
    conn.execute("UPDATE course_zone_types SET items_json = ? WHERE key = 'shrub'",
                 (json.dumps([_item("Hazel bush", 0.5, 0.2)]),))
    conn.commit()
    conn.close()
    with pytest.raises(gspro.ZonesLayoutChanged) as e:
        gspro.cmd_zones_patch(tmp_path / "app.sqlite", "Zonbana", out, ["a"])
    assert e.value.code == gspro.ZONES_LAYOUT_CHANGED_EXIT
    assert "item bindings changed" in capsys.readouterr().err


def test_a_patch_on_the_outer_square_leaves_the_inner_square_out(tmp_path):
    inner = (E0 + 50, N0 + 50, E0 + 150, N0 + 150)
    out, doc = _run(tmp_path, BASE_ZONES, exclude=inner)
    _set_zone(tmp_path / "app.sqlite", "a", rings=[_rect(30, 30, 120, 120)])
    gspro.cmd_zones_patch(tmp_path / "app.sqlite", "Zonbana", out, ["a"], exclude=inner)
    hazel = _masks(out, doc)[0][..., 3]
    assert hazel[SIZE - 1 - 40, 40] > 0 and hazel[SIZE - 1 - 100, 100] == 0


def test_zones_patch_cli(tmp_path):
    out, _ = _run(tmp_path, BASE_ZONES)
    _set_zone(tmp_path / "app.sqlite", "b", delete=True)
    code = gspro.main(["zones-patch", "--db", str(tmp_path / "app.sqlite"), "--course", "Zonbana",
                       "--zones-json", str(out), "--ids", "b", "--result", str(tmp_path / "r.json")])
    record = json.loads((tmp_path / "r.json").read_text())
    assert code == 0 and record["format"] == "unity-zones-patch-v1" and record["removed"] == ["b"]
    assert record["textures"] == ["zones-1.png"]  # drawn zones take nothing from each other: the rough stays


# --- drawn over generated (D-VZ14) --------------------------------------------

def test_drawn_zones_add_up_whatever_their_order():
    """Two drawn replace zones of different palettes over each other: both at
    full weight in the overlap, and swapping their order changes nothing."""
    a = _zone("shrub", [_rect(20, 20, 120, 120)], order=0)
    b = _zone("meadow", [_rect(80, 80, 180, 180)], weight=0.6, order=1)
    one, _ = _render([a, b])
    two, _ = _render([b, a])
    assert _at(one["shrub"], 100, 100) == pytest.approx(1.0) and _at(one["meadow"], 100, 100) == pytest.approx(0.6)
    for slot in one:
        assert np.array_equal(one[slot], two[slot])


def test_a_drawn_replace_zone_takes_its_ground_from_the_generated_fill_even_below_it_in_the_stack():
    channels, _ = _render([
        _zone("shrub", [_rect(50, 50, 150, 150)], weight=0.7, order=0),                     # drawn, lower in the stack
        _zone("rough_tall", [_rect(0, 0, 200, 200)], order=1, generated=True),              # generated, on top
    ])
    assert _at(channels["shrub"], 100, 100) == pytest.approx(0.7)
    assert _at(channels["rough_tall"], 100, 100) == pytest.approx(0.3)
    assert _at(channels["rough_tall"], 20, 20) == pytest.approx(1.0)


def test_a_drawn_mix_zone_adds_to_the_generated_fill():
    channels, _ = _render([
        _zone("rough_tall", [_rect(0, 0, 200, 200)], order=1, generated=True),
        _zone("shrub", [_rect(50, 50, 150, 150)], order=0, blend="mix"),
    ])
    assert _at(channels["shrub"], 100, 100) == pytest.approx(1.0)
    assert _at(channels["rough_tall"], 100, 100) == pytest.approx(1.0)


def test_overlapping_drawn_zones_take_the_generated_ground_once_not_twice():
    """Two drawn replace zones at 0.5 over the same spot claim 0.5 of the
    generated fill between them (the larger of the two), not all of it."""
    channels, _ = _render([
        _zone("rough_tall", [_rect(0, 0, 200, 200)], generated=True),
        _zone("shrub", [_rect(50, 50, 150, 150)], weight=0.5, order=1),
        _zone("meadow", [_rect(50, 50, 150, 150)], weight=0.5, order=2),
    ])
    assert _at(channels["rough_tall"], 100, 100) == pytest.approx(0.5)
    assert _at(channels["shrub"], 100, 100) == pytest.approx(0.5) and _at(channels["meadow"], 100, 100) == pytest.approx(0.5)


def test_a_generator_rerun_is_matched_by_content_and_only_what_changed_is_patched(tmp_path, capsys):
    """A re-run generator replaces its zones with new ids. The ones that come
    back the same are renamed in the zones JSON and patch nothing; the one
    whose palette changed (a creek section picked another one) is patched in
    with the selected zone, and the masks equal a full export."""
    out, doc = _run(tmp_path, BASE_ZONES)
    db = tmp_path / "app.sqlite"
    conn = sqlite3.connect(db)
    # "Regenerate" b and c: delete them, insert copies under new ids, c with another variant.
    for old, new, attrs in [
        ("b", "b2", {"zoneType": "meadow", "feather": 2.0, "noise": 0.0}),
        ("c", "c2", {"zoneType": "rough_tall", "zoneVariant": "lush", "feather": 0.0, "noise": 0.0}),
    ]:
        geometry, order = conn.execute("SELECT geometry_json, sort_order FROM course_features WHERE id = ?", (old,)).fetchone()
        conn.execute("DELETE FROM course_features WHERE id = ?", (old,))
        conn.execute("INSERT INTO course_features VALUES (?, ?, NULL, 'vegetation_zone', ?, ?, ?)",
                     (new, COURSE, geometry, order, json.dumps(attrs)))
    conn.commit()
    conn.close()
    stamps = {m["file"]: out.with_name(m["file"]).stat().st_mtime_ns for m in doc["masks"]}

    record = gspro.cmd_zones_patch(db, "Zonbana", out, ["a"])
    assert record["renamed"] == 1 and record["removed"] == ["c"] and record["zones"] == ["a", "c2"]
    assert record["textures"] == ["zones-0.png"]    # c's rough -> lush; b (meadow, texture 1) came back the same
    assert out.with_name("zones-1.png").stat().st_mtime_ns == stamps["zones-1.png"]
    assert "1 zone(s) unchanged under a new id" in capsys.readouterr().out
    patched_doc = json.loads(out.read_text())
    assert [z["id"] for z in patched_doc["zones"]] == ["base", "a", "b2", "c2"]

    fresh = tmp_path / "fresh"
    fresh.mkdir()
    gspro.cmd_zones(None, db, "Zonbana", _sidecar(tmp_path / "inner.tif.json"), fresh / "zones.json", extent=EXTENT, resolution=SIZE)
    fresh_doc = json.loads((fresh / "zones.json").read_text())
    for a, b in zip(_masks(out, doc), _masks(fresh / "zones.json", fresh_doc)):
        assert np.array_equal(a, b)
    assert patched_doc["zones"] == fresh_doc["zones"]

    # Nothing changed since: the next patch finds nothing, and names no ghosts.
    again = gspro.cmd_zones_patch(db, "Zonbana", out, ["a"])
    assert again["changed"] is False and again["removed"] == [] and again["renamed"] == 0
