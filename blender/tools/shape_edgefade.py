"""Path edge fade: the pure parts of `golfmap.path_edge_fade` (no bpy, no numpy), tested by shape_edgefade_test.py.

The op widens the fringe strip of a gravel / dirt path into the path and paints it with a noisy ramp, so the
surface breaks up into the grass instead of ending on a line. Paint convention of a faded strip:

    red   = the neighbour's grass (Stix 3D grass grows on red: its blade chance is the vertex red)
    green = the path surface (the path material draws it on its green channel)

Both are fully on at the ends of the strip (outer edge: red 1; inner edge: green 1) and sum to 1 everywhere, so
MAHS's black (1 - r - g - b) is 0: the two materials mix by paint alone.

The ramp across the strip is a smoothstep of the normalised distance from the strip's outer edge, bent by a seeded
fractal value noise of the world position (so neighbouring path pieces, which share the noise, join up) and tapered
to nothing at both ends (the edge itself stays straight and black/red, only the mix between wanders).
"""

import math

SURFACES = ("gravel", "dirt")   # the surfaces that get the fade; asphalt, concrete, paving, wood keep a crisp edge
WIDTH_M = 0.3                   # how far the strip reaches into the path (the fade eats into the path from its old edge)
MAX_EDGE_M = 0.3                # the longest edge kept inside the zone (the paint's resolution; faces ~ 1 / MAX_EDGE_M^2)
AMPLITUDE = 0.55                # how far the noise bends the ramp, as a fraction of the strip width
CONVENTION = "path-edge-fade-v1"


def _hash(ix, iy, seed):
    n = (ix * 374761393 + iy * 668265263 + seed * 2147483647) & 0xFFFFFFFF
    n = ((n ^ (n >> 13)) * 1274126177) & 0xFFFFFFFF
    n = n ^ (n >> 16)
    return (n & 0xFFFF) / 32767.5 - 1.0     # [-1, 1]


def value_noise(x, y, seed):
    """Smooth value noise, [-1, 1], period-free; the lattice is 1 unit."""
    ix, iy = math.floor(x), math.floor(y)
    fx, fy = x - ix, y - iy
    sx, sy = fx * fx * (3 - 2 * fx), fy * fy * (3 - 2 * fy)
    a, b = _hash(ix, iy, seed), _hash(ix + 1, iy, seed)
    c, d = _hash(ix, iy + 1, seed), _hash(ix + 1, iy + 1, seed)
    top = a + (b - a) * sx
    return top + ((c + (d - c) * sx) - top) * sy


def fractal_noise(x, y, seed):
    """Three octaves at 0.45 m, 0.17 m and 0.06 m (weights 0.55 / 0.30 / 0.15): patches, clumps, grit."""
    return (0.55 * value_noise(x / 0.45, y / 0.45, seed)
            + 0.30 * value_noise(x / 0.17, y / 0.17, seed + 11)
            + 0.15 * value_noise(x / 0.06, y / 0.06, seed + 23))


def smoothstep(a, b, x):
    t = max(0.0, min(1.0, (x - a) / (b - a)))
    return t * t * (3 - 2 * t)


def strip_value(d_outer, total_width, x, y, seed, amplitude=AMPLITUDE):
    """The path-surface weight s in [0, 1] at a strip vertex: 0 on the outer edge, 1 on the inner edge.
    d_outer = its distance from the strip's outer edge (m), total_width = the strip's width (m)."""
    if total_width <= 0:
        return 1.0
    t = max(0.0, min(1.0, d_outer / total_width))
    if d_outer < 0.004:
        return 0.0
    if d_outer > total_width - 0.01:
        return 1.0
    wobble = amplitude * fractal_noise(x, y, seed) * 4.0 * t * (1.0 - t)
    return smoothstep(0.0, 1.0, t + wobble)


def paint(s):
    """(r, g, b) of a strip vertex with path-surface weight s: red grass, green path."""
    s = max(0.0, min(1.0, s))
    return (1.0 - s, s, 0.0)


def validate_params(op):
    """Problems in the op's own keys (shape_layers.validate_op calls this)."""
    errors = []
    for k, lo in (("widthM", 0.0), ("maxEdgeM", 0.0), ("amplitude", 0.0)):
        if k in op and not (isinstance(op[k], (int, float)) and not isinstance(op[k], bool) and op[k] > lo
                            or k == "amplitude" and isinstance(op[k], (int, float)) and op[k] == 0):
            errors.append(f"{k} must be a number > {lo:g}" + (" (or 0)" if k == "amplitude" else ""))
    if "maxEdgeM" in op and isinstance(op["maxEdgeM"], (int, float)) and 0 < op["maxEdgeM"] < 0.04:
        errors.append("maxEdgeM must be >= 0.04 (every halving of the edge quadruples the faces)")
    if "surfaces" in op and not (isinstance(op["surfaces"], list) and op["surfaces"]
                                 and all(isinstance(s, str) and s for s in op["surfaces"])):
        errors.append("surfaces must be a list of surface names")
    if "weld" in op and not isinstance(op["weld"], bool):
        errors.append("weld must be true/false")
    return errors
