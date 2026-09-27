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
fade is one gradient: deep rough 1; rough 1 at the deep border down to 0 at
SPILL metres; times a ramp to 0 towards each forbidden surface (zero within its
clearance, full beyond clearance + ramp; tees and greens widest), towards the
reach limit and towards buildings and roads. The field is written as nested
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
DEFAULT_SPILL_M = 1.5    # a tight, ragged line into the mown rough (was 5: a wide fade)
DEFAULT_FEATHER_M = 4.0
DEFAULT_NOISE_M = 1.0
DEFAULT_BUILDING_MARGIN_M = 4.0
DEFAULT_ROAD_MARGIN_M = 1.5
DEFAULT_PATH_MARGIN_M = 1.0
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


# (surface codes, clearance: zero weight within this many metres, ramp: full weight beyond clearance + ramp)
CLEARANCES = (
    ((6, 5), 4.0, 4.0),    # tee, green
    ((4,), 3.0, 3.0),      # fairway
    ((3, 7), 2.0, 3.0),    # semi, bunker
    ((8,), 1.5, 2.0),      # water
    ((9,), 1.0, 2.0),      # blend strips
)
BAND_LEVELS = (0.1, 0.25, 0.4, 0.55, 0.7, 0.85, 0.97)   # w >= level; the top band has weight 1
DEFAULT_BAND_FEATHER_M = 1.0
DEFAULT_REACH_RAMP_M = 10.0
DEFAULT_BLOCK_RAMP_M = 1.5


@dataclass
class Result:
    area: BaseGeometry
    habitat_m2: float
    spill_m2: float
    cut_by_reach_m2: float
    cut_by_buildings_m2: float
    cut_by_roads_m2: float
    bands: list | None = None   # [(weight, geometry)] lowest first, from a weight field; None = `area` at one weight


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
S_NONE, S_DEEP, S_ROUGH, S_WATER = 0, 1, 2, 8
S_PLAY = (2, 3, 4, 5, 6, 7)   # rough, semi, fairway, green, tee, bunker
S_FORBIDDEN = (3, 4, 5, 6, 7, 8, 9)   # semi, fairway, green, tee, bunker, water, blend


def weight_field(cls: np.ndarray, cell: float, blocked: np.ndarray | None, rules: Rules,
                 clearances=CLEARANCES, reach_ramp: float = DEFAULT_REACH_RAMP_M,
                 block_ramp: float = DEFAULT_BLOCK_RAMP_M) -> np.ndarray:
    """Tall-grass weight 0..1 per cell of the surface map (see the module doc)."""
    from scipy.ndimage import distance_transform_edt

    def dist(mask):
        return distance_transform_edt(~mask) * cell

    def ramp(d, start, width):
        return np.clip((d - start) / max(width, 1e-6), 0.0, 1.0)

    deep = cls == S_DEEP
    w = deep.astype(np.float32)
    if rules.spill > 0:
        rough = cls == S_ROUGH
        w = np.maximum(w, np.where(rough, np.clip(1.0 - dist(deep) / rules.spill, 0.0, 1.0), 0.0).astype(np.float32))
    for codes, clear, width in clearances:
        present = np.isin(cls, codes)
        if present.any():
            w *= ramp(dist(present), clear, width)
    play = np.isin(cls, S_PLAY)
    w *= np.clip((rules.max_distance - dist(play)) / reach_ramp, 0.0, 1.0)
    if blocked is not None and blocked.any():
        w *= ramp(dist(blocked), 0.0, block_ramp)
    return w


def tall_grass_from_surfaces(cls: np.ndarray, cell: float, west: float, north: float,
                             buildings: list[BaseGeometry], roads: list[tuple[LineString, float]],
                             rules: Rules = Rules(), levels=BAND_LEVELS, paths: list[BaseGeometry] = ()) -> Result:
    """`cls`: surface codes, rows north to south, `cell` metres; (`west`, `north`) the EPSG:3006
    corner of row 0, column 0. The weight field as nested bands; `area` is the lowest band.
    `paths`: the app's `path` features (OPCD's path meshes are not in the surface map), kept
    clear by `rules.path_margin` like roads."""
    from rasterio import features
    from rasterio.transform import Affine

    transform = Affine(cell, 0, west, 0, -cell, north)
    blockers = [b.buffer(rules.building_margin, join_style=2) for b in buildings] + \
               [line.buffer(width / 2 + rules.road_margin, cap_style=2) for line, width in roads] + \
               [g.buffer(rules.path_margin) for g in paths]
    blocked = features.rasterize(blockers, out_shape=cls.shape, transform=transform).astype(bool) if blockers else None
    w = weight_field(cls, cell, blocked, rules)

    bands = []
    for i, level in enumerate(levels):
        m = w >= level
        polys = [shape(g) for g, v in features.shapes(m.astype(np.uint8), mask=m, transform=transform) if v == 1]
        parts = [p.simplify(rules.simplify) for p in _each_polygon(_union(polys)) if p.area >= rules.min_area]
        bands.append((1.0 if i == len(levels) - 1 else float(level), _union(parts)))

    cell2 = cell * cell
    deep = cls == S_DEEP
    return Result(bands[0][1], float(deep.sum()) * cell2, float(((cls == S_ROUGH) & (w > 0)).sum()) * cell2,
                  float((deep & (w == 0)).sum()) * cell2,
                  float(blocked.sum()) * cell2 if blocked is not None else 0.0, 0.0, bands)


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
                       feather: float, noise: float, bands: list | None = None) -> dict:
    """One zone per polygon; with `bands` ([(weight, geometry)], lowest first) one per band
    polygon in that order, so higher bands sit above lower ones in the zone stack."""
    features = []
    for level, geom in (bands if bands is not None else [(weight, area)]):
        for poly in sorted(_each_polygon(geom), key=lambda p: -p.area):
            rings = [poly.exterior, *poly.interiors]
            features.append({
                "type": "Feature",
                "geometry": {"type": "Polygon", "coordinates": [[[round(x, 2), round(y, 2)] for x, y, *_ in r.coords] for r in rings]},
                "properties": {
                    "type": "vegetation_zone", "source": source, "source_ref": f"{source}:{len(features)}",
                    "zoneType": zone_type, "weight": round(level, 3), "feather": feather, "noise": noise,
                    "areaM2": round(poly.area),
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
    p.add_argument("--noise", type=float, default=DEFAULT_NOISE_M, help="zone edge noise in metres")
    p.add_argument("--weight", type=float, default=1.0)
    p.add_argument("--building-margin", type=float, default=DEFAULT_BUILDING_MARGIN_M)
    p.add_argument("--road-margin", type=float, default=DEFAULT_ROAD_MARGIN_M)
    p.add_argument("--clearance", type=float, help="metres kept from forbidden surfaces and the reach limit (default: noise + 0.5)")
    args = p.parse_args(argv)

    buildings = load_buildings(Path(args.buildings) if args.buildings else None)
    roads = load_roads(Path(args.roads) if args.roads else None)
    rules = Rules(max_distance=args.max_distance, spill=args.spill,
                  building_margin=args.building_margin, road_margin=args.road_margin,
                  clearance=args.clearance if args.clearance is not None else args.noise + 0.5)
    if args.surfaces:
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
        from creek_bank_zones import load_paths
        r = tall_grass_from_surfaces(cls, cell, west, north, buildings, roads, rules,
                                     paths=load_paths(Path(args.db), args.course))
    else:
        course, surfaces = load_surfaces(Path(args.db), args.course)
        r = tall_grass_area(surfaces, buildings, roads, rules)
    doc = feature_collection(r.area, args.zone_type, args.source, args.weight,
                             args.band_feather if r.bands is not None else args.feather, args.noise, r.bands)
    Path(args.out).write_text(json.dumps(doc), encoding="utf-8")
    print(f"{course['name']}: {len(doc['features'])} {args.zone_type} zones, {r.area.area:,.0f} m2 "
          f"(deep rough {r.habitat_m2:,.0f} m2 + rough spill {r.spill_m2:,.0f} m2; cut: beyond {args.max_distance:g} m "
          f"{r.cut_by_reach_m2:,.0f} m2, buildings {r.cut_by_buildings_m2:,.0f} m2 ({len(buildings)}), "
          f"roads {r.cut_by_roads_m2:,.0f} m2 ({len(roads)} centerlines))")
    print(f"Wrote {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
