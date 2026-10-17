"""Omberg tee signs: a lacquered plank on a square wooden post by every white/yellow/blue/red tee (not Par 3 or
Junior), with the hole number, a dot and the length per tee, par and stroke index. Tees on the same tee box or
within TOGETHER m (10) of each other share one sign; with more than one length on it the plank is taller.

    pipeline/.venv/Scripts/python.exe docs/gspro/ombergs-golfklubb/tee-signs/tee-signs.gen.py
      -> docs/gspro/ombergs-golfklubb/tee-signs/tee-signs.json   props spec (golfmap-props-spec-v1, committed)
      -> data/props/<site>/tee-signs/*.png                       plank faces (generated, gitignored)
      -> data/omberg-tee-signs/layout.png                        placement check over the 2025 ortho

    blender -b --factory-startup --python blender/tools/build_props.py -- \
        --spec docs/gspro/ombergs-golfklubb/tee-signs/tee-signs.json --out data/omberg-tee-signs/build --preview
    pwsh docs/gspro/ombergs-golfklubb/clubhouse/install.ps1 -Build data/omberg-tee-signs/build \
        -UnityProject D:/gspro_courses/omberg_v4_2025_12_02 -CourseFolder Omberg
    then golfmap.props.place save=true in Unity.

Sources, 2026-10-17:
  - the real sign (hole 14, Marcus's photo): orange-brown lacquered plank about 0.46 x 0.32 m screwed to the front
    of a square post, its bottom ~0.55 m up, the post a few cm proud of it; black print: "14" large in the middle,
    a tee-colour dot and "474", "Par 5" to its right, "Index 4" under it at the right.
  - par and stroke index: the app's holes. Lengths: the app's tee -> aim points -> green line, which matches the
    club's white-tee card (GolfPass, in yards) to a metre or two. Hole 14 has only white and yellow tees in the
    app, so the photographed 474 (a forward tee) has no sign yet.
  - placement: the app's tees and tee/path/hazard features and the lidar tree stems.
"""
import json
import math
import os
import sqlite3

import numpy as np
import rasterio
from rasterio.warp import transform as warp
from rasterio.windows import from_bounds
from PIL import Image, ImageDraw, ImageFilter, ImageFont
from shapely.geometry import Point, Polygon
from shapely.ops import unary_union

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", "..", ".."))
COURSE = "ce4629e1-042d-4ea7-b31e-9226e2742a56"
SITE = "317d1f83-3ade-431c-8201-605ac0bd2871"
DB = os.path.join(ROOT, "data", "app.sqlite")
ORTHO = os.path.join(ROOT, "data", "sources", SITE, "ortho-orto-l2-2025.tif")
STEMS = os.path.join(ROOT, "data", "tiles", SITE, "tree-stems.json")
OUT_DIR = os.path.join(ROOT, "data", "props", SITE, "tee-signs")
CHECK = os.path.join(ROOT, "data", "omberg-tee-signs", "layout.png")
FONT = "C:/Windows/Fonts/arialbd.ttf"

COLORS = ["white", "yellow", "blue", "red"]  # the card's order, longest first
TOGETHER = 10.0  # m: tees this close (or on one tee box) share a sign
# Plank sizes (m): as photographed for one or two lengths (the second shares the "Index" line); three need a taller one.
SMALL = (0.46, 0.32)
LARGE = (0.46, 0.40)
BOTTOM = 0.55
PX_W = 1024
# Albedo: tuned on the plank as Unity renders it in sun against the photo (R:G:B about 1 : 0.74 : 0.46, a little darker
# than the grass beside it).
WOOD_LIGHT = np.array((96, 69, 31), float)
WOOD_DARK = np.array((66, 45, 19), float)
INK = (26, 22, 19)
DOT = {"white": (192, 192, 186), "yellow": (206, 172, 30), "blue": (38, 78, 168), "red": (172, 36, 30)}


def to3006(lon, lat):
    xs, ys = warp("EPSG:4326", "EPSG:3006", [lon], [lat])
    return xs[0], ys[0]


def rings(geometry_json):
    g = json.loads(geometry_json)
    return [[(p["x"], p["y"]) for p in r["points"]] for r in g.get("rings", [])]


def load():
    db = sqlite3.connect(DB)
    db.row_factory = sqlite3.Row
    holes = {}
    for h in db.execute("select id, number, par, stroke_index from holes where course_id=? and number between 1 and 18 order by number", (COURSE,)):
        g = db.execute("select center_lat, center_lon from greens where hole_id=?", (h["id"],)).fetchone()
        aims = [to3006(a["lon"], a["lat"]) for a in db.execute("select lat, lon from aim_points where hole_id=? order by sort_order", (h["id"],))]
        green = to3006(g["center_lon"], g["center_lat"])
        tees = []
        for t in db.execute("select name, color, lat, lon from tees where hole_id=?", (h["id"],)):
            if t["color"] not in COLORS or t["name"] in ("Par 3", "Junior"):
                continue
            p = to3006(t["lon"], t["lat"])
            line = [p] + aims + [green]
            tees.append({"color": t["color"], "at": p, "length": int(round(sum(math.dist(a, b) for a, b in zip(line, line[1:]))))})
        holes[h["number"]] = {"id": h["id"], "par": h["par"], "index": h["stroke_index"], "tees": tees, "green": green, "aims": aims}
    feats = []
    for f in db.execute("select type, hole_id, geometry_json from course_features where course_id=? and type != 'vegetation_zone'", (COURSE,)):
        for r in rings(f["geometry_json"]):
            if len(r) >= 3:
                p = Polygon(r).buffer(0)
                if not p.is_empty:
                    feats.append((f["type"], f["hole_id"], p))
    return holes, feats


def groups(h, feats):
    """The hole's tees in sign groups: same tee box (a tee feature holding both) or within TOGETHER m."""
    boxes = [p for t, _, p in feats if t == "tee"]
    tees = h["tees"]
    parent = list(range(len(tees)))

    def find(i):
        while parent[i] != i:
            i = parent[i]
        return i
    for i, a in enumerate(tees):
        for j, b in enumerate(tees[:i]):
            same_box = any(p.buffer(0.5).contains(Point(a["at"])) and p.buffer(0.5).contains(Point(b["at"])) for p in boxes)
            if same_box or math.dist(a["at"], b["at"]) <= TOGETHER:
                parent[find(i)] = find(j)
    out = {}
    for i, t in enumerate(tees):
        out.setdefault(find(i), []).append(t)
    return [sorted(g, key=lambda t: COLORS.index(t["color"])) for g in out.values()]


def rows(group):
    """Sign rows: (colours, length), tees of one length on one row with a dot each, longest first."""
    by = {}
    for t in group:
        by.setdefault(t["length"], []).append(t["color"])
    return [(cs, L) for L, cs in sorted(by.items(), key=lambda kv: -kv[0])]


# ---------------------------------------------------------------------------------------------
# Plank faces
# ---------------------------------------------------------------------------------------------
def _smooth(shape, seed, blur):
    r = np.random.default_rng(seed)
    a = Image.fromarray((r.random(shape) * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(blur))
    a = np.asarray(a, float)
    return (a - a.min()) / max(1e-6, a.max() - a.min())


def wood(w, h, seed, along="x"):
    """Lacquered pine: growth rings as bands across the grain direction, warped, with fine streaks along it."""
    W, H = (w, h) if along == "x" else (h, w)
    yy, xx = np.mgrid[0:H, 0:W].astype(float)
    # flat-sawn: the rings run along the plank, drifting slowly across it (a smooth field, long along the grain)
    warp_ = _smooth((24, 5), seed, 1.2)
    warp_ = np.asarray(Image.fromarray((warp_ * 255).astype(np.uint8)).resize((W, H), Image.BICUBIC), float) / 255
    period = H / 14.0
    ring = 0.5 + 0.5 * np.sin(2 * math.pi * (yy / period + 1.6 * warp_ + 0.15 * np.sin(xx / W * 2.5 + seed)))
    ring = ring ** 3  # thin dark latewood lines
    streak = _smooth((H, max(4, W // 64)), seed + 1, 0.8)
    streak = np.asarray(Image.fromarray((streak * 255).astype(np.uint8)).resize((W, H), Image.BILINEAR), float) / 255
    tone = _smooth((max(2, H // 64), max(2, W // 64)), seed + 2, 1.5)
    tone = np.asarray(Image.fromarray((tone * 255).astype(np.uint8)).resize((W, H), Image.BICUBIC), float) / 255
    t = np.clip(0.30 * ring + 0.25 * streak + 0.35 * tone, 0, 1)
    rgb = WOOD_LIGHT[None, None, :] * (1 - t[..., None]) + WOOD_DARK[None, None, :] * t[..., None]
    img = Image.fromarray(np.clip(rgb, 0, 255).astype(np.uint8))
    return img if along == "x" else img.transpose(Image.ROTATE_90)


def weathered(img):
    """Darker, slightly worn edges (end grain and rain), as on the photographed plank."""
    W, H = img.size
    yy, xx = np.mgrid[0:H, 0:W].astype(float)
    e = np.minimum(np.minimum(xx, W - 1 - xx), np.minimum(yy, H - 1 - yy)) / (0.035 * W)
    k = 0.80 + 0.20 * np.clip(e, 0, 1)
    a = np.asarray(img, float) * k[..., None]
    return Image.fromarray(np.clip(a, 0, 255).astype(np.uint8))


def font(px):
    return ImageFont.truetype(FONT, int(px))


def face(hole, h, sign_rows, size, path, seed):
    W, H = size
    PX_H = int(round(PX_W * H / W))
    img = weathered(wood(PX_W, PX_H, seed))
    d = ImageDraw.Draw(img)
    u = PX_H / (SMALL[1] * PX_W / SMALL[0])  # 1 on the small plank: the photo's proportions
    big = font(0.36 * PX_W * SMALL[1] / SMALL[0])
    small = font(0.17 * PX_W * SMALL[1] / SMALL[0])
    num = str(hole)
    bb = d.textbbox((0, 0), num, font=big)
    top = 0.07 * PX_H / u
    d.text((PX_W / 2 - (bb[2] - bb[0]) / 2 - bb[0], top - bb[1]), num, font=big, fill=INK)
    row_h = 0.21 * PX_W * SMALL[1] / SMALL[0]
    y0 = top + (bb[3] - bb[1]) + 0.06 * PX_W * SMALL[1] / SMALL[0]
    asc = d.textbbox((0, 0), "0", font=small)
    r = 0.022 * PX_W
    for i, (cs, L) in enumerate(sign_rows):
        y = y0 + i * row_h
        cy = y + (asc[1] + asc[3]) / 2 - asc[1]
        x = 0.075 * PX_W
        for c in cs:
            d.ellipse((x - r, cy - r, x + r, cy + r), fill=DOT[c], outline=INK, width=max(2, int(r / 5)))
            x += 2.6 * r
        d.text((x + 0.3 * r, y - asc[1]), str(L), font=small, fill=INK)
    for i, t in enumerate(("Par %d" % h["par"], "Index %d" % h["index"])):
        y = y0 + i * row_h
        w = d.textlength(t, font=small)
        d.text((0.93 * PX_W - w, y - asc[1]), t, font=small, fill=INK)
    img = img.filter(ImageFilter.GaussianBlur(0.6))  # print soaked into the grain, no razor edges
    img.save(path)


# ---------------------------------------------------------------------------------------------
# Placement
# ---------------------------------------------------------------------------------------------
BLOCK = ("tee", "green", "fairway", "bunker", "water", "rock_slab")
EMPTY = Point(0, 0).buffer(0.01)


def place(h, group, feats, stems, taken):
    """Beside the tee box, level with the rearmost tee on the sign (across the line of play from it), 1.5-4 m
    off the box's edge, clear of hazards, paths and tree stems; on the path's side when there is one. The
    printed side looks across the line of play at the box."""
    pts = [t["at"] for t in group]
    T = (sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts))
    first = h["aims"][0] if h["aims"] else h["green"]
    dx, dy = first[0] - T[0], first[1] - T[1]
    L = math.hypot(dx, dy)
    dx, dy = dx / L, dy / L
    near = [(t, p) for t, _, p in feats if p.distance(Point(T)) < 40]
    boxes = [p for t, p in near if t == "tee" and min(p.distance(Point(q)) for q in pts) < 3.0]
    if boxes:
        tee = unary_union(boxes)
    else:  # no tee box drawn yet: assume one ~14 x 8 m along the line of play round the markers
        from shapely import affinity
        ang = math.degrees(math.atan2(dy, dx))
        tee = unary_union([affinity.rotate(affinity.scale(Point(q).buffer(1.0), 7.0, 4.0), ang, origin=Point(q)) for q in pts])
    paths = unary_union([p for t, p in near if t == "path"] or [EMPTY])
    blocked = unary_union([p for t, p in near if t in BLOCK] or [EMPTY]).buffer(0.6).union(paths.buffer(0.8))
    # a tee with no tee box drawn may sit on another hole's fairway: then the fairway's edge will do
    loose = unary_union([p for t, p in near if t in BLOCK and t != "fairway"] or [EMPTY]).buffer(0.6).union(paths.buffer(0.8))
    have_path = paths.distance(tee) < 25
    trees = [(x, y, r) for x, y, _, r, _, _ in stems if abs(x - T[0]) < 45 and abs(y - T[1]) < 45]
    rear = min((q[0] - T[0]) * dx + (q[1] - T[1]) * dy for q in pts)  # the rearmost tee along the line of play
    best = None
    # looser steps only when nothing is free: under the canopy, further off the box, further from level
    for tol, dmin, dmax, clear, bl in ((1.0, 1.5, 4.0, 1.0, blocked), (1.0, 1.5, 4.0, 0.6, blocked), (2.5, 1.5, 6.0, 0.3, blocked),
                                       (4.0, 1.0, 8.0, 0.0, blocked), (2.5, 1.0, 6.0, 0.3, loose)):
        for ox in np.arange(-25, 25.01, 0.25):
            for oy in np.arange(-25, 25.01, 0.25):
                s = ox * dx + oy * dy
                if abs(s - rear) > tol:
                    continue
                p = (T[0] + ox, T[1] + oy)
                P = Point(p)
                dt = tee.distance(P)
                if not (dmin <= dt <= dmax) or bl.contains(P):
                    continue
                if any(math.hypot(p[0] - x, p[1] - y) < r * clear + 0.6 for x, y, r in trees):
                    continue
                if any(math.dist(p, q) < 4.0 for q in taken):
                    continue
                score = abs(dt - 2.0) * 0.8 + abs(s - rear) * 1.0
                if have_path:
                    score += min(abs(paths.distance(P) - 1.6), 6.0) * 0.4
                if best is None or score < best[0]:
                    best = (score, p, ox * dy - oy * dx)
        if best:
            break
    if best is None:
        raise RuntimeError("no spot for a sign by %s" % [t["color"] for t in group])
    _, p, side = best
    fx, fy = (-dy, dx) if side > 0 else (dy, -dx)  # across the line of play, towards the box
    face_bearing = math.degrees(math.atan2(fx, fy))
    return p, face_bearing, bool(boxes)


def check_sheet(ortho, items, feats):
    """Every sign over the 2025 ortho (40 m, north up): tee boxes, paths, the sign and where it looks."""
    tiles = []
    for it in items:
        e, n = it["e"], it["n"]
        R = 20
        win = from_bounds(e - R, n - R, e + R, n + R, ortho.transform)
        a = ortho.read([1, 2, 3], window=win, out_shape=(3, 320, 320), boundless=True, fill_value=0).transpose(1, 2, 0)
        im = Image.fromarray(a.astype(np.uint8))
        d = ImageDraw.Draw(im)
        px = lambda x, y: ((x - (e - R)) / (2 * R) * 320, ((n + R) - y) / (2 * R) * 320)
        for t, _, p in feats:
            if t in ("tee", "path") and p.distance(Point(e, n)) < 30:
                d.line([px(*c) for c in p.exterior.coords], fill=(255, 255, 255) if t == "tee" else (255, 160, 0), width=1)
        for tx, ty in it["tees"]:
            d.ellipse([px(tx, ty)[0] - 3, px(tx, ty)[1] - 3, px(tx, ty)[0] + 3, px(tx, ty)[1] + 3], outline=(0, 160, 255), width=2)
        sx, sy = px(e, n)
        b = math.radians(it["face"])
        d.line([sx, sy, sx + 22 * math.sin(b), sy - 22 * math.cos(b)], fill=(255, 0, 255), width=3)
        d.ellipse([sx - 5, sy - 5, sx + 5, sy + 5], fill=(255, 0, 255))
        d.text((4, 4), it["label"], fill=(255, 255, 0))
        tiles.append(im)
    cols = 8
    sheet = Image.new("RGB", (cols * 320, ((len(tiles) + cols - 1) // cols) * 320))
    for i, t in enumerate(tiles):
        sheet.paste(t, ((i % cols) * 320, (i // cols) * 320))
    os.makedirs(os.path.dirname(CHECK), exist_ok=True)
    sheet.save(CHECK)


def main():
    holes, feats = load()
    stems = json.load(open(STEMS))["trees"]
    os.makedirs(OUT_DIR, exist_ok=True)
    ortho = rasterio.open(ORTHO)
    assets, instances, materials, check = {}, [], {}, []
    taken = []
    back = os.path.join(OUT_DIR, "plank_back.png")
    weathered(wood(PX_W, int(PX_W * LARGE[1] / LARGE[0]), 99)).save(back)
    post = os.path.join(OUT_DIR, "post_wood.png")
    wood(512, 512, 98, along="y").save(post)  # 1 m tile, grain up the post
    rel = lambda p: os.path.relpath(p, HERE).replace(os.sep, "/")
    materials["tee_plank_back"] = {"image": rel(back), "smoothness": 0.45}
    materials["tee_post_wood"] = {"image": rel(post), "smoothness": 0.35}
    for num, h in sorted(holes.items()):
        for group in sorted(groups(h, feats), key=lambda g: COLORS.index(g[0]["color"])):
            sr = rows(group)
            size = SMALL if len(sr) <= 2 else LARGE
            key = "%02d_%s" % (num, "_".join(t["color"] for t in group))
            path = os.path.join(OUT_DIR, "tee_sign_%s.png" % key)
            face(num, h, sr, size, path, seed=num * 10 + len(taken))
            p, fb, drawn = place(h, group, feats, stems, taken)
            taken.append(p)
            aid, mat = "omberg_tee_sign_%s" % key, "tee_sign_face_%s" % key
            materials[mat] = {"image": rel(path), "smoothness": 0.45}
            assets[aid] = {"category": "prop", "collider": "box", "parts": [
                {"kind": "plank_sign", "face": mat, "back": "tee_plank_back", "mat": "tee_post_wood",
                 "width": size[0], "height": size[1], "bottom": BOTTOM}]}
            # the printed side is local -y, which looks to yawDeg + 90
            instances.append({"asset": aid, "e": round(p[0], 2), "n": round(p[1], 2), "yawDeg": round((fb - 90) % 360, 2), "ground": "centre",
                              "tees": [{"color": t["color"], "length": t["length"]} for t in group],
                              "teeBox": "drawn" if drawn else "assumed"})
            check.append({"e": p[0], "n": p[1], "face": fb, "tees": [t["at"] for t in group], "label": "%d %s%s" % (num, "/".join(t["color"] for t in group), "" if drawn else " (no box)")})
            print("hole %2d  %-22s %-24s at %.1f %.1f faces %3.0f%s" % (num, "/".join(t["color"] for t in group),
                  "  ".join("%s %d" % ("+".join(cs), L) for cs, L in sr), p[0], p[1], fb % 360, "" if drawn else "  (no tee box drawn)"))
    spec = {"format": "golfmap-props-spec-v1", "course": "ombergs-golfklubb", "materials": materials,
            "origin": [477650.0, 6457400.0], "assets": assets, "instances": [{k: v for k, v in i.items() if k != "tees"} for i in instances],
            "signs": instances}
    with open(os.path.join(HERE, "tee-signs.json"), "w", encoding="utf-8") as f:
        json.dump(spec, f, indent=1, ensure_ascii=False)
    check_sheet(ortho, check, feats)
    print("%d signs" % len(instances))


if __name__ == "__main__":
    main()
