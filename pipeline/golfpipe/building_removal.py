"""Building removal for the orthophoto export (gspro.py ortho --remove-buildings).

Unity places a building prefab on each pad, so the photographed roof and
the shadow it casts are wrong in the terrain texture: the roof shows round
the model's footprint, the shadow lies on the grass in a direction the
game's sun does not share. This module masks both and fills the hole from
the ground around it.

Inputs, all on the render's own pixel grid (north-up EPSG:3006):

- roof heights: the canopy step's `--roofs-out` GeoTIFF (lidar nDSM on the
  roof cells, 0 elsewhere; `canopy.suppress_buildings` decides what is a
  roof), resampled nearest. Components under min_area_m2 are dropped (a
  van or a container can clear 2 m).
- footprints: the fetch-buildings survey (OSM footprints with lidar eave /
  ridge heights, what "Generate building pads" writes), burned in at the
  building's ridge height (else eave, else OSM levels x 3 m or its height
  tag, else SURVEY_DEFAULT_HEIGHT_M). The lidar only knows what stood when
  it was flown: on Vreta (March 2021 scan, 2025 photo) the clubhouse and
  half the range building are newer and have no returns at all, but they
  are in OSM, and they are the buildings Unity puts prefabs on anyway.
  Footprints are grown by SURVEY_GROW_M: OSM is a metre or two off the
  photo, and the photo is not a true ortho, so a tall roof leans away from
  the image centre.
- shadow: each roof pixel's shadow runs toward `azimuth` (compass degrees
  the shadow falls toward) for height x `ratio` metres (ratio = the
  cotangent of the sun's elevation). Both are measured from the photo when
  not given (estimate_shadow): the azimuth is the direction in which the
  band next to the roofs is darkest, the ratio where that band turns as
  bright as the sunny side of the roofs.

Mask = (roofs | shadow) grown by grow_m (eaves the lidar grid misses, JPEG
halos; a square grow, separable and so cheap at 8192 px, and buildings are
rectangles anyway). Fill = the colour of the nearest ground at least FILL_SOURCE_GAP_M outside
the hole (the band right at its edge is eave, halo or a strip of roof the
mask missed, and filling from it smears roof colour back in), computed on a
FILL_CELL_M grid and blurred by FILL_BLUR_M, so grass next to grass stays
grass and the gravel yard stays gravel. An inverse-distance fill (GDAL's
fillnodata) was tried first on Vreta: it averages every edge the hole sees,
so a clubhouse between a lawn and a car park came out as grey haze with
radial streaks. Then world-anchored grain
(woodland_floor.floor_noise) at the spread of the ground round the masks,
so the patch is not a smear. alpha rises from 0 on the mask edge to 1
over feather_m, so the patch has no seam.

Car parks, roads and paths are not masked (they are ground); cars on them
stay, being under the 2 m roof height.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import rasterio
from rasterio.crs import CRS
from rasterio.enums import Resampling
from rasterio.warp import reproject
from scipy.ndimage import binary_dilation, distance_transform_edt, gaussian_filter, label, maximum_filter

from golfpipe.trees_features import disk_structure
from golfpipe.woodland_floor import floor_noise

__all__ = [
    "DEFAULT_GROW_M", "DEFAULT_MIN_AREA_M2", "DEFAULT_FEATHER_M", "FALLBACK_AZIMUTH_DEG", "FALLBACK_RATIO",
    "Shadow", "RemovalReport", "roof_heights_on_grid", "burn_survey", "clean_roofs", "shadow_mask", "estimate_shadow",
    "remove_buildings",
]

DEFAULT_GROW_M = 1.5
DEFAULT_MIN_AREA_M2 = 15.0
DEFAULT_FEATHER_M = 1.0
# When the photo has too few roofs to measure the sun: midday in Sweden,
# shadows falling due north, about as long as the building is tall.
FALLBACK_AZIMUTH_DEG = 0.0
FALLBACK_RATIO = 1.0
# Estimation runs on a grid of about this many metres per cell.
ESTIMATE_CELL_M = 1.0
# At least this much roof area (m²) to measure the shadow from.
ESTIMATE_MIN_ROOF_M2 = 100.0
# The shadow side must be this much darker (8-bit luma) than the sunny side
# for the estimate to count.
ESTIMATE_MIN_CONTRAST = 12.0
MAX_RATIO = 3.0
GRAIN_GAIN = 0.5
FILL_SOURCE_GAP_M = 2.0
SURVEY_GROW_M = 2.0
FILL_BLUR_M = 2.0
FILL_CELL_M = 1.0
# A surveyed building with no height from lidar or OSM: two storeys.
SURVEY_DEFAULT_HEIGHT_M = 6.0
LUMA = np.array([0.299, 0.587, 0.114])


@dataclass
class Shadow:
    azimuth_deg: float
    ratio: float
    measured: bool  # False: the fallback, or given by the caller


@dataclass
class RemovalReport:
    buildings: int
    masked_px: int
    shadow: Shadow


def roof_heights_on_grid(path: Path, transform, shape: tuple[int, int]) -> np.ndarray:
    """The roof-heights GeoTIFF resampled (nearest) onto a north-up
    EPSG:3006 grid; cells it does not cover, and anything under 0.5 m, are
    0. The destination nodata is -1, not 0: with 0 GDAL nudges every valid
    zero to the smallest positive float to keep it apart from nodata, and
    the whole square reads as roof."""
    out = np.full(shape, -1.0, dtype=np.float32)
    with rasterio.open(path) as src:
        reproject(
            source=rasterio.band(src, 1), destination=out,
            src_transform=src.transform, src_crs=src.crs or CRS.from_epsg(3006), src_nodata=src.nodata,
            dst_transform=transform, dst_crs=CRS.from_epsg(3006), dst_nodata=-1.0,
            resampling=Resampling.nearest,
        )
    out[~np.isfinite(out) | (out < 0.5)] = 0.0
    return out


def burn_survey(heights: np.ndarray, transform, survey_path: Path) -> tuple[np.ndarray, int]:
    """heights with every surveyed footprint burned in at the building's
    height (see the module docstring), keeping the higher value where the
    lidar has the roof too; and how many footprints touched the grid."""
    import rasterio.features
    from golfpipe.buildings import LEVEL_HEIGHT_M, read_survey

    shapes = []
    for b in read_survey(survey_path):
        if b.roof is not None:
            h = b.roof.ridge_m or b.roof.eave_m
        elif b.height_tag_m:
            h = b.height_tag_m
        elif b.levels:
            h = b.levels * LEVEL_HEIGHT_M
        else:
            h = SURVEY_DEFAULT_HEIGHT_M
        shapes.append((b.polygon, float(max(h, 2.0))))
    if not shapes:
        return heights, 0
    burned = rasterio.features.rasterize(shapes, out_shape=heights.shape, transform=transform, fill=0.0,
                                         dtype="float32", merge_alg=rasterio.enums.MergeAlg.replace)
    grow = int(round(SURVEY_GROW_M / abs(transform.a)))
    if grow > 0:
        burned = maximum_filter(burned, size=2 * grow + 1)
    from shapely.geometry import box

    h, w = heights.shape
    x0, y1 = transform * (0, 0)
    x1, y0 = transform * (w, h)
    area = box(min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1))
    touched = sum(1 for g, _ in shapes if g.intersects(area))
    return np.maximum(heights, burned).astype(np.float32), touched


def clean_roofs(heights: np.ndarray, px: float, min_area_m2: float = DEFAULT_MIN_AREA_M2) -> tuple[np.ndarray, int]:
    """Heights with 8-connected roof components under min_area_m2 zeroed,
    and the number of components kept."""
    roofs = heights > 0
    if not roofs.any():
        return np.zeros_like(heights), 0
    labels, count = label(roofs, structure=np.ones((3, 3), dtype=bool))
    sizes = np.bincount(labels.ravel())
    keep = sizes * px * px >= min_area_m2
    keep[0] = False
    return np.where(keep[labels], heights, 0.0).astype(heights.dtype), int(np.count_nonzero(keep))


def _shift(mask: np.ndarray, drow: int, dcol: int) -> np.ndarray:
    """mask moved by (drow, dcol) pixels, zero-filled."""
    out = np.zeros_like(mask)
    h, w = mask.shape
    if abs(drow) >= h or abs(dcol) >= w:
        return out
    rs, rd = (slice(0, h - drow), slice(drow, h)) if drow >= 0 else (slice(-drow, h), slice(0, h + drow))
    cs, cd = (slice(0, w - dcol), slice(dcol, w)) if dcol >= 0 else (slice(-dcol, w), slice(0, w + dcol))
    out[rd, cd] = mask[rs, cs]
    return out


def shadow_mask(heights: np.ndarray, px: float, azimuth_deg: float, ratio: float) -> np.ndarray:
    """Pixels in the shadow of the roofs: every roof pixel's shadow runs
    toward azimuth_deg (compass, the direction it falls toward) for height x
    ratio metres. Roofs themselves are not included."""
    reach = heights * ratio / px  # shadow length per roof pixel, in pixels
    longest = float(reach.max()) if reach.size else 0.0
    out = np.zeros(heights.shape, dtype=bool)
    if longest < 1.0:
        return out
    az = math.radians(azimuth_deg)
    dx, dy = math.sin(az), -math.cos(az)  # columns east, rows south
    for step in range(1, int(math.ceil(longest)) + 1):
        src = reach >= step - 0.5
        if not src.any():
            break
        out |= _shift(src, int(round(step * dy)), int(round(step * dx)))
    return out & ~(heights > 0)


def _pool(a: np.ndarray, f: int, how: str) -> np.ndarray:
    h, w = (a.shape[0] // f) * f, (a.shape[1] // f) * f
    blocks = a[:h, :w].reshape(h // f, f, w // f, f)
    return blocks.max(axis=(1, 3)) if how == "max" else blocks.mean(axis=(1, 3))


def estimate_shadow(rgb: np.ndarray, heights: np.ndarray, px: float) -> Shadow:
    """The photo's shadow direction and length ratio, measured next to the
    roofs (see the module docstring); the fallback when there are too few
    roofs or the shadow side is not clearly darker."""
    fallback = Shadow(FALLBACK_AZIMUTH_DEG, FALLBACK_RATIO, measured=False)
    f = max(1, int(round(ESTIMATE_CELL_M / px)))
    cell = px * f
    h = _pool(heights.astype(np.float64), f, "max")
    luma = sum(w * _pool(rgb[..., c], f, "mean") for c, w in enumerate(LUMA))
    roofs = h > 0
    if np.count_nonzero(roofs) * cell * cell < ESTIMATE_MIN_ROOF_M2:
        return fallback
    near = binary_dilation(roofs, structure=disk_structure(1.5))

    def band_mean(az: float, ratio: float, inner: float = 0.0) -> float | None:
        band = shadow_mask(h, cell, az, ratio) & ~near
        if inner > 0:
            band &= ~shadow_mask(h, cell, az, inner)
        return float(luma[band].mean()) if np.count_nonzero(band) >= 20 else None

    scores = {az: band_mean(az, 1.0) for az in range(0, 360, 15)}
    scores = {az: v for az, v in scores.items() if v is not None}
    if not scores:
        return fallback
    best = min(scores, key=scores.get)
    fine = {az % 360: band_mean(az % 360, 1.0) for az in range(best - 10, best + 11, 5)}
    fine = {az: v for az, v in fine.items() if v is not None}
    best = min(fine, key=fine.get)
    dark = band_mean(best, 0.4)
    sunny = band_mean((best + 180) % 360, 1.0)
    if dark is None or sunny is None or sunny - dark < ESTIMATE_MIN_CONTRAST:
        return fallback
    threshold = (dark + sunny) / 2.0
    ratio = MAX_RATIO
    r = 0.4
    while r < MAX_RATIO:
        ring = band_mean(best, r + 0.2, inner=r)
        if ring is None or ring > threshold:
            ratio = r + 0.1
            break
        r += 0.2
    return Shadow(float(best), round(max(0.3, min(MAX_RATIO, ratio)), 2), measured=True)


def _nearest_fill(rgb: np.ndarray, source: np.ndarray, px: float) -> np.ndarray:
    """(H, W, 3) float32: every pixel the colour of the nearest source-free
    ground cell on a FILL_CELL_M grid (cell colour = mean of its usable
    pixels), blurred by FILL_BLUR_M, back at full resolution (bilinear)."""
    from scipy.ndimage import zoom

    height, width = source.shape
    f = max(1, int(round(FILL_CELL_M / px)))
    hp, wp = -(-height // f), -(-width // f)
    pad = ((0, hp * f - height), (0, wp * f - width))
    usable = np.pad(~source, pad, constant_values=False).reshape(hp, f, wp, f)
    count = usable.sum(axis=(1, 3))
    cells = np.zeros((hp, wp, 3), dtype=np.float64)
    for c in range(3):
        band = np.pad(rgb[..., c], pad).reshape(hp, f, wp, f).astype(np.float64)
        cells[..., c] = (band * usable).sum(axis=(1, 3)) / np.maximum(count, 1)
    empty = count == 0
    if empty.all():
        return np.asarray(rgb, dtype=np.float32)
    if empty.any():
        _, (ri, ci) = distance_transform_edt(empty, return_indices=True)
        cells = cells[ri, ci]
    sigma = FILL_BLUR_M / (px * f)
    cells = np.stack([gaussian_filter(cells[..., c], sigma) for c in range(3)], axis=-1)
    up = zoom(cells, (f, f, 1), order=1, grid_mode=True, mode="nearest")
    return up[:height, :width].astype(np.float32)


def remove_buildings(
    rgb: np.ndarray,
    transform: "rasterio.Affine",
    heights: np.ndarray,
    azimuth_deg: float | None = None,
    ratio: float | None = None,
    grow_m: float = DEFAULT_GROW_M,
    min_area_m2: float = DEFAULT_MIN_AREA_M2,
    feather_m: float = DEFAULT_FEATHER_M,
    seed: int = 0,
    block_rows: int = 1024,
) -> tuple[np.ndarray, RemovalReport]:
    """rgb ((H, W, 3) uint8 on the north-up EPSG:3006 `transform`) with the
    roofs in `heights` (same grid, metres, 0 = none) and their shadows
    filled from the ground round them. azimuth_deg / ratio: the shadow,
    measured from the photo when None. Returns (new image, report)."""
    px = float(abs(transform.a))
    heights, buildings = clean_roofs(np.asarray(heights, dtype=np.float32), px, min_area_m2)
    if buildings == 0:
        return np.array(rgb, copy=True), RemovalReport(0, 0, Shadow(FALLBACK_AZIMUTH_DEG, FALLBACK_RATIO, False))
    if azimuth_deg is None or ratio is None:
        measured = estimate_shadow(rgb, heights, px)
        shadow = Shadow(measured.azimuth_deg if azimuth_deg is None else azimuth_deg,
                        measured.ratio if ratio is None else ratio, measured.measured)
    else:
        shadow = Shadow(azimuth_deg, ratio, measured=False)
    mask = (heights > 0) | shadow_mask(heights, px, shadow.azimuth_deg, shadow.ratio)
    grow = int(round(grow_m / px))
    if grow > 0:
        mask = maximum_filter(mask.view(np.uint8), size=2 * grow + 1).astype(bool)
    gap = int(round(FILL_SOURCE_GAP_M / px))
    source = maximum_filter(mask.view(np.uint8), size=2 * gap + 1).astype(bool) if gap > 0 else mask
    filled = _nearest_fill(rgb, source, px)
    # The ground's spread round the holes, on a ~1 m sample of the photo.
    f = max(1, int(round(ESTIMATE_CELL_M / px)))
    small = _pool(mask.view(np.uint8), f, "max") > 0
    ring = binary_dilation(small, structure=disk_structure(3.0 / (px * f))) & ~small
    sample = rgb[: small.shape[0] * f: f, : small.shape[1] * f: f].astype(np.float64) @ LUMA
    spread = float(np.clip(sample[ring].std(), 3.0, 20.0)) if ring.any() else 8.0

    out = np.array(rgb, copy=True)
    height = rgb.shape[0]
    pad = int(math.ceil(feather_m / px)) + 1
    xs = transform.c + (np.arange(rgb.shape[1]) + 0.5) * transform.a
    for r0 in range(0, height, block_rows):
        r1 = min(height, r0 + block_rows)
        if not mask[r0:r1].any():
            continue
        p0, p1 = max(0, r0 - pad), min(height, r1 + pad)
        block = mask[p0:p1]
        if feather_m > 0 and not block.all():
            a = np.clip(distance_transform_edt(block) * px / feather_m, 0.0, 1.0)[r0 - p0:r1 - p0]
        else:
            a = block[r0 - p0:r1 - p0].astype(np.float64)
        ys = transform.f + (np.arange(r0, r1) + 0.5) * transform.e
        grain, _ = floor_noise(xs, ys, seed)
        patch = filled[r0:r1].astype(np.float64) + (GRAIN_GAIN * spread * grain)[..., None]
        blend = out[r0:r1].astype(np.float64) * (1.0 - a[..., None]) + patch * a[..., None]
        out[r0:r1] = np.clip(np.round(blend), 0, 255).astype(np.uint8)
    return out, RemovalReport(buildings, int(np.count_nonzero(mask)), shadow)
