"""Rock candidates (golfpipe/rocks.py): found in the lidar, ranked with whatever photos there are."""
import json
from pathlib import Path

import laspy
import numpy as np
from rasterio.transform import from_origin

from golfpipe import rocks
from golfpipe.commands import cmd_rock_candidates

E0, N0, SIDE = 540000.0, 6470000.0, 60
TRANSFORM = from_origin(E0, N0, 1.0, 1.0)
ROCK = (E0 + 20.0, N0 - 20.0)     # a 4 x 3 m dome, 1.6 m high, long side east-west
BUSH = (E0 + 40.0, N0 - 20.0)     # a leafless bush: pulses split in it and reach the ground
POST = (E0 + 20.0, N0 - 45.0)     # a trunk: 4 m high, half a metre across
GRASS, GREY, GREEN, DARK = (90, 140, 60), (150, 150, 145), (50, 110, 40), (20, 30, 15)


def _scene():
    """x, y, z, classification, number_of_returns, return_number of a flat 60 m square at z = 50
    with 4 returns/m²: ground everywhere but under the rock, the rock, the bush and the post."""
    step = 0.5
    gx, gy = (g.ravel() for g in np.meshgrid(np.arange(E0 + .25, E0 + SIDE, step), np.arange(N0 - SIDE + .25, N0, step)))
    on_rock = ((gx - ROCK[0]) / 2.0) ** 2 + ((gy - ROCK[1]) / 1.5) ** 2 <= 1.0
    dome = 1.6 * np.sqrt(np.clip(1 - ((gx - ROCK[0]) / 2.0) ** 2 - ((gy - ROCK[1]) / 1.5) ** 2, 0, 1))
    in_bush = np.hypot(gx - BUSH[0], gy - BUSH[1]) <= 1.5
    in_post = np.hypot(gx - POST[0], gy - POST[1]) <= 0.4
    parts = [
        # ground returns (single), none under the rock
        (gx[~on_rock], gy[~on_rock], np.full((~on_rock).sum(), 50.0), 2, 1, 1),
        # the rock: single returns on its surface, where it stands over the band floor
        (gx[on_rock & (dome >= 0.5)], gy[on_rock & (dome >= 0.5)], 50.0 + dome[on_rock & (dome >= 0.5)], 1, 1, 1),
        # the bush: first of two returns at 1.2 m, the second is the ground return already there
        (gx[in_bush], gy[in_bush], np.full(in_bush.sum(), 51.2), 1, 2, 1),
        # the post: single returns from 1 to 4 m over one spot
        (np.repeat(gx[in_post], 4), np.repeat(gy[in_post], 4), 50.0 + np.tile([1.0, 2.0, 3.0, 4.0], in_post.sum()), 1, 1, 1),
    ]
    columns = [np.concatenate([np.broadcast_to(np.asarray(p[i], dtype=np.float64), p[0].shape) for p in parts]) for i in range(6)]
    return columns


def _band_points(scene=None):
    collector = rocks.Collector(np.full((SIDE, SIDE), 50.0), TRANSFORM)
    x, y, z, cls, returns, number = scene or _scene()
    half = x.size // 2   # two chunks, as a lidar file is read
    collector.add(x[:half], y[:half], z[:half], cls[:half], returns[:half], number[:half])
    collector.add(x[half:], y[half:], z[half:], cls[half:], returns[half:], number[half:])
    return collector.finish()


def _photo(at_rock, elsewhere=GRASS, shade=None):
    """sample(east, north): `at_rock` inside the rock's outline, `elsewhere` round it; `shade`
    (a colour) lies over the rock and 3 m round it, as a tree's shadow does."""
    def sample(east, north):
        east, north = np.asarray(east), np.asarray(north)
        out = np.tile(np.array(elsewhere, dtype=np.float32), (east.size, 1))
        out[((east - ROCK[0]) / 2.0) ** 2 + ((north - ROCK[1]) / 1.5) ** 2 <= 1.0] = at_rock
        if shade is not None:
            out[np.hypot(east - ROCK[0], north - ROCK[1]) <= 5.0] = shade
        return out
    return sample


def test_lidar_alone_finds_the_rock_and_nothing_else():
    found = rocks.detect(_band_points())
    assert len(found) == 1
    rock = found[0]
    assert abs(rock.x - ROCK[0]) < 0.5 and abs(rock.y - ROCK[1]) < 0.5
    assert 1.2 <= rock.height_m <= 1.6
    assert 3.0 <= rock.length_m <= 4.5 and 2.0 <= rock.width_m <= 3.5
    assert min(rock.yaw_deg % 180 - 90, 90 - rock.yaw_deg % 180, key=abs) < 15   # long side east-west
    assert rock.last_fraction == 1.0 and rock.multi_fraction == 0.0 and rock.covered_fraction == 0.0


def test_without_a_photo_the_rock_is_still_a_candidate():
    assessed = rocks.assess(rocks.detect(_band_points()), {}, (E0, N0 - SIDE, E0 + SIDE, N0))
    assert [c.confidence for c in assessed] == ["medium"] and assessed[0].photo == {}


def test_a_shadowed_vintage_does_not_hide_a_rock_another_vintage_shows():
    box = (E0, N0 - SIDE, E0 + SIDE, N0)
    candidates = rocks.detect(_band_points())
    lit, shadowed = _photo(GREY), _photo(GREY, shade=DARK)
    # the year it lies in a tree's shadow says nothing; any year that shows it grey makes it sure
    assert rocks.assess(candidates, {"a": shadowed}, box)[0].photo == {"a": "shadow"}
    assert rocks.assess(candidates, {"a": shadowed}, box)[0].confidence == "medium"
    both = rocks.assess(candidates, {"a": shadowed, "b": lit}, box)[0]
    assert both.photo == {"a": "shadow", "b": "grey"} and both.confidence == "high"
    # seen clearly and green: still listed, last
    green = rocks.assess(candidates, {"a": _photo(GREEN)}, box)[0]
    assert green.photo == {"a": "other"} and green.confidence == "low"


def test_grey_is_judged_against_the_ground_round_the_rock_not_on_an_absolute_scale():
    box = (E0, N0 - SIDE, E0 + SIDE, N0)
    candidates = rocks.detect(_band_points())
    # an underexposed photo: everything at 40 % brightness, the rock still paler and greyer than the grass
    dim = _photo(tuple(int(v * .4) for v in GREY), elsewhere=tuple(int(v * .4) for v in GRASS))
    assert rocks.assess(candidates, {"dim": dim}, box)[0].photo == {"dim": "grey"}
    # a photo that does not cover the box is no look at all
    nowhere = lambda east, north: np.full((np.asarray(east).size, 3), np.nan, dtype=np.float32)
    assert rocks.assess(candidates, {"gone": nowhere}, box)[0].photo == {"gone": "none"}


def test_under_a_crown_a_candidate_ranks_a_step_lower():
    x, y, z, cls, returns, number = _scene()
    # a crown 12 m up over the rock: the rock's returns become the last of two
    over = ((x - ROCK[0]) / 2.0) ** 2 + ((y - ROCK[1]) / 1.5) ** 2 <= 1.0
    rock_returns = over & (z > 50.4)
    returns = np.where(rock_returns, 2, returns)
    number = np.where(rock_returns, 2, number)
    crown = [np.concatenate([a, b]) for a, b in zip(
        (x, y, z, cls, returns, number),
        (x[rock_returns], y[rock_returns], np.full(rock_returns.sum(), 62.0), np.ones(rock_returns.sum()),
         np.full(rock_returns.sum(), 2.0), np.ones(rock_returns.sum())))]
    found = rocks.detect(_band_points(crown))
    assert len(found) == 1 and found[0].covered_fraction == 1.0 and found[0].multi_fraction == 1.0
    box = (E0, N0 - SIDE, E0 + SIDE, N0)
    assert rocks.assess(found, {}, box)[0].confidence == "low"
    assert rocks.assess(found, {"a": _photo(GREY)}, box)[0].confidence == "medium"


def test_known_rocks_are_marked_and_keep_drops():
    box = (E0, N0 - SIDE, E0 + SIDE, N0)
    candidates = rocks.detect(_band_points())
    known = rocks.known_rocks({"boulders": [{"id": "far", "e": E0 + 50, "n": N0 - 50, "lengthM": 2},
                                            {"id": "here", "e": ROCK[0] + 1, "n": ROCK[1], "lengthM": 4}]})
    assert rocks.assess(candidates, {}, box, known=known)[0].known == "here"
    assert rocks.assess(candidates, {}, box)[0].known is None
    assert rocks.assess(candidates, {}, box, keep=lambda c: False) == []


def test_command_reads_lidar_and_every_vintage_in_the_manifest(tmp_path: Path):
    x, y, z, cls, returns, number = _scene()
    header = laspy.LasHeader(point_format=6, version="1.4")
    header.offsets = np.array([E0, N0 - SIDE, 0.0])
    header.scales = np.array([.01, .01, .01])
    las = laspy.LasData(header)
    las.x, las.y, las.z = x, y, z
    las.classification = cls.astype(np.uint8)
    las.number_of_returns = returns.astype(np.uint8)
    las.return_number = number.astype(np.uint8)
    lidar = tmp_path / "scene.las"
    las.write(lidar)
    # two vintages of any name: the active one a uniform dark tile (the rock in shadow), the other
    # missing its tiles. Neither is a clear look, so the rock is kept as "medium".
    import mercantile
    from PIL import Image
    from rasterio.warp import transform as warp_coords
    tiles = tmp_path / "tiles"
    tiles.mkdir()
    (tiles / "manifest.json").write_text(json.dumps({"activeOrtho": "summer", "orthoVintages": [
        {"collection": "summer", "dates": ["2031-07-01"]}, {"collection": "older", "dates": ["2019-05-02"]}]}))
    lon, lat = warp_coords("EPSG:3006", "EPSG:4326", [E0 + SIDE / 2], [N0 - SIDE / 2])
    centre = mercantile.tile(lon[0], lat[0], 18)
    for dx in (-1, 0, 1):
        for dy in (-1, 0, 1):
            path = tiles / "ortho" / "18" / str(centre.x + dx) / f"{centre.y + dy}.webp"
            path.parent.mkdir(parents=True, exist_ok=True)
            Image.new("RGB", (256, 256), GRASS).save(path, lossless=True)
    walls = tmp_path / "stone-walls.json"
    walls.write_text(json.dumps({"boulders": [{"id": "placed", "e": ROCK[0], "n": ROCK[1], "lengthM": 4}]}))
    box = (E0, N0 - SIDE, E0 + SIDE, N0)
    out = tmp_path / "rocks.geojson"
    found = cmd_rock_candidates([lidar], out, bbox_3006=box, tiles_dir=tiles, known_paths=[walls])
    assert len(found) == 1 and found[0].known == "placed"
    doc = json.loads(out.read_text())
    assert doc["photoVintages"] == ["summer"]   # "older" has no tiles: skipped, not an error
    props = doc["features"][0]["properties"]
    assert props["type"] == "rock_candidate" and props["photo"] == {"summer": "other"} and props["confidence"] == "low"
    assert abs(doc["features"][0]["geometry"]["coordinates"][0] - ROCK[0]) < 0.5
    # no tiles directory at all: the lidar alone
    alone = cmd_rock_candidates([lidar], tmp_path / "alone.geojson", bbox_3006=box)
    assert [c.confidence for c in alone] == ["medium"] and alone[0].known is None
    # a course-features file keeps only what is near play
    near = tmp_path / "near.geojson"
    near.write_text(json.dumps({"type": "FeatureCollection", "crs": {"type": "name", "properties": {"name": "EPSG:3006"}},
                                "features": [{"type": "Feature", "properties": {"type": "green"}, "geometry": {
                                    "type": "Polygon", "coordinates": [[[E0 + 50, N0 - 58], [E0 + 58, N0 - 58], [E0 + 58, N0 - 50], [E0 + 50, N0 - 58]]]}}]}))
    assert cmd_rock_candidates([lidar], tmp_path / "far.geojson", bbox_3006=box, near_path=near, near_m=10.0) == []
    assert len(cmd_rock_candidates([lidar], tmp_path / "close.geojson", bbox_3006=box, near_path=near, near_m=60.0)) == 1
