"""cmd_reproject_bbox: WGS84 bbox -> EPSG:3006 (SWEREF99 TM) metres."""

from golfpipe.commands import cmd_reproject_bbox


def test_wgs84_to_sweref99_tm_is_in_metre_range():
    # A bbox over Vreta Kloster (~15.5E, 58.53N).
    e_min, n_min, e_max, n_max = cmd_reproject_bbox((15.50, 58.52, 15.53, 58.54), epsg=3006)

    # Ordering preserved.
    assert e_min < e_max
    assert n_min < n_max

    # SWEREF99 TM eastings sit near the 500 km central-meridian offset; this
    # part of Sweden is ~529 km E, ~6487 km N.
    assert 520_000 < e_min < 540_000
    assert 6_480_000 < n_min < 6_495_000


def test_defaults_to_epsg_3006():
    a = cmd_reproject_bbox((15.50, 58.52, 15.53, 58.54))
    b = cmd_reproject_bbox((15.50, 58.52, 15.53, 58.54), epsg=3006)
    assert a == b
