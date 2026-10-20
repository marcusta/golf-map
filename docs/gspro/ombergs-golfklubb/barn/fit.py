r"""Survey fit for the machine hall and the red outbuilding (neither is in OpenStreetMap); run after crop.py with
D:\\golf-map\pipeline\.venv\Scripts\python.exe -I <this file>   (numpy only).

Reads data/omberg-barn/lidar-crop.npz + dem-edited-crop.npz and writes beside them
  measure.json         the fitted roof planes (frame, bearing, planes, edges, ground) that buildings.py builds from
  footprints.json      the wall rectangles in the shape of an OSM building feature (properties.osm_id and
                       properties.rect {cx, cy, lengthM, widthM, angleDeg}, GeoJSON polygon), which crop.py copies to
                       osm-buildings.json so that clubhouse/check_survey.py --site barn/site.json can read them.

Method (lidar class 1 = roof returns, 1-2 pts/m2; ground = the edited DEM the course is built on):
  hall  A mono-pitch roof: the returns 1.8-3.4 m above ground inside the ortho outline fit one plane
        z = z0 + gE*E + gN*N with rms 2 cm. Its contour direction (perpendicular to the gradient) is the long
        axis, the up-slope side is north. u runs along the axis (bearing `bearing`), v to its left.
  red   A gable roof of the same axis: ridge parallel to u at v = vr, two planes of one pitch.
  edges The extreme returns lying on the plane (|dz| < 0.12 m), padded by PAD (about a third of the point
        spacing) = the outer roof edge. The orthophoto's white roof surface is 0.4-0.5 m narrower on every side
        (its edge pixels are the dark eave); the lidar edge is used because the roof must cover the roof
        picture baked into the ground photo.
  walls The roof edge less the eave overhang OVH.
"""
import json
import math
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[4]
DATA = ROOT / "data/omberg-barn"
PAD = 0.1
OVH = 0.4
TOL = 0.12


def main():
    pts = np.load(DATA / "lidar-crop.npz")["points"]
    dem = np.load(DATA / "dem-edited-crop.npz")

    def terrain(e, n):
        x = (e - float(dem["topLeftE"])) / float(dem["pixelE"]) - .5
        y = (float(dem["topLeftN"]) - n) / float(dem["pixelN"]) - .5
        z = dem["z"]
        i, j = int(math.floor(y)), int(math.floor(x))
        fy, fx = y - i, x - j
        return float(z[i, j] * (1 - fx) * (1 - fy) + z[i, j + 1] * fx * (1 - fy) + z[i + 1, j] * (1 - fx) * fy + z[i + 1, j + 1] * fx * fy)

    roof = pts[pts[:, 3] == 1]
    gz = np.array([terrain(e, n) for e, n in roof[:, :2]])
    h = roof[:, 2] - gz

    # ---- hall plane: seed = the ortho outline (E 477980-478000, N 6458134.5-6458144.5), iterated to the plane
    seed = (roof[:, 0] > 477981) & (roof[:, 0] < 477999) & (roof[:, 1] > 6458135.5) & (roof[:, 1] < 6458144) & (h > 1.8) & (h < 3.4)
    sel = seed.copy()
    for _ in range(8):
        A = np.column_stack((np.ones(sel.sum()), roof[sel, 0] - 477990, roof[sel, 1] - 6458140))
        c = np.linalg.lstsq(A, roof[sel, 2], rcond=None)[0]
        res = roof[:, 2] - (c[0] + c[1] * (roof[:, 0] - 477990) + c[2] * (roof[:, 1] - 6458140))
        sel = seed & (np.abs(res) < 0.1)
    z0, gE, gN = c
    slope = math.hypot(gE, gN)
    vx, vy = gE / slope, gN / slope                    # v = up-slope direction (left of the axis)
    ux, uy = vy, -vx                                   # u = axis, bearing = atan2(ux, uy)
    bearing = math.degrees(math.atan2(ux, uy)) % 360
    O = (477990.0, 6458140.0)
    uu = (roof[:, 0] - O[0]) * ux + (roof[:, 1] - O[1]) * uy
    vv = (roof[:, 0] - O[0]) * vx + (roof[:, 1] - O[1]) * vy
    plane = z0 + gE * (roof[:, 0] - 477990) + gN * (roof[:, 1] - 6458140)
    on = (np.abs(roof[:, 2] - plane) < TOL) & (h > 1.8) & (uu > -11.2) & (uu < 11) & (vv > -3.4) & (vv < 4.2)
    # the red roof lies above the hall roof's west end, so it is not on the plane; vegetation stays under it
    hall = dict(slope=slope, bearing=bearing, z0=z0, gE=gE, gN=gN, rms=float(np.std(res[sel])), returns=int(on.sum()),
                u=[float(uu[on].min() - PAD), float(uu[on].max() + PAD)], v=[float(vv[on].min() - PAD), float(vv[on].max() + PAD)])
    # ---- red gable roof, same axis: ridge along u
    rs = (roof[:, 0] < 477983) & (roof[:, 0] > 477972) & (roof[:, 2] > 114.2) & (roof[:, 2] < 115.6)
    best = None
    for vr in np.arange(-0.5, 1.5, 0.05):
        A = np.column_stack((np.ones(rs.sum()), -np.abs(vv[rs] - vr)))
        c2 = np.linalg.lstsq(A, roof[rs, 2], rcond=None)[0]
        r = float(np.std(roof[rs, 2] - A @ c2))
        if best is None or r < best[0]:
            best = (r, vr, c2)
    r, vr, (zr, pitch) = best
    zp = zr - pitch * np.abs(vv - vr)
    on2 = rs & (np.abs(roof[:, 2] - zp) < TOL + 0.05)
    red = dict(ridgeV=float(vr), ridgeZ=float(zr), pitch=float(pitch), rms=r, returns=int(on2.sum()),
               u=[float(uu[on2].min() - PAD), float(uu[on2].max() + PAD)], v=[float(vv[on2].min() - PAD), float(vv[on2].max() + PAD)])
    # the red roof is symmetric about its ridge: the wider lidar half, capped at 3.0 m (the ortho shows 2.5)
    half = min(3.0, max(red["v"][1] - vr, vr - red["v"][0]))
    red["v"] = [vr - half, vr + half]
    # ground under the buildings (edited DEM, mean over the walls)
    def ground(ur, vr_):
        g = [terrain(O[0] + u * ux + v * vx, O[1] + u * uy + v * vy) for u in np.linspace(ur[0], ur[1], 9) for v in np.linspace(vr_[0], vr_[1], 5)]
        return float(np.mean(g))
    hall_walls_u = [hall["u"][0], hall["u"][1] - OVH]       # west end is the red building's east wall
    hall_walls_v = [hall["v"][0] + OVH, hall["v"][1] - OVH]
    red_walls_u = [red["u"][0] + OVH, hall["u"][0]]         # east wall = the hall's west end
    red_walls_v = [red["v"][0] + OVH, red["v"][1] - OVH]
    hall["ground"] = ground(hall_walls_u, hall_walls_v)
    red["ground"] = ground(red_walls_u, red_walls_v)
    out = dict(origin=list(O), axis=dict(ux=ux, uy=uy, vx=vx, vy=vy, bearingDeg=bearing), overhang=OVH,
               hall=dict(hall, wallsU=hall_walls_u, wallsV=hall_walls_v), red=dict(red, wallsU=red_walls_u, wallsV=red_walls_v))
    (DATA / "measure.json").write_text(json.dumps(out, indent=2))

    def feature(osm_id, name, wu, wv, ridge_abs, eave_abs, ground_abs):
        cu, cv = (wu[0] + wu[1]) / 2, (wv[0] + wv[1]) / 2
        cx, cy = O[0] + cu * ux + cv * vx, O[1] + cu * uy + cv * vy
        corners = [(wu[0], wv[0]), (wu[1], wv[0]), (wu[1], wv[1]), (wu[0], wv[1]), (wu[0], wv[0])]
        ring = [[round(O[0] + a * ux + b * vx, 2), round(O[1] + a * uy + b * vy, 2)] for a, b in corners]
        return {"type": "Feature", "properties": dict(
            type="building", id="survey:barn/%d" % osm_id, kind="yes", name=name, areaM2=round((wu[1] - wu[0]) * (wv[1] - wv[0]), 1),
            rect=dict(cx=round(cx, 2), cy=round(cy, 2), lengthM=round(wu[1] - wu[0], 2), widthM=round(wv[1] - wv[0], 2),
                      angleDeg=round((90 - bearing) % 180, 2)),
            eaveM=round(eave_abs - ground_abs, 2), ridgeM=round(ridge_abs - ground_abs, 2), source="lidar-ortho-fit", osm_id=osm_id),
            "geometry": {"type": "Polygon", "coordinates": [ring]}}

    def zat(v):
        return z0 + slope * v
    feats = [feature(9000001, "machine hall", hall_walls_u, hall_walls_v, zat(hall["v"][1]), zat(hall["v"][0]), hall["ground"]),
             feature(9000002, "red outbuilding", red_walls_u, red_walls_v, zr, zr - pitch * half, red["ground"])]
    (DATA / "footprints.json").write_text(json.dumps(feats, indent=1))
    (DATA / "osm-buildings.json").write_text(json.dumps(feats, indent=1))
    print(json.dumps(out, indent=2))


if __name__ == "__main__":
    main()
