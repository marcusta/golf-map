"""Farm dwellings: the manor house (OSM 1431566968) and the red east house (OSM 1431566962).

Both are built from the same small toolkit: roofs are unions of planar pieces (gable/hip/mono/flat),
cut against each other so valleys, hips and ridges fall on the true plane intersections; walls follow
the roof underside exactly (gable triangles close up, steps between roof levels get their own wall);
windows sit in real reveals. Evidence: lidar planes (data/omberg-farm/lidar-crop.npz), ortho 2023/2025
(parallax-corrected), Street View 6.webp. Heights are metres above the placement ground.
"""
import math

from mathutils import Matrix, Vector
import props_kit as kit

MATTE = {"wall_white_panel", "white_trim", "plaster_white", "roof_pale_metal", "roof_dark_seam", "roof_tile_graphite"}
EPS = 1e-6
OVH = 0.4          # one overhang on every eave and rake (the manor's cross wings have flush gable ends: lidar)
THICK = 0.14       # roof slab thickness (fascia height)
Z_PL = 0.5         # top of the plinth = bottom of the wall panels
SINK = -1.2        # foundation depth under the placement ground


def register_materials():
    M = kit.MATERIALS
    # ortho 2025 calibrated (check_survey): main dark roofs (80,91,107), east house tile (99,104,113): blue-grey sheet / concrete tile
    M["roof_dark_seam"] = ("seam:80,90,104:0.52:2.08:0", (2.08, 2.08), None, 0.3, 0.2)
    M["roof_tile_graphite"] = ("pantile:100,104,112", (2.0, 2.0), None, 0.2, 0.0)
    # the pale wing roofs read white (blown out in 2025, light blue-grey 210,228,232 in 2023): light seamed sheet,
    # kept below the white clip of the course light
    M["roof_pale_metal"] = ("seam:176,179,182:0.52:2.08:0", (2.08, 2.08), None, 0.2, 0.1)
    M["wall_white_panel"] = ("boards:168,164,150:v:0.16:2.0:2", (2.0, 2.0), None, 0.1, 0.0)
    M["plaster_white"] = ("plaster:170,166,158", (2.0, 2.0), None, 0.1, 0.0)
    M["membrane_light"] = (None, (1, 1), (128, 130, 130), 0.1, 0.0)


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


# ---------------------------------------------------------------------------------------------
# Roofs: a union of pieces; each piece is the lower envelope (min) of its planes inside a rectangle
# ---------------------------------------------------------------------------------------------

def gable_x(y0, z0, p, wx0, wx1, wy0, wy1, ovh=OVH, **kw):
    """Gable with a level ridge along x at y=y0 (height z0), pitch p, walls rectangle wx0..wx1 x wy0..wy1."""
    d = dict(planes=[(0, -p, z0 + p * y0), (0, p, z0 - p * y0)], wrect=(wx0, wx1, wy0, wy1),
             rect=(wx0 - ovh, wx1 + ovh, wy0 - ovh, wy1 + ovh))
    d.update(kw)
    return d


def gable_y(x0, z0, p, wx0, wx1, wy0, wy1, ovh=OVH, **kw):
    d = dict(planes=[(-p, 0, z0 + p * x0), (p, 0, z0 - p * x0)], wrect=(wx0, wx1, wy0, wy1),
             rect=(wx0 - ovh, wx1 + ovh, wy0 - ovh, wy1 + ovh))
    d.update(kw)
    return d


def mansard(wx0, wx1, wy0, wy1, sides, zr=7.2, zb=6.1, rb=2.1, p2=1.1, ovh=OVH, **kw):
    """Broken (mansard) roof, the 'saeteritak' of a manor: steep lower pitch p2 from the eave up to the break
    height zb, shallow upper pitch up to the level ridge zr; rb = horizontal distance of the break from the ridge.
    z = F(distance to the nearest wall in `sides`), F concave, so a min over per-wall planes. sides: letters W E S N."""
    p1 = (zr - zb) / rb
    hw = min(wx1 - wx0, wy1 - wy0) / 2 if len(sides) == 4 else ((wy1 - wy0) if "N" in sides else (wx1 - wx0)) / 2
    db = hw - rb
    planes = []
    for w in sides:
        # d = distance from wall w, as a plane in x, y
        a, b, c0 = {"W": (1, 0, -wx0), "E": (-1, 0, wx1), "S": (0, 1, -wy0), "N": (0, -1, wy1)}[w]
        ze = zb - p2 * db
        planes.append((p2 * a, p2 * b, ze + p2 * c0))
        planes.append((p1 * a, p1 * b, zb - p1 * db + p1 * c0))
    d = dict(planes=planes, wrect=(wx0, wx1, wy0, wy1), rect=(wx0 - ovh, wx1 + ovh, wy0 - ovh, wy1 + ovh))
    d.update(kw)
    return d


def mono(z_at, slope_x, wx0, wx1, wy0, wy1, ovh=OVH, **kw):
    """One plane z = z_at + slope_x * (x - wx0)."""
    d = dict(planes=[(slope_x, 0, z_at - slope_x * wx0)], wrect=(wx0, wx1, wy0, wy1),
             rect=(wx0 - ovh, wx1 + ovh, wy0 - ovh, wy1 + ovh))
    d.update(kw)
    return d


def mono_y(z_at, slope_y, wx0, wx1, wy0, wy1, ovh=OVH, **kw):
    """One plane z = z_at + slope_y * (y - wy0)."""
    d = dict(planes=[(0, slope_y, z_at - slope_y * wy0)], wrect=(wx0, wx1, wy0, wy1),
             rect=(wx0 - ovh, wx1 + ovh, wy0 - ovh, wy1 + ovh))
    d.update(kw)
    return d


def flat(z, wx0, wx1, wy0, wy1, **kw):
    d = dict(planes=[(0, 0, z)], wrect=(wx0, wx1, wy0, wy1), rect=(wx0, wx1, wy0, wy1))
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

    def build(self, g, top, under, edge, cap, gutter, ridge_w=0.2):
        """Top planes, undersides, fascia (boundary edges), ridge/hip caps; returns gutter edges [(a, b, z, nx, ny)]."""
        thick = THICK
        gutters, caps, seen = [], [], set()
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
                        gutters.append((a, b, a[2], ox, oy))
                else:
                    key = tuple(sorted([(round(a[0], 3), round(a[1], 3), round(a[2], 3)), (round(b[0], 3), round(b[1], 3), round(b[2], 3))]))
                    if key in seen:
                        continue
                    seen.add(key)
                    # ridge/hip: both sides fall away from the edge; valley: both rise
                    px, py = -oy, ox
                    zc = (a[2] + b[2]) / 2
                    zl = self.z(mx + ox * 0.15, my + oy * 0.15)
                    zr = self.z(mx - ox * 0.15, my - oy * 0.15)
                    if zl is not None and zr is not None and zl < zc - 0.03 and zr < zc - 0.03:
                        caps.append((a, b))
        for a, b in caps:
            # level ridges and 45-degree hips get a cap board; the board follows the edge exactly
            d = (Vector(b) - Vector(a))
            g.beam((a[0], a[1], a[2] + 0.035), (b[0], b[1], b[2] + 0.035), ridge_w, 0.07, cap)
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
    prof = simplify(prof)
    # make sure the profile starts at 0 and ends at L
    return prof


class Wall:
    def __init__(self, a, b, roofs, mat, zb=Z_PL, bottom=None, openings=(), embed=0.05, top=None):
        self.a, self.b = Vector((a[0], a[1], 0)), Vector((b[0], b[1], 0))
        self.L = (self.b - self.a).length
        self.u = (self.b - self.a) / self.L
        self.n = Vector((self.u.y, -self.u.x, 0))
        self.mat = mat
        self.top = top or wall_profile(roofs, a, b, embed)
        self.bottom = bottom or [(0.0, zb), (self.L, zb)]
        self.openings = list(openings)

    def P(self, t, z, d=0.0):
        return (self.a.x + self.u.x * t + self.n.x * d, self.a.y + self.u.y * t + self.n.y * d, z)

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

    def top_at(self, t):
        for t0, z0, t1, z1 in segs_of(self.top):
            if t0 - 1e-6 <= t <= t1 + 1e-6:
                return z0 + (z1 - z0) * (t - t0) / (t1 - t0)
        return None

    def frame(self, t):
        u, n = self.u, self.n
        return Matrix(((u.x, 0, n.x, self.a.x + u.x * t), (u.y, 0, n.y, self.a.y + u.y * t), (0, 1, 0, 0), (0, 0, 0, 1)))

    def opening(self, g, o):
        kind = o.get("kind", "window")
        w, h, sill = o["w"], o["h"], o["sill"]
        d = 0.13
        trim = "white_trim"
        g.push(self.frame(o["t"]))
        hw = w / 2
        # reveals (inside faces of the recess)
        def q(pts, nrm):
            P = [Vector(p) for p in pts]
            nn = (P[1] - P[0]).cross(P[2] - P[1])
            g.poly([tuple(p) for p in (P if nn.dot(Vector(nrm)) > 0 else P[::-1])], trim)
        q([(-hw, sill, 0), (-hw, sill + h, 0), (-hw, sill + h, -d), (-hw, sill, -d)], (1, 0, 0))
        q([(hw, sill, 0), (hw, sill + h, 0), (hw, sill + h, -d), (hw, sill, -d)], (-1, 0, 0))
        q([(-hw, sill + h, 0), (hw, sill + h, 0), (hw, sill + h, -d), (-hw, sill + h, -d)], (0, -1, 0))
        q([(-hw, sill, 0), (hw, sill, 0), (hw, sill, -d), (-hw, sill, -d)], (0, 1, 0))
        zf = -d + 0.06
        fw, mw, dep = 0.065, 0.035, 0.05
        cols, rows = o.get("bars", (2, 3))
        if kind in ("door", "gdoor"):
            leaf = o.get("mat", "door_white")
            if kind == "door":
                g.poly([(-hw, sill, zf), (hw, sill, zf), (hw, sill + h, zf), (-hw, sill + h, zf)], leaf)
                # raised panels (2 lower, glazed top light)
                pw = (w - 3 * 0.16) / 2
                for sx in (-1, 1):
                    g.box((sx * (pw / 2 + 0.08), sill + 0.55, zf + 0.012), (pw, 0.8, 0.024), leaf)
                    g.poly([(sx * (pw / 2 + 0.08) - pw / 2 + 0.01, sill + h - 0.95, zf + 0.004), (sx * (pw / 2 + 0.08) + pw / 2 - 0.01, sill + h - 0.95, zf + 0.004),
                            (sx * (pw / 2 + 0.08) + pw / 2 - 0.01, sill + h - 0.18, zf + 0.004), (sx * (pw / 2 + 0.08) - pw / 2 + 0.01, sill + h - 0.18, zf + 0.004)], "glass")
                g.box((hw - 0.14, sill + 1.0, zf + 0.04), (0.04, 0.12, 0.04), "chrome")
            else:
                g.poly([(-hw, sill, zf), (hw, sill, zf), (hw, sill + h, zf), (-hw, sill + h, zf)], "glass")
                g.box((hw - 0.14, sill + 1.0, zf + 0.04), (0.04, 0.12, 0.04), "chrome")
        else:
            g.poly([(-hw, sill, zf), (hw, sill, zf), (hw, sill + h, zf), (-hw, sill + h, zf)], "glass")
        # sash frame and glazing bars (proud of the glass inside the reveal)
        for cx, cy, sx, sy in [(0, sill + h - fw / 2, w, fw), (0, sill + fw / 2, w, fw), (-hw + fw / 2, sill + h / 2, fw, h), (hw - fw / 2, sill + h / 2, fw, h)]:
            g.box((cx, cy, zf + dep / 2), (sx, sy, dep), trim, skip=("bottom",))
        for i in range(1, cols):
            g.box((-hw + w * i / cols, sill + h / 2, zf + dep / 2 - 0.005), (mw, h - 2 * fw, dep - 0.01), trim, skip=("bottom",))
        for j in range(1, rows):
            if kind == "door":
                break
            g.box((0, sill + h * j / rows, zf + dep / 2 - 0.005), (w - 2 * fw, mw, dep - 0.01), trim, skip=("bottom",))
        # surround: casing boards, head cornice, sill
        cw = 0.12
        for sx in (-1, 1):
            g.box((sx * (hw + cw / 2), sill + h / 2 + 0.02, 0.0175), (cw, h + 0.04, 0.035), trim, skip=("bottom",))
        g.box((0, sill + h + cw / 2 + 0.02, 0.0175), (w + 2 * cw, cw, 0.035), trim, skip=("bottom",))
        g.box((0, sill + h + cw + 0.05, 0.035), (w + 2 * cw + 0.1, 0.05, 0.07), trim, skip=("bottom",))
        if kind == "window":
            g.box((0, sill - 0.035, 0.05), (w + 2 * cw + 0.04, 0.05, 0.1), trim, skip=("bottom",))
        g.pop()


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


def corner_boards(g, roofs, outline, mat="white_trim", w=0.15, e=0.035):
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
        h = z - Z_PL
        for (s0, s1, u, r1, nn) in ((-w, e, uA, e, nA), (0.0, w, uB, e, nB)):
            c = [(v[0] + u[0] * s + nn[0] * r, v[1] + u[1] * s + nn[1] * r) for s in (s0, s1) for r in (0.0, r1)]
            xs, ys = [p[0] for p in c], [p[1] for p in c]
            g.box(((min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2, Z_PL + h / 2), (max(xs) - min(xs), max(ys) - min(ys), h), mat)


def plinth(g, outline, mat="granite_plinth", d=0.045):
    off = offset_poly(outline, d)
    n = len(outline)
    for i in range(n):
        a, b = off[i], off[(i + 1) % n]
        g.poly([(a[0], a[1], SINK), (b[0], b[1], SINK), (b[0], b[1], Z_PL), (a[0], a[1], Z_PL)], mat)
        p, q = outline[i], outline[(i + 1) % n]
        g.poly([(a[0], a[1], Z_PL), (b[0], b[1], Z_PL), (q[0], q[1], Z_PL), (p[0], p[1], Z_PL)], "granite_dark")


def frieze(g, wall, d=0.04, h=0.2, gap=0.09):
    """Eaves board under the roof on walls with a level top (the cornice of the facade)."""
    for t0, z0, t1, z1 in segs_of(wall.top):
        if abs(z1 - z0) < 1e-4 and t1 - t0 > 0.6:
            p = wall.P((t0 + t1) / 2, z0 - gap - h / 2, d / 2)
            g.push(Matrix(((wall.u.x, 0, wall.n.x, p[0]), (wall.u.y, 0, wall.n.y, p[1]), (0, 1, 0, p[2]), (0, 0, 0, 1))))
            g.box((0, 0, 0), (t1 - t0, h, d), "white_trim", skip=("bottom",))
            g.pop()


# ---------------------------------------------------------------------------------------------
# Rainwater goods, steps, balustrades, chimneys, paving
# ---------------------------------------------------------------------------------------------

def gutter_run(g, a, b, z, ox, oy, mat="black_steel", r=0.07):
    """Half-round gutter hung on the fascia along a->b (outward normal ox, oy)."""
    n = 7
    zc = z - 0.12
    L = math.hypot(b[0] - a[0], b[1] - a[1])
    ux, uy = (b[0] - a[0]) / L, (b[1] - a[1]) / L
    prof = [(0.05 + r + r * math.cos(math.pi + math.pi * k / (n - 1)), zc + r * math.sin(math.pi + math.pi * k / (n - 1))) for k in range(n)]
    def P(t, o, z):
        return (a[0] + ux * t + ox * o, a[1] + uy * t + oy * o, z)
    t0, t1 = 0.0, L
    for k in range(n - 1):
        (oa, za), (ob, zb) = prof[k], prof[k + 1]
        q = [P(t0, oa, za), P(t1, oa, za), P(t1, ob, zb), P(t0, ob, zb)]
        g.poly(q[::-1], mat)
        g.poly(q, mat)
    for t in (t0, t1):
        g.poly([P(t, o, zz) for o, zz in prof], mat)
        g.poly([P(t, o, zz) for o, zz in reversed(prof)], mat)


def downpipe(g, top, wall_pt, n_out, z_ground, mat="black_steel", r=0.045):
    """From the gutter outlet `top` (x, y, z) angled in to the wall, down to the ground with a shoe."""
    x, y, z = top
    wx, wy = wall_pt
    zb = z - 0.35
    g.pipe((x, y, z), (wx, wy, zb), r, mat, seg=8)
    g.pipe((wx, wy, zb), (wx, wy, z_ground + 0.3), r, mat, seg=8)
    g.pipe((wx, wy, z_ground + 0.3), (wx + n_out[0] * 0.22, wy + n_out[1] * 0.22, z_ground + 0.02), r, mat, seg=8)
    # wall brackets
    zz = zb - 0.9
    while zz > z_ground + 0.5:
        g.box((wx - n_out[0] * 0.03, wy - n_out[1] * 0.03, zz), (0.09 if abs(n_out[0]) < .5 else 0.05, 0.09 if abs(n_out[1]) < .5 else 0.05, 0.035), mat)
        zz -= 1.3


def quad_n(g, pts, nrm, mat):
    P = [Vector(p) for p in pts]
    nn = (P[1] - P[0]).cross(P[2] - P[1])
    g.poly([tuple(p) for p in (P if nn.dot(Vector(nrm)) > 0 else P[::-1])], mat)


def stair(g, cx, cy, n, width, z_top, z_bot, tread=0.34, mat="concrete", side="granite_plinth"):
    """Steps leaving a wall at (cx, cy) along the outward normal n; the top tread joins the doorstep."""
    rise_n = max(1, int(math.ceil((z_top - z_bot) / 0.18 - 1e-6)))
    rise = (z_top - z_bot) / rise_n
    ang = math.degrees(math.atan2(n[1], n[0]))
    for i in range(rise_n):
        zt = z_top - i * rise
        depth = (i + 1) * tread
        c = (cx + n[0] * depth / 2, cy + n[1] * depth / 2)
        # box long axis along n: build in a rotated frame
        g.box((c[0], c[1], (zt + SINK) / 2), (depth, width, zt - SINK), side, rz=ang, mats={"top": mat})


def balustrade(g, pts, z0, h=0.95, mat="white_trim", pitch=0.13, post_every=1.2):
    """Picket railing along the polyline pts (x, y) standing on z0."""
    for a, b in zip(pts, pts[1:]):
        L = math.hypot(b[0] - a[0], b[1] - a[1])
        ux, uy = (b[0] - a[0]) / L, (b[1] - a[1]) / L
        ang = math.degrees(math.atan2(uy, ux))
        mid = ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)
        g.box((mid[0], mid[1], z0 + h - 0.035), (L, 0.07, 0.07), mat, rz=ang)           # top rail
        g.box((mid[0], mid[1], z0 + 0.1), (L, 0.05, 0.06), mat, rz=ang)                 # bottom rail
        n = max(1, int(round(L / post_every)))
        for i in range(n + 1):
            t = L * i / n
            g.box((a[0] + ux * t, a[1] + uy * t, z0 + h / 2), (0.09, 0.09, h), mat)
        m = int(L / pitch)
        for i in range(1, m):
            t = L * i / m
            g.box((a[0] + ux * t, a[1] + uy * t, z0 + h / 2), (0.032, 0.032, h - 0.18), mat)


def chimney(g, x, y, z_base, z_top, sx=0.9, sy=0.9, mat="plaster_white"):
    g.box((x, y, (z_base + z_top) / 2), (sx, sy, z_top - z_base), mat)
    g.box((x, y, z_top + 0.04), (sx + 0.16, sy + 0.16, 0.08), "granite_dark")
    g.box((x, y, z_top - 0.55), (sx + 0.06, sy + 0.06, 0.1), mat)                      # band under the cap
    for dx in (-sx / 4, sx / 4):                                                        # two flue pots
        g.cylinder((x + dx, y, z_top + 0.08), 0.11, 0.26, "black_steel", seg=8, r_top=0.09)


def win(t, w=0.95, h=1.7, sill=0.85, **k):
    d = dict(t=t, w=w, h=h, sill=sill, kind="window")
    d.update(k)
    return d


def pave_poly(g, outline, z_top, **kw):
    """Concave outlines: ear-clip into triangles for the top, sides as usual."""
    pts = list(outline)
    tris = []
    idx = list(range(len(pts)))
    guard = 0
    while len(idx) > 3 and guard < 500:
        guard += 1
        for k in range(len(idx)):
            i0, i1, i2 = idx[k - 1], idx[k], idx[(k + 1) % len(idx)]
            a, b, c = pts[i0], pts[i1], pts[i2]
            if (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]) <= 1e-9:
                continue
            if any(pt_in_poly([a, b, c], *pts[j]) for j in idx if j not in (i0, i1, i2)):
                continue
            tris.append((a, b, c))
            idx.pop(k)
            break
        else:
            break
    tris.append(tuple(pts[i] for i in idx))
    mat = kw.get("mat", "brick_paving")
    for t in tris:
        g.poly([(x, y, z_top) for x, y in t], mat, uv=("uv", [(x, y) for x, y in t]))
    n = len(pts)
    for i in range(n):
        a, b = pts[i], pts[(i + 1) % n]
        g.poly([(a[0], a[1], z_top - 0.6), (b[0], b[1], z_top - 0.6), (b[0], b[1], z_top), (a[0], a[1], z_top)], kw.get("kerb", "granite_plinth"))


# ---------------------------------------------------------------------------------------------
# Common finishing: roofs, walls, trim, gutters
# ---------------------------------------------------------------------------------------------

def merge_gutters(gutters):
    """Join collinear runs and lap the corner where a perpendicular run ends at the same point."""
    runs = []
    for a, b, z, ox, oy in gutters:
        runs.append([list(a[:2]), list(b[:2]), z, round(ox), round(oy)])
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
    out = []
    for r in runs:
        a, b = r[0], r[1]
        L = math.dist(a, b)
        ux, uy = (b[0] - a[0]) / L, (b[1] - a[1]) / L
        ea, eb = 0.0, 0.0
        for q in runs:
            if q is r or q[3:] == r[3:] or abs(q[2] - r[2]) > 0.02:
                continue
            if r[4] != 0:       # extend the runs along x over the corner, once
                continue
            if min(math.dist(a, q[0]), math.dist(a, q[1])) < 0.02:
                ea = 0.2
            if min(math.dist(b, q[0]), math.dist(b, q[1])) < 0.02:
                eb = 0.2
        if L + ea + eb > 0.9:           # no stubs: the 0.4 m bits at overhang corners are dropped
            out.append(((a[0] - ux * ea, a[1] - uy * ea, r[2]), (b[0] + ux * eb, b[1] + uy * eb, r[2]), r[2], r[3], r[4]))
    return out


def finish(g, roofs, outline, walls, top_mat, cap_mat, pipes, zground, ridge_w=0.2):
    plinth(g, outline)
    corner_boards(g, roofs, outline)
    for w in walls:
        w.build(g)
    gutters = merge_gutters(roofs.build(g, top_mat, "white_trim", "white_trim", cap_mat, "black_steel", ridge_w))
    for a, b, z, ox, oy in gutters:
        gutter_run(g, a, b, z, ox, oy)
    for (x, y, nx, ny) in pipes:
        zg = zground(x, y)
        best = None
        for a, b, z, ox, oy in gutters:
            if ox != nx or oy != ny:
                continue
            L = math.hypot(b[0] - a[0], b[1] - a[1])
            ux, uy = (b[0] - a[0]) / L, (b[1] - a[1]) / L
            t = (x - a[0]) * ux + (y - a[1]) * uy
            off = (x - a[0]) * ox + (y - a[1]) * oy      # towards the wall: negative
            if -0.5 <= t <= L + 0.5 and (best is None or abs(off) < abs(best[0])):
                best = (off, a, ux, uy, z, L)
        if best is None:
            print("WARNING no gutter above downpipe", x, y)
            continue
        off, a, ux, uy, z, L = best
        t = min(max((x - a[0]) * ux + (y - a[1]) * uy, 0.15), L - 0.15)
        top = (a[0] + ux * t + nx * 0.12, a[1] + uy * t + ny * 0.12, z - 0.2)
        downpipe(g, top, (x, y), (nx, ny), zg)
    return gutters


def skylight(g, cx, cy, plane, w=0.78, h=1.0):
    """Flush roof window with a white frame, laid on a roof plane z = A x + B y + C."""
    A, B, C = plane
    ex = Vector((1, 0, A)).normalized()
    ey = Vector((0, 1, B)).normalized()
    c = Vector((cx, cy, A * cx + B * cy + C))
    pts = [c + ex * sx * w / 2 + ey * sy * h / 2 for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
    lift = Vector((0, 0, 0.045))
    quad_n(g, [tuple(p + lift) for p in pts], (0, 0, 1), "glass")
    for p, q in zip(pts, pts[1:] + pts[:1]):
        g.beam(tuple(p + lift * 0.9), tuple(q + lift * 0.9), 0.09, 0.07, "white_trim")


def flat_roof_fascia(g, x0, x1, y0, y1, z, parapet, sides):
    """Parapet (white panel, coping on top) on the listed sides of a flat roof."""
    t = 0.2
    for s in sides:
        if s == "N":
            c, sz = ((x0 + x1) / 2, y1 - t / 2), (x1 - x0, t)
        elif s == "S":
            c, sz = ((x0 + x1) / 2, y0 + t / 2), (x1 - x0, t)
        elif s == "W":
            c, sz = (x0 + t / 2, (y0 + y1) / 2), (t, y1 - y0)
        else:
            c, sz = (x1 - t / 2, (y0 + y1) / 2), (t, y1 - y0)
        g.box((c[0], c[1], z + parapet / 2 - 0.02), (sz[0], sz[1], parapet + 0.04), "wall_white_panel")
        g.box((c[0], c[1], z + parapet + 0.025), (sz[0] + (0.06 if s in "WE" else 0.0), sz[1] + (0.06 if s in "NS" else 0.0), 0.05), "white_trim")


# ---------------------------------------------------------------------------------------------
# The manor house (OSM 1431566968)
# ---------------------------------------------------------------------------------------------

MAIN_OUTLINE = [(-16, -2.7), (-6.66, -2.7), (-6.66, -5.9), (2.27, -5.9), (2.27, -2.7), (16, -2.7), (16, 5.3), (2.27, 5.3),
                (2.27, 8.07), (-16, 8.07)]
XC = -2.195     # axis of the central body (and of the veranda)
TERRACE = [(-16, -8.3), (-10.5, -8.7), (-8, -9.5), (-5.5, -10.2), (-2.2, -10.5), (0.5, -10.0), (2.0, -9.0), (4.5, -8.6),
           (10.6, -8.3), (10.6, -5.7), (18, -5.7), (18, 7.8), (10.5, 7.8), (10.5, 5.3), (16, 5.3), (16, -2.7), (2.27, -2.7),
           (2.27, -5.9), (0.5, -5.9), (0.5, -8.06), (-4.9, -8.06), (-4.9, -5.9), (-6.66, -5.9), (-6.66, -2.7), (-16, -2.7)]
Z_TERRACE = 0.15


def main_roofs():
    ZR, P = 7.2, 0.83
    dark, pale = "roof_dark_seam", "roof_pale_metal"
    return Roofs([
        # lidar: slope 1.1 from the eave to a break at ~6.1 m (y 3.4), then 0.52 to the ridge at 7.2 (both cross wings)
        mansard(-6.66, 2.27, -5.9, 8.07, "WENS", mat=dark),
        # gable ends flush with the walls: the lidar sees the lower wing roofs right up to the wall, so no rake overhang
        mansard(-11.0, 6.4, -2.7, 5.3, "NS", mat=dark, rect=(-11.06, 6.46, -3.1, 5.7)),
        # pale west wing: low gable on the same walls as the cross body (lidar 3.6 south wall, 4.05 ridge)...
        gable_x(1.3, 4.05, 0.16, -16.0, -11.0, -2.7, 5.3, mat=pale, rect=(-16.4, -11.0, -3.1, 5.7)),
        # ... and a skillion over the north strip falling 0.2/m (lidar 3.2 at y 5.5 -> 2.8 at y 7.5)
        mono_y(3.15, -0.2, -16.0, -11.0, 5.3, 8.07, mat=pale, rect=(-16.4, -11.0, 5.3, 8.47)),
        # pale east wing: one plane falling east 4.28 -> 2.89 (lidar 4.2 at x 7 ... 2.9 at x 16)
        mono(4.28, -0.145, 6.4, 16.0, -2.7, 5.3, mat=pale, rect=(6.4, 16.4, -3.1, 5.7)),
        flat(3.35, -11.0, -6.66, 5.3, 8.07, mat="membrane_light"),
    ])


def main_ground(x, y):
    if y > 8.0:
        return -0.3 + 0.025 * x
    if pt_in_poly(TERRACE, x, y) or y < -2.5:
        return Z_TERRACE
    return 0.0


MAIN_PIPES = [(-15.65, -2.77, 0, -1), (-11.5, -2.77, 0, -1), (-6.86, -2.77, 0, -1), (2.55, -2.77, 0, -1), (6.1, -2.77, 0, -1),
              (16.07, -2.4, 1, 0), (16.07, 4.9, 1, 0), (-15.65, 8.14, 0, 1), (-11.5, 8.14, 0, 1), (-6.9, 8.14, 0, 1),
              (2.34, 7.6, 1, 0), (2.34, -5.55, 1, 0), (-6.73, -5.55, -1, 0)]


def build_main(g):
    roofs = main_roofs()
    O = MAIN_OUTLINE
    wm = "wall_white_panel"
    W = lambda i, ops=(): Wall(O[i], O[(i + 1) % len(O)], roofs, wm, openings=ops)
    z = win
    W2 = dict(w=0.95, h=1.5)                    # low pale wings
    D2 = dict(w=1.5, h=2.1, sill=0.45, kind="gdoor", bars=(2, 1))
    # t along each edge from its first vertex
    walls = [
        W(0, [z(1.4, **W2), z(3.6, **W2), z(6.1, h=1.7, w=1.0), z(8.3, h=1.7, w=1.0)]),             # S1 south: x -14.6 -12.4 -9.9 -7.7
        W(1, [z(1.6, h=1.7, w=0.95)]),                                                               # S2 central body, west
        W(2, [z(0.85, h=1.7, w=0.95), z(8.05, h=1.7, w=0.95)]),                                      # S3 central south beside the veranda
        W(3, [z(1.6, h=1.7, w=0.95)]),                                                               # S4 central body, east
        W(4, [z(1.04, h=1.7, w=1.0), z(3.24, h=1.7, w=1.0), z(5.7, **W2), z(8.2, **W2), dict(t=10.7, **D2), z(12.9, **W2)]),  # S5
        W(5, [z(1.3, **W2), dict(t=4.0, **D2), z(6.7, **W2)]),                                       # S6 east end
        W(6, [z(2.5, **W2), z(5.0, **W2), z(7.5, **W2), z(11.67, h=1.7, w=1.0)]),                     # S7 north of the east wing
        W(7, [z(1.4, h=1.7, w=0.95)]),                                                               # S8 central body, east, north part
        W(8, [z(1.67, h=1.7, w=0.95), z(4.47, h=1.7, w=0.95), z(7.27, h=1.7, w=0.95), z(11.07, h=1.7, w=1.0),
              z(14.77, w=0.95, h=1.4, sill=0.8), z(16.77, w=0.95, h=1.4, sill=0.8)]),                                                        # S9 north
        W(9, [z(1.5, w=0.95, h=1.4, sill=0.8), z(4.9, **W2), z(8.3, **W2)]),                                            # S10 west end
    ]

    def interior(a, b, n, ops=()):
        sh = (n[0] * 0.01, n[1] * 0.01)
        bot = wall_profile(roofs, (a[0] + sh[0], a[1] + sh[1]), (b[0] + sh[0], b[1] + sh[1]), embed=0.08)
        return Wall(a, b, roofs, wm, bottom=bot, openings=ops)
    # gable walls of the cross body above the lower wings, with an attic window each
    walls += [interior((-11, 5.3), (-11, -2.7), (-1, 0), [dict(t=4.0, w=0.9, h=1.2, sill=4.55, kind="window", bars=(2, 2))]),
              interior((6.4, -2.7), (6.4, 5.3), (1, 0), [dict(t=4.0, w=0.9, h=1.2, sill=4.85, kind="window", bars=(2, 2))]),
              interior((-6.66, 5.3), (-16, 5.3), (0, 1)), interior((-11, 8.07), (-11, 5.3), (-1, 0)),
              interior((-6.66, 8.07), (-6.66, 5.3), (-1, 0))]
    for w in walls[:10]:
        frieze(g, w)
    finish(g, roofs, O, walls, "roof_dark_seam", "roof_metal_black", MAIN_PIPES, main_ground)
    # flat roof of the lean-to: parapet on the north and west sides
    flat_roof_fascia(g, -11.0, -6.66, 5.3, 8.07, 3.35, 0.3, "NW")
    # its drainage: a scupper through the north parapet into a rainwater head and a downpipe to the ground
    sx = -10.55
    g.box((sx, 8.07 + 0.05, 3.35 + 0.07), (0.3, 0.3, 0.14), "black_steel")
    g.box((sx, 8.07 + 0.12, 3.35 - 0.2), (0.3, 0.24, 0.34), "black_steel")
    downpipe(g, (sx, 8.07 + 0.1, 3.35 - 0.37), (sx, 8.07 + 0.075), (0, 1), main_ground(sx, 8.2))
    # chimneys on the E-W ridge (lidar tops 8.7)
    for x in (-5.9, 0.4):
        chimney(g, x, 1.3, 6.2, 8.6)
    veranda(g)
    stair(g, 13.0, -2.7, (0, -1), 1.7, 0.45, Z_TERRACE)       # steps to the garden doors of the east wing
    stair(g, 16.0, 1.3, (1, 0), 1.7, 0.45, Z_TERRACE)
    pave_poly(g, TERRACE, Z_TERRACE)
    return roofs


def veranda(g):
    """Glazed farstukvist on the axis with a flat roof deck and white balustrade (lidar: deck ~3.5, rail ~4.6)."""
    x0, x1, y0, y1 = XC - 2.7, XC + 2.7, -8.06, -5.9
    fl, deck = 0.45, 2.75
    g.box(((x0 + x1) / 2, (y0 + y1) / 2, (SINK + fl) / 2), (x1 - x0 + 0.1, y1 - y0 + 0.05, fl - SINK), "granite_plinth",
          mats={"top": "granite_dark"})
    zb, zt = fl, deck - 0.3
    glass_top = zt - 0.12
    panel_top = zb + 0.85
    fx = [x0 + 0.07, XC - 0.85, XC + 0.85, x1 - 0.07]
    ymid = (y0 + y1) / 2
    for x in fx:
        g.box((x, y0 + 0.07, (zb + zt) / 2), (0.14, 0.14, zt - zb), "white_trim")
    for yy in (y0 + 0.07, ymid):
        for x in (x0 + 0.07, x1 - 0.07):
            g.box((x, yy, (zb + zt) / 2), (0.14, 0.14, zt - zb), "white_trim")
    y = y0 + 0.07

    def front(xa, xb, door=False):
        xm = (xa + xb) / 2
        xa, xb = xa + 0.07, xb - 0.07
        if door:
            quad_n(g, [(xa, y - 0.01, zb), (xb, y - 0.01, zb), (xb, y - 0.01, glass_top), (xa, y - 0.01, glass_top)], (0, -1, 0), "glass")
            g.box((xm, y - 0.02, glass_top - 0.03), (xb - xa, 0.05, 0.06), "white_trim")
            g.box((xm, y - 0.02, zb + 0.03), (xb - xa, 0.05, 0.06), "white_trim")
            g.box((xm, y - 0.02, (zb + glass_top) / 2), (0.04, 0.05, glass_top - zb), "white_trim")      # door leaves meet
            g.box((xm, y - 0.02, glass_top - 0.45), (xb - xa, 0.04, 0.04), "white_trim")                  # transom
            for sx in (-1, 1):
                g.box((xm + sx * 0.12, y - 0.04, zb + 1.0), (0.03, 0.05, 0.16), "chrome")
        else:
            quad_n(g, [(xa, y - 0.02, zb), (xb, y - 0.02, zb), (xb, y - 0.02, panel_top), (xa, y - 0.02, panel_top)], (0, -1, 0), "wall_white_panel")
            quad_n(g, [(xa, y - 0.01, panel_top), (xb, y - 0.01, panel_top), (xb, y - 0.01, glass_top), (xa, y - 0.01, glass_top)], (0, -1, 0), "glass")
            g.box((xm, y - 0.02, panel_top + 0.02), (xb - xa, 0.06, 0.05), "white_trim")
            g.box((xm, y - 0.02, glass_top - 0.025), (xb - xa, 0.06, 0.05), "white_trim")
            for k in (1, 2):
                g.box((xa + (xb - xa) * k / 3, y - 0.02, (panel_top + glass_top) / 2), (0.04, 0.05, glass_top - panel_top), "white_trim")
            g.box((xm, y - 0.02, (panel_top + glass_top) / 2), (xb - xa, 0.035, 0.035), "white_trim")
    front(fx[0], fx[1])
    front(fx[1], fx[2], door=True)
    front(fx[2], fx[3])

    def side(xp, ya, yb, out):
        ya, yb = ya + 0.07, yb - 0.07
        yy = (ya + yb) / 2
        x = xp + out * 0.02
        quad_n(g, [(x, ya, zb), (x, yb, zb), (x, yb, panel_top), (x, ya, panel_top)], (out, 0, 0), "wall_white_panel")
        quad_n(g, [(x, ya, panel_top), (x, yb, panel_top), (x, yb, glass_top), (x, ya, glass_top)], (out, 0, 0), "glass")
        g.box((x, yy, panel_top + 0.02), (0.06, yb - ya, 0.05), "white_trim")
        g.box((x, yy, glass_top - 0.025), (0.06, yb - ya, 0.05), "white_trim")
        g.box((x, yy, (panel_top + glass_top) / 2), (0.04, 0.04, glass_top - panel_top), "white_trim")
        g.box((x, yy, (panel_top + glass_top) / 2), (0.04, yb - ya, 0.035), "white_trim")
    for xp, out in ((x0 + 0.07, -1), (x1 - 0.07, 1)):
        side(xp, y0 + 0.07, ymid, out)
        side(xp, ymid, y1, out)
    # header beam and deck slab (white edge, grey timber deck)
    g.box(((x0 + x1) / 2, (y0 + y1) / 2, (zt + deck) / 2), (x1 - x0 + 0.2, y1 - y0 + 0.2, deck - zt), "white_trim", mats={"top": "wood_deck_grey"})
    # balustrade on the deck; it stops short of the central roof's eave gutter at the wall
    yb = -6.6
    balustrade(g, [(x0 + 0.08, yb), (x0 + 0.08, y0 - 0.03), (x1 - 0.08, y0 - 0.03), (x1 - 0.08, yb)], deck, h=0.95)
    stair(g, XC, y0, (0, -1), 1.9, fl, Z_TERRACE, tread=0.34)


# ---------------------------------------------------------------------------------------------
# The east house (OSM 1431566962): falu red 1.5-storey house with a gable dormer, porch with balcony
# ---------------------------------------------------------------------------------------------

EX, EY = 8.58, 4.85
E_OUTLINE = [(-EX, -EY), (EX, -EY), (EX, EY), (-EX, EY)]
E_XD = -0.45            # axis of the dormer (lidar ridge x)
E_ZR, E_P = 7.18, 0.748
E_DORM_Y = 3.4          # the dormer's gable wall
E_PAVING = 0.06


def east_roofs():
    t = "roof_tile_graphite"
    return Roofs([
        gable_x(0.0, E_ZR, E_P, -EX, EX, -EY, EY, mat=t),
        # gable dormer on the +y slope: ridge level with the main ridge, pitch 0.52 (lidar slopes 0.45-0.5, ortho valleys ~39 degrees)
        gable_y(E_XD, 7.12, 0.52, E_XD - 5.6, E_XD + 5.6, 0.0, E_DORM_Y, mat=t,
                rect=(E_XD - 5.6, E_XD + 5.6, 0.0, E_DORM_Y + OVH)),
    ])


E_PIPES = [(-8.3, -EY - 0.07, 0, -1), (8.3, -EY - 0.07, 0, -1), (-8.3, EY + 0.07, 0, 1), (8.3, EY + 0.07, 0, 1)]


def build_east(g):
    roofs = east_roofs()
    O = E_OUTLINE
    wm = "falu_red_vertical"
    W = lambda i, ops=(): Wall(O[i], O[(i + 1) % len(O)], roofs, wm, openings=ops)
    w15 = dict(w=1.0, h=1.5, sill=0.9)
    # edge 0: y = -EY (long side towards -y), t = x + EX
    e0 = [win(EX + x, **w15) for x in (-6.0, -3.0, 3.0, 6.0)] + [dict(t=EX, w=1.4, h=2.1, sill=0.45, kind="gdoor", bars=(2, 1))]
    # edge 1: x = +EX gable, t = y + EY
    e1 = [win(EY - 2.0, **w15), win(EY + 2.0, **w15), dict(t=EY, w=0.8, h=1.0, sill=4.3, kind="window", bars=(2, 2))]
    # edge 2: y = +EY, t = EX - x
    e2 = [win(EX - x, **w15) for x in (-6.0, -3.0, 0.0, 3.0, 6.0)]
    # edge 3: x = -EX gable with the porch, t = EY - y
    e3 = [dict(t=EY, w=1.0, h=2.1, sill=0.45, kind="door"), win(EY - 3.1, w=0.95, h=1.5, sill=0.9), win(EY + 3.1, w=0.95, h=1.5, sill=0.9),
          dict(t=EY, w=0.95, h=2.0, sill=3.15, kind="gdoor", bars=(2, 1)),
          dict(t=EY - 2.3, w=0.6, h=1.0, sill=3.9, kind="window", bars=(2, 2)), dict(t=EY + 2.3, w=0.6, h=1.0, sill=3.9, kind="window", bars=(2, 2))]
    walls = [W(0, e0), W(1, e1), W(2, e2), W(3, e3)]
    # the dormer's gable wall stands on the main roof
    a, b = (E_XD + 5.6, E_DORM_Y), (E_XD - 5.6, E_DORM_Y)
    bot = wall_profile(roofs, (a[0], a[1] + 0.01), (b[0], b[1] + 0.01), embed=0.08)
    walls.append(Wall(a, b, roofs, wm, bottom=bot, openings=[dict(t=5.6, w=0.95, h=1.3, sill=5.0, kind="window", bars=(2, 3))]))
    for w in walls[:4]:
        frieze(g, w)
    finish(g, roofs, O, walls, "roof_tile_graphite", "roof_metal_black", E_PIPES, lambda x, y: E_PAVING if (y < -EY and -9.0 < x < -1.2) or x < -EX else 0.0)
    # chimneys on the ridge (lidar top 8.2 at x 2.4; the ortho shows a second one over the dormer valley apex side)
    for x in (-3.4, 2.4):
        chimney(g, x, 0.0, 6.0, 8.2, sx=0.75, sy=0.75)
    # two flush roof windows in the -y slope (ortho white frames, lidar on the plane)
    pl = roofs.pieces[0]["planes"][1]      # the -y slope
    for x in (-5.3, -0.6):
        skylight(g, x, -2.8, pl)
    # porch (farstukvist) at the south gable: open, posts, flat roof used as a balcony with a white balustrade
    px0, px1, py = -10.2, -EX, 1.9
    g.box(((px0 + px1) / 2, 0, (SINK + 0.35) / 2), (px1 - px0, 2 * py + 0.1, 0.35 - SINK), "granite_plinth", mats={"top": "granite_dark"})
    deck, slab = 3.12, 0.25
    for yy in (-py + 0.1, py - 0.1):
        g.box((px0 + 0.1, yy, (0.35 + deck - slab) / 2), (0.15, 0.15, deck - slab - 0.35), "white_trim")
    g.box(((px0 + px1) / 2 - 0.05, 0, deck - slab / 2), (px1 - px0 + 0.1, 2 * py + 0.2, slab), "white_trim", mats={"top": "wood_deck_grey"})
    balustrade(g, [(-EX - 0.1, -py + 0.03), (px0 - 0.03, -py + 0.03), (px0 - 0.03, py - 0.03), (-EX - 0.1, py - 0.03)], deck, h=0.95)
    stair(g, px0, 0, (-1, 0), 1.7, 0.35, E_PAVING, tread=0.34)
    # steps at the garden door on the -y side
    stair(g, 0, -EY, (0, -1), 1.7, 0.4, E_PAVING, tread=0.34)
    # entrance forecourt and the patio strip along the -y side (ortho: brick)
    pave_poly(g, [(-14.0, -3.2), (-EX, -3.2), (-EX, 3.2), (-14.0, 3.2)], E_PAVING)
    pave_poly(g, [(-9.0, -6.9), (-1.2, -6.9), (-1.2, -EY), (-9.0, -EY)], E_PAVING)


# ---------------------------------------------------------------------------------------------
# Contract with model.py
# ---------------------------------------------------------------------------------------------

def build(add, new, ev):
    for osm_id, aid, builder, ground in (("1431566968", "omberg_farm_main_house", build_main, 113.30),
                                         ("1431566962", "omberg_farm_east_house", build_east, 113.26)):
        r = ev.osm[osm_id]["properties"]["rect"]
        g = new()
        builder(g)
        yaw = (90 - r["angleDeg"]) % 180
        add(aid, g, r["cx"], r["cy"], yaw, ground)
