"""Builds manifest.json for a tiled course: WGS84 bounds, min/max zoom per
layer (inferred by scanning the tile directory), elevation range sampled
from the source DEM, generation timestamp, and attribution.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import rasterio

ATTRIBUTION = "© Lantmäteriet, CC BY 4.0"


def _zoom_levels(tiles_dir: Path) -> list[int]:
    if not tiles_dir.exists():
        return []
    return sorted(
        int(p.name) for p in tiles_dir.iterdir() if p.is_dir() and p.name.isdigit()
    )


def _layer_summary(tiles_dir: Path | None) -> dict | None:
    if tiles_dir is None or not tiles_dir.exists():
        return None
    zooms = _zoom_levels(tiles_dir)
    if not zooms:
        return None
    return {"minzoom": zooms[0], "maxzoom": zooms[-1]}


def _dem_bounds_and_elevation(dem_path: Path) -> tuple[tuple[float, float, float, float], tuple[float, float]]:
    with rasterio.open(dem_path) as src:
        from rasterio.warp import transform_bounds

        wgs84_bounds = transform_bounds(src.crs, "EPSG:4326", *src.bounds)
        data = src.read(1, masked=True)
        valid = data.compressed() if np.ma.is_masked(data) else data.ravel()
        valid = valid[np.isfinite(valid)]
        if valid.size == 0:
            elevation_range = (0.0, 0.0)
        else:
            elevation_range = (float(valid.min()), float(valid.max()))
    return wgs84_bounds, elevation_range


def build_manifest(
    course_id: str,
    ortho_tiles_dir: Path | None = None,
    terrain_tiles_dir: Path | None = None,
    hillshade_tiles_dir: Path | None = None,
    dem_path: Path | None = None,
    bounds_wgs84: tuple[float, float, float, float] | None = None,
) -> dict:
    """Assembles the manifest dict. bounds_wgs84, if not given explicitly,
    is derived from dem_path (preferred) since the DEM defines the
    authoritative course extent used to generate both layers.
    """
    elevation_range = None
    bounds = bounds_wgs84

    if dem_path is not None and dem_path.exists():
        dem_bounds, elevation_range = _dem_bounds_and_elevation(dem_path)
        if bounds is None:
            bounds = dem_bounds

    layers = {}
    ortho_summary = _layer_summary(ortho_tiles_dir)
    if ortho_summary:
        layers["ortho"] = ortho_summary
    terrain_summary = _layer_summary(terrain_tiles_dir)
    if terrain_summary:
        layers["terrain"] = terrain_summary
    hillshade_summary = _layer_summary(hillshade_tiles_dir)
    if hillshade_summary:
        layers["hillshade"] = hillshade_summary

    manifest = {
        "courseId": course_id,
        "bounds": {
            "west": bounds[0],
            "south": bounds[1],
            "east": bounds[2],
            "north": bounds[3],
        }
        if bounds is not None
        else None,
        "layers": layers,
        "elevation": (
            {"min": elevation_range[0], "max": elevation_range[1]}
            if elevation_range is not None
            else None
        ),
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "attribution": ATTRIBUTION,
    }
    return manifest


def write_manifest(manifest: dict, out_path: Path) -> Path:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return out_path
