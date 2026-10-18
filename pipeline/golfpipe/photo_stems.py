"""Photo stems: young trees the lidar missed, found from their shadows in the summer photo.

Only on open ground: rough, semi rough, deep rough and fairway, minus every closed surface
(green, tee, bunker, water, creek, path, rock slab, tree species area, woodland floor) whatever
order they were drawn in, a band along them and a wider one along the water (pond-bank stones sit
in the rough and cast shadows too). Woodland stays lidar-only.

A young tree on Omberg's 2025-06-14 photo is a dark shadow stretched away from the sun (north-west
there) with a small green crown tuft at its sun-side end, about a metre sun-side of where the dark
ends. The rules are config: vegetation-rules/photo-stems.json. The steps:

1. Darkness, tile by tile over the open ground only: the luminance against the open grass round it
   (median of 2.56 m blocks, then of 5 x 5 blocks); a shadow is a patch darker than
   `shadow-grow` of that with a core darker than `shadow-seed`.
2. Sun: the shadow direction from the lidar stems that cast one (stem to its shadow's centroid,
   median angle); with too few, `default-shadow-azimuth`.
3. Each shadow measured along that direction: where it ends on the sun side (the first slice across
   it that is dark on the whole), its length and its width (area / length). Its stem stands
   `stem_offset` sun-side of the end.
4. Calibration on the lidar stems whose own shadow ends within `match-m` of them (Calibration):
   the sun factor and the lines from shadow tip distance and width to lidar height and crown radius.
   Each matched stem's height is read back from its own shadow with that stem left out of the
   calibration (`matched[].heightFromShadowM`).
5. Proposals: every other shadow that is no lidar tree's (none within `dedupe-m`, not in a
   lidar tree's own shadow), of a tree's shape and size, on open ground; a smaller piece lying on a
   bigger one's tree goes.
6. Kind from the leaf-off photo round each proposal (`_kind_at`).

Output `golfmap-photo-stems-v1` (EPSG:3006): `calibration`, `matched`, `proposals` with ids
`epsg3006:<x>:<y>` (2 decimals, stems_asset.stem_id), the id gspro.py trees gives a stem there. The
same inputs give the same ids; `--known` leaves accepted and skipped ids out without moving the others.
"""
from __future__ import annotations

from dataclasses import dataclass
import json
import math
from pathlib import Path
from typing import NamedTuple
import warnings

import numpy as np
import rasterio
from rasterio.features import rasterize
from rasterio.windows import Window, from_bounds
from scipy import ndimage as ndi
from shapely import clip_by_rect
from shapely.geometry import Point, box
from shapely.ops import unary_union
from shapely.prepared import prep

from golfpipe import stems_asset
from golfpipe.stems_asset import stem_id
from golfpipe.trees_stems import CONIFER_THRESHOLD, KIND_BROADLEAF, KIND_CONIFER, KIND_UNKNOWN, conifer_score
import vegetation_rules

RULES = vegetation_rules.load("photo-stems")

FORMAT = "golfmap-photo-stems-v1"
SOURCE = stems_asset.PHOTO_SOURCE

OPEN_TYPES = ("rough", "semi_rough", "deep_rough", "fairway")
CLOSED_TYPES = ("green", "tee", "bunker", "water", "water_creek", "path", "rock_slab", "tree_area")
WATER_TYPES = ("water", "water_creek")
WOODLAND_ZONE = "woodland_floor"

SEED_RATIO = RULES["shadow-seed"]
GROW_RATIO = RULES["shadow-grow"]
END_RATIO = RULES["shadow-end"]
MIN_SHADOW_LENGTH_M = RULES["min-shadow-length"]
WATER_BAND_M = RULES["water-band"]
CLOSED_BAND_M = RULES["closed-band"]
MIN_SHADOW_AREA_M2 = RULES["min-shadow-area"]
MAX_SHADOW_AREA_M2 = RULES["max-shadow-area"]
MIN_ELONGATION = RULES["min-elongation"]
MAX_AXIS_OFF_DEG = RULES["max-axis-off"]
MATCH_M = RULES["match-m"]
DEDUPE_M = RULES["dedupe-m"]
PIECE_REACH_M = RULES["piece-reach"]
MIN_MATCHES = RULES["min-matches"]
MIN_HEIGHT_M = RULES["min-height"]
MAX_HEIGHT_M = RULES["max-height"]
DEFAULT_SHADOW_AZIMUTH_DEG = RULES["default-shadow-azimuth"]
DEFAULT_SUN_FACTOR = RULES["default-sun-factor"]
OFFSET_M = RULES["offset"]
OFFSET_PER_WIDTH = RULES["offset-per-width"]
MIN_FIT_MATCHES = RULES["min-fit"]
DEFAULT_RADIUS_PER_WIDTH = RULES["default-radius-per-width"]
CONIFER_MAX_RATIO = RULES["conifer-max-ratio"]
CONIFER_MIN_GREENNESS = RULES["conifer-min-greenness"]
CONIFER_MIN_AREA_M2 = RULES["conifer-min-area"]
BARE_MAX_RATIO = RULES["bare-max-ratio"]
BARE_MIN_AREA_M2 = RULES["bare-min-area"]

# Reading the photo.
TILE_PX = 2048
MARGIN_PX = 160
BLOCK_PX = 16
BG_BLOCKS = 2  # the background is the median of (2 * BG_BLOCKS + 1)^2 blocks

# Measuring a shadow: its sun-side end is the first slice this deep across it that is dark on the whole
# (`shadow-end`), and a shadow is never measured shorter than the minimum.
END_SLICE_M = 0.32
MIN_MEASURED_LENGTH_M = 0.16

# The shadow direction: read from lidar stems at least this tall, to the shadows whose centroid lies from
# DIRECTION_MIN_DIST_M to DIRECTION_REACH_PER_HEIGHT x height + DIRECTION_REACH_M from them.
DIRECTION_MIN_HEIGHT_M = 2.0
DIRECTION_MIN_DIST_M = 0.5
DIRECTION_REACH_PER_HEIGHT = 1.2
DIRECTION_REACH_M = 3.0

# A lidar stem's own shadow: the stem stands at most this far shadow-side of the end, and this far across.
MATCH_BEHIND_END_M = 0.5
MATCH_ACROSS_M = 1.5

# A shadow at least this elongated must point along the shadow direction (`max-axis-off`).
AXIS_CHECK_ELONGATION = 1.5
# Lidar stems further than this (on either axis) are not looked at for a proposal.
LIDAR_SEARCH_M = 40.0
# A lidar tree's own shadow: its length (sun factor x height) and its crown radius, plus this.
LIDAR_SHADOW_MARGIN_M = 1.0
# A smaller piece lies on a bigger proposal's tree within half its width plus this (at least the minimum) across.
PIECE_ACROSS_MARGIN_M = 0.5
PIECE_ACROSS_MIN_M = 1.0

# A proposal's crown radius: at least the minimum, at most CROWN_CAP_PER_HEIGHT x height + CROWN_CAP_M.
MIN_CROWN_RADIUS_M = 0.5
CROWN_CAP_PER_HEIGHT = 0.35
CROWN_CAP_M = 0.5

# The kind in the leaf-off photo: the crown is within radius + KIND_REACH_M of the proposal, the ground round
# it from KIND_GAP_M beyond that to max(KIND_RING_MIN_M, KIND_RING_PER_RADIUS x radius).
KIND_REACH_M = 1.5
KIND_GAP_M = 1.0
KIND_RING_MIN_M = 6.0
KIND_RING_PER_RADIUS = 3


class PhotoStemsError(Exception):
    pass


# --- open ground -------------------------------------------------------------------------------

def ground_of(features: list[dict]):
    """The open ground as one shapely geometry in EPSG:3006 from the app's feature rows
    ({type, attributes, geometry}; geometry as stored, outlines expanded like the SVG's): rough,
    semi rough, deep rough and fairway minus every closed surface and the woodland floor, whatever
    order they were drawn in, minus CLOSED_BAND_M round those and WATER_BAND_M round the water."""
    import gspro

    shapes: dict[str, list] = {}
    for row in features:
        kind = row.get("type")
        if kind == "vegetation_zone":
            if ((row.get("attributes") or {}).get("zoneType")) != WOODLAND_ZONE:
                continue
            kind = WOODLAND_ZONE
        if kind not in OPEN_TYPES and kind not in CLOSED_TYPES and kind != WOODLAND_ZONE:
            continue
        geometry = row.get("geometry")
        if isinstance(geometry, str):
            geometry = json.loads(geometry)
        if not isinstance(geometry, dict):
            continue
        g = gspro._zone_geometry_m(geometry)
        if g is not None and not g.is_empty:
            shapes.setdefault(kind, []).append(g.buffer(0))
    open_g = unary_union([g for t in OPEN_TYPES for g in shapes.get(t, [])])
    closed_g = unary_union([g for t in (*CLOSED_TYPES, WOODLAND_ZONE) for g in shapes.get(t, [])])
    water_g = unary_union([g for t in WATER_TYPES for g in shapes.get(t, [])])
    ground = open_g
    if not closed_g.is_empty:
        ground = ground.difference(closed_g.buffer(CLOSED_BAND_M, quad_segs=4))
    if not water_g.is_empty:
        ground = ground.difference(water_g.buffer(WATER_BAND_M, quad_segs=4))
    return ground


# --- shadows -----------------------------------------------------------------------------------

@dataclass
class Shadow:
    pixel_e: np.ndarray   # pixel centres, EPSG:3006
    pixel_n: np.ndarray
    ratio: np.ndarray     # luminance / background per pixel
    area_m2: float
    centroid_e: float = 0.0
    centroid_n: float = 0.0


def _background(lum: np.ndarray, mask: np.ndarray) -> np.ndarray:
    """The open grass level round every pixel: the median of BLOCK_PX blocks of open pixels, then
    the median of the blocks round each block (NaN where no open pixel is near)."""
    h, w = lum.shape
    bh, bw = -(-h // BLOCK_PX), -(-w // BLOCK_PX)
    padded = np.full((bh * BLOCK_PX, bw * BLOCK_PX), np.nan, np.float32)
    padded[:h, :w] = np.where(mask, lum, np.nan)
    blocks = padded.reshape(bh, BLOCK_PX, bw, BLOCK_PX).transpose(0, 2, 1, 3).reshape(bh, bw, -1)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        med = np.nanmedian(blocks, axis=2)
        k = 2 * BG_BLOCKS + 1
        p = np.pad(med, BG_BLOCKS, constant_values=np.nan)
        win = np.lib.stride_tricks.sliding_window_view(p, (k, k)).reshape(bh, bw, k * k)
        bg = np.nanmedian(win, axis=2).astype(np.float32)
    full = np.repeat(np.repeat(bg, BLOCK_PX, axis=0), BLOCK_PX, axis=1)
    return full[:h, :w]


def find_shadows(photo: Path, ground) -> tuple[list[Shadow], dict]:
    """Every shadow on the open ground of the photo, tile by tile (each shadow taken from the tile
    whose core holds its centroid)."""
    shadows: list[Shadow] = []
    with rasterio.open(photo) as ds:
        if ds.count < 3:
            raise PhotoStemsError(f"{photo} is not an RGB photo")
        info = {"photo": str(photo), "pixelM": abs(ds.transform.a), "tiles": 0}
        span = _pixel_span(ds, ground.bounds)
        if span is None:
            return shadows, info
        row0, col0, row1, col1 = span
        prepared = prep(ground)
        for r in range(row0, row1, TILE_PX):
            for c in range(col0, col1, TILE_PX):
                found = _tile_shadows(ds, ground, prepared, (r, c, min(r + TILE_PX, row1), min(c + TILE_PX, col1)))
                if found is None:
                    continue
                info["tiles"] += 1
                shadows.extend(found)
    shadows.sort(key=lambda s: (round(s.centroid_e, 3), round(s.centroid_n, 3)))
    return shadows, info


def _pixel_span(ds, bounds) -> tuple[int, int, int, int] | None:
    """(row0, col0, row1, col1): the photo's pixels under the ground's bounds; None when they miss it."""
    gx0, gy0, gx1, gy1 = bounds
    b = ds.bounds
    x0, y0, x1, y1 = max(gx0, b.left), max(gy0, b.bottom), min(gx1, b.right), min(gy1, b.top)
    if x0 >= x1 or y0 >= y1:
        return None
    full = from_bounds(x0, y0, x1, y1, ds.transform).round_offsets().round_lengths()
    return (max(0, int(full.row_off)), max(0, int(full.col_off)),
            min(ds.height, int(full.row_off + full.height)), min(ds.width, int(full.col_off + full.width)))


def _tile_shadows(ds, ground, prepared, core: tuple[int, int, int, int]) -> list[Shadow] | None:
    """The shadows whose centroid lies in the tile's core (row0, col0, row1, col1), read with a margin
    round it; None when the tile has no open ground."""
    rr0, cc0 = max(0, core[0] - MARGIN_PX), max(0, core[1] - MARGIN_PX)
    rr1, cc1 = min(ds.height, core[2] + MARGIN_PX), min(ds.width, core[3] + MARGIN_PX)
    win = Window(cc0, rr0, cc1 - cc0, rr1 - rr0)
    t = ds.window_transform(win)
    wx0, wy1 = t * (0, 0)
    wx1, wy0 = t * (win.width, win.height)
    if not prepared.intersects(box(wx0, wy0, wx1, wy1)):
        return None
    part = clip_by_rect(ground, wx0, wy0, wx1, wy1)
    if part.is_empty:
        return None
    mask = rasterize([(part, 1)], out_shape=(int(win.height), int(win.width)), transform=t,
                     fill=0, dtype="uint8").astype(bool)
    if not mask.any():
        return None
    rgb = ds.read([1, 2, 3], window=win)
    lum = rgb.astype(np.float32).sum(axis=0) / 3.0
    bg = _background(lum, mask)
    ratio = ndi.gaussian_filter(lum, 1.0) / np.maximum(bg, 1.0)
    ratio[~mask | ~np.isfinite(bg)] = np.inf
    lab, count = ndi.label(ratio < GROW_RATIO, structure=np.ones((3, 3), bool))
    if not count:
        return []
    seeded = np.zeros(count + 1, bool)
    seeded[np.unique(lab[ratio < SEED_RATIO])] = True
    seeded[0] = False
    px = abs(ds.transform.a)
    out = []
    for i, sl in enumerate(ndi.find_objects(lab), 1):
        if sl is None or not seeded[i]:
            continue
        s = _shadow_of(lab[sl] == i, sl, ratio, t, (rr0, cc0), core, px)
        if s is not None:
            out.append(s)
    return out


def _shadow_of(patch: np.ndarray, sl, ratio: np.ndarray, t, origin: tuple[int, int],
               core: tuple[int, int, int, int], px: float) -> Shadow | None:
    """One labelled patch (`patch` over the slice `sl` of the window read at photo pixel `origin`) as a
    Shadow; None when it is too small or its centroid lies outside the tile's core (another tile owns it)."""
    area = int(patch.sum()) * px * px
    if area < MIN_SHADOW_AREA_M2:
        return None
    rows, cols = np.nonzero(patch)
    rows = rows + sl[0].start
    cols = cols + sl[1].start
    mr, mc = rows.mean() + origin[0], cols.mean() + origin[1]
    if not (core[0] <= mr < core[2] and core[1] <= mc < core[3]):
        return None
    e = t.c + (cols + 0.5) * t.a
    n = t.f + (rows + 0.5) * t.e
    return Shadow(pixel_e=e, pixel_n=n, ratio=ratio[rows, cols].astype(np.float32), area_m2=area,
                  centroid_e=float(e.mean()), centroid_n=float(n.mean()))


# --- geometry along the sun ----------------------------------------------------------------

@dataclass(frozen=True)
class SunFrame:
    """The shadow direction u (unit, east and north, from a tree toward its shadow) and v across it
    (u turned a quarter anticlockwise)."""
    ux: float
    uy: float

    @property
    def u(self) -> tuple[float, float]:
        return self.ux, self.uy

    @property
    def v(self) -> tuple[float, float]:
        return -self.uy, self.ux

    def along(self, de, dn):
        """An offset's component along the shadow direction (away from the sun)."""
        return de * self.ux + dn * self.uy

    def across(self, de, dn):
        """An offset's component across the shadow direction."""
        vx, vy = self.v
        return de * vx + dn * vy

    def azimuth_deg(self) -> float:
        return _azimuth(self.ux, self.uy)


@dataclass
class Measure:
    end_e: float      # the sun-side end of the shadow, on its axis
    end_n: float
    length_m: float   # along the shadow direction
    width_m: float    # area / length
    elongation: float
    axis_off_deg: float
    min_ratio: float
    centroid_e: float = 0.0
    centroid_n: float = 0.0

    @property
    def tip_m(self) -> float:
        """The shadow tip's distance from its stem: its length plus stem_offset."""
        return self.length_m + stem_offset(self)


def measure(s: Shadow, sun: SunFrame) -> Measure:
    """The shadow along the shadow direction."""
    ux, uy = sun.u
    vx, vy = sun.v
    de, dn = s.pixel_e - s.centroid_e, s.pixel_n - s.centroid_n
    along = sun.along(de, dn)
    across = sun.across(de, dn)
    # the sun-side end: the first END_SLICE_M slice across the shadow (from the sun) that is dark on
    # the whole, so a lighter crown tuft or a faint fringe there does not count
    start = float(along.min())
    slot = ((along - start) / END_SLICE_M).astype(np.int64)
    order = np.argsort(slot, kind="stable")
    slots, starts = np.unique(slot[order], return_index=True)
    lo = None
    darkest_slot, darkest = int(slots[0]), np.inf
    for k, sl in enumerate(slots):
        idx = order[starts[k]:(starts[k + 1] if k + 1 < len(starts) else len(order))]
        med = float(np.median(s.ratio[idx]))
        if med < darkest:
            darkest_slot, darkest = int(sl), med
        if len(idx) >= 3 and med < END_RATIO:
            lo = start + int(sl) * END_SLICE_M
            break
    if lo is None:
        lo = start + darkest_slot * END_SLICE_M
    core = s.ratio < END_RATIO
    if core.sum() < 3:
        core = np.ones_like(core)
    hi = float(np.percentile(along, 98))
    across_mid = float(np.median(across[core]))
    length = max(float(hi - lo), MIN_MEASURED_LENGTH_M)
    end_e = s.centroid_e + lo * ux + across_mid * vx
    end_n = s.centroid_n + lo * uy + across_mid * vy
    width = s.area_m2 / length
    cov = np.cov(np.vstack([s.pixel_e, s.pixel_n])) if len(s.pixel_e) > 2 else np.eye(2)
    w, v = np.linalg.eigh(cov)
    elong = math.sqrt(max(w[1], 1e-9) / max(w[0], 1e-9))
    major = (v[0, 1], v[1, 1])
    off = math.degrees(math.acos(min(1.0, abs(major[0] * ux + major[1] * uy))))
    return Measure(float(end_e), float(end_n), length, float(width), elong, off, float(s.ratio.min()),
                   s.centroid_e, s.centroid_n)


def _unit(azimuth_deg: float) -> tuple[float, float]:
    """Compass azimuth (0 north, 90 east) to a unit vector (east, north)."""
    a = math.radians(azimuth_deg)
    return math.sin(a), math.cos(a)


def _azimuth(dx: float, dy: float) -> float:
    return math.degrees(math.atan2(dx, dy)) % 360.0


def shadow_direction(shadows: list[Shadow], stems: list[dict]) -> tuple[SunFrame, int]:
    """(the shadow direction, stems it was read from): the median angle of lidar stem -> centroid of
    the biggest shadow reaching within MATCH_M of it; the default direction with fewer than
    MIN_MATCHES such stems."""
    if not shadows:
        return SunFrame(*_unit(DEFAULT_SHADOW_AZIMUTH_DEG)), 0
    centroid_e = np.array([s.centroid_e for s in shadows])
    centroid_n = np.array([s.centroid_n for s in shadows])
    angles = []
    for st in stems:
        h = st["heightM"]
        if h < DIRECTION_MIN_HEIGHT_M:
            continue
        d = np.hypot(centroid_e - st["x"], centroid_n - st["y"])
        near = np.nonzero((d >= DIRECTION_MIN_DIST_M) & (d <= DIRECTION_REACH_PER_HEIGHT * h + DIRECTION_REACH_M))[0]
        best, best_area = None, 0.0
        for i in near:
            s = shadows[i]
            if np.min(np.hypot(s.pixel_e - st["x"], s.pixel_n - st["y"])) > MATCH_M:
                continue
            if s.area_m2 > best_area:
                best, best_area = i, s.area_m2
        if best is not None:
            angles.append(_azimuth(centroid_e[best] - st["x"], centroid_n[best] - st["y"]))
    if len(angles) < MIN_MATCHES:
        return SunFrame(*_unit(DEFAULT_SHADOW_AZIMUTH_DEG)), len(angles)
    # median of the deviations from the circular mean (angles near 0/360 average right)
    a = np.radians(np.array(angles))
    mean = math.atan2(np.sin(a).mean(), np.cos(a).mean())
    dev = (a - mean + math.pi) % (2 * math.pi) - math.pi
    med = mean + float(np.median(dev))
    return SunFrame(math.sin(med), math.cos(med)), len(angles)


# --- calibration -------------------------------------------------------------------------------

class Match(NamedTuple):
    """A lidar stem (index into the stems) and its own shadow (index into the shadows and measures)."""
    stem: int
    shadow: int
    sunward_m: float   # how far the stem stands sun-side of the shadow's end
    across_m: float


def _robust_line(x: np.ndarray, y: np.ndarray, max_slope: float) -> tuple[float, float]:
    """Least-squares y = a + b x, refitted once without the points over 3 MADs off the line,
    the slope kept within [0, max_slope]."""
    def fit(xs, ys):
        if len(xs) < 2 or float(np.var(xs)) < 1e-9:
            return float(np.mean(ys)), 0.0
        b = float(np.cov(xs, ys, bias=True)[0, 1] / np.var(xs))
        b = min(max(b, 0.0), max_slope)
        return float(np.mean(ys) - b * np.mean(xs)), b

    a, b = fit(x, y)
    res = y - (a + b * x)
    mad = float(np.median(np.abs(res - np.median(res)))) or 1e-9
    keep = np.abs(res - np.median(res)) <= 3 * 1.4826 * mad
    if keep.sum() >= max(3, len(x) // 2):
        a, b = fit(x[keep], y[keep])
    return a, b


def stem_offset(m: Measure) -> float:
    """How far sun-side of where its shadow ends a stem stands: OFFSET_M (a young tree's crown
    tuft), or OFFSET_PER_WIDTH x the shadow's width when that is more (a wide crown hides the foot of
    its own shadow). A rule, not calibrated: the lidar-matched trees are the bigger ones, with
    higher crown bases (about 2 m on Omberg), and the young trees the photo finds are not."""
    return max(OFFSET_M, OFFSET_PER_WIDTH * m.width_m)


@dataclass
class Calibration:
    """How one photo's shadows turn into stems, from the lidar stems that cast one in it.

    - sun factor: shadow tip distance from the stem (Measure.tip_m) per metre of lidar height, the
      median over the matched stems;
    - size: height and crown radius as the matched lidar trees have them for that shadow tip
      distance and width: a least-squares line over the matched stems (robust, slope at most the
      proportional one). A thin young crown casts a lighter, shorter-looking shadow than a full one
      of its height (on Omberg the young trees' dark shadows are about half as long as those of the
      lidar trees in the same rows), so the proportional reading alone sizes them too small. With
      fewer than `min-fit` matches the proportional reading is used.
    """
    sun_factor: float
    radius_per_width: float
    height_line: tuple[float, float] | None
    radius_line: tuple[float, float] | None
    matched: int
    fallback: bool
    offset_median: float | None = None

    def place(self, m: Measure, sun: SunFrame) -> tuple[float, float]:
        d = stem_offset(m)
        return m.end_e - d * sun.ux, m.end_n - d * sun.uy

    def physical_height(self, m: Measure) -> float:
        return m.tip_m / self.sun_factor

    def height(self, m: Measure) -> float:
        if self.height_line is None:
            return self.physical_height(m)
        a, b = self.height_line
        return a + b * m.tip_m

    def radius(self, m: Measure) -> float:
        if self.radius_line is None:
            return self.radius_per_width * m.width_m
        a, b = self.radius_line
        return a + b * m.width_m

    def doc(self) -> dict:
        return {
            "matched": self.matched, "fallback": self.fallback,
            "sunFactor": round(self.sun_factor, 3), "radiusPerWidth": round(self.radius_per_width, 3),
            "heightLine": None if self.height_line is None else [round(v, 3) for v in self.height_line],
            "radiusLine": None if self.radius_line is None else [round(v, 3) for v in self.radius_line],
            "matchedOffsetM": None if self.offset_median is None else round(self.offset_median, 2),
        }


def calibrate(matches: list[Match], stems: list[dict], measures: list[Measure]) -> Calibration:
    """From the matched lidar stems; the defaults when there are fewer than MIN_MATCHES."""
    if len(matches) < MIN_MATCHES:
        return Calibration(DEFAULT_SUN_FACTOR, DEFAULT_RADIUS_PER_WIDTH, None, None, len(matches), True)
    height = np.array([stems[m.stem]["heightM"] for m in matches])
    radius = np.array([stems[m.stem]["crownRadiusM"] for m in matches])
    width = np.array([measures[m.shadow].width_m for m in matches])
    tip = np.array([measures[m.shadow].tip_m for m in matches])
    sun_factor = float(np.median(tip / height))
    radius_per_width = float(np.median(radius / width))
    height_line = radius_line = None
    if len(matches) >= MIN_FIT_MATCHES:
        height_line = _robust_line(tip, height, 1.0 / max(sun_factor, 1e-6))
        radius_line = _robust_line(width, radius, max(radius_per_width, 1e-6))
    return Calibration(sun_factor, radius_per_width, height_line, radius_line, len(matches), False,
                       float(np.median([m.sunward_m for m in matches])))


def match_stems(stems: list[dict], measures: list[Measure], shadows: list[Shadow], sun: SunFrame) -> list[Match]:
    """Each lidar stem with its own shadow: the biggest shadow whose sun-side end is within
    MATCH_M of it, with the stem sun-side of that end (at most MATCH_BEHIND_END_M behind it) and not
    far off its axis."""
    if not measures:
        return []
    ends = np.array([(m.end_e, m.end_n) for m in measures])
    matches = []
    for j, st in enumerate(stems):
        dist = np.hypot(ends[:, 0] - st["x"], ends[:, 1] - st["y"])
        best = None
        for i in np.nonzero(dist <= MATCH_M)[0]:
            m = measures[i]
            de, dn = st["x"] - m.end_e, st["y"] - m.end_n
            sunward, across = -sun.along(de, dn), sun.across(de, dn)
            if not (-MATCH_BEHIND_END_M <= sunward <= MATCH_M and abs(across) <= MATCH_ACROSS_M):
                continue
            if best is None or shadows[i].area_m2 > shadows[best.shadow].area_m2:
                best = Match(j, int(i), sunward, across)
        if best is not None:
            matches.append(best)
    return matches


def _matched_report(matches: list[Match], stems: list[dict], measures: list[Measure]) -> list[dict]:
    """Each matched lidar stem with its height and crown read back from its own shadow, that stem left
    out of the calibration."""
    out = []
    for k, match in enumerate(matches):
        left_out = calibrate(matches[:k] + matches[k + 1:], stems, measures)
        st, m = stems[match.stem], measures[match.shadow]
        out.append({
            "x": st["x"], "y": st["y"], "heightM": st["heightM"], "crownRadiusM": st["crownRadiusM"],
            "heightFromShadowM": round(left_out.height(m), 2),
            "crownRadiusFromShadowM": round(left_out.radius(m), 2),
            "shadowLengthM": round(m.length_m, 2), "shadowWidthM": round(m.width_m, 2),
            "offsetM": round(match.sunward_m, 2),
        })
    return out


# --- proposals ---------------------------------------------------------------------------------

@dataclass
class LidarStems:
    """The lidar stems as columns, for the 'no lidar tree's' rules."""
    x: np.ndarray
    y: np.ndarray
    height: np.ndarray
    radius: np.ndarray

    @classmethod
    def of(cls, stems: list[dict]) -> "LidarStems":
        def column(key):
            return np.array([s[key] for s in stems]) if stems else np.zeros(0)
        return cls(column("x"), column("y"), column("heightM"), column("crownRadiusM"))

    def _around(self, x: float, y: float) -> np.ndarray:
        return (np.abs(self.x - x) < LIDAR_SEARCH_M) & (np.abs(self.y - y) < LIDAR_SEARCH_M)

    def any_within(self, x: float, y: float, dist_m: float) -> bool:
        near = self._around(x, y)
        return bool(np.any(np.hypot(self.x[near] - x, self.y[near] - y) < dist_m))

    def shades(self, e: float, n: float, x: float, y: float, sun: SunFrame, sun_factor: float) -> bool:
        """Whether (e, n) lies in the own shadow of a lidar tree near (x, y): along the shadow ray from
        its stem, within its length, and within its crown radius across."""
        near = self._around(x, y)
        de, dn = e - self.x[near], n - self.y[near]
        along, across = sun.along(de, dn), sun.across(de, dn)
        return bool(np.any((along > 0) & (along < sun_factor * self.height[near] + LIDAR_SHADOW_MARGIN_M)
                           & (np.abs(across) < self.radius[near] + LIDAR_SHADOW_MARGIN_M)))


@dataclass
class _Screen:
    """The rules a shadow passes to be a photo stem."""
    cal: Calibration
    owned: set[int]   # shadows matched to a lidar stem
    lidar: LidarStems
    sun: SunFrame
    ground: object    # the open ground, prepared

    def why_not(self, i: int, s: Shadow, m: Measure, x: float, y: float) -> str | None:
        """Why shadow i is no photo stem at (x, y), None when it is one."""
        if i in self.owned:
            return "lidar stem's own"
        if s.area_m2 > MAX_SHADOW_AREA_M2:
            return "too big"
        if m.elongation < MIN_ELONGATION or (m.elongation >= AXIS_CHECK_ELONGATION and m.axis_off_deg > MAX_AXIS_OFF_DEG):
            return "wrong shape"
        if m.length_m < MIN_SHADOW_LENGTH_M:
            return "too short"
        h = self.cal.height(m)
        if h < MIN_HEIGHT_M or h > MAX_HEIGHT_M:
            return "height"
        if len(self.lidar.x):
            if self.lidar.any_within(x, y, DEDUPE_M):
                return "near a lidar stem"
            if self.lidar.shades(s.centroid_e, s.centroid_n, x, y, self.sun, self.cal.sun_factor):
                return "in a lidar tree's shadow"
        if not self.ground.contains(Point(x, y)):
            return "off open ground"
        return None


@dataclass
class Candidate:
    """A shadow that passed the screen, as the stem it stands for (rounded as proposed)."""
    x: float
    y: float
    height_m: float
    crown_radius_m: float
    measure: Measure
    area_m2: float

    def doc(self, kind: int, ground_m: float | None) -> dict:
        return {"id": stem_id(self.x, self.y), "x": self.x, "y": self.y,
                "heightM": self.height_m, "crownRadiusM": self.crown_radius_m,
                **({"groundM": ground_m} if ground_m is not None else {}),
                "kind": int(kind), "source": SOURCE,
                "shadowLengthM": round(self.measure.length_m, 2), "shadowAreaM2": round(self.area_m2, 2)}


def _candidates(shadows: list[Shadow], measures: list[Measure], screen: _Screen,
                rejected: list[tuple[float, float, str]]) -> list[Candidate]:
    """Every shadow that passes the screen as a stem, sized by the calibration."""
    cal, out = screen.cal, []
    for i, (s, m) in enumerate(zip(shadows, measures)):
        x, y = cal.place(m, screen.sun)
        why = screen.why_not(i, s, m, x, y)
        if why:
            rejected.append((x, y, why))
            continue
        h = cal.height(m)
        r = min(max(cal.radius(m), MIN_CROWN_RADIUS_M), CROWN_CAP_PER_HEIGHT * h + CROWN_CAP_M)
        out.append(Candidate(round(x, 2), round(y, 2), round(h, 1), round(r, 1), m, s.area_m2))
    return out


def _same_tree(p: Candidate, k: Candidate, sun: SunFrame) -> bool:
    """Whether candidate p's shadow lies on bigger candidate k's tree: from k's stem to its shadow's tip."""
    if math.hypot(p.x - k.x, p.y - k.y) < DEDUPE_M / 2:
        return True
    mk, mp = k.measure, p.measure
    de, dn = mp.centroid_e - mk.end_e, mp.centroid_n - mk.end_n
    along, across = sun.along(de, dn), sun.across(de, dn)
    reach = stem_offset(mk) + PIECE_REACH_M
    return -reach <= along <= mk.length_m and abs(across) <= max(PIECE_ACROSS_MIN_M, mk.width_m / 2 + PIECE_ACROSS_MARGIN_M)


def _drop_pieces(candidates: list[Candidate], sun: SunFrame, rejected: list[tuple[float, float, str]]) -> list[Candidate]:
    """Pieces of one tree (a dark crown tuft at the sun-side end of its shadow, a shadow broken in
    two): a smaller shadow lying on a bigger one's tree, from its stem to its shadow's tip, goes."""
    kept: list[Candidate] = []
    for p in sorted(candidates, key=lambda c: (-c.area_m2, c.x, c.y)):
        if any(_same_tree(p, k, sun) for k in kept):
            rejected.append((p.x, p.y, "part of another"))
            continue
        kept.append(p)
    return kept


def _proposals(kept: list[Candidate], leaf_off: Path | None, dem: Path | None, known: set[str] | None) -> list[dict]:
    """The kept candidates as proposals (kind from the leaf-off photo, ground from the DEM), north to
    south, less the known ids."""
    kinds = leaf_off_kinds(leaf_off, kept) if leaf_off else [KIND_UNKNOWN] * len(kept)
    grounds = ground_heights(dem, kept) if dem else [None] * len(kept)
    out = [c.doc(kind, g) for c, kind, g in zip(kept, kinds, grounds)]
    if known:
        out = [p for p in out if p["id"] not in known]
    out.sort(key=lambda p: (-p["y"], p["x"]))
    return out


def run(summer: Path, leaf_off: Path | None, stems: list[dict], features: list[dict],
        known: set[str] | None = None, debug: dict | None = None, dem: Path | None = None) -> dict:
    ground = ground_of(features)
    if ground.is_empty:
        raise PhotoStemsError("the course has no open ground (rough, semi rough, deep rough, fairway)")
    shadows, info = find_shadows(summer, ground)
    sun, direction_matches = shadow_direction(shadows, stems)
    measures = [measure(s, sun) for s in shadows]

    matches = match_stems(stems, measures, shadows, sun)
    cal = calibrate(matches, stems, measures)

    rejected: list[tuple[float, float, str]] = []
    screen = _Screen(cal, {m.shadow for m in matches}, LidarStems.of(stems), sun, prep(ground))
    kept = _drop_pieces(_candidates(shadows, measures, screen, rejected), sun, rejected)

    calibration = {"shadowAzimuthDeg": round(sun.azimuth_deg(), 1), "directionFrom": direction_matches, **cal.doc(),
                   "shadows": len(shadows), "tiles": info.get("tiles", 0)}
    doc = {"format": FORMAT, "crs": stems_asset.CRS, "calibration": calibration,
           "matched": _matched_report(matches, stems, measures),
           "proposals": _proposals(kept, leaf_off, dem, known)}
    if debug is not None:
        debug.update(rejected=rejected, shadows=shadows, measures=measures, u=sun.u)
    return doc


# --- kind from the leaf-off photo ----------------------------------------------------------

def leaf_off_kinds(photo: Path, candidates: list[Candidate]) -> list[int]:
    with rasterio.open(photo) as ds:
        return [_kind_at(ds, c.x, c.y, c.crown_radius_m) for c in candidates]


def _kind_at(ds, x: float, y: float, radius: float) -> int:
    """The leaf-off photo round a proposal against the ground round it: a crown at least
    CONIFER_MIN_AREA_M2 darker than CONIFER_MAX_RATIO of the ground and green (the trees-stems
    conifer score of its greenness, and greener than the ground) is a conifer; anything darker than
    BARE_MAX_RATIO (bare branches and twigs, their thin shadow) a broadleaf; nothing to see, unknown."""
    reach = radius + KIND_REACH_M
    ring = max(KIND_RING_MIN_M, KIND_RING_PER_RADIUS * radius)
    win = from_bounds(x - ring, y - ring, x + ring, y + ring, ds.transform).round_offsets().round_lengths()
    rgb = ds.read([1, 2, 3], window=win, boundless=True, fill_value=0).astype(np.float32)
    t = ds.window_transform(win)
    hh, ww = rgb.shape[1:]
    cols = t.c + (np.arange(ww) + 0.5) * t.a
    rows = t.f + (np.arange(hh) + 0.5) * t.e
    dist = np.hypot(cols[None, :] - x, rows[:, None] - y)
    total = rgb.sum(axis=0)
    valid = total > 0
    lum = total / 3.0
    green = (rgb[1] - rgb[0]) / np.maximum(total, 1.0)
    inner = valid & (dist <= reach)
    outer = valid & (dist > reach + KIND_GAP_M) & (dist <= ring)
    if inner.sum() < 10 or outer.sum() < 10:
        return KIND_UNKNOWN
    cell = abs(t.a) * abs(t.e)
    ratio = lum / max(float(np.median(lum[outer])), 1.0)
    ground_green = float(np.median(green[outer]))
    core = inner & (ratio < CONIFER_MAX_RATIO)
    if core.sum() * cell >= CONIFER_MIN_AREA_M2:
        crown_green = float(np.median(green[core]))
        if crown_green - ground_green >= CONIFER_MIN_GREENNESS and float(conifer_score(crown_green)) >= CONIFER_THRESHOLD:
            return KIND_CONIFER
    if (inner & (ratio < BARE_MAX_RATIO)).sum() * cell >= BARE_MIN_AREA_M2:
        return KIND_BROADLEAF
    return KIND_UNKNOWN


def ground_heights(dem: Path, candidates: list[Candidate]) -> list[float | None]:
    """The DEM under each candidate (2 decimals), None off it or on nodata."""
    with rasterio.open(dem) as ds:
        nodata = ds.nodata
        out = []
        for (v,) in ds.sample([(c.x, c.y) for c in candidates], indexes=[1]):
            ok = np.isfinite(v) and (nodata is None or v != nodata)
            out.append(round(float(v), 2) if ok else None)
    return out


# --- files -------------------------------------------------------------------------------------

def read_stems(path: Path) -> list[dict]:
    """The lidar stems of a tree-stems asset (x, y, heightM, crownRadiusM; a crown radius of 1 m when
    the asset has none)."""
    try:
        rows = stems_asset.read_rows(path)
    except stems_asset.StemsAssetError as exc:
        raise PhotoStemsError(str(exc)) from None
    return [{"x": float(d["x"]), "y": float(d["y"]), "heightM": float(d["heightM"]),
             "crownRadiusM": float(d.get("crownRadiusM", 1.0))} for d in rows]


def read_known(path: Path | None) -> set[str]:
    """Ids to leave out: a JSON list of ids, or an object with `trees`/`skipped` rows or ids."""
    if path is None or not path.is_file():
        return set()
    doc = json.loads(path.read_text(encoding="utf-8"))
    ids: set[str] = set()

    def take(items):
        for it in items or []:
            if isinstance(it, str):
                ids.add(it)
            elif isinstance(it, dict) and isinstance(it.get("id"), str):
                ids.add(it["id"])
            elif isinstance(it, list) and doc.get("fields") and "id" in doc["fields"]:
                ids.add(it[doc["fields"].index("id")])

    if isinstance(doc, list):
        take(doc)
    else:
        take(doc.get("trees"))
        take(doc.get("skipped"))
        take(doc.get("ids"))
    return ids


def cmd_photo_stems(summer: Path, leaf_off: Path | None, stems_path: Path, features_path: Path, out: Path,
                    known_path: Path | None = None, dem: Path | None = None, lidar_size_factor: float = 1.0) -> dict:
    """`lidar_size_factor`: the course's trees.lidarSizeFactor, which the trees export scales every lidar stem
    by (gspro.py trees --size-factor). The lidar stems are calibrated against at that size, so the photo stems
    come out as big as the lidar trees planted next to them."""
    if not lidar_size_factor > 0:
        raise PhotoStemsError(f"the lidar size factor must be above 0, not {lidar_size_factor}")
    for p in (summer, stems_path, features_path):
        if not p.is_file():
            raise PhotoStemsError(f"no such file: {p}")
    if leaf_off is not None and not leaf_off.is_file():
        raise PhotoStemsError(f"no such file: {leaf_off}")
    features = json.loads(features_path.read_text(encoding="utf-8"))
    if isinstance(features, dict):
        features = features.get("features") or []
    if dem is not None and not dem.is_file():
        raise PhotoStemsError(f"no such file: {dem}")
    stems = [dict(s, heightM=s["heightM"] * lidar_size_factor, crownRadiusM=s["crownRadiusM"] * lidar_size_factor)
             for s in read_stems(stems_path)] if lidar_size_factor != 1.0 else read_stems(stems_path)
    doc = run(summer, leaf_off, stems, features, read_known(known_path), dem=dem)
    doc["calibration"]["lidarSizeFactor"] = lidar_size_factor
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(doc, indent=1) + "\n", encoding="utf-8")
    c = doc["calibration"]
    print(f"Wrote {out}")
    print(f"  {len(doc['proposals'])} photo stem(s) proposed from {c['shadows']} shadow(s) on open ground; "
          f"{c['matched']} lidar stem(s) matched their shadow"
          + (" (too few: default calibration)" if c["fallback"] else "")
          + f"; shadow azimuth {c['shadowAzimuthDeg']:g} deg, sun factor {c['sunFactor']:g}")
    return doc
