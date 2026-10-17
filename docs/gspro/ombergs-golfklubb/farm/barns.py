"""Farm barns: the big west barn (OSM 1431566961), the red north barn (1431566959, a high part and a
lower south wing) and the white south barn (1431566960, the stable with a cross gable and a cupola).

Frame of every asset: x along the long axis (compass bearing of the OSM rectangle), y across with +y
to the west, z up from the ground median.  The asset origin sits on the building's own axis, which is
shifted sideways from the OSM rectangle centre by the lidar roof fit (see SHIFT): the roof is a
symmetric gable about the ridge the lidar shows, walls and overhangs are symmetric about the same ridge.

Evidence (lidar-crop.npz, ortho 2023/2025, Street View photos in data/omberg-farm/streetview):
  big barn    roof planes fitted to ~1800 returns: pitch 0.640, ridge 124.47 m, ridge 0.16 m east of the OSM
              axis; roof returns end at +-10.4 m across and +-31.1 m along, the south gable wall returns sit at
              -30.3 m, so walls 60.6 x 18.6 m with ~1 m overhang all round (the OSM rectangle is 1.3 m longer).
  north barn  high part: west plane fit (pitch 0.587) + east eave returns; low south wing: gable returns.
  south barn  eave returns at 117.0 m both sides, cross-gable ridge returns at 118.95 m, valley geometry
              from the ortho triangle; wall height and doors from the photo.
Everything the sources do not show is marked "inferred" in the comments.
"""
import math

import numpy as np
from mathutils import Matrix, Vector

import props_kit as kit

ASSETS = {"1431566961": "omberg_farm_big_barn", "1431566959": "omberg_farm_north_barn", "1431566960": "omberg_farm_south_barn"}

# --------------------------------------------------------------------------------------------------
# Materials
# --------------------------------------------------------------------------------------------------
MATTE = {"omberg_barn_red", "omberg_barn_white", "omberg_barn_trim", "omberg_barn_frame_red", "omberg_barn_door_black",
         "omberg_barn_door_green", "omberg_barn_door_grey", "omberg_barn_timber", "omberg_barn_door_frame", "omberg_barn_plinth",
         "omberg_barn_apron", "omberg_barn_roof_pale", "omberg_barn_roof_fc", "omberg_barn_roof_dark",
         "omberg_barn_louvre", "omberg_barn_void", "omberg_barn_hatch", "omberg_barn_under"}


def tex_barnfc(bank, color="102,102,106"):
    """Weathered corrugated fibre cement: 11 waves over the 2 m tile (0.18 m pitch, the standard sheet), mottled
    grey, rain streaks down the slope, pale lichen patches. Corrugation is in the normal map, not geometry."""
    S = bank.size
    col = kit._rgb([int(c) for c in color.split(",")])
    wave = np.broadcast_to(0.5 + 0.5 * np.sin(np.arange(S)[None, :] / S * 2 * math.pi * 11), (S, S))
    big = kit._fbm((S, S), 301, scales=(256, 128, 64, 32))
    mid = kit._fbm((S, S), 303, scales=(32, 16, 8, 4))
    streak = np.repeat(kit._fbm((S, S // 8), 307, scales=(64, 16, 4)), 8, 1)[:, :S]
    lichen = np.clip((kit._fbm((S, S), 311, scales=(64, 24, 8, 3)) - 0.58) * 5, 0, 1)
    v = (0.86 + 0.24 * big) * (0.93 + 0.14 * mid) * (0.93 + 0.14 * streak) * (0.84 + 0.22 * wave)
    alb = col[None, None, :] * v[:, :, None]
    alb = alb + (kit._rgb([140, 142, 124]) - alb) * 0.22 * lichen[:, :, None]
    height = 0.7 * wave + 0.2 * mid + 0.1 * big
    return np.clip(alb, 0, 1), height, 3.0


def tex_barnboard(bank, color="116,33,29", boards="10", batten="0.22"):
    """Even, well-kept board-and-batten paint: `boards` boards per 2 m tile (0.2 m pitch), a batten (`batten` of the pitch)
    over every joint with a thin shadow line at its edges, a few % tone change between boards, faint long grain.
    No weathering blotches. The relief is in the normal map."""
    S = bank.size
    col = kit._rgb([int(c) for c in color.split(",")])
    n, bt = int(boards), float(batten)
    x = np.broadcast_to(np.arange(S)[None, :] / S * n, (S, S))
    idx = np.floor(x).astype(int) % n
    pos = x % 1
    shade = 1 + (kit._rng(5).random(n) - 0.5) * 0.05
    dist = np.minimum(pos, 1 - pos)                         # distance to the joint, in board pitches
    bat = dist < bt / 2
    edge = np.abs(dist - bt / 2) < 0.012
    grain = np.repeat(kit._fbm((S, S // 8), 21, scales=(64, 16, 4)), 8, 1)[:, :S]
    fine = kit._fbm((S, S), 23, scales=(4, 2, 1))
    tone = shade[idx] * (0.96 + 0.06 * grain) * (0.985 + 0.03 * fine) * np.where(bat, 1.03, 1.0) * np.where(edge, 0.72, 1.0)
    height = np.where(bat, 1.0, 0.45) + 0.03 * grain - np.where(edge, 0.25, 0.0)
    return np.clip(col[None, None, :] * tone[:, :, None], 0, 1), np.clip(height, 0, 1), 3.0


def register_materials():
    M = kit.MATERIALS
    M.update({
        # falu red, even and well kept: photo mid-tone ~ (125,35,32); the course light lifts sunlit faces 1.7x
        "omberg_barn_red": ("barnboard:116,33,29:10:0.22", (2.0, 2.0), None, 0.1, 0.0),
        "omberg_barn_white": ("barnboard:176,174,166:10:0.2", (2.0, 2.0), None, 0.1, 0.0),
        "omberg_barn_trim": (None, (1, 1), (176, 175, 168), 0.1, 0.0),
        "omberg_barn_frame_red": (None, (1, 1), (112, 28, 26), 0.1, 0.0),
        "omberg_barn_door_black": ("boards:30,30,33:v:0.18:2.0:1", (2.0, 2.0), None, 0.1, 0.0),
        "omberg_barn_door_green": ("boards:46,74,54:v:0.14:2.0:2", (2.0, 2.0), None, 0.1, 0.0),
        "omberg_barn_door_grey": ("boards:128,138,144:v:0.14:2.0:2", (2.0, 2.0), None, 0.1, 0.0),
        "omberg_barn_timber": (None, (1, 1), (92, 70, 52), 0.1, 0.0),
        "omberg_barn_door_frame": (None, (1, 1), (48, 44, 42), 0.1, 0.0),
        "omberg_barn_under": (None, (1, 1), (128, 112, 96), 0.05, 0.0),
        "omberg_barn_plinth": ("plaster:112,110,104", (2.0, 2.0), None, 0.1, 0.0),
        "omberg_barn_apron": ("plaster:132,130,124", (2.0, 2.0), None, 0.1, 0.0),
        "omberg_barn_glass": (None, (1, 1), (46, 54, 62), 0.3, 0.0),
        "omberg_barn_void": (None, (1, 1), (9, 9, 10), 0.0, 0.0),
        "omberg_barn_hatch": (None, (1, 1), (40, 44, 48), 0.3, 0.0),
        "omberg_barn_louvre": ("louvre:176,175,168", (1.0, 1.0), None, 0.1, 0.0),
        # roofs: corrugated pale sheet (ortho south half), weathered fibre cement (north half), dark sheet
        "omberg_barn_roof_pale": ("seam:170,174,178:0.076:2.0:1", (2.0, 2.0), None, 0.1, 0.1),
        "omberg_barn_roof_fc": ("barnfc:102,102,106", (2.0, 2.0), None, 0.05, 0.0),
        "omberg_barn_roof_dark": ("seam:62,70,84:0.52:2.08:0", (2.08, 2.08), None, 0.1, 0.1),
    })
    kit.TextureBank.tex_barnfc = tex_barnfc
    kit.TextureBank.tex_barnboard = tex_barnboard


# --------------------------------------------------------------------------------------------------
# Geometry helpers (all faces are oriented by a reference point, so winding mistakes cannot happen)
# --------------------------------------------------------------------------------------------------
def face(g, pts, mat, ref, uv=None):
    """Polygon whose normal points away from `ref` (a point on its inner side)."""
    p = [Vector(q) for q in pts]
    n = Vector((0, 0, 0))
    for a, b in zip(p, p[1:] + p[:1]):
        n += Vector(((a.y - b.y) * (a.z + b.z), (a.z - b.z) * (a.x + b.x), (a.x - b.x) * (a.y + b.y)))
    c = sum(p, Vector((0, 0, 0))) / len(p)
    if n.dot(c - Vector(ref)) < 0:
        p.reverse()
    g.poly([tuple(q) for q in p], mat, uv)


def mean(pts):
    return tuple(float(v) for v in np.mean(np.array(pts, float), axis=0))


def board(g, a, b, c, mat, h=0.22, t=0.04):
    """White edge board along the roof edge a->b: hangs h below the top edge and stands t proud of the edge plane,
    outward (in plan) from c, the slab centre. It gives eaves and rakes a visible thickness."""
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
    pts = lambda *q: [tuple(v) for v in q]
    face(g, pts(a + o, b + o, b + o + dn, a + o + dn), mat, ref)             # outer face
    face(g, pts(a, b, b + o, a + o), mat, ref)                                # top strip
    face(g, pts(a + dn, b + dn, b + o + dn, a + o + dn), mat, ref)            # underside
    face(g, pts(a, a + o, a + o + dn, a + dn), mat, ref)                      # end caps
    face(g, pts(b, b + o, b + o + dn, b + dn), mat, ref)


def slab(g, top, dz, mat, under, edge, fascia):
    """One roof plane: `top` polygon (up-facing, planar); the underside is the same polygon dropped by dz (a plane
    shifted by the sheet thickness), so a neighbouring plane that shares an edge shares the lowered edge too.
    `fascia`: indices i of edges top[i]->top[i+1] that get a vertical edge board (the others are joints)."""
    n = len(top)
    bot = [(x, y, z - dz) for x, y, z in top]
    c = mean(top)
    face(g, top, mat, (c[0], c[1], c[2] - 1))
    face(g, bot, under, (c[0], c[1], c[2] + 1))
    cm = (c[0], c[1], c[2] - dz / 2)
    for i in fascia:
        j = (i + 1) % n
        face(g, [top[i], top[j], bot[j], bot[i]], edge, cm)
        board(g, top[i], top[j], cm, edge)


def ridge_cap(g, x0, x1, y, z, p, mat, w=0.26, h=0.07, swap=False):
    """Triangular ridge flashing; its edges lie exactly on the two roof planes. swap: ridge runs along y."""
    za = z - p * w
    q = (lambda a, b, c: (b, a, c)) if swap else (lambda a, b, c: (a, b, c))
    for s in (-1, 1):
        face(g, [q(x0, y + s * w, za), q(x1, y + s * w, za), q(x1, y, z + h), q(x0, y, z + h)], mat, q((x0 + x1) / 2, y, z - 1))
    for x in (x0, x1):
        face(g, [q(x, y - w, za), q(x, y + w, za), q(x, y, z + h)], mat, q((x0 + x1) / 2, y, z - 0.1))


def plane_box(g, z_of, x0, x1, y0, y1, h, mat_top, mat_side):
    """A low box standing on a roof plane z_of(y): corners on the plane, top lifted by h."""
    q = [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]
    lo = [(x, y, z_of(y)) for x, y in q]
    hi = [(x, y, z_of(y) + h) for x, y in q]
    c = mean(hi)
    face(g, hi, mat_top, (c[0], c[1], c[2] - 1))
    for i in range(4):
        j = (i + 1) % 4
        face(g, [lo[i], lo[j], hi[j], hi[i]], mat_side, (c[0], c[1], c[2] - h / 2))


def long_wall(g, y, s, z0, top, mat, holes=()):
    """Wall plane y (outward normal s*y) from z0 up to the polyline `top` [(x, z)...] (the roof underside; a repeated x
    is a vertical step). holes (x0, x1, z0, z1) are left open (the caller builds the reveal)."""
    segs = [(a, b) for a, b in zip(top, top[1:]) if b[0] > a[0]]

    def seg_at(x):
        return next((a, b) for a, b in segs if a[0] - 1e-9 <= x <= b[0] + 1e-9)

    def zt(seg, x):
        (xa, za), (xb, zb) = seg
        return za + (zb - za) * (x - xa) / (xb - xa)
    xs = sorted({t[0] for t in top} | {h[0] for h in holes} | {h[1] for h in holes})
    for xi, xj in zip(xs, xs[1:]):
        mid = (xi + xj) / 2
        seg = seg_at(mid)
        hole = next((h for h in holes if h[0] - 1e-6 <= mid <= h[1] + 1e-6), None)
        bands = [(z0, None)] if hole is None else [(z0, hole[2]), (hole[3], None)]
        for zb, zu in bands:
            if zu is not None and zu <= zb + 1e-6:
                continue
            a = zt(seg, xi) if zu is None else zu
            b = zt(seg, xj) if zu is None else zu
            if zu is None and hole is not None and b <= zb:
                continue
            face(g, [(xi, y, zb), (xj, y, zb), (xj, y, b), (xi, y, a)], mat, (mid, 0, (zb + a) / 2))


def gable_wall(g, x, ref_x, hw, z0, under, mat):
    """Gable end wall at plane x, closed up to the roof underside under(y) (peak at y=0)."""
    pts = [(x, -hw, z0), (x, hw, z0), (x, hw, under(hw)), (x, 0, under(0)), (x, -hw, under(-hw))]
    face(g, pts, mat, (ref_x, 0, z0 + 1))


def plinth(g, x0, x1, hy, z1=0.3, o=0.06):
    """Foundation 6 cm proud of the walls: a stone band from just below grade to z1, concrete below that down to -1.2 so a
    sloping terrain never shows a gap (the review scene has no terrain, Unity's does)."""
    for z0, z2, mat in ((-1.2, -0.3, "omberg_barn_apron"), (-0.3, z1, "omberg_barn_plinth")):
        h = z2 - z0
        for s in (-1, 1):
            g.box(((x0 + x1) / 2, s * (hy + o / 2 - 0.03), z0 + h / 2), (x1 - x0 + 2 * o, o + 0.06, h), mat)
            g.box((s * ((x1 - x0) / 2 + o / 2 - 0.03) + (x0 + x1) / 2, 0, z0 + h / 2), (o + 0.06, 2 * hy, h), mat)


def ywall(s, y0, xc):
    """Local frame on a long wall: x along the wall, y up, z out of the wall (right-handed), origin at (xc, y0)."""
    return Matrix(((-s, 0, 0, xc), (0, 0, s, y0), (0, 1, 0, 0), (0, 0, 0, 1)))


def xwall(s, x0, yc):
    """Same on a gable wall at plane x0 with outward direction s*x."""
    return Matrix(((0, 0, s, x0), (s, 0, 0, yc), (0, 1, 0, 0), (0, 0, 0, 1)))


def window(g, w, h, sill, frame="omberg_barn_trim", glass="omberg_barn_glass", fw=0.09, bars=(2, 2), depth=0.07):
    """Rectangular window in the current wall frame: glass 1.5 cm proud, four frame bars, glazing bars, sill board."""
    face(g, [(-w / 2, sill, 0.015), (w / 2, sill, 0.015), (w / 2, sill + h, 0.015), (-w / 2, sill + h, 0.015)], glass, (0, sill + h / 2, -1))
    g.box((0, sill + h - fw / 2, depth / 2), (w + 2 * fw, fw, depth), frame)
    g.box((0, sill + fw / 2, depth / 2), (w + 2 * fw, fw, depth), frame)
    for sx in (-1, 1):
        g.box((sx * (w / 2 + fw / 2), sill + h / 2, depth / 2), (fw, h + 2 * fw, depth), frame)
    for i in range(1, bars[0]):
        g.box((-w / 2 + w * i / bars[0], sill + h / 2, depth / 2 - 0.01), (fw * 0.5, h, depth * 0.7), frame)
    for j in range(1, bars[1]):
        g.box((0, sill + h * j / bars[1], depth / 2 - 0.01), (w, fw * 0.5, depth * 0.7), frame)
    g.box((0, sill - fw - 0.025, 0.07), (w + 2 * fw + 0.2, 0.05, 0.14), frame)


def arch_window(g, w, h, sill, frame, glass="omberg_barn_glass", fw=0.1, depth=0.07, n=8):
    """Round-arched window (semicircular head) in the current wall frame: glass, a frame ring and two legs, a sill."""
    r = w / 2
    hs = h - r
    cy = sill + hs
    arc = [(r * math.cos(math.pi * k / n), cy + r * math.sin(math.pi * k / n)) for k in range(n + 1)]
    face(g, [(-r, sill, 0.015), (r, sill, 0.015)] + [(x, y, 0.015) for x, y in arc], glass, (0, cy, -1))
    out = [((r + fw) * math.cos(math.pi * k / n), cy + (r + fw) * math.sin(math.pi * k / n)) for k in range(n + 1)]
    for k in range(n):
        face(g, [(*arc[k], depth), (*out[k], depth), (*out[k + 1], depth), (*arc[k + 1], depth)], frame, (0, cy, -1))
        face(g, [(*out[k], 0), (*out[k + 1], 0), (*out[k + 1], depth), (*out[k], depth)], frame, (0, cy, depth / 2))
    for sx in (-1, 1):
        g.box((sx * (r + fw / 2), sill + hs / 2, depth / 2), (fw, hs, depth), frame)
    g.box((0, sill - fw / 2, depth / 2), (w + 2 * fw, fw, depth), frame)
    g.box((0, sill - fw - 0.02, 0.07), (w + 2 * fw + 0.16, 0.04, 0.14), frame)
    g.box((0, sill + hs / 2, depth / 2 - 0.01), (0.04, hs + r * 0.2, depth * 0.7), frame)  # one mullion


def void_bay(g, s, y_wall, x0, x1, z0, z1, depth, floor):
    """Black interior behind an open barn door: sides, lintel soffit, back and floor, so the opening reads as a
    deep dark bay and never shows through to the sky."""
    yb = y_wall - s * depth
    mat = "omberg_barn_void"
    xc, zc = 0.5 * (x0 + x1), 0.5 * (z0 + z1)
    # normals point into the bay (towards the viewer), so each ref sits on the far side of its face
    face(g, [(x0, yb, z0), (x1, yb, z0), (x1, yb, z1), (x0, yb, z1)], mat, (xc, yb - s, zc))
    face(g, [(x0, y_wall, z0), (x0, yb, z0), (x0, yb, z1), (x0, y_wall, z1)], mat, (x0 - 1, y_wall, zc))
    face(g, [(x1, y_wall, z0), (x1, yb, z0), (x1, yb, z1), (x1, y_wall, z1)], mat, (x1 + 1, y_wall, zc))
    face(g, [(x0, y_wall, z1), (x1, y_wall, z1), (x1, yb, z1), (x0, yb, z1)], mat, (xc, y_wall, z1 + 1))
    face(g, [(x0, y_wall, floor), (x1, y_wall, floor), (x1, yb, floor), (x0, yb, floor)], mat, (xc, y_wall, floor - 1))


def plank(g, a, b, w, z0, t, mat):
    """Flat board from a to b (x, y in the current wall frame), w wide, t thick, standing out from local z0."""
    (ax, ay), (bx, by) = a, b
    L = math.hypot(bx - ax, by - ay)
    ux, uy = (bx - ax) / L, (by - ay) / L
    nx, ny = -uy * w / 2, ux * w / 2
    c = [(ax + nx, ay + ny), (bx + nx, by + ny), (bx - nx, by - ny), (ax - nx, ay - ny)]
    ref = ((ax + bx) / 2, (ay + by) / 2, z0 + t / 2)
    face(g, [(x, y, z0 + t) for x, y in c], mat, ref)
    for i in range(4):
        j = (i + 1) % 4
        face(g, [(*c[i], z0), (*c[j], z0), (*c[j], z0 + t), (*c[i], z0 + t)], mat, ref)


def framed_leaf(g, xc, w, y0, h, panel, rise=1):
    """A ledged-and-braced barn door leaf in the current wall frame: boarded panel, two stiles, bottom / middle / top rail
    and a Z-brace rising towards the side `rise` (+1 right, -1 left). Everything stands 4 cm proud of the boards."""
    fz, ft, fw, fr = 0.11, 0.04, 0.16, "omberg_barn_door_frame"
    g.box((xc, y0 + h / 2, 0.085), (w, h, 0.05), panel)
    for sx in (-1, 1):
        g.box((xc + sx * (w / 2 - fw / 2), y0 + h / 2, fz + ft / 2), (fw, h, ft), fr)
    for yy in (y0 + fw / 2, y0 + h / 2, y0 + h - fw / 2):
        g.box((xc, yy, fz + ft / 2), (w - 2 * fw, fw, ft), fr)
    plank(g, (xc - rise * (w / 2 - fw), y0 + fw), (xc + rise * (w / 2 - fw), y0 + h - fw), 0.14, fz + ft, 0.03, fr)


def sliding_door(g, s, y_wall, x0, x1, z0, z1, mat, rail_x0=None, rail_x1=None, rise=1):
    """A framed door leaf hung in front of the long wall y_wall on a timber rail beam with two hangers."""
    xc = (x0 + x1) / 2
    ra = rail_x0 if rail_x0 is not None else x0 - 0.1
    rb = rail_x1 if rail_x1 is not None else x1 + 0.1
    g.push(ywall(s, y_wall, xc))                       # local x runs -s along the global x
    framed_leaf(g, 0, x1 - x0, z0, z1 - z0, mat, -s * rise)
    g.box((-s * ((ra + rb) / 2 - xc), z1 + 0.14, 0.2), (rb - ra, 0.16, 0.14), "omberg_barn_timber")
    for lx in (-(x1 - x0) / 2 + 0.25, (x1 - x0) / 2 - 0.25):
        g.box((lx, z1 + 0.02, 0.1), (0.08, 0.18, 0.1), "omberg_barn_timber")
    g.pop()


def gable_door(g, sx, x_wall, yc, w, z0, h, mat, rail_len, rail_shift):
    """Double sliding door in a gable wall: two framed leaves with mirrored Z-braces, rail beam above (rail_shift: its
    centre offset along the global y)."""
    g.push(xwall(sx, x_wall, yc))                      # local x runs sx along the global y
    framed_leaf(g, -w / 4, w / 2, z0, h, mat, 1)
    framed_leaf(g, w / 4, w / 2, z0, h, mat, -1)
    g.box((sx * rail_shift, z0 + h + 0.14, 0.2), (rail_len, 0.16, 0.14), "omberg_barn_timber")
    for lx in (-w / 2 + 0.3, w / 2 - 0.3):
        g.box((lx, z0 + h + 0.02, 0.1), (0.08, 0.18, 0.1), "omberg_barn_timber")
    g.pop()


def apron(g, s, y_wall, x0, x1, depth, top=0.08):
    """Concrete threshold slab in front of doors: its top sits just above the terrain so doors stand on a floor."""
    g.box(((x0 + x1) / 2, y_wall + s * depth / 2, top - 0.3), (x1 - x0, depth, 0.6), "omberg_barn_apron")


# --------------------------------------------------------------------------------------------------
# Big barn
# --------------------------------------------------------------------------------------------------
def big_barn(g):
    HX, HY = 30.3, 9.3               # walls: south gable wall from the lidar wall returns (-30.2..-30.5), width ~ OSM
    ZR, P = 11.424, 0.640            # ridge height above ground (124.47-113.05), lidar plane pitch
    T = 0.12                         # sheet thickness
    DZ = T * math.sqrt(1 + P * P)
    OVH_E, OVH_G = 1.05, 0.9         # lidar: roof returns end at +-10.4 across and +-31.1 along
    ZW = ZR - P * HY - DZ            # wall top (roof underside at the wall)
    XS = -0.5                        # seam between the pale south half and the weathered north half (photo, ortho)
    FL = 0.3
    ye = HY + OVH_E
    x0, x1 = -HX - OVH_G, HX + OVH_G
    under = lambda y: ZR - DZ - P * abs(y)
    # roof: four slabs in one plane pair, joint at the seam is the same plane (no step)
    for s in (-1, 1):
        for (xa, xb, m) in ((x0, XS, "omberg_barn_roof_pale"), (XS, x1, "omberg_barn_roof_fc")):
            top = [(xa, 0, ZR), (xb, 0, ZR), (xb, s * ye, ZR - P * ye), (xa, s * ye, ZR - P * ye)]
            # edges: 0 ridge (joint), 1 xb, 2 eave, 3 xa
            fas = [2] + ([1] if xb == x1 else []) + ([3] if xa == x0 else [])
            slab(g, top, DZ, m, "omberg_barn_under", "omberg_barn_trim", fas)
    ridge_cap(g, x0, XS, 0, ZR, P, "omberg_barn_roof_pale")
    ridge_cap(g, XS, x1, 0, ZR, P, "omberg_barn_roof_fc")
    # gable ends (south: black double door; north plain, inferred)
    gable_wall(g, -HX, 0, HY, FL, under, "omberg_barn_red")
    gable_wall(g, HX, 0, HY, FL, under, "omberg_barn_red")
    # long walls; east side (y<0, s=-1) carries the open bays and the doors seen in the photo
    bays = [(-6.8, -1.4), (12.9, 17.9)]                      # open drive-through bays, black inside
    holes = [(a, b, FL, 4.25) for a, b in bays]
    long_wall(g, -HY, -1, FL, [(-HX, ZW), (HX, ZW)], "omberg_barn_red", holes)
    long_wall(g, HY, 1, FL, [(-HX, ZW), (HX, ZW)], "omberg_barn_red")
    for a, b in bays:
        void_bay(g, -1, -HY, a, b, FL, 4.25, 1.6, FL)
    # sliding leaves beside the bays (the photo shows one parked on each side), framed and Z-braced
    for (a, b, rise) in [(-10.3, -6.8, 1), (10.2, 12.9, -1), (17.9, 20.6, 1)]:
        sliding_door(g, -1, -HY, a, b, 0.12, 4.25, "omberg_barn_door_black", rise=rise)
    apron(g, -1, -HY, -10.6, -1.0, 1.7)
    apron(g, -1, -HY, 9.9, 21.0, 1.7)
    # a rail tying the leaf and the bay opening together (the door runs on it)
    g.box((-5.85, -HY - 0.2, 4.39), (9.6, 0.14, 0.16), "omberg_barn_timber")
    g.box((15.4, -HY - 0.2, 4.39), (11.0, 0.14, 0.16), "omberg_barn_timber")
    # south gable door: 7.2 m x 4.13 m black double sliding door (photo), rail beam above, concrete apron
    yc = 0.3
    gable_door(g, -1, -HX, yc, 7.2, 0.12, 4.13, "omberg_barn_door_black", 8.8, 0.6)
    g.box((-HX - 0.85, yc, 0.04 - 0.3), (1.7, 8.0, 0.6), "omberg_barn_apron")
    # windows: east side as photographed, west mirrored (inferred); small, white-framed, 1.0 x 0.9 m, sill 1.45 m
    for xw in (-28.5, -24.5, -16.7, -12.5):
        for s in (-1, 1):
            g.push(ywall(s, s * HY, xw))
            window(g, 1.0, 0.9, 1.45, bars=(2, 2))
            g.pop()
    # one small window between the bays (photo)
    g.push(ywall(-1, -HY, 0.4))
    window(g, 0.7, 0.9, 1.45, bars=(1, 2))
    g.pop()
    # roof hatches on the east slope near the ridge (photo, ortho): 1.2 x 0.55 m, 12 cm high
    for xh in (-22.5, -9.0):
        plane_box(g, lambda y: ZR - P * abs(y), xh - 0.6, xh + 0.6, -1.9, -1.35, 0.12, "omberg_barn_hatch", "omberg_barn_roof_pale")
    # north gable: a hay hatch with its hoist beam high in the gable (inferred: the usual barn detail, not in the photos)
    g.push(xwall(1, HX, 0))
    g.box((0, 7.2 + 0.8, 0.03), (1.3, 1.6, 0.06), "omberg_barn_frame_red")
    g.box((0, 7.2 + 1.6 + 0.05, 0.05), (1.5, 0.1, 0.1), "omberg_barn_trim")
    g.box((0, 7.2 - 0.05, 0.05), (1.5, 0.1, 0.1), "omberg_barn_trim")
    for sx in (-1, 1):
        g.box((sx * 0.7, 7.2 + 0.8, 0.05), (0.1, 1.7, 0.1), "omberg_barn_trim")
    g.box((0, 7.2 + 0.8, 0.065), (0.04, 1.6, 0.03), "omberg_barn_trim")
    g.box((0, 7.2 + 2.25, 0.55), (0.16, 0.16, 1.1), "omberg_barn_timber")          # hoist beam
    g.beam((0, 8.55, 0.02), (0, 9.4, 0.9), 0.1, 0.1, "omberg_barn_timber")           # its brace
    g.pop()
    # two thin horizontal belt boards on the east wall, as in the photo, stopping at the doors and bays
    for xa, xb in ((-HX + 0.05, -10.5), (-1.2, 10.1), (20.8, HX - 0.05)):
        for zb in (3.0, 3.35):
            g.box(((xa + xb) / 2, -HY - 0.012, zb), (xb - xa, 0.03, 0.09), "omberg_barn_red")
    plinth(g, -HX, HX, HY)
    return dict(zr=ZR, p=P)


# --------------------------------------------------------------------------------------------------
# North barn: high part (x > XS) and a lower south wing, red board, white trim, green doors
# --------------------------------------------------------------------------------------------------
def north_barn(g):
    XA, XB, HY = -21.3, 20.37, 5.44  # south wall from the lidar wall returns (1 m beyond the OSM end), north wall OSM
    XS = -0.4                         # step between the two roofs (ortho 2023/2025: roof seam across the barn)
    FL = 0.3
    # high part: west plane fit z = 121.96 - 0.587 b, east eave returns 118.0 -> a ridge 0.6 m west of the OSM axis;
    # the building is shifted to that ridge (SHIFT), so the roof is symmetric.
    ZR, P = 8.60, 0.587               # ridge 121.6 - ground 113.0
    T = 0.10
    DZ = T * math.sqrt(1 + P * P)
    # low wing: gable returns apex 117.0-117.2 m, wall 2.3 m (OSM eave 2.27)
    ZL, PL = 4.10, 0.32
    DL = T * math.sqrt(1 + PL * PL)
    OVH = 0.5
    ye = HY + OVH
    ZWH = ZR - P * HY - DZ
    ZWL = ZL - PL * HY - DL
    under_h = lambda y: ZR - DZ - P * abs(y)
    under_l = lambda y: ZL - DL - PL * abs(y)
    xh0, xh1 = XS - 0.3, XB + 0.3
    xl0 = XA - 0.45
    for s in (-1, 1):
        slab(g, [(xh0, 0, ZR), (xh1, 0, ZR), (xh1, s * ye, ZR - P * ye), (xh0, s * ye, ZR - P * ye)], DZ,
             "omberg_barn_roof_dark", "omberg_barn_trim", "omberg_barn_trim", [1, 2, 3])
        # low wing runs into the high gable wall at x = XS (no gap: the slab ends on the wall plane)
        slab(g, [(xl0, 0, ZL), (XS, 0, ZL), (XS, s * ye, ZL - PL * ye), (xl0, s * ye, ZL - PL * ye)], DL,
             "omberg_barn_roof_dark", "omberg_barn_trim", "omberg_barn_trim", [2, 3])
    ridge_cap(g, xh0, xh1, 0, ZR, P, "omberg_barn_roof_dark")
    ridge_cap(g, xl0, XS, 0, ZL, PL, "omberg_barn_roof_dark")
    # gable walls
    gable_wall(g, XB, 0, HY, FL, under_h, "omberg_barn_red")
    gable_wall(g, XS, 10, HY, FL, under_h, "omberg_barn_red")      # high south gable, above the low roof
    gable_wall(g, XA, 0, HY, FL, under_l, "omberg_barn_red")
    # long walls: low wing up to its eave, high part up to its own
    for s in (-1, 1):
        top = [(XA, ZWL), (XS, ZWL), (XS, ZWH), (XB, ZWH)]
        holes = []
        long_wall(g, s * HY, s, FL, top, "omberg_barn_red", holes)
    # openings: low wing west wall double green doors as in the photo; mirrored east (inferred); high part: a sliding
    # door on the east and a side door on the west (inferred)
    def door_leaf(s, xc, w, h, mat="omberg_barn_door_green"):
        g.push(ywall(s, s * HY, xc))
        g.box((0, 0.12 + h / 2, 0.03), (w, h, 0.06), mat)
        fw = 0.12
        g.box((0, 0.12 + h + fw / 2, 0.045), (w + 2 * fw, fw, 0.09), "omberg_barn_trim")
        for sx in (-1, 1):
            g.box((sx * (w / 2 + fw / 2), 0.12 + h / 2 + fw / 2, 0.045), (fw, h + fw, 0.09), "omberg_barn_trim")
        g.box((0, 0.06, 0.07), (w + 0.4, 0.12, 0.14), "omberg_barn_apron")    # threshold
        g.box((0, 0.12 + h / 2, 0.08), (0.03, h, 0.04), "omberg_barn_trim")  # leaf split
        g.pop()
    for s in (-1, 1):
        door_leaf(s, -12.0, 2.4, 1.85)
        door_leaf(s, -5.5, 1.1, 1.85)
    door_leaf(1, 8.0, 1.1, 2.1)
    # east sliding door on the high part: 3.0 x 3.2 m on a rail
    sliding_door(g, -1, -HY, 9.0, 12.0, 0.12, 3.4, "omberg_barn_door_green")
    g.box((10.5, -HY - 0.06, 0.04 - 0.3), (3.4, 1.4, 0.6), "omberg_barn_apron")
    # gable windows: small, high, white frame (photo: south gable of the high part)
    for xg, sg in ((XS, -1), (XB, 1)):
        g.push(xwall(sg, xg, 0))
        window(g, 0.9, 0.9, 6.25, frame="omberg_barn_trim", glass="omberg_barn_glass", bars=(2, 2))
        g.pop()
    # low wing south gable: one small window (inferred)
    g.push(xwall(-1, XA, 0))
    window(g, 0.6, 0.6, 2.8, bars=(1, 1))
    g.pop()
    # white corner boards on the four outer corners (photo: crisp white corners)
    cb = 0.14
    for x, s, zt in ((XA, 1, ZWL), (XA, -1, ZWL), (XB, 1, ZWH), (XB, -1, ZWH)):
        g.box((x, s * HY, (FL + zt) / 2), (cb + 0.04, cb + 0.04, zt - FL), "omberg_barn_trim")
    # the step: a corner board where the high wall begins above the low eave is not needed (same wall plane)
    plinth(g, XA, XB, HY)
    return None


# --------------------------------------------------------------------------------------------------
# South barn: the white stable ("stall / vagnslider")
# --------------------------------------------------------------------------------------------------
def south_barn(g):
    HX, HY = 13.92, 5.11
    ZR, P = 7.95, 0.685               # ridge 120.7 - ground 112.75; pitch from eave 117.2 and the cross-gable ridge
    # Cross gable (frontispiece): a full gable wall from the eave line to its own level ridge, perpendicular to the main
    # ridge and 0.95 m below it (Street View 7: apex at ~74 % of the eave-to-ridge rise), at 45 deg (the photos show a steep
    # gable, the ortho a ~5 m wide triangle). The 5 lidar returns at 118.95 on it are 0.8 m under this ridge.
    ZD, PC = 7.0, 1.0
    A0 = 1.3                          # cross-gable axis along the barn (those returns)
    T = 0.12
    DZ = T * math.sqrt(1 + P * P)     # one sheet drop for every plane, so all lowered edges (ridge, valleys) coincide
    OVH, OVG = 0.85, 0.5
    FL = 0.3
    ye = HY + OVH
    x0, x1 = -HX - OVG, HX + OVG
    bC = (ZR - ZD) / P                # where the cross ridge runs into the main roof
    hwe = (P * ye - (ZR - ZD)) / PC   # half width of the cross gable at the eave line: the valleys are the plane intersections
    hw5 = (P * HY - (ZR - ZD)) / PC   # ... and at the wall plane (the gable wall's half base)
    zm = lambda y: ZR - P * abs(y)
    under = lambda y: ZR - DZ - P * abs(y)
    dark, trim = "omberg_barn_roof_dark", "omberg_barn_trim"
    slab(g, [(x0, 0, ZR), (x1, 0, ZR), (x1, -ye, zm(ye)), (x0, -ye, zm(ye))], DZ, dark, trim, trim, [1, 2, 3])
    C, F = (A0, bC, ZD), (A0, ye, ZD)
    Vs, Vn = (A0 - hwe, ye, zm(ye)), (A0 + hwe, ye, zm(ye))
    # west plane with the cross gable cut out along its two valleys; the valley edges are shared with the cross planes
    slab(g, [(x0, 0, ZR), (x1, 0, ZR), (x1, ye, zm(ye)), Vn, C, Vs, (x0, ye, zm(ye))], DZ, dark, trim, trim, [1, 2, 5, 6])
    slab(g, [C, F, Vs], DZ, dark, trim, trim, [1])      # the two cross planes: ridge C-F, rake F-V with its barge board
    slab(g, [C, Vn, F], DZ, dark, trim, trim, [1])
    ridge_cap(g, x0, x1, 0, ZR, P, dark)
    ridge_cap(g, bC + 0.26 * PC / P + 0.02, ye - 0.02, A0, ZD, PC, dark, swap=True)   # its ends touch the valleys
    # walls
    zu = under(HY)
    gable_wall(g, -HX, 0, HY, FL, under, "omberg_barn_white")
    gable_wall(g, HX, 0, HY, FL, under, "omberg_barn_white")
    long_wall(g, -HY, -1, FL, [(-HX, zu), (HX, zu)], "omberg_barn_white")
    long_wall(g, HY, 1, FL, [(-HX, zu), (A0 - hw5, zu), (A0, ZD - DZ), (A0 + hw5, zu), (HX, zu)], "omberg_barn_white")
    # west face (photo 7): eight round-arched windows with red frames, a carriage door under the cross gable
    red = "omberg_barn_frame_red"
    for off in (-9.85, -8.2, -6.55, -4.9, 4.9, 6.55, 8.2, 9.85):
        g.push(ywall(1, HY, A0 + off))
        arch_window(g, 1.3, 1.1, 1.75, red)
        g.pop()
    g.push(ywall(1, HY, A0))
    dw, dh, fw = 4.4, 3.2, 0.2
    g.box((0, 0.12 + dh / 2, 0.03), (dw, dh, 0.06), "omberg_barn_door_grey")
    g.box((0, 0.12 + dh + fw / 2, 0.05), (dw + 2 * fw, fw, 0.1), red)
    for sx in (-1, 1):
        g.box((sx * (dw / 2 + fw / 2), 0.12 + dh / 2 + fw / 2, 0.05), (fw, dh + fw, 0.1), red)
    g.box((0, 0.12 + dh / 2, 0.075), (0.05, dh, 0.03), red)                    # leaf split
    g.box((-1.1, 0.12 + 1.0, 0.075), (0.9, 0.04, 0.03), red)                   # wicket in the left leaf
    g.box((-1.1, 0.12 + 2.1, 0.075), (0.9, 0.04, 0.03), red)
    for sx in (-1.55, -0.65):
        g.box((sx, 0.12 + 1.55, 0.075), (0.04, 1.1, 0.03), red)
    g.box((0, 0.06, 0.07), (dw + 2 * fw + 0.6, 0.12, 0.14), "omberg_barn_apron")  # threshold slab at floor level
    window(g, 1.2, 0.7, 5.3, frame=red, glass="omberg_barn_louvre", bars=(3, 1))  # slatted gable vent
    g.pop()
    # east face and ends: the same arched windows (inferred, the photos do not show this side)
    for off in (-9.85, -8.2, -6.55, -4.9, 4.9, 6.55, 8.2, 9.85):
        g.push(ywall(-1, -HY, A0 + off))
        arch_window(g, 1.3, 1.1, 1.75, red)
        g.pop()
    # louvred vents high in the two end gables, like the one in the cross gable (inferred)
    for xg, sg in ((-HX, -1), (HX, 1)):
        g.push(xwall(sg, xg, 0))
        window(g, 1.2, 0.5, 5.0, frame=red, glass="omberg_barn_louvre", bars=(3, 1))
        g.pop()
    # louvred vents high in the two end gables, like the one in the cross gable (inferred)
    for xg, sg in ((-HX, -1), (HX, 1)):
        g.push(xwall(sg, xg, 0))
        window(g, 1.2, 0.5, 5.0, frame=red, glass="omberg_barn_louvre", bars=(3, 1))
        g.pop()
    # cupola on the ridge (photo 6): louvred 1.6 m base and a hipped cap with a deep overhang
    cb, cz0, cz1 = 0.8, ZR - 0.8, ZR + 1.1
    g.box((A0, 0, (cz0 + cz1) / 2), (2 * cb, 2 * cb, cz1 - cz0), "omberg_barn_louvre")
    for sx in (-1, 1):
        for sy in (-1, 1):
            g.box((A0 + sx * cb, sy * cb, (cz0 + cz1) / 2), (0.1, 0.1, cz1 - cz0), trim)
    ch, ca = 1.45, ZR + 1.95
    base = [(A0 - ch, -ch), (A0 + ch, -ch), (A0 + ch, ch), (A0 - ch, ch)]
    for i in range(4):
        j = (i + 1) % 4
        face(g, [(*base[i], cz1), (*base[j], cz1), (A0, 0, ca)], dark, (A0, 0, cz1 - 1))
        face(g, [(*base[i], cz1 - 0.1), (*base[j], cz1 - 0.1), (*base[j], cz1), (*base[i], cz1)], trim, (A0, 0, cz1 - 0.05))
    face(g, [(*b, cz1 - 0.1) for b in base], trim, (A0, 0, cz1 + 1))
    plinth(g, -HX, HX, HY)
    return None


BUILD = {"1431566961": big_barn, "1431566959": north_barn, "1431566960": south_barn}
# building axis relative to the OSM rectangle centre (+ = west) and ground median (RH2000), from the lidar fits
SHIFT = {"1431566961": -0.16, "1431566959": 0.60, "1431566960": -0.15}
GROUND = {"1431566961": 113.05, "1431566959": 113.0, "1431566960": 112.75}


def build(add, new, ev):
    for oid, aid in ASSETS.items():
        r = ev.osm[oid]["properties"]["rect"]
        g = new()
        BUILD[oid](g)
        th = math.radians(r["angleDeg"])
        e = r["cx"] - SHIFT[oid] * math.sin(th)
        n = r["cy"] + SHIFT[oid] * math.cos(th)
        add(aid, g, e, n, (90 - r["angleDeg"]) % 180, GROUND[oid])
