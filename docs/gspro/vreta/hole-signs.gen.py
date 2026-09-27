"""Vreta hole signs: one tee sign per hole (hole number, par, index, hole view, tee lengths) and a slab bench
by the yellow tee, for docs/gspro/vreta/clubhouse-props.gen.py (which adds them to the props spec).

    pipeline/.venv/Scripts/python.exe docs/gspro/vreta/hole-signs.gen.py
      -> docs/gspro/vreta/hole-signs.json          positions + board outline (committed)
      -> data/props/<site>/hole-signs/hole_NN.png  board faces (generated, gitignored)

Sources, 2026-09-26:
  - the real sign (hole 10, Marcus's photo): black board with a bonnet top and a cream inset line, the club
    logo, "10  PAR 4  INDEX 4", a hole view fading into the black, "Halets langd" per tee (61/57/54/48/38) at
    the bottom right; hung from an arm on a black post with a finial and a curved brace. The sponsor plates
    under it are that hole's own and are left out.
  - par and stroke index: the app's holes (they agree with the club's card); tee lengths: the club's card as
    Caddee publishes it (caddee.se/klubb/vreta-kloster-golfklubb; its hole 10 row matches the photographed sign).
  - hole view: the 2025 ortho along the app's tee -> aim points -> green line, green up.
  - placement: the app's yellow tee, tee/path/hazard features and the lidar tree stems. Holes 1 and 10 are
    placed from photos (17; 28-29) instead.
"""
import json
import math
import os
import sqlite3

import numpy as np
import rasterio
from rasterio.warp import transform as warp
from rasterio.windows import from_bounds
from PIL import Image, ImageDraw, ImageFilter, ImageFont, ImageEnhance
from shapely.geometry import Point, Polygon, LineString
from shapely.ops import unary_union

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
SITE = "88E5F5B7-B1E6-4EBA-9D47-49B289C59EAE"
DB = os.path.join(ROOT, "data", "app.sqlite")
ORTHO = os.path.join(ROOT, "data", "sources", SITE, "ortho-orto-l2-2025.tif")
STEMS = os.path.join(ROOT, "data", "tiles", SITE, "tree-stems.json")
OUT_DIR = os.path.join(ROOT, "data", "props", SITE, "hole-signs")
FONT = "C:/Windows/Fonts/bahnschrift.ttf"

# Tee lengths (m) per tee name, from the club's card (Caddee). The sign lists the tees longest first.
TEES = ["61", "57", "54", "48", "38"]
LENGTHS = {
    1: [478, 463, 463, 399, 314], 2: [325, 294, 294, 260, 152], 3: [153, 153, 133, 133, 133],
    4: [383, 354, 354, 319, 234], 5: [481, 480, 480, 384, 315], 6: [377, 377, 319, 319, 238],
    7: [158, 136, 111, 111, 75], 8: [357, 331, 331, 287, 190], 9: [369, 336, 283, 283, 225],
    10: [355, 340, 340, 304, 235], 11: [274, 242, 242, 217, 177], 12: [432, 432, 340, 340, 246],
    13: [172, 149, 149, 112, 112], 14: [380, 344, 344, 303, 236], 15: [508, 469, 388, 388, 333],
    16: [158, 144, 144, 98, 98], 17: [325, 299, 299, 228, 149], 18: [370, 323, 323, 268, 198],
}
# Placed from photos (EPSG:3006 offsets from E0/N0 as in clubhouse-props.gen.py): sign (e, n, yaw), bench (e, n, yaw).
E0, N0 = 530000.0, 6487000.0
FIXED = {
    1: ((138.0, 636.0, 277.0), (138.6, 635.2, 95.0)),   # across the path from the tee, by the cart bay (photo 17)
    10: ((183.3, 585.6, 150.0), (184.6, 584.2, 150.0)),  # photos 28-29
}

# Board: 0.60 x 0.85 m, bonnet top (straight sides to 0.84 of the height, a cosine bell over the top).
BOARD_W, BOARD_H, SHOULDER = 0.60, 0.85, 0.84
PX_W = 1024
PX_H = int(round(PX_W * BOARD_H / BOARD_W))


def outline(n=24):
    """Board outline in metres (x across from the left edge, z up from the bottom edge), counter-clockwise."""
    top = [(BOARD_W * i / n, BOARD_H * (SHOULDER + (1 - SHOULDER) * (1 - math.cos(2 * math.pi * i / n)) / 2)) for i in range(n + 1)]
    return [(0.0, 0.0), (BOARD_W, 0.0)] + top[::-1]


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
    for h in db.execute("select id, number, par, stroke_index from holes where course_id=? and number between 1 and 18 order by number", (SITE,)):
        tees = {t["color"]: to3006(t["lon"], t["lat"]) for t in db.execute("select color, lat, lon from tees where hole_id=?", (h["id"],))}
        g = db.execute("select center_lat, center_lon from greens where hole_id=?", (h["id"],)).fetchone()
        aims = [to3006(a["lon"], a["lat"]) for a in db.execute("select lat, lon from aim_points where hole_id=? order by sort_order", (h["id"],))]
        holes[h["number"]] = {"id": h["id"], "par": h["par"], "index": h["stroke_index"], "tees": tees,
                              "green": to3006(g["center_lon"], g["center_lat"]), "aims": aims}
    feats = []
    for f in db.execute("select type, hole_id, geometry_json from course_features where course_id=?", (SITE,)):
        for r in rings(f["geometry_json"]):
            if len(r) >= 3:
                p = Polygon(r).buffer(0)
                if not p.is_empty:
                    feats.append((f["type"], f["hole_id"], p))
    return holes, feats


# ---------------------------------------------------------------------------------------------
# Board face
# ---------------------------------------------------------------------------------------------
BG = (20, 22, 24)
INK = (196, 194, 186)      # the scene lights sunlit faces at ~1.7x albedo: keep whites ~sRGB 190
CREAM = (176, 158, 118)
GREEN = (84, 150, 104)


def font(size, weight="Bold"):
    f = ImageFont.truetype(FONT, size)
    try:
        f.set_variation_by_name(weight)
    except Exception:  # noqa: BLE001 - static font: its one weight
        pass
    return f


def board_mask(scale=1):
    W, H = PX_W * scale, PX_H * scale
    m = Image.new("L", (W, H), 0)
    ImageDraw.Draw(m).polygon([(x / BOARD_W * W, H - z / BOARD_H * H) for x, z in outline(64)], fill=255)
    return m


def logo(d, cx, y):
    """Club logo: the abbey church (west tower with a spire over the nave), VRETAKLOSTER / GOLFKLUBB."""
    s = PX_W / 1024
    tw, th = 22 * s, 46 * s
    d.polygon([(cx - tw / 2, y + th), (cx - tw / 2, y + 14 * s), (cx, y - 14 * s), (cx + tw / 2, y + 14 * s), (cx + tw / 2, y + th)], fill=CREAM)
    d.polygon([(cx + tw / 2, y + th), (cx + tw / 2, y + 26 * s), (cx + 44 * s, y + 26 * s), (cx + 52 * s, y + 34 * s), (cx + 52 * s, y + th)], fill=CREAM)
    d.polygon([(cx - tw / 2, y + th), (cx - tw / 2, y + 32 * s), (cx - 30 * s, y + 32 * s), (cx - 34 * s, y + 38 * s), (cx - 34 * s, y + th)], fill=CREAM)
    f1, f2 = font(int(52 * s), "Bold Condensed"), font(int(26 * s), "SemiBold")
    a, b = "VRETA", "KLOSTER"
    wa, wb = d.textlength(a, font=f1), d.textlength(b, font=f1)
    x0 = cx - (wa + wb) / 2
    ty = y + th + 8 * s
    d.text((x0, ty), a, font=f1, fill=GREEN)
    d.text((x0 + wa, ty), b, font=f1, fill=INK)
    g = "G O L F K L U B B"
    d.text((cx - d.textlength(g, font=f2) / 2, ty + 58 * s), g, font=f2, fill=(150, 148, 142))


def hole_view(ortho, h, feats, box):
    """The hole along tee -> aims -> green, green up, faded into the board black outside the hole."""
    x0, y0, x1, y1 = box
    VW, VH = x1 - x0, y1 - y0
    T = h["tees"].get("yellow") or next(iter(h["tees"].values()))
    line = [T] + h["aims"] + [h["green"]]
    ang = math.atan2(h["green"][0] - T[0], h["green"][1] - T[1])  # bearing tee -> green
    ca, sa = math.cos(ang), math.sin(ang)
    rot = lambda e, n: ((e - T[0]) * ca - (n - T[1]) * sa, (e - T[0]) * sa + (n - T[1]) * ca)  # x right, y up the hole
    corridor = LineString(line).buffer(45)
    keep = [p for t, hid, p in feats if hid == h["id"] and t in ("fairway", "green", "tee", "bunker") and p.intersects(corridor)]
    pts = [rot(*p) for p in line] + [rot(*c) for p in keep for c in p.exterior.coords]
    pts += [rot(*c) for c in h["tees"].values()]
    rx0, rx1 = min(p[0] for p in pts) - 18, max(p[0] for p in pts) + 18
    ry0, ry1 = min(p[1] for p in pts) - 14, max(p[1] for p in pts) + 14
    # fit the region's aspect, centred on the hole
    mpp = max((rx1 - rx0) / VW, (ry1 - ry0) / VH)
    cx, cy = (rx0 + rx1) / 2, (ry0 + ry1) / 2
    # sample the ortho on the rotated grid (nearest of a 0.25 m read, then a light blur)
    R = max(VW, VH) * mpp * 0.75 + 30
    me, mn = T[0] + cx * ca + cy * sa, T[1] - cx * sa + cy * ca
    step = max(0.25, mpp / 1.5)
    n_px = int(2 * R / step)
    win = from_bounds(me - R, mn - R, me + R, mn + R, ortho.transform)
    img = ortho.read([1, 2, 3], window=win, out_shape=(3, n_px, n_px), boundless=True, fill_value=0).transpose(1, 2, 0)
    jj, ii = np.mgrid[0:VH, 0:VW]
    lx = cx + (ii - VW / 2 + 0.5) * mpp
    ly = cy - (jj - VH / 2 + 0.5) * mpp
    e = T[0] + lx * ca + ly * sa
    n = T[1] - lx * sa + ly * ca
    col = np.clip(((e - (me - R)) / step).astype(int), 0, n_px - 1)
    row = np.clip((((mn + R) - n) / step).astype(int), 0, n_px - 1)
    view = Image.fromarray(img[row, col].astype(np.uint8)).filter(ImageFilter.GaussianBlur(0.6))
    view = ImageEnhance.Color(ImageEnhance.Contrast(ImageEnhance.Brightness(view).enhance(1.2)).enhance(1.12)).enhance(1.3)
    # fade: the hole's own surfaces and the line of play, grown and feathered
    m = Image.new("L", (VW, VH), 0)
    md = ImageDraw.Draw(m)
    topx = lambda e, n: ((rot(e, n)[0] - cx) / mpp + VW / 2, VH / 2 - (rot(e, n)[1] - cy) / mpp)
    for p in keep:
        md.polygon([topx(*c) for c in p.exterior.coords], fill=255)
    md.line([topx(*p) for p in line], fill=255, width=int(40 / mpp))
    grow = int(16 / mpp) | 1
    m = m.filter(ImageFilter.MaxFilter(min(grow, 61))).filter(ImageFilter.GaussianBlur(9 / mpp + 6))
    # distances to the green centre along the line of play, like the real board
    d = ImageDraw.Draw(view)
    f = font(max(14, int(VW / 22)), "SemiBold")
    total = sum(math.dist(a, b) for a, b in zip(line, line[1:]))
    for dist in (100, 150, 200, 250, 300):
        s = total - dist
        if s < 25:
            continue
        for a, b in zip(line, line[1:]):
            L = math.dist(a, b)
            if s <= L:
                q = (a[0] + (b[0] - a[0]) * s / L, a[1] + (b[1] - a[1]) * s / L)
                x, y = topx(*q)
                t = str(dist)
                w = d.textlength(t, font=f)
                d.text((x - w / 2 + 1, y - f.size / 2 + 1), t, font=f, fill=(0, 0, 0))
                d.text((x - w / 2, y - f.size / 2), t, font=f, fill=INK)
                break
            s -= L
    return view, m


def board(ortho, num, h, feats, path):
    img = Image.new("RGB", (PX_W, PX_H), BG)
    d = ImageDraw.Draw(img)
    s = PX_W / 1024
    # cream inset line following the outline
    m = board_mask()
    pad = 40  # erode inside a black margin: the filters repeat the image edge, which would keep the sides
    big = Image.new("L", (PX_W + 2 * pad, PX_H + 2 * pad), 0)
    big.paste(m, (pad, pad))
    inner = big.filter(ImageFilter.MinFilter(int(34 * s) | 1))
    inner2 = inner.filter(ImageFilter.MinFilter(int(9 * s) | 1))
    ring = Image.fromarray(np.array(inner) - np.array(inner2)).crop((pad, pad, pad + PX_W, pad + PX_H))
    img.paste(Image.new("RGB", img.size, CREAM), (0, 0), ring)
    logo(d, PX_W / 2, 0.045 * PX_H)
    # number row
    fb, fr = font(int(110 * s), "Bold"), font(int(64 * s), "SemiBold")
    y = 0.215 * PX_H
    d.text((0.09 * PX_W, y), str(num), font=fb, fill=INK)
    t = "PAR %d   INDEX %d" % (h["par"], h["index"])
    d.text((0.93 * PX_W - d.textlength(t, font=fr), y + 36 * s), t, font=fr, fill=INK)
    # hole view, left and down the middle; lengths bottom right
    box = (int(0.09 * PX_W), int(0.33 * PX_H), int(0.72 * PX_W), int(0.93 * PX_H))
    view, vm = hole_view(ortho, h, feats, box)
    img.paste(view, box[:2], vm)
    fl, fh = font(int(34 * s), "SemiBold"), font(int(32 * s), "Regular")
    ly = 0.765 * PX_H
    d.text((0.70 * PX_W, ly), "Hålets längd", font=fh, fill=INK)
    for i, (tee, L) in enumerate(zip(TEES, LENGTHS[num])):
        d.text((0.70 * PX_W, ly + (i + 1) * 40 * s), "%s:  %dm" % (tee, L), font=fl, fill=INK)
    # outside the outline: black (the texture is mapped onto the board's shape)
    img = Image.composite(img, Image.new("RGB", img.size, BG), m)
    img.save(path)


# ---------------------------------------------------------------------------------------------
# Placement
# ---------------------------------------------------------------------------------------------
BLOCK = ("tee", "green", "fairway", "bunker", "water", "water_creek", "penalty_red", "penalty_yellow", "path")


def place(num, h, feats, stems):
    T = h["tees"].get("yellow") or next(iter(h["tees"].values()))
    first = h["aims"][0] if h["aims"] else h["green"]
    dx, dy = first[0] - T[0], first[1] - T[1]
    L = math.hypot(dx, dy)
    dx, dy = dx / L, dy / L
    near = [(t, p) for t, _, p in feats if p.distance(Point(T)) < 40]
    tee = min((p for t, p in near if t == "tee"), key=lambda p: p.distance(Point(T)))
    blocked = unary_union([p for t, p in near if t in BLOCK]).buffer(0.9)
    blocked = blocked.union(unary_union([p for t, p in near if t == "vegetation_zone"] or [Point(0, 0).buffer(0.01)]).buffer(0.5))  # tall grass
    semi = unary_union([p for t, p in near if t == "semi_rough"] or [Point(0, 0).buffer(0.01)])
    paths = unary_union([p for t, p in near if t == "path"] or [Point(0, 0).buffer(0.01)])
    have_path = paths.distance(Point(T)) < 30
    trees = [(x, y, r) for x, y, _, r, _, _ in stems if abs(x - T[0]) < 40 and abs(y - T[1]) < 40]
    best = None
    for ox in np.arange(-22, 22.01, 0.5):
        for oy in np.arange(-22, 22.01, 0.5):
            p = (T[0] + ox, T[1] + oy)
            s_along = ox * dx + oy * dy
            dt = tee.distance(Point(p))
            if not (2.0 <= dt <= 9.0) or s_along > 4.0 or blocked.contains(Point(p)):
                continue
            if any(math.hypot(p[0] - x, p[1] - y) < r + 1.5 for x, y, r in trees):
                continue
            # the bench beside the post, on the side away from the board's arm
            bear = math.atan2(T[0] - p[0], T[1] - p[1])
            yaw = math.degrees(bear) + 90
            ux, uy = math.sin(math.radians(yaw)), math.cos(math.radians(yaw))
            bench = (p[0] - 1.5 * ux, p[1] - 1.5 * uy)
            if blocked.contains(Point(bench)) or any(math.hypot(bench[0] - x, bench[1] - y) < r + 1.2 for x, y, r in trees):
                continue
            score = math.dist(p, T) * 0.25 + dt * 0.5 + max(0.0, s_along) * 1.5
            if have_path:
                score += abs(paths.distance(Point(p)) - 1.8) * 1.2
            if semi.contains(Point(p)):
                score += 2.0
            if best is None or score < best[0]:
                best = (score, p, yaw, bench)
    if best is None:
        raise RuntimeError("hole %d: no spot for the sign near the yellow tee" % num)
    _, p, yaw, bench = best
    return (p[0] - E0, p[1] - N0, yaw % 360), (bench[0] - E0, bench[1] - N0, yaw % 360)


def main():
    holes, feats = load()
    stems = json.load(open(STEMS))["trees"]
    os.makedirs(OUT_DIR, exist_ok=True)
    ortho = rasterio.open(ORTHO)
    signs = []
    for num, h in sorted(holes.items()):
        path = os.path.join(OUT_DIR, "hole_%02d.png" % num)
        board(ortho, num, h, feats, path)
        sign, bench = FIXED.get(num) or place(num, h, feats, stems)
        T = h["tees"].get("yellow")
        signs.append({"hole": num, "par": h["par"], "index": h["index"], "lengths": dict(zip(TEES, LENGTHS[num])),
                      "texture": os.path.relpath(path, HERE).replace(os.sep, "/"),
                      "sign": [round(v, 2) for v in sign], "bench": [round(v, 2) for v in bench],
                      "yellowTee": [round(T[0] - E0, 2), round(T[1] - N0, 2)] if T else None,
                      "placed": "photo" if num in FIXED else "auto"})
        print("hole %2d  par %d  index %2d  sign %7.1f %7.1f yaw %5.1f  (%s)" % (num, h["par"], h["index"], sign[0], sign[1], sign[2], signs[-1]["placed"]))
    spec = {"board": {"width": BOARD_W, "height": BOARD_H, "outline": [[round(x, 4), round(z, 4)] for x, z in outline()]}, "signs": signs}
    with open(os.path.join(HERE, "hole-signs.json"), "w", encoding="utf-8") as f:
        json.dump(spec, f, indent=1, ensure_ascii=False)


if __name__ == "__main__":
    main()
