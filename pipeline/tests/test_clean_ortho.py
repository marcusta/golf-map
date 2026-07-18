"""clean-ortho tests — fully offline, no torch. Mask geometry (canopy ∪
shadow ∩ corridor, manual mask, dilation, azimuth offsets) on synthetic
shapes, GeoJSON loading in both CRS flavors, and the CLI/command wiring with
an injected fake inpaint implementation.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest
import rasterio
from rasterio.transform import from_origin
from shapely.geometry import Point, Polygon, box

from golfpipe import clean_ortho
from golfpipe.__main__ import main
from golfpipe.commands import cmd_clean_ortho, default_clean_out_path
from golfpipe.water import GEOJSON_CRS_3006

# Scene anchored at realistic SWEREF99 TM coordinates (near Linköping).
E0, N0 = 533000.0, 6473000.0


def _square(e: float, n: float, size: float) -> Polygon:
    return box(e, n, e + size, n + size)


def _feature(geom: Polygon, feature_type: str | None) -> dict:
    props = {} if feature_type is None else {"type": feature_type}
    return {
        "type": "Feature",
        "properties": props,
        "geometry": {
            "type": "Polygon",
            "coordinates": [[list(c) for c in geom.exterior.coords]],
        },
    }


def _write_geojson(path: Path, features: list[dict], crs: dict | None = GEOJSON_CRS_3006) -> Path:
    doc: dict = {"type": "FeatureCollection", "features": features}
    if crs is not None:
        doc["crs"] = crs
    path.write_text(json.dumps(doc), encoding="utf-8")
    return path


# --- shadow_geometry ---------------------------------------------------------


def test_shadow_points_east_for_azimuth_90():
    canopy = _square(E0, N0, 10)
    shadow = clean_ortho.shadow_geometry(canopy, azimuth_deg=90.0, length_m=12.0)
    # Band extends 12 m east of the canopy, no northward drift.
    assert shadow.bounds == pytest.approx((E0 + 12 / 4, N0, E0 + 22, N0 + 10))
    # Solid band: mid-offset point is covered, not just the tip.
    assert shadow.contains(Point(E0 + 15, N0 + 5))
    # Nothing west of the canopy.
    assert not shadow.intersects(Point(E0 - 1, N0 + 5))


def test_shadow_points_north_for_azimuth_0():
    canopy = _square(E0, N0, 10)
    shadow = clean_ortho.shadow_geometry(canopy, azimuth_deg=0.0, length_m=9.0)
    e_min, n_min, e_max, n_max = shadow.bounds
    assert (e_min, e_max) == pytest.approx((E0, E0 + 10))
    assert n_max == pytest.approx(N0 + 19)
    assert n_min > N0  # first sub-offset, never the un-shifted canopy itself


def test_shadow_length_zero_is_empty():
    canopy = _square(E0, N0, 10)
    assert clean_ortho.shadow_geometry(canopy, azimuth_deg=45.0, length_m=0.0).is_empty
    assert clean_ortho.shadow_geometry(Polygon(), azimuth_deg=45.0, length_m=10.0).is_empty


def test_shadow_band_has_no_gaps_for_long_shadows():
    # Length >> step: consecutive sub-offsets must overlap into a solid band.
    canopy = _square(E0, N0, 8)
    shadow = clean_ortho.shadow_geometry(canopy, azimuth_deg=90.0, length_m=30.0)
    for d in np.linspace(3.0, 30.0, 10):
        assert shadow.contains(Point(E0 + 4 + d, N0 + 4)), f"gap at offset {d}"


# --- build_mask_geometry -----------------------------------------------------


def test_mask_is_canopy_and_shadow_clipped_to_corridor():
    canopy = _square(E0, N0 + 20, 10)  # sits half in, half out of the corridor
    corridor = box(E0 + 5, N0, E0 + 60, N0 + 60)
    mask = clean_ortho.build_mask_geometry(
        [canopy], [corridor],
        shadow_azimuth_deg=90.0, shadow_length_m=10.0, margin_m=0.0,
    )
    assert mask.contains(Point(E0 + 7, N0 + 25))       # canopy inside corridor
    assert not mask.contains(Point(E0 + 2, N0 + 25))   # canopy outside corridor
    assert mask.contains(Point(E0 + 14, N0 + 25))      # shadow band inside corridor
    assert not mask.contains(Point(E0 + 40, N0 + 40))  # open corridor stays clean


def test_manual_mask_is_not_clipped_to_corridor():
    corridor = box(E0, N0, E0 + 20, N0 + 20)
    manual = _square(E0 + 100, N0 + 100, 5)  # far outside the corridor
    mask = clean_ortho.build_mask_geometry(
        [], [corridor], [manual], shadow_length_m=0.0, margin_m=0.0,
    )
    assert mask.contains(Point(E0 + 102, N0 + 102))


def test_margin_dilates_the_mask():
    canopy = _square(E0 + 10, N0 + 10, 10)
    corridor = box(E0, N0, E0 + 100, N0 + 100)
    probe = Point(E0 + 20.3, N0 + 15)  # 0.3 m past the canopy's east edge
    no_margin = clean_ortho.build_mask_geometry(
        [canopy], [corridor], shadow_length_m=0.0, margin_m=0.0,
    )
    with_margin = clean_ortho.build_mask_geometry(
        [canopy], [corridor], shadow_length_m=0.0, margin_m=0.5,
    )
    assert not no_margin.contains(probe)
    assert with_margin.contains(probe)


def test_empty_canopy_and_manual_gives_empty_mask():
    corridor = box(E0, N0, E0 + 20, N0 + 20)
    mask = clean_ortho.build_mask_geometry([], [corridor])
    assert mask.is_empty


# --- GeoJSON loading ---------------------------------------------------------


def test_load_typed_polygons_epsg3006_passthrough(tmp_path: Path):
    path = _write_geojson(tmp_path / "trees.geojson", [
        _feature(_square(E0, N0, 10), "trees"),
        _feature(_square(E0 + 20, N0, 10), None),
    ])
    typed = clean_ortho.load_typed_polygons(path)
    assert [t for t, _ in typed] == ["trees", None]
    assert typed[0][1].bounds == pytest.approx((E0, N0, E0 + 10, N0 + 10))


def test_load_typed_polygons_reprojects_wgs84(tmp_path: Path):
    from rasterio.crs import CRS
    from rasterio.warp import transform as warp_transform

    lon, lat = 15.6, 58.4
    ring = [[lon, lat], [lon + 0.001, lat], [lon + 0.001, lat + 0.001], [lon, lat + 0.001], [lon, lat]]
    path = tmp_path / "features.geojson"
    path.write_text(json.dumps({
        "type": "FeatureCollection",
        "features": [{
            "type": "Feature",
            "properties": {"type": "fairway"},
            "geometry": {"type": "Polygon", "coordinates": [ring]},
        }],
    }), encoding="utf-8")

    typed = clean_ortho.load_typed_polygons(path)
    assert [t for t, _ in typed] == ["fairway"]
    # A lon/lat square comes out slightly rotated in SWEREF99 TM, so compare
    # the polygon bounds against the transformed corners' extremes.
    xs, ys = warp_transform(
        CRS.from_epsg(4326), CRS.from_epsg(3006), [p[0] for p in ring], [p[1] for p in ring],
    )
    assert typed[0][1].bounds == pytest.approx((min(xs), min(ys), max(xs), max(ys)), abs=0.01)


def test_select_polygons_by_type_and_untyped():
    typed = [("trees", _square(E0, N0, 5)), ("water", _square(E0, N0, 5)), (None, _square(E0, N0, 5))]
    assert len(clean_ortho.select_polygons(typed, ("trees",))) == 1
    assert len(clean_ortho.select_polygons(typed, ("trees",), include_untyped=True)) == 2
    assert len(clean_ortho.select_polygons(typed, ("fairway", "rough"))) == 0


def test_load_typed_polygons_bad_file(tmp_path: Path):
    bad = tmp_path / "nope.geojson"
    bad.write_text("{not json", encoding="utf-8")
    with pytest.raises(clean_ortho.CleanOrthoError, match="cannot read GeoJSON"):
        clean_ortho.load_typed_polygons(bad)


# --- rasterize_mask ----------------------------------------------------------


def test_rasterize_mask_burns_expected_cells():
    transform = from_origin(E0, N0 + 20, 1.0, 1.0)  # 20x20 grid, 1 m cells
    geom = box(E0 + 5, N0 + 5, E0 + 10, N0 + 10)
    mask = clean_ortho.rasterize_mask(geom, transform, (20, 20))
    assert mask.dtype == bool
    # all_touched: the 5x5 m square burns its touched boundary cells too.
    assert mask[12, 7]           # centre of the square (row 12 = n 6.5..7.5)
    assert not mask[2, 2]        # far corner untouched
    assert 25 <= int(mask.sum()) <= 49


def test_rasterize_empty_geometry_is_all_false():
    transform = from_origin(E0, N0 + 10, 1.0, 1.0)
    mask = clean_ortho.rasterize_mask(Polygon(), transform, (10, 10))
    assert not mask.any()


# --- cmd_clean_ortho / CLI wiring ---------------------------------------------


SIZE = 80  # 80x80 px, 1 m/px synthetic ortho


@pytest.fixture
def small_ortho(tmp_path: Path) -> Path:
    path = tmp_path / "ortho.tif"
    transform = from_origin(E0, N0 + SIZE, 1.0, 1.0)
    rng = np.random.default_rng(42)
    rgb = rng.integers(1, 255, size=(3, SIZE, SIZE), dtype=np.uint8)
    profile = {
        "driver": "GTiff", "height": SIZE, "width": SIZE, "count": 3,
        "dtype": "uint8", "crs": rasterio.crs.CRS.from_epsg(3006),
        "transform": transform, "nodata": 0, "compress": "deflate",
    }
    with rasterio.open(path, "w", **profile) as dst:
        dst.write(rgb)
    return path


@pytest.fixture
def scene_geojson(tmp_path: Path) -> tuple[Path, Path]:
    """Canopy square [20,30)x[40,50) fully inside a fairway corridor
    covering the west half of the ortho."""
    trees = _write_geojson(tmp_path / "trees.geojson", [
        _feature(box(E0 + 20, N0 + 40, E0 + 30, N0 + 50), "trees"),
    ])
    features = _write_geojson(tmp_path / "features.geojson", [
        _feature(box(E0, N0, E0 + 40, N0 + SIZE), "fairway"),
        _feature(box(E0 + 40, N0, E0 + SIZE, N0 + SIZE), "trees"),  # not corridor
    ])
    return trees, features


def _magenta_fill(image: np.ndarray, mask: np.ndarray) -> np.ndarray:
    out = image.copy()
    out[mask] = (255, 0, 255)
    return out


def test_cmd_clean_ortho_with_fake_inpaint(small_ortho: Path, scene_geojson, tmp_path: Path):
    trees, features = scene_geojson
    source_bytes = small_ortho.read_bytes()
    mask_out = tmp_path / "mask.tif"

    out = cmd_clean_ortho(
        small_ortho, trees, features,
        shadow_azimuth_deg=0.0, shadow_length_m=5.0, margin_m=0.5,
        crop_size=32, overlap=8,
        mask_out=mask_out,
        inpaint_fn=_magenta_fill,
    )

    # Default output name, source untouched.
    assert out == small_ortho.with_name("ortho.clean.tif")
    assert small_ortho.read_bytes() == source_bytes

    with rasterio.open(small_ortho) as src, rasterio.open(out) as dst:
        assert dst.crs == src.crs
        assert dst.transform == src.transform
        assert dst.profile["compress"] == "deflate"
        original = np.moveaxis(src.read(), 0, -1)
        cleaned = np.moveaxis(dst.read(), 0, -1)
    with rasterio.open(mask_out) as msrc:
        mask = msrc.read(1) > 0

    assert mask.any()
    # Masked pixels replaced by the fake fill, everything else byte-identical.
    assert np.all(cleaned[mask] == (255, 0, 255))
    assert np.array_equal(cleaned[~mask], original[~mask])
    # Canopy centre (row = N0+SIZE-45 = 35, col = 25) masked; far east isn't.
    assert mask[35, 25]
    assert not mask[35, 70]


def test_cmd_clean_ortho_refuses_overwriting_source(small_ortho: Path, scene_geojson):
    trees, features = scene_geojson
    with pytest.raises(clean_ortho.CleanOrthoError, match="refusing to overwrite"):
        cmd_clean_ortho(small_ortho, trees, features, out=small_ortho, inpaint_fn=_magenta_fill)


def test_cmd_clean_ortho_requires_corridor_features(small_ortho: Path, tmp_path: Path):
    trees = _write_geojson(tmp_path / "t.geojson", [_feature(_square(E0, N0, 5), "trees")])
    features = _write_geojson(tmp_path / "f.geojson", [_feature(_square(E0, N0, 5), "water")])
    with pytest.raises(clean_ortho.CleanOrthoError, match="no corridor features"):
        cmd_clean_ortho(small_ortho, trees, features, inpaint_fn=_magenta_fill)


def test_main_empty_mask_writes_copy_without_torch(small_ortho: Path, tmp_path: Path, monkeypatch):
    """CLI end-to-end: canopy entirely outside the corridor -> empty mask ->
    unmodified copy is written and torch/weights are never touched."""
    monkeypatch.delenv("GOLFPIPE_LAMA_WEIGHTS", raising=False)
    trees = _write_geojson(tmp_path / "t.geojson", [
        _feature(box(E0 + 60, N0 + 60, E0 + 70, N0 + 70), "trees"),
    ])
    features = _write_geojson(tmp_path / "f.geojson", [
        _feature(box(E0, N0, E0 + 20, N0 + 20), "fairway"),
    ])
    out = tmp_path / "cleaned.tif"
    rc = main([
        "clean-ortho", "--ortho", str(small_ortho), "--trees", str(trees),
        "--features", str(features), "--shadow-length", "0", "--out", str(out),
    ])
    assert rc == 0
    with rasterio.open(small_ortho) as src, rasterio.open(out) as dst:
        assert np.array_equal(src.read(), dst.read())


def test_main_missing_weights_is_a_clean_error(small_ortho: Path, scene_geojson, tmp_path: Path, monkeypatch, capsys):
    monkeypatch.delenv("GOLFPIPE_LAMA_WEIGHTS", raising=False)
    trees, features = scene_geojson
    rc = main([
        "clean-ortho", "--ortho", str(small_ortho), "--trees", str(trees),
        "--features", str(features), "--out", str(tmp_path / "c.tif"),
    ])
    assert rc == 1
    err = capsys.readouterr().err
    assert "GOLFPIPE_LAMA_WEIGHTS" in err
    assert "big-lama" in err


def test_default_clean_out_path():
    p = Path("/data/sources/x/ortho-orto-l2-2025.tif")
    assert default_clean_out_path(p) == Path("/data/sources/x/ortho-orto-l2-2025.clean.tif")
