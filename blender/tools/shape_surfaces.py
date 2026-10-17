"""Surface regions of a merged road shape: which part of its mesh is asphalt, gravel, dirt ... (pure Python).

The GSPro SVG writes every touching road piece of any surface as ONE shape per network (`roads_124`), because
OPCD's build needs the junction fillets dissolved inside one shape. The sidecar `<svg stem>-paths.json`
(`golfmap-path-regions-v1`, pipeline/gspro.py `_road_regions`) keeps every piece's surface and outline, and
`golfmap.split_surfaces` (shape_apply.py) cuts the shape's OPCD meshes along the seams between the surfaces and
separates them into one object per surface. This module is the geometry of that step, without bpy or numpy, so
`shape_surfaces_test.py` runs it with plain Python:

- **Pieces.** `known` = a piece with a surface that is not a junction piece; `derived` = a junction piece
  (`source: road-junctions`: a kerb fillet filling the inside corner of two roads, or a width taper; they reach
  0.5 m into the roads they were made for) or a road piece without a surface. Rings are the pieces' outer rings
  (the sidecar keeps no holes).
- **Surface rank** (RANK, high to low): asphalt, concrete, paving, wood, gravel, dirt (then any other surface, by
  name). Where pieces of two surfaces overlap, the higher one wins, so the seam is the higher road's own kerb.
- **Derived pieces** go to the surface they lie along most: the length of their outline inside each surface's
  region of the known pieces (highest known surface at the point; a fillet leg 0.5 m inside the asphalt road counts
  for asphalt even where the gravel road's own outline also reaches under the asphalt), the longest wins; lengths
  within `tie` (relative, default 15 %) of the longest are a tie and the higher rank wins (a symmetric T-junction
  fillet goes to the major road, the higher surface). A derived piece only owns the part of it outside every known
  piece of another surface: its legs inside the other road never become a 0.5 m strip of its surface along that
  road's kerb, only the flare outside both roads does (the brief's "union of its pieces + its junction pieces"
  would leave such strips).
- **Classifier** (`Regions.covered(x, y)`): the highest-ranked known piece containing the point, else the
  highest-ranked assigned surface of a derived piece containing it, else None (not covered: the merge's closing
  filled a slit there, or it is outside the shape). `Regions.region(x, y)` fills the uncovered points with the
  nearest covered region (exact: the nearest point of the covered set lies on an outer sub-segment).
- **Seams** (`Regions.seams`): every piece outline cut at every crossing with another; a sub-segment is a seam when
  the points just left and right of it are covered by different surfaces. Chained into polylines, low (lower-ranked)
  surface on the left of the direction of travel, simplified (Douglas-Peucker, 5 mm).
- **Ragged seams** (`ragged` > 0, golfmap.split_surfaces' `raggedM`): where a loose road (gravel, dirt) meets a hard
  one (asphalt, concrete, paving) the seam is no straight kerb line: tyres drag gravel out onto the asphalt in
  lobes, and the asphalt edge crumbles. Such a chain is resampled every RAGGED_STEP and moved off the kerb: up to
  `ragged` m onto the hard road (the spill, a few broad lobes with smaller ones on them) and a few cm either way
  (the crumbled edge), tapering to nothing over RAGGED_END_M at an open chain's ends so it still meets the outline
  where the kerb does. A point that would leave the hard road (or come within RAGGED_MARGIN of its far side) is
  pulled back, and a chain that would cross itself is retried at half the reach (twice), then left straight. The
  mesh cut follows the ragged line, so the two surfaces meet in a hard but uneven edge, not a fade; `region` then
  answers by the ragged line near it (`straight` keeps the kerb line for the fade lines).
- **Fade lines** (`Regions.fade_lines(width)`): the seams offset `width` into the lower surface (not for sharp
  pairs: asphalt / concrete), kept only where they really are `width` from every fading seam and inside the lower
  region: shape_apply cuts them so the vertex-paint fade (red at `width`, black at the seam) has vertices to live on.

Coordinates: any planar frame; Regions takes a `to_xy` for the sidecar's SVG units (shape_apply passes the .blend
frame, `svg_to_blend`). Lengths are metres in both.
"""

import hashlib
import json
import math
import os

FORMAT = "golfmap-path-regions-v1"
JUNCTION_SOURCE = "road-junctions"
RANK = ("asphalt", "concrete", "paving", "wood", "gravel", "dirt")
SHARP_PAIRS = (frozenset(("asphalt", "concrete")),)  # seams with no paint fade (two hard surfaces, a crisp edge)
DEFAULT_TIE = 0.15
DEFAULT_SLIT = 0.8  # outlines of two surfaces closer than this across uncovered ground: a slit (the SVG merge closes
#                     gaps up to 2 x ROADS_CLOSE_M = 0.6 m; a little more so the medial line reaches the mesh edge)
RAGGED_HARD = ("asphalt", "concrete", "paving")
RAGGED_LOOSE = ("gravel", "dirt")
DEFAULT_RAGGED = 0.35  # split_surfaces' raggedM: how far gravel spills onto the hard road at most (m)
RAGGED_STEP = 0.1     # vertex spacing of a ragged seam (m): 5-10 cm, above the cut's sliver collapse (5 cm)
RAGGED_END_M = 0.5    # the displacement tapers to nothing over this much chain at an open chain's ends
RAGGED_MARGIN = 0.25  # a spill lobe keeps this far inside the hard road (its far side, a hole, another seam)
SIMPLIFY_M = 0.005
SIDE_EPS = 1e-3  # how far left/right of a sub-segment its sides are sampled (m)
KEY_DIGITS = 6  # endpoint keys round to 1 um


# ---------------------------------------------------------------- sidecar

def sidecar_for_svg(svg_path):
    """The road-surface sidecar written next to an SVG: <stem>-paths.json."""
    stem, _ = os.path.splitext(svg_path)
    return stem + "-paths.json"


def load_sidecar(path):
    with open(path, encoding="utf-8") as f:
        doc = json.load(f)
    if doc.get("format") != FORMAT:
        raise ValueError(f"{path}: format must be {FORMAT!r}")
    return doc


def mixed_shapes(doc):
    """Road shapes of the sidecar whose pieces carry more than one surface."""
    return sorted(n for n, r in (doc.get("regions") or {}).items() if r.get("mixed"))


def shape_key(doc, shape):
    """A hash of one shape's regions entry (the op-result cache keys on it)."""
    entry = (doc.get("regions") or {}).get(shape)
    return hashlib.sha1(json.dumps(entry, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def svg_to_blend(frame):
    """(svg x, svg y) -> .blend (x, y): SVG x = E - e0, y = n1 - N; .blend x = -(E - e0 + px), y = -(N - n0 + pz)
    (shape_coords; SHAPING-PLAN.md "Coordinates")."""
    side, px, pz = frame["sideM"], frame.get("px", 0.0), frame.get("pz", 0.0)
    return lambda x, y: (-(x + px), y - side - pz)


def rank(surface):
    """Sort key: RANK order first, then any other surface by name, None last."""
    if surface in RANK:
        return (0, RANK.index(surface), "")
    return (1, 0, surface) if surface else (2, 0, "")


def higher(a, b):
    return a if rank(a) <= rank(b) else b


def is_sharp(a, b):
    return frozenset((a, b)) in SHARP_PAIRS


def is_ragged(high, low):
    """A seam that is drawn ragged (a loose road against a hard one)."""
    return high in RAGGED_HARD and low in RAGGED_LOOSE


def _hash(ix, iy, seed):
    n = (ix * 374761393 + iy * 668265263 + seed * 2147483647) & 0xFFFFFFFF
    n = ((n ^ (n >> 13)) * 1274126177) & 0xFFFFFFFF
    n = n ^ (n >> 16)
    return (n & 0xFFFF) / 32767.5 - 1.0


def _noise(x, y, seed):
    """Smooth value noise in [-1, 1] on a 1-unit lattice (shape_edgefade.value_noise's, without importing it)."""
    ix, iy = math.floor(x), math.floor(y)
    fx, fy = x - ix, y - iy
    sx, sy = fx * fx * (3 - 2 * fx), fy * fy * (3 - 2 * fy)
    a, b = _hash(ix, iy, seed), _hash(ix + 1, iy, seed)
    c, d = _hash(ix, iy + 1, seed), _hash(ix + 1, iy + 1, seed)
    top = a + (b - a) * sx
    return top + ((c + (d - c) * sx) - top) * sy


def ragged_offset(s, length, reach, seed, closed=False):
    """How far (m) a ragged seam lies left of its kerb line at `s` m along it: negative = onto the hard road (on
    the right). Lobes of spilled gravel (0.1..1 x reach, broad ones ~2 m apart with ~0.5 m ones on them), a
    crumbled edge of bays and teeth (~6 cm at 0.3 m) and a jagged grit of +-3.5 cm per vertex; zero at an open
    chain's ends."""
    u = 0.5 + 0.5 * _noise(s / 2.0, 0.0, seed)
    v = 0.5 + 0.5 * _noise(s / 0.5, 3.1, seed)
    spill = reach * (0.1 + 0.65 * u * u + 0.25 * v * v)
    crumble = 0.06 * _noise(s / 0.3, 7.7, seed) + 0.035 * _hash(int(round(s / RAGGED_STEP)), 9, seed)
    taper = 1.0
    if not closed or length < 4 * RAGGED_END_M:
        e = min(s, length - s) / RAGGED_END_M
        taper = 0.0 if e <= 0 else 1.0 if e >= 1 else e * e * (3 - 2 * e)
    return taper * (crumble - spill)


# ---------------------------------------------------------------- small geometry

def _key(p):
    return (round(p[0], KEY_DIGITS), round(p[1], KEY_DIGITS))


def seg_point_distance(px, py, ax, ay, bx, by):
    """(distance, t) of point p to segment ab."""
    dx, dy = bx - ax, by - ay
    L = dx * dx + dy * dy
    t = 0.0 if L <= 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / L))
    qx, qy = ax + t * dx - px, ay + t * dy - py
    return math.sqrt(qx * qx + qy * qy), t


def seg_intersections(a, b, c, d, eps=1e-9):
    """Parameters t along ab where segment cd meets it (crossing, touching, or the ends of a collinear overlap)."""
    r = (b[0] - a[0], b[1] - a[1])
    s = (d[0] - c[0], d[1] - c[1])
    rxs = r[0] * s[1] - r[1] * s[0]
    qp = (c[0] - a[0], c[1] - a[1])
    rr = r[0] * r[0] + r[1] * r[1]
    if rr <= 0:
        return []
    out = []
    lr, ls = math.sqrt(rr), math.hypot(*s)
    if abs(rxs) <= eps * lr * max(ls, eps):  # parallel
        if abs(qp[0] * r[1] - qp[1] * r[0]) > eps * lr * max(1.0, lr):
            return []  # not collinear
        for p in (c, d):  # collinear: the other's end points that lie on ab
            t = ((p[0] - a[0]) * r[0] + (p[1] - a[1]) * r[1]) / rr
            if -eps <= t <= 1 + eps:
                out.append(min(1.0, max(0.0, t)))
        return out
    t = (qp[0] * s[1] - qp[1] * s[0]) / rxs
    u = (qp[0] * r[1] - qp[1] * r[0]) / rxs
    tol_t, tol_u = eps / lr, eps / max(ls, eps)
    if -tol_t <= t <= 1 + tol_t and -tol_u <= u <= 1 + tol_u:
        out.append(min(1.0, max(0.0, t)))
    return out


def point_in_ring(x, y, pts):
    inside = False
    n = len(pts)
    j = n - 1
    for i in range(n):
        xi, yi = pts[i]
        xj, yj = pts[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def ring_area(pts):
    a = 0.0
    for i in range(len(pts)):
        x0, y0 = pts[i - 1]
        x1, y1 = pts[i]
        a += x0 * y1 - x1 * y0
    return abs(a) / 2


def simplify(points, tol=SIMPLIFY_M):
    """Douglas-Peucker; the end points are kept (a closed chain keeps its start = end)."""
    if len(points) < 3 or tol <= 0:
        return list(points)
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        i, j = stack.pop()
        if j <= i + 1:
            continue
        a, b = points[i], points[j]
        best, k = -1.0, None
        for m in range(i + 1, j):
            dist = seg_point_distance(points[m][0], points[m][1], a[0], a[1], b[0], b[1])[0]
            if dist > best:
                best, k = dist, m
        if best > tol:
            keep[k] = True
            stack += [(i, k), (k, j)]
    return [p for p, f in zip(points, keep) if f]


def polyline_length(points):
    return sum(math.dist(points[i], points[i + 1]) for i in range(len(points) - 1))


class Ring:
    """A polygon ring with an index of its edges by y slab, so point-in-ring tests only the edges crossing the
    point's row."""

    SLAB = 1.0

    def __init__(self, pts):
        if len(pts) > 1 and _key(pts[0]) == _key(pts[-1]):
            pts = pts[:-1]
        self.pts = [(float(x), float(y)) for x, y in pts]
        xs, ys = [p[0] for p in self.pts], [p[1] for p in self.pts]
        self.bbox = (min(xs), min(ys), max(xs), max(ys))
        self.slabs = {}
        n = len(self.pts)
        for i in range(n):
            a, b = self.pts[i - 1], self.pts[i]
            lo, hi = min(a[1], b[1]), max(a[1], b[1])
            for s in range(math.floor(lo / self.SLAB), math.floor(hi / self.SLAB) + 1):
                self.slabs.setdefault(s, []).append((a, b))

    def segments(self):
        return [(self.pts[i - 1], self.pts[i]) for i in range(len(self.pts))]

    def contains(self, x, y):
        b = self.bbox
        if x < b[0] or x > b[2] or y < b[1] or y > b[3]:
            return False
        inside = False
        for (xi, yi), (xj, yj) in self.slabs.get(math.floor(y / self.SLAB), ()):
            if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
                inside = not inside
        return inside

    def area(self):
        return ring_area(self.pts)


class SegmentGrid:
    """Segments in a uniform grid of `cell` m (each one in every cell its bounding box covers)."""

    def __init__(self, cell=4.0):
        self.cell = cell
        self.cells = {}
        self.items = []

    def add(self, a, b, data=None):
        i = len(self.items)
        self.items.append((a, b, data))
        c = self.cell
        for cx in range(math.floor(min(a[0], b[0]) / c), math.floor(max(a[0], b[0]) / c) + 1):
            for cy in range(math.floor(min(a[1], b[1]) / c), math.floor(max(a[1], b[1]) / c) + 1):
                self.cells.setdefault((cx, cy), []).append(i)
        return i

    def query_box(self, x0, y0, x1, y1):
        c = self.cell
        out = set()
        for cx in range(math.floor(x0 / c), math.floor(x1 / c) + 1):
            for cy in range(math.floor(y0 / c), math.floor(y1 / c) + 1):
                out.update(self.cells.get((cx, cy), ()))
        return sorted(out)

    def nearest(self, x, y, max_r=None):
        """(distance, index) of the nearest segment, or (inf, None)."""
        if not self.items:
            return float("inf"), None
        r = self.cell
        while True:
            best = (float("inf"), None)
            for i in self.query_box(x - r, y - r, x + r, y + r):
                a, b, _ = self.items[i]
                d = seg_point_distance(x, y, a[0], a[1], b[0], b[1])[0]
                if d < best[0]:
                    best = (d, i)
            if best[1] is not None and best[0] <= r:
                return best  # every segment within r of the point was looked at
            if max_r is not None and r >= max_r:
                return best
            if r > 1e5:
                return best
            r *= 2

    def within(self, x, y, radius):
        """Indices of segments within `radius` of the point."""
        out = []
        for i in self.query_box(x - radius, y - radius, x + radius, y + radius):
            a, b, _ = self.items[i]
            if seg_point_distance(x, y, a[0], a[1], b[0], b[1])[0] <= radius:
                out.append(i)
        return out


# ---------------------------------------------------------------- regions

class Regions:
    """The surface regions of one road shape from its sidecar pieces (see the module docstring).

    pieces: the sidecar's `regions[<shape>].pieces`; to_xy: SVG (x, y) -> working (x, y) (default identity);
    dominant: the shape's dominant surface (a derived piece touching no known one falls back to it)."""

    def __init__(self, pieces, to_xy=None, tie=DEFAULT_TIE, dominant=None, eps=SIDE_EPS, slit=DEFAULT_SLIT,
                 ragged=0.0):
        to_xy = to_xy or (lambda x, y: (x, y))
        self.tie = tie
        self.eps = eps
        self.slit = slit
        self.pieces = []  # {index, id, featureNo, surface (own), source, for, derived, rings: [Ring]}
        for i, p in enumerate(pieces):
            rings = []
            for ring in p.get("rings") or []:
                pts = [to_xy(float(x), float(y)) for x, y in ring]
                if len(pts) >= 3:
                    r = Ring(pts)
                    if len(r.pts) >= 3 and r.area() > 0:
                        rings.append(r)
            if not rings:
                continue
            derived = p.get("source") == JUNCTION_SOURCE or not p.get("surface")
            self.pieces.append({"index": i, "id": p.get("id"), "featureNo": p.get("featureNo"), "surface": p.get("surface"),
                                "source": p.get("source"), "for": list(p.get("for") or []), "derived": derived, "rings": rings})
        self.dominant = dominant or self._dominant()
        self.ring_grid = {}  # 25 m cells -> [(piece position, ring)]
        for k, p in enumerate(self.pieces):
            for r in p["rings"]:
                for cell in self._cells(r.bbox, 25.0):
                    self.ring_grid.setdefault(cell, []).append((k, r))
        self._arrangement()
        self.assigned = {}  # piece position -> surface
        self.assignment = []  # report rows for derived pieces
        self._assign_derived()
        self._seams_and_outline()
        self.ragged = max(0.0, float(ragged or 0.0))
        self.ragged_grid = None
        self.ragged_report = {"chains": 0, "straight": 0, "halved": 0, "pulledBack": 0}
        if self.ragged > 0:
            self._ragged_seams()

    # ---- building blocks

    @staticmethod
    def _cells(bbox, size):
        return [(cx, cy) for cx in range(math.floor(bbox[0] / size), math.floor(bbox[2] / size) + 1)
                for cy in range(math.floor(bbox[1] / size), math.floor(bbox[3] / size) + 1)]

    def _dominant(self):
        area = {}
        for p in self.pieces:
            if not p["derived"]:
                area[p["surface"]] = area.get(p["surface"], 0.0) + sum(r.area() for r in p["rings"])
        return max(sorted(area), key=lambda s: area[s]) if area else None

    def surfaces(self):
        """Every surface a region can have, high to low."""
        s = {p["surface"] for p in self.pieces if not p["derived"]} | set(self.assigned.values())
        return sorted((x for x in s if x), key=rank)

    def _containing(self, x, y):
        out = []
        for k, r in self.ring_grid.get((math.floor(x / 25.0), math.floor(y / 25.0)), ()):
            if r.contains(x, y):
                out.append(k)
        return out

    def known_class(self, x, y):
        """The highest-ranked surface of the known pieces containing the point, else None."""
        best = None
        for k in self._containing(x, y):
            p = self.pieces[k]
            if not p["derived"] and (best is None or rank(p["surface"]) < rank(best)):
                best = p["surface"]
        return best

    def covered(self, x, y):
        """The point's surface: the highest known piece containing it, else the highest assigned derived piece,
        else None (not covered by any piece)."""
        known = derived = None
        for k in self._containing(x, y):
            p = self.pieces[k]
            if not p["derived"]:
                if known is None or rank(p["surface"]) < rank(known):
                    known = p["surface"]
            else:
                s = self.assigned.get(k)
                if s and (derived is None or rank(s) < rank(derived)):
                    derived = s
        return known if known is not None else derived

    def region(self, x, y):
        """(surface, filled): the covered surface, or the nearest covered region's (filled = True). Near a ragged
        seam, the side of the ragged line the point is on."""
        s = self.covered(x, y)
        if s is not None:
            if self.ragged_grid is not None:
                s = self._ragged_side(x, y, s)
            return s, False
        d, i = self.outer.nearest(x, y)
        if i is None:
            return self.dominant, True
        return self.outer.items[i][2], True

    def _arrangement(self):
        """Every ring segment of every piece cut at its crossings with the other pieces' rings: self.subs =
        [(a, b, piece position)]."""
        grid = SegmentGrid(4.0)
        segs = []
        for k, p in enumerate(self.pieces):
            for r in p["rings"]:
                for a, b in r.segments():
                    if _key(a) != _key(b):
                        segs.append((a, b, k))
                        grid.add(a, b, len(segs) - 1)
        self.subs = []
        for a, b, k in segs:
            ts = {0.0, 1.0}
            for j in grid.query_box(min(a[0], b[0]) - 1e-6, min(a[1], b[1]) - 1e-6, max(a[0], b[0]) + 1e-6, max(a[1], b[1]) + 1e-6):
                c, d, _ = grid.items[j]
                if segs[grid.items[j][2]][2] == k:
                    continue  # the same piece (its own ring does not cut it)
                ts.update(seg_intersections(a, b, c, d))
            ts = sorted(ts)
            pts = [(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t) for t in ts]
            for p0, p1 in zip(pts, pts[1:]):
                if math.dist(p0, p1) > 1e-7:
                    self.subs.append((p0, p1, k))

    def _sides(self, a, b, classify):
        L = math.dist(a, b)
        e = min(self.eps, L / 4)
        nx, ny = -(b[1] - a[1]) / L, (b[0] - a[0]) / L
        mx, my = (a[0] + b[0]) / 2, (a[1] + b[1]) / 2
        return classify(mx + nx * e, my + ny * e), classify(mx - nx * e, my - ny * e)

    def _assign_derived(self):
        """Each derived piece to the surface its outline runs inside most (see the module docstring)."""
        lengths = {}
        for a, b, k in self.subs:
            if not self.pieces[k]["derived"]:
                continue
            mx, my = (a[0] + b[0]) / 2, (a[1] + b[1]) / 2
            s = self.known_class(mx, my)
            if s is None:  # on a kerb the midpoint may sit exactly on the known outline: either side decides
                left, right = self._sides(a, b, self.known_class)
                s = left or right
            if s is not None:
                rec = lengths.setdefault(k, {})
                rec[s] = rec.get(s, 0.0) + math.dist(a, b)
        for k, p in enumerate(self.pieces):
            if not p["derived"]:
                continue
            lens = lengths.get(k, {})
            if lens:
                top = max(lens.values())
                near = [s for s, v in lens.items() if top - v <= self.tie * top]
                surface = min(near, key=rank)
                why = "tie" if len(near) > 1 else "longest"
            else:
                surface, why = self.dominant, "dominant"
            self.assigned[k] = surface
            self.assignment.append({"piece": p["id"], "featureNo": p["featureNo"], "source": p["source"], "for": p["for"],
                                    "ownSurface": p["surface"], "surface": surface, "why": why,
                                    "alongM": {s: round(v, 2) for s, v in sorted(lens.items())}})

    def _seams_and_outline(self):
        """Seam sub-segments (low surface on their left) chained into polylines, plus the medial lines of slits
        (_slit_seams); outer sub-segments (one side uncovered; stored with the covered side on their left) into a
        grid for the nearest-region fill."""
        self.outer = SegmentGrid(4.0)
        seam_subs = {}
        outer_keys = set()
        for a, b, _ in self.subs:
            left, right = self._sides(a, b, self.covered)
            if left is None and right is None:
                continue
            if left is None or right is None:
                key = frozenset((_key(a), _key(b)))
                if key not in outer_keys:
                    outer_keys.add(key)
                    if left is None:
                        self.outer.add(b, a, right)
                    else:
                        self.outer.add(a, b, left)
                continue
            if left == right:
                continue
            hi, lo = higher(left, right), (right if higher(left, right) == left else left)
            p, q = (a, b) if left == lo else (b, a)
            key = frozenset((_key(p), _key(q)))
            seam_subs.setdefault(key, (p, q, hi, lo))
        slits = self._slit_seams()
        self.seam_grid = SegmentGrid(4.0)
        for p, q, hi, lo in seam_subs.values():
            self.seam_grid.add(p, q, (hi, lo))
        for chain in slits:
            pts = chain["points"]
            for p, q in zip(pts, pts[1:]):
                self.seam_grid.add(p, q, (chain["high"], chain["low"]))
        self.slits = slits
        self.seams = self._chain(list(seam_subs.values())) + slits

    def _ragged_side(self, x, y, s):
        """`s` (the covered surface) or, within reach of a ragged seam between `s` and another surface, the
        surface on the point's side of the ragged line (left = the loose one)."""
        g = self.ragged_grid
        r = self.ragged + 0.1
        best = None
        for i in g.query_box(x - r, y - r, x + r, y + r):
            a, b, (hi, lo) = g.items[i]
            if s not in (hi, lo):
                continue
            d, _ = seg_point_distance(x, y, a[0], a[1], b[0], b[1])
            if d <= r and (best is None or d < best[0]):
                best = (d, a, b, hi, lo)
        if best is None:
            return s
        _, a, b, hi, lo = best
        cross = (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0])
        return lo if cross > 0 else hi

    def _ragged_chain(self, chain, reach, seed):
        """(ragged points of one chain at `reach`, points pulled back), the points None when they cross."""
        closed = chain["closed"]
        pts = resample(chain["points"], RAGGED_STEP)
        n = len(pts)
        hi, lo = chain["high"], chain["low"]
        stations = [0.0]
        for p, q in zip(pts, pts[1:]):
            stations.append(stations[-1] + math.dist(p, q))
        length = stations[-1]
        normals = []
        for i in range(n):
            a = pts[i - 1] if i > 0 else (pts[-2] if closed and n > 2 else pts[i])
            b = pts[i + 1] if i < n - 1 else (pts[1] if closed and n > 2 else pts[i])
            dx, dy = b[0] - a[0], b[1] - a[1]
            L = math.hypot(dx, dy) or 1.0
            normals.append((-dy / L, dx / L))  # left: the loose side
        want = [ragged_offset(st, length, reach, seed, closed) for st in stations]
        scale = [1.0] * n
        pulled = 0
        for i, (p, nv, d) in enumerate(zip(pts, normals, want)):
            if abs(d) < 1e-6:
                continue  # on the kerb (an end): nothing to check
            scale[i] = 0.0
            for f in (1.0, 0.5, 0.25):
                dd = d * f
                q = (p[0] + nv[0] * dd, p[1] + nv[1] * dd)
                if dd < 0:
                    far = (p[0] + nv[0] * (dd - RAGGED_MARGIN), p[1] + nv[1] * (dd - RAGGED_MARGIN))
                    ok = self.covered(*q) == hi and self.covered(*far) == hi
                else:
                    ok = self.covered(*q) in (hi, lo)
                if ok:
                    scale[i] = f
                    break
            if scale[i] < 1.0:
                pulled += 1
        # a pulled-back point pulls its neighbours with it (no spikes): the smallest scale within 5 points
        smooth = [min(scale[max(0, i - 5):i + 6]) for i in range(n)]
        out = [(p[0] + nv[0] * d * f, p[1] + nv[1] * d * f) for p, nv, d, f in zip(pts, normals, want, smooth)]
        if closed:
            out[-1] = out[0]
        else:
            out[0], out[-1] = pts[0], pts[-1]
        if _self_crossing(out, closed):
            return None, pulled
        return out, pulled

    def _ragged_seams(self):
        """Replace every ragged pair's chain in self.seams by its ragged line; self.ragged_grid indexes them."""
        import zlib
        self.ragged_grid = SegmentGrid(2.0)
        for chain in self.seams:
            if not is_ragged(chain["high"], chain["low"]) or chain["length"] < 2 * RAGGED_STEP:
                continue
            k = _key(chain["points"][0])
            seed = zlib.crc32(("%s|%s|%.3f|%.3f" % (chain["high"], chain["low"], k[0], k[1])).encode()) & 0x7FFFFFFF
            reach, out, pulled = self.ragged, None, 0
            for _ in range(3):
                out, pulled = self._ragged_chain(chain, reach, seed)
                if out is not None:
                    break
                reach *= 0.5
                self.ragged_report["halved"] += 1
            self.ragged_report["chains"] += 1
            if out is None:
                self.ragged_report["straight"] += 1
                continue
            self.ragged_report["pulledBack"] += pulled
            chain["straight"] = chain["points"]
            chain["points"] = out
            chain["length"] = polyline_length(out)
            chain["ragged"] = round(reach, 3)
            for p, q in zip(out, out[1:]):
                if _key(p) != _key(q):
                    self.ragged_grid.add(p, q, (chain["high"], chain["low"]))

    def _slit_seams(self, step=0.1):
        """Where the outlines of two surfaces face each other across uncovered ground closer than `slit`
        (a slit the merge's closing filled), the nearest-region fill splits it along its medial line, which no
        piece outline follows: the medial line as a seam polyline, so the mesh cut follows it instead of
        stair-stepping over the triangles. Sampled every `step` along the higher surface's outer outline (its
        end points included, so a medial line starts exactly where the two outlines meet): the midpoint between
        the sample and the nearest point of another surface's outline on the uncovered side, when that point is
        within `slit` and the midpoint is uncovered. Chains: [{high, low, points, length, closed, slit: True}]."""
        if self.slit <= 0 or not self.outer.items:
            return []
        out = []
        by_class = {}
        for i, (a, b, c) in enumerate(self.outer.items):
            by_class.setdefault(c, []).append(i)
        # Chain each class's outer sub-segments (covered side on the left) so the samples come in order.
        for cls in sorted(by_class, key=rank):
            subs = [(self.outer.items[i][0], self.outer.items[i][1], cls, None) for i in by_class[cls]]
            for chain in self._chain(subs, keep=True):
                pts = chain["points"]
                run, run_low = [], None
                runs = []  # (points, low) of this chain, in order
                samples = []
                for k in range(len(pts) - 1):
                    a, b = pts[k], pts[k + 1]
                    L = math.dist(a, b)
                    n = max(1, int(math.ceil(L / step)))
                    for j in range(n + (1 if k == len(pts) - 2 else 0)):
                        t = j / n
                        nx, ny = (b[1] - a[1]) / L, -(b[0] - a[0]) / L  # right = the uncovered side
                        samples.append(((a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t), (nx, ny)))
                for p, (nx, ny) in samples:
                    best = None
                    for i in self.outer.within(p[0], p[1], self.slit):
                        a, b, other = self.outer.items[i]
                        if other == cls or rank(other) <= rank(cls):
                            continue  # only toward a lower surface (the higher one samples)
                        d, t = seg_point_distance(p[0], p[1], a[0], a[1], b[0], b[1])
                        q = (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)
                        if d > 1e-6:
                            if (q[0] - p[0]) * nx + (q[1] - p[1]) * ny <= 0:
                                continue  # behind the outline (across the covered side)
                            if self.covered((p[0] + q[0]) / 2, (p[1] + q[1]) / 2) is not None:
                                continue  # a piece in between: not a slit
                        if best is None or d < best[0]:
                            best = (d, q, other)
                    if best is not None and (run_low is None or best[2] == run_low):
                        run.append(((p[0] + best[1][0]) / 2, (p[1] + best[1][1]) / 2))
                        run_low = best[2]
                        continue
                    runs.append((run, run_low, False))
                    run, run_low = ([((p[0] + best[1][0]) / 2, (p[1] + best[1][1]) / 2)], best[2]) if best else ([], None)
                runs.append((run, run_low, True))
                # A closed outline starts anywhere: a run through its start is one run (last + first).
                if chain["closed"] and len(runs) > 1 and runs[0][0] and runs[-1][0] and runs[0][1] == runs[-1][1]:
                    runs = [(runs[-1][0] + runs[0][0][1:], runs[0][1], True)] + runs[1:-1]
                out += [(r, cls, low) for r, low, _ in runs if len(r) >= 2]
        chains = []
        for pts, hi, lo in out:
            pts = simplify(pts)
            # the lower surface lies on the uncovered side of the higher outline = the right of the sampling
            # direction: reverse so it is on the left, as for every seam
            pts = pts[::-1]
            if polyline_length(pts) >= 1e-3:
                chains.append({"high": hi, "low": lo, "points": pts, "length": polyline_length(pts), "closed": False, "slit": True})
        return chains

    @staticmethod
    def _chain(subs, keep=False):
        """Directed sub-segments (p, q, hi, lo) -> chains [{high, low, points, length, closed}]: consecutive pieces
        share an end point and the same pair; a node where more than one continues ends the chain. keep: no
        simplification (the slit sampler wants every vertex)."""
        starts, ends = {}, {}
        for i, (p, q, hi, lo) in enumerate(subs):
            starts.setdefault((_key(p), hi, lo), []).append(i)
            ends.setdefault((_key(q), hi, lo), []).append(i)

        def through(node):  # a node a chain passes straight through: one piece in, one out (same pair)
            return len(starts.get(node, ())) == 1 and len(ends.get(node, ())) == 1

        used = [False] * len(subs)
        chains = []

        def walk(i):
            p, q, hi, lo = subs[i]
            pts = [p, q]
            used[i] = True
            while through((_key(pts[-1]), hi, lo)):
                j = starts[(_key(pts[-1]), hi, lo)][0]
                if used[j]:
                    break  # back at the start: a closed loop
                used[j] = True
                pts.append(subs[j][1])
            return pts, hi, lo

        order = sorted(range(len(subs)), key=lambda i: (_key(subs[i][0]), _key(subs[i][1])))
        for i in order:  # open chains start where the chain does not simply pass through
            p, _, hi, lo = subs[i]
            if not used[i] and not through((_key(p), hi, lo)):
                chains.append(walk(i))
        for i in order:  # what is left are closed loops
            if not used[i]:
                chains.append(walk(i))
        out = []
        for pts, hi, lo in chains:
            closed = len(pts) > 2 and _key(pts[0]) == _key(pts[-1])
            pts = pts if keep else simplify(pts)
            out.append({"high": hi, "low": lo, "points": pts, "length": polyline_length(pts), "closed": closed})
        out.sort(key=lambda c: (rank(c["high"]), rank(c["low"]), _key(c["points"][0])))
        return out

    # ---- queries for the mesh step

    def seam_distance(self, x, y, low=None, fading=True, max_r=None):
        """Distance to the nearest seam (with `low` as its lower surface, and only fading pairs when `fading`)."""
        best = float("inf")
        r = self.seam_grid.cell
        while True:
            for i in self.seam_grid.query_box(x - r, y - r, x + r, y + r):
                a, b, (hi, lo) = self.seam_grid.items[i]
                if low is not None and lo != low:
                    continue
                if fading and is_sharp(hi, lo):
                    continue
                best = min(best, seg_point_distance(x, y, a[0], a[1], b[0], b[1])[0])
            if best <= r or (max_r is not None and r >= max_r) or r > 1e5 or not self.seam_grid.items:
                return best
            r *= 2

    def fade_lines(self, width):
        """Polylines `width` into the lower side of every fading seam (see the module docstring):
        [{low, high, points}]."""
        tol = min(0.02, width * 0.05)
        out = []
        for chain in self.seams:
            if is_sharp(chain["high"], chain["low"]) or len(chain["points"]) < 2:
                continue
            off = offset_polyline(chain.get("straight", chain["points"]), width, chain["closed"])
            lo = chain["low"]

            def good(pt):
                return (self.region(pt[0], pt[1])[0] == lo
                        and self.seam_distance(pt[0], pt[1], lo, True, max_r=width * 4) >= width - tol)

            ok = [good(p) for p in off]
            run = []
            for i, p in enumerate(off):
                mid_ok = i > 0 and ok[i] and ok[i - 1] and good(((off[i - 1][0] + p[0]) / 2, (off[i - 1][1] + p[1]) / 2))
                if ok[i] and run and mid_ok:
                    run.append(p)
                    continue
                if len(run) >= 2:
                    out.append({"low": lo, "high": chain["high"], "points": run})
                run = [p] if ok[i] else []
            if len(run) >= 2:
                out.append({"low": lo, "high": chain["high"], "points": run})
        return out

    def report(self):
        pairs = {}
        for c in self.seams:
            k = c["high"] + "/" + c["low"]
            pairs[k] = round(pairs.get(k, 0.0) + c["length"], 2)
        area = {}
        for p in self.pieces:
            s = p["surface"] if not p["derived"] else self.assigned.get(self.pieces.index(p))
            area[s or "none"] = round(area.get(s or "none", 0.0) + sum(r.area() for r in p["rings"]), 1)
        out = {"surfaces": self.surfaces(), "dominant": self.dominant, "pieces": len(self.pieces),
               "derived": self.assignment, "pieceAreaM2": area, "seamChains": len(self.seams), "seamM": pairs}
        if self.ragged > 0:
            out["ragged"] = dict(self.ragged_report, reachM=self.ragged)
        return out


def resample(points, step):
    """The polyline with a vertex at least every `step` m (its own vertices kept)."""
    out = [tuple(points[0])]
    for p, q in zip(points, points[1:]):
        k = max(1, math.ceil(math.dist(p, q) / step))
        for j in range(1, k + 1):
            t = j / k
            out.append((p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t))
    return out


def _self_crossing(pts, closed=False):
    """Whether two non-adjacent segments of the polyline cross or touch."""
    g = SegmentGrid(1.0)
    segs = list(zip(pts, pts[1:]))
    for i, (a, b) in enumerate(segs):
        g.add(a, b, i)
    m = len(segs)
    for i, (a, b) in enumerate(segs):
        for j in g.query_box(min(a[0], b[0]), min(a[1], b[1]), max(a[0], b[0]), max(a[1], b[1])):
            if j <= i + 1 or (closed and i == 0 and j == m - 1):
                continue
            if seg_intersections(a, b, *segs[j]):
                return True
    return False


def offset_polyline(points, d, closed=False):
    """The polyline moved `d` to its left (mitred joins, the mitre capped at 4 d)."""
    n = len(points)
    if n < 2:
        return list(points)
    normals = []
    for i in range(n - 1):
        a, b = points[i], points[i + 1]
        L = math.dist(a, b) or 1.0
        normals.append((-(b[1] - a[1]) / L, (b[0] - a[0]) / L))
    out = []
    for i in range(n):
        if i == 0 and not closed:
            nx, ny = normals[0]
            scale = 1.0
        elif i == n - 1 and not closed:
            nx, ny = normals[-1]
            scale = 1.0
        else:
            n0 = normals[i - 1] if i > 0 else normals[-1]
            n1 = normals[i] if i < n - 1 else normals[0]
            mx, my = n0[0] + n1[0], n0[1] + n1[1]
            L = math.hypot(mx, my)
            if L < 1e-9:
                nx, ny, scale = n1[0], n1[1], 1.0
            else:
                nx, ny = mx / L, my / L
                cos = nx * n1[0] + ny * n1[1]
                scale = min(4.0, 1.0 / max(cos, 1e-6))
        out.append((points[i][0] + nx * d * scale, points[i][1] + ny * d * scale))
    return out
