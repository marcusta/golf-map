"""The farmyard north of the machine hall: three containers, a white crate, a barrel and a bundle of pipes.

Only what the 2025 ortho shows clearly and the lidar confirms (heights = class 1 returns above the edited DEM); the
scrap, tarps, heaps, the dark machine and the many small tanks stay in the ground photo. Positions (EPSG:3006,
ortho 2025 box centres, lean corrected by the lidar) and sizes:
  rust container   E 478004.6 N 6458158.3, 6.06 x 2.44 m, top 2.62 m (lidar 2.60-2.69), long axis bearing 188
  blue box A       E 478000.1 N 6458157.7, 4.0 x 2.1 m, top 1.7 m (lidar 1.65-1.75), long axis 92
  blue box B       E 478000.7 N 6458154.3, 2.6 x 2.9 m, top 2.3 m (lidar 2.16-2.40)
  white crate      E 477991.5 N 6458147.2, 1.4 x 1.3 m, top 1.7 m (lidar 1.77)
  barrel           E 477992.6 N 6458149.0, 0.95 m across, top 1.2 m (lidar 1.16-1.35), yellow
  pipe bundle      E 477997.0 N 6458145.6, 6.5 m long on bearing 29, 0.3 m high (inferred)
Door ends, door bars and the side the containers face are inferred. Each asset's origin sits on the course terrain
(ground_abs = ev.terrain there, dz 0); every object's foot is the lowest terrain under it, minus 3 cm.
"""
import math
import random

import numpy as np
from mathutils import Matrix

import props_kit as kit

MATTE = {"omberg_yard_rust", "omberg_yard_blue", "omberg_yard_rust_flat", "omberg_yard_blue_flat", "omberg_yard_post",
         "omberg_yard_white", "omberg_yard_barrel", "omberg_yard_pipe"}

CONT = dict(rust=("omberg_yard_rust", "omberg_yard_rust_flat"), blue=("omberg_yard_blue", "omberg_yard_blue_flat"))


def register_materials():
    M = kit.MATERIALS
    M.update({
        "omberg_yard_rust": ("corr:150,70,50:0.1:2.0:1", (2.0, 2.0), None, 0.2, 0.2),
        "omberg_yard_rust_flat": (None, (1, 1), (128, 66, 50), 0.2, 0.1),
        "omberg_yard_blue": ("corr:44,86,150:0.1:2.0:0", (2.0, 2.0), None, 0.25, 0.2),
        "omberg_yard_blue_flat": (None, (1, 1), (46, 92, 156), 0.25, 0.1),
        "omberg_yard_post": (None, (1, 1), (54, 52, 50), 0.2, 0.3),
        "omberg_yard_white": ("plaster:214,214,208", (2.0, 2.0), None, 0.2, 0.0),
        "omberg_yard_barrel": (None, (1, 1), (214, 176, 62), 0.3, 0.0),
        "omberg_yard_pipe": (None, (1, 1), (214, 214, 208), 0.35, 0.0),
        "omberg_yard_pipe_grey": (None, (1, 1), (150, 152, 150), 0.35, 0.0),
    })


def foot_z(ev, pts, ground_abs):
    """Lowest terrain under an object's footprint corners, relative to the asset's ground, less 3 cm."""
    return min(ev.terrain(e, n) for e, n in pts) - ground_abs - 0.03


def corners(e, n, bearing, L, W):
    """EN corners + centre of a box whose long side L runs along `bearing`."""
    a = math.radians(bearing)
    ux, uy = math.sin(a), math.cos(a)
    vx, vy = -uy, ux
    pts = [(e + sx * L / 2 * ux + sy * W / 2 * vx, n + sx * L / 2 * uy + sy * W / 2 * vy) for sx in (-1, 1) for sy in (-1, 1)]
    return pts + [(e, n)]


def lidar_top(ev, e, n, r, ground_abs, q=75):
    p = ev.points
    m = (np.hypot(p[:, 0] - e, p[:, 1] - n) < r) & (p[:, 3] == 1)
    return float(np.percentile(p[m, 2], q)) - ground_abs if m.sum() > 3 else None


def container(g, ev, ground_abs, origin, e, n, bearing, L, W, H, kind, door_end=-1):
    """Steel shipping container: corrugated sides (vertical ribs), a flat roof, dark corner posts and base rails, door
    bars on one end. Local frame of the object: x along the long side."""
    side_m, flat_m = CONT[kind]
    z0 = foot_z(ev, corners(e, n, bearing, L, W), ground_abs)
    x, y = e - origin[0], n - origin[1]
    g.push(Matrix.Translation((x, y, z0)) @ Matrix.Rotation(math.radians(90 - bearing), 4, "Z"))
    h = H - z0 + z0                                   # H is measured from the lowest ground, so z0 + H is the top
    g.box((0, 0, h / 2), (L, W, h), side_m, mats={"top": flat_m, "bottom": flat_m})
    for sx in (-1, 1):
        for sy in (-1, 1):
            g.box((sx * (L / 2 - 0.08), sy * (W / 2 - 0.08), h / 2), (0.16, 0.16, h + 0.02), "omberg_yard_post")   # corner posts
    for sy in (-1, 1):
        g.box((0, sy * (W / 2 - 0.05), 0.09), (L, 0.1, 0.18), "omberg_yard_post")                                  # base rails
        g.box((0, sy * (W / 2 - 0.05), h - 0.05), (L, 0.1, 0.1), "omberg_yard_post")                               # top rails
    xd = door_end * (L / 2 + 0.012)
    for k in (-0.5, -0.17, 0.17, 0.5):                                                                             # locking bars
        g.box((xd, k * W * 0.92, h / 2), (0.03, 0.05, h - 0.4), "omberg_yard_post")
    g.box((xd, 0, h / 2), (0.02, W - 0.3, 0.05), "omberg_yard_post")
    g.pop()


def crate(g, ev, ground_abs, origin, e, n, bearing, L, W, H):
    z0 = foot_z(ev, corners(e, n, bearing, L, W), ground_abs)
    g.push(Matrix.Translation((e - origin[0], n - origin[1], z0)) @ Matrix.Rotation(math.radians(90 - bearing), 4, "Z"))
    g.box((0, 0, H / 2), (L, W, H), "omberg_yard_white")
    for sx in (-1, 1):
        g.box((sx * (L / 2 - 0.02), 0, H / 2), (0.05, W, 0.06), "omberg_yard_post")
    g.pop()


def barrel(g, ev, ground_abs, origin, e, n, d, H):
    z0 = foot_z(ev, [(e + d / 2, n), (e - d / 2, n), (e, n + d / 2), (e, n - d / 2)], ground_abs)
    x, y = e - origin[0], n - origin[1]
    g.cylinder((x, y, z0), d / 2, H, "omberg_yard_barrel", seg=14)
    for z in (0.25, H - 0.25):
        g.cylinder((x, y, z0 + z), d / 2 + 0.012, 0.05, "omberg_yard_barrel", seg=14)


def pipes(g, ev, ground_abs, origin, e, n, bearing, L, rnd):
    """A loose bundle: 14 pipes of 8-12 cm lying in two layers, ends staggered."""
    a = math.radians(bearing)
    ux, uy = math.sin(a), math.cos(a)
    vx, vy = -uy, ux
    for i in range(14):
        row, col = divmod(i, 8)
        off = (col - 3.5) * 0.115 + rnd.uniform(-0.02, 0.02) + (0.055 if row else 0)
        r = rnd.uniform(0.04, 0.055)
        ln = L * rnd.uniform(0.82, 1.0)
        sh = rnd.uniform(-0.3, 0.3)
        c = (e + off * vx + sh * ux, n + off * vy + sh * uy)
        z = foot_z(ev, [(c[0] + dx * ux * ln / 2, c[1] + dx * uy * ln / 2) for dx in (-1, 1)], ground_abs) + r + (0.1 if row else 0.0)
        pa = (c[0] - ux * ln / 2 - origin[0], c[1] - uy * ln / 2 - origin[1], z)
        pb = (c[0] + ux * ln / 2 - origin[0], c[1] + uy * ln / 2 - origin[1], z)
        g.pipe(pa, pb, r, "omberg_yard_pipe" if i % 5 else "omberg_yard_pipe_grey", seg=8)


def build(add, new, ev):
    rnd = random.Random(7)
    # ---- containers
    O = (478002.4, 6458156.4)
    G = ev.terrain(*O)
    g = new()
    g.category = "prop"
    top = lambda e, n, r, default: (lidar_top(ev, e, n, r, G) or default)
    container(g, ev, G, O, 478004.6, 6458158.3, 188.0, 6.06, 2.44, 2.62 + 0.0, "rust", door_end=-1)
    container(g, ev, G, O, 478000.1, 6458157.7, 92.0, 4.0, 2.1, 1.72, "blue", door_end=1)
    container(g, ev, G, O, 478000.7, 6458154.3, 98.0, 2.9, 2.6, 2.3, "blue", door_end=-1)
    add("omberg_barn_containers", g, O[0], O[1], 90.0, G)
    # ---- small things
    O = (477994.6, 6458147.0)
    G = ev.terrain(*O)
    g = new()
    g.category = "prop"
    crate(g, ev, G, O, 477991.5, 6458147.2, 100.0, 1.4, 1.3, 1.7)
    barrel(g, ev, G, O, 477992.6, 6458149.0, 0.95, 1.2)
    pipes(g, ev, G, O, 477997.0, 6458145.6, 29.0, 6.5, rnd)
    add("omberg_barn_yard", g, O[0], O[1], 90.0, G)
