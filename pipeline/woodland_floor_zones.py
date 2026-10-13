#!/usr/bin/env python3
"""Woodland-floor vegetation zones for a whole course, derived by rule: what
grows under the trees depends on which trees stand there and on the ground.

The floor types are the ground-vegetation types Swedish forestry sorts a stand
by (markvegetationstyp), cut down to what reads from a fairway:

  heath     dry knolls and ridges, thin soil over rock, mostly under pine:
            heather, lingonberry, dry bilberry, stones, a pine seedling.
  bilberry  ordinary conifer floor on level, fresh ground (blåbärsgranskog):
            a bilberry carpet, stumps, fallen branches, a fern here and there.
  herb      under broadleaves (oak, birch, hazel groves and old pasture): low
            grass and herbs, hazel, saplings.
  fern      hollows and valley floors where water gathers, under any trees:
            ferns in stands, lush grass, mossy logs.
  edge      the brush along a stand's rim towards open ground (bryn): bushes
            and saplings. A mix layer over whatever floor or tall rough is there.
  brush     saplings and knee-to-chest-high bushes here and there inside what
            is decidedly forest, not in a tree corridor between two holes. A
            mix layer too.

Each is a variant of the `woodland_floor` zone type (`woodland_floor/<key>`);
which plants it holds is the course's grass palette and bindings
(.claude/skills/grass-planting/SKILL.md).

Inputs, all on the surface map's grid (golfmap.surfaces.export) and found next
to it: the terrain's DEM (terrain_fields.py: knoll or hollow, wetness, slope)
and the planted trees (`<prefix>-<terrain>-trees.json`, unity-trees-v1: where
each crown is, how wide, conifer or broadleaf; tree species areas override the
kind of the stems inside them).

  closure   crowns smoothed over CLOSURE_SMOOTH_M. The floor starts where the
            closure passes FLOOR_CLOSURE: a lone tree or a loose row keeps
            the tall rough under it, a gap in a stand opens the floor.
  conifers  the conifer share of the crown area around a point.
  type      per point, the best of the four scores (wet -> fern, dry knoll ->
            heath, else conifer -> bilberry, broadleaf -> herb), each with its
            own smooth noise so the patches have ragged borders, then blurred
            over TYPE_BLEND_M so two floors cross-fade instead of meeting on a line.
            Picked twice: in patches of TYPE_NOISE_FEATURE_M, and again in
            pockets of POCKET_FEATURE_M where noise counts for more than the
            score (POCKET_SCORE), so a bilberry floor holds pockets of fern, heather or
            grass. The pockets get POCKET_SHARE of the weight.
  where     only on deep rough, with the tall rough's clearances from tees,
            greens, fairways, bunkers, water and houses
            (grass_zones.weight_field) and within REACH_M of play. Paths and
            roads are cut out of the polygons.

Written like the tall rough: nested weight bands, one `vegetation_zone` per
band polygon, source `woodland-floor`. The generator runs after the tall rough
and before the creek banks, so the floor takes the ground from the tall rough
under the trees and a creek bank takes it from the floor.

tests/test_woodland_floor_zones.py.
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from shapely.geometry.base import BaseGeometry

import gspro
from golfpipe.detect_common import _each_polygon
from grass_zones import (Rules, S_SLAB, _union, load_buildings, load_path_surfaces, load_roads,
                         load_surfaces_map, ways_cut, weight_field)
from terrain_fields import Fields, terrain_fields

ZONE_TYPE = "woodland_floor"
DEFAULT_SOURCE = "woodland-floor"
HEATH, BILBERRY, HERB, FERN, EDGE, BRUSH = "heath", "bilberry", "herb", "fern", "edge", "brush"
FLOORS = (HEATH, BILBERRY, HERB, FERN)
MIX_LAYERS = (EDGE, BRUSH)     # planted over the floor (blend: mix)

KIND_BROADLEAF, KIND_CONIFER = 0, 1          # golfpipe/trees_stems.py; 2 = unknown
CONIFER_SPECIES = ("pine", "spruce", "fir", "larch", "juniper", "cedar", "cypress")

MIN_CROWN_M = 1.5              # a stem's crown on the ground is at least this wide a disc
CLOSURE_SMOOTH_M = 6.0
FLOOR_CLOSURE = (0.15, 0.4)    # floor weight 0 below, 1 above
EDGE_CLOSURE = (0.05, 0.15, 0.3) # the rim: 0 below, 1 at the middle, 0 above
STAND_SMOOTH_M = 15.0          # a rim belongs to a stand: crowns over this much ground ...
STAND_CLOSURE = (0.12, 0.25)   # ... close this far (a lone tree's own rim gets no brush)
KIND_SMOOTH_M = 10.0           # the stand around a point, not the one tree over it
FOREST_SMOOTH_M = 25.0         # decidedly forest: crowns over this much ground ...
FOREST_CLOSURE = (0.28, 0.38)  # ... close this far (a corridor between two holes does not). Vreta's floor: median 0.31;
                               # (0.35, 0.5) left 1 ha of brush on 20 ha of floor, too thin to notice
BRUSH_FEATURE_M = 12.0         # the brush stands in drifts this size ...
BRUSH_COVER = (-0.2, 0.2)      # ... where its noise passes this (about two thirds of the forest)
DEFAULT_REACH_M = 50.0         # the floor is geometry: none further than this from play
REACH_RAMP_M = 15.0

# Scores 0..1 (see the module doc). Vreta's woodland: tpi -1.3 (p5) .. 1.1 (p95) m, twi 4.3 .. 11.
KNOLL_TPI_M = (0.4, 1.3)
WET_TWI = (8.5, 10.0)
WET_MAX_SLOPE_DEG = (6.0, 10.0)      # water does not stay on a slope
TYPE_NOISE = 0.3                     # how far the noise moves a score
TYPE_NOISE_FEATURE_M = 14.0
TYPE_BLEND_M = 2.0
POCKET_FEATURE_M = 5.0
POCKET_SCORE = 0.35            # how much the score still counts in a pocket (the noise counts 1)
POCKET_SHARE = 0.4

BAND_LEVELS = (0.2, 0.5, 0.8)        # w >= level; the top band has weight 1
BAND_FEATHER_M = 1.5
SIMPLIFY_M = 0.5
MIN_AREA_M2 = 20.0


@dataclass
class Trees:
    """Planted trees on the surface map's grid: column, row (fractional), crown radius in
    metres and kind per tree."""
    col: np.ndarray
    row: np.ndarray
    radius: np.ndarray
    kind: np.ndarray


def _ramp(a: np.ndarray, lo: float, hi: float) -> np.ndarray:
    return np.clip((a - lo) / max(hi - lo, 1e-6), 0.0, 1.0)


def crown_cover(trees: Trees, shape: tuple[int, int], cell: float) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Cells under a crown: (any, conifer, broadleaf) boolean grids."""
    grids = [np.zeros(shape, dtype=bool) for _ in range(3)]
    rows, cols = shape
    for c, r, radius, kind in zip(trees.col, trees.row, trees.radius, trees.kind):
        rc = max(radius, MIN_CROWN_M) / cell
        r0, r1 = max(0, int(r - rc)), min(rows, int(r + rc) + 2)
        c0, c1 = max(0, int(c - rc)), min(cols, int(c + rc) + 2)
        if r1 <= r0 or c1 <= c0:
            continue
        yy, xx = np.ogrid[r0:r1, c0:c1]
        disc = (yy + 0.5 - r) ** 2 + (xx + 0.5 - c) ** 2 <= rc * rc
        grids[0][r0:r1, c0:c1] |= disc
        if kind == KIND_CONIFER:
            grids[1][r0:r1, c0:c1] |= disc
        elif kind == KIND_BROADLEAF:
            grids[2][r0:r1, c0:c1] |= disc
    return grids[0], grids[1], grids[2]


def closure_and_conifers(trees: Trees, shape: tuple[int, int], cell: float) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Canopy closure 0..1, the same over a stand's width (STAND_SMOOTH_M) and over a
    forest's (FOREST_SMOOTH_M), and the conifer share 0..1 of the crowns around each cell
    (0.5 where no tree of a known kind is near)."""
    from scipy.ndimage import gaussian_filter
    crown, conifer, broadleaf = crown_cover(trees, shape, cell)
    closure = gaussian_filter(crown.astype(np.float32), CLOSURE_SMOOTH_M / cell)
    con = gaussian_filter(conifer.astype(np.float32), KIND_SMOOTH_M / cell)
    bro = gaussian_filter(broadleaf.astype(np.float32), KIND_SMOOTH_M / cell)
    known = con + bro
    stand = gaussian_filter(crown.astype(np.float32), STAND_SMOOTH_M / cell)
    forest = gaussian_filter(crown.astype(np.float32), FOREST_SMOOTH_M / cell)
    return closure, stand, forest, np.where(known > 1e-3, con / np.maximum(known, 1e-6), 0.5).astype(np.float32)


def floor_shares(fields: Fields, conifers: np.ndarray, cell: float, seed: int = 0) -> dict[str, np.ndarray]:
    """Each floor type's share 0..1 per cell; they sum to 1 everywhere."""
    from scipy.ndimage import gaussian_filter
    from creek_bank_zones import smooth_noise

    wet = _ramp(fields.twi, *WET_TWI) * (1.0 - _ramp(fields.slope, *WET_MAX_SLOPE_DEG))
    knoll = _ramp(fields.tpi, *KNOLL_TPI_M) * (1.0 - wet)
    level = (1.0 - wet) * (1.0 - knoll)
    scores = {
        FERN: wet,
        HEATH: knoll * (0.4 + 0.6 * conifers),       # a broadleaf knoll is a dry herb slope as often as heath
        BILBERRY: level * conifers + knoll * 0.3 * conifers,
        HERB: level * (1.0 - conifers) + knoll * 0.6 * (1.0 - conifers),
    }

    def pick(score: float, noise: float, feature_m: float, blend_m: float, seed_: int) -> list[np.ndarray]:
        stack = np.stack([score * scores[k] + noise * smooth_noise(conifers.shape, cell, feature_m, seed_ + i)
                          for i, k in enumerate(FLOORS)])
        best = np.argmax(stack, axis=0)
        return [gaussian_filter((best == i).astype(np.float32), blend_m / cell) for i in range(len(FLOORS))]

    patches = pick(1.0, TYPE_NOISE, TYPE_NOISE_FEATURE_M, TYPE_BLEND_M, seed)
    pockets = pick(POCKET_SCORE, 1.0, POCKET_FEATURE_M, TYPE_BLEND_M / 2, seed + 100)
    shares = [(1.0 - POCKET_SHARE) * a + POCKET_SHARE * b for a, b in zip(patches, pockets)]
    total = np.maximum(np.sum(shares, axis=0), 1e-6)
    return {k: s / total for k, s in zip(FLOORS, shares)}


def floor_weights(cls: np.ndarray, cell: float, z: np.ndarray, trees: Trees, blocked: np.ndarray | None = None,
                  reach: float = DEFAULT_REACH_M, seed: int = 0, fields: Fields | None = None) -> dict[str, np.ndarray]:
    """Weight 0..1 per cell for each floor type, the edge brush and the forest brush (see the module doc)."""
    from creek_bank_zones import smooth_noise
    ground = weight_field(cls, cell, blocked, Rules(max_distance=reach, spill=0.0), reach_ramp=REACH_RAMP_M, seed=seed)
    ground[cls == S_SLAB] = 0.0      # weight_field grows grass in over a rock slab's edge; the floor stays off it
    closure, stand, forest, conifers = closure_and_conifers(trees, cls.shape, cell)
    floor = ground * _ramp(closure, *FLOOR_CLOSURE)
    fields = fields if fields is not None else terrain_fields(z, cell)
    out = {k: floor * share for k, share in floor_shares(fields, conifers, cell, seed).items()}
    lo, mid, hi = EDGE_CLOSURE
    out[EDGE] = ground * np.minimum(_ramp(closure, lo, mid), 1.0 - _ramp(closure, mid, hi)) * _ramp(stand, *STAND_CLOSURE)
    drifts = _ramp(smooth_noise(cls.shape, cell, BRUSH_FEATURE_M, seed + 50), *BRUSH_COVER)
    out[BRUSH] = floor * _ramp(forest, *FOREST_CLOSURE) * drifts
    return out


def bands(w: np.ndarray, transform, cut: BaseGeometry | None = None, levels=BAND_LEVELS) -> list[tuple[float, BaseGeometry]]:
    """The weight field as nested bands [(weight, geometry)], lowest first, with `cut`
    (paths and roads) taken out."""
    from rasterio import features
    from shapely import make_valid
    from shapely.geometry import shape

    out = []
    for i, level in enumerate(levels):
        m = w >= level
        polys = [shape(g) for g, v in features.shapes(m.astype(np.uint8), mask=m, transform=transform) if v == 1]
        band = _union(p.simplify(SIMPLIFY_M) for p in _each_polygon(_union(polys)) if p.area >= MIN_AREA_M2)
        if cut is not None and not cut.is_empty:
            band = _union(p for p in _each_polygon(make_valid(band.difference(cut))) if p.area >= MIN_AREA_M2)
        out.append((1.0 if i == len(levels) - 1 else float(level), band))
    return out


def feature_collection(slots: list[tuple[str, list[tuple[float, BaseGeometry]]]], source: str) -> dict:
    """One zone per band polygon, floors first, then the mix layers (edge, brush)."""
    features = []
    for variant, slot_bands in slots:
        for level, geom in slot_bands:
            for poly in sorted(_each_polygon(geom), key=lambda p: -p.area):
                rings = [poly.exterior, *poly.interiors]
                props = {
                    "type": "vegetation_zone", "source": source, "source_ref": f"{source}:{variant}:{len(features)}",
                    "zoneType": ZONE_TYPE, "zoneVariant": variant, "weight": round(level, 3),
                    "feather": BAND_FEATHER_M, "noise": 0, "areaM2": round(poly.area),
                }
                if variant in MIX_LAYERS:
                    props["blend"] = gspro.ZONE_BLEND_MIX
                features.append({
                    "type": "Feature",
                    "geometry": {"type": "Polygon", "coordinates": [[[round(x, 2), round(y, 2)] for x, y, *_ in r.coords] for r in rings]},
                    "properties": props,
                })
    return {"type": "FeatureCollection", "crs": {"type": "name", "properties": {"name": "EPSG:3006"}}, "features": features}


# --- inputs -------------------------------------------------------------------

def load_trees(path: Path, cell: float, west: float, north: float, shape: tuple[int, int]) -> Trees:
    """The planted trees (unity-trees-v1, plot-local metres from the plot's south-west corner)
    on the surface map's grid. A tree species area whose mix is all conifers, or all
    broadleaves, sets the kind of the stems inside it."""
    from rasterio import features
    from rasterio.transform import Affine
    from shapely.geometry import Polygon

    doc = json.loads(path.read_text(encoding="utf-8"))
    if doc.get("format") != "unity-trees-v1":
        raise SystemExit(f"error: {path} is not unity-trees-v1")
    ox, oy = doc["plot"]["originX"], doc["plot"]["originY"]
    trees = doc.get("trees") or []
    col = np.array([(ox + t["x"] - west) / cell for t in trees], dtype=np.float64)
    row = np.array([(north - (oy + t["z"])) / cell for t in trees], dtype=np.float64)
    radius = np.array([float(t.get("r") or 0.0) for t in trees], dtype=np.float64)
    kind = np.array([int(t.get("k", 2)) for t in trees], dtype=np.int64)
    transform = Affine(cell, 0, west, 0, -cell, north)
    for area in doc.get("areas") or []:
        species = [s["species"] for s in area.get("species") or []]
        conifer = [any(c in s for c in CONIFER_SPECIES) for s in species]
        if not species or (any(conifer) and not all(conifer)):
            continue
        rings = [[(ox + n["x"], oy + n["z"]) for n in ring["nodes"]] for ring in area.get("rings") or []]
        polys = [Polygon(r) for r in rings if len(r) >= 3]
        if not polys:
            continue
        inside = features.rasterize(polys, out_shape=shape, transform=transform).astype(bool)
        ri, ci = np.clip(row.astype(int), 0, shape[0] - 1), np.clip(col.astype(int), 0, shape[1] - 1)
        kind[inside[ri, ci]] = KIND_CONIFER if all(conifer) else KIND_BROADLEAF
    return Trees(col, row, radius, kind)


def main(argv: list[str] | None = None) -> int:
    from rasterio import features
    from rasterio.transform import Affine
    from creek_bank_zones import load_dem

    p = argparse.ArgumentParser(description="Woodland-floor vegetation zones by tree kind and terrain (see the module doc).")
    p.add_argument("--db", default=str(gspro.DEFAULT_DB))
    p.add_argument("--course", required=True, help="course id, or a name substring")
    p.add_argument("--out", required=True, help="output GeoJSON (EPSG:3006 FeatureCollection of vegetation_zone features)")
    p.add_argument("--surfaces", required=True, help="Unity surface map (<prefix>-<terrain>-surfaces.json, golfmap.surfaces.export)")
    p.add_argument("--sidecar", help="the terrain's DEM sidecar (default: found next to the surface map); its .tif is the DEM")
    p.add_argument("--trees", help="the terrain's planted trees, unity-trees-v1 (default: <prefix>-<terrain>-trees.json next to the surface map)")
    p.add_argument("--buildings", help="building survey GeoJSON (EPSG:3006)")
    p.add_argument("--roads", help="road centerlines GeoJSON with widthM (EPSG:3006)")
    p.add_argument("--reach", type=float, default=DEFAULT_REACH_M, help=f"max metres from a rough/fairway/green/bunker (default {DEFAULT_REACH_M:g})")
    p.add_argument("--source", default=DEFAULT_SOURCE)
    args = p.parse_args(argv)

    surfaces = Path(args.surfaces)
    sidecar = Path(args.sidecar) if args.sidecar else None
    cls, cell, west, north, doc = load_surfaces_map(surfaces, sidecar)
    prefix = surfaces.name[: -len("-surfaces.json")]
    if sidecar is None:
        sidecar = sorted(surfaces.parent.glob(f"{prefix}-dem-*.tif.json"))[0]
    z = load_dem(sidecar)
    if z.shape != cls.shape:
        raise SystemExit(f"error: DEM {z.shape} and surface map {cls.shape} differ; re-export the surface map for this terrain")
    trees_path = Path(args.trees) if args.trees else surfaces.with_name(f"{prefix}-trees.json")
    if not trees_path.exists():
        # No trees, no floor: an empty result (which also clears the last run's zones), not a failed planting.
        Path(args.out).write_text(json.dumps(feature_collection([], args.source)), encoding="utf-8")
        print(f"warning: no planted trees at {trees_path} (export the trees for this terrain): no woodland floor")
        return 0
    trees = load_trees(trees_path, cell, west, north, cls.shape)

    transform = Affine(cell, 0, west, 0, -cell, north)
    rules = Rules()
    blockers = [b.buffer(rules.building_margin, join_style=2) for b in load_buildings(Path(args.buildings) if args.buildings else None)]
    blocked = features.rasterize(blockers, out_shape=cls.shape, transform=transform).astype(bool) if blockers else None
    weights = floor_weights(cls, cell, z, trees, blocked, reach=args.reach)
    cut = ways_cut(load_roads(Path(args.roads) if args.roads else None), load_path_surfaces(Path(args.db), args.course), rules)

    slots = [(k, bands(weights[k], transform, cut)) for k in (*FLOORS, *MIX_LAYERS)]
    fc = feature_collection(slots, args.source)
    Path(args.out).write_text(json.dumps(fc), encoding="utf-8")
    cell2 = cell * cell
    print(f"{doc.get('course', args.course)}: {len(trees.col)} trees, {len(fc['features'])} {ZONE_TYPE} zones; "
          + ", ".join(f"{k} {float(weights[k].sum()) * cell2 / 1e4:.1f} ha" for k in (*FLOORS, *MIX_LAYERS)))
    print(f"Wrote {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
