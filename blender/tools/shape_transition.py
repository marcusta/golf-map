"""Curve-local path transition paint. Pure sampling; bpy is imported only by apply()."""
import math
import hashlib
import json
import os
from collections import Counter
from shape_edgefade import value_noise, smoothstep

# Speed shims (same results; GOLFMAP_SHAPE_NO_FAST_SHIMS=1 leaves them out, which is how they are compared):
# the refinement, the paint and the write-out run on arrays instead of per vertex / corner Python objects,
# a centreline is rejected by its box before its grid, and the fringes' seam tree is built once.
FAST = os.environ.get("GOLFMAP_SHAPE_NO_FAST_SHIMS") != "1"


def project(point, line):
    """Nearest polyline station and signed lateral distance (metres)."""
    best = None
    station = 0.0
    for a, b in zip(line, line[1:]):
        dx, dy = b[0]-a[0], b[1]-a[1]
        length = math.hypot(dx, dy)
        if length < 1e-9:
            continue
        t = max(0.0, min(1.0, ((point[0]-a[0])*dx+(point[1]-a[1])*dy)/length**2))
        px, py = point[0]-a[0]-t*dx, point[1]-a[1]-t*dy
        distance = px*px+py*py
        candidate = (distance, station+t*length, (dx*py-dy*px)/length)
        if best is None or candidate[0] < best[0]:
            best = candidate
        station += length
    if best is None:
        raise ValueError('transition centreline needs two distinct points')
    return best[1], best[2], math.sqrt(best[0])


class LineIndex:
    """project() for the points within `band` metres of a polyline (None beyond): its segments in a grid of
    band-sized cells, so a long centreline costs a point only the segments beside it. Same result as project()."""
    def __init__(self, line, band):
        self.band = band
        self.cell = cell = max(band, .5)
        self.grid = {}
        self.segments = []
        station = 0.0
        for a, b in zip(line, line[1:]):
            length = math.hypot(b[0]-a[0], b[1]-a[1])
            if length < 1e-9:
                continue
            index = len(self.segments)
            self.segments.append((a, b, station))
            station += length
            for ix in range(math.floor((min(a[0], b[0])-band)/cell), math.floor((max(a[0], b[0])+band)/cell)+1):
                for iy in range(math.floor((min(a[1], b[1])-band)/cell), math.floor((max(a[1], b[1])+band)/cell)+1):
                    self.grid.setdefault((ix, iy), []).append(index)
        if not self.segments:
            raise ValueError('transition centreline needs two distinct points')
        # Everything this index can answer lies in here (a point outside is beyond the band of every
        # segment, which project() answers with None anyway).
        self.box = (min(min(a[0], b[0]) for a, b, _ in self.segments)-band,
                    min(min(a[1], b[1]) for a, b, _ in self.segments)-band,
                    max(max(a[0], b[0]) for a, b, _ in self.segments)+band,
                    max(max(a[1], b[1]) for a, b, _ in self.segments)+band)

    def project(self, point):
        if FAST and not (self.box[0] <= point[0] <= self.box[2] and self.box[1] <= point[1] <= self.box[3]):
            return None
        best = None
        for index in self.grid.get((math.floor(point[0]/self.cell), math.floor(point[1]/self.cell)), ()):
            a, b, station = self.segments[index]
            dx, dy = b[0]-a[0], b[1]-a[1]
            length = math.hypot(dx, dy)
            t = max(0.0, min(1.0, ((point[0]-a[0])*dx+(point[1]-a[1])*dy)/length**2))
            px, py = point[0]-a[0]-t*dx, point[1]-a[1]-t*dy
            distance = px*px+py*py
            if best is None or distance < best[0]:
                best = (distance, station+t*length, (dx*py-dy*px)/length)
        if best is None or best[0] > self.band**2:
            return None
        return best[1], best[2], math.sqrt(best[0])


def weights(along, lateral, spec, width):
    """RGB weights or None outside the longitudinal footprint. Sum is exactly one."""
    a = (along-spec['startM'])*spec.get('direction', 1)
    length = spec['transitionLengthM']
    hold = spec.get('holdLengthM', 0.0)
    fade = spec.get('fadeLengthM', 0.0)
    reach = spec.get('centerGrassReachM', 0.0)
    if a < -reach:
        return None
    if a > length+hold+fade and spec.get('ending') == 'grass':
        return (1.,0.,0.)
    if a < 0:
        # Longitudinal grass tongue into the solid road, feathered both along and across.
        tongue = smoothstep(-reach, 0, a)*(1-smoothstep(.12,.55,abs(lateral)))
        return tongue, 1-tongue, 0.0
    seed = int(spec.get('seed', 0))
    noise = value_noise(a/3.5, lateral/.8, seed)
    wobble = spec.get('edgeIrregularity', .2)*noise
    t = smoothstep(0.0, max(.001, length), a)
    wander = .07*math.sin(a*.65)+spec.get('variation', .3)*.15*value_noise(a/4, .3, seed+42)
    dist = abs(abs(lateral-wander)-spec.get('trackSpacingM', 1.5)/2)
    ribbon = 1-smoothstep(spec.get('trackWidthM', .6)/2, spec.get('trackWidthM', .6)/2+.35, dist)
    pattern = spec.get('pattern', 'soft-fade')
    if pattern == 'soft-fade':
        path = 1-(.85+.12*noise)*smoothstep(.05+wobble*.1, 1, t)
    elif pattern == 'wheel-tracks':
        path = (1-smoothstep(0, .65+wobble*.15, t))
        path += (1-path)*ribbon
    elif pattern == 'overgrown-gravel':
        centre = 1-smoothstep(.15, max(.16, width*.35), abs(lateral-wander))
        grass = t*centre
        path = (1-grass)*(1-.55*t)
        path = max(path, ribbon*.7*t)
    else:
        raise ValueError('unknown path transition pattern: '+pattern)
    if reach:
        path *= 1-(1-smoothstep(.12,.55,abs(lateral)))*(1-t)
    if a > length+hold and fade and spec.get('ending') == 'grass':
        f = smoothstep(0, fade, a-length-hold)
        path = path*(1-f)
    dirt = (1-path)*spec.get('dirtAmount', 0)*t*smoothstep(-.2,.3,value_noise(a/2.4,lateral/.85,seed+83))
    if a > length+hold and fade and spec.get('ending') == 'grass':
        dirt *= 1-smoothstep(0,fade,a-length-hold)
    return 1-path-dirt, path, dirt


def wear(along, lateral, spec, width):
    """Share (0..1) of the path surface that traffic has packed: two wheel tracks, or one trodden band
    (`tracks` 1), ragged, wandering, coming and going along the path; the shoulders stay loose."""
    seed = int(spec.get('seed', 0))
    x = lateral-.1*value_noise(along/7, .3, seed+42)
    centre = spec.get('trackSpacingM', 1.5)/2 if spec.get('tracks', 2) == 2 else 0.
    half = spec.get('trackWidthM', .6)/2*(1+.35*value_noise(along/1.3, lateral/.5, seed))
    ribbon = 1-smoothstep(half*.7, half+spec.get('edgeM', .2), abs(abs(x)-centre))
    patch = .75+.25*value_noise(along/9, 0., seed+83)
    shoulder = 1-smoothstep(width/2-.45, width/2-.2, abs(lateral))
    return max(0., min(1., spec.get('strength', 1.)*ribbon*patch*shoulder))


def grass_middle(along, lateral, spec):
    """Share (0..1) of grass down the middle of a gravel track (wear's `grassMiddle`): a ragged strip
    `halfWidthM` either side of the wandering centre, inside its `spans` only, narrowing to nothing over `taperM`
    at each span end (the wheels turn in and out near another road), with a bald patch here and there."""
    g = spec.get('grassMiddle')
    if not g:
        return 0.
    taper = g.get('taperM', 1.5)
    reach = 0.
    for a, b in g.get('spans', ()):
        if a <= along <= b:
            reach = max(reach, smoothstep(0, taper, along-a)*smoothstep(0, taper, b-along))
    if reach <= 0:
        return 0.
    seed = int(spec.get('seed', 0))
    x = lateral-.1*value_noise(along/7, .3, seed+42)  # the same wander as the wheel tracks (wear)
    half = g.get('halfWidthM', .3)*reach*(1+.3*value_noise(along/1.1, lateral/.4, seed+7))
    edge = g.get('edgeM', .1)
    strip = 1-smoothstep(half-edge*.5, half+edge*.5, abs(x))
    bald = smoothstep(.35, .75, value_noise(along/2.3, .7, seed+131))  # worn through where wheels cut across
    return max(0., min(1., strip*(1-.8*bald)))


def byte_weights(rgb, worn=0.):
    """RGB bytes summing to 255, then `worn` of the path's green taken out: what is missing from the sum is
    MAHS's black, the packed look of the surface (red, the grass Stix grows on, is not touched)."""
    g = max(0, min(255, round(rgb[1]*255)))
    b = max(0, min(255-g, round(rgb[2]*255)))
    return ((255-g-b)/255, round(g*(1-worn))/255, b/255, 1.0)


# ---------------------------------------------------------------- the array path (speed shim)
#
# Same algorithm as the scalar path below, on numpy arrays: a vertex's paint is kept per vertex instead of
# memoised per position lookup, the longest-edge choice and the face split run over all faces at once, and
# the corner normals / UVs / colours are interpolated and written as arrays. Every float is the one the
# scalar path computes: mathutils' length_squared is a double sum of float products, its normalized() scales
# by float32(1 / float32(sqrt(exact double dot))), a midpoint is a float32 average, a barycentric midpoint a
# double average (exactly representable either way), and the colours go through the same float32 -> byte
# conversion. Checked by a full Vreta apply against GOLFMAP_SHAPE_NO_FAST_SHIMS=1.

EDGE_BASE = 1 << 24    # an edge key is lo * EDGE_BASE + hi, so sorting the keys sorts by (lo, hi)
# Per set of split edges {0: v0v1, 1: v1v2, 2: v2v0} the parts the scalar path leaves, in its order, as
# indices into (v0, v1, v2, mid01, mid12, mid20) - the barycentrics follow the same indices.
SPLIT_PARTS = {
    0: ((0, 1, 2),),
    1: ((0, 3, 2), (3, 1, 2)),
    2: ((1, 4, 0), (4, 2, 0)),
    4: ((2, 5, 1), (5, 0, 1)),
    3: ((0, 3, 2), (1, 4, 3), (4, 2, 3)),
    5: ((2, 5, 3), (5, 0, 3), (3, 1, 2)),
    6: ((1, 4, 0), (2, 5, 4), (5, 0, 4)),
    7: ((2, 5, 3), (5, 0, 3), (1, 4, 3), (4, 2, 3)),
}


def _world(obj, co):
    """`obj.matrix_world @ v.co` per vertex as an (N, 3) float32 array."""
    import numpy as np
    m = obj.matrix_world
    if all(m[r][c] == (1.0 if r == c else 0.0) for r in range(4) for c in range(4)):
        return co.copy()
    from mathutils import Vector
    return np.array([tuple(m @ Vector(p)) for p in co.tolist()], dtype=np.float32) if len(co) \
        else np.zeros((0, 3), dtype=np.float32)


def _paint_rows(world, sample, curves):
    """(N, 4) paint and an (N,) painted mask for world positions. Only the points inside some centreline's
    box are sampled: paint_at answers None for every other one."""
    import numpy as np
    paint = np.zeros((len(world), 4))
    painted = np.zeros(len(world), dtype=bool)
    if not len(world):
        return paint, painted
    inside = np.zeros(len(world), dtype=bool)
    for _, line in curves:
        b = line.box
        inside |= ((world[:, 0] >= b[0]) & (world[:, 0] <= b[2])
                   & (world[:, 1] >= b[1]) & (world[:, 1] <= b[3]))
    index = np.nonzero(inside)[0]
    for i, p in zip(index.tolist(), world[index].tolist()):
        rgb = sample(p)
        if rgb is not None:
            paint[i] = rgb
            painted[i] = True
    return paint, painted


def _length_squared(d):
    """mathutils' Vector.length_squared of the (..., 3) float32 differences: float products in a double sum."""
    p = (d * d).astype(float)
    return (p[..., 0] + p[..., 1]) + p[..., 2]


def _normalized(acc):
    """mathutils' Vector.normalized() of an (..., 3) float32 array."""
    import numpy as np
    q = acc.astype(float)
    d = (q[..., 0] * q[..., 0] + q[..., 1] * q[..., 1]) + q[..., 2] * q[..., 2]
    inv = (np.float32(1.0) / np.sqrt(d).astype(np.float32))[..., None]
    return np.where((d > 1.0e-35)[..., None], acc * inv, np.float32(0.0))


def _interpolate(values, loops, bary):
    """Per corner the barycentric mix of its source triangle's three corner values, in the scalar path's
    order: (v0 * b0 + v1 * b1) + v2 * b2. `values` (L, k), `loops` (F, 3), `bary` (F, 3, 3) [face, corner, q]
    in `values`' dtype. Returns (F, 3, k)."""
    v = values[loops]                                    # (F, 3 = q, k)
    return ((v[:, 0][:, None, :] * bary[:, :, 0:1] + v[:, 1][:, None, :] * bary[:, :, 1:2])
            + v[:, 2][:, None, :] * bary[:, :, 2:3])


def _attr(data, key, width, dtype):
    import numpy as np
    buf = np.empty(len(data) * width, dtype=dtype)
    data.foreach_get(key, buf)
    return buf.reshape(-1, width)


class _SeamPaint:
    """What the meshes painted at each position, so a fringe can copy their bytes where it shares a vertex.
    The meshes are done first (they sort before the fringes), so the tree is built once, when the first
    fringe asks: the scalar path rebuilds it after every mesh."""

    def __init__(self):
        self.chunks = []
        self.tree = None
        self.values = None

    def put(self, positions, values):
        """Positions (n, 3) and their bytes (n, 4), in the order the scalar path's dict sees them (later
        entries win)."""
        self.chunks.append((positions, values))
        self.tree = None

    def build(self):
        import numpy as np
        from mathutils.kdtree import KDTree
        pos = np.concatenate([c[0] for c in self.chunks])
        val = np.concatenate([c[1] for c in self.chunks])
        _, first, inverse = np.unique(pos, axis=0, return_index=True, return_inverse=True)
        inverse = np.asarray(inverse).reshape(-1)
        last = np.zeros(len(first), dtype=np.int64)
        np.maximum.at(last, inverse, np.arange(len(inverse)))   # the dict keeps the last value of a key
        order = np.argsort(first, kind="stable")                # ... in the order the keys first appeared
        self.tree = KDTree(len(order))
        self.values = val[last[order]]
        for i, p in enumerate(pos[first[order]].tolist()):
            self.tree.insert(p, i)
        self.tree.balance()

    def match(self, positions):
        """Per position the mesh bytes within a millimetre of it, or None."""
        if not self.chunks:
            return [None] * len(positions)
        if self.tree is None:
            self.build()
        out = []
        for p in positions:
            _, index, distance = self.tree.find(p)
            out.append(self.values[index] if distance < .001 else None)
        return out


def _object_fast(obj, sample, curves, max_edge, seam):
    """One object's refinement and paint on arrays; the report entry, or None when nothing is painted."""
    import bpy
    import numpy as np
    me = obj.data
    blend = obj.get('opcd_kind') == 'blend'
    verts = _attr(me.vertices, 'co', 3, np.float32)
    world = _world(obj, verts)
    paint, painted = _paint_rows(world, sample, curves)
    if not painted.any():
        return None
    me.calc_loop_triangles()
    area = np.empty(len(me.loop_triangles), dtype=np.float32)
    me.loop_triangles.foreach_get('area', area)
    # OPCD cuts can leave zero-area triangulation slivers (see the scalar path).
    keep = area > 1e-10
    dropped_area = float(area[~keep].astype(float).sum())
    tri_v = _attr(me.loop_triangles, 'vertices', 3, np.int32)[keep].astype(np.int64)
    tri_l = _attr(me.loop_triangles, 'loops', 3, np.int32)[keep]
    tri_m = np.empty(len(me.loop_triangles), dtype=np.int32)
    me.loop_triangles.foreach_get('material_index', tri_m)
    tri_m = tri_m[keep]
    tri_p = np.empty(len(me.loop_triangles), dtype=np.int32)
    me.loop_triangles.foreach_get('polygon_index', tri_p)
    tri_p = tri_p[keep]
    poly_smooth = np.empty(len(me.polygons), dtype=bool)
    me.polygons.foreach_get('use_smooth', poly_smooth)
    faces, src = tri_v, np.arange(len(tri_v), dtype=np.int64)
    bary = np.zeros((len(faces), 3, 3))
    bary[:, 0, 0] = bary[:, 1, 1] = bary[:, 2, 2] = 1.0
    edges = np.concatenate([faces[:, [0, 1]], faces[:, [1, 2]], faces[:, [2, 0]]])
    code = np.minimum(edges[:, 0], edges[:, 1]) * EDGE_BASE + np.maximum(edges[:, 0], edges[:, 1])
    unique, count = np.unique(code, return_counts=True)
    boundary = unique[count == 1]
    iteration = 0
    for iteration in range(12):
        rows = np.arange(len(faces))
        side = _length_squared(world[faces] - world[faces[:, [1, 2, 0]]])
        longest = np.argmax(side, axis=1)                       # the first maximum, as max() takes it
        a, b = faces[rows, longest], faces[rows, (longest + 1) % 3]
        code = np.minimum(a, b) * EDGE_BASE + np.maximum(a, b)
        want = ((np.sqrt(side[rows, longest]) > max_edge) & painted[faces].any(axis=1)
                & ~_has(boundary, code))
        chosen = np.unique(code[want])
        if not len(chosen):
            break
        base = len(verts)
        middle = (verts[chosen // EDGE_BASE] + verts[chosen % EDGE_BASE]) * np.float32(.5)
        verts = np.concatenate([verts, middle])
        more = _world(obj, middle)
        world = np.concatenate([world, more])
        rgb, mask = _paint_rows(more, sample, curves)
        paint, painted = np.concatenate([paint, rgb]), np.concatenate([painted, mask])
        mid_v, mid_b, case = [], [], np.zeros(len(faces), dtype=np.int64)
        for i, (p, q) in enumerate(((0, 1), (1, 2), (2, 0))):
            key = (np.minimum(faces[:, p], faces[:, q]) * EDGE_BASE
                   + np.maximum(faces[:, p], faces[:, q]))
            found = np.searchsorted(chosen, key)
            hit = chosen[np.minimum(found, len(chosen) - 1)] == key
            case |= hit.astype(np.int64) << i
            mid_v.append(base + found)
            mid_b.append((bary[:, p, :] + bary[:, q, :]) * .5)
        symbol_v = [faces[:, 0], faces[:, 1], faces[:, 2]] + mid_v
        symbol_b = [bary[:, 0, :], bary[:, 1, :], bary[:, 2, :]] + mid_b
        start = np.concatenate([[0], np.cumsum(np.array([1, 2, 2, 3, 2, 3, 3, 4])[case])])
        new_f = np.empty((int(start[-1]), 3), dtype=np.int64)
        new_b = np.empty((int(start[-1]), 3, 3))
        new_src = np.empty(int(start[-1]), dtype=np.int64)
        for bits, recipe in SPLIT_PARTS.items():
            index = np.nonzero(case == bits)[0]
            if not len(index):
                continue
            for n, part in enumerate(recipe):
                where = start[index] + n
                new_f[where] = np.stack([symbol_v[s][index] for s in part], axis=1)
                new_b[where] = np.stack([symbol_b[s][index] for s in part], axis=1)
                new_src[where] = src[index]
        faces, bary, src = new_f, new_b, new_src
    # float-precision output slivers (see the scalar path)
    e1, e2 = verts[faces[:, 1]] - verts[faces[:, 0]], verts[faces[:, 2]] - verts[faces[:, 0]]
    length = np.sqrt(_length_squared(np.cross(e1, e2)))
    keep = length > 1e-9
    dropped_area += float((length[~keep] * .5).sum())
    faces, bary, src = faces[keep], bary[keep], src[keep]
    new = bpy.data.meshes.new(me.name + ' transition')
    new.vertices.add(len(verts))
    new.loops.add(faces.size)
    new.polygons.add(len(faces))
    new.vertices.foreach_set('co', verts.reshape(-1))
    new.polygons.foreach_set('loop_start', np.arange(len(faces), dtype=np.int32) * 3)
    new.polygons.foreach_set('vertices', faces.astype(np.int32).reshape(-1))
    new.shade_flat()
    new.update(calc_edges=True)
    for material in me.materials:
        new.materials.append(material)
    # Same order as the scalar path, so the mesh carries its attributes in the same order: the colour
    # attributes and UV layers, then material_index and sharp_face, and the custom normals last.
    attrs = [(a, new.color_attributes.new(name=a.name, type=a.data_type, domain='CORNER'))
             for a in me.color_attributes if a.domain == 'CORNER']
    if not attrs:
        attrs = [(None, new.color_attributes.new(name='Col', type='BYTE_COLOR', domain='CORNER'))]
    uvs = [(old, new.uv_layers.new(name=old.name)) for old in me.uv_layers]
    new.polygons.foreach_set('material_index', tri_m[src])
    new.polygons.foreach_set('use_smooth', poly_smooth[tri_p[src]])
    loops = tri_l[src]
    bary32 = bary.astype(np.float32)
    normals = _normalized(_interpolate(_attr(me.corner_normals, 'vector', 3, np.float32), loops, bary32))
    for old, uv in uvs:
        uv.data.foreach_set('uv', _interpolate(_attr(old.data, 'uv', 2, np.float32), loops,
                                               bary32).reshape(-1))
    corner_paint = paint[faces]                      # (F, 3, 4)
    corner_painted = painted[faces]
    worn = corner_paint[:, :, 3]
    bytes_out = None
    for old, col in attrs:
        if old is None:
            base = np.zeros((len(faces), 3, 4))
            base[:, :, 1] = base[:, :, 3] = 1.0
        else:
            base = _interpolate(_attr(old.data, 'color_srgb', 4, np.float32).astype(float), loops, bary)
        # Keep the fringe's transverse grass ramp; meshes use canonical G path.
        coverage = base[:, :, 1] if blend else 1.0
        value = _byte_weights(coverage * corner_paint[:, :, 1], coverage * corner_paint[:, :, 2], worn)
        # Unity's current path SurfaceMaterial maps every original channel to the same own surface. Full
        # green therefore preserves its rendered appearance under the RGB convention.
        plain = base.copy()
        if not blend:
            plain[:, :, 0], plain[:, :, 1], plain[:, :, 2] = 0.0, 1.0, 0.0
        out = np.where(corner_painted[:, :, None], value, plain)
        col.data.foreach_set('color_srgb', out.reshape(-1).astype(np.float32))
        bytes_out = _attr(col.data, 'color_srgb', 4, np.float32)
    if blend:
        # A vertex the meshes also painted takes their actual bytes.
        hit = seam.match(world.tolist())
        found = np.array([v is not None for v in hit])
        if found.any():
            value = np.zeros((len(verts), 4), dtype=np.float32)
            value[found] = np.array([v for v in hit if v is not None], dtype=np.float32)
            take = found[faces].reshape(-1)
            mine = faces.reshape(-1)[take]
            for _old, col in attrs:
                buf = _attr(col.data, 'color_srgb', 4, np.float32)
                buf[take] = value[mine]
                col.data.foreach_set('color_srgb', buf.reshape(-1))
    else:
        flat = faces.reshape(-1)
        last = np.full(len(verts), -1, dtype=np.int64)
        np.maximum.at(last, flat, np.arange(len(flat)))
        used = np.nonzero(last >= 0)[0]
        used = used[np.argsort(last[used], kind="stable")]
        seam.put(world[used], bytes_out.reshape(-1, 4)[last[used]])
    new.normals_split_custom_set(normals.reshape(-1, 3).tolist())
    new.update()
    obj.data = new
    return {'vertices': len(verts), 'triangles': len(faces), 'iterations': iteration,
            'droppedSliverArea': dropped_area}


def _has(sorted_keys, keys):
    """Mask of the keys present in the ascending `sorted_keys`."""
    import numpy as np
    if not len(sorted_keys):
        return np.zeros(len(keys), dtype=bool)
    at = np.searchsorted(sorted_keys, keys)
    return sorted_keys[np.minimum(at, len(sorted_keys) - 1)] == keys


def _byte_weights(g, b, worn):
    """byte_weights over arrays: (..., 4) sRGB whose bytes sum to 255 less `worn` of the green (the red is
    what is left, as in the scalar one)."""
    import numpy as np
    gb = np.minimum(np.maximum(np.rint(g * 255), 0), 255)
    bb = np.minimum(np.maximum(np.rint(b * 255), 0), 255 - gb)
    return np.stack([(255 - gb - bb) / 255, np.rint(gb * (1 - worn)) / 255, bb / 255,
                     np.ones(np.shape(gb))], axis=-1)


def apply(objects, entries, frame, max_edge=.3):
    """Refine interior triangles without moving vertices or transferring faces between objects.

    Preserve source corner normals, UVs, material and colour by barycentric interpolation.
    Boundary edges are immutable: coincident original seam vertices receive identical bytes.
    """
    import bpy
    from mathutils import Vector
    from shape_coords import to_blend
    marker = hashlib.sha256(json.dumps([entries,max_edge],sort_keys=True).encode()).hexdigest()
    curves = [(e, LineIndex([to_blend(*p, frame) for p in e['centerline3006']], e['widthM']/2+.25)) for e in entries]
    memo = {}
    def sample(co):
        # Position alone decides the paint; a mesh is sampled per corner and per refinement pass.
        at = (co[0], co[1])
        if at not in memo:
            memo[at] = paint_at(at)
        return memo[at]
    def paint_at(co):
        worn = None
        for entry, line in curves:
            # OPCD's outer fringe is narrow; a broad search band would paint an
            # unrelated parallel road in the same merged road shape.
            hit = line.project(co)
            if hit is None:
                continue
            s,l,d = hit
            wears = wear(s,l,entry['wear'],entry['widthM']) if entry.get('wear') else None
            for spec in entry['transitions']:
                rgb = weights(s,l,spec,entry['widthM'])
                if rgb is not None:
                    return rgb+(wears or 0.,)
            if worn is None and wears is not None:
                worn = (grass_middle(s,l,entry['wear']), wears)
        # A worn path outside every transition is all path, but for a gravel track's grass middle (red: Unity
        # grows its grass there).
        return None if worn is None else (worn[0],1.-worn[0],0.,worn[1])
    report = {}
    seam = {}
    from mathutils.kdtree import KDTree
    seam_tree = None
    fast_seam = _SeamPaint()
    # Meshes first; fringes reuse their actual paint bytes at coincident vertices.
    for obj in sorted(objects,key=lambda o:(o.get('opcd_kind')=='blend',o.name)):
        if obj.get('golfmap_path_transition') == marker:
            continue
        me = obj.data
        if FAST:
            rec = _object_fast(obj, sample, curves, max_edge, fast_seam)
            if rec is None:
                continue
            obj['golfmap_path_transition'] = marker
            report[obj.name] = rec
            continue
        if not any(sample(obj.matrix_world@v.co) is not None for v in me.vertices):
            continue
        me.calc_loop_triangles()
        verts = [v.co.copy() for v in me.vertices]
        world = [obj.matrix_world@v for v in verts]
        # OPCD cuts can leave zero-area triangulation slivers. They have no
        # surface to preserve and would otherwise export invalid normals/faces.
        dropped_area = sum(t.area for t in me.loop_triangles if t.area <= 1e-10)
        triangles = [t for t in me.loop_triangles if t.area > 1e-10]
        sources = [tuple(t.loops) for t in triangles]
        faces = [(tuple(t.vertices),i,((1.,0.,0.),(0.,1.,0.),(0.,0.,1.))) for i,t in enumerate(triangles)]
        key = lambda a,b: (min(a,b),max(a,b))
        counts = Counter(key(f[i],f[(i+1)%3]) for f,_,_ in faces for i in range(3))
        boundary = {e for e,n in counts.items() if n==1}
        for iteration in range(12):
            chosen = set()
            for f,_,_ in faces:
                edges = [key(f[i],f[(i+1)%3]) for i in range(3)]
                edge = max(edges,key=lambda e:(world[e[0]]-world[e[1]]).length_squared)
                if edge not in boundary and (world[edge[0]]-world[edge[1]]).length > max_edge and any(sample(world[j]) is not None for j in f):
                    chosen.add(edge)
            if not chosen:
                break
            mids = {}
            for a,b in sorted(chosen):
                mids[a,b] = len(verts)
                verts.append((verts[a]+verts[b])*.5)
                world.append(obj.matrix_world@verts[-1])
            out = []
            for f,src,bary in faces:
                parts = [(f,bary)]
                for edge in (key(f[0],f[1]),key(f[1],f[2]),key(f[2],f[0])):
                    if edge not in mids:
                        continue
                    newer = []
                    for tri,bs in parts:
                        if not all(v in tri for v in edge):
                            newer.append((tri,bs)); continue
                        for j in range(3):
                            k,h = (j+1)%3,(j+2)%3
                            if key(tri[j],tri[k]) == edge:
                                mid = tuple((bs[j][q]+bs[k][q])*.5 for q in range(3))
                                newer.extend([((tri[j],mids[edge],tri[h]),(bs[j],mid,bs[h])),((mids[edge],tri[k],tri[h]),(mid,bs[k],bs[h]))]); break
                    parts = newer
                out.extend((tri,src,bs) for tri,bs in parts)
            faces = out
        dropped_area += sum((verts[f[1]]-verts[f[0]]).cross(verts[f[2]]-verts[f[0]]).length*.5
                            for f,_,_ in faces if (verts[f[1]]-verts[f[0]]).cross(verts[f[2]]-verts[f[0]]).length <= 1e-9)
        faces = [(f,src,bs) for f,src,bs in faces
                 if (verts[f[1]]-verts[f[0]]).cross(verts[f[2]]-verts[f[0]]).length > 1e-9]
        new = bpy.data.meshes.new(me.name+' transition')
        new.from_pydata(verts,[],[f for f,_,_ in faces])
        for material in me.materials:
            new.materials.append(material)
        attrs = [(a,new.color_attributes.new(name=a.name,type=a.data_type,domain='CORNER')) for a in me.color_attributes if a.domain=='CORNER']
        if not attrs:
            attrs = [(None,new.color_attributes.new(name='Col',type='BYTE_COLOR',domain='CORNER'))]
        uvs = [(u,new.uv_layers.new(name=u.name)) for u in me.uv_layers]
        normals = []
        for pi,(tri,src,bs) in enumerate(faces):
            new.polygons[pi].material_index = triangles[src].material_index
            new.polygons[pi].use_smooth = me.polygons[triangles[src].polygon_index].use_smooth
            loops = sources[src]
            for j,bary in enumerate(bs):
                li = pi*3+j
                no = sum((me.corner_normals[loops[q]].vector*bary[q] for q in range(3)),Vector())
                normals.append(no.normalized())
                for old,uv in uvs:
                    uv.data[li].uv = sum((old.data[loops[q]].uv*bary[q] for q in range(3)),Vector((0.,0.)))
                rgb = sample(world[tri[j]])
                for old,col in attrs:
                    base = tuple(sum(old.data[loops[q]].color_srgb[k]*bary[q] for q in range(3)) for k in range(4)) if old else (0.,1.,0.,1.)
                    if rgb is not None:
                        # Keep the fringe's transverse grass ramp; meshes use canonical G path.
                        coverage = base[1] if obj.get('opcd_kind')=='blend' else 1.
                        value = byte_weights((1-coverage*(rgb[1]+rgb[2]),coverage*rgb[1],coverage*rgb[2]),rgb[3])
                        pos = tuple(world[tri[j]])
                        if obj.get('opcd_kind')=='blend':
                            if seam_tree is not None:
                                _, index, distance = seam_tree.find(pos)
                                if distance < .001:
                                    value = seam_values[index]
                        else:
                            seam[pos] = value
                        col.data[li].color_srgb = value
                    else:
                        # Unity's current path SurfaceMaterial maps every original
                        # channel to the same own surface. Full green therefore
                        # preserves its rendered appearance under the RGB convention.
                        col.data[li].color_srgb = (0.,1.,0.,base[3]) if obj.get('opcd_kind')!='blend' else base
                    pos = tuple(world[tri[j]])
                    if obj.get('opcd_kind') != 'blend':
                        seam[pos] = tuple(col.data[li].color_srgb)
                    elif seam_tree is not None:
                        _, index, distance = seam_tree.find(pos)
                        if distance < .001:
                            col.data[li].color_srgb = seam_values[index]
        new.normals_split_custom_set(normals)
        new.update()
        obj.data = new
        obj['golfmap_path_transition'] = marker
        report[obj.name] = {'vertices':len(verts),'triangles':len(faces),'iterations':iteration,
                            'droppedSliverArea':dropped_area}
        if obj.get('opcd_kind') != 'blend' and seam:
            seam_tree = KDTree(len(seam))
            seam_values = []
            for index,(pos,value) in enumerate(seam.items()):
                seam_tree.insert(pos,index)
                seam_values.append(value)
            seam_tree.balance()
    return report
