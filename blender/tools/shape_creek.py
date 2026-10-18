"""Creek channel profile for `golfmap.creek_channel` (shape_apply.py): pure numpy, no bpy, tested by `shape_creek_test.py`.

A creek 0.7 m wide and 0.7 m deep does not survive the 0.5 m DEM (its bank taper and cell size leave a V, 0.3-0.4 m deep
beside the line). The creek bed cut out of the ground (`golfmap.cut_out`, 0.15 m triangles, heights from the DEM) is given
the channel it should have: a flat bottom `depthM` under the ground beside it, `widthM` wide, with steep walls `wallM`
wide, following the creek's centerline. Only ever lowers; the vertices of the mesh border stay where they are (they are
shared with the meshes around), and the channel eases in over `rampM` from each end of the mesh.
"""

import numpy as np


def smoothstep(x):
    x = np.clip(x, 0.0, 1.0)
    return x * x * (3.0 - 2.0 * x)


def station_distance(xy, line):
    """Per point of `xy` (n, 2): the distance to the polyline `line` (m, 2) and the way along it (station) of the nearest
    point."""
    xy = np.asarray(xy, dtype=np.float64)
    line = np.asarray(line, dtype=np.float64)
    a, b = line[:-1], line[1:]
    ab = b - a
    seg = np.linalg.norm(ab, axis=1)
    cum = np.concatenate([[0.0], np.cumsum(seg)])
    l2 = np.maximum((ab * ab).sum(axis=1), 1e-18)
    ap = xy[:, None, :] - a[None, :, :]
    t = np.clip((ap * ab[None, :, :]).sum(axis=2) / l2[None, :], 0.0, 1.0)
    proj = a[None, :, :] + t[:, :, None] * ab[None, :, :]
    dist = np.linalg.norm(xy[:, None, :] - proj, axis=2)
    best = np.argmin(dist, axis=1)
    rows = np.arange(len(xy))
    return dist[rows, best], cum[best] + t[rows, best] * seg[best]


def reference_heights(d, s, z, band, window=1.5, step=1.0):
    """The ground beside the channel at every station: the median height of the points `band` = (near, far) metres from the
    line, within `window` metres along it, per `step` metres of station, then interpolated to `s`."""
    sel = (d >= band[0]) & (d <= band[1])
    if int(sel.sum()) < 3:
        raise ValueError("fewer than 3 vertices %.2f-%.2f m from the line to read the ground beside the channel from" % band)
    sv, zv = s[sel], z[sel]
    centres = np.arange(float(s.min()), float(s.max()) + step, step)
    med = np.full(len(centres), np.nan)
    for i, c in enumerate(centres):
        m = np.abs(sv - c) <= window
        if int(m.sum()) >= 2:
            med[i] = float(np.median(zv[m]))
    ok = np.isfinite(med)
    if not ok.any():
        raise ValueError("no stretch of the creek has ground beside it to read")
    return np.interp(s, centres[ok], med[ok])


def channel_heights(xy, z, line, width=0.7, depth=0.7, wall=0.15, ramp=1.5, band=(1.0, 1.2), pinned=None):
    """New heights for the vertices (`xy` (n, 2), `z` (n)): the channel along `line`. Returns (new z, info)."""
    z = np.asarray(z, dtype=np.float64)
    d, s = station_distance(xy, line)
    ground = reference_heights(d, s, z, band)
    half = width / 2.0
    w = 1.0 - smoothstep((d - half) / max(wall, 1e-6))
    if ramp > 0:
        end = np.minimum(s - s.min(), s.max() - s)
        w = w * smoothstep(end / ramp)
    target = ground - depth
    new = np.minimum(z, z + (target - z) * w)
    if pinned is not None:
        new = np.where(pinned, z, new)
    drop = z - new
    inside = (d <= half) & (w > 0.99)
    info = {"vertices": int(len(z)), "moved": int((drop > 1e-6).sum()), "maxDropM": round(float(drop.max()), 3),
            "groundM": [round(float(ground.min()), 3), round(float(ground.max()), 3)],
            "bedM": [round(float((ground - depth).min()), 3), round(float((ground - depth).max()), 3)],
            "bedVertices": int(inside.sum()),
            "stationM": [round(float(s.min()), 2), round(float(s.max()), 2)]}
    return new, info
