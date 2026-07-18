"""Replay vector terrain edits (flatten / smooth) onto a DEM.

The editor stores terrain edits as vector features — never raster mutations —
so they survive lidar refetches and rebuilds, diff cleanly, and are undoable
(terrain-edit wave, D-TE2). This module is the pure replay engine behind the
`apply-dem-edits` command: given a DEM grid and an ordered list of polygon
edits it produces the edited grid. Every DEM consumer (terrain-RGB tiles,
hillshade, the future Unity `.raw` export) goes through this same step so
edits transfer identically everywhere; the raw `sources/dem.tif` stays
pristine.

Operations (D-TE3, two only in v1):

- ``plane`` — least-squares plane fit z = a·x + b·y + c over the valid
  in-mask cells (x/y in metres, centered so the normal system stays
  conditioned), with two rounds of 2σ outlier rejection so cars/bushes on a
  parking lot don't tilt the fit. ``flat: true`` forces a = b = 0 with
  c = the post-rejection mean (dead-flat pad).
- ``smooth`` — median filter with a circular footprint of radius ``radiusM``
  (default 2 m, converted to cells from the raster transform, minimum
  1 cell), computed over the heights as they were before this edit — reads
  may reach outside the mask so the smoothed edge agrees with the
  surroundings. Kills spikes without smearing grade.

Both ops feather over an edge band inside the polygon (D-TE3): weight
w = clamp(dist_to_polygon_edge / featherM, 0, 1) via a cell-size-aware
euclidean distance transform on the mask, output = w·op + (1−w)·original.
``featherM`` 0 = hard edge. Nodata cells are excluded from fits and get zero
feather weight — they pass through untouched.

Edits apply in ``created_at`` order (D-TE4 — overlaps are order-dependent but
deterministic; each edit reads the running result of the previous ones).
Handoff format (D-TE5): GeoJSON FeatureCollection, WGS84 coordinates,
per-feature ``properties: { op, featherM, radiusM?, flat?, createdAt? }``;
rings are reprojected to the DEM CRS via ``rasterio.warp.transform_geom``.

Degenerate inputs (a polygon covering no cells / fewer than 16 valid cells,
a rank-deficient fit, an unknown op) skip that one edit with a warning to
stdout — a bad polygon must never crash a build.
"""

from __future__ import annotations

import json
import warnings
from dataclasses import dataclass, replace
from pathlib import Path

import numpy as np
import rasterio.features
import rasterio.transform
from scipy.ndimage import distance_transform_edt, generic_filter, median_filter

__all__ = [
    "DemEditError", "DemEdit", "PlaneFit",
    "OPS", "DEFAULT_FEATHER_M", "DEFAULT_SMOOTH_RADIUS_M",
    "MIN_PLANE_CELLS", "OUTLIER_SIGMA", "OUTLIER_ROUNDS",
    "load_edits", "reproject_edits", "fit_plane", "apply_edits",
]


class DemEditError(RuntimeError):
    """User-actionable apply-dem-edits input/setup error."""


OPS = ("plane", "smooth")
DEFAULT_FEATHER_M = 2.0
DEFAULT_SMOOTH_RADIUS_M = 2.0
# A plane fit over fewer valid cells than this is meaningless noise — skip.
MIN_PLANE_CELLS = 16
OUTLIER_SIGMA = 2.0
OUTLIER_ROUNDS = 2


@dataclass(frozen=True)
class DemEdit:
    """One vector terrain edit. `geometry` is a GeoJSON Polygon/MultiPolygon
    dict — WGS84 as loaded from the edits file (D-TE5), the DEM's CRS after
    reproject_edits.
    """

    op: str
    geometry: dict
    feather_m: float = DEFAULT_FEATHER_M
    radius_m: float = DEFAULT_SMOOTH_RADIUS_M
    flat: bool = False
    created_at: str | None = None


def load_edits(path: Path, log=print) -> list[DemEdit]:
    """Parses a D-TE5 edits file (GeoJSON FeatureCollection, WGS84) into
    DemEdits sorted by the `createdAt` property (D-TE4 — the server writes
    features pre-sorted, but sort defensively; the sort is stable, so
    features without `createdAt` keep their file order, after dated ones).

    Malformed *files* raise DemEditError; malformed individual *features*
    (missing/unknown op, non-polygon geometry, bad numeric params) are
    skipped with a warning so one bad polygon never crashes a build.
    """
    path = Path(path)
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise DemEditError(f"cannot read edits GeoJSON {path}: {exc}") from exc
    if not isinstance(doc, dict) or doc.get("type") != "FeatureCollection":
        raise DemEditError(f"{path}: edits must be a GeoJSON FeatureCollection (D-TE5)")
    features = doc.get("features")
    if not isinstance(features, list):
        raise DemEditError(f"{path}: FeatureCollection has no features array")

    edits: list[DemEdit] = []
    for i, feature in enumerate(features):
        label = f"{path.name} feature {i}"
        if not isinstance(feature, dict):
            log(f"warning: {label}: not a Feature object — skipped")
            continue
        geometry = feature.get("geometry")
        props = feature.get("properties") or {}
        if not isinstance(geometry, dict) or geometry.get("type") not in ("Polygon", "MultiPolygon"):
            log(f"warning: {label}: geometry is not a Polygon/MultiPolygon — skipped")
            continue
        op = props.get("op")
        if op not in OPS:
            log(f"warning: {label}: unknown op {op!r} (expected one of {OPS}) — skipped")
            continue
        try:
            feather_m = float(props.get("featherM", DEFAULT_FEATHER_M))
            radius_m = float(props.get("radiusM", DEFAULT_SMOOTH_RADIUS_M))
        except (TypeError, ValueError):
            log(f"warning: {label}: featherM/radiusM is not a number — skipped")
            continue
        if not np.isfinite(feather_m) or feather_m < 0 or not np.isfinite(radius_m) or radius_m <= 0:
            log(f"warning: {label}: featherM must be >= 0 and radiusM > 0 — skipped")
            continue
        created_at = props.get("createdAt")
        edits.append(DemEdit(
            op=op,
            geometry=geometry,
            feather_m=feather_m,
            radius_m=radius_m,
            flat=bool(props.get("flat", False)),
            created_at=str(created_at) if created_at is not None else None,
        ))

    edits.sort(key=lambda e: (e.created_at is None, e.created_at or ""))
    return edits


def reproject_edits(edits: list[DemEdit], dem_crs) -> list[DemEdit]:
    """Reprojects each edit's rings from WGS84 (the D-TE5 handoff CRS) to the
    DEM's CRS via rasterio.warp.transform_geom."""
    from rasterio.warp import transform_geom

    return [
        replace(edit, geometry=transform_geom("EPSG:4326", dem_crs, edit.geometry))
        for edit in edits
    ]


@dataclass(frozen=True)
class PlaneFit:
    """z = a·(x−x0) + b·(y−y0) + c, coefficients from centered-coordinate
    least squares; `inliers` marks the input points that survived outlier
    rejection (used for the `flat` mean)."""

    a: float
    b: float
    c: float
    x0: float
    y0: float
    inliers: np.ndarray

    def evaluate(self, x, y) -> np.ndarray:
        return self.a * (np.asarray(x, dtype=np.float64) - self.x0) \
            + self.b * (np.asarray(y, dtype=np.float64) - self.y0) + self.c


def fit_plane(
    x, y, z,
    sigma_factor: float = OUTLIER_SIGMA,
    rounds: int = OUTLIER_ROUNDS,
    min_points: int = MIN_PLANE_CELLS,
) -> PlaneFit | None:
    """Outlier-rejected least-squares plane fit over (x, y, z) samples
    (x/y in metres; centered internally to keep the normal system
    conditioned). Up to `rounds` rejection passes drop residuals beyond
    sigma_factor·σ and refit — cars and bushes on a lot don't tilt it.
    A rejection pass that would leave fewer than min_points samples is not
    taken (the previous fit stands). Returns None when there are fewer than
    min_points samples or the system is rank-deficient (e.g. collinear
    cells) — callers skip the edit.
    """
    x = np.asarray(x, dtype=np.float64)
    y = np.asarray(y, dtype=np.float64)
    z = np.asarray(z, dtype=np.float64)
    if z.size < min_points:
        return None
    x0, y0 = float(x.mean()), float(y.mean())
    xc, yc = x - x0, y - y0

    keep = np.ones(z.size, dtype=bool)
    coef: np.ndarray | None = None
    for round_idx in range(rounds + 1):
        design = np.column_stack([xc[keep], yc[keep], np.ones(int(keep.sum()))])
        solution, _, rank, _ = np.linalg.lstsq(design, z[keep], rcond=None)
        if rank < 3:
            return None
        coef = solution
        if round_idx == rounds:
            break
        residuals = z[keep] - design @ solution
        sigma = float(residuals.std())
        if sigma <= 0:
            break
        keep_local = np.abs(residuals) <= sigma_factor * sigma
        if keep_local.all() or int(keep_local.sum()) < min_points:
            break
        kept_indices = np.flatnonzero(keep)
        keep = np.zeros_like(keep)
        keep[kept_indices[keep_local]] = True

    a, b, c = (float(v) for v in coef)
    return PlaneFit(a=a, b=b, c=c, x0=x0, y0=y0, inliers=keep)


def apply_edits(
    dem: np.ndarray,
    transform: "rasterio.Affine",
    nodata: float | None,
    edits: list[DemEdit],
    log=print,
) -> np.ndarray:
    """Replays `edits` (geometries already in the DEM's CRS, already sorted
    per D-TE4) onto `dem`, returning a new float32 grid. The input array is
    never modified. Cells outside every mask — and every nodata cell — come
    back bit-identical.
    """
    current = dem.astype(np.float64)
    valid = np.isfinite(current)
    if nodata is not None:
        valid &= current != nodata

    for index, edit in enumerate(edits):
        _apply_one(current, valid, transform, edit, index, log)

    return current.astype(np.float32)


def _apply_one(
    current: np.ndarray,
    valid: np.ndarray,
    transform: "rasterio.Affine",
    edit: DemEdit,
    index: int,
    log,
) -> None:
    """Applies one edit to `current` in place. All raster math runs on a
    mask-bbox window only (masks are small; whole-raster filtering is
    wasteful), padded so smooth reads and the feather band stay inside it.
    """
    label = f"edit {index + 1} ({edit.op}{', flat' if edit.op == 'plane' and edit.flat else ''})"
    height, width = current.shape
    mask = rasterio.features.rasterize(
        [(edit.geometry, 1)],
        out_shape=(height, width),
        transform=transform,
        fill=0,
        all_touched=False,
        dtype="uint8",
    ).astype(bool)
    if not mask.any():
        log(f"warning: {label}: polygon covers no DEM cells — skipped")
        return

    cell_x = abs(transform.a)
    cell_y = abs(transform.e)
    pad_m = max(edit.feather_m, edit.radius_m if edit.op == "smooth" else 0.0)
    pad = int(np.ceil(pad_m / min(cell_x, cell_y))) + 2
    mask_rows = np.flatnonzero(mask.any(axis=1))
    mask_cols = np.flatnonzero(mask.any(axis=0))
    r0 = max(int(mask_rows[0]) - pad, 0)
    r1 = min(int(mask_rows[-1]) + pad + 1, height)
    c0 = max(int(mask_cols[0]) - pad, 0)
    c1 = min(int(mask_cols[-1]) + pad + 1, width)
    window = np.s_[r0:r1, c0:c1]

    mask_win = mask[window]
    cur_win = current[window]
    valid_win = valid[window]

    if edit.op == "plane":
        target = _plane_target(cur_win, mask_win, valid_win, transform, r0, c0, edit, label, log)
    else:
        target = _smooth_target(cur_win, mask_win, valid_win, cell_x, cell_y, edit)
    if target is None:
        return

    # Feather: w = clamp(dist_to_polygon_edge / featherM, 0, 1) over the edge
    # band inside the mask; 0 everywhere outside it. featherM 0 = hard edge.
    if edit.feather_m > 0:
        distances = distance_transform_edt(mask_win, sampling=(cell_y, cell_x))
        weight = np.clip(distances / edit.feather_m, 0.0, 1.0)
    else:
        weight = mask_win.astype(np.float64)
    # Nodata cells (and cells the op could not produce a value for) get zero
    # weight, and their target is pinned to the original so w=0 cells come
    # back bit-identical (no 0·nan poisoning).
    weight = np.where(valid_win & np.isfinite(target), weight, 0.0)
    target = np.where(weight > 0, target, cur_win)
    current[window] = cur_win * (1.0 - weight) + target * weight


def _plane_target(
    cur_win: np.ndarray,
    mask_win: np.ndarray,
    valid_win: np.ndarray,
    transform: "rasterio.Affine",
    r0: int,
    c0: int,
    edit: DemEdit,
    label: str,
    log,
) -> np.ndarray | None:
    fit_cells = mask_win & valid_win
    n_valid = int(np.count_nonzero(fit_cells))
    if n_valid < MIN_PLANE_CELLS:
        log(f"warning: {label}: only {n_valid} valid cell(s) in mask (< {MIN_PLANE_CELLS}) — skipped")
        return None
    fit_rows, fit_cols = np.nonzero(fit_cells)
    xs, ys = rasterio.transform.xy(transform, fit_rows + r0, fit_cols + c0)
    fit = fit_plane(np.asarray(xs), np.asarray(ys), cur_win[fit_cells])
    if fit is None:
        log(f"warning: {label}: rank-deficient plane fit — skipped")
        return None
    if edit.flat:
        fit = replace(fit, a=0.0, b=0.0, c=float(cur_win[fit_cells][fit.inliers].mean()))

    target = cur_win.copy()
    mask_rows, mask_cols = np.nonzero(mask_win)
    txs, tys = rasterio.transform.xy(transform, mask_rows + r0, mask_cols + c0)
    target[mask_win] = fit.evaluate(txs, tys)
    return target


def _smooth_target(
    cur_win: np.ndarray,
    mask_win: np.ndarray,
    valid_win: np.ndarray,
    cell_x: float,
    cell_y: float,
    edit: DemEdit,
) -> np.ndarray:
    # Circular footprint of radiusM, converted to cells, minimum 1 cell.
    n_x = max(int(round(edit.radius_m / cell_x)), 1)
    n_y = max(int(round(edit.radius_m / cell_y)), 1)
    dy, dx = np.mgrid[-n_y : n_y + 1, -n_x : n_x + 1]
    footprint = (dx / n_x) ** 2 + (dy / n_y) ** 2 <= 1.0 + 1e-9

    # Medians read the pre-edit heights (cur_win), reaching outside the mask
    # so smoothed edges agree with the surroundings. The window is padded by
    # the radius, so footprints of in-mask cells stay inside it.
    if valid_win.all():
        filtered = median_filter(cur_win, footprint=footprint, mode="nearest")
    else:
        # Nodata present: a plain median would drag toward the nodata value.
        # nan-median it instead — windows are mask-bbox-sized, so the slower
        # generic_filter is fine here. All-nan neighborhoods yield nan, which
        # the feather step zero-weights (cell passes through untouched).
        data = np.where(valid_win, cur_win, np.nan)
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", category=RuntimeWarning)
            filtered = generic_filter(data, np.nanmedian, footprint=footprint, mode="nearest")

    target = cur_win.copy()
    target[mask_win] = filtered[mask_win]
    return target
