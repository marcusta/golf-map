"""Omberg's stone edges, for Unity's golfmap.walls.build (GolfMapWalls.cs): the rough boulder revetment along the
hole 14 pond's edge towards the green.

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
]


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
            "walls": walls, "boulders": [], "placedColors": {}}
    outs = [(os.path.join(HERE, "stone-walls.json"), spec), (os.path.join(HERE, "wall-stones.json"), stones_spec())]
    if a.out:
        outs.append((os.path.join(a.out, "stone-walls.json"), spec))
    for path, d in outs:
        with open(path, "w", encoding="utf-8", newline="\n") as f:
            f.write(json.dumps(d, indent=1) + "\n")
        print("wrote", path)


if __name__ == "__main__":
    main()
