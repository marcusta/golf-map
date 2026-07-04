from pathlib import Path

import mercantile
import numpy as np
from PIL import Image

from golfpipe.commands import cmd_tile_ortho, cmd_tile_terrain
from golfpipe.terrain_rgb import decode_terrain_rgb
from golfpipe.tiling import raster_bounds_wgs84


def test_tile_ortho_writes_expected_zxy(tmp_path: Path, synthetic_ortho: Path):
    out_dir = tmp_path / "ortho_tiles"
    minzoom, maxzoom = 15, 16
    count = cmd_tile_ortho(synthetic_ortho, out_dir, minzoom=minzoom, maxzoom=maxzoom)
    assert count > 0

    bbox = raster_bounds_wgs84(synthetic_ortho)
    expected_tiles = list(mercantile.tiles(*bbox, [minzoom, maxzoom]))
    assert expected_tiles, "sanity: raster bbox should cover at least one tile"

    found_any = False
    for tile in expected_tiles:
        tile_path = out_dir / str(tile.z) / str(tile.x) / f"{tile.y}.jpg"
        if tile_path.exists():
            found_any = True
            img = Image.open(tile_path)
            img.verify()
    assert found_any, "expected at least one tile at a computed z/x/y path"


def test_tile_ortho_jpeg_tiles_are_valid_images(tmp_path: Path, synthetic_ortho: Path):
    out_dir = tmp_path / "ortho_tiles"
    cmd_tile_ortho(synthetic_ortho, out_dir, minzoom=16, maxzoom=16)

    jpgs = list(out_dir.rglob("*.jpg"))
    assert jpgs, "no jpg tiles were written"
    for jpg in jpgs:
        img = Image.open(jpg)
        assert img.format == "JPEG"
        img.load()  # fully decode, raises on corruption


def test_tile_ortho_skips_fully_nodata_tiles(tmp_path: Path, synthetic_ortho_with_nodata: Path):
    out_dir = tmp_path / "ortho_tiles"
    # High zoom so some tiles fall entirely within the nodata quadrant.
    count = cmd_tile_ortho(synthetic_ortho_with_nodata, out_dir, minzoom=18, maxzoom=18)
    total_possible = sum(1 for _ in mercantile.tiles(*raster_bounds_wgs84(synthetic_ortho_with_nodata), [18]))
    assert 0 < count < total_possible, (
        "expected some but not all tiles to be written (nodata tiles skipped)"
    )


def test_tile_terrain_writes_expected_zxy(tmp_path: Path, synthetic_dem: Path):
    out_dir = tmp_path / "terrain_tiles"
    minzoom, maxzoom = 14, 15
    count = cmd_tile_terrain(synthetic_dem, out_dir, minzoom=minzoom, maxzoom=maxzoom)
    assert count > 0

    bbox = raster_bounds_wgs84(synthetic_dem)
    expected_tiles = list(mercantile.tiles(*bbox, [minzoom, maxzoom]))
    found_any = False
    for tile in expected_tiles:
        tile_path = out_dir / str(tile.z) / str(tile.x) / f"{tile.y}.png"
        if tile_path.exists():
            found_any = True
    assert found_any


def test_tile_terrain_decode_round_trips_within_tolerance(tmp_path: Path, synthetic_dem: Path):
    """The DEM fixture has a known gradient (100..150 m west->east). After
    reprojection + tiling + terrain-RGB encoding, decoding a tile's pixels
    should still recover heights within the source gradient's min/max
    (plus small resampling slack), *for tiles fully inside the source
    raster's real coverage*. Edge tiles at this zoom legitimately extend
    past the 512x512 m source extent into the WarpedVRT's padded/nodata
    area (filled as height 0 per the documented nodata policy), so we
    check the one tile guaranteed to be fully interior: the centre tile.
    """
    out_dir = tmp_path / "terrain_tiles"
    minzoom = maxzoom = 16
    cmd_tile_terrain(synthetic_dem, out_dir, minzoom=minzoom, maxzoom=maxzoom)

    bbox = raster_bounds_wgs84(synthetic_dem)
    center_lon = (bbox[0] + bbox[2]) / 2
    center_lat = (bbox[1] + bbox[3]) / 2
    center_tile = mercantile.tile(center_lon, center_lat, maxzoom)

    png = out_dir / str(center_tile.z) / str(center_tile.x) / f"{center_tile.y}.png"
    assert png.exists(), "expected the centre tile to be written"

    img = Image.open(png)
    assert img.format == "PNG"
    rgb = np.array(img.convert("RGB"))
    heights = decode_terrain_rgb(rgb)
    # Gradient source range is [100, 150]; allow resampling slack.
    assert heights.min() >= 90.0
    assert heights.max() <= 160.0


def test_tile_terrain_nodata_filled_as_zero_height(tmp_path: Path, synthetic_dem_with_nodata: Path):
    """Documented nodata policy for outside-coverage/edge padding: nodata
    pixels are filled with height 0 m before Terrain-RGB encoding (see
    cmd_tile_terrain docstring and README). This test locks that behavior
    in rather than silently tolerating a huge negative sentinel leaking
    into decoded heights. synthetic_dem_with_nodata's nodata patch sits in
    a corner (touching the raster edge), matching the "outside real
    coverage" case that --fill-nodata intentionally leaves 0-filled.
    """
    out_dir = tmp_path / "terrain_tiles"
    cmd_tile_terrain(synthetic_dem_with_nodata, out_dir, minzoom=16, maxzoom=16)

    pngs = list(out_dir.rglob("*.png"))
    assert pngs

    all_heights = []
    for png in pngs:
        img = Image.open(png)
        rgb = np.array(img.convert("RGB"))
        all_heights.append(decode_terrain_rgb(rgb))

    stacked = np.concatenate([h.ravel() for h in all_heights])
    # No absurd negative sentinel values (old nodata was -9999) should
    # survive into decoded output.
    assert stacked.min() > -1000.0


def test_tile_terrain_fills_interior_nodata_hole_no_zero_pit(tmp_path: Path, synthetic_dem_with_interior_hole: Path):
    """Regression test for the Landeryd cliff-wall bug: a DEM with a
    nodata hole *inside* its real coverage (surrounded by valid gradient
    data on all sides, not touching any raster edge) must NOT be 0-filled
    -- with --fill-nodata (the default), rasterio.fill.fillnodata should
    inpaint it so decoded heights over the former hole stay within the
    surrounding gradient's range, instead of plunging to a 0 m pit.

    Like test_tile_terrain_decode_round_trips_within_tolerance, we check
    only the centre tile (guaranteed fully inside the source raster's real
    coverage, and where the interior hole actually lands) since edge tiles
    legitimately extend into the WarpedVRT's 0-filled outside-coverage
    padding regardless of --fill-nodata.
    """
    out_dir = tmp_path / "terrain_tiles"
    minzoom = maxzoom = 16
    cmd_tile_terrain(synthetic_dem_with_interior_hole, out_dir, minzoom=minzoom, maxzoom=maxzoom, fill_nodata=True)

    bbox = raster_bounds_wgs84(synthetic_dem_with_interior_hole)
    center_lon = (bbox[0] + bbox[2]) / 2
    center_lat = (bbox[1] + bbox[3]) / 2
    center_tile = mercantile.tile(center_lon, center_lat, maxzoom)

    png = out_dir / str(center_tile.z) / str(center_tile.x) / f"{center_tile.y}.png"
    assert png.exists(), "expected the centre tile to be written"

    img = Image.open(png)
    rgb = np.array(img.convert("RGB"))
    heights = decode_terrain_rgb(rgb)
    # The source gradient is 100..150 m; a 0-filled hole would show up as
    # a hard floor at 0.0. With interpolation, every decoded height should
    # stay close to the gradient's real range (small resampling slack).
    assert heights.min() >= 90.0, f"found a height ({heights.min()}) consistent with an unfilled 0 m pit"
    assert heights.max() <= 160.0


def test_tile_terrain_edge_pad_boundary_tiles_have_no_zero_cliff(tmp_path: Path, synthetic_dem_min50: Path):
    """Regression test for the edge-wall artifact: a DEM whose every value
    is >= 50 m should, after tiling, produce ZERO tiles anywhere in the
    pyramid with a decoded height below the source minimum (allowing a
    small epsilon for resampling) -- not just the interior tiles. Boundary
    and corner tiles sample the WarpedVRT's padded/outside-coverage area,
    which used to be hard 0-filled (the "cliff wall" bug); with edge_pad_m
    > 0 (the default), that area is edge-replicated instead, so it should
    never read as 0 m.
    """
    out_dir = tmp_path / "terrain_tiles"
    minzoom = maxzoom = 16
    cmd_tile_terrain(synthetic_dem_min50, out_dir, minzoom=minzoom, maxzoom=maxzoom)

    pngs = list(out_dir.rglob("*.png"))
    assert pngs, "expected terrain tiles to be written"

    epsilon = 1.0
    source_min = 50.0
    worst = None
    for png in pngs:
        img = Image.open(png)
        rgb = np.array(img.convert("RGB"))
        heights = decode_terrain_rgb(rgb)
        tile_min = heights.min()
        if worst is None or tile_min < worst:
            worst = tile_min
        assert tile_min >= source_min - epsilon, (
            f"{png} decoded a height ({tile_min}) below the source minimum "
            f"({source_min}) minus epsilon -- looks like an unfilled 0 m cliff-wall pixel"
        )

    assert worst is not None and worst >= source_min - epsilon


def test_tile_terrain_edge_pad_zero_restores_old_zero_fill_boundary(tmp_path: Path, synthetic_dem_min50: Path):
    """Sanity check for the --edge-pad 0 escape hatch: with edge padding
    disabled, at least one boundary/corner tile should show the old 0 m
    floor (proving edge_pad_dem is what fixes the previous test, not
    resampling smoothing it away for free).
    """
    out_dir = tmp_path / "terrain_tiles"
    minzoom = maxzoom = 16
    cmd_tile_terrain(synthetic_dem_min50, out_dir, minzoom=minzoom, maxzoom=maxzoom, edge_pad_m=0)

    pngs = list(out_dir.rglob("*.png"))
    assert pngs

    global_min = None
    for png in pngs:
        img = Image.open(png)
        rgb = np.array(img.convert("RGB"))
        heights = decode_terrain_rgb(rgb)
        tile_min = heights.min()
        if global_min is None or tile_min < global_min:
            global_min = tile_min

    assert global_min is not None and global_min < 10.0, (
        "expected at least one tile to still show the old 0 m outside-coverage "
        "fill when edge_pad_m=0, confirming edge padding is what fixes it"
    )


def test_tile_terrain_no_fill_nodata_leaves_interior_hole_as_zero(tmp_path: Path, synthetic_dem_with_interior_hole: Path):
    """Sanity check for the --no-fill-nodata escape hatch: with fill_nodata
    disabled, the interior hole reproduces the old (buggy) 0 m pit
    behavior in the same centre tile, proving the fillnodata step in the
    previous test is what actually fixes it (not e.g. resampling smoothing
    it away for free).
    """
    out_dir = tmp_path / "terrain_tiles"
    minzoom = maxzoom = 16
    cmd_tile_terrain(synthetic_dem_with_interior_hole, out_dir, minzoom=minzoom, maxzoom=maxzoom, fill_nodata=False)

    bbox = raster_bounds_wgs84(synthetic_dem_with_interior_hole)
    center_lon = (bbox[0] + bbox[2]) / 2
    center_lat = (bbox[1] + bbox[3]) / 2
    center_tile = mercantile.tile(center_lon, center_lat, maxzoom)

    png = out_dir / str(center_tile.z) / str(center_tile.x) / f"{center_tile.y}.png"
    assert png.exists()

    img = Image.open(png)
    rgb = np.array(img.convert("RGB"))
    heights = decode_terrain_rgb(rgb)
    # Without fill-nodata, the interior hole is 0-filled, so the centre
    # tile's decoded heights should drop well below the real 100..150 m
    # gradient range.
    assert heights.min() < 50.0
