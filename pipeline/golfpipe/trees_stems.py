"""Crown-top estimates from the roof-suppressed nDSM before canopy spreading.

These are visible crown maxima, not surveyed trunk positions. A 0.8 m Gaussian
reduces single-return spikes. Height-dependent maximum windows (radius 1 +
0.15 * height, 2 to 7 m) separate markers, then an 8-connected watershed of
the inverted height assigns crown area. Radius is the equal-area circle,
capped at 0.35 * height (maximum 10 m) to limit merged understory/hedges,
except for flat compact crowns (below). No species inference is made from
this low-density, unclassified lidar.

Support thresholds are two-tier. The candidate mask starts at
DEFAULT_MIN_HEIGHT_M (1.0 m; the roof-suppressed nDSM has no floor, so this
is a free choice) and keeps 8-connected components of at least
DEFAULT_MIN_AREA_M2 (4 m²), plus smaller components of at least
TALL_MIN_AREA_M2 (2 m²) whose top reaches TALL_HEIGHT_M (3 m). After
watershed, a segment whose top is below TALL_HEIGHT_M keeps the 4 m²
requirement; a taller segment needs TALL_MIN_AREA_M2 plus the roof guard
when its support is under ROOF_GUARD_AREA_M2 (12 m²): it is kept only when
a roof mask is given and no roof-suppressed cell lies within ROOF_GUARD_M
(3 m) of the segment. Without a roof mask the tall floor is effectively
ROOF_GUARD_AREA_M2. The 2 m² tall tier comes from Linkan hole 13: a young
tree in the 2021 scan, 4.5 m tall with 8 returns above 1 m, fills three
1 m cells in a row (4.0, 4.5, 4.5 m) and its neighbour with the same 7
returns happens to spread over four, so a 4 m² gate kept one and lost the
other.
Landeryd measurements behind the numbers: an isolated 7 m² bush on Masters
hole 5 tops out at 1.96 m, so a 2 m floor missed it. Components of the
>= 1 m nDSM with a top in [1, 2) m have a median area of 5 m² (1,867 of
them on the Landeryd grid, 90% under 12 m²), and 8 random orthophoto checks
showed bushes, young plantation and understory in six, silage bales and a
residential yard in the other two. Thin birches with few coarse branches
give 1 to 2 returns per m² at this density: five of them in the east corner
of hole 5 (8.9 to 13.3 m tall, return-height spread 4.7 to 8.2 m) occupy 4,
6, 6, 8 and 11 cells, the same support as the roof-edge fragments that
survive multi-return suppression. Distance to a roof separates them: at
4 m² the clubhouse window gains 69 tall stems, 52 within 3 m of a roof cell;
the hole 5 window gains 31, 6 near roofs, and all five birches survive.
Bushes are wider than they are tall, so the 0.35 * height radius cap has a
LOW_CROWN_MAX_RADIUS_M (1.5 m) floor; the hole 5 bush keeps its 1.5 m
equal-area radius instead of 0.7 m. Above 4.3 m the tree cap applies as before.

Flat compact crowns keep their equal-area radius. Wide low crowns (the
willows in the dogleg of Linkan hole 13: 9.5 m tall, 168 m² of watershed
support, 725 returns with a median of 8.1 m and none above 10 m) are the
crown, not a stand share, and the 0.35 * height cap drew them at 3.3 m
instead of 7.3 m. A segment is flat when the 75th percentile of its cell
heights is at least FLAT_CROWN_TOP_FRACTION (0.85) of the stem height, and
compact when its equal-area radius is at least FLAT_CROWN_COMPACTNESS
(0.55) of the farthest cell's distance from the peak; a 30 m hedge fails
compactness (0.13 for a 30 by 3 m strip) and a closed-stand share with a
sloping profile fails flatness. Such a segment gets min(equal-area radius,
FLAT_CROWN_MAX_RADIUS_M). On the hole 13 crop the rule widens 5 of 25
segments over 30 m²; the web renderer trusts a radius above 0.35 * height
for the same reason (see renderCrownRadius in web/src/map/tree-geometry.ts).

Low lobes split off tall segments. The second hole 13 willow (8.6 m, 92 m²)
has a 19 m return inside its west edge from a taller tree. The 0.8 m
Gaussian spreads that spike over its neighbours, the flat crown interior
varies by under 1 m, so no crown cell wins its local-maximum window and the
whole crown joins the 18.9 m segment (one 137 m² stem). A cropped run with
a different sub-metre grid offset kept them apart, so this depends on grid
alignment. After watershed, cells of a segment below LOBE_TOP_FRACTION (0.6)
of its top that form an 8-connected component of at least LOBE_MIN_AREA_M2
(20 m²) and pass is_flat_crown (p75 against the component's p90, equal-area
radius against the extent from the cell nearest the lobe's centroid) become
their own marker at that cell. The lower ring of a sloping crown passes those
percentile tests too, so a lobe whose crest cells (>= 90% of its p90) mostly
touch the segment's higher cells (LOBE_MAX_TOP_EDGE_FRACTION 0.5) is left as
the tall tree's skirt. On the full Linkan grid this adds 56 stems (2 to 17 m)
and gives the willow an 8.9 m, r 4.2 stem beside the 18.9 m tree. Stem heights
are the 3 by 3 maximum within the stem's own segment so a lobe beside a tall
crown keeps its own top.
"""
from __future__ import annotations

from dataclasses import dataclass
import math
from pathlib import Path

import numpy as np
from scipy.ndimage import gaussian_filter, label, maximum_filter
from skimage.segmentation import watershed

from golfpipe.detect_trees import NODATA
from golfpipe import trees_features as trees_features_mod
from golfpipe.trees_features import denoise_mask, near_roof_mask
from golfpipe.water import GEOJSON_CRS_3006

FIELDS = ["x", "y", "heightM", "crownRadiusM", "groundM", "kind"]
ASSET_VERSION = 2
DEFAULT_MIN_HEIGHT_M = 1.0
DEFAULT_MIN_AREA_M2 = 4.0
TALL_HEIGHT_M = 3.0
TALL_MIN_AREA_M2 = 2.0
LOW_CROWN_MAX_RADIUS_M = 1.5
TREE_CROWN_RADIUS_PER_HEIGHT = 0.35
FLAT_CROWN_TOP_FRACTION = 0.85
FLAT_CROWN_COMPACTNESS = 0.55
FLAT_CROWN_MAX_RADIUS_M = 10.0
LOBE_TOP_FRACTION = 0.6
LOBE_MIN_AREA_M2 = 20.0
LOBE_MAX_TOP_EDGE_FRACTION = 0.5
ROOF_GUARD_AREA_M2 = trees_features_mod.ROOF_GUARD_AREA_M2
ROOF_GUARD_M = trees_features_mod.ROOF_GUARD_M

# Crown kind. Inferred from crown colour in a leaf-off ortho (see
# segment_greenness): a crown that is still green in April is a conifer, a
# bare grey crown is broadleaf. Crown-shape features from the 1 m smoothed nDSM
# (crown radius / height, apex sharpness, flat-top fraction) and the lidar
# multi-return fraction were measured at AUC 0.42-0.65 on 40 labelled Landeryd
# stems and are not used.
KIND_BROADLEAF = 0
KIND_CONIFER = 1
KIND_UNKNOWN = 2
KIND_MIN_HEIGHT_M = 4.0
# Mean (G - R) / (R + G + B) over the upper crown, mapped linearly onto a
# conifer score in [0, 1]. Landeryd labelled stems: broadleaf median 0.029,
# conifer median 0.095; the 0.5 score (greenness 0.07) separates 39 of 40.
GREENNESS_ANCHORS = (0.02, 0.12)
CONIFER_THRESHOLD = 0.5
UNKNOWN_BAND = 0.05                  # greenness within 0.065..0.075 stays unknown
UPPER_CROWN_FRACTION = 0.5           # cells at or above this fraction of the segment top count as crown
MIN_ORTHO_COVERAGE = 0.5             # fraction of upper-crown cells the leaf-off ortho must cover
LEAF_OFF_MONTHS = frozenset({10, 11, 12, 1, 2, 3, 4})
LEAF_OFF_ZOOM = 18


@dataclass(frozen=True)
class TreeStem:
    x: float
    y: float
    height_m: float
    crown_radius_m: float
    ground_m: float
    kind: int = KIND_UNKNOWN
    conifer_score: float = float("nan")

    def row(self) -> list[float]:
        return [round(self.x, 2), round(self.y, 2), round(self.height_m, 1),
                round(self.crown_radius_m, 1), round(self.ground_m, 2), int(self.kind)]


def _ramp(value, anchors):
    """Linear map from anchors[0] -> 0 to anchors[1] -> 1, clipped; NaN stays NaN."""
    lo, hi = anchors
    return np.clip((np.asarray(value, dtype=np.float64) - lo) / (hi - lo), 0, 1)


def conifer_score(greenness):
    """Conifer likeness in [0, 1] of the leaf-off upper-crown greenness."""
    return _ramp(greenness, GREENNESS_ANCHORS)


def classify_kind(score, height_m, threshold=CONIFER_THRESHOLD, band=UNKNOWN_BAND, min_height_m=KIND_MIN_HEIGHT_M):
    """0 broadleaf, 1 conifer, 2 unknown (under min_height_m, no score, or within band of the threshold)."""
    score = np.asarray(score, dtype=np.float64)
    height_m = np.asarray(height_m, dtype=np.float64)
    kind = np.where(score >= threshold, KIND_CONIFER, KIND_BROADLEAF)
    unknown = (height_m < min_height_m) | ~np.isfinite(score) | (np.abs(score - threshold) < band)
    return np.where(unknown, KIND_UNKNOWN, kind).astype(np.int64)


def leaf_off_vintage(manifest):
    """Collection name of the newest ortho vintage flown entirely in Oct-Apr, or None."""
    best = None
    for vintage in manifest.get("orthoVintages") or []:
        dates = vintage.get("dates") or []
        if not dates or not all(int(d[5:7]) in LEAF_OFF_MONTHS for d in dates):
            continue
        if best is None or max(dates) > max(best["dates"]):
            best = vintage
    return best["collection"] if best else None


def leaf_off_ortho_dir(tiles_dir, manifest):
    """Tile pyramid directory of the leaf-off vintage: tiles_dir/ortho when it is
    the active vintage, tiles_dir/ortho/<collection> otherwise; None if there is none."""
    collection = leaf_off_vintage(manifest)
    if collection is None:
        return None
    if collection == manifest.get("activeOrtho"):
        return tiles_dir / "ortho"
    return tiles_dir / "ortho" / collection


def sample_ortho_rgb(tile_dir, transform, shape, zoom=LEAF_OFF_ZOOM):
    """Sample a Web Mercator XYZ webp pyramid at the centres of an EPSG:3006 grid.
    Returns float32 (rows, cols, 3); NaN where no tile exists."""
    from PIL import Image
    from rasterio.warp import transform as warp_coords
    rows, cols = shape
    col_idx, row_idx = np.meshgrid(np.arange(cols) + .5, np.arange(rows) + .5)
    east = transform.c + col_idx * transform.a
    north = transform.f + row_idx * transform.e
    lon, lat = warp_coords("EPSG:3006", "EPSG:4326", east.ravel(), north.ravel())
    lon = np.asarray(lon, dtype=np.float64)
    lat = np.radians(np.asarray(lat, dtype=np.float64))
    extent = 2 ** zoom * 256
    px = (lon + 180) / 360 * extent
    py = (1 - np.log(np.tan(lat) + 1 / np.cos(lat)) / math.pi) / 2 * extent
    tile_x = np.floor(px / 256).astype(np.int64)
    tile_y = np.floor(py / 256).astype(np.int64)
    in_x = (px % 256).astype(np.int64)
    in_y = (py % 256).astype(np.int64)
    out = np.full((lon.size, 3), np.nan, dtype=np.float32)
    keys = tile_x * (1 << 32) + tile_y
    for key in np.unique(keys):
        path = Path(tile_dir) / str(zoom) / str(int(key >> 32)) / f"{int(key & 0xffffffff)}.webp"
        if not path.exists():
            continue
        img = np.asarray(Image.open(path).convert("RGB"), dtype=np.float32)
        sel = np.nonzero(keys == key)[0]
        out[sel] = img[in_y[sel], in_x[sel]]
    return out.reshape(rows, cols, 3)


def segment_greenness(raw, segments, peaks, rgb, upper_fraction=UPPER_CROWN_FRACTION, min_coverage=MIN_ORTHO_COVERAGE):
    """Per marker (1-based, in peak order): mean (G - R) / (R + G + B) over the
    upper crown, i.e. segment cells at or above upper_fraction of the segment's
    top height. NaN where the ortho covers less than min_coverage of those cells."""
    from scipy.ndimage import maximum as nd_maximum
    n = len(peaks) + 1
    if n == 1:
        return np.zeros(0)
    labels = np.maximum(segments, 0)
    top = np.asarray(nd_maximum(raw, segments, range(1, n)), dtype=np.float64)
    upper = raw >= upper_fraction * np.concatenate([[np.inf], top])[labels]
    red, green, blue = (rgb[..., i].astype(np.float64) for i in range(3))
    covered = upper & np.isfinite(red) & np.isfinite(green) & np.isfinite(blue)
    greenness = np.where(covered, (green - red) / (red + green + blue + 1e-6), 0.0)
    def seg_sum(weights):
        return np.bincount(labels.ravel(), weights=weights.ravel(), minlength=n)[1:]
    upper_count = seg_sum(upper.astype(np.float64))
    covered_count = seg_sum(covered.astype(np.float64))
    mean = seg_sum(greenness) / np.maximum(covered_count, 1)
    enough = covered_count >= min_coverage * np.maximum(upper_count, 1)
    return np.where(enough & (covered_count > 0), mean, np.nan)


def segment_crowns(ndsm, ground, transform, min_height_m=DEFAULT_MIN_HEIGHT_M, min_area_m2=DEFAULT_MIN_AREA_M2,
                   tall_height_m=TALL_HEIGHT_M, tall_min_area_m2=TALL_MIN_AREA_M2):
    """Smooth, seed and watershed the nDSM. Returns None when nothing qualifies,
    else (raw, smooth, segments, peaks, cell): peaks are (row, col) per marker,
    marker k labels segments == k. The candidate mask keeps components of at
    least min_area_m2, and components of at least tall_min_area_m2 (when
    smaller) whose top reaches tall_height_m."""
    cell = float(transform.a)
    if cell <= 0 or not np.isclose(transform.e, -cell) or transform.b or transform.d:
        raise ValueError("stems require a north-up square metre grid")
    if ndsm.shape != ground.shape or ndsm.ndim != 2:
        raise ValueError("nDSM and ground must be matching 2D grids")
    if min_height_m <= 0 or min_area_m2 <= 0:
        raise ValueError("minimum height and crown area must be positive")
    raw = np.clip(np.nan_to_num(ndsm, nan=0, posinf=0, neginf=0), 0, 40).astype(np.float32)
    valid_ground = np.isfinite(ground) & (ground != NODATA)
    base = (raw >= min_height_m) & valid_ground
    mask = denoise_mask(base, cell, 1.0, min_area_m2)
    if 0 < tall_min_area_m2 < min_area_m2:
        # Thin tall trees: the same closing, a lower floor, and a height test per component.
        thin = denoise_mask(base, cell, 1.0, tall_min_area_m2) & ~mask
        labels, count = label(thin, structure=np.ones((3, 3)))
        if count:
            from scipy.ndimage import maximum as nd_maximum
            tops = np.asarray(nd_maximum(raw, labels, range(1, count + 1)), dtype=np.float64)
            keep = np.concatenate([[False], tops >= tall_height_m])
            mask |= keep[labels]
    mask &= valid_ground
    if not mask.any():
        return None
    smooth = gaussian_filter(raw, 0.8 / cell, mode="constant")
    # Choose a window per pixel, in whole-cell radius bands.
    radii = np.ceil(np.clip(1 + .15 * smooth, 2, 7) / cell).astype(np.int16)
    candidates = np.zeros(mask.shape, dtype=bool)
    for radius in np.unique(radii[mask]):
        local_max = maximum_filter(smooth, size=2 * int(radius) + 1, mode="constant")
        candidates |= mask & (radii == radius) & (smooth == local_max) & (raw >= min_height_m)
    plateaus, count = label(candidates, structure=np.ones((3, 3)))
    # One marker per plateau. Stable ordering gives byte-identical repeated runs.
    from scipy.ndimage import maximum_position
    peaks = maximum_position(smooth, plateaus, range(1, count + 1)) if count else []
    if not peaks:
        return None
    markers = np.zeros(mask.shape, dtype=np.int32)
    for idx, (row, col) in enumerate(peaks, 1):
        markers[row, col] = idx
    segments = watershed(-smooth, markers, connectivity=np.ones((3, 3)), mask=mask)
    return raw, smooth, segments, peaks, cell


def segment_profile(raw, segments, peaks, cell):
    """Per marker (index k for marker k, index 0 unused): the 75th percentile of
    raw cell heights in the segment and the distance in metres from the peak
    to the far edge of the farthest cell."""
    n = len(peaks) + 1
    labels = np.maximum(segments, 0)
    flat_labels = labels.ravel()
    counts = np.bincount(flat_labels, minlength=n)
    order = np.lexsort((raw.ravel(), flat_labels))
    starts = np.cumsum(counts) - counts
    pick = starts + np.floor(0.75 * np.maximum(counts - 1, 0)).astype(np.int64)
    p75 = raw.ravel()[order][np.clip(pick, 0, raw.size - 1)]
    p75[counts == 0] = 0.0
    rows, cols = np.indices(raw.shape)
    peak_rows = np.concatenate([[0], [row for row, _ in peaks]])[labels]
    peak_cols = np.concatenate([[0], [col for _, col in peaks]])[labels]
    d2 = (rows - peak_rows) ** 2 + (cols - peak_cols) ** 2
    far = np.zeros(n)
    np.maximum.at(far, flat_labels, d2.ravel())
    return p75, (np.sqrt(far) + 0.5) * cell


def is_flat_crown(height_m, p75_m, equal_area_radius_m, extent_m, top_fraction=FLAT_CROWN_TOP_FRACTION,
                  compactness=FLAT_CROWN_COMPACTNESS):
    """True for a crown whose cells sit near the top and spread evenly around the peak."""
    return height_m > 0 and extent_m > 0 and p75_m >= top_fraction * height_m and equal_area_radius_m >= compactness * extent_m


def split_low_lobes(raw, segments, peaks, cell, top_fraction=LOBE_TOP_FRACTION, min_area_m2=LOBE_MIN_AREA_M2,
                    min_height_m=DEFAULT_MIN_HEIGHT_M, max_top_edge_fraction=LOBE_MAX_TOP_EDGE_FRACTION):
    """Give flat compact canopy far below a segment's top its own marker.
    A lobe whose highest cells mostly touch the rest of the segment is the
    tall tree's own sloping skirt, not a crown, and stays put.
    Returns (segments, peaks) with new markers appended in segment order;
    the inputs are not modified."""
    from scipy.ndimage import binary_dilation, find_objects, maximum as nd_maximum
    peaks = list(peaks)
    if not peaks:
        return segments, peaks
    segments = segments.copy()
    tops = np.asarray(nd_maximum(raw, segments, range(1, len(peaks) + 1)), dtype=np.float64)
    min_cells = int(math.ceil(min_area_m2 / (cell * cell)))
    structure = np.ones((3, 3), dtype=bool)
    for idx, sl in enumerate(find_objects(segments), 1):
        top = tops[idx - 1]
        if sl is None or top_fraction * top < min_height_m:
            continue
        seg_view = segments[sl]
        raw_view = raw[sl]
        low = (seg_view == idx) & (raw_view < top_fraction * top) & (raw_view >= min_height_m)
        if np.count_nonzero(low) < min_cells:
            continue
        near_rest = binary_dilation((seg_view == idx) & (raw_view >= top_fraction * top), structure=structure)
        labels, count = label(low, structure=structure)
        for k in range(1, count + 1):
            comp = labels == k
            cells = raw_view[comp]
            if cells.size < min_cells:
                continue
            rows, cols = np.nonzero(comp)
            # The marker is the lobe cell nearest its centroid: the smoothed maximum leans
            # toward the tall neighbour's skirt and a flat crown has no top of its own.
            j = int(np.argmin((rows - rows.mean()) ** 2 + (cols - cols.mean()) ** 2))
            extent = (math.sqrt(float(((rows - rows[j]) ** 2 + (cols - cols[j]) ** 2).max())) + 0.5) * cell
            equal_area = math.sqrt(cells.size * cell * cell / math.pi)
            p90, p75 = np.percentile(cells, [90, 75])
            if not is_flat_crown(float(p90), float(p75), equal_area, extent):
                continue
            crest = comp & (raw_view >= 0.9 * p90)
            if np.count_nonzero(crest & near_rest) > max_top_edge_fraction * np.count_nonzero(crest):
                continue
            seg_view[comp] = len(peaks) + 1
            peaks.append((int(rows[j]) + sl[0].start, int(cols[j]) + sl[1].start))
    return segments, peaks


def segment_top_heights(raw, segments):
    """Per cell, the maximum raw height over the 3 by 3 window restricted to
    the cell's own segment (unsegmented cells use only themselves)."""
    out = np.array(raw, dtype=np.float32, copy=True)
    rows, cols = raw.shape
    for dr in (-1, 0, 1):
        for dc in (-1, 0, 1):
            if dr == 0 and dc == 0:
                continue
            src_r = slice(max(dr, 0), rows + min(dr, 0))
            src_c = slice(max(dc, 0), cols + min(dc, 0))
            dst_r = slice(max(-dr, 0), rows + min(-dr, 0))
            dst_c = slice(max(-dc, 0), cols + min(-dc, 0))
            same = segments[dst_r, dst_c] == segments[src_r, src_c]
            np.maximum(out[dst_r, dst_c], np.where(same, raw[src_r, src_c], 0), out=out[dst_r, dst_c])
    return out


def stems_from_ndsm(ndsm, ground, transform, min_height_m=DEFAULT_MIN_HEIGHT_M, min_area_m2=DEFAULT_MIN_AREA_M2,
                    tall_height_m=TALL_HEIGHT_M, tall_min_area_m2=TALL_MIN_AREA_M2, leaf_off_rgb=None,
                    roof_mask=None, roof_guard_area_m2=ROOF_GUARD_AREA_M2, roof_guard_m=ROOF_GUARD_M):
    """Return deterministic crown estimates; all lengths and coordinates in metres.

    Segments with a top below tall_height_m need min_area_m2 of support;
    taller segments need tall_min_area_m2, which may be lower (thin tall trees).
    A tall segment with support under roof_guard_area_m2 is kept only when
    roof_mask (an ndsm-shaped bool grid of roof-suppressed cells) is given
    and no roof cell lies within roof_guard_m of the segment; with
    roof_mask None those segments are dropped.
    leaf_off_rgb is an ndsm-shaped (rows, cols, 3) leaf-off ortho sample (see
    sample_ortho_rgb); each stem gets a kind from its crown greenness (see
    classify_kind). Without it every kind is unknown.
    """
    if tall_height_m <= 0:
        raise ValueError("tall crowns need a positive height split")
    if tall_min_area_m2 <= 0:
        raise ValueError("tall crowns need a positive support floor")
    segmented = segment_crowns(ndsm, ground, transform, min_height_m, min_area_m2, tall_height_m, tall_min_area_m2)
    if segmented is None:
        return []
    raw, smooth, segments, peaks, cell = segmented
    segments, peaks = split_low_lobes(raw, segments, peaks, cell, min_height_m=min_height_m)
    area = np.bincount(np.maximum(segments, 0).ravel(), minlength=len(peaks) + 1) * cell * cell
    p75, extent = segment_profile(raw, segments, peaks, cell)
    near_roof = np.zeros(len(peaks) + 1, dtype=bool)
    if roof_mask is None:
        near_roof[:] = True
    else:
        if np.shape(roof_mask) != raw.shape:
            raise ValueError("roof_mask must match the nDSM shape")
        near = near_roof_mask(roof_mask, cell, roof_guard_m)
        near_roof[np.unique(segments[near & (segments > 0)])] = True
    heights = segment_top_heights(raw, segments)
    if leaf_off_rgb is None:
        scores = np.full(len(peaks), np.nan)
    else:
        scores = conifer_score(segment_greenness(raw, segments, peaks, leaf_off_rgb))
    stems = []
    for idx, (row, col) in enumerate(peaks, 1):
        height = float(heights[row, col])
        if area[idx] < (tall_min_area_m2 if height >= tall_height_m else min_area_m2):
            continue
        if height >= tall_height_m and area[idx] < roof_guard_area_m2 and near_roof[idx]:
            continue
        equal_area = math.sqrt(area[idx] / math.pi)
        radius = min(equal_area, max(cell / 2, TREE_CROWN_RADIUS_PER_HEIGHT * height, LOW_CROWN_MAX_RADIUS_M), 10.0)
        if equal_area > radius and is_flat_crown(height, p75[idx], equal_area, extent[idx]):
            radius = min(equal_area, FLAT_CROWN_MAX_RADIUS_M)
        x, y = transform * (col + .5, row + .5)
        score = float(scores[idx - 1])
        stems.append(TreeStem(x, y, height, radius, float(ground[row, col]), int(classify_kind(score, height)), score))
    return stems


def compact_asset(stems):
    return {"version": ASSET_VERSION, "crs": "EPSG:3006", "fields": FIELDS, "trees": [stem.row() for stem in stems]}


def feature_collection(stems, source_ref, course_id=None):
    result = {"type": "FeatureCollection", "crs": GEOJSON_CRS_3006, "features": []}
    if course_id:
        result["courseId"] = course_id
    for stem in stems:
        row = stem.row()
        result["features"].append({"type": "Feature", "geometry": {"type": "Point", "coordinates": row[:2]},
            "properties": {"type": "tree", "source": "lidar-stems", "source_ref": source_ref,
                           "license": "CC0-1.0", **dict(zip(FIELDS, row))}})
    return result
