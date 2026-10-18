"""1-2 km ring: low-geometry buildings from shared archetypes, fitted per building to lidar and ortho.

model.py calls register_materials() and build(add, new, ev). Players see these as silhouettes on the
horizon, so what counts is: right place and footprint, right roof form and heights (lidar), right roof
and wall colour, very few triangles. Every building is fitted from the lidar (class 1 returns inside
the OSM footprint; OSM is the guide for the footprint and its orientation), snapped to a coarse grid and
then collapsed onto a shared asset when another building is near enough the same. Windows, doors and
the plinth are texture or flat strips, not geometry; roof material is texture; the roof slab is two
planes with a fascia band, no gutters.

The fitter is plain numpy so it also runs outside Blender (kit is None there): see fit_building().
SPEC below is the per-building judgement from the ortho (class, wall, roof colour) plus the few
geometry overrides where the lidar is silent (dark roofs return nothing) or the footprint is a cluster
of wings.
"""
import json
import math
import os
from pathlib import Path

import numpy as np

try:
    import props_kit as kit
except ImportError:  # plain-Python analysis run: no bpy, so no materials or geometry
    kit = None

NEAR_LIMIT = 1000.0  # near.py builds everything within this distance of the clubhouse
# "far farmsteads" (far/farms.py) already builds these
OTHER_SET = {"1109741285", "1109741286", "1109741287", "1109741288", "1109741289", "1109741290", "1431576952"}
OVH = 0.3            # eave and gable overhang of every roof, m
FASC = 0.16          # roof slab edge (fascia band) height, m
PLINTH = 0.45        # plinth strip above the floor line, m
SNAP = 0.5           # footprint sizes snap to this, m
HSNAP = 0.25         # heights snap to this: a 0.5 m grid alone would eat the 0.3 m residual budget
H_MIN = 1.8          # lidar returns lower than this above the ground are not roof
SKIP = {}            # OSM id -> why it is not built (tree, not a building ...)


# ---------------------------------------------------------------------------------------------
# Geometry helpers (frame = metres east/north rotated so +x runs along the building's long axis)
# ---------------------------------------------------------------------------------------------
def _in_poly(poly, x, y):
    """Even-odd point-in-polygon for arrays x, y."""
    ins = np.zeros(np.shape(x), bool)
    n = len(poly)
    for i in range(n):
        x1, y1 = poly[i]
        x2, y2 = poly[(i + 1) % n]
        if y1 == y2:
            continue
        ins ^= ((y1 > y) != (y2 > y)) & (x < (x2 - x1) * (y - y1) / (y2 - y1) + x1)
    return ins


def _main_angle(poly):
    """Dominant edge direction (radians): the length-weighted circular mean of 4*theta, /4."""
    s = c = 0.0
    for i in range(len(poly)):
        dx, dy = poly[(i + 1) % len(poly)][0] - poly[i][0], poly[(i + 1) % len(poly)][1] - poly[i][1]
        L = math.hypot(dx, dy)
        s += L * math.sin(4 * math.atan2(dy, dx))
        c += L * math.cos(4 * math.atan2(dy, dx))
    return math.atan2(s, c) / 4


def _largest_rect(mask):
    """Largest all-True axis-aligned rectangle (r0, r1, c0, c1; ends exclusive) in a boolean grid."""
    h = np.zeros(mask.shape[1], int)
    best, arg = 0, None
    for r in range(mask.shape[0]):
        h = np.where(mask[r], h + 1, 0)
        st = []
        for c in range(len(h) + 1):
            cur = h[c] if c < len(h) else 0
            start = c
            while st and st[-1][1] >= cur:
                s0, hh = st.pop()
                if hh * (c - s0) > best:
                    best, arg = hh * (c - s0), (r - hh + 1, r + 1, s0, c)
                start = s0
            st.append((start, cur))
    return arg


def decompose(poly_xy, step=0.5, min_area=8.0, min_side=2.0):
    """Rectilinear polygon (in the building frame) -> disjoint rectangles (x0, x1, y0, y1), biggest first.
    A polygon that fills 78 % of its bounding box stays one rectangle (a notch is OSM noise there)."""
    p = np.asarray(poly_xy)
    x0, y0 = p.min(0)
    x1, y1 = p.max(0)
    nx, ny = int(math.ceil((x1 - x0) / step)), int(math.ceil((y1 - y0) / step))
    gx, gy = np.meshgrid(x0 + (np.arange(nx) + .5) * step, y0 + (np.arange(ny) + .5) * step)
    mask = _in_poly(p, gx, gy)
    total = mask.sum() * step * step
    if total > 0.78 * (x1 - x0) * (y1 - y0):
        return [(x0, x1, y0, y1)]
    out = []
    while mask.any():
        r0, r1, c0, c1 = _largest_rect(mask)
        area = (r1 - r0) * (c1 - c0) * step * step
        if out and area < max(min_area, 0.05 * total):
            break
        if (r1 - r0) * step >= min_side and (c1 - c0) * step >= min_side:
            out.append((x0 + c0 * step, x0 + c1 * step, y0 + r0 * step, y0 + r1 * step))
        mask[r0:r1, c0:c1] = False
    return out


def _ground_plane(g, poly, cx, cy, reach):
    """Least-squares ground plane z = a + b*(x-cx) + c*(y-cy) from class 2 returns around (not under) a footprint."""
    m = (np.abs(g[:, 0] - cx) < reach) & (np.abs(g[:, 1] - cy) < reach)
    q = g[m]
    q = q[~_in_poly(poly, q[:, 0], q[:, 1])]
    if len(q) < 8:
        return None
    A = np.column_stack([np.ones(len(q)), q[:, 0] - cx, q[:, 1] - cy])
    co = None
    for _ in range(3):  # trim returns on walls, hedges and ditches
        co, *_ = np.linalg.lstsq(A, q[:, 2], rcond=None)
        r = A @ co - q[:, 2]
        k = np.abs(r) < max(0.25, 2.5 * np.median(np.abs(r)))
        if k.sum() < 8:
            break
        A, q = A[k], q[k]
    return co


# ---------------------------------------------------------------------------------------------
# Roof forms: s(x, y) in 0..1 is how far up the roof's eave-to-ridge rise a point is
# ---------------------------------------------------------------------------------------------
def _tent(u, t):
    """0 at both ends of 0..1, 1 at t."""
    return np.where(u < t, u / t, (1 - u) / (1 - t))


def _shape(form, x, y, r, t=0.5):
    """r = (x0, x1, y0, y1) roof outline; x along the long axis. t: where along the span a gable's ridge sits."""
    cx, cy, a, b = (r[0] + r[1]) / 2, (r[2] + r[3]) / 2, (r[3] - r[2]) / 2, (r[1] - r[0]) / 2
    if form == "gable":        # ridge along x
        return _tent((y - r[2]) / (2 * a), t)
    if form == "gable_y":      # ridge across the short axis
        return _tent((x - r[0]) / (2 * b), t)
    if form == "hip":          # same pitch on all four sides
        return np.minimum(a - np.abs(y - cy), b - np.abs(x - cx)) / min(a, b)
    if form == "mono":         # low at -y
        return (y - r[2]) / (2 * a)
    if form == "mono_n":       # low at +y
        return (r[3] - y) / (2 * a)
    if form == "mono_x":       # low at -x
        return (x - r[0]) / (2 * b)
    if form == "mono_xn":
        return (r[1] - x) / (2 * b)
    return np.zeros_like(np.asarray(x, float))  # flat


# (form, ridge position, cost): a lopsided ridge or a non-flat form must win by its cost in residual metres
CANDS = [("flat", .5, 0.0)] + [(f, t, c + 0.6 * abs(t - .5)) for f, c in (("gable", .05), ("gable_y", .08))
                                for t in (.3, .35, .4, .45, .5, .55, .6, .65, .7)]     + [("hip", .5, .12), ("mono", .5, .1), ("mono_n", .5, .1), ("mono_x", .5, .14), ("mono_xn", .5, .14)]


def roof_z(form, R, t, e, r, e2, x, y):
    """Roof height at plan points: eave e (low side) to ridge r; a lopsided gable (t != .5) keeps one pitch,
    so its far eave sits at e2 (None: same as e)."""
    if form in ("gable", "gable_y") and e2 is not None and e2 != e:
        if form == "gable":
            u = (y - R[2]) / (R[3] - R[2])
        else:
            u = (x - R[0]) / (R[1] - R[0])
        return np.where(u < t, e + (r - e) * u / t, e2 + (r - e2) * (1 - u) / (1 - t))
    return e + (r - e) * _shape(form, x, y, R, t)


def _fit_equal_pitch(form, t, pts, rect):
    """Lopsided gable with one pitch on both slopes: z = ridge - pitch * |distance from the ridge line|."""
    lo, span = (rect[2], rect[3] - rect[2]) if form == "gable" else (rect[0], rect[1] - rect[0])
    d = np.abs(pts[:, 1 if form == "gable" else 0] - (lo + t * span))
    z = pts[:, 2]
    k = np.ones(len(z), bool)
    for _ in range(6):
        if np.ptp(d[k]) < 1:
            return None
        co, *_ = np.linalg.lstsq(np.column_stack([np.ones(k.sum()), d[k]]), z[k], rcond=None)
        r = np.abs(co[0] + co[1] * d - z)
        k2 = r < max(0.4, 2.2 * np.median(r[k]))
        if k2.sum() < max(6, 0.4 * len(z)) or (k2 == k).all():
            break
        k = k2
    r = np.abs(co[0] + co[1] * d - z)
    ridge, p = float(co[0]), float(-co[1])
    if not .1 < p < 1.1:
        return None
    return dict(form=form, t=t, eave=ridge - p * t * span, e2=ridge - p * (1 - t) * span, ridge=ridge, pitch=p,
                res=float(np.median(r[k])), share=float(k.mean()))


def fit_form(form, t, pts, rect):
    """Robust (eave, ridge, median residual, inlier share) of one roof form to points (x, y, h)."""
    if form in ("gable", "gable_y") and t != .5:
        return _fit_equal_pitch(form, t, pts, rect)
    s = _shape(form, pts[:, 0], pts[:, 1], rect, t)
    z = pts[:, 2]
    k = np.ones(len(z), bool)
    co = None
    for _ in range(6):
        if form == "flat":
            co = np.array([np.median(z[k]), 0.0])
        else:
            if np.ptp(s[k]) < 0.2:
                return None
            co, *_ = np.linalg.lstsq(np.column_stack([np.ones(k.sum()), s[k]]), z[k], rcond=None)
        r = np.abs(co[0] + co[1] * s - z)
        k2 = r < max(0.4, 2.2 * np.median(r[k]))  # trim trees, chimneys and dormers
        if k2.sum() < max(6, 0.4 * len(z)) or (k2 == k).all():
            break
        k = k2
    r = np.abs(co[0] + co[1] * s - z)
    return dict(form=form, t=t, eave=float(co[0]), e2=float(co[0]), ridge=float(co[0] + co[1]), res=float(np.median(r[k])),
                share=float(k.mean()))


def _rise_ok(f, rise, a, b):
    if f in ("gable", "hip"):
        return .12 < rise / a < 1.1   # 6 to 48 degrees
    if f == "gable_y":
        return .12 < rise / b < 1.1
    if f in ("mono", "mono_n"):
        return .05 < rise / (2 * a) < .6
    if f in ("mono_x", "mono_xn"):
        return .05 < rise / (2 * b) < .6
    return True


def pick_form(pts, rect, only=None, flat=True):
    """Best roof form for the points (None if too few to say). `only` restricts to one form name."""
    if len(pts) < 14:
        return None
    a, b = (rect[3] - rect[2]) / 2, (rect[1] - rect[0]) / 2
    cands = []
    for f, t, cost in CANDS:
        if (only and f != only) or (f == "flat" and not flat):
            continue
        c = fit_form(f, t, pts, rect)
        if not c or (t == .5 and not _rise_ok(f, c["ridge"] - c["eave"], a, b)):
            continue
        if f == "hip" and abs(a - b) < 0.3:
            continue  # a pyramid is not a form this ring needs
        c["score"] = c["res"] + cost + 0.25 * (1 - c["share"])
        cands.append(c)
    return min(cands, key=lambda c: c["score"]) if cands else None


# ---------------------------------------------------------------------------------------------
# Fitting one building
# ---------------------------------------------------------------------------------------------
def wanted(ev):
    """The visible-buildings entries this set builds: beyond 1 km, minus the other set's."""
    vis = json.loads((ev.data / "visible-buildings.json").read_text())
    return [b for b in vis if b["d"] > NEAR_LIMIT and b["id"] not in OTHER_SET and b["id"] not in SKIP]


class Frame:
    """World (E, N) <-> building frame: origin (e, n), +x along `th` (radians CCW from east)."""
    def __init__(self, e, n, th):
        self.e, self.n, self.th = e, n, th
        self.c, self.s = math.cos(th), math.sin(th)

    def fwd(self, x, y):
        dx, dy = np.asarray(x) - self.e, np.asarray(y) - self.n
        return self.c * dx + self.s * dy, -self.s * dx + self.c * dy

    def back(self, x, y):
        return self.e + self.c * x - self.s * y, self.n + self.s * x + self.c * y

    @property
    def yaw(self):  # compass bearing of local +x (model.py turns it into 90 - yaw)
        return round((90 - math.degrees(self.th)) % 360, 3)


def frame_of(poly):
    th = _main_angle(poly)
    for _ in range(2):
        c, s = math.cos(th), math.sin(th)
        u = poly[:, 0] * c + poly[:, 1] * s
        v = -poly[:, 0] * s + poly[:, 1] * c
        if np.ptp(v) > np.ptp(u):  # long axis along local x
            th += math.pi / 2
        else:
            break
    uc, vc = (u.max() + u.min()) / 2, (v.max() + v.min()) / 2
    return Frame(uc * c - vc * s, uc * s + vc * c, th)


def fit_building(b, ev, c1, g, forms=None):
    """Footprint parts, ground and roof of one visible-buildings entry, from lidar returns c1 (class 1)
    and g (class 2). Heights are metres above the ground plane at the building centre.
    forms: optional {part index: form name} to refit with that form."""
    poly = np.array(ev.osm[b["id"]]["geometry"]["coordinates"][0])[:-1]
    fr = frame_of(poly)
    px, py = fr.fwd(poly[:, 0], poly[:, 1])
    parts = decompose(np.column_stack([px, py]))
    cx, cy = poly.mean(0)
    reach = max(b["L"], b["W"]) / 2 + 14
    co = _ground_plane(g, poly, cx, cy, reach)
    near = (np.abs(c1[:, 0] - fr.e) < reach) & (np.abs(c1[:, 1] - fr.n) < reach)
    q = c1[near]
    qx, qy = fr.fwd(q[:, 0], q[:, 1])
    gz = co[0] + co[1] * (q[:, 0] - cx) + co[2] * (q[:, 1] - cy)
    F = float(co[0] + co[1] * (fr.e - cx) + co[2] * (fr.n - cy))
    out = []
    for i, r in enumerate(parts):
        m = (qx > r[0] - .6) & (qx < r[1] + .6) & (qy > r[2] - .6) & (qy < r[3] + .6) & (q[:, 2] - gz > H_MIN)
        pts = np.column_stack([qx[m], qy[m], q[m, 2] - gz[m]])
        out.append(dict(rect=[round(float(v), 2) for v in r], n=int(m.sum()), pts=pts,
                        fit=pick_form(pts, r, (forms or {}).get(i))))
    return dict(id=b["id"], frame=fr, parts=out, F=F, poly=poly, gplane=(co, cx, cy))


# ---------------------------------------------------------------------------------------------
# Per-building judgement. wall/roof keys are the palette below; parts = [(x0, x1, y0, y1, form, eave, ridge[, t])]
# in the building frame (fit_building prints it) replace the fitted parts where the lidar could not.
# ---------------------------------------------------------------------------------------------
def S(cls, wall, roof, **k):
    return dict(cls=cls, wall=wall, roof=roof, **k)


SPEC = {
    # c9_south_east: the big halls and barns SE of the course
    "1109741274": S("barn", "red", "sheet_dark"),
    "1109741275": S("hall", "sheet_pale", "fc"),
    "1109741276": S("barn", "white", "sheet_pale"),
    "1109741277": S("hall", "sheet_pale", "sheet_pale"),
    "1109741278": S("hall", "sheet_grey", "sheet_dark", solar={0: (-37, 8, -8.3, -3.4)}),
    "1109741279": S("barn", "red", "sheet_dark"),
    "1109741280": S("barn", "red", "sheet_dark"),
    # c2_east_south
    "1109741281": S("cottage", "white", "sheet_dark"),
    "1109741282": S("barn", "grey", "sheet_dark"),
    "1109741283": S("farmhouse", "white", "tile_red"),
    # c1_east
    "1109741291": S("shed", "red", "sheet_dark"),
    "1109741292": S("cottage", "white", "sheet_dark"),
    "1109741293": S("shed", "red", "sheet_dark"),
    "1109741294": S("farmhouse", "white", "tile_red"),
    # c6_east_far
    "1109741296": S("shed", "red", "sheet_pale"),
    "1109741297": S("farmhouse", "white", "tile_red"),
    "1109741298": S("barn", "red", "tile_brown", roofs={1: "sheet_pale"}),
    "1109741299": S("cottage", "red", "sheet_dark"),
    "1109741300": S("cottage", "white", "tile_red", form="gable"),
    "1109741301": S("shed", "red", "sheet_dark"),
    "1109741302": S("cottage", "red", "tile_red", form="hip"),
    # c3_south
    "1109741324": S("shed", "white", "sheet_pale"),
    "1109741325": S("long_shed", "red", "sheet_dark"),
    "1109741326": S("cottage", "red", "sheet_dark"),
    "1109741327": S("farmhouse", "yellow", "tile_red"),
    # c4_south_west
    "1109749344": S("farmhouse", "white", "tile_red"),
    "1109749345": S("shed", "red", "sheet_pale"),
    "1109749346": S("shed", "red", "fc"),
    "1431566982": S("farmhouse", "white", "sheet_dark", solar={0: (-7.5, 7.5, -4.0, -2.2)}),
    "1431566983": S("shed", "red", "tile_red"),
    "1431566984": S("long_shed", "red", "sheet_dark"),
    "1431566985": S("long_shed", "red", "sheet_dark"),
    # c10_south_far
    "1109749347": S("hall", "sheet_pale", "sheet_rust", roofs={1: "sheet_pale", 2: "sheet_dark"}, parts=[
        (-3, 17.5, -9.75, 4.25, "gable", 4.5, 9.5, .45), (-3, 17.5, 4.25, 9.75, "flat", 4.5, 4.5),
        (-17.5, -3, -9.75, 9.75, "mono", 4.0, 5.5)]),
    "1109749349": S("shed", "red", "sheet_dark"),
    "1109749350": S("farmhouse", "yellow", "tile_red"),
    "1109749351": S("shed", "red", "sheet_dark"),
    # c7_north
    "1421568564": S("shed", "red", "tile_brown"),
    "1421568565": S("cottage", "white", "tile_red"),
    "1421568566": S("shed", "white", "sheet_white"),
    "1431561178": S("shed", "red", "fc"),
    # c5_north_east
    "1431550310": S("barn", "red", "sheet_pale"),
    "1431550311": S("barn", "red", "tile_brown"),
    "1431550312": S("shed", "red", "sheet_dark", lidar=False),  # under tree canopy: only a dark roof strip shows
    "1431558260": S("farmhouse", "red", "sheet_dark", form="hip", hts={0: (4.0, 7.5)}),
    "1431558261": S("farmhouse", "red", "sheet_dark"),
    "1431558262": S("shed", "red", "sheet_dark"),
    "1431558265": S("barn", "red", "tile_brown"),
    "1431558266": S("farmhouse", "yellow", "tile_red", form="hip"),
    "1431558267": S("hall", "sheet_dark", "sheet_dark"),
    "1431558268": S("tank", "grey", "fc", parts=[(-13, 13, -13, 13, "flat", 2.2, 2.2)]),
    "1431558270": S("shed", "red", "fc"),
    "1431558271": S("barn", "red", "tile_brown"),
    "1431558272": S("barn", "red", "tile_brown"),
    "1431558273": S("hall", "sheet_grey", "sheet_pale", parts=[
        (-32.75, 32.75, -13.6, 2.4, "gable", 4.75, 12.75, .56, 6.75), (-0.75, 14.75, 2.4, 19.9, "gable_y", 5.5, 12.5, .43),
        (18.75, 32.75, -20.1, -13.6, "mono", 3.75, 5.0)]),
    "1431558274": S("cottage", "white", "tile_brown", roofs={1: "sheet_white"}),
    "1431558275": S("shed", "red", "sheet_dark"),
    "1431558315": S("hall", "sheet_dark", "sheet_dark", solar={0: (1.5, 9.0, -21, 5.6)}),
}

# class -> (eave m above the floor, pitch degrees) when the lidar has nothing to say
PRIOR = {"farmhouse": (4.2, 38), "cottage": (2.8, 35), "barn": (4.5, 28), "long_shed": (2.8, 18),
         "hall": (5.0, 14), "shed": (2.5, 22)}


# ---------------------------------------------------------------------------------------------
# Palette: roof and wall materials. Colours are albedo (the ortho shows lit values ~1.4x brighter; the
# values follow the course's other ring/background sets, calibrated against this same ortho).
# ---------------------------------------------------------------------------------------------
ROOFS = {  # key -> (texture kind, rgb)
    "tile_red": ("tile", "152,72,54"), "tile_brown": ("tile", "122,96,88"), "tile_orange": ("tile", "164,80,56"),
    "sheet_dark": ("sheet", "66,74,88"), "sheet_pale": ("corr", "172,176,180"),
    "sheet_white": ("corr", "204,206,208"), "sheet_rust": ("corr", "128,102,88"), "fc": ("plain", "130,133,138"),
    "felt": ("plain", "104,72,60")}
BOARDS = {  # wall key -> (texture kind, rgb) for barns and sheds: vertical boards or sheet
    "red": ("boards", "106,33,29"), "darkred": ("boards", "88,29,26"), "brown": ("boards", "74,56,46"),
    "grey": ("boards", "124,120,112"), "white": ("boards", "176,174,166"), "yellow": ("boards", "196,172,108"),
    "sheet_grey": ("sheet", "150,152,150"), "sheet_dark": ("sheet", "70,76,84"), "sheet_pale": ("sheet", "190,192,190")}
FACADES = {"white": "176,174,166", "yellow": "198,174,110", "red": "108,36,30", "grey": "150,146,136"}
DOOR = {"boards": "58,40,34", "sheet": "62,66,72"}
HOUSES = ("farmhouse", "cottage")


# ---------------------------------------------------------------------------------------------
# Textures (albedo only, small: at 1-2 km they only have to read as roof, wall and window rhythm)
# ---------------------------------------------------------------------------------------------
def _col(c):
    return np.array([int(v) for v in c.split(",")], float) / 255.0


def _noise(S, W, seed, scales=(64, 16, 4)):
    return kit._fbm((S, W), seed, scales=scales)


def tex_ringroof(kind, rgb, S="256"):
    """Roof tile (2 m), standing-seam or corrugated sheet (2.08 m) or plain fibre cement / felt."""
    S = int(S)
    col = _col(rgb)
    g = _noise(S, S, 21)
    y = np.arange(S)[:, None] / S
    x = np.arange(S)[None, :] / S
    if kind == "tile":  # 6 courses x 8 pans per 2 m, each course darker at its lower lip
        fy, fx = (y * 6) % 1, (x * 8) % 1
        tid = np.floor(y * 6).astype(int) * 8 + np.floor(x * 8).astype(int)
        shade = 1 + (np.random.default_rng(9).random(60) - .5) * .18
        v = shade[tid] * (0.82 + 0.22 * (.5 + .5 * np.cos(fx * 2 * math.pi))) * (0.92 + 0.12 * g)
        v = np.where(fy > 0.92, v * .62, v)
    elif kind in ("sheet", "corr"):  # 4 seams or 13 ribs per 2.08 m, running down the slope
        n = 4 if kind == "sheet" else 13
        f = (x * n) % 1
        prof = np.where(f < .08, 1.12, .96) if kind == "sheet" else .9 + .14 * np.sin(f * 2 * math.pi)
        v = prof * (0.92 + 0.14 * g) * np.ones_like(y)
    else:
        v = 0.86 + 0.26 * g + 0.06 * (np.random.default_rng(4).random((S, S)) - .5)
    return np.clip(col * v[:, :, None], 0, 1), None, 0


def tex_ringwall(kind, rgb, S="256"):
    """Vertical boards (0.2 m) or corrugated sheet (0.16 m ribs) over a 2 m / 2.08 m tile."""
    S = int(S)
    col = _col(rgb)
    x = np.arange(S)[None, :] / S
    g = _noise(S, S, 31, (64, 16, 4))
    if kind == "boards":
        pos = (x * 10) % 1
        idx = np.floor(x * 10).astype(int)
        shade = 1 + (np.random.default_rng(3).random(12) - .5) * .12
        v = shade[idx] * (0.88 + 0.14 * g) * np.where((pos < .06) | (pos > .96), .55, 1.0)
    else:
        v = (0.9 + 0.14 * np.sin((x * 13) % 1 * 2 * math.pi)) * (0.92 + 0.12 * g)
    return np.clip(col * (v * np.ones((S, 1)))[:, :, None], 0, 1), None, 0


def tex_ringfacade(rgb, S="256"):
    """House wall: two 1.2 x 1.3 m windows (white frame, dark glass, mullion cross) per 4.8 x 2.7 m tile, sill at 0.8 m."""
    S = int(S)
    col = _col(rgb)
    g = _noise(S, S, 41, (64, 16, 4))
    img = col[None, None, :] * (0.94 + 0.08 * g)[:, :, None]
    U = (np.arange(S)[None, :] + .5) / S * 4.8
    V = (1 - (np.arange(S)[:, None] + .5) / S) * 2.7
    frame = np.array([.86, .86, .83]) if col.mean() < .6 else np.array([.55, .56, .55])
    for cx in (1.2, 3.6):
        dx, dy = np.abs(U - cx), np.abs(V - 1.45)
        inside = (dx < .6) & (dy < .65)
        glass = (dx < .53) & (dy < .58) & ~((dx < .03) | (np.abs(V - 1.45) < .03))
        img = np.where(inside[:, :, None], frame, img)
        img = np.where(glass[:, :, None], _col("40,48,58") * (0.9 + 0.2 * g)[:, :, None], img)
        img = np.where(((dx < .68) & (V > .74) & (V < .82))[:, :, None], frame * .9, img)  # sill
    return np.clip(img, 0, 1), None, 0


def tex_ringdoor(rgb, door, kind, S="256"):
    """Barn / hall end wall: a 12 x 6 m tile with one dark door 4 m wide and 3.2 m high in the middle (door sits on the floor)."""
    S = int(S)
    base, _, _ = tex_ringwall(kind, rgb, str(S))
    W = S * 2
    img = np.concatenate([base, base], 1)
    U = (np.arange(W)[None, :] + .5) / W * 12
    V = (1 - (np.arange(S)[:, None] + .5) / S) * 6
    g = _noise(S, W, 51, (64, 16, 4))
    dcol = _col(door)[None, None, :] * (0.9 + 0.2 * g)[:, :, None]
    inside = (np.abs(U - 6) < 2.0) & (V < 3.2)
    seam = (np.abs(U - 6) < .05)  # the two leaves
    d = np.where(seam[:, :, None] & inside[:, :, None], dcol * .6, dcol)
    return np.clip(np.where(inside[:, :, None], d, img), 0, 1), None, 0


def tex_ringsolar():
    """1 x 1.7 m panel: 6 x 10 dark cells, thin frame."""
    S = 128
    yy, xx = np.arange(S)[:, None] / S, np.arange(S)[None, :] / S
    gap = (((yy * 10) % 1) < .06) | (((xx * 6) % 1) < .08)
    frame = (xx < .03) | (xx > .97) | (yy < .02) | (yy > .98)
    img = np.ones((S, S, 3)) * _col("24,30,46")
    img = np.where(gap[:, :, None], _col("70,76,90"), img)
    return np.where(frame[:, :, None], _col("150,152,156"), img), None, 0


FLAT = {  # name -> (rgb, smoothness)
    "far_plinth": ("120,118,112", 0), "far_trim_white": ("172,172,166", 0), "far_trim_dark": ("52,44,40", 0),
    "far_concrete": ("132,130,124", 0), "far_slurry": ("84,66,54", 0)}


def register_materials():
    """All ring materials: matte (ground-level scatter and silhouette reading, never a specular glint)."""
    M = kit.MATERIALS
    kit.TextureBank.tex_ringroof = lambda self, *a: tex_ringroof(*a)
    kit.TextureBank.tex_ringwall = lambda self, *a: tex_ringwall(*a)
    kit.TextureBank.tex_ringfacade = lambda self, *a: tex_ringfacade(*a)
    kit.TextureBank.tex_ringdoor = lambda self, *a: tex_ringdoor(*a)
    kit.TextureBank.tex_ringsolar = lambda self, *a: tex_ringsolar()
    for k, (kind, rgb) in ROOFS.items():
        t = 2.0 if kind in ("tile", "plain") else 2.08
        M["far_roof_" + k] = ("ringroof:%s:%s" % (kind, rgb), (t, t), None, 0.0, 0.0)
    for k, (kind, rgb) in BOARDS.items():
        t = 2.0 if kind == "boards" else 2.08
        M["far_wall_" + k] = ("ringwall:%s:%s" % (kind, rgb), (t, t), None, 0.0, 0.0)
        M["far_door_" + k] = ("ringdoor:%s:%s:%s" % (rgb, DOOR[kind], kind), (12.0, 6.0), None, 0.0, 0.0)
    for k, rgb in FACADES.items():
        M["far_fac_" + k] = ("ringfacade:" + rgb, (4.8, 2.7), None, 0.0, 0.0)
    M["far_solar"] = ("ringsolar", (1.0, 1.7), None, 0.0, 0.0)
    for k, (rgb, sm) in FLAT.items():
        M[k] = (None, (1, 1), tuple(int(v) for v in rgb.split(",")), sm, 0.0)


MATTE = {"far_roof_" + k for k in ROOFS} | {"far_wall_" + k for k in BOARDS} | {"far_door_" + k for k in BOARDS} \
    | {"far_fac_" + k for k in FACADES} | {"far_solar"} | set(FLAT)


# ---------------------------------------------------------------------------------------------
# Geometry: walls as boxes per wing (plinth strip + wall + gable), roof as planes with a fascia band
# ---------------------------------------------------------------------------------------------
def _snap(v, q=SNAP):
    return round(v / q) * q


def _out(g, pts, mat, hint, uv=None):
    """Add a face with its normal turned to `hint` (Unity culls back faces)."""
    n = np.zeros(3)
    for i in range(len(pts)):
        a, b = np.array(pts[i]), np.array(pts[(i + 1) % len(pts)])
        n += np.cross(a, b)
    if np.dot(n, hint) < 0:
        pts = pts[::-1]
        if uv:
            uv = ("uv", uv[1][::-1])
    g.poly([tuple(float(c) for c in p) for p in pts], mat, uv)


def _plan(form, R, t):
    """Roof planes of an outline rectangle as plan polygons, counter-clockwise from above."""
    x0, x1, y0, y1 = R
    A, B, C, D = (x0, y0), (x1, y0), (x1, y1), (x0, y1)
    xc, yc = (x0 + x1) / 2, (y0 + y1) / 2
    if form == "gable":
        ym = y0 + t * (y1 - y0)
        return [[A, B, (x1, ym), (x0, ym)], [(x0, ym), (x1, ym), C, D]]
    if form == "gable_y":
        xm = x0 + t * (x1 - x0)
        return [[A, (xm, y0), (xm, y1), D], [(xm, y0), B, C, (xm, y1)]]
    if form == "hip":
        a = min(x1 - x0, y1 - y0) / 2
        if x1 - x0 >= y1 - y0:
            P, Q = (x0 + a, yc), (x1 - a, yc)
            return [[A, B, Q, P], [B, C, Q], [C, D, P, Q], [D, A, P]]
        P, Q = (xc, y0 + a), (xc, y1 - a)
        return [[A, B, P], [B, C, Q, P], [C, D, Q], [D, A, P, Q]]
    return [[A, B, C, D]]


def _zfun(w):
    return lambda x, y: float(roof_z(w["form"], w["R"], w["t"], w["eave"], w["ridge"], w["e2"], np.float64(x), np.float64(y)))


def _shared(parts, i, side):
    """True when another wing touches side `side` (0 -x, 1 +x, 2 -y, 3 +y) of wing i: no overhang there."""
    R = parts[i]["R"]
    for j, o in enumerate(parts):
        if j == i:
            continue
        Q = o["R"]
        if side < 2:
            edge, other = (R[0], Q[1]) if side == 0 else (R[1], Q[0])
            span = min(R[3], Q[3]) - max(R[2], Q[2])
        else:
            edge, other = (R[2], Q[3]) if side == 2 else (R[3], Q[2])
            span = min(R[1], Q[1]) - max(R[0], Q[0])
        if abs(edge - other) < 0.3 and span > 0.5:
            return True
    return False


def build_wing(g, p, w, i, depth, mats):
    """One rectangular wing: walls, roof slab, optional solar quad. p: asset params; w: the wing."""
    form, t, e, r = w["form"], w["t"], w["eave"], w["ridge"]
    R = w["R"]
    ov = [0.0 if _shared(p["parts"], i, s) else OVH for s in range(4)]
    Wr = (R[0] + ov[0], R[1] - ov[1], R[2] + ov[2], R[3] - ov[3])
    z = _zfun(w)
    top = lambda x, y: z(x, y) - FASC  # wall tops meet the underside of the slab
    xm = R[0] + t * (R[1] - R[0])
    ym = R[2] + t * (R[3] - R[2])
    house = p["cls"] in HOUSES
    door_sides = {"gable": ("-x", "+x"), "gable_y": ("-y", "+y")}.get(form, ()) if p["cls"] in ("barn", "hall", "long_shed") else ()
    roof_m, wall_m, trim = "far_roof_" + w["roof"] if w.get("roof") else mats["roof"], mats["wall"], mats["trim"]
    # --- walls: sides run counter-clockwise round the wing, outward on the right
    x0, x1, y0, y1 = Wr
    sides = [("-y", (x0, y0), (x1, y0), (0, -1), xm), ("+x", (x1, y0), (x1, y1), (1, 0), ym),
             ("+y", (x1, y1), (x0, y1), (0, 1), xm), ("-x", (x0, y1), (x0, y0), (-1, 0), ym)]
    for name, a, b, nrm, kink in sides:
        L = math.hypot(b[0] - a[0], b[1] - a[1])
        ss = [0.0, L]
        if form in ("gable", "gable_y") and 0.0 < t:
            # the ridge crosses a wall running across it: one more vertex at the peak
            along_y = name in ("+x", "-x")
            if (form == "gable" and along_y) or (form == "gable_y" and not along_y):
                c = (a[1] if along_y else a[0])
                d = (b[1] if along_y else b[0])
                if min(c, d) < kink < max(c, d):
                    ss = [0.0, abs(kink - c), L]
        P = lambda s, zz: (a[0] + (b[0] - a[0]) * s / L, a[1] + (b[1] - a[1]) * s / L, zz)
        tops = [(s, top(*P(s, 0)[:2])) for s in ss]
        zp = 0.0 if name in door_sides else PLINTH
        hint = (nrm[0], nrm[1], 0)
        _out(g, [P(0, -depth), P(L, -depth), P(L, zp), P(0, zp)], "far_plinth", hint)
        eave_z = min(zz for _, zz in tops)
        poly = [P(0, zp), P(L, zp)] + [P(s, zz) for s, zz in reversed(tops)]
        if name in door_sides:
            uv = [(s - L / 2 + 6.0, min(zz, 5.9)) for s, zz in [(0, zp), (L, zp)] + list(reversed(tops))]
            _out(g, poly, mats["door"], hint, ("uv", uv))
        elif house:
            nb = max(1, round(L / 2.4))
            nst = max(1, round((eave_z - PLINTH) / 2.7))
            vs = 2.7 * nst / max(eave_z - PLINTH, 1.0)
            uv = [(s / L * nb * 2.4, (zz - PLINTH) * vs) for s, zz in [(0, zp), (L, zp)] + list(reversed(tops))]
            _out(g, poly, wall_m, hint, ("uv", uv))
        else:
            _out(g, poly, wall_m, hint)
    # --- roof slab: top planes, the same planes FASC lower (seen from below), and the edge band
    planes = _plan(form, R, t)
    edges = {}
    for pl in planes:
        P3 = [(x, y, z(x, y)) for x, y in pl]
        _out(g, P3, roof_m, (0, 0, 1))
        _out(g, [(x, y, zz - FASC) for x, y, zz in P3], roof_m, (0, 0, -1))
        for k in range(len(pl)):
            edges[(pl[k], pl[(k + 1) % len(pl)])] = True
    for (a, b) in edges:
        if (b, a) in edges:
            continue  # inner edge (ridge, hip) shared by two planes
        za, zb = z(*a), z(*b)
        out = (b[1] - a[1], -(b[0] - a[0]), 0)  # right of a->b: outward for counter-clockwise planes
        _out(g, [(a[0], a[1], za - FASC), (b[0], b[1], zb - FASC), (b[0], b[1], zb), (a[0], a[1], za)], trim, out)
    sol = w.get("solar")
    if sol:  # a panel field flat on the slope, 3 cm proud
        sx0, sx1, sy0, sy1 = sol
        q = [(sx0, sy0), (sx1, sy0), (sx1, sy1), (sx0, sy1)]
        _out(g, [(x, y, z(x, y) + 0.03) for x, y in q], "far_solar", (0, 0, 1))


def build_tank(g, p, depth):
    """Round slurry tank: a low concrete drum with a brown crust."""
    w = p["parts"][0]
    R = w["R"]
    cx, cy, rad = (R[0] + R[1]) / 2, (R[2] + R[3]) / 2, min(R[1] - R[0], R[3] - R[2]) / 2
    h = w["eave"]
    n = 20
    ring = [(cx + rad * math.cos(2 * math.pi * k / n), cy + rad * math.sin(2 * math.pi * k / n)) for k in range(n)]
    for k in range(n):
        a, b = ring[k], ring[(k + 1) % n]
        _out(g, [(a[0], a[1], -depth), (b[0], b[1], -depth), (b[0], b[1], h), (a[0], a[1], h)], "far_concrete",
             ((a[0] + b[0]) / 2 - cx, (a[1] + b[1]) / 2 - cy, 0))
    _out(g, [(x, y, h) for x, y in ring], "far_slurry", (0, 0, 1))


def build_asset(p, depth, new):
    """Geometry of one shared asset from its parameters p (see resolve())."""
    g = new()
    if p["cls"] == "tank":
        build_tank(g, p, depth)
        return g
    wall = p["wall"]
    if p["cls"] in HOUSES:
        wm = "far_fac_" + wall
        dm = None
    else:
        wm, dm = "far_wall_" + wall, "far_door_" + wall
    mats = dict(roof="far_roof_" + p["roof"], wall=wm, door=dm,
                trim="far_trim_white" if p["cls"] in HOUSES and wall in ("white", "yellow") else "far_trim_dark")
    for i, w in enumerate(p["parts"]):
        build_wing(g, p, w, i, depth, mats)
    return g


# ---------------------------------------------------------------------------------------------
# From fit + judgement to asset parameters, sharing, placement
# ---------------------------------------------------------------------------------------------
def _prior(cls, R, form):
    e, deg = PRIOR[cls]
    a, b = (R[3] - R[2]) / 2, (R[1] - R[0]) / 2
    span = {"gable": a, "gable_y": b, "hip": min(a, b)}.get(form, 2 * min(a, b))
    return e, e + math.tan(math.radians(deg)) * span


def resolve(fit, spec):
    """Wings [{R, form, t, eave, ridge}] of one building: lidar fit where trustworthy, class prior elsewhere."""
    cls = spec["cls"]
    parts = []
    if spec.get("parts"):
        for q in spec["parts"]:
            parts.append(dict(R=tuple(_snap(v) for v in q[:4]), form=q[4], eave=_snap(q[5], HSNAP), ridge=_snap(q[6], HSNAP),
                              t=q[7] if len(q) > 7 else .5, e2=_snap(q[8], HSNAP) if len(q) > 8 else None, src="spec"))
    else:
        for i, pt in enumerate(fit["parts"]):
            R = tuple(_snap(v) for v in pt["rect"])
            f = pt["fit"]
            if spec.get("form") and f and f["form"] != spec["form"]:
                f = pick_form(pt["pts"], pt["rect"], spec["form"])
            elif f and f["form"] == "flat" and cls != "shed":  # a pitched roof seen only in part reads flat
                f = pick_form(pt["pts"], pt["rect"], flat=False)
            ok = f and pt["n"] >= 20 and f["res"] <= 0.6 and f["share"] >= 0.4 and spec.get("lidar", True)                 and not (f["form"] == "flat" and cls != "shed")
            if ok:
                w = dict(R=R, form=f["form"], t=f["t"], eave=_snap(f["eave"], HSNAP), ridge=_snap(f["ridge"], HSNAP),
                         e2=_snap(f["e2"], HSNAP), src="lidar")
            else:
                form = spec.get("form") or ("gable" if R[1] - R[0] >= R[3] - R[2] else "gable_y")
                e, r = _prior(cls, R, form)
                if pt["n"] >= 15:  # keep the class pitch but sit it at the level of the few returns there are
                    sh = _shape(form, pt["pts"][:, 0], pt["pts"][:, 1], pt["rect"], .5)
                    e = float(np.median(pt["pts"][:, 2] - (r - e) * sh))
                    e, r = max(e, 2.2), max(e, 2.2) + (r - e)
                w = dict(R=R, form=form, t=.5, eave=_snap(e, HSNAP), ridge=_snap(r, HSNAP), e2=_snap(e, HSNAP), src="prior")
            h = (spec.get("hts") or {}).get(i)
            if h:
                w["eave"], w["ridge"] = _snap(h[0], HSNAP), _snap(h[1], HSNAP)
            parts.append(w)
    for i, w in enumerate(parts):
        if (spec.get("roofs") or {}).get(i):
            w["roof"] = spec["roofs"][i]  # a wing with its own roof material
        if w["form"] == "flat":
            w["ridge"] = w["eave"]
        if w.get("e2") is None or w["form"] not in ("gable", "gable_y"):
            w["e2"] = w["eave"]
        w["e2"] = max(w["e2"], 2.0)
        w["eave"] = max(w["eave"], 2.0)
        w["ridge"] = max(w["ridge"], w["eave"] + (0 if w["form"] == "flat" else HSNAP))
        if (spec.get("solar") or {}).get(i):
            w["solar"] = spec["solar"][i]
    return dict(cls=cls, wall=spec["wall"], roof=spec["roof"], parts=parts)


def _sig(p):
    return (p["cls"], p["wall"], p["roof"], tuple((w["R"], w["form"], w["t"], w["eave"], w["e2"], w["ridge"], tuple(w.get("solar") or ()), w.get("roof"))
                                                    for w in p["parts"]))


def share(rows, rel=0.2, tol=(2.5, 2.0, 0.5, 0.75, 0.5, 0.12)):
    """Collapse look-alike single-wing buildings onto one asset: same wall, roof and roof form (houses with
    houses, outbuildings with outbuildings) and a size within max(tol, rel * size) of the group's first
    (length, width) or within tol (eave, ridge, far eave, ridge position). The shared asset takes the group's
    median size. Returns {asset signature: params}; every row gets its 'key'."""
    groups = {}
    for r in rows:
        p = r["p"]
        if len(p["parts"]) == 1 and p["cls"] != "tank" and not p["parts"][0].get("solar") and not p["parts"][0].get("roof"):
            w = p["parts"][0]
            groups.setdefault((p["cls"] in HOUSES, p["wall"], p["roof"], w["form"]), []).append(r)
    for key, lst in groups.items():
        lst.sort(key=lambda r: -(r["p"]["parts"][0]["R"][1] - r["p"]["parts"][0]["R"][0]))
        clusters = []
        for r in lst:
            w = r["p"]["parts"][0]
            vec = (w["R"][1] - w["R"][0], w["R"][3] - w["R"][2], w["eave"], w["ridge"], w["e2"], w["t"])
            for c in clusters:
                lim = (max(tol[0], rel * c["vec"][0]), max(tol[1], rel * c["vec"][1])) + tuple(tol[2:])
                if all(abs(v - u) <= t for v, u, t in zip(vec, c["vec"], lim)):
                    c["rows"].append(r)
                    break
            else:
                clusters.append(dict(vec=vec, rows=[r]))
        for c in clusters:
            ws = [r["p"]["parts"][0] for r in c["rows"]]
            med = lambda k: float(np.median([k(w) for w in ws]))
            L, W = _snap(med(lambda w: w["R"][1] - w["R"][0])), _snap(med(lambda w: w["R"][3] - w["R"][2]))
            base = dict(c["rows"][0]["p"])
            base["parts"] = [dict(ws[0], R=(-L / 2, L / 2, -W / 2, W / 2), eave=_snap(med(lambda w: w["eave"]), HSNAP),
                                  ridge=_snap(med(lambda w: w["ridge"]), HSNAP), e2=_snap(med(lambda w: w["e2"]), HSNAP),
                                  t=round(med(lambda w: w["t"]) * 20) / 20)]
            for r in c["rows"]:
                r["p"] = base
    assets = {}
    for r in rows:
        r["key"] = _sig(r["p"])
        assets.setdefault(r["key"], r["p"])
    return assets


def terrain_fn(ev):
    """ev.terrain with the DEM arrays decompressed once (the Evidence keeps lazy npz members: every call would unzip 130 MB)."""
    d = {k: (np.asarray(v["z"]), float(v["topLeftE"]), float(v["topLeftN"]), float(v["pixelE"]), float(v["pixelN"]))
         for k, v in ev.dems.items()}
    w, s_, e1, n1 = (float(v) for v in ev.dems["inner"]["valid"])

    def f(e, n):
        z, tle, tln, pe, pn = d["inner" if w < e < e1 and s_ < n < n1 else "outer"]
        x, y = (e - tle) / pe - .5, (tln - n) / pn - .5
        i, j = int(math.floor(y)), int(math.floor(x))
        fy, fx = y - i, x - j
        i, j = max(0, min(i, z.shape[0] - 2)), max(0, min(j, z.shape[1] - 2))
        return float(z[i, j] * (1 - fx) * (1 - fy) + z[i, j + 1] * fx * (1 - fy) + z[i + 1, j] * (1 - fx) * fy + z[i + 1, j + 1] * fx * fy)
    return f


def terrain_depth(terrain, poly, F):
    """How far the walls go below the floor line F: to the lowest Unity ground under the footprint, 0.3 m further."""
    xs, ys = poly[:, 0], poly[:, 1]
    gx, gy = np.meshgrid(np.arange(xs.min(), xs.max() + 1, 1.5), np.arange(ys.min(), ys.max() + 1, 1.5))
    m = _in_poly(poly, gx, gy)
    pts = [(x, y) for x, y in zip(gx[m], gy[m])] + [tuple(v) for v in poly]
    lo = min(terrain(x, y) for x, y in pts)
    return max(0.5, math.ceil((F - lo + 0.3) / SNAP) * SNAP)


def build(add, new, ev):
    P = ev.points
    c1, g = P[P[:, 3] == 1], P[P[:, 3] == 2]
    terrain = terrain_fn(ev)
    rows = []
    for b in wanted(ev):
        fit = fit_building(b, ev, c1, g)
        rows.append(dict(b=b, fit=fit, p=resolve(fit, SPEC[b["id"]]), depth=terrain_depth(terrain, fit["poly"], fit["F"])))
    assets = share(rows)
    depth = {}
    for r in rows:  # a shared asset goes as deep as its deepest instance
        depth[r["key"]] = max(depth.get(r["key"], 0), r["depth"])
    ids, geos, counter = {}, {}, {}
    for key, p in assets.items():
        counter[p["cls"]] = counter.get(p["cls"], 0) + 1
        ids[key] = "omberg_ring_far_%s_%02d" % (p["cls"], counter[p["cls"]])
        geos[key] = build_asset(p, depth[key], new)
    dump = []
    for r in rows:
        fr, aid = r["fit"]["frame"], ids[r["key"]]
        add(aid, geos[r["key"]], fr.e, fr.n, fr.yaw, r["fit"]["F"])
        dump.append(dict(id=r["b"]["id"], asset=aid, e=fr.e, n=fr.n, yaw=fr.yaw, F=r["fit"]["F"], poly=r["fit"]["poly"].tolist(),
                         depth=depth[r["key"]], cls=r["p"]["cls"],
                         parts=[dict(R=w["R"], form=w["form"], t=w["t"], eave=w["eave"], e2=w["e2"], ridge=w["ridge"], src=w["src"])
                                for w in r["p"]["parts"]],
                         fit=[None if not pt["fit"] else dict(form=pt["fit"]["form"], eave=pt["fit"]["eave"], ridge=pt["fit"]["ridge"],
                                                              res=pt["fit"]["res"], n=pt["n"]) for pt in r["fit"]["parts"]]))
    tris = sum(sum(len(f) - 2 for f, _, _ in geos[k].faces) for k in assets)
    print("far ring: %d buildings, %d assets, %d triangles (%d with instances)" % (
        len(rows), len(assets), tris, sum(sum(len(f) - 2 for f, _, _ in geos[r["key"]].faces) for r in rows)), flush=True)
    if os.environ.get("FAR_RING_DUMP"):
        Path(os.environ["FAR_RING_DUMP"]).write_text(json.dumps(dump, indent=1))
