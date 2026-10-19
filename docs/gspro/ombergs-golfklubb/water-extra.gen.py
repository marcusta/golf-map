"""Omberg's extra water planes, for Unity's golfmap.waterplanes.extra (GolfMapWaterplanes.cs): water the course's
lake meshes do not reach yet because a pond's outline changed in the app after the last OPCD build.

    pipeline/.venv/Scripts/python.exe docs/gspro/ombergs-golfklubb/water-extra.gen.py [--out <Unity course folder>]
        -> docs/gspro/ombergs-golfklubb/water-extra.json (+ <out>/water-extra.json)

Hole 9, 2026-10-19 (Marcus: "Här ska det vara en bro över ... fallet är under bron"): the bay between fall E's lip and
the stone bridge, and the channel under the bridge, were moved from pond 573 (the lower) to pond 576 (the upper, its
water runs under the bridge to the lip). OPCD's 576 lake mesh still ends at the bridge: this plane carries 576's water
over the bay and the channel, a copy of Spline_hole_9_240_WaterPlane at its surface. Drop an entry once an OPCD build
has the new outline (then golfmap.waterplanes.build makes the whole plane).
Coordinates: the pond's outline from the database (EPSG:3006), clipped to `clip`; scene x = E - 477021, z = N - 6456736.
"""
import argparse
import json
import os
import sqlite3

import shapely
from shapely.geometry import Polygon, box

HERE = os.path.dirname(os.path.abspath(__file__))
DB = os.path.join(HERE, "..", "..", "..", "data", "app.sqlite")
COURSE_ID = "ce4629e1-042d-4ea7-b31e-9226e2742a56"
E0, N0 = 477021.0, 6456736.0

PLANES = [
    {"name": "Spline_hole_9_240b_WaterPlane", "like": "Spline_hole_9_240_WaterPlane", "feature": 576,
     # the bay and the channel: west of the old lake mesh's edge at the bridge (it overlaps 576's own plane a little)
     "clip": (477735.0, 6457795.0, 477746.0, 6457815.0)},
]


def outline(feature_no):
    from rasterio.warp import transform
    c = sqlite3.connect("file:%s?mode=ro" % DB, uri=True)
    g = json.loads(c.execute("select geojson from course_features where course_id=? and feature_no=?", (COURSE_ID, feature_no)).fetchone()[0])
    co = g.get("geometry", g)["coordinates"][0]
    xs, ys = transform("EPSG:4326", "EPSG:3006", [p[0] for p in co], [p[1] for p in co])
    return Polygon(list(zip(xs, ys))).buffer(0)


def plane(p):
    region = outline(p["feature"]).intersection(box(*p["clip"])).buffer(0)
    if region.geom_type != "Polygon":
        region = max(region.geoms, key=lambda g: g.area)
    region = region.simplify(0.05)
    verts = [(round(x - E0, 3), round(y - N0, 3)) for x, y in region.exterior.coords[:-1]]
    index = {v: i for i, v in enumerate(verts)}
    tris = []
    for t in shapely.constrained_delaunay_triangles(region).geoms:
        tris.extend(index[(round(x - E0, 3), round(y - N0, 3))] for x, y in t.exterior.coords[:-1])
    print("%-32s %3d vertices, %3d triangles, %.1f m2" % (p["name"], len(verts), len(tris) // 3, region.area))
    return {"name": p["name"], "like": p["like"], "vertices": [list(v) for v in verts], "triangles": tris}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="", help="also write water-extra.json into this folder (the Unity course folder)")
    a = ap.parse_args()
    spec = {"format": "golfmap-water-extra-v1", "source": "docs/gspro/ombergs-golfklubb/water-extra.gen.py",
            "planes": [plane(p) for p in PLANES]}
    for folder in [HERE] + ([a.out] if a.out else []):
        path = os.path.join(folder, "water-extra.json")
        with open(path, "w", encoding="utf-8", newline="\n") as f:
            f.write(json.dumps(spec, indent=1) + "\n")
        print("wrote", path)


if __name__ == "__main__":
    main()
