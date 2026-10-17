#!/usr/bin/env python3
"""Rocky lake-shore vegetation zones by rule: what grows on and around the rock
where a course meets a big lake over granite (Omberg's 14th green on the cliffs
along Vättern).

On the shore the rock is bare, with grass and moss on the ledges and in the
cracks, a thick fringe of low scrub (hazel, willow, small birch and maple,
dwarf and young pines) hugging its edge, heather and lingonberry on the thin
soil, and grass under and between the bushes. Four variants of the
`rock_shore` zone type (`rock_shore/<key>`); which plants each holds is the
course's grass palette and bindings (.claude/skills/grass-planting/SKILL.md):

  crack   VSP texture grass and moss ON the rock (surface class Slab): smooth
          noise patches favouring ledges (DEM slope under LEDGE_SLOPE_DEG),
          none on faces steeper than FACE_SLOPE_DEG, covering CRACK_COVER of the
          slab, plus a ragged fringe in over its edge (CRACK_FRINGE_M, 0 .. 2x
          by noise) and a skirt out onto the land beside it. A mix layer.
  heath   low plants (heather, lingonberry) in sparse patches on the slab's
          ledges and on the thin soil within HEATH_REACH_M outside it.
  scrub   bushes on land (deep rough, rough, other; never on the slab) in a band
          SCRUB_BAND_M out from the slab's edge, densest against the rock and
          thinning inland, and along the lake within SHORE_BAND_M of its water.
          In clumps (noise), the clumps closing up against the rock.
  grass   VSP texture grass under and between the scrub in the same band. A mix
          layer.

  where   the shore: within LAKE_REACH_M of the big lake (the largest water
          body of the surface map, at least LAKE_MIN_M2) AND on a slab or within
          SLAB_REACH_M of one, both with a short ramp. By default a rock in the
          woods gets nothing from here; with `inland` > 0 (a course's rules,
          Omberg's outcrops in the rough, 2026-10-17) every slab gets its crack
          grass and heath in full, and scrub and grass at the `inland` weight in a
          band only INLAND_SCRUB_BAND_M wide (a rock in a meadow is not a shore
          thicket), with no lake needed.
  clear   the tall rough's clearances from tees, greens, fairways, semi, bunkers
          and blend strips (grass_zones.CLEARANCES, without water and rock: a
          shore bush stands on the waterline and against the rock), houses
          (+ margin), and the paths and roads cut out of the polygons
          (grass_zones.ways_cut).

Written like the woodland floor: nested weight bands per variant, one
`vegetation_zone` per band polygon, source `rock-shore`. The generator runs
after the woodland floor and before the creek banks, so scrub and heath (replace
zones) take their ground from the tall rough and the floor, and the grass and
crack layers plant over whatever is there. Slope from the course DEM next to the
surface map at its own 0.5 m cells (a cliff's ledges are a metre or two across):
a rock slab with riseMode `dem` follows that DEM in the meshes too.

tests/test_rock_shore_zones.py.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
from shapely.geometry.base import BaseGeometry

import gspro
import vegetation_rules
from golfpipe.detect_common import _each_polygon
from grass_zones import (CLEARANCES, S_DEEP, S_OTHER, S_ROUGH, S_SLAB, S_WATER, Rules, _union, load_buildings,
                         load_path_surfaces, load_roads, load_surfaces_map, surface_codes, ways_cut)

# The rules (reaches, bands, covers, slopes, ...) live in pipeline/vegetation-rules/rock-shore.json,
# each with its unit and what it does; a course changes them in docs/gspro/<course>/vegetation-rules.json
# (vegetation_rules.py). The clearances are the tall rough's (tall-grass.json).
R = vegetation_rules.load("rock-shore")

ZONE_TYPE = R["zone-type"]
DEFAULT_SOURCE = "rock-shore"
CRACK, HEATH, SCRUB, GRASS = "crack", "heath", "scrub", "grass"
VARIANTS = (SCRUB, HEATH, GRASS, CRACK)   # zone-stack order, bottom first: the heath patches open the scrub
MIX_LAYERS = R["mix-layers"]                    # planted over what grows there (blend: mix)
LAND = surface_codes(R["land-surfaces"])        # deep rough, rough, other

LAKE_MIN_M2 = R["lake-min"]                     # the big lake: a pond or a creek pool is not a shore
LAKE_REACH_M = R["lake-reach"]                  # the shore: within this of the lake ...
SLAB_REACH_M = R["slab-reach"]                  # ... and on a slab or within this of one
REACH_RAMP_M = R["reach-ramp"]                  # both limits fade over this (centred on them)

SLOPE_SMOOTH_M = R["slope-smooth"]              # DEM smoothing before the slope (lidar speckle)
LEDGE_SLOPE_DEG = R["ledge-slope"]              # a ledge: full below the first, none above the second
FACE_SLOPE_DEG = R["face-slope"]                # a face: nothing grows on it

CRACK_COVER = R["crack-cover"]                  # share of the slab under crack patches
CRACK_FEATURE_M = R["crack-noise-size"]         # the patches' size
CRACK_LEDGE_BONUS = R["crack-ledge-bonus"]      # how much a ledge counts against the noise
CRACK_FRINGE_M = R["crack-fringe"]              # in over the slab's edge (0 .. 2x by noise) ...
CRACK_SKIRT_M = R["crack-skirt"]                # ... and out onto the land beside it
CRACK_EDGE_NOISE_M = R["crack-edge-noise-size"]  # the noise that makes the fringe and skirt ragged
CRACK_SOFT = R["crack-soft"]                    # the patch edge: noise this far either side of the cut-off fades 0 .. 1

HEATH_REACH_M = R["heath-reach"]                # thin soil: this far out from the slab's edge
HEATH_COVER = R["heath-cover"]                  # share of the ledges and thin soil under heath patches
HEATH_FEATURE_M = R["heath-noise-size"]
HEATH_FADE_M = R["heath-fade"]                  # on the thin soil it fades out over the last metres of HEATH_REACH_M
HEATH_LEDGE = R["heath-ledge"]                  # on the slab: only where the ledge weight is above this

SCRUB_START_M = R["scrub-start"]                # the band begins this far off the slab's edge (the crack fringe and skirt are there) ...
SCRUB_FULL_M = R["scrub-full"]                  # ... is full from the first to the second ...
SCRUB_BAND_M = R["scrub-band"]                  # ... and thins to SCRUB_FAR_WEIGHT here, gone SCRUB_FADE_M on
SCRUB_FAR_WEIGHT = R["scrub-far-weight"]
SCRUB_FADE_M = R["scrub-fade"]                  # beyond the band (and the inland band) gone over this
INLAND = R["inland"]                            # 0 = the shore only; above 0 every slab dressed, its scrub and grass inland at this weight
INLAND_SCRUB_BAND_M = R["inland-scrub-band"]    # away from the lake (inland > 0): the scrub band ends here, gone SCRUB_FADE_M on
SHORE_BAND_M = R["shore-band"]                  # along the lake: within this of its water ...
SHORE_FULL_M = R["shore-full"]                  # ... full to here
SHORE_WEIGHT = R["shore-weight"]
SCRUB_FEATURE_M = R["scrub-noise-size"]         # the clumps' size
SCRUB_COVER = R["scrub-cover"]                  # noise -> clump weight 0 .. 1 (about two thirds of the band)
SCRUB_EDGE_CLOSE = R["scrub-edge-close"]        # against the rock the clumps close up: noise lifted by this at the edge ...
SCRUB_EDGE_M = R["scrub-edge"]                  # ... fading out over these metres from it
WATER_MARGIN_M = R["water-margin"]              # no bush with its foot in the water
GRASS_BETWEEN = R["grass-between"]              # the grass between the clumps, as a share of the band's weight

NO_CLEARANCE_FROM = surface_codes(R["no-clearance-from"])  # water, rock
PLAY_CLEARANCES = tuple(c for c in CLEARANCES if not set(c[0]) & set(NO_CLEARANCE_FROM))   # tee/green, fairway, semi/bunker, blend
BLOCK_RAMP_M = R["block-ramp"]

BAND_LEVELS = R["band-levels"]                  # w >= level; the top band has weight 1
BAND_FEATHER_M = R["band-feather"]
BAND_NOISE_M = R["band-noise"]
SIMPLIFY_M = R["simplify"]
MIN_AREA_M2 = R["min-area"]                     # per variant key


def _ramp(a, lo: float, hi: float):
    return np.clip((a - lo) / max(hi - lo, 1e-6), 0.0, 1.0)


def _dist(mask: np.ndarray, cell: float) -> np.ndarray:
    """Metres from each cell to the nearest cell of `mask` (0 on it; inf when it is empty)."""
    from scipy.ndimage import distance_transform_edt
    if not mask.any():
        return np.full(mask.shape, np.inf, dtype=np.float32)
    return (distance_transform_edt(~mask) * cell).astype(np.float32)


def big_lake(cls: np.ndarray, cell: float, min_m2: float = LAKE_MIN_M2) -> np.ndarray:
    """The largest connected water body of the surface map, when it is at least `min_m2`; else no cell."""
    from scipy.ndimage import label
    lab, n = label(cls == S_WATER)
    if n == 0:
        return np.zeros(cls.shape, dtype=bool)
    sizes = np.bincount(lab.ravel())
    sizes[0] = 0
    biggest = int(sizes.argmax())
    if sizes[biggest] * cell * cell < min_m2:
        return np.zeros(cls.shape, dtype=bool)
    return lab == biggest


def _quantile_cut(score: np.ndarray, where: np.ndarray, cover: float, soft: float) -> np.ndarray:
    """0..1 per cell: 1 where `score` is in the top `cover` share of the `where` cells, fading over ±`soft`."""
    if not where.any() or cover <= 0:
        return np.zeros(score.shape, dtype=np.float32)
    cut = float(np.quantile(score[where], 1.0 - min(cover, 1.0)))
    return _ramp(score, cut - soft, cut + soft).astype(np.float32)


def shore_weights(cls: np.ndarray, cell: float, z: np.ndarray, blocked: np.ndarray | None = None,
                  lake_reach: float = LAKE_REACH_M, slab_reach: float = SLAB_REACH_M, crack_cover: float = CRACK_COVER,
                  heath_cover: float = HEATH_COVER, scrub_band: float = SCRUB_BAND_M, shore_band: float = SHORE_BAND_M,
                  lake_min_m2: float = LAKE_MIN_M2, inland: float = INLAND, inland_scrub_band: float = INLAND_SCRUB_BAND_M,
                  seed: int = 0) -> dict[str, np.ndarray]:
    """Weight 0..1 per cell of the surface map for each variant (see the module doc). `inland` 0 = the shore
    only; above 0 every slab is dressed, its scrub and grass away from the lake at that weight."""
    from creek_bank_zones import slope_deg, smooth_noise

    zero = {k: np.zeros(cls.shape, dtype=np.float32) for k in VARIANTS}
    slab = cls == S_SLAB
    lake = big_lake(cls, cell, lake_min_m2)
    if not slab.any() or (not lake.any() and inland <= 0):
        return zero

    d_lake = _dist(lake, cell)                     # inf when there is no lake
    d_slab = _dist(slab, cell)                     # 0 on the slab
    inside = _dist(~slab, cell)                    # on the slab: metres in from its edge (one cell on the edge cells)
    half = REACH_RAMP_M / 2
    lakeside = 1.0 - _ramp(d_lake, lake_reach - half, lake_reach + half)      # 1 on the shore, 0 inland
    near_slab = 1.0 - _ramp(d_slab, slab_reach - half, slab_reach + half)
    shore = near_slab if inland > 0 else lakeside * near_slab
    if not (shore > 0).any():
        return zero

    clear = np.ones(cls.shape, dtype=np.float32)
    for codes, clearance, width in PLAY_CLEARANCES:
        present = np.isin(cls, codes)
        if present.any():
            clear *= _ramp(_dist(present, cell), clearance, clearance + width)
    if blocked is not None and blocked.any():
        clear *= _ramp(_dist(blocked, cell), 0.0, BLOCK_RAMP_M)
    where = shore * clear

    slope = slope_deg(z, cell, SLOPE_SMOOTH_M)
    ledge = 1.0 - _ramp(slope, *LEDGE_SLOPE_DEG)
    not_face = slope < FACE_SLOPE_DEG
    land = np.isin(cls, LAND) & (d_lake >= WATER_MARGIN_M)

    # crack: patches on the slab where noise plus the ledge bonus is in the top CRACK_COVER, a fringe in
    # over the edge and a skirt out onto the land beside it.
    score = smooth_noise(cls.shape, cell, CRACK_FEATURE_M, seed + 1) + CRACK_LEDGE_BONUS * ledge
    rock = slab & not_face
    patches = _quantile_cut(score, rock, crack_cover, CRACK_SOFT)
    edge_noise = 1.0 + smooth_noise(cls.shape, cell, CRACK_EDGE_NOISE_M, seed + 2)          # 0 .. 2
    fringe = slab & (inside - cell / 2 < CRACK_FRINGE_M * edge_noise)
    skirt = land & (d_slab - cell / 2 < CRACK_SKIRT_M * edge_noise)
    crack = np.where(rock, patches, 0.0)
    crack = np.maximum(crack, (fringe & not_face) | skirt)

    # heath: sparse patches on the ledges and the thin soil just outside.
    thin = land & (d_slab <= HEATH_REACH_M)
    heath_ground = (slab & not_face & (ledge > HEATH_LEDGE)) | thin
    heath_score = smooth_noise(cls.shape, cell, HEATH_FEATURE_M, seed + 3)
    heath = _quantile_cut(heath_score, heath_ground, heath_cover, CRACK_SOFT) * heath_ground
    heath = heath * np.where(slab, ledge, 1.0 - _ramp(d_slab, HEATH_REACH_M - HEATH_FADE_M, HEATH_REACH_M))

    # scrub and grass: the band off the slab's edge and along the lake, on land.
    off_slab = _ramp(d_slab, SCRUB_START_M - cell / 2, SCRUB_FULL_M[0]) * \
        (1.0 - (1.0 - SCRUB_FAR_WEIGHT) * _ramp(d_slab, SCRUB_FULL_M[1], scrub_band)) * \
        (1.0 - _ramp(d_slab, scrub_band, scrub_band + SCRUB_FADE_M))
    along = SHORE_WEIGHT * (1.0 - _ramp(d_lake, SHORE_FULL_M, shore_band))
    if inland > 0:
        # inland: a narrower band at the `inland` weight, blending into the shore's over the lake reach's ramp
        narrow = 1.0 - _ramp(d_slab, inland_scrub_band, inland_scrub_band + SCRUB_FADE_M)
        off_slab = off_slab * (lakeside + (1.0 - lakeside) * inland * narrow)
    band = np.maximum(off_slab, along) * land
    close = SCRUB_EDGE_CLOSE * (1.0 - _ramp(d_slab, *SCRUB_EDGE_M))
    clumps = _ramp(smooth_noise(cls.shape, cell, SCRUB_FEATURE_M, seed + 4) + close, *SCRUB_COVER)
    scrub = band * clumps
    grass = np.maximum(scrub, GRASS_BETWEEN * band)

    return {
        CRACK: (crack * where).astype(np.float32),
        HEATH: (heath * where).astype(np.float32),
        SCRUB: (scrub * where).astype(np.float32),
        GRASS: (grass * where).astype(np.float32),
    }


def bands(w: np.ndarray, transform, min_area: float, cut: BaseGeometry | None = None,
          levels=BAND_LEVELS) -> list[tuple[float, BaseGeometry]]:
    """The weight field as nested bands [(weight, geometry)], lowest first, with `cut` (paths and roads) taken out."""
    from rasterio import features
    from shapely import make_valid
    from shapely.geometry import shape

    out = []
    for i, level in enumerate(levels):
        m = w >= level
        polys = [shape(g) for g, v in features.shapes(m.astype(np.uint8), mask=m, transform=transform) if v == 1] if m.any() else []
        band = _union(p.simplify(SIMPLIFY_M) for p in _each_polygon(_union(polys)) if p.area >= min_area)
        if cut is not None and not cut.is_empty and not band.is_empty:
            band = _union(p for p in _each_polygon(make_valid(band.difference(cut))) if p.area >= min_area)
        out.append((1.0 if i == len(levels) - 1 else float(level), band))
    return out


def feature_collection(slots: list[tuple[str, list[tuple[float, BaseGeometry]]]], source: str) -> dict:
    """One zone per band polygon, the variants in `slots` order (bottom first)."""
    features = []
    for variant, slot_bands in slots:
        for level, geom in slot_bands:
            for poly in sorted(_each_polygon(geom), key=lambda p: -p.area):
                rings = [poly.exterior, *poly.interiors]
                props = {
                    "type": "vegetation_zone", "source": source, "source_ref": f"{source}:{variant}:{len(features)}",
                    "zoneType": ZONE_TYPE, "zoneVariant": variant, "weight": round(level, 3),
                    "feather": BAND_FEATHER_M, "noise": BAND_NOISE_M, "areaM2": round(poly.area, 1),
                }
                if variant in MIX_LAYERS:
                    props["blend"] = gspro.ZONE_BLEND_MIX
                features.append({
                    "type": "Feature",
                    "geometry": {"type": "Polygon", "coordinates": [[[round(x, 2), round(y, 2)] for x, y, *_ in r.coords] for r in rings]},
                    "properties": props,
                })
    return {"type": "FeatureCollection", "crs": {"type": "name", "properties": {"name": "EPSG:3006"}}, "features": features}


def main(argv: list[str] | None = None) -> int:
    from rasterio import features
    from rasterio.transform import Affine
    from creek_bank_zones import load_dem

    p = argparse.ArgumentParser(description="Rocky lake-shore vegetation zones on and around the rock slabs by a big lake (see the module doc).")
    p.add_argument("--db", default=str(gspro.DEFAULT_DB))
    p.add_argument("--course", required=True, help="course id, or a name substring")
    p.add_argument("--out", required=True, help="output GeoJSON (EPSG:3006 FeatureCollection of vegetation_zone features)")
    p.add_argument("--surfaces", required=True, help="Unity surface map (<prefix>-<terrain>-surfaces.json, golfmap.surfaces.export)")
    p.add_argument("--sidecar", help="the terrain's DEM sidecar (default: found next to the surface map); its .tif is the DEM")
    p.add_argument("--buildings", help="building survey GeoJSON (EPSG:3006)")
    p.add_argument("--roads", help="road centerlines GeoJSON with widthM (EPSG:3006)")
    p.add_argument("--lake-reach", type=float, default=LAKE_REACH_M, help=f"the shore: metres from the big lake (default {LAKE_REACH_M:g})")
    p.add_argument("--slab-reach", type=float, default=SLAB_REACH_M, help=f"... and from a rock slab (default {SLAB_REACH_M:g})")
    p.add_argument("--crack-cover", type=float, default=CRACK_COVER, help=f"share of the slab under crack grass (default {CRACK_COVER:g})")
    p.add_argument("--heath-cover", type=float, default=HEATH_COVER, help=f"share of ledges and thin soil under heath (default {HEATH_COVER:g})")
    p.add_argument("--scrub-band", type=float, default=SCRUB_BAND_M, help=f"metres of scrub out from the slab's edge (default {SCRUB_BAND_M:g})")
    p.add_argument("--shore-band", type=float, default=SHORE_BAND_M, help=f"metres of scrub along the lake (default {SHORE_BAND_M:g})")
    p.add_argument("--lake-min", type=float, default=LAKE_MIN_M2, help=f"m2 of water that makes the big lake (default {LAKE_MIN_M2:g})")
    p.add_argument("--inland", type=float, default=INLAND, help=f"0 = the shore only (default {INLAND:g}); 0..1 = every slab dressed, its scrub and grass away from the lake at this weight")
    p.add_argument("--inland-scrub-band", type=float, default=INLAND_SCRUB_BAND_M, help=f"metres of scrub out from an inland slab (default {INLAND_SCRUB_BAND_M:g})")
    p.add_argument("--seed", type=int, default=0)
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

    transform = Affine(cell, 0, west, 0, -cell, north)
    rules = Rules()
    blockers = [b.buffer(rules.building_margin, join_style=2) for b in load_buildings(Path(args.buildings) if args.buildings else None)]
    blocked = features.rasterize(blockers, out_shape=cls.shape, transform=transform).astype(bool) if blockers else None
    weights = shore_weights(cls, cell, z, blocked, lake_reach=args.lake_reach, slab_reach=args.slab_reach,
                            crack_cover=args.crack_cover, heath_cover=args.heath_cover, scrub_band=args.scrub_band,
                            shore_band=args.shore_band, lake_min_m2=args.lake_min, inland=args.inland,
                            inland_scrub_band=args.inland_scrub_band, seed=args.seed)
    cell2 = cell * cell
    if not any(w.any() for w in weights.values()):
        Path(args.out).write_text(json.dumps(feature_collection([], args.source)), encoding="utf-8")
        why = ("no rock slab in the surface map" if not (cls == S_SLAB).any() else
               f"no lake of {args.lake_min / 1e4:g} ha or more in the surface map" if not big_lake(cls, cell, args.lake_min).any() and args.inland <= 0 else
               f"no rock slab within {args.lake_reach:g} m of the lake")
        print(f"{doc.get('course', args.course)}: no {ZONE_TYPE} zones ({why})")
        print(f"Wrote {args.out}")
        return 0
    cut = ways_cut(load_roads(Path(args.roads) if args.roads else None), load_path_surfaces(Path(args.db), args.course), rules)

    slots = [(k, bands(weights[k], transform, MIN_AREA_M2[k], cut)) for k in VARIANTS]
    fc = feature_collection(slots, args.source)
    Path(args.out).write_text(json.dumps(fc), encoding="utf-8")
    counts = {k: sum(1 for f in fc["features"] if f["properties"]["zoneVariant"] == k) for k in VARIANTS}
    print(f"{doc.get('course', args.course)}: {(cls == S_SLAB).sum() * cell2:,.0f} m2 of rock slab, {len(fc['features'])} {ZONE_TYPE} zones; "
          + ", ".join(f"{k} {counts[k]} zones over {s[0][1].area:,.0f} m2 (full weight {float(weights[k].sum()) * cell2:,.0f} m2)"
                      for k, s in slots))
    print(f"Wrote {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
