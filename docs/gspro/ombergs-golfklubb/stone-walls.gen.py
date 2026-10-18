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
STONE_SETS = {"rose": [{"asset": "boulder_%d" % i, "weight": 1} for i in range(1, len(BOULDERS) + 1)]}

TOE_IN_M = 0.6    # the foot this far inside the outline: under the water, on the dug bank
LIP_OUT_M = 1.0   # the top edge this far outside it, on the bank above the water
STATION_M = 0.5   # stations along the outline

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
# nearest `start` to the one nearest `end`, the way that passes `via`.
WALLS = [
    {"id": "h14-pond-edge", "feature": "b2388429-8a29-41d6-9396-559dcfd5f18c",
     "start": (477339.0, 6457146.5), "via": (477336.6, 6457150.5), "end": (477358.0, 6457157.5),
     "note": "Hole 14 pond: the rough stone edge towards the green, round the west tip (the creek's outlet) and "
             "along the north edge to E 477358 (2025 and 2023 orthos)."},
    # The pond between holes 18, 1 and tee 10 (water feature 77, others_4d; Deep Water, 2 m, 34 deg, 45 deg above).
    {"id": "p77-south-west", "feature": "4530bf16-35ec-4c82-b78b-f139db337b9e",
     "start": (477682.7, 6457395.2), "via": (477652.3, 6457383.8), "end": (477643.7, 6457447.0),
     "note": "Pond between 18 and 1: rounded boulders along the south edge (dark in the 2023 ortho, grey in 2025), "
             "round the south-west corner and up the west side past the bulge to N 6457447."},
    {"id": "p77-north-tip", "feature": "4530bf16-35ec-4c82-b78b-f139db337b9e",
     "start": (477675.8, 6457494.0), "via": (477683.8, 6457497.0), "end": (477694.5, 6457487.4),
     "note": "Pond between 18 and 1: the grey stone rim round the north tip (2025 and 2023 orthos)."},
]


# Loose rounded boulders in the grass among the rock slabs under the trees NE of hole 1's green (Marcus's photo,
# 2026-10-18: a few dark rounded boulders, 0.5-1.2 m, sitting in the grass; one beside the middle tree's trunk, one in
# front of the mound). Only the one on the NE slab is seen in the 2023 ortho (dark, with its shadow); the others are
# placed from the photo. e/n = centre (EPSG:3006), yawDeg = bearing of the long side, lengthM, topM = top over the
# highest ground under it (about half the length: sunk in, the round underside never floats).
H1_BOULDERS = [
    {"id": "h1-trees-ne-boulder-1", "asset": "boulder_4", "e": 477843.7, "n": 6457341.0, "yawDeg": 40, "lengthM": 1.3, "topM": 0.6,
     "note": "On the little slab NE of the tree group: the dark boulder with its shadow in the 2023 ortho."},
    {"id": "h1-trees-ne-boulder-2", "asset": "boulder_2", "e": 477836.8, "n": 6457315.2, "yawDeg": 100, "lengthM": 0.9, "topM": 0.45,
     "note": "In front of the mound, south of the big slab (photo: the boulder centre-left of the mound)."},
    {"id": "h1-trees-ne-boulder-3", "asset": "boulder_7", "e": 477845.8, "n": 6457313.4, "yawDeg": 20, "lengthM": 0.8, "topM": 0.4,
     "note": "Beside the trunk of the middle tree (photo)."},
    {"id": "h1-trees-ne-boulder-4", "asset": "boulder_5", "e": 477833.4, "n": 6457316.4, "yawDeg": 60, "lengthM": 0.6, "topM": 0.3,
     "note": "Small, lower left of the mound (photo)."},
    {"id": "h1-trees-ne-boulder-5", "asset": "boulder_9", "e": 477830.4, "n": 6457318.6, "yawDeg": 150, "lengthM": 0.5, "topM": 0.25,
     "note": "Small, lower left of the mound (photo)."},
]


# The stenröse at hole 2's tee (Marcus's photo from the tee, 2026-10-18): a heap of big grey lichen granite boulders on
# the edge of the deep rough NW of the tee box, about 5 x 4 m and 2.7 m high. The 2023 and 2025 orthos show eight pale
# round stones 1-1.5 m across at E 477847.7-477851, N 6457273.5-6457277.5 (with a dark gap in the middle of the heap),
# a bedrock slab north of it. Each stone is placed whole on the lidar ground (no plateau); the stones are closed
# Blender boulders, rounder-angular than the wall stones (superellipsoid 2.4-3, flat faces), 1.2-2.4 m once scaled.
# (sy, sz, exponent, lumps) of the heap stones: depth and height as a fraction of the length.
HEAP_STONES = [
    (0.82, 0.70, 2.6, 0.55), (0.76, 0.66, 2.9, 0.5), (0.9, 0.74, 2.4, 0.6), (0.7, 0.62, 3.0, 0.45),
    (0.86, 0.8, 2.5, 0.55), (0.78, 0.68, 2.8, 0.5), (0.92, 0.72, 2.3, 0.6),
]
HEAP_FLATS = [
    {"dir": [0, 1, 0.2], "at": 0.8, "keep": 0.15}, {"dir": [0, -1, 0.1], "at": 0.82, "keep": 0.15},
    {"dir": [1, 0, 0.3], "at": 0.84, "keep": 0.2}, {"dir": [0, 0, 1], "at": 0.86, "keep": 0.3},
]
# e/n = centre (EPSG:3006), yawDeg, lengthM, topM = top over the highest ground under it (ring stones sit in the
# ground; the middle tier and the top stone rest on them, so their tops are higher than their own height).
H2_HEAP = [
    # ground ring
    ("a", "heap_1", 477848.3, 6457274.4, 25, 1.9, 1.15), ("b", "heap_3", 477850.3, 6457274.2, 100, 1.7, 1.1),
    ("c", "heap_2", 477849.2, 6457273.4, 60, 1.4, 0.8), ("d", "heap_5", 477847.9, 6457276.4, 150, 1.8, 1.25),
    ("e", "heap_4", 477850.7, 6457276.0, 10, 1.5, 1.1), ("f", "heap_6", 477849.3, 6457277.5, 75, 1.4, 0.95),
    # middle tier and the top stone
    ("g", "heap_7", 477849.4, 6457275.0, 35, 2.0, 1.9), ("h", "heap_2", 477848.7, 6457275.9, 120, 1.7, 1.85),
    ("i", "heap_5", 477849.4, 6457276.0, 140, 2.4, 2.7),
    # the rest of the foot: a wider heap (the photo: 6-8 stones in a row about 5 m long)
    ("j", "heap_3", 477846.9, 6457275.3, 60, 1.6, 1.0), ("k", "heap_6", 477847.5, 6457277.4, 20, 1.5, 1.1),
    ("l", "heap_1", 477851.7, 6457275.0, 130, 1.3, 0.85), ("m", "heap_4", 477848.5, 6457273.4, 170, 1.2, 0.75),
    ("n", "heap_7", 477850.5, 6457277.4, 95, 1.3, 0.9),
]
H2_BOULDERS = [{"id": "h2-tee-stenrose-" + k, "asset": a, "e": e, "n": n, "yawDeg": y, "lengthM": L, "topM": t,
                "note": "Stenrose NW of hole 2's tee (the heap in the photo from the tee; ortho: pale round stones)."}
               for k, a, e, n, y, L, t in H2_HEAP]


# The stone box behind hole 3's tees (Marcus's video frame, 2026-10-18; the 2025 and 2023 orthos show it at
# E 478240.3-478250.6, N 6457621.0-6457640: a frame of grey blocks, the south wall 10.4 m and the west wall 10.5 m
# visible, the east side open, filled with a loose pile of pale granite stones 0.4-1.3 m that spills north of the
# frame as rubble to N 6457639). The frame is a low wall of long thin blocks (0.25 x 0.42 m, sunk to the ground; the
# ground inside stays at lawn level); the stones are single boulders, a few standing on end.
BOX_E0, BOX_N0 = 478240.0, 6457621.0   # the frame's SW outer corner
BOX_BLOCKS = [  # (id, e, n, bearing of the long side, length m): the south wall 4 x 2.65 m, the west wall 5 x 2.1 m
    ("s%d" % i, BOX_E0 + 0.6 + 1.3 + 2.6 * i, BOX_N0 + 0.45, 90, 2.65) for i in range(4)
] + [("w%d" % i, BOX_E0 + 0.45, BOX_N0 + 1.5 + 0.55 + 2.1 * i, 0, 2.15) for i in range(5)]
BOX_STONE_MAT = "granite_rock"   # paler than the wall stones (the ortho: pale grey-beige)
BOX_FLAT = [(0.82, 0.72, 2.6, 0.5), (0.74, 0.6, 2.9, 0.45), (0.9, 0.7, 2.4, 0.55), (0.7, 0.66, 3.0, 0.4),
            (0.86, 0.78, 2.5, 0.5), (0.78, 0.64, 2.8, 0.45)]
BOX_TALL = [(0.8, 2.0, 2.6, 0.45), (0.7, 2.3, 2.9, 0.4), (0.85, 1.9, 2.5, 0.5)]   # stand on end: taller than long


def box_stones():
    """The pile: seeded, dart-thrown, denser along the south and east of the frame, a few standing on end."""
    import random
    rnd = random.Random(303)
    placed = []   # (e, n, length)
    out = []

    def throw(count, e0, e1, n0, n1, tall, lo, hi, dense, tag):
        tries = 0
        made = 0
        while made < count and tries < 4000:
            tries += 1
            L = lo + (hi - lo) * rnd.random() ** 1.6
            e, n = rnd.uniform(e0, e1), rnd.uniform(n0, n1)
            near_s = max(0.0, 1 - (n - n0) / 3.5)
            near_e = max(0.0, 1 - (e1 - e) / 3.5)
            if rnd.random() > 0.3 + 0.7 * max(near_s, near_e) * dense + (1 - dense) * 0.7:
                continue
            if any(math.hypot(e - pe, n - pn) < 0.5 * (L + pl) / 2 + 0.05 for pe, pn, pl in placed):
                continue
            placed.append((e, n, L))
            made += 1
            if tall:
                k = rnd.randrange(len(BOX_TALL))
                out.append(("%s-t%d" % (tag, made), "boxtall_%d" % (k + 1), e, n, rnd.randrange(360), round(L, 2), round(L * BOX_TALL[k][1] * 0.88, 2)))
            else:
                k = rnd.randrange(len(BOX_FLAT))
                out.append(("%s-%d" % (tag, made), "boxstone_%d" % (k + 1), e, n, rnd.randrange(360), round(L, 2), round(L * BOX_FLAT[k][1] * 0.8, 2)))
    # the tall ones first (they claim their places), then the pile inside the frame (bounds are the walls' inner faces
    # less half a stone), then the rubble north of it
    throw(5, BOX_E0 + 1.6, BOX_E0 + 9.9, BOX_N0 + 1.6, BOX_N0 + 9.8, True, 0.5, 0.75, 1.0, "in")
    throw(70, BOX_E0 + 1.1, BOX_E0 + 10.2, BOX_N0 + 0.95, BOX_N0 + 10.4, False, 0.4, 1.3, 1.0, "in")
    throw(14, BOX_E0 + 1.2, BOX_E0 + 10.0, BOX_N0 + 11.0, BOX_N0 + 18.0, False, 0.35, 0.9, 0.0, "out")
    return out


BOX_BOULDERS = [{"id": "h3-box-block-" + k, "asset": "boxkerb_%d" % (1 + i % 2), "e": e, "n": n, "yawDeg": y, "lengthM": L, "topM": 0.45,
                 "note": "Hole 3, the stone box behind the tees: a block of the frame."}
                for i, (k, e, n, y, L) in enumerate(BOX_BLOCKS)]
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
    ring = dug_ring(w["feature"])
    pts, direction = stretch(ring, w["start"], w["via"], w["end"])
    pts = resample(pts, STATION_M)
    toe, lip = [], []
    for i, p in enumerate(pts):
        a, b = pts[max(0, i - 2)], pts[min(len(pts) - 1, i + 2)]
        tx, ty = b[0] - a[0], b[1] - a[1]
        L = math.hypot(tx, ty) or 1.0
        # a counter-clockwise ring has its inside on the left; walked backwards, on the right
        ox, oy = (ty / L, -tx / L) if direction > 0 else (-ty / L, tx / L)
        toe.append([round(p[0] - ox * TOE_IN_M, 2), round(p[1] - oy * TOE_IN_M, 2)])
        lip.append([round(p[0] + ox * LIP_OUT_M, 2), round(p[1] + oy * LIP_OUT_M, 2)])
    return toe, lip


def stones_spec():
    assets = {}
    for i, (w, h) in enumerate(BOULDERS, 1):
        assets["boulder_%d" % i] = {"category": "prop", "collider": "mesh", "parts": [
            {"kind": "boulder", "sx": 1.0, "sy": w, "sz": h, "seed": 40 + i, "mat": "granite_boulder",
             "moss": 0.84, "mossMat": "granite_moss"}]}
    for i, (sy, sz, ex, lumps) in enumerate(HEAP_STONES, 1):
        assets["heap_%d" % i] = {"category": "prop", "collider": "mesh", "parts": [
            {"kind": "boulder", "sx": 1.0, "sy": sy, "sz": sz, "seed": 100 + i, "exponent": ex, "lumps": lumps,
             "flats": HEAP_FLATS, "seg": 32, "rings": 20, "mat": "granite_boulder"}]}
    for i in (1, 2):   # the frame's blocks: 0.25 x 0.42 m once 2.65 m long, sunk 0.35 m more (topM 0.4)
        assets["boxkerb_%d" % i] = {"category": "prop", "collider": "mesh", "parts": [
            {"kind": "boulder", "sx": 1.0, "sy": 0.12, "sz": 0.3, "seed": 200 + i, "exponent": 8.0, "lumps": 0.1,
             "seg": 24, "rings": 14, "mat": "granite_plinth"}]}
    for i, (sy, sz, ex, lumps) in enumerate(BOX_FLAT, 1):
        assets["boxstone_%d" % i] = {"category": "prop", "collider": "mesh", "parts": [
            {"kind": "boulder", "sx": 1.0, "sy": sy, "sz": sz, "seed": 210 + i, "exponent": ex, "lumps": lumps,
             "flats": HEAP_FLATS, "seg": 24, "rings": 14, "mat": BOX_STONE_MAT}]}
    for i, (sy, sz, ex, lumps) in enumerate(BOX_TALL, 1):
        assets["boxtall_%d" % i] = {"category": "prop", "collider": "mesh", "parts": [
            {"kind": "boulder", "sx": 1.0, "sy": sy, "sz": sz, "seed": 220 + i, "exponent": ex, "lumps": lumps,
             "flats": HEAP_FLATS, "seg": 24, "rings": 14, "mat": BOX_STONE_MAT}]}
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
        walls.append({"id": w["id"], "note": w["note"], "seed": sum(map(ord, w["id"])), "toe": toe, "lip": lip})
    spec = {"format": "golfmap-walls-v1", "source": "docs/gspro/ombergs-golfklubb/stone-walls.gen.py", "stonesFolder": STONES_FOLDER,
            "physicMaterial": PHYSIC_MATERIAL, "stoneSets": STONE_SETS, "defaults": DEFAULTS, "styles": STYLES,
            "walls": walls, "boulders": H1_BOULDERS + H2_BOULDERS + BOX_BOULDERS, "placedColors": {}}
    outs = [(os.path.join(HERE, "stone-walls.json"), spec), (os.path.join(HERE, "wall-stones.json"), stones_spec())]
    if a.out:
        outs.append((os.path.join(a.out, "stone-walls.json"), spec))
    for path, d in outs:
        with open(path, "w", encoding="utf-8", newline="\n") as f:
            f.write(json.dumps(d, indent=1) + "\n")
        print("wrote", path)


if __name__ == "__main__":
    main()
