"""Car park stall lines and parked cars (the Vreta recipe, clubhouse-props.gen.py "Parked cars").

cars.json holds the stall rows traced on the 2025 ortho (see its "doc"): the painted grid comes from the
rows, a car stands in every stall of "cars" that is not marked "parked": false. model.py calls
register_materials() and build(add, new, ev).
"""
import hashlib
import json
import math
from pathlib import Path

import props_kit as kit

HERE = Path(__file__).resolve().parent
MATTE = {"park_paint"}     # painted lines: no specular (a sheen on 12 cm strips glares at grazing angles)
LINE_W, LIFT, CELL = 0.12, 0.03, 0.5   # strip width, metres over the ground, drape step
CHUNK = 4                  # stalls per line piece: Unity grounds a prop at its origin, so each piece sits on its own
PITCH = 2.5
VEH = "Assets/GolfMap/Omberg/Props/VehiclesLowPoly/"
PAINT = {"grey": (0.20, 0.21, 0.22), "silver": (0.55, 0.56, 0.58), "blue": (0.06, 0.10, 0.24), "red": (0.42, 0.03, 0.03), "black": (0.02, 0.02, 0.025)}
SIZE = {"hatch": (4.1, 1.5, 1.8), "sedan": (4.5, 1.45, 1.8)}   # review boxes only: length (along the car), height, width
CHECK = {"pieces": 0, "tris": 0, "dev": [], "cars": 0, "empty": 0, "mid": [], "edge": []}


def register_materials():
    kit.MATERIALS["park_paint"] = (None, (1, 1), (187, 187, 187), 0.0, 0.0)  # #bbb like the course's line_paint


def hatch(col):
    if col in ("white", "black"):
        return {"prefab": VEH + "Hatchback %s.prefab" % col.title(), "axis": "z", "category": "vehicle", "collider": "box"}
    c = PAINT[col]
    return {"prefab": VEH + "Hatchback White.prefab", "axis": "z", "category": "vehicle", "collider": "box",
            "recolor": [{"material": "BodyMat 5", "color": list(c), "as": "Hatchback body " + col},
                        {"material": "SeamsMat 5", "color": [v * 0.7 for v in c], "as": "Hatchback seams " + col}]}


def sedan(col):
    if col == "white":
        return {"prefab": VEH + "Sedan.prefab", "axis": "z", "category": "vehicle", "collider": "box"}
    return {"prefab": VEH + "Sedan.prefab", "axis": "z", "category": "vehicle", "collider": "box",
            "recolor": [{"material": "Tocus_Body White", "color": list(PAINT[col]), "as": "Sedan body " + col}]}


def axes(yaw):
    """Unit vectors in (e, n): along the row (bearing yaw - 90) and the cars' forward (bearing yaw)."""
    a, f = math.radians(yaw - 90), math.radians(yaw)
    return (math.sin(a), math.cos(a)), (math.sin(f), math.cos(f))


def en(row, u, v):
    A, F = axes(row["yaw"])
    e, n = row["origin"]
    return e + u * A[0] + v * F[0], n + u * A[1] + v * F[1]


def cuts(row, painted=False):
    """Stall boundaries along the row, metres from its origin (all of them, or those of the painted stalls)."""
    if "cuts" in row:
        return row["cuts"]
    a, b = row["paintK"] if painted and "paintK" in row else row["k"]
    return [j * PITCH for j in range(a, b + 2)]


def strips(g, segs, o, ev, ground):
    """Flat strips LINE_W wide along segs [(e0, n0, e1, n1)] draped LIFT over the course terrain, in the local
    frame of a piece whose origin is o = (e, n) and whose yaw is 90 (local x = east, y = north). Cut every CELL
    so they follow the ground; no skirt, a strip has no thickness to show."""
    w = LINE_W / 2
    for e0, n0, e1, n1 in segs:
        L = math.hypot(e1 - e0, n1 - n0)
        nx, ny = -(n1 - n0) / L * w, (e1 - e0) / L * w   # left of the line, half the width
        m = max(1, math.ceil(L / CELL))
        at = lambda t: (e0 + (e1 - e0) * t, n0 + (n1 - n0) * t)
        zt = lambda t: ev.terrain(*at(t)) - ground + LIFT

        def cut(t0, t1, depth=0):
            """t values along the line: a CELL step, split again where the terrain in the middle is more than
            1 cm off the straight run between the ends (a kerb or the foot of a hedge in the DEM)."""
            tm = (t0 + t1) / 2
            if depth < 3 and abs(zt(tm) - (zt(t0) + zt(t1)) / 2) > 0.01:
                return cut(t0, tm, depth + 1) + cut(tm, t1, depth + 1)
            return [t0]

        ts = [t for i in range(m) for t in cut(i / m, (i + 1) / m)] + [1.0]
        for t0, t1 in zip(ts, ts[1:]):
            p, q = at(t0), at(t1)
            quad = [(p[0] - nx, p[1] - ny), (q[0] - nx, q[1] - ny), (q[0] + nx, q[1] + ny), (p[0] + nx, p[1] + ny)]
            # both corners of an end take the terrain under the line's centre there: a strip is flat across its
            # 12 cm, and sampling each corner would tilt it over a kerb or a hedge foot in the DEM
            zp, zq = zt(t0), zt(t1)
            g.poly([(x - o[0], y - o[1], z) for (x, y), z in zip(quad, (zp, zq, zq, zp))], "park_paint")
            cx, cy = (p[0] + q[0]) / 2, (p[1] + q[1]) / 2
            CHECK["mid"].append((zp + zq) / 2 + ground - ev.terrain(cx, cy))   # the flat middle against the terrain there
            for (x, y), z in zip(quad, (zp, zq, zq, zp)):
                CHECK["edge"].append(z + ground - ev.terrain(x, y))


def piece(add, new, ev, aid, segs):
    """One line asset: its origin at the middle of its segments, grounded on the terrain there."""
    xs = [e for s in segs for e in (s[0], s[2])]
    ys = [n for s in segs for n in (s[1], s[3])]
    o = ((min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2)
    ground = ev.terrain(*o)
    g = new()
    g.category = "marking"
    strips(g, segs, o, ev, ground)
    add(aid, g, o[0], o[1], 90, ground)
    CHECK["pieces"] += 1
    CHECK["tris"] += 2 * len(g.faces)


def row_lines(row, add, new, ev):
    """Painted lines of a row in pieces of CHUNK stalls: dividers at every boundary, plus the long lines
    (row['edges'], default both stall ends) between the piece's first and last boundary."""
    pc = cuts(row, True)
    va, vb = row["v"]
    n = len(pc) - 1   # painted stalls
    for p, i0 in enumerate(range(0, n, CHUNK)):
        i1 = min(i0 + CHUNK, n)
        segs = [(*en(row, pc[j], va), *en(row, pc[j], vb)) for j in range(i0, i1 + (1 if i1 == n else 0))]
        segs += [(*en(row, pc[i0], v), *en(row, pc[i1], v)) for v in row.get("edges", [va, vb])]
        piece(add, new, ev, "omberg_park_stall_lines_%s_%d" % (row["id"].lower(), p), segs)
    for j, x in enumerate(row.get("extra", [])):   # hatching and bay ends traced by hand: a piece each
        piece(add, new, ev, "omberg_park_stall_lines_%s_x%d" % (row["id"].lower(), j), [tuple(x)])


def build(add, new, ev):
    data = json.loads((HERE / "cars.json").read_text(encoding="utf-8"))
    rows = {r["id"]: r for r in data["rows"]}
    for r in data["rows"]:
        row_lines(r, add, new, ev)
    for c in data["cars"]:
        if c.get("parked") is False:
            CHECK["empty"] += 1
            continue
        r = rows[c["row"]]
        cs = cuts(r)
        i = c["stall"] - r["k"][0] if "k" in r else c["stall"]
        vm = sum(r["v"]) / 2
        e, n = en(r, (cs[i] + cs[i + 1]) / 2, vm)   # every car stands at its stall centre, nose in
        # model and the odd reversed car come from the stall position, so flipping "parked" changes nothing else
        h = int(hashlib.md5(("%.2f%.2f" % (e, n)).encode()).hexdigest(), 16)
        kind = "hatch" if h % 10 < 5 else "sedan"
        nose = r.get("nose", 1)
        if (h >> 8) % 10 == 0:
            nose = -nose
        aid = "omberg_park_car_%s_%s" % (kind, c["col"])
        spec = (hatch if kind == "hatch" else sedan)(c["col"])
        prefab = spec.pop("prefab")
        ev.add_prefab(aid, prefab, round(e, 2), round(n, 2), round((r["yaw"] + (0 if nose > 0 else 180)) % 360, 1),
                      ev.terrain(e, n), size=SIZE[kind], **spec)
        CHECK["cars"] += 1
    m, ed = CHECK["mid"], CHECK["edge"]
    print("park: %d line pieces, %d triangles; %d cars, %d stalls left empty; strip over the terrain: middles %.3f..%.3f m, "
          "corners %.3f..%.3f m (%d of %d corners outside 0.02..0.04)"
          % (CHECK["pieces"], CHECK["tris"], CHECK["cars"], CHECK["empty"], min(m), max(m), min(ed), max(ed),
             sum(not .02 <= x <= .04 for x in ed), len(ed)), flush=True)
