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
- ``corridor`` — a road or cart path: anisotropic, smooth ALONG the
  ``centerline`` (a LineString in the feature's ``properties``, WGS84 like
  the rings) and flat ACROSS it. The centerline is resampled at half a
  cell; every in-mask cell takes the station nearest to it; each station's
  height is the mean of the pre-edit heights of its cells (the cross
  section — only cells within ``widthM``/2 of the line when ``widthM`` is
  given, so the verge inside the feather band doesn't pull the profile);
  that 1-D profile gets a running median then a running mean over
  ``smoothM`` (default 25 m) of stations, and each cell's target is its
  station's smoothed height. The isotropic ``smooth`` can't do this: a
  median wide enough to take out 10-20 m undulations smears the surrounding
  grade into the road, and a narrow one leaves them.
- ``dig`` — a bunker or a pond dug below a reference height, never above
  the ground it replaces (every cell becomes min(current, reference − drop)).
  The drop is a profile of the distance ``d`` in from the polygon edge: an
  optional shelf (``shelfM`` wide, falling to ``shelfDepthM``), then a bank
  at ``bankSlopeDeg`` rounding off into a floor at ``depthM``, so the edge
  itself is untouched and a narrow arm never reaches full depth. With
  ``faceSlopeDeg`` + ``faceBearingDeg`` (compass bearing from the polygon's
  centroid) the bank steepens towards that side: a bunker's face towards
  its green, a gentle entry opposite. ``variation`` (0-1) + ``seed`` vary
  bank width and shelf around the perimeter with smooth, seeded noise.
  ``reference: level`` is one flat height, the 25th percentile of the
  in-polygon cells within ``rimM`` of the edge (a pond: lidar sees its
  surface, which then stays the water level OPCD's water plane is put at);
  bank the outline takes in above that level tapers down to it across the
  same ``rimM`` band rather than being cut to it at the shore;
  ``reference: plane`` fits a plane to the ground in a ``rimM`` band outside
  the polygon (a bunker: the lidar has already smoothed the hollow itself).
  ``reference: stream`` is a creek's water surface, falling downstream
  (creeks.surface_profile along the edit's ``centerline``, else the line
  down its polygon); each cell digs below the surface at its nearest
  station, with the same bank taper as ``level``.
- ``delta`` — heights ADDED from a raster (``raster``: a float32 EPSG:3006
  GeoTIFF of metres, bilinear at each cell centre, 0 outside it): a Unity
  sculpt layer (golfpipe/sculpt.py). No feather — the layer carries its own
  edges — and it can raise as well as lower.

The ops feather over an edge band inside the polygon (D-TE3): weight
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
    "OPS", "DEFAULT_FEATHER_M", "DEFAULT_SMOOTH_RADIUS_M", "DEFAULT_CORRIDOR_SMOOTH_M",
    "DIG_REFERENCES", "dig_drop",
    "MIN_PLANE_CELLS", "OUTLIER_SIGMA", "OUTLIER_ROUNDS",
    "load_edits", "reproject_edits", "fit_plane", "apply_edits",
]


class DemEditError(RuntimeError):
    """User-actionable apply-dem-edits input/setup error."""


OPS = ("plane", "smooth", "corridor", "dig", "delta")
DEFAULT_FEATHER_M = 2.0
DEFAULT_SMOOTH_RADIUS_M = 2.0
# Longitudinal smoothing window for corridors: long enough to take out the
# 10-20 m undulations a cart path bounces over, short enough to keep a
# designed crest or dip.
DEFAULT_CORRIDOR_SMOOTH_M = 25.0
DIG_REFERENCES = ("level", "plane", "stream")
DEFAULT_DIG_BANK_SLOPE_DEG = 20.0
DEFAULT_DIG_RIM_M = 2.0
# Water level from the in-polygon rim: a low percentile, so bank cells a
# generously drawn outline takes in don't lift it.
DIG_LEVEL_PERCENTILE = 25.0
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
    # corridor only: the road's centerline as [[x, y], …] (WGS84 as loaded,
    # the DEM CRS after reproject_edits), the along-line smoothing window,
    # and the paved width the profile is sampled over (None = all mask cells).
    centerline: list[list[float]] | None = None
    smooth_m: float = DEFAULT_CORRIDOR_SMOOTH_M
    width_m: float | None = None
    # dig only (see the module docstring).
    depth_m: float = 0.0
    bank_slope_deg: float = DEFAULT_DIG_BANK_SLOPE_DEG
    face_slope_deg: float | None = None
    face_bearing_deg: float | None = None
    shelf_m: float = 0.0
    shelf_depth_m: float = 0.0
    reference: str = "level"
    rim_m: float = DEFAULT_DIG_RIM_M
    variation: float = 0.0
    seed: int = 0
    # delta only: the GeoTIFF of metres to add.
    raster: str | None = None


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
        centerline = None
        smooth_m = DEFAULT_CORRIDOR_SMOOTH_M
        width_m = None
        if op == "corridor":
            centerline = props.get("centerline")
            if (not isinstance(centerline, list) or len(centerline) < 2
                    or not all(isinstance(p, (list, tuple)) and len(p) >= 2 for p in centerline)):
                log(f"warning: {label}: corridor needs a centerline of at least 2 [x, y] points — skipped")
                continue
            centerline = [[float(p[0]), float(p[1])] for p in centerline]
            try:
                smooth_m = float(props.get("smoothM", DEFAULT_CORRIDOR_SMOOTH_M))
                width_m = float(props["widthM"]) if props.get("widthM") is not None else None
            except (TypeError, ValueError):
                log(f"warning: {label}: smoothM/widthM is not a number — skipped")
                continue
            if not np.isfinite(smooth_m) or smooth_m <= 0 or (width_m is not None and not width_m > 0):
                log(f"warning: {label}: smoothM and widthM must be > 0 — skipped")
                continue
        elif op == "dig" and props.get("centerline") is not None:
            # A creek dig (reference: stream) may carry its line and width.
            centerline = props.get("centerline")
            if (not isinstance(centerline, list) or len(centerline) < 2
                    or not all(isinstance(p, (list, tuple)) and len(p) >= 2 for p in centerline)):
                log(f"warning: {label}: dig centerline needs at least 2 [x, y] points — skipped")
                continue
            centerline = [[float(p[0]), float(p[1])] for p in centerline]
            try:
                width_m = float(props["widthM"]) if props.get("widthM") is not None else None
            except (TypeError, ValueError):
                log(f"warning: {label}: widthM is not a number — skipped")
                continue
        raster = None
        if op == "delta":
            raster = props.get("raster")
            if not isinstance(raster, str) or not Path(raster).is_file():
                log(f"warning: {label}: delta needs an existing raster file, got {raster!r} — skipped")
                continue
        dig: dict = {}
        if op == "dig":
            try:
                dig = _dig_params(props)
            except ValueError as exc:
                log(f"warning: {label}: {exc} — skipped")
                continue
        created_at = props.get("createdAt")
        edits.append(DemEdit(
            op=op,
            geometry=geometry,
            feather_m=feather_m,
            radius_m=radius_m,
            flat=bool(props.get("flat", False)),
            created_at=str(created_at) if created_at is not None else None,
            centerline=centerline,
            smooth_m=smooth_m,
            width_m=width_m,
            raster=raster,
            **dig,
        ))

    edits.sort(key=lambda e: (e.created_at is None, e.created_at or ""))
    return edits


def _dig_params(props: dict) -> dict:
    """The dig fields of a D-TE5 feature's properties, validated (ValueError
    names the bad one)."""
    def num(key, default=None):
        value = props.get(key, default)
        if value is None:
            return None
        try:
            value = float(value)
        except (TypeError, ValueError):
            raise ValueError(f"{key} is not a number")
        if not np.isfinite(value):
            raise ValueError(f"{key} is not finite")
        return value

    depth = num("depthM")
    if depth is None or depth <= 0:
        raise ValueError("dig needs depthM > 0")
    bank = num("bankSlopeDeg", DEFAULT_DIG_BANK_SLOPE_DEG)
    face = num("faceSlopeDeg")
    bearing = num("faceBearingDeg")
    for key, value in (("bankSlopeDeg", bank), ("faceSlopeDeg", face)):
        if value is not None and not 0 < value < 90:
            raise ValueError(f"{key} must be between 0 and 90 degrees")
    if (face is None) != (bearing is None):
        raise ValueError("faceSlopeDeg and faceBearingDeg go together")
    shelf = num("shelfM", 0.0)
    shelf_depth = num("shelfDepthM", 0.0)
    if shelf < 0 or shelf_depth < 0 or shelf_depth >= depth:
        raise ValueError("shelfM must be >= 0 and shelfDepthM in [0, depthM)")
    reference = props.get("reference", "level")
    if reference not in DIG_REFERENCES:
        raise ValueError(f"reference must be one of {DIG_REFERENCES}")
    rim = num("rimM", DEFAULT_DIG_RIM_M)
    variation = num("variation", 0.0)
    if rim <= 0 or not 0 <= variation <= 1:
        raise ValueError("rimM must be > 0 and variation in [0, 1]")
    try:
        seed = int(props.get("seed", 0))
    except (TypeError, ValueError):
        raise ValueError("seed is not an integer")
    return dict(
        depth_m=depth, bank_slope_deg=bank, face_slope_deg=face, face_bearing_deg=bearing,
        shelf_m=shelf, shelf_depth_m=shelf_depth, reference=reference, rim_m=rim,
        variation=variation, seed=seed,
    )


def reproject_edits(edits: list[DemEdit], dem_crs) -> list[DemEdit]:
    """Reprojects each edit's rings from WGS84 (the D-TE5 handoff CRS) to the
    DEM's CRS via rasterio.warp.transform_geom."""
    from rasterio.warp import transform as warp_transform
    from rasterio.warp import transform_geom

    out = []
    for edit in edits:
        centerline = edit.centerline
        if centerline:
            xs, ys = warp_transform("EPSG:4326", dem_crs, [p[0] for p in centerline], [p[1] for p in centerline])
            centerline = [[float(x), float(y)] for x, y in zip(xs, ys)]
        out.append(replace(edit, geometry=transform_geom("EPSG:4326", dem_crs, edit.geometry), centerline=centerline))
    return out


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
    pad_m = max(edit.feather_m, edit.radius_m if edit.op == "smooth" else 0.0, edit.rim_m if edit.op == "dig" else 0.0)
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
    elif edit.op == "corridor":
        target = _corridor_target(cur_win, mask_win, valid_win, transform, r0, c0, cell_x, cell_y, edit, label, log)
    elif edit.op == "dig":
        target = _dig_target(cur_win, mask_win, valid_win, transform, r0, c0, cell_x, cell_y, edit, label, log)
    elif edit.op == "delta":
        target = _delta_target(cur_win, mask_win, transform, r0, c0, edit)
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


def _corridor_target(
    cur_win: np.ndarray,
    mask_win: np.ndarray,
    valid_win: np.ndarray,
    transform: "rasterio.Affine",
    r0: int,
    c0: int,
    cell_x: float,
    cell_y: float,
    edit: DemEdit,
    label: str,
    log,
) -> np.ndarray | None:
    from scipy.ndimage import uniform_filter1d
    from scipy.spatial import cKDTree

    pts = np.asarray(edit.centerline or [], dtype=np.float64)
    if pts.ndim != 2 or len(pts) < 2:
        log(f"warning: {label}: corridor has no centerline — skipped")
        return None
    seg = np.hypot(*np.diff(pts, axis=0).T)
    cum = np.concatenate([[0.0], np.cumsum(seg)])
    total = float(cum[-1])
    if total <= 0:
        log(f"warning: {label}: corridor centerline has zero length — skipped")
        return None

    # Stations every half cell along the line.
    step = min(cell_x, cell_y) / 2.0
    n = int(np.ceil(total / step)) + 1
    s = np.linspace(0.0, total, n)
    sx = np.interp(s, cum, pts[:, 0])
    sy = np.interp(s, cum, pts[:, 1])

    cells = mask_win & valid_win
    rows, cols = np.nonzero(cells)
    if len(rows) == 0:
        log(f"warning: {label}: no valid cells in the corridor — skipped")
        return None
    xs, ys = rasterio.transform.xy(transform, rows + r0, cols + c0)
    dist, station = cKDTree(np.column_stack([sx, sy])).query(np.column_stack([xs, ys]))
    z = cur_win[rows, cols]

    # Cross-section mean per station, over the paved width when known.
    on_road = dist <= edit.width_m / 2.0 if edit.width_m is not None else np.ones(len(rows), dtype=bool)
    if not on_road.any():
        on_road = np.ones(len(rows), dtype=bool)
    sums = np.bincount(station[on_road], weights=z[on_road], minlength=n)
    counts = np.bincount(station[on_road], minlength=n)
    sampled = counts > 0
    if int(sampled.sum()) < 2:
        log(f"warning: {label}: corridor covers fewer than 2 stations — skipped")
        return None
    profile = np.interp(s, s[sampled], sums[sampled] / counts[sampled])

    # Running median (spikes) then running mean (the median's steps) over
    # smoothM of stations. The ends are padded by extrapolating the line
    # fitted to the outermost window: "nearest" (or reflect) padding would
    # bend a graded road's ends towards level by grade × half the window,
    # 12 cm at 2 % — visible at every road entry.
    k = max(int(round(edit.smooth_m / step)), 1)
    k += 1 - k % 2
    profile = _extrapolate_ends(profile, s, k)
    smoothed = uniform_filter1d(median_filter(profile, size=k, mode="nearest"), size=k, mode="nearest")[k:-k]

    target = cur_win.copy()
    target[rows, cols] = smoothed[station]
    return target


def _extrapolate_ends(profile: np.ndarray, s: np.ndarray, k: int) -> np.ndarray:
    """`profile` with `k` samples added at each end, continuing the straight
    line fitted to the outermost `2k` samples (all of them when the profile
    is shorter — twice the window so the bumps being smoothed away average
    out of the fit too), so a filter of width k sees the road's grade past
    its ends instead of a padded constant."""
    step = s[1] - s[0] if len(s) > 1 else 1.0
    m = min(2 * k, len(profile))

    def fit(seg_s, seg_z):
        if len(seg_s) < 2 or np.ptp(seg_s) == 0:
            return 0.0, float(seg_z.mean())
        a, b = np.polyfit(seg_s, seg_z, 1)
        return float(a), float(b)

    a0, b0 = fit(s[:m], profile[:m])
    a1, b1 = fit(s[-m:], profile[-m:])
    before = a0 * (s[0] - step * np.arange(k, 0, -1)) + b0
    after = a1 * (s[-1] + step * np.arange(1, k + 1)) + b1
    return np.concatenate([before, profile, after])


def dig_drop(
    d: np.ndarray,
    depth_m: float,
    slope_deg: np.ndarray | float,
    shelf_m: np.ndarray | float = 0.0,
    shelf_depth_m: float = 0.0,
) -> np.ndarray:
    """How far below the reference a dig goes at distance `d` (m) in from its
    edge: 0 at the edge, down a shelf (`shelf_m` wide to `shelf_depth_m`),
    then a bank at `slope_deg` whose toe rounds into the floor at `depth_m`.
    The rounding is a soft minimum over the last ~15 % of the depth, shifted
    so the drop is exactly 0 at the edge and never exceeds `depth_m`."""
    d = np.maximum(np.asarray(d, dtype=np.float64), 0.0)
    shelf_m = np.asarray(shelf_m, dtype=np.float64)
    tan = np.tan(np.radians(np.asarray(slope_deg, dtype=np.float64)))
    on_shelf = d < shelf_m
    shelf_drop = np.where(shelf_m > 0, shelf_depth_m * d / np.maximum(shelf_m, 1e-9), 0.0)
    bank_depth = depth_m - shelf_depth_m
    k = max(0.15 * bank_depth, 1e-3)

    def softmin(a, b):
        return -k * np.logaddexp(-a / k, -b / k)

    past = np.maximum(d - shelf_m, 0.0)
    bank = softmin(past * tan, bank_depth) - softmin(0.0, bank_depth)
    bank = np.clip(bank, 0.0, bank_depth)
    return np.where(on_shelf, shelf_drop, shelf_depth_m + bank)


def _perimeter_noise(bearing_deg: np.ndarray, seed: int) -> np.ndarray:
    """Smooth seeded variation in [-1, 1] around a closed outline (a bearing
    from its centroid): 2-4 lobes plus an overtone, the shape of Shoreline
    Studio's `smooth_variation`."""
    rng = np.random.default_rng(seed)
    phase = rng.random() * 2 * np.pi
    lobes = 2 + int(rng.integers(0, 3))
    angle = np.radians(bearing_deg) * lobes + phase
    return np.clip(0.65 * np.sin(angle) + 0.35 * np.sin(2 * angle + 1.7), -1.0, 1.0)


def _dig_target(
    cur_win: np.ndarray,
    mask_win: np.ndarray,
    valid_win: np.ndarray,
    transform: "rasterio.Affine",
    r0: int,
    c0: int,
    cell_x: float,
    cell_y: float,
    edit: DemEdit,
    label: str,
    log,
) -> np.ndarray | None:
    inside = mask_win & valid_win
    if int(np.count_nonzero(inside)) < 4:
        log(f"warning: {label}: fewer than 4 valid cells in the polygon — skipped")
        return None
    cell = min(cell_x, cell_y)
    # Distance in from the edge (cell centre to the polygon boundary ~ EDT to
    # the nearest outside cell minus half a cell), and which outside cell that
    # is: its bearing from the centroid orients the face.
    edt, (near_r, near_c) = distance_transform_edt(mask_win, sampling=(cell_y, cell_x), return_indices=True)
    d = np.maximum(edt - cell / 2.0, 0.0)

    rows, cols = np.nonzero(mask_win)
    xs, ys = rasterio.transform.xy(transform, rows + r0, cols + c0)
    xs, ys = np.asarray(xs), np.asarray(ys)
    cx, cy = float(xs.mean()), float(ys.mean())
    ex, ey = rasterio.transform.xy(transform, near_r[rows, cols] + r0, near_c[rows, cols] + c0)
    bearing = np.degrees(np.arctan2(np.asarray(ex) - cx, np.asarray(ey) - cy)) % 360.0

    slope = np.full(len(rows), edit.bank_slope_deg)
    if edit.face_slope_deg is not None and edit.face_bearing_deg is not None:
        toward = (1.0 + np.cos(np.radians(bearing - edit.face_bearing_deg))) / 2.0
        slope = edit.bank_slope_deg + (edit.face_slope_deg - edit.bank_slope_deg) * toward
    shelf = np.full(len(rows), edit.shelf_m)
    if edit.variation > 0:
        wobble = 1.0 + 0.5 * edit.variation * _perimeter_noise(bearing, edit.seed)
        # A wider bank is a gentler one: scale the run, not the angle.
        slope = np.degrees(np.arctan(np.tan(np.radians(slope)) / wobble))
        shelf = shelf * wobble

    if edit.reference in ("level", "stream"):
        if edit.reference == "level":
            rim = inside & (d <= edit.rim_m)
            if not rim.any():
                rim = inside
            level = float(np.percentile(cur_win[rim], DIG_LEVEL_PERCENTILE))
        else:
            level = _stream_levels(cur_win, valid_win, mask_win, transform, r0, c0, xs, ys, d, edit, label, log)
            if level is None:
                return None
        # An outline drawn a little generously takes in bank above the water:
        # those cells come down to the level over the rim band instead of being
        # cut to it at the outline (a wall at the shore).
        cur_cells = cur_win[rows, cols]
        t = np.clip(d[rows, cols] / edit.rim_m, 0.0, 1.0)
        taper = t * t * (3 - 2 * t)
        reference = np.where(cur_cells > level, cur_cells + (level - cur_cells) * taper, level)
        # How much of a bank a cell was (0 at the level, 1 from 20 cm above it):
        # the dig proper starts where the taper reaches the level, `rimM` in,
        # so bank and underwater slopes don't stack into a wall.
        above = np.clip((cur_cells - level) / 0.2, 0.0, 1.0)
        dist = np.maximum(d[rows, cols] - edit.rim_m * above, 0.0)
    else:
        dist = d[rows, cols]
        out_edt = distance_transform_edt(~mask_win, sampling=(cell_y, cell_x))
        band = ~mask_win & valid_win & (out_edt <= edit.rim_m + cell / 2.0)
        band_rows, band_cols = np.nonzero(band)
        bx, by = rasterio.transform.xy(transform, band_rows + r0, band_cols + c0)
        fit = fit_plane(np.asarray(bx), np.asarray(by), cur_win[band])
        if fit is None:
            log(f"warning: {label}: no plane fits the ground around the polygon — skipped")
            return None
        reference = fit.evaluate(xs, ys)

    drop = dig_drop(dist, edit.depth_m, slope, shelf, edit.shelf_depth_m)
    target = cur_win.copy()
    target[rows, cols] = np.minimum(cur_win[rows, cols], reference - drop)
    return target


def _stream_levels(
    cur_win: np.ndarray,
    valid_win: np.ndarray,
    mask_win: np.ndarray,
    transform: "rasterio.Affine",
    r0: int,
    c0: int,
    xs: np.ndarray,
    ys: np.ndarray,
    d: np.ndarray,
    edit: DemEdit,
    label: str,
    log,
) -> np.ndarray | None:
    """Per in-mask cell (in `xs`/`ys` order): the creek's water surface at
    its nearest station (creeks.surface_profile over the pre-edit heights),
    along the edit's centerline, else the line down its polygon."""
    from scipy.spatial import cKDTree
    from shapely.geometry import shape

    from golfpipe.creeks import ribbon_centerline, surface_profile

    line = edit.centerline
    width = edit.width_m
    if not line:
        found = ribbon_centerline(shape(edit.geometry))
        if found is None:
            log(f"warning: {label}: no line down this creek polygon — skipped")
            return None
        line = [list(p) for p in found[0].coords]
        width = width or found[1]
    if not width:
        width = 2.0 * float(d[mask_win].max())
    win_transform = transform * rasterio.Affine.translation(c0, r0)
    profile = surface_profile(cur_win, win_transform, np.asarray(line), width, valid=valid_win)
    if profile is None:
        log(f"warning: {label}: the creek line crosses no valid cells — skipped")
        return None
    _, station = cKDTree(np.column_stack([profile.x, profile.y])).query(np.column_stack([xs, ys]))
    return profile.z[station]


def _delta_target(
    cur_win: np.ndarray,
    mask_win: np.ndarray,
    transform: "rasterio.Affine",
    r0: int,
    c0: int,
    edit: DemEdit,
) -> np.ndarray:
    """The heights plus the edit's raster, sampled bilinearly at the cell
    centres (0 outside the raster)."""
    from scipy.ndimage import map_coordinates

    with rasterio.open(edit.raster) as src:
        layer = src.read(1).astype(np.float64)
        inv = ~src.transform
    layer = np.nan_to_num(layer)
    rows, cols = np.nonzero(mask_win)
    xs, ys = rasterio.transform.xy(transform, rows + r0, cols + c0)
    fc, fr = inv * (np.asarray(xs), np.asarray(ys))
    # map_coordinates indexes pixel centres at integers; the affine gives corners.
    add = map_coordinates(layer, [np.asarray(fr) - 0.5, np.asarray(fc) - 0.5], order=1, mode="constant", cval=0.0)
    target = cur_win.copy()
    target[rows, cols] = cur_win[rows, cols] + add
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
