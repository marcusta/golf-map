from pathlib import Path

import numpy as np
import rasterio

from golfpipe.commands import cmd_tile_hillshade
from golfpipe.hillshade import hillshade_horn, write_hillshade_geotiff
from golfpipe.manifest import build_manifest


def test_hillshade_horn_is_opaque_uint8_with_relief():
    # A tilted plane → uniform aspect, so shading is a single non-extreme value
    # everywhere (opaque, not transparent, not clipped to pure black/white).
    yy, xx = np.mgrid[0:32, 0:32].astype("float64")
    dem = 100.0 + 0.5 * xx  # slope in +x
    shade = hillshade_horn(dem, res_m=1.0)
    assert shade.dtype == np.uint8
    assert shade.min() > 0 and shade.max() < 255  # every pixel a real grey value


def test_write_hillshade_geotiff_single_band_uint8(tmp_path: Path, synthetic_dem: Path):
    out = tmp_path / "hs.tif"
    write_hillshade_geotiff(synthetic_dem, out)
    with rasterio.open(out) as src:
        assert src.count == 1
        assert src.dtypes[0] == "uint8"
        assert src.crs is not None
        band = src.read(1)
    # Flat-ish synthetic gradient → mid-grey, opaque (no zeros = no transparency holes).
    assert band.min() > 0


def test_cmd_tile_hillshade_writes_tiles_and_manifest_layer(tmp_path: Path, synthetic_dem: Path):
    out_dir = tmp_path / "hillshade"
    count = cmd_tile_hillshade(synthetic_dem, out_dir, minzoom=15, maxzoom=16)
    assert count > 0
    assert list(out_dir.rglob("*.webp"))

    manifest = build_manifest("c-hs", hillshade_tiles_dir=out_dir, dem_path=synthetic_dem)
    assert manifest["layers"]["hillshade"] == {"minzoom": 15, "maxzoom": 16}
