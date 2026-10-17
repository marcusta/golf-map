"""Houses by the rocks (OSM 786179224 house, 786179223 outbuilding) and the barn to the north-west (OSM 786179225),
plus the mossy cottage east of the barn (1431567004).  model.py calls register_materials() and build(add, new, ev).

Survey (lidar-crop.npz class-1 plane fits, 2023/2025 orthos; the numbers sit in the dicts below):
  * The orthos are NOT true orthos: roofs sit about 1 m west of the lidar roofs and the OSM outlines follow the
    ortho.  So heights, ridges and pitches are lidar plane fits and the outlines are lidar extents (roof returns up
    to the edge, a symmetric eave overhang), the ortho only gives the roof form (valleys, gables, colours, patches).
  * Walls are invisible from above: falu-red board with white trim, orange tile - like the farm's road house.
  * Asset frame of every building: x along the long axis (compass bearing yaw), y to the left of x, z up from Z0
    (an absolute RH2000 height); origin on the building centre.  Local (analysis) coordinates are shifted by -centre
    once, at the start of each build (g.push), so the numbers in the code are the lidar-frame numbers.
Everything the sources do not show is marked "inferred".
"""
import math

import numpy as np
from mathutils import Matrix, Vector

import props_kit as kit

# Only materials defined here (model.py zeroes their specular: sRGB-lit matt, no mirror on the tiles).
MATTE = {"tile_clay", "tile_moss", "plinth_stone", "sheet_red", "sheet_pale", "sheet_frame"}


def register_materials():
    M = kit.MATERIALS
    M["tile_clay"] = ("pantile:166,80,54", (2.0, 2.0), None, 0.2, 0.0)             # orange clay tile as on the farm road house
    M["tile_moss"] = ("pantile:110,88,70", (2.0, 2.0), None, 0.15, 0.0)        # old tile under moss (the ortho roof is brown-green)
    M["plinth_stone"] = ("stone:116,112,108", (2.0, 2.0), None, 0.2, 0.0)            # granite plinth and steps
    M["sheet_red"] = ("seam:152,66,55:0.076:2.0:1", (2.0, 2.0), None, 0.12, 0.1)    # corrugated red sheet, relief in the normal map
    M["sheet_pale"] = ("seam:200,172,152:0.076:2.0:1", (2.0, 2.0), None, 0.2, 0.1)  # the lighter patch on the barn roof
    M["sheet_frame"] = (None, (1, 1), (140, 56, 46), 0.12, 0.1)
    kit.TILE_ROOFS["tile_clay"] = 0.34     # stepped courses as geometry (as kit._roof_slab and the farm do)
    kit.TILE_ROOFS["tile_moss"] = 0.34


# ---------------------------------------------------------------------------------------------
# frames and ground
# ---------------------------------------------------------------------------------------------
class Frame:
    """Local metres: origin (e0, n0) in EPSG:3006, x along math angle `ang` (compass bearing 90 - ang), y to its left."""

    def __init__(s, e0, n0, ang):
        s.e0, s.n0, s.ang = e0, n0, ang
        t = math.radians(ang)
        s.ux, s.uy = np.array([math.cos(t), math.sin(t)]), np.array([-math.sin(t), math.cos(t)])

    def en(s, x, y):
        return s.e0 + x * s.ux[0] + y * s.uy[0], s.n0 + x * s.ux[1] + y * s.uy[1]

    def xy(s, E, N):
        d = np.c_[np.asarray(E) - s.e0, np.asarray(N) - s.n0]
        return d @ s.ux, d @ s.uy

    @property
    def yaw(s):
        return (90 - s.ang) % 360


def in_poly(x, y, poly):
    """Even-odd point-in-polygon for numpy arrays x, y."""
    ins = np.zeros(np.shape(x), bool)
    for (x1, y1), (x2, y2) in zip(poly, poly[1:] + poly[:1]):
        if abs(y2 - y1) < 1e-12:
            continue
        ins ^= ((y1 > y) != (y2 > y)) & (x < (x2 - x1) * (y - y1) / (y2 - y1) + x1)
    return ins


def ground_under(ev, F, poly, pad=0.8):
    """(lowest, median) real ground inside `poly` (frame xy) grown by `pad`: class-2 lidar and the course terrain.
    The plinth must reach the lowest of them so nothing floats where rock falls away."""
    xs, ys = [p[0] for p in poly], [p[1] for p in poly]
    P = ev.points
    px, py = F.xy(P[:, 0], P[:, 1])
    big = [(min(xs) - pad, min(ys) - pad), (max(xs) + pad, min(ys) - pad), (max(xs) + pad, max(ys) + pad), (min(xs) - pad, max(ys) + pad)]
    m = (P[:, 3] == 2) & in_poly(px, py, big)
    zs = list(P[m, 2])
    lo = float(np.percentile(zs, 3)) if len(zs) > 5 else 1e9
    gx, gy = np.meshgrid(np.arange(min(xs), max(xs) + .01, 0.5), np.arange(min(ys), max(ys) + .01, 0.5))
    ok = in_poly(gx.ravel(), gy.ravel(), poly)
    tz = [ev.terrain(*F.en(a, b)) for a, b in zip(gx.ravel()[ok], gy.ravel()[ok])]
    return min(lo, min(tz)), float(np.median(tz))


def ring_report(name, ev, F, foot, FL, Z0, zb):
    """Course terrain along a ring 0.35 m outside the plinth: how much plinth shows (FFL - terrain) and where rock stands higher
    than the floor. The plinth bottom (zb) lies under the lowest of it by construction."""
    ring = offset_poly(foot, 0.35)
    zs = []
    for a, b in zip(ring, ring[1:] + ring[:1]):
        L = math.hypot(b[0] - a[0], b[1] - a[1])
        for t in np.arange(0, L, 0.5):
            zs.append(ev.terrain(*F.en(a[0] + (b[0] - a[0]) * t / L, a[1] + (b[1] - a[1]) * t / L)))
    zs = np.array(zs)
    print("%s plinth: bottom %.2f, FFL %.2f, terrain ring %.2f..%.2f -> plinth shows %.2f..%.2f m%s" % (
        name, zb + Z0, FL + Z0, zs.min(), zs.max(), FL + Z0 - zs.max(), FL + Z0 - zs.min(),
        ", terrain %.2f ABOVE the floor" % (zs.max() - FL - Z0) if zs.max() > FL + Z0 else ""), flush=True)


def offset_poly(poly, d):
    """Mitred outward offset of a CCW polygon (rectilinear footprints: exact)."""
    out, n = [], len(poly)
    for i in range(n):
        a, b, c = poly[i - 1], poly[i], poly[(i + 1) % n]
        e1, e2 = np.subtract(b, a), np.subtract(c, b)
        n1, n2 = np.array([e1[1], -e1[0]]) / np.hypot(*e1), np.array([e2[1], -e2[0]]) / np.hypot(*e2)
        out.append(tuple(np.array(b) + (n1 + n2) * d / (1 + n1 @ n2)))
    return out


# ---------------------------------------------------------------------------------------------
# faces, walls, openings (patterns of farm/neighbours.py, copied: that module is another agent's)
# ---------------------------------------------------------------------------------------------
OUT = {"+y": (0, 1, 0), "-y": (0, -1, 0), "+x": (1, 0, 0), "-x": (-1, 0, 0)}
WHITE = "white_trim"
STONE = "plinth_stone"


def quad(g, pts, out, mat):
    """Polygon facing `out`: the vertex order is fixed from its Newell normal, so no winding to get wrong."""
    P = [Vector(p) for p in pts]
    P = [p for i, p in enumerate(P) if (p - P[i - 1]).length > 1e-6]
    if len(P) < 3:
        return
    n = Vector()
    for i in range(len(P)):
        a, b = P[i], P[(i + 1) % len(P)]
        n += Vector(((a.y - b.y) * (a.z + b.z), (a.z - b.z) * (a.x + b.x), (a.x - b.x) * (a.y + b.y)))
    if n.dot(Vector(out)) < 0:
        P.reverse()
    g.poly([tuple(p) for p in P], mat)


def frame_m(side, plane, at):
    """Opening frame (as kit.opening): local (u along the wall, v up, n out of the wall) -> asset coordinates."""
    return {"+y": Matrix(((-1, 0, 0, at), (0, 0, 1, plane), (0, 1, 0, 0), (0, 0, 0, 1))),
            "-y": Matrix(((1, 0, 0, at), (0, 0, -1, plane), (0, 1, 0, 0), (0, 0, 0, 1))),
            "+x": Matrix(((0, 0, 1, plane), (1, 0, 0, at), (0, 1, 0, 0), (0, 0, 0, 1))),
            "-x": Matrix(((0, 0, -1, plane), (-1, 0, 0, at), (0, 1, 0, 0), (0, 0, 0, 1)))}[side]


def wall(g, side, plane, lo, hi, z0, top, mat, holes=(), brk=()):
    """Planar wall on the line `plane` (x or y, by side), running lo..hi along the other axis, from z0 to top(c, mid)
    (linear between the breakpoints `brk`). holes: (c0, c1, zlow, zhigh), also stacked ones (a door under an attic window).
    Opening columns get a piece between the holes and the neighbouring full columns carry the hole corner vertices, so the
    wall has no T-cracks."""
    P = (lambda c, z: (c, plane, z)) if side[1] == "y" else (lambda c, z: (plane, c, z))
    cs = sorted({lo, hi, *brk} | {h[0] for h in holes} | {h[1] for h in holes})
    for a, b in zip(cs, cs[1:]):
        if b - a < 1e-6:
            continue
        m = (a + b) / 2
        hs = sorted((h for h in holes if h[0] <= a + 1e-6 and b <= h[1] + 1e-6), key=lambda h: h[2])   # holes stacked in this column
        if hs:
            lows = [z0] + [h[3] for h in hs]
            highs = [h[2] for h in hs] + [None]
            for zl, zh in zip(lows, highs):
                zt_b, zt_a = (top(b, m), top(a, m)) if zh is None else (zh, zh)
                if min(zt_a, zt_b) <= zl + 1e-6 and zh is not None:
                    continue
                # corners of neighbouring holes that lie on this piece's side edges become vertices (no T-cracks)
                rb = sorted({z for k in holes if abs(k[0] - b) < 1e-6 for z in (k[2], k[3]) if zl + 1e-6 < z < zt_b - 1e-6})
                la = sorted({z for k in holes if abs(k[1] - a) < 1e-6 for z in (k[2], k[3]) if zl + 1e-6 < z < zt_a - 1e-6}, reverse=True)
                quad(g, [P(a, zl), P(b, zl)] + [P(b, z) for z in rb] + [P(b, zt_b), P(a, zt_a)] + [P(a, z) for z in la], OUT[side], mat)
            continue
        pts = [P(a, z0), P(b, z0)]
        pts += [q for k in holes if abs(k[0] - b) < 1e-6 for q in (P(b, k[2]), P(b, k[3]))]
        pts += [P(b, top(b, m)), P(a, top(a, m))]
        pts += [q for k in holes if abs(k[1] - a) < 1e-6 for q in (P(a, k[3]), P(a, k[2]))]
        quad(g, pts, OUT[side], mat)


def window(g, side, plane, o):
    """Casement window in a real recess: white reveals, glass set back, white sash frame with mullions, casing,
    drip cap and a projecting sill. o: at, w, h, sill, bars=(cols, rows), recess."""
    w, h, s = o["w"], o["h"], o["sill"]
    cols, rows = o.get("bars", (2, 1))
    d, fw, cw = o.get("recess", 0.11), 0.07, 0.10
    L, R, B, T = -w / 2, w / 2, s, s + h
    g.push(frame_m(side, plane, o["at"]))
    quad(g, [(L, B, 0), (L, T, 0), (L, T, -d), (L, B, -d)], (1, 0, 0), WHITE)
    quad(g, [(R, B, 0), (R, T, 0), (R, T, -d), (R, B, -d)], (-1, 0, 0), WHITE)
    quad(g, [(L, B, 0), (R, B, 0), (R, B, -d), (L, B, -d)], (0, 1, 0), WHITE)
    quad(g, [(L, T, 0), (R, T, 0), (R, T, -d), (L, T, -d)], (0, -1, 0), WHITE)
    quad(g, [(L, B, -d + 0.02), (R, B, -d + 0.02), (R, T, -d + 0.02), (L, T, -d + 0.02)], (0, 0, 1), "window_dark")
    zf = -d + 0.045                                 # sash frame sits in the back of the recess
    for sx in (-1, 1):
        g.box((sx * (w / 2 - fw / 2), (B + T) / 2, zf), (fw, h, 0.05), WHITE)
    for z in (B + fw / 2, T - fw / 2):
        g.box((0, z, zf), (w - 2 * fw, fw, 0.05), WHITE)
    for i in range(1, cols):
        g.box((L + w * i / cols, (B + T) / 2, zf), (0.05, h - 2 * fw, 0.05), WHITE)
    for j in range(1, rows):
        g.box((0, B + h * j / rows, zf), (w - 2 * fw, 0.04, 0.05), WHITE)
    for sx in (-1, 1):                              # casing boards
        g.box((sx * (w / 2 + cw / 2), (B + T) / 2 + cw / 2 - 0.01, 0.015), (cw, h + cw + 0.02, 0.03), WHITE)
    g.box((0, T + cw / 2, 0.015), (w + 2 * cw, cw, 0.03), WHITE)
    g.box((0, T + cw + 0.02, 0.04), (w + 2 * cw + 0.08, 0.04, 0.08), WHITE)
    g.box((0, B - 0.03, 0.04), (w + 2 * cw + 0.06, 0.05, 0.12), WHITE)
    g.pop()


def door(g, side, plane, o):
    """Board door with an optional glazed upper half, in a recess with casing; the step comes from step()."""
    w, h, s = o["w"], o["h"], o["sill"]
    d, cw = 0.10, 0.10
    L, R, B, T = -w / 2, w / 2, s, s + h
    g.push(frame_m(side, plane, o["at"]))
    quad(g, [(L, B, 0), (L, T, 0), (L, T, -d), (L, B, -d)], (1, 0, 0), WHITE)
    quad(g, [(R, B, 0), (R, T, 0), (R, T, -d), (R, B, -d)], (-1, 0, 0), WHITE)
    quad(g, [(L, T, 0), (R, T, 0), (R, T, -d), (L, T, -d)], (0, -1, 0), WHITE)
    g.box((0, (B + T) / 2, -d + 0.03), (w - 0.02, h - 0.01, 0.05), o.get("mat", "door_white"))
    if o.get("lights", True):
        gl = w / 2 - 0.16
        z0, z1 = B + h * 0.42, T - 0.22
        quad(g, [(-gl, z0, -d + 0.062), (gl, z0, -d + 0.062), (gl, z1, -d + 0.062), (-gl, z1, -d + 0.062)], (0, 0, 1), "window_dark")
        for z in (z0, z1):
            g.box((0, z, -d + 0.066), (2 * gl + 0.06, 0.05, 0.02), WHITE)
        for sx in (-gl, gl):
            g.box((sx, (z0 + z1) / 2, -d + 0.066), (0.05, z1 - z0 + 0.05, 0.02), WHITE)
        g.box((0, (z0 + z1) / 2, -d + 0.066), (0.03, z1 - z0, 0.02), WHITE)
    g.box((R - 0.12, B + 0.98, -d + 0.075), (0.04, 0.14, 0.04), "chrome")
    for sx in (-1, 1):
        g.box((sx * (w / 2 + cw / 2), (B + T) / 2 + cw / 2, 0.015), (cw, h + cw, 0.03), WHITE)
    g.box((0, T + cw / 2, 0.015), (w + 2 * cw, cw, 0.03), WHITE)
    g.box((0, T + cw + 0.02, 0.04), (w + 2 * cw + 0.08, 0.04, 0.08), WHITE)
    g.pop()


def step(g, side, plane, at, w, flights):
    """Stone steps in front of a door: (depth from the wall, top z, bottom z) per block; the bottom lies under the lowest
    ground, so no block floats whatever the ground does."""
    g.push(frame_m(side, plane, at))
    for depth, top, bottom in flights:
        g.box((0, (top + bottom) / 2, depth / 2 + 0.03), (w, top - bottom, depth), STONE)
    g.pop()


def win(at, w=1.0, h=1.05, sill=0.85, bars=(2, 1), **k):
    """Window spec: centre `at` along its wall, size, sill height above the floor (FL)."""
    return dict(at=at, w=w, h=h, sill=sill, bars=bars, **k)


def dr(at, w=0.95, h=2.0, **k):
    return dict(at=at, w=w, h=h, sill=0.0, kind="door", **k)


def build_wall(g, W, FL, TV, mat="falu_red_vertical"):
    """One planar wall of a building. W: side, plane, lo, hi, top(c, m) (z of the wall top, 0.09 under the roof top: inside
    the roof slab), brk (breakpoints of top), ops (window / door specs). Opening sizes are clipped here so the casing and drip cap
    stay 0.17 under the roof's underside; the wall's holes are cut from the clipped sizes. Corners are closed by corner boards
    (corner_boards), not by wall thickness."""
    top, ops = W["top"], []
    for o in W["ops"]:
        o = dict(o)
        o["side"], o["z"] = W["side"], FL if o.get("kind") == "door" else FL + o["sill"]
        a, b = o["at"] - o["w"] / 2 - 0.1, o["at"] + o["w"] / 2 + 0.1
        lim = min(top(a, a), top(b, b), top(o["at"], o["at"])) + 0.09 - TV - 0.17
        o["h"] = min(o["h"], lim - o["z"])
        assert o["h"] > 0.3, ("opening does not fit under the roof", W["side"], W["plane"], o["at"], o["h"])
        ops.append(o)
    holes = [(o["at"] - o["w"] / 2, o["at"] + o["w"] / 2, o["z"], o["z"] + o["h"]) for o in ops]
    wall(g, W["side"], W["plane"], W["lo"], W["hi"], FL, top, mat, holes, W.get("brk", ()))
    for o in ops:
        o["sill"] = o["z"]
        (door if o.get("kind") == "door" else window)(g, W["side"], W["plane"], o)


# ---------------------------------------------------------------------------------------------
# roofs: planes z = a x + b y + c over convex plan polygons
# ---------------------------------------------------------------------------------------------
def clip(poly, f):
    """Sutherland-Hodgman against f(p) >= 0, f linear in (x, y)."""
    out = []
    for p, q in zip(poly, poly[1:] + poly[:1]):
        fp, fq = f(p), f(q)
        if fp >= -1e-9:
            out.append(p)
        if (fp > 1e-9 and fq < -1e-9) or (fp < -1e-9 and fq > 1e-9):
            t = fp / (fp - fq)
            out.append((p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t))
    return [p for i, p in enumerate(out) if np.hypot(p[0] - out[i - 1][0], p[1] - out[i - 1][1]) > 1e-7]


def area(poly):
    return 0.5 * sum(p[0] * q[1] - q[0] * p[1] for p, q in zip(poly, poly[1:] + poly[:1]))


def slab(g, poly, pl, mat, tv, free=(), under=WHITE, edge=WHITE, zref=None, lip=0.035):
    """One roof plane over a convex plan polygon: top on z = pl.a x + pl.b y + pl.c (clay-tile courses as stepped geometry,
    as kit._roof_slab), soffit tv below, and a fascia / barge face on the `free` edges (pairs of plan points).
    zref aligns the course steps of the pieces of one plane."""
    if area(poly) < 0:
        poly = poly[::-1]
    a, b, c = pl
    Z = lambda p: a * p[0] + b * p[1] + c
    cl = kit.TILE_ROOFS.get(mat)
    dz = z0 = None
    if cl:
        m = math.hypot(a, b)
        dz = cl * m / math.sqrt(1 + m * m)
        zs = [Z(p) for p in poly]
        z0 = zref if zref is not None else min(zs)
        for k in range(int(math.floor((min(zs) - z0) / dz + 1e-9)), int(math.ceil((max(zs) - z0) / dz - 1e-9))):
            lo, hi = z0 + k * dz, z0 + (k + 1) * dz
            band = clip(clip(poly, lambda p: Z(p) - lo), lambda p: hi - Z(p))
            if len(band) < 3 or abs(area(band)) < 1e-5:
                continue
            g.poly([(p[0], p[1], Z(p) + lip * (1 - (Z(p) - lo) / dz)) for p in band], mat)
            for p, q in zip(band, band[1:] + band[:1]):          # the course's front: a riser along its low contour
                if abs(Z(p) - lo) < 1e-6 and abs(Z(q) - lo) < 1e-6 and np.hypot(q[0] - p[0], q[1] - p[1]) > 1e-4:
                    quad(g, [(p[0], p[1], lo), (q[0], q[1], lo), (q[0], q[1], lo + lip), (p[0], p[1], lo + lip)], (-a, -b, 0), mat)
    else:
        g.poly([(p[0], p[1], Z(p)) for p in poly], mat)
    g.poly([(p[0], p[1], Z(p) - tv) for p in reversed(poly)], under)
    key = lambda p: (round(p[0], 4), round(p[1], 4))
    fr = {frozenset((key(f[0]), key(f[1]))): (f[2] if len(f) > 2 else tv) for f in free}   # (p, q[, depth of the fascia])
    for p, q in zip(poly, poly[1:] + poly[:1]):
        d = fr.get(frozenset((key(p), key(q))))
        if d is not None:
            top = edge_top(p, q, Z, cl, z0, dz, lip) if cl else [(0.0, Z(p)), (1.0, Z(q))]
            pts = [(p[0], p[1], Z(p) - d), (q[0], q[1], Z(q) - d)]
            pts += [(p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, z) for t, z in reversed(top)]
            g.poly(pts, edge)
            if d > tv + 1e-6:      # a deep barge board hangs free: its inner face shows from under the eave, so it gets a
                nx, ny = q[1] - p[1], p[0] - q[0]      # second face 2 cm behind (reversed copies at the same place are welded away)
                k = 0.02 / math.hypot(nx, ny)
                g.poly([(x - nx * k, y - ny * k, z) for x, y, z in pts[::-1]], edge)


def edge_top(p, q, Z, cl, z0, dz, lip):
    """Top of a fascia / barge face along the plan edge p-q: it follows the stepped course tops exactly (z + lift at every
    course contour), so the face and the tile surface share their edge and nothing shows between them."""
    lift = lambda z: lip * (1 - ((z - z0) / dz - math.floor((z - z0) / dz + 1e-9)))
    zp, zq = Z(p), Z(q)
    out = [(0.0, zp + lift(zp))]
    if abs(zq - zp) > 1e-9:
        k0, k1 = sorted((zp, zq))
        ks = [z0 + k * dz for k in range(int(math.ceil((k0 - z0) / dz + 1e-9)), int(math.floor((k1 - z0) / dz - 1e-9)) + 1)]
        if zq < zp:
            ks.reverse()
        for c in ks:
            t = (c - zp) / (zq - zp)
            out += [(t, c + (0.0 if zq > zp else lip)), (t, c + (lip if zq > zp else 0.0))]
    out.append((1.0, zq + lift(zq)))
    return out


def ridge_cap(g, p, q, z, mat, w=0.28, h=0.12):
    g.beam((p[0], p[1], z + 0.03), (q[0], q[1], z + 0.03), w, h, mat)


def flashing(g, v0, v1, pa, pb, side_a, w=0.2, lift=0.045):
    """Galvanised valley flashing: two strips along the valley v0-v1 on planes pa and pb (a, b, c), side_a: a point in
    plane a's region. Hides the tile-course seam where two planes meet."""
    d = np.subtract(v1, v0) / np.hypot(*np.subtract(v1, v0))
    nrm = np.array([-d[1], d[0]])
    if nrm @ (np.subtract(side_a, v0)) < 0:
        nrm = -nrm
    for pl, s in ((pa, 1), (pb, -1)):
        pts = []
        for q, k in ((v0, 0), (v1, 0), (np.add(v1, s * nrm * w), 1), (np.add(v0, s * nrm * w), 1)):
            pts.append((q[0], q[1], pl[0] * q[0] + pl[1] * q[1] + pl[2] + lift))
        quad(g, pts, (0, 0, 1), "galvanised")


def gutter(g, a, b, nout, ez, r=0.07, mat="galvanised"):
    """Half-round gutter along the eave line a-b (plan points), `nout` the plan direction away from the wall, ez the z of the
    fascia's top edge. A thin shell: an outer half-pipe and an inner one 12 mm inside it (the kit's to_object welds and drops
    coincident reversed copies, so a double-sided gutter would end up one-sided), open top, closed ends. Returns the gutter top z."""
    a, b, nout = np.array(a, float), np.array(b, float), np.array(nout, float)
    d = (b - a) / np.hypot(*(b - a))
    cpos = nout * r * 0.6
    gz = ez - 0.11
    nprof = 7
    ang = [math.pi + math.pi * k / (nprof - 1) for k in range(nprof)]
    P = lambda q, rr, an: (q[0] + cpos[0] + nout[0] * rr * math.cos(an), q[1] + cpos[1] + nout[1] * rr * math.cos(an), gz + rr * math.sin(an))
    for rr, sgn in ((r, 1), (r - 0.012, -1)):
        for k in range(nprof - 1):
            am = (ang[k] + ang[k + 1]) / 2
            out = (nout[0] * math.cos(am) * sgn, nout[1] * math.cos(am) * sgn, math.sin(am) * sgn)
            quad(g, [P(a, rr, ang[k]), P(b, rr, ang[k]), P(b, rr, ang[k + 1]), P(a, rr, ang[k + 1])], out, mat)
    for an in (ang[0], ang[-1]):                                    # the rim between the two shells
        quad(g, [P(a, r, an), P(b, r, an), P(b, r - 0.012, an), P(a, r - 0.012, an)], (0, 0, 1), mat)
    for e, s in ((a, -1), (b, 1)):
        quad(g, [P(e, r, an) for an in ang], (d[0] * s, d[1] * s, 0), mat)
    return gz


def downpipe(g, wallpt, nout, dg, zg, zfoot, mat="galvanised"):
    """Gutter outlet -> jog in under the eave -> straight down the wall -> shoe on a splash stone.
    wallpt: plan point on the wall line where the pipe stands; nout: plan direction out of the wall; dg: distance of the
    gutter centre from the wall; zg: gutter bottom; zfoot: ground height at the foot (the pipe always ends on it)."""
    w, nout = np.array(wallpt, float), np.array(nout, float)
    at = lambda d, z: (w[0] + nout[0] * d, w[1] + nout[1] * d, z)
    off = 0.09
    pts = [at(dg, zg), at(dg, zg - 0.22), at(off, zg - 0.22 - (dg - off)), at(off, zfoot + 0.2), at(off + 0.2, zfoot + 0.1)]
    for p, q in zip(pts, pts[1:]):
        g.pipe(p, q, 0.045, mat, seg=8)
    for z in np.arange(zfoot + 0.7, pts[2][2] - 0.2, 1.0):
        g.beam(at(0.0, z), at(off, z), 0.03, 0.03, mat)          # bracket to the wall
    g.box(at(off + 0.3, zfoot), (0.45, 0.4, 0.12), STONE, rz=-math.degrees(math.atan2(nout[1], nout[0])))


def stoop(g, side, plane, at, w, depth, top, bottom):
    step(g, side, plane, at, w, [(depth, top, bottom)])


# ---------------------------------------------------------------------------------------------
# the house group
# ---------------------------------------------------------------------------------------------
def tent(z, t, c, u):
    """Roof top of a gable at coordinate u: ridge height z over ridge line c, pitch t."""
    return z - t * abs(u - c)


def build(add, new, ev):
    house(add, new, ev)
    outbuilding(add, new, ev)
    barn(add, new, ev)
    cottage(add, new, ev)


# ---------------------------------------------------------------------------------------------
# house, OSM 786179224.  Lidar fits in the frame at 26.5 deg about (477610.46, 6457550.72), heights absolute (RH2000).
#   wing A (long, ridge along x):  ridge y 0.71, z 111.71, tan 0.554 (rms 0.05, 105 returns)
#   wing B (across, ridge along y): ridge x 3.61, z 111.87, tan 0.495 (rms 0.04..0.06, 140 returns); ridge flat along y
#   entrance gable ("kvist") on B's east slope: ridge y 1.6, z 110.72 level, 7 returns 0.5-0.9 m above B's plane; its
#     pitch is inferred equal to B's (0.495), which puts its eaves exactly on B's roof at the wall and its valleys at 45 deg
#   eaves: B's x 7.7..8.0 is covered by returns (x 7.98 on the plane), the west side has none: roof symmetric about the ridge
#     (half width 4.2); A reaches y 4.1 on the north (returns) and is symmetric (3.8) about its ridge; B's ends: y -3.9
#     (return at -3.88) and 6.45 (last returns 6.5); A's west gable x -7.0 (returns to -6.4, ortho -6.9 + the 0.8 shift).
# ---------------------------------------------------------------------------------------------
def house(add, new, ev):
    F = Frame(477610.46, 6457550.72, 26.5)
    Z0, FL = 107.0, 0.62
    OV, BG, TV = 0.45, 0.40, 0.17                      # eave overhang, barge overhang, vertical roof thickness (0.15 slab)
    ZA, YA, TA, HWA = 111.71 - Z0, 0.71, 0.554, 3.8
    ZB, XB, TB, HWB = 111.87 - Z0, 3.61, 0.495, 4.2
    ZD, YD = 110.72 - Z0, 1.6
    xaW, yaS, yaN = -7.0, YA - HWA, YA + HWA
    xbW, xbE, ybS, ybN = XB - HWB, XB + HWB, -3.95, 6.45
    wA = dict(W=xaW + BG, S=yaS + OV, N=yaN - OV)       # wall lines
    wB = dict(W=xbW + OV, E=xbE - OV, S=ybS + BG, N=ybN - BG)
    plB_W, plB_E = (TB, 0, ZB - TB * XB), (-TB, 0, ZB + TB * XB)
    plA_N, plA_S = (0, -TA, ZA + TA * YA), (0, TA, ZA - TA * YA)
    plD_N, plD_S = (0, -TB, ZD + TB * YD), (0, TB, ZD - TB * YD)
    # where the planes meet (plan lines: valleys and the end of A's ridge on B's west slope)
    xP = (ZA - plB_W[2]) / TB                                           # A's ridge ends on B's west plane
    yvn = (plA_N[2] - (plB_W[0] * xbW + plB_W[2])) / TA                 # north valley reaches B's eave line x = xbW
    yvs = ((plB_W[0] * xbW + plB_W[2]) - plA_S[2]) / TA
    xd0 = XB + (ZB - ZD) / TB                                           # dormer ridge meets B's east plane
    yd = xbE - xd0                                                      # 45 degree valleys: reach the eave line at YD +- yd
    pt = lambda *a: tuple(float(v) for v in a)

    g = new()
    cx, cy = 3.0, 1.2                                                   # asset origin: building centre
    g.push(Matrix.Translation((-cx, -cy, 0)))
    # --- footprint, ground, plinth ---
    foot = [(wA["W"], wA["S"]), (wB["W"], wA["S"]), (wB["W"], wB["S"]), (wB["E"], wB["S"]), (wB["E"], wB["N"]), (wB["W"], wB["N"]),
            (wB["W"], wA["N"]), (wA["W"], wA["N"])]
    glow, gmed = ground_under(ev, F, foot)
    zb = glow - Z0 - 0.35                                               # plinth bottom: 0.35 under the lowest ground
    g.extrude(offset_poly(foot, 0.04), zb, FL, STONE, top=STONE, bottom=False)
    ring_report("house", ev, F, foot, FL, Z0, zb)

    # --- roof planes ---
    tile = "tile_clay"
    zA0, zB0 = ZA - TA * HWA, ZB - TB * HWB                             # course origins = eave heights (courses start at the eave)
    # wing A north / south: west part, the triangle up to B's west slope, and the strip under B's eave
    def pieces(sgn):
        yE = yaN if sgn > 0 else yaS
        yv = yvn if sgn > 0 else yvs
        return [([pt(xaW, YA), pt(xbW, YA), pt(xbW, yE), pt(xaW, yE)], [((xaW, yE), (xaW, YA)), ((xbW, yE), (xaW, yE))]),
                ([pt(xbW, YA), pt(xP, YA), pt(xbW, yv)], []),
                ([pt(xbW, yv), pt(wB["W"], yv), pt(wB["W"], yE), pt(xbW, yE)], [((wB["W"], yE), (xbW, yE))])]
    for sgn, pl in ((1, plA_N), (-1, plA_S)):
        for poly, fr in pieces(sgn):
            slab(g, poly, pl, tile, TV, fr, zref=zA0)
    # wing B west slope: north and south of A, with their eave (x = xbW) and gable ends
    slab(g, [pt(xbW, yvn), pt(xbW, ybN), pt(XB, ybN), pt(XB, YA), pt(xP, YA)], plB_W, tile, TV,
         [((xbW, ybN), (xbW, yvn)), ((XB, ybN), (xbW, ybN))], zref=zB0)
    slab(g, [pt(xP, YA), pt(XB, YA), pt(XB, ybS), pt(xbW, ybS), pt(xbW, yvs)], plB_W, tile, TV,
         [((xbW, yvs), (xbW, ybS)), ((xbW, ybS), (XB, ybS))], zref=zB0)
    # wing B east slope, cut by the entrance gable's triangle
    slab(g, [pt(XB, ybN), pt(XB, YD), pt(xd0, YD), pt(xbE, YD + yd), pt(xbE, ybN)], plB_E, tile, TV,
         [((xbE, YD + yd), (xbE, ybN)), ((xbE, ybN), (XB, ybN))], zref=zB0)
    slab(g, [pt(XB, YD), pt(XB, ybS), pt(xbE, ybS), pt(xbE, YD - yd), pt(xd0, YD)], plB_E, tile, TV,
         [((XB, ybS), (xbE, ybS)), ((xbE, ybS), (xbE, YD - yd))], zref=zB0)
    # entrance gable: two small planes, barge boards on the front edge (x = xbE)
    for pl, poly in ((plD_N, [pt(xd0, YD), pt(xbE, YD), pt(xbE, YD + yd)]), (plD_S, [pt(xd0, YD), pt(xbE, YD - yd), pt(xbE, YD)])):
        slab(g, poly, pl, tile, TV, [((xbE, YD), (xbE, YD + yd))] if pl is plD_N else [((xbE, YD - yd), (xbE, YD))], zref=ZD - TB * yd)
    # ridges, valleys
    ridge_cap(g, (xaW, YA), (xP + 0.05, YA), ZA, tile)
    ridge_cap(g, (XB, ybS), (XB, ybN), ZB, tile)
    ridge_cap(g, (xd0 - 0.05, YD), (xbE, YD), ZD, tile)
    flashing(g, (xP, YA), (xbW, yvn), plA_N, plB_W, (xP - 1, YA + 1))
    flashing(g, (xP, YA), (xbW, yvs), plA_S, plB_W, (xP - 1, YA - 1))
    flashing(g, (xd0, YD), (xbE, YD + yd), plD_N, plB_E, (xd0 + 1, YD + .3))
    flashing(g, (xd0, YD), (xbE, YD - yd), plD_S, plB_E, (xd0 + 1, YD - .3))

    # --- walls (to 0.09 under the roof top, inside the slab) ---
    topB = lambda c, m: tent(ZB, TB, XB, c) - 0.09
    topA = lambda c, m: tent(ZA, TA, YA, c) - 0.09
    eaveB = ZB - TB * (wB["E"] - XB) - 0.09
    eaveA = ZA - TA * (YA - wA["S"]) - 0.09
    topE = lambda c, m: max(eaveB, tent(ZD, TB, YD, c) - 0.09)           # the entrance gable's front wall rises from the eave
    walls = [
        dict(side="+x", plane=wB["E"], lo=wB["S"], hi=wB["N"], top=topE, brk=(YD - yd, YD, YD + yd),
             ops=[dr(YD, 1.0, 2.0), win(-1.8, 1.1, 1.15, 0.9), win(4.8, 1.1, 1.15, 0.9)]),
        dict(side="-y", plane=wB["S"], lo=wB["W"], hi=wB["E"], top=topB, brk=(XB,),
             ops=[win(1.6, 1.1, 1.15, 0.9), win(5.6, 1.1, 1.15, 0.9), win(XB, 0.7, 0.8, 2.75, (1, 1))]),
        dict(side="+y", plane=wB["N"], lo=wB["W"], hi=wB["E"], top=topB, brk=(XB,),
             ops=[win(1.6, 1.1, 1.15, 0.9), win(5.6, 1.1, 1.15, 0.9), win(XB, 0.7, 0.8, 2.75, (1, 1))]),
        dict(side="-x", plane=wB["W"], lo=wB["S"], hi=wA["S"], top=lambda c, m: eaveB, ops=[]),
        dict(side="-x", plane=wB["W"], lo=wA["N"], hi=wB["N"], top=lambda c, m: eaveB, ops=[win(5.3, 0.8, 1.1, 0.9)]),
        dict(side="-y", plane=wA["S"], lo=wA["W"], hi=wB["W"], top=lambda c, m: eaveA,
             ops=[win(-5.3, 1.0, 0.95, 0.85), win(-3.0, 1.0, 0.95, 0.85), win(-1.3, 0.8, 0.95, 0.85, (1, 1))]),
        dict(side="+y", plane=wA["N"], lo=wA["W"], hi=wB["W"], top=lambda c, m: eaveA,
             ops=[win(-5.0, 1.0, 0.95, 0.85), win(-2.6, 1.0, 0.95, 0.85)]),
        dict(side="-x", plane=wA["W"], lo=wA["S"], hi=wA["N"], top=topA, brk=(YA,),
             ops=[win(-0.45, 1.0, 0.95, 0.85), win(1.85, 1.0, 0.95, 0.85), win(YA, 0.7, 0.8, 2.6, (1, 1))]),
    ]
    for W in walls:
        build_wall(g, W, FL, TV)
    corner_boards(g, foot, walls, FL)
    stoop(g, "+x", wB["E"], YD, 1.5, 0.9, FL - 0.02, zb)

    # --- gutters and downpipes: free eaves only (not under the gables, not where the other wing's roof is) ---
    eave = lambda a, b, nout, ez, pipes, plane: eave_line(g, ev, F, Z0, OV, a, b, nout, ez, pipes, plane)
    eave((xaW + 0.05, yaN), (wB["W"] - 0.05, yaN), (0, 1), zA0, [xaW + 0.6, wB["W"] - 0.35], wA["N"])
    eave((xaW + 0.05, yaS), (wB["W"] - 0.05, yaS), (0, -1), zA0, [xaW + 0.6, wB["W"] - 0.35], wA["S"])
    eave((xbW, yvn + 0.12), (xbW, ybN - 0.05), (-1, 0), zB0, [yvn + 0.4, ybN - 0.13], wB["W"])
    eave((xbW, ybS + 0.05), (xbW, yvs - 0.12), (-1, 0), zB0, [ybS + 0.6], wB["W"])
    eave((xbE, YD + yd + 0.12), (xbE, ybN - 0.05), (1, 0), zB0, [YD + yd + 0.45, ybN - 0.65], wB["E"])
    eave((xbE, ybS + 0.05), (xbE, YD - yd - 0.12), (1, 0), zB0, [ybS + 0.6, YD - yd - 0.45], wB["E"])
    g.pop()
    add("omberg_cot_house", g, *F.en(cx, cy), F.yaw, Z0)


def eave_line(g, ev, F, Z0, OV, a, b, nout, ez, pipes, wall_plane):
    """Gutter on the eave a-b (plan points, fascia top at ez, `nout` away from the wall) with a downpipe at each coordinate
    in `pipes` (along the eave); each pipe ends on the course terrain at its foot."""
    gz = gutter(g, a, b, nout, ez)
    for c in pipes:
        wp = (c, wall_plane) if nout[0] == 0 else (wall_plane, c)
        downpipe(g, wp, nout, OV + 0.04, gz - 0.07, ev.terrain(*F.en(*wp)) - Z0)


def corner_boards(g, foot, walls, FL, s=0.12):
    """White corner boards from the floor to the lower wall top at every footprint corner (inside corners too)."""
    def top_at(x, y):
        z = []
        for W in walls:
            c, p = (x, y) if W["side"][1] == "y" else (y, x)
            if abs(p - W["plane"]) < 1e-6 and W["lo"] - 1e-6 <= c <= W["hi"] + 1e-6:
                z.append(W["top"](c, c))
        return min(z)
    for x, y in foot:
        zt = top_at(x, y)
        g.box((x, y, (FL + zt) / 2), (s, s, zt - FL), WHITE)



# ---------------------------------------------------------------------------------------------
# outbuilding, OSM 786179223.  Same frame as the house.  Lidar: planes tan 0.493 (rms 0.045, 150 returns), ridge y 9.0 (0.4 north
# of the OSM centre line; 9.05 with the south eave held off the house wall), z 111.157, ridge direction parallel to the house (25..26.5 deg); roof returns x 6.4..14.05, y 6.07..12.0.
# Its south-west roof corner reaches under the house north-east eave: the overhangs overlap in plan (x 6.3..7.8, y 6.1..6.45), but
# its tiles are 0.25 m under the house roof soffit there (O top 109.78 at the corner, the house slab underside 110.02) and its
# eave starts just north of the house gable wall plane (y 6.05), so nothing of it is inside that wall.
# Walls inferred: falu red with white trim like the farm road house; a garage door on the yard (south) side since the black cars
# stand there, a person door, small windows.
# ---------------------------------------------------------------------------------------------
def outbuilding(add, new, ev):
    F = Frame(477610.46, 6457550.72, 26.5)
    Z0, FL, OV, BG, TV = 107.0, 0.46, 0.45, 0.40, 0.17
    YR, ZR, T, HW = 9.05, 111.157 - Z0, 0.49, 2.95
    x0, x1 = 6.3, 14.2
    yS, yN = YR - HW, YR + HW
    wl = dict(W=x0 + BG, E=x1 - BG, S=yS + OV, N=yN - OV)
    cx = (x0 + x1) / 2
    g = new()
    g.push(Matrix.Translation((-cx, -YR, 0)))
    foot = [(wl["W"], wl["S"]), (wl["E"], wl["S"]), (wl["E"], wl["N"]), (wl["W"], wl["N"])]
    glow, gmed = ground_under(ev, F, foot)
    zb = glow - Z0 - 0.35
    g.extrude(offset_poly(foot, 0.04), zb, FL, STONE, top=STONE, bottom=False)
    ring_report("outbuilding", ev, F, foot, FL, Z0, zb)
    zE = ZR - T * HW
    for pl, ys, fr in (((0, -T, ZR + T * YR), yN, [((x0, yN), (x0, YR)), ((x1, yN), (x0, yN)), ((x1, YR), (x1, yN))]),
                       ((0, T, ZR - T * YR), yS, [((x0, YR), (x0, yS)), ((x0, yS), (x1, yS)), ((x1, yS), (x1, YR))])):
        slab(g, [(x0, YR), (x1, YR), (x1, ys), (x0, ys)], pl, "tile_clay", TV, fr, zref=zE)
    ridge_cap(g, (x0, YR), (x1, YR), ZR, "tile_clay")
    top = lambda c, m: tent(ZR, T, YR, c) - 0.09
    eave_top = lambda c, m: ZR - T * (HW - OV) - 0.09
    walls = [
        dict(side="-y", plane=wl["S"], lo=wl["W"], hi=wl["E"], top=eave_top,
             ops=[win(7.75, 0.8, 0.8, 1.0, (1, 1)), dr(10.3, 2.5, 2.0, lights=False, mat="door_white"), dr(12.7, 0.9, 1.9)]),
        dict(side="+y", plane=wl["N"], lo=wl["W"], hi=wl["E"], top=eave_top, ops=[win(8.4, 0.9, 0.8, 1.0, (2, 1)), win(12.2, 0.9, 0.8, 1.0, (2, 1))]),
        dict(side="-x", plane=wl["W"], lo=wl["S"], hi=wl["N"], top=top, brk=(YR,), ops=[win(YR, 0.8, 0.8, 1.0, (1, 1))]),
        dict(side="+x", plane=wl["E"], lo=wl["S"], hi=wl["N"], top=top, brk=(YR,), ops=[win(YR - 1.0, 0.8, 0.8, 1.0, (1, 1)), win(YR + 1.0, 0.8, 0.8, 1.0, (1, 1)), win(YR, 0.5, 0.6, 2.45, (1, 1))]),
    ]
    for W in walls:
        build_wall(g, W, FL, TV)
    corner_boards(g, foot, walls, FL)
    stoop(g, "-y", wl["S"], 10.3, 3.1, 0.9, FL - 0.03, zb)            # apron in front of the garage door
    stoop(g, "-y", wl["S"], 12.7, 1.4, 0.7, FL - 0.02, zb)
    eave = lambda a, b, nout, ez, pipes, plane: eave_line(g, ev, F, Z0, OV, a, b, nout, ez, pipes, plane)
    eave((8.5, yS), (x1 - 0.05, yS), (0, -1), zE, [13.6], wl["S"])
    eave((x0 + 0.05, yN), (x1 - 0.05, yN), (0, 1), zE, [x0 + 0.6, x1 - 0.6], wl["N"])
    g.pop()
    add("omberg_cot_outbuilding", g, *F.en(cx, YR), F.yaw, Z0)


# ---------------------------------------------------------------------------------------------
# barn, OSM 786179225.  Frame at -8.6 deg about (477411.59, 6457660.19) (x east-south-east, compass bearing 98.6).
# Lidar (270 returns, rms 0.04): a symmetric steep gable, ridge y 2.51, z 103.72, tan 0.79, half width 3.4 (north eave y 5.9;
# the plane returns 101.3 at y 5.7), whose south side breaks at y -0.89 (z 101.03) into a shallow plane, tan 0.097 (rms 0.036,
# 88 returns), down to the south eave at y -4.75: one roof with a kink, no wall between.  Roof x -8.3..9.95 (ortho shifted 0.9).
# Ortho: red corrugated sheet, a lighter rectangle x -1.8..7.3 (ortho frame, +0.9 here) on the steep south plane just above
# the kink: modelled as a raised pale-sheet band.  Inferred: board walls falu red, the big sliding doors on the east gable (the
# track and the worn yard are to the east and north; only the gable is tall enough for a 2.6 m door), a person door and small
# windows on the long north wall, loft hatch and louvre in the gables.
# ---------------------------------------------------------------------------------------------
def barn(add, new, ev):
    F = Frame(477411.59, 6457660.19, -8.6)
    Z0, FL, OV, BG, TV = 98.5, 0.38, 0.45, 0.40, 0.13
    YR, ZR, T, HW, TL = 2.51, 103.72 - 98.5, 0.79, 3.4, 0.097
    x0, x1 = -8.5, 10.1
    yk, yN, yS = YR - HW, YR + HW, -4.75
    zk = ZR - T * HW
    cx, cy = (x0 + x1) / 2, (yS + yN) / 2
    wl = dict(W=x0 + BG, E=x1 - BG, S=yS + OV, N=yN - OV)
    g = new()
    g.push(Matrix.Translation((-cx, -cy, 0)))
    foot = [(wl["W"], wl["S"]), (wl["E"], wl["S"]), (wl["E"], wl["N"]), (wl["W"], wl["N"])]
    glow, gmed = ground_under(ev, F, foot)
    zb = glow - Z0 - 0.35
    g.extrude(offset_poly(foot, 0.04), zb, FL, STONE, top=STONE, bottom=False)
    ring_report("barn", ev, F, foot, FL, Z0, zb)
    plN, plS, plL = (0, -T, ZR + T * YR), (0, T, ZR - T * YR), (0, TL, zk - TL * yk)
    red, fr_ = "sheet_red", dict(edge="sheet_frame", under="sheet_frame")
    slab(g, [(x0, YR), (x1, YR), (x1, yN), (x0, yN)], plN, red, TV, [((x0, yN), (x0, YR)), ((x1, yN), (x0, yN)), ((x1, YR), (x1, yN))], **fr_)
    slab(g, [(x0, yk), (x1, yk), (x1, YR), (x0, YR)], plS, red, TV, [((x0, YR), (x0, yk)), ((x1, yk), (x1, YR))], **fr_)
    slab(g, [(x0, yS), (x1, yS), (x1, yk), (x0, yk)], plL, red, TV, [((x0, yk), (x0, yS)), ((x0, yS), (x1, yS)), ((x1, yS), (x1, yk))], **fr_)
    ridge_cap(g, (x0, YR), (x1, YR), ZR, "sheet_frame", 0.34, 0.12)
    ridge_cap(g, (x0, yk), (x1, yk), zk - 0.02, "sheet_frame", 0.26, 0.05)      # flashing over the break in pitch
    # the lighter band: pale sheet 3 cm proud of the red, with a thin red rim (roof-light or new sheets)
    px0, px1, py0, py1 = -0.9, 8.2, yk + 0.12, YR - 0.55
    Zs = lambda p: plS[1] * p[1] + plS[2] + 0.03
    patch = [(px0, py0), (px1, py0), (px1, py1), (px0, py1)]
    g.poly([(p[0], p[1], Zs(p)) for p in patch], "sheet_pale")
    for p, q in zip(patch, patch[1:] + patch[:1]):
        quad(g, [(p[0], p[1], Zs(p) - 0.03), (q[0], q[1], Zs(q) - 0.03), (q[0], q[1], Zs(q)), (p[0], p[1], Zs(p))], (q[1] - p[1], p[0] - q[0], 0), "sheet_frame")
    # --- walls ---
    ztop = lambda c: (zk + TL * (c - yk) if c < yk else ZR - T * abs(c - YR)) - 0.09
    gab = lambda c, m: ztop(c)
    walls = [
        dict(side="+x", plane=wl["E"], lo=wl["S"], hi=wl["N"], top=gab, brk=(yk, YR), ops=[win(YR, 1.2, 0.7, 3.35, (3, 1))]),
        dict(side="-x", plane=wl["W"], lo=wl["S"], hi=wl["N"], top=gab, brk=(yk, YR), ops=[win(YR, 0.9, 0.9, 2.3, (2, 2))]),
        dict(side="+y", plane=wl["N"], lo=wl["W"], hi=wl["E"], top=lambda c, m: ztop(wl["N"]),
             ops=[dr(4.4, 0.95, 1.85, mat="door_red", lights=False), win(-6.2, 0.7, 0.55, 1.05), win(-2.6, 0.7, 0.55, 1.05), win(0.9, 0.7, 0.55, 1.05),
                  win(7.5, 0.7, 0.55, 1.05)]),
        dict(side="-y", plane=wl["S"], lo=wl["W"], hi=wl["E"], top=lambda c, m: ztop(wl["S"]),
             ops=[win(-5.5, 0.7, 0.5, 0.75), win(-1.5, 0.7, 0.5, 0.75), win(3.5, 0.7, 0.5, 0.75), win(7.0, 0.7, 0.5, 0.75)]),
    ]
    for W in walls:
        build_wall(g, W, FL, TV)
    corner_boards(g, foot, walls, FL)
    sliding_door(g, wl["E"], YR, 3.4, 2.65, FL)
    stoop(g, "+y", wl["N"], 4.4, 1.3, 0.7, FL - 0.02, zb)
    eave = lambda a, b, nout, ez, pipes, plane: eave_line(g, ev, F, Z0, OV, a, b, nout, ez, pipes, plane)
    eave((x0 + 0.05, yN), (x1 - 0.05, yN), (0, 1), zk, [x0 + 0.6, x1 - 0.6], wl["N"])
    eave((x0 + 0.05, yS), (x1 - 0.05, yS), (0, -1), zk + TL * (yS - yk), [x0 + 0.6, x1 - 0.6], wl["S"])
    g.pop()
    add("omberg_cot_barn", g, *F.en(cx, cy), F.yaw, Z0)


def sliding_door(g, plane, yc, w, h, FL):
    """Two board leaves on a rail in front of the east gable wall (closed): white frame boards, a brace on each leaf, a rail
    with hangers. Hung 0.10 off the wall, so it is the cover of the wall, not a hole in it."""
    t, off = 0.06, 0.10
    lw = w / 2 + 0.05
    z0, z1 = FL, FL + h
    xf = plane + off + t / 2 + 0.015
    for s in (-1, 1):
        yl = yc + s * (lw / 2 - 0.05)
        g.box((plane + off, yl, (z0 + z1) / 2), (t, lw, h), "door_red")
        for zz in (z0 + 0.35, z1 - 0.35):                               # ledges
            g.box((xf, yl, zz), (0.03, lw - 0.04, 0.14), WHITE)
        g.beam((xf, yl - s * (lw / 2 - 0.1), z0 + 0.35), (xf, yl + s * (lw / 2 - 0.1), z1 - 0.35), 0.03, 0.11, WHITE)   # diagonal brace
    for s in (-1, 1):                                                   # frame boards round the closed pair
        g.box((plane + off - 0.01, yc + s * (w / 2 + 0.08), (z0 + z1) / 2 + 0.06), (0.05, 0.14, h + 0.12), WHITE)
    g.box((plane + off - 0.01, yc, z1 + 0.1), (0.05, w + 0.30, 0.14), WHITE)
    g.box((plane + off + 0.12, yc, z1 + 0.28), (0.07, w + 1.0, 0.09), "black_steel")   # rail
    for s in (-1, 1):
        g.box((plane + off + 0.045, yc + s * (w / 4), z1 + 0.17), (0.03, 0.05, 0.22), "black_steel")   # hangers


# ---------------------------------------------------------------------------------------------
# mossy cottage, OSM 1431567004 (east of the barn, in the trees).  Frame at -28.4 deg about (477472.14, 6457653.45).
# Ortho 2025: an L-shaped roof of old tile under moss (brown-green), trees all round.  Lidar (150 returns, rms 0.06): a steep
# gable, ridge y -1.2, z 105.74, tan 0.755, returns x -4.6..5.4, S returns to y -3.9 (z 103.7); its north side breaks at y 1.2
# (z 103.93) into a shallow plane (tan 0.226, rms 0.013) in the east part x > 1.5 - the wing of the L - down to y 4.0 (z 103.3);
# in the west part the steep plane runs on to the eave at y 2.2 (z 103.17).  The south and north eaves are symmetric about the
# ridge (half width 3.5, inferred), walls dark falu red (inferred), the door in the east gable.
# 1431567005 (south of it) is a tree crown in the ortho and in the lidar (returns 7-14 m above ground): not built.
# ---------------------------------------------------------------------------------------------
def cottage(add, new, ev):
    F = Frame(477472.14, 6457653.45, -28.4)
    Z0, FL, OV, BG, TV = 100.9, 0.35, 0.40, 0.35, 0.15
    YR, ZR, T, HW = -1.2, 105.74 - Z0, 0.755, 3.5
    yk, TS = 1.2, 0.226
    zk = ZR - T * (yk - YR)
    x0, x1, xs0 = -4.8, 5.55, 1.2
    yS, yN, yNs = YR - HW, YR + HW, 4.35
    wl = dict(W=x0 + BG, E=x1 - BG, S=yS + OV, N=yN - OV, NS=yNs - OV, WW=xs0 + BG + 0.05)
    cx, cy = (x0 + x1) / 2, (yS + yNs) / 2
    g = new()
    g.push(Matrix.Translation((-cx, -cy, 0)))
    foot = [(wl["W"], wl["S"]), (wl["E"], wl["S"]), (wl["E"], wl["NS"]), (wl["WW"], wl["NS"]), (wl["WW"], wl["N"]), (wl["W"], wl["N"])]
    glow, gmed = ground_under(ev, F, foot)
    zb = glow - Z0 - 0.35
    g.extrude(offset_poly(foot, 0.04), zb, FL, STONE, top=STONE, bottom=False)
    ring_report("cottage", ev, F, foot, FL, Z0, zb)
    tile = "tile_moss"
    plN, plS, plK = (0, -T, ZR + T * YR), (0, T, ZR - T * YR), (0, -TS, zk + TS * yk)
    zE = ZR - T * HW
    slab(g, [(x0, YR), (x1, YR), (x1, yS), (x0, yS)], plS, tile, TV, [((x0, YR), (x0, yS)), ((x0, yS), (x1, yS)), ((x1, yS), (x1, YR))], zref=zE)
    slab(g, [(x0, YR), (xs0, YR), (xs0, yN), (x0, yN)], plN, tile, TV, [((x0, yN), (x0, YR)), ((xs0, yN), (x0, yN))], zref=zE)
    slab(g, [(xs0, YR), (x1, YR), (x1, yk), (xs0, yk)], plN, tile, TV, [((x1, yk), (x1, YR))], zref=zE)
    # the wing's skirt: west barge hangs 0.6 so it reaches the lower west roof beside it
    slab(g, [(xs0, yk), (x1, yk), (x1, yNs), (xs0, yNs)], plK, tile, TV,
         [((xs0, yk), (xs0, yNs), 0.6), ((xs0, yNs), (x1, yNs)), ((x1, yNs), (x1, yk))], zref=zk - TS * (yNs - yk))
    ridge_cap(g, (x0, YR), (x1, YR), ZR, tile)
    ridge_cap(g, (xs0, yk), (x1, yk), zk - 0.02, "galvanised", 0.2, 0.04)           # flashing over the break in pitch
    ztop = lambda c: (ZR - T * abs(c - YR) if c <= yk else zk - TS * (c - yk)) - 0.09
    mtop = lambda c: ZR - T * abs(c - YR) - 0.09
    walls = [
        dict(side="-y", plane=wl["S"], lo=wl["W"], hi=wl["E"], top=lambda c, m: mtop(wl["S"]), ops=[win(-2.4, 0.9, 0.95, 0.85), win(2.2, 0.9, 0.95, 0.85)]),
        dict(side="-x", plane=wl["W"], lo=wl["S"], hi=wl["N"], top=lambda c, m: mtop(c), brk=(YR,), ops=[win(-2.4, 0.9, 0.95, 0.85), win(YR + 0.9, 0.9, 0.95, 0.85), win(YR, 0.6, 0.7, 2.5, (1, 1))]),
        dict(side="+y", plane=wl["N"], lo=wl["W"], hi=wl["WW"], top=lambda c, m: mtop(wl["N"]), ops=[win(-1.6, 0.9, 0.95, 0.85)]),
        dict(side="-x", plane=wl["WW"], lo=wl["N"], hi=wl["NS"], top=lambda c, m: ztop(c), ops=[]),
        dict(side="+y", plane=wl["NS"], lo=wl["WW"], hi=wl["E"], top=lambda c, m: ztop(wl["NS"]), ops=[win(3.3, 0.9, 0.85, 0.85)]),
        dict(side="+x", plane=wl["E"], lo=wl["S"], hi=wl["NS"], top=lambda c, m: ztop(c), brk=(YR, yk),
             ops=[dr(YR, 0.95, 1.95, mat="door_red", lights=False), win(-3.2, 0.9, 0.95, 0.85), win(YR, 0.6, 0.7, 2.7, (1, 1))]),
    ]
    for W in walls:
        build_wall(g, W, FL, TV, "falu_red_dark_vertical")
    corner_boards(g, foot, walls, FL)
    stoop(g, "+x", wl["E"], YR, 1.4, 0.8, FL - 0.02, zb)
    eave = lambda a, b, nout, ez, pipes, plane: eave_line(g, ev, F, Z0, OV, a, b, nout, ez, pipes, plane)
    eave((x0 + 0.05, yS), (x1 - 0.05, yS), (0, -1), zE, [x0 + 0.5, x1 - 0.5], wl["S"])
    eave((x0 + 0.05, yN), (xs0 - 0.1, yN), (0, 1), zE, [x0 + 0.5], wl["N"])
    eave((xs0 + 0.05, yNs), (x1 - 0.05, yNs), (0, 1), zk - TS * (yNs - yk), [x1 - 0.5], wl["NS"])
    g.pop()
    add("omberg_cot_cottage", g, *F.en(cx, cy), F.yaw, Z0)
