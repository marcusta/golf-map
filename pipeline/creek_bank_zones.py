#!/usr/bin/env python3
"""Creek-bank vegetation zones: tall, uneven grass on the banks of the creeks a
builder marked, from the water's edge up to the top of the bank, and in clumps
out into the water.

A creek is marked by its `bankVeg` attribute (shared/features/creek-vegetation.ts):
`default` = the `creek_bank` zone type's Default mix, anything else one of its
variants (the palettes). `bankVegCover` (0..1, default 0.5) is the share of the
water surface the grass covers; `bankVegMaxM` (default 4.5) caps how far up the
bank it reaches. A `water` polygon (a dug pond or channel) is planted the same
way when it is marked; "creek" below means either.

Per marked creek, on a 0.25 m grid over the creek and its banks (the Unity
surface map and the terrain's edited DEM, both 0.5 m, resampled):

  water  the creek polygon, plus water-surface cells (OPCD Water meshes) within
         1 m of it.
  bank   the ground next to the water that rises at SLOPE_DEG or more and is
         connected to the water through such ground: walking out from the
         water, the bank ends where the ground first flattens (the top of the
         bank), at most bankVegMaxM out; always at least MIN_BANK_M.
  top    weight 1 on the bank, fading to 0 over FADE_M beyond its top; the fade
         is shifted by up to TOP_NOISE_M of smooth noise so the edge is ragged,
         dipping below the top in places and reaching past it in others.
  water  clumps: a score that is highest at the shore and lowest mid-stream
         (distance to the shore over the local half-width), plus smooth noise;
         the cells scoring above the threshold that makes the covered share
         equal bankVegCover are grass. So the grass grows in from both banks
         with a ragged edge and some clumps further out, and a winding strip of
         open water usually stays down the middle. Specks under MIN_CLUMP_M2
         are dropped.
  wet    when the course's `creek_bank` type has a `<palette>_wet` variant, the
         weight is split: the water and the lower bank (bankVegWetM, default WET_M, from the water,
         ending over WET_RAMP_M, shifted by WET_NOISE_M of noise) go to the wet
         mix (cattails, reeds), the rest of the bank to the palette's own mix
         (plainer grasses). Items both mixes bind (the base grass) run through
         the split without a seam: an item's channel is the sum of its slots.
  section a hand-drawn `creek_bank` vegetation zone marks a stretch: the banks of
         any creek or water inside it get its variant as the palette (it need
         not be marked for that), blending into the creek's own over
         SECTION_BLEND_M with a ragged edge; later sections sit on top. The
         zone itself is not planted (gspro.py cmd_zones skips it).
  never  tees, greens, fairways, semis, bunkers, paths and bridges (the app's
         `path` features: OPCD's path meshes are not in the surface map; and
         "other" meshes), other water, buildings and roads, each with a
         clearance and a ramp. Paths keep PATH_CLEARANCE_M: grass cards are
         ~1 m wide and lean, so a zone that stops at the path edge still
         hangs over it.

The weight field is written as nested contour bands (one `vegetation_zone` per
band polygon, zoneType `creek_bank`, zoneVariant the palette) for the server's
generated-feature import under the source `creek-bank`, so a re-run replaces
exactly what the last run made. scripts/grass-zones.ts runs this after
grass_zones.py, so these zones sit above the tall rough and claim their weight
first; grass_zones.py in turn does not keep its water clearance along the
marked creeks, so the tall rough runs up to them and fills in where the bank
grass fades out above the top of the bank.
"""

from __future__ import annotations

import argparse
import json
import sys
import zlib
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from shapely import make_valid
from shapely.geometry import shape
from shapely.geometry.base import BaseGeometry

import gspro
import vegetation_rules
from golfpipe.detect_common import _each_polygon
from grass_zones import _union, load_buildings, load_roads, load_surfaces_map, surface_codes

# The rules (bank widths, slope, cover, wet edge, clearances, ...) live in
# pipeline/vegetation-rules/creek-bank.json, each with its unit and what it does;
# a course changes them in docs/gspro/<course>/vegetation-rules.json (vegetation_rules.py).
# The palette keys (bankVeg, 'default', '<palette>_wet') are a contract with the zone types
# and shared/features/creek-vegetation.ts: they stay here.
R = vegetation_rules.load("creek-bank")

ZONE_TYPE = R["zone-type"]
DEFAULT_SOURCE = "creek-bank"
BANK_VEG_ATTRIBUTE = "bankVeg"
BANK_VEG_DEFAULT = "default"
BANK_VEG_COVER_ATTRIBUTE = "bankVegCover"
BANK_VEG_MAX_ATTRIBUTE = "bankVegMaxM"
BANK_VEG_WET_ATTRIBUTE = "bankVegWetM"
PLANTABLE_TYPES = R["plantable-types"]   # BANK_VEG_FEATURE_TYPES in the shared module
# OPCD water surface this close to a creek's outline is its water; beyond OWN_WATER_REACH_M of
# that it is other water.
WATER_SURFACE_REACH_M = R["water-surface-reach"]
OWN_WATER_REACH_M = R["own-water-reach"]
# The tall rough's water clearance is lifted on the marked creeks + this (marked_water_mask).
MARKED_WATER_MARGIN_M = R["marked-water-margin"]
DEFAULT_COVER = R["cover"]
DEFAULT_MAX_M = R["max-bank"]

CELL_M = 0.25
SLOPE_DEG = R["slope"]        # the bank ends where the ground flattens below this
SLOPE_SMOOTH_M = R["slope-smooth"]    # DEM smoothing before the slope (lidar speckle)
MIN_BANK_M = R["min-bank"]        # grass at least this far from the water, flat banks too
FADE_M = R["fade"]            # weight 1 -> 0 beyond the top of the bank
TOP_NOISE_M = R["top-noise"]       # the fade shifted by up to this much, in and out
TOP_NOISE_FEATURE_M = R["top-noise-size"]
WATER_NOISE_FEATURE_M = R["water-noise-size"]
WATER_NOISE = R["water-noise"]       # noise against the shore -> mid-stream score (0..1)
HALF_WIDTH_WINDOW_M = R["half-width-window"] # the local half-width is the deepest water within this window
MIN_CLUMP_M2 = R["min-clump"]
BAND_LEVELS = R["band-levels"]   # w >= level; the top band has weight 1
BAND_FEATHER_M = R["band-feather"]
MIN_AREA_M2 = R["min-area"]
SIMPLIFY_M = R["simplify"]
BUILDING_MARGIN_M = R["building-margin"]
ROAD_MARGIN_M = R["road-margin"]
# Paths (the app's `path` features; not in the surface map): nothing within this, full weight
# PATH_RAMP_M further out. A leaning 1 m card must not hang over the path.
PATH_CLEARANCE_M = R["path-clearance"]
PATH_RAMP_M = R["path-ramp"]

# Surface map codes (unity/Editor/GolfMap/GolfMapSurfaces.cs): (codes, clearance, ramp) in metres.
S_WATER, S_OTHER = 8, 10
# e.g. ((6, 5), 2.0, 2.0): tee, green; 'other' = OPCD meshes that are none of the course surfaces
# (paths are not here: see PATH_CLEARANCE_M)
CLEARANCES = tuple((surface_codes(c["surfaces"]), c["clear"], c["ramp"]) for c in R["clearances"])
OTHER_WATER = (R["other-water-clear"], R["other-water-ramp"])
BLOCK_RAMP_M = R["block-ramp"]
WET_SUFFIX = "_wet"
WET_M = R["wet"]             # the wet mix up to this far from the water (default; a creek's bankVegWetM) ...
WET_RAMP_M = R["wet-ramp"]        # ... handing over to the palette's own mix over this
WET_NOISE_M = R["wet-noise"]       # (ramp and noise shrink with a shorter reach, so a narrow edge stays an edge)
WET_NOISE_FEATURE_M = R["wet-noise-size"]
SECTION_BLEND_M = R["section-blend"]   # a section's palette hands over to the next over this, along the creek ...
SECTION_NOISE_M = R["section-noise"]   # ... shifted by this much noise, so the change is not a straight cut
SECTION_NOISE_FEATURE_M = R["section-noise-size"]


@dataclass
class Creek:
    id: str
    geometry: BaseGeometry
    palette: str | None   # 'default' or a creek_bank variant key; None = planted only inside sections
    cover: float
    max_m: float
    variants: frozenset = frozenset()   # the course's creek_bank variant keys (for `<palette>_wet`)
    wet_m: float = WET_M                  # how far up the bank the wet mix reaches (bankVegWetM)


@dataclass
class Section:
    """A hand-drawn creek_bank zone: the creek banks inside it get `palette` (its
    zoneVariant; '' = the Default mix, 'default' here), whatever the creek says."""
    geometry: BaseGeometry
    palette: str


def palette_variant(palette: str) -> str:
    return "" if palette == BANK_VEG_DEFAULT else palette


def wet_variant(palette: str, variants) -> str | None:
    wet = palette + WET_SUFFIX
    return wet if wet in variants else None


# --- the weight field ---------------------------------------------------------

def _dist(mask: np.ndarray, cell: float) -> np.ndarray:
    """Metres from every cell to the nearest True cell (0 on it)."""
    from scipy.ndimage import distance_transform_edt
    if not mask.any():
        return np.full(mask.shape, np.inf, dtype=np.float32)
    return (distance_transform_edt(~mask) * cell).astype(np.float32)


def _ramp(d: np.ndarray, start: float, width: float) -> np.ndarray:
    return np.clip((d - start) / max(width, 1e-6), 0.0, 1.0).astype(np.float32)


def smooth_noise(shape_: tuple[int, int], cell: float, feature_m: float, seed: int) -> np.ndarray:
    """Smooth noise in [-1, 1] with blobs about `feature_m` across (two octaves)."""
    from scipy.ndimage import gaussian_filter
    rng = np.random.default_rng(seed)
    out = np.zeros(shape_, dtype=np.float32)
    for weight, size in ((0.75, feature_m), (0.25, feature_m / 3)):
        n = gaussian_filter(rng.standard_normal(shape_).astype(np.float32), sigma=max(size / cell / 2, 0.5), mode="reflect")
        out += weight * n / max(float(n.std()), 1e-6)
    return np.clip(out / 2.0, -1.0, 1.0)


def slope_deg(z: np.ndarray, cell: float, smooth_m: float = SLOPE_SMOOTH_M) -> np.ndarray:
    from scipy.ndimage import gaussian_filter
    zs = gaussian_filter(z.astype(np.float64), sigma=max(smooth_m / cell, 0.0)) if smooth_m > 0 else z
    gy, gx = np.gradient(zs, cell)
    return np.degrees(np.arctan(np.hypot(gx, gy))).astype(np.float32)


def bank_region(water: np.ndarray, z: np.ndarray, cell: float, max_m: float,
                slope_min: float = SLOPE_DEG, min_bank: float = MIN_BANK_M) -> np.ndarray:
    """Cells outside the water between its edge and the top of the bank: ground at
    `slope_min` or steeper connected to the water through such ground, within `max_m`;
    everything within `min_bank` of the water too."""
    from scipy.ndimage import binary_closing, binary_fill_holes, label
    d_out = _dist(water, cell)
    steep = (slope_deg(z, cell) >= slope_min) & (d_out <= max_m) & ~water
    labels, _ = label(steep | water, structure=np.ones((3, 3), dtype=bool))
    touching = np.unique(labels[water])
    bank = np.isin(labels, touching[touching > 0]) & ~water
    bank |= (d_out <= min_bank) & ~water
    # Lidar speckle: a flat cell or two inside a bank is not its top. Padded so the
    # closing does not eat the window's border.
    pad = 2
    closed = binary_closing(np.pad(bank | water, pad, mode="edge"), structure=np.ones((3, 3), dtype=bool), iterations=pad)
    bank = binary_fill_holes(closed[pad:-pad, pad:-pad]) & (d_out <= max_m)
    return bank & ~water


def water_clumps(water: np.ndarray, cell: float, cover: float, noise: np.ndarray,
                 min_clump: float = MIN_CLUMP_M2) -> np.ndarray:
    """The grass-covered water cells: `cover` of the water, growing in from the
    shore with a ragged edge (see the module doc)."""
    from scipy.ndimage import distance_transform_edt, label, maximum_filter
    n_water = int(water.sum())
    if n_water == 0 or cover <= 0:
        return np.zeros_like(water)
    if cover >= 1:
        return water.copy()
    d_in = distance_transform_edt(water) * cell
    half = maximum_filter(d_in, size=max(3, int(HALF_WIDTH_WINDOW_M / cell) | 1))
    t = np.clip(d_in / np.maximum(half, cell), 0.0, 1.0)
    score = np.where(water, (1.0 - t) + WATER_NOISE * noise, -np.inf)
    min_cells = max(1, int(round(min_clump / (cell * cell))))

    def covered(threshold: float) -> np.ndarray:
        m = score >= threshold
        labels, count = label(m, structure=np.ones((3, 3), dtype=bool))
        if count:
            sizes = np.bincount(labels.ravel())
            small = sizes < min_cells
            small[0] = False
            m &= ~small[labels]
        return m

    lo, hi = float(score[water].min()), float(score[water].max()) + 1e-6
    best = covered(np.quantile(score[water], 1.0 - cover))
    for _ in range(16):   # dropping specks lowers the share: settle the threshold
        mid = (lo + hi) / 2
        m = covered(mid)
        share = m.sum() / n_water
        if abs(share - cover) < abs(best.sum() / n_water - cover):
            best = m
        if share > cover:
            lo = mid
        else:
            hi = mid
    return best


# A rock slab standing in the water or on the bank (surface map S_SLAB, golfmap.cut_out with `rise`: Vreta hole
# 15's klippa): the bank grass keeps off the rock but for grass_zones' slab rule (a ragged fringe in over its edge and
# SLAB_PATCH_COVER patches), and a ragged ring of it grows round the rock in the water, SLAB_RING_M out (0 .. 2x by
# noise, never under SLAB_RING_MIN_M), so the rock stands in reeds and grass rather than in bare water (Marcus, 2026-10-15).
S_SLAB = 12
SLAB_RING_M = R["slab-ring"]
SLAB_RING_MIN_M = R["slab-ring-min"]     # never narrower: grass right up against the rock all round
SLAB_RING_NOISE_FEATURE_M = R["slab-ring-noise-size"]


def _round_rocks(w: np.ndarray, cls: np.ndarray, cell: float, seed: int) -> np.ndarray:
    slab = cls == S_SLAB
    if not slab.any():
        return w
    from grass_zones import slab_grass
    reach = np.maximum(SLAB_RING_MIN_M, SLAB_RING_M * (1.0 + smooth_noise(cls.shape, cell, SLAB_RING_NOISE_FEATURE_M, seed + 7)))
    ring = ~slab & (_dist(slab, cell) < reach)
    on_rock = slab_grass(cls, cell, seed)
    w = np.where(ring, np.maximum(w, 1.0), w)
    return np.where(slab, on_rock.astype(np.float32) if on_rock is not None else 0.0, w).astype(np.float32)


def creek_weight(water: np.ndarray, z: np.ndarray, cls: np.ndarray, blocked: np.ndarray | None,
                 other_water: np.ndarray | None, cell: float, cover: float, max_m: float, seed: int,
                 paths: np.ndarray | None = None) -> np.ndarray:
    """Bank grass weight 0..1 per cell (see the module doc). `cls`: surface map codes
    on the same grid; `blocked`: buildings and roads with their margins; `paths`: the
    path features themselves (PATH_CLEARANCE_M is applied here)."""
    bank = bank_region(water, z, cell, max_m)
    top_noise = smooth_noise(water.shape, cell, TOP_NOISE_FEATURE_M, seed)
    # Signed metres past the top of the bank (negative on the bank), shifted by the noise.
    past_top = _dist(bank | water, cell) - _dist(~(bank | water), cell)
    w = np.clip(1.0 - (past_top + TOP_NOISE_M * top_noise) / FADE_M, 0.0, 1.0).astype(np.float32)
    w[(_dist(water, cell) > max_m + FADE_M)] = 0.0
    clumps = water_clumps(water, cell, cover, smooth_noise(water.shape, cell, WATER_NOISE_FEATURE_M, seed + 1))
    w = np.where(water, clumps.astype(np.float32), w)
    w = _round_rocks(w, cls, cell, seed)
    for codes, clear, ramp in CLEARANCES:
        present = np.isin(cls, codes)
        if present.any():
            w *= _ramp(_dist(present, cell), clear, ramp)
    if other_water is not None and other_water.any():
        w *= _ramp(_dist(other_water, cell), *OTHER_WATER)
    if blocked is not None and blocked.any():
        w *= _ramp(_dist(blocked, cell), 0.0, BLOCK_RAMP_M)
    if paths is not None and paths.any():
        w *= _ramp(_dist(paths, cell), PATH_CLEARANCE_M, PATH_RAMP_M)
    return w


def wet_share(water: np.ndarray, cell: float, seed: int, wet_m: float = WET_M) -> np.ndarray:
    """0..1 per cell: how much of the weight goes to the wet mix (1 in the water and on
    the lower bank up to `wet_m` from it, 0 higher up; a ragged, mostly sharp hand-over,
    its ramp and noise scaled down with a reach shorter than the default)."""
    k = min(1.0, max(wet_m, 0.0) / WET_M)
    ramp = max(WET_RAMP_M * k, 2 * cell)
    noise = smooth_noise(water.shape, cell, WET_NOISE_FEATURE_M, seed)
    d = _dist(water, cell) + WET_NOISE_M * k * noise
    return np.where(water, 1.0, np.clip(1.0 - (d - wet_m) / ramp, 0.0, 1.0)).astype(np.float32)


def palette_shares(creek: Creek, sections: list[Section], raster, shape_: tuple[int, int], cell: float,
                   seed: int) -> list[tuple[str, np.ndarray]]:
    """[(palette, share 0..1 per cell)]: inside a section its palette (later sections on
    top), elsewhere the creek's own (nothing where the creek is not marked); the ends of
    a section blend over SECTION_BLEND_M with a ragged edge."""
    remaining = np.ones(shape_, dtype=np.float32)
    shares: dict[str, np.ndarray] = {}
    noise = smooth_noise(shape_, cell, SECTION_NOISE_FEATURE_M, seed) if sections else None
    for sec in reversed(sections):
        inside = raster([sec.geometry])
        if inside is None or not inside.any():
            continue
        signed = _dist(~inside, cell) - _dist(inside, cell)   # + inside, - outside, metres from the edge
        s = np.clip(0.5 + (signed + SECTION_NOISE_M * noise) / SECTION_BLEND_M, 0.0, 1.0) * remaining
        remaining = remaining - s
        shares[sec.palette] = shares.get(sec.palette, 0) + s
    if creek.palette:
        shares[creek.palette] = shares.get(creek.palette, 0) + remaining
    return [(p, a) for p, a in shares.items() if np.max(a) > 0]


def _bands(w: np.ndarray, transform, levels) -> list[tuple[float, BaseGeometry]]:
    from rasterio import features
    bands = []
    for i, level in enumerate(levels):
        m = w >= level
        polys = [shape(g) for g, v in features.shapes(m.astype(np.uint8), mask=m, transform=transform) if v == 1]
        parts = [p.simplify(SIMPLIFY_M) for p in _each_polygon(_union(polys)) if p.area >= MIN_AREA_M2]
        bands.append((1.0 if i == len(levels) - 1 else float(level), _union(parts)))
    return bands


# --- one creek on the course grids --------------------------------------------

def _seed(creek_id: str) -> int:
    return zlib.crc32(creek_id.encode("utf-8"))


def creek_bands(creek: Creek, cls_full: np.ndarray, z_full: np.ndarray, cell_full: float,
                west: float, north: float, others: list[BaseGeometry], blockers: list[BaseGeometry],
                cell: float = CELL_M, levels=BAND_LEVELS, paths: list[BaseGeometry] = (),
                sections: list[Section] = ()) -> tuple[list[tuple[str, list]], dict]:
    """The creek's weight field per zone variant as nested bands: [(variant, [(weight,
    geometry)] lowest first)] in EPSG:3006 (one slot, or the palette's and its wet
    variant's); plus stats. `cls_full`/`z_full`: the surface map and DEM (rows
    north to south, `cell_full` metres, (west, north) the corner of row 0 col 0)."""
    from rasterio import features
    from rasterio.transform import Affine
    from scipy.ndimage import zoom

    pad = creek.max_m + FADE_M + 4.0
    minx, miny, maxx, maxy = creek.geometry.bounds
    c0 = max(0, int(np.floor((minx - pad - west) / cell_full)))
    c1 = min(cls_full.shape[1], int(np.ceil((maxx + pad - west) / cell_full)))
    r0 = max(0, int(np.floor((north - (maxy + pad)) / cell_full)))
    r1 = min(cls_full.shape[0], int(np.ceil((north - (miny - pad)) / cell_full)))
    if c1 <= c0 or r1 <= r0:
        return [], {"waterM2": 0.0}
    k = cell_full / cell
    cls = zoom(cls_full[r0:r1, c0:c1], k, order=0)
    z = zoom(z_full[r0:r1, c0:c1].astype(np.float32), k, order=1)
    wwest, wnorth = west + c0 * cell_full, north - r0 * cell_full
    transform = Affine(cell, 0, wwest, 0, -cell, wnorth)

    def raster(geoms):
        geoms = [g for g in geoms if g is not None and not g.is_empty]
        return features.rasterize(geoms, out_shape=cls.shape, transform=transform).astype(bool) if geoms else None

    poly = raster([creek.geometry])
    if poly is None or not poly.any():
        return [], {"waterM2": 0.0}
    water = poly | ((cls == S_WATER) & (_dist(poly, cell) <= WATER_SURFACE_REACH_M))
    near = _dist(water, cell) <= OWN_WATER_REACH_M
    other = raster(others)
    other_water = ((cls == S_WATER) & ~near) | (other & ~poly if other is not None else False)
    w = creek_weight(water, z, cls, raster(blockers), other_water, cell, creek.cover, creek.max_m, _seed(creek.id),
                     paths=raster(paths))

    slots = []
    f = None
    for palette, share in palette_shares(creek, list(sections), raster, water.shape, cell, _seed(creek.id) + 3):
        wp = w * share
        wet = wet_variant(palette, creek.variants)
        if wet:
            f = wet_share(water, cell, _seed(creek.id) + 2, creek.wet_m) if f is None else f
            slots += [(palette_variant(palette), _bands(wp * (1.0 - f), transform, levels)), (wet, _bands(wp * f, transform, levels))]
        else:
            slots.append((palette_variant(palette), _bands(wp, transform, levels)))
    cell2 = cell * cell
    stats = {
        "waterM2": float(water.sum()) * cell2,
        "coverShare": float(((w > 0.5) & water).sum()) / max(1, int(water.sum())),
        "bankM2": float(((w > 0.5) & ~water).sum()) * cell2,
    }
    return slots, stats


# --- inputs -------------------------------------------------------------------

def load_paths(db_path: Path, course_ident: str) -> list[BaseGeometry]:
    """The course's `path` features (roads, cart paths, bridges) in EPSG:3006 metres."""
    conn = gspro._open_course_db(db_path)
    course = gspro._resolve_course(conn, course_ident)
    rows = conn.execute("SELECT geometry_json FROM course_features WHERE course_id = ? AND type = 'path'", (course["id"],)).fetchall()
    conn.close()
    out = []
    for r in rows:
        g = gspro._zone_geometry_m(json.loads(r["geometry_json"]))
        if g is not None and not g.is_empty:
            out.append(make_valid(g))
    return out


def load_sections(db_path: Path, course_ident: str) -> list[Section]:
    """The course's creek sections: hand-drawn (not generated) creek_bank zones, in stack order.
    Only those near a creek or water steer anything (gspro.creek_section_ids, the same
    reach as `near_sections` below); gspro.py rasterizes the rest as ordinary zones."""
    conn = gspro._open_course_db(db_path)
    course = gspro._resolve_course(conn, course_ident)
    rows = conn.execute(
        "SELECT geometry_json, attributes_json FROM course_features WHERE course_id = ? AND type = 'vegetation_zone' "
        "AND generated = 0 ORDER BY sort_order, id", (course["id"],)).fetchall()
    conn.close()
    out = []
    for r in rows:
        attrs = json.loads(r["attributes_json"]) if r["attributes_json"] else {}
        if attrs.get("zoneType") != ZONE_TYPE:
            continue
        g = gspro._zone_geometry_m(json.loads(r["geometry_json"]))
        if g is not None and not g.is_empty:
            out.append(Section(make_valid(g), str(attrs.get("zoneVariant") or "") or BANK_VEG_DEFAULT))
    return out


def planted(feature_type: str, marked: bool, in_section: bool) -> bool:
    """Whether a creek's or water's banks are planted: marked, or reaching into a
    section (an unmarked one is planted inside its sections only)."""
    return feature_type in PLANTABLE_TYPES and (marked or in_section)


def load_creeks(db_path: Path, course_ident: str, sections: list[Section] = ()) -> tuple[dict, list[Creek], list[BaseGeometry]]:
    """The course, its planted creeks (marked, or reaching into a section), and every
    other water / creek outline."""
    conn = gspro._open_course_db(db_path)
    course = dict(gspro._resolve_course(conn, course_ident))
    rows = conn.execute(
        "SELECT id, type, geometry_json, attributes_json FROM course_features "
        "WHERE course_id = ? AND type IN ('water_creek', 'water') ORDER BY id",
        (course["id"],),
    ).fetchall()
    types = conn.execute("SELECT variants_json FROM course_zone_types WHERE course_id = ? AND key = ?",
                         (course["id"], ZONE_TYPE)).fetchone()
    conn.close()
    variants = frozenset(v.get("key") for v in json.loads(types["variants_json"] or "[]")) if types else frozenset()
    creeks, others = [], []
    for r in rows:
        geom = gspro._zone_geometry_m(json.loads(r["geometry_json"]))
        if geom is None or geom.is_empty:
            continue
        geom = make_valid(geom)
        attrs = json.loads(r["attributes_json"]) if r["attributes_json"] else {}
        palette = attrs.get(BANK_VEG_ATTRIBUTE)
        marked = isinstance(palette, str) and palette != ""
        in_section = any(sec.geometry.intersects(geom) for sec in sections)
        if planted(r["type"], marked, in_section):
            cover = attrs.get(BANK_VEG_COVER_ATTRIBUTE, DEFAULT_COVER)
            max_m = attrs.get(BANK_VEG_MAX_ATTRIBUTE, DEFAULT_MAX_M)
            wet_m = attrs.get(BANK_VEG_WET_ATTRIBUTE, WET_M)
            creeks.append(Creek(r["id"], geom, palette if marked else None,
                                float(cover) if isinstance(cover, (int, float)) else DEFAULT_COVER,
                                float(max_m) if isinstance(max_m, (int, float)) else DEFAULT_MAX_M,
                                variants,
                                float(wet_m) if isinstance(wet_m, (int, float)) else WET_M))
        else:
            others.append(geom)
    return course, creeks, others


def marked_water_mask(db_path: Path, course_ident: str, shape_: tuple[int, int], cell: float,
                      west: float, north: float, margin: float = MARKED_WATER_MARGIN_M) -> np.ndarray:
    """The marked creeks (+ `margin`) on a surface-map grid: grass_zones.py lifts its
    water clearance there (the creek-bank zones take the banks)."""
    from rasterio import features
    from rasterio.transform import Affine
    sections = load_sections(db_path, course_ident)
    _, creeks, _ = load_creeks(db_path, course_ident, sections)
    # An unmarked creek is planted only inside its sections: lift the clearance there only.
    reach = _union([sec.geometry.buffer(SECTION_BLEND_M + SECTION_NOISE_M) for sec in sections])
    geoms = [(c.geometry if c.palette else c.geometry.intersection(reach)).buffer(margin) for c in creeks]
    geoms = [g for g in geoms if not g.is_empty]
    if not geoms:
        return np.zeros(shape_, dtype=bool)
    return features.rasterize(geoms, out_shape=shape_, transform=Affine(cell, 0, west, 0, -cell, north)).astype(bool)


def feature_collection(results: list[tuple[Creek, list]], source: str) -> dict:
    """`results`: (creek, [(variant, bands)]) as creek_bands returns them."""
    features = []
    for creek, slots in results:
        for variant, bands in slots:
            for level, geom in bands:
                for poly in sorted(_each_polygon(geom), key=lambda p: -p.area):
                    rings = [poly.exterior, *poly.interiors]
                    features.append({
                        "type": "Feature",
                        "geometry": {"type": "Polygon", "coordinates": [[[round(x, 2), round(y, 2)] for x, y, *_ in r.coords] for r in rings]},
                        "properties": {
                            "type": "vegetation_zone", "source": source, "source_ref": f"{source}:{creek.id}:{len(features)}",
                            "zoneType": ZONE_TYPE, "zoneVariant": variant, "weight": round(level, 3),
                            "feather": BAND_FEATHER_M, "noise": 0, "areaM2": round(poly.area, 1), "creekId": creek.id,
                        },
                    })
    return {"type": "FeatureCollection", "crs": {"type": "name", "properties": {"name": "EPSG:3006"}}, "features": features}


def load_dem(sidecar: Path) -> np.ndarray:
    """The terrain's edited DEM (the tif the sidecar sits next to), rows north to south."""
    import rasterio
    tif = sidecar.with_suffix("")   # <prefix>-dem-<n>m.tif.json -> .tif
    with rasterio.open(tif) as src:
        return src.read(1).astype(np.float32)


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Creek-bank vegetation zones for the creeks marked with a bankVeg palette (see the module doc).")
    p.add_argument("--db", default=str(gspro.DEFAULT_DB))
    p.add_argument("--course", required=True, help="course id, or a name substring")
    p.add_argument("--out", required=True, help="output GeoJSON (EPSG:3006 FeatureCollection of vegetation_zone features)")
    p.add_argument("--surfaces", required=True, help="Unity surface map (<prefix>-<terrain>-surfaces.json, golfmap.surfaces.export)")
    p.add_argument("--sidecar", help="the terrain's DEM sidecar (default: found next to the surface map); its .tif is the DEM")
    p.add_argument("--buildings", help="building survey GeoJSON (EPSG:3006)")
    p.add_argument("--roads", help="road centerlines GeoJSON with widthM (EPSG:3006)")
    p.add_argument("--source", default=DEFAULT_SOURCE)
    vegetation_rules.add_overrides_flag(p)
    args = p.parse_args(argv)

    surfaces = Path(args.surfaces)
    sidecar = Path(args.sidecar) if args.sidecar else None
    cls, cell, west, north, doc = load_surfaces_map(surfaces, sidecar)
    if sidecar is None:
        prefix = surfaces.name[: -len("-surfaces.json")]
        sidecar = sorted(surfaces.parent.glob(f"{prefix}-dem-*.tif.json"))[0]
    z = load_dem(sidecar)
    if z.shape != cls.shape:
        raise SystemExit(f"error: DEM {z.shape} and surface map {cls.shape} differ; re-export the surface map for this terrain")
    sections = load_sections(Path(args.db), args.course)
    course, creeks, others = load_creeks(Path(args.db), args.course, sections)
    blockers = [b.buffer(BUILDING_MARGIN_M, join_style=2) for b in load_buildings(Path(args.buildings) if args.buildings else None)]
    blockers += [line.buffer(width / 2 + ROAD_MARGIN_M, cap_style=2) for line, width in load_roads(Path(args.roads) if args.roads else None)]

    paths = load_paths(Path(args.db), args.course)

    results = []
    for creek in creeks:
        near = [b for b in blockers if b.distance(creek.geometry) < creek.max_m + 10]
        near_others = [o for o in others if o.distance(creek.geometry) < creek.max_m + 10]
        near_paths = [q for q in paths if q.distance(creek.geometry) < creek.max_m + 10]
        near_sections = [sec for sec in sections if sec.geometry.distance(creek.geometry) < creek.max_m + 10]
        slots, stats = creek_bands(creek, cls, z, cell, west, north, near_others, near, paths=near_paths,
                                   sections=near_sections)
        results.append((creek, slots))
        print(f"  creek {creek.id[:8]} {'/'.join(v or 'default' for v, _ in slots) or 'nothing'}: water {stats['waterM2']:,.0f} m2, "
              f"covered {stats.get('coverShare', 0):.0%} (asked {creek.cover:.0%}), bank {stats.get('bankM2', 0):,.0f} m2")
    fc = feature_collection(results, args.source)
    Path(args.out).write_text(json.dumps(fc), encoding="utf-8")
    print(f"{course['name']}: {len(creeks)} planted creek(s), {len(sections)} section(s), {len(fc['features'])} {ZONE_TYPE} zones")
    print(f"Wrote {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
