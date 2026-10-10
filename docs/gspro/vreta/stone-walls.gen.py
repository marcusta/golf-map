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
# Klippa blocks, for a klippa's face (style "cliff"): jointed granite bedrock seen as big angular blocks - very
# blocky (exponent 3.4-5), a flat face (+y), flat beds and one or two oblique joint planes cutting the corners. The
# NatureManufacture cliff pieces were tried first: one-sided facades, hollow from behind and from above.
# (depth, height) as a fraction of the length, exponent, oblique joints as (x, z) of the plane's normal (+y side).
KLIPPA_BLOCKS = [
    (0.62, 0.5, 4.2, [(0.7, 0.4)]), (0.7, 0.58, 3.6, [(-0.6, 0.5)]), (0.55, 0.46, 5.0, [(0.6, -0.3), (-0.5, 0.6)]),
    (0.75, 0.62, 3.8, [(-0.7, -0.3)]), (0.6, 0.42, 4.6, [(0.5, 0.6)]), (0.68, 0.55, 3.4, [(0.7, 0.2), (-0.7, 0.2)]),
    (0.58, 0.52, 4.4, [(-0.4, 0.7)]), (0.72, 0.48, 4.0, [(0.6, 0.6)]),
]
# Low glacier-polished slabs on a klippa's top (props_kit `rock`: a dome with a sheared flank): (sx, sy, sz) metres.
KLIPPA_SLABS = [(8.0, 4.5, 0.9), (6.5, 4.0, 0.8), (5.0, 3.2, 0.6)]
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
    for i, (d, h, e, joints) in enumerate(KLIPPA_BLOCKS, 1):
        flats = [{"dir": [0, 1, 0], "at": 0.8, "keep": 0.05}, {"dir": [0, 0, 1], "at": 0.82, "keep": 0.15},
                 {"dir": [0, 0, -1], "at": 0.8, "keep": 0.1}]
        flats += [{"dir": [jx, 0.55, jz], "at": 0.72, "keep": 0.04} for jx, jz in joints]
        assets["klippa_block_%d" % i] = {"category": "prop", "collider": "mesh", "parts": [
            {"kind": "boulder", "sx": 1.0, "sy": d, "sz": h, "seed": 80 + i, "exponent": e, "lumps": 0.55,
             "flats": flats, "seg": 28, "rings": 16, "mat": "granite_boulder", "moss": 0.8, "mossMat": "granite_moss"}]}
    for i, (sx, sy, sz) in enumerate(KLIPPA_SLABS, 1):
        assets["klippa_slab_%d" % i] = {"category": "prop", "collider": "mesh", "parts": [
            {"kind": "rock", "sx": sx, "sy": sy, "sz": sz, "seed": 90 + i, "mat": "granite_boulder"}]}
    for aid, b in BIG_BOULDERS.items():
        assets[aid] = {"category": "prop", "collider": "mesh", "parts": [
            dict(b, kind="boulder", seg=40, rings=24, mat="granite_boulder")]}
    return {"format": "golfmap-props-spec-v1", "source": "docs/gspro/vreta/stone-walls.gen.py", "origin": [0, 0],
            "assets": assets, "instances": []}


NM = "Assets/NatureManufacture Assets/Meadow Environment Dynamic Nature/Rocks/"
# Every stone collider gets GSPro's stone physics (hard bounce, little roll friction), like the course meshes carry
# GSPrough, GSPfairway ...; without one the rocks are not a surface in GSPro.
PHYSIC_MATERIAL = "Assets/Resources/Physics/GSPstone.physicMaterial"
# The NatureManufacture pack's photoscanned rock is much paler than Vreta's granite: drawn with copies of its
# materials, _Color multiplied by this (GolfMapWalls `tint`).
NM_TINT = [0.72, 0.72, 0.71]
STONE_SETS = {
    "rose": [{"asset": "boulder_%d" % i, "weight": 1} for i in range(1, len(BOULDERS) + 1)],
    "wall": [{"asset": "wallstone_%d" % i, "weight": 1} for i in range(1, len(WALL_STONES) + 1)],
    "klippa": [{"asset": "klippa_block_%d" % i, "weight": 1} for i in range(1, len(KLIPPA_BLOCKS) + 1)],
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
    # Continuous exposed granite, not the stock Mossy Rock's soil/gravel and distant grass base.
    "stoneAlbedo": "Assets/Rocks and Boulders/Rocks/Source/Textures/Rockdetail4.tif",
    "stoneNormal": "Assets/Rocks and Boulders/Rocks/Source/Textures/Rockdetail4_nmp.tif",
    "stoneTileM": 8.0,
    "stoneColor": [0.59, 0.61, 0.62],
    "paintFeatherM": 0.25,
    "minFaceM": 0.35,            # no stones (and no terrace) where the bank is lower than this
}

STYLES = {
    # A klippa: a natural rock face. The ground is sharpened through the bank's mid-height point at faceDeg +-
    # jitterDeg (not terraced), the outline painted as rock, cliff facades stood in the face.
    "cliff": {
        "stoneSet": "klippa",
        "faceDeg": 70, "jitterDeg": 10,  # Marcus: ~70, 60-80 in places
        "beyondM": 1.0, "taperM": 2.5, "paintFeatherM": 0.5,
        "baseCourseM": [1.4, 2.0],       # blocks: the bottom tier (a klippa reads as big masses, not rubble) ...
        "courseM": [1.1, 1.7],           # ... and the tiers above
        "stoneHeightVar": [0.75, 1.1], "bedJitterM": 0.3,   # sheet joints, far from level courses
        "lengthRatio": [1.5, 2.8], "maxStoneM": 4.8, "depthM": [1.6, 2.6],
        "faceProudM": 0.05, "faceJitterM": 0.15, "spinDeg": 9, "gapM": -0.2,
        "sinkM": 0.35, "topMarginM": 0.3, "capM": 0.1, "minTopCourseM": 0.35,
    },
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

# Hole 4's rock knoll, north of hole 3's tees on the west side of hole 4's fairway (docs: the "Hole 4 rock knolls"
# proposal). Outlines drawn by Marcus on the 2023 leaf-off ortho (2026-09-27), registered to it (17.35 px/m,
# NCC 0.89): blue = klippa (bare granite slabs with cracks, the face towards the fairway), red = large stones.
H4_KLIPPA = [(529591.18, 6488085.62), (529589.68, 6488085.79), (529586.69, 6488087.64), (529582.28, 6488091.53), (529581.59, 6488093.14), (529580.58, 6488094.15), (529576.37, 6488097.20), (529573.78, 6488099.74), (529569.63, 6488102.85), (529567.29, 6488105.19), (529566.08, 6488106.86), (529565.79, 6488108.01), (529565.97, 6488109.63), (529566.97, 6488111.67), (529568.18, 6488112.31), (529570.84, 6488112.25), (529571.24, 6488112.65), (529571.70, 6488112.65), (529573.37, 6488112.42), (529573.72, 6488112.13), (529576.89, 6488112.02), (529578.56, 6488111.56), (529583.26, 6488107.61), (529584.29, 6488104.15), (529585.24, 6488103.08), (529588.18, 6488102.16), (529590.40, 6488100.69), (529590.69, 6488099.88), (529590.69, 6488098.27), (529593.31, 6488096.05), (529593.92, 6488095.10), (529593.98, 6488090.72), (529593.52, 6488088.24), (529592.02, 6488086.11), (529591.18, 6488085.62)]
H4_STONE_FIELD = [(529595.62, 6488058.82), (529593.49, 6488058.93), (529592.65, 6488059.77), (529592.02, 6488060.92), (529591.33, 6488064.27), (529589.88, 6488068.24), (529588.85, 6488073.03), (529588.10, 6488074.41), (529587.52, 6488077.23), (529587.52, 6488079.71), (529588.10, 6488081.61), (529590.12, 6488085.53), (529592.28, 6488086.95), (529592.48, 6488086.80), (529591.67, 6488085.94), (529592.48, 6488084.96), (529593.75, 6488082.36), (529596.28, 6488078.96), (529598.93, 6488073.03), (529598.93, 6488071.76), (529598.47, 6488070.09), (529598.36, 6488061.79), (529597.90, 6488060.75), (529596.92, 6488059.60), (529596.25, 6488058.99), (529595.62, 6488058.82)]
# The stones in the red outline: grey blobs on the 2023 photo (E, N, size incl. shadow m, area m2).
H4_STONES = [
    (529590.39, 6488077.76, 3.36, 6.12),
    (529593.15, 6488075.40, 3.04, 4.38),
    (529592.41, 6488062.01, 2.56, 2.30),
    (529594.19, 6488060.67, 2.40, 2.30),
    (529594.75, 6488078.78, 2.72, 1.74),
    (529592.08, 6488082.93, 1.28, 1.20),
    (529591.14, 6488080.33, 1.44, 0.87),
    (529591.43, 6488071.55, 1.12, 0.84),
    (529591.39, 6488068.63, 1.44, 0.67),
    (529590.70, 6488085.07, 1.60, 0.64),
    (529589.52, 6488071.56, 1.12, 0.56),
    (529596.20, 6488068.44, 0.96, 0.56),
    (529594.15, 6488066.63, 0.80, 0.49),
    (529597.94, 6488070.96, 1.12, 0.33),
    (529591.89, 6488079.30, 0.64, 0.28),
    (529594.84, 6488073.51, 0.64, 0.26)
]


# An outcrop (a klippa) built the way rock is built in game scenes: big closed photoscanned rocks (the pack's
# Rock_01/03/05, 2.4-3.8 m, scaled up to 5-8 m) sunk deep into the knoll and overlapping, so only their upper parts
# show; the steep face is the rocks' own, the ground is left as the lidar has it. Face rocks are the pack's grass-top
# variants (moss on their tops); top rocks the plain ones (a grass-top rock lying on the knoll reads as a grass mound). Tried first and rejected
# (2026-09-27): sharpening the course mesh into a 70 deg face with blocks fitted into it (read as a boxy terrace with
# rubble), the pack's cliff facades (hollow from behind and above), Blender slabs on top (pancakes).
OUTCROP_TINT = [0.66, 0.67, 0.70]   # the pack's rock is pale beige in Vreta's light; the klippor are cool grey granite
# Matt: the pack's smoothness and metallic maps make the rock look wet in Vreta's light (Marcus, 2026-10-10, first on
# hole 13's boulder, then "give the rest of the klippor the same settings"; the tint was 0.57, 0.58, 0.61 before).
OUTCROP_MATT = {"_SmoothnessPower": 0.35, "_MetallicPower": 0.0}
# The grass-top variants: less moss (only on faces turned up, _SnowMaxAngle), the rock itself toned like the plain ones
# (their material's _Color is 0.68 against the plain 0.81).
OUTCROP_MOSS = {"tint": [0.68, 0.69, 0.73], "materialFloats": {"_Snow_Amount": 1.0, "_SnowMaxAngle": 40},
                "materialColors": {"_SnowAlbedoColor": [0.6, 0.63, 0.5, 1]}}
# Klippa A's rocks as Marcus moved and turned them in Unity (2026-09-28): e/n of the pivot, dy = pivot over the ground
# under it (course mesh), Euler rotation, local scale. They override the generated spots.
H4_POSES = {
    "h4-klippa-a-face-01": {"e": 529577.080, "n": 6488108.680, "dy": -1.632, "euler": [0, 158.3, 0], "scale": [2.6024, 2.6024, 2.6024]},
    "h4-klippa-a-face-02": {"e": 529579.070, "n": 6488105.430, "dy": -1.623, "euler": [0, 153.7, 0], "scale": [2.7333, 2.7333, 2.7333]},
    "h4-klippa-a-face-03": {"e": 529580.360, "n": 6488101.800, "dy": -0.573, "euler": [0, 71.9, 0], "scale": [1.8445, 1.8445, 1.8445]},
    "h4-klippa-a-face-04": {"e": 529581.630, "n": 6488098.730, "dy": -2.477, "euler": [0, 157.8, 0], "scale": [3.2438, 3.2438, 3.2438]},
    "h4-klippa-a-face-05": {"e": 529584.580, "n": 6488098.660, "dy": -3.068, "euler": [0, 91.6, 0], "scale": [4.3555, 4.3555, 4.3555]},
    "h4-klippa-a-face-06": {"e": 529587.030, "n": 6488097.580, "dy": -1.602, "euler": [0, 126, 0], "scale": [2.2617, 2.2617, 2.2617]},
    "h4-klippa-a-face-07": {"e": 529588.450, "n": 6488094.730, "dy": -2.949, "euler": [0, 190.7, 0], "scale": [3.4433, 3.4433, 3.4433]},
    "h4-klippa-a-face-08": {"e": 529589.054, "n": 6488089.770, "dy": -1.291, "euler": [0, 113.3, 0], "scale": [2.2206, 2.2206, 2.2206]},
    "h4-klippa-a-top-01": {"e": 529567.350, "n": 6488106.530, "dy": -1.075, "euler": [0, 148.8, 0], "scale": [2.0835, 2.0835, 2.0835]},
    "h4-klippa-a-top-02": {"e": 529567.160, "n": 6488110.190, "dy": -1.125, "euler": [0, 161.1, 0], "scale": [2.1718, 2.1718, 2.1718]},
    "h4-klippa-a-top-03": {"e": 529573.680, "n": 6488104.680, "dy": -2.411, "euler": [0, 138, 0], "scale": [2.7973, 2.7973, 2.7973]},
    "h4-klippa-a-top-04": {"e": 529572.470, "n": 6488109.950, "dy": -1.594, "euler": [0, 147.7, 0], "scale": [3.4061, 3.4061, 3.4061]},
    "h4-klippa-a-top-05": {"e": 529579.850, "n": 6488095.760, "dy": -1.269, "euler": [0, 124.2, 0], "scale": [1.8577, 1.8577, 1.8577]},
    "h4-klippa-a-top-06": {"e": 529584.560, "n": 6488093.230, "dy": -2.016, "euler": [0, 164.3, 0], "scale": [2.427, 2.427, 2.427]},
}
OUTCROP_FACE = ["Rock_01", "Rock_03", "Rock_05_cut", "Rock_03", "Rock_01_cut"]
OUTCROP_TOP = ["Rock_01", "Rock_03", "Rock_01_cut", "Rock_03_cut"]   # Rock_05's underside shows when half-buried


def outcrop_rocks(w, toe, lip, seed):
    """Face rocks every ~4.5 m along the traced face, centred a third of the way out from the top edge to the foot,
    long side along the face, cresting 0.2-0.6 m over the ground behind them; top rocks on a 4.5 m grid inside the
    outline at least 2 m behind the face, cresting 0.25-0.6 m over the ground."""
    import random
    rnd = random.Random(seed)
    poly = w["outline"]

    def inside(x, y):
        c = False
        for i in range(len(poly)):
            (x1, y1), (x2, y2) = poly[i], poly[(i + 1) % len(poly)]
            if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
                c = not c
        return c

    out = []
    along = [0.0]
    for i in range(1, len(lip)):
        along.append(along[-1] + math.dist(lip[i - 1], lip[i]))
    k, d = 0, rnd.uniform(0.5, 1.5)
    while d < along[-1]:
        i = max(j for j in range(len(along)) if along[j] <= d)
        t, l = toe[i], lip[i]
        j = min(i + 1, len(lip) - 1); j0 = max(i - 1, 0)
        bearing = math.degrees(math.atan2(lip[j][0] - lip[j0][0], lip[j][1] - lip[j0][1])) % 360
        e, n = l[0] + (t[0] - l[0]) * 0.35, l[1] + (t[1] - l[1]) * 0.35
        name = OUTCROP_FACE[k % len(OUTCROP_FACE)]
        length = rnd.uniform(5.0, 7.5)
        out.append({"id": "%s-face-%02d" % (w["id"], k + 1), "prefab": NM + "Rocks/Prefabs Grass Top/prefab_%s_grass_top.prefab" % name, **OUTCROP_MOSS,
                    "e": round(e, 2), "n": round(n, 2), "yawDeg": round((bearing + rnd.uniform(-20, 20)) % 360, 1),
                    "lengthM": round(length, 2), "topM": round(rnd.uniform(0.2, 0.6), 2)})
        k += 1
        d += length * rnd.uniform(0.55, 0.7)
    xs, ys = [q[0] for q in poly], [q[1] for q in poly]
    m = 0
    for x in [min(xs) + 2.25 + 4.5 * a for a in range(int((max(xs) - min(xs)) / 4.5) + 1)]:
        for y in [min(ys) + 2.25 + 4.5 * b for b in range(int((max(ys) - min(ys)) / 4.5) + 1)]:
            x2, y2 = x + rnd.uniform(-1.2, 1.2), y + rnd.uniform(-1.2, 1.2)
            if not inside(x2, y2) or min(math.dist((x2, y2), q) for q in lip) < 2.0:
                continue
            # the face side of the lip is outside the top: skip points nearer a foot than a top edge
            if min(math.dist((x2, y2), q) for q in toe) < min(math.dist((x2, y2), q) for q in lip):
                continue
            name = OUTCROP_TOP[m % len(OUTCROP_TOP)]
            out.append({"id": "%s-top-%02d" % (w["id"], m + 1), "prefab": NM + "Rocks/Prefabs/prefab_%s.prefab" % name, "tint": OUTCROP_TINT, "materialFloats": OUTCROP_MATT,
                        "e": round(x2, 2), "n": round(y2, 2), "yawDeg": round(rnd.uniform(120, 170), 1),
                        "lengthM": round(rnd.uniform(3.5, 5.5), 2), "topM": round(rnd.uniform(0.3, 0.7), 2)})
            m += 1
    for entry in out:   # set by hand in Unity
        pose = H4_POSES.get(entry["id"])
        if pose:
            entry.update(e=pose["e"], n=pose["n"], pose={"dy": pose["dy"], "euler": pose["euler"], "scale": pose["scale"]},
                         note="set by hand in Unity 2026-09-28")
    return out


# Three more rocks on klippa A's top, in the area Marcus marked on a screenshot (2026-09-28), projected to the ground
# through that view's camera (eye E 529597.4 N 6488110.7 H 106.1, heading 233, tilt -24, fov 62).
H4_TOP_EXTRA = [
    {"id": "h4-klippa-a-top-07", "rock": "Rock_03", "e": 529587.47, "n": 6488088.66, "yawDeg": 150, "lengthM": 3.2, "topM": 0.55},
    {"id": "h4-klippa-a-top-08", "rock": "Rock_01_cut", "e": 529584.10, "n": 6488094.70, "yawDeg": 125, "lengthM": 2.6, "topM": 0.5},
    {"id": "h4-klippa-a-top-09", "rock": "Rock_01", "e": 529578.20, "n": 6488099.97, "yawDeg": 160, "lengthM": 3.8, "topM": 0.6},
]


def h4_placed():
    """Klippa A's extra top rocks and the stone field below it, placed whole."""
    out = [dict({k: v for k, v in r.items() if k != "rock"}, prefab=NM + "Rocks/Prefabs/prefab_%s.prefab" % r["rock"], tint=OUTCROP_TINT, materialFloats=OUTCROP_MATT)
           for r in H4_TOP_EXTRA]
    out += [
    ]
    angular = ["Rock_06", "Rock_04", "Rock_07", "Rock_03", "m_rock_03"]
    rounded = ["boulder_big", "boulder_2", "boulder_4", "boulder_6", "boulder_8"]
    for j, (e, n, size, area) in enumerate(H4_STONES):
        big = area > 1.5
        size = size * (0.72 if big else 0.9)        # the big blobs include their shadow
        entry = {"id": "h4-stone-%02d" % (j + 1), "e": e, "n": n, "yawDeg": (j * 137) % 360, "lengthM": round(size, 2)}
        if big:
            entry.update({"asset": rounded[j % len(rounded)], "topM": round(size * 0.55, 2)})
        else:
            entry.update({"prefab": NM + "Rocks/Prefabs/prefab_%s.prefab" % angular[j % len(angular)], "tint": NM_TINT, "topM": round(size * 0.45, 2)})
        out.append(entry)
    return out


# centre: a point on the plateau the rays start from (the tee polygon's centroid in golf-map).
# fromDeg/toDeg: the arc of the bank that is walled, clockwise, read off the 2025 ortho.
# Pond-side klippa marked by Marcus, 2026-09-27. Screenshot registered to the
# 2025 ortho (NCC 0.969, 0.144 m/screenshot pixel); west face traced from lidar.
POND_KLIPPA = [
    (530077.92, 6487323.55), (530077.78, 6487327.87), (530078.93, 6487332.62),
    (530080.37, 6487336.66), (530081.09, 6487341.41), (530083.54, 6487345.01),
    (530087.42, 6487347.17), (530090.16, 6487348.03), (530094.19, 6487346.45),
    (530098.80, 6487348.61), (530104.42, 6487351.92), (530109.02, 6487353.22),
    (530111.18, 6487352.64), (530112.77, 6487350.62), (530113.20, 6487347.31),
    (530111.47, 6487343.71), (530109.02, 6487339.97), (530107.30, 6487334.50),
    (530105.14, 6487330.46), (530103.41, 6487327.87), (530099.38, 6487325.71),
    (530096.78, 6487323.12), (530093.33, 6487321.54), (530089.30, 6487321.39),
    (530084.54, 6487322.26), (530081.09, 6487323.12), (530077.92, 6487323.55),
]
PLACED += [
    {"id": "pond-klippa-slab-1", "asset": "klippa_slab_1", "e": 530090.0, "n": 6487332.0,
     "yawDeg": 55, "lengthM": 7.0, "topM": 0.25},
    {"id": "pond-klippa-slab-2", "asset": "klippa_slab_2", "e": 530095.0, "n": 6487338.0,
     "yawDeg": 55, "lengthM": 5.5, "topM": 0.2},
    {"id": "pond-klippa-slab-3", "asset": "klippa_slab_3", "e": 530098.0, "n": 6487328.5,
     "yawDeg": 60, "lengthM": 4.0, "topM": 0.2},
]

# Klippor standing alone west of the knoll with the rock slabs hall_194/195 (Marcus, 2026-10-09: "do them all as
# klippor"). Grey rounded rocks with shadows in both the 2023 and 2025 ortho; the lidar ground model has filtered
# them out (0.3-0.4 m bumps), topM is the raw lidar's top points over each against the highest DEM ground under it.
PATH_KLIPPOR = [
    {"id": "path-klippa-east", "rock": "Rock_01", "e": 529539.5, "n": 6487736.9, "yawDeg": 135, "lengthM": 7.5, "topM": 1.4,
     "note": "At the path's west edge: about 5 x 7 m, long side NW-SE; lidar top 89.9 m, highest ground under it 88.5 m."},
    {"id": "path-klippa-west", "rock": "Rock_03", "e": 529533.5, "n": 6487736.1, "yawDeg": 80, "lengthM": 5.2, "topM": 0.65,
     "note": "Its neighbour 1 m to the west: about 4 x 5 m; lidar top 88.4 m, highest ground under it 87.7 m (2 m lower downhill)."},
    {"id": "path-klippa-south", "rock": "Rock_01_cut", "e": 529579.0, "n": 6487693.8, "yawDeg": 10, "lengthM": 3.5, "topM": 0.4,
     "note": "Single pale stone in the open grass 60 m to the SE, about 3 x 3.5 m in the 2023 ortho; "
             "low: the lidar's top points are 0.15 m over the highest ground under it, on a slope."},
]
# The boulders in the tall rough between hole 6's two tees (Marcus, 2026-10-09: "add them all as klippor, small
# ones too"). Read off the 2023 ortho (leaf-off, shadows to the NW left out), seen in the 2025 one too; topM of
# the four big ones as above (raw lidar top against the highest DEM ground under it), the small ones' judged.
H6_TEE_KLIPPOR = [
    {"id": "h6-tee-klippa-a", "rock": "Rock_01", "e": 529798.4, "n": 6488555.6, "yawDeg": 20, "lengthM": 4.5, "topM": 1.6,
     "note": "The biggest, westmost: about 4 x 4.5 m, lidar top 84.5 m over ground at 82.8 m."},
    {"id": "h6-tee-klippa-b1", "rock": "Rock_04", "e": 529800.5, "n": 6488556.8, "yawDeg": 0, "lengthM": 2.0, "topM": 0.6,
     "note": "Small stone against A's east side."},
    {"id": "h6-tee-klippa-b2", "rock": "Rock_03_cut", "e": 529803.3, "n": 6488557.0, "yawDeg": 100, "lengthM": 2.4, "topM": 0.9,
     "note": "East of A: lidar top 83.5 m over ground at 82.6 m."},
    {"id": "h6-tee-klippa-c", "rock": "Rock_03", "e": 529806.8, "n": 6488550.6, "yawDeg": 70, "lengthM": 3.4, "topM": 0.75,
     "note": "About 3.3 x 2.8 m: lidar top 82.9 m, highest ground under it 82.2 m (1 m lower downhill)."},
    {"id": "h6-tee-klippa-d", "rock": "Rock_05_cut", "e": 529812.3, "n": 6488552.1, "yawDeg": 20, "lengthM": 4.6, "topM": 0.8,
     "note": "Eastmost, nearest the forward tee: about 3.7 x 4.4 m, lidar top 83.3 m, highest ground under it 82.5 m."},
    {"id": "h6-tee-klippa-s1", "rock": "Rock_06", "e": 529794.2, "n": 6488560.4, "yawDeg": 60, "lengthM": 1.6, "topM": 0.4,
     "note": "Small stone 5 m NW of A."},
    {"id": "h6-tee-klippa-s2", "rock": "Rock_07", "e": 529803.2, "n": 6488550.3, "yawDeg": 120, "lengthM": 2.4, "topM": 0.5,
     "note": "Low stone SW of C."},
    {"id": "h6-tee-klippa-s3", "rock": "Rock_04", "e": 529809.6, "n": 6488549.6, "yawDeg": 40, "lengthM": 1.8, "topM": 0.5,
     "note": "Small stone between C and D."},
]
# Field stones spread over the tree area right of hole 1's fairway, north of its fairway bunker (Marcus,
# 2026-10-09: "lots of smaller rocks here spread over this area"). Pale blobs with a shadow to the NW in the 2023
# ortho (leaf-off): (E, N, length m, rock). Heights are not measured (1 lidar point per m2): topM = 0.4 x length.
H1_TREE_STONES = [
    (529944.8, 6487696.3, 2.6, "Rock_06"), (529937.5, 6487704.5, 1.4, "m_rock_01"), (529932.5, 6487707.3, 1.5, "m_rock_02"),
    (529939.7, 6487704.3, 0.7, "s_rock_01"), (529940.0, 6487708.8, 0.6, "s_rock_02"), (529928.7, 6487721.2, 1.4, "m_rock_03"),
    (529928.8, 6487717.7, 1.6, "Rock_04"), (529935.5, 6487717.7, 1.0, "s_rock_03"), (529938.7, 6487718.3, 0.7, "s_rock_04"),
    (529934.7, 6487715.2, 0.6, "s_rock_05"), (529931.2, 6487711.3, 0.6, "s_rock_06"), (529932.7, 6487702.0, 0.8, "s_rock_01"),
    (529923.2, 6487721.0, 1.5, "m_rock_01"), (529917.5, 6487710.1, 1.2, "m_rock_02"), (529913.7, 6487726.5, 1.0, "s_rock_02"),
    (529916.0, 6487744.2, 2.2, "Rock_07"), (529921.05, 6487738.5, 2.6, "Rock_04"), (529906.2, 6487755.6, 3.2, "Rock_03_cut"),
    (529904.3, 6487752.4, 1.6, "m_rock_03"), (529928.2, 6487753.1, 1.0, "s_rock_03"), (529927.2, 6487741.4, 1.4, "m_rock_01"),
    (529935.3, 6487748.8, 1.0, "s_rock_04"), (529936.6, 6487750.7, 1.3, "m_rock_02"), (529936.9, 6487747.2, 1.0, "s_rock_05"),
]
H1_TREE_KLIPPOR = [{"id": "h1-tree-stone-%02d" % (i + 1), "rock": rock, "e": e, "n": n, "yawDeg": (i * 137) % 360,
                    "lengthM": length, "topM": round(0.4 * length, 2)}
                   for i, (e, n, length, rock) in enumerate(H1_TREE_STONES)]
# Rocks found by the course-wide scan of 2026-10-10 (grey in both the 2023 and 2025 ortho, or standing up in the raw
# lidar, within 35 m of play) and looked at by eye; Marcus: "All of them". (E, N, length m, top m, yawDeg, rock),
# read off the 2023 ortho; tops judged from size and shadow, not measured.
SURVEY_STONES = {
    "h12": [   # hole 12: the boulder left of the fairway, the stones round the green, two along the right rough
        (529979.9, 6487163.0, 3.5, 1.4, 30, "Rock_01_cut"), (529966.5, 6487374.7, 2.0, 0.8, 80, "Rock_06"),
        (529963.8, 6487375.3, 1.0, 0.4, 10, "s_rock_01"), (530035.8, 6487351.6, 1.5, 0.6, 50, "m_rock_01"),
        (530038.9, 6487350.0, 1.3, 0.5, 120, "m_rock_02"), (530037.4, 6487349.0, 1.2, 0.5, 200, "s_rock_03"),
        (529937.6, 6487339.6, 2.0, 0.8, 140, "Rock_07"), (530042.6, 6487417.2, 1.5, 0.6, 20, "m_rock_03"),
        (530043.6, 6487415.7, 1.2, 0.5, 100, "s_rock_02"), (530043.1, 6487429.3, 1.5, 0.6, 160, "m_rock_01"),
        (530031.0, 6487414.1, 1.0, 0.4, 60, "s_rock_04"), (530046.8, 6487401.0, 1.2, 0.5, 300, "s_rock_05"),
        (530045.7, 6487396.8, 1.0, 0.4, 240, "s_rock_06"), (530013.8, 6487254.5, 1.5, 0.6, 90, "m_rock_02"),
        (530038.1, 6487211.1, 1.5, 0.6, 30, "m_rock_03"),
    ],
    "h4-tee": [   # 20 m south of hole 4's back tees: two big boulders (8 x 4.5 m and 5.5 x 4 m) and the stones round them
        (529747.0, 6487834.5, 8.5, 2.0, 45, "Rock_01"), (529754.25, 6487837.75, 5.5, 1.6, 80, "Rock_03"),
        (529756.0, 6487844.75, 1.6, 0.6, 0, "m_rock_01"), (529741.75, 6487846.75, 1.5, 0.6, 130, "m_rock_02"),
        (529743.5, 6487844.25, 1.2, 0.5, 40, "s_rock_01"), (529741.5, 6487852.75, 2.2, 0.8, 100, "Rock_04"),
        (529735.5, 6487828.0, 2.2, 0.9, 70, "Rock_06"), (529733.0, 6487828.0, 1.0, 0.4, 0, "s_rock_02"),
        (529731.25, 6487841.75, 1.3, 0.5, 20, "s_rock_03"), (529732.5, 6487832.5, 1.0, 0.4, 200, "s_rock_04"),
    ],
    "h10-heap": [   # the stone heap (a cleared-field cairn, about 9 x 19 m) on the rough island east of hole 10
        (530257.5, 6487344.5, 2.4, 0.9, 10, "Rock_04"), (530259.25, 6487345.5, 2.0, 0.8, 120, "Rock_06"),
        (530257.0, 6487342.25, 1.8, 0.8, 60, "m_rock_01"), (530259.5, 6487342.5, 2.6, 1.0, 200, "Rock_07"),
        (530258.0, 6487340.25, 2.2, 1.1, 150, "Rock_04"), (530260.0, 6487339.5, 1.8, 0.8, 300, "m_rock_02"),
        (530257.0, 6487338.0, 2.0, 0.9, 90, "Rock_06"), (530259.25, 6487337.0, 2.4, 1.1, 30, "Rock_07"),
        (530261.25, 6487336.5, 1.6, 0.6, 250, "m_rock_03"), (530258.0, 6487335.0, 2.0, 0.8, 170, "Rock_04"),
        (530260.0, 6487334.0, 1.8, 0.7, 70, "m_rock_01"), (530258.5, 6487331.75, 1.6, 0.6, 320, "m_rock_02"),
        (530256.0, 6487340.5, 1.4, 0.5, 220, "m_rock_03"),
    ],
    "se": [   # single boulders in the open rough of the south-east holes, each with a mown ring round it
        (530290.75, 6486961.75, 3.0, 1.2, 40, "Rock_03_cut"), (530188.75, 6486919.75, 2.5, 1.0, 110, "Rock_01_cut"),
        (530179.7, 6486890.8, 2.5, 1.0, 20, "Rock_06"),
    ],
}
SURVEY_KLIPPOR = [{"id": "%s-stone-%02d" % (group, i + 1), "rock": rock, "e": e, "n": n, "yawDeg": yaw, "lengthM": length, "topM": top}
                  for group, stones in SURVEY_STONES.items() for i, (e, n, length, top, yaw, rock) in enumerate(stones)]
PLACED += [dict({k: v for k, v in r.items() if k != "rock"}, prefab=NM + "Rocks/Prefabs/prefab_%s.prefab" % r["rock"], tint=OUTCROP_TINT, materialFloats=OUTCROP_MATT)
           for r in PATH_KLIPPOR + H6_TEE_KLIPPOR + H1_TREE_KLIPPOR + SURVEY_KLIPPOR]
# The boulder across the path from hole 13's middle tee, the hole 13 sign in front of it (photo cddccbea: ~9 m across,
# 4-5 m high, most of it under ivy; the edited DEM has it as the knoll SW of the path, top 89.1 m at 529941, 6487469).
# First built as the Blender boulder_ivy, an even green dome (Marcus, 2026-10-10: "It is ugly"): now one of the
# pack's plain rocks sunk into the slope 13 m long, centred on the knoll's 5.5 m NE face and sunk into it, top level with the crest (Marcus: "scaled up a bit and sunk into the hill") (the lidar has the boulder as that face). A rock centred on the lip hangs out over the drop and shows its flat underside: its pivot must be under the lowest ground it covers, so it is big enough to reach from the foot to the crest.
PLACED += [{"id": "h13-ivy-boulder", "prefab": NM + "Rocks/Prefabs/prefab_Rock_01.prefab",
            "tint": OUTCROP_TINT, "materialFloats": OUTCROP_MATT,
            "e": 529942.77, "n": 6487472.81, "yawDeg": 135, "lengthM": 15.0, "topM": -0.3,
            # set by hand in Unity 2026-10-10 (moved 1.8 m SW into the hill): pivot dy over the ground under it
            "pose": {"dy": -5.190, "euler": [0, 135, 0], "scale": [5.9415, 5.9415, 5.9415]}}]

WALLS = [
    {"id": "pond-klippa", "style": "cliff", "faceFromDeg": 220, "faceToDeg": 350,
     "faceDeg": 65, "jitterDeg": 5, "roundTopM": 6.0, "paintInsetM": 1.8, "placeStones": False,
     # Ground reshaping off (Marcus, 2026-09-29): the klippa stays the vanilla Blender-shaped mesh until the
     # Blender shaping tools take it on; the settings above are kept for then.
     "ground": False,
     "grassPatches": [[530096.5, 6487342.5, 2.8, 3.2], [530103.5, 6487329.5, 2.1, 2.6],
                      [530090.0, 6487326.5, 2.5, 1.8], [530085.5, 6487337.0, 2.0, 2.6],
                      [530101.5, 6487336.0, 2.8, 2.0], [530108.0, 6487347.5, 1.8, 2.0]],
     "outline": POND_KLIPPA,
     "note": "Marcus's marked pond-side rock, 2026-09-27: exposed granite inside the traced 2025 ortho outline; "
             "west-facing bank towards the fairway and pond, 2.2-5.7 m high in the edited lidar DEM."},
    {"id": "h13-front-tee", "centre": (529933.2, 6487506.9), "fromDeg": 252, "toDeg": 90,
     "note": "Hole 13 front tee: the whole downhill side, from the path (W) round the north to the NE; 1-2.5 m. "
             "Photo c219a56f shows three courses on the NE."},
    {"id": "h13-middle-tee", "centre": (529964.3, 6487483.7), "fromDeg": 296, "toDeg": 38,
     "note": "Hole 13 middle tee: the north side, 0.7-2.4 m, turning at the west end (photo 7176f1a2: two courses)."},
    {"id": "h4-klippa-a", "rocks": True, "faceFromDeg": 0, "faceToDeg": 150, "outline": H4_KLIPPA,
     "ground": False,  # no rock paint on the mesh under the rocks (as pond-klippa, 2026-09-29)
     "note": "Hole 4: klippa A, the rock knoll's face towards the fairway (3.5-4.4 m in the lidar, 57 deg; Marcus: "
             "~70 deg, 60-80 natural). Bare mossy granite on the 2023 leaf-off photo."},
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


def trace_face(wall, defaults, res=0.5):
    """A cliff's stations from its steep ground: cells steeper than 30 deg inside the outline (1.5 m buffer) that
    fall towards faceFromDeg..faceToDeg (compass, clockwise), binned every metre along their main axis; from each
    bin's middle the foot is where the ground stops falling faster than 0.3 m/m outward, the top the same inward."""
    from scipy import ndimage
    poly = wall["outline"]
    es, ns = [q[0] for q in poly], [q[1] for q in poly]
    e0, e1, n0, n1 = min(es) - 10, max(es) + 10, min(ns) - 10, max(ns) + 10
    W, H = int((e1 - e0) / res), int((n1 - n0) / res)
    xs = e0 + (np.arange(W) + 0.5) * res; ys = n1 - (np.arange(H) + 0.5) * res
    Z = np.array([[h(x, y) for x in xs] for y in ys])
    Zs = ndimage.gaussian_filter(Z, 1.0)
    gy, gx = np.gradient(Zs, res)
    dzde, dzdn = gx, -gy
    slope = np.degrees(np.arctan(np.hypot(dzde, dzdn)))
    aspect = (np.degrees(np.arctan2(-dzde, -dzdn)) + 360) % 360
    E, N = np.meshgrid(xs, ys)
    inside = np.zeros(E.shape, bool)
    for i in range(len(poly)):
        (x1, y1), (x2, y2) = poly[i], poly[(i + 1) % len(poly)]
        cond = ((y1 > N) != (y2 > N)) & (E < (x2 - x1) * (N - y1) / ((y2 - y1) if y2 != y1 else 1e-9) + x1)
        inside ^= cond
    inside = ndimage.binary_dilation(inside, iterations=int(1.5 / res))
    a0, a1 = wall["faceFromDeg"], wall["faceToDeg"]
    facing = ((aspect - a0) % 360) <= ((a1 - a0) % 360)
    m = inside & facing & (slope > 30)
    pe, pn, pa = E[m], N[m], aspect[m]
    c = np.array([pe.mean(), pn.mean()])
    axis = np.linalg.svd(np.c_[pe, pn] - c, full_matrices=False)[2][0]
    t = (np.c_[pe, pn] - c) @ axis
    mids = []
    for b in np.arange(t.min(), t.max() + 1e-6, 1.0):
        sel = np.abs(t - b) <= 0.75
        if sel.sum() < 2: continue
        asp = math.degrees(math.atan2(np.sin(np.radians(pa[sel])).mean(), np.cos(np.radians(pa[sel])).mean())) % 360
        mids.append((pe[sel].mean(), pn[sel].mean(), asp))
    # smooth the line and the facing along it
    sm = []
    for i in range(len(mids)):
        win = mids[max(0, i - 1):i + 2]
        sm.append((np.mean([q[0] for q in win]), np.mean([q[1] for q in win]),
                   math.degrees(math.atan2(np.mean([math.sin(math.radians(q[2])) for q in win]), np.mean([math.cos(math.radians(q[2])) for q in win]))) % 360))
    toe_pts, lip_pts, dem_h = [], [], []
    for (me, mn, asp) in sm:
        ux, uy = math.sin(math.radians(asp)), math.cos(math.radians(asp))
        def walk(sign):
            d = 0.0
            while d < 8.0:
                z0 = h(me + sign * ux * d, mn + sign * uy * d); z1 = h(me + sign * ux * (d + STEP), mn + sign * uy * (d + STEP))
                if (z0 - z1) * sign / STEP < FACE_FALL: break
                d += STEP
            return d
        dout, din = walk(1), walk(-1)
        toe = (me + ux * dout, mn + uy * dout); lip = (me - ux * din, mn - uy * din)
        hh = h(*lip) - h(*toe)
        if hh < defaults["minFaceM"]: continue
        toe_pts.append([round(toe[0], 2), round(toe[1], 2)]); lip_pts.append([round(lip[0], 2), round(lip[1], 2)]); dem_h.append(round(hh, 2))
    return toe_pts, lip_pts, dem_h


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--out", default="", help="also write stone-walls.json into this folder (the Unity course folder)")
    a = p.parse_args()
    walls = []
    outcrops = []
    for w in WALLS:
        toe, lip, dem_h = trace_face(w, DEFAULTS) if "faceFromDeg" in w else trace(w, DEFAULTS)
        length = sum(math.dist(toe[i], toe[i + 1]) for i in range(len(toe) - 1))
        print("%-16s %3d stations, %5.1f m along the foot, bank %.2f-%.2f m" % (w["id"], len(toe), length, min(dem_h), max(dem_h)))
        if w.get("rocks"):
            rocks = outcrop_rocks(w, toe, lip, sum(map(ord, w["id"])))
            outcrops.extend(rocks)
            print("%-16s -> %d outcrop rocks" % (w["id"], len(rocks)))
        entry = {"id": w["id"], "note": w["note"], "seed": sum(map(ord, w["id"])), "toe": toe, "lip": lip, "demH": dem_h}
        if w.get("rocks"):
            entry.update(style="cliff", paintOnly=True, paintInsetM=0.8)
        for key in ("ground", "paintOnly", "paintInsetM", "grassPatches", "faceDeg", "jitterDeg", "roundTopM", "placeStones"):
            if key in w: entry[key] = w[key]
        if "style" in w:
            entry["style"] = w["style"]
        if "outline" in w:
            entry["outline"] = [[round(e, 2), round(n, 2)] for e, n in w["outline"]]
        walls.append(entry)
    spec = {"format": "golfmap-walls-v1", "source": "docs/gspro/vreta/stone-walls.gen.py", "stonesFolder": STONES_FOLDER,
            "physicMaterial": PHYSIC_MATERIAL, "stoneSets": STONE_SETS, "defaults": DEFAULTS, "styles": STYLES, "walls": walls, "boulders": PLACED + h4_placed() + outcrops,
            "placedColors": {key: [0.70, 0.75, 0.61] for key in
                             ["pond-klippa", "pond-klippa-slab-1", "pond-klippa-slab-2", "pond-klippa-slab-3"]}}
    outs = [(os.path.join(HERE, "stone-walls.json"), spec), (os.path.join(HERE, "wall-stones.json"), stones_spec())]
    if a.out:
        outs.append((os.path.join(a.out, "stone-walls.json"), spec))
    for path, d in outs:
        with open(path, "w", encoding="utf-8", newline="\n") as f:
            f.write(json.dumps(d, indent=1) + "\n")
        print("wrote", path)


if __name__ == "__main__":
    main()
