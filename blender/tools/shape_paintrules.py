"""Rule-based vertex paint of the course meshes: the pure maths of `golfmap.paint` (numpy, no bpy).

A port of Unity's GolfMapVertexPaint (paint.json, `golfmap-paint-v1`: kinds `object`, `road`, `edge`) and of the
colour part of GolfMapLake.Bed (the big lake's light sand band), plus `stroke` (hand paint kept as a rule). Every
function takes per-mesh arrays in the .blend frame and returns weights or colours, so the Blender op
(shape_paintop.py) and a plain-Python preview share one implementation. Tests: `python blender/tools/shape_paintrules_test.py`.

Colours are Unity's: RGBA floats 0..1 as the FBX carries them (Blender's `color_srgb` of the `Col` BYTE_COLOR
attribute), MAHS's black = 1 - r - g - b. A rule paints one channel: red (1, 0, 0), green (0, 1, 0), blue (0, 0, 1)
or black (0, 0, 0); alpha is never touched. Mode `replace` lerps the colour toward the channel colour by the weight,
`overlay` (red, green, blue) raises that component only (Unity's Overlay: on rough the Stix grass, red, stays).
A weight <= MIN_WEIGHT paints nothing (Unity's `w <= 0.001f`); the lake bed paints any weight > 0.

Frames. The .blend is the course turned 180 degrees about the inner square's SW corner (shape_coords): Unity world
= (-x, z, -y) of the .blend. XY distances are the same in both, and the turn keeps the handedness, so left / right of
a creek line is the same too. Rules and strokes in EPSG:3006 go through shape_coords.to_blend. The creeks and
R.A.M. roads exports are in plot metres (x east, z north from the inner square's SW corner), which Unity uses as
world coordinates as they are (the splines sit under an identity root, the paint compares them with world
positions), so plot (x, z) -> .blend (-x, -z): paint lands where Unity draws the road. The lake-plane file's shore
grid is in Unity world metres: the same map.

Order on a vertex in Unity: every matching object rule (file order), then road rules, then edge rules; each lerp
reads the colour the one before left. Per vertex and independent of the other vertices, so one op per rule in that
order gives the same colour.

Differences from Unity, all small: float64 instead of float32 maths; nearest-point ties broken by a different
point order (Unity's PointGrid iterates its cells in Unity-world order); colours quantised to bytes after every op
(Unity keeps floats in its painted copy): <= 0.5 / 255 per op. The edge rule's noise is this module's own Perlin
noise (perlin01), not bit-identical to Unity's Mathf.PerlinNoise (same seed offsets, same threshold method); its
wall-ground exception (no blue on a wall-reshaped rough) is not ported.
"""

import base64
import glob
import hashlib
import json
import math
import os

import numpy as np

import shape_coords

FORMAT = "golfmap-paint-v1"
KINDS = ("object", "road", "edge", "lakebed", "stroke")
CHANNELS = {"red": (1.0, 0.0, 0.0), "green": (0.0, 1.0, 0.0), "blue": (0.0, 0.0, 1.0), "black": (0.0, 0.0, 0.0)}
CHANNEL_INDEX = {"red": 0, "green": 1, "blue": 2}
MODES = ("replace", "overlay")
MIN_WEIGHT = 0.001                    # Unity: a weight <= 0.001 paints nothing
ROAD_STEP_M = 0.25                    # road centrelines sampled this often (Unity's RoadStepM)
BUNKER_BLEND = "_Bunker_-_Blend"      # the outer edge of these is edge rule 'bunker'
LAKE_BED_SUFFIX = "_Water_Base_Lake_-_Mesh"
LAKE_ABOVE_WATER_KEEP_M = 0.3         # lake bed vertices higher than this over the water are bank: left as painted
LAKE_BAND_M, LAKE_FADE_M = 25.0, 20.0  # GolfMapLake.BedSettings defaults
DEFAULT_COLOUR = (1.0, 0.0, 0.0, 1.0)  # a mesh without colours paints from red (GolfMapVertexPaint) ...
LAKE_DEFAULT_COLOUR = (0.0, 0.0, 0.0, 1.0)  # ... a lake bed from black (GolfMapLake.Bed)
STROKE_GEOMETRIES = ("line", "polygon", "circle")
# GolfMapSurfaces.Surface (codes are Unity's file format)
SURFACES = ("None", "Deep", "Rough", "Semi", "Fairway", "Green", "Tee", "Bunker", "Water", "Blend", "Other", "Rock",
            "Slab")
# the export files a rule reads, by kind (<prefix>-inner-<suffix>.json in the course export folder)
FILE_SUFFIX = {"road": "ramroads", "creek": "creeks", "lakebed": "lake-plane"}
# Unity-only keys of a paint.json rule (materials, Stix grass): not paint, never in an op
UNITY_ONLY_KEYS = ("material", "grassFrom", "enabled", "notes", "note")


class RuleError(ValueError):
    pass


# ---------------------------------------------------------------- names

def classify(name):
    """GolfMapSurfaces.Classify: the surface class of a course mesh by its name."""
    if name.startswith("Gap_Issue"):
        return "Blend"
    if "_-_Blend" in name or "_B_" in name:
        return "Blend"
    if "_Rock_-_" in name:
        return "Slab"
    if "Water" in name or "Creek" in name or "Lake" in name:
        return "Water"
    for word in ("Deep", "Semi", "Rough", "Fairway", "Green", "Tee", "Bunker"):
        if word in name:
            return word
    return "Other"


def is_course_mesh(name):
    """What paint may touch: a Spline_* course mesh, never a water plane (GolfMapVertexPaint.CourseMeshes)."""
    return name.startswith("Spline_") and "waterplane" not in name.lower()


# ---------------------------------------------------------------- rules

def _num(rule, key, default, where):
    v = rule.get(key, default)
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v):
        raise RuleError(f"{where}: {key} must be a number")
    return float(v)


def _clamp01(v):
    return min(1.0, max(0.0, v))


def _channel(rule, where, default="black"):
    c = str(rule.get("channel") or default).lower()
    if c not in CHANNELS:
        raise RuleError(f"{where}: channel must be red, green, blue or black")
    return c


def _surfaces(rule, where, default):
    out = []
    for s in rule.get("surfaces") or default:
        hit = [x for x in SURFACES if x.lower() == str(s).lower()]
        if not hit:
            raise RuleError(f"{where}: unknown surface {s!r}")
        out.append(hit[0])
    return out


def _mode(rule, where, channel):
    mode = str(rule.get("mode") or "replace").lower()
    if mode not in MODES:
        raise RuleError(f"{where}: mode must be replace or overlay")
    if mode == "overlay" and channel == "black":
        raise RuleError(f"{where}: black has no overlay (it is the absence of the others); use mode replace")
    return mode


def _pairs(v, n, what, where):
    if not (isinstance(v, list) and len(v) >= n and all(
            isinstance(p, list) and len(p) == 2 and all(isinstance(c, (int, float)) and not isinstance(c, bool)
                                                      for c in p) for p in v)):
        raise RuleError(f"{where}: {what} must be a list of >= {n} [E, N] pairs")
    return [[float(p[0]), float(p[1])] for p in v]


def normalise(rule, where="rule"):
    """A paint.json rule (or stroke) with Unity's defaults filled in and checked: the dict every weight function
    takes. Raises RuleError with Unity's messages where Unity throws."""
    if not isinstance(rule, dict):
        raise RuleError(f"{where}: not an object")
    kind = rule.get("kind")
    if kind not in KINDS:
        raise RuleError(f"{where}: kind must be one of {', '.join(KINDS)}")
    r = {"id": str(rule.get("id") or kind), "kind": kind}
    if kind == "object":
        r.update(match=rule.get("match"), channel=_channel(rule, where), mode="replace",
                 strength=_clamp01(_num(rule, "strength", 1, where)), fadeM=_num(rule, "fadeM", 0.5, where),
                 belowM=_num(rule, "belowM", -1, where), softM=_num(rule, "softM", 0.08, where),
                 reachM=_num(rule, "reachM", 1.5, where), shoreM=_num(rule, "shoreM", -1, where),
                 creek=rule.get("creek") or None)
        if (r["shoreM"] > 0 or r["belowM"] > 0) and (r["softM"] <= 0 or r["reachM"] <= 0):
            raise RuleError(f"{where}: softM and reachM must be > 0")
        if not isinstance(r["match"], str) or not r["match"]:
            raise RuleError(f"{where}: an object rule needs match (a name substring)")
        if r["fadeM"] <= 0:
            raise RuleError(f"{where}: fadeM must be > 0")
    elif kind == "road":
        r.update(channel=_channel(rule, where), mode="replace", strength=_clamp01(_num(rule, "strength", 1, where)),
                 insetM=_num(rule, "insetM", 0.4, where), fadeM=_num(rule, "fadeM", 1, where),
                 surfaces=_surfaces(rule, where, ("Rough", "Deep")))
        if r["fadeM"] <= 0:
            raise RuleError(f"{where}: fadeM must be > 0")
    elif kind == "edge":
        if rule.get("edge") != "bunker":
            raise RuleError(f"{where}: edge {rule.get('edge')!r} is not supported (bunker)")
        ch = _channel(rule, where)
        r.update(edge="bunker", channel=ch, mode=_mode(rule, where, ch), widthM=_num(rule, "widthM", 1.5, where),
                 strength=_clamp01(_num(rule, "strength", 1, where)),
                 coverage=_clamp01(_num(rule, "coverage", 0.5, where)),
                 noiseM=max(0.5, _num(rule, "noiseM", 4, where)), seed=int(_num(rule, "seed", 1, where)),
                 surfaces=_surfaces(rule, where, ("Rough",)))
        if r["widthM"] <= 0:
            raise RuleError(f"{where}: widthM must be > 0")
    elif kind == "lakebed":
        r.update(channel="red", mode="replace", bandM=max(0.0, _num(rule, "bandM", LAKE_BAND_M, where)),
                 fadeM=max(0.01, _num(rule, "fadeM", LAKE_FADE_M, where)),
                 match=str(rule.get("match") or LAKE_BED_SUFFIX))
    else:  # stroke
        geom = rule.get("geometry")
        if geom not in STROKE_GEOMETRIES:
            raise RuleError(f"{where}: geometry must be line, polygon or circle")
        if not rule.get("channel"):
            raise RuleError(f"{where}: a stroke needs channel (red, green, blue or black)")
        ch = _channel(rule, where)
        r.update(geometry=geom, channel=ch, mode=_mode(rule, where, ch),
                 strength=_clamp01(_num(rule, "strength", 1, where)), featherM=_num(rule, "featherM", 0.5, where),
                 widthM=_num(rule, "widthM", 1.0, where),
                 surfaces=_surfaces(rule, where, ()) if rule.get("surfaces") else None,
                 match=rule.get("match") or None)
        if r["featherM"] < 0:
            raise RuleError(f"{where}: featherM must be >= 0")
        if geom == "line":
            r["points3006"] = _pairs(rule.get("points3006"), 2, "points3006", where)
            if r["widthM"] <= 0:
                raise RuleError(f"{where}: widthM must be > 0 (a line's full width)")
        elif geom == "polygon":
            r["points3006"] = _pairs(rule.get("points3006"), 3, "points3006", where)
        else:
            r["centre3006"] = _pairs([rule.get("centre3006")], 1, "centre3006", where)[0]
            r["radiusM"] = _num(rule, "radiusM", 0, where)
            if r["radiusM"] <= 0:
                raise RuleError(f"{where}: radiusM must be > 0")
        if r["match"] is not None and not isinstance(r["match"], str):
            raise RuleError(f"{where}: match must be a name substring")
    return r


def validate(rule, where="rule"):
    """[] or the rule's problems (for shape_layers.validate_op)."""
    try:
        normalise(rule, where)
        return []
    except RuleError as e:
        return [str(e)]


def paint_rule(rule):
    """A paint.json rule as it goes into an op: the Unity-only keys (materials, Stix grass, enabled, notes) dropped,
    so a material tweak does not re-run the paint."""
    return {k: v for k, v in rule.items() if k not in UNITY_ONLY_KEYS}


# ---------------------------------------------------------------- shared maths

def smooth(e0, e1, x):
    """Unity's Smooth: smoothstep of x from e0 to e1 (x may be inf)."""
    with np.errstate(invalid="ignore", over="ignore"):
        t = np.clip((np.asarray(x, dtype=np.float64) - e0) / (e1 - e0), 0.0, 1.0)
    t = np.where(np.isnan(t), 1.0, t)
    return t * t * (3 - 2 * t)


def apply_channel(rgba, weight, channel, mode="replace", min_weight=MIN_WEIGHT):
    """New colours (a copy of rgba, (N, 4)) with `channel` painted by `weight` (N,): replace = lerp toward the
    channel colour (Color.Lerp with the target's alpha = the colour's own), overlay = that component raised toward 1.
    Weights <= min_weight leave the colour as it is."""
    out = np.array(rgba, dtype=np.float64, copy=True)
    w = np.clip(np.asarray(weight, dtype=np.float64), 0.0, 1.0)
    m = w > min_weight
    if not m.any():
        return out
    wm = w[m]
    if mode == "overlay":
        i = CHANNEL_INDEX[channel]
        out[m, i] = out[m, i] + (1.0 - out[m, i]) * wm
    else:
        t = np.array(CHANNELS[channel], dtype=np.float64)
        out[m, :3] = out[m, :3] + (t - out[m, :3]) * wm[:, None]
    return out


_KEY_OFF = 1 << 20


def _cell_key(ix, iy):
    return (ix.astype(np.int64) + _KEY_OFF) * (1 << 22) + (iy.astype(np.int64) + _KEY_OFF)


class PointIndex:
    """Points bucketed on the XY plane for nearest-within-r queries (Unity's PointGrid, vectorised)."""

    def __init__(self, xy, cell):
        self.xy = np.asarray(xy, dtype=np.float64).reshape(-1, 2)
        self.cell = max(float(cell), 0.25)
        ij = np.floor(self.xy / self.cell).astype(np.int64)
        keys = _cell_key(ij[:, 0], ij[:, 1])
        self.order = np.argsort(keys, kind="stable")
        self.ukeys, self.starts, self.counts = np.unique(keys[self.order], return_index=True, return_counts=True)

    def nearest(self, q, r, chunk=65536):
        """(distance, point index) per query point: the nearest point within r (r <= the cell size), else (inf, -1).
        Ties go to the later point, as in Unity."""
        q = np.asarray(q, dtype=np.float64).reshape(-1, 2)
        dist = np.full(len(q), np.inf)
        idx = np.full(len(q), -1, dtype=np.int64)
        if not len(self.xy) or not len(q):
            return dist, idx
        r2 = float(r) * float(r)
        for s in range(0, len(q), chunk):
            qc = q[s:s + chunk]
            best = np.full(len(qc), np.inf)
            bidx = np.full(len(qc), -1, dtype=np.int64)
            cq = np.floor(qc / self.cell).astype(np.int64)
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    k = _cell_key(cq[:, 0] + dx, cq[:, 1] + dy)
                    pos = np.searchsorted(self.ukeys, k)
                    pos_c = np.minimum(pos, len(self.ukeys) - 1)
                    hit = (pos < len(self.ukeys)) & (self.ukeys[pos_c] == k)
                    qi = np.nonzero(hit)[0]
                    if not len(qi):
                        continue
                    cnt = self.counts[pos_c[qi]]
                    rep = np.repeat(qi, cnt)
                    off = np.arange(cnt.sum()) - np.repeat(np.cumsum(cnt) - cnt, cnt)
                    pts = self.order[np.repeat(self.starts[pos_c[qi]], cnt) + off]
                    d2 = ((self.xy[pts] - qc[rep]) ** 2).sum(axis=1)
                    ok = d2 <= r2
                    rep, pts, d2 = rep[ok], pts[ok], d2[ok]
                    if not len(rep):
                        continue
                    blk = np.full(len(qc), np.inf)
                    np.minimum.at(blk, rep, d2)
                    win = d2 == blk[rep]
                    bi = np.full(len(qc), -1, dtype=np.int64)
                    bi[rep[win]] = pts[win]
                    upd = blk <= best
                    best[upd] = blk[upd]
                    bidx[upd] = bi[upd]
            found = bidx >= 0
            dist[s:s + chunk] = np.where(found, np.sqrt(best), np.inf)
            idx[s:s + chunk] = bidx
        return dist, idx


def boundary_points(world, loop_vert, loop_start, loop_total):
    """World positions (M, 3) of a mesh's border vertices: GolfMapBunkerChannels.Read's welded topology (positions
    rounded to a millimetre are one vertex, a border edge is used by one face). `world` (N, 3) per vertex, the face
    corners as Blender keeps them (corner -> vertex, face -> first corner and corner count)."""
    world = np.asarray(world, dtype=np.float64).reshape(-1, 3)
    loop_vert = np.asarray(loop_vert, dtype=np.int64)
    if not len(world) or not len(loop_vert):
        return np.zeros((0, 3))
    _, first, weld = np.unique(np.round(world * 1000.0).astype(np.int64), axis=0, return_index=True,
                               return_inverse=True)
    weld = weld.reshape(-1)
    loop_start = np.asarray(loop_start, dtype=np.int64)
    loop_total = np.asarray(loop_total, dtype=np.int64)
    face = np.repeat(np.arange(len(loop_start)), loop_total)
    pos = np.arange(len(loop_vert)) - loop_start[face]
    nxt = loop_start[face] + (pos + 1) % loop_total[face]
    a, b = weld[loop_vert], weld[loop_vert[nxt]]
    keep = a != b
    lo, hi = np.minimum(a[keep], b[keep]), np.maximum(a[keep], b[keep])
    key, count = np.unique(lo * (int(weld.max()) + 1) + hi, return_counts=True)
    edge = key[count == 1]
    n = int(weld.max()) + 1
    ids = np.unique(np.concatenate([edge // n, edge % n]))
    return world[first[ids]]


def _segments_nearest(q, pts, closed=False, chunk=4096):
    """Per query point: (distance to the polyline, index of the nearest segment (first of equals), side value of
    that segment = cross(d, q - a): > 0 left of the line's direction)."""
    q = np.asarray(q, dtype=np.float64).reshape(-1, 2)
    p = np.asarray(pts, dtype=np.float64).reshape(-1, 2)
    a = p if closed else p[:-1]
    b = np.roll(p, -1, axis=0) if closed else p[1:]
    d = b - a
    l2 = np.maximum((d ** 2).sum(axis=1), 1e-9)
    dist = np.empty(len(q))
    seg = np.empty(len(q), dtype=np.int64)
    side = np.empty(len(q))
    step = max(1, chunk * 64 // max(1, len(a)))
    for s in range(0, len(q), step):
        qc = q[s:s + step]
        rel = qc[:, None, :] - a[None, :, :]
        t = np.clip((rel * d[None]).sum(axis=2) / l2[None], 0.0, 1.0)
        c = a[None] + d[None] * t[:, :, None] - qc[:, None, :]
        d2 = (c ** 2).sum(axis=2)
        k = np.argmin(d2, axis=1)
        r = np.arange(len(qc))
        dist[s:s + step] = np.sqrt(d2[r, k])
        seg[s:s + step] = k
        side[s:s + step] = d[k, 0] * rel[r, k, 1] - d[k, 1] * rel[r, k, 0]
    return dist, seg, side


def side_of(line, q):
    """GolfMapVertexPaint.SideOf: > 0 left, < 0 right of the line (looking along it) by its nearest segment."""
    return _segments_nearest(q, line)[2]


# ---------------------------------------------------------------- kinds

def object_weights(xyz, border, rule, line=None, below_left=float("nan"), below_right=float("nan")):
    """Kind 'object' on one matching mesh: weight per vertex (xyz (N, 3) .blend world) from the mesh's own border
    points (boundary_points). Default: full from fadeM inside the border, fading to 0 at it (full where no border is
    within fadeM). belowM: by depth under the nearest border vertex within reachM (none: full depth); `line` (a
    creek's, .blend XY, downstream) gives the depth per side (below_left / below_right, NaN = the rule's).
    shoreM: the opposite band, less than shoreM under the border."""
    xyz = np.asarray(xyz, dtype=np.float64).reshape(-1, 3)
    border = np.asarray(border, dtype=np.float64).reshape(-1, 3)
    s = rule["strength"]
    if rule["shoreM"] > 0 or rule["belowM"] > 0:
        d, i = PointIndex(border[:, :2], rule["reachM"]).nearest(xyz[:, :2], rule["reachM"])
        depth = np.where(i >= 0, border[np.maximum(i, 0), 2] - xyz[:, 2], np.inf)
        if rule["shoreM"] > 0:
            return s * (1.0 - smooth(rule["shoreM"], rule["shoreM"] + rule["softM"], depth))
        below = np.full(len(xyz), rule["belowM"])
        if line is not None and len(line) >= 2:
            side = side_of(line, xyz[:, :2])
            per = np.where(side > 0, below_left, below_right)
            below = np.where(np.isnan(per), below, per)
        return s * smooth(below, below + rule["softM"], depth)
    d, i = PointIndex(border[:, :2], rule["fadeM"]).nearest(xyz[:, :2], rule["fadeM"])
    return s * np.where(i >= 0, smooth(0.0, rule["fadeM"], d), 1.0)


def road_samples(lines, step=ROAD_STEP_M):
    """The centrelines sampled every `step` (Unity's LoadRoadRules): (M, 3) of x, y, half width. `lines` = [(points
    (K, 2), widthM)] in any one frame (an affine map of the samples = the samples of the mapped lines)."""
    out = []
    for pts, width in lines:
        p = np.asarray(pts, dtype=np.float64).reshape(-1, 2)
        for k in range(1, len(p)):
            a, b = p[k - 1], p[k]
            n = max(1, int(math.ceil(float(np.hypot(*(b - a))) / step)))
            j = np.arange(0 if k == 1 else 1, n + 1) / n
            seg = a[None] + (b - a)[None] * j[:, None]
            out.append(np.column_stack([seg, np.full(len(seg), width / 2.0)]))
    return np.concatenate(out) if out else np.zeros((0, 3))


def road_reach(samples, rule):
    """No paint beyond this from a centreline sample: the widest half width - insetM + fadeM (>= 0.5)."""
    widest = float(samples[:, 2].max()) * 2 if len(samples) else 0.0
    return max(0.5, widest / 2 - rule["insetM"] + rule["fadeM"])


def road_weights(xy, samples, rule, index=None):
    """Kind 'road': strength out to the nearest sample's half width less insetM, fading to 0 over fadeM past it."""
    reach = road_reach(samples, rule)
    index = index or PointIndex(samples[:, :2], reach)
    d, i = index.nearest(xy, reach)
    full = samples[np.maximum(i, 0), 2] - rule["insetM"]
    return np.where(i >= 0, rule["strength"] * (1.0 - smooth(full, full + rule["fadeM"], d)), 0.0)


# Ken Perlin's reference permutation
_P = np.array([151, 160, 137, 91, 90, 15, 131, 13, 201, 95, 96, 53, 194, 233, 7, 225, 140, 36, 103, 30, 69, 142, 8, 99,
               37, 240, 21, 10, 23, 190, 6, 148, 247, 120, 234, 75, 0, 26, 197, 62, 94, 252, 219, 203, 117, 35, 11, 32,
               57, 177, 33, 88, 237, 149, 56, 87, 174, 20, 125, 136, 171, 168, 68, 175, 74, 165, 71, 134, 139, 48, 27,
               166, 77, 146, 158, 231, 83, 111, 229, 122, 60, 211, 133, 230, 220, 105, 92, 41, 55, 46, 245, 40, 244,
               102, 143, 54, 65, 25, 63, 161, 1, 216, 80, 73, 209, 76, 132, 187, 208, 89, 18, 169, 200, 196, 135, 130,
               116, 188, 159, 86, 164, 100, 109, 198, 173, 186, 3, 64, 52, 217, 226, 250, 124, 123, 5, 202, 38, 147,
               118, 126, 255, 82, 85, 212, 207, 206, 59, 227, 47, 16, 58, 17, 182, 189, 28, 42, 223, 183, 170, 213,
               119, 248, 152, 2, 44, 154, 163, 70, 221, 153, 101, 155, 167, 43, 172, 9, 129, 22, 39, 253, 19, 98, 108,
               110, 79, 113, 224, 232, 178, 185, 112, 104, 218, 246, 97, 228, 251, 34, 242, 193, 238, 210, 144, 12,
               191, 179, 162, 241, 81, 51, 145, 235, 249, 14, 239, 107, 49, 192, 214, 31, 181, 199, 106, 157, 184, 84,
               204, 176, 115, 121, 50, 45, 127, 4, 150, 254, 138, 236, 205, 93, 222, 114, 67, 29, 24, 72, 243, 141,
               128, 195, 78, 66, 215, 61, 156, 180], dtype=np.int64)
_PP = np.concatenate([_P, _P])
_GRAD = np.array([[1, 1], [-1, 1], [1, -1], [-1, -1], [1, 0], [-1, 0], [0, 1], [0, -1]], dtype=np.float64)


def perlin01(x, y):
    """2D gradient (Perlin) noise mapped to about 0..1, clustering round 0.5 like Mathf.PerlinNoise (not
    bit-identical to it). Deterministic, period 256."""
    x = np.asarray(x, dtype=np.float64)
    y = np.asarray(y, dtype=np.float64)
    xf, yf = np.floor(x), np.floor(y)
    xi, yi = xf.astype(np.int64) & 255, yf.astype(np.int64) & 255
    fx, fy = x - xf, y - yf
    u, v = fx * fx * fx * (fx * (fx * 6 - 15) + 10), fy * fy * fy * (fy * (fy * 6 - 15) + 10)

    def g(ix, iy, dx, dy):
        h = _PP[_PP[ix] + iy] & 7
        return _GRAD[h, 0] * dx + _GRAD[h, 1] * dy
    n00, n10 = g(xi, yi, fx, fy), g(xi + 1, yi, fx - 1, fy)
    n01, n11 = g(xi, yi + 1, fx, fy - 1), g(xi + 1, yi + 1, fx - 1, fy - 1)
    a = n00 + (n10 - n00) * u
    b = n01 + (n11 - n01) * u
    return 0.5 + 0.5 * (a + (b - a) * v)


def _frac(x):
    return x - math.floor(x)


def edge_noise(rule):
    """The rule's seeded noise offsets and coverage threshold (Unity's LoadRules + Threshold, on perlin01)."""
    s = rule["seed"]
    off = (_frac(s * 0.6180339) * 200 + 11.3, _frac(s * 0.4142136) * 200 + 23.7)
    off2 = (off[0] + 57.1, off[1] + 91.9)
    if rule["coverage"] >= 1:
        thr = -np.inf
    elif rule["coverage"] <= 0:
        thr = np.inf
    else:
        n = 96
        i, j = np.meshgrid(np.arange(n), np.arange(n), indexing="ij")
        samples = np.sort(perlin01(off[0] + i * 0.37, off[1] + j * 0.37).ravel())
        thr = float(samples[min(max(int(round((1 - rule["coverage"]) * (len(samples) - 1))), 0), len(samples) - 1)])
    return off, off2, thr


def edge_weights(xy, edge_points, rule):
    """Kind 'edge' (bunker): weight per vertex (xy .blend) from its distance to the nearest bunker-blend border point
    within widthM, broken into stretches by the seeded noise (coverage) with a noisy reach of 35-100 % of widthM.
    The noise runs in Unity world XZ (-x, -y) as Unity's does."""
    xy = np.asarray(xy, dtype=np.float64).reshape(-1, 2)
    d, i = PointIndex(np.asarray(edge_points, dtype=np.float64).reshape(-1, 3)[:, :2], rule["widthM"]).nearest(
        xy, rule["widthM"])
    off, off2, thr = edge_noise(rule)
    ux, uz = -xy[:, 0], -xy[:, 1]
    n1 = perlin01(off[0] + ux / rule["noiseM"], off[1] + uz / rule["noiseM"])
    applies = smooth(thr - 0.035, thr + 0.035, n1) if np.isfinite(thr) else np.full(len(xy), 1.0 if thr < 0 else 0.0)
    n2 = perlin01(off2[0] + ux * 2 / rule["noiseM"], off2[1] + uz * 2 / rule["noiseM"])
    reach = rule["widthM"] * (0.35 + 0.65 * np.clip((n2 - 0.2) / 0.6, 0.0, 1.0))
    w = rule["strength"] * applies * (1.0 - smooth(0.0, reach, d))
    return np.where((i >= 0) & (d < rule["widthM"]) & (d < reach) & (applies > 0), w, 0.0)


def _grid_sample(g, data, x, z):
    """GolfMapLake.Sample: bilinear over the cell centres, inf outside."""
    fx = (x - g["x0"]) / g["cellM"] - 0.5
    fz = (z - g["z0"]) / g["cellM"] - 0.5
    out = (fx < 0) | (fz < 0) | (fx > g["width"] - 1) | (fz > g["height"] - 1)
    fxc, fzc = np.clip(fx, 0, g["width"] - 1), np.clip(fz, 0, g["height"] - 1)
    ix = np.minimum(fxc.astype(np.int64), g["width"] - 2)
    iz = np.minimum(fzc.astype(np.int64), g["height"] - 2)
    tx, tz = fxc - ix, fzc - iz
    d = np.asarray(data, dtype=np.float64).reshape(g["height"], g["width"]) * g["stepM"]
    v = ((d[iz, ix] * (1 - tx) + d[iz, ix + 1] * tx) * (1 - tz) + (d[iz + 1, ix] * (1 - tx) + d[iz + 1, ix + 1] * tx) * tz)
    return np.where(out, np.inf, v)


def lakebed_weights(xyz, plane, rule):
    """GolfMapLake.Bed's colour: red by k per vertex (xyz .blend) of a lake bed mesh: 1 within bandM of the shore
    (the lake-plane file's shore distance grid), fading to 0 over fadeM, times (1 - cliff); none above the water
    (+0.3 m) or off the grid."""
    xyz = np.asarray(xyz, dtype=np.float64).reshape(-1, 3)
    g = plane["grid"]
    ux, uz, uy = -xyz[:, 0], -xyz[:, 1], xyz[:, 2]
    d = _grid_sample(g, plane["dist"], ux, uz)
    with np.errstate(invalid="ignore"):
        k = np.where(d <= rule["bandM"], 1.0, np.clip(1.0 - (d - rule["bandM"]) / rule["fadeM"], 0.0, 1.0))
    if plane.get("cliff") is not None:
        cl = _grid_sample(dict(g, stepM=1.0 / 255.0), plane["cliff"], ux, uz)
        k = np.where(np.isfinite(cl), k * (1.0 - np.clip(cl, 0.0, 1.0)), k)
    return np.where(uy > plane["surfaceY"] + LAKE_ABOVE_WATER_KEEP_M, 0.0, np.nan_to_num(k, nan=0.0))


def lake_mesh_selected(name, lo, hi, plane, match=LAKE_BED_SUFFIX):
    """GolfMapLake.Bed's choice of meshes: named *_Water_Base_Lake_-_Mesh, reaching under the water and over the
    shore grid. lo / hi: the mesh's .blend world bounding box corners (x, y, z)."""
    if not name.endswith(match):
        return False
    g = plane["grid"]
    gx1, gz1 = g["x0"] + g["width"] * g["cellM"], g["z0"] + g["height"] * g["cellM"]
    ux0, ux1, uz0, uz1 = -hi[0], -lo[0], -hi[1], -lo[1]
    return lo[2] < plane["surfaceY"] and ux1 > g["x0"] and ux0 < gx1 and uz1 > g["z0"] and uz0 < gz1


def _inside_polygon(q, poly):
    """Even-odd point in polygon, vectorised over q."""
    x, y = q[:, 0], q[:, 1]
    inside = np.zeros(len(q), dtype=bool)
    p = np.asarray(poly, dtype=np.float64)
    for (x1, y1), (x2, y2) in zip(p, np.roll(p, -1, axis=0)):
        with np.errstate(divide="ignore", invalid="ignore"):
            cross = ((y1 > y) != (y2 > y)) & (x < (x2 - x1) * (y - y1) / (y2 - y1) + x1)
        inside ^= cross
    return inside


def stroke_geometry(rule, frame):
    """The stroke's shape in the .blend frame: (kind, points (K, 2) or centre (2,), radius)."""
    if rule["geometry"] == "circle":
        e, n = rule["centre3006"]
        return "circle", np.array(shape_coords.to_blend(e, n, frame)), rule["radiusM"]
    pts = np.array([shape_coords.to_blend(e, n, frame) for e, n in rule["points3006"]], dtype=np.float64)
    return rule["geometry"], pts, rule["widthM"] / 2 if rule["geometry"] == "line" else 0.0


def stroke_box(geom, rule):
    """XY box (.blend) outside which the stroke paints nothing."""
    kind, pts, r = geom
    pad = r + rule["featherM"] if kind != "polygon" else rule["featherM"]
    p = np.asarray(pts, dtype=np.float64).reshape(-1, 2)
    return (float(p[:, 0].min() - pad), float(p[:, 1].min() - pad), float(p[:, 0].max() + pad), float(p[:, 1].max() + pad))


def stroke_weights(xy, geom, rule):
    """Kind 'stroke': strength inside the shape (a line widthM wide, a polygon, a circle), fading to 0 over featherM
    outside it (a hard edge when featherM is 0)."""
    xy = np.asarray(xy, dtype=np.float64).reshape(-1, 2)
    kind, pts, r = geom
    if kind == "circle":
        out = np.maximum(0.0, np.hypot(xy[:, 0] - pts[0], xy[:, 1] - pts[1]) - r)
    elif kind == "line":
        out = np.maximum(0.0, _segments_nearest(xy, pts)[0] - r)
    else:
        out = np.where(_inside_polygon(xy, pts), 0.0, _segments_nearest(xy, pts, closed=True)[0])
    if rule["featherM"] <= 0:
        return np.where(out <= 0, rule["strength"], 0.0)
    return rule["strength"] * (1.0 - smooth(0.0, rule["featherM"], out))


def stroke_touches(name, rule):
    """Whether a stroke may paint this mesh: a course mesh of its surfaces and with its name substring (both
    optional)."""
    if not is_course_mesh(name):
        return False
    if rule.get("surfaces") and classify(name) not in rule["surfaces"]:
        return False
    return not rule.get("match") or rule["match"] in name


# ---------------------------------------------------------------- the export files

def course_prefix(folder):
    """The course's file prefix: <prefix>-inner-dem-<side>m.tif.json in its export folder."""
    found = sorted(glob.glob(os.path.join(folder, "*-inner-dem-*m.tif.json")))
    if not found:
        return None
    base = os.path.basename(found[0])
    return base[:base.index("-inner-dem-")]


def rule_file(rule, folder, source=None):
    """The export file a rule reads (None: it reads none): `source` (relative to the course folder) or
    <prefix>-inner-<ramroads|creeks|lake-plane>.json."""
    kind = rule.get("kind")
    what = "creek" if kind == "object" and rule.get("creek") else kind
    if what not in FILE_SUFFIX:
        return None
    if source:
        return source if os.path.isabs(source) else os.path.join(folder, source)
    prefix = course_prefix(folder)
    return os.path.join(folder, f"{prefix}-inner-{FILE_SUFFIX[what]}.json") if prefix else None


def file_sha(path):
    try:
        with open(path, "rb") as f:
            return hashlib.sha1(f.read()).hexdigest()
    except (OSError, TypeError):
        return None


def dependency(op, folder):
    """What besides the op itself decides a paint op's result: its export file and that file's content sha (None
    when missing). The worker folds this into the op's canonical text, so an edited export re-runs the op."""
    rule = op.get("rule") or {}
    path = rule_file(rule, folder, op.get("source"))
    return None if path is None else {"file": os.path.basename(path), "sha": file_sha(path)}


def _plot_check(doc, path):
    plot = doc.get("plot") or {}
    if plot.get("terrain", "inner") != "inner":
        raise RuleError(f"{path}: not for the inner terrain")


def plot_to_blend(pts):
    """Plot metres (x east, z north; Unity world as Unity uses them) -> .blend x, y."""
    p = np.asarray(pts, dtype=np.float64).reshape(-1, 2)
    return -p


def load_roads(path):
    """unity-ramroads-v1 -> [(centreline (K, 2) .blend, widthM)] (GolfMapRamRoads.Load: an id and >= 2 points)."""
    with open(path, encoding="utf-8") as f:
        doc = json.load(f)
    if doc.get("format") != "unity-ramroads-v1":
        raise RuleError(f"{path}: format must be unity-ramroads-v1")
    _plot_check(doc, path)
    out = []
    for r in doc.get("roads") or []:
        pts = [p[:2] for p in r.get("points") or [] if isinstance(p, list) and len(p) >= 2]
        if r.get("id") and len(pts) >= 2:
            out.append((plot_to_blend(pts), float(r.get("widthM", 3))))
    return out


def load_creek(path, creek_id):
    """unity-creeks-v1 -> (line (K, 2) .blend, grassBelowLeftM, grassBelowRightM) of one creek, or None."""
    with open(path, encoding="utf-8") as f:
        doc = json.load(f)
    if doc.get("format") != "unity-creeks-v1":
        raise RuleError(f"{path}: format must be unity-creeks-v1")
    _plot_check(doc, path)
    for c in doc.get("creeks") or []:
        pts = [[p[0], p[2]] for p in c.get("points") or [] if isinstance(p, list) and len(p) >= 4]
        if c.get("id") == creek_id and len(pts) >= 2:
            return (plot_to_blend(pts), float(c.get("grassBelowLeftM", float("nan"))),
                    float(c.get("grassBelowRightM", float("nan"))))
    return None


def load_lake_plane(path):
    """golfmap-lake-plane-v1 -> {surfaceY, grid, dist (uint8), cliff (uint8 or None), name}."""
    with open(path, encoding="utf-8") as f:
        doc = json.load(f)
    if doc.get("format") != "golfmap-lake-plane-v1":
        raise RuleError(f"{path}: format must be golfmap-lake-plane-v1")
    g = doc.get("shoreDistance") or {}
    if not g.get("width") or not g.get("data"):
        raise RuleError(f"{path} has no shore distance grid: run golfpipe lake-plane again")
    grid = {k: float(g[k]) for k in ("x0", "z0", "cellM", "stepM")}
    grid.update(width=int(g["width"]), height=int(g["height"]))
    dist = np.frombuffer(base64.b64decode(g["data"]), dtype=np.uint8)
    if len(dist) != grid["width"] * grid["height"]:
        raise RuleError(f"{path}: the shore grid's data is not width x height")
    cliff = np.frombuffer(base64.b64decode(g["cliff"]), dtype=np.uint8) if g.get("cliff") else None
    if cliff is not None and len(cliff) != len(dist):
        raise RuleError(f"{path}: the shore grid's cliff is not width x height")
    return {"name": doc.get("name"), "surfaceY": float(doc.get("surfaceY", 0.0)), "grid": grid, "dist": dist,
            "cliff": cliff}
