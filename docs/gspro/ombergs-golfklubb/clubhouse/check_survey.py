"""Read-only check of the procedural Omberg clubhouse-area buildings against lidar and the orthophoto.

Run inside Blender 4.5 on a built model (nothing is written except into --out):

  blender.exe -b <build>/omberg-clubhouse-authored.blend --python check_survey.py -- --out <folder>

Options after "--":
  --out DIR        output folder (images + survey-check.json), required
  --props FILE     props.json of the build (default: beside the opened .blend)
  --site FILE      site.json describing another site (see below). Without it the clubhouse site is
                   checked exactly as before (all the hard-coded defaults below).
  --data DIR       folder with lidar-crop.npz and ortho-2025.png (default <repo>/data/omberg-clubhouse,
                   or the site's data folder)
  --survey FILE    footprint source: survey.json (clubhouse default, beside this script) or an
                   osm-buildings.json GeoJSON list (overrides the site's "footprints")
  --focus E,N,H    extra zoomed pair of images around E,N with half-width H metres
                   (default 477805,6457674,14 = the main entrance foyer; site default: its "focus",
                   else the first asset)
  --dz             also add the instance dz. Off by default: layoutZ already holds the intended
                   base height, and Unity's dz only lifts the asset from the terrain under its
                   centre to that base (white connector: probe 106.69 + dz 0.511 = base 107.2)

site.json (all paths relative to the file itself; every key optional unless noted)
  name          label used in titles
  dataDir       folder with the lidar and orthos (default: the file's folder)
  crop          crop.json (default "crop.json"): bounds [e0,n0,e1,n1], ortho2025/ortho2023 {file, topLeftE,
                topLeftN, pixelM}. Instead of a file this may be the same object inline.
  origin        [E, N, zBase] of the review scene, i.e. where model.py puts the objects and which z the
                objects' z=0 is (default: the .blend's scene["golfmap_origin_epsg3006"])
  assetPrefix   check every mesh object whose name starts with this (e.g. "omberg_farm_")
  assets        explicit asset names, checked in addition to the prefix matches
  categories    props.json asset categories that carry roofs (default ["building"]); other assets are left
                out of the roof analysis and only get their transform compared with props.json
  groundAssets  names excluded from the roof analysis (only their transform is checked)
  osm           {asset: osm way id | [ids]}  (ids are the OSM way numbers, as strings or numbers)
  footprints    osm-buildings.json (GeoJSON features, properties.osm_id) or a survey.json
  sections      {asset: [roof-edge section ids]} (survey.json only)
  focus         "E,N,H" like --focus
  colors        {asset: [r,g,b]}; assets without one get distinct generated colours
  colourReference {material, boxes:[[e0,e1,n0,n1],...]}  neutral grey asphalt used to white-balance the
                ortho for the roof-colour check; without it roof colours are compared uncalibrated
With --site the report also gets "lidarFacts": per OSM footprint, independent of the model, the lidar
roof ridge/eave (absolute), ground, roof-return coverage and the unmapped >2 m roof clusters.

What it does
  1. Evaluates every building mesh in world space and rasterizes a model DSM at 0.25 m: the maximum
     z of the upward-facing triangles per cell, in absolute RH2000 metres (z + 109.09, plus dz with --dz). The
     "model footprint" of an asset is the part of that raster more than ROOF_MIN_H above local ground.
  2. Builds a lidar DSM at 0.5 m (max Z of class-1 points per cell) and a local ground surface from the
     class-2 points. Lidar "roof" points are class 1, more than ROOF_MIN_H above ground, and not green
     in the ortho (trees are class 1 too).
  3. Compares them per asset: |model - lidar| inside the model footprint (model sampled at the lidar
     point itself), lidar roof missing from the model, model roof with no lidar, ridge and eave heights.
  4. Draws ortho crops with outlines, signed height-difference maps, an overview and a focus view.

The heights are only as good as sparse (1-2 pts/m2) lidar. The ortho is not a true ortho: tall roofs lean
away from the image centre by up to about 1 m, so outline-vs-ortho offsets under 1 m on tall roofs are
not model errors.
"""
import argparse
import json
import math
import sys
from pathlib import Path

import numpy as np

try:
    import bpy
    import OpenImageIO as oiio
except ImportError:
    sys.exit("check_survey.py must run inside Blender: blender -b <build>.blend --python check_survey.py -- --out DIR")

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]

# ---- constants ------------------------------------------------------------------------------------
PX_E, PX_N, PX = 477750.0, 6457790.13, 0.16      # ortho top-left pixel origin and size (survey.py)
BOUNDS = (477750.0, 6457610.0, 477960.0, 6457790.0)
ROOF_MIN_H = 2.0          # m above local ground for a lidar point / model cell to count as roof
MODEL_CELL = 0.25
LIDAR_CELL = 0.5
OFF_TOL = 0.5             # |diff| above this counts as "off"
EDGE_TOL = 0.5            # lidar roof within this of the model footprint is not "missing"
NO_LIDAR_BLOCK = 2.0      # model roof is "without lidar" per block of this size with zero roof returns
Z_OFFSET_FALLBACK = 109.09
ASSETS = ["omberg_clubhouse", "omberg_white_connector", "omberg_north_lodge", "omberg_west_lodge",
          "omberg_east_lodge", "omberg_southeast_lodge", "omberg_padel_annex", "omberg_south_pavilion",
          "omberg_central_annex", "omberg_solar_shelter"]
GROUND_ASSETS = ["omberg_courtyard_paving"]
# survey.json features that describe each asset (OSM way ids; interpreted roof-edge section ids)
SURVEY_OF = {
    "omberg_clubhouse": (["687779192"], ["clubhouse-west-low", "clubhouse-east-tall"]),
    "omberg_white_connector": ([], ["white-diagonal-link", "white-straight-link"]),
    "omberg_north_lodge": (["687779185"], []),
    "omberg_west_lodge": (["687779186"], []),
    "omberg_east_lodge": (["687779187"], []),
    "omberg_southeast_lodge": (["1431566994"], []),
    "omberg_padel_annex": (["687779189"], []),
    "omberg_south_pavilion": (["687779190"], []),
    "omberg_central_annex": (["687779191"], []),
    "omberg_solar_shelter": (["1431573558"], []),
}
COLORS = {  # bright outline colours
    "omberg_clubhouse": (0, 255, 255), "omberg_white_connector": (255, 255, 255),
    "omberg_north_lodge": (255, 160, 0), "omberg_west_lodge": (255, 90, 255),
    "omberg_east_lodge": (0, 255, 120), "omberg_southeast_lodge": (255, 255, 0),
    "omberg_padel_annex": (120, 160, 255), "omberg_south_pavilion": (255, 120, 120),
    "omberg_central_annex": (200, 255, 0), "omberg_solar_shelter": (0, 200, 255)}
OSM_COLOR = (255, 230, 0)
TRACE_COLOR = (255, 0, 200)
OTHER_COLOR = (230, 230, 230)
TITLE = "OMBERG CLUBHOUSE AREA"
FOOTPRINT_LABEL = "survey.json"
COLOR_REFERENCE = dict(material="omberg_courtyard_asphalt", boxes=[
    (477800, 477860, 6457695, 6457760), (477860, 477930, 6457690, 6457735), (477834, 477860, 6457670, 6457700)])
VEG_ROUGHNESS = 0.8       # m, median 2 m-block std of roof-return heights above which an unmapped cluster is called vegetation
BIG_VIEW = (477775, 6457640, 477850, 6457715, 6)      # lidar-on-ortho validation view (e0, n0, e1, n1, k)
PALETTE = [(0, 255, 255), (255, 160, 0), (255, 90, 255), (0, 255, 120), (255, 255, 0), (120, 160, 255),
           (255, 120, 120), (200, 255, 0), (0, 200, 255), (255, 255, 255), (255, 60, 60), (160, 255, 200)]


def short(name):
    return name.replace("omberg_", "")


def rnd(x, n=2):
    if x is None:
        return None
    x = float(x)
    return None if math.isnan(x) or math.isinf(x) else round(x, n)


# ---- tiny 5x7 bitmap font (OpenImageIO in Blender has no FreeType) ---------------------------------
_FONT = """
A .###. #...# #...# ##### #...# #...# #...#
B ####. #...# #...# ####. #...# #...# ####.
C .###. #...# #.... #.... #.... #...# .###.
D ####. #...# #...# #...# #...# #...# ####.
E ##### #.... #.... ####. #.... #.... #####
F ##### #.... #.... ####. #.... #.... #....
G .###. #...# #.... #.### #...# #...# .###.
H #...# #...# #...# ##### #...# #...# #...#
I .###. ..#.. ..#.. ..#.. ..#.. ..#.. .###.
J ..### ...#. ...#. ...#. ...#. #..#. .##..
K #...# #..#. #.#.. ##... #.#.. #..#. #...#
L #.... #.... #.... #.... #.... #.... #####
M #...# ##.## #.#.# #.#.# #...# #...# #...#
N #...# ##..# #.#.# #..## #...# #...# #...#
O .###. #...# #...# #...# #...# #...# .###.
P ####. #...# #...# ####. #.... #.... #....
Q .###. #...# #...# #...# #.#.# #..#. .##.#
R ####. #...# #...# ####. #.#.. #..#. #...#
S .#### #.... #.... .###. ....# ....# ####.
T ##### ..#.. ..#.. ..#.. ..#.. ..#.. ..#..
U #...# #...# #...# #...# #...# #...# .###.
V #...# #...# #...# #...# #...# .#.#. ..#..
W #...# #...# #...# #.#.# #.#.# ##.## #...#
X #...# #...# .#.#. ..#.. .#.#. #...# #...#
Y #...# #...# .#.#. ..#.. ..#.. ..#.. ..#..
Z ##### ....# ...#. ..#.. .#... #.... #####
0 .###. #...# #..## #.#.# ##..# #...# .###.
1 ..#.. .##.. ..#.. ..#.. ..#.. ..#.. .###.
2 .###. #...# ....# ...#. ..#.. .#... #####
3 .###. #...# ....# ..##. ....# #...# .###.
4 ...#. ..##. .#.#. #..#. ##### ...#. ...#.
5 ##### #.... ####. ....# ....# #...# .###.
6 ..##. .#... #.... ####. #...# #...# .###.
7 ##### ....# ...#. ..#.. .#... .#... .#...
8 .###. #...# #...# .###. #...# #...# .###.
9 .###. #...# #...# .#### ....# ...#. .##..
. ..... ..... ..... ..... ..... .##.. .##..
, ..... ..... ..... ..... .##.. ..#.. .#...
: ..... .##.. .##.. ..... .##.. .##.. .....
- ..... ..... ..... ##### ..... ..... .....
+ ..... ..#.. ..#.. ##### ..#.. ..#.. .....
/ ....# ....# ...#. ..#.. .#... #.... #....
( ...#. ..#.. .#... .#... .#... ..#.. ...#.
) .#... ..#.. ...#. ...#. ...#. ..#.. .#...
% ##..# ##..# ...#. ..#.. .#... #..## #..##
= ..... ##### ..... ##### ..... ..... .....
< ...#. ..#.. .#... #.... .#... ..#.. ...#.
> .#... ..#.. ...#. ....# ...#. ..#.. .#...
_ ..... ..... ..... ..... ..... ..... #####
' ..#.. ..#.. .#... ..... ..... ..... .....
| ..#.. ..#.. ..#.. ..#.. ..#.. ..#.. ..#..
~ ..... .#... #.#.# ...#. ..... ..... .....
? .###. #...# ....# ...#. ..#.. ..... ..#..
"""
GLYPHS = {}
for _line in _FONT.strip().splitlines():
    _parts = _line.split()
    GLYPHS[_parts[0]] = np.array([[c == "#" for c in row] for row in _parts[1:]], dtype=bool)
GLYPHS[" "] = np.zeros((7, 5), dtype=bool)


def text_size(s, scale):
    return len(s) * 6 * scale, 7 * scale


def draw_text(img, x, y, s, scale=2, color=(255, 255, 255), outline=(0, 0, 0)):
    """Draw s with its top-left at (x, y); a 1-px outline keeps it legible on photographs."""
    x, y = int(x), int(y)
    for pass_color, offs in ((outline, [(-1, -1), (1, -1), (-1, 1), (1, 1), (0, -1), (0, 1), (-1, 0), (1, 0)]),
                             (color, [(0, 0)])):
        if pass_color is None:
            continue
        for i, ch in enumerate(s.upper()):
            g = GLYPHS.get(ch, GLYPHS["?"])
            ys, xs = np.nonzero(g)
            for dx, dy in offs:
                for yy, xx in zip(ys, xs):
                    px0 = x + (i * 6 + xx) * scale + dx
                    py0 = y + yy * scale + dy
                    x0c, y0c = max(px0, 0), max(py0, 0)
                    x1c, y1c = min(px0 + scale, img.shape[1]), min(py0 + scale, img.shape[0])
                    if x1c > x0c and y1c > y0c:
                        img[y0c:y1c, x0c:x1c] = pass_color


def fill_rect(img, x0, y0, x1, y1, color, alpha=1.0):
    x0, y0, x1, y1 = int(max(x0, 0)), int(max(y0, 0)), int(min(x1, img.shape[1])), int(min(y1, img.shape[0]))
    if x1 <= x0 or y1 <= y0:
        return
    reg = img[y0:y1, x0:x1].astype(np.float32)
    img[y0:y1, x0:x1] = (reg * (1 - alpha) + np.array(color, np.float32) * alpha).astype(np.uint8)


def draw_poly(img, pts, color, width=2, closed=True):
    """pts in pixel coordinates."""
    pts = list(pts)
    if closed:
        pts = pts + [pts[0]]
    t = width // 2
    for (xa, ya), (xb, yb) in zip(pts[:-1], pts[1:]):
        n = int(max(abs(xb - xa), abs(yb - ya))) * 2 + 2
        xs = np.linspace(xa, xb, n).round().astype(int)
        ys = np.linspace(ya, yb, n).round().astype(int)
        for dy in range(-t, width - t):
            for dx in range(-t, width - t):
                xx, yy = xs + dx, ys + dy
                ok = (xx >= 0) & (yy >= 0) & (xx < img.shape[1]) & (yy < img.shape[0])
                img[yy[ok], xx[ok]] = color


# ---- grids ----------------------------------------------------------------------------------------
class Grid:
    """Axis-aligned raster: row 0 is the north edge y1, cell centres at x0 + (i+.5)*cell."""

    def __init__(self, x0, y1, cell, nx, ny):
        self.x0, self.y1, self.cell, self.nx, self.ny = x0, y1, cell, nx, ny

    def idx(self, e, n):
        i = np.floor((np.asarray(e) - self.x0) / self.cell).astype(int)
        j = np.floor((self.y1 - np.asarray(n)) / self.cell).astype(int)
        return j, i, (i >= 0) & (i < self.nx) & (j >= 0) & (j < self.ny)

    def sample(self, arr, e, n, fill):
        j, i, ok = self.idx(e, n)
        out = np.full(np.shape(j), fill, dtype=arr.dtype)
        out[ok] = arr[j[ok], i[ok]]
        return out

    def centres(self):
        e = self.x0 + (np.arange(self.nx) + .5) * self.cell
        n = self.y1 - (np.arange(self.ny) + .5) * self.cell
        return e, n


def disc_offsets(r):
    return [(dy, dx) for dy in range(-r, r + 1) for dx in range(-r, r + 1) if dy * dy + dx * dx <= r * r + r * .5]


def dilate(mask, r):
    if r <= 0:
        return mask.copy()
    out = mask.copy()
    h, w = mask.shape
    for dy, dx in disc_offsets(r):
        ys0, ys1 = max(0, dy), min(h, h + dy)
        xs0, xs1 = max(0, dx), min(w, w + dx)
        out[ys0:ys1, xs0:xs1] |= mask[ys0 - dy:ys1 - dy, xs0 - dx:xs1 - dx]
    return out


def poly_mask(grid, polys):
    """Even-odd fill of EN polygons on grid (cell-centre test)."""
    e, n = grid.centres()
    E, N = np.meshgrid(e, n)
    inside = np.zeros(E.shape, bool)
    for poly in polys:
        p = np.asarray(poly, float)
        x1, y1 = p[:, 0], p[:, 1]
        x2, y2 = np.roll(x1, -1), np.roll(y1, -1)
        for a, b, c, d in zip(x1, y1, x2, y2):
            if b == d:
                continue
            cond = (b > N) != (d > N)
            xint = a + (N - b) * (c - a) / (d - b)
            inside ^= cond & (E < xint)
    return inside


def poly_area(poly):
    p = np.asarray(poly, float)
    return abs(float(np.sum(p[:, 0] * np.roll(p[:, 1], -1) - np.roll(p[:, 0], -1) * p[:, 1]))) / 2


def hull_area(pts):
    pts = sorted(set(map(tuple, np.round(pts, 3))))
    if len(pts) < 3:
        return 0.0

    def half(ps):
        h = []
        for p in ps:
            while len(h) >= 2 and (h[-1][0] - h[-2][0]) * (p[1] - h[-2][1]) - (h[-1][1] - h[-2][1]) * (p[0] - h[-2][0]) <= 0:
                h.pop()
            h.append(p)
        return h
    lo, up = half(pts), half(pts[::-1])
    return poly_area(lo[:-1] + up[:-1]) if len(lo) + len(up) > 4 else 0.0


# ---- model rasterization --------------------------------------------------------------------------
def raster_max(P, grid):
    """Max z of triangles P (T,3,3: E,N,Z) per cell of grid (cell-centre sampling); NaN where empty."""
    z = np.full(grid.nx * grid.ny, -np.inf)
    if len(P) == 0:
        return np.full((grid.ny, grid.nx), np.nan)
    A, B, C = P[:, 0], P[:, 1], P[:, 2]
    c = grid.cell
    i0 = np.ceil((P[:, :, 0].min(1) - grid.x0) / c - .5).astype(int)
    i1 = np.floor((P[:, :, 0].max(1) - grid.x0) / c - .5).astype(int)
    j0 = np.ceil((grid.y1 - P[:, :, 1].max(1)) / c - .5).astype(int)
    j1 = np.floor((grid.y1 - P[:, :, 1].min(1)) / c - .5).astype(int)
    i0, j0 = np.maximum(i0, 0), np.maximum(j0, 0)
    i1, j1 = np.minimum(i1, grid.nx - 1), np.minimum(j1, grid.ny - 1)
    w, h = i1 - i0 + 1, j1 - j0 + 1
    det = (B[:, 1] - C[:, 1]) * (A[:, 0] - C[:, 0]) + (C[:, 0] - B[:, 0]) * (A[:, 1] - C[:, 1])
    ok = (w > 0) & (h > 0) & (np.abs(det) > 1e-12)
    size = np.maximum(w, h)
    K = 1
    while True:
        sel = np.nonzero(ok & (size <= K) & (size > K // 2))[0] if K > 1 else np.nonzero(ok & (size <= 1))[0]
        if len(sel):
            step = max(1, 3_000_000 // (K * K))
            for s in range(0, len(sel), step):
                t = sel[s:s + step]
                I = i0[t, None, None] + np.arange(K)[None, :, None] + np.zeros((1, 1, K), int)
                J = j0[t, None, None] + np.arange(K)[None, None, :] + np.zeros((1, K, 1), int)
                valid = (I <= i1[t, None, None]) & (J <= j1[t, None, None])
                E = grid.x0 + (I + .5) * c
                N = grid.y1 - (J + .5) * c
                a, b, cc, d = A[t, None, None], B[t, None, None], C[t, None, None], det[t, None, None]
                l1 = ((b[..., 1] - cc[..., 1]) * (E - cc[..., 0]) + (cc[..., 0] - b[..., 0]) * (N - cc[..., 1])) / d
                l2 = ((cc[..., 1] - a[..., 1]) * (E - cc[..., 0]) + (a[..., 0] - cc[..., 0]) * (N - cc[..., 1])) / d
                l3 = 1 - l1 - l2
                inside = valid & (l1 >= -1e-9) & (l2 >= -1e-9) & (l3 >= -1e-9)
                zz = l1 * a[..., 2] + l2 * b[..., 2] + l3 * cc[..., 2]
                np.maximum.at(z, (J * grid.nx + I)[inside], zz[inside])
        if K >= size.max():
            break
        K = K * 2 if K > 1 else 2
    z = z.reshape(grid.ny, grid.nx)
    z[np.isinf(z)] = np.nan
    return z


def mesh_triangles(ob, dg, shift):
    """Upward-facing triangles (T,3,3) of the evaluated object in RH2000/EPSG:3006 (shift = origin E, N, z offset)."""
    ev = ob.evaluated_get(dg)
    me = ev.to_mesh()
    try:
        me.calc_loop_triangles()
        nv = len(me.vertices)
        co = np.empty(nv * 3)
        me.vertices.foreach_get("co", co)
        co = co.reshape(-1, 3)
        M = np.array(ob.matrix_world)
        w = co @ M[:3, :3].T + M[:3, 3]
        tr = np.empty(len(me.loop_triangles) * 3, dtype=np.int64)
        me.loop_triangles.foreach_get("vertices", tr)
        tr = tr.reshape(-1, 3)
        P = w[tr]
        mi = np.empty(len(me.loop_triangles), dtype=np.int64)
        me.loop_triangles.foreach_get("material_index", mi)
        mnames = np.array([(m.name if m else "") for m in me.materials] + [""])
        mats = mnames[np.minimum(mi, len(mnames) - 1)]
    finally:
        ev.to_mesh_clear()
    P = P.copy()
    P += shift
    cross_z = (P[:, 1, 0] - P[:, 0, 0]) * (P[:, 2, 1] - P[:, 0, 1]) - (P[:, 1, 1] - P[:, 0, 1]) * (P[:, 2, 0] - P[:, 0, 0])
    e1, e2 = P[:, 1] - P[:, 0], P[:, 2] - P[:, 0]
    norm = np.linalg.norm(np.cross(e1, e2), axis=1)
    up = cross_z > 0.02 * norm
    keep = up & (norm > 1e-12)
    return P[keep], len(P), mats[keep]


# ---- lidar ----------------------------------------------------------------------------------------
def ground_surface(pts, bounds, cell=2.0):
    """Class-2 median per 2 m cell, holes filled from neighbours, 3x3 smoothed. Returns (Grid, array)."""
    e0, n0, e1, n1 = bounds
    nx, ny = int(math.ceil((e1 - e0) / cell)), int(math.ceil((n1 - n0) / cell))
    g = Grid(e0, n1, cell, nx, ny)
    gp = pts[pts[:, 3] == 2]
    j, i, ok = g.idx(gp[:, 0], gp[:, 1])
    flat = (j * nx + i)[ok]
    zs = gp[ok, 2]
    order = np.argsort(flat, kind="stable")
    flat, zs = flat[order], zs[order]
    val = np.full(nx * ny, np.nan)
    starts = np.nonzero(np.r_[True, flat[1:] != flat[:-1]])[0]
    for a, b in zip(starts, np.r_[starts[1:], len(flat)]):
        val[flat[a]] = np.median(zs[a:b])
    val = val.reshape(ny, nx)
    known = ~np.isnan(val)
    while not known.all():
        pad = np.pad(np.where(known, val, 0.0), 1)
        cnt = np.pad(known.astype(float), 1)
        s = sum(pad[1 + dy:1 + dy + ny, 1 + dx:1 + dx + nx] for dy in (-1, 0, 1) for dx in (-1, 0, 1))
        c = sum(cnt[1 + dy:1 + dy + ny, 1 + dx:1 + dx + nx] for dy in (-1, 0, 1) for dx in (-1, 0, 1))
        new = (c > 0) & ~known
        if not new.any():
            break
        val[new] = s[new] / c[new]
        known |= new
    pad = np.pad(val, 1, mode="edge")
    val = sum(pad[1 + dy:1 + dy + ny, 1 + dx:1 + dx + nx] for dy in (-1, 0, 1) for dx in (-1, 0, 1)) / 9
    return g, val


def bilinear(grid, arr, e, n):
    fx = (np.asarray(e) - grid.x0) / grid.cell - .5
    fy = (grid.y1 - np.asarray(n)) / grid.cell - .5
    fx = np.clip(fx, 0, grid.nx - 1.001)
    fy = np.clip(fy, 0, grid.ny - 1.001)
    i, j = np.floor(fx).astype(int), np.floor(fy).astype(int)
    tx, ty = fx - i, fy - j
    return (arr[j, i] * (1 - tx) * (1 - ty) + arr[j, i + 1] * tx * (1 - ty)
            + arr[j + 1, i] * (1 - tx) * ty + arr[j + 1, i + 1] * tx * ty)


def clusters(cells, link=3):
    """Group integer cells (N,2) whose Chebyshev distance <= link. Returns list of index arrays."""
    pos = {tuple(c): k for k, c in enumerate(cells)}
    seen = np.zeros(len(cells), bool)
    out = []
    for s in range(len(cells)):
        if seen[s]:
            continue
        stack, comp = [s], []
        seen[s] = True
        while stack:
            k = stack.pop()
            comp.append(k)
            ci, cj = cells[k]
            for dj in range(-link, link + 1):
                for di in range(-link, link + 1):
                    q = pos.get((ci + di, cj + dj))
                    if q is not None and not seen[q]:
                        seen[q] = True
                        stack.append(q)
        out.append(np.array(comp))
    return out


# ---- images ---------------------------------------------------------------------------------------
def read_rgb(path):
    b = oiio.ImageBuf(str(path))
    a = np.array(b.get_pixels(oiio.UINT8))
    if a.shape[2] > 3:
        a = a[:, :, :3]
    return np.ascontiguousarray(a)


def write_rgb(path, a):
    h, w, _ = a.shape
    o = oiio.ImageBuf(oiio.ImageSpec(w, h, 3, oiio.UINT8))
    o.set_pixels(oiio.ROI(0, w, 0, h, 0, 1, 0, 3), np.ascontiguousarray(a))
    if not o.write(str(path)):
        raise RuntimeError("cannot write %s: %s" % (path, o.geterror()))


class View:
    """A crop of the ortho (snapped to its pixel grid) magnified by integer k."""

    def __init__(self, ortho, e0, n0, e1, n1, k, dim=1.0):
        H, W, _ = ortho.shape
        c0 = max(0, int(math.floor((e0 - PX_E) / PX)))
        c1 = min(W, int(math.ceil((e1 - PX_E) / PX)))
        r0 = max(0, int(math.floor((PX_N - n1) / PX)))
        r1 = min(H, int(math.ceil((PX_N - n0) / PX)))
        crop = ortho[r0:r1, c0:c1].astype(np.float32)
        if dim != 1.0:
            grey = crop.mean(2, keepdims=True)
            crop = (crop * .5 + grey * .5) * dim
        self.img = np.repeat(np.repeat(crop, k, 0), k, 1).clip(0, 255).astype(np.uint8)
        self.k = k
        self.grid = Grid(PX_E + c0 * PX, PX_N - r0 * PX, PX / k, self.img.shape[1], self.img.shape[0])

    def px(self, e, n):
        return (np.asarray(e) - self.grid.x0) / self.grid.cell, (self.grid.y1 - np.asarray(n)) / self.grid.cell

    def poly(self, poly, color, width=2, closed=True):
        x, y = self.px(np.asarray(poly)[:, 0], np.asarray(poly)[:, 1])
        draw_poly(self.img, list(zip(x, y)), color, width, closed)

    def mask_outline(self, grid, mask, color, width=2):
        """Outline of a boolean raster on another grid, drawn at this view's resolution."""
        e, n = self.grid.centres()
        E, N = np.meshgrid(e, n)
        j, i, ok = grid.idx(E, N)
        m = np.zeros(E.shape, bool)
        m[ok] = mask[j[ok], i[ok]]
        if not m.any():
            return
        pad = np.pad(m, 1)
        inner = pad[1:-1, 1:-1] & pad[:-2, 1:-1] & pad[2:, 1:-1] & pad[1:-1, :-2] & pad[1:-1, 2:]
        edge = m & ~inner
        if width > 1:
            edge = dilate(edge, width // 2)
        self.img[edge] = color

    def square(self, e, n, size_m, color, alpha=1.0, border=None):
        x, y = self.px(e, n)
        s = size_m / self.grid.cell / 2
        for xx, yy, c in zip(np.atleast_1d(x), np.atleast_1d(y), np.atleast_2d(color) if np.ndim(color) > 1 else [color] * np.size(x)):
            fill_rect(self.img, xx - s, yy - s, xx + s, yy + s, c, alpha)
            if border is not None:
                draw_poly(self.img, [(xx - s, yy - s), (xx + s, yy - s), (xx + s, yy + s), (xx - s, yy + s)], border, 1)


def diff_color(d, scale=1.5):
    t = np.clip(np.asarray(d, float) / scale, -1, 1)
    blue, red = np.array([30, 90, 255.]), np.array([255, 40, 30.])
    target = np.where(t[..., None] < 0, blue, red)
    return (255 * (1 - np.abs(t[..., None])) + target * np.abs(t[..., None])).astype(np.uint8)


def height_color(z, lo, hi):
    t = np.clip((np.asarray(z, float) - lo) / max(hi - lo, 1e-6), 0, 1)
    stops = np.array([[40, 30, 140], [30, 150, 255], [60, 230, 90], [255, 240, 40], [255, 70, 30]], float)
    pos = t * (len(stops) - 1)
    k = np.minimum(pos.astype(int), len(stops) - 2)
    f = (pos - k)[..., None]
    return (stops[k] * (1 - f) + stops[k + 1] * f).astype(np.uint8)


def finish(view, title, legend, path, colorbar=None, scale=2):
    """Add a title banner and a legend box, save."""
    img = view.img
    ts = scale + 1
    while text_size(title, ts)[0] + 20 > img.shape[1] and ts > 1:
        ts -= 1
    tw, th = text_size(title, ts)
    banner = np.zeros((th + 14, max(img.shape[1], tw + 20), 3), np.uint8)
    banner[:] = (20, 20, 24)
    draw_text(banner, 10, 7, title, ts, (255, 255, 255), None)
    out = np.zeros((banner.shape[0] + img.shape[0], banner.shape[1], 3), np.uint8)
    out[:banner.shape[0]] = banner
    out[banner.shape[0]:banner.shape[0] + img.shape[0], :img.shape[1]] = img
    body = out[banner.shape[0]:banner.shape[0] + img.shape[0], :img.shape[1]]
    lw = max(text_size(t, scale)[0] for _, t in legend) + 44 if legend else 0
    lh = len(legend) * (7 * scale + 8) + 10
    if colorbar:
        lh += 7 * scale + 54
        lw = max(lw, 250)
    if legend or colorbar:
        x0, y0 = 8, max(8, body.shape[0] - lh - 8)
        fill_rect(body, x0, y0, x0 + lw, y0 + lh, (0, 0, 0), .72)
        y = y0 + 8
        for col, t in legend:
            fill_rect(body, x0 + 8, y, x0 + 28, y + 7 * scale, col, 1.0)
            draw_text(body, x0 + 36, y, t, scale, (255, 255, 255), None)
            y += 7 * scale + 8
        if colorbar:
            lo, hi, fn, label = colorbar
            draw_text(body, x0 + 8, y, label, scale, (255, 255, 255), None)
            y += 7 * scale + 6
            for q in range(234):
                v = lo + (hi - lo) * q / 233
                body[y:y + 16, x0 + 8 + q] = fn(np.array(v))
            for v, lab in zip(np.linspace(lo, hi, 5), ["%+.1f" % v if lo < 0 else "%.1f" % v for v in np.linspace(lo, hi, 5)]):
                xx = int(x0 + 8 + (v - lo) / (hi - lo) * 233)
                body[y + 16:y + 21, xx] = 255
                draw_text(body, xx - len(lab) * 3 * 1, y + 23, lab, 1, (255, 255, 255), None)
    write_rgb(path, out)



# ---- roof colours ---------------------------------------------------------------------------------
def srgb_to_lin(c):
    c = np.asarray(c, float) / 255.0
    return np.where(c <= .04045, c / 12.92, ((c + .055) / 1.055) ** 2.4)


def lin_to_srgb(l):
    l = np.clip(np.asarray(l, float), 0, 1)
    return 255 * np.where(l <= .0031308, 12.92 * l, 1.055 * l ** (1 / 2.4) - .055)


def to_lab(srgb):
    l = srgb_to_lin(srgb)
    M = np.array([[.4124564, .3575761, .1804375], [.2126729, .7151522, .0721750], [.0193339, .1191920, .9503041]])
    xyz = (l @ M.T) / np.array([.95047, 1.0, 1.08883])
    f = np.where(xyz > .008856, np.cbrt(xyz), 7.787 * xyz + 16 / 116)
    return np.array([116 * f[..., 1] - 16, 500 * (f[..., 0] - f[..., 1]), 200 * (f[..., 1] - f[..., 2])])


def colour_diff(a, b):
    """CIE76 dE plus dL, dC (chroma) and dh (hue angle, degrees) of a - b, both sRGB 0-255."""
    la, lb = to_lab(a), to_lab(b)
    ca, cb = math.hypot(la[1], la[2]), math.hypot(lb[1], lb[2])
    dh = (math.degrees(math.atan2(la[2], la[1])) - math.degrees(math.atan2(lb[2], lb[1])) + 180) % 360 - 180
    return dict(dE76=rnd(np.linalg.norm(la - lb), 1), dL=rnd(la[0] - lb[0], 1), dChroma=rnd(ca - cb, 1),
                dHueDeg=rnd(dh if min(ca, cb) > 3 else 0, 0))


def texture_mean_linear(path):
    px = read_rgb(path).reshape(-1, 3)
    return srgb_to_lin(px).mean(0)


def fit_sun(normals, lum, weights):
    """Fit Y = a*max(0,n.s)+b over normals (K,3) by grid search on the sun direction."""
    def trial(az, el):
        s_ = np.array([math.cos(math.radians(el)) * math.sin(math.radians(az)), math.cos(math.radians(el)) * math.cos(math.radians(az)),
                       math.sin(math.radians(el))])
        x = np.maximum(0, normals @ s_)
        A = np.column_stack((x, np.ones(len(x)))) * np.sqrt(weights)[:, None]
        coef = np.linalg.lstsq(A, lum * np.sqrt(weights), rcond=None)[0]
        if coef[1] < 0:
            coef = np.array([float(np.sum(A[:, 0] * lum * np.sqrt(weights)) / np.sum(A[:, 0] ** 2)), 0.0])
        res = lum * np.sqrt(weights) - A @ coef
        return float((res ** 2).sum()), coef, s_
    best = None
    for az in range(0, 360, 5):
        for el in range(15, 65, 5):
            r = trial(az, el)
            if best is None or r[0] < best[0][0]:
                best = (r, az, el)
    az0, el0 = best[1], best[2]
    for az in range(az0 - 5, az0 + 6):
        for el in range(max(10, el0 - 5), min(66, el0 + 6)):
            r = trial(az, el)
            if r[0] < best[0][0]:
                best = (r, az, el)
    (sse, coef, s_), az, el = best
    mean = np.average(lum, weights=weights)
    sst = float((weights * (lum - mean) ** 2).sum())
    return dict(azimuthDeg=az, elevationDeg=el, a=float(coef[0]), b=float(coef[1]), r2=1 - sse / max(sst, 1e-12), sun=s_)


def colour_check(names, tris, mg, owned, dsm, union, ref_cells, orthos, props, tex_dir, out, report, ref_name="omberg_courtyard_asphalt"):
    """Median ortho roof colour vs. the model's exported colour, per asset and roof material."""
    mats_tbl = props["materials"]
    tex_cache = {}

    def model_lin(mat):
        d = mats_tbl.get(mat)
        if d is None:
            return None
        base = np.array(d["color"], float)
        if d.get("albedo"):
            if d["albedo"] not in tex_cache:
                tex_cache[d["albedo"]] = texture_mean_linear(tex_dir / d["albedo"])
            return tex_cache[d["albedo"]] * base, tex_cache[d["albedo"]]
        return base, None

    def erode(m, r):
        return ~dilate(~m, r)

    def clean_mask(pix, mat):
        """Drop saturated pixels, cast shadows and (terracotta only) blue-grey pixels such as real solar panels the model lacks."""
        ok = pix.max(1) < 250
        if mat.endswith("terracotta"):
            ok &= pix[:, 0] > pix[:, 2] + 10
        lum = pix.mean(1)
        if ok.any():
            ok &= lum > .55 * np.median(lum[ok])
        return ok

    # --- roof surfaces per (asset, material)
    groups = []
    for name in names:
        P, mats = tris[name]
        solar = np.zeros(owned[name].shape, bool)
        is_solar = np.array([m.endswith("solar_panel") for m in mats], bool)
        if is_solar.any():
            solar = dilate(~np.isnan(raster_max(P[is_solar], mg)), 2)
        z = dsm[name]
        pad = np.pad(z, 1, constant_values=np.nan)
        lap = (pad[:-2, 1:-1] + pad[2:, 1:-1] + pad[1:-1, :-2] + pad[1:-1, 2:] - 4 * z)
        gx = (pad[1:-1, 2:] - pad[1:-1, :-2]) / (2 * MODEL_CELL)
        gy = -(pad[2:, 1:-1] - pad[:-2, 1:-1]) / (2 * MODEL_CELL)
        planar = np.isfinite(lap) & (np.abs(lap) < .03) & np.isfinite(gx) & np.isfinite(gy)
        for m in sorted(set(mats)):
            if m == "" or m.endswith("solar_panel"):
                continue
            dm = raster_max(P[mats == m], mg)
            top = ~np.isnan(dm) & (dm >= z - .03)
            mask = erode(owned[name] & top & ~solar, 2)        # ~0.5 m off every edge, solar panels and other materials
            area = mask.sum() * MODEL_CELL ** 2
            if area < 4:
                continue
            jj, ii = np.nonzero(mask & planar)
            if len(jj) < 30:
                continue
            e = mg.x0 + (ii + .5) * MODEL_CELL
            n = mg.y1 - (jj + .5) * MODEL_CELL
            nv = np.column_stack((-gx[jj, ii], -gy[jj, ii], np.ones(len(jj))))
            nv /= np.linalg.norm(nv, axis=1)[:, None]
            groups.append(dict(asset=name, material=m, area=area, e=e, n=n, nv=nv))

    def sample(img, e, n):
        x = np.clip(((e - PX_E) / PX).astype(int), 0, img.shape[1] - 1)
        y = np.clip(((PX_N - n) / PX).astype(int), 0, img.shape[0] - 1)
        return img[y, x].astype(float)

    # --- neutral reference: car-park / drive asphalt (grey, no building or object near)
    if ref_cells is not None:
        asph_model_lin = np.array(mats_tbl[ref_name]["color"], float)
        y_ref = float(asph_model_lin @ np.array([.2126, .7152, .0722]))
        neutral = np.full(3, y_ref)                          # a neutral grey of the model asphalt's luminance
        ref_e, ref_n = ref_cells
        cal = dict(reference="grey asphalt of the car park and drives (low-saturation mid-grey ortho pixels away from buildings, cars and trees; %d candidate cells)" % len(ref_e),
                   assumption="that asphalt is a NEUTRAL grey with the same albedo as the model's courtyard asphalt (linear %s, sRGB %s, Y=%.3f); "
                              "so white balance and exposure are set to make it so. The absolute lightness of every suggestion rests on that albedo, +-30 %% is realistic." % (
                                  [rnd(v, 4) for v in asph_model_lin], [int(round(v)) for v in lin_to_srgb(asph_model_lin)], y_ref),
                   note="the courtyard itself is NOT usable as a neutral: in the ortho it is red-brown brick-like paving.", years={})
    else:
        cal = dict(reference=None, note="no colourReference in the site file: the ortho is NOT white-balanced; raw ortho colours (sun-shade corrected only "
                                        "where terracotta roofs allow a fit) are compared with the model, so a global cast/exposure of the ortho remains in dL/dE.", years={})
    year_info = {}
    for year, img in orthos.items():
        if ref_cells is not None:
            rp = sample(img, ref_e, ref_n)
            okp = (rp.max(1) - rp.min(1) < .18 * rp.max(1)) & (rp.mean(1) > 70) & (rp.mean(1) < 160)
            a_pix = np.median(rp[okp], axis=0)
            a_lin = srgb_to_lin(a_pix)
            k = a_lin / neutral                                # per-channel white balance x exposure x horizontal illumination
        else:
            okp = np.zeros(0, bool)
            a_pix = np.zeros(3)
            k = np.ones(3)
        # sun direction from the terracotta tile roofs (same material, many orientations)
        tn, tl, tw = [], [], []
        for g in groups:
            if not g["material"].endswith("terracotta"):
                continue
            pix_ = sample(img, g["e"], g["n"])
            okc = clean_mask(pix_, g["material"])
            Y = srgb_to_lin(pix_) @ np.array([.2126, .7152, .0722])
            keys = np.round(g["nv"][:, :2] * 12).astype(int)
            for key in {tuple(q) for q in keys}:
                sel = (keys[:, 0] == key[0]) & (keys[:, 1] == key[1]) & okc
                if sel.sum() >= 25:
                    tn.append(g["nv"][sel].mean(0))
                    tl.append(np.median(Y[sel]))
                    tw.append(sel.sum())
        sun = None
        if len(tn) >= 6:
            tn = np.array(tn)
            tn /= np.linalg.norm(tn, axis=1)[:, None]
            sun = fit_sun(tn, np.array(tl), np.array(tw, float))
            if sun["a"] <= 0 or sun["r2"] < .5:
                sun["rejected"] = True
        use_sun = sun is not None and not sun.get("rejected")
        year_info[year] = dict(k=k, sun=sun if use_sun else None)
        cal["years"][year] = dict(asphaltOrthoMedianSrgb=[int(v) for v in a_pix] if ref_cells is not None else None, asphaltPixels=int(okp.sum()),
                                  asphaltOrthoVsModelRatioLinear=[rnd(v, 3) for v in k],
                                  sunFit=None if sun is None else dict(azimuthDeg=sun["azimuthDeg"], elevationDeg=sun["elevationDeg"],
                                                                      r2=rnd(sun["r2"], 3), aOverB=rnd(sun["a"] / max(sun["b"], 1e-9), 2),
                                                                      binsUsed=len(tn), bins=[[rnd(n_[0], 2), rnd(n_[1], 2), rnd(l_, 3), int(w_)] for n_, l_, w_ in zip(np.atleast_2d(tn), tl, tw)][:24], applied=bool(use_sun), groups="omberg_terracotta"))
    # --- rows
    rows = []
    for g in groups:
        mdl = model_lin(g["material"])
        if mdl is None:
            continue
        lin, albedo = mdl
        row = dict(asset=g["asset"], material=g["material"], areaM2=rnd(g["area"], 1), cells=int(len(g["e"])),
                   modelLinear=[rnd(v, 4) for v in lin], modelSrgb=[int(round(v)) for v in lin_to_srgb(lin)],
                   textureMeanLinear=None if albedo is None else [rnd(v, 4) for v in albedo],
                   materialColourField=[rnd(v, 4) for v in mats_tbl[g["material"]]["color"]], ortho={})
        for year, img in orthos.items():
            pix_all = sample(img, g["e"], g["n"])
            sat_pct = 100 * float((pix_all.max(1) >= 250).mean())
            okc = clean_mask(pix_all, g["material"])
            pix = pix_all[okc]
            nvc = g["nv"][okc]
            lin_px = srgb_to_lin(pix)
            ki = year_info[year]
            if ki["sun"]:
                s = ki["sun"]
                E = s["a"] * np.maximum(0, nvc @ s["sun"]) + s["b"]
                Eh = s["a"] * s["sun"][2] + s["b"]
                ok = E > .25 * Eh
                lin_px = lin_px[ok] * (Eh / E[ok])[:, None]
            alb = np.median(lin_px / ki["k"], axis=0)
            raw = np.median(pix, axis=0)
            calc = lin_to_srgb(alb)
            row["ortho"][year] = dict(pixelsUsed=int(len(lin_px)), saturatedPct=rnd(sat_pct, 1),
                                      rawP25P75Srgb=[[int(v) for v in np.percentile(pix, 25, axis=0)], [int(v) for v in np.percentile(pix, 75, axis=0)]],
                                      rawMedianSrgb=[int(v) for v in raw], calibratedSrgb=[int(round(v)) for v in calc],
                                      calibratedLinear=[rnd(v, 4) for v in alb],
                                      rawVsModel=colour_diff(raw, lin_to_srgb(lin)), calibratedVsModel=colour_diff(calc, lin_to_srgb(lin)))
        c25 = np.array(row["ortho"]["2025"]["calibratedLinear"])
        if albedo is not None:
            tint = c25 / np.maximum(albedo, 1e-4)
            row["suggested"] = dict(srgb=[int(round(v)) for v in lin_to_srgb(c25)], tintLinear=[rnd(v, 3) for v in tint],
                                    tintExceeds1=bool(tint.max() > 1.0),
                                    note="new 'color' multiplier for the textured material (linear, as in props.json); >1 means the albedo texture itself must be brighter")
        else:
            row["suggested"] = dict(srgb=[int(round(v)) for v in lin_to_srgb(c25)], colourLinear=[rnd(v, 4) for v in c25])
        rows.append(row)
    # --- per material summary (area weighted, linear)
    summary = {}
    for m in sorted({r["material"] for r in rows}):
        rr = [r for r in rows if r["material"] == m]
        w = np.array([r["areaM2"] for r in rr])
        c25 = np.average([r["ortho"]["2025"]["calibratedLinear"] for r in rr], axis=0, weights=w)
        c23 = np.average([r["ortho"]["2023"]["calibratedLinear"] for r in rr], axis=0, weights=w) if "2023" in rr[0]["ortho"] else None
        mdl = np.array(rr[0]["modelLinear"])
        item = dict(areaM2=rnd(w.sum(), 1), assets=[short(r["asset"]) for r in rr], modelSrgb=rr[0]["modelSrgb"],
                    orthoCalibratedSrgb2025=[int(round(v)) for v in lin_to_srgb(c25)],
                    vsModel=colour_diff(lin_to_srgb(c25), lin_to_srgb(mdl)))
        if c23 is not None:
            item["orthoCalibratedSrgb2023"] = [int(round(v)) for v in lin_to_srgb(c23)]
        alb = rr[0]["textureMeanLinear"]
        if alb is not None:
            t = c25 / np.maximum(np.array(alb), 1e-4)
            item["suggestedTintLinear"] = [rnd(v, 3) for v in t]
            item["tintExceeds1"] = bool(t.max() > 1)
        item["suggestedSrgb"] = [int(round(v)) for v in lin_to_srgb(c25)]
        summary[m] = item
    report["roofColours"] = dict(
        method="Median sRGB of ortho pixels inside each roof material's surface (model raster 0.25 m, eroded 0.5 m, solar panels and other materials left out, planar cells only). "
               "Calibrated = per-channel linear gain from the courtyard asphalt (ortho vs model colour) and, where the fit is good, a sun-shading correction "
               "fitted on the terracotta roofs (Y = a*max(0,n.s)+b over roof slopes) so sloped roofs are compared as if horizontal like the asphalt. "
               "Model colour = mean linear albedo texture x props.json colour (export tints and linearisation already applied), shown as sRGB. dE is CIE76; positive dL = ortho brighter than model.",
        calibration=cal, rows=rows, perMaterial=summary)

    # --- swatch image
    sc = 2
    rowh = 7 * sc + 22
    W = 560 + 5 * 120 + 10
    img = np.full((60 + rowh * len(rows) + 30, W, 3), 32, np.uint8)
    draw_text(img, 10, 8, "ROOF COLOUR: ORTHO SWATCH NEXT TO MODEL SWATCH (SRGB)", 2, (255, 255, 255), None)
    for q, lab in enumerate(["O2025 RAW", "O2025 CAL", "O2023 CAL", "MODEL EXPORT", "SUGGESTED"]):
        draw_text(img, 564 + q * 120, 34, lab, 1, (200, 200, 200), None)
    y = 50
    for r in rows:
        c = r["ortho"]["2025"]["calibratedVsModel"]
        draw_text(img, 10, y + 4, "%s / %s" % (short(r["asset"]), r["material"].replace("omberg_", "")), sc, (255, 255, 255), None)
        draw_text(img, 10, y + 4 + 7 * sc + 3, "%s M2   DE %s  DL %+.0f  DC %+.0f  DH %+.0f" % (r["areaM2"], c["dE76"], c["dL"], c["dChroma"], c["dHueDeg"]), 1, (255, 220, 120), None)
        sw = [r["ortho"]["2025"]["rawMedianSrgb"], r["ortho"]["2025"]["calibratedSrgb"], r["ortho"].get("2023", r["ortho"]["2025"])["calibratedSrgb"], r["modelSrgb"], r["suggested"]["srgb"]]
        for q, col in enumerate(sw):
            img[y:y + rowh - 4, 560 + q * 120:560 + q * 120 + 112] = np.clip(col, 0, 255)
            draw_text(img, 564 + q * 120, y + 4, "%d,%d,%d" % tuple(int(v) for v in col), 1, (255, 255, 255), (0, 0, 0))
        y += rowh
    draw_text(img, 10, y + 8, ("CAL = WHITE-BALANCED ON GREY CAR-PARK ASPHALT (ASSUMED NEUTRAL, = MODEL ASPHALT LUMINANCE) AND SUN-SHADE CORRECTED. MODEL = MEAN ALBEDO TEXTURE x EXPORTED COLOUR." if ref_cells is not None
                               else "CAL = NOT WHITE-BALANCED (NO NEUTRAL REFERENCE FOR THIS SITE), ONLY SUN-SHADE CORRECTED WHERE POSSIBLE. MODEL = MEAN ALBEDO TEXTURE x EXPORTED COLOUR."), 1, (200, 200, 200), None)
    write_rgb(out / "roof-colour-swatches.png", img[:y + 30])
    return rows, summary



# ---- site configuration ---------------------------------------------------------------------------
def load_site(path, scene_origin):
    """Read a site.json. Returns a dict with resolved data folder, crop geometry, assets and polygons source."""
    path = Path(path).resolve()
    base = path.parent
    cfg = json.loads(path.read_text(encoding="utf-8"))
    data = (base / cfg.get("dataDir", ".")).resolve()
    crop = cfg.get("crop", "crop.json")
    if isinstance(crop, str):
        crop = json.loads((data / crop).read_text(encoding="utf-8"))
    o25 = crop["ortho2025"]
    o23 = crop.get("ortho2023")
    origin = cfg.get("origin")
    site = dict(
        path=path, name=cfg.get("name", path.parent.name), data=data,
        bounds=tuple(float(v) for v in crop["bounds"]),
        px_e=float(o25["topLeftE"]), px_n=float(o25["topLeftN"]), px=float(o25["pixelM"]),
        ortho2025=data / o25.get("file", "ortho-2025.png"),
        ortho2023=(data / o23.get("file", "ortho-2023.png")) if o23 else None,
        lidar=data / cfg.get("lidar", "lidar-crop.npz"),
        origin=[float(v) for v in origin] if origin else None,
        categories=list(cfg.get("categories", ["building"])), prefix=cfg.get("assetPrefix"), assets=list(cfg.get("assets", [])), ground=list(cfg.get("groundAssets", [])),
        osm={a: [str(i) for i in (v if isinstance(v, list) else [v])] for a, v in cfg.get("osm", {}).items()},
        sections={a: list(v) for a, v in cfg.get("sections", {}).items()},
        footprints=(base / cfg["footprints"]).resolve() if cfg.get("footprints") else None,
        focus=cfg.get("focus"), colors={a: tuple(int(x) for x in c) for a, c in cfg.get("colors", {}).items()},
        colour_ref=cfg.get("colourReference"))
    if site["origin"] is None and scene_origin is None:
        sys.exit("site file has no origin and the .blend has no golfmap_origin_epsg3006")
    return site


def load_footprints(path):
    """OSM way id (str) -> list of EN rings, from a survey.json or a GeoJSON feature list (osm-buildings.json)."""
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    out = {}
    if isinstance(data, dict) and "buildings" in data:                      # survey.json
        for r in data["buildings"]:
            out[r["id"].split("/")[-1]] = [r["footprint3006"]]
        return out, {r["id"]: r["roofEdge3006"] for r in data.get("interpretedRoofSections", [])}
    feats = data["features"] if isinstance(data, dict) else data           # GeoJSON
    for f in feats:
        pr = f.get("properties", {})
        key = str(pr.get("osm_id") or str(pr.get("id", "")).split("/")[-1])
        g = f["geometry"]
        polys = [g["coordinates"]] if g["type"] == "Polygon" else g["coordinates"]
        out[key] = [[[float(c[0]), float(c[1])] for c in poly[0]] for poly in polys]
    return out, {}


def distinct_colors(names):
    return {n: PALETTE[i % len(PALETTE)] if i < len(PALETTE) else tuple(int(v) for v in
            (255 * np.array(colorsys_hsv((i * 0.381966) % 1.0, .85, 1.0)))) for i, n in enumerate(names)}


def colorsys_hsv(h, s_, v):
    import colorsys
    return colorsys.hsv_to_rgb(h, s_, v)


def lidar_facts(footprints, mapping, lg, gnd_grid, gnd, pts, rp, green_pts, cell_pts, cell_h, ortho):
    """Model-independent lidar facts per OSM footprint plus the >ROOF_MIN_H roof clusters outside every footprint.

    footprints: OSM id -> list of EN rings; mapping: OSM id -> asset name. Heights are absolute (RH2000)."""
    bg = Grid(lg.x0, lg.y1, NO_LIDAR_BLOCK, int(math.ceil(lg.nx * lg.cell / NO_LIDAR_BLOCK)), int(math.ceil(lg.ny * lg.cell / NO_LIDAR_BLOCK)))
    roof_j, roof_i, roof_ok = lg.idx(rp[:, 0], rp[:, 1])
    all_j, all_i, all_ok = lg.idx(pts[:, 0], pts[:, 1])
    gr_j, gr_i, gr_ok = lg.idx(green_pts[:, 0], green_pts[:, 1])
    rb_j, rb_i, rb_ok = bg.idx(rp[:, 0], rp[:, 1])
    # roughness: std of the roof-return heights per 2 m block (blocks with >= 4 returns). Planar roofs stay below ~0.5 m even
    # on steep slopes, tree crowns are typically above 1 m, so this separates the dark/shadowed trees the ortho-green test misses.
    flat_b = rb_j[rb_ok] * bg.nx + rb_i[rb_ok]
    zb = rp[rb_ok, 2]
    cnt_b = np.bincount(flat_b, minlength=bg.nx * bg.ny)
    sum_b = np.bincount(flat_b, zb, minlength=bg.nx * bg.ny)
    sq_b = np.bincount(flat_b, zb * zb, minlength=bg.nx * bg.ny)
    with np.errstate(invalid="ignore", divide="ignore"):
        mean_b = sum_b / cnt_b
        rough_b = np.sqrt(np.maximum(sq_b / cnt_b - mean_b ** 2, 0))
    rough_b[cnt_b < 4] = np.nan
    rough_b = rough_b.reshape(bg.ny, bg.nx)
    out = dict(method="Inside each OSM footprint (0.5 m cell-centre test): lidar roof = class 1, >= %.1f m above the class-2 ground surface and not green in the ortho. "
                      "Ridge = highest roof return, eave = low quantile of the roof returns (sparse lidar: a quantile, not an exact edge). "
                      "Coverage = share of 0.5 m cells / 2 m blocks inside the footprint with at least one roof return." % ROOF_MIN_H,
               buildings={}, unmappedRoofClusters=[])
    masks = {}
    e, n = lg.centres()
    for oid, rings in footprints.items():
        m = poly_mask(lg, rings)
        masks[oid] = m
        if not m.any():
            continue
        inm = np.zeros(len(rp), bool)
        inm[roof_ok] = m[roof_j[roof_ok], roof_i[roof_ok]]
        z = rp[inm, 2]
        jj, ii = np.nonzero(m)
        gz = bilinear(gnd_grid, gnd, e[ii], n[jj])
        ring = dilate(m, 8) & ~dilate(m, 2)                       # 1-4 m outside the footprint
        in_ring = np.zeros(len(pts), bool)
        in_ring[all_ok] = ring[all_j[all_ok], all_i[all_ok]]
        ring_g = pts[in_ring & (pts[:, 3] == 2), 2]
        in_all = np.zeros(len(pts), bool)
        in_all[all_ok] = m[all_j[all_ok], all_i[all_ok]]
        cells_with = np.zeros(m.shape, bool)
        sel = inm[roof_ok]
        cells_with[roof_j[roof_ok][sel], roof_i[roof_ok][sel]] = True
        bm = poly_mask(bg, rings)
        bcount = np.zeros(bm.shape, int)
        np.add.at(bcount, (rb_j[rb_ok], rb_i[rb_ok]), 1)
        area = sum(poly_area(r) for r in rings)
        d = dict(asset=mapping.get(oid), footprintAreaM2=rnd(area, 1), roofPointsInside=int(inm.sum()),
                 roofPointsPerM2=rnd(inm.sum() / max(area, 1e-6), 2),
                 pctCellsWithRoofReturn=rnd(100 * cells_with[m].mean(), 1),
                 pctBlocks2mWithRoofReturn=rnd(100 * (bcount[bm] > 0).mean(), 1) if bm.any() else None,
                 groundSurfaceMedianAbsM=rnd(np.median(gz)),
                 groundClass2Ring1to4mMedianAbsM=rnd(np.median(ring_g)) if len(ring_g) else None, groundClass2RingPoints=int(len(ring_g)),
                 class2PointsInsideFootprint=int((in_all & (pts[:, 3] == 2)).sum()),
                 greenDroppedPointsInside=int((m[gr_j[gr_ok], gr_i[gr_ok]]).sum()))
        bj_, bi_, bok_ = bg.idx(rp[inm, 0], rp[inm, 1])
        rv = rough_b[bj_[bok_], bi_[bok_]]
        d["roughnessMedianM"] = rnd(np.nanmedian(rv)) if np.isfinite(rv).any() else None
        if len(z):
            g0 = float(np.median(gz))
            d.update(ridgeMaxAbsM=rnd(z.max()), ridgeP99AbsM=rnd(np.percentile(z, 99)), ridgeP95AbsM=rnd(np.percentile(z, 95)),
                     roofMedianAbsM=rnd(np.median(z)), eaveP5AbsM=rnd(np.percentile(z, 5)), eaveP10AbsM=rnd(np.percentile(z, 10)),
                     ridgeMaxAboveGroundM=rnd(z.max() - g0), ridgeP99AboveGroundM=rnd(np.percentile(z, 99) - g0),
                     eaveP5AboveGroundM=rnd(np.percentile(z, 5) - g0), eaveP10AboveGroundM=rnd(np.percentile(z, 10) - g0),
                     heightAboveGroundQuantilesP5P25P50P75P95=[rnd(np.percentile(z, q) - g0) for q in (5, 25, 50, 75, 95)])
        out["buildings"][oid] = d
    # unmapped roof clusters: highest roof return per 0.5 m cell, more than 1 m from any footprint
    union = np.zeros((lg.ny, lg.nx), bool)
    for m in masks.values():
        union |= m
    far = ~dilate(union, 2)
    cj, ci, cok = lg.idx(cell_pts[:, 0], cell_pts[:, 1])
    keep = np.zeros(len(cell_pts), bool)
    keep[cok] = far[cj[cok], ci[cok]]
    if keep.any():
        cp, ch = cell_pts[keep], cell_h[keep]
        cl = clusters(np.column_stack((np.floor(cp[:, 0] / LIDAR_CELL), np.floor(cp[:, 1] / LIDAR_CELL))).astype(int), 3)
        cl.sort(key=lambda g: -len(g))
        for g in cl:
            if len(g) < 6:
                continue
            pp = cp[g]
            ix_ = np.clip(((pp[:, 0] - PX_E) / PX).astype(int), 0, ortho.shape[1] - 1)
            iy_ = np.clip(((PX_N - pp[:, 1]) / PX).astype(int), 0, ortho.shape[0] - 1)
            rgb_ = ortho[iy_, ix_].astype(float)
            gnd_c = bilinear(gnd_grid, gnd, pp[:, 0], pp[:, 1])
            bj_, bi_, bok_ = bg.idx(pp[:, 0], pp[:, 1])
            rv = rough_b[bj_[bok_], bi_[bok_]]
            rough = float(np.nanmedian(rv)) if np.isfinite(rv).any() else float("nan")
            out["unmappedRoofClusters"].append(dict(
                id="U%d" % (len(out["unmappedRoofClusters"]) + 1), cells=int(len(g)), areaCellsM2=rnd(len(g) * LIDAR_CELL ** 2, 1),
                areaHullM2=rnd(hull_area(pp[:, :2]), 1), centreE=rnd(pp[:, 0].mean(), 1), centreN=rnd(pp[:, 1].mean(), 1),
                bboxE=[rnd(pp[:, 0].min(), 1), rnd(pp[:, 0].max(), 1)], bboxN=[rnd(pp[:, 1].min(), 1), rnd(pp[:, 1].max(), 1)],
                groundAbsM=rnd(np.median(gnd_c)), maxZAbsM=rnd(pp[:, 2].max()), p90ZAbsM=rnd(np.percentile(pp[:, 2], 90)),
                meanAboveGroundM=rnd(ch[g].mean(), 1), maxAboveGroundM=rnd(ch[g].max(), 1), heightStdM=rnd(ch[g].std(), 2),
                roughnessMedianM=rnd(rough), likelyVegetation=bool(not (rough < VEG_ROUGHNESS)),
                orthoMeanRgb=[int(v) for v in rgb_.mean(0)],
                greenishPct=rnd(100 * float(((rgb_[:, 1] > rgb_[:, 0]) & (rgb_[:, 1] > rgb_[:, 2])).mean()), 0),
                note="no OSM footprint within 1 m; clearly green trees are already dropped; likelyVegetation = roughness >= %.1f m (or too few returns to tell)" % VEG_ROUGHNESS))
    return out


# ---- main -----------------------------------------------------------------------------------------
def main():
    global PX_E, PX_N, PX, BOUNDS, ASSETS, GROUND_ASSETS, SURVEY_OF, COLORS, TITLE, FOOTPRINT_LABEL, COLOR_REFERENCE, BIG_VIEW
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--props")
    ap.add_argument("--site")
    ap.add_argument("--data")
    ap.add_argument("--survey")
    ap.add_argument("--focus")
    ap.add_argument("--dz", action="store_true")
    args = ap.parse_args(sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else [])
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    blend = Path(bpy.data.filepath) if bpy.data.filepath else None
    props_path = Path(args.props) if args.props else (blend.parent / "props.json" if blend else None)
    if not props_path or not props_path.exists():
        sys.exit("props.json not found (pass --props)")
    props = json.loads(props_path.read_text(encoding="utf-8"))
    sc = bpy.context.scene
    scene_origin = sc.get("golfmap_origin_epsg3006")
    site = load_site(args.site, scene_origin) if args.site else None
    if site:
        PX_E, PX_N, PX, BOUNDS = site["px_e"], site["px_n"], site["px"], site["bounds"]
        GROUND_ASSETS = list(site["ground"])
        found = list(site["assets"])
        if site["prefix"]:
            found += [o.name for o in sorted(bpy.data.objects, key=lambda o: o.name) if o.type == "MESH" and o.name.startswith(site["prefix"])]
        ASSETS = [n for n in dict.fromkeys(found) if n not in GROUND_ASSETS]
        # only roof-bearing assets: props.json category must be in the site's "categories" (default building); the rest
        # (garden structures, props...) skip the roof checks, only their transform is compared with props.json
        cats = set(site["categories"])
        not_roof = [n for n in ASSETS if props["assets"].get(n, {}).get("category", "building") not in cats]
        ASSETS = [n for n in ASSETS if n not in not_roof]
        GROUND_ASSETS += not_roof
        if not ASSETS:
            sys.exit("site file selects no assets (check assetPrefix / assets)")
        SURVEY_OF = {n: (site["osm"].get(n, []), site["sections"].get(n, [])) for n in ASSETS}
        COLORS = {**distinct_colors(ASSETS), **site["colors"]}
        TITLE = site["name"].upper()
        COLOR_REFERENCE = site["colour_ref"]
        BIG_VIEW = None
    fp_path = Path(args.survey) if args.survey else (site["footprints"] if site else HERE / "survey.json")
    if fp_path is not None:
        footprints, sec_poly = load_footprints(fp_path)
        FOOTPRINT_LABEL = fp_path.name
    else:
        footprints, sec_poly = {}, {}
    if args.data:
        data = Path(args.data)
        lidar_path, ortho_path, ortho23_path = data / "lidar-crop.npz", data / "ortho-2025.png", data / "ortho-2023.png"
    elif site:
        lidar_path, ortho_path, ortho23_path = site["lidar"], site["ortho2025"], site["ortho2023"]
    else:
        data = ROOT / "data/omberg-clubhouse"
        lidar_path, ortho_path, ortho23_path = data / "lidar-crop.npz", data / "ortho-2025.png", data / "ortho-2023.png"
    pts = np.load(lidar_path)["points"]
    ortho = read_rgb(ortho_path)
    if site and site["origin"]:
        origin = site["origin"]
    else:
        origin = list(scene_origin if scene_origin is not None else [477825, 6457700, Z_OFFSET_FALLBACK])
    ox, oy, oz = float(origin[0]), float(origin[1]), float(origin[2])
    inst = {i["asset"]: i for i in props["instances"]}
    report = dict(tool="check_survey.py", blend=str(blend), props=str(props_path), lidar=str(lidar_path),
                  ortho=str(ortho_path),
                  parameters=dict(roofMinHeightM=ROOF_MIN_H, modelCellM=MODEL_CELL, lidarCellM=LIDAR_CELL,
                                  offThresholdM=OFF_TOL, footprintToleranceM=EDGE_TOL, noLidarBlockM=NO_LIDAR_BLOCK,
                                  originEN_Z=[ox, oy, oz], dzApplied=args.dz,
                                  signConvention="diff = model - lidar; positive = model too high"),
                  assets={}, unassignedLidarRoof=[], checks={})

    # --- 1. Blender transforms vs props.json --------------------------------------------------------
    tcheck = {}
    for name in ASSETS + GROUND_ASSETS:
        ob = bpy.data.objects.get(name)
        i = inst.get(name)
        if ob is None or i is None:
            tcheck[name] = dict(error="object or instance missing", object=ob is not None, instance=i is not None)
            continue
        want = (i["e"] - ox, i["n"] - oy, i.get("layoutZ", 0))
        dloc = max(abs(ob.location[k] - want[k]) for k in range(3))
        drot = (ob.rotation_euler.z - math.radians(90 - i["yawDeg"]) + math.pi) % (2 * math.pi) - math.pi
        tcheck[name] = dict(locMaxErrM=rnd(dloc, 6), rotZErrDeg=rnd(math.degrees(drot), 6),
                            scale=[rnd(v, 6) for v in ob.scale], parent=ob.parent.name if ob.parent else None,
                            dzInProps=i.get("dz", 0), matchesProps=bool(dloc < 1e-4 and abs(drot) < 1e-6))
    report["checks"]["blenderTransformsVsProps"] = tcheck
    report["checks"]["allTransformsMatch"] = all(v.get("matchesProps") for v in tcheck.values())
    if site:
        report["site"] = dict(file=str(site["path"]), name=site["name"], assets=ASSETS, excludedFromRoofChecks=GROUND_ASSETS, footprints=str(fp_path),
                              boundsE0N0E1N1=list(BOUNDS), orthoTopLeftEN=[PX_E, PX_N], orthoPixelM=PX)
        if scene_origin is not None:
            report["checks"]["originMatchesBlendScene"] = bool(max(abs(float(scene_origin[k]) - origin[k]) for k in range(3)) < 1e-6)

    # --- 2. lidar surfaces --------------------------------------------------------------------------
    gnd_grid, gnd = ground_surface(pts, BOUNDS)
    pts = pts[pts[:, 3] != 7]
    pg = bilinear(gnd_grid, gnd, pts[:, 0], pts[:, 1])
    px_, py_ = (pts[:, 0] - PX_E) / PX, (PX_N - pts[:, 1]) / PX
    ix, iy = np.clip(px_.astype(int), 0, ortho.shape[1] - 1), np.clip(py_.astype(int), 0, ortho.shape[0] - 1)
    rgb = ortho[iy, ix].astype(float)
    exg = 2 * rgb[:, 1] - rgb[:, 0] - rgb[:, 2]
    green = (exg > 25) & (rgb[:, 1] > rgb[:, 0] + 8) & (rgb[:, 1] > rgb[:, 2] + 8)
    above = pts[:, 2] - pg
    is_roof = (pts[:, 3] == 1) & (above >= ROOF_MIN_H)
    veg = is_roof & green
    roof = is_roof & ~green
    rp = pts[roof]
    rp_h = above[roof]
    report["lidar"] = dict(points=int(len(pts)), class1=int((pts[:, 3] == 1).sum()), class2=int((pts[:, 3] == 2).sum()),
                           class1Above2m=int(is_roof.sum()), droppedAsGreenOrtho=int(veg.sum()), roofPoints=int(roof.sum()),
                           groundCellM=2.0)

    # --- 3. model DSMs ------------------------------------------------------------------------------
    mg = Grid(BOUNDS[0], PX_N, MODEL_CELL, int(round((BOUNDS[2] - BOUNDS[0]) / MODEL_CELL)),
              int(math.ceil((PX_N - BOUNDS[1]) / MODEL_CELL)))
    me_e, me_n = mg.centres()
    gnd_model = bilinear(gnd_grid, gnd, *np.meshgrid(me_e, me_n))
    dg = bpy.context.evaluated_depsgraph_get()
    dsm, tri_info, tris = {}, {}, {}
    for name in ASSETS:
        ob = bpy.data.objects.get(name)
        if ob is None:
            report["assets"][name] = dict(error="object not in .blend")
            continue
        dz = 0.0 if (not args.dz) else float(inst.get(name, {}).get("dz", 0))
        P, total, mats = mesh_triangles(ob, dg, np.array([ox, oy, oz + dz]))
        tris[name] = (P, mats)
        dsm[name] = raster_max(P, mg)
        tri_info[name] = dict(triangles=int(total), upwardFacing=int(len(P)), dzAppliedM=dz)
    names = [n for n in ASSETS if n in dsm]
    foot = {n: np.nan_to_num(dsm[n], nan=-1e9) - gnd_model >= ROOF_MIN_H for n in names}
    stack = np.stack([np.nan_to_num(dsm[n], nan=-1e9) for n in names])
    owner = stack.argmax(0)
    owned = {n: foot[n] & (owner == k) for k, n in enumerate(names)}
    union = np.zeros_like(next(iter(foot.values())))
    for n in names:
        union |= foot[n]
    union_tol = dilate(union, int(round(EDGE_TOL / MODEL_CELL)))
    # model height seen from above at any point (max over all assets), for diff maps
    top = np.nanmax(np.stack([dsm[n] for n in names]), axis=0) if names else None

    # --- survey polygons and 0.5 m region masks -----------------------------------------------------
    lg = Grid(BOUNDS[0], PX_N, LIDAR_CELL, int(round((BOUNDS[2] - BOUNDS[0]) / LIDAR_CELL)),
              int(math.ceil((PX_N - BOUNDS[1]) / LIDAR_CELL)))
    osm_poly = footprints
    survey_polys = {}
    for name in names:
        ids, secs = SURVEY_OF[name]
        survey_polys[name] = dict(osm=[r for i in ids for r in osm_poly.get(i, [])], sections=[sec_poly[s] for s in secs if s in sec_poly])
    region_rank = {}
    for name in names:
        polys = survey_polys[name]["osm"] + survey_polys[name]["sections"]
        m = poly_mask(lg, polys) if polys else np.zeros((lg.ny, lg.nx), bool)
        # own model footprint on the 0.5 m grid
        fj, fi = np.nonzero(foot[name])
        fm = np.zeros((lg.ny, lg.nx), bool)
        fm[np.minimum(fj // 2, lg.ny - 1), np.minimum(fi // 2, lg.nx - 1)] = True
        base = m | fm
        rank = np.full((lg.ny, lg.nx), 9, np.int8)
        for cls, r in ((2, 8), (1, 4), (0, 0)):   # 4 m, 2 m, inside
            rank[dilate(base, r)] = cls
        region_rank[name] = rank
        survey_polys[name]["mask"] = m

    # --- 4. lidar DSM (0.5 m, max z of class 1) -----------------------------------------------------
    lj, li, lok = lg.idx(rp[:, 0], rp[:, 1])
    cell_flat = lj * lg.nx + li
    order = np.lexsort((rp[:, 2], cell_flat))      # last of each cell group = max z
    cf, last = cell_flat[order], np.r_[cell_flat[order][1:] != cell_flat[order][:-1], True]
    sel = order[last]                               # one roof point (the highest) per 0.5 m cell
    cell_pts = rp[sel]
    cell_h = rp_h[sel]
    cell_model = bilinear_free = None
    mj, mi, mok = mg.idx(cell_pts[:, 0], cell_pts[:, 1])
    topz = np.full(len(cell_pts), np.nan)
    topz[mok] = top[mj[mok], mi[mok]]
    cell_owner = np.full(len(cell_pts), -1)
    cell_owner[mok] = owner[mj[mok], mi[mok]]
    in_tol = np.zeros(len(cell_pts), bool)
    in_tol[mok] = union_tol[mj[mok], mi[mok]]
    cell_gnd = bilinear(gnd_grid, gnd, cell_pts[:, 0], cell_pts[:, 1])
    model_z = np.where(np.isnan(topz), cell_gnd, topz)
    # where the model has no roof the model surface is the ground (diff = ground - lidar)
    model_z = np.where(in_tol | ~np.isnan(topz), np.nan_to_num(topz, nan=-1e9), cell_gnd)
    model_z = np.where(model_z < -1e8, cell_gnd, model_z)
    diff_all = model_z - cell_pts[:, 2]

    # --- 5. per-asset statistics --------------------------------------------------------------------
    lj_all, li_all, ok_all = lg.idx(cell_pts[:, 0], cell_pts[:, 1])
    assigned = np.full(len(cell_pts), -1)
    best = np.full(len(cell_pts), 9)
    for k, name in enumerate(names):
        rk = region_rank[name][lj_all, li_all]
        better = rk < best
        assigned[better] = k
        best[better] = rk[better]
    missing_cells = (~in_tol) & (best < 9) | ((~in_tol) & (best == 9))
    stats_of = {}
    for k, name in enumerate(names):
        o = owned[name]
        n_roof_cells = int(o.sum())
        sel_in = (cell_owner == k) & (foot[name][mj.clip(0, mg.ny - 1), mi.clip(0, mg.nx - 1)]) & mok
        d = diff_all[sel_in]
        ad = np.abs(d)
        s = dict(model=tri_info[name])
        s["modelRoofAreaM2"] = rnd(n_roof_cells * MODEL_CELL ** 2, 1)
        s["modelFootprintAreaM2"] = rnd(foot[name].sum() * MODEL_CELL ** 2, 1)
        s["comparedCells"] = int(sel_in.sum())
        if len(d):
            s["absDiffMedianM"] = rnd(np.median(ad))
            s["absDiffP90M"] = rnd(np.percentile(ad, 90))
            s["pctOffByMoreThan0_5m"] = rnd(100 * (ad > OFF_TOL).mean(), 1)
            s["signedDiffMedianM"] = rnd(np.median(d))
            if tri_info[name]["dzAppliedM"]:
                s["signedDiffMedianWithoutDzM"] = rnd(np.median(d) - tri_info[name]["dzAppliedM"])
            s["pctOffByMoreThan1m"] = rnd(100 * (ad > 1.0).mean(), 1)
        # ridge / eave: model over its owned roof cells, lidar over the same cells and over the survey region
        mz = dsm[name][o]
        if len(mz):
            s["model"].update(ridgeMaxM=rnd(mz.max()), ridgeP98M=rnd(np.percentile(mz, 98)), eaveP5M=rnd(np.percentile(mz, 5)),
                              medianGroundM=rnd(np.median(gnd_model[o])))
        lz = cell_pts[sel_in, 2]
        # all roof points (not just the cell maxima) inside the owned footprint
        aj, ai, aok = mg.idx(rp[:, 0], rp[:, 1])
        in_o = np.zeros(len(rp), bool)
        in_o[aok] = owned[name][aj[aok], ai[aok]]
        az = rp[in_o, 2]
        s["lidar"] = dict(pointsInModelFootprint=int(in_o.sum()))
        if len(az):
            s["lidar"].update(ridgeMaxInFootprintM=rnd(az.max()), ridgeP98InFootprintM=rnd(np.percentile(az, 98)),
                              eaveP5InFootprintM=rnd(np.percentile(az, 5)))
        reg = (region_rank[name][lg.idx(rp[:, 0], rp[:, 1])[0].clip(0, lg.ny - 1), lg.idx(rp[:, 0], rp[:, 1])[1].clip(0, lg.nx - 1)] <= 0)
        reg &= survey_polys[name]["mask"][lg.idx(rp[:, 0], rp[:, 1])[0].clip(0, lg.ny - 1), lg.idx(rp[:, 0], rp[:, 1])[1].clip(0, lg.nx - 1)]
        rz = rp[reg, 2]
        if len(rz):
            s["lidar"].update(pointsInSurveyPolygon=int(reg.sum()), surveyRidgeMaxM=rnd(rz.max()), surveyRidgeP98M=rnd(np.percentile(rz, 98)),
                              surveyEaveP5M=rnd(np.percentile(rz, 5)))
        # ground returns inside the owned footprint (roof where lidar sees the ground)
        gj, gi, gok = mg.idx(pts[:, 0], pts[:, 1])
        in_g = np.zeros(len(pts), bool)
        in_g[gok] = owned[name][gj[gok], gi[gok]]
        s["lidar"]["groundPointsInsideModelFootprint"] = int((in_g & (pts[:, 3] == 2)).sum())
        # model roof blocks without any lidar roof return
        bs = int(round(NO_LIDAR_BLOCK / MODEL_CELL))
        by, bx = mg.ny // bs, mg.nx // bs
        frac = o[:by * bs, :bx * bs].reshape(by, bs, bx, bs).mean((1, 3))
        ra = np.zeros((by, bx), int)
        bj, bi, bok = (np.floor((PX_N - rp[:, 1]) / NO_LIDAR_BLOCK).astype(int), np.floor((rp[:, 0] - BOUNDS[0]) / NO_LIDAR_BLOCK).astype(int), None)
        okb = (bj >= 0) & (bj < by) & (bi >= 0) & (bi < bx)
        np.add.at(ra, (bj[okb], bi[okb]), 1)
        # also count green-dropped / any >2 m class-1 points as "lidar returned something"
        vj, vi = np.floor((PX_N - pts[veg, 1]) / NO_LIDAR_BLOCK).astype(int), np.floor((pts[veg, 0] - BOUNDS[0]) / NO_LIDAR_BLOCK).astype(int)
        okv = (vj >= 0) & (vj < by) & (vi >= 0) & (vi < bx)
        np.add.at(ra, (vj[okv], vi[okv]), 1)
        empty = (frac >= .5) & (ra == 0)
        total_blocks = int((frac >= .5).sum())
        s["modelRoofWithoutLidar"] = dict(blockM=NO_LIDAR_BLOCK, blocks=int(empty.sum()), ofBlocks=total_blocks,
                                          areaM2=rnd(empty.sum() * NO_LIDAR_BLOCK ** 2, 1),
                                          pct=rnd(100 * empty.sum() / max(total_blocks, 1), 1))
        if empty.any():
            ej, ei = np.nonzero(empty)
            ce = BOUNDS[0] + (ei + .5) * NO_LIDAR_BLOCK
            cn = PX_N - (ej + .5) * NO_LIDAR_BLOCK
            groups = clusters(np.column_stack((ei, ej)), 1)
            groups.sort(key=lambda g: -len(g))
            s["modelRoofWithoutLidar"]["where"] = [dict(blocks=int(len(g)), areaM2=rnd(len(g) * NO_LIDAR_BLOCK ** 2, 1),
                                                         centreE=rnd(ce[g].mean(), 1), centreN=rnd(cn[g].mean(), 1),
                                                         bboxE=[rnd(ce[g].min() - 1, 1), rnd(ce[g].max() + 1, 1)],
                                                         bboxN=[rnd(cn[g].min() - 1, 1), rnd(cn[g].max() + 1, 1)]) for g in groups[:6]]
        # lidar roof missing from the model, assigned to this asset's survey region
        mk = (assigned == k) & ~in_tol & (best < 9)
        s["lidarRoofOutsideModel"] = dict(cells05m=int(mk.sum()), areaM2Cells=rnd(mk.sum() * LIDAR_CELL ** 2, 1))
        if mk.any():
            cp, ch = cell_pts[mk], cell_h[mk]
            cl = clusters(np.column_stack((np.floor(cp[:, 0] / LIDAR_CELL), np.floor(cp[:, 1] / LIDAR_CELL))).astype(int), 3)
            cl.sort(key=lambda g: -len(g))
            rows = []
            for g in cl:
                if len(g) < 3:
                    continue
                pp = cp[g]
                rows.append(dict(cells=int(len(g)), areaHullM2=rnd(hull_area(pp[:, :2]), 1), areaCellsM2=rnd(len(g) * LIDAR_CELL ** 2, 1),
                                 centreE=rnd(pp[:, 0].mean(), 1), centreN=rnd(pp[:, 1].mean(), 1),
                                 bboxE=[rnd(pp[:, 0].min(), 1), rnd(pp[:, 0].max(), 1)],
                                 bboxN=[rnd(pp[:, 1].min(), 1), rnd(pp[:, 1].max(), 1)],
                                 meanAboveGroundM=rnd(ch[g].mean(), 1), maxZ=rnd(pp[:, 2].max(), 1),
                                 distToModelFootprintM=None))
            s["lidarRoofOutsideModel"]["clusters"] = rows[:8]
            s["lidarRoofOutsideModel"]["clustersOfAtLeast3Cells"] = len(rows)
            s["lidarRoofOutsideModel"]["areaHullTotalM2"] = rnd(sum(r["areaHullM2"] for r in rows), 1)
        # footprint vs OSM polygon
        osm_union = survey_polys[name]["mask"]
        fm2 = np.zeros((lg.ny, lg.nx), bool)
        fj, fi = np.nonzero(foot[name])
        fm2[np.minimum(fj // 2, lg.ny - 1), np.minimum(fi // 2, lg.nx - 1)] = True
        if osm_union.any():
            inter = (fm2 & osm_union).sum()
            uni = (fm2 | osm_union).sum()
            s["footprintVsSurveyPolygons"] = dict(surveyAreaM2=rnd(osm_union.sum() * LIDAR_CELL ** 2, 1),
                                                  modelAreaM2=rnd(fm2.sum() * LIDAR_CELL ** 2, 1), iou=rnd(inter / max(uni, 1), 3))
        stats_of[name] = s
        report["assets"][name] = s

    # lidar roof not belonging to any asset region
    um = (~in_tol) & (best >= 9)
    if um.any():
        cp, ch = cell_pts[um], cell_h[um]
        cl = clusters(np.column_stack((np.floor(cp[:, 0] / LIDAR_CELL), np.floor(cp[:, 1] / LIDAR_CELL))).astype(int), 3)
        cl.sort(key=lambda g: -len(g))
        for g in cl[:15]:
            if len(g) >= 6:
                pp = cp[g]
                report["unassignedLidarRoof"].append(dict(cells=int(len(g)), areaHullM2=rnd(hull_area(pp[:, :2]), 1),
                                                          centreE=rnd(pp[:, 0].mean(), 1), centreN=rnd(pp[:, 1].mean(), 1),
                                                          meanAboveGroundM=rnd(ch[g].mean(), 1),
                                                          note="outside every asset region; trees (not green in ortho), other buildings or unmodelled structures"))

    unmapped = []
    if site:
        mapping = {i: a for a, ids in site["osm"].items() for i in ids}
        report["lidarFacts"] = lidar_facts(footprints, mapping, lg, gnd_grid, gnd, pts, rp, pts[veg], cell_pts, cell_h, ortho)
        unmapped = report["lidarFacts"]["unmappedRoofClusters"]

    # --- 5b. roof colours ----------------------------------------------------------------------------
    if blend is not None and (blend.parent / "Textures").is_dir():
        # candidate neutral-reference cells: car park, drive and plaza boxes, away from roofs and from anything tall in the lidar
        ref_cells, ref_name = None, "omberg_courtyard_asphalt"
        if COLOR_REFERENCE is not None:
            ref_name = COLOR_REFERENCE["material"]
            occ = Grid(BOUNDS[0], PX_N, 1.0, int(round(BOUNDS[2] - BOUNDS[0])), int(math.ceil(PX_N - BOUNDS[1])))
            objp = pts[(pts[:, 3] == 1) & (above > .3)]
            oj, oi, ook = occ.idx(objp[:, 0], objp[:, 1])
            occm = np.zeros((occ.ny, occ.nx), bool)
            occm[oj[ook], oi[ook]] = True
            occm = dilate(occm, 1)
            far_from_roofs = ~dilate(union, 12)
            ce, cn = [], []
            for e0_, e1_, n0_, n1_ in COLOR_REFERENCE["boxes"]:
                ee, nn = np.meshgrid(np.arange(e0_, e1_, .25) + .125, np.arange(n0_, n1_, .25) + .125)
                ee, nn = ee.ravel(), nn.ravel()
                a_, b_, c_ = occ.sample(occm, ee, nn, True), mg.sample(far_from_roofs, ee, nn, False), None
                keep = ~a_ & b_
                ce.append(ee[keep])
                cn.append(nn[keep])
            ref_cells = (np.concatenate(ce), np.concatenate(cn))
        orthos = {"2025": ortho}
        if ortho23_path is not None and Path(ortho23_path).exists():
            orthos["2023"] = read_rgb(ortho23_path)
        colour_check(names, tris, mg, owned, dsm, union, ref_cells, orthos, props, blend.parent / "Textures", out, report, ref_name)

    # --- 6. images ----------------------------------------------------------------------------------
    # a) lidar on ortho (validation of the lidar/ortho alignment)
    K = 3
    v = View(ortho, BOUNDS[0], BOUNDS[1], BOUNDS[2], BOUNDS[3], 1)
    if BIG_VIEW is not None:
        big = View(ortho, *BIG_VIEW)
    else:
        xs_all, ys_all = [], []
        for n_ in names:
            ys_, xs_ = np.nonzero(foot[n_])
            if len(xs_):
                xs_all += [BOUNDS[0] + xs_.min() * MODEL_CELL, BOUNDS[0] + (xs_.max() + 1) * MODEL_CELL]
                ys_all += [PX_N - (ys_.max() + 1) * MODEL_CELL, PX_N - ys_.min() * MODEL_CELL]
            for poly in survey_polys[n_]["osm"]:
                xs_all += [min(q[0] for q in poly), max(q[0] for q in poly)]
                ys_all += [min(q[1] for q in poly), max(q[1] for q in poly)]
        for u in unmapped:
            xs_all += u["bboxE"]
            ys_all += u["bboxN"]
        if not xs_all:
            xs_all, ys_all = [BOUNDS[0], BOUNDS[2]], [BOUNDS[1], BOUNDS[3]]
        be0, be1 = max(BOUNDS[0], min(xs_all) - 15), min(BOUNDS[2], max(xs_all) + 15)
        bn0, bn1 = max(BOUNDS[1], min(ys_all) - 15), min(BOUNDS[3], max(ys_all) + 15)
        big = View(ortho, be0, bn0, be1, bn1, max(1, min(6, int(2400 / ((be1 - be0) / PX)))))
    allroof = pts[is_roof]
    gcol = height_color(above[is_roof], ROOF_MIN_H, 12)
    for p, c, g in zip(allroof, gcol, green[is_roof]):
        big.square(p[0], p[1], .5, c, 1.0, border=(255, 255, 255) if g else None)
    for n in names:
        big.mask_outline(mg, foot[n], COLORS[n], 2)
    for u in unmapped:
        big.poly([(u["bboxE"][0], u["bboxN"][0]), (u["bboxE"][1], u["bboxN"][0]), (u["bboxE"][1], u["bboxN"][1]), (u["bboxE"][0], u["bboxN"][1])],
                 OTHER_COLOR if u["likelyVegetation"] else TRACE_COLOR, 1 if u["likelyVegetation"] else 2)
    finish(big, "LIDAR ROOF POINTS ON ORTHO-2025 (WHITE BORDER = DROPPED, GREEN IN ORTHO)", [((255, 70, 30), "lidar roof, 12 m above ground"), ((40, 30, 140), "lidar roof, 2 m above ground"), ((255, 255, 255), "model outline = colour per asset")] + ([(TRACE_COLOR, "unmapped lidar roof cluster, not vegetation-like"), (OTHER_COLOR, "unmapped cluster, rough = vegetation")] if unmapped else []),
           out / "validate-lidar-on-ortho.png")

    # b) per-asset crops
    def asset_bounds(name):
        ys, xs = np.nonzero(foot[name])
        e0, e1 = BOUNDS[0] + xs.min() * MODEL_CELL, BOUNDS[0] + (xs.max() + 1) * MODEL_CELL
        n1, n0 = PX_N - ys.min() * MODEL_CELL, PX_N - (ys.max() + 1) * MODEL_CELL
        for poly in survey_polys[name]["osm"] + survey_polys[name]["sections"]:
            p = np.asarray(poly)
            e0, e1, n0, n1 = min(e0, p[:, 0].min()), max(e1, p[:, 0].max()), min(n0, p[:, 1].min()), max(n1, p[:, 1].max())
        return e0 - 6, n0 - 6, e1 + 6, n1 + 6

    images = {}
    for name in names:
        if not foot[name].any():
            continue
        e0, n0, e1, n1 = asset_bounds(name)
        k = max(2, min(4, int(1600 / ((e1 - e0) / PX))))
        legend = [(COLORS[name], "model roof outline"), (OSM_COLOR, "osm footprint (%s)" % FOOTPRINT_LABEL)]
        # ortho + outlines
        v = View(ortho, e0, n0, e1, n1, k)
        for other in names:
            if other != name:
                v.mask_outline(mg, foot[other], OTHER_COLOR, 1)
        for poly in survey_polys[name]["osm"]:
            v.poly(poly, OSM_COLOR, 2)
        for poly in survey_polys[name]["sections"]:
            v.poly(poly, TRACE_COLOR, 2)
        v.mask_outline(mg, foot[name], COLORS[name], 3)
        if survey_polys[name]["sections"]:
            legend.append((TRACE_COLOR, "survey roof trace (approx.)"))
        legend.append((OTHER_COLOR, "other assets"))
        s = stats_of[name]
        title = "%s  ORTHO 2025  median |d| %s m  P90 %s m  >0.5 m %s%%" % (name, s.get("absDiffMedianM"), s.get("absDiffP90M"), s.get("pctOffByMoreThan0_5m"))
        p1 = out / ("asset-%s-ortho.png" % short(name))
        finish(v, title, legend, p1)
        images[name] = dict(ortho=p1.name)
        # signed height difference
        v = View(ortho, e0, n0, e1, n1, k, dim=.45)
        sel_v = (cell_pts[:, 0] > e0) & (cell_pts[:, 0] < e1) & (cell_pts[:, 1] > n0) & (cell_pts[:, 1] < n1)
        cols = diff_color(diff_all[sel_v])
        for p, c, inside in zip(cell_pts[sel_v], cols, in_tol[sel_v]):
            v.square(p[0], p[1], LIDAR_CELL, c, .92, border=None if inside else (0, 0, 0))
        # model roof blocks with no lidar
        o = owned[name]
        bs = int(round(NO_LIDAR_BLOCK / MODEL_CELL))
        by, bx = mg.ny // bs, mg.nx // bs
        frac = o[:by * bs, :bx * bs].reshape(by, bs, bx, bs).mean((1, 3))
        ra = np.zeros((by, bx), int)
        for arr in (rp, pts[veg]):
            jj, ii = np.floor((PX_N - arr[:, 1]) / NO_LIDAR_BLOCK).astype(int), np.floor((arr[:, 0] - BOUNDS[0]) / NO_LIDAR_BLOCK).astype(int)
            okk = (jj >= 0) & (jj < by) & (ii >= 0) & (ii < bx)
            np.add.at(ra, (jj[okk], ii[okk]), 1)
        for bj_, bi_ in zip(*np.nonzero((frac >= .5) & (ra == 0))):
            ce, cn = BOUNDS[0] + (bi_ + .5) * NO_LIDAR_BLOCK, PX_N - (bj_ + .5) * NO_LIDAR_BLOCK
            if e0 < ce < e1 and n0 < cn < n1:
                x, y = v.px(ce, cn)
                h2 = NO_LIDAR_BLOCK / v.grid.cell / 2
                draw_poly(v.img, [(x - h2, y - h2), (x + h2, y - h2), (x + h2, y + h2), (x - h2, y + h2)], (255, 220, 0), 1)
        v.mask_outline(mg, foot[name], COLORS[name], 2)
        for poly in survey_polys[name]["osm"]:
            v.poly(poly, OSM_COLOR, 1)
        leg2 = [(COLORS[name], "model roof outline"), (OSM_COLOR, "osm footprint"), ((255, 220, 0), "2 m model roof block, no lidar roof return"),
                ((0, 0, 0), "black border: lidar roof outside model")]
        title = "%s  MODEL - LIDAR (BLUE = MODEL TOO LOW, RED = TOO HIGH)  N=%d" % (name, s["comparedCells"])
        p2 = out / ("asset-%s-diff.png" % short(name))
        finish(v, title, leg2, p2, colorbar=(-1.5, 1.5, lambda x: diff_color(x), "MODEL - LIDAR (M)"))
        images[name]["diff"] = p2.name

    # c) overview
    v = View(ortho, BOUNDS[0], BOUNDS[1], BOUNDS[2], BOUNDS[3], 2)
    for n in names:
        v.mask_outline(mg, foot[n], COLORS[n], 3)
    for n in names:
        for poly in survey_polys[n]["osm"]:
            v.poly(poly, OSM_COLOR, 1)
    for n in names:
        ys, xs = np.nonzero(foot[n])
        if len(xs):
            cx, cy = v.px(BOUNDS[0] + xs.mean() * MODEL_CELL, PX_N - ys.mean() * MODEL_CELL)
            tw, _ = text_size(short(n), 2)
            draw_text(v.img, cx - tw / 2, cy - 7, short(n), 2, COLORS[n])
    for u in unmapped:
        x0_, y0_ = v.px(u["bboxE"][0], u["bboxN"][1])
        x1_, y1_ = v.px(u["bboxE"][1], u["bboxN"][0])
        veg_ = u["likelyVegetation"]
        draw_poly(v.img, [(x0_, y0_), (x1_, y0_), (x1_, y1_), (x0_, y1_)], OTHER_COLOR if veg_ else TRACE_COLOR, 1 if veg_ else 2)
        if not veg_:
            draw_text(v.img, x0_, y0_ - 16, u["id"], 2, TRACE_COLOR)
    finish(v, TITLE + " - MODEL ROOF OUTLINES ON ORTHO-2025", [(COLORS[n], short(n)) for n in names] + [(OSM_COLOR, "osm footprints (thin)")]
           + ([(TRACE_COLOR, "unmapped cluster, not vegetation-like"), (OTHER_COLOR, "unmapped cluster, vegetation-like")] if unmapped else []), out / "overview.png")

    # d) focus (main entrance foyer by default)
    focus = args.focus or (site["focus"] if site else None)
    if focus is None and site:
        for n_ in names:
            ys_, xs_ = np.nonzero(foot[n_])
            if len(xs_):
                focus = "%.1f,%.1f,%.1f" % (BOUNDS[0] + xs_.mean() * MODEL_CELL, PX_N - ys_.mean() * MODEL_CELL, 20)
                break
        if focus is None:                                   # nothing modelled above ground: first footprint, else the crop centre
            polys_ = [q for n_ in names for q in survey_polys[n_]["osm"]]
            if polys_:
                pa = np.asarray(polys_[0])
                focus = "%.1f,%.1f,%.1f" % (pa[:, 0].mean(), pa[:, 1].mean(), 20)
            else:
                focus = "%.1f,%.1f,%.1f" % ((BOUNDS[0] + BOUNDS[2]) / 2, (BOUNDS[1] + BOUNDS[3]) / 2, 40)
    fe, fn, fh = [float(t) for t in (focus or "477805,6457674,14").split(",")]
    v = View(ortho, fe - fh, fn - fh * .8, fe + fh, fn + fh * .8, 6)
    for n in names:
        v.mask_outline(mg, foot[n], COLORS[n], 2)
    for n in names:
        for poly in survey_polys[n]["osm"] + survey_polys[n]["sections"]:
            v.poly(poly, OSM_COLOR if poly in survey_polys[n]["osm"] else TRACE_COLOR, 1)
    sel_f = (pts[:, 0] > fe - fh) & (pts[:, 0] < fe + fh) & (pts[:, 1] > fn - fh * .8) & (pts[:, 1] < fn + fh * .8) & (pts[:, 3] == 1)
    for p, a in zip(pts[sel_f], above[sel_f]):
        v.square(p[0], p[1], .35, height_color(np.array(a), 0, 12), 1.0, border=(255, 255, 255))
    finish(v, "FOCUS E%.0f N%.0f: ORTHO 2025, MODEL OUTLINES, LIDAR CLASS-1 POINTS BY HEIGHT ABOVE GROUND" % (fe, fn),
           [((255, 70, 30), "lidar 12 m above ground"), ((40, 30, 140), "lidar 0 m above ground"), (OSM_COLOR, "osm footprint"), (TRACE_COLOR, "survey roof trace")],
           out / "focus-ortho-lidar.png")
    v = View(ortho, fe - fh, fn - fh * .8, fe + fh, fn + fh * .8, 6, dim=.45)
    selc = (cell_pts[:, 0] > fe - fh) & (cell_pts[:, 0] < fe + fh) & (cell_pts[:, 1] > fn - fh * .8) & (cell_pts[:, 1] < fn + fh * .8)
    for p, c in zip(cell_pts[selc], diff_color(diff_all[selc])):
        v.square(p[0], p[1], LIDAR_CELL, c, .95)
    for n in names:
        v.mask_outline(mg, foot[n], COLORS[n], 2)
    finish(v, "FOCUS E%.0f N%.0f: MODEL - LIDAR" % (fe, fn), [(OTHER_COLOR, "model roof outlines")], out / "focus-diff.png",
           colorbar=(-1.5, 1.5, lambda x: diff_color(x), "MODEL - LIDAR (M)"))
    report["images"] = dict(overview="overview.png", lidarOnOrtho="validate-lidar-on-ortho.png", focusOrthoLidar="focus-ortho-lidar.png",
                            focusDiff="focus-diff.png", roofColourSwatches="roof-colour-swatches.png", perAsset=images)
    np.savez_compressed(out / "model-dsm.npz", names=np.array(names), dsm=np.stack([dsm[n] for n in names]).astype(np.float32),
                        ground=gnd_model.astype(np.float32), grid=np.array([mg.x0, mg.y1, mg.cell]))
    (out / "survey-check.json").write_text(json.dumps(report, indent=1), encoding="utf-8")

    # --- console summary ----------------------------------------------------------------------------
    print("\nCHECK SURVEY  (diff = model - lidar; dz %s)" % ("NOT applied" if (not args.dz) else "applied"))
    print("transforms match props.json: %s" % report["checks"]["allTransformsMatch"])
    print("%-24s %5s %6s %6s %6s %7s %6s %6s %6s %6s" % ("asset", "cells", "med|d|", "P90", ">0.5%", "missing", "noLid", "ridgeM", "ridgeL", "eaveM"))
    for n in names:
        s = stats_of[n]
        print("%-24s %5d %6s %6s %6s %7s %6s %6s %6s %6s" % (
            short(n), s["comparedCells"], s.get("absDiffMedianM"), s.get("absDiffP90M"), s.get("pctOffByMoreThan0_5m"),
            s["lidarRoofOutsideModel"]["cells05m"], s["modelRoofWithoutLidar"]["blocks"], s["model"].get("ridgeMaxM"),
            s["lidar"].get("ridgeP98InFootprintM"), s["model"].get("eaveP5M")))
    if "roofColours" in report:
        print("\nROOF COLOURS (sRGB; model = as exported, cal = white-balanced on grey asphalt + sun-shade corrected, 2025)")
        print("%-16s %-14s %6s %-13s %-13s %-13s %5s %5s %5s %5s" % ("asset", "material", "m2", "model", "ortho raw", "ortho cal", "dE", "dL", "dC", "dH"))
        for r in report["roofColours"]["rows"]:
            o = r["ortho"]["2025"]
            c = o["calibratedVsModel"]
            print("%-16s %-14s %6.0f %-13s %-13s %-13s %5s %+5.0f %+5.0f %+5.0f" % (short(r["asset"]), r["material"].replace("omberg_", ""), r["areaM2"],
                  ",".join(map(str, r["modelSrgb"])), ",".join(map(str, o["rawMedianSrgb"])), ",".join(map(str, o["calibratedSrgb"])), c["dE76"], c["dL"], c["dChroma"], c["dHueDeg"]))
    print("wrote", out)


if __name__ == "__main__":
    main()
