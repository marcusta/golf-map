"""Farm south of hole 14 tee (OSM 1109749334-1109749343, 1431566970-1431566973, 1109741328) as background buildings.

Seen from holes 13-15 at 150-400 m, so the budget goes into roof planes, overhangs, fascia, ridge caps, chimneys,
the solar array, barn doors and window rows. model.py calls register_materials() and build(add, new, ev).

Evidence and rules (the numbers sit in the specs below, each marked "lidar" or "inferred"):
  * Roof planes are RANSAC plane fits to the class-1 lidar returns inside each footprint (rms 0.04-0.06 m, 50-350
    returns per plane); ridge position, ridge height and pitch come from the plane intersections, one pitch per plane
    pair. Where two wings meet, the planes are cut against each other so valleys fall on the true intersections.
  * The 2025 ortho is not a true ortho: roofs sit ~1-3 m west/north of the lidar roofs and the OSM outlines follow the
    ortho. So roof outlines are lidar extents (+0.35 m for the sparse edge sampling) and the OSM polygon only gives the
    size and wing layout. The ortho gives roof forms, colours, the solar array and doors' sides.
  * Dark sheet roofs (337, the west slope of 338) return nothing to the lidar: their heights are inferred from the few
    returns on the lit part and the OSM eave/ridge tags, marked "inferred".
  * Walls and trim colours are not visible from above: falu-red board with white trim for barns and outbuildings,
    pale yellow / white / falu red for the houses (inferred). Windows and doors are inferred rows.
Asset frame of every building: the OSM rectangle frame - x along the rectangle's long axis, y to its left, origin on
its centre, z up from the median class-2 ground in a ring round the footprint (so the lidar fits are used as they are).
"""
import math

import numpy as np
from mathutils import Matrix, Vector

import props_kit as kit

# Only materials this module defines (model.py zeroes their specular: sRGB-lit matt).
MATTE = {"bgw_tile_red", "bgw_tile_brown", "bgw_sheet_black", "bgw_sheet_dark", "bgw_sheet_pale", "bgw_fc",
         "bgw_wall_yellow", "bgw_wall_white", "bgw_plinth", "bgw_chimney", "bgw_void", "bgw_door_green", "bgw_door_brown"}
EPS = 1e-6


def tex_bgwfc(self, color="136,132,126"):
    """Weathered fibre-cement sheet: 11 waves per 2 m tile, mottled, rain streaks, pale lichen (relief in the normal map)."""
    S = self.size
    col = kit._rgb([int(c) for c in color.split(",")])
    wave = np.broadcast_to(0.5 + 0.5 * np.sin(np.arange(S)[None, :] / S * 2 * math.pi * 11), (S, S))
    big = kit._fbm((S, S), 301, scales=(256, 128, 64, 32))
    mid = kit._fbm((S, S), 303, scales=(32, 16, 8, 4))
    streak = np.repeat(kit._fbm((S, S // 8), 307, scales=(64, 16, 4)), 8, 1)[:, :S]
    lichen = np.clip((kit._fbm((S, S), 311, scales=(64, 24, 8, 3)) - 0.58) * 5, 0, 1)
    v = (0.86 + 0.24 * big) * (0.93 + 0.14 * mid) * (0.93 + 0.14 * streak) * (0.84 + 0.22 * wave)
    alb = col[None, None, :] * v[:, :, None]
    alb = alb + (kit._rgb([140, 142, 124]) - alb) * 0.22 * lichen[:, :, None]
    return np.clip(alb, 0, 1), 0.7 * wave + 0.2 * mid + 0.1 * big, 3.0


def register_materials():
    M = kit.MATERIALS
    # tile colours: the 2025 ortho shows the sunlit slopes at (224,162,148) (orange) and (208,156,143) (main house, redder);
    # the kit's orange pantile is the farm's calibrated value, the others are a step redder / browner
    M["bgw_tile_red"] = ("pantile:152,72,54", (2.0, 2.0), None, 0.25, 0.0)
    M["bgw_tile_brown"] = ("pantile:128,84,70", (2.0, 2.0), None, 0.2, 0.0)
    # sheets: very dark (no lidar return: 337, 338 west), dark grey (334/335), pale grey corrugated (L-barn north wing,
    # 338 east), weathered fibre cement (L-barn south wing, west barn, small shed)
    M["bgw_sheet_black"] = ("seam:50,56,68:0.52:2.08:0", (2.08, 2.08), None, 0.25, 0.2)
    M["bgw_sheet_dark"] = ("seam:80,88,102:0.52:2.08:0", (2.08, 2.08), None, 0.25, 0.2)
    M["bgw_sheet_pale"] = ("seam:172,176,180:0.076:2.0:1", (2.0, 2.0), None, 0.12, 0.1)
    M["bgw_fc"] = ("bgwfc:136,132,126", (2.0, 2.0), None, 0.05, 0.0)
    M["bgw_wall_yellow"] = ("boards:204,182,118:h:0.14:2.0:0", (2.0, 2.0), None, 0.12, 0.0)
    M["bgw_wall_white"] = ("boards:192,190,182:h:0.14:2.0:0", (2.0, 2.0), None, 0.12, 0.0)
    M["bgw_plinth"] = ("plaster:128,126,120", (2.0, 2.0), None, 0.1, 0.0)
    M["bgw_chimney"] = ("plaster:178,170,158", (2.0, 2.0), None, 0.1, 0.0)
    M["bgw_void"] = (None, (1, 1), (14, 14, 15), 0.0, 0.0)
    M["bgw_door_green"] = ("boards:48,76,56:v:0.14:2.0:2", (2.0, 2.0), None, 0.1, 0.0)
    M["bgw_door_brown"] = ("boards:84,62,48:v:0.14:2.0:2", (2.0, 2.0), None, 0.1, 0.0)
    kit.TextureBank.tex_bgwfc = tex_bgwfc


WHITE = "white_trim"
RED = "falu_red_vertical"
GLASS = "window_dark"


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
    """Polygon facing `nrm` whatever order the points come in."""
    P = [Vector(p) for p in pts]
    n = Vector()
    for i in range(len(P)):
        a, b = P[i], P[(i + 1) % len(P)]
        n += Vector(((a.y - b.y) * (a.z + b.z), (a.z - b.z) * (a.x + b.x), (a.x - b.x) * (a.y + b.y)))
    g.poly([tuple(p) for p in (P if n.dot(Vector(nrm)) > 0 else P[::-1])], mat)


# ---------------------------------------------------------------------------------------------
# Roofs: a union of pieces; each piece is the lower envelope (min) of its planes inside a rectangle.
# Planes are (a, b, c): z = a x + b y + c in the asset frame (z above the placement ground).
# ---------------------------------------------------------------------------------------------
def piece(planes, outer, ovh=0.45, **kw):
    """`outer` = roof outline rectangle (x0, x1, y0, y1); walls sit `ovh` inside it (ovh may be per side x0, x1, y0, y1;
    0 where the piece runs into another one)."""
    ov = ovh if isinstance(ovh, tuple) else (ovh,) * 4
    x0, x1, y0, y1 = outer
    d = dict(planes=planes, rect=tuple(outer), wrect=(x0 + ov[0], x1 - ov[1], y0 + ov[2], y1 - ov[3]))
    d.update(kw)
    return d


def gab_x(y0, z0, p, outer, ovh=0.45, **kw):
    """Gable, level ridge along x at y = y0 (height z0), pitch p. mats=[+y slope, -y slope]."""
    return piece([(0, -p, z0 + p * y0), (0, p, z0 - p * y0)], outer, ovh, **kw)


def gab_y(x0, z0, p, outer, ovh=0.45, **kw):
    """Gable, level ridge along y at x = x0. mats=[+x slope, -x slope]."""
    return piece([(-p, 0, z0 + p * x0), (p, 0, z0 - p * x0)], outer, ovh, **kw)


def mono_y(zlow, ylow, slope, outer, ovh=0.3, **kw):
    """One plane rising towards +y: z = zlow + slope (y - ylow)."""
    return piece([(0, slope, zlow - slope * ylow)], outer, ovh, **kw)


class Roofs:
    def __init__(self, pieces, thick=0.12):
        self.pieces = pieces
        self.thick = thick
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
                    # cover "rect": Q hides lower roof under its whole outline (wings of an L or T, whose overhangs merge into
                    # one surface); cover "wrect": only its wall footprint does (a dormer's overhang floats over the roof below)
                    hps = rect_hps(Q["rect"] if Q.get("cover", "rect") == "rect" else Q["wrect"]) + [(q[0] - pl[0], q[1] - pl[1], q[2] - pl[2]) for q in Q["planes"]]
                    polys = subtract(polys, hps)
                mats = P.get("mats")
                for p in polys:
                    if abs(area(p)) > 1e-4:
                        if area(p) < 0:
                            p = p[::-1]
                        out.append(dict(poly=p, plane=pl, piece=i, mat=(mats[k] if mats else P.get("mat"))))
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

    def build(self, g, top, under, edge, cap, ridge_w=0.22):
        """Top planes, undersides, fascia on the free edges, ridge/hip caps; returns the level free eaves
        [(a, b, z, nx, ny)] for the gutters."""
        thick = self.thick
        eaves, caps, seen = [], [], set()
        for r in self.polys:
            pl, poly = r["plane"], r["poly"]
            mat = r["mat"] or top
            P3 = [(x, y, pl[0] * x + pl[1] * y + pl[2]) for x, y in poly]
            g.poly(P3, mat)
            g.poly([(x, y, z - thick) for x, y, z in reversed(P3)], under)
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
                    g.poly([(a[0], a[1], a[2] - thick), (b[0], b[1], b[2] - thick), b, a], edge)
                    if abs(a[2] - b[2]) < 1e-3:
                        eaves.append((a, b, a[2], ox, oy))
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
            g.beam((a[0], a[1], a[2] + 0.03), (b[0], b[1], b[2] + 0.03), ridge_w, 0.07, cap)
        return eaves


# ---------------------------------------------------------------------------------------------
# Walls with window/door recesses
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
    """Top of a wall along a->b: the roof, with vertical steps where pieces change; embed: how far the wall top sits below
    the roof surface (inside the slab, which is thicker)."""
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
    T = []
    for t in sorted(t for t in cand if -1e-4 <= t <= L + 1e-4):     # snap near-duplicates (plane intersections land 1e-6 off the ends)
        t = min(max(t, 0.0), L)
        if not T or t - T[-1] > 1e-4:
            T.append(t)
    T[-1] = L
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
    """One outline edge a->b (CCW outline: outward normal to the right of the direction)."""

    def __init__(self, a, b, roofs, mat, zb, openings=(), embed=0.05, trim=WHITE):
        self.a, self.b = Vector((a[0], a[1], 0)), Vector((b[0], b[1], 0))
        self.L = math.hypot(b[0] - a[0], b[1] - a[1])       # float64: mathutils lengths are float32 and miss the profile's end by 1e-6
        self.u = (self.b - self.a) / self.L
        self.n = Vector((self.u.y, -self.u.x, 0))
        self.mat, self.trim, self.tag = mat, trim, ""
        self.top = wall_profile(roofs, a, b, embed)
        self.bottom = [(0.0, zb), (self.L, zb)]
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
            ba, bb = lin(bot, ta, tb)
            ya, yb = lin(top, ta, tb)
            yb, ya = max(yb, bb), max(ya, ba)
            here = sorted((o for o in ops if o["t0"] - 1e-6 <= ta and tb <= o["t1"] + 1e-6), key=lambda o: o["sill"])
            if not here:
                pts = [(ta, ba), (tb, bb)]
                pts += [(tb, z) for z in sorted(zs.get(round(tb, 6), ())) if bb + 1e-4 < z < yb - 1e-4]
                pts.append((tb, yb))
                pts.append((ta, ya))
                pts += [(ta, z) for z in sorted(zs.get(round(ta, 6), ()), reverse=True) if ba + 1e-4 < z < ya - 1e-4]
                if abs(ya - ba) < 1e-4 and abs(yb - bb) < 1e-4:
                    continue
                g.poly([self.P(t, z) for t, z in pts], self.mat)
            else:
                lo_a, lo_b = ba, bb
                for o in here:
                    sill, head = o["sill"], o["sill"] + o["h"]
                    if sill > lo_a + 1e-4 or sill > lo_b + 1e-4:
                        g.poly([self.P(ta, lo_a), self.P(tb, lo_b), self.P(tb, max(sill, lo_b)), self.P(ta, max(sill, lo_a))], self.mat)
                    lo_a = lo_b = head
                if head < ya - 1e-4 or head < yb - 1e-4:
                    g.poly([self.P(ta, head), self.P(tb, head), self.P(tb, max(yb, head)), self.P(ta, max(ya, head))], self.mat)
                if min(ya, yb) < head + 0.03:
                    print("WARNING %s: opening head %.2f meets the roof (%.2f) on wall %s t=%.2f" % (self.tag, head, min(ya, yb), self.a, ta))
        for o in ops:
            self.opening(g, o)

    def frame(self, t):
        u, n = self.u, self.n
        return Matrix(((u.x, 0, n.x, self.a.x + u.x * t), (u.y, 0, n.y, self.a.y + u.y * t), (0, 1, 0, 0), (0, 0, 0, 1)))

    def opening(self, g, o):
        """Recess (reveals in trim), dark glass or door leaf set back, a flat casing ring in trim, glazing bars; doors get a
        threshold. Local frame: x along the wall, y up, z out of the wall."""
        kind = o.get("kind", "window")
        w, h, sill = o["w"], o["h"], o["sill"]
        d = 0.10 if kind != "barn" else 0.14
        tr = o.get("trim", self.trim)
        hw = w / 2
        g.push(self.frame(o["t"]))
        for x, nx in ((-hw, 1), (hw, -1)):
            quad_n(g, [(x, sill, 0), (x, sill + h, 0), (x, sill + h, -d), (x, sill, -d)], (nx, 0, 0), tr)
        quad_n(g, [(-hw, sill + h, 0), (hw, sill + h, 0), (hw, sill + h, -d), (-hw, sill + h, -d)], (0, -1, 0), tr)
        if kind == "window":
            quad_n(g, [(-hw, sill, 0), (hw, sill, 0), (hw, sill, -d), (-hw, sill, -d)], (0, 1, 0), tr)
        zf = -d + 0.03
        leaf = o.get("mat")
        if kind in ("door", "barn"):
            quad_n(g, [(-hw, sill, zf), (hw, sill, zf), (hw, sill + h, zf), (-hw, sill + h, zf)], (0, 0, 1), leaf or "door_white")
            if kind == "door" and o.get("glazed", True):
                gl = hw - 0.2
                quad_n(g, [(-gl, sill + h * 0.45, zf + 0.004), (gl, sill + h * 0.45, zf + 0.004), (gl, sill + h - 0.22, zf + 0.004), (-gl, sill + h - 0.22, zf + 0.004)], (0, 0, 1), GLASS)
            if kind == "barn":              # the door's rail above the opening; a Z-brace in trim across the leaves and a centre joint
                g.box((0, sill + h + 0.3, 0.1), (w + 1.2, 0.12, 0.1), "black_steel", skip=("bottom",))
                g.beam((-hw + 0.25, sill + 0.35, zf + 0.04), (hw - 0.25, sill + h - 0.35, zf + 0.04), 0.14, 0.03, tr)
                g.box((0, sill + h / 2, zf + 0.02), (0.05, h, 0.03), tr)
        else:
            quad_n(g, [(-hw, sill, zf), (hw, sill, zf), (hw, sill + h, zf), (-hw, sill + h, zf)], (0, 0, 1), GLASS)
            cols, rows = o.get("bars", (2, 1))
            for i in range(1, cols):
                x = -hw + w * i / cols
                quad_n(g, [(x - 0.02, sill, zf + 0.004), (x + 0.02, sill, zf + 0.004), (x + 0.02, sill + h, zf + 0.004), (x - 0.02, sill + h, zf + 0.004)], (0, 0, 1), tr)
            for j in range(1, rows):
                y = sill + h * j / rows
                quad_n(g, [(-hw, y - 0.02, zf + 0.004), (hw, y - 0.02, zf + 0.004), (hw, y + 0.02, zf + 0.004), (-hw, y + 0.02, zf + 0.004)], (0, 0, 1), tr)
        # casing ring on the wall face (3 cm proud; thin, so a flat strip reads right at distance)
        cw = o.get("casing", 0.11)
        z = 0.03
        o0, o1 = hw + cw, sill + h + cw
        for p in ([(-o0, sill, z), (-hw, sill, z), (-hw, o1, z), (-o0, o1, z)],
                  [(hw, sill, z), (o0, sill, z), (o0, o1, z), (hw, o1, z)],
                  [(-hw, sill + h, z), (hw, sill + h, z), (hw, o1, z), (-hw, o1, z)]):
            quad_n(g, p, (0, 0, 1), tr)
        if kind == "window":
            g.box((0, sill - 0.04, 0.05), (w + 2 * cw + 0.08, 0.06, 0.1), tr, skip=("bottom",))
        else:
            g.box((0, 0.03, 0.09), (w + 2 * cw, 0.12, 0.18), "bgw_plinth", skip=("bottom",))      # threshold
        g.pop()


# ---------------------------------------------------------------------------------------------
# Trim: plinth, corner boards, gutters, chimneys, steps
# ---------------------------------------------------------------------------------------------
def plinth(g, outline, sink, top, mat="bgw_plinth", d=0.04):
    off = offset_poly(outline, d)
    n = len(outline)
    for i in range(n):
        a, b = off[i], off[(i + 1) % n]
        g.poly([(a[0], a[1], sink), (b[0], b[1], sink), (b[0], b[1], top), (a[0], a[1], top)], mat)
        p, q = outline[i], outline[(i + 1) % n]
        g.poly([(a[0], a[1], top), (b[0], b[1], top), (q[0], q[1], top), (p[0], p[1], top)], mat)


def convex_corners(poly):
    n = len(poly)
    return [(poly[i][0] - poly[i - 1][0]) * (poly[(i + 1) % n][1] - poly[i][1]) - (poly[i][1] - poly[i - 1][1]) * (poly[(i + 1) % n][0] - poly[i][0]) > 0
            for i in range(n)]


def corner_boards(g, roofs, outline, zb, mat=WHITE, w=0.14):
    """White pilasters on the convex corners, plinth to under the eave: a post whose two outer faces stand 3 cm proud of
    both walls (its inner faces sit inside the walls)."""
    cv = convex_corners(outline)
    n = len(outline)
    for i, v in enumerate(outline):
        if not cv[i]:
            continue
        pa, pb = outline[i - 1], outline[(i + 1) % n]
        za = roofs.z(v[0], v[1], wall=True)
        if za is None:
            continue
        ia = (v[0] - pa[0], v[1] - pa[1])
        ib = (pb[0] - v[0], pb[1] - v[1])
        la, lb = math.hypot(*ia), math.hypot(*ib)
        ia, ib = (ia[0] / la, ia[1] / la), (ib[0] / lb, ib[1] / lb)
        k = w / 2 - 0.03
        cx = v[0] - (ia[1] + ib[1]) * k
        cy = v[1] - (-ia[0] - ib[0]) * k
        h = za - 0.12 - zb
        if h > 0.3:
            g.box((cx, cy, zb + h / 2), (w, w, h), mat, rz=math.degrees(math.atan2(ia[1], ia[0])), skip=("bottom", "top"))


def gutter(g, a, b, z, ox, oy, thick, mat="galvanised"):
    """A square-section gutter hung under the fascia of a level eave a->b."""
    g.beam((a[0] + ox * 0.07, a[1] + oy * 0.07, z - thick - 0.05), (b[0] + ox * 0.07, b[1] + oy * 0.07, z - thick - 0.05), 0.11, 0.09, mat)


def chimney(g, x, y, z_base, z_top, sx=0.8, sy=0.8, rot=0.0, mat="bgw_chimney"):
    """Chimney stack with a cap slab and two flue pots (rot: degrees about z)."""
    g.push(Matrix.Translation((x, y, 0)) @ Matrix.Rotation(math.radians(rot), 4, "Z"))
    g.box((0, 0, (z_base + z_top) / 2), (sx, sy, z_top - z_base), mat, skip=("bottom",))
    g.box((0, 0, z_top + 0.04), (sx + 0.14, sy + 0.14, 0.08), "granite_dark", skip=("bottom",))
    for dx in (-sx / 4, sx / 4):
        g.cylinder((dx, 0, z_top + 0.08), 0.1, 0.24, "black_steel", seg=6, r_top=0.08)
    g.pop()


def step(g, wall, t, w, flights, sink):
    """Stone steps in front of a door: (depth from the wall, top z) per tread; each block stands on `sink`."""
    p = wall.P(t, 0)
    ang = math.degrees(math.atan2(wall.n.y, wall.n.x))
    for depth, top in flights:
        c = wall.P(t, 0, depth / 2)
        g.box((c[0], c[1], (top + sink) / 2), (depth, w, top - sink), "granite_plinth", rz=ang)


def solar_array(g, plane, x0, x1, y0, y1, lift=0.09):
    """Solar panels on a roof plane z = a x + b y + c, outline rectangle in plan: one panel quad, a frame skirt, standing on
    short stand-offs implied by `lift`."""
    A, B, C = plane
    corners = [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]
    top = [(x, y, A * x + B * y + C + lift) for x, y in corners]
    quad_n(g, top, (-A, -B, 1), "solar_panel")
    for i in range(4):
        a, b = top[i], top[(i + 1) % 4]
        out = ((b[1] - a[1]), -(b[0] - a[0]), 0)
        quad_n(g, [a, b, (b[0], b[1], b[2] - lift), (a[0], a[1], a[2] - lift)], out, "paint_grey")


# ---------------------------------------------------------------------------------------------
# One building from a spec
# ---------------------------------------------------------------------------------------------
def win(c, w=1.0, h=1.2, sill=0.95, **k):
    """c: the window's centre as a local x (on a wall along x) or y (on a wall along y) coordinate."""
    d = dict(c=c, w=w, h=h, sill=sill, kind="window")
    d.update(k)
    return d


def door(c, w=1.0, h=2.05, **k):
    d = dict(c=c, w=w, h=h, sill=0.0, kind="door")   # sill is set from the plinth in build_building
    d.update(k)
    return d


def barn_door(c, w=3.2, h=3.6, mat="door_red", **k):
    d = dict(c=c, w=w, h=h, sill=0.0, kind="barn", mat=mat)
    d.update(k)
    return d


def build_building(g, S, sink):
    """S: outline (CCW wall polygon), pieces (roof pieces), thick, wall (material), zb (plinth top), open {edge index: [openings]},
    chimneys [(x, y, z_top, sx, sy)], extra(g, roofs) hook, tile (top material), trim."""
    roofs = Roofs(S["pieces"], S.get("thick", 0.12))
    outline, zb = S["outline"], S.get("zb", 0.35)
    n = len(outline)
    plinth(g, outline, sink, zb, S.get("plinth", "bgw_plinth"))
    walls = []

    def make_wall(a, b, zbot, opens, bottom=None):
        ux, uy = b[0] - a[0], b[1] - a[1]
        L = math.hypot(ux, uy)
        ops = []
        for o in opens:
            o = dict(o)
            o["t"] = (o["c"] - a[0]) / (ux / L) if abs(ux) > abs(uy) else (o["c"] - a[1]) / (uy / L)
            if o["t"] - o["w"] / 2 < 0.25 or o["t"] + o["w"] / 2 > L - 0.25:
                print("WARNING opening off the wall: %s %s c=%.2f (wall %.2f long)" % (S.get("name", "?"), a, o["c"], L))
                continue
            if o["kind"] in ("door", "barn"):
                o["sill"] = zbot
            ops.append(o)
        w = Wall(a, b, roofs, S["wall"], zbot, ops)
        if bottom:
            w.bottom = bottom
        w.tag = S.get("name", "?")
        walls.append(w)

    for i in range(n):
        make_wall(outline[i], outline[(i + 1) % n], zb, S.get("open", {}).get(i, []))
    for we in S.get("walls_extra", []):       # interior steps: a wall rising above a lower roof (optional sloped bottom [(t, z), ...])
        make_wall(*we)
    for w in walls:
        w.build(g)
    corner_boards(g, roofs, outline, zb)
    eaves = roofs.build(g, S["tile"], WHITE, WHITE, S.get("cap", S["tile"]), S.get("ridge_w", 0.22))
    if S.get("gutters", True):
        for a, b, z, ox, oy in eaves:
            if math.hypot(b[0] - a[0], b[1] - a[1]) > 1.5:
                gutter(g, a, b, z, ox, oy, roofs.thick)
    for c in S.get("chimneys", []):
        chimney(g, *c)
    if "extra" in S:
        S["extra"](g, roofs, walls)
    for w in walls:
        for o in w.openings:
            if o["kind"] == "door" and o.get("steps", True):
                step(g, w, o["t"], o["w"] + 0.5, [(0.45, zb - 0.02), (0.8, zb * 0.5)], sink)
    return roofs


def rect_outline(x0, x1, y0, y1):
    return [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]


# ---------------------------------------------------------------------------------------------
# Ground and placement
# ---------------------------------------------------------------------------------------------
def pip(poly, x, y):
    c = np.zeros(len(x), bool)
    for i in range(len(poly)):
        p, q = poly[i], poly[(i + 1) % len(poly)]
        m = ((p[1] > y) != (q[1] > y)) & (x < p[0] + (y - p[1]) / (q[1] - p[1] + 1e-12) * (q[0] - p[0]))
        c ^= m
    return c


def grow(poly, d):
    cx = np.mean([p[0] for p in poly])
    cy = np.mean([p[1] for p in poly])
    out = []
    for p in poly:
        v = np.array([p[0] - cx, p[1] - cy])
        out.append((p[0] + d * v[0] / np.linalg.norm(v), p[1] + d * v[1] / np.linalg.norm(v)))
    return out


class Site:
    """One building's frame (the OSM rectangle's) plus ground sampling."""

    def __init__(self, ev, osm_id):
        f = ev.osm[osm_id]
        self.ev, self.id = ev, osm_id
        r = f["properties"]["rect"]
        self.cx, self.cy, self.ang = r["cx"], r["cy"], r["angleDeg"]
        t = math.radians(self.ang)
        self.c, self.s = math.cos(t), math.sin(t)
        self.poly = [tuple(c) for c in f["geometry"]["coordinates"][0][:-1]]
        pts = ev.points
        ring = pip(grow(self.poly, 4.0), pts[:, 0], pts[:, 1]) & ~pip(grow(self.poly, 0.8), pts[:, 0], pts[:, 1]) & (pts[:, 3] == 2)
        self.ground = float(np.median(pts[ring, 2]))

    def en(self, x, y):
        return self.cx + x * self.c - y * self.s, self.cy + x * self.s + y * self.c

    @property
    def yaw(self):
        return (90 - self.ang) % 360

    def sink(self, outline, margin=1.5):
        """Plinth depth: a little under the lowest course terrain (the outer edited DEM, which Unity uses) under the
        footprint and its surroundings, relative to the placement ground."""
        xs = [p[0] for p in outline]
        ys = [p[1] for p in outline]
        lo = 1e9
        for x in np.linspace(min(xs) - margin, max(xs) + margin, 14):
            for y in np.linspace(min(ys) - margin, max(ys) + margin, 14):
                e, n = self.en(x, y)
                lo = min(lo, self.ev.terrain(e, n))
        return min(lo - self.ground, 0.0) - 0.4

    def place(self, add, aid, g):
        add(aid, g, self.cx, self.cy, self.yaw, self.ground)


# ---------------------------------------------------------------------------------------------
# Buildings. Frame: OSM rectangle (x = u along its long axis, y = v to its left); z above the ring ground.
# `Z(zabs)` turns an absolute lidar height into z above that ground.
# ---------------------------------------------------------------------------------------------
BUILDINGS = {}


def building(osm, aid):
    def deco(fn):
        BUILDINGS[osm] = (aid, fn)
        return fn
    return deco


def long_wall_windows(ts, **kw):
    return [win(t, **kw) for t in ts]


def gx(y0, z, p, x0, x1, hn, hs, ovh=0.45, ovx=None, **kw):
    """Gable with the ridge along x at y0 (z: ridge height above ground), roof outline x0..x1 along the ridge and hn / hs
    across it (north = +y side hn, south = -y side hs)."""
    ovx = ovh if ovx is None else ovx
    return gab_x(y0, z, p, (x0, x1, y0 - hs, y0 + hn), (ovx, ovx, ovh, ovh), **kw)


def walls_of(pc):
    return pc["wrect"]


# ---- 1109749341: the long orange-roofed building (lidar: plane fits n=96/82, rms 0.056)
@building("1109749341", "omberg_bg_west_long_orange")
def b341(S, Z):
    # ridge v=-0.43, z 120.65, pitch 0.80 (fits 0.804 / 0.796); outline: lidar along extent -8.8..7.7, half width = OSM 3.71
    pc = gx(-0.43, Z(120.65), 0.80, -8.75, 7.75, 3.74, 3.74, 0.45, 0.4)
    x0, x1, y0, y1 = walls_of(pc)
    return dict(name="341", outline=rect_outline(x0, x1, y0, y1), pieces=[pc], tile="roof_tile_orange", wall=RED, thick=0.15, zb=0.35,
                chimneys=[(-2.3, -0.9, Z(120.65) - 1.4, Z(121.35) - 0.2, 0.7, 0.9)],        # three returns 1.2 m above the slope near u=-2.3
                open={0: [win(-5.0), win(-1.6), win(1.8), win(5.0)],                 # south long wall (inferred row)
                      2: [win(-5.0), win(-1.6), win(1.8), door(5.2)],
                      1: [win(-0.4, 0.8, 0.9, 1.5)], 3: [win(-0.4, 0.8, 0.9, 1.5)]},
)


# ---- 1109749340: small orange building north of it (fits n=28/27)
@building("1109749340", "omberg_bg_west_small_orange_n")
def b340(S, Z):
    pc = gx(-0.18, Z(118.98), 0.71, -4.3, 2.9, 2.95, 2.95, 0.4, 0.35)
    x0, x1, y0, y1 = walls_of(pc)
    return dict(name="340", outline=rect_outline(x0, x1, y0, y1), pieces=[pc], tile="roof_tile_orange", wall=RED, thick=0.15, zb=0.3,
                open={0: [win(-1.0, 0.9, 1.1, 0.9)], 2: [win(-1.0, 0.9, 1.1, 0.9), door(0.9, 0.9, 1.9)],
                      1: [win(-0.2, 0.7, 0.8, 1.3)], 3: [win(-0.2, 0.7, 0.8, 1.3)]})


# ---- 1109749342: the dark-tile outbuilding south of the main house (fits n=56/49)
@building("1109749342", "omberg_bg_west_outbuilding_s")
def b342(S, Z):
    pc = gx(-0.85, Z(121.22), 0.67, -6.65, 4.55, 3.53, 3.53, 0.45, 0.4)
    x0, x1, y0, y1 = walls_of(pc)
    return dict(name="342", outline=rect_outline(x0, x1, y0, y1), pieces=[pc], tile="bgw_tile_brown", wall=RED, thick=0.15, zb=0.3,
                open={0: [win(-3.5, 1.0, 1.0, 1.0), win(0.5, 1.0, 1.0, 1.0)], 2: [win(-3.5, 1.0, 1.0, 1.0), door(-0.8, 1.0, 2.0), win(2.2, 1.0, 1.0, 1.0)],
                      1: [win(-0.8, 0.7, 0.8, 1.4)], 3: [win(-0.8, 0.7, 0.8, 1.4)]})


# ---- 1109749334, 1109749335: the two dark-roofed sheds east of the yard (fits n=62/54, n=29/26)
@building("1109749334", "omberg_bg_west_shed_e1")
def b334(S, Z):
    pc = gx(0.42, Z(120.62), 0.687, -4.85, 5.35, 3.79, 3.79, 0.4, 0.35, tile="bgw_sheet_dark")
    x0, x1, y0, y1 = walls_of(pc)
    return dict(name="334", outline=rect_outline(x0, x1, y0, y1), pieces=[pc], tile="bgw_sheet_dark", wall=RED, thick=0.1, zb=0.25,
                open={0: [barn_door(-0.5, 2.6, 2.4, "door_black")], 2: [win(-1.5, 0.8, 0.8, 1.2), win(1.5, 0.8, 0.8, 1.2)]})


@building("1109749335", "omberg_bg_west_shed_e2")
def b335(S, Z):
    pc = gx(-0.45, Z(119.40), 0.734, -3.5, 4.0, 2.5, 2.5, 0.35, 0.3, tile="bgw_sheet_dark")
    x0, x1, y0, y1 = walls_of(pc)
    return dict(name="335", outline=rect_outline(x0, x1, y0, y1), pieces=[pc], tile="bgw_sheet_dark", wall=RED, thick=0.1, zb=0.25,
                open={2: [door(0.6, 0.9, 1.9)], 0: [win(0.5, 0.7, 0.7, 1.2)]})


# ---- 1109749338: machinery shed, shallow roof; the lit east slope returns (n=85, 19.2 deg), the west slope is black sheet
@building("1109749338", "omberg_bg_west_shed_s")
def b338(S, Z):
    # ridge v=+0.1, z 119.68 (OSM ridge tag 6.3 m above ground agrees), pitch 0.348; west slope no returns: mirrored (inferred)
    pc = gx(0.1, Z(119.68), 0.348, -7.1, 6.0, 4.85, 4.85, 0.4, 0.4, mats=["bgw_sheet_black", "bgw_sheet_pale"])
    x0, x1, y0, y1 = walls_of(pc)
    return dict(name="338", outline=rect_outline(x0, x1, y0, y1), pieces=[pc], tile="bgw_sheet_pale", wall=RED, thick=0.1, zb=0.3,
                open={3: [barn_door(0.1, 3.6, 3.2, "door_black")], 1: [win(0.1, 0.9, 0.9, 2.2)],
                      2: [win(-4.0, 1.0, 0.9, 1.6), win(-1.0, 1.0, 0.9, 1.6), win(2.0, 1.0, 0.9, 1.6), win(4.6, 1.0, 0.9, 1.6)]})


# ---- 1431566971: small orange house west of the farm house (fits n=33/29)
@building("1431566971", "omberg_bg_west_small_orange_w")
def b971(S, Z):
    pc = gx(-0.85, Z(119.72), 0.72, -4.85, 3.75, 2.78, 2.78, 0.4, 0.35)
    x0, x1, y0, y1 = walls_of(pc)
    return dict(name="971", outline=rect_outline(x0, x1, y0, y1), pieces=[pc], tile="roof_tile_orange", wall=RED, thick=0.15, zb=0.3,
                open={0: [win(-2.0, 0.9, 1.1, 0.95), win(1.0, 0.9, 1.1, 0.95)], 2: [door(-2.4, 0.95, 2.0), win(0.6, 0.9, 1.1, 0.95)],
                      1: [win(-0.5, 0.7, 0.8, 1.3)], 3: [win(-0.5, 0.7, 0.8, 1.3)]})


# ---- 1431566973: small shed south of the west barn (fits n=46/34)
@building("1431566973", "omberg_bg_west_shed_w")
def b973(S, Z):
    pc = gx(-0.76, Z(120.54), 0.756, -3.7, 4.2, 3.35, 3.35, 0.4, 0.35)
    x0, x1, y0, y1 = walls_of(pc)
    return dict(name="973", outline=rect_outline(x0, x1, y0, y1), pieces=[pc], tile="bgw_fc", wall=RED, thick=0.1, zb=0.25,
                open={0: [win(-1.8, 0.9, 0.9, 1.1), win(1.4, 0.9, 0.9, 1.1)], 2: [door(-1.6, 0.9, 1.9), win(1.6, 0.9, 0.9, 1.1)]})


# ---- 1109749336: the big L-shaped barn. Four planes fitted (n=350/263/252/250, rms 0.056, pitch 0.866 = 40.9 deg), equal
# ridge heights 124.43 / 124.45: the north-east wing runs along v at u=11.0, the south wing along u at v=8.1, a plain union
# of two gables with the valleys on the plane intersections. Roof outline from the returns (south end u=-16.95, west eave
# flush with the north wing's west rake at v=15.7, east gable v=-16.3, north edge u=18.6).
@building("1109749336", "omberg_bg_west_l_barn")
def b336(S, Z):
    R, p = Z(124.44), 0.866
    ew = gab_y(11.0, R, p, (3.4, 18.6, -16.3, 15.7), 0.5, mats=["bgw_sheet_pale", "bgw_sheet_pale"])
    ns = gab_x(8.1, R, p, (-16.95, 11.0, 0.5, 15.7), (0.5, 0.0, 0.5, 0.5), mats=["bgw_fc", "bgw_fc"])
    out = [(-16.45, 1.0), (3.9, 1.0), (3.9, -15.8), (18.1, -15.8), (18.1, 15.2), (-16.45, 15.2)]

    def extra(g, roofs, walls):
        # solar array on the north wing's sunny (south) slope: 12.8 m along the roof, 5.4 m up the slope, set 1.6 m in from the
        # east gable (ortho; the lean-corrected panel edges), 0.9 m under the ridge
        solar_array(g, (p, 0, R - p * 11.0), 4.7, 10.1, -14.6, -1.8)
    return dict(name="336", outline=out, pieces=[ew, ns], tile="bgw_sheet_pale", wall=RED, thick=0.12, zb=0.35, extra=extra, ridge_w=0.26,
                open={0: [barn_door(-11.0, 3.6, 3.8, "door_black"), barn_door(-4.0, 3.6, 3.8, "door_black"), win(-14.4, 0.9, 0.9, 2.2)],
                      1: [barn_door(-9.0, 4.0, 3.8, "door_black"), win(-4.5, 1.0, 0.9, 2.2)],
                      2: [win(11.0, 1.0, 1.0, 7.8)],
                      3: [win(y, 1.0, 0.9, 2.2) for y in (-12.0, -8.0, -4.0, 0.0, 4.0, 8.0, 12.0)],
                      4: [win(x, 1.0, 0.9, 2.2) for x in (14.0, 8.0, 2.0, -3.0, -8.0, -13.0)],
                      5: [barn_door(8.1, 4.4, 4.2, "door_black"), win(3.2, 0.9, 0.9, 2.2), win(13.0, 0.9, 0.9, 2.2), win(8.1, 1.0, 1.0, 8.0)]})


# ---- 1109749343: the big west barn, a T of two gables (n=212/168/162/146, rms 0.05, pitch 0.9 = 42 deg), ridges 124.85 /
# 124.88 (equal): long wing along u at v=6.1, east arm along v at u=-0.23. Walls = the OSM outline sheared onto the lidar
# ridges; the roof outline from the returns (+0.35).
@building("1109749343", "omberg_bg_west_barn")
def b343(S, Z):
    R, p = Z(124.86), 0.90
    ns = gab_x(6.1, R, p, (-13.15, 12.85, -0.35, 12.55), (0.45, 0.45, 0.5, 0.5), mats=["bgw_fc", "bgw_fc"])
    ew = gab_y(-0.23, R, p, (-6.58, 6.12, -13.7, 6.1), (0.5, 0.5, 0.45, 0.0), mats=["bgw_fc", "bgw_fc"])
    out = [(-12.7, 0.15), (-6.08, 0.15), (-6.08, -13.25), (5.62, -13.25), (5.62, 0.15), (12.4, 0.15), (12.4, 12.05), (-12.7, 12.05)]
    return dict(name="343", outline=out, pieces=[ns, ew], tile="bgw_fc", wall=RED, thick=0.12, zb=0.35, ridge_w=0.26,
                open={0: [barn_door(-9.4, 3.2, 3.4, "door_black")],
                      1: [win(y, 1.0, 0.9, 2.1) for y in (-3.0, -7.0, -11.0)],
                      2: [barn_door(-0.23, 3.6, 3.4, "door_black"), win(-0.23, 1.0, 1.0, 7.4)],
                      3: [win(y, 1.0, 0.9, 2.1) for y in (-11.0, -7.0, -3.0)],
                      4: [win(x, 1.0, 0.9, 2.1) for x in (8.0, 11.0)],
                      5: [win(3.0, 1.0, 0.9, 2.1), win(9.0, 1.0, 0.9, 2.1), win(6.1, 1.0, 1.0, 7.4)],
                      6: [win(x, 1.0, 0.9, 2.1) for x in (9.0, 5.0, 1.0, -3.0, -7.0, -11.0)],
                      7: [barn_door(6.1, 3.4, 3.4, "door_black")]})


# ---- 1109749337: the long black-roofed building. No lidar returns on the black sheet except ~24 on the west slope (plane
# z=118.566-0.546 v, v -0.6..4.2): ridge v=-0.8 / z 119.0, pitch 0.546, eave 3.4 m above ground - inferred for the rest.
# OSM outline moved by the lidar shift (0.8 m east, 0.7 m south). The 4.5 x 2.3 m notch of the polygon at its south-west corner
# is ignored (the roof covers it).
@building("1109749337", "omberg_bg_west_long_dark")
def b337(S, Z):
    pc = gx(-0.8, Z(119.0), 0.546, -13.4, 12.0, 5.3, 5.3, 0.45, 0.45)
    x0, x1, y0, y1 = walls_of(pc)
    return dict(name="337", outline=rect_outline(x0, x1, y0, y1), pieces=[pc], tile="bgw_sheet_black", wall=RED, thick=0.1, zb=0.3, ridge_w=0.24,
                open={0: [barn_door(-9.0, 3.2, 2.7, "door_black"), barn_door(-3.0, 3.2, 2.7, "door_black"), barn_door(4.0, 3.2, 2.7, "door_black"), win(9.5, 1.0, 0.9, 1.5)],
                      1: [win(-0.8, 0.9, 0.9, 2.0)],
                      2: [win(x, 1.0, 0.9, 1.5) for x in (9.0, 4.0, -1.0, -6.0, -11.0)],
                      3: [barn_door(-0.8, 3.0, 2.6, "door_black")]})


# ---- 1109749339: the two-storey farm house: gable (ridge v=+0.73, z 122.38, pitch 0.69; n=110/62), a shed dormer on the
# south slope (plane z=122.0-0.188 v, 5.5 m wide, flush with the eave wall), two chimneys (returns 1.0 m above the north
# slope at u=-4.0 and +1.0). Frame: x = u points west, y = v points south (rect angle 180).
@building("1109749339", "omberg_bg_west_farmhouse")
def b339(S, Z):
    R, p, y0 = Z(122.38), 0.69, 0.73
    main = gx(y0, R, p, -8.35, 6.55, 4.55, 5.2, 0.45, 0.4)
    xa, xb = -4.2, 1.3                                  # dormer walls (lidar u -3.9..1.1 +- the sparse edge)
    zd = Z(122.002)
    yf = main["wrect"][3]                               # eave wall = dormer front wall
    dorm = mono_y(zd, 0.0, -0.188, (xa - 0.25, xb + 0.25, 1.0, yf + 0.4), (0.25, 0.25, 0.0, 0.4), cover="wrect")
    x0, x1, y0w, y1w = main["wrect"]
    out = rect_outline(x0, x1, y0w, y1w)
    dthick = 0.15 * math.sqrt(1 + 0.188 ** 2)

    def extra(g, roofs, walls):
        zm = lambda y: R - p * (y - y0)                 # main south plane top
        zdu = lambda y: zd - 0.188 * y - dthick         # dormer underside
        ym = (R + p * y0 - zd + dthick) / (p - 0.188)   # where the underside meets the main slope
        for x, nx in ((xa, -1), (xb, 1)):               # cheeks between the front wall, the slope and the dormer underside
            quad_n(g, [(x, yf, zm(yf) - 0.05), (x, ym, zm(ym)), (x, yf, zdu(yf))], (nx, 0, 0), "bgw_wall_yellow")
    chim = [(-4.0, 0.45, R - p * 0.3 - 0.5, R + 0.65, 0.9, 0.9), (1.0, 0.45, R - p * 0.3 - 0.5, R + 0.65, 0.9, 0.9)]
    return dict(name="339", outline=out, pieces=[main, dorm], tile="bgw_tile_red", wall="bgw_wall_yellow", thick=0.15, zb=0.4, extra=extra, chimneys=chim,
                open={0: [win(x, 1.0, 1.3, 0.95) for x in (-6.2, -3.4, 3.2, 5.2)] + [door(0.0, 1.1, 2.2)] +
                         [win(x, 0.9, 1.0, 2.75) for x in (-6.2, -3.4, 0.0, 3.2, 5.2)],
                      2: [win(x, 1.0, 1.3, 0.95) for x in (-6.2, -3.8, 2.4, 4.8)] + [door(-1.45, 1.1, 2.2)] +
                         [win(x, 0.9, 1.0, 2.75) for x in (-6.2, -3.8, 2.4, 4.8)] + [win(-2.5, 1.0, 0.95, 4.5), win(-0.4, 1.0, 0.95, 4.5)],
                      1: [win(-1.8, 1.0, 1.3, 0.95), win(2.2, 1.0, 1.3, 0.95), win(0.4, 0.8, 1.0, 4.8), win(0.4, 0.9, 1.0, 2.75)],
                      3: [win(-1.8, 1.0, 1.3, 0.95), win(2.2, 1.0, 1.3, 0.95), win(0.4, 0.8, 1.0, 4.8), win(0.4, 0.9, 1.0, 2.75)]})


# ---- 1109741328: the west house: main gable ridge v=+1.14 / z 121.73 / pitch 0.835 (n=97/57, rms 0.05), a taller two-storey
# cross wing on its south side with a shallower roof (east plane fitted z=121.647-0.464u, rms 0.047; ridge u=+0.55, z 121.39;
# the west plane is noisy), valleys on the plane intersections; chimneys from the residual grid (returns 0.8-1.4 m above the
# north slope at u=-1.5 and 3). A low black-sheet lean-to against the east gable (5 returns at 117.6-118.1, falling east at
# 0.18; the OSM polygon stops at the gable) is built as a mono roof, its extent from the ortho.
@building("1109741328", "omberg_bg_west_house")
def b328(S, Z):
    R = Z(121.73)
    main = gx(1.14, R, 0.835, -7.4, 8.1, 4.46, 4.44, 0.45, 0.4, cover="wrect")
    wing = gab_y(0.55, Z(121.39), 0.464, (-3.4, 3.4, -6.2, 1.14), (0.45, 0.45, 0.45, 0.0))
    za = Z(118.18)
    zm = lambda y: R - 0.835 * (1.14 - y)
    annex = piece([(-0.18, 0, za + 0.18 * 7.7)], (7.7, 12.3, -2.9, 2.9), (0.0, 0.5, 0.0, 0.0), mats=["bgw_sheet_black"])
    out = [(-7.0, -2.85), (-2.85, -2.85), (-2.85, -5.75), (2.85, -5.75), (2.85, -2.85), (11.8, -2.85), (11.8, 2.9), (7.7, 2.9), (7.7, 5.15), (-7.0, 5.15)]
    return dict(name="328", outline=out, pieces=[main, wing, annex], tile="roof_tile_orange", wall="bgw_wall_white", thick=0.15, zb=0.4,
                walls_extra=[((7.7, -2.85), (7.7, 2.9), za - 0.05, [win(1.14, 0.8, 0.9, 5.2)]),      # the east gable above the lean-to
                             # the wing's side walls above the main south slope (zm: its top surface, 0.1 buried)
                             ((2.85, -2.85), (2.85, 1.14), 0, [], [(0.0, zm(-2.85) - 0.1), (3.99, zm(1.14) - 0.1)]),
                             ((-2.85, 1.14), (-2.85, -2.85), 0, [], [(0.0, zm(1.14) - 0.1), (3.99, zm(-2.85) - 0.1)])],
                chimneys=[(-1.5, 1.4, R - 1.2, R + 0.75, 0.8, 0.8), (3.0, 1.4, R - 1.2, R + 0.8, 0.8, 0.8)],
                open={0: [win(-5.0, 1.0, 1.3, 0.95)],
                      1: [win(-4.2, 1.0, 1.3, 0.95), win(-4.2, 0.9, 1.1, 3.0)],
                      2: [win(-1.4, 1.0, 1.3, 0.95), door(1.1, 1.0, 2.1), win(-1.4, 1.0, 1.1, 3.0), win(1.1, 1.0, 1.1, 3.0)],
                      3: [win(-4.2, 1.0, 1.3, 0.95), win(-4.2, 0.9, 1.1, 3.0)],
                      4: [win(5.2, 1.0, 1.1, 0.95)],
                      5: [door(0.0, 0.9, 1.9)],
                      6: [win(9.2, 1.0, 1.0, 0.95)],
                      7: [win(4.0, 1.0, 1.3, 0.95)],
                      8: [win(x, 1.0, 1.3, 0.95) for x in (6.0, 3.0, 0.0, -3.0, -5.8)],
                      9: [win(1.0, 1.0, 1.3, 0.95), win(1.0, 0.8, 0.9, 3.0)]})


# ---- 1431566970: small house in the trees north-west of the farm (n=41/38; weakest fit: tree-covered, lidar on the roof only
# at gaps): ridge along v at u=-1.07 (z 119.98, pitch 0.65). The heart-shaped OSM polygon is a mapper artefact (the returns
# cover its notch), so it is a plain gable. Ground slopes 0.18 m/m east: the plinth is sunk to the lowest DEM.
@building("1431566970", "omberg_bg_west_cabin_nw")
def b970(S, Z):
    pc = gab_y(-1.07, Z(119.98), 0.65, (-5.37, 3.23, -4.45, 3.85), (0.4, 0.4, 0.35, 0.35))
    x0, x1, y0, y1 = pc["wrect"]
    return dict(name="970", outline=rect_outline(x0, x1, y0, y1), pieces=[pc], tile="bgw_tile_brown", wall=RED, thick=0.15, zb=0.5,
                open={0: [win(-2.0, 0.9, 1.0, 1.0)], 2: [win(-2.0, 0.9, 1.0, 1.0), door(0.4, 0.95, 1.9)],
                      1: [win(-0.3, 0.8, 0.7, 0.75)], 3: [win(-0.3, 0.8, 0.7, 0.75)]})


def build(add, new, ev):
    for osm, (aid, fn) in BUILDINGS.items():
        S = Site(ev, osm)
        spec = fn(S, lambda z: z - S.ground)
        g = new()
        sink = S.sink(spec["outline"])
        build_building(g, spec, sink)
        print("west %s ground %.2f plinth sunk to %.2f (z %.2f abs)" % (spec["name"], S.ground, sink, S.ground + sink))
        S.place(add, aid, g)
