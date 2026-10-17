"""Houses across the road south of the farm, built from the 2025 lidar, the 2023/2025 orthos and street view.

  OSM 1431566963  road house: falu-red board house, orange tile roof, shed dormer ("frontispiece") with a window
                  band, glazed veranda on its west (track) side, chimney      -> omberg_farm_road_house
  OSM 1431566964  its outbuilding, low grey roof                               -> omberg_farm_road_outbuilding
  OSM 1431566965  small red cottage in the field, brown tile roof              -> omberg_farm_field_cottage
  OSM 1431566966  a second house in the trees (two chimneys, two shed dormers) -> omberg_farm_field_house
  OSM 1431566967  small dark-roofed shed beside it                             -> omberg_farm_field_shed

Every building is a gabled box whose ridge height, pitch, barge overhang, dormer planes and chimneys are plane fits
to the class-1 lidar returns (the numbers sit in _build()); ground = class-2 median in a ring round the footprint.
Asset frame: +x along the long axis, +y to the left of x, ridge on y = 0 (place() moves the origin onto the fitted
ridge), z up from the ground. Roof planes, walls and openings are exact planes; window and door recesses are cut in
the wall polygons (wall()), so there are no coplanar boxes or gaps.
model.py calls register_materials() and build(add, new, ev).
"""
import math

import numpy as np
from mathutils import Matrix, Vector

import props_kit as kit

MATTE = {"nb_tile_brown", "nb_roof_grey", "nb_roof_dark", "nb_white_board", "nb_chimney", "nb_step"}   # only materials this module defines


def register_materials():
    M = kit.MATERIALS
    M["nb_tile_brown"] = ("pantile:124,80,64", (2.0, 2.0), None, 0.2, 0.0)
    M["nb_roof_grey"] = ("seam:108,112,118:0.52:2.08:0", (2.08, 2.08), None, 0.3, 0.2)
    M["nb_roof_dark"] = ("seam:48,50,54:0.52:2.08:0", (2.08, 2.08), None, 0.3, 0.2)
    M["nb_white_board"] = ("boards:176,176,170:h:0.14:1.0:0", (1.0, 1.0), None, 0.15, 0.0)
    M["nb_chimney"] = ("plaster:84,78,74", (2.0, 2.0), None, 0.1, 0.0)
    M["nb_step"] = ("stone:118,114,110", (2.0, 2.0), None, 0.2, 0.0)
    kit.TILE_ROOFS["nb_tile_brown"] = 0.34   # stepped courses as geometry (kit._roof_slab)
    kit.SEAM_ROOFS["nb_roof_grey"] = kit.SEAM_ROOFS["nb_roof_dark"] = 0.52


# ---------------------------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------------------------
OUT = {"+y": (0, 1, 0), "-y": (0, -1, 0), "+x": (1, 0, 0), "-x": (-1, 0, 0)}
WHITE = "white_trim"


def quad(g, pts, out, mat):
    """Polygon facing `out`: the vertex order is fixed from its Newell normal, so no winding to get wrong."""
    P = [Vector(p) for p in pts]
    P = [p for i, p in enumerate(P) if (p - P[i - 1]).length > 1e-6]
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
    (linear between the breakpoints). holes: (c0, c1, zlow, zhigh). Opening columns get a piece below and above, and the
    neighbouring full columns carry the hole's corner vertices, so the wall has no T-cracks."""
    P = (lambda c, z: (c, plane, z)) if side[1] == "y" else (lambda c, z: (plane, c, z))
    cs = sorted({lo, hi, *brk} | {h[0] for h in holes} | {h[1] for h in holes})
    for a, b in zip(cs, cs[1:]):
        if b - a < 1e-6:
            continue
        m = (a + b) / 2
        h = next((h for h in holes if h[0] <= a + 1e-6 and b <= h[1] + 1e-6), None)
        if h:
            if h[2] > z0 + 1e-6:
                quad(g, [P(a, z0), P(b, z0), P(b, h[2]), P(a, h[2])], OUT[side], mat)
            if min(top(a, m), top(b, m)) > h[3] + 1e-6:
                quad(g, [P(a, h[3]), P(b, h[3]), P(b, top(b, m)), P(a, top(a, m))], OUT[side], mat)
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
    """Board door with a glazed upper half, in a recess with casing; the step comes from step()."""
    w, h, s = o["w"], o["h"], o["sill"]
    d, cw = 0.10, 0.10
    L, R, B, T = -w / 2, w / 2, s, s + h
    g.push(frame_m(side, plane, o["at"]))
    quad(g, [(L, B, 0), (L, T, 0), (L, T, -d), (L, B, -d)], (1, 0, 0), WHITE)
    quad(g, [(R, B, 0), (R, T, 0), (R, T, -d), (R, B, -d)], (-1, 0, 0), WHITE)
    quad(g, [(L, T, 0), (R, T, 0), (R, T, -d), (L, T, -d)], (0, -1, 0), WHITE)
    g.box((0, (B + T) / 2, -d + 0.03), (w - 0.02, h - 0.01, 0.05), o.get("mat", "door_white"))
    if o.get("lights", True):
        gl = (w / 2 - 0.16)
        quad(g, [(-gl, B + h * 0.42, -d + 0.062), (gl, B + h * 0.42, -d + 0.062), (gl, T - 0.22, -d + 0.062), (-gl, T - 0.22, -d + 0.062)], (0, 0, 1), "window_dark")
        for z in (B + h * 0.42, T - 0.22):
            g.box((0, z, -d + 0.066), (2 * gl + 0.06, 0.05, 0.02), WHITE)
        for sx in (-gl, gl):
            g.box((sx, (B + h * 0.42 + T - 0.22) / 2, -d + 0.066), (0.05, T - 0.22 - B - h * 0.42 + 0.05, 0.02), WHITE)
        g.box((0, (B + h * 0.42 + T - 0.22) / 2, -d + 0.066), (0.03, T - 0.22 - B - h * 0.42, 0.02), WHITE)
    g.box((R - 0.12, B + 0.98, -d + 0.075), (0.04, 0.14, 0.04), "chrome")
    for sx in (-1, 1):
        g.box((sx * (w / 2 + cw / 2), (B + T) / 2 + cw / 2, 0.015), (cw, h + cw, 0.03), WHITE)
    g.box((0, T + cw / 2, 0.015), (w + 2 * cw, cw, 0.03), WHITE)
    g.box((0, T + cw + 0.02, 0.04), (w + 2 * cw + 0.08, 0.04, 0.08), WHITE)
    g.pop()


def step(g, side, plane, at, w, flights):
    """Stone steps in front of a door: (depth from the wall, top z) per tread, highest nearest the door; each block
    stands on the ground (sunk 0.3 below it) so none floats."""
    g.push(frame_m(side, plane, at))
    for depth, top in flights:
        g.box((0, (top - 0.3) / 2, depth / 2), (w, top + 0.3, depth), "nb_step")
    g.pop()


def downpipe(g, x, yg, zg, yw, mat):
    """Gutter outlet (x, yg, zg) -> jog in under the overhang -> straight down the wall at yw -> shoe over a splash
    stone on the ground. Always ends on the ground, beside the wall (callers keep it clear of roofs)."""
    s = 1 if yw > 0 else -1
    wy = yw + s * 0.07
    p = [(x, yg, zg), (x, yg, zg - 0.22), (x, wy, zg - 0.22 - abs(yg - wy)), (x, wy, 0.20), (x, wy + s * 0.2, 0.09)]
    for a, b in zip(p, p[1:]):
        g.pipe(a, b, 0.045, mat, seg=8)
    for z in (0.7, 1.7, 2.7):
        if z < p[2][2] - 0.2:
            g.box((x, (wy + yw) / 2, z), (0.1, abs(wy - yw), 0.03), mat)
    g.box((x, wy + s * 0.3, 0.0), (0.45, 0.4, 0.12), "nb_step")   # splash stone, sunk so it sits on any ground


def gutter(g, x0, x1, ey, ez, sgn, mat="galvanised", r=0.07):
    """Half-round gutter on a fascia whose top edge is (ey, ez) (kit placement); returns (gy, gz)."""
    gy, gz = ey + sgn * r * 0.6, ez - 0.11
    kit._gutter(g, x0, x1, gy, gz, r, mat)
    return gy, gz


# ---------------------------------------------------------------------------------------------
# a gabled house
# ---------------------------------------------------------------------------------------------
def zr(p, y):
    """Top of the roof plane (tile or sheet surface) at |y|."""
    return p["ridge"] - p["tan"] * abs(y)


def house(g, p):
    L, W, ph = p["L"], p["W"], p["ph"]
    tile, wmat = p["tile"], p.get("wall", "falu_red_vertical")
    thick, ovh = p.get("thick", 0.15), p.get("ovh", 0.45)
    govh = p.get("govh", 0.4)
    gl, gh = govh if isinstance(govh, tuple) else (govh, govh)   # barge overhang at the -x and +x gable
    tv = thick * math.sqrt(1 + p["tan"] ** 2)           # vertical thickness of a roof slab
    x0, x1 = -L - gl, L + gh
    ops = p["openings"]
    for o in ops:
        if o.get("kind") == "door":
            o["sill"] = ph                               # threshold on the plinth top
    for o in ops:                                        # keep casing, drip cap and sill clear of the roof underside
        side = o["side"]
        top = zr(p, W) - tv - 0.17 if side[1] == "y" else min(zr(p, o["at"] - o["w"] / 2), zr(p, o["at"] + o["w"] / 2)) - 0.09 - 0.17
        o["h"] = min(o["h"], top - o["sill"])
    g.extrude([(-L - .03, -W - .03), (L + .03, -W - .03), (L + .03, W + .03), (-L - .03, W + .03)], -0.8, ph, "concrete", top="concrete", bottom=False)

    # walls: gable walls rise to the roof underside inside the slab; long walls to the eave, lower under a dormer
    holes = lambda side, plane: [(o["at"] - o["w"] / 2 - 0.0, o["at"] + o["w"] / 2, o["sill"], o["sill"] + o["h"]) for o in ops if o["side"] == side]
    dorm_x = {d["side"]: (d["xc"] - d["wd"] / 2, d["xc"] + d["wd"] / 2) for d in p.get("dormers", []) if d.get("yw", W) >= W}
    for side, plane in (("+y", W), ("-y", -W)):
        dx = dorm_x.get(1 if side == "+y" else -1)
        brk = dx or ()
        zt = zr(p, W)
        top = lambda c, m, dx=dx, zt=zt: zt - (tv if dx and dx[0] < m < dx[1] else 0.09)
        wall(g, side, plane, -L, L, ph, top, wmat, holes(side, plane), brk)
    for side, plane in (("+x", L), ("-x", -L)):
        wall(g, side, plane, -W, W, ph, lambda c, m: zr(p, c) - 0.09, wmat, holes(side, plane), (0.0,))
    for o in ops:
        side = o["side"]
        plane = {"+y": W, "-y": -W, "+x": L, "-x": -L}[side]
        (door if o.get("kind") == "door" else window)(g, side, plane, o)
        if o.get("kind") == "door" and o.get("steps", True):
            step(g, side, plane, o["at"], o["w"] + 0.5, [(0.4, ph - 0.02), (0.75, ph * 0.5 - 0.01)])
    for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1)):  # corner boards, plinth to under the roof
        zt = zr(p, W) - 0.09
        g.box((sx * L, sy * W, (ph + zt) / 2), (0.13, 0.13, zt - ph), WHITE)

    # roof: two slabs from the walls to the ridge; the dormer side is cut so the dormer wall stands flush on the eave
    for sgn in (1, -1):
        d = next((d for d in p.get("dormers", []) if d["side"] == sgn and d.get("yw", W) >= W), None)
        if d:
            xl, xr = d["xc"] - d["wd"] / 2, d["xc"] + d["wd"] / 2
            parts = [(x0, xl, ovh), (xl, xr, 0.0), (xr, x1, ovh)]
        else:
            parts = [(x0, x1, ovh)]
        for a, b, ov in parts:
            (ey, ez), _h, _n = kit._roof_slab(g, a, b, sgn * W, zr(p, W), 0.0, p["ridge"], ov, thick, tile, WHITE, WHITE)
            p.setdefault("_eave", {})[(sgn, ov > 0, a)] = (a, b, ey, ez)
    metal = tile in kit.SEAM_ROOFS
    g.box(((x0 + x1) / 2, 0, p["ridge"] + 0.02), (x1 - x0, 0.2 if metal else 0.28, 0.07 if metal else 0.12), tile)
    for d in p.get("dormers", []):
        dormer(g, p, d, tv)

    for c in p.get("chimneys", []):                       # (x, size along x, size across the ridge)
        c, sx, sy = c if isinstance(c, tuple) else (c, 0.62, 0.62)
        z = p["ridge"]
        g.box((c, 0, z + 0.25), (sx, sy, 1.2), "nb_chimney")           # bottom 0.35 under the ridge, inside the slabs
        g.box((c, 0, z + 0.89), (sx + 0.16, sy + 0.16, 0.08), "concrete")
        g.cylinder((c + sx * 0.2, 0.0, z + 0.93), 0.06, 0.45, "paint_white", seg=8)
    if p.get("veranda"):
        veranda(g, p, p["veranda"])
    gutters(g, p)


def dormer(g, p, d, tv):
    """Shed dormer flush with the eave wall: red front wall with a window band, red cheeks, a low tile roof that
    overhangs front and sides, white barge boards. The roof meets the main roof in a straight line and the cheeks
    meet the main slope along its true intersection, so there is no gap and no loose edge."""
    s, W = d["side"], d.get("yw", p["W"])               # W: plane of the dormer front wall (the eave wall, or set back on the roof)
    sd, z0 = d["s"], d["z0"]
    zt = lambda Y: z0 - sd * Y
    thick = d.get("thick", 0.14)
    dtv = thick * math.sqrt(1 + sd * sd)
    xl, xr = d["xc"] - d["wd"] / 2, d["xc"] + d["wd"] / 2
    Ym = (p["ridge"] - z0 + dtv) / (p["tan"] - sd)       # where the dormer's underside meets the main slope
    Yh = d.get("Yh", Ym - 0.45)                          # back end of the dormer slab, buried in the main roof
    side = "+y" if s > 0 else "-y"
    ox = d.get("ox", 0.3)
    kit._roof_slab(g, xl - ox, xr + ox, s * W, zt(W), s * Yh, zt(Yh), d.get("ovf", p.get("ovh", 0.45)), thick, p["tile"], WHITE, WHITE)
    zb = zr(p, W) - 0.05
    win = [dict(o, side=side) for o in d["windows"]]
    wall(g, side, s * W, xl, xr, zb, lambda c, m: zt(W) - 0.5 * dtv, p.get("wall", "falu_red_vertical"),
         [(o["at"] - o["w"] / 2, o["at"] + o["w"] / 2, o["sill"], o["sill"] + o["h"]) for o in win])
    for o in win:
        window(g, side, s * W, o)
    for x, nx in ((xl, -1), (xr, 1)):                    # cheeks: triangle between front wall, slab and main slope
        quad(g, [(x, s * W, zb), (x, s * Ym, zr(p, Ym)), (x, s * W, zt(W) - 0.5 * dtv)], (nx, 0, 0), p.get("wall", "falu_red_vertical"))


def gutters(g, p):
    """Half-round gutters on the eaves that have free ground below, with a downpipe at each end that reaches the
    ground. Skipped over the dormer and where a veranda roof is underneath (water runs on to its own gutter)."""
    W = p["W"]
    for sgn in (1, -1):
        for key, (a, b, eyy, ezz) in sorted(p["_eave"].items(), key=lambda kv: kv[1][0]):
            if key[0] != sgn or not key[1]:
                continue
            for lo, hi in p.get("gutterSpans", {}).get(sgn, [(a + 0.02, b - 0.02)]):
                lo, hi = max(lo, a + 0.02), min(hi, b - 0.02)
                if hi - lo < 0.6:
                    continue
                gy, gz = gutter(g, lo, hi, eyy, ezz, sgn)
                for x in p.get("downpipes", {}).get(sgn, []):
                    if lo - 0.01 <= x <= hi + 0.01:
                        downpipe(g, x, gy, gz - 0.07, sgn * W, "galvanised")


def veranda(g, p, v):
    """Glazed veranda on a concrete floor slab: white boarded lower panel, glass between white posts, header beam,
    shed roof in grey sheet metal falling away from the house, front door with steps and its own gutter and downpipe."""
    x0, x1, yw, yf, fl = v["x0"], v["x1"], p["W"], v["yf"], v["floor"]
    hp, n = v["panel"], v["modules"]
    vz = lambda Y: v["rz0"] - v["rs"] * Y                # roof top plane
    vt = 0.08 * math.sqrt(1 + v["rs"] ** 2)
    under = lambda Y: vz(Y) - vt
    g.box(((x0 + x1) / 2, (yw + yf - 0.03) / 2, (fl - 0.6) / 2), (x1 - x0 - 0.06, yf - 0.03 - yw, fl + 0.6), "concrete")   # floor slab; the boarded panels hide its edge
    dx = v["doorX"]
    dw = 0.95
    hdr_t = under(yf) + 0.01
    hdr_b = hdr_t - 0.2
    xs = [x0 + (x1 - x0) * i / n for i in range(n + 1)]
    wall(g, "+y", yf, x0, x1, -0.1, lambda c, m: hp, "nb_white_board", [(dx - dw / 2, dx + dw / 2, fl, hp)])
    for xe, side in ((x0, "-x"), (x1, "+x")):
        wall(g, side, xe, yw, yf, -0.1, lambda c, m: hp, "nb_white_board")
    # glazing: front modules, end panes; each module's glass is set 2 cm behind the posts
    for a, b in zip(xs, xs[1:]):
        if a < dx < b:
            quad(g, [(dx - dw / 2, yf - 0.03, fl + 1.95), (dx + dw / 2, yf - 0.03, fl + 1.95), (dx + dw / 2, yf - 0.03, hdr_b), (dx - dw / 2, yf - 0.03, hdr_b)], (0, 1, 0), "window_dark")
            for lo, hi in ((a, dx - dw / 2), (dx + dw / 2, b)):
                quad(g, [(lo, yf - 0.03, hp), (hi, yf - 0.03, hp), (hi, yf - 0.03, hdr_b), (lo, yf - 0.03, hdr_b)], (0, 1, 0), "window_dark")
        else:
            quad(g, [(a, yf - 0.03, hp), (b, yf - 0.03, hp), (b, yf - 0.03, hdr_b), (a, yf - 0.03, hdr_b)], (0, 1, 0), "window_dark")
            g.box(((a + b) / 2, yf, (hp + hdr_b) / 2 + 0.05), (0.04, 0.05, hdr_b - hp - 0.1 + 0.0), WHITE)   # centre mullion
    for xe, sgn in ((x0, -1), (x1, 1)):
        for ya, yb in ((yw, (yw + yf) / 2), ((yw + yf) / 2, yf)):
            quad(g, [(xe, ya, hp), (xe, yb, hp), (xe, yb, under(yb) - 0.2), (xe, ya, under(ya) - 0.2)], (sgn, 0, 0), "window_dark")
        g.beam((xe, yw, under(yw) - 0.1), (xe, yf, under(yf) - 0.1), 0.12, 0.2, WHITE)
        g.box((xe, (yw + yf) / 2, (hp + under((yw + yf) / 2) - 0.2) / 2 + 0.05), (0.04, 0.05, under((yw + yf) / 2) - 0.2 - hp - 0.1), WHITE)
    for x in xs:
        g.box((x, yf, (fl + hdr_t) / 2), (0.1, 0.11, hdr_t - fl), WHITE)
    for xe in (x0, x1):
        for y in (yw + 0.05, (yw + yf) / 2):
            g.box((xe, y, (fl + under(y)) / 2), (0.1, 0.1, under(y) - fl), WHITE)
    g.box(((x0 + x1) / 2, yf, hdr_t - 0.1), (x1 - x0 + 0.1, 0.13, 0.2), WHITE)       # header beam
    for a, b in zip(xs, xs[1:]):                                                        # sill rail on the panel
        for lo, hi in ((a, b),) if not a < dx < b else ((a, dx - dw / 2), (dx + dw / 2, b)):
            g.box(((lo + hi) / 2, yf, hp + 0.02), (hi - lo, 0.13, 0.06), WHITE)
    # door leaf in the door module (glazed top), threshold and steps
    g.box((dx, yf - 0.03, (fl + 0.02 + fl + 1.95) / 2), (dw - 0.04, 0.05, 1.93), "door_white")
    quad(g, [(dx - 0.26, yf + 0.0, fl + 0.85), (dx + 0.26, yf + 0.0, fl + 0.85), (dx + 0.26, yf + 0.0, fl + 1.8), (dx - 0.26, yf + 0.0, fl + 1.8)], (0, 1, 0), "window_dark")
    for lo, hi, zl, zh in ((-0.28, 0.28, 0.82, 0.88), (-0.28, 0.28, 1.78, 1.84)):
        g.box((dx, yf + 0.005, fl + (zl + zh) / 2), (hi - lo, 0.02, zh - zl), WHITE)
    for sx in (-0.28, 0.28):
        g.box((dx + sx, yf + 0.005, fl + 1.33), (0.06, 0.02, 1.0), WHITE)
    step(g, "+y", yf + 0.03, dx, dw + 0.5, [(0.4, fl - 0.02), (0.75, fl * 0.5 - 0.01)])
    # roof: low shed from the house wall down to the front, grey sheet
    rx0, rx1 = x0 - 0.2, x1 + 0.2
    (ey, ez), _h, _n = kit._roof_slab(g, rx0, rx1, yf, vz(yf), yw, vz(yw), 0.25, 0.08, "nb_roof_grey", WHITE, WHITE, ext_high=0.06)
    gy, gz = gutter(g, rx0 + 0.02, rx1 - 0.02, ey, ez + 0.02, 1)
    downpipe(g, x1 + 0.12, gy, gz - 0.07, yf + 0.05, "galvanised")


# ---------------------------------------------------------------------------------------------
# the five buildings. Lidar fits: ridge = top of the roof planes at the fitted ridge line; tan = fitted slope;
# shift = fitted ridge offset from the OSM rectangle centre along the rectangle's short axis (+ = left of its long axis)
# ---------------------------------------------------------------------------------------------
def ring_ground(ev, r, L, W):
    """Ground: median of the class-2 returns in a 1-4 m ring around the (OSM) rectangle."""
    th = math.radians(r["angleDeg"])
    d = ev.points[:, :2] - [r["cx"], r["cy"]]
    U, V = d @ [math.cos(th), math.sin(th)], d @ [-math.sin(th), math.cos(th)]
    ring = (ev.points[:, 3] == 2) & (abs(U) < L + 4) & (abs(V) < W + 4) & ~((abs(U) < L + 1) & (abs(V) < W + 1))
    return float(np.median(ev.points[ring, 2]))


def place(add, ev, osm, aid, g, shift, shiftU=0.0):
    """Drop the asset on the OSM rectangle moved `shift` m across (onto the fitted ridge) and `shiftU` m along it."""
    r = ev.osm[osm]["properties"]["rect"]
    th = math.radians(r["angleDeg"])
    L, W = r["lengthM"] / 2, r["widthM"] / 2
    e = r["cx"] + shiftU * math.cos(th) - shift * math.sin(th)
    n = r["cy"] + shiftU * math.sin(th) + shift * math.cos(th)
    add(aid, g, e, n, (90 - r["angleDeg"]) % 360, ring_ground(ev, r, L, W))
    return r


def win(at, side, w=1.1, h=1.25, sill=0.95, bars=(2, 1), **k):
    return dict(side=side, at=at, w=w, h=h, sill=sill, bars=bars, **k)


def dr(at, side, w=0.95, h=2.05, sill=0.28, **k):
    return dict(side=side, at=at, w=w, h=h, sill=sill, kind="door", **k)


def build(add, new, ev):
    rect = lambda osm: ev.osm[osm]["properties"]["rect"]
    # --- 963 road house: gabled, 36.4 deg, shed dormer + glazed veranda on the +y (west, track) side, a smaller dormer
    # on the rear; the south barge overhang is ~0.7 m (lidar roof returns 0.8 m past the wall returns)
    r = rect("1431566963")
    p = dict(L=r["lengthM"] / 2, W=r["widthM"] / 2, ph=0.28, ridge=6.354, tan=0.737, tile="roof_tile_orange", govh=0.8,
             chimneys=[-0.8],
             dormers=[dict(side=1, xc=-0.25, wd=4.4, z0=5.886, s=0.2734,
                           windows=[dict(at=-0.25, w=3.9, h=0.72, sill=3.78, bars=(5, 1))], ovf=0.6),
                      dict(side=-1, xc=-0.4, wd=2.2, z0=5.685, s=0.18,
                           windows=[dict(at=-0.4, w=1.3, h=0.8, sill=3.8, bars=(2, 1))])],
             veranda=dict(x0=-1.5, x1=5.75, yf=6.1, floor=0.20, panel=0.95, modules=6, doorX=0.27, rz0=3.305, rs=0.119),
             gutterSpans={1: [(-9, -2.55), (2.0, 9)], -1: [(-9, -1.65), (0.85, 9)]},
             downpipes={1: [-6.4, 6.4], -1: [-6.4, 6.4]},
             openings=[dr(0.27, "+y"), win(2.65, "+y", 1.2, 1.2, 1.0, (3, 1)), win(4.75, "+y", 1.2, 1.2, 1.0, (3, 1)),
                       win(-3.7, "+y", 1.15, 1.3, 0.95),
                       win(-5.1, "-y"), dr(-2.7, "-y"), win(-0.4, "-y"), win(2.2, "-y"), win(4.8, "-y"),
                       win(-1.0, "+x"), win(0.0, "+x", 0.75, 0.95, 4.0, (2, 1)),
                       win(-1.2, "-x"), win(1.3, "-x"), win(0.0, "-x", 0.75, 0.95, 4.0, (2, 1))])
    g = new()
    house(g, p)
    place(add, ev, "1431566963", "omberg_farm_road_house", g, 0.197)

    # --- 964 outbuilding: the OSM polygon is its roof outline (the planes reach it), so the walls are 0.4 m inside it;
    # low grey sheet roof, white door and a window pair on the track side
    r = rect("1431566964")
    p = dict(L=r["lengthM"] / 2 - 0.4, W=r["widthM"] / 2 - 0.39, ph=0.2, ridge=3.568, tan=0.53, tile="nb_roof_grey", ovh=0.39, govh=0.3,
             thick=0.1, downpipes={1: [-3.4], -1: [3.4]},
             openings=[dr(1.5, "+y", 0.9, 1.8), win(-0.7, "+y", 1.0, 0.8, 0.95), win(-2.3, "+y", 1.0, 0.8, 0.95),
                       win(-1.5, "-y", 1.0, 0.8, 0.95), win(1.5, "-y", 1.0, 0.8, 0.95), win(0.0, "+x", 0.7, 0.7, 1.15, (1, 1))])
    g = new()
    house(g, p)
    place(add, ev, "1431566964", "omberg_farm_road_outbuilding", g, 0.262, 0.15)

    # --- 965 field cottage: red walls, brown tile roof, gable (+x) towards the farm track; the roof reaches 0.7 m past
    # the south (-x) wall and 0.3 m past the north one
    r = rect("1431566965")
    p = dict(L=r["lengthM"] / 2, W=r["widthM"] / 2, ph=0.3, ridge=4.237, tan=0.67, tile="nb_tile_brown", ovh=0.4, govh=(0.72, 0.3),
             downpipes={1: [-3.8], -1: [3.8]},
             openings=[win(-1.2, "+x", 0.85, 0.95, 0.9), win(1.2, "+x", 0.85, 0.95, 0.9),
                       dr(0.8, "-x", 0.9, 1.9, 0.3), win(-1.3, "-x", 0.85, 0.95, 0.9),
                       win(-1.0, "+y", 0.85, 0.85, 0.85), win(1.8, "+y", 0.85, 0.85, 0.85), win(0.5, "-y", 0.85, 0.85, 0.85)])
    g = new()
    house(g, p)
    place(add, ev, "1431566965", "omberg_farm_field_cottage", g, -0.43)

    # --- 966 field house: ridge E-W, two shed dormers set back on the roof (main eave runs in front of them), two chimneys
    r = rect("1431566966")
    p = dict(L=r["lengthM"] / 2, W=r["widthM"] / 2, ph=0.35, ridge=6.618, tan=0.70, tile="nb_tile_brown", chimneys=[(-2.12, 0.46, 0.8), (1.77, 0.46, 1.2)], govh=0.5,
             dormers=[dict(side=s, xc=-0.25, wd=2.9, z0=6.10, s=0.18, yw=4.25, ovf=0.65,
                           windows=[win(-0.25 - 0.7, "+y", 0.9, 1.15, 0, (2, 1)), win(-0.25 + 0.7, "+y", 0.9, 1.15, 0, (2, 1))])
                      for s in (1, -1)],
             downpipes={1: [-6.6, 6.6], -1: [-6.6, 6.6]},
             openings=[win(-5.3, "-y"), win(-3.0, "-y"), dr(-0.3, "-y"), win(2.4, "-y"), win(4.8, "-y"),
                       win(-5.3, "+y"), win(-3.0, "+y"), win(2.4, "+y"), win(4.8, "+y"),
                       win(-1.4, "+x"), win(1.4, "+x"), win(0.0, "+x", 0.75, 0.95, 4.0),
                       win(-1.4, "-x"), win(1.4, "-x"), win(0.0, "-x", 0.75, 0.95, 4.0)])
    for d in p["dormers"]:                          # dormer windows sit 0.2 m above the roof surface at the dormer wall
        for o in d["windows"]:
            o["sill"] = zr(p, d["yw"]) + 0.2
    g = new()
    house(g, p)
    place(add, ev, "1431566966", "omberg_farm_field_house", g, -0.2)

    # --- 967 shed
    r = rect("1431566967")
    p = dict(L=r["lengthM"] / 2, W=r["widthM"] / 2, ph=0.2, ridge=3.25, tan=0.58, tile="nb_roof_dark", ovh=0.3, govh=(0.5, 0.33),
             thick=0.1, wall="falu_red_dark_vertical", downpipes={1: [-1.6], -1: [1.6]},
             openings=[dr(0.3, "+y", 0.8, 1.8), win(0.0, "-y", 0.5, 0.5, 1.1, (1, 1))])
    g = new()
    house(g, p)
    place(add, ev, "1431566967", "omberg_farm_field_shed", g, -0.3)
