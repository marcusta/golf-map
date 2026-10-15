#!/usr/bin/env python3
"""Tall-grass vegetation zones for a whole course, derived by rule instead of
by hand.

The ground truth for "what surface is here" is the built course: the surface
map Unity writes from the OPCD meshes (golfmap.surfaces.export ->
<prefix>-<terrain>-surfaces.json/.bin), because OPCD's Blender step fills
everything outside the holes with its own Outer_Deep_Sat meshes and adds blend
strips, none of which exist as features in the app. Without a surface map the
app's drawn features stand in (--surfaces omitted), painted bottom to top in
the OPCD SVG's order.

Where tall grass grows (all in EPSG:3006 metres):

  habitat  every point whose visible surface is deep rough (per-hole Deep
           meshes and the Outer_Deep fill); tees, fairways, greens, semi
           rough, bunkers, water, rough and blend strips on top cut it out.
  spill    up to SPILL metres of the habitat's surroundings where the visible
           surface is rough, so the grass fades into the rough instead of
           stopping at a drawn edge (the zone's inward feather does the fade).
  reach    only within MAX_DISTANCE of a rough, fairway, green or bunker.
  never    building footprints (+ margin) and roads: golf-map `path` features
           (already cut as a surface, plus a margin) and OSM road centerlines
           buffered by half their width plus a margin.
  clear    the zones' edge noise wobbles every edge outward too, so the area
           keeps CLEARANCE (noise + 0.5 m) from every surface it must never
           touch (semi, fairway, green, tee, bunker, water, blend strips) and
           from the reach limit; the inward feather still fades the edge.
           Creeks marked for bank vegetation (a `bankVeg` palette) keep no
           clearance: creek_bank_zones.py plants their banks with zones that
           sit on top, and the tall rough fills in where those fade out.

From a surface map the rules become a WEIGHT FIELD instead of an area, so every
fade is one gradient: deep rough 1; the rough's first SPILL metres (a foot or
so, ragged: noise decides where it reaches in) 1; times a ramp to 0 towards each
forbidden surface (zero within its clearance, full beyond clearance + ramp; tees
and greens widest) - but only where the deep rough meets that surface itself:
where mown rough lies between (a metre or two, ROUGH_BUFFER_M), the rough is the
buffer and the grass grows right up to it; times a ramp towards the reach limit
and buildings; thinner far from play (Rules.far_*: a course's own in
docs/gspro/<course>/vegetation-rules.json, passed in as flags). Paths and roads are not in the field at all: it runs on under
them, and their drawn outlines (+ margin) are cut out of the band polygons, so
the grass edge is the path's edge to the centimetre instead of to a 0.5 m cell
(cells left bare strips beside a path and grass half across it). On loose ones
(gravel, dirt) small notches in that cut let a tuft grow a foot onto the path
here and there. The edges are ragged in the field itself, so the
bands carry no edge noise (it would wobble bare patches into the deep rough
along every rough and path). The field is written as nested
contour bands (weight 0.1 ... 1.0, one zone per band polygon); the zone
rasterizer keeps the maximum per type, so the bands stack into the ramp. One
polygon with an inward feather cannot do that: it fades from every cut edge,
which leaves a thin, dipping strip where a narrow rough meets deep rough.

The result is written as `vegetation_zone` features (EPSG:3006 GeoJSON, one
per polygon, holes kept) for the server's generated-feature import under one
source, so a re-run replaces exactly what the last run made and nothing
hand-drawn. scripts/grass-zones.ts runs this and the import for a course.
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from shapely import make_valid
from shapely.geometry import LineString, Polygon, shape
from shapely.geometry.base import BaseGeometry
from shapely.ops import unary_union

import gspro
from golfpipe.detect_common import _each_polygon

HABITAT_TYPES = ("deep_rough",)
SPILL_TYPES = ("rough",)
PLAY_TYPES = ("rough", "fairway", "green", "bunker")
FORBIDDEN_TYPES = ("semi_rough", "fairway", "green", "tee", "bunker", "water", "water_creek", "path")
# Surfaces that paint over whatever lies below them; the OPCD surface types.
SURFACE_TYPES = tuple(gspro.TYPE_SURFACE)

DEFAULT_MAX_DISTANCE_M = 75.0
DEFAULT_SPILL_M = 0.3    # a foot or so into the mown rough, ragged (was 1.5, before that 5: a wide fade)
DEFAULT_FEATHER_M = 4.0
DEFAULT_NOISE_M = 1.0
DEFAULT_BUILDING_MARGIN_M = 4.0
DEFAULT_ROAD_MARGIN_M = 0.5   # centerline + width is an estimate of the road's edge
DEFAULT_PATH_MARGIN_M = 0.15  # the grass's feet stand a hand off the path's edge: its blades lean over it (0: slightly too much on the road)
DEFAULT_MIN_AREA_M2 = 25.0
DEFAULT_SIMPLIFY_M = 0.3
DEFAULT_SOURCE = "tall-grass"
DEFAULT_ZONE_TYPE = "rough_tall"


@dataclass
class Rules:
    max_distance: float = DEFAULT_MAX_DISTANCE_M
    spill: float = DEFAULT_SPILL_M
    building_margin: float = DEFAULT_BUILDING_MARGIN_M
    road_margin: float = DEFAULT_ROAD_MARGIN_M
    path_margin: float = DEFAULT_PATH_MARGIN_M
    min_area: float = DEFAULT_MIN_AREA_M2
    simplify: float = DEFAULT_SIMPLIFY_M
    clearance: float = DEFAULT_NOISE_M + 0.5
    # Far from play the grass is thinner: beyond far_start metres from the nearest rough, semi,
    # fairway, green, tee or bunker the weight falls over far_ramp metres to far_weight (the mask
    # value is VSP's density, so 0.56 is a little over half the plants; far_weight is also a band
    # level, so the thinned field is written at exactly that weight). Nobody walks there, it is
    # seen from a distance, and it is most of the grass the player's machine draws (Marcus
    # 2026-10-13). far_weight 1 = off.
    far_start: float = 30.0
    far_ramp: float = 10.0
    far_weight: float = 0.56
    # A course can thin nearer as well (docs/gspro/<course>/vegetation-rules.json, which can also move
    # the far rule): beyond near_start the weight falls over near_ramp to near_weight, and the two
    # multiply, so no stretch is ever thicker than the far rule alone makes it (Vreta, 2026-10-15:
    # 0.6 from 20 m, 0.3 from 50 m). near_weight 1 = off.
    near_start: float = 0.0
    near_ramp: float = 0.0
    near_weight: float = 1.0
    # Further out still, where no ball is played from, the mix itself changes: beyond out_start
    # metres from play the ordinary mix hands over, across out_ramp metres, to the type's
    # FAR_VARIANT (zones of slot <type>/far): few, large, wide cards that read as the same grass
    # from the fairway at a fraction of the instances. Distance from play, not the drawn `oob`
    # ring: on Vreta that ring holds only the western holes. Only with far_variant set, which
    # main() does when the course binds items to the variant (an unbound one would plant nothing).
    out_start: float = 40.0
    out_ramp: float = 10.0
    far_variant: bool = False


# (surface codes, clearance: zero weight within this many metres, ramp: full weight beyond clearance + ramp)
CLEARANCES = (
    ((6, 5), 4.0, 4.0),    # tee, green
    ((4,), 3.0, 3.0),      # fairway
    ((3, 7), 2.0, 3.0),    # semi, bunker
    ((8,), 1.5, 2.0),      # water
    ((9,), 1.0, 2.0),      # blend strips
    ((11,), 0.2, 1.0),     # rock: klippor and tee-wall faces (stone-painted course mesh)
)
BAND_LEVELS = (0.1, 0.25, 0.4, 0.55, 0.7, 0.85, 0.97)   # w >= level; the top band has weight 1


def band_levels(rules: Rules, levels=BAND_LEVELS) -> tuple:
    """`levels` plus the thinning weights (far, near and the two together), so the thinned field is
    written at exactly those weights (0.5 between the 0.4 and 0.55 levels would be written as 0.4:
    60 % thinner, not half). The top level stays last: its band has weight 1."""
    extra = {w for w in (rules.far_weight, rules.near_weight, rules.far_weight * rules.near_weight) if 0.0 < w < levels[-1]}
    return tuple(sorted({*levels[:-1], *extra})) + (levels[-1],)
DEFAULT_BAND_FEATHER_M = 0.5   # centred on the band's edge: full a quarter metre inside it
DEFAULT_BAND_NOISE_M = 0.0     # the field's own edges are ragged; zone noise would open bare patches along them
DEFAULT_REACH_RAMP_M = 10.0
DEFAULT_BLOCK_RAMP_M = 1.5
# Mown rough between the deep rough and a tee, green, fairway, ... is the buffer: behind
# ROUGH_BUFFER_M of it the surface's own clearance starts to give way, and behind
# ROUGH_BUFFER_M + ROUGH_BUFFER_RAMP_M it no longer applies. The same goes for the grass
# that spills into the rough: none within ROUGH_BUFFER_M of the surface.
ROUGH_BUFFER_M = 1.0
ROUGH_BUFFER_RAMP_M = 1.0
EDGE_NOISE_FEATURE_M = 3.0     # blobs of the noise that decides where the grass spills into the rough
# Loose paths (gravel, dirt): a tuft every TUFT_SPACING_M of edge on average (never closer
# than TUFT_MIN_GAP_M), each a disc on the edge reaching its radius onto the path.
LOOSE_SURFACES = ("gravel", "dirt")
TUFT_SPACING_M = 9.0
TUFT_MIN_GAP_M = 2.0
TUFT_RADIUS_M = (0.36, 0.42)   # >= half the diagonal of a 0.5 m mask pixel: each tuft holds one
ROAD_DRAWN_REACH_M = 3.0       # a road centerline this close to a drawn path (or its own width) is that path
PATH_SEAM_M = 1.0              # the surface map's cells this close to a drawn path are its mesh and seam
# The verge of a loose path: an unmown strip of straw and weeds beside it, as a mix layer over whatever
# grows there (zone variant VERGE_VARIANT, blend mix). In deep rough only: mown rough is cut right up to
# the gravel (Vreta, 2026-10: a verge there read as weeds on a kept lawn). Ragged (reach x 0.4 .. 1.6 by
# noise), with gaps, never near a play surface or water, and a card's lean off the path: its 1 m cards
# hung over a 2 m path from both sides, and tufts of its own closed it.
VERGE_VARIANT = "verge"
FAR_VARIANT = "far"            # the thin mix beyond Rules.out_start from play (Rules.far_variant)
VERGE_DEEP_M = 1.8
VERGE_ROUGH_M = 0.0
VERGE_NOISE_FEATURE_M = 4.0    # blobs of the noise that bends the verge's outer edge
VERGE_GAP_FEATURE_M = 9.0      # ... and of the one that opens gaps along it
VERGE_COVER = 0.75             # share of the path's length that has a verge
VERGE_CLEAR = ((3, 4, 5, 6, 7), 4.0), ((8,), 2.0)   # semi/fairway/green/tee/bunker, water: none within this
VERGE_PATH_MARGIN_M = 0.35     # its feet stand this far off the path's edge
VERGE_FEATHER_M = 0.4
VERGE_MIN_M2 = 0.3
MIN_SLIVER_M2 = 2.0            # band pieces smaller than this after the paths are cut out are dropped


@dataclass
class Result:
    area: BaseGeometry
    habitat_m2: float
    spill_m2: float
    cut_by_reach_m2: float
    cut_by_buildings_m2: float
    cut_by_roads_m2: float
    bands: list | None = None   # [(weight, geometry)] lowest first, from a weight field; None = `area` at one weight
    verge: BaseGeometry | None = None   # the loose paths' verges (VERGE_VARIANT), with --surfaces
    far_bands: list | None = None   # [(weight, geometry)] of the FAR_VARIANT mix far from play (Rules.far_variant)


def _union(geoms) -> BaseGeometry:
    geoms = [g for g in geoms if g is not None and not g.is_empty]
    return make_valid(unary_union(geoms)) if geoms else Polygon()


def tall_grass_area(surfaces: list[tuple[str, BaseGeometry]], buildings: list[BaseGeometry],
                    roads: list[tuple[LineString, float]], rules: Rules = Rules()) -> Result:
    """`surfaces`: (feature type, geometry) in paint order, bottom first.
    `roads`: (centerline, width in metres)."""
    habitat = Polygon()
    spillable = Polygon()
    for kind, geom in surfaces:
        if kind not in SURFACE_TYPES or geom is None or geom.is_empty:
            continue
        habitat = habitat.difference(geom)
        spillable = spillable.difference(geom)
        if kind in HABITAT_TYPES:
            habitat = habitat.union(geom)
        if kind in SPILL_TYPES:
            spillable = spillable.union(geom)
    habitat, spillable = make_valid(habitat), make_valid(spillable)

    spill = make_valid(habitat.buffer(rules.spill, join_style=1).intersection(spillable)) if rules.spill > 0 else Polygon()
    area = make_valid(habitat.union(spill))
    raw = area.area

    play = _union(g for kind, g in surfaces if kind in PLAY_TYPES)
    area = make_valid(area.intersection(play.buffer(max(0.0, rules.max_distance - rules.clearance))))
    if rules.clearance > 0:
        forbidden = _union(g for kind, g in surfaces if kind in FORBIDDEN_TYPES)
        area = make_valid(area.difference(forbidden.buffer(rules.clearance)))
    after_reach = area.area

    area, cut_b, cut_r = cut_blockers(area, buildings, roads, [g for kind, g in surfaces if kind == "path"], rules)
    parts = [p.simplify(rules.simplify) for p in _each_polygon(area) if p.area >= rules.min_area]
    return Result(_union(parts), habitat.area, spill.area, raw - after_reach, cut_b, cut_r)


def cut_blockers(area: BaseGeometry, buildings: list[BaseGeometry], roads: list[tuple[LineString, float]],
                 paths: list[BaseGeometry], rules: Rules) -> tuple[BaseGeometry, float, float]:
    """Remove buildings (+ margin) and roads/paths (+ margin); returns (area, cut by buildings, cut by roads)."""
    before = area.area
    area = make_valid(area.difference(_union(b.buffer(rules.building_margin, join_style=2) for b in buildings)))
    after_buildings = area.area
    area = make_valid(area.difference(_union([line.buffer(width / 2 + rules.road_margin, cap_style=2) for line, width in roads] +
                                             [g.buffer(rules.path_margin) for g in paths])))
    return area, before - after_buildings, after_buildings - area.area


# Surface map codes (unity/Editor/GolfMap/GolfMapSurfaces.cs, golfmap-surfaces-v1).
S_NONE, S_DEEP, S_ROUGH, S_WATER, S_BLEND, S_OTHER = 0, 1, 2, 8, 9, 10
S_PLAY = (2, 3, 4, 5, 6, 7)   # rough, semi, fairway, green, tee, bunker
S_FORBIDDEN = (3, 4, 5, 6, 7, 8, 9, 11)   # semi, fairway, green, tee, bunker, water, blend, rock
# A rock slab cut out into its own mesh (Spline_<name>_Rock_-_Mesh): bare, but the grass around
# it reaches SLAB_FRINGE_M in over its edge on average (0 .. 2x, by noise: no mesh edge shows),
# and patches cover SLAB_PATCH_COVER of the rock. No clearance around it.
S_SLAB = 12
SLAB_FRINGE_M = 0.4            # 0.6 took a metre all round: half of a 5 m slab
SLAB_PATCH_COVER = 0.15
SLAB_NOISE_FEATURE_M = 1.2
SLAB_SKIRT_M = 0.5             # out into mown rough beside it (0 .. 2x): no clean grass line along the rock


def slab_grass(cls: np.ndarray, cell: float, seed: int = 0) -> np.ndarray | None:
    """Where grass grows on the rock slabs (S_SLAB cells): a ragged fringe in over the edge,
    so the mesh edge is under grass all the way round, and patches here and there on the rock
    (SLAB_PATCH_COVER of it). None when the map has no slab."""
    from scipy.ndimage import distance_transform_edt
    from creek_bank_zones import smooth_noise

    slab = cls == S_SLAB
    if not slab.any():
        return None
    inside = distance_transform_edt(slab) * cell   # 1 cell on the slab's edge cells
    reach = SLAB_FRINGE_M * (1.0 + smooth_noise(cls.shape, cell, SLAB_NOISE_FEATURE_M, seed + 1))
    fringe = inside - cell / 2 < reach
    noise = smooth_noise(cls.shape, cell, SLAB_NOISE_FEATURE_M, seed + 2)
    patches = noise >= np.quantile(noise[slab], 1.0 - SLAB_PATCH_COVER)
    return slab & (fringe | patches)


def weight_field(cls: np.ndarray, cell: float, blocked: np.ndarray | None, rules: Rules,
                 clearances=CLEARANCES, reach_ramp: float = DEFAULT_REACH_RAMP_M,
                 block_ramp: float = DEFAULT_BLOCK_RAMP_M, seed: int = 0, split: bool = False):
    """Tall-grass weight 0..1 per cell of the surface map (see the module doc).
    `blocked`: buildings (+ margin), faded over `block_ramp`. Paths and roads are cut
    from the band polygons instead (tall_grass_from_surfaces). `split`: (ordinary mix,
    far mix) instead - with rules.far_variant the far mix takes over beyond out_start
    from play; the two add up to what grows there without the far thinning."""
    from scipy.ndimage import distance_transform_edt
    from creek_bank_zones import smooth_noise

    def dist(mask):
        return distance_transform_edt(~mask) * cell

    def ramp(d, start, width):
        return np.clip((d - start) / max(width, 1e-6), 0.0, 1.0)

    deep = cls == S_DEEP
    rough = cls == S_ROUGH
    w = deep.astype(np.float32)
    grown = slab_grass(cls, cell, seed)
    if grown is not None:
        # Whatever lies beside the slab: where it meets mown rough its edge needs the cover too
        # (the deep-rough-only version left a straight bare mesh edge there). The clearances
        # below still keep it off tees, greens and fairways.
        w[grown] = 1.0
        # And a ragged skirt out into the mown rough beside it: tufts against the rock, so the
        # slab's edge is broken up from both sides (deep rough is tall grass already).
        skirt = SLAB_SKIRT_M * (1.0 + smooth_noise(cls.shape, cell, SLAB_NOISE_FEATURE_M, seed + 3))
        w[rough & (dist(cls == S_SLAB) - cell / 2 < skirt)] = 1.0
    if rules.spill > 0 and rough.any():
        # Into the rough from its deep border, as far as the noise says: 0 .. 2 x spill.
        reach = rules.spill * (1.0 + smooth_noise(cls.shape, cell, EDGE_NOISE_FEATURE_M, seed))
        w[rough & (dist(deep) - cell / 2 < reach)] = 1.0
    d_rough = dist(rough) if rough.any() else None
    for codes, clear, width in clearances:
        present = np.isin(cls, codes)
        if present.any():
            d = dist(present)
            f = ramp(d, clear, width)
            if d_rough is not None:   # rough in between: it is the buffer
                f = np.maximum(f, ramp(d - d_rough, ROUGH_BUFFER_M, ROUGH_BUFFER_RAMP_M))
            w *= f
    play = np.isin(cls, S_PLAY)
    d_play = dist(play)
    w *= np.clip((rules.max_distance - d_play) / reach_ramp, 0.0, 1.0)
    if blocked is not None and blocked.any():
        w *= ramp(dist(blocked), 0.0, block_ramp)
    far = np.zeros_like(w)
    if rules.far_variant and play.any():
        t = ramp(d_play, rules.out_start, rules.out_ramp)
        far, w = w * t, w * (1.0 - t)
    if rules.far_weight < 1.0 and play.any():
        w *= 1.0 - (1.0 - rules.far_weight) * ramp(d_play, rules.far_start, rules.far_ramp)
    if rules.near_weight < 1.0 and play.any():
        w *= 1.0 - (1.0 - rules.near_weight) * ramp(d_play, rules.near_start, rules.near_ramp)
    w, far = w.astype(np.float32), far.astype(np.float32)
    return (w, far) if split else w


def path_verge(cls: np.ndarray, cell: float, loose: np.ndarray, blocked: np.ndarray | None,
               max_distance: float = DEFAULT_MAX_DISTANCE_M, seed: int = 0) -> np.ndarray:
    """Cells of the verge beside the loose paths (`loose`: their cells), per the VERGE_* rules."""
    from scipy.ndimage import distance_transform_edt
    from creek_bank_zones import smooth_noise

    def dist(mask):
        return distance_transform_edt(~mask) * cell

    reach = np.where(cls == S_DEEP, VERGE_DEEP_M, np.where(cls == S_ROUGH, VERGE_ROUGH_M, 0.0))
    reach = reach * (1.0 + 0.6 * smooth_noise(cls.shape, cell, VERGE_NOISE_FEATURE_M, seed + 11))
    verge = dist(loose) - cell / 2 < reach
    gaps = smooth_noise(cls.shape, cell, VERGE_GAP_FEATURE_M, seed + 12)
    if verge.any():
        verge &= gaps >= np.quantile(gaps[verge], 1.0 - VERGE_COVER)
    for codes, clear in VERGE_CLEAR:
        present = np.isin(cls, codes)
        if present.any():
            verge &= dist(present) >= clear
    if blocked is not None and blocked.any():
        verge &= dist(blocked) >= DEFAULT_BLOCK_RAMP_M
    play = np.isin(cls, S_PLAY)
    if play.any():   # as far from play as the tall grass itself
        verge &= dist(play) <= max_distance
    return verge


def path_tufts(loose: BaseGeometry, seed: int = 0, spacing: float = TUFT_SPACING_M) -> BaseGeometry:
    """Discs on the outline of the loose paths, where a tuft grows onto the path."""
    from shapely.geometry import Point
    rng = np.random.default_rng(seed)
    discs = []
    for poly in _each_polygon(loose):
        for ring in (poly.exterior, *poly.interiors):
            at = rng.exponential(spacing)
            while at < ring.length:
                discs.append(ring.interpolate(at).buffer(rng.uniform(*TUFT_RADIUS_M), quad_segs=3))
                at += TUFT_MIN_GAP_M + rng.exponential(spacing - TUFT_MIN_GAP_M)
    return _union(discs)


def ways_cut(roads: list[tuple[LineString, float]], paths: list[tuple[BaseGeometry, str | None]],
             rules: Rules, seed: int = 0) -> BaseGeometry:
    """What paths and roads take out of the grass: roads by centerline and width (+ margin),
    paths by their drawn outline (+ margin), less the tufts on the loose ones. A road that is
    also drawn as a path is cut by the drawing alone: its centerline lies a metre off and its
    width is an estimate, which left 1-2 m of bare ground along the drawn edge."""
    drawn = _union(g for g, _ in paths)
    survey = []
    for line, width in roads:
        if width > 0 and not drawn.is_empty:   # width 0: an area (parking lot), cut as it is
            line = line.difference(drawn.buffer(max(width, ROAD_DRAWN_REACH_M)))
        if not line.is_empty:
            survey.append(line.buffer(width / 2 + rules.road_margin, cap_style=2))
    hard = _union(survey + [g.buffer(rules.path_margin) for g, surface in paths if surface not in LOOSE_SURFACES])
    loose = _union(g.buffer(rules.path_margin) for g, surface in paths if surface in LOOSE_SURFACES)
    if not loose.is_empty:
        loose = make_valid(loose.difference(path_tufts(loose, seed)))
    return _union([hard, loose])


def tall_grass_from_surfaces(cls: np.ndarray, cell: float, west: float, north: float,
                             buildings: list[BaseGeometry], roads: list[tuple[LineString, float]],
                             rules: Rules = Rules(), levels=BAND_LEVELS, paths: list = ()) -> Result:
    """`cls`: surface codes, rows north to south, `cell` metres; (`west`, `north`) the EPSG:3006
    corner of row 0, column 0. The weight field as nested bands; `area` is the lowest band.
    `paths`: the app's `path` features, each a geometry or (geometry, surface). The path
    meshes are drawn from them, so their outlines are the grass's edge: cut from the bands
    (ways_cut), with tufts onto those with a loose surface."""
    from rasterio import features
    from rasterio.transform import Affine
    from scipy.ndimage import binary_dilation, distance_transform_edt

    transform = Affine(cell, 0, west, 0, -cell, north)

    def raster(geoms, all_touched=False):
        geoms = [g for g in geoms if not g.is_empty]
        return features.rasterize(geoms, out_shape=cls.shape, transform=transform, all_touched=all_touched).astype(bool) if geoms else None

    levels = band_levels(rules, levels)
    paths = [p if isinstance(p, tuple) else (p, None) for p in paths]
    blocked = raster([b.buffer(rules.building_margin, join_style=2) for b in buildings])
    drawn = raster([g for g, _ in paths], all_touched=True)
    if drawn is not None:
        # The field runs on under the paths: their cells - the mesh ("other") and OPCD's seam
        # along it (single blend cells, which would push the grass 1-3 m back) - take the
        # surface beside the path.
        near = raster([g.buffer(PATH_SEAM_M) for g, _ in paths], all_touched=True)
        under = drawn | (near & (cls == S_OTHER))
        under |= near & (cls == S_BLEND) & binary_dilation(under, structure=np.ones((3, 3), dtype=bool))
        if not under.all():
            rows, cols = distance_transform_edt(under, return_distances=False, return_indices=True)
            cls = cls[rows, cols]
    w, w_far = weight_field(cls, cell, blocked, rules, split=True)
    cut = ways_cut(roads, paths, rules)

    # A patch of grass on a rock slab is small by design: the minimum area does not apply there.
    slab = cls == S_SLAB
    slabs = _union(shape(g) for g, v in features.shapes(slab.astype(np.uint8), mask=slab, transform=transform) if v == 1) if slab.any() else Polygon()

    def contour_bands(field):
        out = []
        for i, level in enumerate(levels):
            m = field >= level
            polys = [shape(g) for g, v in features.shapes(m.astype(np.uint8), mask=m, transform=transform) if v == 1]
            band = _union(p.simplify(rules.simplify) for p in _each_polygon(_union(polys))
                          if p.area >= rules.min_area or (not slabs.is_empty and p.intersects(slabs)))
            if not cut.is_empty:   # after the simplify: the path's edge stays exact
                band = _union(p for p in _each_polygon(make_valid(band.difference(cut))) if p.area >= min(rules.min_area, MIN_SLIVER_M2))
            out.append((1.0 if i == len(levels) - 1 else float(level), band))
        return out

    bands = contour_bands(w)
    far_bands = contour_bands(w_far) if w_far.any() else None

    # The verge of the loose paths: its cells, less every path and a margin.
    verge = None
    loose_paths = [g for g, surface in paths if surface in LOOSE_SURFACES]
    loose = raster(loose_paths, all_touched=True)
    if loose is not None:
        m = path_verge(cls, cell, loose, blocked, rules.max_distance)
        polys = [shape(g) for g, v in features.shapes(m.astype(np.uint8), mask=m, transform=transform) if v == 1]
        off = _union(g.buffer(max(rules.path_margin, VERGE_PATH_MARGIN_M)) for g, _ in paths)
        area = make_valid(_union(p.simplify(rules.simplify / 2) for p in polys).difference(off))
        verge = _union(p for p in _each_polygon(area) if p.area >= VERGE_MIN_M2)

    cell2 = cell * cell
    deep = cls == S_DEEP
    return Result(bands[0][1], float(deep.sum()) * cell2, float(((cls == S_ROUGH) & (w > 0)).sum()) * cell2,
                  float((deep & (w == 0)).sum()) * cell2,
                  float(blocked.sum()) * cell2 if blocked is not None else 0.0, cut.area, bands, verge, far_bands)


def load_surfaces_map(path: Path, sidecar: Path | None) -> tuple[np.ndarray, float, float, float, dict]:
    """The surface map and the EPSG:3006 corner of its row 0 / column 0, placed with the terrain's
    DEM sidecar (<prefix>-<terrain>-dem-*.tif.json next to it unless given)."""
    doc = json.loads(path.read_text(encoding="utf-8"))
    if doc.get("format") != "golfmap-surfaces-v1":
        raise SystemExit(f"error: {path} is not golfmap-surfaces-v1")
    cls = np.fromfile(path.with_name(doc["data"]), dtype=np.uint8).reshape(doc["height"], doc["width"])
    if sidecar is None:
        prefix = path.name[: -len("-surfaces.json")]
        found = sorted(path.parent.glob(f"{prefix}-dem-*.tif.json"))
        if not found:
            raise SystemExit(f"error: no {prefix}-dem-*.tif.json next to {path}; pass --sidecar")
        sidecar = found[0]
    sc = json.loads(sidecar.read_text(encoding="utf-8"))
    e0, n0 = sc["square3006"][0], sc["square3006"][1]
    pos = sc.get("unity", {}).get("position", {"x": 0.0, "z": 0.0})
    # world (x, z) -> EPSG:3006: the sidecar's square corner sits at the terrain's Unity position
    west = e0 + (doc["worldOrigin"][0] - pos["x"])
    south = n0 + (doc["worldOrigin"][1] - pos["z"])
    north = south + doc["sizeM"][1]
    return cls, float(doc["cellM"]), west, north, doc


def feature_collection(area: BaseGeometry, zone_type: str, source: str, weight: float,
                       feather: float, noise: float, bands: list | None = None,
                       verge: BaseGeometry | None = None, far_bands: list | None = None) -> dict:
    """One zone per polygon; with `bands` ([(weight, geometry)], lowest first) one per band
    polygon in that order, so higher bands sit above lower ones in the zone stack. `far_bands`:
    the same for the FAR_VARIANT mix, above the ordinary bands (it claims its share first, the
    ordinary mix keeps the rest, so the two cross-fade). `verge`: the loose paths' verges, on
    top as VERGE_VARIANT mix zones (what is under them keeps growing)."""
    features = []
    for variant, stack in ((None, bands if bands is not None else [(weight, area)]), (FAR_VARIANT, far_bands or [])):
        for level, geom in stack:
            for poly in sorted(_each_polygon(geom), key=lambda p: -p.area):
                rings = [poly.exterior, *poly.interiors]
                features.append({
                    "type": "Feature",
                    "geometry": {"type": "Polygon", "coordinates": [[[round(x, 2), round(y, 2)] for x, y, *_ in r.coords] for r in rings]},
                    "properties": {
                        "type": "vegetation_zone", "source": source,
                        "source_ref": f"{source}:{variant + ':' if variant else ''}{len(features)}",
                        "zoneType": zone_type, **({"zoneVariant": variant} if variant else {}),
                        "weight": round(level, 3), "feather": feather, "noise": noise,
                        "areaM2": round(poly.area),
                    },
                })
    for poly in sorted(_each_polygon(verge) if verge is not None else [], key=lambda p: -p.area):
        rings = [poly.exterior, *poly.interiors]
        features.append({
            "type": "Feature",
            "geometry": {"type": "Polygon", "coordinates": [[[round(x, 2), round(y, 2)] for x, y, *_ in r.coords] for r in rings]},
            "properties": {
                "type": "vegetation_zone", "source": source, "source_ref": f"{source}:{VERGE_VARIANT}:{len(features)}",
                "zoneType": zone_type, "zoneVariant": VERGE_VARIANT, "blend": gspro.ZONE_BLEND_MIX, "weight": 1.0,
                "feather": VERGE_FEATHER_M, "noise": 0, "areaM2": round(poly.area),
            },
        })
    return {"type": "FeatureCollection", "crs": {"type": "name", "properties": {"name": "EPSG:3006"}}, "features": features}


# --- inputs -----------------------------------------------------------------

def load_surfaces(db_path: Path, course_ident: str) -> tuple[dict, list[tuple[str, BaseGeometry]]]:
    course, rows = gspro._load_course_features(db_path, course_ident, "opcd")
    surfaces = []
    for r in rows:
        if r["type"] not in SURFACE_TYPES:
            continue
        geom = gspro._zone_geometry_m(json.loads(r["geometry_json"]))
        if geom is not None and not geom.is_empty:
            surfaces.append((r["type"], geom))
    return dict(course), surfaces


def load_path_surfaces(db_path: Path, course_ident: str) -> list[tuple[BaseGeometry, str | None]]:
    """The course's `path` features in EPSG:3006 metres with their `surface` attribute."""
    conn = gspro._open_course_db(db_path)
    course = gspro._resolve_course(conn, course_ident)
    rows = conn.execute("SELECT geometry_json, attributes_json FROM course_features WHERE course_id = ? AND type = 'path'",
                        (course["id"],)).fetchall()
    conn.close()
    out = []
    for r in rows:
        g = gspro._zone_geometry_m(json.loads(r["geometry_json"]))
        if g is not None and not g.is_empty:
            attrs = json.loads(r["attributes_json"]) if r["attributes_json"] else {}
            out.append((make_valid(g), attrs.get("surface")))
    return out


def far_variant_bound(db_path: Path, course_ident: str, zone_type: str) -> bool:
    """Whether the course's `zone_type` has a FAR_VARIANT that binds items (zones -- bind
    <course> <type> --variant far --palette ...): the switch for the far mix."""
    conn = gspro._open_course_db(db_path)
    course = gspro._resolve_course(conn, course_ident)
    types = gspro._load_zone_types(conn, course["id"])
    conn.close()
    return any(t.key == zone_type and any(v.key == FAR_VARIANT and v.items for v in t.variants) for t in types)


def load_buildings(path: Path | None) -> list[BaseGeometry]:
    if not path or not path.exists():
        return []
    doc = json.loads(path.read_text(encoding="utf-8"))
    return [make_valid(shape(f["geometry"])) for f in doc.get("features", [])
            if f.get("geometry") and f["geometry"]["type"] in ("Polygon", "MultiPolygon")]


def load_roads(path: Path | None, default_width: float = 5.0) -> list[tuple[LineString, float]]:
    if not path or not path.exists():
        return []
    doc = json.loads(path.read_text(encoding="utf-8"))
    roads = []
    for f in doc.get("features", []):
        g = f.get("geometry")
        if g and g["type"] in ("Polygon", "MultiPolygon"):
            roads.append((shape(g), 0.0))  # a parking lot: the area itself (+ margin)
            continue
        if not g or g["type"] not in ("LineString", "MultiLineString"):
            continue
        width = float((f.get("properties") or {}).get("widthM") or default_width)
        roads.append((shape(g), width))
    return roads


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Tall-grass vegetation zones for a course from its drawn surfaces (see the module doc).")
    p.add_argument("--db", default=str(gspro.DEFAULT_DB), help=f"app database (default {gspro.DEFAULT_DB})")
    p.add_argument("--course", required=True, help="course id, or a name substring")
    p.add_argument("--out", required=True, help="output GeoJSON (EPSG:3006 FeatureCollection of vegetation_zone features)")
    p.add_argument("--surfaces", help="Unity surface map (<prefix>-<terrain>-surfaces.json, golfmap.surfaces.export); omitted = the app's drawn features")
    p.add_argument("--sidecar", help="the terrain's DEM sidecar placing the surface map (default: found next to it)")
    p.add_argument("--buildings", help="building survey GeoJSON (fetch-buildings output, EPSG:3006)")
    p.add_argument("--roads", help="road centerlines GeoJSON with widthM (fetch-roads --centerlines-out, EPSG:3006)")
    p.add_argument("--zone-type", default=DEFAULT_ZONE_TYPE, help=f"zoneType of the zones (default {DEFAULT_ZONE_TYPE})")
    p.add_argument("--source", default=DEFAULT_SOURCE, help=f"generated-feature source (default {DEFAULT_SOURCE})")
    p.add_argument("--max-distance", type=float, default=DEFAULT_MAX_DISTANCE_M, help="max metres from a rough/fairway/green/bunker")
    p.add_argument("--spill", type=float, default=DEFAULT_SPILL_M, help="metres the grass may reach into surrounding rough")
    p.add_argument("--feather", type=float, default=DEFAULT_FEATHER_M, help="zone feather (inward density fade) in metres")
    p.add_argument("--band-feather", type=float, default=DEFAULT_BAND_FEATHER_M,
                   help=f"feather of each weight band with --surfaces (default {DEFAULT_BAND_FEATHER_M} m)")
    p.add_argument("--noise", type=float, help=f"zone edge noise in metres (default {DEFAULT_NOISE_M}; "
                   f"{DEFAULT_BAND_NOISE_M} for the weight bands with --surfaces, whose edges are ragged already)")
    p.add_argument("--weight", type=float, default=1.0)
    p.add_argument("--building-margin", type=float, default=DEFAULT_BUILDING_MARGIN_M)
    p.add_argument("--road-margin", type=float, default=DEFAULT_ROAD_MARGIN_M)
    p.add_argument("--path-margin", type=float, default=DEFAULT_PATH_MARGIN_M, help="metres kept clear beside the app's path features")
    p.add_argument("--clearance", type=float, help="metres kept from forbidden surfaces and the reach limit (default: noise + 0.5)")
    p.add_argument("--far-start", type=float, default=Rules.far_start, help="metres from play where the grass starts to thin")
    p.add_argument("--far-ramp", type=float, default=Rules.far_ramp, help="metres over which it thins, from --far-start")
    p.add_argument("--far-weight", type=float, default=Rules.far_weight, help="its weight beyond --far-start + --far-ramp (1 = no thinning)")
    p.add_argument("--near-start", type=float, default=Rules.near_start, help="metres from play where a course's own, nearer thinning starts")
    p.add_argument("--near-ramp", type=float, default=Rules.near_ramp, help="metres over which it thins, from --near-start")
    p.add_argument("--near-weight", type=float, default=Rules.near_weight, help="its weight beyond --near-start + --near-ramp, times the far rule's (1 = off)")
    p.add_argument("--out-start", type=float, default=Rules.out_start,
                   help=f"metres from play where the <type>/{FAR_VARIANT} mix takes over (only when the course binds that variant)")
    args = p.parse_args(argv)

    buildings = load_buildings(Path(args.buildings) if args.buildings else None)
    roads = load_roads(Path(args.roads) if args.roads else None)
    rules = Rules(max_distance=args.max_distance, spill=args.spill,
                  building_margin=args.building_margin, road_margin=args.road_margin, path_margin=args.path_margin,
                  clearance=args.clearance if args.clearance is not None else (DEFAULT_NOISE_M if args.noise is None else args.noise) + 0.5,
                  far_start=args.far_start, far_ramp=args.far_ramp, far_weight=args.far_weight,
                  near_start=args.near_start, near_ramp=args.near_ramp, near_weight=args.near_weight, out_start=args.out_start)
    if args.surfaces:
        rules.far_variant = far_variant_bound(Path(args.db), args.course, args.zone_type)
        cls, cell, west, north, doc = load_surfaces_map(Path(args.surfaces), Path(args.sidecar) if args.sidecar else None)
        course = {"name": doc.get("course", args.course)}
        # Creeks marked for bank vegetation: no water clearance there, the tall rough
        # runs up to them and the creek-bank zones on top take the banks.
        from creek_bank_zones import marked_water_mask
        marked = marked_water_mask(Path(args.db), args.course, cls.shape, cell, west, north) & (cls == S_WATER)
        if marked.any():
            cls = cls.copy()
            cls[marked] = S_NONE
            print(f"  {marked.sum() * cell * cell:,.0f} m2 of water on creeks marked for bank vegetation: no clearance")
        r = tall_grass_from_surfaces(cls, cell, west, north, buildings, roads, rules,
                                     paths=load_path_surfaces(Path(args.db), args.course))
    else:
        course, surfaces = load_surfaces(Path(args.db), args.course)
        r = tall_grass_area(surfaces, buildings, roads, rules)
    doc = feature_collection(r.area, args.zone_type, args.source, args.weight,
                             args.band_feather if r.bands is not None else args.feather,
                             args.noise if args.noise is not None else DEFAULT_BAND_NOISE_M if r.bands is not None else DEFAULT_NOISE_M,
                             r.bands, r.verge, r.far_bands)
    Path(args.out).write_text(json.dumps(doc), encoding="utf-8")
    print(f"{course['name']}: {len(doc['features'])} {args.zone_type} zones, {r.area.area:,.0f} m2 "
          f"(deep rough {r.habitat_m2:,.0f} m2 + rough spill {r.spill_m2:,.0f} m2; cut: beyond {args.max_distance:g} m "
          f"{r.cut_by_reach_m2:,.0f} m2, buildings {r.cut_by_buildings_m2:,.0f} m2 ({len(buildings)}), "
          f"roads {r.cut_by_roads_m2:,.0f} m2 ({len(roads)} centerlines))")
    if args.surfaces and rules.far_weight < 1.0:
        print(f"  thinner far from play: from {rules.far_start:g} m the weight falls over {rules.far_ramp:g} m to {rules.far_weight:g}")
    if args.surfaces and rules.near_weight < 1.0:
        print(f"  and nearer: from {rules.near_start:g} m over {rules.near_ramp:g} m to {rules.near_weight:g} (times the far rule's)")
    if r.far_bands:
        print(f"  {r.far_bands[0][1].area:,.0f} m2 beyond {rules.out_start:g} m from play: the thin {args.zone_type}/{FAR_VARIANT} mix "
              f"(hand-over across {rules.out_start:g}-{rules.out_start + rules.out_ramp:g} m)")
    elif args.surfaces:
        print(f"  no {args.zone_type}/{FAR_VARIANT} variant with items on this course: the ordinary mix grows to the reach limit")
    if r.verge is not None and not r.verge.is_empty:
        print(f"  {r.verge.area:,.0f} m2 of verge along the gravel and dirt paths ({args.zone_type}/{VERGE_VARIANT}, mixed over what grows there)")
    print(f"Wrote {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
