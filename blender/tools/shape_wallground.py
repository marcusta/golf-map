"""The ground under a stone wall's bank: `golfmap.wall_ground` (shape_apply registers it; one op per wall, written by
`pipeline/shaping_walls.py` from `docs/gspro/<course>/stone-walls.json` into `shaping/80-walls.gen.json`).

The Blender port of Unity's GolfMapWallGround (unity/Editor/GolfMap/GolfMapWallGround.cs), which reshaped the course
meshes in Unity after every mesh sync and opened 8-26 cm steps and cracks at mesh borders (it split triangles 1 -> 4
near a bank, so an unsplit neighbour kept its long edge, and moved each mesh on its own). Same shape, seam-safe by
construction:

- the profile is Unity's: stations every 0.25 m along the toe, the ground at the foot (hToe) and the plateau's height
  (hTop: the highest of the lip and beyondM past it), for a cliff the mid-height point (tMid), each smoothed along the
  wall (median of 9, then mean of 5). Heights are measured on the meshes as they are when the op runs (the shaped
  meshes; in Unity the original FBX); `Surface.At` = the highest Spline mesh face under a point (a BVH ray cast down);
- terrace (every style but cliff): raised, never lowered, to the foot up to baseInM in, then a face at faceDeg up to
  hTop, flat out to beyondM past the lip; cliff: a 12 deg apron, the face at faceDeg +- jitterDeg (seeded along the
  face) through the mid-height point, the top; below the mid-height point it may be lowered; roundTopM rounds the
  crest (and relaxes shoulder and foot, Unity's RoundShoulders); tapered over taperM at the wall's ends; a move under
  5 mm is no move; paintOnly subdivides and paints but keeps the heights;
- the target height is a pure function of XY (and the wall), applied to EVERY visible Spline mesh vertex within reach
  (all surfaces, as Unity did). Vertices two meshes share (boundary vertices within SEAM_XY in XY) are one point: one
  XY, one height (their mean), one move, one normal;
- subdivision is by EDGES: an edge is halved when its XY length is over subdivideM and one of its ends or its middle
  lies within reach of the bank (the band the shape changes + 1.3 m), measured on the shared points - so a border edge
  two meshes share splits alike on both sides; interior edges of a triangle with two split edges are split too (the
  1 -> 4 pattern Unity used), up to 6 levels; colours and normals interpolate at the new vertices (bmesh);
- paint (Rough / Deep meshes by Unity's name rule, into the `Col` corner colours as sRGB bytes, the values Unity's
  MAHS reads): the face (feathered paintFeatherM) toward groundChannel, a cliff's outline inside (minus paintInsetM,
  feathered) with its grass patches left out, then with stoneFace (the wall has a stoneAlbedo) blue -> green where
  the new normal is 35-60 deg steep - Unity's weights exactly;
- normals: the moved vertices and their ring (and the painted ones) take the area-weighted normal of every face
  around the point over all meshes that share it; every other vertex keeps its custom normal;
- afterwards shape_apply's weld_tjunctions on the written meshes closes what a mesh left unsplit, and the seam
  (slab_seam_check) and T-junction (tjunction_check) checks run: a seam the op opened is an op error.

Without bpy or numpy this module still imports (validate_params is called by shape_layers' layer validation).
Test: blender.exe -b --factory-startup --python-exit-code 1 --python blender/tools/shape_wallground_test.py
"""

import math
import time

try:
    import numpy as np
except ImportError:   # plain Python: only validate_params / settings are used
    np = None

STATION_STEP_M = 0.25
REACH_M = 1.3          # subdivide this far past the band the shape changes (one original triangle)
RECT_PAD_M = 3.0       # the wall's box: its toe, lip and outline + REACH_M + this (Unity's Load)
MOVE_MIN_M = 0.005     # a smaller move is no move
PAINT_MIN = 0.01       # a smaller stone weight paints nothing
SEAM_XY = 1e-4         # = shape_apply.SEAM_XY: boundary vertices this close are one seam point
MAX_LEVELS = 6
APRON_TAN = 0.2126     # a cliff's apron: 12 degrees
VN_LAYER = "golfmap_wg_vn"
CHANNELS = {"red": (1.0, 0.0, 0.0), "green": (0.0, 1.0, 0.0), "blue": (0.0, 0.0, 1.0), "black": (0.0, 0.0, 0.0)}
PROFILES = ("terrace", "cliff")

# The `ground` settings of an op and Unity's defaults (GolfMapWalls.Settings). The generator writes them all.
GROUND_DEFAULTS = {
    "profile": "terrace", "faceDeg": 60.0, "baseInM": 0.2, "beyondM": 0.5, "taperM": 1.5, "subdivideM": 0.35,
    "paintFeatherM": 0.25, "paintInsetM": 0.0, "minFaceM": 0.35, "jitterDeg": 0.0, "roundTopM": 0.0,
    "groundChannel": "blue", "paintOnly": False, "stoneFace": False,
}
GROUND_NUMBERS = ("faceDeg", "baseInM", "beyondM", "taperM", "subdivideM", "paintFeatherM", "paintInsetM", "minFaceM",
                  "jitterDeg", "roundTopM")
GROUND_BOOLS = ("paintOnly", "stoneFace")


# ---------------------------------------------------------------- validation (pure Python)

def _num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def _pairs(v, n_min, width=(2,)):
    return isinstance(v, list) and len(v) >= n_min and all(
        isinstance(p, list) and len(p) in width and all(_num(c) for c in p) for p in v)


def validate_params(op):
    """Problems with a golfmap.wall_ground op's own keys (shape_layers.validate_op checks the rest)."""
    errors = []
    toe, lip = op.get("toe3006"), op.get("lip3006")
    if not _pairs(toe, 2):
        errors.append("toe3006 must be a list of >= 2 [E, N] pairs")
    if not _pairs(lip, 2):
        errors.append("lip3006 must be a list of >= 2 [E, N] pairs")
    if isinstance(toe, list) and isinstance(lip, list) and len(toe) != len(lip):
        errors.append("toe3006 and lip3006 need the same number of stations")
    if "outline3006" in op and not _pairs(op["outline3006"], 3):
        errors.append("outline3006 must be a list of >= 3 [E, N] pairs")
    if "grassPatches3006" in op:
        gp = op["grassPatches3006"]
        if not _pairs(gp, 0, (3, 4)) or any(r <= 0 for p in gp for r in p[2:]):
            errors.append("grassPatches3006 must be a list of [E, N, radiusEastM(, radiusNorthM)] with radii > 0")
    if "wall" in op and not (isinstance(op["wall"], str) and op["wall"]):
        errors.append("wall must be the wall's id")
    g = op.get("ground")
    if not isinstance(g, dict):
        return errors + ["ground must be an object of the wall's ground settings"]
    unknown = sorted(set(g) - set(GROUND_DEFAULTS))
    if unknown:
        errors.append("unknown ground key(s) " + ", ".join(unknown) + " (known: " + ", ".join(sorted(GROUND_DEFAULTS)) + ")")
    for k in GROUND_NUMBERS:
        if k in g and not _num(g[k]):
            errors.append(f"ground.{k} must be a number")
    for k in GROUND_BOOLS:
        if k in g and not isinstance(g[k], bool):
            errors.append(f"ground.{k} must be true/false")
    if g.get("profile", "terrace") not in PROFILES:
        errors.append("ground.profile must be one of " + ", ".join(PROFILES))
    if str(g.get("groundChannel", "blue")).lower() not in CHANNELS:
        errors.append("ground.groundChannel must be red, green, blue or black")
    if _num(g.get("subdivideM", 0.35)) and g.get("subdivideM", 0.35) < 0.05:
        errors.append("ground.subdivideM must be >= 0.05 (the faces grow with 1 / subdivideM^2)")
    for k in ("baseInM", "beyondM", "taperM", "paintFeatherM", "paintInsetM", "minFaceM", "jitterDeg", "roundTopM"):
        if _num(g.get(k, 0)) and g.get(k, 0) < 0:
            errors.append(f"ground.{k} must be >= 0")
    return errors


def settings(op):
    """The op's ground settings over Unity's defaults."""
    g = dict(GROUND_DEFAULTS)
    g.update(op.get("ground") or {})
    g["groundChannel"] = str(g["groundChannel"]).lower()
    return g


# ---------------------------------------------------------------- Unity's maths

def _mathf_max(a, b):
    return a if a > b else b   # Mathf.Max: a NaN in a gives b, in b gives NaN


def _clamp01(x):
    return np.clip(x, 0.0, 1.0)


def _smoothstep01(t):
    # Mathf.SmoothStep(0, 1, t)
    t = np.clip(t, 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def _inverse_lerp(a, b, v):
    return np.clip((v - a) / (b - a), 0.0, 1.0) if b != a else np.zeros_like(v)


def classify(name):
    """Unity's GolfMapSurfaces.Classify by name (only rough and deep take the stone paint)."""
    if name.startswith("Gap_Issue") or "_-_Blend" in name or "_B_" in name:
        return "blend"
    if "_Rock_-_" in name:
        return "slab"
    if "Water" in name or "Creek" in name or "Lake" in name:
        return "water"
    for word, s in (("Deep", "deep"), ("Semi", "semi"), ("Rough", "rough"), ("Fairway", "fairway"), ("Green", "green"),
                    ("Tee", "tee"), ("Bunker", "bunker")):
        if word in name:
            return s
    return "other"


class DotNetRandom:
    """System.Random(seed) as Unity's Mono has it (Knuth's subtractive generator): the same phases as Unity."""
    MBIG, MSEED = 2147483647, 161803398

    def __init__(self, seed):
        seed = int(seed)
        sub = 2147483647 if seed == -2147483648 else abs(seed)
        a = [0] * 56
        mj = self.MSEED - sub
        a[55] = mj
        mk = 1
        for i in range(1, 55):
            ii = (21 * i) % 55
            a[ii] = mk
            mk = mj - mk
            if mk < 0:
                mk += self.MBIG
            mj = a[ii]
        for _ in range(4):
            for i in range(1, 56):
                a[i] -= a[1 + (i + 30) % 55]
                if a[i] < 0:
                    a[i] += self.MBIG
        self.a, self.inext, self.inextp = a, 0, 21

    def next_double(self):
        self.inext = 1 if self.inext + 1 >= 56 else self.inext + 1
        self.inextp = 1 if self.inextp + 1 >= 56 else self.inextp + 1
        r = self.a[self.inext] - self.a[self.inextp]
        if r == self.MBIG:
            r -= 1
        if r < 0:
            r += self.MBIG
        self.a[self.inext] = r
        return r * (1.0 / self.MBIG)


_PERM = [151, 160, 137, 91, 90, 15, 131, 13, 201, 95, 96, 53, 194, 233, 7, 225, 140, 36, 103, 30, 69, 142, 8, 99, 37,
         240, 21, 10, 23, 190, 6, 148, 247, 120, 234, 75, 0, 26, 197, 62, 94, 252, 219, 203, 117, 35, 11, 32, 57, 177,
         33, 88, 237, 149, 56, 87, 174, 20, 125, 136, 171, 168, 68, 175, 74, 165, 71, 134, 139, 48, 27, 166, 77, 146,
         158, 231, 83, 111, 229, 122, 60, 211, 133, 230, 220, 105, 92, 41, 55, 46, 245, 40, 244, 102, 143, 54, 65, 25,
         63, 161, 1, 216, 80, 73, 209, 76, 132, 187, 208, 89, 18, 169, 200, 196, 135, 130, 116, 188, 159, 86, 164, 100,
         109, 198, 173, 186, 3, 64, 52, 217, 226, 250, 124, 123, 5, 202, 38, 147, 118, 126, 255, 82, 85, 212, 207, 206,
         59, 227, 47, 16, 58, 17, 182, 189, 28, 42, 223, 183, 170, 213, 119, 248, 152, 2, 44, 154, 163, 70, 221, 153,
         101, 155, 167, 43, 172, 9, 129, 22, 39, 253, 19, 98, 108, 110, 79, 113, 224, 232, 178, 185, 112, 104, 218, 246,
         97, 228, 251, 34, 242, 193, 238, 210, 144, 12, 191, 179, 162, 241, 81, 51, 145, 235, 249, 14, 239, 107, 49,
         192, 214, 31, 181, 199, 106, 157, 184, 84, 204, 176, 115, 121, 50, 45, 127, 4, 150, 254, 138, 236, 205, 93,
         222, 114, 67, 29, 24, 72, 243, 141, 128, 195, 78, 66, 215, 61, 156, 180]


def perlin01(x, y):
    """2D improved Perlin noise mapped to about 0..1 (vectorised). Stands in for Unity's Mathf.PerlinNoise, whose exact
    lattice is not public: same character and range, not the same values (only grass patches use it)."""
    p = np.array(_PERM + _PERM, dtype=np.int64)
    x, y = np.asarray(x, dtype=np.float64), np.asarray(y, dtype=np.float64)
    xi, yi = np.floor(x), np.floor(y)
    xf, yf = x - xi, y - yi
    xi, yi = xi.astype(np.int64) & 255, yi.astype(np.int64) & 255
    u, v = xf ** 3 * (xf * (xf * 6 - 15) + 10), yf ** 3 * (yf * (yf * 6 - 15) + 10)

    def grad(h, gx, gy):
        h = h & 15
        a = np.where(h < 8, gx, gy)
        b = np.where(h < 4, gy, np.where((h == 12) | (h == 14), gx, 0.0))
        return np.where(h & 1, -a, a) + np.where(h & 2, -b, b)

    aa, ab = p[p[xi] + yi], p[p[xi] + yi + 1]
    ba, bb = p[p[xi + 1] + yi], p[p[xi + 1] + yi + 1]
    x1 = grad(aa, xf, yf) + u * (grad(ba, xf - 1, yf) - grad(aa, xf, yf))
    x2 = grad(ab, xf, yf - 1) + u * (grad(bb, xf - 1, yf - 1) - grad(ab, xf, yf - 1))
    return (x1 + v * (x2 - x1) + 1.0) / 2.0


def _smooth(values):
    """Unity's Smooth: median of 9 (NaN left out, the upper median of an even count), then mean of 5."""
    v = list(values)
    n = len(v)
    med = []
    for i in range(n):
        win = sorted(x for x in v[max(0, i - 4):min(n, i + 5)] if not math.isnan(x))
        med.append(win[len(win) // 2] if win else float("nan"))
    out = []
    for i in range(n):
        win = [x for x in med[max(0, i - 2):min(n, i + 3)] if not math.isnan(x)]
        out.append(sum(win) / len(win) if win else float("nan"))
    return np.array(out, dtype=np.float64)


# ---------------------------------------------------------------- the bank (numpy, no bpy)

class Bank:
    """One wall's bank in the .blend frame: stations, profile and the shape. `to_blend(e, n)` maps EPSG:3006 to the
    .blend's x, y; `sample(points (N, 2)) -> heights (N,)` (NaN where no mesh) is the surface before the op."""

    def __init__(self, op, to_blend, sample):
        s = self.s = settings(op)
        self.id = op.get("wall") or op.get("id")
        toe = np.array([to_blend(e, n) for e, n in op["toe3006"]], dtype=np.float64)
        lip = np.array([to_blend(e, n) for e, n in op["lip3006"]], dtype=np.float64)
        self.outline = (np.array([to_blend(e, n) for e, n in op["outline3006"]], dtype=np.float64)
                        if len(op.get("outline3006") or []) >= 3 else None)
        # grass patches in Unity's scene frame (x east, z north from the terrain's corner: the .blend turned 180 deg),
        # where Unity's noise lives
        self.patches = [(-to_blend(p[0], p[1])[0], -to_blend(p[0], p[1])[1], float(p[2]), float(p[3] if len(p) > 3 else p[2]))
                        for p in op.get("grassPatches3006") or []]
        self.cliff = s["profile"] == "cliff"
        self.channel = np.array(CHANNELS[s["groundChannel"]])
        self.tan_face = math.tan(math.radians(min(max(s["faceDeg"], 20.0), 85.0)))
        rnd = DotNetRandom(op.get("seed", 1))
        self.phase = [rnd.next_double() * 6.283 for _ in range(3)]
        along = np.concatenate([[0.0], np.cumsum(np.hypot(*(toe[1:] - toe[:-1]).T))])
        self.length = float(along[-1])
        pts = np.concatenate([toe, lip] + ([self.outline] if self.outline is not None else []))
        pad = REACH_M + RECT_PAD_M
        self.rect = (float(pts[:, 0].min() - pad), float(pts[:, 1].min() - pad),
                     float(pts[:, 0].max() + pad), float(pts[:, 1].max() + pad))
        # stations every STATION_STEP_M along the foot
        n = max(2, int(math.ceil(self.length / STATION_STEP_M)) + 1)
        st_toe, st_lip = np.zeros((n, 2)), np.zeros((n, 2))
        st_along = np.zeros(n)
        seg = 0
        for i in range(n):
            a = self.length * i / (n - 1)
            while seg < len(along) - 2 and along[seg + 1] < a:
                seg += 1
            span = along[seg + 1] - along[seg]
            f = min(max((a - along[seg]) / span, 0.0), 1.0) if span > 1e-4 else 0.0
            st_toe[i] = toe[seg] + (toe[seg + 1] - toe[seg]) * f
            st_lip[i] = lip[seg] + (lip[seg + 1] - lip[seg]) * f
            st_along[i] = a
        into = st_lip - st_toe
        depth = np.hypot(into[:, 0], into[:, 1])
        inward = np.where(depth[:, None] > 1e-3, into / np.maximum(depth, 1e-12)[:, None], 0.0)
        # every height the profile needs, sampled in one batch
        lines = [np.arange(0.0, d + 1e-9, 0.25) if d >= 0 else np.zeros(0) for d in depth]
        line_pts = [st_toe[i] + inward[i] * lines[i][:, None] for i in range(n)]
        batch = np.concatenate([st_toe, st_lip, st_lip + inward * s["beyondM"]] + line_pts)
        h = sample(batch)
        h_toe, h_lip, h_bey = h[:n], h[n:2 * n], h[2 * n:3 * n]
        h_line = h[3 * n:]
        h_top = np.array([_mathf_max(float(a), float(b)) for a, b in zip(h_lip, h_bey)])
        t_mid = depth / 2.0
        k = 0
        for i in range(n):
            mid = (h_toe[i] + h_top[i]) / 2.0
            zs = h_line[k:k + len(lines[i])]
            for t, z in zip(lines[i], zs):
                if not math.isnan(z) and z >= mid:
                    t_mid[i] = t
                    break
            k += len(lines[i])
        self.raw = {"hToe": h_toe.copy(), "hTop": h_top.copy()}
        self.toe, self.inward, self.along, self.depth = st_toe, inward, st_along, depth
        self.h_toe, self.h_top, self.t_mid = _smooth(h_toe), _smooth(h_top), _smooth(t_mid)

    def stats(self):
        ok = np.isfinite(self.h_toe) & np.isfinite(self.h_top)
        rise = (self.h_top - self.h_toe)[ok]
        return {"stations": int(len(self.toe)), "measured": int(ok.sum()), "lengthM": round(self.length, 2),
                "riseM": [round(float(rise.min()), 3), round(float(rise.max()), 3)] if len(rise) else None,
                "faceStations": int((rise >= self.s["minFaceM"]).sum())}

    # -- where a point is

    def locate(self, p):
        """Unity's Locate for points (N, 2): {ok, s, t, depth, hToe, hTop, tMid, faceTan} (arrays)."""
        p = np.asarray(p, dtype=np.float64).reshape(-1, 2)
        n, S = len(p), len(self.toe)
        x0, y0, x1, y1 = self.rect
        ok = (p[:, 0] >= x0) & (p[:, 0] < x1) & (p[:, 1] >= y0) & (p[:, 1] < y1)
        best = np.zeros(n, dtype=np.int64)
        for c in range(0, n, 2048):
            d2 = ((p[c:c + 2048, None, :] - self.toe[None, :, :]) ** 2).sum(axis=2)
            best[c:c + 2048] = np.argmin(d2, axis=1)
        out_s = np.full(n, np.nan)
        out_d = np.full(n, np.inf)
        out_q = np.zeros((n, 2))
        i0 = best.copy()
        F = np.zeros(n)
        for k in (best - 1, best):                     # Unity's order: k = best - 1 first, then best
            valid = (k >= np.maximum(0, best - 1)) & (k < np.minimum(S - 1, best + 1)) & (k >= 0)
            kk = np.clip(k, 0, S - 2)
            a = self.toe[kk]
            ab = self.toe[kk + 1] - a
            l2 = (ab ** 2).sum(axis=1)
            f = np.where(l2 > 1e-8, ((p - a) * ab).sum(axis=1) / np.where(l2 > 1e-8, l2, 1.0), 0.0)
            beyond = ((kk == 0) & (f < 0)) | ((kk == S - 2) & (f > 1))
            fc = np.clip(f, 0.0, 1.0)
            q = a + ab * fc[:, None]
            d = ((q - p) ** 2).sum(axis=1)
            take = valid & (d < out_d)
            s = self.along[kk] + (self.along[kk + 1] - self.along[kk]) * fc
            s = np.where(beyond, np.where(f < 0, -1.0, self.length + 1.0), s)
            out_d = np.where(take, d, out_d)
            out_s = np.where(take, s, out_s)
            out_q = np.where(take[:, None], q, out_q)
            i0 = np.where(take, kk, i0)
            F = np.where(take, fc, F)
        i1 = np.minimum(i0 + 1, S - 1)
        ok &= (out_s >= 0) & (out_s <= self.length)
        lerp = lambda arr: arr[i0] + (arr[i1] - arr[i0]) * F
        inward = self.inward[i0] + (self.inward[i1] - self.inward[i0]) * F[:, None]
        n2 = (inward ** 2).sum(axis=1)
        ok &= n2 >= 1e-6
        inward = inward / np.sqrt(np.maximum(n2, 1e-12))[:, None]
        r = {"s": out_s, "t": ((p - out_q) * inward).sum(axis=1), "depth": lerp(self.depth), "hToe": lerp(self.h_toe),
             "hTop": lerp(self.h_top), "tMid": lerp(self.t_mid)}
        ok &= np.isfinite(r["hToe"]) & np.isfinite(r["hTop"])
        r["ok"] = ok
        if self.cliff:
            r["faceTan"] = np.tan(np.radians(np.clip(self.s["faceDeg"] + self.s["jitterDeg"] * self.noise(out_s), 30.0, 88.0)))
        else:
            r["faceTan"] = np.full(n, self.tan_face)
        return r

    def noise(self, s):
        tau = 6.2831853
        s = np.nan_to_num(np.asarray(s, dtype=np.float64))
        v = (np.sin(tau * s / 7.3 + self.phase[0]) + 0.6 * np.sin(tau * s / 3.1 + self.phase[1])
             + 0.4 * np.sin(tau * s / 12.7 + self.phase[2]))
        return np.clip(v / 1.6, -1.0, 1.0)

    def in_outline(self, p):
        if self.outline is None:
            return np.zeros(len(p), dtype=bool)
        o = self.outline
        x, y = p[:, 0], p[:, 1]
        c = np.zeros(len(p), dtype=bool)
        j = len(o) - 1
        for i in range(len(o)):
            yi, yj, xi, xj = o[i, 1], o[j, 1], o[i, 0], o[j, 0]
            cross = (yi > y) != (yj > y)
            with np.errstate(divide="ignore", invalid="ignore"):
                xs = (xj - xi) * (y - yi) / (yj - yi) + xi
            c ^= cross & (x < xs)
            j = i
        return c

    def outline_edge(self, p):
        o = self.outline
        d = np.full(len(p), np.inf)
        j = len(o) - 1
        for i in range(len(o)):
            ab = o[i] - o[j]
            l2 = float((ab ** 2).sum())
            f = np.clip(((p - o[j]) * ab).sum(axis=1) / l2, 0.0, 1.0) if l2 > 1e-8 else np.zeros(len(p))
            d = np.minimum(d, np.hypot(*(o[j] + ab * f[:, None] - p).T))
            j = i
        return d

    def near(self, p):
        """Within reach of the bank (Unity's nearAt): the band the shape changes + REACH_M, or the outline + REACH_M."""
        p = np.asarray(p, dtype=np.float64).reshape(-1, 2)
        if not len(p):
            return np.zeros(0, dtype=bool)
        a = self.locate(p)
        lo = (0.0 if self.cliff else self.s["baseInM"]) - REACH_M
        out = a["ok"] & (a["t"] >= lo) & (a["t"] <= a["depth"] + self.s["beyondM"] + REACH_M)
        if self.outline is not None:
            out |= self.in_outline(p) | (self.outline_edge(p) < REACH_M)
        return out

    # -- the shape at points

    def target_cliff(self, a):
        s = self.s
        h = a["hTop"] - a["hToe"]
        mid = (a["hTop"] + a["hToe"]) / 2
        ft = a["faceTan"]
        f0 = a["tMid"] - (mid - a["hToe"]) / ft
        f1 = a["tMid"] + (a["hTop"] - mid) / ft
        t = a["t"]
        apron = a["hToe"] + t * APRON_TAN
        face = mid + (t - a["tMid"]) * ft
        if s["roundTopM"] > 0:
            angle = np.arctan(ft)
            radius = np.minimum(s["roundTopM"], h * 0.8 / np.maximum(0.01, 1 - np.cos(angle)))
            cx = f1 + radius * np.tan(angle * 0.5)
            start = cx - radius * np.sin(angle)
            arc = a["hTop"] - radius + np.sqrt(np.maximum(0.0, radius * radius - (t - cx) ** 2))
            face = np.where((t > start) & (t < cx), arc, np.where(t >= cx, a["hTop"], face))
        target = np.minimum(np.maximum(apron, face), a["hTop"])
        bad = (h < s["minFaceM"]) | (t < 0) | (t > a["depth"] + s["beyondM"])
        return np.where(bad, np.nan, target), f0, f1

    def target_terrace(self, a):
        s = self.s
        h = a["hTop"] - a["hToe"]
        face_top = s["baseInM"] + np.maximum(0.0, h) / self.tan_face
        t = a["t"]
        target = np.where(t <= face_top, a["hToe"] + (t - s["baseInM"]) * self.tan_face, a["hTop"])
        bad = (h < s["minFaceM"]) | (t < s["baseInM"]) | (t > a["depth"] + s["beyondM"])
        return np.where(bad, np.nan, target), face_top

    def taper(self, a):
        t = self.s["taperM"]
        return np.ones(len(a["s"])) if t <= 0 else np.clip(np.minimum(a["s"], self.length - a["s"]) / t, 0.0, 1.0)

    def shape(self, p, z):
        """Unity's per-vertex loop for points within reach (N, 2) at heights z (N,): (move, stone weight)."""
        s = self.s
        p = np.asarray(p, dtype=np.float64).reshape(-1, 2)
        z = np.asarray(z, dtype=np.float64)
        n = len(p)
        lift, drop, stone = np.zeros(n), np.zeros(n), np.zeros(n)
        fe = max(0.01, s["paintFeatherM"])
        if self.outline is not None:
            inside = self.in_outline(p)
            w = np.clip((self.outline_edge(p) - s["paintInsetM"]) / fe, 0.0, 1.0)
            if self.patches:
                ux, uz = -p[:, 0], -p[:, 1]     # Unity's scene frame
                for (px, pz, rx, rz) in self.patches:
                    dx, dz = (ux - px) / rx, (uz - pz) / rz
                    phase = float(perlin01(px * 0.17, pz * 0.17)) * 6.283
                    dx = dx + (perlin01(ux * 0.38, uz * 0.38) - 0.5) * 0.9
                    dz = dz + (perlin01(ux * 0.38 + 73, uz * 0.38 + 19) - 0.5) * 0.9
                    ang = np.arctan2(dz, dx)
                    edge = 0.75 + 0.3 * np.sin(ang * 3 + phase) + 0.18 * np.sin(ang * 5 - phase)
                    d = np.sqrt(dx * dx + dz * dz)
                    ragged = (perlin01(ux * 1.1, uz * 1.1) - 0.5) * 0.22
                    w = w * _smoothstep01((d + ragged - edge) / 0.32)
            stone = np.where(inside & (w > stone), w, stone)
        if s["paintOnly"]:
            return np.zeros(n), stone
        a = self.locate(p)
        ok = a["ok"]
        taper = self.taper(a)
        h = a["hTop"] - a["hToe"]
        with np.errstate(invalid="ignore"):
            if self.cliff:
                target, f0, f1 = self.target_cliff(a)
                t = a["t"]
                if s["roundTopM"] > 0:
                    join = (_smoothstep01(np.clip(t / 2.0, 0, 1))
                            * _smoothstep01(np.clip((a["depth"] + s["beyondM"] - t) / 2.0, 0, 1)))
                else:
                    join = 1.0
                d = (target - z) * taper * join
                has = ok & np.isfinite(target)
                lift = np.where(has & (d > 0), np.maximum(lift, d), lift)
                drop = np.where(has & ~(d > 0) & ((t < a["tMid"]) | (s["roundTopM"] > 0)), np.minimum(drop, d), drop)
                if self.outline is None:
                    w = np.minimum(np.clip((t - (f0 - fe)) / fe, 0, 1), np.clip((f1 + fe - t) / fe, 0, 1)) * taper
                    use = ok & (h >= s["minFaceM"]) & (t >= -fe) & (t <= a["depth"] + s["beyondM"]) & (w > stone)
                    stone = np.where(use, w, stone)
            else:
                target, face_top = self.target_terrace(a)
                has = ok & np.isfinite(target)
                lift = np.where(has, np.maximum(lift, (target - z) * taper), lift)
                t = a["t"]
                w = np.minimum(np.clip((t - (s["baseInM"] - fe)) / fe, 0, 1), np.clip((face_top + fe - t) / fe, 0, 1)) * taper
                use = ok & (h >= s["minFaceM"]) & (w > stone)
                stone = np.where(use, w, stone)
        move = np.where(lift > MOVE_MIN_M, lift, np.where(drop < -MOVE_MIN_M, drop, 0.0))
        return move, stone

    def round_shoulders(self, p, z, near, neighbours):
        """Unity's RoundShoulders for a cliff with roundTopM (not paintOnly): z relaxed toward its neighbours within
        1.5 m (Gaussian), weighted at the crest and the foot, 3 passes. neighbours(i) -> indices within 1.5 m.
        Returns the new z (N,)."""
        s = self.s
        if not (self.cliff and not s["paintOnly"] and s["roundTopM"] > 0):
            return z
        z = np.asarray(z, dtype=np.float64).copy()
        weights = np.zeros(len(p))
        idx = np.nonzero(near)[0]
        if len(idx):
            a = self.locate(p[idx])
            _, f0, f1 = self.target_cliff(a)
            rise = a["hTop"] - a["hToe"]
            with np.errstate(invalid="ignore", divide="ignore"):
                lo, hi = a["hTop"] - rise * 0.55, a["hTop"] - rise * 0.25
                upper = _smoothstep01(np.where(hi != lo, (z[idx] - lo) / np.where(hi != lo, hi - lo, 1.0), 0.0))
                crest = np.exp(-((a["t"] - f1) / 2.0) ** 2) * upper
                foot = np.exp(-(a["t"] / 1.5) ** 2)
                w = np.maximum(crest, foot) * self.taper(a)
            use = a["ok"] & (rise >= s["minFaceM"])
            weights[idx] = np.where(use, np.nan_to_num(w), 0.0)
        live = np.nonzero(weights >= 0.01)[0]
        nb = {int(i): np.asarray(neighbours(int(i)), dtype=np.int64) for i in live}
        for _ in range(3):
            nxt = z.copy()
            for i in live:
                j = nb[int(i)]
                d2 = ((p[j] - p[i]) ** 2).sum(axis=1)
                keep = d2 <= 2.25
                wt = np.exp(-d2[keep] / 0.8)
                if wt.sum() > 0:
                    nxt[i] = z[i] + ((wt * z[j][keep]).sum() / wt.sum() - z[i]) * weights[i] * 0.8
            z = nxt
        return z


# ---------------------------------------------------------------- Blender: planner and runner

def spline_meshes():
    import bpy
    return [o for o in bpy.data.objects if o.type == "MESH" and o.name.startswith("Spline")]


def _rect_of(op, frame, shape_coords):
    """The wall's XY box in the .blend (Unity's Bounds of toe, lip and outline + REACH_M + RECT_PAD_M)."""
    pts = [shape_coords.to_blend(e, n, frame) for e, n in list(op["toe3006"]) + list(op["lip3006"])
           + list(op.get("outline3006") or [])]
    pad = REACH_M + RECT_PAD_M
    return (min(p[0] for p in pts) - pad, min(p[1] for p in pts) - pad,
            max(p[0] for p in pts) + pad, max(p[1] for p in pts) + pad)


def _box_overlap(a, b, margin=0.0):
    return b[2] >= a[0] - margin and b[0] <= a[2] + margin and b[3] >= a[1] - margin and b[1] <= a[3] + margin


def candidates(ctx, rect, margin=0.0):
    """The visible Spline meshes whose XY box meets the wall's box (Unity's Touches)."""
    return sorted(o.name for o in spline_meshes() if o.visible_get() and ctx.box(o.name)
                  and _box_overlap(rect, ctx.box(o.name), margin))


def plan_wall_ground(ctx, op, unit_cls, near_boxes):
    """One unit per wall, named by the op id. Reads: every visible Spline mesh whose box meets the wall's box (the
    profile is measured on them, the shape moves them) and every mesh within 1 m of those (the weld afterwards).
    Region: the wall's box - outside it nothing moves but what the weld snaps along a written mesh's border."""
    import shape_coords
    rect = _rect_of(op, ctx.frame, shape_coords)
    unit = unit_cls(op["id"], [], op.get("seed", 1),
                    lambda margin=0.0: near_boxes(ctx, candidates(ctx, rect, margin), 1.0 + margin))
    unit.region = rect
    return [unit], []


def op_wall_ground(ctx, op, units, weld, seam_check, tj_check):
    """Run the op's units through the unit runner (shape_apply's op_wall_ground hands its plan_units result and its
    weld_tjunctions, slab_seam_check, tjunction_check in, so they key the op's code)."""
    runs = []
    for unit in units:
        run = ctx.runner.run(ctx, op, unit, lambda: wall_ground(ctx, op, weld, seam_check, tj_check))
        if run is not None:
            runs.append(run)
    return runs


def _positions(obj):
    me = obj.data
    co = np.empty(len(me.vertices) * 3, dtype=np.float32)
    me.vertices.foreach_get("co", co)
    return co.reshape(-1, 3).astype(np.float64)


def _vertex_normals(me):
    """Each vertex's normal as rendered (mean of its corner normals, custom ones included)."""
    cn = np.empty(len(me.loops) * 3, dtype=np.float32)
    me.corner_normals.foreach_get("vector", cn)
    cv = np.empty(len(me.loops), dtype=np.int64)
    me.loops.foreach_get("vertex_index", cv)
    acc = np.zeros((len(me.vertices), 3))
    np.add.at(acc, cv, cn.reshape(-1, 3))
    ln = np.linalg.norm(acc, axis=1)
    acc[ln < 1e-12] = (0.0, 0.0, 1.0)
    return acc / np.maximum(np.linalg.norm(acc, axis=1), 1e-12)[:, None]


def _surface(objs, rect):
    """Surface.At: the highest face of these meshes under each point (N, 2) -> (N,), NaN where none."""
    from mathutils.bvhtree import BVHTree
    verts, polys, off, top = [], [], 0, -1e9
    for o in objs:
        me = o.data
        co = _positions(o)
        if not len(co) or not len(me.polygons):
            continue
        cv = np.empty(len(me.loops), dtype=np.int64)
        me.loops.foreach_get("vertex_index", cv)
        start = np.empty(len(me.polygons), dtype=np.int64)
        me.polygons.foreach_get("loop_start", start)
        total = np.empty(len(me.polygons), dtype=np.int64)
        me.polygons.foreach_get("loop_total", total)
        lx, ly = co[cv, 0], co[cv, 1]
        x0, x1 = np.minimum.reduceat(lx, start), np.maximum.reduceat(lx, start)
        y0, y1 = np.minimum.reduceat(ly, start), np.maximum.reduceat(ly, start)
        keep = np.nonzero((x1 >= rect[0]) & (x0 <= rect[2]) & (y1 >= rect[1]) & (y0 <= rect[3]))[0]
        if not len(keep):
            continue
        verts += co.tolist()
        cvl = cv.tolist()
        for f in keep.tolist():
            s0 = int(start[f])
            polys.append([off + v for v in cvl[s0:s0 + int(total[f])]])
        off += len(co)
        top = max(top, float(co[:, 2].max()))
    if not polys:
        return lambda pts: np.full(len(pts), np.nan)
    tree = BVHTree.FromPolygons(verts, polys, all_triangles=False)
    z0 = top + 10.0

    def sample(pts):
        out = np.full(len(pts), np.nan)
        for i, (x, y) in enumerate(np.asarray(pts, dtype=np.float64).tolist()):
            hit = tree.ray_cast((x, y, z0), (0.0, 0.0, -1.0))
            if hit[0] is not None:
                out[i] = hit[0].z
        return out
    return sample


def _in_rect(xy, rect, pad=0.0):
    return (xy[:, 0] >= rect[0] - pad) & (xy[:, 0] <= rect[2] + pad) & (xy[:, 1] >= rect[1] - pad) & (xy[:, 1] <= rect[3] + pad)


def _seam_points(bms, rect):
    """The boundary vertices (within the wall's box) that coincide across or within meshes, as points: per mesh
    {vertex index: point id}, and per point its members [(mesh, vertex index)] and canonical XY (the
    lexicographically least member's). Vertex indices are bm.verts order (index_update)."""
    from mathutils.kdtree import KDTree
    pts, own = [], []
    for k, bm in enumerate(bms):
        bm.verts.index_update()
        for v in bm.verts:
            if v.is_boundary:
                x, y = v.co.x, v.co.y
                if rect[0] - 0.5 <= x <= rect[2] + 0.5 and rect[1] - 0.5 <= y <= rect[3] + 0.5:
                    pts.append((x, y))
                    own.append((k, v.index))
    parent = list(range(len(pts)))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i
    if pts:
        kd = KDTree(len(pts))
        for i, (x, y) in enumerate(pts):
            kd.insert((x, y, 0.0), i)
        kd.balance()
        for i, (x, y) in enumerate(pts):
            for _, j, _ in kd.find_range((x, y, 0.0), SEAM_XY):
                a, b = find(i), find(j)
                if a != b:
                    parent[max(a, b)] = min(a, b)
    comps = {}
    for i in range(len(pts)):
        comps.setdefault(find(i), []).append(i)
    of = [dict() for _ in bms]
    members, canon = [], []
    for root in sorted(comps):
        idx = comps[root]
        if len(idx) < 2:
            continue
        g = len(members)
        members.append([own[i] for i in idx])
        canon.append(min(pts[i] for i in idx))
        for i in idx:
            of[own[i][0]][own[i][1]] = g
    return of, members, canon


def _arrays(bm):
    bm.verts.index_update()
    bm.edges.index_update()
    co = np.array([v.co[:] for v in bm.verts], dtype=np.float64).reshape(-1, 3)
    edges = list(bm.edges)
    ev = np.array([(e.verts[0].index, e.verts[1].index) for e in edges], dtype=np.int64).reshape(-1, 2)
    return co, edges, ev


def _cut_edges(bm, bank, sub_m, rect, canon_xy):
    """The edges of one mesh to halve: XY length (on the shared points) over sub_m, one end or the middle within reach."""
    co, edges, ev = _arrays(bm)
    xy = co[:, :2].copy()
    for vi, c in canon_xy.items():
        xy[vi] = c
    if not len(ev):
        return []
    a, b = xy[ev[:, 0]], xy[ev[:, 1]]
    length = np.hypot(*(b - a).T)
    lo, hi = np.minimum(a, b), np.maximum(a, b)
    cand = (length > sub_m) & (hi[:, 0] >= rect[0]) & (lo[:, 0] <= rect[2]) & (hi[:, 1] >= rect[1]) & (lo[:, 1] <= rect[3])
    ci = np.nonzero(cand)[0]
    if not len(ci):
        return []
    ends = np.unique(ev[ci].reshape(-1))
    nv = np.zeros(len(xy), dtype=bool)
    nv[ends] = bank.near(xy[ends])
    mid = bank.near((a[ci] + b[ci]) / 2.0)
    cut = nv[ev[ci, 0]] | nv[ev[ci, 1]] | mid
    return [edges[i] for i in ci[cut].tolist()]


def _subdivide_level(bms, bank, sub_m, rect):
    """One level: decide, triangulate n-gons at cut edges, promote interior edges of 2-cut triangles, halve.
    Returns the number of edges halved."""
    import bmesh
    of, members, canon = _seam_points(bms, rect)
    total = 0
    for k, bm in enumerate(bms):
        canon_xy = {vi: canon[g] for vi, g in of[k].items()}
        cut = _cut_edges(bm, bank, sub_m, rect, canon_xy)
        for _ in range(4):
            ngons = {f for e in cut for f in e.link_faces if len(f.verts) > 3}
            if not ngons:
                break
            bmesh.ops.triangulate(bm, faces=sorted(ngons, key=lambda f: f.index))
            cut = _cut_edges(bm, bank, sub_m, rect, canon_xy)   # no new vertices: the indices still hold
        if not cut:
            continue
        cut_set = set(cut)
        grew = True
        while grew:   # a triangle with two halved edges gets its third (interior) edge halved too: 1 -> 4
            grew = False
            for f in {f for e in list(cut_set) for f in e.link_faces}:
                if len(f.verts) != 3:
                    continue
                es = list(f.edges)
                if sum(e in cut_set for e in es) >= 2:
                    for e in es:
                        if e not in cut_set and len(e.link_faces) == 2:
                            cut_set.add(e)
                            grew = True
        cut = sorted(cut_set, key=lambda e: e.index)
        res = bmesh.ops.subdivide_edges(bm, edges=cut, cuts=1, use_grid_fill=True, use_single_edge=True)
        new_verts = [g for g in res["geom_inner"] + res["geom_split"] + res["geom"] if isinstance(g, bmesh.types.BMVert)]
        rest = {f for v in new_verts for f in v.link_faces if len(f.verts) > 3}
        if rest:
            bmesh.ops.triangulate(bm, faces=sorted(rest, key=lambda f: f.index))
        total += len(cut)
    return total


def _paint(me, verts, weight, channel, stone_face, normals):
    """Unity's paint on corners: lerp toward the channel by the weight (alpha kept), then with stone_face blue ->
    green on 35-60 deg slopes of the vertex normal. sRGB bytes, the values Unity reads."""
    attr = me.color_attributes.get("Col")
    if attr is None:
        attr = me.color_attributes.new("Col", "BYTE_COLOR", "CORNER")
        red = np.tile(np.array([1.0, 0.0, 0.0, 1.0], dtype=np.float32), len(attr.data))
        attr.data.foreach_set("color_srgb", red)
    nl = len(me.loops)
    if attr.domain == "CORNER":
        cv = np.empty(nl, dtype=np.int64)
        me.loops.foreach_get("vertex_index", cv)
    else:
        cv = np.arange(len(me.vertices))
    buf = np.empty(len(attr.data) * 4, dtype=np.float32)
    attr.data.foreach_get("color_srgb", buf)
    c = buf.reshape(-1, 4).astype(np.float64)
    w = np.zeros(len(me.vertices))
    w[verts] = weight
    wc = w[cv]
    sel = wc > PAINT_MIN
    c[sel, :3] += (channel[None, :] - c[sel, :3]) * wc[sel, None]
    if stone_face:
        slope = np.degrees(np.arccos(np.clip(normals[:, 2], -1.0, 1.0)))   # Vector3.Angle(normal, up)
        face = _smoothstep01(np.clip((slope - 35.0) / 25.0, 0.0, 1.0))
        amount = np.where(sel, c[:, 2] * face[cv], 0.0)
        c[:, 2] -= amount
        c[:, 1] += amount
    attr.data.foreach_set("color_srgb", np.clip(c, 0.0, 1.0).astype(np.float32).reshape(-1))
    return int(sel.sum())


def wall_ground(ctx, op, weld, seam_check, tj_check):
    """The op on the open .blend: returns its run record (shape_apply's format)."""
    import bpy
    import bmesh
    import shape_coords
    from mathutils.kdtree import KDTree
    t0 = time.time()
    s = settings(op)
    run = {"feature": op["id"], "targets": [], "seed": op.get("seed", 1), "wall": op.get("wall") or op["id"]}
    rect = _rect_of(op, ctx.frame, shape_coords)
    names = candidates(ctx, rect)
    objs = [bpy.data.objects[n] for n in names]
    for o in objs:
        if not np.allclose(np.array(o.matrix_world), np.eye(4), atol=1e-7):
            return dict(run, result=["CANCELLED"], error=f"{o.name} has an object transform (the op works in mesh coordinates)")
    if not objs:
        return dict(run, result=["FINISHED"], note="no course mesh under the wall")
    bank = Bank(op, lambda e, n: shape_coords.to_blend(e, n, ctx.frame), _surface(objs, rect))
    run["profile"] = bank.stats()
    if not run["profile"]["measured"]:
        return dict(run, result=["CANCELLED"], error="no course mesh under the wall's stations (nothing measured)")
    # the meshes with a vertex or an edge middle within reach (Unity: a vertex)
    work = []
    for o in objs:
        me = o.data
        co = _positions(o)
        inr = _in_rect(co[:, :2], rect)
        hit = bool(inr.any() and bank.near(co[inr, :2]).any())
        if not hit and len(me.edges):
            ev = np.empty(len(me.edges) * 2, dtype=np.int64)
            me.edges.foreach_get("vertices", ev)
            ev = ev.reshape(-1, 2)
            m = inr[ev[:, 0]] | inr[ev[:, 1]]
            hit = bool(m.any() and bank.near((co[ev[m, 0], :2] + co[ev[m, 1], :2]) / 2.0).any())
        if hit:
            work.append(o)
    if not work:
        return dict(run, result=["FINISHED"], note="no course mesh vertex within reach of the bank", seconds=round(time.time() - t0, 2))
    seams_before = seam_check(objs)
    bms, n0, custom = [], [], []
    for o in work:
        me = o.data
        vn = _vertex_normals(me)
        bm = bmesh.new()
        bm.from_mesh(me)
        layer = bm.verts.layers.float_vector.new(VN_LAYER)
        bm.verts.ensure_lookup_table()
        for v, n in zip(bm.verts, vn.tolist()):
            v[layer] = n
        bms.append(bm)
        n0.append(len(me.vertices))
        custom.append(bool(me.has_custom_normals))
    # 1. subdivide by edges, up to MAX_LEVELS
    levels, halved = 0, 0
    for _ in range(MAX_LEVELS):
        k = _subdivide_level(bms, bank, s["subdivideM"], rect)
        if not k:
            break
        levels += 1
        halved += k
    # 2. the points: shared boundary vertices are one point (canonical XY, mean height)
    of, members, canon = _seam_points(bms, rect)
    arrays = [_arrays(bm) for bm in bms]
    uid = []        # per mesh: point id of each vertex (-1 outside the wall's box)
    u_xy, u_z = [list(c) for c in canon], []
    for g, mem in enumerate(members):
        u_z.append(float(np.mean([arrays[k][0][vi, 2] for k, vi in mem])))
    for k, (co, _, _) in enumerate(arrays):
        ids = np.full(len(co), -1, dtype=np.int64)
        for vi, g in of[k].items():
            ids[vi] = g
        single = np.nonzero((ids < 0) & _in_rect(co[:, :2], rect))[0]
        ids[single] = np.arange(len(u_xy), len(u_xy) + len(single))
        u_xy += co[single, :2].tolist()
        u_z += co[single, 2].tolist()
        uid.append(ids)
    u_xy, u_z = np.array(u_xy, dtype=np.float64).reshape(-1, 2), np.array(u_z, dtype=np.float64)
    # 3. the shape at the points within reach
    near = bank.near(u_xy)
    move, stone = np.zeros(len(u_xy)), np.zeros(len(u_xy))
    ni = np.nonzero(near)[0]
    if len(ni):
        move[ni], stone[ni] = bank.shape(u_xy[ni], u_z[ni])
    new_z = u_z + move
    if bank.cliff and s["roundTopM"] > 0 and not s["paintOnly"]:
        kd = KDTree(len(u_xy))
        for i, (x, y) in enumerate(u_xy.tolist()):
            kd.insert((x, y, 0.0), i)
        kd.balance()
        new_z = bank.round_shoulders(u_xy, new_z, near, lambda i: [j for _, j, _ in kd.find_range((u_xy[i, 0], u_xy[i, 1], 0.0), 1.5)])
    moved_u = new_z != u_z
    # 4. heights into the meshes; which meshes change
    paint_mesh = [classify(o.name) in ("rough", "deep") for o in work]
    changed, per = [], {}
    raised = lowered = 0
    max_raise = max_lower = 0.0
    for k, (o, bm) in enumerate(zip(work, bms)):
        ids = uid[k]
        has = ids >= 0
        mv = np.zeros(len(ids), dtype=bool)
        mv[has] = moved_u[ids[has]]
        pv = np.zeros(len(ids), dtype=bool)
        if paint_mesh[k]:
            pv[has] = stone[ids[has]] > PAINT_MIN
        dz = np.zeros(len(ids))
        if mv.any():
            bm.verts.ensure_lookup_table()
            co = arrays[k][0]
            for vi in np.nonzero(mv)[0].tolist():
                z = float(new_z[ids[vi]])
                dz[vi] = z - co[vi, 2]
                v = bm.verts[vi]
                v.co.z = z
        r, lw = int((dz > MOVE_MIN_M - 1e-9).sum()), int((dz < -MOVE_MIN_M + 1e-9).sum())
        raised += r
        lowered += lw
        if r:
            max_raise = max(max_raise, float(dz.max()))
        if lw:
            max_lower = max(max_lower, float(-dz.min()))
        if mv.any() or pv.any():
            changed.append(k)
            per[o.name] = {"vertices": [n0[k], len(bm.verts)], "raised": r, "lowered": lw, "painted": int(pv.sum()),
                           "maxRaiseM": round(float(dz.max()), 3) if r else 0.0}
    # 5. normals of the moved points, their ring and the painted points, over every mesh that shares them
    ring = moved_u.copy()
    for k, (co, edges, ev) in enumerate(arrays):
        ids = uid[k]
        if not len(ev):
            continue
        a, b = ids[ev[:, 0]], ids[ev[:, 1]]
        ok = (a >= 0) & (b >= 0)
        a, b = a[ok], b[ok]
        ring[b[moved_u[a]]] = True
        ring[a[moved_u[b]]] = True
    want = ring | (stone > PAINT_MIN)
    acc = np.zeros((len(u_xy), 3))
    for k, bm in enumerate(bms):
        bm.normal_update()
        ids = uid[k]
        bm.verts.ensure_lookup_table()
        for vi in np.nonzero((ids >= 0))[0].tolist():
            u = ids[vi]
            if not want[u]:
                continue
            for f in bm.verts[vi].link_faces:
                acc[u] += np.array(f.normal[:]) * f.calc_area()
    ln = np.linalg.norm(acc, axis=1)
    u_n = np.where(ln[:, None] > 1e-12, acc / np.maximum(ln, 1e-12)[:, None], 0.0)
    # 6. write the changed meshes (the others are left as they were: not even read back)
    tj_before = tj_check([work[k].name for k in changed]) if changed else {}
    painted = 0
    for k in range(len(work)):
        bm = bms[k]
        if k not in changed:
            bm.free()
            continue
        o = work[k]
        me = o.data
        bm.to_mesh(me)
        bm.free()
        me.update()
        a = me.attributes.get(VN_LAYER)
        old = np.empty(len(me.vertices) * 3, dtype=np.float32)
        a.data.foreach_get("vector", old)
        me.attributes.remove(a)
        old = old.reshape(-1, 3).astype(np.float64)
        old /= np.maximum(np.linalg.norm(old, axis=1), 1e-12)[:, None]
        ids = uid[k]
        has = ids >= 0
        sel = np.zeros(len(ids), dtype=bool)
        sel[has] = want[ids[has]] & (np.linalg.norm(u_n[ids[has]], axis=1) > 0.5)
        final = old.copy()
        new = u_n[ids[sel]]
        flip = (new * old[sel]).sum(axis=1) < 0      # keep the side the faces had
        new[flip] *= -1
        final[sel] = new
        if paint_mesh[k]:
            pv = np.nonzero(has)[0]
            w = stone[ids[pv]]
            painted += _paint(me, pv, w, bank.channel, s["stoneFace"], final)
        if custom[k]:
            me.normals_split_custom_set_from_vertices([tuple(v) for v in final.tolist()])
        me.update()
    written = [work[k].name for k in changed]
    # 7. close T-junctions a neighbour left unsplit, then check
    weld_rep = weld(written) if written else None
    touched = sorted(set(written) | set((weld_rep or {}).get("objects", {})))
    after = [bpy.data.objects[n] for n in sorted(set(names) | set(touched)) if n in bpy.data.objects]
    seams_after = seam_check(after)
    tj_after = tj_check(written) if written else {}
    gaps = lambda r: sum(v.get("gaps", 0) for v in r.values())
    on_edge = lambda r: sum(v.get("onEdge", 0) for v in r.values())
    run.update(result=["FINISHED"], targets=touched, objects=per, levels=levels, edgesHalved=halved,
               verticesAdded=sum(len(bpy.data.objects[n].data.vertices) - p["vertices"][0] for n, p in per.items()),
               raised=raised, lowered=lowered, painted=painted, maxRaiseM=round(max_raise, 3), maxLowerM=round(max_lower, 3),
               weld=weld_rep, seams={"before": seams_before, "after": seams_after},
               tJunctions={"before": {"onEdge": on_edge(tj_before), "gaps": gaps(tj_before)},
                           "after": {"onEdge": on_edge(tj_after), "gaps": gaps(tj_after)}, "objects": tj_after},
               seconds=round(time.time() - t0, 2))
    print(f"[shape_apply] wall_ground {op['id']}: {len(written)} mesh(es) changed, +{run['verticesAdded']} vertices, "
          f"{raised} raised (max {run['maxRaiseM']} m), {lowered} lowered, {painted} corners painted, seams open "
          f"{seams_after['open']} (before {seams_before['open']}), {run['seconds']} s")
    if seams_after["open"] > seams_before["open"]:
        raise RuntimeError(f"wall_ground {op['id']}: {seams_after['open'] - seams_before['open']} seam(s) opened "
                           f"(max dz {seams_after['maxDz']} m)")
    if gaps(tj_after) > gaps(tj_before):
        raise RuntimeError(f"wall_ground {op['id']}: {gaps(tj_after) - gaps(tj_before)} T-junction gap(s) left after the weld")
    return run
