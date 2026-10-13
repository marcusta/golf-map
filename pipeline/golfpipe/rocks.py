"""Rock candidates from lidar, ranked with whatever orthophotos the course has.

A boulder standing on the ground is found in the point cloud, not in a photo: the lidar ground
model has filtered it out, so its returns stand 0.5-5 m over the ground with nothing under them,
each the last return of its pulse. A photo then only says how sure the candidate is. It never
removes one: a rock in a tree's shadow is black in that photo, and a course may have one photo
vintage, of any year and season, or none.

    points  -> Collector.add(...) per lidar chunk, .finish() -> BandPoints (the returns in the band)
    detect  -> clusters of band points that are solid, squat, compact and not undercut -> RockCandidate
    photos  -> per vintage a look at each candidate: "grey", "other", "shadow" or "none"
    confidence: high = grey in some vintage; medium = no vintage got a clear look (shadow, no
                photo); low = seen clearly and not grey (a dense bush, a car, a mossy stone).
                Under a tree crown one step lower: the lidar tells less there (see detect).

Limits: a rock the provider classified as ground is in the ground model and has no band points
(a rock slab, an outcrop: find those in the DEM, `terrain_fields`); a stone lower than
MIN_HEIGHT_M is not seen; sheds, cars and log piles are solid too (pass the building survey to
drop what stands on a footprint, judge the rest by eye). The lidar thresholds are counts and
fractions of returns, the photo thresholds are ratios to the candidate's own surroundings in the
same photo, so neither depends on a scan's density or a photo's exposure. Set from the physics
and checked on Vreta (2 points/m², photos of April 2023 and June 2025) only.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
from scipy import ndimage

MIN_HEIGHT_M = 0.5            # band floor: ground returns spread to about +0.4 m (lowveg_features)
MAX_HEIGHT_M = 5.0            # band top; what stands higher over a cell is canopy above it
MIN_TOP_M = 0.6               # a candidate's top (90th percentile of its band heights)
MIN_POINTS = 4
MAX_LENGTH_M = 15.0           # longer is a wall, a hedge or a thicket
MIN_LAST_FRACTION = 0.8       # a pulse stops on rock: its band return is the pulse's last
MAX_OPEN_MULTI_FRACTION = 0.2 # under open sky a pulse on rock returns once (as trees_stems' solid rule)
COVERED_FRACTION = 0.5        # more of its returns than this under something taller: under a crown
LONG_M = 6.0                  # from this length on, an object more than
MAX_LONG_ASPECT = 4.0         # ... this many times longer than wide is a fence, a hedge or a wall
MAX_UNDERCUT_FRACTION = 0.5   # band returns with a ground-level return in the same UNDERCUT_CELL_M cell
UNDERCUT_CELL_M = 0.5
MAX_SCATTER_M = 1.0           # median height range of the band returns sharing a cell: a surface, not twigs
MAX_SLENDERNESS = 1.0         # top / length: a trunk or a post stands taller than it is long
GROUND_CLASSES = (2, 9, 17)   # ground, water, bridge deck: never a rock return
NOISE_CLASSES = (7, 18)
BUILDING_CLASSES = (6,)

PHOTO_STEP_M = 0.3            # lattice a photo is sampled on (a z18 pixel at 58 N)
FOOTPRINT_SHRINK = 0.8        # the look keeps inside the outline: the rock leans a little in a photo
RING_GAP_M = 1.0              # surroundings: from this far outside the outline ...
RING_M = 4.0                  # ... to this far
SHADOW_OF_MEDIAN = 0.7        # a pixel darker than this share of the photo's median brightness is in shadow
SHADOW_MAX_FRACTION = 0.5     # more of the footprint in shadow than this: no look in that vintage
MIN_LOOK_PIXELS = 6
GREY_SATURATION_RATIO = 0.75  # grey: less saturated than the lit ground round it by this ratio ...
GREY_BRIGHTNESS_RATIO = 0.8   # ... and not darker than it by more than this
KNOWN_MARGIN_M = 1.0

CONFIDENCE_ORDER = {"high": 0, "medium": 1, "low": 2}


@dataclass(frozen=True)
class BandPoints:
    """The returns MIN_HEIGHT_M..MAX_HEIGHT_M over the ground model that are not ground, water,
    building or noise. h = height over the ground; last = the last return of its pulse; multi =
    its pulse had more returns; undercut = a ground-level return shares its UNDERCUT_CELL_M cell;
    covered = something stands over MAX_HEIGHT_M in its ground cell."""
    x: np.ndarray
    y: np.ndarray
    h: np.ndarray
    last: np.ndarray
    multi: np.ndarray
    undercut: np.ndarray
    covered: np.ndarray


@dataclass(frozen=True)
class RockCandidate:
    x: float
    y: float
    height_m: float
    length_m: float
    width_m: float
    yaw_deg: float            # compass bearing of the long side, 0..180
    points: int
    last_fraction: float
    multi_fraction: float
    undercut_fraction: float
    covered_fraction: float
    scatter_m: float
    photo: dict = field(default_factory=dict)   # vintage -> "grey" | "other" | "shadow" | "none"
    confidence: str = "medium"
    known: str | None = None


class Collector:
    """Gathers the band points of a box from lidar chunks. `ground` is the ground model on
    `transform` (north up, EPSG:3006), as grid_dem.build_dem_grid makes it."""

    def __init__(self, ground, transform):
        self.ground = np.asarray(ground, dtype=np.float64)
        self.e_min, self.n_max, self.cell = transform.c, transform.f, transform.a
        self.rows, self.cols = self.ground.shape
        factor = max(1, int(round(self.cell / UNDERCUT_CELL_M)))
        self.fine = self.cell / factor
        self.low = np.zeros((self.rows * factor, self.cols * factor), dtype=bool)
        self.high = np.zeros((self.rows, self.cols), dtype=bool)
        self.parts = []

    def add(self, x, y, z, classification, number_of_returns, return_number):
        x = np.asarray(x, dtype=np.float64)
        y = np.asarray(y, dtype=np.float64)
        colf = (x - self.e_min) / self.cell
        rowf = (self.n_max - y) / self.cell
        classification = np.asarray(classification)
        keep = (colf >= 0) & (colf < self.cols) & (rowf >= 0) & (rowf < self.rows) & ~np.isin(classification, NOISE_CLASSES)
        if not keep.any():
            return
        x, y, colf, rowf, classification = x[keep], y[keep], colf[keep], rowf[keep], classification[keep]
        number_of_returns = np.asarray(number_of_returns)[keep]
        return_number = np.asarray(return_number)[keep]
        # the ground under each return: bilinear between the cell centres
        ground = ndimage.map_coordinates(self.ground, [rowf - .5, colf - .5], order=1, mode="nearest")
        h = np.asarray(z, dtype=np.float64)[keep] - ground
        low = h < MIN_HEIGHT_M
        self.low[(rowf[low] * self.cell / self.fine).astype(np.int64), (colf[low] * self.cell / self.fine).astype(np.int64)] = True
        high = h > MAX_HEIGHT_M
        self.high[rowf[high].astype(np.int64), colf[high].astype(np.int64)] = True
        band = ~low & ~high & ~np.isin(classification, GROUND_CLASSES + BUILDING_CLASSES)
        if band.any():
            self.parts.append((x[band], y[band], h[band], return_number[band] >= number_of_returns[band],
                               number_of_returns[band] > 1))

    def finish(self) -> BandPoints:
        if not self.parts:
            empty = np.zeros(0)
            none = np.zeros(0, dtype=bool)
            return BandPoints(empty, empty, empty, none, none, none, none)
        x, y, h, last, multi = (np.concatenate(values) for values in zip(*self.parts))
        colf = (x - self.e_min) / self.cell
        rowf = (self.n_max - y) / self.cell
        undercut = self.low[(rowf * self.cell / self.fine).astype(np.int64), (colf * self.cell / self.fine).astype(np.int64)]
        covered = self.high[rowf.astype(np.int64), colf.astype(np.int64)]
        return BandPoints(x, y, h, last, multi, undercut, covered)


def detect(points: BandPoints, cell_m: float = 1.0) -> list[RockCandidate]:
    """Clusters of band points (touching cell_m cells) that read as one solid squat object.

    Under open sky the pulses on it must be single returns. Under a crown that says nothing (the
    pulse split in the crown first), so there only "the last return, nothing under it" is left,
    which low branches pass too: those candidates rank a step lower (confidence_of)."""
    if points.x.size == 0:
        return []
    col = np.floor((points.x - points.x.min()) / cell_m).astype(np.int64)
    row = np.floor((points.y.max() - points.y) / cell_m).astype(np.int64)
    occupied = np.zeros((row.max() + 1, col.max() + 1), dtype=bool)
    occupied[row, col] = True
    labels, count = ndimage.label(occupied, structure=np.ones((3, 3)))
    label = labels[row, col]

    def per_label(weights=None):
        return np.bincount(label, weights=weights, minlength=count + 1)
    n = per_label()
    cells = np.bincount(labels.ravel(), minlength=count + 1)
    last = per_label(points.last) / np.maximum(n, 1)
    undercut = per_label(points.undercut) / np.maximum(n, 1)
    multi = per_label(points.multi) / np.maximum(n, 1)
    covered = per_label(points.covered) / np.maximum(n, 1)
    likely = ((n >= MIN_POINTS) & (last >= MIN_LAST_FRACTION) & (undercut <= MAX_UNDERCUT_FRACTION)
              & ((covered > COVERED_FRACTION) | (multi <= MAX_OPEN_MULTI_FRACTION))
              & (cells * cell_m * cell_m <= MAX_LENGTH_M * MAX_LENGTH_M))
    likely[0] = False
    order = np.argsort(label, kind="stable")
    starts = np.searchsorted(label[order], np.arange(count + 2))
    cell_key = row * occupied.shape[1] + col
    found = []
    for index in np.nonzero(likely)[0]:
        sel = order[starts[index]:starts[index + 1]]
        x, y, h = points.x[sel], points.y[sel], points.h[sel]
        top = float(np.percentile(h, 90))
        if top < MIN_TOP_M:
            continue
        # long side: the first principal axis of the footprint; sizes are the extents along the two
        # axes plus one point spacing (the outermost returns fall short of the edge by half each side)
        centred = np.column_stack([x - x.mean(), y - y.mean()])
        _, vectors = np.linalg.eigh(np.cov(centred.T) if len(sel) > 2 else np.eye(2))
        along = centred @ vectors[:, 1]
        across = centred @ vectors[:, 0]
        spacing = min(cell_m, float(np.sqrt(cells[index] * cell_m * cell_m / len(sel))))
        length = float(along.max() - along.min()) + spacing
        width = float(across.max() - across.min()) + spacing
        if length > MAX_LENGTH_M or top / max(length, cell_m) > MAX_SLENDERNESS:
            continue
        if length >= LONG_M and length > MAX_LONG_ASPECT * width:
            continue
        keys, inverse, in_cell = np.unique(cell_key[sel], return_inverse=True, return_counts=True)
        spread = ndimage.maximum(h, inverse, range(len(keys))) - ndimage.minimum(h, inverse, range(len(keys)))
        scatter = float(np.median(np.asarray(spread)[in_cell > 1])) if (in_cell > 1).any() else 0.0
        if scatter > MAX_SCATTER_M:
            continue
        mid_along = (along.max() + along.min()) / 2
        mid_across = (across.max() + across.min()) / 2
        centre = np.array([x.mean(), y.mean()]) + mid_along * vectors[:, 1] + mid_across * vectors[:, 0]
        found.append(RockCandidate(
            x=float(centre[0]), y=float(centre[1]), height_m=top, length_m=length, width_m=min(width, length),
            yaw_deg=float(np.degrees(np.arctan2(vectors[0, 1], vectors[1, 1])) % 180), points=len(sel),
            last_fraction=float(last[index]), multi_fraction=float(multi[index]),
            undercut_fraction=float(undercut[index]), covered_fraction=float(covered[index]),
            scatter_m=scatter))
    return found


def _brightness_saturation(rgb):
    high, low = rgb.max(axis=-1), rgb.min(axis=-1)
    return high / 255.0, np.where(high > 0, (high - low) / np.maximum(high, 1.0), 0.0)


def photo_shadow_level(sample, bbox_3006, step_m: float = 20.0) -> float | None:
    """The brightness under which a pixel of this photo counts as shadow: SHADOW_OF_MEDIAN of the
    photo's median brightness over the box. None when the photo does not cover the box."""
    e_min, n_min, e_max, n_max = bbox_3006
    east, north = np.meshgrid(np.arange(e_min + step_m / 2, e_max, step_m), np.arange(n_min + step_m / 2, n_max, step_m))
    rgb = np.asarray(sample(east.ravel(), north.ravel()), dtype=np.float64)
    seen = np.isfinite(rgb).all(axis=-1)
    if not seen.any():
        return None
    return SHADOW_OF_MEDIAN * float(np.median(_brightness_saturation(rgb[seen])[0]))


def photo_look(sample, candidate: RockCandidate, shadow_level: float | None) -> str:
    """What one photo shows where the candidate stands: "grey" (paler and less saturated than the lit
    ground round it), "other" (seen, not grey), "shadow" (the footprint is in shadow: nothing
    to read) or "none" (no photo there). `sample(east, north)` returns (n, 3) RGB 0..255, NaN outside."""
    if shadow_level is None:
        return "none"
    half_length = max(candidate.length_m / 2, PHOTO_STEP_M)
    half_width = max(candidate.width_m / 2, PHOTO_STEP_M)
    reach = half_length + RING_M
    offsets = np.arange(-reach, reach + PHOTO_STEP_M / 2, PHOTO_STEP_M)
    de, dn = (grid.ravel() for grid in np.meshgrid(offsets, offsets))
    yaw = np.radians(candidate.yaw_deg)
    along = de * np.sin(yaw) + dn * np.cos(yaw)
    across = de * np.cos(yaw) - dn * np.sin(yaw)

    def inside(grow):
        return (along / (half_length + grow)) ** 2 + (across / (half_width + grow)) ** 2 <= 1.0
    footprint = (along / (half_length * FOOTPRINT_SHRINK)) ** 2 + (across / (half_width * FOOTPRINT_SHRINK)) ** 2 <= 1.0
    ring = inside(RING_M) & ~inside(RING_GAP_M)
    rgb = np.asarray(sample(candidate.x + de, candidate.y + dn), dtype=np.float64)
    seen = np.isfinite(rgb).all(axis=-1)
    if (seen & footprint).sum() < max(MIN_LOOK_PIXELS, 0.5 * footprint.sum()):
        return "none"
    brightness, saturation = _brightness_saturation(np.where(seen[:, None], rgb, 0.0))
    lit = seen & (brightness >= shadow_level)
    on = footprint & seen
    if (on & ~lit).sum() > SHADOW_MAX_FRACTION * on.sum() or (footprint & lit).sum() < MIN_LOOK_PIXELS:
        return "shadow"
    around = ring & lit
    if around.sum() < MIN_LOOK_PIXELS:
        return "shadow"   # nothing lit to compare with
    rock = footprint & lit
    grey = (saturation[rock].mean() <= GREY_SATURATION_RATIO * saturation[around].mean()
            and brightness[rock].mean() >= GREY_BRIGHTNESS_RATIO * brightness[around].mean())
    return "grey" if grey else "other"


def confidence_of(looks: dict, covered_fraction: float = 0.0) -> str:
    verdicts = set(looks.values())
    tier = 0 if "grey" in verdicts else 2 if "other" in verdicts else 1
    if covered_fraction > COVERED_FRACTION:
        tier = min(2, tier + 1)
    return ("high", "medium", "low")[tier]


def assess(candidates, photos: dict, bbox_3006, known=(), keep=None) -> list[RockCandidate]:
    """Candidates with their photo looks, confidence and the known rock each stands on, best first.
    photos: vintage name -> sample(east, north). known: (id, e, n, lengthM) rocks already placed.
    keep(candidate) False drops one (a building footprint, too far from play)."""
    from dataclasses import replace
    levels = {name: photo_shadow_level(sample, bbox_3006) for name, sample in photos.items()}
    result = []
    for candidate in candidates:
        if keep is not None and not keep(candidate):
            continue
        looks = {name: photo_look(sample, candidate, levels[name]) for name, sample in photos.items()}
        on = None
        for rock_id, e, n, length in known:
            if np.hypot(candidate.x - e, candidate.y - n) <= max(length, candidate.length_m) / 2 + KNOWN_MARGIN_M:
                on = rock_id
                break
        result.append(replace(candidate, photo=looks, confidence=confidence_of(looks, candidate.covered_fraction), known=on))
    result.sort(key=lambda c: (CONFIDENCE_ORDER[c.confidence], -c.height_m * c.length_m, -c.y, c.x))
    return result


def known_rocks(walls_spec: dict) -> list[tuple[str, float, float, float]]:
    """(id, e, n, lengthM) of the single stones of a golfmap-walls-v1 spec (`boulders`)."""
    return [(str(b.get("id", "")), float(b["e"]), float(b["n"]), float(b.get("lengthM", 1.0)))
            for b in walls_spec.get("boulders") or [] if "e" in b and "n" in b]


def feature_collection(candidates, source_ref: str, vintages=()) -> dict:
    """GeoJSON points (EPSG:3006), best first."""
    features = []
    for c in candidates:
        features.append({"type": "Feature", "geometry": {"type": "Point", "coordinates": [round(c.x, 2), round(c.y, 2)]},
                         "properties": {
                             "type": "rock_candidate", "source": "lidar-rocks", "source_ref": source_ref,
                             "confidence": c.confidence, "known": c.known,
                             "heightM": round(c.height_m, 2), "lengthM": round(c.length_m, 1), "widthM": round(c.width_m, 1),
                             "yawDeg": round(c.yaw_deg), "points": c.points,
                             "lastFraction": round(c.last_fraction, 2), "multiFraction": round(c.multi_fraction, 2),
                             "undercutFraction": round(c.undercut_fraction, 2), "underCanopy": round(c.covered_fraction, 2),
                             "scatterM": round(c.scatter_m, 2), "photo": c.photo}})
    return {"type": "FeatureCollection", "crs": {"type": "name", "properties": {"name": "EPSG:3006"}},
            "photoVintages": list(vintages), "features": features}
