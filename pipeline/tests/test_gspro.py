"""gspro rendering helpers — square extent + hillshade, no network."""

import json

import numpy as np
import pytest
import rasterio
from rasterio.transform import from_origin
from rasterio.transform import from_bounds
from rasterio.crs import CRS
from PIL import Image

import gspro

BBOX = (15.50, 58.52, 15.53, 58.54)  # Vreta-ish, WGS84


def test_square_3006_extent_is_square():
    e0, n0, e1, n1 = gspro._square_3006_extent(BBOX)
    assert abs((e1 - e0) - (n1 - n0)) < 1e-6  # true square in metres
    assert e1 > e0 and n1 > n0


def test_square_3006_extent_side_is_the_next_whole_ten_metres():
    from rasterio.warp import transform_bounds
    e0, n0, e1, n1 = gspro._square_3006_extent(BBOX)
    side = e1 - e0
    assert abs(side / gspro.SIDE_STEP_M - round(side / gspro.SIDE_STEP_M)) < 1e-6
    # Rounded UP, so nothing of the WGS84 area is cut off.
    r0, s0, r1, s1 = transform_bounds(gspro.WGS84, gspro.SWEREF99, *BBOX)
    assert side >= max(r1 - r0, s1 - s0) - 1e-6
    assert side < max(r1 - r0, s1 - s0) + gspro.SIDE_STEP_M


def test_square_3006_flag_is_used_verbatim_and_gives_a_wgs84_envelope():
    import argparse
    args = argparse.Namespace(square_3006="529030,6486669,531080,6488719", bbox=None)
    bbox, extent = gspro._resolve_area(args)
    assert extent == (529030.0, 6486669.0, 531080.0, 6488719.0)
    west, south, east, north = bbox
    assert 15.4 < west < east < 15.6 and 58.4 < south < north < 58.6
    # --bbox alone still squares + snaps.
    args = argparse.Namespace(square_3006=None, bbox=",".join(str(v) for v in BBOX))
    bbox2, extent2 = gspro._resolve_area(args)
    assert bbox2 == BBOX and extent2 == gspro._square_3006_extent(BBOX)


def test_square_3006_flag_rejects_non_squares_and_garbage():
    import pytest
    for bad in ["1,2,3", "0,0,100,90", "100,100,0,0", "a,b,c,d"]:
        with pytest.raises(SystemExit):
            gspro._parse_square(bad)


def _synthetic_dem(path, extent):
    """A DEM (EPSG:3006) with a Gaussian mound covering `extent`, so slope and
    aspect vary and hillshade is genuinely non-uniform."""
    w = 200
    e0, n0, e1, n1 = extent
    gx, gy = np.meshgrid(np.linspace(0, 1, w), np.linspace(0, 1, w))
    data = (30.0 * np.exp(-(((gx - 0.5) ** 2 + (gy - 0.5) ** 2) / 0.05))).astype("float32")
    transform = from_bounds(e0, n0, e1, n1, w, w)
    with rasterio.open(
        path, "w", driver="GTiff", height=w, width=w, count=1,
        dtype="float32", crs=CRS.from_epsg(3006), transform=transform,
    ) as dst:
        dst.write(data, 1)


def test_hillshade_renders_square_grayscale_jpeg(tmp_path):
    dem = tmp_path / "dem.tif"
    _synthetic_dem(dem, gspro._square_3006_extent(BBOX))
    out = tmp_path / "hs.jpg"

    gspro.cmd_hillshade(BBOX, out, size=64, dem_path=dem,
                        azimuth=315.0, altitude=45.0, z=1.0, resolution=0.5)

    assert out.exists()
    with Image.open(out) as im:
        assert im.size == (64, 64)
        assert im.mode == "L"  # single-band grayscale


def test_hillshade_of_a_ramp_is_not_flat(tmp_path):
    dem = tmp_path / "dem.tif"
    _synthetic_dem(dem, gspro._square_3006_extent(BBOX))
    out = tmp_path / "hs.jpg"
    gspro.cmd_hillshade(BBOX, out, size=64, dem_path=dem,
                        azimuth=315.0, altitude=45.0, z=1.0, resolution=0.5)
    arr = np.asarray(Image.open(out))
    assert arr.std() > 0  # a tilted plane must produce shading variation


def _synthetic_ortho(path, extent, w=120):
    """An RGB orthophoto (EPSG:3006) covering `extent`: red ramps west→east,
    green south→north, blue constant — so a re-rendered square still shows
    orientation and is far from uniform."""
    e0, n0, e1, n1 = extent
    gx, gy = np.meshgrid(np.linspace(0, 255, w), np.linspace(255, 0, w))
    data = np.stack([gx, gy, np.full((w, w), 90.0)]).astype("uint8")
    transform = from_bounds(e0, n0, e1, n1, w, w)
    with rasterio.open(
        path, "w", driver="GTiff", height=w, width=w, count=3,
        dtype="uint8", crs=CRS.from_epsg(3006), transform=transform,
    ) as dst:
        dst.write(data)


def test_ortho_from_local_source_writes_a_square_rgb_jpeg_at_out(tmp_path):
    src = tmp_path / "ortho-orto-l2-2025.tif"
    _synthetic_ortho(src, gspro._square_3006_extent(BBOX))
    out = tmp_path / "exports" / "vreta-orto-l2-2025.jpg"

    gspro.cmd_ortho(BBOX, None, size=64, count=2, ortho_tifs=[src], quality=80, out=out)

    assert out.exists()  # parent folder created on the way
    with Image.open(out) as im:
        assert im.format == "JPEG"
        assert im.size == (64, 64)
        assert im.mode == "RGB"
        arr = np.asarray(im)
    # Orientation survives the reprojection: red grows eastward, green northward.
    assert arr[32, 60, 0] > arr[32, 3, 0] + 100
    assert arr[3, 32, 1] > arr[60, 32, 1] + 100


def test_ortho_terrain_variant_is_the_same_render_darkened(tmp_path):
    """--terrain-out: a second JPEG of the same square with RGB × darken, for
    the Unity terrain texture (the shader lights the photo a second time)."""
    src = tmp_path / "ortho.tif"
    _synthetic_ortho(src, gspro._square_3006_extent(BBOX))
    out = tmp_path / "vreta-orto-8192.jpg"
    terrain = tmp_path / "vreta-orto-8192-terrain.jpg"

    gspro.cmd_ortho(BBOX, None, size=64, count=2, ortho_tifs=[src], quality=95, out=out,
                    terrain_out=terrain, darken=0.5, darken_space="srgb")

    plain = np.asarray(Image.open(out)).astype(float)
    dark = np.asarray(Image.open(terrain)).astype(float)
    assert dark.shape == plain.shape == (64, 64, 3)
    assert np.abs(dark - plain * 0.5).mean() < 1.5  # near-lossless: q97, no chroma subsampling
    assert dark.max() < plain.max()
    # The twin is not encoded any harder than the plain file, tonal range aside.
    assert terrain.stat().st_size > 0.6 * out.stat().st_size

    # Linear light (the default): ×0.25 on the light is ×~0.53 on mid-tone
    # sRGB values, far gentler than ×0.25 on the bytes, and hue-preserving.
    gspro.cmd_ortho(BBOX, None, size=64, count=2, ortho_tifs=[src], quality=95, out=out,
                    terrain_out=terrain, darken=0.25)
    lin = np.asarray(Image.open(terrain)).astype(float)
    mid = (plain > 60) & (plain < 200)
    ratio = (lin[mid] / plain[mid]).mean()
    assert 0.45 < ratio < 0.6
    with pytest.raises(SystemExit, match="--darken-space"):
        gspro.cmd_ortho(BBOX, None, 32, 2, [src], out=out, terrain_out=terrain, darken_space="hsl")
    with pytest.raises(SystemExit, match="--darken"):
        gspro.cmd_ortho(BBOX, None, 32, 2, [src], out=out, terrain_out=terrain, darken=0)
    with pytest.raises(SystemExit, match="--terrain-out"):
        gspro.cmd_ortho(BBOX, tmp_path, 32, 2, [src], terrain_out=terrain)


def test_darken_is_a_true_light_multiplier_in_linear_space():
    grey = np.full((1, 1, 3), 188, dtype=np.uint8)   # sRGB 188 ≈ 0.5 linear
    half = gspro._darken(grey, 0.5, "linear")[0, 0, 0]
    assert 136 <= half <= 138                          # 0.25 linear = sRGB 137
    assert gspro._darken(grey, 0.5, "srgb")[0, 0, 0] == 94
    assert gspro._darken(np.zeros((1, 1, 3), np.uint8), 0.3, "linear").max() == 0
    assert gspro._darken(np.full((1, 1, 3), 255, np.uint8), 1.0, "linear").min() == 255


def test_ortho_quality_changes_the_file_size(tmp_path):
    src = tmp_path / "ortho.tif"
    _synthetic_ortho(src, gspro._square_3006_extent(BBOX))
    sizes = {}
    for q in (30, 80, 95):
        out = tmp_path / f"q{q}.jpg"
        gspro.cmd_ortho(BBOX, None, size=64, count=2, ortho_tifs=[src], quality=q, out=out)
        sizes[q] = out.stat().st_size
    assert sizes[30] < sizes[80] < sizes[95]


def test_ortho_out_dir_names_files_after_the_source(tmp_path):
    src = tmp_path / "ortho-orto-l2-2023.tif"
    _synthetic_ortho(src, gspro._square_3006_extent(BBOX))
    out_dir = tmp_path / "out"
    gspro.cmd_ortho(BBOX, out_dir, size=32, count=2, ortho_tifs=[src])
    assert (out_dir / "ortho_ortho-orto-l2-2023_32px.jpg").exists()


def test_ortho_rejects_out_with_several_sources_and_a_missing_source(tmp_path):
    import pytest
    src = tmp_path / "a.tif"
    _synthetic_ortho(src, gspro._square_3006_extent(BBOX))
    with pytest.raises(SystemExit, match="exactly one --ortho"):
        gspro.cmd_ortho(BBOX, None, 32, 2, [src, src], out=tmp_path / "x.jpg")
    with pytest.raises(SystemExit, match="no such orthophoto"):
        gspro.cmd_ortho(BBOX, None, 32, 2, [tmp_path / "missing.tif"], out=tmp_path / "x.jpg")
    with pytest.raises(SystemExit, match="--quality"):
        gspro.cmd_ortho(BBOX, None, 32, 2, [src], quality=0, out=tmp_path / "x.jpg")


# --- dem --------------------------------------------------------------------

def test_dem_writes_a_square_float32_geotiff_with_a_height_range_sidecar(tmp_path):
    import json
    extent = (529030.0, 6486669.0, 529230.0, 6486869.0)  # a 200 m square
    src = tmp_path / "dem.tif"
    _synthetic_dem(src, (extent[0] - 50, extent[1] - 50, extent[2] + 50, extent[3] + 50))
    out = tmp_path / "vreta-inner-dem-200m.tif"

    gspro.cmd_dem(None, src, out, resolution=5.0, extent=extent, raw_size=0)

    with rasterio.open(out) as ds:
        assert ds.count == 1 and ds.dtypes[0] == "float32"
        assert ds.width == ds.height == 40  # 200 m / 5 m
        assert ds.crs.to_epsg() == 3006
        assert tuple(round(v, 6) for v in ds.bounds) == extent
        data = ds.read(1)
    assert np.isfinite(data).all()
    assert data.max() > data.min()  # the mound is in there
    assert not (tmp_path / "vreta-inner-dem-200m.raw").exists()  # raw_size=0 skips it

    sidecar = json.loads((tmp_path / "vreta-inner-dem-200m.tif.json").read_text())
    assert sidecar["square3006"] == list(extent)
    assert sidecar["centre3006"] == [529130.0, 6486769.0]
    assert sidecar["sideM"] == 200.0 and sidecar["resolution"] == 5.0 and sidecar["size"] == 40
    assert sidecar["minM"] == float(data.min()) and sidecar["maxM"] == float(data.max())
    assert sidecar["heightRangeM"] == sidecar["maxM"] - sidecar["minM"]
    assert sidecar["crs"] == "EPSG:3006" and sidecar["source"] == "dem.tif"
    assert sidecar["terrain"] is None and "raw" not in sidecar
    # The Unity terrain settings OPCD's MinMax sheet is filled in for.
    assert sidecar["unity"] == {
        "terrainWidthM": 200.0, "terrainLengthM": 200.0, "terrainHeightM": sidecar["heightRangeM"],
        "heightmapResolution": 4097, "depth": 16, "byteOrder": "Windows", "flipVertically": True,
    }


def _read_raw(path, size):
    return np.frombuffer(path.read_bytes(), dtype="<u2").reshape(size, size)


def test_dem_writes_the_unity_raw_heightmap_opcds_bat_would(tmp_path):
    """The TIF→RAW step itself: uint16 little-endian, [min,max] → [0,65535],
    north-up rows, resampled to the Unity heightmap resolution."""
    import json
    extent = (0.0, 0.0, 200.0, 200.0)
    src = tmp_path / "dem.tif"
    # A plane rising to the north-east: z = x + 2y over the square.
    transform = from_origin(-50, 250, 1.0, 1.0)
    ys, xs = np.mgrid[0:300, 0:300]
    plane = ((xs - 50) + 2 * (250 - ys)).astype("float32")  # x + 2*northing
    with rasterio.open(src, "w", driver="GTiff", height=300, width=300, count=1, dtype="float32",
                       crs=gspro.SWEREF99, transform=transform) as ds:
        ds.write(plane, 1)
    out = tmp_path / "x-inner-dem-200m.tif"

    gspro.cmd_dem(None, src, out, resolution=10.0, extent=extent, raw_size=33, terrain="inner")

    raw = _read_raw(tmp_path / "x-inner-dem-200m.raw", 33)
    sidecar = json.loads((out.with_name(out.name + ".json")).read_text())
    assert sidecar["raw"] == {
        "file": "x-inner-dem-200m.raw", "size": 33, "dtype": "uint16", "byteOrder": "little-endian",
        "rowOrder": "north-up", "scale": {"minM": sidecar["minM"], "maxM": sidecar["maxM"], "to": [0, 65535]},
    }
    assert sidecar["terrain"] == "inner"
    assert sidecar["unity"]["heightmapResolution"] == 33
    assert sidecar["unity"]["position"] == {"x": 0.0, "y": 0.0, "z": 0.0}
    # The range covers the whole square: z from 0 (SW) to ~600 (NE).
    assert sidecar["minM"] == pytest.approx(0, abs=20) and sidecar["maxM"] == pytest.approx(600, abs=20)
    # Scaled over [min, max] — the extremes hit the ends of the uint16 range.
    assert raw.min() == 0 and raw.max() == 65535
    # North-up: the top row is the high (north) edge, and heights rise eastward along a row.
    assert raw[0].mean() > raw[-1].mean()
    assert raw[16, -1] > raw[16, 0]
    # The RAW's height at a cell matches the TIF's height there, once unscaled.
    with rasterio.open(out) as ds:
        tif = ds.read(1)
    unscaled = sidecar["minM"] + raw.astype("float64") / 65535 * sidecar["heightRangeM"]
    assert unscaled[0, 0] == pytest.approx(tif[0, 0], abs=(tif.max() - tif.min()) / 20)


def test_dem_fills_where_the_source_stops_instead_of_leaking_its_nodata(tmp_path):
    """An outer square can reach past the DEM (a withheld lidar tile, or a
    smaller source): those cells, and the source's tagged -9999 cells, must
    come out as filled ground, not as a 10 km cliff — in the TIF and the RAW."""
    src = tmp_path / "dem.tif"
    transform = from_origin(0, 100, 1.0, 1.0)  # covers x 0..100, y 0..100 only
    data = np.full((100, 100), 50.0, dtype="float32")
    data[10:20, 10:20] = -9999.0  # a tagged hole inside the coverage too
    with rasterio.open(src, "w", driver="GTiff", height=100, width=100, count=1, dtype="float32",
                       crs=gspro.SWEREF99, transform=transform, nodata=-9999.0) as ds:
        ds.write(data, 1)
    out = tmp_path / "x-outer-dem-200m.tif"

    gspro.cmd_dem(None, src, out, resolution=5.0, extent=(-50.0, -50.0, 150.0, 150.0), raw_size=41)

    with rasterio.open(out) as ds:
        tif = ds.read(1)
    assert np.isfinite(tif).all()
    assert tif.min() == pytest.approx(50.0, abs=0.01) and tif.max() == pytest.approx(50.0, abs=0.01)
    raw = _read_raw(tmp_path / "x-outer-dem-200m.raw", 41)
    sidecar = json.loads(out.with_name(out.name + ".json").read_text())
    assert sidecar["minM"] == pytest.approx(50.0, abs=0.01) and sidecar["maxM"] == pytest.approx(50.0, abs=0.01)
    assert raw.min() == raw.max() == 0  # a flat source scales to a flat heightmap, not a cliff


def test_outer_dem_positions_itself_against_the_inner_sidecar(tmp_path):
    """An OUTER export given the inner's sidecar records where the outer
    terrain goes in Unity with the inner at the origin: half the side
    difference to the south-west, lifted by the difference in minima."""
    import json
    src = tmp_path / "dem.tif"
    _synthetic_dem(src, (-200, -200, 600, 600))
    inner_extent = (100.0, 100.0, 300.0, 300.0)   # 200 m, centred on (200, 200)
    outer_extent = (0.0, 0.0, 400.0, 400.0)       # 400 m, same centre
    inner_out = tmp_path / "x-inner-dem-200m.tif"
    outer_out = tmp_path / "x-outer-dem-400m.tif"
    gspro.cmd_dem(None, src, inner_out, resolution=10.0, extent=inner_extent, raw_size=17, terrain="inner")
    inner_sidecar = inner_out.with_name(inner_out.name + ".json")

    gspro.cmd_dem(None, src, outer_out, resolution=10.0, extent=outer_extent, raw_size=17, terrain="outer",
                  inner_sidecar=inner_sidecar)

    inner = json.loads(inner_sidecar.read_text())
    outer = json.loads(outer_out.with_name(outer_out.name + ".json").read_text())
    assert outer["terrain"] == "outer"
    assert outer["unity"]["position"] == {
        "x": -100.0, "z": -100.0,
        "y": round(outer["minM"] - inner["minM"], 3),
        "innerSidecar": "x-inner-dem-200m.tif.json",
    }
    assert outer["minM"] <= inner["minM"]  # the outer covers more ground, so it can only reach lower

    with pytest.raises(SystemExit, match="inner sidecar"):
        gspro.cmd_dem(None, src, outer_out, resolution=10.0, extent=outer_extent, raw_size=0,
                      inner_sidecar=tmp_path / "missing.json")


def test_dem_refuses_a_square_that_is_not_whole_cells_or_a_missing_dem(tmp_path):
    import pytest
    src = tmp_path / "dem.tif"
    _synthetic_dem(src, (0, 0, 300, 300))
    with pytest.raises(SystemExit, match="whole number"):
        gspro.cmd_dem(None, src, tmp_path / "x.tif", resolution=3.0, extent=(0, 0, 200, 200))
    with pytest.raises(SystemExit, match="no such DEM"):
        gspro.cmd_dem(None, tmp_path / "missing.tif", tmp_path / "x.tif", resolution=1.0, extent=(0, 0, 200, 200))


# --- trees ------------------------------------------------------------------

def _stems_asset(path, rows, version=2):
    fields = ["x", "y", "heightM", "crownRadiusM", "groundM"] + (["kind"] if version == 2 else [])
    path.write_text(json.dumps({"version": version, "crs": "EPSG:3006", "fields": fields, "trees": rows}))


def _sidecar(path, extent, lo, hi, terrain):
    path.write_text(json.dumps({"terrain": terrain, "square3006": list(extent), "sideM": extent[2] - extent[0],
                                "minM": lo, "maxM": hi}))


def test_trees_writes_unity_trees_over_the_square_with_the_sidecars_height_range(tmp_path):
    extent = (1000.0, 2000.0, 1200.0, 2200.0)
    stems = tmp_path / "tree-stems.json"
    _stems_asset(stems, [
        [1010.0, 2020.0, 12.0, 3.0, 50.5, 1],   # conifer inside
        [1100.0, 2100.0, 4.0, 2.0, 51.0, 0],    # broadleaf, r > 0.35 h -> bush
        [1300.0, 2100.0, 9.0, 2.0, 52.0, 0],    # east of the square
    ])
    sidecar = tmp_path / "x-inner-dem-200m.tif.json"
    _sidecar(sidecar, extent, 48.25, 70.5, "inner")
    out = tmp_path / "x-inner-trees.json"

    gspro.cmd_trees(None, stems, sidecar, out, extent=extent)

    doc = json.loads(out.read_text())
    assert doc["format"] == "unity-trees-v1"
    assert doc["plot"] == {"crs": "EPSG:3006", "terrain": "inner", "originX": 1000.0, "originY": 2000.0,
                           "sizeM": 200.0, "minM": 48.25, "maxM": 70.5}
    assert doc["trees"] == [
        {"id": "epsg3006:1010.00:2020.00", "x": 10.0, "z": 20.0, "h": 12.0, "r": 3.0, "g": 50.5, "k": 1, "bush": False},
        {"id": "epsg3006:1100.00:2100.00", "x": 100.0, "z": 100.0, "h": 4.0, "r": 2.0, "g": 51.0, "k": 0, "bush": True},
    ]


def test_outer_trees_leave_the_inner_square_to_the_inner_terrain(tmp_path):
    outer = (0.0, 0.0, 400.0, 400.0)
    inner = (100.0, 100.0, 300.0, 300.0)
    stems = tmp_path / "tree-stems.json"
    _stems_asset(stems, [[50.0, 50.0, 10.0, 2.0, 30.0], [200.0, 200.0, 10.0, 2.0, 31.0]], version=1)  # v1: no kind
    sidecar = tmp_path / "x-outer-dem-400m.tif.json"
    _sidecar(sidecar, outer, 20.0, 60.0, "outer")
    out = tmp_path / "x-outer-trees.json"

    gspro.cmd_trees(None, stems, sidecar, out, terrain="outer", exclude=inner, extent=outer)

    doc = json.loads(out.read_text())
    assert doc["plot"]["terrain"] == "outer" and doc["plot"]["sizeM"] == 400.0
    assert [t["id"] for t in doc["trees"]] == ["epsg3006:50.00:50.00"]
    assert doc["trees"][0]["k"] == 2  # v1 asset: kind unknown


def test_trees_merges_two_stems_on_one_cell_into_one_id(tmp_path):
    """The detector can put two crowns on the same cell; the planter keys by
    id, so the wider crown wins and the id stays unique."""
    extent = (0.0, 0.0, 100.0, 100.0)
    stems = tmp_path / "s.json"
    _stems_asset(stems, [[10.5, 20.5, 7.5, 2.6, 82.55, 1], [10.5, 20.5, 7.5, 3.2, 82.55, 1], [30.0, 30.0, 5.0, 1.0, 80.0, 0]])
    sidecar = tmp_path / "s.tif.json"
    _sidecar(sidecar, extent, 1.0, 2.0, "inner")
    out = tmp_path / "o.json"

    gspro.cmd_trees(None, stems, sidecar, out, extent=extent)

    trees = json.loads(out.read_text())["trees"]
    assert [t["id"] for t in trees] == ["epsg3006:10.50:20.50", "epsg3006:30.00:30.00"]
    assert trees[0]["r"] == 3.2


def test_trees_refuses_a_sidecar_for_another_square_or_missing_inputs(tmp_path):
    extent = (0.0, 0.0, 100.0, 100.0)
    stems = tmp_path / "s.json"
    _stems_asset(stems, [])
    sidecar = tmp_path / "s.tif.json"
    _sidecar(sidecar, (0.0, 0.0, 200.0, 200.0), 1.0, 2.0, "inner")
    with pytest.raises(SystemExit, match="is for square"):
        gspro.cmd_trees(None, stems, sidecar, tmp_path / "o.json", extent=extent)
    with pytest.raises(SystemExit, match="export the heightmap first"):
        gspro.cmd_trees(None, stems, tmp_path / "missing.json", tmp_path / "o.json", extent=extent)
    with pytest.raises(SystemExit, match="no such tree-stems"):
        gspro.cmd_trees(None, tmp_path / "missing.json", sidecar, tmp_path / "o.json", extent=extent)


def test_cli_accepts_square_3006_for_ortho_and_dem(tmp_path):
    extent = (529030.0, 6486669.0, 529230.0, 6486869.0)
    src = tmp_path / "ortho.tif"
    _synthetic_ortho(src, extent)
    out = tmp_path / "o.jpg"
    assert gspro.main(["ortho", "--square-3006", "529030,6486669,529230,6486869", "--ortho", str(src),
                       "--out", str(out), "--size", "64"]) == 0
    assert Image.open(out).size == (64, 64)

    dem = tmp_path / "dem.tif"
    _synthetic_dem(dem, extent)
    out_dem = tmp_path / "d.tif"
    assert gspro.main(["dem", "--square-3006", "529030,6486669,529230,6486869", "--dem", str(dem),
                       "--out", str(out_dem), "--resolution", "10", "--raw-size", "65", "--terrain", "inner"]) == 0
    with rasterio.open(out_dem) as ds:
        assert ds.width == 20
    assert (tmp_path / "d.raw").stat().st_size == 65 * 65 * 2
