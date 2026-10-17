"""Farm garden and yard details: clipped boxwood hedges (CESimgolf prefabs from the course project), the gravel
forecourt with its round bed, the raised-bed kitchen garden with a flagstone seat, and the garden furniture.

Read from the 2025 ortho (checked against 2023) and the lidar; coordinates below are metres from
(478000, 6457000) in EPSG:3006. model.py calls register_materials() and build(add, new, ev).
Authored assets (omberg_farm_*): forecourt (gravel + the bed's mulch), kitchen_garden, garden_furniture.
Prefab assets (ev.add_prefab, many scaled instances each): hedge_boxwood, hedge_corner_boxwood, edging_boxwood,
shrub_boxwood, arborvitae.
Everything ground-bound is built relative to a ground model made from the lidar's class-2 points
(it agrees with the exported terrain DEM to 2-4 cm here) and every asset is authored around the ground
height at its own centre, which is where Unity puts it.
"""
import math
import numpy as np
import bmesh
from mathutils import Matrix
import props_kit as kit

O = (478000.0, 6457000.0)
MATTE = {"garden_gravel", "garden_path", "garden_soil", "garden_flagstone", "garden_cushion"}

# ---- survey data (metres from O) -------------------------------------------------------------
# Hedge runs fitted to the class-1 lidar returns 1.2-2.8 m over the ground (5-95% lateral spread 2.3-2.5 m);
# `h` = (station m, top height m): 80th percentile of the returns within 0.8 m of the centreline.
EAST_HEDGE = dict(
    # straight runs through the fitted centreline; `corners` = vertices with a turn over 20 degrees, closed by a cube
    pts=[(354.8, 651.0), (355.9, 656.0), (355.9, 661.1), (352.25, 667.4), (352.4, 677.0), (354.5, 686.3), (367.3, 685.3)],
    corners=(2, 3, 5), width=2.6, h=[(0, 1.82), (12, 1.82), (20, 1.86), (26, 1.97), (32, 2.10), (36, 2.26), (42, 2.20), (49, 2.28)])
# the hedge along the west edge of the lawn island, 2 m wide (lidar returns 1.55-1.8 m, lower to the south)
WEST_HEDGE = dict(pts=[(312.2, 685.6), (311.1, 679.5), (310.0, 670.0)], corners=(), width=2.0,
                  h=[(0, 1.75), (8, 1.82), (12, 1.68), (16, 1.58)])

# lit gravel of the forecourt (ortho colour segmentation, straightened east edge) minus the brick
# terrace +0.3 m and the course's own road mesh (surfaces raster class 10); counter-clockwise
FORECOURT = [(324.36, 683.36), (323.9, 684.9), (325.3, 685.4), (327.0, 685.35), (328.8, 685.0), (330.2, 685.0),
             (331.13, 685.5), (331.14, 686.98), (331.52, 687.61), (332.11, 687.85), (333.63, 687.87), (335.1, 688.36),
             (336.24, 689.53), (336.73, 689.76), (338.08, 689.78), (339.24, 690.06), (341.39, 689.78), (343.64, 689.77),
             (344.3, 689.47), (344.6, 688.9), (335.0, 671.55), (327.07, 671.54), (326.55, 671.67), (326.22, 671.95),
             (324.99, 675.73), (324.38, 676.99), (324.35, 677.79), (324.05, 679.0)]
# the teardrop bed in the loop (2023 ortho, leaf-off, clearest): 4 x 8 m, low clipped boxwood edging round it
ROUNDEL = [(330.96, 682.6), (329.7, 682.2), (329.0, 680.7), (328.9, 678.8), (329.2, 676.4), (329.8, 675.1), (330.6, 674.7),
           (331.4, 675.6), (332.2, 677.2), (332.7, 678.8), (332.9, 680.4), (332.4, 682.0)]
SHRUBS = [(330.95, 681.0, .7, .65), (330.9, 679.4, .8, .75), (330.8, 677.8, .7, .6), (330.7, 676.3, .5, .5),
          (329.9, 680.1, .45, .5), (332.0, 680.0, .45, .55), (329.85, 678.2, .45, .45), (331.9, 678.2, .45, .5)]

# kitchen garden NE of the main house: a row of small raised beds along the lawn edge and a big frame
# (2023 ortho): (centre e, n, size along, size across, rotation deg)
BEDS = [(354.3 + 1.037 * i, 715.6 - 0.22 * i, 0.95, 1.3, -12.0) for i in range(6)] + [(354.4, 717.0, .9, .9, -12.0), (355.7, 716.8, .9, .9, -12.0)]
BIG_BED = (362.7, 713.2, 5.2, 4.4, -7.7)
# packed brown path from the seat to the first bed (2025 ortho)
PATH = [(347.1, 717.9), (347.5, 716.6), (348.5, 715.7), (349.9, 715.2), (352.2, 715.0), (353.1, 715.6), (353.0, 716.9),
        (351.1, 717.8), (349.4, 718.5), (348.6, 719.4), (348.3, 720.2)]
PATIO = [(344.6, 722.0), (347.9, 722.0), (348.3, 720.2), (347.1, 717.9), (344.9, 717.9), (344.3, 719.5)]

# ---- ground model --------------------------------------------------------------------------------
_G = {}


def ground_model(ev):
    """Bilinear lidar-ground height at (e, n): class-2 points binned to 0.5 m cells, holes filled by
    growing box averages (under hedges and eaves the ground returns are sparse)."""
    if "z" not in _G:
        e0, n0, e1, n1, c = 478290.0, 6457640.0, 478390.0, 6457745.0, 0.5
        p = ev.points
        p = p[(p[:, 3] == 2) & (p[:, 0] >= e0 - 5) & (p[:, 0] < e1 + 5) & (p[:, 1] >= n0 - 5) & (p[:, 1] < n1 + 5)]
        nx, ny = int((e1 - e0) / c), int((n1 - n0) / c)
        ix = np.clip(((p[:, 0] - e0) / c).astype(int), 0, nx - 1)
        iy = np.clip(((p[:, 1] - n0) / c).astype(int), 0, ny - 1)
        S = np.zeros((ny, nx)); C = np.zeros((ny, nx))
        np.add.at(S, (iy, ix), p[:, 2]); np.add.at(C, (iy, ix), 1)

        def box(a, r):
            k = 2 * r + 1
            a = np.pad(a, r)
            cs = np.cumsum(np.cumsum(np.pad(a, ((1, 0), (1, 0))), 0), 1)
            return cs[k:, k:] - cs[:-k, k:] - cs[k:, :-k] + cs[:-k, :-k]
        z = np.full((ny, nx), np.nan)
        for r in range(0, 12):
            Sr, Cr = (S, C) if r == 0 else (box(S, r), box(C, r))
            m = np.isnan(z) & (Cr > 0)
            z[m] = Sr[m] / Cr[m]
        _G.update(z=z, e0=e0, n0=n0, c=c, nx=nx, ny=ny)
    g = _G

    def gz(e, n):
        fx = min(max((e - g["e0"]) / g["c"] - 0.5, 0), g["nx"] - 1.001)
        fy = min(max((n - g["n0"]) / g["c"] - 0.5, 0), g["ny"] - 1.001)
        i, j = int(fx), int(fy)
        u, v = fx - i, fy - j
        z = g["z"]
        return (z[j, i] * (1 - u) + z[j, i + 1] * u) * (1 - v) + (z[j + 1, i] * (1 - u) + z[j + 1, i + 1] * u) * v
    return gz


# ---- 2D helpers ---------------------------------------------------------------------------------
def A(p):
    return (O[0] + p[0], O[1] + p[1])


def chaikin(pts, n=3, closed=True):
    for _ in range(n):
        out = []
        m = len(pts)
        for i in range(m if closed else m - 1):
            a, b = pts[i], pts[(i + 1) % m]
            out += [(a[0] * .75 + b[0] * .25, a[1] * .75 + b[1] * .25), (a[0] * .25 + b[0] * .75, a[1] * .25 + b[1] * .75)]
        pts = out if closed else [pts[0]] + out + [pts[-1]]
    return pts


def centreline(pts, step=1.2):
    """Catmull-Rom through the survey points, resampled about every `step` m (stations in m)."""
    P = [np.array(p, float) for p in pts]
    P = [P[0] * 2 - P[1]] + P + [P[-1] * 2 - P[-2]]
    out = []
    for i in range(1, len(P) - 2):
        p0, p1, p2, p3 = P[i - 1], P[i], P[i + 1], P[i + 2]
        n = max(1, int(round(np.linalg.norm(p2 - p1) / step)))
        for k in range(n):
            t = k / n
            out.append(0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t ** 3))
    out.append(P[-2])
    return [tuple(map(float, p)) for p in out]


def interp(tab, s):
    if s <= tab[0][0]:
        return tab[0][1]
    for (a, ha), (b, hb) in zip(tab[:-1], tab[1:]):
        if s <= b:
            return ha + (hb - ha) * (s - a) / (b - a)
    return tab[-1][1]


def orient(poly):
    a = sum(p[0] * q[1] - q[0] * p[1] for p, q in zip(poly, poly[1:] + poly[:1]))
    return poly if a > 0 else poly[::-1]


class Frame:
    """Asset-local frame centred at (e, n) on the ground: x east, y north, z up from the ground there."""

    def __init__(self, gz, pts):
        xs = [p[0] for p in pts]; ys = [p[1] for p in pts]
        self.e = round(O[0] + (min(xs) + max(xs)) / 2, 1)
        self.n = round(O[1] + (min(ys) + max(ys)) / 2, 1)
        self.gz, self.z0 = gz, gz(self.e, self.n)

    def xy(self, p):
        e, n = A(p)
        return (e - self.e, n - self.n)

    def z(self, p):
        return self.gz(*A(p)) - self.z0


# ---- mesh builders ------------------------------------------------------------------------------
def fill(poly, step):
    """Triangles of a polygon (survey metres, counter-clockwise) cut by a `step` m grid so a surface laid on
    it can follow the ground. Returns (triangles, boundary edges as (a, b) CCW pairs)."""
    bm = bmesh.new()
    bm.faces.new([bm.verts.new((x, y, 0)) for x, y in poly])
    xs = [p[0] for p in poly]; ys = [p[1] for p in poly]
    for ax, lo, hi in ((0, min(xs), max(xs)), (1, min(ys), max(ys))):
        for v in np.arange(math.ceil(lo / step) * step, hi, step):
            no = (1, 0, 0) if ax == 0 else (0, 1, 0)
            co = (v, 0, 0) if ax == 0 else (0, v, 0)
            bmesh.ops.bisect_plane(bm, geom=bm.verts[:] + bm.edges[:] + bm.faces[:], dist=1e-4, plane_co=co, plane_no=no)
    bmesh.ops.triangulate(bm, faces=bm.faces[:])
    tris = [[(v.co.x, v.co.y) for v in f.verts] for f in bm.faces]
    edges = []
    for e in bm.edges:
        if e.is_boundary:
            lp = e.link_loops[0]
            edges.append(((lp.vert.co.x, lp.vert.co.y), (lp.link_loop_next.vert.co.x, lp.link_loop_next.vert.co.y)))
    bm.free()
    return tris, edges


def surface(g, F, poly, mat, lift, step=2.0, skirt=0.15, edge_mat=None):
    """A thin pavement laid on the ground: grid-cut fill at ground + lift, and a skirt going `skirt` m
    under the ground round the rim, so the terrain mesh never shows through."""
    tris, edges = fill(orient(poly), step)
    for t in tris:
        g.poly([(*F.xy(p), F.z(p) + lift) for p in t], mat)
    for a, b in edges:
        g.poly([(*F.xy(a), F.z(a) - skirt), (*F.xy(b), F.z(b) - skirt), (*F.xy(b), F.z(b) + lift), (*F.xy(a), F.z(a) + lift)],
               edge_mat or mat)


def board_box(g, F, c, size, rot, mat, top_mat=None):
    """Axis box in survey coordinates, rotated `rot` degrees, standing on the highest ground under it."""
    x, y = F.xy(c)
    cs = [(c[0] + dx * math.cos(math.radians(rot)) - dy * math.sin(math.radians(rot)),
           c[1] + dx * math.sin(math.radians(rot)) + dy * math.cos(math.radians(rot)))
          for dx in (-size[0] / 2, size[0] / 2) for dy in (-size[1] / 2, size[1] / 2)]
    zs = [F.z(p) for p in cs] + [F.z(c)]
    lo, hi = min(zs) - 0.06, max(zs)
    g.box((x, y, (lo + hi + size[2]) / 2), (size[0], size[1], hi + size[2] - lo), mat, rz=rot,
          mats={"top": top_mat} if top_mat else None)


# ---- furniture ----------------------------------------------------------------------------------
def at(g, x, y, z, yaw):
    g.push(Matrix.Translation((x, y, z)) @ Matrix.Rotation(math.radians(yaw), 4, "Z"))


def chair(g, mat="wood_post_brown", yaw=0.0):
    at(g, 0, 0, 0, yaw)
    g.box((0, 0, 0.44), (0.44, 0.44, 0.04), mat)
    g.box((0, -0.2, 0.7), (0.44, 0.04, 0.48), mat)                # back on the -y side (faces +y)
    for sx in (-0.19, 0.19):
        g.box((sx, 0.19, 0.21), (0.04, 0.04, 0.42), mat)
        g.box((sx, -0.2, 0.21), (0.04, 0.04, 0.42), mat)
    g.pop()


def round_table(g, r, top_mat, h=0.74):
    g.cylinder((0, 0, h - 0.04), r, 0.04, top_mat, seg=16)
    g.cylinder((0, 0, 0), 0.05, h - 0.04, "black_steel", seg=8)
    g.cylinder((0, 0, 0), 0.28, 0.03, "black_steel", seg=12)


def lounger(g, mat="paint_white", cushion="garden_cushion"):
    g.box((0, 0, 0.22), (0.62, 1.9, 0.08), mat)
    g.box((0, 0.15, 0.31), (0.58, 1.4, 0.1), cushion)
    g.beam((0, -0.7, 0.3), (0, -1.05, 0.72), 0.58, 0.09, cushion)   # raised back at the -y end
    for sy in (-0.8, 0.8):
        for sx in (-0.26, 0.26):
            g.box((sx, sy, 0.09), (0.05, 0.05, 0.18), "black_steel")


def sofa(g, mat="wood_post_brown", cushion="garden_cushion"):
    g.box((0, 0, 0.15), (1.9, 0.8, 0.3), mat)
    g.box((0, 0.05, 0.38), (1.7, 0.62, 0.16), cushion)
    g.box((0, -0.36, 0.62), (1.9, 0.1, 0.5), mat)
    for sx in (-0.9, 0.9):
        g.box((sx, 0, 0.35), (0.1, 0.8, 0.7), mat)


# ---- build --------------------------------------------------------------------------------------
def _tex_farmgravel(self, color="132,117,102"):
    """The kit's pebble gravel with its contrast halved: worn drive gravel reads as one tone from a few metres."""
    alb, hgt, strength = self.tex_gravel(color)
    mean = alb.mean(axis=(0, 1), keepdims=True)
    return mean + (alb - mean) * 0.5, hgt, 3.0


def register_materials():
    kit.TextureBank.tex_farmgravel = _tex_farmgravel
    kit.MATERIALS.update({
        # beige-brown worn gravel (Street View Aug 2025 + ortho); darker than the ortho pixels because the
        # course scene lights sunlit faces at ~1.7x albedo
        "garden_gravel": ("farmgravel:132,117,102", (2.0, 2.0), None, 0.04, 0.0),
        "garden_path": ("farmgravel:112,98,86", (2.0, 2.0), None, 0.03, 0.0),
        "garden_soil": ("gravel:78,62,50", (2.0, 2.0), None, 0.03, 0.0),
        "garden_flagstone": ("stone:136,132,124", (2.0, 2.0), None, 0.1, 0.0),
        "garden_cushion": (None, (1, 1), (190, 188, 180), 0.1, 0.0),
    })


# ---- Unity prefabs ------------------------------------------------------------------------------
BOX = "Assets/CESimgolf 3D Assets/BUSHES - Boxwood/PREFABS/"
ARB = "Assets/CESimgolf 3D Assets/BUSHES - Arborvitae/PREFABS/"
# Prefab size at scale 1 in Unity's axes: L along local x (the long axis), W across (local z), H = top above
# the pivot (local y; the mesh also sits ~0.2 m below the pivot). From the FBX/prefab files in the Omberg
# project and data/arborist/catalog-sizes.json. NB the manifest `scale` is Unity's localScale: (x, y UP, z).
REC_SMALL = dict(path=BOX + "Boxwood Rectangle Small.prefab", L=6.35, W=1.59, H=1.267)
SQUARE = dict(path=BOX + "Boxwood Square.prefab", L=1.564, W=1.564, H=1.566)
ROUND = dict(path=BOX + "Boxwood Round.prefab", L=1.096, W=1.096, H=0.88)
THUJA = dict(path=ARB + "Arborvitae_Tall_Thin_PREFAB.prefab", L=2.27, W=2.27, H=6.04)


def put_prefab(ev, gz, aid, P, p, yaw, length, width, height, overlap=1.0, dz=0.0):
    """One scaled instance centred at survey point p whose footprint is length x width and whose top stands
    `height` above the terrain. The driver multiplies `size` by the scale per axis and draws it as (along, across,
    up), so the review box gets its axes swapped to come out right."""
    e, n = A(p)
    sc = (length * overlap / P["L"], height / P["H"], width / P["W"])
    ev.add_prefab(aid, P["path"], round(e, 2), round(n, 2), round(yaw, 2), gz(e, n), scale=sc,
                  size=(P["L"], P["H"], P["W"]), dz=dz)


def bearing(a, b):
    return math.degrees(math.atan2(b[0] - a[0], b[1] - a[1]))


def hedge_row(ev, gz, spec, max_len=6.0):
    """Boxwood Rectangle Small blocks tiled along the runs (about 6 m, 6% overlap), top height from the lidar
    table, and a Boxwood Square cube on each sharp corner so the outer corner closes."""
    pts, w = spec["pts"], spec["width"]
    cum = [0.0]
    for a, b in zip(pts, pts[1:]):
        cum.append(cum[-1] + math.dist(a, b))
    for i, (a, b) in enumerate(zip(pts, pts[1:])):
        L = cum[i + 1] - cum[i]
        n = max(1, math.ceil(L / max_len))
        for k in range(n):
            t = (k + .5) / n
            c = (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)
            put_prefab(ev, gz, "omberg_farm_hedge_boxwood", REC_SMALL, c, bearing(a, b), L / n, w, interp(spec["h"], cum[i] + t * L), 1.06)
    for i in spec["corners"]:
        put_prefab(ev, gz, "omberg_farm_hedge_corner_boxwood", SQUARE, pts[i], bearing(pts[i], pts[i + 1]), w, w, interp(spec["h"], cum[i]))


def resample_closed(ring, step):
    cum = [0.0]
    for a, b in zip(ring, ring[1:] + ring[:1]):
        cum.append(cum[-1] + math.dist(a, b))
    n = max(3, round(cum[-1] / step))
    out, j = [], 0
    for k in range(n):
        s = cum[-1] * k / n
        while cum[j + 1] < s:
            j += 1
        a, b, t = ring[j], ring[(j + 1) % len(ring)], (s - cum[j]) / (cum[j + 1] - cum[j])
        out.append((a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t))
    return out


def build(add, new, ev):
    gz = ground_model(ev)

    # --- hedges: boxwood prefab blocks along the fitted runs
    hedge_row(ev, gz, EAST_HEDGE)
    hedge_row(ev, gz, WEST_HEDGE)

    # --- forecourt gravel and the round bed (soil here; the planting is prefabs)
    g = new(); g.category = "structure"
    F = Frame(gz, FORECOURT + ROUNDEL)
    ring = orient(chaikin(ROUNDEL, 3))
    surface(g, F, [p for p in FORECOURT], "garden_gravel", 0.035)
    # bed: mulch up to the edging; the edging, shrubs and thuja pair are prefabs below
    c = (sum(p[0] for p in ring) / len(ring), sum(p[1] for p in ring) / len(ring))

    def inset(d):
        return [(c[0] + (p[0] - c[0]) * (1 - d / max(math.dist(p, c), 1)), c[1] + (p[1] - c[1]) * (1 - d / max(math.dist(p, c), 1))) for p in ring]
    surface(g, F, inset(0.4), "garden_soil", 0.14, step=1.0, skirt=0.1)
    add("omberg_farm_forecourt", g, F.e, F.n, 90, F.z0)
    # low clipped edging on the outline (0.44 m wide, 0.42 m tall), ~1.8 m blocks round the ends, 15% overlap
    ep = resample_closed(inset(0.3), 1.8)
    for a, b in zip(ep, ep[1:] + ep[:1]):
        put_prefab(ev, gz, "omberg_farm_edging_boxwood", REC_SMALL, ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2), bearing(a, b),
                   math.dist(a, b), 0.44, 0.42, 1.15)
    for e, n, r, h in SHRUBS:                       # clipped round shrubs, standing on the mulch (+0.12)
        put_prefab(ev, gz, "omberg_farm_shrub_boxwood", ROUND, (e, n), 0, 1.8 * r, 1.8 * r, h + 0.05, dz=0.12)
    # INFERRED, not seen in the orthos: a pair of clipped columns flanking the entrance of the manor-type main
    # house (OSM 1431566968, porch on its south side); move them to suit the dwellings agent's steps
    for e, n in ((328.7, 690.7), (337.1, 690.7)):
        put_prefab(ev, gz, "omberg_farm_arborvitae", THUJA, (e, n), 0, 0.95, 0.95, 2.3)

    # --- kitchen garden (raised beds) and the flagstone seat
    g = new(); g.category = "structure"
    pts = [(b[0], b[1]) for b in BEDS] + [BIG_BED[:2]] + PATIO + PATH
    F = Frame(gz, pts)
    wood, t = "wood_grey", 0.04
    for e, n, a, b, rot in BEDS + [BIG_BED]:
        cr, sr = math.cos(math.radians(rot)), math.sin(math.radians(rot))
        h = 0.24
        # frame: four boards stood on the highest ground under the bed, a soil box between them
        for ox, oy, sx, sy in ((0, b / 2 - t / 2, a, t), (0, -b / 2 + t / 2, a, t), (a / 2 - t / 2, 0, t, b - 2 * t), (-a / 2 + t / 2, 0, t, b - 2 * t)):
            board_box(g, F, (e + ox * cr - oy * sr, n + ox * sr + oy * cr), (sx, sy, h), rot, wood)
        board_box(g, F, (e, n), (a - 2 * t, b - 2 * t, h - 0.04), rot, "garden_soil")
    surface(g, F, PATIO, "garden_flagstone", 0.03, step=1.5, skirt=0.1)
    surface(g, F, PATH, "garden_path", 0.025, step=1.5, skirt=0.1)
    add("omberg_farm_kitchen_garden", g, F.e, F.n, 90, F.z0)

    # --- furniture: brick terrace east of the main house (terrace top ~ ground + 0.05) and the seat
    g = new(); g.category = "prop"
    sets = [(339.8, 693.5), (350.6, 693.8), (348.0, 705.2), (352.7, 705.0), (346.0, 721.7)]
    F = Frame(gz, sets)

    def put(p, lift, yaw, fn, *a):
        x, y = F.xy(p)
        at(g, x, y, F.z(p) + lift, yaw)
        fn(g, *a)
        g.pop()
    p = (339.8, 693.5)                                   # round table with six chairs
    put(p, 0.05, 0, round_table, 0.7, "wood_grey")
    for k in range(6):
        a = math.radians(60 * k + 20)
        put((p[0] + 1.05 * math.cos(a), p[1] + 1.05 * math.sin(a)), 0.05, math.degrees(a) + 90, chair, "wood_post_brown")
    put((350.6, 693.8), 0.05, -20, kit.picnic_table, dict(length=2.2, mat="wood_post_brown", frame="black_steel"))
    put((348.0, 705.2), 0.05, 130, sofa)
    for q, yaw in (((352.4, 705.0), 100), ((353.3, 704.6), 100)):
        put(q, 0.05, yaw, lounger)
    p = (346.0, 721.7)                                   # flagstone seat: white table, three chairs
    put(p, 0.03, 0, round_table, 0.42, "paint_white", 0.72)
    for k in range(3):
        a = math.radians(120 * k + 90)
        put((p[0] + 0.8 * math.cos(a), p[1] + 0.8 * math.sin(a)), 0.03, math.degrees(a) + 90, chair, "wood_grey")
    add("omberg_farm_garden_furniture", g, F.e, F.n, 90, F.z0)
