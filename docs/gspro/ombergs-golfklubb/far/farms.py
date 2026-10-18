"""Far farmsteads east of the course: A (E 478470-478560, N 6457270-6457380) and B (E 479000-479120, N 6457230-6457360).
Simple lidar-fitted buildings (300-1500 triangles each), seen at 300-900 m: right footprint, roof form, height, colour.

Method and engine are background/west.py's (RANSAC plane fits to class-1 returns, lidar-extent roofs, true valleys by plane cuts,
plinths to the lowest terrain); it is imported, not copied, for Roofs / Wall / plinth / helpers. What this file simplifies:
flush glass and flat casings instead of recessed windows, no gutters, steps, chimneys or door furniture.

Evidence and rules (numbers in the specs, marked "lidar" / "ortho" / "inferred"):
  * Roofs: plane fits (rms 0.04-0.07 m) where the lidar sees them. Dark sheet roofs return nothing (A2, A3 west slope, A_ne,
    B1, B2, B4, B6): their ridge height is inferred (eave 2.4-3.0 m, pitch 0.5-0.65) and the outline is the ortho's.
  * The 2025 ortho leans: roof tops sit ~1 m off the lidar, so extents are lidar extents + 0.35 m (sparse edge sampling) and
    the OSM polygon (traced on the ortho) only supplies size and wing layout.
  * Walls are invisible from above: white / pale yellow / falu red from the glimpses of wall the lean shows (A2 west house: white
    strip; A3: white south wall; A2 east house: dark red-brown; B5: white gable) - inferred.
Asset frame of every building: x along compass bearing yawDeg, y to its left, origin where the spec says, z up from the median
class-2 ground in a ring round the roof.
"""
import math
import sys
from pathlib import Path

import numpy as np

import props_kit as kit

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "background"))
import west as W  # noqa: E402  (Roofs, Wall, plinth, corner_boards, solar_array, window helpers)

MATTE = {"tile_red", "sheet_dark", "sheet_char", "sheet_pale", "felt_grey", "wall_white", "wall_yellow",
         "wall_grey", "plinth"}
WHITE, GLASS = W.WHITE, W.GLASS
RED = "falu_red_vertical"


def register_materials():
    M = kit.MATERIALS
    M["tile_red"] = ("pantile:146,84,66", (2.0, 2.0), None, 0.25, 0.0)           # ortho: sunlit red tile of the A and B houses
    M["sheet_dark"] = ("seam:62,67,76:0.52:2.08:0", (2.08, 2.08), None, 0.25, 0.2)
    M["sheet_char"] = ("seam:84,91,102:0.52:2.08:0", (2.08, 2.08), None, 0.25, 0.2)
    M["sheet_pale"] = ("seam:172,176,180:0.076:2.0:1", (2.0, 2.0), None, 0.12, 0.1)  # reads white where the sun hits it
    M["felt_grey"] = ("felt:112,106,100", (2.0, 2.0), None, 0.1, 0.0)           # A1 lean-to and the tiny shed: weathered grey-brown in the ortho
    M["wall_white"] = ("boards:192,190,182:h:0.14:2.0:0", (2.0, 2.0), None, 0.12, 0.0)
    M["wall_yellow"] = ("boards:204,182,118:h:0.14:2.0:0", (2.0, 2.0), None, 0.12, 0.0)
    M["wall_grey"] = ("boards:108,102,92:v:0.18:2.0:2", (2.0, 2.0), None, 0.1, 0.0)  # A1: the ortho shows weathered grey boards
    M["plinth"] = ("plaster:128,126,120", (2.0, 2.0), None, 0.1, 0.0)


# ---------------------------------------------------------------------------------------------
# Walls with flush openings (west.Wall's recesses, reveals, bars and furniture cost ~40 triangles a window)
# ---------------------------------------------------------------------------------------------
class LiteWall(W.Wall):
    def opening(self, g, o):
        """Glass or door leaf flush in the hole, a flat casing 3 cm proud on four sides. Local frame: x along the wall,
        y up, z out of the wall."""
        kind, w, h, sill = o.get("kind", "window"), o["w"], o["h"], o["sill"]
        hw, tr, cw = w / 2, o.get("trim", self.trim), 0.11
        g.push(self.frame(o["t"]))
        W.quad_n(g, [(-hw, sill, 0), (hw, sill, 0), (hw, sill + h, 0), (-hw, sill + h, 0)], (0, 0, 1),
                 GLASS if kind == "window" else (o.get("mat") or "door_white"))
        z, y1 = 0.03, sill + h + cw
        for p in ([(-hw - cw, sill - cw, z), (hw + cw, sill - cw, z), (hw + cw, sill, z), (-hw - cw, sill, z)] if kind == "window" else [],
                  [(-hw - cw, sill, z), (-hw, sill, z), (-hw, y1, z), (-hw - cw, y1, z)],
                  [(hw, sill, z), (hw + cw, sill, z), (hw + cw, y1, z), (hw, y1, z)],
                  [(-hw, sill + h, z), (hw, sill + h, z), (hw, y1, z), (-hw, y1, z)]):
            if p:
                W.quad_n(g, p, (0, 0, 1), tr)
        g.pop()


def build_building(g, S, sink):
    """S: outline (CCW wall polygon), pieces, wall (material), zb (plinth top), open {edge: [openings]}, walls_extra, extra(g, roofs),
    tile (top material), cap, thick."""
    roofs = W.Roofs(S["pieces"], S.get("thick", 0.12))
    outline, zb = S["outline"], S.get("zb", 0.3)
    n = len(outline)
    W.plinth(g, outline, sink, zb, "plinth")
    walls = []

    def make_wall(a, b, zbot, opens, bottom=None):
        ux, uy = b[0] - a[0], b[1] - a[1]
        L = math.hypot(ux, uy)
        ops = []
        for o in opens:
            o = dict(o)
            o["t"] = (o["c"] - a[0]) / (ux / L) if abs(ux) > abs(uy) else (o["c"] - a[1]) / (uy / L)
            if o["t"] - o["w"] / 2 < 0.25 or o["t"] + o["w"] / 2 > L - 0.25:
                print("WARNING opening off the wall: %s %s c=%.2f (wall %.2f long)" % (S["name"], a, o["c"], L))
                continue
            if o["kind"] in ("door", "barn"):
                o["sill"] = zbot
            ops.append(o)
        w = LiteWall(a, b, roofs, S["wall"], zbot, ops)
        if bottom:
            w.bottom = bottom
        w.tag = S["name"]
        walls.append(w)

    for i in range(n):
        make_wall(outline[i], outline[(i + 1) % n], zb, S.get("open", {}).get(i, []))
    for we in S.get("walls_extra", []):
        make_wall(*we)
    for w in walls:
        try:
            w.build(g)
        except ValueError as e:
            raise ValueError("%s wall %s->%s: %s top=%s" % (S["name"], tuple(w.a), tuple(w.b), e, w.top))
    if S.get("corners", True):
        W.corner_boards(g, roofs, outline, zb)
    roofs.build(g, S["tile"], WHITE, WHITE, S.get("cap", S["tile"]), S.get("ridge_w", 0.22))
    if "extra" in S:
        S["extra"](g, roofs, walls)
    return roofs


# ---------------------------------------------------------------------------------------------
# Roof pieces and frames
# ---------------------------------------------------------------------------------------------
def gable_x(y0, z, pn, ps, x0, x1, ylo, yhi, ovh=(0.4, 0.4, 0.45, 0.45), **kw):
    """Ridge along x at y = y0 (height z); pitch pn on the +y slope, ps on the -y slope. Outline x0..x1, ylo..yhi;
    ovh = (rake x0, rake x1, eave y0, eave y1). mats = [+y slope, -y slope]."""
    return W.piece([(0, -pn, z + pn * y0), (0, ps, z - ps * y0)], (x0, x1, ylo, yhi), ovh, **kw)


def gable_y(x0, z, pe, pw, xlo, xhi, y0, y1, ovh=(0.45, 0.45, 0.4, 0.4), **kw):
    """Ridge along y at x = x0; pitch pe on the +x slope, pw on the -x slope. mats = [+x slope, -x slope]."""
    return W.piece([(-pe, 0, z + pe * x0), (pw, 0, z - pw * x0)], (xlo, xhi, y0, y1), ovh, **kw)


def walls_rect(pc):
    x0, x1, y0, y1 = pc["wrect"]
    return W.rect_outline(x0, x1, y0, y1)


class Frame:
    """Local frame (x along math angle `ang`, y to its left) at (cx, cy); `rect` = roof bounding box (x0, x1, y0, y1) used for the
    ground ring: median class-2 height in a 0.8-4 m ring round it (the lidar fits are used as they are)."""

    def __init__(self, ev, cx, cy, ang, rect):
        self.ev, self.cx, self.cy, self.ang = ev, cx, cy, ang
        t = math.radians(ang)
        self.c, self.s = math.cos(t), math.sin(t)
        p = ev.points
        d = p[:, :2] - [cx, cy]
        x, y = d[:, 0] * self.c + d[:, 1] * self.s, -d[:, 0] * self.s + d[:, 1] * self.c
        x0, x1, y0, y1 = rect
        box = lambda m: (x > x0 - m) & (x < x1 + m) & (y > y0 - m) & (y < y1 + m)
        ring = box(4.0) & ~box(0.8) & (p[:, 3] == 2)
        self.ground = float(np.median(p[ring, 2]))
        self.rect = rect

    def en(self, x, y):
        return self.cx + x * self.c - y * self.s, self.cy + x * self.s + y * self.c

    def Z(self, zabs):
        return zabs - self.ground

    def sink(self, outline, margin=1.5):
        """Plinth bottom: a little under the lowest outer-DEM terrain (what Unity uses) under and round the footprint."""
        xs, ys = [p[0] for p in outline], [p[1] for p in outline]
        lo = min(self.ev.terrain(*self.en(x, y)) for x in np.linspace(min(xs) - margin, max(xs) + margin, 14)
                 for y in np.linspace(min(ys) - margin, max(ys) + margin, 14))
        return min(lo - self.ground, 0.0) - 0.4

    def place(self, add, aid, g):
        add(aid, g, self.cx, self.cy, (90 - self.ang) % 360, self.ground)


BUILDINGS = []


def building(aid, cx, cy, ang, rect):
    def deco(fn):
        BUILDINGS.append((aid, (cx, cy, ang, rect), fn))
        return fn
    return deco


win, door = W.win, W.door


def barn_door(c, w=3.2, h=3.0, mat="door_black"):
    return W.barn_door(c, w, h, mat)


# ===== Farmstead A ==============================================================================================
# ---- OSM 1431576952: the long white-roofed building. Lidar planes n=230/182 rms 0.07: ridge 124.34 at v=+0.08 (frame: OSM
# rect, 57.1 deg), pitch 0.938/0.915; roof returns v -4.9..5.27, u -13.5..16.5 (+0.35). A low lean-to at the south-west end
# (returns on the plane z=119.0+0.2(u+17), u -17.2..-13.2, v -4.4..5.4) - the ortho's grey-brown "end" is its roof, not a wall.
@building("omberg_far_a_long", 478490.96, 6457289.88, 57.1, (-17.7, 16.9, -5.3, 5.7))
def a_long(S):
    R = S.Z(124.34)
    main = gable_x(0.08, R, 0.927, 0.927, -13.85, 16.85, -5.25, 5.65, mats=["sheet_pale", "sheet_pale"])
    za, sl = S.Z(119.0), 0.2
    annex = W.piece([(sl, 0, za + sl * 17.0)], (-17.65, -13.45, -5.1, 5.5), (0.35, 0.0, 0.3, 0.3), mats=["felt_grey"])
    zr = za + sl * (17.0 - 13.45)
    out = W.rect_outline(-17.3, 16.45, -4.8, 5.2)
    return dict(name="a_long", outline=out, pieces=[main, annex], tile="sheet_pale", wall="wall_grey", zb=0.3,
                walls_extra=[((-13.45, 5.2), (-13.45, -4.8), 0, [], [(0.0, zr - 0.15), (10.0, zr - 0.15)])],     # the gable above the lean-to
                open={0: [barn_door(-6.0, 3.4, 2.7, "door_black"), win(-1.0, 1.0, 0.9, 1.6), win(4.0, 1.0, 0.9, 1.6), win(9.0, 1.0, 0.9, 1.6),
                          win(14.0, 1.0, 0.9, 1.6)],
                      2: [win(x, 1.0, 0.9, 1.6) for x in (-8.0, -3.0, 2.0, 7.0, 12.0)],
                      1: [win(0.2, 0.8, 0.8, 4.2)], 3: [door(0.2, 1.0, 1.9)]})


# ---- A2 west house (not in OSM): dark sheet, no returns. Ortho (rotated 61 deg): roof 13 x 10 m, light/dark ridge edge at
# v=-1.3; inferred eave 3.0 m, ridge 5.2 m, one pitch on each slope so the eaves stay level.
@building("omberg_far_a_house_w", 478502.0, 6457332.0, 61.0, (-5.6, 7.7, -5.2, 5.0))
def a_house_w(S):
    r0 = -1.0
    pc = gable_x(r0, 5.2, 0.5, 0.5, -5.6, 7.7, -5.2, 5.0, mats=["sheet_dark", "sheet_char"])
    return dict(name="a_house_w", outline=walls_rect(pc), pieces=[pc], tile="sheet_dark", wall="wall_white", thick=0.12, zb=0.35,
                open={0: [win(x, 1.0, 1.2, 0.95) for x in (-3.5, -0.5, 2.5, 5.0)],
                      2: [win(x, 1.0, 1.2, 0.95) for x in (-3.5, -0.5, 2.5)] + [door(5.0, 1.0, 1.85)],
                      1: [win(0.0, 0.9, 1.1, 0.95)], 3: [win(-0.5, 0.9, 1.1, 0.95)]})


# ---- A2 east house (not in OSM): dark sheet. Ortho (rotated -38 deg): roof u -7.5..5.7, v -1.9..4.9, ridge v~+1.5; walls dark red.
@building("omberg_far_a_house_e", 478515.4, 6457335.3, -38.0, (-7.6, 5.8, -2.0, 5.0))
def a_house_e(S):
    pc = gable_x(1.5, 4.5, 0.5, 0.5, -7.5, 5.7, -1.9, 4.9, mats=["sheet_dark", "sheet_char"])
    return dict(name="a_house_e", outline=walls_rect(pc), pieces=[pc], tile="sheet_dark", wall=RED, thick=0.12, zb=0.3,
                open={0: [win(x, 0.9, 1.1, 0.95) for x in (-5.0, -2.0, 1.0, 4.0)],
                      2: [win(x, 0.9, 1.1, 0.95) for x in (-4.0, -1.0, 2.0)], 3: [door(1.0, 1.0, 2.0)]})


# ---- small dark shed west of the houses (not in OSM): ortho ~6 x 4.6 m, ridge along 38 deg; inferred eave 2.2, ridge 3.4
@building("omberg_far_a_shed_w", 478491.0, 6457322.5, 38.0, (-3.2, 3.2, -2.6, 2.6))
def a_shed_w(S):
    pc = gable_x(0.0, 3.4, 0.55, 0.55, -3.2, 3.2, -2.6, 2.6, (0.3, 0.3, 0.3, 0.3), mats=["sheet_dark", "sheet_char"])
    return dict(name="a_shed_w", outline=walls_rect(pc), pieces=[pc], tile="sheet_dark", wall=RED, thick=0.1, zb=0.2,
                open={2: [win(-1.0, 0.8, 0.8, 1.1)], 0: [door(1.0, 0.9, 1.7)]})


# ---- small white-roofed shed (not in OSM): plane n=30 z=120.446+0.571 v (frame 42.2 deg at 478506, 6457318), ridge v=-1.25 z 119.57
# (3.7 m), eaves 2.5 m on both slopes; ortho roof u -4.3..4.1, v -3.4..0.9
@building("omberg_far_a_shed_white", 478506.0, 6457318.0, 42.2, (-4.5, 4.3, -3.6, 1.1))
def a_shed_white(S):
    pc = gable_x(-1.25, S.Z(119.57), 0.56, 0.56, -4.4, 4.2, -3.5, 1.0, (0.3, 0.3, 0.3, 0.3), mats=["sheet_pale", "sheet_pale"])
    return dict(name="a_shed_white", outline=walls_rect(pc), pieces=[pc], tile="sheet_pale", wall=RED, thick=0.1, zb=0.2,
                open={2: [win(-1.5, 0.8, 0.8, 1.1), win(1.5, 0.8, 0.8, 1.1)], 0: [door(0.0, 0.9, 1.9)]})


# ---- tiny grey-roofed shed at the north-east end of the long building (not in OSM): ortho 5.8 x 4.4 m, inferred eave 2.2, ridge 3.3
@building("omberg_far_a_shed_n", 478501.3, 6457309.3, 38.0, (-2.9, 2.9, -2.2, 2.2))
def a_shed_n(S):
    pc = gable_x(0.0, 3.3, 0.55, 0.55, -2.9, 2.9, -2.2, 2.2, (0.3, 0.3, 0.3, 0.3), mats=["felt_grey", "felt_grey"])
    return dict(name="a_shed_n", outline=walls_rect(pc), pieces=[pc], tile="felt_grey", wall=RED, thick=0.1, zb=0.2,
                open={0: [win(-0.8, 0.8, 0.8, 1.1)], 2: [door(0.8, 0.9, 1.9)]})


# ---- A3 main house (not in OSM): gable ridge along 82.3 deg (planes n=239/181 rms 0.06: z=123.81-0.882v / 123.854+0.832v, ridge
# 123.83 at v=0, roof returns v -5.3..5.8, u -8..6.0; the dark west slope returns a few points). A cross gable on the east slope
# (ridge u=-1.2, z 123.6, plane z=123.48-0.555u n=58; the ortho shows its valleys) with walls white (the south wall shows white).
@building("omberg_far_a_house_n", 478529.3, 6457356.0, 82.3, (-8.5, 6.8, -6.0, 6.3))
def a_house_n(S):
    R = S.Z(123.83)
    main = gable_x(0.1, R, 0.857, 0.857, -8.35, 6.6, -5.8, 6.0, mats=["sheet_dark", "sheet_char"], cover="wrect")
    zc, hw, pc_, xc = S.Z(123.6), 3.0, 0.78, -1.2     # lidar: the +u side of the cross gable is low/steep (hipped in the ortho)
    cross = gable_y(xc, zc, pc_, pc_, xc - hw - 0.4, xc + hw + 0.4, -5.8, 0.2, (0.4, 0.4, 0.45, 0.0), mats=["sheet_dark", "sheet_char"],
                    cover="wrect")
    wm = main["wrect"]
    out = W.rect_outline(*wm)
    yf = wm[2]
    zm = lambda y: R - 0.857 * abs(y - 0.1)               # main slope under the cross gable's eave
    zu = zc - pc_ * hw - 0.12                              # cross eave underside

    def extra(g, roofs, walls):
        ym = -(R - zu) / 0.857 + 0.1                       # where the underside meets the main slope (y < 0)
        for x, nx in ((xc - hw, -1), (xc + hw, 1)):    # cheeks between the front wall, the main slope and the cross eave
            W.quad_n(g, [(x, yf, zm(yf) - 0.05), (x, ym, zm(ym)), (x, yf, zu)], (nx, 0, 0), "wall_white")
    return dict(name="a_house_n", outline=out, pieces=[main, cross], tile="sheet_dark", wall="wall_white", thick=0.12, zb=0.35, extra=extra,
                open={0: [win(x, 1.0, 1.2, 0.95) for x in (-6.0, -3.5, 3.5, 5.0)] + [win(xc, 1.0, 1.0, 4.8), door(xc, 1.1, 2.0)],
                      1: [win(-2.5, 1.0, 1.2, 0.95), win(2.0, 1.0, 1.2, 0.95), win(-0.2, 0.8, 1.0, 4.4)],
                      2: [win(x, 1.0, 1.2, 0.95) for x in (5.0, 2.0, -1.0, -4.0, -6.5)],
                      3: [win(-1.0, 1.0, 1.2, 0.95), win(1.5, 1.0, 1.2, 0.95), win(0.2, 0.8, 1.0, 4.4)]})


# ---- A3 red-roofed building south of it (not in OSM): planes n=44/32 rms 0.03-0.05 (z=121.75+0.889v / 122.608-0.834v, a 0.09 tilt),
# ridge v=+0.25 z 122.2, pitch 0.86; roof returns u -0.9..6.9, v -3.1..3.05 (+0.35); red tile
@building("omberg_far_a_red", 478534.0, 6457345.0, 0.0, (-1.6, 7.4, -3.6, 3.5))
def a_red(S):
    pc = gable_x(0.25, S.Z(122.2), 0.86, 0.86, -1.3, 7.25, -3.5, 3.4, (0.35, 0.35, 0.4, 0.4), mats=["tile_red", "tile_red"])
    return dict(name="a_red", outline=walls_rect(pc), pieces=[pc], tile="tile_red", wall="wall_yellow", thick=0.12, zb=0.3,
                open={0: [win(x, 0.9, 1.1, 0.95) for x in (0.5, 3.0, 5.5)], 2: [win(1.0, 0.9, 1.1, 0.95), door(3.5, 1.0, 2.0)],
                      3: [win(0.0, 0.8, 0.9, 2.6)], 1: [win(0.0, 0.8, 0.9, 2.6)]})


# ---- A3 dark building north-east (not in OSM): north slope returns n~90 (h 4.35 at v 2.3 to 2.6 at v 4.9, pitch 0.67), ridge v=+2.0
# z 4.6 above ground; ortho roof u -5.8..3.1, v -0.9..5.1
@building("omberg_far_a_ne", 478540.5, 6457362.0, 0.0, (-6.1, 3.1, -1.4, 5.4))
def a_ne(S):
    pc = gable_x(2.0, S.Z(116.97 + 4.6), 0.67, 0.67, -6.0, 3.0, -1.2, 5.2, (0.35, 0.35, 0.4, 0.4), mats=["sheet_dark", "sheet_char"])
    return dict(name="a_ne", outline=walls_rect(pc), pieces=[pc], tile="sheet_dark", wall=RED, thick=0.12, zb=0.3,
                open={0: [win(-3.0, 0.9, 0.9, 1.2), win(0.0, 0.9, 0.9, 1.2)],
                      3: [door(2.0, 1.0, 2.0)], 2: [win(-3.0, 0.9, 0.9, 1.2), win(0.0, 0.9, 0.9, 1.2)]})


# ===== Farmstead B ==============================================================================================
# ---- OSM 1109741288: the L-shaped barn. Frame: south wing's lidar frame (-16.2 deg at 479032, 6457283; x east, y north).
# South wing: planes z=127.593+0.813v / 128.938-0.744v (n=184/25), ridge v=0.86 z 128.30 (OSM tag 8.73 m), roof u<=12.5, v -4.95..6.65,
# solar array on the south slope. North-south wing (axis 73.8): east eave v=-7.4 at 123.8, ridge z 128.0, pitch 0.57, ridge at x=-15.8
# (lidar ridge points 8.2 m up), roof to y=27.8; its south gable wall is in line with the south wing's south wall.
@building("omberg_far_b_barn", 479032.0, 6457283.0, -16.2, (-23.0, 12.7, -5.1, 28.0))
def b_barn(S):
    R, xr = S.Z(128.1), -15.8
    ns = gable_y(xr, R, 0.57, 0.57, -22.9, -8.7, -4.95, 27.8, (0.45, 0.45, 0.4, 0.4), mats=["sheet_dark", "sheet_char"])
    sw = gable_x(0.86, R, 0.744, 0.81, xr, 12.5, -4.95, 6.65, (0.0, 0.4, 0.45, 0.45), mats=["sheet_char", "sheet_char"])
    out = [(-22.45, -4.5), (12.1, -4.5), (12.1, 6.2), (-9.15, 6.2), (-9.15, 27.4), (-22.45, 27.4)]

    def extra(g, roofs, walls):
        W.solar_array(g, (0, 0.81, R - 0.81 * 0.86), -6.0, 11.4, -4.2, 0.4)
    return dict(name="b_barn", outline=out, pieces=[ns, sw], tile="sheet_dark", wall=RED, thick=0.12, zb=0.35, extra=extra, ridge_w=0.26,
                open={0: [barn_door(-17.0, 3.6, 3.4), barn_door(-9.0, 3.6, 3.4)] + [win(x, 1.0, 0.9, 2.2) for x in (-3.0, 3.0, 9.0)],
                      1: [win(0.0, 1.0, 0.9, 2.2), door(3.0, 1.0, 2.0)],
                      2: [win(x, 1.0, 0.9, 2.2) for x in (-5.0, 0.0, 5.0)],
                      3: [win(x, 1.0, 0.9, 2.2) for x in (10.0, 15.0, 20.0, 25.0)],
                      4: [win(-15.8, 1.0, 1.0, 6.5)] + [win(x, 1.0, 0.9, 2.2) for x in (-20.0, -10.0)],
                      5: [win(y, 1.0, 0.9, 2.2) for y in (-2.0, 3.0, 8.0, 13.0, 18.0, 23.0)]})


# ---- OSM 1109741287: dark-roofed house, 17.6 x 9.5 m (OSM follows the ortho roof); the lidar sees no roof (tags eave 2.85, ridge 5.61)
@building("omberg_far_b_house_dark", 479067.64, 6457281.62, 81.9, (-8.9, 8.9, -4.8, 4.8))
def b_house_dark(S):
    pc = gable_x(0.0, 5.61, 0.64, 0.64, -8.8, 8.8, -4.75, 4.75, (0.4, 0.4, 0.45, 0.45), mats=["sheet_dark", "sheet_char"])
    return dict(name="b_house_dark", outline=walls_rect(pc), pieces=[pc], tile="sheet_dark", wall=RED, thick=0.12, zb=0.35,
                open={0: [win(x, 1.0, 1.2, 0.95) for x in (-6.0, -3.0, 0.0, 3.0)] + [door(6.0, 1.0, 2.1)],
                      2: [win(x, 1.0, 1.2, 0.95) for x in (-6.0, -3.0, 3.0, 6.0)] + [door(0.0, 1.0, 2.1)],
                      1: [win(0.0, 0.9, 1.0, 1.4)], 3: [win(0.0, 0.9, 1.0, 1.4)]})


# ---- OSM 1109741286: the white house with a cross-gabled roof. Planes: main ridge along 80.6 deg z=127.04 (n=172/118, pitch .714/.688),
# cross ridge at u=+1.07 z 127.05 (planes a=-0.568 / +0.62, n=43/36); equal ridge heights give the X of valleys; roof u -7.0..8.8 (+0.35),
# v -5.9..5.85 (the returns beyond are flat porch roofs 3.3-3.8 m up).
@building("omberg_far_b_house_cross", 479093.26, 6457292.91, 80.6, (-7.4, 9.2, -6.0, 5.9))
def b_house_cross(S):
    R = S.Z(127.04)
    outer = (-7.3, 9.1, -5.95, 5.85)   # |v| > 5.8: flat porch/veranda roofs at 121.9-122.5 (not modelled)
    main = gable_x(0.0, R, 0.688, 0.714, *outer, (0.4, 0.4, 0.45, 0.45), mats=["sheet_dark", "sheet_char"])
    cross = gable_y(1.07, R, 0.62, 0.62, *outer, (0.45, 0.45, 0.4, 0.4), mats=["sheet_dark", "sheet_char"])
    return dict(name="b_house_cross", outline=walls_rect(main), pieces=[main, cross], tile="sheet_dark", wall="wall_white", thick=0.12, zb=0.4,
                open={0: [win(x, 1.0, 1.3, 0.95) for x in (-4.5, -1.5, 2.0, 5.0)] + [win(x, 0.9, 1.1, 3.2) for x in (-4.5, -1.5, 2.0, 5.0)] +
                         [win(1.07, 1.0, 1.0, 5.5)],
                      1: [win(x, 1.0, 1.3, 0.95) for x in (-4.0, -1.5, 1.0, 3.5)] + [win(x, 0.9, 1.1, 3.2) for x in (-4.0, -1.5, 1.0, 3.5)] +
                         [win(0.0, 1.0, 1.0, 5.5)],
                      2: [win(x, 1.0, 1.3, 0.95) for x in (-4.5, -1.5, 2.0, 5.0)] + [win(x, 0.9, 1.1, 3.2) for x in (-4.5, -1.5, 2.0, 5.0)] +
                         [win(1.07, 1.0, 1.0, 5.5)],
                      3: [win(x, 1.0, 1.3, 0.95) for x in (-4.0, -1.5, 1.0, 3.5)] + [win(x, 0.9, 1.1, 3.2) for x in (-4.0, -1.5, 1.0, 3.5)] +
                         [win(0.0, 1.0, 1.0, 5.5)]})


# ---- OSM 1109741285: dark-roofed house, 16.3 x 6.7 m (no lidar returns: inferred eave 2.6, ridge 4.5)
@building("omberg_far_b_house_s", 479077.86, 6457240.19, 168.6, (-8.3, 8.3, -3.5, 3.5))
def b_house_s(S):
    pc = gable_x(0.0, 4.5, 0.67, 0.67, -8.15, 8.15, -3.35, 3.35, (0.35, 0.35, 0.4, 0.4), mats=["sheet_dark", "sheet_char"])
    return dict(name="b_house_s", outline=walls_rect(pc), pieces=[pc], tile="sheet_dark", wall="wall_white", thick=0.12, zb=0.3,
                open={0: [win(x, 1.0, 1.2, 0.95) for x in (-5.5, -2.5, 0.5, 3.5)] + [door(6.0, 1.0, 2.1)],
                      2: [win(x, 1.0, 1.2, 0.95) for x in (-5.5, -2.5, 2.5, 5.5)] + [door(-0.3, 1.0, 2.1)],
                      1: [win(0.0, 0.9, 1.0, 1.2)], 3: [win(0.0, 0.9, 1.0, 1.2)]})


# ---- OSM 1109741289: red-tile house. Planes z=124.662+0.72v / 125.158-0.71v (n=113/58), ridge v=+0.35 z 124.91 (5.9 m, tag 6.14),
# roof u -4.6..6.1, v -3.3..3.6 (+0.35); the west gable wall shows white in the ortho
@building("omberg_far_b_small_n", 479063.64, 6457341.62, 80.7, (-5.1, 6.5, -3.8, 4.0))
def b_small_n(S):
    pc = gable_x(0.35, S.Z(124.91), 0.715, 0.72, -5.0, 6.4, -3.7, 3.95, (0.4, 0.4, 0.4, 0.4), mats=["tile_red", "tile_red"])
    return dict(name="b_small_n", outline=walls_rect(pc), pieces=[pc], tile="tile_red", wall="wall_white", thick=0.12, zb=0.3,
                open={0: [win(x, 0.9, 1.1, 0.95) for x in (-2.5, 1.0, 4.0)], 2: [win(-1.5, 0.9, 1.1, 0.95), door(2.0, 1.0, 2.0)],
                      3: [win(0.3, 0.9, 1.0, 2.8)], 1: [win(0.3, 0.9, 1.0, 2.8)]})


# ---- OSM 1109741290: small dark-roofed shed (no returns; ortho ~6.0 x 5.0 m, ridge along the long axis); inferred eave 2.3, ridge 3.5
@building("omberg_far_b_shed", 479049.18, 6457337.53, 172.3, (-3.2, 3.2, -2.7, 2.7))
def b_shed(S):
    pc = gable_x(0.0, 3.5, 0.55, 0.55, -3.0, 3.0, -2.5, 2.5, (0.3, 0.3, 0.3, 0.3), mats=["sheet_dark", "sheet_char"])
    return dict(name="b_shed", outline=walls_rect(pc), pieces=[pc], tile="sheet_dark", wall=RED, thick=0.1, zb=0.2,
                open={0: [win(-1.0, 0.8, 0.8, 1.1)], 2: [door(0.5, 0.9, 1.9)]})


# ===== Farmstead C (between A and B, E 478745-478785, N 6457325-6457375; not in OSM) =================================
# ---- C1 house, orange tile: planes z=123.313+0.865v / 122.04-0.887v (frame 82 deg at 478768, 6457337.5; n=164/50, rms 0.05-0.06),
# ridge v=-0.73 z 122.68 (6.2 m); lidar roof u -7.2..5.5, v -4.4..3.2 (+0.35). White walls (the ortho's south wall shows white).
@building("omberg_far_c_house", 478768.0, 6457337.5, 82.0, (-7.6, 6.0, -5.2, 3.9))
def c_house(S):
    pc = gable_x(-0.73, S.Z(122.68), 0.887, 0.865, -7.5, 6.0, -4.75, 3.4, (0.4, 0.4, 0.45, 0.45), mats=["roof_tile_orange", "roof_tile_orange"])
    return dict(name="c_house", outline=walls_rect(pc), pieces=[pc], tile="roof_tile_orange", wall="wall_white", thick=0.12, zb=0.35,
                open={0: [win(x, 1.0, 1.2, 0.95) for x in (-5.0, -2.5, 0.0, 2.5)] + [door(4.2, 1.0, 2.0)],
                      1: [win(-0.7, 0.9, 1.0, 1.0), win(-0.7, 0.8, 0.9, 3.6)],
                      3: [win(-0.7, 0.9, 1.0, 1.0), win(-0.7, 0.8, 0.9, 3.6)],
                      2: [win(-6.0, 0.9, 1.1, 0.95)]})


# ---- C1 north wing: flat roof returns z 119.0-119.3 (2.7-3.0 m, u -4..6, v 2.5..6.5), white/pale sheet roof in the ortho; same frame
@building("omberg_far_c_house_wing", 478768.0, 6457337.5, 82.0, (-0.2, 6.0, 2.8, 7.1))
def c_house_wing(S):
    pc = W.piece([(0, 0, S.Z(119.3))], (1.5, 5.8, 2.95, 6.9), (0.3, 0.3, 0.0, 0.4), mats=["sheet_pale"])    # the white part (ortho u 1.8..5.5)
    return dict(name="c_house_wing", outline=walls_rect(pc), pieces=[pc], tile="sheet_pale", wall="wall_white", thick=0.12, zb=0.3,
                open={2: [win(x, 1.0, 1.2, 0.9) for x in (2.8, 4.5)], 1: [door(4.7, 0.9, 1.9)], 3: [win(4.7, 0.9, 1.0, 0.9)]})


# ---- C1 west part of the north wing: same flat returns (u -4..1), dark brown roof in the ortho (dE 89,80,85)
@building("omberg_far_c_house_wing_w", 478768.0, 6457337.5, 82.0, (-5.4, 1.6, 2.8, 7.1))
def c_house_wing_w(S):
    pc = W.piece([(0, 0, S.Z(119.3))], (-5.2, 1.5, 2.95, 6.1), (0.3, 0.3, 0.0, 0.4), mats=["sheet_dark"])
    return dict(name="c_house_wing_w", outline=walls_rect(pc), pieces=[pc], tile="sheet_dark", wall="wall_white", thick=0.12, zb=0.3,
                open={2: [win(-2.5, 1.0, 1.2, 0.9)], 3: [win(4.0, 0.9, 1.0, 0.9)]})


# ---- C2 dark outbuilding (frame -33 deg at 478772, 6457367): section at u=0 gives a ridge v=-2.6 z 4.3 m (south slope 0.72, north 0.84),
# a low-pitch lean-to north of it (plane z=117.93-0.10v, 2.5 -> 2.1 m; n=263 rms 0.05); roof u -6.2..9.9, v -4.1..4.1. Walls falu red (inferred)
@building("omberg_far_c_barn", 478772.0, 6457367.0, -33.0, (-6.7, 10.2, -5.2, 4.3))
def c_barn(S):
    main = gable_x(-2.6, S.Z(115.4 + 4.3), 0.84, 0.72, -6.5, 10.0, -5.0, 0.0, (0.4, 0.4, 0.45, 0.0), mats=["sheet_dark", "sheet_char"])
    lean = W.piece([(0, -0.1, S.Z(117.93))], (-6.5, 10.0, -0.45, 4.2), (0.4, 0.4, 0.0, 0.45), mats=["sheet_dark"])
    return dict(name="c_barn", outline=W.rect_outline(-6.1, 9.6, -4.55, 3.75), pieces=[main, lean], tile="sheet_dark", wall=RED, thick=0.12, zb=0.3,
                open={0: [barn_door(2.0, 3.0, 2.4, "door_black"), win(-3.0, 1.0, 0.9, 1.1), win(7.0, 1.0, 0.9, 1.1)],
                      2: [win(x, 1.0, 0.9, 1.1) for x in (7.0, 3.5, 0.0, -3.0)],
                      3: [win(-0.5, 0.9, 0.9, 1.1)], 1: [door(0.0, 1.0, 1.9)]})


# ---- C3 small dark shed (mostly in tree shadow; ortho ~5 x 4.6 m, no returns): inferred eave 2.3, ridge 3.4
@building("omberg_far_c_shed", 478777.5, 6457353.5, 0.0, (-3.0, 3.0, -2.7, 2.7))
def c_shed(S):
    pc = gable_x(0.0, 3.4, 0.55, 0.55, -2.8, 2.8, -2.4, 2.4, (0.3, 0.3, 0.3, 0.3), mats=["sheet_dark", "sheet_char"])
    return dict(name="c_shed", outline=walls_rect(pc), pieces=[pc], tile="sheet_dark", wall=RED, thick=0.1, zb=0.2,
                open={0: [win(-1.0, 0.8, 0.8, 1.1)], 2: [door(0.8, 0.9, 1.8)]})


def build(add, new, ev):
    for aid, (cx, cy, ang, rect), fn in BUILDINGS:
        S = Frame(ev, cx, cy, ang, rect)
        spec = fn(S)
        g = new()
        sink = S.sink(spec["outline"])
        build_building(g, spec, sink)
        print("far %s ground %.2f plinth sunk to %.2f (z %.2f abs)" % (spec["name"], S.ground, sink, S.ground + sink))
        S.place(add, aid, g)
