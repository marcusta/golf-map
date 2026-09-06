import json

import laspy
import numpy as np
import pytest
from rasterio.transform import from_origin

from golfpipe.commands import cmd_trees_stems
from golfpipe import trees_stems
from golfpipe.trees_stems import stems_from_ndsm, compact_asset, feature_collection


def scene(height=20):
    yy, xx = np.mgrid[:60, :60]
    h = np.maximum(height * np.exp(-((xx - 20)**2 + (yy - 30)**2) / 18),
                   15 * np.exp(-((xx - 33)**2 + (yy - 30)**2) / 18))
    return h, np.full(h.shape, 75.0), from_origin(540000, 6470000, 1, 1)


def test_two_crowns_keep_heights_ground_and_segmentation_radius():
    h, ground, transform = scene()
    trees = stems_from_ndsm(h, ground, transform)
    assert len(trees) == 2
    assert sorted(t.height_m for t in trees) == [15, 20]
    assert all(t.ground_m == 75 and 3 < t.crown_radius_m <= 7 for t in trees)  # 0.35 * 20 m cap
    assert {(t.x, t.y) for t in trees} == {(540020.5, 6469969.5), (540033.5, 6469969.5)}
    assert compact_asset(trees) == compact_asset(stems_from_ndsm(h, ground, transform))
    assert feature_collection(trees, "fixture.las")["features"][0]["properties"]["license"] == "CC0-1.0"
    # Without a leaf-off ortho every kind is unknown; the asset carries the six version-2 columns.
    asset = compact_asset(trees)
    assert asset["version"] == 2 and asset["fields"][-1] == "kind"
    assert all(len(row) == 6 and row[5] == trees_stems.KIND_UNKNOWN for row in asset["trees"])


def test_kind_from_leaf_off_greenness():
    h, ground, transform = scene()
    h[5:8, 50:54] = 2.5                              # bush under the 4 m kind floor
    rgb = np.full(h.shape + (3,), 90.0, dtype=np.float32)   # grey (bare branches / ground)
    rgb[:, :27] = (40.0, 70.0, 40.0)                 # green crown on the left tree, (G - R) / sum = 0.2
    rgb[:, 40:] = np.nan                             # no ortho tile over the bush
    stems = {int(s.x): s for s in stems_from_ndsm(h, ground, transform, leaf_off_rgb=rgb)}
    assert stems[540020].kind == trees_stems.KIND_CONIFER and stems[540020].conifer_score == 1.0
    assert stems[540033].kind == trees_stems.KIND_BROADLEAF and stems[540033].conifer_score == 0.0
    assert stems[540051].kind == trees_stems.KIND_UNKNOWN and np.isnan(stems[540051].conifer_score)
    rows = compact_asset(list(stems.values()))["trees"]
    assert sorted(row[5] for row in rows) == [0, 1, 2]
    # Coverage below half of the upper crown or a score inside the band stays unknown.
    rgb[:, 20:] = np.nan
    tallest = lambda stems: max(stems, key=lambda s: s.height_m)
    assert tallest(stems_from_ndsm(h, ground, transform, leaf_off_rgb=rgb)).kind == trees_stems.KIND_UNKNOWN
    assert list(trees_stems.classify_kind([0.49, 0.56, 0.0, 1.0], [10, 10, 3.9, 10])) == [2, 1, 2, 1]
    # Tall crown with a grey top is broadleaf even if the ortho misses a few edge cells.
    rgb[:] = 90.0; rgb[:3] = np.nan
    assert tallest(stems_from_ndsm(h, ground, transform, leaf_off_rgb=rgb)).kind == trees_stems.KIND_BROADLEAF


def test_leaf_off_vintage_selection(tmp_path):
    manifest = {"activeOrtho": "orto-l2-2025", "orthoVintages": [
        {"collection": "orto-l2-2025", "dates": ["2025-06-21", "2025-06-22"]},
        {"collection": "orto-l2-2019", "dates": ["2019-04-10"]},
        {"collection": "orto-l2-2023", "dates": ["2023-04-22"]},
        {"collection": "orto-l2-2021", "dates": ["2021-04-30", "2021-05-02"]},
    ]}
    assert trees_stems.leaf_off_vintage(manifest) == "orto-l2-2023"
    assert trees_stems.leaf_off_ortho_dir(tmp_path, manifest) == tmp_path / "ortho" / "orto-l2-2023"
    manifest["activeOrtho"] = "orto-l2-2023"
    assert trees_stems.leaf_off_ortho_dir(tmp_path, manifest) == tmp_path / "ortho"
    assert trees_stems.leaf_off_vintage({"orthoVintages": [{"collection": "x", "dates": ["2025-06-21"]}]}) is None
    assert trees_stems.leaf_off_ortho_dir(tmp_path, {}) is None


def test_noise_invalid_ground_and_empty_input():
    h, ground, transform = scene()
    ground[:] = -9999
    assert stems_from_ndsm(h, ground, transform) == []
    h[:] = 0
    ground[:] = 75
    h[3, 3] = 40
    h[8, 8] = np.nan
    assert stems_from_ndsm(h, ground, transform) == []
    with pytest.raises(ValueError):
        stems_from_ndsm(h, ground, from_origin(0, 0, 2, 1))


def test_plateau_has_one_marker():
    h = np.zeros((50, 50)); h[10:40, 10:40] = 12
    trees = stems_from_ndsm(h, np.full(h.shape, 10), from_origin(0, 50, 1, 1))
    assert len(trees) == 1
    # A flat 900 m² plateau is a flat compact crown: equal-area 16.9 m, held at the 10 m ceiling.
    assert trees[0].crown_radius_m == 10.0
    assert stems_from_ndsm(h * 0 + np.where(h > 0, 12 - 0.6 * np.abs(np.indices(h.shape)[1] - 25), 0),
                           np.full(h.shape, 10), from_origin(0, 50, 1, 1))[0].crown_radius_m <= 4.2   # sloping: capped


def test_taller_crowns_use_wider_peak_window():
    yy, xx = np.mgrid[:40, :40]
    h = np.maximum(7 * np.exp(-((xx - 16)**2 + (yy - 20)**2) / 4.5),
                   6 * np.exp(-((xx - 20)**2 + (yy - 20)**2) / 4.5))
    transform = from_origin(0, 40, 1, 1)
    ground = np.full(h.shape, 10)
    assert len(stems_from_ndsm(h, ground, transform)) == 2
    assert len(stems_from_ndsm(h * 4, ground, transform)) == 1


def test_two_tier_support_keeps_low_bush_and_drops_tall_fragment():
    h = np.zeros((40, 40)); ground = np.full(h.shape, 60.0); transform = from_origin(0, 40, 1, 1)
    h[10:12, 10:13] = 1.6; h[11, 11] = 1.9          # 6 m² bush, top 1.9 m (hole 5 shape)
    h[30:32, 30:33] = 9.0                           # 6 m² tall fragment (roof edge)
    h[20:25, 5:10] = 12.0                           # 25 m² tree
    stems = stems_from_ndsm(h, ground, transform)          # no roof mask: tall crowns need 12 m²
    assert sorted(round(s.height_m, 1) for s in stems) == [1.9, 12.0]
    bush = min(stems, key=lambda s: s.height_m)
    assert (bush.x, bush.y) == (11.5, 28.5) and bush.ground_m == 60
    assert bush.crown_radius_m == pytest.approx(np.sqrt(6 / np.pi), abs=.01)  # 1.5 m floor beats 0.35 * h
    # The old single-tier rule misses the bush; disabling the guard admits the fragment.
    assert [round(s.height_m) for s in stems_from_ndsm(h, ground, transform, 2.0, 12.0)] == [12]
    assert sorted(round(s.height_m) for s in stems_from_ndsm(h, ground, transform, roof_guard_area_m2=0.0)) == [2, 9, 12]
    # The tall floor is independent of the low floor: raising only the low floor keeps the 6 m² tall fragment.
    assert sorted(round(s.height_m) for s in stems_from_ndsm(h, ground, transform, min_area_m2=7.0, roof_guard_area_m2=0.0)) == [9, 12]
    assert [round(s.height_m) for s in stems_from_ndsm(h, ground, transform, min_area_m2=7.0, tall_min_area_m2=7.0, roof_guard_area_m2=0.0)] == [12]
    with pytest.raises(ValueError):
        stems_from_ndsm(h, ground, transform, tall_height_m=0.0)


def test_roof_guard_keeps_thin_birch_far_from_roofs_and_drops_it_beside_one():
    """A thin birch at 1.4 pts/m² is a 6-cell 10 m segment. The same segment
    2 m from a roof edge is indistinguishable by shape; only distance to a
    roof-suppressed cell separates them."""
    h = np.zeros((40, 40)); ground = np.full(h.shape, 60.0); transform = from_origin(0, 40, 1, 1)
    h[10:12, 10:13] = 10.0                          # birch, nearest roof cell 5 cells away
    h[30:32, 30:33] = 10.0                          # fragment, 2 cells from the roof
    roof = np.zeros(h.shape, dtype=bool); roof[0:6, 0:40] = True; roof[34:40, 28:36] = True
    stems = stems_from_ndsm(h, ground, transform, roof_mask=roof)
    assert [(s.x, s.y, round(s.height_m)) for s in stems] == [(11.5, 28.5, 10)]
    assert stems_from_ndsm(h, ground, transform) == []            # no mask: both dropped
    assert len(stems_from_ndsm(h, ground, transform, roof_mask=roof, roof_guard_m=1.0)) == 2
    h[20:25, 5:10] = 12.0                                         # 25 m² tree beside the roof: never guarded
    roof[18:27, 3:5] = True
    assert sorted(round(s.height_m) for s in stems_from_ndsm(h, ground, transform, roof_mask=roof)) == [10, 12]
    with pytest.raises(ValueError):
        stems_from_ndsm(h, ground, transform, roof_mask=roof[:20])


def test_las_command_roof_suppression_and_manifest_preservation(tmp_path):
    h, ground, transform = scene()
    yy, xx = np.mgrid[:60, :60]
    # Ground and canopy returns plus a single-return roof away from both crowns.
    h[:8, :8] = 10
    x = (540000 + xx + .5).ravel(); y = (6470000 - yy - .5).ravel()
    header = laspy.LasHeader(point_format=6, version="1.4")
    header.scales = np.array([.01, .01, .01])
    las = laspy.LasData(header)
    las.x = np.concatenate([x, x]); las.y = np.concatenate([y, y])
    las.z = np.concatenate([ground.ravel(), (ground + h).ravel()])
    las.classification = np.concatenate([np.full(x.size, 2), np.full(x.size, 1)]).astype(np.uint8)
    multi = np.where(h > 1, 2, 1); multi[:8, :8] = 1
    las.number_of_returns = np.concatenate([np.ones(x.size), multi.ravel()]).astype(np.uint8)
    lidar = tmp_path / "scene.las"; las.write(lidar)
    tiles = tmp_path / "tiles"; tiles.mkdir()
    (tiles / "manifest.json").write_text(json.dumps({
        "layers": {"ortho": {"minzoom": 14}}, "assets": {"other": {"path": "other.json"}}, "activeOrtho": "2025",
        "orthoVintages": [{"collection": "2025", "dates": ["2025-06-21"]}, {"collection": "2023", "dates": ["2023-04-22"]}]}))
    # Leaf-off pyramid: one uniformly green z18 tile over the scene (dark spruce colour).
    import mercantile
    from PIL import Image
    from rasterio.warp import transform as warp_coords
    lon, lat = warp_coords("EPSG:3006", "EPSG:4326", [540030], [6469970])
    tile = mercantile.tile(lon[0], lat[0], trees_stems.LEAF_OFF_ZOOM)
    tile_path = tiles / "ortho" / "2023" / str(tile.z) / str(tile.x) / f"{tile.y}.webp"
    tile_path.parent.mkdir(parents=True)
    Image.new("RGB", (256, 256), (40, 70, 40)).save(tile_path)
    stems = cmd_trees_stems([lidar], tmp_path / "trees.geojson", tiles, "course",
                           bbox_3006=(540000, 6469940, 540060, 6470000), workdir=tmp_path / "scratch")
    assert len(stems) == 2
    asset = json.loads((tiles / "tree-stems.json").read_text())
    manifest = json.loads((tiles / "manifest.json").read_text())
    assert len(asset["trees"]) == manifest["assets"]["tree-stems"]["count"] == 2
    assert manifest["assets"]["tree-stems"]["format"] == "tree-stems-v1" and asset["version"] == 2
    assert [row[5] for row in asset["trees"]] == [trees_stems.KIND_CONIFER] * 2
    geojson = json.loads((tmp_path / "trees.geojson").read_text())
    assert {f["properties"]["kind"] for f in geojson["features"]} == {trees_stems.KIND_CONIFER}
    # --no-kind and an explicit pyramid path both work.
    assert {s.kind for s in cmd_trees_stems([lidar], tmp_path / "nokind.geojson", tiles, "course",
            bbox_3006=(540000, 6469940, 540060, 6470000), leaf_off_ortho=None)} == {trees_stems.KIND_UNKNOWN}
    assert {s.kind for s in cmd_trees_stems([lidar], tmp_path / "explicit.geojson", tiles, "course",
            bbox_3006=(540000, 6469940, 540060, 6470000), leaf_off_ortho=tiles / "ortho" / "2023")} == {trees_stems.KIND_CONIFER}
    assert manifest["assets"]["other"]["path"] == "other.json"
    assert manifest["activeOrtho"] == "2025" and "ortho" in manifest["layers"]
    # Threshold pass-through: a 25 m floor removes every crown from the 20 m scene.
    assert cmd_trees_stems([lidar], tmp_path / "none.geojson", tiles, "course",
                           bbox_3006=(540000, 6469940, 540060, 6470000), min_height_m=25.0) == []
    assert json.loads((tiles / "manifest.json").read_text())["assets"]["tree-stems"]["count"] == 0


def test_thin_tall_tree_keeps_two_square_metres_of_support():
    """Linkan hole 13: a young 4.5 m tree fills three 1 m cells in a row. A
    3-cell blob under 3 m is still noise."""
    h = np.zeros((40, 40)); ground = np.full(h.shape, 60.0); transform = from_origin(0, 40, 1, 1)
    h[20, 10:13] = [4.0, 4.5, 4.5]                  # 3 m² tall: kept
    h[30, 10:13] = [2.0, 2.5, 2.5]                  # 3 m² low: dropped
    roof = np.zeros(h.shape, dtype=bool); roof[0:2, :] = True
    stems = stems_from_ndsm(h, ground, transform, roof_mask=roof)
    assert [(s.x, s.y, s.height_m) for s in stems] == [(11.5, 19.5, 4.5)]
    assert stems[0].crown_radius_m == pytest.approx(np.sqrt(3 / np.pi), abs=.01)
    assert stems_from_ndsm(h, ground, transform, tall_min_area_m2=4.0, roof_mask=roof) == []
    assert stems_from_ndsm(h, ground, transform) == []        # no roof mask: still guarded


def test_flat_compact_crown_keeps_equal_area_radius_but_hedge_and_sloping_crown_do_not():
    yy, xx = np.mgrid[:60, :80]; ground = np.full(yy.shape, 60.0); transform = from_origin(0, 60, 1, 1)
    h = np.zeros(yy.shape)
    willow = (xx - 15)**2 + (yy - 15)**2 <= 7**2
    h[willow] = 8.5; h[(xx - 15)**2 + (yy - 15)**2 <= 3**2] = 9.5   # flat 9.5 m crown, r 7
    h[40:43, 10:40] = 3.5                                            # 30 by 3 m hedge
    cone = (xx - 60)**2 + (yy - 40)**2 <= 7**2
    h[cone] = np.maximum(0, 16 - 2 * np.sqrt((xx - 60)**2 + (yy - 40)**2))[cone]   # sloping 16 m crown, r 7
    stems = {round(s.height_m, 1): s for s in stems_from_ndsm(h, ground, transform)}
    assert set(stems) == {9.5, 3.5, 16.0}
    assert stems[9.5].crown_radius_m == pytest.approx(7.0, abs=.15)          # flat and compact: equal-area wins
    assert stems[3.5].crown_radius_m == pytest.approx(1.5, abs=.01)          # hedge: low-crown floor, not 5.4 m
    assert stems[16.0].crown_radius_m == pytest.approx(0.35 * 16, abs=.01)   # sloping: 0.35 * height cap
    assert not trees_stems.is_flat_crown(10, 8.0, 7.0, 10.0)                  # p75 below 85% of top
    assert not trees_stems.is_flat_crown(10, 9.5, 5.4, 15.0)                  # strip: 5.4 / 15 under 0.55


def test_low_lobe_splits_off_a_tall_segment_but_a_sloping_skirt_does_not():
    """Linkan hole 13: a 9 m willow crown with a 19 m return inside its edge
    joins the 19 m tree's segment. The flat lobe gets its own marker at its
    centroid and keeps its own 3 by 3 top; the tall tree keeps the tall cells."""
    from golfpipe.trees_stems import segment_top_heights, split_low_lobes
    raw = np.zeros((30, 30), dtype=np.float32)
    raw[10:20, 5:15] = 9.0                       # flat 100 m² crown
    raw[13:17, 15:19] = [[12, 19, 17, 12]] * 4   # 16 m² tall top touching its east edge
    segments = np.where(raw > 0, 1, 0).astype(np.int32)
    peaks = [(14, 16)]
    split, new_peaks = split_low_lobes(raw, segments, peaks, 1.0)
    assert new_peaks == [(14, 16), (14, 9)] and segments.max() == 1     # input untouched
    assert np.count_nonzero(split == 2) == 100 and np.count_nonzero(split == 1) == 16
    tops = segment_top_heights(raw, split)
    assert tops[14, 9] == 9.0 and tops[14, 14] == 9.0 and tops[14, 16] == 19.0
    # The lower ring of a sloping 16 m cone is flat enough in percentile terms, but its
    # highest cells all touch the cone's core: it is the tree's own skirt.
    yy, xx = np.mgrid[:30, :30]
    cone = np.maximum(0, 16 - 2 * np.sqrt((xx - 15) ** 2 + (yy - 15) ** 2)).astype(np.float32)
    assert split_low_lobes(cone, np.where(cone > 0, 1, 0).astype(np.int32), [(15, 15)], 1.0)[1] == [(15, 15)]
    # Lobes below the height floor are not split (a 3 m top has nothing under 0.6 * 3 m to give).
    low = np.where(raw > 0, 3.0, 0).astype(np.float32)
    assert split_low_lobes(low, segments, peaks, 1.0)[1] == peaks
