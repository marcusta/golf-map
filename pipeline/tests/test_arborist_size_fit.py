"""arborist.py: a tree whose Arborist model is another shape than its Unity prefab is sized to its lidar stem (SizeFit)."""
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import arborist  # noqa: E402

RULES = {"minScale": 0.5, "maxScale": 1.8, "shrubMaxHeightM": 3.5, "woodlandRadiusM": 20, "woodlandMinNeighbours": 4,
         "woodlandCrownMultiplier": 1.16, "woodlandWidthWeight": 2, "woodlandScaleBoost": 1.1, "openCrownPadM": 0.7, "openWidthWeight": 1.5}
SLIM = {"heightM": 10.0, "widthM": 4.0}    # Unity's prefab
WIDE = {"heightM": 10.0, "widthM": 8.0}    # Arborist's model: same height, twice as wide


def stem(id, x, z, h=10.0, r=2.65):
    return {"id": id, "x": x, "z": z, "h": h, "r": r}


def test_open_grown_tree_aims_at_the_lidar_crown_plus_the_pad():
    fit = arborist.SizeFit([stem("a", 100, 100)], RULES)
    # Arborist's model at its fit: (h 10, crown 2*2.65+0.7 = 6 m) with height counting 2 and width 1.5.
    want = math.exp((2 * math.log(10 / 10) + 1.5 * math.log(6 / 8)) / 3.5)
    unity = math.exp((2 * math.log(10 / 10) + 1.5 * math.log(6 / 4)) / 3.5)
    assert math.isclose(fit.ratio(100, 100, SLIM, WIDE), want / unity)
    # the wider model comes out smaller than its height-only scale (1.0), the slim one larger
    assert fit.ratio(100, 100, SLIM, WIDE) < 1 < fit.ratio(100, 100, WIDE, SLIM)


def test_same_shape_gives_one_and_a_moved_tree_has_no_stem():
    fit = arborist.SizeFit([stem("a", 100, 100)], RULES)
    assert math.isclose(fit.ratio(100.004, 99.996, SLIM, SLIM), 1.0)    # the float position, to the centimetre
    assert fit.ratio(103, 100, SLIM, WIDE) is None


def test_woodland_stems_use_the_canopy_rule():
    stand = [stem(f"w{i}", 100 + 5 * (i % 3), 100 + 5 * (i // 3)) for i in range(6)]
    fit = arborist.SizeFit(stand, RULES)
    assert "w4" in fit.woodland
    s = fit.stem(105, 105)
    want = math.exp((2 * math.log(10 / 10) + 2 * math.log(2 * 2.65 * 1.16 / 8)) / 4) * 1.1
    assert math.isclose(fit.scale(s, 10, 8, False), want)


def test_unity_side_keeps_its_scale_limits_arborist_side_does_not():
    fit = arborist.SizeFit([stem("a", 100, 100, h=4.0, r=1.0)], RULES)
    s = fit.stem(100, 100)
    tall = {"heightM": 15.0, "widthM": 12.0}
    assert fit.scale(s, 15, 12, True) == 0.5               # Unity's prefab pinned at minScale
    assert fit.scale(s, 15, 12, False) < 0.5               # Arborist's model goes to the stem's size
    assert math.isclose(fit.ratio(100, 100, tall, tall), fit.scale(s, 15, 12, False) / 0.5)
