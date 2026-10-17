"""Yard details of the Omberg greenkeeping yard: the asphalt apron round the maintenance hall, the concrete wash pad
and sand bays (precast L-walls, three heaps) at the hall's north gable, the pink granite edge stones, the tyre
stack, the skip and the parked carts / tilt trailer / utility vehicle.

Survey (2025 ortho, checked against 2023; lidar class 1 for wall tops and heap heights; the Street View photos in
maskinhall/ for forms and colours). Coordinates below are metres from (477000, 6457000) in EPSG:3006 unless named.
The hall (OSM 737322222) is 42 x 17 m with its long axis on bearing 9.55 deg; everything at the north gable is
laid out in that frame, "a" along the gable (east) and "b" along the hall axis (north) from the hall's NE corner.

Assets (omberg_maint_*): yard_asphalt_east / yard_asphalt_west (draped), yard_slab (wash pad + bay apron),
bay_walls (precast walls), sand_heaps, edge_stones_east / edge_stones_west, yard_props (tyres, skip),
yard_vehicles (carts, tilt trailer, utility vehicle).
Everything ground-bound is draped on ev.terrain, the course terrain Unity's ground is, and each asset's origin
sits at ground_abs = ev.terrain there, so dz stays 0.
"""
import math
import random

import bmesh
import numpy as np
from mathutils import Matrix

import props_kit as kit

OFF = (477000.0, 6457000.0)
HALL_NE = (477725.10, 6457938.21)      # hall NE corner (OSM footprint)
AXIS = 9.55                            # bearing of the hall's long axis, deg
EX = (math.sin(math.radians(AXIS + 90)), math.cos(math.radians(AXIS + 90)))   # "a": along the gable
EY = (math.sin(math.radians(AXIS)), math.cos(math.radians(AXIS)))             # "b": along the hall axis
STATS = {}                                                                    # asset -> residuals, printed by build


def en(a, b):
    return (HALL_NE[0] + a * EX[0] + b * EY[0], HALL_NE[1] + a * EX[1] + b * EY[1])


# ---- survey data ---------------------------------------------------------------------------------
# Asphalt apron: the paved ground of the 2025 ortho (traced by hand along the grass edge, the straight yard edge
# and the hall's walls) minus the course's road mesh (surfaces raster classes 9+10, smoothed, shrunk 0.4 m so the
# asphalt overlaps the road edge instead of leaving a grass seam) minus the hall footprint; counter-clockwise.
PAVE_EAST = [
    (713, 958.5), (710.01, 940.69), (708.4, 940.96), (701.42, 899.47), (718.07, 896.71), (718.1, 896.6),
    (717.1, 895.2), (716, 887), (715.3, 883.5), (714.9, 879.2), (714.5, 870.2), (714.4, 864.5), (710.04, 864.5),
    (709.17, 865.53), (708.69, 866.71), (708.45, 866.87), (708.35, 867.23), (707.65, 868.06), (707.15, 869.3),
    (706.16, 870.53), (702.89, 877.07), (702.38, 878.85), (701.62, 880.25), (701.5, 881.06), (701.24, 881.38),
    (701.01, 882.55), (700.74, 882.88), (700.51, 884.05), (700.24, 884.38), (699.99, 886.48), (699.74, 886.88),
    (699.61, 888.03), (699.11, 889.43), (699.1, 890.94), (698.6, 892.44), (698.48, 894.53), (698.1, 895.46),
    (698.1, 897.44), (697.6, 898.96), (697.6, 901.44), (697.1, 902.96), (697.1, 910), (697.48, 910.85),
    (697.6, 913.06), (697.98, 913.86), (698.11, 915.57), (698.48, 916.36), (698.62, 917.61), (698.98, 918.36),
    (699.11, 920.11), (699.48, 920.86), (699.62, 922.11), (699.98, 922.86), (700.12, 924.11), (700.48, 924.86),
    (700.61, 926.57), (700.98, 927.36), (701.12, 928.61), (701.98, 930.84), (702.12, 932.11), (702.6, 933.33),
    (702.61, 934.1), (703.6, 936.82), (703.62, 937.63), (706.48, 945.84), (706.62, 947.13), (707.26, 949.03),
    (708, 950.4), (708.51, 952.16), (709.5, 953.9), (709.75, 955.01), (711.04, 957.71), (711.66, 958.5),
]
PAVE_WEST = [
    (700.6, 864.5), (696.8, 871.2), (694.9, 875.9), (692.4, 881.6), (690.5, 886.6), (689.1, 890.7), (686.7, 900.3),
    (685.3, 905.2), (683.8, 909.6), (683.2, 914), (683.4, 915.8), (689.9, 915.7), (690.2, 926), (690.6, 934.2),
    (691.8, 935.6), (693.75, 937), (695.1, 941.9), (694.7, 944.97), (695.95, 946.9), (695.93, 953.82),
    (699.04, 952.74), (699.3, 952.42), (700.63, 951.68), (701.36, 950.81), (702.27, 948.29), (702.26, 946.77),
    (701.28, 944.18), (701.25, 943.61), (700.78, 942.66), (700.76, 942.13), (700.5, 941.81), (700.26, 940.27),
    (699.28, 937.68), (699.26, 937.13), (699.01, 936.82), (698.88, 935.76), (698.28, 934.18), (698.24, 933.6),
    (698.01, 933.32), (697.89, 932.29), (697.52, 931.4), (697.39, 930.29), (697.02, 929.4), (696.88, 928.26),
    (695.9, 924.93), (695.77, 923.3), (695.51, 922.86), (695.38, 921.76), (694.4, 918.44), (694.39, 917.41),
    (693.9, 915.92), (693.77, 914.3), (693.4, 913.41), (693.27, 910.82), (692.9, 909.92), (692.9, 902.56),
    (693.4, 900.91), (693.4, 898.56), (693.89, 896.95), (693.9, 895.08), (694.27, 894.18), (694.4, 892.09),
    (694.77, 891.2), (694.89, 889.6), (695.27, 888.7), (695.39, 887.1), (695.77, 886.2), (695.89, 884.59),
    (696.39, 883.23), (696.4, 882.44), (697.49, 879.17), (698.13, 878.14), (698.5, 876.64), (702.61, 868.68),
    (702.74, 867.82), (702.9, 867.55), (702.77, 865.56), (702.26, 864.5),
]

# Bays (hall frame, a/b metres): back wall centre a = -0.8; partition walls at b = 5.7, 9.75, 13.8, 17.85 (lidar
# wall tops at b 5.7 / 9.65 / 13.6 / 17.85, a pitch of 4 m), running from the back wall out to a = -9.5.
BACK_A = -0.8
WALLS_B = [5.7, 9.75, 13.8, 17.85]
FRONT_A = -9.5
SLAB = (-15.3, -0.55, 0.05, 18.0)        # a0, a1, b0, b1: light concrete in the ortho, left edge straight on a = -15.3
SLAB_CAP = 103.30                        # the terrain bumps up under the heaps (lidar ground = heap): the slab stays level there
SLAB_LIFT = 0.055                        # slab top over the terrain; asphalt is 0.04 so the slab edge reads as a 1.5 cm kerb
ASPHALT_LIFT = 0.04
PART_TOP = 104.90                        # wall tops, lidar class 1 (104.85..104.99 on all four partitions)
BACK_TOP = 104.95
LOW_TOP = 104.35                         # the back wall is low (tyres stand against it) from the hall to the first bay: photo 3

# Edge stones (offsets from OFF): the dark spots in the ortho (stone shadows, 4.5-6 m apart); the east row starts at
# the hall's SE gable corner. The stones stand 0.2-0.4 m outside the asphalt edge on the lawn.
STONES_EAST = [(717.0, 894.85), (716.3, 889.55), (715.65, 883.55), (714.85, 877.85), (714.15, 872.55)]
STONES_WEST = [(684.75, 905.8), (686.1, 901.4), (687.5, 897.2), (689.0, 891.4), (690.7, 886.15), (692.65, 880.75),
               (694.7, 875.75), (698.4, 869.0), (700.4, 864.9)]
SIGN_AT = (714.15, 872.55)               # the black sign plate on a thin post stands by the southernmost east stone: photo 1


# ---- frames ----------------------------------------------------------------------------------------
class Frame:
    """Asset-local frame centred at (e, n) on the course terrain, +x on compass bearing `yaw`, +y to its left, z up
    from the terrain there (z0 = ground_abs)."""

    def __init__(self, ev, e, n, yaw):
        self.ev, self.e, self.n, self.yaw = ev, round(e, 2), round(n, 2), yaw
        self.s, self.c = math.sin(math.radians(yaw)), math.cos(math.radians(yaw))
        self.z0 = ev.terrain(self.e, self.n)

    def world(self, x, y):
        return self.e + x * self.s - y * self.c, self.n + x * self.c + y * self.s

    def local(self, e, n):
        return (e - self.e) * self.s + (n - self.n) * self.c, -(e - self.e) * self.c + (n - self.n) * self.s

    def ground(self, x, y):
        return self.ev.terrain(*self.world(x, y)) - self.z0

    def up(self, z_abs):
        return z_abs - self.z0

    def smooth(self, x, y):
        """Terrain smoothed (see smooth_terrain), asset-local height."""
        return smooth_terrain(self.ev, *self.world(x, y)) - self.z0


def smooth_terrain(ev, e, n, r=1.0):
    """Terrain averaged over a 3 x 3 stencil of spacing r (m), absolute z. The DEM carries +-2-3 cm lidar noise that a flat-shaded
    pavement on a 1 m grid shows as a patchwork of light and dark facets; paving follows this and carries a lift that covers
    the difference (the STATS residuals show what is left)."""
    t = 2.0 * ev.terrain(e, n)
    for dx, dy in ((r, 0), (-r, 0), (0, r), (0, -r), (r, r), (-r, r), (r, -r), (-r, -r)):
        t += ev.terrain(e + dx, n + dy)
    return max(t / 10.0, ev.terrain(e, n) + 0.008)        # never under the terrain at a vertex: peaks are followed, hollows bridged


def world_frame(ev, pts):
    es = [p[0] for p in pts]
    ns = [p[1] for p in pts]
    return Frame(ev, OFF[0] + (min(es) + max(es)) / 2, OFF[1] + (min(ns) + max(ns)) / 2, 90.0)


def hall_frame(ev, a0, b0):
    e, n = en(a0, b0)
    F = Frame(ev, e, n, AXIS + 90.0)         # local x = a - a0, y = b - b0
    F.a0, F.b0 = a0, b0
    return F


# ---- textures (generated like the kit's; every tile is square so the metres stay honest) -------------
def _rgb(c):
    return np.array([int(v) for v in c.split(",")], float) / 255.0


def _tex_yardasphalt(self, color="74,74,73"):
    """Old asphalt: 4 m tile, fine aggregate, soft tonal patches (patched strips, tyre polish), no markings."""
    S = self.size
    g = kit._fbm((S, S), 211, scales=(256, 96, 24))
    grit = kit._noise((S, S), 213, 2) * 0.6 + kit._rng(214).random((S, S)) * 0.4
    chips = (kit._rng(215).random((S, S)) > 0.985) * 0.18          # a few pale stones in the binder
    v = 0.80 + 0.34 * g + 0.16 * (grit - 0.5) + chips
    return _rgb(color) * v[:, :, None], grit, 1.2


def _tex_slab(self, color="132,128,120"):
    """Wash-pad concrete, 4 m tile: broom-smooth, damp darker patches and a saw cut on the tile's west and south
    edges (so the slab shows a 4 m joint grid)."""
    S = self.size
    g = kit._fbm((S, S), 221, scales=(256, 64, 16))
    wet = np.clip((kit._fbm((S, S), 222, scales=(384, 128)) - 0.52) * 5, 0, 1)
    grain = kit._rng(223).random((S, S))
    v = 0.9 + 0.22 * (g - 0.5) + 0.05 * (grain - 0.5) - 0.12 * wet
    y, x = np.mgrid[0:S, 0:S]
    joint = (x < 6) | (y < 6)
    v = np.where(joint, 0.42, v)
    return _rgb(color)[None, None, :] * v[:, :, None], np.where(joint, 0.0, 0.8 + 0.2 * g), 1.5


def _tex_precast(self, color="138,136,130", joints="1"):
    """Weathered precast concrete panel: ONE texture = ONE panel (the mesh maps u 0..1 over each panel), pores, vertical
    rain streaks, a darker damp foot and, with joints=1, the dark vertical joints on both panel edges."""
    S = self.size
    g = kit._fbm((S, S), 231, scales=(256, 64, 16, 4))
    streak = np.repeat(kit._fbm((S // 16, S), 232, scales=(6, 24)), 16, 0)[:S, :]       # constant down the panel, varying across
    pores = (kit._rng(233).random((S, S)) > 0.992) * 0.25
    ramp = np.linspace(1.0, 0.78, S)[:, None]                       # image rows run top -> bottom
    v = (0.86 + 0.2 * (g - 0.5) - 0.2 * np.clip(streak - 0.45, 0, 1)) * ramp - pores
    h = 0.8 + 0.2 * g
    if joints == "1":
        x = np.arange(S)[None, :]
        j = (x < 5) | (x > S - 6)
        v = np.where(j, 0.4, v)
        h = np.where(j, 0.0, h)
    return _rgb(color)[None, None, :] * v[:, :, None], h, 2.5


def _tex_sand(self, color="128,108,84", coarse="0"):
    """Sand heap, 2 m tile: fine grain, faint rills; coarse=1 adds clods (soil)."""
    S = self.size
    r = kit._rng(241 + int(coarse))
    grain = r.random((S, S))
    g = kit._fbm((S, S), 243, scales=(128, 32, 8))
    rill = 0.5 + 0.5 * np.sin(np.arange(S)[None, :] * 0.11 + 6 * g)
    v = 0.9 + 0.18 * (g - 0.5) + 0.06 * (rill - 0.5) + 0.12 * (grain - 0.5)
    h = grain * 0.4 + g * 0.6
    if coarse == "1":
        clods = np.clip((kit._fbm((S, S), 244, scales=(24, 8, 3)) - 0.55) * 5, 0, 1)
        v = v * (1 - 0.35 * clods) * (0.9 + 0.2 * kit._noise((S, S), 245, 3))
        h = h + clods
    return _rgb(color)[None, None, :] * v[:, :, None], h, 3.0


def register_materials():
    kit.TextureBank.tex_yardasphalt = _tex_yardasphalt
    kit.TextureBank.tex_slab = _tex_slab
    kit.TextureBank.tex_precast = _tex_precast
    kit.TextureBank.tex_sand = _tex_sand
    kit.MATERIALS.update({
        # albedo is the ortho / photo colour divided by ~1.7: the course scene lights sunlit faces at 1.7x
        "yard_asphalt": ("yardasphalt:70,70,69", (4.0, 4.0), None, 0.08, 0.0),
        "yard_slab": ("slab:128,124,116", (4.0, 4.0), None, 0.3, 0.0),
        "precast": ("precast:130,128,122:1", (2.0, 2.0), None, 0.05, 0.0),
        "precast_cap": ("precast:130,128,122:0", (2.0, 2.0), None, 0.05, 0.0),
        "sand_beige": ("sand:132,112,88", (2.0, 2.0), None, 0.02, 0.0),
        "sand_brown": ("sand:86,66,50:1", (2.0, 2.0), None, 0.02, 0.0),
        # split pink-red granite posts (photos 5, 6): crystalline, warm; the kit's granite generator, no lichen
        "yard_granite_pink": ("granite:122,92,88:0.15", (1.5, 1.5), None, 0.12, 0.0),
        "yard_rust": (None, (1, 1), (104, 66, 48), 0.15, 0.3),
        "cart_green": (None, (1, 1), (30, 96, 56), 0.55, 0.1),
        "cart_beige": (None, (1, 1), (168, 154, 124), 0.25, 0.0),
        "deere_green": (None, (1, 1), (44, 118, 52), 0.55, 0.1),
        "deere_yellow": (None, (1, 1), (216, 184, 36), 0.45, 0.1),
        "alu_deck": (None, (1, 1), (138, 140, 142), 0.45, 0.6),
    })


MATTE = {"yard_asphalt", "precast", "precast_cap", "sand_beige", "sand_brown", "yard_granite_pink"}


# ---- surfaces ----------------------------------------------------------------------------------------
def orient(poly):
    a = sum(p[0] * q[1] - q[0] * p[1] for p, q in zip(poly, poly[1:] + poly[:1]))
    return poly if a > 0 else poly[::-1]


def fill(poly, step):
    """Triangles of a counter-clockwise polygon cut by a step-metre grid (so a surface laid on it can follow the
    ground), and its boundary edges as CCW (a, b) pairs."""
    bm = bmesh.new()
    bm.faces.new([bm.verts.new((x, y, 0)) for x, y in poly])
    xs = [p[0] for p in poly]
    ys = [p[1] for p in poly]
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


def surface(g, F, poly, mat, zfn, step=1.5, skirt=0.12, name=None):
    """A thin paving laid on the ground: grid-cut fill at zfn(x, y) and a skirt going `skirt` m under the terrain round the
    rim. Records the residual of every triangle's plane against the terrain (at its centroid) in STATS[name]."""
    tris, edges = fill(orient(poly), step)
    res = STATS.setdefault(name or mat, [9e9, -9e9, 0])
    for t in tris:
        pts = [(x, y, zfn(x, y)) for x, y in t]
        g.poly(pts, mat)
        cx, cy = sum(p[0] for p in t) / 3, sum(p[1] for p in t) / 3
        r = sum(p[2] for p in pts) / 3 - F.ground(cx, cy)
        res[0], res[1], res[2] = min(res[0], r), max(res[1], r), res[2] + 1
    for a, b in edges:
        g.poly([(*a, F.ground(*a) - skirt), (*b, F.ground(*b) - skirt), (*b, zfn(*b)), (*a, zfn(*a))], mat)


# ---- walls ---------------------------------------------------------------------------------------------
def wall(g, p0, p1, z_bot, z_top, t_bot, t_top, panels, mat="precast", cap="precast_cap"):
    """Straight precast wall from p0 to p1 (local x, y), centre line, tapering from t_bot to t_top thick, as `panels`
    equal panels (the face texture is one panel wide, so its joints are the panel joints). Faces wound outward;
    the foot is open (it stands inside the slab)."""
    L = math.dist(p0, p1)
    d = ((p1[0] - p0[0]) / L, (p1[1] - p0[1]) / L)
    n = (-d[1], d[0])
    H = z_top - z_bot
    tb, tt = t_bot / 2, t_top / 2
    tu = kit.MATERIALS[mat][1][0]

    def P(s, side, top):
        h = tt if top else tb
        return (p0[0] + d[0] * s + n[0] * h * side, p0[1] + d[1] * s + n[1] * h * side, z_top if top else z_bot)

    for k in range(panels):
        s0, s1 = L * k / panels, L * (k + 1) / panels
        g.poly([P(s1, 1, 0), P(s0, 1, 0), P(s0, 1, 1), P(s1, 1, 1)], mat, uv=("uv", [(tu, 0), (0, 0), (0, H), (tu, H)]))
        g.poly([P(s0, -1, 0), P(s1, -1, 0), P(s1, -1, 1), P(s0, -1, 1)], mat, uv=("uv", [(0, 0), (tu, 0), (tu, H), (0, H)]))
    g.poly([P(0, -1, 0), P(0, -1, 1), P(0, 1, 1), P(0, 1, 0)], cap)
    g.poly([P(L, -1, 0), P(L, 1, 0), P(L, 1, 1), P(L, -1, 1)], cap)
    g.poly([P(0, -1, 1), P(L, -1, 1), P(L, 1, 1), P(0, 1, 1)], cap)


# ---- sand heaps -----------------------------------------------------------------------------------------
def _cone(c, a, b):
    """Heap lobe: a ridge along a (from a_lo to a_hi) with a rounded crest, falling away at tangent `sf` toward the open
    front, `sbk` to the back and `sb` across; R0 rounds the crest. Sand lies at 30-34 deg (tan .6-.67) when poured, a bit
    less where it was pushed with a loader: the sides stay under .6."""
    if a < c["a_lo"]:
        da, s = c["a_lo"] - a, c["sf"]
    elif a > c["a_hi"]:
        da, s = a - c["a_hi"], c["sbk"]
    else:
        da, s = 0.0, 0.0
    q = math.hypot(s * da, c["sb"] * (b - c["bc"]))
    return c["H"] - (math.sqrt(c["R0"] ** 2 + q * q) - c["R0"])


def heap(g, F, mat, cones, a_rng, b_rng, step, lumps, seed):
    """Heightfield heap on the slab: z = slab + h - 2 cm, so the toe (h < 2 cm) hides under the slab and the heap needs no skirt.
    Lumps (sines, faded out toward the toe) keep it from being a cone; the domain runs 5 cm into the walls on both sides."""
    rnd = random.Random(seed)
    ph = [rnd.uniform(0, 6.28) for _ in range(6)]
    na, nb = int(round((a_rng[1] - a_rng[0]) / step)), int(round((b_rng[1] - b_rng[0]) / step))
    A = [a_rng[0] + (a_rng[1] - a_rng[0]) * i / na for i in range(na + 1)]
    B = [b_rng[0] + (b_rng[1] - b_rng[0]) * j / nb for j in range(nb + 1)]
    zs, hs = {}, {}
    for i, a in enumerate(A):
        for j, b in enumerate(B):
            h = max(_cone(c, a, b) for c in cones)
            fade = min(1.0, max(0.0, h / 0.3))
            h += fade * lumps * (0.6 * math.sin(2.1 * a + ph[0]) * math.cos(1.7 * b + ph[1])
                                 + 0.4 * math.sin(3.9 * a + 1.3 * b + ph[2]) + 0.25 * math.sin(7.3 * b - 2.9 * a + ph[3]))
            h = max(h, 0.0)
            x, y = a - F.a0, b - F.b0
            hs[i, j] = h
            zs[i, j] = (x, y, F.up(slab_abs(F.ev, *F.world(x, y))) + h - 0.02)
    for i in range(na):
        for j in range(nb):
            if max(hs[i, j], hs[i + 1, j], hs[i + 1, j + 1], hs[i, j + 1]) < 0.02:
                continue
            g.poly([zs[i, j], zs[i + 1, j], zs[i + 1, j + 1], zs[i, j + 1]], mat)


def slab_abs(ev, e, n):
    """Top of the concrete (absolute RH2000) at world (e, n): terrain + 4.5 cm, capped where the lidar ground is the heap."""
    t = smooth_terrain(ev, e, n)
    return min(t, SLAB_CAP) + SLAB_LIFT


# ---- small things ---------------------------------------------------------------------------------------
def edge_stone(g, rnd, x, y, z, yaw):
    """A split granite post: ~0.3 x 0.3 m, 0.45-0.56 m above ground, sunk 6 cm. Four rings (foot, belly, shoulder, chamfered
    top) with jittered corners and a tilted, slightly stepped split top: irregular but a clear block, as in photos 5-6."""
    h = rnd.uniform(0.45, 0.56)
    w1, w2 = rnd.uniform(0.28, 0.37), rnd.uniform(0.25, 0.32)
    c, s = math.cos(math.radians(yaw)), math.sin(math.radians(yaw))
    tx, ty = rnd.uniform(-0.12, 0.12), rnd.uniform(-0.12, 0.12)   # top plane slope

    def ring(inset, dz, jit, tilt=False):
        out = []
        for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
            px = sx * (w1 / 2 - inset) + rnd.uniform(-jit, jit)
            py = sy * (w2 / 2 - inset) + rnd.uniform(-jit, jit)
            zz = z + dz + (tx * px + ty * py + rnd.uniform(-0.012, 0.012) if tilt else 0.0)
            out.append((x + c * px - s * py, y + s * px + c * py, zz))
        return out

    rings = [ring(0.0, -0.06, 0.01), ring(-0.012, h * 0.45, 0.018), ring(0.008, h - 0.07, 0.015, True), ring(0.04, h - 0.005, 0.01, True)]
    for r0, r1 in zip(rings, rings[1:]):
        for i in range(4):
            j = (i + 1) % 4
            g.poly([r0[i], r0[j], r1[j], r1[i]], "yard_granite_pink")
    t = rings[3]
    g.poly([t[0], t[1], t[2]], "yard_granite_pink")
    g.poly([t[0], t[2], t[3]], "yard_granite_pink")


def tyre(g, x, y, z, seg=12):
    """A black tyre lying flat (0.74 m over, 0.24 m wide), lathe of a six-point section."""
    prof = [(0.21, 0.0), (0.32, 0.0), (0.37, 0.12), (0.32, 0.24), (0.21, 0.24), (0.19, 0.12)]
    for i in range(len(prof)):
        p, q = prof[i], prof[(i + 1) % len(prof)]
        for j in range(seg):
            a0, a1 = 2 * math.pi * j / seg, 2 * math.pi * (j + 1) / seg
            V = lambda pr, a: (x + pr[0] * math.cos(a), y + pr[0] * math.sin(a), z + pr[1])
            g.poly([V(p, a0), V(p, a1), V(q, a1), V(q, a0)], "tyre")


def skip(g, x, y, z, yaw, L=2.8, W=1.8, H=1.0):
    """Open steel skip: tapered box, 6 cm rim, rust brown. Local x along L."""
    c, s = math.cos(math.radians(yaw)), math.sin(math.radians(yaw))
    R = lambda px, py, zz: (x + c * px - s * py, y + s * px + c * py, zz)
    k = 0.2                                   # the foot is 20 cm narrower on every side
    o_top = [(-L / 2, -W / 2), (L / 2, -W / 2), (L / 2, W / 2), (-L / 2, W / 2)]
    o_bot = [(px * (1 - 2 * k / L), py * (1 - 2 * k / W)) for px, py in o_top]
    i_top = [(px * (1 - 0.1 / (L / 2)), py * (1 - 0.1 / (W / 2))) for px, py in o_top]
    i_bot = [(px * (1 - (2 * k + 0.2) / L), py * (1 - (2 * k + 0.2) / W)) for px, py in o_top]
    for i in range(4):
        j = (i + 1) % 4
        g.poly([R(*o_bot[i], z), R(*o_bot[j], z), R(*o_top[j], z + H), R(*o_top[i], z + H)], "yard_rust")        # outside
        g.poly([R(*o_top[i], z + H), R(*o_top[j], z + H), R(*i_top[j], z + H), R(*i_top[i], z + H)], "yard_rust")  # rim
        g.poly([R(*i_top[j], z + H), R(*i_bot[j], z + 0.1), R(*i_bot[i], z + 0.1), R(*i_top[i], z + H)], "yard_rust")  # inside
    g.poly([R(*p, z + 0.1) for p in i_bot], "yard_rust")


# ---- vehicles ---------------------------------------------------------------------------------------------
def prism_xz(g, pts, y0, y1, mat):
    """Profile in the x-z plane (counter-clockwise seen from +y... i.e. from the left) extruded from y0 to y1."""
    n = len(pts)
    for i in range(n):
        a, b = pts[i], pts[(i + 1) % n]
        g.poly([(a[0], y0, a[1]), (a[0], y1, a[1]), (b[0], y1, b[1]), (b[0], y0, b[1])], mat)
    g.poly([(p[0], y1, p[1]) for p in pts][::-1], mat)
    g.poly([(p[0], y0, p[1]) for p in pts], mat)


def wheel(g, x, y, z, r, w, hub="galvanised"):
    g.push(Matrix.Translation((x, y, z)) @ Matrix.Rotation(math.pi / 2, 4, "X"))
    g.cylinder((0, 0, -w / 2), r, w, "tyre", seg=10)
    g.cylinder((0, 0, -w / 2 - 0.005), r * 0.55, w + 0.01, hub, seg=10)
    g.pop()


def cart(g):
    """Electric golf cart, 2.4 x 1.2 m: +x forward, wheels' underside at z = 0. Green body, beige roof on four posts
    (photo 1: E-Z-GO style)."""
    G = "cart_green"
    g.box((0, 0, 0.20), (2.2, 0.95, 0.08), "paint_black")
    g.box((-0.72, 0, 0.44), (0.85, 1.12, 0.46), G)                                  # rear deck / battery box
    prism_xz(g, [(0.34, 0.2), (1.22, 0.2), (1.24, 0.45), (1.05, 0.62), (0.62, 0.80), (0.34, 0.78)], -0.56, 0.56, G)   # cowl
    g.box((0.0, 0, 0.52), (0.62, 1.0, 0.12), "rubber_black")                         # seat
    g.box((-0.36, 0, 0.82), (0.12, 1.0, 0.46), "rubber_black")                       # backrest
    g.box((-0.1, 0, 1.80), (1.95, 1.2, 0.05), "cart_beige")                          # roof
    for x in (0.82, -0.95):
        for y in (-0.55, 0.55):
            g.box((x, y, 1.27), (0.05, 0.05, 1.07), "paint_black")
    g.box((0.84, 0, 1.12), (0.03, 1.08, 0.5), "car_glass")                            # windscreen
    for x in (0.76, -0.76):
        for y in (-0.56, 0.56):
            wheel(g, x, y, 0.23, 0.23, 0.16)


def utility_vehicle(g):
    """John Deere Gator style utility vehicle, 3.0 x 1.55 m: +x forward. Green, dark ROPS roof, black cargo bed."""
    G = "deere_green"
    g.box((0.2, 0, 0.42), (2.4, 1.2, 0.2), "paint_black")                            # chassis
    prism_xz(g, [(0.45, 0.45), (1.5, 0.45), (1.52, 0.72), (1.2, 0.9), (0.6, 0.95), (0.45, 0.9)], -0.7, 0.7, G)           # hood
    g.box((0.0, 0, 0.62), (0.9, 1.3, 0.28), G)                                       # cab floor / seat base
    g.box((-0.3, 0, 0.98), (0.14, 1.2, 0.55), "rubber_black")                        # seat back
    g.box((0.05, 0, 0.78), (0.6, 1.2, 0.12), "rubber_black")
    for x in (0.55, -0.45):
        for y in (-0.66, 0.66):
            g.box((x, y, 1.45), (0.06, 0.06, 1.0), "paint_black")
    g.box((0.05, 0, 1.97), (1.35, 1.45, 0.06), "paint_black")                        # roof
    g.box((-1.0, 0, 0.62), (1.2, 1.5, 0.06), "paint_black")                          # cargo floor
    for s in (-1, 1):
        g.box((-1.0, s * 0.75, 0.82), (1.2, 0.05, 0.35), "paint_black")
    g.box((-1.6, 0, 0.82), (0.05, 1.5, 0.35), "paint_black")
    g.box((-0.45, 0, 0.82), (0.05, 1.5, 0.35), "paint_black")
    for x in (1.0, -1.05):
        for y in (-0.7, 0.7):
            wheel(g, x, y, 0.32, 0.32, 0.22, "deere_yellow")


def tilt_trailer(g, with_carts=True):
    """Car trailer with a tilting alu bed, 5.2 x 2.1 m, raised 9 deg (loading position, photo 1) carrying two carts.
    +x = drawbar end; z = 0 at the ground under the wheels."""
    th = math.radians(9.0)
    for y in (-1.15, 1.15):
        wheel(g, 0.0, y, 0.30, 0.30, 0.2)
        g.box((0.0, y * 0.9, 0.66), (0.9, 0.3, 0.04), "alu_deck")                    # mudguard
    g.beam((0.0, -1.0, 0.45), (0.0, 1.0, 0.45), 0.08, 0.08, "black_steel")           # axle
    g.beam((1.0, 0, 0.45), (3.6, 0, 0.55), 0.12, 0.1, "black_steel")                # drawbar
    g.push(Matrix.Translation((0, 0, 0.62)) @ Matrix.Rotation(-th, 4, "Y"))
    g.box((-0.4, 0, 0), (5.2, 2.1, 0.08), "alu_deck")                                # bed
    for y in (-0.6, 0.6):
        g.box((-0.3, y, -0.1), (5.0, 0.1, 0.12), "black_steel")                      # rails under
    for y in (-1.05, 1.05):
        g.box((-0.4, y, 0.07), (5.2, 0.05, 0.1), "alu_deck")                         # side rails
    g.box((2.15, 0, 0.18), (0.06, 2.1, 0.3), "alu_deck")                             # head board
    if with_carts:
        for x in (-1.45, 1.05):
            g.push(Matrix.Translation((x, 0, 0.04)))
            cart(g)
            g.pop()
    g.pop()


# ---- build ---------------------------------------------------------------------------------------------
def build_asphalt(add, new, ev, name, poly_off):
    F = world_frame(ev, poly_off)
    g = new()
    g.category = "structure"
    poly = [(OFF[0] + e - F.e, OFF[1] + n - F.n) for e, n in poly_off]
    surface(g, F, poly, "yard_asphalt", lambda x, y: F.smooth(x, y) + ASPHALT_LIFT, step=1.0, skirt=0.12, name=name)
    add("omberg_maint_" + name, g, F.e, F.n, 90.0, F.z0)


def build_bays(add, new, ev):
    F = hall_frame(ev, -7.5, 9.0)
    a0, a1, b0, b1 = SLAB

    def L(a, b):
        return (a - F.a0, b - F.b0)

    # concrete: wash pad (b 0..5.7) and the apron of the three bays, one slab with a 4 m saw-cut grid in its texture
    g = new()
    g.category = "structure"
    surface(g, F, [L(a0, b0), L(a1, b0), L(a1, b1), L(a0, b1)], "yard_slab",
            lambda x, y: F.up(slab_abs(ev, *F.world(x, y))), step=1.5, skirt=0.12, name="yard_slab")
    add("omberg_maint_yard_slab", g, F.e, F.n, F.yaw, F.z0)

    # precast walls: foot 20 cm under the lowest ground along the wall, tops level at the lidar height
    g = new()
    g.category = "structure"

    def foot(p, q):
        return F.up(min(ev.terrain(*F.world(*L(p[0] + (q[0] - p[0]) * t / 8, p[1] + (q[1] - p[1]) * t / 8))) for t in range(9)) - 0.2)

    for bw in WALLS_B:                                   # partitions, 8.6 m = 4 panels of 2.15 m
        p, q = L(BACK_A + 0.05, bw), L(FRONT_A, bw)
        wall(g, p, q, foot(p, q), F.up(PART_TOP), 0.30, 0.20, 4)
    p, q = L(BACK_A, b0 + 0.05), L(BACK_A, WALLS_B[0])   # low back wall behind the wash pad (tyres), 3 panels
    wall(g, p, q, foot(p, q), F.up(LOW_TOP), 0.35, 0.24, 3)
    p, q = L(BACK_A, WALLS_B[0]), L(BACK_A, WALLS_B[-1] + 0.15)   # high back wall behind the bays, 6 panels of 2.1 m
    wall(g, p, q, foot(p, q), F.up(BACK_TOP), 0.35, 0.24, 6)
    add("omberg_maint_bay_walls", g, F.e, F.n, F.yaw, F.z0)

    # heaps: beige top-dressing sand (big, south bay), beige sand (middle), coarse brown soil (north, lower)
    g = new()
    g.category = "structure"
    inner = BACK_A - 0.175 + 0.05
    C = [dict(H=1.78, a_lo=-4.4, a_hi=-1.3, bc=7.85, sf=0.40, sbk=0.9, sb=0.55, R0=0.7),
         dict(H=0.50, a_lo=-6.9, a_hi=-5.2, bc=7.55, sf=0.30, sbk=0.9, sb=0.50, R0=0.4)]   # the tongue spilling out front
    B = [dict(H=1.40, a_lo=-3.6, a_hi=-1.3, bc=11.95, sf=0.42, sbk=0.9, sb=0.55, R0=0.6)]
    A = [dict(H=0.85, a_lo=-2.9, a_hi=-1.4, bc=15.6, sf=0.50, sbk=0.9, sb=0.75, R0=0.4)]
    for cones, bays, mat, step, lumps, seed in ((C, 0, "sand_beige", 0.25, 0.035, 3), (B, 1, "sand_beige", 0.25, 0.03, 5),
                                                (A, 2, "sand_brown", 0.25, 0.07, 9)):
        heap(g, F, mat, cones, (FRONT_A - 0.2, inner), (WALLS_B[bays] + 0.10, WALLS_B[bays + 1] - 0.10), step, lumps, seed)
    add("omberg_maint_sand_heaps", g, F.e, F.n, F.yaw, F.z0)

    # props: five stacks of tyres against the low wall, the skip beyond the bays (2025 ortho: a 2.8 x 1.8 m frame)
    g = new()
    g.category = "prop"
    rnd = random.Random(12)
    for k in range(5):
        a, b = BACK_A - 0.175 - 0.37, 0.95 + 0.9 * k
        x, y = L(a, b)
        n = rnd.choice((3, 4, 4, 5))
        for i in range(n):
            xx, yy = x + rnd.uniform(-0.03, 0.03), y + rnd.uniform(-0.03, 0.03)
            tyre(g, xx, yy, F.up(slab_abs(ev, *F.world(x, y))) + 0.24 * i)
    sx, sy = L(-7.6, 22.3)
    zs = max(F.ground(sx + dx, sy + dy) for dx in (-1.4, 1.4) for dy in (-0.9, 0.9))
    skip(g, sx, sy, zs - 0.05, 90.0)
    add("omberg_maint_yard_props", g, F.e, F.n, F.yaw, F.z0)


def build_stones(add, new, ev, name, pts, with_sign):
    F = world_frame(ev, pts)
    g = new()
    g.category = "structure"
    rnd = random.Random(len(pts) * 7 + 1)
    for (e, n) in pts:
        x, y = F.local(OFF[0] + e, OFF[1] + n)
        # aligned to the yard edge within +-12 deg: the posts stand square to it
        edge = 345.0 if e < 700 else 180.0 + 6.0
        yaw = 90.0 - edge + rnd.uniform(-12, 12)
        edge_stone(g, rnd, x, y, F.ground(x, y), yaw)
    if with_sign:                                          # a thin post with a small black plate, facing the yard (west)
        x, y = F.local(OFF[0] + SIGN_AT[0] + 0.55, OFF[1] + SIGN_AT[1] + 0.25)
        z = F.ground(x, y)
        g.cylinder((x, y, z - 0.1), 0.012, 0.85, "black_steel", seg=6)
        g.push(Matrix.Translation((x - 0.03, y, z + 0.78)) @ Matrix.Rotation(math.radians(-12), 4, "Y"))
        g.box((0, 0, 0), (0.03, 0.26, 0.2), "sign_black")
        g.pop()
    add("omberg_maint_" + name, g, F.e, F.n, 90.0, F.z0)


def build_vehicles(add, new, ev):
    """Parked on the west apron beside the cabin as in photo 1: a tilt trailer carrying two carts, two more carts and the
    utility vehicle. INFERRED positions (vehicles move; the 2025 ortho shows none here)."""
    pts = [(688.0, 906.0), (691.0, 903.2), (691.3, 907.5), (691.2, 912.0)]
    F = world_frame(ev, pts)
    g = new()
    g.category = "prop"

    def put(e, n, bearing, fn):
        x, y = F.local(OFF[0] + e, OFF[1] + n)
        g.push(Matrix.Translation((x, y, F.ground(x, y) + ASPHALT_LIFT)) @ Matrix.Rotation(math.radians(90.0 - bearing), 4, "Z"))
        fn(g)
        g.pop()

    put(688.0, 906.0, 345.0, tilt_trailer)
    put(691.0, 903.2, 345.0, cart)
    put(691.3, 907.5, 350.0, cart)
    put(691.2, 912.2, 340.0, utility_vehicle)
    add("omberg_maint_yard_vehicles", g, F.e, F.n, 90.0, F.z0)


def build(add, new, ev):
    STATS.clear()
    build_asphalt(add, new, ev, "yard_asphalt_east", PAVE_EAST)
    build_asphalt(add, new, ev, "yard_asphalt_west", PAVE_WEST)
    build_bays(add, new, ev)
    build_stones(add, new, ev, "edge_stones_east", STONES_EAST, True)
    build_stones(add, new, ev, "edge_stones_west", STONES_WEST, False)
    build_vehicles(add, new, ev)
    for k, (lo, hi, n) in STATS.items():
        print("residual %s: surface - terrain %.3f .. %.3f m over %d triangles" % (k, lo, hi, n), flush=True)
