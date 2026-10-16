"""golfpipe.horizon: a low hazy far shore where a lake's water reaches the edge of its planes."""
import math

import numpy as np

from golfpipe.horizon import DEFAULT_HEIGHT_M, horizon


def lake_plane(open_from: float, open_to: float, radius: float = 4000.0, cell: float = 25.0) -> dict:
    """A far plane: a ring of water out to `radius` between two compass bearings (land elsewhere), centre (0, 0)."""
    verts, tris = [], []
    for b in np.arange(0, 360, 2.0):
        inside = (b - open_from) % 360 <= (open_to - open_from) % 360
        if not inside:
            continue
        a0, a1 = math.radians(b), math.radians(b + 2.0)
        k = len(verts) // 2
        for a in (a0, a1):
            for r in (radius - 300, radius):
                verts += [math.sin(a) * r, math.cos(a) * r]
        tris += [k, k + 1, k + 2, k + 1, k + 3, k + 2]
    return {"name": "Lake", "surfaceY": 8.0, "radiusM": radius, "centre": [0.0, 0.0],
            "meshes": [{"role": "far", "cellM": cell, "vertices": verts, "triangles": tris}]}


def test_the_ridge_stands_only_where_the_water_reaches_the_horizon():
    doc = horizon(lake_plane(200, 340), distance_m=3900)
    assert len(doc["stretches"]) == 1
    s = doc["stretches"][0]
    assert abs(s["fromDeg"] - 200) <= 2 and abs(s["toDeg"] - 342) <= 2
    v = np.asarray(doc["vertices"]).reshape(-1, 3)
    assert len(doc["uvs"]) == len(v) * 2
    assert max(doc["triangles"]) < len(v)
    bearing = np.degrees(np.arctan2(v[:, 0], v[:, 2])) % 360
    assert np.all((bearing > 195) & (bearing < 347))                  # none over the land
    r = np.hypot(v[:, 0], v[:, 2])
    assert r.min() >= 3899 and r.max() <= 3900 + 361
    assert v[:, 1].min() < 8.0                                          # the foot under the water
    assert v[:, 1].max() <= 8.0 + DEFAULT_HEIGHT_M[1] + 1e-6


def test_the_ridge_faces_the_centre():
    """Unity draws clockwise triangles (seen from the camera): from the centre the ridge's faces are clockwise."""
    doc = horizon(lake_plane(260, 280), distance_m=3900)
    v = np.asarray(doc["vertices"]).reshape(-1, 3)
    t = np.asarray(doc["triangles"]).reshape(-1, 3)
    a, b, c = v[t[:, 0]], v[t[:, 1]], v[t[:, 2]]
    n = np.cross(b - a, c - a)
    eye = np.array([0.0, 30.0, 0.0])
    to_eye = eye - (a + b + c) / 3
    facing = np.einsum("ij,ij->i", n, to_eye)
    # the front slope (foot to crest, within 180 m of the foot) is what the course sees
    mid = (a + b + c) / 3
    front = np.hypot(mid[:, 0], mid[:, 2]) <= 3900 + 180
    front &= np.linalg.norm(n, axis=1) > 1e-6
    # Unity is left-handed and draws clockwise front faces: (b-a)x(c-a) then points away from the eye
    assert np.all(facing[front] < 0)


def test_no_open_horizon_no_ridge():
    assert horizon(lake_plane(0, 1), distance_m=3900)["vertices"] == []
