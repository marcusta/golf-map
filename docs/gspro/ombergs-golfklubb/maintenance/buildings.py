"""Maintenance hall (OSM 737322222), the small red cabin (OSM 1431573559) and the white storage shed.

Frames: x runs along the ridge (compass bearing = yawDeg), y to the left of x (+y = west for the hall), z up
from the ground median. The asset origin sits on the ridge axis at the roof's mid length (the lidar roof
fit, see HALL_AXIS / CABIN_AXIS), so the roof is exactly symmetric about y = 0.

Evidence (data/omberg-maintenance lidar + ortho 2023/2025, Street View in maskinhall/*.webp|png):
  hall   lidar roof returns (class 1, ~1100): two planes of one pitch 0.357 (19.6 deg), ridge 109.64 m at 0.22 m
         east of the OSM axis, rms 0.07 m; ground 103.0 m (flat +-0.1 m all round); roof returns run -20.6..+21.7 m
         along the ridge and 9.0 m either side of it, so walls 8.5 m from the ridge (OSM width 16.98 m) with 0.5 m
         eaves and ~0.45 m rakes. Wall top = roof underside at the wall = 3.39 m: the photo shows the garage doors
         (3.15 m) reaching almost to the gutter, which agrees.
  yard   The asphalt yard and the road lie west of the hall, so the long wall with the garage doors is the west
         wall (+y); the concrete pad with the sand bays is north of the hall, in front of the gable with the red
         door, hose reels and sink (photo maskinhall/...152448); the south gable has the big segmental window and
         the green door (photo ...098513). West wall, south to north (photo ...144929): corner pilaster, big
         arched window, green entrance door, garage door, red door, small arched window, garage door, narrow
         arched window, corner pilaster; red downpipes at the corners and beside the garage doors.
  cabin  lidar ridge 106.86 m (pitch 0.4815), ground 102.8 m; ridge runs along the 7 m axis, white barge boards
         on the gables (ortho), door on the east long wall (the photo: window, door, window; window in the south
         gable).
  shed   the lidar shows nothing at the white box seen in both orthos (the lidar is older: the returns east of the
         cabin are a vehicle or a former container); size 3.05 x 2.7 m from the ortho, height 2.6 m from its shadow.
Everything the sources do not show is marked "inferred".
"""
import math

import numpy as np
from mathutils import Matrix, Vector

import props_kit as kit

IDS = {"hall": "omberg_maint_hall", "cabin": "omberg_maint_cabin", "shed": "omberg_maint_container"}

MATTE = {"omberg_hall_pebble", "omberg_hall_render", "omberg_hall_trapez", "omberg_hall_tile", "omberg_hall_fascia",
         "omberg_hall_green", "omberg_hall_door_green", "omberg_hall_door_red", "omberg_hall_concrete",
         "omberg_hall_flash", "omberg_hall_white", "omberg_cabin_red", "omberg_cabin_white", "omberg_cabin_green",
         "omberg_cabin_roof", "omberg_cabin_block", "omberg_cabin_deck", "omberg_shed_white", "omberg_shed_trim"}


# --------------------------------------------------------------------------------------------------
# Textures (relief lives in the normal maps, never in geometry)
# --------------------------------------------------------------------------------------------------
def tex_pebble(self, color="140,98,88"):
    """Pebble-dash render (spritputs) with granite aggregate: 2 m tile at 2 mm/px. Rosy brown ground, pale grey,
    dark and pink stones 6-10 mm, faint rain streaks and damp patches."""
    S = self.size
    col = kit._rgb([int(c) for c in color.split(",")])
    big = kit._fbm((S, S), 501, scales=(256, 128, 64, 32))
    mid = kit._fbm((S, S), 503, scales=(16, 8, 4))
    g1, g2, g3 = kit._noise((S, S), 511, 4), kit._noise((S, S), 513, 3), kit._noise((S, S), 517, 5)
    streak = np.repeat(kit._fbm((S, S // 8), 521, scales=(64, 16, 4)), 8, 1)[:, :S]
    light = np.clip((g1 - 0.66) * 8, 0, 1)
    dark = np.clip((g2 - 0.70) * 8, 0, 1)
    pink = np.clip((g3 - 0.64) * 7, 0, 1)
    v = (0.86 + 0.22 * big) * (0.94 + 0.10 * mid) * (0.93 + 0.12 * streak)
    alb = col[None, None, :] * v[:, :, None]
    alb = alb + (kit._rgb([200, 194, 186]) - alb) * 0.6 * light[:, :, None]
    alb = alb + (kit._rgb([66, 58, 56]) - alb) * 0.55 * dark[:, :, None]
    alb = alb + (kit._rgb([196, 140, 128]) - alb) * 0.4 * pink[:, :, None]
    height = 0.35 + 0.3 * g1 + 0.25 * light + 0.15 * pink + 0.1 * mid
    return np.clip(alb, 0, 1), np.clip(height, 0, 1), 4.0


def tex_trapez(self, color="116,30,32", pitch="0.2", tile_m="2.0"):
    """Trapezoidal sheet metal, ribs along v: a flat-topped rib every `pitch` m with sloped flanks, a wide pan between."""
    S = self.size
    col = kit._rgb([int(c) for c in color.split(",")])
    n = int(round(float(tile_m) / float(pitch)))
    x = (np.arange(S) / S * n) % 1
    d = np.abs(x - 0.5)
    prof = 0.2 + 0.8 * np.clip(1 - (d - 0.12) / 0.10, 0, 1)
    side = np.where((d > 0.12) & (d < 0.22), np.where(x < 0.5, 1.0, -1.0), 0.0)   # flanks catch light unequally
    hgt = np.tile(prof[None, :], (S, 1))
    big = kit._fbm((S, S), 531, scales=(256, 64, 16))
    streak = np.repeat(kit._fbm((S, S // 8), 533, scales=(64, 16, 4)), 8, 1)[:, :S]
    v = (0.92 + 0.12 * big) * (0.95 + 0.08 * streak) * (1 + 0.12 * np.tile(side[None, :], (S, 1)))
    return np.clip(col * v[:, :, None], 0, 1), hgt, 4.0


def tex_rtile(self, color="176,78,48"):
    """Double-Roman roof tile (concrete/clay): 2 m tile = 6 courses of 0.33 m and 6 tiles of 0.33 m, each with two
    rolls; the course's lower edge is its thick lip (shadow line under it). Courses run along u, v is up the slope."""
    S = self.size
    col = kit._rgb([int(c) for c in color.split(",")])
    rows, cols = 6, 6
    y = np.arange(S)[:, None] / S * rows
    x = np.arange(S)[None, :] / S * cols
    fy, fx = y % 1, x % 1
    wave = 0.5 + 0.5 * np.cos(fx * 4 * math.pi)                # two rolls per tile
    hgt = 0.55 * wave + 0.45 * np.where(fy > 0.94, 0.0, fy ** 1.5)
    tid = np.floor(y).astype(int) * cols + np.floor(x).astype(int)
    shade = 1 + (kit._rng(9).random(rows * cols + cols) - 0.5) * 0.14
    g = kit._fbm((S, S), 541, scales=(128, 32, 8))
    dirt = kit._fbm((S, S), 543, scales=(256, 64))
    v = shade[tid] * (0.86 + 0.16 * wave) * (0.88 + 0.2 * g) * (0.94 + 0.1 * dirt)
    v = np.where(fy > 0.94, v * 0.55, v)
    return np.clip(col * v[:, :, None], 0, 1), hgt, 6.0


def tex_panel(self, color="206,208,204", pitch="1.0"):
    """Sheet-steel panels with a shallow groove at every joint (`pitch` m) and a faint rain streak: the white shed."""
    S = self.size
    col = kit._rgb([int(c) for c in color.split(",")])
    n = max(1, int(round(2.0 / float(pitch))))
    x = (np.arange(S) / S * n) % 1
    groove = np.where((x < 0.012) | (x > 0.988), 0.0, 1.0)
    hgt = np.tile(groove[None, :], (S, 1))
    big = kit._fbm((S, S), 551, scales=(256, 64, 16))
    streak = np.repeat(kit._fbm((S, S // 8), 553, scales=(64, 16, 4)), 8, 1)[:, :S]
    v = (0.93 + 0.1 * big) * (0.94 + 0.08 * streak) * np.where(hgt < 0.5, 0.78, 1.0)
    return np.clip(col * v[:, :, None], 0, 1), hgt, 3.0


def register_materials():
    M = kit.MATERIALS
    M.update({
        # photo (Street View): rosy brown ground with pale and dark stones; the course light lifts sunlit faces
        "omberg_hall_pebble": ("pebble:140,98,88", (2.0, 2.0), None, 0.05, 0.0),
        "omberg_hall_render": ("plaster:176,175,170", (2.0, 2.0), None, 0.05, 0.0),
        "omberg_hall_trapez": ("trapez:116,30,32:0.2:2.0", (2.0, 2.0), None, 0.2, 0.1),
        "omberg_hall_flash": (None, (1, 1), (118, 32, 32), 0.3, 0.1),
        "omberg_hall_tile": ("rtile:186,90,60", (2.0, 2.0), None, 0.12, 0.0),
        "omberg_hall_fascia": (None, (1, 1), (104, 30, 30), 0.1, 0.0),          # dark red eave boards and soffit
        "omberg_hall_gutter": (None, (1, 1), (222, 222, 218), 0.45, 0.3),       # white half-round gutter
        "omberg_hall_pipe": (None, (1, 1), (150, 32, 30), 0.35, 0.2),           # red downpipes
        "omberg_hall_green": (None, (1, 1), (50, 96, 66), 0.3, 0.0),            # frames, glazing bars
        "omberg_hall_door_green": ("boards:52,98,68:v:0.12:2.0:2", (2.0, 2.0), None, 0.15, 0.0),
        "omberg_hall_door_red": ("boards:132,36,34:v:0.12:2.0:2", (2.0, 2.0), None, 0.15, 0.0),
        "omberg_hall_white": (None, (1, 1), (214, 212, 204), 0.2, 0.0),
        "omberg_hall_glass": (None, (1, 1), (58, 56, 70), 0.7, 0.1),
        "omberg_hall_concrete": ("plaster:140,138,132", (2.0, 2.0), None, 0.1, 0.0),
        "omberg_hall_steel": (None, (1, 1), (156, 160, 164), 0.55, 0.6),
        "omberg_hall_lamp": (None, (1, 1), (36, 36, 38), 0.4, 0.2),
        "omberg_hall_hose_yellow": (None, (1, 1), (212, 182, 48), 0.3, 0.0),
        "omberg_hall_black": (None, (1, 1), (22, 22, 24), 0.3, 0.0),
        "omberg_hall_reel_green": (None, (1, 1), (40, 110, 72), 0.4, 0.0),
        "omberg_hall_reel_blue": (None, (1, 1), (36, 78, 150), 0.4, 0.0),
        "omberg_hall_box_red": (None, (1, 1), (170, 36, 34), 0.4, 0.1),
        "omberg_hall_paper": (None, (1, 1), (226, 226, 222), 0.1, 0.0),
        # cabin: falu red board, white trim, dark grey felt/shingle roof
        "omberg_cabin_red": ("boards:132,36,32:v:0.19:2.0:1", (2.0, 2.0), None, 0.1, 0.0),
        "omberg_cabin_white": (None, (1, 1), (214, 212, 204), 0.2, 0.0),
        "omberg_cabin_green": ("boards:52,98,68:v:0.12:2.0:2", (2.0, 2.0), None, 0.15, 0.0),
        "omberg_cabin_roof": ("shingle:88,90,95", (2.0, 2.0), None, 0.15, 0.0),
        "omberg_cabin_glass": (None, (1, 1), (52, 58, 66), 0.7, 0.1),
        "omberg_cabin_block": ("plaster:128,126,120", (2.0, 2.0), None, 0.05, 0.0),
        "omberg_cabin_deck": ("boards:122,106,88:h:0.14:1.0:0", (1.0, 1.0), None, 0.1, 0.0),
        "omberg_cabin_under": (None, (1, 1), (22, 20, 20), 0.0, 0.0),
        # shed
        "omberg_shed_white": ("panel:206,208,204:1.0", (2.0, 2.0), None, 0.15, 0.0),
        "omberg_shed_trim": (None, (1, 1), (190, 192, 190), 0.2, 0.0),
        "omberg_shed_dark": (None, (1, 1), (60, 62, 66), 0.3, 0.2),
    })
    kit.TextureBank.tex_pebble = tex_pebble
    kit.TextureBank.tex_trapez = tex_trapez
    kit.TextureBank.tex_rtile = tex_rtile
    kit.TextureBank.tex_panel = tex_panel


# --------------------------------------------------------------------------------------------------
# Geometry helpers. Every face is oriented by a reference point on its inner side, so a winding mistake cannot
# happen (Unity culls back faces).
# --------------------------------------------------------------------------------------------------
def face(g, pts, mat, ref, uv=None):
    """Polygon whose normal points away from `ref` (a point on the inner side of its plane)."""
    p = [Vector(tuple(q) + (0.0,) * (3 - len(q))) for q in pts]   # (u, v) points lie on the wall plane w = 0
    ref = tuple(ref) + (0.0,) * (3 - len(ref))
    n = Vector((0, 0, 0))
    for a, b in zip(p, p[1:] + p[:1]):
        n += Vector(((a.y - b.y) * (a.z + b.z), (a.z - b.z) * (a.x + b.x), (a.x - b.x) * (a.y + b.y)))
    if n.length < 1e-9:
        return
    c = sum(p, Vector((0, 0, 0))) / len(p)
    if n.dot(c - Vector(ref)) < 0:
        p.reverse()
    g.poly([tuple(q) for q in p], mat, uv)


def mean(pts):
    return tuple(float(v) for v in np.mean(np.array(pts, float), axis=0))


def wallframe(u, w, origin):
    """Right-handed local frame of a wall: u along the wall, v up, w out of the wall; origin on the wall plane."""
    u, w, v = Vector(u), Vector(w), Vector((0, 0, 1))
    assert (u.cross(v) - w).length < 1e-6, "u x v must be w"
    return Matrix(((u.x, v.x, w.x, origin[0]), (u.y, v.y, w.y, origin[1]), (u.z, v.z, w.z, origin[2]), (0, 0, 0, 1)))


def long_frame(s, hy):
    """Long wall at y = s*hy; local u = -s*x."""
    return wallframe((-s, 0, 0), (0, s, 0), (0, s * hy, 0))


def gable_frame(s, hx):
    """Gable wall at x = s*hx; local u = s*y."""
    return wallframe((0, s, 0), (s, 0, 0), (s * hx, 0, 0))


class Shape:
    """Opening outline in wall-local (u, v): vertical jambs from zb to the springing/top zs, then a flat head (f = 0)
    or a circular-segment arch of rise f (f = W/2 is a round head), sampled in n steps. outline() is counter-clockwise
    seen from outside: [bottom-left, bottom-right, top right ... top left], so edge 0 is the bottom."""

    def __init__(s, uc, W, zb, zs, f=0.0, n=6):
        s.uc, s.W, s.zb, s.zs, s.f = uc, W, zb, zs, f
        s.n = n if f > 0 else 1
        if f > 0:
            s.R = (W * W / 4 + f * f) / (2 * f)
            s.zc = zs + f - s.R

    def ztop(s, u, inset=0.0):
        if s.f == 0:
            return s.zs - inset
        return s.zc + math.sqrt(max((s.R - inset) ** 2 - (u - s.uc) ** 2, 0.0))

    def top(s, inset=0.0):
        hw = s.W / 2 - inset
        us = [s.uc - hw + 2 * hw * k / s.n for k in range(s.n + 1)]
        return [(u, s.ztop(u, inset)) for u in us]

    def outline(s, inset=0.0, bottom_inset=None):
        bi = inset if bottom_inset is None else bottom_inset
        hw = s.W / 2 - inset
        return [(s.uc - hw, s.zb + bi), (s.uc + hw, s.zb + bi)] + list(reversed(s.top(inset)))


def ring(g, Po, Pi, w, mat, skip=()):
    """Flat strip between two matching outlines at plane w, facing +w; `skip` lists edge indices to leave out."""
    m = len(Po)
    for i in range(m):
        if i in skip:
            continue
        j = (i + 1) % m
        q = [(*Po[i], w), (*Po[j], w), (*Pi[j], w), (*Pi[i], w)]
        face(g, q, mat, (*mean([p[:2] for p in q]), w - 1))


def tube(g, P, w0, w1, mat, centre, skip=(), inward=True):
    """The edge faces of outline P between planes w0 and w1; inward: facing the centre (reveal, frame step), else away."""
    m = len(P)
    for i in range(m):
        if i in skip:
            continue
        j = (i + 1) % m
        q = [(*P[i], w0), (*P[j], w0), (*P[j], w1), (*P[i], w1)]
        mid = ((P[i][0] + P[j][0]) / 2, (P[i][1] + P[j][1]) / 2)
        d = (mid[0] - centre[0], mid[1] - centre[1])
        k = 0.5 if inward else -0.5   # a point beyond the face (outside) makes the normal face the centre
        face(g, q, mat, (mid[0] + d[0] * k, mid[1] + d[1] * k, (w0 + w1) / 2), None)


def wall(g, mat, u0, u1, z0, zt, openings=()):
    """Wall plane w = 0 from z0 to the flat top zt over [u0, u1], left open where the shapes are; faces +w."""
    pts = {round(u0, 6), round(u1, 6)}
    for o in openings:
        for u, _ in o.top(0):
            pts.add(round(u, 6))
    us = sorted(pts)

    def top_at(o, u):
        t = o.top(0)
        for (ua, za), (ub, zb_) in zip(t, t[1:]):
            if ua - 1e-9 <= u <= ub + 1e-9:
                return za + (zb_ - za) * (u - ua) / max(ub - ua, 1e-9)
        return t[-1][1]

    for a, b in zip(us, us[1:]):
        mid = (a + b) / 2
        o = next((o for o in openings if o.uc - o.W / 2 - 1e-6 <= mid <= o.uc + o.W / 2 + 1e-6), None)
        if o is None:
            face(g, [(a, z0), (b, z0), (b, zt), (a, zt)], mat, (mid, (z0 + zt) / 2, -1))
            continue
        if o.zb > z0 + 1e-6:
            face(g, [(a, z0), (b, z0), (b, o.zb), (a, o.zb)], mat, (mid, (z0 + o.zb) / 2, -1))
        ta, tb = top_at(o, a), top_at(o, b)
        if zt - ta > 1e-6 or zt - tb > 1e-6:
            face(g, [(a, ta), (b, tb), (b, zt), (a, zt)], mat, (mid, (ta + zt) / 2, -1))


def reveal(g, o, mat, d, sill=True):
    """The four sides of an opening, d deep (local -w): both jambs, the head (follows the arch) and the sill."""
    t = o.top(0)
    ul, ur = o.uc - o.W / 2, o.uc + o.W / 2
    zl, zr = t[0][1], t[-1][1]
    face(g, [(ul, o.zb, 0), (ul, o.zb, -d), (ul, zl, -d), (ul, zl, 0)], mat, (ul - 1, (o.zb + zl) / 2, -d / 2))
    face(g, [(ur, o.zb, 0), (ur, o.zb, -d), (ur, zr, -d), (ur, zr, 0)], mat, (ur + 1, (o.zb + zr) / 2, -d / 2))
    for (ua, za), (ub, zb_) in zip(t, t[1:]):
        face(g, [(ua, za, 0), (ub, zb_, 0), (ub, zb_, -d), (ua, za, -d)], mat, ((ua + ub) / 2, (za + zb_) / 2 + 1, -d / 2))
    if sill:
        face(g, [(ul, o.zb, 0), (ur, o.zb, 0), (ur, o.zb, -d), (ul, o.zb, -d)], mat, (o.uc, o.zb - 1, -d / 2))


def surround(g, o, wd, proud, mat, bottom=False):
    """Architrave of smooth render around an opening: a flat band `wd` wide standing `proud` off the wall, with its
    outer and inner edge faces. bottom=False leaves the lower edge open (doors)."""
    bi = -wd if bottom else 0.0
    Po, Pi = o.outline(-wd, bi), o.outline(0.0, 0.0)
    skip = () if bottom else (0,)
    ring(g, Po, Pi, proud, mat, skip)
    c = (o.uc, (o.zb + o.zs) / 2)
    tube(g, Po, 0.0, proud, mat, c, skip=skip, inward=False)
    tube(g, Pi, 0.0, proud, mat, c, skip=skip, inward=True)


def bar_v(g, o, u, d, mat, t=0.032, inset=0.05):
    """Vertical glazing bar at u from the lower frame to the head, in front of the glass."""
    z0, z1 = o.zb + inset, o.ztop(u, inset)
    g.box((u, (z0 + z1) / 2, -d - 0.012), (t, z1 - z0, 0.03), mat)


def bar_h(g, o, v, d, mat, t=0.032, inset=0.05):
    hw = o.W / 2 - inset
    g.box((o.uc, v, -d - 0.012), (2 * hw, t, 0.03), mat)


def window(g, o, d, frame, glass, bars=(1, 1), fw=0.055, sill=None, rev="omberg_hall_render", transom=None):
    """A window in a reveal: sash ring at depth d, glass 3 cm behind it, glazing bars in front of the glass.
    bars (nu, nv): panes across and up; transom: also a bar at that height (arched windows at the springing line)."""
    reveal(g, o, rev, d, sill=sill is None)
    Po, Pi = o.outline(0.0), o.outline(fw)
    ring(g, Po, Pi, -d, frame)
    c = (o.uc, (o.zb + o.zs) / 2)
    tube(g, Pi, -d, -d - 0.03, frame, c, inward=True)
    gl = [(*p, -d - 0.03) for p in Pi]
    face(g, gl, glass, (o.uc, c[1], -d - 1))
    inner_w = o.W - 2 * fw
    for i in range(1, bars[0]):
        bar_v(g, o, o.uc - inner_w / 2 + inner_w * i / bars[0], d, frame)
    if o.f == 0:
        ztot = o.zs - fw - (o.zb + fw)
        for j in range(1, bars[1]):
            bar_h(g, o, o.zb + fw + ztot * j / bars[1], d, frame)
    if transom is not None:
        bar_h(g, o, transom, d, frame)
    if sill is not None:
        sw = o.W + 2 * sill[0]
        g.box((o.uc, o.zb - sill[1] / 2, (sill[2] - d) / 2), (sw, sill[1], sill[2] + d), sill[3])


def vent(g, u, v, mat="omberg_hall_render", r=0.09, dark="omberg_hall_black"):
    """Round ventilation cover: a ring 3 cm proud with a dark grille."""
    g.push(Matrix.Translation((u, v, 0)))
    g.cylinder((0, 0, 0), r, 0.03, mat, seg=10)
    face(g, [(r * 0.7 * math.cos(2 * math.pi * k / 10), r * 0.7 * math.sin(2 * math.pi * k / 10), 0.032) for k in range(10)], dark, (0, 0, -1))
    g.pop()


def lamp(g, u, v, arm=0.0):
    """Half-dome wall lamp on a short bracket (photo: dark housing). Wall-local, w out of the wall."""
    g.box((u, v, 0.02), (0.1, 0.12, 0.04), "omberg_hall_lamp")
    g.cylinder((u, v, 0.04), 0.045, 0.06 + arm, "omberg_hall_lamp", seg=8)
    g.sphere((u, v, 0.1 + arm), 0.09, "omberg_hall_lamp", seg=10, rings=4, scale=(1, 1, 0.8))


# --------------------------------------------------------------------------------------------------
# Hall
# --------------------------------------------------------------------------------------------------
HX, HY = 20.7, 8.5          # walls: half length, half width about the ridge
XE, YE = 21.15, 9.0         # roof edges (0.45 m rakes, 0.5 m eaves)
ZR, PITCH = 6.64, 0.357     # ridge height above ground, lidar plane pitch
THICK = 0.20                # roof build-up (tiles, battens, rafters) normal to the slope
DZ = THICK * math.sqrt(1 + PITCH * PITCH)
ZW = ZR - PITCH * HY - DZ   # wall top = roof underside at the wall
FL = 0.3                    # top of the plinth = bottom of the rendered wall
PROUD = 0.04                # pilasters and plinth stand this far off the wall
under = lambda y: ZR - DZ - PITCH * abs(y)
topz = lambda y: ZR - PITCH * abs(y)

HALL_AXIS = (0.55, -0.22)   # roof centre relative to the OSM rectangle centre (x along the ridge, y left)
HALL_GROUND = 103.0


def slab(g, top, mat_top, mat_under, edges, dz=DZ):
    """One roof plane: `top` polygon (planar, up-facing) and its underside dropped by dz. edges: {index of the edge
    top[i]->top[i+1]: material} get a vertical edge face (the others are joints)."""
    n = len(top)
    bot = [(x, y, z - dz) for x, y, z in top]
    c = mean(top)
    face(g, top, mat_top, (c[0], c[1], c[2] - 1))
    face(g, bot, mat_under, (c[0], c[1], c[2] + 1))
    cm = (c[0], c[1], c[2] - dz / 2)
    for i, m in edges.items():
        j = (i + 1) % n
        face(g, [top[i], top[j], bot[j], bot[i]], m, cm)


def board(g, a, b, c, mat, h=0.22, t=0.035):
    """Barge board along the roof edge a->b: hangs h below the top edge and stands t proud of the edge plane,
    outward (in plan) from c, the slab centre."""
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


def ridge_cap(g, x0, x1, z, p, mat, w=0.26, h=0.07):
    """Triangular ridge cap whose lower edges lie exactly on the two roof planes."""
    za = z - p * w
    for s in (-1, 1):
        face(g, [(x0, s * w, za), (x1, s * w, za), (x1, 0, z + h), (x0, 0, z + h)], mat, ((x0 + x1) / 2, 0, z - 1))
    for x in (x0, x1):
        face(g, [(x, -w, za), (x, w, za), (x, 0, z + h)], mat, ((x0 + x1) / 2, 0, z - 0.1))


def gutter(g, x0, x1, y, z, s, r=0.075, t=0.012, seg=6):
    """White half-round gutter along x from x0 to x1: its back touches the fascia at |y| = YE, rim at height z (open
    side up). y is the fascia plane, s the side (+1 / -1). Outer skin, inner skin, rims and end caps."""
    cy, cz = y + s * (r + 0.01), z
    arc = lambda rr: [(cy + s * rr * math.cos(math.pi * k / seg), cz - rr * math.sin(math.pi * k / seg)) for k in range(seg + 1)]
    ao, ai = arc(r), arc(r - t)
    xm = (x0 + x1) / 2
    for k in range(seg):
        (y0, z0), (y1, z1) = ao[k], ao[k + 1]
        face(g, [(x0, y0, z0), (x1, y0, z0), (x1, y1, z1), (x0, y1, z1)], "omberg_hall_gutter", (xm, cy, cz))
        (y0, z0), (y1, z1) = ai[k], ai[k + 1]
        mid = ((y0 + y1) / 2, (z0 + z1) / 2)
        face(g, [(x0, y0, z0), (x1, y0, z0), (x1, y1, z1), (x0, y1, z1)], "omberg_hall_gutter",
             (xm, mid[0] + (mid[0] - cy), mid[1] + (mid[1] - cz)))
        face(g, [(x0, ao[k][0], ao[k][1]), (x0, ao[k + 1][0], ao[k + 1][1]), (x0, ai[k + 1][0], ai[k + 1][1]), (x0, ai[k][0], ai[k][1])],
             "omberg_hall_gutter", (xm, cy, cz))
        face(g, [(x1, ao[k][0], ao[k][1]), (x1, ao[k + 1][0], ao[k + 1][1]), (x1, ai[k + 1][0], ai[k + 1][1]), (x1, ai[k][0], ai[k][1])],
             "omberg_hall_gutter", (xm, cy, cz))
    for e in (0, seg):
        face(g, [(x0, ao[e][0], ao[e][1]), (x1, ao[e][0], ao[e][1]), (x1, ai[e][0], ai[e][1]), (x0, ai[e][0], ai[e][1])],
             "omberg_hall_gutter", (xm, ao[e][0], ao[e][1] - 1))
    return cy, cz - r


def downpipe(g, x, s, gy, gz, ground=0.12, r=0.04):
    """Red round downpipe from the gutter outlet (gy, gz) down, swan-necked in to the wall (clamped on the wall
    face PROUD + pilaster), then straight to the ground with a short shoe."""
    yw = s * (HY + r + 0.02)
    g.pipe((x, gy, gz), (x, gy, gz - 0.25), r, "omberg_hall_pipe")
    g.pipe((x, gy, gz - 0.25), (x, yw, gz - 0.25 - abs(gy - yw)), r, "omberg_hall_pipe")
    zb = gz - 0.25 - abs(gy - yw)
    g.pipe((x, yw, zb), (x, yw, ground + 0.15), r, "omberg_hall_pipe")
    g.pipe((x, yw, ground + 0.15), (x, yw + s * 0.14, ground), r, "omberg_hall_pipe")


def threshold(g, uc, W, depth=0.5, zt=0.035):
    """Concrete threshold in front of a door at ground level: top 3.5 cm above the placement ground, reaching
    0.3 m below it so sloping terrain never shows a gap."""
    g.box((uc, zt - 0.17, (depth - 0.2) / 2 + 0.0), (W + 0.12, 0.34, depth + 0.2), "omberg_hall_concrete")


def leaf_frame(g, uc, W, zb, H, d, mat, glass_z=None, glass="omberg_hall_glass", fw=0.07, bars=(1, 1)):
    """One boarded door leaf at depth d: lower boarded panel, stiles and rails in front of it, an optional glazed band
    (z0, z1 absolute) with `bars` panes across/up."""
    wf = -d + 0.03
    z1 = zb + H
    g.box((uc - W / 2 + fw / 2, zb + H / 2, wf - 0.0), (fw, H, 0.06), "omberg_hall_green")
    g.box((uc + W / 2 - fw / 2, zb + H / 2, wf - 0.0), (fw, H, 0.06), "omberg_hall_green")
    g.box((uc, zb + 0.07, wf), (W - 2 * fw, 0.14, 0.06), "omberg_hall_green")
    g.box((uc, z1 - fw / 2, wf), (W - 2 * fw, fw, 0.06), "omberg_hall_green")
    lo, hi = zb + 0.14, z1 - fw
    if glass_z:
        g0, g1 = glass_z
        g.box((uc, g0 - 0.03, wf), (W - 2 * fw, 0.06, 0.06), "omberg_hall_green")
        face(g, [(uc - W / 2 + fw, lo, wf - 0.02), (uc + W / 2 - fw, lo, wf - 0.02), (uc + W / 2 - fw, g0 - 0.06, wf - 0.02),
                 (uc - W / 2 + fw, g0 - 0.06, wf - 0.02)], mat, (uc, lo, wf - 1))
        face(g, [(uc - W / 2 + fw, g0, wf - 0.02), (uc + W / 2 - fw, g0, wf - 0.02), (uc + W / 2 - fw, g1, wf - 0.02),
                 (uc - W / 2 + fw, g1, wf - 0.02)], glass, (uc, g0, wf - 1))
        iw = W - 2 * fw
        for i in range(1, bars[0]):
            g.box((uc - iw / 2 + iw * i / bars[0], (g0 + g1) / 2, wf), (0.03, g1 - g0, 0.04), "omberg_hall_green")
        for j in range(1, bars[1]):
            g.box((uc, g0 + (g1 - g0) * j / bars[1], wf), (iw, 0.03, 0.04), "omberg_hall_green")
        if g1 < hi - 1e-6:
            face(g, [(uc - W / 2 + fw, g1, wf - 0.02), (uc + W / 2 - fw, g1, wf - 0.02), (uc + W / 2 - fw, hi, wf - 0.02),
                     (uc - W / 2 + fw, hi, wf - 0.02)], mat, (uc, g1, wf - 1))
    else:
        face(g, [(uc - W / 2 + fw, lo, wf - 0.02), (uc + W / 2 - fw, lo, wf - 0.02), (uc + W / 2 - fw, hi, wf - 0.02),
                 (uc - W / 2 + fw, hi, wf - 0.02)], mat, (uc, lo, wf - 1))


def garage_door(g, o):
    """Four-leaf folding door set 0.2 m back in its reveal: green boarded leaves, the top row glazed in one pane per
    leaf (photo), a track rail on the wall above it."""
    d = 0.2
    reveal(g, o, "omberg_hall_render", d, sill=False)
    lw = o.W / 4
    H = o.zs - o.zb
    for i in range(4):
        uc = o.uc - o.W / 2 + lw * (i + 0.5)
        leaf_frame(g, uc, lw, o.zb, H, d, "omberg_hall_door_green", glass_z=(o.zs - 0.72, o.zs - 0.07), bars=(1, 1))
    g.box((o.uc, o.zs + 0.12, 0.05), (o.W + 0.5, 0.06, 0.1), "omberg_hall_steel")
    threshold(g, o.uc, o.W + 0.1, 0.6)


def entrance_door(g, o, panel="omberg_hall_door_green", small=None, d=0.1):
    """Green entrance door with a 3x3 glazed upper panel (photo) or, with `small`, one small window high in the leaf."""
    reveal(g, o, "omberg_hall_render", d, sill=False)
    H = o.zs - o.zb
    gz = (o.zb + 0.95, o.zs - 0.12) if small is None else small
    leaf_frame(g, o.uc, o.W, o.zb, H, d, panel, glass_z=gz, bars=(3, 3) if small is None else (2, 2))
    g.box((o.uc + o.W / 2 - 0.12, o.zb + 1.0, -d + 0.09), (0.04, 0.12, 0.05), "omberg_hall_steel")
    threshold(g, o.uc, o.W, 0.4)


def plain_door(g, o, panel, d=0.1):
    """Narrow ledged door (red): boarded panel in a frame, a lever handle."""
    reveal(g, o, "omberg_hall_render", d, sill=False)
    H = o.zs - o.zb
    leaf_frame(g, o.uc, o.W, o.zb, H, d, panel)
    g.box((o.uc + o.W / 2 - 0.13, o.zb + 1.0, -d + 0.09), (0.04, 0.12, 0.05), "omberg_hall_steel")
    threshold(g, o.uc, o.W, 0.4)


def plinth_run(g, frame_fn, u0, u1, gaps):
    """Light-grey render plinth band (-0.8 .. FL), PROUD off the wall, interrupted at door openings `gaps` [(u0, u1)]."""
    segs, a = [], u0
    for ga, gb in sorted(gaps):
        if ga > a:
            segs.append((a, ga))
        a = gb
    if a < u1:
        segs.append((a, u1))
    for a, b in segs:
        g.box(((a + b) / 2, (FL - 0.8) / 2, PROUD / 2), (b - a, FL + 0.8, PROUD), "omberg_hall_render")


def corner_pilaster(g, cx, cy, a=0.45):
    """L-shaped light-grey render strip round a corner, `a` wide on each wall, PROUD thick, from the plinth to the
    roof underside (photo: broad light-grey corner posts)."""
    t = PROUD
    pts = [(cx * (HX + t), cy * (HY + t)), (cx * (HX - a), cy * (HY + t)), (cx * (HX - a), cy * HY), (cx * HX, cy * HY),
           (cx * HX, cy * (HY - a)), (cx * (HX + t), cy * (HY - a))]
    area = sum(p[0] * q[1] - q[0] * p[1] for p, q in zip(pts, pts[1:] + pts[:1]))
    if area < 0:
        pts.reverse()
    g.extrude(pts, FL, ZW, "omberg_hall_render", bottom=False)


def hall(g):
    # ---- roof: two planes, edge boards, ridge cap, gutters ------------------------------------------------
    for s in (-1, 1):
        top = [(-XE, 0, ZR), (XE, 0, ZR), (XE, s * YE, topz(YE)), (-XE, s * YE, topz(YE))]
        slab(g, top, "omberg_hall_tile", "omberg_hall_fascia",
             {1: "omberg_hall_flash", 2: "omberg_hall_fascia", 3: "omberg_hall_flash"})
        c = mean(top)
        board(g, top[1], top[2], c, "omberg_hall_flash")
        board(g, top[3], top[0], c, "omberg_hall_flash")
    ridge_cap(g, -XE, XE, ZR, PITCH, "omberg_hall_tile")
    gy, gz = {}, {}
    for s in (-1, 1):
        gy[s], gz[s] = gutter(g, -XE + 0.05, XE - 0.05, s * YE, topz(YE) - 0.06, s)
    # ---- gables: render up to the wall top, dark-red trapezoidal sheet above, flashing at the join -------
    for s in (-1, 1):
        g.push(gable_frame(s, HX))
        peak = ZR - DZ
        face(g, [(-HY, ZW, 0), (HY, ZW, 0), (0, peak, 0)], "omberg_hall_trapez", (0, ZW, -1))
        g.box((0, ZW - 0.02, 0.02), (2 * HY + 0.02, 0.1, 0.04), "omberg_hall_flash")     # drip flashing at the join
        g.pop()
    # ---- openings. Positions are global x (long walls) or y (gables); converted to wall-local u --------------
    sh = lambda x, s, W, zb, zs, f=0.0, n=6: Shape(-s * x, W, zb, zs, f, n)     # long wall: u = -s*x
    S, E = 1, -1
    west = [("big", sh(-16.4, S, 2.6, 0.95, 2.45, 0.45, 8)),
            ("entr", sh(-12.7, S, 1.0, 0.035, 2.12)),
            ("gar", sh(0.0, S, 3.5, 0.035, 3.15)),
            ("red", sh(3.0, S, 0.9, 0.035, 2.1)),
            ("arch", sh(6.8, S, 0.55, 1.3, 2.1, 0.275, 5)),
            ("gar", sh(12.0, S, 3.5, 0.035, 3.15)),
            ("arch", sh(17.0, S, 0.5, 1.2, 2.1, 0.25, 5))]
    g.push(long_frame(S, HY))
    walls_openings(g, west, HX, [-S * x for x in (-10.5, 5.0, 15.0)])
    for x in (-8.7, 8.5, 15.2):
        lamp(g, -S * x, 2.95)
    for x in (-2.7, 9.3):
        vent(g, -S * x, 2.9)
    g.pop()
    # east wall (inferred: not photographed): small round-headed windows and two green entrance doors
    east = [("arch", sh(-15.0, E, 0.7, 1.2, 2.1, 0.35, 5)), ("entr", sh(-11.0, E, 1.0, 0.035, 2.12)),
            ("arch", sh(-7.0, E, 0.7, 1.2, 2.1, 0.35, 5)), ("arch", sh(0.0, E, 0.7, 1.2, 2.1, 0.35, 5)),
            ("arch", sh(7.0, E, 0.7, 1.2, 2.1, 0.35, 5)), ("entr", sh(11.0, E, 1.0, 0.035, 2.12)),
            ("arch", sh(15.0, E, 0.7, 1.2, 2.1, 0.35, 5))]
    g.push(long_frame(E, HY))
    walls_openings(g, east, HX, [])
    for x in (-13.0, 13.0):
        lamp(g, -E * x, 2.95)
    g.pop()
    # south gable (photo 098513): green door at the east corner with a small window, segmental window, round-headed one
    gs = -1
    shg = lambda y, W, zb, zs, f=0.0, n=6: Shape(gs * y, W, zb, zs, f, n)      # gable: u = s*y
    south = [("doorw", shg(-7.1, 1.0, 0.035, 2.1)),
             ("gwin", shg(-0.9, 1.8, 0.95, 2.3, 0.35, 8)),
             ("arch", shg(4.4, 0.8, 1.0, 2.2, 0.4, 6))]
    g.push(gable_frame(gs, HX))
    walls_openings(g, south, HY, [])
    lamp(g, gs * -5.5, 3.9, 0.06)
    g.pop()
    # north gable (photo 152448): red door in a grey surround, vent, hose reels, steel sink bench, duct, lamp
    shn = lambda y, W, zb, zs, f=0.0, n=6: Shape(y, W, zb, zs, f, n)
    north = [("red", shn(1.6, 0.95, 0.035, 2.1))]
    g.push(gable_frame(1, HX))
    walls_openings(g, north, HY, [-0.2])
    vent(g, 4.6, 2.85)
    north_fittings(g)
    lamp(g, 5.0, 4.0, 0.1)
    g.pop()
    # ---- corners: pilasters, downpipes -------------------------------------------------------------------
    for cx in (-1, 1):
        for cy in (-1, 1):
            corner_pilaster(g, cx, cy)
    for s, xs in ((1, (-19.4, -2.3, 9.5, 19.4)), (-1, (-19.4, 3.5, 19.4))):
        for x in xs:
            downpipe(g, x, s, gy[s], gz[s])
    # roof vent pipe seen in the ortho on the east slope (inferred height)
    g.pipe((2.2, -5.6, topz(5.6) - 0.02), (2.2, -5.6, topz(5.6) + 0.45), 0.06, "omberg_hall_steel")
    g.cylinder((2.2, -5.6, topz(5.6) + 0.45), 0.1, 0.05, "omberg_hall_steel", seg=8)


def walls_openings(g, items, half, seams):
    """Build one wall in the current local frame (u in [-half, half]): render faces with the openings cut, their
    reveals, doors, windows and surrounds, the plinth and thin render joints at local u in `seams`.
    items: [(kind, Shape)]."""
    ua, ub = -half, half
    shapes = [o for _, o in items]
    wall(g, "omberg_hall_pebble", ua, ub, FL, ZW, shapes)
    gaps = []
    for kind, o in items:
        c = o.uc
        if kind == "gar":
            garage_door(g, o)
            gaps.append((c - o.W / 2, c + o.W / 2))
        elif kind == "entr":
            entrance_door(g, o)
            surround(g, o, 0.12, 0.03, "omberg_hall_render")
            gaps.append((c - o.W / 2, c + o.W / 2))
        elif kind == "doorw":
            entrance_door(g, o, small=(o.zb + 1.45, o.zs - 0.15))
            surround(g, o, 0.12, 0.03, "omberg_hall_render")
            gaps.append((c - o.W / 2, c + o.W / 2))
        elif kind == "red":
            plain_door(g, o, "omberg_hall_door_red")
            surround(g, o, 0.1, 0.03, "omberg_hall_render")
            gaps.append((c - o.W / 2, c + o.W / 2))
        elif kind == "big":
            window(g, o, 0.14, "omberg_hall_green", "omberg_hall_glass", bars=(4, 1), transom=o.zs,
                   sill=(0.2, 0.05, 0.08, "omberg_hall_white"))
            surround(g, o, 0.2, 0.03, "omberg_hall_render", bottom=True)
        elif kind == "gwin":
            window(g, o, 0.14, "omberg_hall_white", "omberg_hall_glass", bars=(3, 1), transom=o.zs,
                   sill=(0.15, 0.05, 0.08, "omberg_hall_white"))
            surround(g, o, 0.15, 0.03, "omberg_hall_render", bottom=True)
        elif kind == "arch":
            window(g, o, 0.12, "omberg_hall_green", "omberg_hall_glass", bars=(1, 1), transom=o.zs,
                   sill=(0.1, 0.045, 0.07, "omberg_hall_render"))
            surround(g, o, 0.1, 0.03, "omberg_hall_render", bottom=True)
    plinth_run(g, None, ua, ub, gaps)
    for u in seams:                               # thin render joints (photo): a 6 cm light-grey strip, 1 cm proud
        g.box((u, (FL + ZW) / 2, 0.006), (0.06, ZW - FL, 0.012), "omberg_hall_render")


def north_fittings(g):
    """Wall fittings of the north gable (photo 152448), local u = y: two hose reels, a steel sink bench, the blue reel,
    the red dispenser box, a sign and the grey exhaust duct."""
    # reel: round drum with flanges on a bracket
    def reel(u, v, mat, hose):
        g.box((u, v, 0.03), (0.08, 0.5, 0.06), "omberg_hall_steel")
        g.cylinder((u, v, 0.06), 0.27, 0.025, mat, seg=14)             # back flange
        g.cylinder((u, v, 0.085), 0.23, 0.10, hose, seg=14)            # hose coil, its face is what is seen
        g.cylinder((u, v, 0.185), 0.05, 0.03, "omberg_hall_steel", seg=8)   # hub
    reel(4.3, 1.25, "omberg_hall_steel", "omberg_hall_hose_yellow")
    reel(5.3, 1.7, "omberg_hall_steel", "omberg_hall_black")
    reel(-5.1, 2.0, "omberg_hall_reel_blue", "omberg_hall_black")
    g.box((7.0, 1.3, 0.09), (0.34, 0.42, 0.18), "omberg_hall_box_red")
    g.box((7.5, 1.9, 0.015), (0.4, 0.5, 0.03), "omberg_hall_paper")
    # grey exhaust duct: vertical round pipe from 0.9 m to the eave, clamped on the wall
    g.pipe((-5.9, 0.9, 0.09), (-5.9, ZW - 0.1, 0.09), 0.09, "omberg_hall_steel", seg=10)
    # steel sink bench: top with basin, four legs, a lower shelf
    bu0, bu1 = -2.6, 0.2
    bw = 0.6
    g.box(((bu0 + bu1) / 2, 0.9, 0.04 + bw / 2), (bu1 - bu0, 0.04, bw), "omberg_hall_steel")
    g.box(((bu0 + bu1) / 2, 0.97, 0.04 + 0.01), (bu1 - bu0, 0.1, 0.02), "omberg_hall_steel")
    g.box((bu0 + 0.55, 0.922, 0.04 + bw / 2), (0.5, 0.004, bw * 0.7), "omberg_hall_black")      # basin opening
    for u in (bu0 + 0.05, bu1 - 0.05):
        for w in (0.1, bw + 0.0):
            g.box((u, 0.45, w), (0.04, 0.9, 0.04), "omberg_hall_steel")
    g.box(((bu0 + bu1) / 2, 0.3, 0.04 + bw / 2), (bu1 - bu0, 0.03, bw), "omberg_hall_steel")
    g.pipe((bu0 + 0.55, 1.0, 0.04), (bu0 + 0.55, 1.2, 0.06), 0.015, "omberg_hall_steel", seg=6)   # tap


# --------------------------------------------------------------------------------------------------
# Cabin
# --------------------------------------------------------------------------------------------------
CHX, CHY = 3.575, 2.5       # walls half length / half width (OSM rectangle 7.15 x 5.01)
CXE, CYE = 3.925, 2.86      # roof edges (lidar: -3.1 .. 4.6 along, -3.06 .. 2.67 across the ridge)
CZR, CP = 4.06, 0.4815      # ridge above ground, lidar pitch
CT = 0.09
CDZ = CT * math.sqrt(1 + CP * CP)
CZF = 0.2                   # floor level above the ground: the cabin stands on blocks
CZW = CZR - CP * CHY - CDZ
CABIN_AXIS = (0.78, -0.22)
CABIN_GROUND = 102.8


def cabin(g):
    ctop = lambda y: CZR - CP * abs(y)
    for s in (-1, 1):
        top = [(-CXE, 0, CZR), (CXE, 0, CZR), (CXE, s * CYE, ctop(CYE)), (-CXE, s * CYE, ctop(CYE))]
        slab(g, top, "omberg_cabin_roof", "omberg_cabin_white",
             {1: "omberg_cabin_white", 2: "omberg_cabin_white", 3: "omberg_cabin_white"}, dz=CDZ)
        c = mean(top)
        board(g, top[1], top[2], c, "omberg_cabin_white", h=0.16, t=0.03)
        board(g, top[3], top[0], c, "omberg_cabin_white", h=0.16, t=0.03)
    ridge_cap(g, -CXE, CXE, CZR, CP, "omberg_cabin_roof", w=0.18, h=0.05)
    # gables: boards up to the roof underside
    for s in (-1, 1):
        g.push(gable_frame(s, CHX))
        face(g, [(-CHY, CZW, 0), (CHY, CZW, 0), (0, CZR - CDZ, 0)], "omberg_cabin_red", (0, CZW, -1))
        g.pop()
    sh = lambda u, W, zb, zt: Shape(u, W, zb, zt)

    def cwindow(o, d=0.07):
        window(g, o, d, "omberg_cabin_white", "omberg_cabin_glass", bars=(2, 3), fw=0.05, rev="omberg_cabin_white",
               sill=(0.07, 0.04, 0.05, "omberg_cabin_white"))
        surround(g, o, 0.09, 0.02, "omberg_cabin_white", bottom=True)

    # east long wall (door side, photo): window, door, window; u = x for s = -1
    g.push(long_frame(-1, CHY))
    door = sh(0.0, 0.9, CZF, CZF + 2.05)
    win = [sh(-1.9, 0.8, CZF + 0.95, CZF + 1.85), sh(1.9, 0.8, CZF + 0.95, CZF + 1.85)]
    wall(g, "omberg_cabin_red", -CHX, CHX, CZF, CZW, win + [door])
    for o in win:
        cwindow(o)
    reveal(g, door, "omberg_cabin_white", 0.06, sill=False)
    H = door.zs - door.zb
    g.box((0, door.zb + H / 2, -0.04), (0.9, H, 0.05), "omberg_cabin_green")
    g.box((0, door.zb + 1.35, -0.012), (0.5, 0.7, 0.02), "omberg_cabin_glass")
    surround(g, door, 0.09, 0.02, "omberg_cabin_white")
    g.box((0.3, door.zb + 1.0, 0.02), (0.04, 0.12, 0.05), "omberg_cabin_white")
    # deck and step in front of the door
    g.box((0, CZF - 0.05, 0.4), (1.5, 0.1, 0.8), "omberg_cabin_deck")           # deck level with the sill
    g.box((0, 0.0, 0.95), (0.9, 0.2, 0.3), "omberg_cabin_deck")                 # one step
    for u in (-0.65, 0.65):
        g.box((u, 0.025, 0.72), (0.1, 0.25, 0.1), "omberg_cabin_deck")          # deck posts
    g.pop()
    # west long wall: two windows (inferred)
    g.push(long_frame(1, CHY))
    win = [sh(-1.6, 0.8, CZF + 0.95, CZF + 1.85), sh(1.6, 0.8, CZF + 0.95, CZF + 1.85)]
    wall(g, "omberg_cabin_red", -CHX, CHX, CZF, CZW, win)
    for o in win:
        cwindow(o)
    g.pop()
    # south gable (photo): one window high in the centre; north gable plain (inferred)
    g.push(gable_frame(-1, CHX))
    o = sh(0.0, 0.9, CZF + 0.9, CZF + 1.8)
    wall(g, "omberg_cabin_red", -CHY, CHY, CZF, CZW, [o])
    cwindow(o)
    g.pop()
    g.push(gable_frame(1, CHX))
    wall(g, "omberg_cabin_red", -CHY, CHY, CZF, CZW)
    g.pop()
    # white corner boards
    for cx in (-1, 1):
        for cy in (-1, 1):
            g.box((cx * (CHX + 0.01), cy * (CHY + 0.01), (CZF + CZW) / 2), (0.12, 0.12, CZW - CZF), "omberg_cabin_white")
    # floor underside (dark) closes the gap over the ground; concrete blocks carry it
    face(g, [(-CHX, -CHY, CZF), (CHX, -CHY, CZF), (CHX, CHY, CZF), (-CHX, CHY, CZF)], "omberg_cabin_under", (0, 0, CZF + 1))
    for x in (-CHX + 0.3, 0.0, CHX - 0.3):
        for y in (-CHY + 0.3, CHY - 0.3):
            g.box((x, y, (CZF - 0.2) / 2), (0.3, 0.3, CZF + 0.2), "omberg_cabin_block")
    # white base board over the floor edge
    for s in (-1, 1):
        g.box((0, s * (CHY + 0.006), CZF + 0.06), (2 * CHX, 0.012, 0.12), "omberg_cabin_white")
        g.box((s * (CHX + 0.006), 0, CZF + 0.06), (0.012, 2 * CHY, 0.12), "omberg_cabin_white")


# --------------------------------------------------------------------------------------------------
# White storage shed / container
# --------------------------------------------------------------------------------------------------
SL, SW, SH = 3.05, 2.7, 2.6     # ortho footprint, height from the shadow (inferred)
SHED_AT = (477690.6, 6457924.8)  # ortho, 3.05 m side along bearing 110.8
SHED_YAW = 110.8


def shed(g):
    hx, hy = SL / 2, SW / 2
    g.box((0, 0, SH / 2), (SL, SW, SH), "omberg_shed_white", skip=("bottom",))
    g.box((0, 0, SH + 0.03), (SL + 0.1, SW + 0.1, 0.06), "omberg_shed_trim")           # roof edge cap
    for sx in (-1, 1):
        for sy in (-1, 1):
            g.box((sx * hx, sy * hy, SH / 2), (0.1, 0.1, SH), "omberg_shed_trim")     # corner posts
    g.box((0, 0, 0.07), (SL + 0.06, SW + 0.06, 0.14), "omberg_shed_dark")             # base rail
    # a steel man-door on the long side facing the yard (inferred)
    g.box((hx + 0.012, 0.3, 1.05), (0.02, 0.85, 2.0), "omberg_shed_trim")
    g.box((hx + 0.02, 0.3, 1.05), (0.01, 0.7, 1.85), "omberg_shed_white")


# --------------------------------------------------------------------------------------------------
def place(r, dx, dy):
    """E, N of a point dx along / dy to the left of the rectangle's long axis from its centre."""
    yaw = math.radians((90 - r["angleDeg"]) % 180)
    e = r["cx"] + dx * math.sin(yaw) - dy * math.cos(yaw)
    n = r["cy"] + dx * math.cos(yaw) + dy * math.sin(yaw)
    return e, n, (90 - r["angleDeg"]) % 180


def ground_at(ev, e, n, r=4.0, fallback=103.0):
    p = ev.points
    m = (np.hypot(p[:, 0] - e, p[:, 1] - n) < r) & (p[:, 3] == 2)
    return float(np.median(p[m, 2])) if m.sum() > 10 else fallback


def build(add, new, ev):
    g = new()
    hall(g)
    e, n, yaw = place(ev.osm["737322222"]["properties"]["rect"], *HALL_AXIS)
    add(IDS["hall"], g, e, n, yaw, HALL_GROUND)
    g = new()
    cabin(g)
    e, n, yaw = place(ev.osm["1431573559"]["properties"]["rect"], *CABIN_AXIS)
    add(IDS["cabin"], g, e, n, yaw, CABIN_GROUND)
    g = new()
    shed(g)
    add(IDS["shed"], g, SHED_AT[0], SHED_AT[1], SHED_YAW, ground_at(ev, *SHED_AT))
