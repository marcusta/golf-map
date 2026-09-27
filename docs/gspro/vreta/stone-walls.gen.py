"""Vreta dry-stone walls: the boulder faces of raised tees, for Unity's golfmap.walls.build (GolfMapWalls.cs).

    pipeline/.venv/Scripts/python.exe docs/gspro/vreta/stone-walls.gen.py [--out <Unity course folder>]
        -> docs/gspro/vreta/stone-walls.json (+ <out>/stone-walls.json): the walls, for golfmap.walls.build
        -> docs/gspro/vreta/wall-stones.json: the boulders, for blender/tools/build_props.py (see STONES_FOLDER)

Each wall is a steep bank round a tee plateau, faced with rounded granite boulders from its foot to its top
edge. The lidar DEM smooths the near-vertical wall into a 45-60 deg bank 2-3 m wide; the trace finds that bank
on rays from the plateau's centre and writes paired stations along it: the foot (toe, where the ground flattens
out below) and the top edge (lip). Unity measures the heights on the course meshes and faces the bank with
boulders between the two.

Sources, 2026-09-27:
  - where the walls run: the 2025 ortho (0.25 m; the boulders show as a grey band along the traced foot) and
    the 2026-09-26 reference photos (golf-map site photos, ids below).
  - the bank: dem-edited.tif, the edited lidar DEM the Unity heightmap and course meshes were built from.
    A ray finds the lip where the ground first falls faster than 0.6 m/m (31 deg) outwards (moved back to where
    it starts falling faster than 0.3 m/m) and the toe where it stops falling faster than 0.3 m/m (17 deg).
  - the look (stones 0.6-1.2 m, rounded grey granite, mossy tops, two to three nested courses, leaning into the
    bank): photos c219a56f (front tee from the NE), 7176f1a2 (middle tee's west end), ab05c8a4 (middle tee
    from the N).
Coordinates: EPSG:3006 metres.
"""
import argparse
import json
import math
import os

import numpy as np
import rasterio

HERE = os.path.dirname(os.path.abspath(__file__))
DEM = os.path.join(HERE, "..", "..", "..", "data", "sources", "88E5F5B7-B1E6-4EBA-9D47-49B289C59EAE", "dem-edited.tif")

# The stones, built in Blender (blender/tools/props_kit.py `boulder`, the kit's lichen-covered granite with olive
# moss on faces pointing up) into STONES_FOLDER; GolfMapWalls scales each to the size it needs. The packs in the
# course project only have angular crags, which read as rubble.
#   blender -b --factory-startup --python blender/tools/build_props.py -- --spec docs/gspro/vreta/wall-stones.json
#       --out "<Unity course folder>/Walls/Stones" [--preview]
STONES_FOLDER = "Walls/Stones"  # under the Unity course folder
# Rounded field stones, for a stenröse (style "rose"): (width, height) as a fraction of the length, 0.5-0.9.
BOULDERS = [
    (0.82, 0.72), (0.9, 0.8), (0.62, 0.52), (0.95, 0.88), (0.78, 0.6),
    (0.86, 0.76), (0.66, 0.66), (0.92, 0.62), (0.8, 0.84), (0.58, 0.5),
]
# Wall stones, for a dry-stone wall (style "wall"): blocks with rounded edges (superellipsoid `exponent`), a face
# cut flat on +y and flattish beds (+-z), lumps kept small, so they fit together into a flat, irregular face (photos
# c219a56f, 7176f1a2; Marcus: "fairly flat ... from large stones that have been fitted together").
# (depth, height) as a fraction of the length, exponent.
WALL_STONES = [
    (0.7, 0.55, 3.0), (0.65, 0.5, 2.6), (0.75, 0.62, 3.4), (0.6, 0.45, 2.8), (0.8, 0.6, 3.2),
    (0.7, 0.5, 2.5), (0.66, 0.58, 3.0), (0.72, 0.48, 3.6), (0.62, 0.52, 2.7), (0.78, 0.56, 3.1),
]
WALL_STONE_FLATS = [
    {"dir": [0, 1, 0], "at": 0.82, "keep": 0.12},   # the face
    {"dir": [0, 0, 1], "at": 0.85, "keep": 0.3},    # top bed
    {"dir": [0, 0, -1], "at": 0.85, "keep": 0.3},   # bottom bed
]


# Two big boulders by the tees, finer meshes than the wall stones (they are seen from a few metres). `moss` and
# `mossMat` as in props_kit `boulder`: the cover on the faces pointing up more than `moss`, give or take its patches.
BIG_BOULDERS = {
    # the ivy boulder: most of it under ivy, bare patches on the steep sides (photo cddccbea)
    "boulder_ivy": {"sx": 1.0, "sy": 0.78, "sz": 0.62, "seed": 71, "moss": -0.1, "mossMat": "ivy"},
    # bare grey granite with moss on top (photo e77aaa87, left of the middle tee)
    "boulder_big": {"sx": 1.0, "sy": 0.82, "sz": 0.55, "seed": 72, "moss": 0.84, "mossMat": "granite_moss"},
}

# Single boulders placed whole (GolfMapWalls `boulders`): e/n = centre, yawDeg = compass bearing of the long
# side, lengthM = its length, topM = its top over the highest ground under it. Read off the 2025 ortho and
# the photos, cross-checked by bearing from where each photo was taken.
PLACED = [
    {"id": "h13-ivy-boulder", "asset": "boulder_ivy", "e": 529941.6, "n": 6487472.6, "yawDeg": 135,
     "lengthM": 9.5, "topM": 0.7,
     "note": "Ivy-covered boulder across the path from the middle tee, the hole 13 sign in front of it (photo "
             "cddccbea: ~9 m across, 4-5 m high). The round ivy mass behind the middle tee in photos e77aaa87 "
             "(bearing 224 deg) and ab05c8a4. The edited DEM has it as the knoll SW of the path (top 89.1 m at "
             "529941, 6487469, ~5 m over the path); the ortho shows its pale NE part under the trees."},
    {"id": "h13-middle-tee-east-boulder", "asset": "boulder_big", "e": 529980.0, "n": 6487490.5, "yawDeg": 30,
     "lengthM": 3.8, "topM": 1.7,
     "note": "Bare grey boulder at the east end of the middle tee's wall (photo e77aaa87, left, bearing 201 deg; "
             "ortho: grey rock ~3 x 4 m with its shadow to the NE). Not in the edited DEM."},
]


def stones_spec():
    assets = {}
    for i, (w, h) in enumerate(BOULDERS, 1):
        assets["boulder_%d" % i] = {"category": "prop", "collider": "mesh", "parts": [
            {"kind": "boulder", "sx": 1.0, "sy": w, "sz": h, "seed": 40 + i, "mat": "granite_boulder",
             "moss": 0.84, "mossMat": "granite_moss"}]}
    for i, (d, h, e) in enumerate(WALL_STONES, 1):
        assets["wallstone_%d" % i] = {"category": "prop", "collider": "mesh", "parts": [
            {"kind": "boulder", "sx": 1.0, "sy": d, "sz": h, "seed": 60 + i, "exponent": e, "lumps": 0.45,
             "flats": WALL_STONE_FLATS, "seg": 24, "rings": 14, "mat": "granite_boulder",
             "moss": 0.86, "mossMat": "granite_moss"}]}
    for aid, b in BIG_BOULDERS.items():
        assets[aid] = {"category": "prop", "collider": "mesh", "parts": [
            dict(b, kind="boulder", seg=40, rings=24, mat="granite_boulder")]}
    return {"format": "golfmap-props-spec-v1", "source": "docs/gspro/vreta/stone-walls.gen.py", "origin": [0, 0],
            "assets": assets, "instances": []}


STONE_SETS = {
    "rose": [{"asset": "boulder_%d" % i, "weight": 1} for i in range(1, len(BOULDERS) + 1)],
    "wall": [{"asset": "wallstone_%d" % i, "weight": 1} for i in range(1, len(WALL_STONES) + 1)],
}

# How the ground is shaped (GolfMapWallGround.cs) and the stones sit (GolfMapWalls.cs); a wall may override any of
# it, and picks a style. The lidar (0.5 m) and then OPCD's ~1.2 m mesh grid smooth the walls' near-vertical faces
# to 35-45 deg banks; `ground` reshapes the course meshes in Unity (subdivided on the bank, raised into the tee's
# flat top and a steep face, the face painted as stone) and the stones then sit on that face.
DEFAULTS = {
    "style": "wall",
    "ground": True,
    "faceDeg": 70,               # the face (Marcus, 2026-09-27: "not 90 but at least 50-60")
    "baseInM": 0.2,              # the face starts this far in from the traced foot
    "beyondM": 0.5,              # the plateau's height: the highest of the lip and this far past it
    "taperM": 1.5,               # the terrace fades in and out over this at the wall's ends
    "subdivideM": 0.35,          # triangles on the bank split until their edges are under this
    "groundChannel": "blue",     # the face's paint: the rough copy's stone channel (no Stix grass)
    # ... drawn as OPCD's mossy rock: its red channel onto the blue of a copy of the rough material
    "stoneMaterial": "Assets/Resources/OPCD MAHS Resources/ExtraMaterials/OPCD MAHS Mossy Rock.mat",
    "stoneMaterialChannel": "red",
    "paintFeatherM": 0.25,
    "minFaceM": 0.35,            # no stones (and no terrace) where the bank is lower than this
}

STYLES = {
    # A dry-stone wall: courses of wall stones with their flat faces in the face's plane, fitted tight.
    "wall": {
        "stoneSet": "wall",
        "baseCourseM": [0.6, 0.8],   # course heights up the face: the bottom course's (photo c219a56f: the big ones) ...
        "courseM": [0.4, 0.62],      # ... and the rest
        "stoneHeightVar": [0.8, 1.08],  # a stone's height / its course's: courses are only roughly level
        "bedJitterM": 0.06,          # and its bed this much off the course line
        "lengthRatio": [1.1, 2.1],   # a stone's length / its course height (rounder than a mason's block) ...
        "maxStoneM": 1.5,            # ... up to this
        "depthM": [0.55, 0.8],       # how far a stone reaches into the bank
        "faceProudM": 0.03,          # a stone's face this far out of the plane, give or take faceJitterM
        "faceJitterM": 0.03,
        "spinDeg": 3,                # turned this much either way about each axis: a fitted, not a laid, face
        "gapM": -0.03,               # neighbours meet (rounded edges overlap a little)
        "sinkM": 0.1,                # the bottom course is bedded this deep
        "topMarginM": 0.15,          # no course starts within this of the top
        "capM": 0.04,                # the top course is cut to end this far over the plateau ...
        "minTopCourseM": 0.18,       # ... or left out when that leaves it lower than this
    },
    # A stenröse: a heap of rounded boulders, courses nested and staggered, proud of the bank, leaning back.
    # Built for the hole 13 tees first and kept as a style (see the memory note on stenröse vs stone wall).
    "rose": {
        "stoneSet": "rose",
        "faceDeg": 60,
        "baseStoneM": [0.7, 1.1],    # along-wall length of a bottom-course stone
        "stoneM": [0.5, 0.85],       # the courses above
        "heightScale": [0.9, 1.1],
        "courseStepM": 0.42,         # height between course bases: stones nest into the row below
        "followBank": 1.0,           # front stones on the reshaped face ...
        "proudFrac": 0.3,            # ... standing this much of their depth out of it
        "leanDeg": 12,               # tops lean back into the bank
        "spinDeg": 12,
        "sinkM": 0.12,               # the bottom course is bedded this deep
        "gapM": -0.2,                # neighbours overlap: packed
        "topMarginM": 0.25,          # no course starts within this of the top
        "capM": 0.08,                # and no stone tops the plateau by more than this
        "maxFill": 0,                # nothing behind: the reshaped ground is the plateau
    },
}

# centre: a point on the plateau the rays start from (the tee polygon's centroid in golf-map).
# fromDeg/toDeg: the arc of the bank that is walled, clockwise, read off the 2025 ortho.
WALLS = [
    {"id": "h13-front-tee", "centre": (529933.2, 6487506.9), "fromDeg": 252, "toDeg": 90,
     "note": "Hole 13 front tee: the whole downhill side, from the path (W) round the north to the NE; 1-2.5 m. "
             "Photo c219a56f shows three courses on the NE."},
    {"id": "h13-middle-tee", "centre": (529964.3, 6487483.7), "fromDeg": 296, "toDeg": 38,
     "note": "Hole 13 middle tee: the north side, 0.7-2.4 m, turning at the west end (photo 7176f1a2: two courses)."},
]

_dem = rasterio.open(DEM)
_z = _dem.read(1).astype(float)


def h(e, n):
    """DEM height, bilinear."""
    T = _dem.transform
    fx = (e - T.c) / T.a - 0.5
    fy = (n - T.f) / T.e - 0.5
    i, j = int(math.floor(fx)), int(math.floor(fy))
    u, v = fx - i, fy - j
    z = _z
    return float((z[j, i] * (1 - u) + z[j, i + 1] * u) * (1 - v) + (z[j + 1, i] * (1 - u) + z[j + 1, i + 1] * u) * v)


STEP = 0.25   # metres along a ray
REACH = 22.0  # how far a ray looks for the bank
LIP_FALL, FACE_FALL = 0.6, 0.3  # m/m


def ray(ce, cn, bearing):
    """(lip distance, toe distance, height of the bank) on one ray, or None where the ray finds no bank."""
    s, c = math.sin(math.radians(bearing)), math.cos(math.radians(bearing))
    ts = np.arange(0, REACH, STEP)
    zs = np.array([h(ce + s * t, cn + c * t) for t in ts])
    fall = -np.gradient(zs, STEP)
    steep = np.where(fall > LIP_FALL)[0]
    if len(steep) == 0:
        return None
    lip = steep[0]
    while lip > 0 and fall[lip - 1] > FACE_FALL:
        lip -= 1
    toe = steep[0]
    while toe < len(fall) - 1 and fall[toe] > FACE_FALL:
        toe += 1
    return ts[lip], ts[toe], zs[lip] - zs[toe]


def median(xs, i, r=2):
    w = [x for x in xs[max(0, i - r):i + r + 1] if x is not None]
    return sorted(w)[len(w) // 2] if w else None


def mean(xs, i, r=2):
    w = [x for x in xs[max(0, i - r):i + r + 1] if x is not None]
    return sum(w) / len(w) if w else None


def trace(wall, defaults):
    ce, cn = wall["centre"]
    span = (wall["toDeg"] - wall["fromDeg"]) % 360
    bearings = [(wall["fromDeg"] + d) % 360 for d in range(0, span + 1, 2)]
    hits = [ray(ce, cn, b) for b in bearings]
    # smooth the distances along the wall: a median drops single noisy rays and fills single misses, a mean
    # then irons out the 0.25 m ray steps
    lips = [x[0] if x else None for x in hits]
    toes = [x[1] if x else None for x in hits]
    heights = [x[2] if x else None for x in hits]
    lips, toes, heights = ([median(xs, i) for i in range(len(xs))] for xs in (lips, toes, heights))
    toe_pts, lip_pts, dem_h = [], [], []
    for i, b in enumerate(bearings):
        tl, tt, hh = mean(lips, i), mean(toes, i), mean(heights, i)
        if tl is None or tt is None or hh is None or hh < defaults["minFaceM"]:
            continue
        s, c = math.sin(math.radians(b)), math.cos(math.radians(b))
        toe_pts.append([round(ce + s * tt, 2), round(cn + c * tt, 2)])
        lip_pts.append([round(ce + s * tl, 2), round(cn + c * tl, 2)])
        dem_h.append(round(hh, 2))
    return toe_pts, lip_pts, dem_h


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--out", default="", help="also write stone-walls.json into this folder (the Unity course folder)")
    a = p.parse_args()
    walls = []
    for w in WALLS:
        toe, lip, dem_h = trace(w, DEFAULTS)
        length = sum(math.dist(toe[i], toe[i + 1]) for i in range(len(toe) - 1))
        print("%-16s %3d stations, %5.1f m along the foot, bank %.2f-%.2f m" % (w["id"], len(toe), length, min(dem_h), max(dem_h)))
        walls.append({"id": w["id"], "note": w["note"], "seed": sum(map(ord, w["id"])), "toe": toe, "lip": lip, "demH": dem_h})
    spec = {"format": "golfmap-walls-v1", "source": "docs/gspro/vreta/stone-walls.gen.py", "stonesFolder": STONES_FOLDER,
            "stoneSets": STONE_SETS, "defaults": DEFAULTS, "styles": STYLES, "walls": walls, "boulders": PLACED}
    outs = [(os.path.join(HERE, "stone-walls.json"), spec), (os.path.join(HERE, "wall-stones.json"), stones_spec())]
    if a.out:
        outs.append((os.path.join(a.out, "stone-walls.json"), spec))
    for path, d in outs:
        with open(path, "w", encoding="utf-8", newline="\n") as f:
            f.write(json.dumps(d, indent=1) + "\n")
        print("wrote", path)


if __name__ == "__main__":
    main()
