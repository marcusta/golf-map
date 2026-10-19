"""Omberg's stone edges, for Unity's golfmap.walls.build (GolfMapWalls.cs): the rough boulder revetments along the
hole 14 pond's edge towards the green, and along the pond between holes 18 and 1 (south and west sides, north tip).

    pipeline/.venv/Scripts/python.exe docs/gspro/ombergs-golfklubb/stone-walls.gen.py [--out <Unity course folder>]
        -> docs/gspro/ombergs-golfklubb/stone-walls.json (+ <out>/stone-walls.json): the walls, for golfmap.walls.build
        -> docs/gspro/ombergs-golfklubb/wall-stones.json: the boulders, for blender/tools/build_props.py

The stones are Vreta's rounded field boulders (docs/gspro/vreta/stone-walls.gen.py BOULDERS, the props kit's
granite with moss on faces pointing up), built into Omberg's own Walls/Stones:
    blender -b --factory-startup --python blender/tools/build_props.py -- --spec docs/gspro/ombergs-golfklubb/wall-stones.json
        --out "D:/gspro_courses/omberg_v4_2025_12_02/Assets/GolfMap/Omberg/Walls/Stones"

The pond edge is not traced from the DEM, as Vreta's tee walls are: the pond is dug (water-digs, Deep Water, 1 m,
32 deg banks; `bun run terrain:generate -- "Ombergs Golfklubb" water-digs --feature hole_14_53 --dry-run`) and its
edge is the drawn outline. Each station is a point of the dug outline (the dig edit's own ring, read from the
database): the foot TOE_IN_M inside it under the water, the top edge LIP_OUT_M outside it on the bank. Unity
measures the bank between them on the course meshes (the pond's bed mesh and the rough) and, with `ground`, raises
it into a steep face painted as stone (GolfMapWallGround: raised, never lowered; the paint keeps the tall grass and
the Stix blades off the stones), so the stones go from under the water up over the edge.

Sources, 2026-10-16: the 2025 and 2023 orthos (0.25 m) show grey rounded stones along the pond's north edge from its
west tip (where the creek leaves it, towards the green) east to about E 477357, and round the tip; the east and
south sides are grass to the water. Marcus: "I delen som vetter mot green ser det ut att vara grovt stensatt kant".
Coordinates: EPSG:3006 metres.
"""
import argparse
import json
import math
import os
import random
import sqlite3

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..", "..", "..")
DB = os.path.join(ROOT, "data", "app.sqlite")
COURSE_ID = "ce4629e1-042d-4ea7-b31e-9226e2742a56"

STONES_FOLDER = "Walls/Stones"  # under the Unity course folder (Assets/GolfMap/Omberg)
PHYSIC_MATERIAL = "Assets/Resources/Physics/GSPstone.physicMaterial"
# Rounded field stones (Vreta's BOULDERS): (width, height) as a fraction of the length.
BOULDERS = [
    (0.82, 0.72), (0.9, 0.8), (0.62, 0.52), (0.95, 0.88), (0.78, 0.6),
    (0.86, 0.76), (0.66, 0.66), (0.92, 0.62), (0.8, 0.84), (0.58, 0.5),
]
# Dry-stone wall stones (Vreta's WALL_STONES, blockier: Marcus wanted the wall tighter): (depth, height) as a fraction
# of the length, exponent; a flat face and flat beds cut by WALL_STONE_FLATS.
WALL_STONES = [
    (0.7, 0.55, 3.8), (0.65, 0.5, 3.4), (0.75, 0.62, 4.2), (0.6, 0.45, 3.6), (0.8, 0.6, 4.0),
    (0.7, 0.5, 3.3), (0.66, 0.58, 3.8), (0.72, 0.48, 4.4), (0.62, 0.52, 3.5), (0.78, 0.56, 3.9),
]
WALL_STONE_FLATS = [
    {"dir": [0, 1, 0], "at": 0.82, "keep": 0.12},   # the face
    {"dir": [0, 0, 1], "at": 0.85, "keep": 0.3},    # top bed
    {"dir": [0, 0, -1], "at": 0.85, "keep": 0.3},   # bottom bed
]
STONE_SETS = {"rose": [{"asset": "boulder_%d" % i, "weight": 1} for i in range(1, len(BOULDERS) + 1)],
              "wall": [{"asset": "wallstone_%d" % i, "weight": 1} for i in range(1, len(WALL_STONES) + 1)]}

TOE_IN_M = 0.6    # the foot this far inside the outline: under the water, on the dug bank
LIP_OUT_M = 1.0   # the top edge this far outside it, on the bank above the water
STATION_M = 0.5   # stations along the outline
LINE_TOE_OUT_M = 1.0    # a drawn wall: the foot this far out from its line (the terrain edit's face runs 0.3 m, the meshes
#                         smear it over a grid step, 0.74 m; GolfMapWallGround raises it back into a face) ...
LINE_LIP_IN_M = 0.15    # ... and the top edge this far back, on the plateau

DEFAULTS = {
    "style": "rose",
    "ground": True,       # the bank raised into a steep stone face (the dug bank under it is 32 deg)
    "faceDeg": 55,
    "baseInM": 0.1,       # the face starts this far in from the foot
    "beyondM": 0.4,       # the edge's height: the highest of the lip and this far past it
    "taperM": 1.2,        # the face fades in and out over this at the ends
    "subdivideM": 0.3,
    "groundChannel": "blue",
    # the face drawn as Vreta's walls are: OPCD's mossy rock channel with continuous granite detail
    "stoneMaterial": "Assets/Resources/OPCD MAHS Resources/ExtraMaterials/OPCD MAHS Mossy Rock.mat",
    "stoneMaterialChannel": "red",
    "stoneAlbedo": "Assets/Rocks and Boulders/Rocks/Source/Textures/Rockdetail4.tif",
    "stoneNormal": "Assets/Rocks and Boulders/Rocks/Source/Textures/Rockdetail4_nmp.tif",
    "stoneTileM": 6.0,
    "stoneColor": [0.56, 0.57, 0.56],
    "paintFeatherM": 0.2,
    "minFaceM": 0.2,      # a pond edge is low: stones wherever the bank rises this much from the foot
}
STYLES = {
    # A dry-stone wall (Vreta's "wall"): courses of flat-faced stones fitted into the face's plane. Hole 9's green wall
    # (Marcus's photos, 2026-10-19): about three courses of grey blocks 0.4-1 m long in a metre of wall, near vertical,
    # the green's tall grass hanging over the top.
    "wall": {
        "stoneSet": "wall",
        "faceDeg": 80,
        "baseInM": 0.05,
        "beyondM": 1.2,              # the edge's height this far past the lip: the meshes' smeared edge still falls at 0.4 m
        "baseCourseM": [0.4, 0.55],  # course heights up the face: the bottom course's ...
        "courseM": [0.3, 0.42],      # ... and the rest
        "stoneHeightVar": [1.05, 1.25],  # stones overfill their course (Marcus: tighter)
        "bedJitterM": 0.05,
        "lengthRatio": [1.6, 2.8],   # a stone's length / its course height: long blocks (photo)
        "maxStoneM": 1.3,
        "depthM": [0.45, 0.7],
        "faceProudM": 0.12,          # out of the raised face: the meshes' uneven face swallowed stones set 3 cm proud
        "faceJitterM": 0.03,
        "spinDeg": 3,
        "gapM": -0.25,                # neighbours overlap: no dark joints between them (Marcus: tighter)
        "sinkM": 0.1,
        "topMarginM": 0.12,
        "capM": 0.0,                 # flush with the top: the grass hangs over it
        "minTopCourseM": 0.15,
    },
    # The wall round a raised tee: hole 9's north tee (Marcus's photo, 2026-10-19): near vertical, steeper than Vreta's
    # hole 13 tee walls and of smaller stones, five or six courses in 1-1.7 m.
    "teewall": {
        "style": "wall",              # the builder: a dry-stone wall (GolfMapWalls)
        "stoneSet": "wall",
        "faceDeg": 86,
        "baseInM": 0.05,
        "beyondM": 1.2,               # the plateau's height 1.2 m back: nearer, the meshes' smeared edge is still falling
        "baseCourseM": [0.3, 0.4],
        "courseM": [0.2, 0.3],
        "stoneHeightVar": [1.05, 1.2],  # a stone fills its course and overlaps the next (Marcus: too many gaps)
        "bedJitterM": 0.02,
        "lengthRatio": [1.3, 2.4],
        "maxStoneM": 0.7,
        "depthM": [0.35, 0.55],
        "faceProudM": 0.1,             # clear of the raised face mesh: nearer, it swallows whole stones
        "faceJitterM": 0.02,
        "spinDeg": 2,
        "gapM": -0.12,                 # neighbours overlap: no dark joints
        "sinkM": 0.08,
        "topMarginM": 0.08,
        "capM": 0.0,
        "minTopCourseM": 0.12,
    },
    # A pond's edge laid as a dry-stone wall: hole 14 (Marcus's photo, 2026-10-19: "more like the walls on 9 than round
    # stones"): two courses of flat-faced grey blocks 0.5-1 m long from the water up to the grass, near vertical, the
    # top flush with the bank. No terrain edit: the dug bank is raised into the face, so the edge's height is near the lip.
    "pondwall": {
        "style": "wall",
        "stoneSet": "wall",
        "faceDeg": 78,
        "baseInM": 0.05,
        "beyondM": 0.4,
        "baseCourseM": [0.35, 0.45],
        "courseM": [0.28, 0.38],
        "stoneHeightVar": [1.05, 1.2],
        "bedJitterM": 0.04,
        "lengthRatio": [1.5, 2.5],
        "maxStoneM": 1.1,
        "depthM": [0.4, 0.6],
        "faceProudM": 0.1,
        "faceJitterM": 0.03,
        "spinDeg": 3,
        "gapM": -0.2,
        "sinkM": 0.1,
        "topMarginM": 0.1,
        "capM": 0.0,
        "minTopCourseM": 0.15,
    },
    # A rough revetment: one or two courses of rounded boulders, packed, from under the water over the edge.
    "rose": {
        "stoneSet": "rose",
        "baseStoneM": [0.7, 1.1],    # along-edge length of a bottom stone (the ortho: 0.5-1 m stones)
        "stoneM": [0.5, 0.8],        # the course above
        "heightScale": [0.85, 1.1],
        "courseStepM": 0.35,
        "followBank": 1.0,
        "proudFrac": 0.35,
        "leanDeg": 8,
        "spinDeg": 18,
        "sinkM": 0.15,
        "gapM": -0.15,
        "topMarginM": 0.15,
        "capM": 0.12,                # a stone tops the edge by up to this: the ortho shows them proud of the grass
        "maxFill": 0,
    },
}

# feature: the pond (water feature number 83, shape hole_14_53); from/to: the stretch of its outline, from the point
# nearest `start` to the one nearest `end`, the way that passes `via`. Or `line`: the wall's top edge drawn directly
# (EPSG:3006), its water on the left of the line's direction; the foot LINE_TOE_OUT_M out from it (the terrain edit's
# face, `bun run terrain:wall`), the top edge LINE_LIP_IN_M back on the plateau.
WALLS = [
    {"id": "h14-pond-edge", "style": "pondwall", "feature": "b2388429-8a29-41d6-9396-559dcfd5f18c",
     "start": (477339.0, 6457146.5), "via": (477336.6, 6457150.5), "end": (477358.0, 6457157.5),
     "note": "Hole 14 pond: the rough stone edge towards the green, round the west tip (the creek's outlet) and "
             "along the north edge to E 477358 (2025 and 2023 orthos)."},
    # The pond between holes 18, 1 and tee 10 (water feature 77, others_4d; Deep Water, 2 m, 34 deg, 45 deg above).
    {"id": "p77-south-west", "feature": "4530bf16-35ec-4c82-b78b-f139db337b9e",
     "start": (477682.7, 6457395.2), "via": (477652.3, 6457383.8), "end": (477643.7, 6457447.0),
     "note": "Pond between 18 and 1: rounded boulders along the south edge (dark in the 2023 ortho, grey in 2025), "
             "round the south-west corner and up the west side past the bulge to N 6457447."},
    # The pond behind hole 13's green (shape hole_13_234; Deep Water, 1.3 m, 30 deg, 45 deg above, water 110.38 m):
    # a ring of rounded boulders all round: west, north and east from the 2025 ortho and Marcus's tee photo, the
    # south side added at his request (2026-10-18).
    {"id": "h13-pond-edge", "feature": "ec66ad78-2d56-46b7-92b8-cd35c58745a8",
     "start": (477670.0, 6456926.3), "via": (477683.1, 6456939.7), "end": (477696.3, 6456928.1),
     "note": "Pond behind hole 13's green: the stone rim from the south-west corner up the west side, along the "
             "north edge and down the east side (2025 ortho; boulders 0.5-1 m)."},
    {"id": "h13-pond-edge-south", "feature": "ec66ad78-2d56-46b7-92b8-cd35c58745a8",
     "start": (477696.3, 6456928.1), "via": (477688.0, 6456922.9), "end": (477670.0, 6456926.3),
     "note": "Pond behind hole 13's green: the south side back to the south-west corner, so the rim runs all round "
             "(Marcus 2026-10-18: the back was missing; the 2025 ortho shows grass and a dark edge there, the 2023 "
             "ortho a thin shadowed lip)."},
    # Hole 9: the dry-stone wall along the green's north side above pond 573 (shape hole_9_23d), on Marcus's line
    # (2026-10-19). The ground is shaped in the DEM by the terrain edit wall:hole9-green (the same line): straight down
    # into the water in the west, about a metre over a sloping grass terrace in the east (his drone and bridge photos).
    {"id": "h9-green-wall", "style": "wall",
     "line": [(477711.75, 6457792.3), (477714.35, 6457793.75), (477717.65, 6457795.15), (477721.4, 6457796.05),
              (477725.15, 6457796.6), (477728.5, 6457796.6), (477731.85, 6457796.25), (477735.15, 6457795.45),
              (477738.1, 6457794.0), (477740.6, 6457792.15), (477742.15, 6457790.35)],
     "note": "Hole 9: the dry-stone wall along the green's north side, on Marcus's line (photos from the drone and "
             "the bridge, 2026-10-19)."},
    # Hole 9's north tee (tee 392): the wall round its west end and north side, on Marcus's line (2026-10-19). The
    # ground is shaped by the terrain edit wall:hole9-north-tee (the same line): 1.3-1.7 m north, about 1 m west.
    {"id": "h9-north-tee-wall", "style": "teewall",
     "line": [(477592.42, 6457801.12), (477592.63, 6457804.61), (477592.92, 6457808.23), (477593.49, 6457809.83),
              (477594.49, 6457810.7), (477597.2, 6457810.85), (477601.49, 6457810.55), (477607.2, 6457810.12),
              (477611.49, 6457809.68), (477614.35, 6457808.96), (477616.85, 6457807.87), (477618.78, 6457806.2),
              (477620.99, 6457803.3)],
     "note": "Hole 9's north tee: the near-vertical dry-stone wall round its west end and north side, on Marcus's "
             "line (photo, 2026-10-19)."},
    # Hole 9, fall E (Marcus 2026-10-19): the stone sill the upper pond 576's water falls over into 573, 5 m west of the
    # bridge; the ground is the terrain edit sill:h9-fall-e (flat at the upper water, 0.8 m wide), the line its west edge.
    {"id": "h9-fall-e-sill", "style": "wall", "beyondM": 0.1, "capM": 0.25,   # up to the sill and a little over (Marcus: much higher); the bay behind is water
     "line": [(477736.13, 6457800.36), (477735.5, 6457805.5), (477734.87, 6457810.64)],   # 1.5 m into both banks (Marcus: wider)
     "note": "Hole 9: the stone sill of fall E between the upper pond (576) and 573, west of the bridge (photo from the west)."},
    {"id": "p77-north-tip", "feature": "4530bf16-35ec-4c82-b78b-f139db337b9e",
     "start": (477675.8, 6457494.0), "via": (477683.8, 6457497.0), "end": (477694.5, 6457487.4),
     "note": "Pond between 18 and 1: the grey stone rim round the north tip (2025 and 2023 orthos)."},
]


# Angular boulders for the heap, the box and hole 1's loose stones (Marcus's photos, 2026-10-18).
def angular_flats(seed, n=9):
    """n flat faces at random directions, cut deep (at 0.7-0.8) and nearly sawn (keep 0.04-0.12): a blocky, broken stone."""
    rnd = random.Random(seed)
    out = []
    for _ in range(n):
        z, a = rnd.uniform(-0.25, 0.9), rnd.uniform(0, 2 * math.pi)
        r = math.sqrt(1 - z * z)
        out.append({"dir": [round(r * math.cos(a), 3), round(r * math.sin(a), 3), round(z, 3)],
                    "at": round(rnd.uniform(0.7, 0.8), 2), "keep": round(rnd.uniform(0.04, 0.12), 2)})
    return out


# (sy, sz, exponent, lumps) as a fraction of the length: grey granite, patchy pale grey-green lichen, a few
# yellow-orange spots (props_kit material granite_lichen).
HEAP_STONES = [
    (0.82, 0.70, 3.0, 0.35), (0.76, 0.66, 3.3, 0.30), (0.90, 0.74, 2.8, 0.40), (0.70, 0.62, 3.4, 0.30),
    (0.86, 0.80, 3.0, 0.35), (0.78, 0.68, 3.2, 0.32), (0.92, 0.72, 2.8, 0.40), (0.74, 0.76, 3.1, 0.35),
    (0.88, 0.64, 3.3, 0.30),
]
# Stones of the box at hole 3: pale grey-beige (granite_beige), blocky, lying and standing on end (taller than long).
BOX_FLAT = [(0.82, 0.72, 3.0, 0.3), (0.74, 0.62, 3.3, 0.3), (0.90, 0.70, 2.8, 0.35), (0.70, 0.66, 3.4, 0.28),
            (0.86, 0.78, 3.0, 0.3), (0.78, 0.64, 3.2, 0.3)]
BOX_TALL = [(0.8, 2.0, 3.0, 0.3), (0.7, 2.3, 3.3, 0.28), (0.85, 1.9, 3.0, 0.3)]


def _poly_from_db(feature_no):
    """A feature's outer ring as a shapely polygon (EPSG:3006), or None without the database or shapely."""
    try:
        from shapely.geometry import Polygon
        db = sqlite3.connect(DB)
        row = db.execute("select geometry_json from course_features where course_id = ? and feature_no = ?",
                         (COURSE_ID, feature_no)).fetchone()
        pts = [(p["x"], p["y"]) for p in json.loads(row[0])["rings"][0]["points"]]
        return Polygon(pts)
    except Exception:
        return None


# Loose boulders in the grass among the rock slabs under the trees NE of hole 1's green (Marcus's photo,
# 2026-10-18: a few dark rounded boulders, 0.5-1.2 m, sitting in the grass; one beside the middle tree's trunk, one in
# front of the mound; round 2: bigger and rougher, the heap stones' angular lichen granite). Only the one on the NE
# slab is seen in the 2023 ortho (dark, with its shadow); the others are placed from the photo. e/n = centre
# (EPSG:3006), yawDeg = bearing of the long side, lengthM, topM = top over the highest ground under it.
H1_BOULDERS = [
    {"id": "h1-trees-ne-boulder-1", "asset": "heap_8", "e": 477843.7, "n": 6457341.0, "yawDeg": 40, "lengthM": 1.6, "topM": 0.85,
     "note": "On the little slab NE of the tree group: the dark boulder with its shadow in the 2023 ortho."},
    {"id": "h1-trees-ne-boulder-2", "asset": "heap_2", "e": 477836.8, "n": 6457315.2, "yawDeg": 100, "lengthM": 1.2, "topM": 0.65,
     "note": "In front of the mound, south of the big slab (photo: the boulder centre-left of the mound)."},
    {"id": "h1-trees-ne-boulder-3", "asset": "heap_5", "e": 477845.8, "n": 6457313.4, "yawDeg": 20, "lengthM": 1.1, "topM": 0.6,
     "note": "Beside the trunk of the middle tree (photo)."},
    {"id": "h1-trees-ne-boulder-4", "asset": "heap_4", "e": 477833.4, "n": 6457316.4, "yawDeg": 60, "lengthM": 0.85, "topM": 0.45,
     "note": "Small, lower left of the mound (photo)."},
    {"id": "h1-trees-ne-boulder-5", "asset": "heap_6", "e": 477830.4, "n": 6457318.6, "yawDeg": 150, "lengthM": 0.75, "topM": 0.4,
     "note": "Small, lower left of the mound (photo)."},
]


# Loose boulders on hole 16's rock round the big silver birch (Marcus's photo + video frame, 2026-10-18): the grey
# granite of slab 126's west lobe NW of the birch, seen from the hole 13 fairway to the left of the birch, with boulders
# on and between the slabs, and a few on the rim of slab 150 right at the birch. 1.0-1.5 m long, the heap stones' angular
# shapes in the darker hgrey_N variant (props_kit granite_lichen_dark: Marcus found granite_lichen too white against the
# slab; hole 1 and 2 keep granite_lichen). The first ones are seen as pale round stones in the 2023/2025 orthos (one on
# the lobe, two in the grass at its west edge by a shrub, two on the east slab); the rest are placed from the photo in
# groups of 2-4 on and around the slab. e/n = centre (EPSG:3006), yawDeg = bearing of the long side.
def _birch_boulders():
    rows = [  # asset, e, n, yaw, lengthM, note
        ("hgrey_5", 477608.1, 6457102.8, 30, 1.2, "Pale round boulder on the lobe's slab (2023 and 2025 orthos)."),
        ("hgrey_2", 477596.8, 6457101.9, 110, 1.0, "In the grass at the lobe's west edge, beside the shrub (ortho)."),
        ("hgrey_6", 477597.2, 6457103.9, 60, 1.0, "In the grass at the lobe's west edge, beside the shrub (ortho)."),
        ("hgrey_8", 477606.0, 6457100.2, 150, 1.5, "On the lobe's slab, the biggest of the band (photo)."),
        ("hgrey_1", 477603.5, 6457099.5, 80, 1.1, "On the lobe's slab (photo)."),
        ("hgrey_4", 477610.5, 6457098.0, 20, 1.0, "On the lobe's slab (photo)."),
        ("hgrey_9", 477609.3, 6457095.5, 125, 1.3, "On the lobe's south slab (photo)."),
        ("hgrey_3", 477606.5, 6457093.0, 45, 1.1, "On the lobe's south slab (photo)."),
        ("hgrey_7", 477620.6, 6457094.3, 95, 1.2, "Pale boulder on the east slab (ortho)."),
        ("hgrey_5", 477619.9, 6457093.0, 10, 1.0, "Pale boulder on the east slab (ortho)."),
        ("hgrey_3", 477621.3, 6457064.3, 70, 1.4, "Rim of slab 150, right of the birch's trunk; lidar returns here."),
        ("hgrey_6", 477622.6, 6457066.0, 130, 1.0, "Rim of slab 150, right of the birch's trunk."),
        ("hgrey_9", 477623.0, 6457080.5, 55, 1.3, "North end of slab 150; lidar returns here."),
        # round 2 (Marcus): more to the left of the birch, along the lobe's west edge and in the grass at it
        ("hgrey_2", 477599.3, 6457103.3, 75, 1.3, "Group A on the lobe's west rim."),
        ("hgrey_7", 477600.7, 6457102.4, 140, 1.0, "Group A on the lobe's west rim."),
        ("hgrey_4", 477600.0, 6457104.8, 35, 1.5, "Group A on the lobe's west rim."),
        ("hgrey_1", 477600.2, 6457097.4, 100, 1.2, "Group B in the grass south-west of the lobe."),
        ("hgrey_8", 477598.9, 6457096.6, 15, 1.0, "Group B in the grass south-west of the lobe."),
        ("hgrey_6", 477600.7, 6457095.8, 160, 1.4, "Group B in the grass south-west of the lobe."),
        ("hgrey_9", 477603.6, 6457106.4, 55, 1.1, "Group C at the lobe's north end."),
        ("hgrey_5", 477604.9, 6457105.5, 120, 1.5, "Group C at the lobe's north end."),
        ("hgrey_3", 477606.0, 6457106.6, 90, 1.0, "Group C at the lobe's north end."),
        ("hgrey_2", 477602.2, 6457092.2, 25, 1.3, "Group D at the lobe's south end, in the grass."),
        ("hgrey_7", 477601.3, 6457091.1, 105, 1.0, "Group D at the lobe's south end, in the grass."),
    ]
    return [{"id": "h16-birch-boulder-%02d" % (i + 1), "asset": a, "e": e, "n": n, "yawDeg": y, "lengthM": L,
             "topM": round(0.5 * L, 2), "note": note} for i, (a, e, n, y, L, note) in enumerate(rows)]


BIRCH_BOULDERS = _birch_boulders()


def h2_heap():
    """The stenrose at hole 2's tee (photo from the tee, 2026-10-18; round 2: 7-8 m long, 4-5 m deep, 3 m high, one dominant
    top stone of 2.5 m at the right = the north end). The 2023 and 2025 orthos show eight pale stones 1-1.5 m across at
    E 477847.7-477851, N 6457273.5-6457277.5 on the edge of the deep rough, 3 m from the tee's semi rough. Angular
    blocks (heap_N) in three layers on the lidar ground, no plateau: a ground ring whose tops run 0.8-1.5 m, a middle tier
    1.7-2.3 m, a crown 2.2-2.6 m and the dominant stone on top (topM = its top over the highest ground under it)."""
    rnd = random.Random(77)
    ce, cn = 477848.9, 6457275.4
    ang = math.radians(345)          # the long axis, bearing (NNW-SSE), so the heap stands across the line of sight from the tee
    ux, uy = math.sin(ang), math.cos(ang)
    A, B = 4.3, 2.7
    semi = _poly_from_db(91)
    placed, out = [], []

    def at(a, b):
        return ce + a * ux + b * uy, cn + a * uy - b * ux

    def stone(layer, count, scale, lo, hi, top_fn, factor):
        made, tries = 0, 0
        while made < count and tries < 3000:
            tries += 1
            a, b = rnd.uniform(-A, A) * scale, rnd.uniform(-B, B) * scale
            if (a / (A * scale)) ** 2 + (b / (B * scale)) ** 2 > 1.0:
                continue
            L = lo + (hi - lo) * rnd.random()
            e, n = at(a, b)
            if any(math.hypot(e - pe, n - pn) < factor * (L + pl) / 2 for pe, pn, pl in placed):
                continue
            if semi is not None:
                from shapely.geometry import Point
                if semi.distance(Point(e, n)) < 0.6 + 0.4 * L:
                    continue
            p = max(0.0, 1.0 - (a / A) ** 2 - (b / B) ** 2)
            placed.append((e, n, L))
            made += 1
            out.append((layer, "heap_%d" % (1 + rnd.randrange(len(HEAP_STONES))), e, n, rnd.randrange(360), round(L, 2),
                        round(top_fn(L, p, rnd), 2)))
    stone(0, 28, 1.0, 1.4, 2.2, lambda L, p, r: max(0.8, 0.6 * L) + 0.45 * p + 0.1 * r.random(), 0.5)
    stone(1, 14, 0.68, 1.5, 2.1, lambda L, p, r: 1.7 + 0.5 * p + 0.15 * r.random(), 0.45)
    stone(2, 6, 0.4, 1.3, 1.8, lambda L, p, r: 2.2 + 0.35 * p + 0.1 * r.random(), 0.42)
    e, n = at(0.42 * A, -0.2)
    out.append((3, "heap_3", e, n, 120, 2.6, 2.95))   # the dominant stone, about 2.5 m, on the right (north) side
    return out


H2_BOULDERS = [{"id": "h2-tee-stenrose-%02d" % (i + 1), "asset": a, "e": round(e, 2), "n": round(n, 2), "yawDeg": y,
                "lengthM": L, "topM": t, "note": "Stenrose NW of hole 2's tee (layer %d)." % layer}
               for i, (layer, a, e, n, y, L, t) in enumerate(h2_heap())]


# The stone box behind hole 3's tees (Marcus's video frame, 2026-10-18; the 2025 and 2023 orthos show it at
# E 478240.3-478250.6, N 6457621.0-6457640: a frame of grey blocks, the south wall 10.4 m and the west wall 10.5 m
# visible, the east side open, filled with a loose pile of pale granite stones 0.4-1.3 m. Round 2: all the stones
# inside the frame, packed so they touch, higher towards the middle (1.0-1.4 m, a few on end to 1.5 m); the frame
# straight square-ended blocks 0.32 m thick whose flat top stands 0.45 m over the ground.
BOX_E0, BOX_N0 = 478240.0, 6457621.0   # the frame's SW outer corner
BOX_BLOCKS = [("s%d" % i, BOX_E0 + 0.61 + 1.3 + 2.6 * i, BOX_N0 + 0.45, 90, 2.6) for i in range(4)] + \
             [("w%d" % i, BOX_E0 + 0.45, BOX_N0 + 0.29 + 1.12 + 2.24 * i, 0, 2.24) for i in range(5)]


def box_stones():
    """The pile: seeded dart-throwing, tight (a stone may not come nearer than 0.42 of the two lengths: they overlap a
    little, so none stands alone), higher towards the middle."""
    rnd = random.Random(404)
    e_lo, e_hi, n_lo, n_hi = BOX_E0 + 0.85, BOX_E0 + 10.5, BOX_N0 + 0.8, BOX_N0 + 10.6
    ce, cn, R = (e_lo + e_hi) / 2, (n_lo + n_hi) / 2, 5.6
    placed, out = [], []

    def profile(e, n):
        return max(0.0, 1.0 - (math.hypot(e - ce, n - cn) / R) ** 2)

    def throw(layer, count, pmin, lo, hi, tall, top_fn, factor):
        made, tries = 0, 0
        while made < count and tries < 8000:
            tries += 1
            L = lo + (hi - lo) * rnd.random() ** 1.2
            half = L * 0.5
            e, n = rnd.uniform(e_lo + half * 0.8, e_hi - half * 0.8), rnd.uniform(n_lo + half * 0.8, n_hi - half * 0.8)
            p = profile(e, n)
            if p < pmin:
                continue
            if any(math.hypot(e - pe, n - pn) < factor * (L + pl) / 2 for pe, pn, pl in placed):
                continue
            placed.append((e, n, L))
            made += 1
            k = rnd.randrange(len(BOX_TALL) if tall else len(BOX_FLAT))
            out.append(("%s%d" % ("t" if tall else "s", len(out) + 1), ("boxtall_%d" if tall else "boxstone_%d") % (k + 1), e, n,
                        rnd.randrange(360), round(L, 2), round(top_fn(L, p, k, rnd), 2)))
    # standing stones first (they claim their places), then the ground layer, then the middle
    throw(2, 6, 0.1, 0.5, 0.7, True, lambda L, p, k, r: BOX_TALL[k][1] * L * 0.9 + 0.1 * p, 0.8)
    throw(0, 90, 0.0, 0.6, 1.1, False, lambda L, p, k, r: BOX_FLAT[k][1] * L * 0.88 + 0.35 * p, 0.42)
    throw(1, 34, 0.35, 0.7, 1.3, False, lambda L, p, k, r: 0.8 + 0.6 * p + BOX_FLAT[k][1] * L * 0.25 * r.random(), 0.42)
    return out


BOX_BOULDERS = [{"id": "h3-box-block-" + k, "asset": "boxkerb_1", "e": e, "n": n, "yawDeg": y, "lengthM": L, "topM": 0.45,
                 "note": "Hole 3, the stone box behind the tees: a block of the frame."}
                for k, e, n, y, L in BOX_BLOCKS]
BOX_BOULDERS += [{"id": "h3-box-stone-" + k, "asset": a, "e": round(e, 2), "n": round(n, 2), "yawDeg": y, "lengthM": L, "topM": t}
                 for k, a, e, n, y, L, t in box_stones()]



def dug_ring(feature_id):
    """The pond's outline as the water-digs edit dug it (the server's flattened B-spline), counter-clockwise."""
    db = sqlite3.connect(DB)
    row = db.execute("select rings_json from terrain_edits where origin = 'water-digs' and origin_ref = ?",
                     ("feature:" + feature_id,)).fetchone()
    if row is None:
        raise SystemExit("no water-digs edit for feature %s: run bun run terrain:generate first" % feature_id)
    ring = [(p["x"], p["y"]) for p in json.loads(row[0])[0]]
    if ring[0] == ring[-1]:
        ring = ring[:-1]
    area = sum(ring[i - 1][0] * ring[i][1] - ring[i][0] * ring[i - 1][1] for i in range(len(ring))) / 2
    return ring if area > 0 else ring[::-1]


def resample(points, step):
    out, carry = [points[0]], 0.0
    for a, b in zip(points, points[1:]):
        seg = math.dist(a, b)
        t = step - carry
        while t <= seg:
            out.append((a[0] + (b[0] - a[0]) * t / seg, a[1] + (b[1] - a[1]) * t / seg))
            t += step
        carry = seg - (t - step)
    if math.dist(out[-1], points[-1]) > step * 0.3:
        out.append(points[-1])
    return out


def stretch(ring, start, via, end):
    near = lambda q: min(range(len(ring)), key=lambda i: math.dist(ring[i], q))
    i0, iv, i1 = near(start), near(via), near(end)
    n = len(ring)
    fwd = [ring[(i0 + k) % n] for k in range((i1 - i0) % n + 1)]
    if (iv - i0) % n <= (i1 - i0) % n:
        return fwd, 1
    return [ring[(i0 - k) % n] for k in range((i0 - i1) % n + 1)], -1


def stations(w):
    if "line" in w:
        # a drawn line: the water on its left, so "out" (towards the plateau) is its right
        pts, direction, toe_in, lip_out = resample(list(w["line"]), STATION_M), -1, -LINE_TOE_OUT_M, LINE_LIP_IN_M
    else:
        ring = dug_ring(w["feature"])
        pts, direction = stretch(ring, w["start"], w["via"], w["end"])
        pts, toe_in, lip_out = resample(pts, STATION_M), TOE_IN_M, LIP_OUT_M
    toe, lip = [], []
    for i, p in enumerate(pts):
        a, b = pts[max(0, i - 2)], pts[min(len(pts) - 1, i + 2)]
        tx, ty = b[0] - a[0], b[1] - a[1]
        L = math.hypot(tx, ty) or 1.0
        # a counter-clockwise ring has its inside on the left; walked backwards, on the right
        ox, oy = (ty / L, -tx / L) if direction > 0 else (-ty / L, tx / L)
        toe.append([round(p[0] - ox * toe_in, 2), round(p[1] - oy * toe_in, 2)])
        lip.append([round(p[0] + ox * lip_out, 2), round(p[1] + oy * lip_out, 2)])
    return toe, lip


def stones_spec():
    assets = {}
    for i, (w, h) in enumerate(BOULDERS, 1):
        assets["boulder_%d" % i] = {"category": "prop", "collider": "mesh", "parts": [
            {"kind": "boulder", "sx": 1.0, "sy": w, "sz": h, "seed": 40 + i, "mat": "granite_boulder",
             "moss": 0.84, "mossMat": "granite_moss"}]}
    for i, (d, h, e) in enumerate(WALL_STONES, 1):
        assets["wallstone_%d" % i] = {"category": "prop", "collider": "mesh", "parts": [
            {"kind": "boulder", "sx": 1.0, "sy": d, "sz": h, "seed": 60 + i, "exponent": e, "lumps": 0.45,
             "flats": WALL_STONE_FLATS, "seg": 24, "rings": 14, "mat": "granite_wall",
             "moss": 0.86, "mossMat": "granite_moss"}]}
    for i, (sy, sz, ex, lumps) in enumerate(HEAP_STONES, 1):
        assets["heap_%d" % i] = {"category": "prop", "collider": "mesh", "parts": [
            {"kind": "boulder", "sx": 1.0, "sy": sy, "sz": sz, "seed": 100 + i, "exponent": ex, "lumps": lumps,
             "flats": angular_flats(300 + i), "seg": 32, "rings": 22, "mat": "granite_lichen"}]}
    # hole 16's boulders: the heap stones' shapes in a darker granite (Marcus: granite_lichen glows white on the slab)
    for i, (sy, sz, ex, lumps) in enumerate(HEAP_STONES, 1):
        assets["hgrey_%d" % i] = {"category": "prop", "collider": "mesh", "parts": [
            {"kind": "boulder", "sx": 1.0, "sy": sy, "sz": sz, "seed": 100 + i, "exponent": ex, "lumps": lumps,
             "flats": angular_flats(300 + i), "seg": 32, "rings": 22, "mat": "granite_lichen_dark"}]}
    # the frame's blocks: straight, square-ended boxes 1 m x 0.12 x 0.30 (scaled to their length: 0.32 thick, 0.8 high, the
    # top 0.45 over the ground, the rest sunk)
    assets["boxkerb_1"] = {"category": "prop", "collider": "mesh", "parts": [
        {"kind": "box", "c": (0, 0, 0), "s": (1.0, 0.12, 0.30), "mat": "granite_plinth"}]}
    for i, (sy, sz, ex, lumps) in enumerate(BOX_FLAT, 1):
        assets["boxstone_%d" % i] = {"category": "prop", "collider": "mesh", "parts": [
            {"kind": "boulder", "sx": 1.0, "sy": sy, "sz": sz, "seed": 210 + i, "exponent": ex, "lumps": lumps,
             "flats": angular_flats(400 + i), "seg": 28, "rings": 18, "mat": "granite_beige"}]}
    for i, (sy, sz, ex, lumps) in enumerate(BOX_TALL, 1):
        assets["boxtall_%d" % i] = {"category": "prop", "collider": "mesh", "parts": [
            {"kind": "boulder", "sx": 1.0, "sy": sy, "sz": sz, "seed": 220 + i, "exponent": ex, "lumps": lumps,
             "flats": angular_flats(500 + i), "seg": 28, "rings": 18, "mat": "granite_beige"}]}
    return {"format": "golfmap-props-spec-v1", "source": "docs/gspro/ombergs-golfklubb/stone-walls.gen.py", "origin": [0, 0],
            "assets": assets, "instances": []}


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--out", default="", help="also write stone-walls.json into this folder (the Unity course folder)")
    a = p.parse_args()
    walls = []
    for w in WALLS:
        toe, lip = stations(w)
        length = sum(math.dist(toe[i], toe[i + 1]) for i in range(len(toe) - 1))
        print("%-16s %3d stations, %5.1f m along the foot" % (w["id"], len(toe), length))
        walls.append({"id": w["id"], "note": w["note"], "seed": sum(map(ord, w["id"])), "toe": toe, "lip": lip,
                      **{k: v for k, v in w.items() if k not in ("id", "note", "feature", "start", "via", "end", "line")}})  # style and any setting
    spec = {"format": "golfmap-walls-v1", "source": "docs/gspro/ombergs-golfklubb/stone-walls.gen.py", "stonesFolder": STONES_FOLDER,
            "physicMaterial": PHYSIC_MATERIAL, "stoneSets": STONE_SETS, "defaults": DEFAULTS, "styles": STYLES,
            "walls": walls, "boulders": H1_BOULDERS + H2_BOULDERS + BOX_BOULDERS + BIRCH_BOULDERS, "placedColors": {}}
    outs = [(os.path.join(HERE, "stone-walls.json"), spec), (os.path.join(HERE, "wall-stones.json"), stones_spec())]
    if a.out:
        outs.append((os.path.join(a.out, "stone-walls.json"), spec))
    for path, d in outs:
        with open(path, "w", encoding="utf-8", newline="\n") as f:
            f.write(json.dumps(d, indent=1) + "\n")
        print("wrote", path)


if __name__ == "__main__":
    main()
