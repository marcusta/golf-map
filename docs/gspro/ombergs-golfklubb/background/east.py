"""House cluster SE of hole 12 green: OSM 1109741303-1109741323 (a row of small cabins, larger houses and barns) and the
buildings the OSM does not have yet (the new houses NW of the cabins, the glasshouse).

Evidence: lidar class-1 (data/omberg-background/lidar-crop.npz) for every building that stood in the survey; the 2025
ortho for the three new builds NW of the cabins (L-house, solar house, big dark hall), which the lidar predates -
their heights come from shadow lengths (sun ~44 deg up from ESE, calibrated on the cabins) and typical roofs.
The orthos are not true orthos (roofs lean ~1 m), so roof extents, ridges and pitches are lidar plane fits
(two-pitch least squares, see the SPEC numbers) and the ortho only gives roof form, colour and outline of wings.
Walls are invisible from above: colours are typical Ostergotland ones, marked inferred. Everything not in the
sources is marked "inferred".

Engine (copied from farm/dwellings.py, the tested helpers): a roof is a union of planar pieces (gable/hip/mono/flat),
cut against each other so ridges, hips and valleys lie on true plane intersections; each wall follows the roof underside
exactly (gable triangles close up) and has real window and door recesses. Asset frame: local x along the compass
bearing yaw (math angle th), y to its left, z up from the lowest ground under the footprint.
model.py calls register_materials() and build(add, new, ev).
"""
import math

import numpy as np
from mathutils import Matrix, Vector

import props_kit as kit

# only materials this module defines (model.py zeroes their specular: sRGB-lit matt, no mirror on tiles and sheets)
MATTE = {"bge_tile_orange", "bge_tile_aged", "bge_tile_brown", "bge_roof_charcoal", "bge_roof_pale", "bge_wall_white",
         "bge_wall_yellow", "bge_wall_black", "bge_wall_plaster", "bge_felt_flat", "bge_roof_dark_sheet", "bge_chimney",
         "bge_frame_white", "bge_deck", "bge_roof_red_sheet", "bge_glasshouse", "bge_wall_blue", "bge_felt_pale"}
EPS = 1e-6
THICK = 0.11       # roof slab thickness (fascia height)
OVH_E, OVH_G = 0.45, 0.35   # eave and gable (rake) overhang, from the lidar roof extents (roof returns end ~0.4 m past the wall)
SINK = -0.6        # foundation bottom under the lowest ground


def register_materials():
    M = kit.MATERIALS
    # ortho 2025 sunlit tile reads (195,140,125) washed by haze; clay tile albedo of the farm road house (164,80,56) matches
    # the same ortho/lidar pipeline, so the new tile is a notch brighter for the new builds and the cabins
    M["bge_tile_orange"] = ("pantile:186,96,66", (2.0, 2.0), None, 0.2, 0.0)
    M["bge_tile_aged"] = ("pantile:162,100,78", (2.0, 2.0), None, 0.18, 0.0)        # weathered tile (318, 303's older half)
    M["bge_tile_brown"] = ("pantile:140,92,74", (2.0, 2.0), None, 0.15, 0.0)       # dark brown tile (321, 322, 323)
    M["bge_roof_charcoal"] = ("seam:84,91,102:0.52:2.08:0", (2.08, 2.08), None, 0.3, 0.2)   # ortho (99,105,118) blue-grey sheet
    M["bge_roof_dark_sheet"] = ("seam:62,67,76:0.52:2.08:0", (2.08, 2.08), None, 0.3, 0.2)
    M["bge_roof_pale"] = ("seam:174,176,178:0.076:2.0:1", (2.0, 2.0), None, 0.12, 0.1)      # pale corrugated sheet, below the white clip
    M["bge_roof_red_sheet"] = ("seam:150,70,56:0.076:2.0:1", (2.0, 2.0), None, 0.12, 0.1)
    M["bge_felt_flat"] = (None, (1, 1), (92, 94, 96), 0.1, 0.0)
    M["bge_wall_white"] = ("boards:172,170,162:v:0.16:2.0:2", (2.0, 2.0), None, 0.1, 0.0)
    M["bge_wall_yellow"] = ("boards:196,176,118:h:0.14:1.0:0", (1.0, 1.0), None, 0.1, 0.0)
    M["bge_wall_black"] = ("boards:40,38,38:v:0.18:2.0:2", (2.0, 2.0), None, 0.1, 0.0)
    M["bge_wall_plaster"] = ("plaster:176,172,164", (2.0, 2.0), None, 0.1, 0.0)
    M["bge_chimney"] = ("plaster:110,98,92", (2.0, 2.0), None, 0.1, 0.0)
    M["bge_frame_white"] = (None, (1, 1), (174, 174, 168), 0.15, 0.0)
    M["bge_deck"] = (None, (1, 1), (112, 100, 88), 0.1, 0.0)
    M["bge_glasshouse"] = (None, (1, 1), (92, 112, 118), 0.7, 0.0)               # greenhouse glass over dark benches, blue-grey in the ortho
    M["bge_wall_blue"] = (None, (1, 1), (52, 104, 172), 0.2, 0.0)
    M["bge_felt_pale"] = (None, (1, 1), (150, 150, 146), 0.1, 0.0)


# ---------------------------------------------------------------------------------------------
# 2D helpers
# ---------------------------------------------------------------------------------------------
def area(p):
    return 0.5 * sum(a[0] * b[1] - b[0] * a[1] for a, b in zip(p, p[1:] + p[:1]))


def clip_hp(poly, a, b, c):
    """Part of `poly` with a*x + b*y + c >= 0."""
    out = []
    for i, p in enumerate(poly):
        q = poly[(i + 1) % len(poly)]
        fp, fq = a * p[0] + b * p[1] + c, a * q[0] + b * q[1] + c
        if fp >= 0:
            out.append(p)
        if (fp >= 0) != (fq >= 0):
            t = fp / (fp - fq)
            out.append((p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])))
    return out


def subtract(polys, hps):
    """polys minus the convex region {all hp >= 0}."""
    res = []
    for P in polys:
        rest = P
        for a, b, c in hps:
            out = clip_hp(rest, -a, -b, -c)
            if len(out) >= 3 and abs(area(out)) > 1e-5:
                res.append(out)
            rest = clip_hp(rest, a, b, c)
            if len(rest) < 3:
                break
    return res


def rect_hps(r):
    x0, x1, y0, y1 = r
    return [(1, 0, -x0), (-1, 0, x1), (0, 1, -y0), (0, -1, y1)]


def in_rect(r, x, y, e=1e-6):
    return r[0] - e <= x <= r[1] + e and r[2] - e <= y <= r[3] + e


def pt_in_poly(poly, x, y):
    c = False
    for i, p in enumerate(poly):
        q = poly[(i + 1) % len(poly)]
        if (p[1] > y) != (q[1] > y) and x < p[0] + (y - p[1]) / (q[1] - p[1]) * (q[0] - p[0]):
            c = not c
    return c


def offset_poly(poly, d):
    """CCW polygon grown by d (mitred)."""
    n = len(poly)
    lines = []
    for i in range(n):
        a, b = poly[i], poly[(i + 1) % n]
        L = math.hypot(b[0] - a[0], b[1] - a[1])
        ux, uy = (b[0] - a[0]) / L, (b[1] - a[1]) / L
        lines.append(((a[0] + uy * d, a[1] - ux * d), (ux, uy)))
    out = []
    for i in range(n):
        (p, u), (q, v) = lines[i - 1], lines[i]
        den = u[0] * v[1] - u[1] * v[0]
        t = ((q[0] - p[0]) * v[1] - (q[1] - p[1]) * v[0]) / den
        out.append((p[0] + u[0] * t, p[1] + u[1] * t))
    return out


def quad_n(g, pts, nrm, mat):
    """Polygon facing `nrm`: the order is fixed from its normal, so no winding to get wrong."""
    P = [Vector(p) for p in pts]
    nn = (P[1] - P[0]).cross(P[2] - P[1])
    g.poly([tuple(p) for p in (P if nn.dot(Vector(nrm)) > 0 else P[::-1])], mat)


# ---------------------------------------------------------------------------------------------
# Roofs: a union of pieces; each piece is the lower envelope (min) of its planes inside a rectangle
# ---------------------------------------------------------------------------------------------
def gable_x(y0, z0, pl, pr, wx0, wx1, wy0, wy1, oe=OVH_E, og=OVH_G, **kw):
    """Level ridge along x at y=y0 (height z0); slope pl falls towards -y, pr towards +y; walls rectangle wx0..wx1 x wy0..wy1."""
    d = dict(planes=[(0, pl, z0 - pl * y0), (0, -pr, z0 + pr * y0)], wrect=(wx0, wx1, wy0, wy1),
             rect=(wx0 - og, wx1 + og, wy0 - oe, wy1 + oe))
    d.update(kw)
    return d


def gable_y(x0, z0, pl, pr, wx0, wx1, wy0, wy1, oe=OVH_E, og=OVH_G, **kw):
    """Level ridge along y at x=x0; slope pl falls towards -x, pr towards +x. oe is the eave overhang (here along x)."""
    d = dict(planes=[(pl, 0, z0 - pl * x0), (-pr, 0, z0 + pr * x0)], wrect=(wx0, wx1, wy0, wy1),
             rect=(wx0 - oe, wx1 + oe, wy0 - og, wy1 + og))
    d.update(kw)
    return d


def hip(wx0, wx1, wy0, wy1, ze, p, ovh=OVH_E, **kw):
    """Hip roof: pitch p from every wall, eave height ze at the walls (min of the four planes)."""
    d = dict(planes=[(p, 0, ze - p * wx0), (-p, 0, ze + p * wx1), (0, p, ze - p * wy0), (0, -p, ze + p * wy1)],
             wrect=(wx0, wx1, wy0, wy1), rect=(wx0 - ovh, wx1 + ovh, wy0 - ovh, wy1 + ovh))
    d.update(kw)
    return d


def mono_y(z_at, slope_y, wx0, wx1, wy0, wy1, ovh=OVH_E, og=OVH_G, **kw):
    """One plane z = z_at + slope_y * (y - wy0)."""
    d = dict(planes=[(0, slope_y, z_at - slope_y * wy0)], wrect=(wx0, wx1, wy0, wy1),
             rect=(wx0 - og, wx1 + og, wy0 - ovh, wy1 + ovh))
    d.update(kw)
    return d


def flat(z, wx0, wx1, wy0, wy1, ovh=0.12, **kw):
    d = dict(planes=[(0, 0, z)], wrect=(wx0, wx1, wy0, wy1), rect=(wx0 - ovh, wx1 + ovh, wy0 - ovh, wy1 + ovh))
    d.update(kw)
    return d


class Roofs:
    def __init__(self, pieces):
        self.pieces = pieces
        self.polys = self._visible()
        self._tjunctions()

    @staticmethod
    def _z(P, x, y):
        return min(a * x + b * y + c for a, b, c in P["planes"])

    def z(self, x, y, wall=False):
        best = None
        for P in self.pieces:
            if in_rect(P["wrect"] if wall else P["rect"], x, y):
                z = self._z(P, x, y)
                if best is None or z > best:
                    best = z
        return best

    def _visible(self):
        out = []
        for i, P in enumerate(self.pieces):
            for k, pl in enumerate(P["planes"]):
                x0, x1, y0, y1 = P["rect"]
                poly = [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]
                for m, q in enumerate(P["planes"]):
                    if m != k:
                        poly = clip_hp(poly, q[0] - pl[0], q[1] - pl[1], q[2] - pl[2])
                    if len(poly) < 3:
                        break
                if len(poly) < 3:
                    continue
                polys = [poly]
                for j, Q in enumerate(self.pieces):
                    if j == i:
                        continue
                    # only the wall footprint of Q hides roof below it: an overhang beyond the walls floats over the lower roof
                    hps = rect_hps(Q["wrect"]) + [(q[0] - pl[0], q[1] - pl[1], q[2] - pl[2]) for q in Q["planes"]]
                    polys = subtract(polys, hps)
                for p in polys:
                    if abs(area(p)) > 1e-4:
                        if area(p) < 0:
                            p = p[::-1]
                        out.append(dict(poly=p, plane=pl, piece=i, mat=P.get("mat")))
        return out

    def _tjunctions(self):
        """Insert vertices of neighbouring polygons that lie on an edge (no pinholes between roof planes)."""
        pts = [v for r in self.polys for v in r["poly"]]
        for r in self.polys:
            p, new = r["poly"], []
            for i, a in enumerate(p):
                b = p[(i + 1) % len(p)]
                new.append(a)
                L = math.hypot(b[0] - a[0], b[1] - a[1])
                if L < 1e-6:
                    continue
                ins = []
                for q in pts:
                    t = ((q[0] - a[0]) * (b[0] - a[0]) + (q[1] - a[1]) * (b[1] - a[1])) / (L * L)
                    if 1e-4 < t < 1 - 1e-4 and abs((q[0] - a[0]) * (b[1] - a[1]) - (q[1] - a[1]) * (b[0] - a[0])) / L < 1e-5:
                        ins.append((t, q))
                new += [q for _, q in sorted(ins)]
            r["poly"] = new

    def build(self, g, top, under, edge, cap, ridge_w=0.2):
        """Top planes, undersides, fascia (boundary edges), ridge/hip caps; returns gutter edges [(a, b, z, nx, ny)]."""
        gutters, caps, seen = [], [], set()
        for r in self.polys:
            pl, poly = r["plane"], r["poly"]
            mat = r["mat"] or top
            P3 = [(x, y, pl[0] * x + pl[1] * y + pl[2]) for x, y in poly]
            g.poly(P3, mat)
            g.poly([(x, y, z - THICK) for x, y, z in reversed(P3)], under)
            n = len(poly)
            for i in range(n):
                a, b = P3[i], P3[(i + 1) % n]
                L = math.hypot(b[0] - a[0], b[1] - a[1])
                if L < 1e-4:
                    continue
                ox, oy = (b[1] - a[1]) / L, -(b[0] - a[0]) / L          # outward (CCW polygon)
                mx, my = (a[0] + b[0]) / 2, (a[1] + b[1]) / 2
                pz = self.z(mx + ox * 0.03, my + oy * 0.03)
                if pz is None or pz < (a[2] + b[2]) / 2 - 0.25:          # free edge: nothing at the same level beyond it
                    g.poly([(a[0], a[1], a[2] - THICK), (b[0], b[1], b[2] - THICK), b, a], edge)
                    if abs(a[2] - b[2]) < 1e-3:
                        gutters.append((a, b, a[2], ox, oy))
                else:
                    key = tuple(sorted([(round(a[0], 3), round(a[1], 3), round(a[2], 3)), (round(b[0], 3), round(b[1], 3), round(b[2], 3))]))
                    if key in seen:
                        continue
                    seen.add(key)
                    # ridge/hip: both sides fall away from the edge; valley: both rise
                    zc = (a[2] + b[2]) / 2
                    zl = self.z(mx + ox * 0.15, my + oy * 0.15)
                    zr = self.z(mx - ox * 0.15, my - oy * 0.15)
                    if zl is not None and zr is not None and zl < zc - 0.03 and zr < zc - 0.03:
                        caps.append((a, b))
        for a, b in caps:
            g.beam((a[0], a[1], a[2] + 0.03), (b[0], b[1], b[2] + 0.03), ridge_w, 0.06, cap)
        return gutters


# ---------------------------------------------------------------------------------------------
# Walls with real openings
# ---------------------------------------------------------------------------------------------
def segs_of(prof):
    """[(t, z), ...] with vertical steps (equal t) -> non-vertical segments."""
    return [(a[0], a[1], b[0], b[1]) for a, b in zip(prof, prof[1:]) if b[0] - a[0] > 1e-6]


def lin(segs, ta, tb):
    for t0, z0, t1, z1 in segs:
        if t0 - 1e-6 <= ta and tb <= t1 + 1e-6:
            f = lambda t: z0 + (z1 - z0) * (t - t0) / (t1 - t0)
            return f(ta), f(tb)
    raise ValueError("no profile segment for %s..%s" % (ta, tb))


def simplify(prof):
    out = []
    for p in prof:
        if out and abs(out[-1][0] - p[0]) < 1e-9 and abs(out[-1][1] - p[1]) < 1e-9:
            continue
        out.append(p)
        while len(out) >= 3:
            a, b, c = out[-3:]
            if abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) < 1e-7 and a[0] <= b[0] <= c[0]:
                del out[-2]
            else:
                break
    return out


def wall_profile(roofs, a, b, embed=0.05):
    """Top of a wall along a->b: the roof underside, with vertical steps where pieces change."""
    L = math.hypot(b[0] - a[0], b[1] - a[1])
    ux, uy = (b[0] - a[0]) / L, (b[1] - a[1]) / L
    cand = {0.0, L}
    for P in roofs.pieces:
        x0, x1, y0, y1 = P["wrect"]
        for c in (x0, x1):
            if abs(ux) > 0.5:
                cand.add((c - a[0]) / ux)
        for c in (y0, y1):
            if abs(uy) > 0.5:
                cand.add((c - a[1]) / uy)
    planes = [pl for P in roofs.pieces for pl in P["planes"]]
    lines = [(pl[0] * ux + pl[1] * uy, pl[0] * a[0] + pl[1] * a[1] + pl[2]) for pl in planes]
    for i in range(len(lines)):
        for j in range(i + 1, len(lines)):
            if abs(lines[i][0] - lines[j][0]) > 1e-9:
                cand.add((lines[j][1] - lines[i][1]) / (lines[i][0] - lines[j][0]))
    T = sorted(t for t in cand if -1e-9 <= t <= L + 1e-9)
    d = 2e-6
    prof = []
    for t in T:
        for tt in (max(t - d, 0.0), min(t + d, L)):
            z = roofs.z(a[0] + ux * tt, a[1] + uy * tt, wall=True)
            if z is None:
                z = roofs.z(a[0] + ux * tt, a[1] + uy * tt)
            if z is not None:
                prof.append((t, z - embed))
    return simplify(prof)


class Wall:
    def __init__(self, a, b, roofs, mat, zb, bottom=None, openings=(), embed=0.05, top=None):
        self.a, self.b = Vector((a[0], a[1], 0)), Vector((b[0], b[1], 0))
        self.L = math.hypot(b[0] - a[0], b[1] - a[1])         # double precision: Vector.length is float32 and misses the profile end
        self.u = (self.b - self.a) / self.L
        self.n = Vector((self.u.y, -self.u.x, 0))
        self.mat = mat
        self.top = top or wall_profile(roofs, a, b, embed)
        self.bottom = bottom or [(0.0, zb), (self.L, zb)]
        self.openings = list(openings)

    def P(self, t, z, d=0.0):
        return (self.a.x + self.u.x * t + self.n.x * d, self.a.y + self.u.y * t + self.n.y * d, z)

    def top_at(self, t):
        for t0, z0, t1, z1 in segs_of(self.top):
            if t0 - 1e-6 <= t <= t1 + 1e-6:
                return z0 + (z1 - z0) * (t - t0) / (t1 - t0)
        return None

    def build(self, g):
        top, bot = segs_of(self.top), segs_of(self.bottom)
        ops = sorted(self.openings, key=lambda o: o["t"])
        T = {0.0, self.L}
        for s in top + bot:
            T.update((s[0], s[2]))
        zs = {}
        for o in ops:
            o["t0"], o["t1"] = o["t"] - o["w"] / 2, o["t"] + o["w"] / 2
            T.update((o["t0"], o["t1"]))
            for tt in (o["t0"], o["t1"]):
                zs.setdefault(round(tt, 6), set()).update((o["sill"], o["sill"] + o["h"]))
        T = sorted(T)
        for ta, tb in zip(T, T[1:]):
            if tb - ta < 1e-6:
                continue
            try:
                ba, bb = lin(bot, ta, tb)
                ya, yb = lin(top, ta, tb)
            except ValueError:
                print("PROFILE", self.a, self.b, "top", top, "bot", bot)
                raise
            yb = max(yb, bb)
            ya = max(ya, ba)
            here = sorted((o for o in ops if o["t0"] - 1e-6 <= ta and tb <= o["t1"] + 1e-6), key=lambda o: o["sill"])
            if not here:
                pts = [(ta, ba)]
                pts.append((tb, bb))
                pts += [(tb, z) for z in sorted(zs.get(round(tb, 6), ())) if bb + 1e-4 < z < yb - 1e-4]
                pts.append((tb, yb))
                pts.append((ta, ya))
                pts += [(ta, z) for z in sorted(zs.get(round(ta, 6), ()), reverse=True) if ba + 1e-4 < z < ya - 1e-4]
                if abs(ya - ba) < 1e-4 and abs(yb - bb) < 1e-4:
                    continue
                g.poly([self.P(t, z) for t, z in pts], self.mat)
            else:
                # solid bands between the stacked openings of this interval (bottom band follows the bottom profile)
                lo_a, lo_b = ba, bb
                for o in here:
                    sill, head = o["sill"], o["sill"] + o["h"]
                    if sill > lo_a + 1e-4 or sill > lo_b + 1e-4:
                        g.poly([self.P(ta, lo_a), self.P(tb, lo_b), self.P(tb, max(sill, lo_b)), self.P(ta, max(sill, lo_a))], self.mat)
                    lo_a = lo_b = head
                if head < ya - 1e-4 or head < yb - 1e-4:
                    g.poly([self.P(ta, head), self.P(tb, head), self.P(tb, max(yb, head)), self.P(ta, max(ya, head))], self.mat)
                if min(ya, yb) < head + 0.03:
                    print("WARNING opening head %.2f meets the roof (%.2f) on wall %s" % (head, min(ya, yb), self.a))
        for o in ops:
            self.opening(g, o)

    def frame(self, t):
        u, n = self.u, self.n
        return Matrix(((u.x, 0, n.x, self.a.x + u.x * t), (u.y, 0, n.y, self.a.y + u.y * t), (0, 1, 0, 0), (0, 0, 0, 1)))

    def opening(self, g, o):
        """Recess with white reveals, dark glass (or the door leaf) set back, a thin sash frame with glazing bars, a flat
        casing and a sill: ~40 triangles, the cheapest form that still reads as a real window at 30 m."""
        kind = o.get("kind", "window")
        w, h, sill = o["w"], o["h"], o["sill"]
        d, T, fw, cw = 0.11, "bge_frame_white", 0.06, 0.1
        hw = w / 2
        g.push(self.frame(o["t"]))
        for sx, nx in ((-1, 1), (1, -1)):
            quad_n(g, [(sx * hw, sill, 0), (sx * hw, sill + h, 0), (sx * hw, sill + h, -d), (sx * hw, sill, -d)], (nx, 0, 0), T)
        quad_n(g, [(-hw, sill + h, 0), (hw, sill + h, 0), (hw, sill + h, -d), (-hw, sill + h, -d)], (0, -1, 0), T)
        zf = -d + 0.03
        if kind == "gate":                       # sliding/barn gate: a plain leaf, planks in the texture, a rail above it
            quad_n(g, [(-hw, sill, zf), (hw, sill, zf), (hw, sill + h, zf), (-hw, sill + h, zf)], (0, 0, 1), o.get("mat", "door_black"))
            if (self.top_at(o["t"]) or 0) - (sill + h) > 0.4:
                g.box((0, sill + h + 0.15, 0.05), (w + 0.5, 0.1, 0.1), "black_steel", skip=("bottom",))
            g.pop()
            return
        if kind == "door":
            quad_n(g, [(-hw, sill, zf), (hw, sill, zf), (hw, sill + h, zf), (-hw, sill + h, zf)], (0, 0, 1), o.get("mat", "door_white"))
            gl = hw - 0.15                      # glazed upper light
            quad_n(g, [(-gl, sill + h * 0.5, zf + 0.012), (gl, sill + h * 0.5, zf + 0.012), (gl, sill + h - 0.2, zf + 0.012),
                       (-gl, sill + h - 0.2, zf + 0.012)], (0, 0, 1), "window_dark")
        else:
            quad_n(g, [(-hw, sill, zf), (hw, sill, zf), (hw, sill + h, zf), (-hw, sill + h, zf)], (0, 0, 1), "window_dark")
            cols, rows = o.get("bars", (2, 2))
            zb = zf + 0.012
            for x0, x1, y0, y1 in ((-hw, -hw + fw, sill, sill + h), (hw - fw, hw, sill, sill + h), (-hw + fw, hw - fw, sill, sill + fw),
                                   (-hw + fw, hw - fw, sill + h - fw, sill + h)):
                quad_n(g, [(x0, y0, zb), (x1, y0, zb), (x1, y1, zb), (x0, y1, zb)], (0, 0, 1), T)
            for i in range(1, cols):
                x = -hw + w * i / cols
                quad_n(g, [(x - 0.015, sill + fw, zb), (x + 0.015, sill + fw, zb), (x + 0.015, sill + h - fw, zb), (x - 0.015, sill + h - fw, zb)], (0, 0, 1), T)
            for j in range(1, rows):
                y = sill + h * j / rows
                quad_n(g, [(-hw + fw, y - 0.015, zb), (hw - fw, y - 0.015, zb), (hw - fw, y + 0.015, zb), (-hw + fw, y + 0.015, zb)], (0, 0, 1), T)
        zc = 0.03                                # casing: flat boards just proud of the wall
        top = sill + h
        quad_n(g, [(-hw - cw, sill, zc), (-hw, sill, zc), (-hw, top, zc), (-hw - cw, top, zc)], (0, 0, 1), T)
        quad_n(g, [(hw, sill, zc), (hw + cw, sill, zc), (hw + cw, top, zc), (hw, top, zc)], (0, 0, 1), T)
        quad_n(g, [(-hw - cw, top, zc), (hw + cw, top, zc), (hw + cw, top + cw, zc), (-hw - cw, top + cw, zc)], (0, 0, 1), T)
        if kind != "door":
            g.box((0, sill - 0.03, 0.05), (w + 2 * cw + 0.04, 0.05, 0.1), T, skip=("bottom",))
        g.pop()


# ---------------------------------------------------------------------------------------------
# Walls' surroundings: plinth, corner boards, steps, rainwater goods, chimneys
# ---------------------------------------------------------------------------------------------
def convex_corners(poly):
    n = len(poly)
    out = []
    for i in range(n):
        a, b, c = poly[i - 1], poly[i], poly[(i + 1) % n]
        cr = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0])
        out.append(cr > 0)
    return out


def edge_normal(a, b):
    L = math.hypot(b[0] - a[0], b[1] - a[1])
    return ((b[1] - a[1]) / L, -(b[0] - a[0]) / L)


def corner_boards(g, roofs, outline, zf, mat="bge_frame_white", w=0.13, e=0.03):
    """White pilasters on the convex corners, from the plinth to under the eave (two boards, one per wall)."""
    cv = convex_corners(outline)
    n = len(outline)
    for i, v in enumerate(outline):
        if not cv[i]:
            continue
        pa, pb = outline[i - 1], outline[(i + 1) % n]
        nA, nB = edge_normal(pa, v), edge_normal(v, pb)
        LA, LB = math.hypot(v[0] - pa[0], v[1] - pa[1]), math.hypot(pb[0] - v[0], pb[1] - v[1])
        uA, uB = ((v[0] - pa[0]) / LA, (v[1] - pa[1]) / LA), ((pb[0] - v[0]) / LB, (pb[1] - v[1]) / LB)
        z = roofs.z(v[0] - 0.02 * (nA[0] + nB[0]), v[1] - 0.02 * (nA[1] + nB[1]), wall=True) - 0.08
        h = z - zf
        for (s0, s1, u, nn) in ((-w, e, uA, nA), (0.0, w, uB, nB)):
            c = [(v[0] + u[0] * s + nn[0] * r, v[1] + u[1] * s + nn[1] * r) for s in (s0, s1) for r in (0.0, e)]
            xs, ys = [p[0] for p in c], [p[1] for p in c]
            g.box(((min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2, zf + h / 2), (max(xs) - min(xs), max(ys) - min(ys), h), mat,
                  skip=("bottom",))


def plinth(g, outline, zf, mat="granite_plinth", d=0.04):
    off = offset_poly(outline, d)
    n = len(outline)
    for i in range(n):
        a, b = off[i], off[(i + 1) % n]
        g.poly([(a[0], a[1], SINK), (b[0], b[1], SINK), (b[0], b[1], zf), (a[0], a[1], zf)], mat)
        p, q = outline[i], outline[(i + 1) % n]
        g.poly([(a[0], a[1], zf), (b[0], b[1], zf), (q[0], q[1], zf), (p[0], p[1], zf)], "granite_dark")


def stair(g, cx, cy, n, width, z_top, z_bot, tread=0.32, mat="concrete", side="granite_plinth"):
    """Steps leaving a wall at (cx, cy) along the outward normal n; the top tread joins the doorstep, each block runs down
    into the ground (SINK) so none floats."""
    rise_n = max(1, int(math.ceil((z_top - z_bot) / 0.18 - 1e-6)))
    rise = (z_top - z_bot) / rise_n
    ang = math.degrees(math.atan2(n[1], n[0]))
    for i in range(rise_n):
        zt = z_top - i * rise
        depth = (i + 1) * tread
        c = (cx + n[0] * depth / 2, cy + n[1] * depth / 2)
        g.box((c[0], c[1], (zt + SINK) / 2), (depth, width, zt - SINK), side, rz=ang, mats={"top": mat})


def gutter_run(g, a, b, z, ox, oy, mat="black_steel", r=0.07):
    """Half-round gutter hung on the fascia along a->b (outward normal ox, oy)."""
    n = 5
    zc = z - 0.1
    L = math.hypot(b[0] - a[0], b[1] - a[1])
    ux, uy = (b[0] - a[0]) / L, (b[1] - a[1]) / L
    prof = [(0.05 + r + r * math.cos(math.pi + math.pi * k / (n - 1)), zc + r * math.sin(math.pi + math.pi * k / (n - 1))) for k in range(n)]

    def P(t, o, z):
        return (a[0] + ux * t + ox * o, a[1] + uy * t + oy * o, z)
    for k in range(n - 1):
        (oa, za), (ob, zb) = prof[k], prof[k + 1]
        q = [P(0, oa, za), P(L, oa, za), P(L, ob, zb), P(0, ob, zb)]
        g.poly(q[::-1], mat)
        g.poly(q, mat)
    for t in (0, L):
        g.poly([P(t, o, zz) for o, zz in prof], mat)
        g.poly([P(t, o, zz) for o, zz in reversed(prof)], mat)


def downpipe(g, x, y, ox, oy, z_gutter, z_ground, mat="black_steel", r=0.045):
    """Pipe from the gutter at (x, y) (hung 0.12 out) straight down the wall to a shoe above the ground."""
    top = (x + ox * 0.12, y + oy * 0.12, z_gutter - 0.18)
    wp = (x + ox * 0.06, y + oy * 0.06)
    g.pipe(top, (wp[0], wp[1], top[2] - 0.3), r, mat, seg=6)
    g.pipe((wp[0], wp[1], top[2] - 0.3), (wp[0], wp[1], z_ground + 0.3), r, mat, seg=6)
    g.pipe((wp[0], wp[1], z_ground + 0.3), (wp[0] + ox * 0.2, wp[1] + oy * 0.2, z_ground + 0.04), r, mat, seg=6)


def chimney(g, x, y, z_base, z_top, sx=0.7, sy=0.7, mat="bge_chimney"):
    g.box((x, y, (z_base + z_top) / 2), (sx, sy, z_top - z_base), mat, skip=("bottom",))
    g.box((x, y, z_top + 0.04), (sx + 0.14, sy + 0.14, 0.08), "granite_dark", skip=("bottom",))
    g.cylinder((x, y, z_top + 0.08), 0.12, 0.22, "black_steel", seg=6, r_top=0.1)


def merge_gutters(gutters):
    """Join collinear runs at the same level (the roof planes of a piece split along a ridge-parallel eave)."""
    runs = [[list(a[:2]), list(b[:2]), z, round(ox), round(oy)] for a, b, z, ox, oy in gutters]
    changed = True
    while changed:
        changed = False
        for i, r in enumerate(runs):
            for j, q in enumerate(runs):
                if i != j and r[3:] == q[3:] and abs(r[2] - q[2]) < 0.02 and math.dist(r[1], q[0]) < 1e-3:
                    r[1] = q[1]
                    del runs[j]
                    changed = True
                    break
            if changed:
                break
    return [(r[0], r[1], r[2], r[3], r[4]) for r in runs if math.dist(r[0], r[1]) > 0.9]


def solar_array(g, plane, cx, cy, w, h, ang_deg=0.0, lift=0.05, mat="solar_panel"):
    """Flush panel field on a roof plane z = A x + B y + C, centred (cx, cy), w along the local x', h up the slope y'."""
    A, B, C = plane
    c = math.cos(math.radians(ang_deg))
    s = math.sin(math.radians(ang_deg))
    ex = Vector((c, s, A * c + B * s)).normalized()
    ey_h = (-s, c)
    ey = Vector((ey_h[0], ey_h[1], A * ey_h[0] + B * ey_h[1])).normalized()
    ctr = Vector((cx, cy, A * cx + B * cy + C))
    pts = [ctr + ex * sx * w / 2 + ey * sy * h / 2 for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
    up = Vector((0, 0, lift))
    quad_n(g, [tuple(p + up) for p in pts], (0, 0, 1), mat)
    for p, q in zip(pts, pts[1:] + pts[:1]):            # the 3 cm aluminium edge
        g.beam(tuple(p + up * 0.9), tuple(q + up * 0.9), 0.04, 0.05, "galvanised")


def union_outline(rects):
    """CCW outline of the union of axis-aligned rectangles (x0, x1, y0, y1): cells of the compressed grid, boundary edges
    chained, collinear points merged. Returns the largest polygon."""
    xs = sorted({r[0] for r in rects} | {r[1] for r in rects})
    ys = sorted({r[2] for r in rects} | {r[3] for r in rects})
    inside = {}
    for i in range(len(xs) - 1):
        for j in range(len(ys) - 1):
            cx, cy = (xs[i] + xs[i + 1]) / 2, (ys[j] + ys[j + 1]) / 2
            inside[i, j] = any(r[0] < cx < r[1] and r[2] < cy < r[3] for r in rects)
    edges = {}
    for (i, j), v in inside.items():
        if not v:
            continue
        x0, x1, y0, y1 = xs[i], xs[i + 1], ys[j], ys[j + 1]
        if not inside.get((i, j - 1)):
            edges[(x0, y0)] = (x1, y0)
        if not inside.get((i + 1, j)):
            edges[(x1, y0)] = (x1, y1)
        if not inside.get((i, j + 1)):
            edges[(x1, y1)] = (x0, y1)
        if not inside.get((i - 1, j)):
            edges[(x0, y1)] = (x0, y0)
    polys = []
    while edges:
        start = next(iter(edges))
        p, cur = [start], edges.pop(start)
        while cur != start:
            p.append(cur)
            cur = edges.pop(cur)
        out = []
        for k, q in enumerate(p):                 # drop collinear points
            a, b = p[k - 1], p[(k + 1) % len(p)]
            if abs((q[0] - a[0]) * (b[1] - q[1]) - (q[1] - a[1]) * (b[0] - q[0])) > 1e-9:
                out.append(q)
        polys.append(out)
    return max(polys, key=lambda q: abs(area(q)))


# ---------------------------------------------------------------------------------------------
# One building
# ---------------------------------------------------------------------------------------------
def win(t, w=0.9, h=1.2, sill=None, **k):
    d = dict(t=t, w=w, h=h, sill=sill, kind="window")
    d.update(k)
    return d


def door(t, w=0.95, h=2.05, **k):
    d = dict(t=t, w=w, h=h, sill=None, kind="door")
    d.update(k)
    return d


def gate(t, w=3.2, h=3.0, **k):
    k.setdefault("mat", "door_black")
    return door(t, w, h, kind="gate", steps=False, **k)


class Site:
    """Per-building context: frame in EPSG:3006, lowest ground, floor level, terrain relative to the placement ground."""

    def __init__(self, ev, e0, n0, th_deg, outline, pad=0.6, floor=None, floor_off=None):
        self.ev, self.e0, self.n0, self.th = ev, e0, n0, math.radians(th_deg)
        self.c, self.s = math.cos(self.th), math.sin(self.th)
        xs = [p[0] for p in outline]
        ys = [p[1] for p in outline]
        zs = []
        # lowest course terrain under (and just around) the footprint: the plinth has to reach it
        for x in np.arange(min(xs) - pad, max(xs) + pad + 0.01, 0.5):
            for y in np.arange(min(ys) - pad, max(ys) + pad + 0.01, 0.5):
                if pt_in_poly(outline, x, y) or any(math.dist((x, y), p) < pad for p in outline):
                    zs.append(self.terrain_abs(x, y))
        self.zmin, self.zmax = min(zs), max(zs)
        self.ground = round(self.zmin, 3)
        # floor: above the middle of the slope, so the high side is buried a few cm and the low side shows a taller plinth
        self.zf = min(self.zmin + 0.35 + 0.25 * (self.zmax - self.zmin), self.zmax + 0.2)
        self.zf -= self.ground
        if floor is not None:
            self.zf = floor - self.ground
        elif floor_off is not None:
            self.zf = floor_off

    def world(self, x, y):
        return self.e0 + x * self.c - y * self.s, self.n0 + x * self.s + y * self.c

    def terrain_abs(self, x, y):
        return self.ev.terrain(*self.world(x, y))

    def tg(self, x, y):
        return self.terrain_abs(x, y) - self.ground

    @property
    def yaw(self):
        return (90 - math.degrees(self.th)) % 360


def auto_windows(wall, zf, taken, pitch=2.6, w=0.9, h=1.2, sill=0.95, margin=1.1, bars=(2, 2), upper=None):
    """Ground-floor windows spread along a wall (spacing ~pitch), clear of the doors and of anything under the roof edge."""
    out = []
    L = wall.L
    n = max(1, int(round((L - 2 * margin) / pitch)) + 1) if L > 2 * margin + 0.1 else 0
    ts = [L / 2] if n == 1 else [margin + (L - 2 * margin) * i / (n - 1) for i in range(n)]
    for t in ts:
        if any(abs(t - d) < (w + dw) / 2 + 0.5 for d, dw in taken):
            continue
        t0, t1 = t - w / 2, t + w / 2
        ta, tb = wall.top_at(max(t0, 1e-3)), wall.top_at(min(t1, L - 1e-3))
        if ta is None or tb is None or min(ta, tb) < zf + sill + h + 0.3:
            continue
        out.append(win(t, w, h, zf + sill, bars=bars))
    return out


def assemble(g, site, B):
    """Walls, roof, trims and surroundings of one building from its spec B (see the BUILDINGS table)."""
    zf = site.zf
    roofs = Roofs(B["pieces"](site))
    O = B["outline"]
    n = len(O)
    wmat = B.get("wall", "falu_red_vertical")
    walls = [Wall(O[i], O[(i + 1) % n], roofs, wmat, zf) for i in range(n)]

    def seg_dist(p, a, b):
        L2 = (b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2
        t = max(0.0, min(1.0, ((p[0] - a[0]) * (b[0] - a[0]) + (p[1] - a[1]) * (b[1] - a[1])) / L2))
        return math.dist(p, (a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])))
    espec = {}
    for k, v in B.get("edges", {}).items():            # keys: an edge index, or an (x, y) point on/near the wanted edge
        if isinstance(k, tuple):
            k = min(range(n), key=lambda i: seg_dist(k, O[i], O[(i + 1) % n]))
        espec.setdefault(k, {}).update(v)
    for i, w in enumerate(walls):
        spec = espec.get(i, {})
        taken, ops = [], []
        for d in spec.get("doors", []):
            d = dict(d)
            d["sill"] = zf
            d.setdefault("mat", B.get("door", "door_white"))
            ops.append(d)
            taken.append((d["t"], d["w"]))
            ex = w.n
            c = (w.a.x + w.u.x * d["t"], w.a.y + w.u.y * d["t"])
            ztop = zf
            zb = site.tg(c[0] + ex.x * 0.9, c[1] + ex.y * 0.9)
            if d.get("steps", True):
                stair(g, c[0], c[1], (ex.x, ex.y), d["w"] + 0.5, ztop - 0.02, min(zb, ztop - 0.18))
        for o in spec.get("windows", []):
            o = dict(o)
            o["sill"] = zf + (o["sill"] if o["sill"] is not None else 0.95)
            ops.append(o)
            taken.append((o["t"], o["w"]))
        autos = spec.get("auto") or []
        for a in autos if isinstance(autos, list) else [autos]:
            ops += auto_windows(w, zf, taken, **a)
        for o in ops:        # never taller than the wall allows: head 0.15 under the roof underside
            top = min(w.top_at(max(o["t"] - o["w"] / 2, 1e-3)) or 9, w.top_at(min(o["t"] + o["w"] / 2, w.L - 1e-3)) or 9)
            if o["sill"] + o["h"] > top - 0.15:
                o["h"] = top - 0.15 - o["sill"]
                if o["h"] < (1.85 if o["kind"] != "window" else 0.6):
                    print("WARNING %s opening only %.2f m high on wall %d" % (B.get("name", "?"), o["h"], i))
        w.openings = ops
    for it in B.get("inner", []):
        # a gable wall standing on a lower roof (the cross body above a lean-to): its bottom follows the lower roof underside
        a, b = it["a"], it["b"]
        nx, ny = edge_normal(a, b)
        bot = wall_profile(roofs, (a[0] + nx * 0.01, a[1] + ny * 0.01), (b[0] + nx * 0.01, b[1] + ny * 0.01), embed=0.08)
        walls.append(Wall(a, b, roofs, wmat, zf, bottom=bot, openings=it.get("ops", [])))
    plinth(g, O, zf)
    if B.get("corners", True):
        corner_boards(g, roofs, O, zf)
    for w in walls:
        w.build(g)
    gut = merge_gutters(roofs.build(g, B["tile"], B.get("under", "bge_frame_white"), B.get("fascia", "bge_frame_white"), B.get("cap", B["tile"])))
    if B.get("gutters"):
        for a, b, z, ox, oy in gut:
            gutter_run(g, a, b, z, ox, oy)
            L = math.dist(a, b)
            ends = [0.12, L - 0.12] if L > 8 else [L - 0.12]
            for t in ends:
                x, y = a[0] + (b[0] - a[0]) / L * t, a[1] + (b[1] - a[1]) / L * t
                px, py = x - ox * (0.45 + 0.05), y - oy * (0.45 + 0.05)   # on the wall under the overhang
                if roofs.z(px - ox * 0.0, py - oy * 0.0, wall=True) is None:
                    continue
                downpipe(g, px, py, ox, oy, z, site.tg(x + ox * 0.2, y + oy * 0.2))
    chim = B.get("chimneys", [])
    for (x, y, zt, *sz) in (chim(site) if callable(chim) else chim):
        sx, sy = sz or (0.7, 0.7)
        # base under the lowest roof corner, so it never floats and the stack reads as coming through the roof
        zb = min(roofs.z(x + dx * sx / 2, y + dy * sy / 2) for dx in (-1, 1) for dy in (-1, 1)) - 0.3
        chimney(g, x, y, zb, zt, sx, sy)
    if B.get("extras"):
        B["extras"](g, site, roofs)
    return roofs


# ---------------------------------------------------------------------------------------------
# Specs from the lidar fits: roof extents (u, v in the OSM rectangle frame) -> walls inset by the overhang
# ---------------------------------------------------------------------------------------------
def fitted_gable(u0, u1, v0, v1, ridge_v, ridge_abs, pl, pr, oe=OVH_E, og=OVH_G):
    """Gable roof with a level ridge along u fitted to the lidar: roof returns span u0..u1 x v0..v1; returns (outline, pieces)."""
    x0, x1, y0, y1 = u0 + og, u1 - og, v0 + oe, v1 - oe
    outline = [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]

    def pieces(site):
        return [gable_x(ridge_v, ridge_abs - site.ground, pl, pr, x0, x1, y0, y1, oe, og)]
    return outline, pieces


def osm_frame(ev, osm):
    r = ev.osm[osm]["properties"]["rect"]
    return r["cx"], r["cy"], r["angleDeg"]


# ---------------------------------------------------------------------------------------------
# The buildings
# ---------------------------------------------------------------------------------------------
# Lidar plane fits per OSM rectangle frame (u along the long side, v to its left): roof returns span u0..u1 x v0..v1,
# ridge (level, along u) at v = rv, height rz (abs RH2000), slopes pl/pr (falling to -v/+v). From fit.py (2-slope LSQ, trees
# filtered by ortho green, rms 0.06-0.34 m).
CABIN_FIT = {   # (u0, u1, v0, v1, rv, rz, pl, pr)
    "1109741305": (-4.3, 4.4, -2.9, 2.6, 0.00, 125.08, 0.650, 0.703),
    "1109741306": (-4.0, 4.7, -2.6, 2.6, -0.20, 125.15, 0.723, 0.648),
    "1109741307": (-4.1, 4.4, -2.9, 2.6, -0.26, 125.23, 0.670, 0.681),
    "1109741308": (-4.0, 4.6, -3.2, 3.5, -0.62, 125.27, 0.724, 0.575),
    "1109741309": (-4.3, 4.2, -3.2, 2.4, -0.57, 125.38, 0.706, 0.681),
    "1109741310": (-3.9, 5.0, -3.5, 2.3, -0.55, 125.43, 0.664, 0.636),
}


def cabin(add, new, ev, osm, n):
    """One of the six identical cabins: 8.6 x 5.6 m roof (lidar), ridge 4.7 m over the ground, pitch ~0.67, falu red board.
    Walls are inset by the overhangs; the door and the window row face the track side (+v = SW)."""
    u0, u1, v0, v1, rv, rz, pl, pr = CABIN_FIT[osm]
    cx, cy, ang = osm_frame(ev, osm)
    # all six are the same cabin: symmetric roof of the measured width about the middle of the roof returns, mean pitch
    hw = min((v1 - v0) / 2, 2.85)
    vm = (v0 + v1) / 2 if osm != "1109741308" else rv           # 308's returns include a bush on the +v side
    ul, vl = (u0 + u1) / 2, vm
    th = math.radians(ang)
    e0, n0 = cx + ul * math.cos(th) - vl * math.sin(th), cy + ul * math.sin(th) + vl * math.cos(th)
    L = (u1 - u0) / 2
    p = 0.67
    outline, _ = fitted_gable(-L, L, -hw, hw, 0.0, rz, p, p)

    def pieces(site):
        return [gable_x(0.0, rz - site.ground, p, p, -L + OVH_G, L - OVH_G, -hw + OVH_E, hw - OVH_E)]
    wl = 2 * (L - OVH_G)
    B = dict(outline=outline, pieces=pieces, wall="falu_red_vertical", tile="bge_tile_orange",
             edges={2: dict(doors=[door(wl * 0.3)], auto=dict(pitch=2.4, w=0.9, h=1.2)),
                    0: dict(auto=dict(pitch=2.4, w=0.9, h=1.2)),
                    1: dict(windows=[win(hw - OVH_E, 0.7, 0.85, sill=2.7, bars=(2, 2))]),
                    3: dict(windows=[win(hw - OVH_E, 0.7, 0.85, sill=2.7, bars=(2, 2))])})
    site = Site(ev, e0, n0, ang, outline)
    g = new()
    assemble(g, site, B)
    add("omberg_bg_east_cabin_%d" % n, g, e0, n0, site.yaw, site.ground)


def lidar_house(add, new, ev, osm, aid, fit, wings=(), **B):
    """A gabled building from the lidar fit of its OSM rectangle (frame: rectangle centre, u along the long side).
    wings: extra volumes [dict(rect=(x0, x1, y0, y1), piece=callable(site) -> roof piece)] unioned into the outline."""
    u0, u1, v0, v1, rv, rz, pl, pr = fit
    cx, cy, ang = osm_frame(ev, osm)
    outline, pieces = fitted_gable(u0, u1, v0, v1, rv, rz, pl, pr)
    if wings:
        main = (outline[0][0], outline[1][0], outline[0][1], outline[2][1])
        outline = union_outline([main] + [w["rect"] for w in wings])
        base = pieces
        pieces = lambda site: base(site) + [w["piece"](site) for w in wings]
    B = dict(B, outline=outline, pieces=pieces, name=aid)
    site = Site(ev, cx, cy, ang, outline, floor_off=B.get("floor_off"))
    g = new()
    assemble(g, site, B)
    add(aid, g, cx, cy, site.yaw, site.ground)
    return g


def rect_outline(x0, x1, y0, y1):
    return [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]


def place(add, ev, aid, osm_or_frame, outline, B):
    """Frame: an OSM rectangle id (rectangle centre, its angle) or an explicit (e, n, math angle deg)."""
    e0, n0, ang = osm_frame(ev, osm_or_frame) if isinstance(osm_or_frame, str) else osm_or_frame
    site = Site(ev, e0, n0, ang, outline, floor=B.get("floor"))
    g = _new()
    assemble(g, site, dict(B, outline=outline))
    add(aid, g, e0, n0, site.yaw, site.ground)
    return site


_new = None


def long_hall(add, ev):
    """OSM 303: 36 x 15 m hall with an orange-tile gable roof (solar band and four arrays on the +v slope, lidar plane fit)
    and a low dark-sheet annex wrapping its west end and part of the south side (ortho: dark, lidar: 2.6-2.8 m, nearly flat)."""
    x0, x1, y0, y1 = -17.35, 18.25, -7.55, 6.15           # walls: lidar roof returns u -17.7..18.6, v -8.0..6.6 less the overhangs
    ax1, ay1, sx0 = 21.9, 8.65, 8.4                         # annex: west end, south side, where the south strip starts
    O = [(x0, y0), (ax1, y0), (ax1, ay1), (sx0, ay1), (sx0, y1), (x0, y1)]
    rz, pl, pr, rv = 125.25, 0.50, 0.475, -0.99

    def pieces(site):
        g0 = site.ground
        zs = rz - g0
        ze = 121.66 - g0                                  # annex roof at the main eave level (lidar 2.7-2.8 m over the ground)
        return [gable_x(rv, zs, pl, pr, x0, 18.25, y0, y1, mat="bge_tile_aged"),
                gable_y(20.075, ze + 0.2, 0.1, 0.1, 18.25, ax1, y0, ay1, 0.35, 0.35, mat="bge_roof_dark_sheet"),
                mono_y(ze + 0.05, -0.06, sx0, 18.25, y1, ay1, 0.35, 0.0, mat="bge_roof_dark_sheet")]

    def extras(g, site, roofs):
        # solar: a continuous band by the eave and four arrays higher up (ortho), flush on the +v plane
        plane = roofs.pieces[0]["planes"][1]              # falls to +v
        for vc, hh, ua, ub in ((5.35, 1.55, -16.2, 17.4), (2.75, 1.65, 13.6, 17.1), (2.75, 1.65, 8.6, 12.9), (2.75, 1.65, 3.6, 8.1), (2.75, 1.65, -1.4, 3.1)):
            solar_array(g, plane, (ua + ub) / 2, vc, ub - ua, hh * math.hypot(1, pr))
    B = dict(pieces=pieces, wall="falu_red_vertical", tile="bge_tile_aged", gutters=True, extras=extras,
             inner=[dict(a=(18.25, y0), b=(18.25, y1)), dict(a=(18.25, y1), b=(sx0, y1))],
             edges={0: dict(doors=[gate(10.5, 3.4, 2.3), gate(16.35, 3.4, 2.3)], auto=dict(pitch=3.8, w=1.2, h=1.2, margin=2.0)),
                    4: dict(auto=dict(pitch=4.0, w=1.2, h=1.2, margin=1.5)),
                    5: dict(doors=[door(7.55)]),
                    2: dict(auto=dict(pitch=4.0, w=1.2, h=1.2, margin=1.0))})
    place(add, ev, "omberg_bg_east_long_hall", "1109741303", O, B)


def pale_hall(add, ev):
    """OSM 315: pale-sheet hall (main body, ridge level 126.4 m, pitch 0.31), a lower and narrower annex whose ridge is offset
    east (125.4 m) and a low felt-roofed bay at the north end; all from the lidar planes. Sits on a 1 m slope."""
    x0, x1 = -13.95, 7.3
    y0, y1 = -8.65, 6.65
    ax1, ay1 = 16.15, 0.15
    fx1 = 18.85
    O = [(x0, y0), (fx1, y0), (fx1, ay1), (x1, ay1), (x1, y1), (x0, y1)]

    def pieces(site):
        g0 = site.ground
        return [gable_x(-0.8, 126.42 - g0, 0.317, 0.31, x0, x1, y0, y1, mat="bge_roof_pale"),
                gable_x(-4.25, 125.37 - g0, 0.30, 0.30, x1, ax1, y0, ay1, 0.45, 0.35, mat="bge_roof_pale"),
                flat(124.05 - g0, ax1, fx1, y0, ay1, 0.2, mat="roof_felt_brown")]
    B = dict(pieces=pieces, wall="bge_wall_white", tile="bge_roof_pale", gutters=True, floor=121.45,
             inner=[dict(a=(x1, y0), b=(x1, ay1)), dict(a=(ax1, y0), b=(ax1, ay1))],
             edges={0: dict(doors=[gate(6.0, 3.4, 2.4), gate(15.5, 3.4, 2.4), door(24.2)], auto=dict(pitch=4.0, w=1.2, h=1.2, margin=1.5)),
                    4: dict(auto=dict(pitch=3.6, w=1.0, h=1.2, margin=1.5)),
                    5: dict(auto=dict(pitch=3.0, w=1.0, h=1.2, margin=1.5)),
                    2: dict(auto=dict(pitch=3.6, w=1.0, h=1.2, margin=1.5))})
    place(add, ev, "omberg_bg_east_pale_hall", "1109741315", O, B)


def gabled_pair(*ks):
    return ks


def barn_314(add, new, ev):
    """OSM 314: the dark-roofed machine barn: low-pitch (0.36) charcoal sheet roof, ridge 6.3 m over the ground. Falu red board
    (inferred), a gate at the south gable where the machines stand (ortho), a second on the east (yard) side."""
    lidar_house(add, new, ev, "1109741314", "omberg_bg_east_dark_barn", (-9.8, 11.6, -5.4, 6.0, 0.34, 128.26, 0.347, 0.368),
                wall="falu_red_vertical", tile="bge_roof_charcoal", fascia="black_trim", under="black_trim", gutters=True,
                edges={3: dict(doors=[gate(5.25, 3.6, 3.4)]), 0: dict(doors=[gate(5.0, 3.2, 3.2)], auto=dict(pitch=4.2, w=1.0, h=0.9, sill=1.7, margin=2.5)),
                       2: dict(auto=dict(pitch=4.2, w=1.0, h=0.9, sill=1.7, margin=2.0)), 1: dict(auto=dict(pitch=3.0, w=0.9, h=0.8, sill=2.0))})


def houses_south(add, new, ev):
    # 317: small house, white board, orange tile; door and windows on the south side (inferred), white gable end seen in the ortho
    lidar_house(add, new, ev, "1109741317", "omberg_bg_east_house_317", (-4.2, 4.6, -3.1, 3.4, 0.25, 126.06, 0.558, 0.599),
                wall="bge_wall_white", tile="bge_tile_orange", floor_off=0.3,
                edges={0: dict(doors=[door(2.4)], auto=dict(pitch=2.5, w=0.9, h=0.9, sill=0.8)), 2: dict(auto=dict(pitch=2.5, w=0.9, h=0.9, sill=0.8)),
                       1: dict(auto=dict(pitch=2.5, w=0.7, h=0.8, sill=0.8)), 3: dict(auto=dict(pitch=2.5, w=0.7, h=0.8, sill=0.8))})
    # 318: long weathered-tile building, falu red; doors on the east side, a row of small windows
    lidar_house(add, new, ev, "1109741318", "omberg_bg_east_long_318", (-6.4, 8.0, -3.6, 3.4, 0.24, 127.64, 0.616, 0.714),
                wall="falu_red_vertical", tile="bge_tile_aged",
                edges={0: dict(doors=[door(3.2)], auto=dict(pitch=2.9, w=0.9, h=1.0, margin=1.6)), 2: dict(auto=dict(pitch=2.9, w=0.9, h=1.0, margin=1.6)),
                       1: dict(auto=dict(pitch=2.5, w=0.8, h=0.9)), 3: dict(auto=dict(pitch=2.5, w=0.8, h=0.9))})
    # 319: small house under trees (lidar mixed with canopy: roof taken as the rectangle, ridge 5.1 m), dark brown tile
    lidar_house(add, new, ev, "1109741319", "omberg_bg_east_house_319", (-6.3, 6.3, -3.6, 3.6, 0.0, 127.32, 0.55, 0.55),
                wall="falu_red_dark_vertical", tile="bge_tile_brown",
                edges={0: dict(doors=[door(3.0)], auto=dict(pitch=3.0, w=0.9, h=1.1)), 2: dict(auto=dict(pitch=3.0, w=0.9, h=1.1))})
    # 320: house, white board, steep orange tile (pitch 0.74, ridge 128.75 m = 6.5 m, lidar), chimney on the ridge (7.2 m).
    # A cross gable (ridge 128.3 m in the lidar, u -1.4..3.6) comes out of the +v (south) slope flush with the wall, with a low
    # porch roof in front of it (lidar 2.6-3.3 m over the ground, white in the ortho)
    gab = dict(rect=(-1.4, 3.6, -0.45, 3.45), piece=lambda site: gable_y(1.1, 128.3 - site.ground, 0.74, 0.74, -1.4, 3.6, -0.45, 3.45, 0.2, 0.3, mat="bge_tile_orange"))
    porch = dict(rect=(-1.4, 3.6, 3.45, 5.4), piece=lambda site: mono_y(125.3 - site.ground, -0.22, -1.4, 3.6, 3.45, 5.4, 0.3, 0.25, mat="bge_roof_pale"))
    lidar_house(add, new, ev, "1109741320", "omberg_bg_east_house_320", (-7.7, 8.2, -4.8, 3.45, -0.55, 129.0, 0.84, 0.66),
                wall="bge_wall_white", tile="bge_tile_orange", gutters=True, wings=[gab, porch],
                inner=[dict(a=(3.6, -0.45), b=(3.6, 3.45)), dict(a=(-1.4, 3.45), b=(-1.4, -0.45)), dict(a=(3.6, 3.45), b=(-1.4, 3.45))],
                chimneys=lambda site: [(-1.7, -0.45, 129.45 - site.ground, 0.7, 0.7)],
                edges={(1.1, 5.4): dict(doors=[door(2.5)], windows=[win(0.8, 0.9, 1.2, sill=0.8)]),
                       2: dict(auto=[dict(pitch=2.6, w=0.95, h=1.25, margin=1.2)]),
                       0: dict(auto=[dict(pitch=2.6, w=0.95, h=1.25, margin=1.2)]),
                       1: dict(auto=dict(pitch=2.5, w=0.8, h=1.0)), 3: dict(auto=dict(pitch=2.5, w=0.8, h=1.0))})
    # 321: shed with a steep brown-tile roof
    lidar_house(add, new, ev, "1109741321", "omberg_bg_east_shed_321", (-4.0, 4.5, -3.3, 2.8, -0.24, 127.62, 0.631, 0.634),
                wall="falu_red_vertical", tile="bge_tile_brown",
                edges={2: dict(doors=[door(4.0)], auto=dict(pitch=3.0, w=0.8, h=0.9)), 0: dict(auto=dict(pitch=3.0, w=0.8, h=0.9))})
    # 322: two-storey house, pale yellow board, brown tile, ridge 7.0 m, two chimneys (lidar bumps), a gabled dormer in the
    # south (-v) slope flush with the south wall (ortho: white-edged gable at E 921.7-925)
    dorm = dict(rect=(-2.5, 0.7, -3.35, 0.0), piece=lambda site: gable_y(-0.9, 128.05 - site.ground, 0.62, 0.62, -2.5, 0.7, -3.35, 0.0, 0.2, 0.3, mat="bge_tile_brown"))
    lidar_house(add, new, ev, "1109741322", "omberg_bg_east_house_322", (-6.9, 5.7, -3.8, 5.1, 0.65, 129.0, 0.64, 0.70),
                wall="bge_wall_yellow", tile="bge_tile_brown", gutters=True, wings=[dorm],
                inner=[dict(a=(0.7, -3.35), b=(0.7, 0.0)), dict(a=(-2.5, 0.0), b=(-2.5, -3.35))],      # the dormer's cheeks
                chimneys=lambda site: [(-2.3, 0.65, 129.6 - site.ground, 0.7, 0.7), (1.5, 0.65, 129.6 - site.ground, 0.7, 0.7)],
                edges={(-0.9, -3.35): dict(windows=[win(1.6, 0.9, 1.0, sill=0.9), win(1.6, 0.9, 1.0, sill=3.1)]),
                       (3.0, -3.35): dict(doors=[door(1.2)], auto=[dict(pitch=2.7, w=0.95, h=1.25, margin=1.0)]),
                       (-5.0, -3.35): dict(auto=[dict(pitch=2.7, w=0.95, h=1.25, margin=1.0), dict(pitch=2.7, w=0.95, h=1.1, sill=3.0, margin=1.0)]),
                       2: dict(auto=[dict(pitch=2.7, w=0.95, h=1.25, margin=1.2), dict(pitch=2.7, w=0.95, h=1.1, sill=3.0, margin=1.2)]),
                       1: dict(auto=[dict(pitch=2.5, w=0.9, h=1.2), dict(pitch=2.5, w=0.7, h=0.9, sill=3.4)]), 3: dict(auto=dict(pitch=2.5, w=0.9, h=1.2))})
    # 323: small house, falu red, orange tile
    lidar_house(add, new, ev, "1109741323", "omberg_bg_east_house_323", (-4.2, 4.3, -4.0, 4.4, 0.45, 125.86, 0.543, 0.652),
                wall="falu_red_vertical", tile="bge_tile_orange",
                edges={0: dict(doors=[door(2.6)], auto=dict(pitch=2.6, w=0.9, h=1.2)), 2: dict(auto=dict(pitch=2.6, w=0.9, h=1.2)),
                       1: dict(auto=dict(pitch=2.5, w=0.8, h=1.0)), 3: dict(auto=dict(pitch=2.5, w=0.8, h=1.0))})


def world_of(frame, x, y):
    e0, n0, ang = frame
    t = math.radians(ang)
    return e0 + x * math.cos(t) - y * math.sin(t), n0 + x * math.sin(t) + y * math.cos(t)


def shifted(outline, cx, cy):
    return [(x - cx, y - cy) for x, y in outline]


def new_house(add, ev):
    """Buildings the OSM and the lidar do not have (built after the survey), from the 2025 ortho only. All three plots share the
    axis -19 deg (math angle). Heights are inferred: ortho shadows (sun 44 deg, ESE) give ridge ~5.7 m for the L-house,
    ~6 m for the solar house, ~5.8 m for the hall's high edge; pitches/typical; colours/walls inferred."""
    # ---- L-house: three gabled wings (north wing along x, east wing and south-west wing along y), orange tile, pale yellow board
    F = (477940.0, 6456705.0, -19.0)
    wallsr = [(-11.75, 1.9, 2.3, 10.3), (-2.15, 5.95, -5.35, 10.3), (-4.35, 2.55, -14.95, -4.6)]
    O = union_outline(wallsr)

    def pieces(site):
        zr = 5.7
        return [gable_x(6.3, zr, 0.72, 0.72, -11.75, 1.9, 2.3, 10.3, mat="bge_tile_orange"),
                gable_y(1.9, zr, 0.72, 0.72, -2.15, 5.95, -5.35, 10.3, mat="bge_tile_orange"),
                gable_y(-0.9, zr - 0.43, 0.72, 0.72, -4.35, 2.55, -14.95, -4.6, mat="bge_tile_orange")]
    B = dict(pieces=pieces, wall="bge_wall_yellow", tile="bge_tile_orange", gutters=True, floor_off=0.4, name="lhouse",
             inner=[dict(a=(2.55, -4.6), b=(-2.15, -4.6))],            # the south wing's north gable above the lower east-wing roof
             chimneys=lambda site: [(-4.7, 6.3, 6.4)],
             edges={1: dict(doors=[door(4.5)], auto=dict(pitch=2.7, w=0.95, h=1.25)), 3: dict(doors=[door(8.0)], auto=dict(pitch=2.7, w=0.95, h=1.25)),
                    4: dict(auto=[dict(pitch=2.7, w=0.95, h=1.25)]), 5: dict(auto=[dict(pitch=2.7, w=0.95, h=1.25), dict(pitch=2.7, w=0.7, h=0.9, sill=3.2)]),
                    6: dict(auto=dict(pitch=2.7, w=0.95, h=1.25)), 7: dict(auto=dict(pitch=2.7, w=0.95, h=1.25)),
                    9: dict(auto=dict(pitch=2.7, w=0.95, h=1.25)), 0: dict(auto=dict(pitch=2.7, w=0.8, h=1.1))})
    place(add, ev, "omberg_bg_east_lhouse", F, O, B)

    # ---- its outbuilding SW of the house: a small house, ridge along x, white east gable end (ortho), orange tile
    ob = [(-11.95, -2.75, -22.45, -16.65)]
    cx, cy = -7.35, -19.55
    E, N = world_of(F, cx, cy)

    def pieces_o(site):
        return [gable_x(0.0, 4.3, 0.6, 0.6, -4.6, 4.6, -2.9, 2.9, mat="bge_tile_orange")]
    Bo = dict(pieces=pieces_o, wall="bge_wall_white", tile="bge_tile_orange", floor_off=0.3, name="outhouse",
              edges={0: dict(doors=[door(2.3)], auto=dict(pitch=2.8, w=0.9, h=1.1)), 2: dict(auto=dict(pitch=2.8, w=0.9, h=1.1)),
                     1: dict(auto=dict(pitch=2.5, w=0.7, h=0.9)), 3: dict(auto=dict(pitch=2.5, w=0.7, h=0.9))})
    place(add, ev, "omberg_bg_east_lhouse_outbuilding", (E, E * 0 + N, -19.0), rect_outline(-4.6, 4.6, -2.9, 2.9), Bo)

    # ---- solar house: three volumes (west gable, solar shed roof falling south, north-east shed roof), black board, charcoal sheet
    F = (477982.0, 6456733.0, -19.0)
    rects = [(-10.1, -0.5, -6.8, 4.0), (-3.1, 7.0, -8.6, 1.3), (3.3, 10.6, 3.3, 10.4), (-0.5, 3.3, 1.3, 9.8)]
    O = union_outline(rects)

    def pieces(site):
        m = "bge_roof_charcoal"
        return [gable_y(-5.3, 5.9, 0.45, 0.45, -10.1, -0.5, -6.8, 4.0, mat=m),
                mono_y(3.4, 0.30, -3.1, 7.0, -8.6, 1.3, mat=m),
                mono_y(5.0, -0.2, 3.3, 10.6, 3.3, 10.4, mat=m),
                flat(3.3, -0.5, 3.3, 1.3, 9.8, 0.2, mat=m)]

    def extras(g, site, roofs):
        plane = roofs.pieces[1]["planes"][0]
        solar_array(g, plane, 2.0, -3.6, 8.0, 7.2 * math.hypot(1, 0.30))
    B = dict(pieces=pieces, wall="bge_wall_black", tile="bge_roof_charcoal", fascia="black_trim", under="black_trim", gutters=True,
             floor_off=0.4, name="solar", extras=extras, corners=False, door="door_black",
             inner=[dict(a=(3.3, 1.3), b=(-0.5, 1.3)), dict(a=(-0.5, 1.3), b=(-0.5, 4.0))],
             edges={})
    # doors/windows: modern, wide panes, auto on every long wall
    n = len(O)
    for i in range(n):
        a, b = O[i], O[(i + 1) % n]
        if math.dist(a, b) > 3.0:
            B["edges"][i] = dict(auto=dict(pitch=3.4, w=1.6, h=1.5, sill=0.8, margin=1.3, bars=(2, 1)))
    place(add, ev, "omberg_bg_east_solar_house", F, O, B)

    # ---- big dark hall: one mono-pitch charcoal roof falling to the NE (lit fascia along that edge in the ortho), black board,
    # a lower west wing. Under construction in the ortho (scaffold, blue tarp): finished form inferred.
    F = (477922.0, 6456661.0, -19.0)
    rects = [(-3.8, 8.1, -8.1, 8.8), (-8.6, -3.8, -8.0, -3.8)]
    O = union_outline(rects)

    def pieces(site):
        m = "bge_roof_dark_sheet"
        return [mono_y(5.9, -0.125, -3.8, 8.1, -8.1, 8.8, mat=m), mono_y(3.2, 0.0, -8.6, -3.8, -8.0, -3.8, mat=m)]
    B = dict(pieces=pieces, wall="bge_wall_black", tile="bge_roof_dark_sheet", fascia="black_trim", under="black_trim", gutters=True,
             floor_off=0.4, name="darkhall", corners=False, door="door_black",
             edges={})
    n = len(O)
    for i in range(n):
        a, b = O[i], O[(i + 1) % n]
        if math.dist(a, b) > 5.0:
            B["edges"][i] = dict(auto=dict(pitch=4.5, w=1.3, h=1.2, sill=1.4, margin=2.0))
    place(add, ev, "omberg_bg_east_dark_hall", F, O, B)


def glasshouse(add, new, ev):
    """The glasshouse east of the pale hall (ortho: white frame, glass, ~13 x 4.7 m; no lidar returns through glass): low
    concrete kerb, glass walls to 1.9 m, glazed gable roof to 3.0 m (inferred), white bars every 1.3 m, a door in each end."""
    corners = [(478043.0, 6456520.0), (478047.5, 6456521.3), (478050.7, 6456508.4), (478045.6, 6456507.3)]
    e0 = sum(c[0] for c in corners) / 4
    n0 = sum(c[1] for c in corners) / 4
    ang = 101.6
    L, W = 6.5, 2.35
    O = rect_outline(-L, L, -W, W)
    site = Site(ev, e0, n0, ang, O, floor_off=0.3)
    g = new()
    G, F = "bge_glasshouse", "bge_frame_white"
    ze, zr, z0 = 1.9, 3.0, site.zf
    g.extrude([(-L, -W), (L, -W), (L, W), (-L, W)], SINK, z0, "concrete", top="concrete", bottom=False)
    for sy in (-1, 1):              # long glass walls (face outward), gable ends, roof planes
        a, b = ((-L, sy * W), (L, sy * W))
        quad_n(g, [(a[0], a[1], z0), (b[0], b[1], z0), (b[0], b[1], ze), (a[0], a[1], ze)], (0, sy, 0), G)
        quad_n(g, [(-L, sy * W, ze), (L, sy * W, ze), (L, 0, zr), (-L, 0, zr)], (0, sy, 1 / 0.6), G)
    for sx in (-1, 1):
        quad_n(g, [(sx * L, -W, z0), (sx * L, W, z0), (sx * L, W, ze), (sx * L, -W, ze)], (sx, 0, 0), G)
        quad_n(g, [(sx * L, -W, ze), (sx * L, W, ze), (sx * L, 0, zr)], (sx, 0, 0), G)
        g.box((sx * L, 0, (z0 + ze) / 2), (0.07, 1.0, ze - z0), "door_white", mats={"side": "door_white"})      # end door
    n = int(2 * L / 1.3)
    for i in range(n + 1):          # rafters and posts
        x = -L + 2 * L * i / n
        for sy in (-1, 1):
            g.box((x, sy * W, (z0 + ze) / 2), (0.06, 0.06, ze - z0), F, skip=("bottom",))
            g.beam((x, sy * W, ze), (x, 0, zr), 0.05, 0.06, F)
    g.box((0, 0, zr + 0.02), (2 * L, 0.08, 0.06), F)
    for sy in (-1, 1):
        g.box((0, sy * W, ze), (2 * L, 0.06, 0.06), F)
        g.box((0, sy * W, z0 + 0.04), (2 * L, 0.06, 0.08), F)
    add("omberg_bg_east_glasshouse", g, e0, n0, site.yaw, site.ground)


def small_buildings(add, new, ev):
    """Small boxes seen in the ortho: a white flat-roofed hut (E 478?) near the L-house, a blue hut beside the hall's south end,
    and a garden pavilion south of the solar house. Walls/heights inferred (ortho shadows ~2.4 m)."""
    def hut(aid, frame, w, d, h, wall, roof, mono=0.06):
        O = rect_outline(-w / 2, w / 2, -d / 2, d / 2)

        def pieces(site):
            return [mono_y(h, mono, -w / 2, w / 2, -d / 2, d / 2, 0.25, 0.25, mat=roof)]
        B = dict(pieces=pieces, wall=wall, tile=roof, floor_off=0.2, corners=False, name=aid, fascia="bge_frame_white",
                 edges={0: dict(doors=[door(w * 0.25, 0.85, 1.9)]), 2: dict(auto=dict(pitch=2.0, w=0.7, h=0.7, sill=0.9))})
        place(add, ev, aid, frame, O, B)
    hut("omberg_bg_east_hut_white", (477934.6, 6456678.3, -10.0), 3.4, 4.2, 2.5, "bge_wall_white", "bge_felt_flat")
    hut("omberg_bg_east_hut_dark", (478073.0, 6456681.0, -19.0), 3.6, 3.2, 2.4, "bge_wall_black", "bge_roof_dark_sheet")
    hut("omberg_bg_east_hut_blue", (477926.9, 6456644.6, -10.0), 3.2, 3.3, 2.5, "bge_wall_blue", "bge_felt_flat")
    # pavilion: hip roof
    O = rect_outline(-1.9, 1.9, -1.6, 1.6)

    def pieces(site):
        return [hip(-1.9, 1.9, -1.6, 1.6, 2.6, 0.5, 0.4, mat="bge_roof_pale")]
    B = dict(pieces=pieces, wall="bge_wall_white", tile="bge_roof_pale", floor_off=0.25, corners=False, name="pavilion",
             edges={0: dict(doors=[door(1.9, 1.0, 1.95)]), 2: dict(auto=dict(pitch=1.6, w=0.7, h=1.0))})
    place(add, ev, "omberg_bg_east_pavilion", (477980.2, 6456722.2, -19.0), O, B)


def modern_sw(add, ev):
    """The modern house west of 322 (not in OSM; lidar: ring of 2.3-2.8 m returns round flat roofs, 3-5 m over the brown wing):
    a brown-tile gable wing, a dark flat-roofed west wing and a pale flat-roofed north block, white render (inferred)."""
    F = (477915.0, 6456500.0, 0.0)
    rects = [(-3.0, 4.5, -2.6, 3.0), (-9.0, -3.0, -2.6, 3.0), (-8.0, 1.0, 3.0, 7.5)]
    O = union_outline(rects)

    def pieces(site):
        return [gable_x(0.2, 127.3 - site.ground, 0.62, 0.62, -3.0, 4.5, -2.6, 3.0, mat="bge_tile_brown"),
                flat(124.9 - site.ground, -9.0, -3.0, -2.6, 3.0, 0.15, mat="bge_roof_dark_sheet"),
                flat(124.9 - site.ground, -8.0, 1.0, 3.0, 7.5, 0.15, mat="bge_felt_pale")]
    B = dict(pieces=pieces, wall="bge_wall_plaster", tile="bge_tile_brown", floor_off=0.3, name="modern_sw", corners=False,
             inner=[dict(a=(-3.0, 3.0), b=(-3.0, -2.6))],
             chimneys=lambda site: [(-1.8, 2.2, 128.2 - site.ground, 0.6, 0.6)],
             edges={})
    n = len(O)
    for i in range(n):
        a, b = O[i], O[(i + 1) % n]
        if math.dist(a, b) > 3.0:
            B["edges"][i] = dict(auto=dict(pitch=3.2, w=1.4, h=1.3, sill=0.8, margin=1.0))
    place(add, ev, "omberg_bg_east_house_sw_modern", F, O, B)


def build(add, new, ev):
    global _new
    _new = new
    for n, osm in enumerate(CABIN_FIT, 1):
        cabin(add, new, ev, osm, n)
    long_hall(add, ev)
    pale_hall(add, ev)
    barn_314(add, new, ev)
    houses_south(add, new, ev)
    new_house(add, ev)
    glasshouse(add, new, ev)
    small_buildings(add, new, ev)
    modern_sw(add, ev)
    # 304: the orange-tiled shed by the road; big gate on the road (NE, -v) side. inferred: walls, gate, windows
    lidar_house(add, new, ev, "1109741304", "omberg_bg_east_shed", (-4.6, 5.5, -5.3, 3.6, -0.77, 123.84, 0.478, 0.494),
                wall="bge_wall_yellow", tile="bge_tile_orange",
                edges={0: dict(doors=[gate(5.0, 3.0, 2.2)]), 2: dict(auto=dict(pitch=2.8, w=1.0, h=1.1)),
                       1: dict(auto=dict(pitch=2.8, w=0.8, h=0.9))})
