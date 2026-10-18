"""Within 1 km, at "near" quality: the driving-range bay shelter (OSM 1431573541) and its surroundings, and the
small hut north of the course (OSM 965886766).

Evidence (data/omberg-ring: lidar-crop.npz, 2025 + leaf-off 2023 ortho, the range-shelter photo):
  shelter   open steel-and-glass range shelter (photo): curved translucent roof on steel arches, glazed back (west)
            and ends, open front (east) facing the range, one green mat per bay. Lidar roof returns (204) fit a
            circular arch across the depth: apex 114.295 m (3.92 m over the ground) at y = +2.09 m (east), radius
            11.2 m, median |d| 0.026 m; roof ends at x = -10.7 / +11.0, y = -2.2 / +2.8. Slab top 110.57 m (0.2 over
            the ground, 110.37), y +-2.1, x +-11.25. Battens every 1.2 m run across the roof in the ortho (17-19 white
            lines), the mats show as 6 pale patches 3.4-3.6 m apart, so 6 bays with a post line every 3.6 m.
  mats      17 dark green mats (1.5 x 1.6 m) in a row along the east edge of the pink path north of the shelter
            (ortho 2025, detected by colour; positions are the detections, the row spacing is regularised).
  targets   8 target greens with a flag pin (round green discs ~9 m with a white dot and its shadow, both ortho vintages).
  hut       flat roof at 100.35 m (a 0.1 m fall to the SW), the ortho shows the white roof 4.1 x 3.0 m, shifted 0.6 m
            from the OSM rectangle; the ground under it falls 1.4 m across the hut (outer DEM).
Everything the sources do not show is marked "inferred" in the comments.

Frames: shelter x along 160.5 deg (SSE), y east (the open side), z up from the ground median 110.37 m.
Ground-bound things sit on ev.terrain, so each asset's origin is placed at the terrain under it (dz = 0).
"""
import math

import bpy
import numpy as np
from mathutils import Vector

import props_kit as kit

PREFIX = "omberg_ring_near_"
# exported names (model.py prefixes every material with omberg_ring_) that are alpha-faded
TRANSLUCENT = {"omberg_ring_glass", "omberg_ring_roof_pc"}
MATTE = {"omberg_steel", "omberg_alu", "omberg_slab", "omberg_fascia", "omberg_roof_white", "omberg_mat_turf",
         "omberg_rubber", "omberg_hut_stone"}


def tex_ringglass(bank, color="150,190,180", alpha="0.22"):
    """Clear glass: a flat tint, a fifth opaque."""
    rgb = np.ones((64, 64, 3)) * (np.array([float(c) for c in color.split(",")]) / 255.0)
    return rgb, None, 1.0, np.full((64, 64), float(alpha))


def tex_ringpc(bank, color="214,200,172", alpha="0.62"):
    """Multiwall polycarbonate: pale beige, faint ribs every 2 cm across the 1 m tile, slightly see-through."""
    S = 256
    rib = 0.5 + 0.5 * np.cos(np.arange(S)[None, :] / S * 2 * math.pi * 50)
    v = 0.94 + 0.06 * rib
    rgb = (np.array([float(c) for c in color.split(",")]) / 255.0)[None, None, :] * v[:, :, None] * np.ones((S, S, 1))
    return rgb, None, 1.0, np.full((S, S), float(alpha)) * (0.9 + 0.1 * rib)


def register_materials():
    M = kit.MATERIALS
    M.update({
        "omberg_steel": (None, (1, 1), (24, 42, 36), 0.3, 0.0),        # photo: dark green powder-coated tube
        "omberg_alu": (None, (1, 1), (176, 178, 178), 0.3, 0.0),        # roof battens (the white lines of the ortho)
        "omberg_fascia": (None, (1, 1), (30, 40, 36), 0.3, 0.0),        # thin dark roof edge (photo)
        "omberg_slab": ("plaster:176,172,164", (2.0, 2.0), None, 0.1, 0.0),   # pale concrete slab (photo)
        "omberg_glass": ("ringglass:150,190,180:0.22", (1, 1), None, 0.9, 0.0),
        "omberg_roof_pc": ("ringpc:214,200,172:0.5", (1, 1), None, 0.3, 0.0),
        "omberg_mat_turf": ("turf:38,66,52", (1, 1), None, 0.05, 0.0),  # ortho: dark green mats
        "omberg_rubber": (None, (1, 1), (20, 20, 20), 0.2, 0.0),
        "omberg_roof_white": (None, (1, 1), (176, 176, 170), 0.15, 0.0),   # hut: the ortho roof is near white
        "omberg_hut_stone": ("stone:116,112,108", (2.0, 2.0), None, 0.15, 0.0),
    })
    kit.TextureBank.tex_ringglass = tex_ringglass
    kit.TextureBank.tex_ringpc = tex_ringpc
    kit.FADE.update(TRANSLUCENT)
    # props_kit leaves alpha unlinked in the Blender material; link it so the review renders show glass as glass
    # (Unity reads the manifest's fade flag). Wrapped once: another module may have wrapped it already.
    if not getattr(kit.blender_material, "_near_alpha", False):
        base = kit.blender_material

        def blender_material(name, table, tex_folder):
            fresh = bpy.data.materials.get(name) is None
            m = base(name, table, tex_folder)
            if fresh and name in TRANSLUCENT:
                nt = m.node_tree
                bsdf = nt.nodes.get("Principled BSDF")
                tex = next((n for n in nt.nodes if n.type == "TEX_IMAGE"), None)
                if tex and bsdf:
                    nt.links.new(tex.outputs["Alpha"], bsdf.inputs["Alpha"])
                m.surface_render_method = "BLENDED"
            return m
        blender_material._near_alpha = True
        kit.blender_material = blender_material


# ---------------------------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------------------------
def face(g, pts, mat, ref, uv=None):
    """Polygon whose normal points away from `ref` (a point on its inner side): winding cannot go wrong."""
    p = [Vector(q) for q in pts]
    n = Vector((0, 0, 0))
    for a, b in zip(p, p[1:] + p[:1]):
        n += Vector(((a.y - b.y) * (a.z + b.z), (a.z - b.z) * (a.x + b.x), (a.x - b.x) * (a.y + b.y)))
    c = sum(p, Vector((0, 0, 0))) / len(p)
    if n.dot(c - Vector(ref)) < 0:
        p.reverse()
    g.poly([tuple(q) for q in p], mat, uv)


def world(e0, n0, yaw, x, y):
    """EPSG:3006 (E, N) of asset-local (x, y) for an asset at (e0, n0) whose +x runs along compass bearing yaw."""
    b = math.radians(yaw)
    ex, ey = math.sin(b), math.cos(b)
    return e0 + x * ex - y * ey, n0 + x * ey + y * ex


def wall(g, a, b, zb, zt, mat, ref, step=0.5, holes=(), plinth=None, plinth_mat=None, depth=0.1, fill=None):
    """Vertical wall on the plan line a -> b (2D points). zb(t), zt(t): bottom (ground) and top height at distance t
    along it. holes: dicts t0, t1, sill, head (absolute z) are cut through with a reveal `depth` deep and closed by
    `fill` (door leaf / window pane, material) at the back. plinth: height of a stone band standing 3 cm proud of
    the boards, running 0.4 m below the ground. `ref` = a point inside the building."""
    L = math.dist(a, b)
    ux, uy = (b[0] - a[0]) / L, (b[1] - a[1]) / L
    nx, ny = uy, -ux
    mid = ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)
    if (nx * (mid[0] - ref[0]) + ny * (mid[1] - ref[1])) < 0:
        nx, ny = -nx, -ny                                   # outward

    def P(t, z, off=0.0):
        return (a[0] + ux * t + nx * off, a[1] + uy * t + ny * off, z)

    ts = sorted(set([round(L * i / max(1, int(L / step)), 4) for i in range(max(1, int(L / step)) + 1)] +
                    [h[k] for h in holes for k in ("t0", "t1")] + [L]))
    inner = (ref[0], ref[1], 1.0)
    for t0, t1 in zip(ts, ts[1:]):
        if t1 - t0 < 1e-4:
            continue
        hole = next((h for h in holes if h["t0"] - 1e-6 <= (t0 + t1) / 2 <= h["t1"] + 1e-6), None)
        stone = plinth is not None and (hole is None or hole.get("boards_below"))     # a window keeps the plinth under it
        if stone:
            pa, pb = zb(t0) + plinth, zb(t1) + plinth
            # the end strips run 3 cm past the corner so two plinths meet round it without a gap
            ta, tb = (t0 - 0.03 if t0 < 1e-6 else t0), (t1 + 0.03 if t1 > L - 1e-6 else t1)
            face(g, [P(ta, zb(t0) - 0.4, 0.03), P(tb, zb(t1) - 0.4, 0.03), P(tb, pb, 0.03), P(ta, pa, 0.03)], plinth_mat, inner)
            face(g, [P(ta, pa, 0.03), P(tb, pb, 0.03), P(tb, pb, 0.0), P(ta, pa, 0.0)], plinth_mat, P((t0 + t1) / 2, (pa + pb) / 2 - 1.0))   # ledge, faces up
            lo0, lo1 = pa, pb
        else:
            lo0, lo1 = zb(t0) - 0.4 if hole is None else zb(t0), zb(t1) - 0.4 if hole is None else zb(t1)
        if hole is None:
            face(g, [P(t0, lo0), P(t1, lo1), P(t1, zt(t1)), P(t0, zt(t0))], mat, inner)
        else:
            if hole.get("boards_below"):
                face(g, [P(t0, lo0), P(t1, lo1), P(t1, hole["sill"]), P(t0, hole["sill"])], mat, inner)
            else:
                face(g, [P(t0, lo0 - 0.4), P(t1, lo1 - 0.4), P(t1, hole["sill"]), P(t0, hole["sill"])], plinth_mat or mat, inner)
            face(g, [P(t0, hole["head"]), P(t1, hole["head"]), P(t1, zt(t1)), P(t0, zt(t0))], mat, inner)
    for h in holes:
        t0, t1, s, hd = h["t0"], h["t1"], h["sill"], h["head"]
        for t, side in ((t0, 1), (t1, -1)):                    # jambs
            face(g, [P(t, s), P(t, hd), P(t, hd, -depth), P(t, s, -depth)], mat, P(t - side * 0.5, (s + hd) / 2, -depth / 2))   # faces into the opening
        face(g, [P(t0, hd), P(t1, hd), P(t1, hd, -depth), P(t0, hd, -depth)], mat, P((t0 + t1) / 2, hd + 0.5, -depth / 2))   # soffit, faces down
        face(g, [P(t0, s), P(t1, s), P(t1, s, -depth), P(t0, s, -depth)], plinth_mat or mat, P((t0 + t1) / 2, s - 0.5, -depth / 2))  # sill, faces up
        face(g, [P(t0, s, -depth), P(t1, s, -depth), P(t1, hd, -depth), P(t0, hd, -depth)], h.get("fill") or fill or mat, inner)
    return nx, ny


def flat_roof(g, x0, x1, y0, y1, zf, thick, top, edge, under, hang=None):
    """Roof plane (rectangle x0..x1, y0..y1, top height zf(y) linear in y) with underside, fascia and barge boards."""
    zt0, zt1 = zf(y0), zf(y1)
    hang = hang or thick
    ref = ((x0 + x1) / 2, (y0 + y1) / 2, (zt0 + zt1) / 2 - 1.0)
    top_q = [(x0, y0, zt0), (x1, y0, zt0), (x1, y1, zt1), (x0, y1, zt1)]
    face(g, top_q, top, ref)
    face(g, [(x, y, z - thick) for x, y, z in top_q], under, ((x0 + x1) / 2, (y0 + y1) / 2, (zt0 + zt1) / 2 + 1.0))
    inside = ((x0 + x1) / 2, (y0 + y1) / 2, (zt0 + zt1) / 2 - hang / 2)
    for (xa, ya, za), (xb, yb, zb_) in zip(top_q, top_q[1:] + top_q[:1]):
        face(g, [(xa, ya, za), (xb, yb, zb_), (xb, yb, zb_ - hang), (xa, ya, za - hang)], edge, inside)


# ---------------------------------------------------------------------------------------------
# Driving-range bay shelter
# ---------------------------------------------------------------------------------------------
# Marcus moved it 1.21 m west in Unity (2026-10-18) from the lidar fit's E 477841.10 N 6457553.55.
SH = dict(e=477839.89, n=6457553.53, yaw=160.5, ground=110.37)
SLAB_X, SLAB_Y, SLAB_TOP = 11.25, 2.1, 0.2
ARCH = dict(y0=2.09, z0=114.295 - SH["ground"], R=11.2)           # lidar fit of the roof's top surface
ROOF_X, ROOF_Y0, ROOF_Y1 = 11.05, -2.2, 2.8
POST_Y, BAYS, BAY = 1.95, 6, 3.6                                  # post rows y = +-1.95, post lines every 3.6 m
NSEG = 8                                                          # segments across the arch


def zr(y):
    """Top surface of the roof panels at across-position y."""
    return ARCH["z0"] - (ARCH["R"] - math.sqrt(ARCH["R"] ** 2 - (y - ARCH["y0"]) ** 2))


def arch_pts(offset=0.0):
    ys = [ROOF_Y0 + (ROOF_Y1 - ROOF_Y0) * i / NSEG for i in range(NSEG + 1)]
    return [(y, zr(y) + offset) for y in ys]


def shelter(ev):
    g = kit.Geo()
    g.category = "building"
    steel, glass, alu, fas = "omberg_steel", "omberg_glass", "omberg_alu", "omberg_fascia"
    # slab: pale concrete, its sides run 0.6 m down so the sloping ground never shows a gap
    g.box((0, 0, SLAB_TOP - 0.4), (2 * SLAB_X, 2 * SLAB_Y, 0.8), "omberg_slab")
    post_x = [-BAYS * BAY / 2 + BAY * i for i in range(BAYS + 1)]         # -10.8 .. +10.8
    zlow = lambda y: zr(y) - 0.17                                          # underside of the arches
    BEAM_H = 0.14
    # posts 10 x 10 cm, base plates, and a beam along each post row under the arches
    for y in (-POST_Y, POST_Y):
        for x in post_x:
            top = zlow(y) - BEAM_H
            g.box((x, y, (SLAB_TOP + top) / 2), (0.1, 0.1, top - SLAB_TOP + 0.04), steel)
            g.box((x, y, SLAB_TOP + 0.01), (0.2, 0.2, 0.02), steel)
        g.box((0, y, zlow(y) - BEAM_H / 2), (2 * post_x[-1] + 0.1, 0.1, BEAM_H), steel)
    # curved rafters (arches) over every post line, 6 x 14 cm, centred 10 cm under the roof surface
    pts = arch_pts(-0.10)
    for x in post_x:
        for (ya, za), (yb, zb) in zip(pts, pts[1:]):
            g.beam((x, ya, za), (x, yb, zb), 0.06, 0.14, steel)
    # lighter secondary arches at the batten lines between the post lines (the photo shows a dark rib every 1.2 m
    # under the panels), 4 x 10 cm, hung from the purlins
    for k in range(19):
        x = -BAYS * BAY / 2 + 1.2 * k
        if any(abs(x - px) < 0.05 for px in post_x):
            continue
        for (ya, za), (yb, zb) in zip(pts, pts[1:]):
            g.beam((x, ya, za + 0.0), (x, yb, zb + 0.0), 0.04, 0.10, steel)
    # purlins along the roof under the arches (the photo shows four lines plus the edge frame)
    for y in (-1.3, -0.4, 0.5, 1.4, 2.3, 2.65):
        g.box((0, y, zlow(y) - 0.04), (2 * ROOF_X - 0.1, 0.05, 0.08), steel)
    # translucent roof: top and underside layers 3 cm apart, dark thin edge fascia all round
    ys = arch_pts()
    for (ya, za), (yb, zb) in zip(ys, ys[1:]):
        c = (0.0, (ya + yb) / 2, (za + zb) / 2)
        face(g, [(-ROOF_X, ya, za), (ROOF_X, ya, za), (ROOF_X, yb, zb), (-ROOF_X, yb, zb)], "omberg_roof_pc", (0, c[1], c[2] - 1))
        face(g, [(-ROOF_X, ya, za - 0.03), (ROOF_X, ya, za - 0.03), (ROOF_X, yb, zb - 0.03), (-ROOF_X, yb, zb - 0.03)],
             "omberg_roof_pc", (0, c[1], c[2] + 1))
        for sx in (-1, 1):                                                      # end fascia
            q = [(sx * ROOF_X, ya, za), (sx * ROOF_X, yb, zb), (sx * ROOF_X, yb, zb - 0.12), (sx * ROOF_X, ya, za - 0.12)]
            face(g, q, fas, (0, c[1], c[2] - 0.06))
            face(g, [(x - sx * 0.006, y, z) for x, y, z in q], fas, (sx * 5, c[1], c[2] - 0.06))     # inner face 6 mm in (a coincident one is welded away)
    for y, side in ((ROOF_Y0, -1), (ROOF_Y1, 1)):
        z = zr(y)
        q = [(-ROOF_X, y, z), (ROOF_X, y, z), (ROOF_X, y, z - 0.12), (-ROOF_X, y, z - 0.12)]
        face(g, q, fas, (0, y - side, z - 0.06))
        face(g, [(x, yy - side * 0.006, zz) for x, yy, zz in q], fas, (0, y + side, z - 0.06))
    # aluminium battens every 1.2 m across the roof (the white lines of the ortho), 5 x 2.5 cm
    bx = [-BAYS * BAY / 2 + 1.2 * k for k in range(19)]
    hb = 0.025
    for x in bx:
        for (ya, za), (yb, zb) in zip(ys, ys[1:]):
            xl, xr = x - 0.025, x + 0.025
            ref = (x, (ya + yb) / 2, (za + zb) / 2 - 1)
            face(g, [(xl, ya, za + hb), (xr, ya, za + hb), (xr, yb, zb + hb), (xl, yb, zb + hb)], alu, ref)
            for xs_ in (xl, xr):
                face(g, [(xs_, ya, za), (xs_, yb, zb), (xs_, yb, zb + hb), (xs_, ya, za + hb)], alu, (x, (ya + yb) / 2, (za + zb) / 2 + hb / 2))
        for y, za in ((ys[0][0], ys[0][1]), (ys[-1][0], ys[-1][1])):
            face(g, [(x - 0.025, y, za), (x + 0.025, y, za), (x + 0.025, y, za + hb), (x - 0.025, y, za + hb)], alu, (x, (ROOF_Y0 + ROOF_Y1) / 2, za))
    # back wall (west, y = -1.95): glass panes 1.8 m wide in steel mullions, rails at the foot and at 1 m
    yb_ = -POST_Y
    top_b = zlow(yb_) - BEAM_H
    mx = [-BAYS * BAY / 2 + 1.8 * j for j in range(2 * BAYS + 1)]
    for x in mx[1::2]:
        g.box((x, yb_, (SLAB_TOP + top_b) / 2), (0.05, 0.06, top_b - SLAB_TOP), steel)
    for z in (SLAB_TOP + 0.08, 1.05):
        g.box((0, yb_, z), (2 * post_x[-1], 0.06, 0.06 if z > 0.5 else 0.12), steel)
    for xa, xb in zip(mx, mx[1:]):
        for dy, s in ((-0.003, -1), (0.003, 1)):
            q = [(xa + 0.03, yb_ + dy, SLAB_TOP + 0.14), (xb - 0.03, yb_ + dy, SLAB_TOP + 0.14), (xb - 0.03, yb_ + dy, top_b), (xa + 0.03, yb_ + dy, top_b)]
            face(g, q, glass, (xa, yb_ - 5 * s, 1.5))
    # ends (x = +-10.8): three glass panes between the corner posts and two mullions; a glazed door at the NNW end
    top_at = lambda y: zlow(y) - BEAM_H
    my = [-POST_Y, -0.65, 0.65, POST_Y]
    for sx in (-1, 1):
        x = sx * post_x[-1]
        for y in (-0.65, 0.65):
            g.box((x, y, (SLAB_TOP + top_at(y)) / 2), (0.06, 0.05, top_at(y) - SLAB_TOP), steel)
        g.box((x, 0, SLAB_TOP + 0.08), (0.06, 2 * POST_Y, 0.12), steel)
        if sx > 0:
            g.box((x, 0, 1.05), (0.06, 2 * POST_Y, 0.06), steel)
        else:                                                                           # the door pane keeps no rail
            for yc in (-1.3, 1.3):
                g.box((x, yc, 1.05), (0.06, 1.3, 0.06), steel)
        for ya, yb in zip(my, my[1:]):
            for dx, s in ((-0.003, -1), (0.003, 1)):
                q = [(x + dx, ya + 0.03, SLAB_TOP + 0.14), (x + dx, yb - 0.03, SLAB_TOP + 0.14), (x + dx, yb - 0.03, top_at(yb)), (x + dx, ya + 0.03, top_at(ya))]
                face(g, q, glass, (x - 5 * s * sx, 0, 1.5))
    x = -post_x[-1]                                                                    # NNW end: the door, 1.1 m wide
    for y in (-0.55, 0.55):
        g.box((x, y, (SLAB_TOP + 2.1) / 2), (0.06, 0.05, 2.1 - SLAB_TOP), steel)
    g.box((x, 0, 2.1), (0.06, 1.15, 0.06), steel)
    g.box((x - 0.05, 0.4, 1.05), (0.03, 0.03, 0.5), "omberg_alu")                      # handle bar
    # bay dividers: low steel frames from the glass wall to the front posts at the inner post lines
    for x in post_x[1:-1]:
        for z in (0.45, 1.05):
            g.box((x, 0, z), (0.05, 2 * POST_Y, 0.04), steel)
        for y in (-0.6, 0.75):
            g.box((x, y, (SLAB_TOP + 1.05) / 2), (0.04, 0.04, 1.05 - SLAB_TOP), steel)
    # one mat per bay near the open front, 1.5 x 1.5 m, with a rubber tee box
    for i in range(BAYS):
        xc = -BAYS * BAY / 2 + BAY * (i + 0.5)
        g.box((xc, 1.0, SLAB_TOP + 0.015), (1.5, 1.5, 0.03), "omberg_mat_turf", mats={"side": "omberg_rubber"})
        g.box((xc + 0.35, 1.45, SLAB_TOP + 0.04), (0.26, 0.26, 0.02), "omberg_rubber")
    return g


# ---------------------------------------------------------------------------------------------
# Hitting stations along the pink path, target flags, ball shed, asphalt path
# ---------------------------------------------------------------------------------------------
# mat centres (E, N) detected in the 2025 ortho (dark green 1.5 x 1.6 m rectangles along the path's east edge)
MATS = [(477850.81, 6457580.87), (477850.72, 6457584.44), (477850.63, 6457587.61), (477850.53, 6457590.94),
        (477850.78, 6457595.09), (477850.89, 6457598.61), (477851.25, 6457602.95), (477851.44, 6457606.43),
        (477851.81, 6457611.08), (477852.15, 6457615.27), (477852.65, 6457619.46), (477852.82, 6457622.69),
        (477853.5, 6457626.5), (477854.1, 6457630.4), (477855.0, 6457634.4), (477855.7, 6457637.3), (477856.3, 6457640.5)]
# target-green flag pins (E, N): the bright dot and its shadow in the middle of each round green disc, both vintages
FLAGS = [(477907.8, 6457639.2), (477947.9, 6457622.0), (477931.2, 6457596.3), (477977.5, 6457600.7),
         (477971.7, 6457647.3), (478001.7, 6457631.4), (478029.7, 6457604.5), (478052.3, 6457631.5)]
# centreline of the asphalt path from the pink path's south end to the shelter's NNW end (leaf-off 2023 ortho)
PATH = [(477847.12, 6457577.6), (477846.96, 6457575.4), (477846.3, 6457572.9), (477844.9, 6457570.3),
        (477843.0, 6457568.1), (477840.9, 6457566.5), (477839.3, 6457565.5)]


def mat_asset():
    g = kit.Geo()
    g.category = "prop"
    g.box((0, 0, -0.055), (1.5, 1.6, 0.19), "omberg_mat_turf", mats={"side": "omberg_rubber"})   # top 4 cm, foot sunk
    g.box((0.0, 0.45, 0.045), (0.26, 0.26, 0.02), "omberg_rubber")                               # tee box
    g.box((0.0, 0.45, 0.062), (0.04, 0.04, 0.014), "omberg_rubber")                              # tee
    return g


def flag_asset():
    g = kit.Geo()
    g.category = "prop"
    kit.target_flag(g, {"height": 2.4, "mat": "target_flag_white"})
    return g


def chaikin(pts, n=3):
    for _ in range(n):
        out = [pts[0]]
        for a, b in zip(pts, pts[1:]):
            out += [(0.75 * a[0] + 0.25 * b[0], 0.75 * a[1] + 0.25 * b[1]), (0.25 * a[0] + 0.75 * b[0], 0.25 * a[1] + 0.75 * b[1])]
        out.append(pts[-1])
        pts = out
    return pts


def path_asset(ev):
    """Asphalt path draped on ev.terrain: a strip along the smoothed centreline, 2.4 m wide, 3 cm over the ground,
    with a 0.3 m skirt on both edges. Asset frame: x east, y north from the first point (yaw 90)."""
    e0, n0 = PATH[0]
    g0 = ev.terrain(e0, n0)
    # last point: tuck into the slab's NNW end (shelter frame x = -11.3, y = 0.4)
    end = world(SH["e"], SH["n"], SH["yaw"], -11.3, 0.4)
    c = chaikin(PATH[:-1] + [(PATH[-1][0] * 0.5 + end[0] * 0.5, PATH[-1][1] * 0.5 + end[1] * 0.5), end], 3)
    # resample every ~1 m
    out = [c[0]]
    for p in c[1:]:
        if math.dist(p, out[-1]) >= 1.0 or p is c[-1]:
            out.append(p)
    w, lift = 1.2, 0.03
    g = kit.Geo()
    g.category = "structure"
    L, R = [], []
    for i, p in enumerate(out):
        a, b = out[max(0, i - 1)], out[min(len(out) - 1, i + 1)]
        d = math.dist(a, b)
        tx, ty = (b[0] - a[0]) / d, (b[1] - a[1]) / d
        L.append((p[0] - ty * w, p[1] + tx * w))
        R.append((p[0] + ty * w, p[1] - tx * w))

    def pt(q, dz=0.0):
        return (q[0] - e0, q[1] - n0, ev.terrain(q[0], q[1]) - g0 + lift + dz)
    for i in range(len(out) - 1):
        face(g, [pt(R[i]), pt(R[i + 1]), pt(L[i + 1]), pt(L[i])], "asphalt", (out[i][0] - e0, out[i][1] - n0, -5))
        for side in (L, R):
            sgn = 1 if side is L else -1
            q = [pt(side[i], -0.3 - lift), pt(side[i + 1], -0.3 - lift), pt(side[i + 1]), pt(side[i])]
            face(g, q, "asphalt", (out[i][0] - e0, out[i][1] - n0, 0.0))
    return g, e0, n0, g0


def shed_asset(ev, e, n, yaw):
    """Ball dispenser shed at the north end of the mat row (inferred: the ortho shows a dark-roofed square ~2 m
    with a long shadow, six lidar returns at 2.4 m on its east edge)."""
    g = kit.Geo()
    g.category = "structure"
    g0 = ev.terrain(e, n)
    hx, hy, top = 1.05, 0.95, 2.35
    terr = lambda x, y: ev.terrain(*world(e, n, yaw, x, y)) - g0
    corners = [(-hx, -hy), (hx, -hy), (hx, hy), (-hx, hy)]
    for k, (a, b) in enumerate(zip(corners, corners[1:] + corners[:1])):
        L = math.dist(a, b)
        zb = lambda t, a=a, b=b, L=L: terr(a[0] + (b[0] - a[0]) * t / L, a[1] + (b[1] - a[1]) * t / L)
        holes = []
        zroof = lambda y: top - 0.05 * (y + hy) / (2 * hy)
        zt = lambda t, a=a, b=b, L=L: zroof(a[1] + (b[1] - a[1]) * t / L) - 0.12
        if k == 3:
            holes = [dict(t0=0.45, t1=1.45, sill=max(zb(0.45), zb(1.45)) + 0.1, head=max(zb(0.45), zb(1.45)) + 1.85)]
        wall(g, a, b, zb, zt, "omberg_steel", (0, 0, 1), holes=holes, plinth=0.3, plinth_mat="concrete",
             depth=0.08, fill="door_black")
    flat_roof(g, -hx - 0.2, hx + 0.2, -hy - 0.2, hy + 0.2, lambda y: top - 0.05 * (y + hy) / (2 * hy), 0.12,
              "roof_metal_black", "omberg_fascia", "omberg_fascia", hang=0.14)
    return g, g0


# ---------------------------------------------------------------------------------------------
# Hut north of the course (OSM 965886766)
# ---------------------------------------------------------------------------------------------
HUT = dict(e=477632.47, n=6458618.61, ang=135.3, u0=0.15, v0=0.675, hx=1.9, hy=1.375)


def hut(ev):
    """Red board shed with a white flat roof, on a rock slope. Local frame: x = the OSM long axis towards NW
    (u), y towards SW (v), origin on the hut's walls centre (u0, v0 from the lidar roof returns and the ortho)."""
    th = math.radians(HUT["ang"])
    ux, uy = math.cos(th), math.sin(th)
    vx, vy = -uy, ux
    e = HUT["e"] + HUT["u0"] * ux + HUT["v0"] * vx
    n = HUT["n"] + HUT["u0"] * uy + HUT["v0"] * vy
    yaw = (90 - HUT["ang"]) % 360           # compass bearing of +x (NW)
    g0 = ev.terrain(e, n)
    g = kit.Geo()
    g.category = "building"
    hx, hy = HUT["hx"], HUT["hy"]
    terr = lambda x, y: ev.terrain(*world(e, n, yaw, x, y)) - g0
    roof_abs = lambda y: 100.40 - 0.10 * (y + hy + 0.15) / (2 * hy + 0.3)        # lidar: flat, 0.1 m fall to +y
    zroof = lambda y: roof_abs(y) - g0
    THICK = 0.14
    corners = [(-hx, -hy), (hx, -hy), (hx, hy), (-hx, hy)]
    for k, (a, b) in enumerate(zip(corners, corners[1:] + corners[:1])):
        L = math.dist(a, b)
        zb = lambda t, a=a, b=b, L=L: terr(a[0] + (b[0] - a[0]) * t / L, a[1] + (b[1] - a[1]) * t / L)
        zt = lambda t, a=a, b=b, L=L: zroof(a[1] + (b[1] - a[1]) * t / L) - THICK
        holes = []
        if k == 0:                                           # long wall at -y (the low, track side): the door, 0.9 x 2.0 m
            t0, t1 = 0.45, 1.35
            sill = max(zb(t0), zb(t1)) + 0.2                 # one step above the ground at its higher end (inferred)
            holes = [dict(t0=t0, t1=t1, sill=sill, head=sill + 2.0)]
            wz = max(zb(2.4), zb(3.2)) + 1.1                  # a small window right of the door (inferred: a 3 m wall with no light)
            holes.append(dict(t0=2.4, t1=3.2, sill=wz, head=wz + 0.7, fill="window_dark", boards_below=True))
        wall(g, a, b, zb, zt, "falu_red_vertical", (0, 0, 1), holes=holes, plinth=0.35, plinth_mat="omberg_hut_stone",
             depth=0.1, fill="door_red")
        if k == 0:
            h = holes[0]
            # white casing round the door and a stone step
            ex, ey = (b[0] - a[0]) / L, (b[1] - a[1]) / L
            nx, ny = ey, -ex
            if ny > 0:
                nx, ny = -nx, -ny
            for tt, w_, z0, z1 in ((t0 - 0.06, 0.08, h["sill"], h["head"] + 0.1), (t1 + 0.06, 0.08, h["sill"], h["head"] + 0.1)):
                cx_, cy_ = a[0] + ex * tt + nx * 0.02, a[1] + ey * tt + ny * 0.02
                g.box((cx_, cy_, (z0 + z1) / 2), (w_ if abs(ex) > 0.5 else 0.05, 0.05 if abs(ex) > 0.5 else w_, z1 - z0), "white_trim")
            cx_, cy_ = a[0] + ex * (t0 + t1) / 2 + nx * 0.02, a[1] + ey * (t0 + t1) / 2 + ny * 0.02
            g.box((cx_, cy_, h["head"] + 0.05), (t1 - t0 + 0.2, 0.05, 0.08), "white_trim")
            wh = holes[1]                                    # white casing and a sill board round the window
            for tt in (wh["t0"] - 0.05, wh["t1"] + 0.05):
                g.box((a[0] + ex * tt + nx * 0.02, a[1] + ey * tt + ny * 0.02, (wh["sill"] + wh["head"]) / 2), (0.07, 0.05, wh["head"] - wh["sill"] + 0.14), "white_trim")
            for zz, hh in ((wh["head"] + 0.04, 0.07), (wh["sill"] - 0.04, 0.07)):
                g.box((a[0] + ex * (wh["t0"] + wh["t1"]) / 2 + nx * 0.02, a[1] + ey * (wh["t0"] + wh["t1"]) / 2 + ny * 0.02, zz), (wh["t1"] - wh["t0"] + 0.19, 0.05, hh), "white_trim")
            sx_, sy_ = a[0] + ex * (t0 + t1) / 2 + nx * 0.3, a[1] + ey * (t0 + t1) / 2 + ny * 0.3
            g.box((sx_, sy_, (h["sill"] - 0.1 + zb((t0 + t1) / 2) - 0.4) / 2), (1.2, 0.6, h["sill"] - 0.1 - zb((t0 + t1) / 2) + 0.4), "omberg_hut_stone")
    flat_roof(g, -hx - 0.15, hx + 0.15, -hy - 0.15, hy + 0.15, zroof, THICK, "omberg_roof_white", "white_trim", "white_trim", hang=0.16)
    return g, e, n, yaw, g0


# ---------------------------------------------------------------------------------------------
def build(add, new, ev):
    # shelter
    g = shelter(ev)
    add(PREFIX + "range_shelter", g, SH["e"], SH["n"], SH["yaw"], SH["ground"])
    # path (draped)
    g, e0, n0, g0 = path_asset(ev)
    add(PREFIX + "range_path", g, e0, n0, 90.0, g0)
    # mats: one shared asset, each instance on its own terrain; yaw puts +y (the open side) east of the row
    for i, (e, n) in enumerate(MATS):
        a, b = MATS[max(0, i - 1)], MATS[min(len(MATS) - 1, i + 1)]
        row = math.degrees(math.atan2(b[0] - a[0], b[1] - a[1]))        # compass bearing of the row, north-ish
        add(PREFIX + "range_mat", mat_asset(), e, n, (row + 180) % 360, ev.terrain(e, n))
    # target flags
    for e, n in FLAGS:
        add(PREFIX + "range_flag", flag_asset(), e, n, 90.0, ev.terrain(e, n))
    # ball shed, bearing 72 deg from the ortho
    se, sn = 477852.9, 6457643.3
    g, g0 = shed_asset(ev, se, sn, 72.0)
    add(PREFIX + "range_shed", g, se, sn, 72.0, g0)
    # hut
    g, e, n, yaw, g0 = hut(ev)
    add(PREFIX + "hut", g, e, n, yaw, g0)
