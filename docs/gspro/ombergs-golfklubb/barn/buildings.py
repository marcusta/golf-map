"""Machine hall and red outbuilding by the gravel track, east of hole 7's green (neither is in OpenStreetMap).

Evidence (data/omberg-barn: lidar class 1 + 2025/2023 ortho + edited DEM, fitted by fit.py into measure.json):
  frame   u = the long axis, bearing 104.85 deg (= the roof plane's contour direction), v = to its left
          (up-slope, north-north-east), origin E 477990 N 6458140. All dimensions below come from measure.json.
  hall    ONE roof plane (mono-pitch, rms 2 cm, 182 returns): slope 0.105 (6 deg) rising to the north, 2.2 m above
          the ground on the south eave, 2.9 m on the north edge, roof edge 21.2 x 6.0 m, walls 20.6 x 5.2 m
          (roof edge less a 0.4 m eave overhang on the south, north and east sides; the west end butts against
          the red building's east wall). The ortho's white surface is 0.4-0.5 m narrower on every side than the
          lidar roof (see fit.py) and shows a dark 0.7-2 m strip along the north edge that changes with the sun:
          the shadow of the north eave / the north wall. Ortho 2025 white roof = (250,246,240): clipped, so the
          albedo is set by looking at Unity top-down captures (memory: colours as rendered in Unity).
  red     a gable roof of the same axis (49 returns, rms 2 cm): ridge parallel to u, pitch 0.124 (7 deg), ridge
          5.7 m above ground, eaves 5.3 m: a tall two-storey shed 4.7 x 5.2 m. The ortho shows rust-red sheet
          roofing, dark red-brown walls (the strip west of it) and a very long NW shadow (a tall building).
Marked "inferred": wall colours and cladding (only seen as shaded strips), every door and window (no photo of
either building), the sliding doors on the north (yard) side, the roof sheet's corrugation.

Asset frames: local x along u (yawDeg = the bearing), y to its left, z up from the wall footprint's ground (the mean
of the edited DEM under it), origin at the wall rectangle's centre. Every face is oriented by a reference point on
its inner side, so no winding mistake can happen (Unity culls back faces).
"""
import math

import numpy as np
from mathutils import Matrix, Vector

import props_kit as kit

IDS = {"hall": "omberg_barn_hall", "red": "omberg_barn_red"}

MATTE = {"omberg_hall_wall", "omberg_hall_door", "omberg_hall_plinth", "omberg_hall_trim", "omberg_hall_frame",
         "omberg_hall_roof_under", "omberg_red_wall", "omberg_red_door", "omberg_red_trim", "omberg_red_frame"}


# --------------------------------------------------------------------------------------------------
# Textures
# --------------------------------------------------------------------------------------------------
def tex_corr(self, color="200,203,201", pitch="0.08", tile_m="2.0", rust="0"):
    """Corrugated sheet steel, a sine profile of `pitch` m across u (the ribs run along v: down the roof slope, up a
    wall). One flank of every wave catches the light, a faint rain streak runs along the ribs, `rust` adds orange
    bleed-through speckles. The tile has no gradient, so it repeats without seams."""
    S = self.size
    col = kit._rgb([int(c) for c in color.split(",")])
    n = int(round(float(tile_m) / float(pitch)))
    x = (np.arange(S) / S * n) % 1
    prof = 0.5 - 0.5 * np.cos(2 * math.pi * x)
    hgt = np.tile(prof[None, :], (S, 1))
    flank = np.tile(np.sin(2 * math.pi * x)[None, :], (S, 1))
    big = kit._fbm((S, S), 601, scales=(256, 64, 16))
    streak = np.repeat(kit._fbm((S, S // 8), 603, scales=(64, 16, 4)), 8, 1)[:, :S]
    v = (0.93 + 0.10 * big) * (0.94 + 0.10 * streak) * (1 + 0.07 * flank) * (0.94 + 0.06 * prof)
    alb = col[None, None, :] * v[:, :, None]
    if rust != "0":
        spots = np.clip((kit._noise((S, S), 611, 6) - 0.74) * 6, 0, 1) * np.clip(kit._fbm((S, S), 613, scales=(128, 32)) * 2 - 0.6, 0, 1)
        alb = alb + (kit._rgb([150, 82, 48]) - alb) * 0.6 * spots[:, :, None]
    return np.clip(alb, 0, 1), hgt, 5.0


def register_materials():
    M = kit.MATERIALS
    M.update({
        # hall: light grey-white sheet roof (ortho clipped white), rust-brown sheet walls (inferred), grey plinth
        "omberg_hall_roof": ("corr:206,208,205:0.08:2.0:0", (2.0, 2.0), None, 0.35, 0.2),
        "omberg_hall_roof_under": (None, (1, 1), (150, 150, 146), 0.1, 0.0),
        "omberg_hall_wall": ("corr:122,84,64:0.08:2.0:1", (2.0, 2.0), None, 0.12, 0.0),
        "omberg_hall_door": ("corr:104,74,58:0.08:2.0:1", (2.0, 2.0), None, 0.12, 0.0),
        "omberg_hall_plinth": ("plaster:128,126,120", (2.0, 2.0), None, 0.05, 0.0),
        "omberg_hall_trim": (None, (1, 1), (70, 50, 42), 0.15, 0.0),
        "omberg_hall_frame": (None, (1, 1), (58, 48, 42), 0.15, 0.0),
        "omberg_hall_steel": (None, (1, 1), (150, 154, 156), 0.5, 0.6),
        "omberg_hall_glass": (None, (1, 1), (92, 104, 110), 0.7, 0.1),
        # red outbuilding: rusty red sheet roof, red-brown boards, weathered off-white window frames
        "omberg_red_roof": ("corr:172,84,58:0.08:2.0:1", (2.0, 2.0), None, 0.3, 0.2),
        "omberg_red_roof_under": (None, (1, 1), (120, 74, 58), 0.1, 0.0),
        "omberg_red_wall": ("boards:118,48,38:v:0.16:2.0:1", (2.0, 2.0), None, 0.1, 0.0),
        "omberg_red_door": ("boards:74,56,46:v:0.12:2.0:2", (2.0, 2.0), None, 0.1, 0.0),
        "omberg_red_trim": (None, (1, 1), (176, 172, 160), 0.15, 0.0),
        "omberg_red_frame": (None, (1, 1), (66, 46, 38), 0.15, 0.0),
        "omberg_red_glass": (None, (1, 1), (62, 70, 78), 0.75, 0.1),
    })
    kit.TextureBank.tex_corr = tex_corr


# --------------------------------------------------------------------------------------------------
# Geometry helpers
# --------------------------------------------------------------------------------------------------
def face(g, pts, mat, ref, uv=None):
    """Polygon whose normal points away from `ref` (a point on the inner side of its plane)."""
    p = [Vector(tuple(q) + (0.0,) * (3 - len(q))) for q in pts]
    ref = Vector(tuple(ref) + (0.0,) * (3 - len(ref)))
    n = Vector((0, 0, 0))
    for a, b in zip(p, p[1:] + p[:1]):
        n += Vector(((a.y - b.y) * (a.z + b.z), (a.z - b.z) * (a.x + b.x), (a.x - b.x) * (a.y + b.y)))
    if n.length < 1e-9:
        return
    c = sum(p, Vector((0, 0, 0))) / len(p)
    if n.dot(c - ref) < 0:
        p.reverse()
    g.poly([tuple(q) for q in p], mat, uv)


def mean(pts):
    return tuple(float(v) for v in np.mean(np.array(pts, float), axis=0))


def slab(g, top, mat_top, mat_under, mat_edge, dz, skip=()):
    """One roof plane: `top` polygon (planar, up-facing), its underside dropped by dz, and a vertical edge face on
    every side (the side with index i runs top[i] -> top[i+1]) that is not in `skip`."""
    n = len(top)
    bot = [(x, y, z - dz) for x, y, z in top]
    c = mean(top)
    face(g, top, mat_top, (c[0], c[1], c[2] - 1))
    face(g, bot, mat_under, (c[0], c[1], c[2] + 1))
    cm = (c[0], c[1], c[2] - dz / 2)
    for i in range(n):
        if i in skip:
            continue
        j = (i + 1) % n
        face(g, [top[i], top[j], bot[j], bot[i]], mat_edge, cm)


def board(g, a, b, c, mat, h=0.18, t=0.03):
    """Fascia/barge board along the roof edge a->b: hangs h below the top edge, stands t proud of the edge plane,
    outward (in plan) from c, the slab's centre."""
    a, b, c = Vector(a), Vector(b), Vector(c)
    d = b - a
    n = Vector((-d.y, d.x, 0))
    if n.length < 1e-6:
        return
    n.normalize()
    if n.dot((a + b) / 2 - c) < 0:
        n = -n
    o, dn = n * t, Vector((0, 0, -h))
    ref = (a + b) / 2 + o / 2 + dn / 2
    q = lambda *v: [tuple(x) for x in v]
    face(g, q(a + o, b + o, b + o + dn, a + o + dn), mat, ref)
    face(g, q(a, b, b + o, a + o), mat, ref)
    face(g, q(a + dn, b + dn, b + o + dn, a + o + dn), mat, ref)
    face(g, q(a, a + o, a + o + dn, a + dn), mat, ref)
    face(g, q(b, b + o, b + o + dn, b + dn), mat, ref)


def wallframe(u, w, origin):
    """Right-handed local frame of a wall: u along the wall, v up, w out of the wall; origin on the wall plane."""
    u, w, v = Vector(u), Vector(w), Vector((0, 0, 1))
    assert (u.cross(v) - w).length < 1e-6, "u x v must be w"
    return Matrix(((u.x, v.x, w.x, origin[0]), (u.y, v.y, w.y, origin[1]), (u.z, v.z, w.z, origin[2]), (0, 0, 0, 1)))


# side -> (outward w, along-wall u, sign s of the wall coordinate: a = s * c, c = x for N/S and y for E/W)
SIDES = {"N": ((0, 1, 0), (-1, 0, 0), -1), "S": ((0, -1, 0), (1, 0, 0), 1),
         "E": ((1, 0, 0), (0, 1, 0), 1), "W": ((-1, 0, 0), (0, -1, 0), -1)}


def side_frame(side, pos):
    w, u, _ = SIDES[side]
    origin = (0, pos, 0) if side in "NS" else (pos, 0, 0)
    return wallframe(u, w, origin)


class Opening:
    """A rectangular opening in a wall: wall coordinate range [c0, c1] (x for N/S, y for E/W), heights zlo..zhi."""

    def __init__(s, c0, c1, zlo, zhi):
        s.c0, s.c1, s.zlo, s.zhi = min(c0, c1), max(c0, c1), zlo, zhi

    @property
    def cc(s):
        return (s.c0 + s.c1) / 2

    @property
    def w(s):
        return s.c1 - s.c0


def wall_panel(g, side, pos, c0, c1, zb, top, mat, kinks=(), openings=()):
    """Wall plane (side's coordinate `pos`) over [c0, c1] from zb up to top(c), facing outward, with the openings left
    open. `top` must be linear between the coordinates in `kinks`."""
    pts = {round(c0, 6), round(c1, 6)} | {round(k, 6) for k in kinks if c0 < k < c1}
    for o in openings:
        pts |= {round(o.c0, 6), round(o.c1, 6)}
    cs = sorted(pts)
    s = SIDES[side][2]
    g.push(side_frame(side, pos))
    for a, b in zip(cs, cs[1:]):
        mid = (a + b) / 2
        ops = sorted((o for o in openings if o.c0 - 1e-6 <= mid <= o.c1 + 1e-6), key=lambda o: o.zlo)
        ta, tb = top(a), top(b)
        pa, pb = s * a, s * b

        def quad(z0a, z0b, z1a, z1b):
            face(g, [(pa, z0a), (pb, z0b), (pb, z1b), (pa, z1a)], mat, ((pa + pb) / 2, (z0a + z0b + z1a + z1b) / 4, -1))
        cur = zb
        for o in ops:                                   # stacked openings in one strip leave a band between them
            if o.zlo > cur + 1e-6:
                quad(cur, cur, o.zlo, o.zlo)
            cur = max(cur, o.zhi)
        if ta - cur > 1e-6 or tb - cur > 1e-6:
            quad(cur, cur, ta, tb)
    g.pop()


def reveal(g, side, pos, o, d, mat):
    """The four sides of an opening, d deep into the wall."""
    s = SIDES[side][2]
    a0, a1 = sorted((s * o.c0, s * o.c1))
    g.push(side_frame(side, pos))
    zm = (o.zlo + o.zhi) / 2
    am = (a0 + a1) / 2
    face(g, [(a0, o.zlo, 0), (a0, o.zlo, -d), (a0, o.zhi, -d), (a0, o.zhi, 0)], mat, (a0 - 1, zm, -d / 2))
    face(g, [(a1, o.zlo, 0), (a1, o.zlo, -d), (a1, o.zhi, -d), (a1, o.zhi, 0)], mat, (a1 + 1, zm, -d / 2))
    face(g, [(a0, o.zhi, 0), (a1, o.zhi, 0), (a1, o.zhi, -d), (a0, o.zhi, -d)], mat, (am, o.zhi + 1, -d / 2))
    if o.zlo > 0.3:
        face(g, [(a0, o.zlo, 0), (a1, o.zlo, 0), (a1, o.zlo, -d), (a0, o.zlo, -d)], mat, (am, o.zlo - 1, -d / 2))
    g.pop()


def window(g, side, pos, o, d, frame, glass, bars=(2, 2), fw=0.06, trim=None):
    """A window in a reveal: glass at depth d, a frame ring and glazing bars standing in front of it, and (optionally)
    a trim board round the outside. Everything in wall-local (a, z, w) coordinates."""
    s = SIDES[side][2]
    a0, a1 = sorted((s * o.c0, s * o.c1))
    reveal(g, side, pos, o, d, frame)
    g.push(side_frame(side, pos))
    am, zm, W, H = (a0 + a1) / 2, (o.zlo + o.zhi) / 2, a1 - a0, o.zhi - o.zlo
    face(g, [(a0, o.zlo, -d), (a1, o.zlo, -d), (a1, o.zhi, -d), (a0, o.zhi, -d)], glass, (am, zm, -d - 1))
    wz = -d + 0.03
    g.box((am, o.zlo + fw / 2, wz), (W, fw, 0.06), frame)
    g.box((am, o.zhi - fw / 2, wz), (W, fw, 0.06), frame)
    g.box((a0 + fw / 2, zm, wz), (fw, H, 0.06), frame)
    g.box((a1 - fw / 2, zm, wz), (fw, H, 0.06), frame)
    for i in range(1, bars[0]):
        g.box((a0 + W * i / bars[0], zm, wz), (0.035, H, 0.05), frame)
    for j in range(1, bars[1]):
        g.box((am, o.zlo + H * j / bars[1], wz), (W, 0.035, 0.05), frame)
    if trim:
        t, p = 0.09, 0.025
        g.box((am, o.zhi + t / 2, p / 2), (W + 2 * t, t, p), trim)
        g.box((am, o.zlo - t / 2, p / 2 + 0.01), (W + 2 * t, t, p + 0.02), trim)
        g.box((a0 - t / 2, zm, p / 2), (t, H, p), trim)
        g.box((a1 + t / 2, zm, p / 2), (t, H, p), trim)
    g.pop()


def plain_door(g, side, pos, o, d, leaf, frame, trim=None, ledge=True):
    """A door leaf recessed d in its opening: boards, a z-brace and a handle."""
    s = SIDES[side][2]
    a0, a1 = sorted((s * o.c0, s * o.c1))
    reveal(g, side, pos, o, d, frame)
    g.push(side_frame(side, pos))
    am, W, H = (a0 + a1) / 2, a1 - a0, o.zhi - o.zlo
    zm = (o.zlo + o.zhi) / 2
    g.box((am, zm - 0.01, -d + 0.03), (W - 0.04, H - 0.04, 0.05), leaf)
    for z in (o.zlo + 0.35, o.zhi - 0.35):
        g.box((am, z, -d + 0.062), (W - 0.04, 0.12, 0.02), frame)
    g.box((a1 - 0.14 if s > 0 else a0 + 0.14, zm - 0.1, -d + 0.1), (0.04, 0.12, 0.05), "omberg_hall_steel")
    if trim:
        t, p = 0.10, 0.025
        g.box((am, o.zhi + t / 2, p / 2), (W + 2 * t, t, p), trim)
        g.box((a0 - t / 2, zm + t / 2, p / 2), (t, H + t, p), trim)
        g.box((a1 + t / 2, zm + t / 2, p / 2), (t, H + t, p), trim)
    g.pop()


PB = 0.035                   # the plinth stands this far off the wall (and 2 cm into it)


def plinth(g, side, pos, c0, c1, gaps=(), zf=-0.5, zp=0.30, mat="omberg_hall_plinth", pad=(0.0, 0.0)):
    """Concrete plinth in front of the foot of a wall: from zf (below any ground) to zp, in front of [c0, c1] except the
    door openings in `gaps` (Opening objects); `pad` lengthens it past the wall ends (to wrap a corner)."""
    s = SIDES[side][2]
    cuts = sorted((o.c0, o.c1) for o in gaps)
    edges = [c0 - pad[0]]
    for a, b in cuts:
        edges += [a, b]
    edges.append(c1 + pad[1])
    g.push(side_frame(side, pos))
    for i in range(0, len(edges), 2):
        a, b = sorted((s * edges[i], s * edges[i + 1]))
        if b - a > 1e-6:
            g.box(((a + b) / 2, (zf + zp) / 2, (PB - 0.02) / 2), (b - a, zp - zf, PB + 0.02), mat)
    g.pop()


def threshold(g, side, pos, o, mat="omberg_hall_plinth"):
    """Concrete step in front of a door at ground level: top 4 cm above the placement ground, reaching 0.5 m below it."""
    s = SIDES[side][2]
    a0, a1 = sorted((s * o.c0, s * o.c1))
    g.push(side_frame(side, pos))
    g.box(((a0 + a1) / 2, (0.04 - 0.5) / 2, 0.13), (a1 - a0 + 0.2, 0.54, 0.4), mat)
    g.pop()


# --------------------------------------------------------------------------------------------------
# Machine hall
# --------------------------------------------------------------------------------------------------
DZ_H = 0.12                  # hall roof sheet + purlin build-up, vertical


def hall(g, M):
    H = M["hall"]
    ovh = M["overhang"]
    cu = (H["wallsU"][0] + H["wallsU"][1]) / 2
    cv = (H["wallsV"][0] + H["wallsV"][1]) / 2
    G = H["ground"]
    x0, x1 = H["wallsU"][0] - cu, H["wallsU"][1] - cu             # walls: x0 is the red building's east wall
    y0, y1 = H["wallsV"][0] - cv, H["wallsV"][1] - cv
    xe = H["u"][1] - cu                                            # roof east edge (east wall + overhang)
    ys, yn = H["v"][0] - cv, H["v"][1] - cv                        # roof south / north edges
    zt = lambda y: H["z0"] + H["slope"] * (y + cv) - G             # roof top above the wall ground
    # ---- roof: one plane
    roof = [(x0, ys, zt(ys)), (xe, ys, zt(ys)), (xe, yn, zt(yn)), (x0, yn, zt(yn))]
    slab(g, roof, "omberg_hall_roof", "omberg_hall_roof_under", "omberg_hall_trim", DZ_H, skip=(3,))
    c = mean(roof)
    board(g, roof[0], roof[1], c, "omberg_hall_trim", h=0.17, t=0.025)            # south eave
    board(g, roof[1], roof[2], c, "omberg_hall_trim", h=0.17, t=0.025)            # east edge
    board(g, roof[2], roof[3], c, "omberg_hall_trim", h=0.17, t=0.025)            # north edge
    # ---- walls: corrugated, vertical ribs; the plinth stands in front of their foot
    zp = 0.30
    ztop_s, ztop_n = zt(y0) - DZ_H, zt(y1) - DZ_H
    # sliding doors on the north (yard) side: three leaves, + a man door at the east end (inferred)
    leaves = [(-5.3, 4.0), (0.0, 4.0), (5.3, 4.0)]
    man_n = Opening(x1 - 1.9, x1 - 1.0, 0.0, 2.05)
    win_s = [Opening(cx - 0.6, cx + 0.6, 1.35, 1.85) for cx in (-6.2, 0.0, 6.2)]
    east_door = Opening(-0.45, 0.45, 0.0, 2.0)
    wall_panel(g, "N", y1, x0, x1, zp - 0.02, lambda cx: ztop_n, "omberg_hall_wall", openings=[man_n])
    wall_panel(g, "S", y0, x0, x1, zp - 0.02, lambda cx: ztop_s, "omberg_hall_wall", openings=win_s)
    wall_panel(g, "E", x1, y0, y1, zp - 0.02, lambda cy: zt(cy) - DZ_H, "omberg_hall_wall", openings=[east_door])
    plinth(g, "N", y1, x0, x1, gaps=[man_n], pad=(0.0, PB))
    plinth(g, "S", y0, x0, x1, pad=(0.0, PB))
    plinth(g, "E", x1, y0, y1, gaps=[east_door])
    threshold(g, "N", y1, man_n)
    threshold(g, "E", x1, east_door)
    for cx, cy, zc in ((x1, y1, ztop_n), (x1, y0, ztop_s)):          # corner trim boards, full wall height
        g.box((cx + 0.012, cy + 0.012 * (1 if cy > 0 else -1), (zp + zc) / 2), (0.1, 0.1, zc - zp), "omberg_hall_trim")
    plain_door(g, "N", y1, man_n, 0.10, "omberg_hall_door", "omberg_hall_frame", trim="omberg_hall_trim")
    plain_door(g, "E", x1, east_door, 0.10, "omberg_hall_door", "omberg_hall_frame", trim="omberg_hall_trim")
    for o in win_s:
        window(g, "S", y0, o, 0.08, "omberg_hall_frame", "omberg_hall_glass", bars=(3, 1), fw=0.05, trim="omberg_hall_trim")
    for cx, W in leaves:
        sliding_door(g, y1, ztop_n, cx, W)


def sliding_door(g, yw, ztop_wall, cx, W, H=2.3):
    """A sliding leaf hung 0.1 m off the north wall (side N: a = -x): dark corrugated leaf, framed, a steel track above it
    with two hangers, a floor guide. cx = its centre along x, W its width."""
    g.push(side_frame("N", yw))
    a = -cx
    z0, z1 = 0.06, 0.06 + H
    g.box((a, (z0 + z1) / 2, 0.075), (W, H, 0.04), "omberg_hall_door")                  # leaf
    for da in (-W / 2 + 0.05, W / 2 - 0.05):
        g.box((a + da, (z0 + z1) / 2, 0.1), (0.1, H, 0.06), "omberg_hall_frame")         # stiles
    for z in (z0 + 0.06, z1 - 0.06):
        g.box((a, z, 0.1), (W, 0.12, 0.06), "omberg_hall_frame")                         # bottom and top rails
    g.box((a, z0 + H * 0.45, 0.1), (W, 0.1, 0.06), "omberg_hall_frame")                  # mid rail
    g.beam((a - W / 2 + 0.1, z0 + 0.1, 0.125), (a + W / 2 - 0.1, z0 + H * 0.45 - 0.05, 0.125), 0.09, 0.025, "omberg_hall_frame")  # brace
    zt = z1 + 0.16
    g.box((a, zt, 0.15), (W + 1.0, 0.07, 0.07), "omberg_hall_steel")                     # track
    for da in (-W / 2 + 0.35, W / 2 - 0.35):
        g.box((a + da, (z1 + zt) / 2 - 0.02, 0.15), (0.05, zt - z1 - 0.05, 0.05), "omberg_hall_steel")   # hangers
    for da in (-W / 2 - 0.5, W / 2 + 0.5):
        g.box((a + da, zt, 0.075), (0.06, 0.1, 0.1), "omberg_hall_steel")                # track brackets to the wall
    g.box((a, 0.04, 0.12), (W * 0.5, 0.05, 0.05), "omberg_hall_steel")                   # floor guide rail
    g.pop()


# --------------------------------------------------------------------------------------------------
# Red outbuilding
# --------------------------------------------------------------------------------------------------
DZ_R = 0.11


def red(g, M):
    R = M["red"]
    ovh = M["overhang"]
    cu = (R["wallsU"][0] + R["wallsU"][1]) / 2
    cv = (R["wallsV"][0] + R["wallsV"][1]) / 2
    G = R["ground"]
    x0, x1 = R["wallsU"][0] - cu, R["wallsU"][1] - cu
    y0, y1 = R["wallsV"][0] - cv, R["wallsV"][1] - cv
    yr = R["ridgeV"] - cv
    xw, xe = R["u"][0] - cu, R["u"][1] - cu
    ys, yn = R["v"][0] - cv, R["v"][1] - cv
    zr, p = R["ridgeZ"] - G, R["pitch"]
    zt = lambda y: zr - p * abs(y - yr)
    # ---- roof: two planes meeting in the ridge, a ridge cap over the joint
    south = [(xw, yr, zr), (xe, yr, zr), (xe, ys, zt(ys)), (xw, ys, zt(ys))]
    north = [(xe, yr, zr), (xw, yr, zr), (xw, yn, zt(yn)), (xe, yn, zt(yn))]
    slab(g, south, "omberg_red_roof", "omberg_red_roof_under", "omberg_red_frame", DZ_R, skip=(0,))
    slab(g, north, "omberg_red_roof", "omberg_red_roof_under", "omberg_red_frame", DZ_R, skip=(0,))
    cs, cn = mean(south), mean(north)
    for slab_pts, c in ((south, cs), (north, cn)):
        board(g, slab_pts[1], slab_pts[2], c, "omberg_red_frame", h=0.16, t=0.025)    # east edge
        board(g, slab_pts[2], slab_pts[3], c, "omberg_red_frame", h=0.16, t=0.025)    # eave
        board(g, slab_pts[3], slab_pts[0], c, "omberg_red_frame", h=0.16, t=0.025)    # west edge
    w, h = 0.26, 0.07
    za = zr - p * w
    for sg in (-1, 1):
        face(g, [(xw - 0.02, yr + sg * w, za), (xe + 0.02, yr + sg * w, za), (xe + 0.02, yr, zr + h), (xw - 0.02, yr, zr + h)],
             "omberg_red_roof", ((xw + xe) / 2, yr, zr - 1))
    for x in (xw - 0.02, xe + 0.02):
        face(g, [(x, yr - w, za), (x, yr + w, za), (x, yr, zr + h)], "omberg_red_roof", ((xw + xe) / 2, yr, zr - 0.1))
    # ---- walls
    zp = 0.30
    zwall = lambda y: zt(y) - DZ_R
    # north (yard side): door + window below, a window and the loft hatch above (inferred: no photo of the building)
    door_n = Opening(x1 - 1.45, x1 - 0.5, 0.0, 2.1)
    win_n = [Opening(x0 + 0.65, x0 + 1.4, 1.05, 2.0), Opening(x0 + 0.65, x0 + 1.4, 3.55, 4.5)]
    hatch = Opening(x1 - 1.55, x1 - 0.45, 3.45, 4.55)
    win_s = [Opening(-0.4, 0.4, 1.05, 2.0), Opening(-0.4, 0.4, 3.55, 4.5)]
    win_w = [Opening(yr - 0.4, yr + 0.4, 1.05, 2.0), Opening(yr - 0.4, yr + 0.4, 3.55, 4.5)]
    win_e = [Opening(yr - 0.4, yr + 0.4, 3.55, 4.5)]                    # only above the hall roof is it visible
    wall_panel(g, "N", y1, x0, x1, zp - 0.02, lambda cx: zwall(y1), "omberg_red_wall", openings=[door_n] + win_n + [hatch])
    wall_panel(g, "S", y0, x0, x1, zp - 0.02, lambda cx: zwall(y0), "omberg_red_wall", openings=win_s)
    wall_panel(g, "W", x0, y0, y1, zp - 0.02, lambda cy: zwall(cy), "omberg_red_wall", kinks=(yr,), openings=win_w)
    wall_panel(g, "E", x1, y0, y1, zp - 0.02, lambda cy: zwall(cy), "omberg_red_wall", kinks=(yr,), openings=win_e)
    plinth(g, "N", y1, x0, x1, gaps=[door_n], pad=(PB, PB))
    plinth(g, "S", y0, x0, x1, pad=(PB, PB))
    plinth(g, "W", x0, y0, y1)
    plinth(g, "E", x1, y0, y1)
    threshold(g, "N", y1, door_n)
    for cx, cy in ((x0, y0), (x0, y1), (x1, y0), (x1, y1)):              # corner boards
        zc = zwall(cy)
        g.box((cx + 0.011 * (1 if cx > 0 else -1), cy + 0.011 * (1 if cy > 0 else -1), (zp + zc) / 2), (0.1, 0.1, zc - zp), "omberg_red_trim")
    plain_door(g, "N", y1, door_n, 0.10, "omberg_red_door", "omberg_red_frame", trim="omberg_red_trim")
    plain_door(g, "N", y1, hatch, 0.09, "omberg_red_door", "omberg_red_frame", trim="omberg_red_trim")
    for side, pos, ops in (("N", y1, win_n), ("S", y0, win_s), ("W", x0, win_w), ("E", x1, win_e)):
        for o in ops:
            window(g, side, pos, o, 0.09, "omberg_red_frame", "omberg_red_glass", bars=(2, 3), fw=0.06, trim="omberg_red_trim")


# --------------------------------------------------------------------------------------------------
def to_en(M, u, v):
    a = M["axis"]
    O = M["origin"]
    return O[0] + u * a["ux"] + v * a["vx"], O[1] + u * a["uy"] + v * a["vy"]


def build(add, new, ev):
    M = ev.measure
    yaw = M["axis"]["bearingDeg"]
    for key, fn in (("hall", hall), ("red", red)):
        B = M[key]
        cu = (B["wallsU"][0] + B["wallsU"][1]) / 2
        cv = (B["wallsV"][0] + B["wallsV"][1]) / 2
        g = new()
        fn(g, M)
        e, n = to_en(M, cu, cv)
        add(IDS[key], g, e, n, yaw, B["ground"])
