"""Vreta clubhouse area: buildings and props measured for blender/tools/build_props.py.

    python docs/gspro/vreta/clubhouse-props.gen.py   -> docs/gspro/vreta/clubhouse-props.json

Sources, 2026-09-26:
  - positions, footprints, eave/ridge heights: Lantmateriet lidar (dsm-skoglig 2021, ~1.5 pt/m2,
    roof points above dem.tif fitted per building: PCA axis, 1-99 % extents, height profiles across
    and along the axis). OSM footprints here are ~5 m off; the 2025 ortho roofs agree with lidar.
  - buildings the lidar predates or barely sees (range centre 6930) and all small props: the
    2025 ortho (0.16 m) - roof corners, flag shadows, parked cars (clubhouse-cars.json, stall rows
    tested for occupancy and colour).
  - looks (materials, windows, doors, roof kinds, what stands where): the 138 reference photos
    taken 2026-09-26 (golf-map site photos, photo numbers below = capture order).
Coordinates: EPSG:3006 metres. Local asset frame: x = long axis, y across, z up; yawDeg = compass
bearing of local +x (local +y points to yawDeg - 90).
"""
import hashlib
import json
import math
import os

E0, N0 = 530000.0, 6487000.0
HERE = os.path.dirname(os.path.abspath(__file__))
# Ground for terrain-aware parts (paving draped on the ground, step flights down to the lawn): the edited
# lidar DEM the Unity heightmap and course meshes were built from. Unity places these assets with
# ground "centre" = the surface at the asset origin, so heights here are relative to the DEM there.
DEM = os.path.join(HERE, "..", "..", "..", "data", "sources", "88E5F5B7-B1E6-4EBA-9D47-49B289C59EAE", "dem-edited.tif")
try:
    import rasterio
    _dem = rasterio.open(DEM)
    _demz = _dem.read(1)
except Exception as e:  # noqa: BLE001 - the spec still builds flat without the DEM
    print("no DEM (%s): terrain-aware parts built flat" % e)
    _dem = None


def ground(e, n):
    """DEM height at (e, n) relative to E0/N0, bilinear."""
    if _dem is None:
        return 0.0
    T = _dem.transform
    fx = (E0 + e - T.c) / T.a - 0.5
    fy = (N0 + n - T.f) / T.e - 0.5
    i, j = int(math.floor(fx)), int(math.floor(fy))
    u, v = fx - i, fy - j
    z = _demz
    return float((z[j, i] * (1 - u) + z[j, i + 1] * u) * (1 - v) + (z[j + 1, i] * (1 - u) + z[j + 1, i + 1] * u) * v)


def height_grid(poly, ce, cn, yaw, cell=0.5):
    """Asset-local height grid (DEM minus the ground at the asset origin) over a local polygon's bbox."""
    xs, ys = [p[0] for p in poly], [p[1] for p in poly]
    x0, y0 = math.floor(min(xs)) - cell, math.floor(min(ys)) - cell
    nc = int((max(xs) - x0) / cell) + 3
    nr = int((max(ys) - y0) / cell) + 3
    base = ground(ce, cn)
    z = []
    for j in range(nr):
        for i in range(nc):
            e, n = world(x0 + i * cell, y0 + j * cell, ce, cn, yaw)
            z.append(round(ground(e, n) - base, 3))
    return {"x0": x0, "y0": y0, "cell": cell, "cols": nc, "rows": nr, "z": z}

assets = {}
instances = []


def P(e, n):
    return (E0 + e, N0 + n)


def place(asset, e, n, yaw, ground="median", dz=0.0, **kw):
    E, N = P(e, n)
    d = {"asset": asset, "e": round(E, 2), "n": round(N, 2), "yawDeg": round(yaw % 360, 2), "ground": ground}
    if dz:
        d["dz"] = dz
    d.update(kw)
    instances.append(d)


def local(e, n, ce, cn, yaw):
    """World (e, n relative to E0/N0) -> asset-local x, y for an asset at (ce, cn) with yawDeg."""
    b = math.radians(yaw)
    ux, uy = math.sin(b), math.cos(b)          # local +x
    vx, vy = math.sin(b - math.pi / 2), math.cos(b - math.pi / 2)  # local +y
    de, dn = e - ce, n - cn
    return (round(de * ux + dn * uy, 2), round(de * vx + dn * vy, 2))


def world(x, y, ce, cn, yaw):
    b = math.radians(yaw)
    ux, uy = math.sin(b), math.cos(b)
    vx, vy = math.sin(b - math.pi / 2), math.cos(b - math.pi / 2)
    return (ce + x * ux + y * vx, cn + x * uy + y * vy)


def win(side, at, w=1.2, h=1.2, sill=0.9, **kw):
    d = {"side": side, "at": at, "w": w, "h": h, "sill": sill, "kind": "window"}
    d.update(kw)
    return d


# ---------------------------------------------------------------------------------------------
# Clubhouse (OSM way 1722): photos 20-23, 31. Falu red horizontal log-look boards, black corner
# boards and window frames, black louvred shutters, granite plinth; steep black standing-seam roof,
# whole WSW slope solar panels; glazed restaurant veranda (black steel, outside V struts) on the
# WSW side facing the 18th green, brick terrace and four wide brick steps down to the lawn; brick
# terrace with picnic tables round the NNW gable; granite outcrop by the NNW corner.
# Lidar: ridge 9.9 m on axis 158 deg through (187.8, 604.8), WSW eave ~5.0 m 6.5 m from the ridge,
# veranda roof 2.7-3.1 m out to ~5 m further WSW. Length 25 m.
# ---------------------------------------------------------------------------------------------
CH = (187.8, 604.8, 158.0)
ch_open = [
    # NNW gable (-x): black double door, window above, loft shutter (photo 20)
    {"side": "-x", "at": 1.2, "w": 1.8, "h": 2.3, "sill": 0.6, "kind": "door", "mat": "door_black", "frame": "black_trim"},
    win("-x", 1.2, 0.9, 1.3, 3.4, frame="white_trim", bars=[1, 2]),
    {"side": "-x", "at": -1.4, "w": 1.3, "h": 1.4, "sill": 6.3, "kind": "shutter", "frame": "black_trim"},
    win("-x", -4.2, 0.7, 0.8, 1.6, frame="black_trim", bars=[1, 1]),
    win("-x", 4.4, 0.7, 0.8, 1.7, frame="black_trim", bars=[1, 1]),
    # SSE gable (+x): loft shutter, two shutters, window with shutters, vent (photo 31)
    {"side": "+x", "at": 0.0, "w": 1.1, "h": 1.3, "sill": 6.6, "kind": "shutter", "frame": "black_trim"},
    {"side": "+x", "at": -2.0, "w": 0.9, "h": 1.1, "sill": 3.7, "kind": "shutter", "frame": "black_trim"},
    {"side": "+x", "at": 2.0, "w": 0.9, "h": 1.1, "sill": 3.7, "kind": "shutter", "frame": "black_trim"},
    win("+x", 2.0, 0.8, 0.9, 1.8, frame="black_trim", bars=[1, 1], shutters=True),
    {"side": "+x", "at": -2.0, "w": 0.6, "h": 0.6, "sill": 2.2, "kind": "vent"},
]
for x in (-9.0, -4.5, 0.0, 4.5, 9.0):  # ENE side, parking/putting green (photo 20 right)
    ch_open.append(win("+y", x, 0.8, 1.1, 1.4, frame="black_trim", bars=[1, 2]))
    ch_open.append(win("+y", x + 1.2, 0.7, 0.8, 3.6, frame="black_trim", bars=[1, 1]))
for x in (-8.0, -3.0, 2.0, 7.0):  # WSW side above the veranda roof
    ch_open.append(win("-y", x, 0.8, 0.9, 4.0, frame="black_trim", bars=[1, 1]))
def ccw(pts):
    """Local polygon, counter-clockwise (the drape clipper wants convex CCW)."""
    q = [local(e, n, CH[0], CH[1], CH[2]) for e, n in pts]
    a = sum(q[i][0] * q[(i + 1) % len(q)][1] - q[(i + 1) % len(q)][0] * q[i][1] for i in range(len(q)))
    return q if a > 0 else q[::-1]


# Brick terrace round the NNW gable (photos 21, 22; 2025 ortho resampled into the building frame, Marcus's
# outline 2026-09-26): a strip between the granite outcrop and the gable, and a ~13 x 9 m terrace W of it,
# out to the asphalt (dashed brick edge by the memorial stone, x -25.5) with a rounded corner down to the
# lawn. Two convex pieces (the drape clipper wants convex CCW).
terrace_n = [(-16.6, -4.8), (-12.55, -4.8), (-12.55, 6.5), (-16.6, 6.5)]
terrace_w = [(-19.0, -13.3), (-11.4, -13.3), (-11.4, -6.5), (-12.55, -4.8), (-25.5, -4.8), (-25.5, -8.5),
             (-24.9, -10.6), (-23.4, -12.2), (-21.2, -13.1)]
# The veranda deck is level with that terrace (asphalt level at the gable: the DEM there is the ground at
# the building centre) and four wide brick steps (photos 22, 23) go down to the lawn along the deck and on
# along the terrace's lawn edge. The lawn falls away to the SSE (-0.5 m at the NNW end, -1.2 m at the SSE
# end): the flight keeps its four steps and the base under the bottom tread shows more (photo 23).
_base = ground(CH[0], CH[1])
_lawn = sorted(ground(*world(x, -15.0, CH[0], CH[1], CH[2])) for x in range(-19, 12, 2))
STEP_N, RISE = 4, 0.17
DECK = 0.04
print("clubhouse: ground %.2f, lawn at the step foot %+.2f..%+.2f -> deck %+.2f, %d steps" % (_base + 0, _lawn[0] - _base, _lawn[-1] - _base, DECK, STEP_N))
assets["clubhouse"] = {"category": "building", "parts": [
    {"kind": "building", "length": 25.0, "width": 13.0, "wall": "falu_red_horizontal", "trim": "black_trim",
     "cornerBoard": 0.18, "plinth": {"h": 0.6, "mat": "granite_plinth"},
     "roof": {"type": "gable", "eave": 5.0, "ridge": 9.9, "overhang": 0.5, "gableOverhang": 0.35, "thick": 0.2,
              "mat": "roof_metal_black", "under": "black_trim", "edge": "black_trim",
              "solar": [{"side": "-y", "x0": -12.0, "x1": 12.0, "from": 0.6, "to": 0.5}]},
     "chimneys": [{"x": -6.0, "y": -3.2, "h": 1.5, "sx": 0.7, "sy": 0.9, "mat": "black_trim"}],
     "openings": ch_open},
    {"kind": "veranda", "x0": -11.5, "x1": 11.5, "y0": -6.5, "y1": -11.5, "floor": 0.7, "height": 2.5,
     "overhang": 0.8, "deck": 1.8, "band": True, "mullion": 1.3},
    {"kind": "steps", "x0": -19.0, "x1": 11.5, "y": -13.3, "dir": -1, "count": STEP_N, "rise": RISE, "run": 0.42, "top": DECK, "side": "granite_plinth"},
    {"kind": "railing", "pts": [(11.7, -6.6, DECK), (11.7, -13.2, DECK)], "h": 1.0},
    # level at the deck where the ground falls towards the lawn; the kerb shows round the rounded corner
    {"kind": "drape", "poly": terrace_n, "grid": height_grid(terrace_n, CH[0], CH[1], CH[2]), "mat": "brick_paving", "floor": DECK},
    {"kind": "drape", "poly": terrace_w, "grid": height_grid(terrace_w, CH[0], CH[1], CH[2]), "mat": "brick_paving", "floor": DECK, "edge": "granite_plinth"},
]}
place("clubhouse", CH[0], CH[1], CH[2], ground="centre")

# ---------------------------------------------------------------------------------------------
# Cottages x3 (OSM 1729/1712/1724, lodging): photos 4-6, 8, 128. Vertical board-and-batten, white
# corner boards, windows, bargeboards; orange clay pan-tile roof, ridge N-S (gables face the road);
# recessed porches with white posts on both eave sides at the south end.
# Lidar: ridge 5.8 m, eaves ~3.0 m at the roof edge +-7 m, roof 10.5 x 13.8 m, axis 174 deg.
# ---------------------------------------------------------------------------------------------
cot_fp = [(-5.0, -6.4), (0.8, -6.4), (0.8, -4.5), (5.0, -4.5), (5.0, 4.5), (0.8, 4.5), (0.8, 6.4), (-5.0, 6.4)]
cot_open = [
    win("+x", -2.3, 1.2, 1.2, 0.9, bars=[2, 1]), win("+x", 2.3, 1.2, 1.2, 0.9, bars=[2, 1]),
    win("+x", 0.0, 0.6, 0.6, 3.6, bars=[1, 1]),
    {"side": "-y", "plane": -4.5, "at": 3.7, "w": 0.95, "h": 2.1, "sill": 0.3, "kind": "door", "bars": [1, 3]},
    win("-y", 1.9, 1.2, 1.2, 0.9, plane=-4.5, bars=[2, 1]),
    {"side": "+y", "plane": 4.5, "at": 3.7, "w": 0.95, "h": 2.1, "sill": 0.3, "kind": "door", "bars": [1, 3]},
    win("+y", 1.9, 1.2, 1.2, 0.9, plane=4.5, bars=[2, 1]),
    win("-y", -3.5, 1.2, 1.2, 0.9, bars=[2, 1]), win("-y", -1.0, 0.6, 1.2, 0.9, bars=[1, 1]),
    win("+y", -3.5, 1.2, 1.2, 0.9, bars=[2, 1]), win("+y", -1.0, 0.6, 1.2, 0.9, bars=[1, 1]),
    win("-x", -3.0, 1.2, 1.2, 0.9, bars=[2, 1]), win("-x", 3.0, 1.2, 1.2, 0.9, bars=[2, 1]),
    win("-x", 0.0, 0.6, 0.6, 3.6, bars=[1, 1]),
]
assets["cottage"] = {"category": "building", "parts": [
    {"kind": "building", "length": 10.0, "width": 12.8, "footprint": cot_fp, "wall": "falu_red_vertical", "trim": "white_trim",
     "plinth": {"h": 0.3, "mat": "concrete"},
     "roof": {"type": "gable", "eave": 3.2, "ridge": 5.85, "overhang": 0.5, "gableOverhang": 0.35, "mat": "roof_tile_orange"},
     "posts": [(4.9, -6.3), (2.85, -6.3), (4.9, 6.3), (2.85, 6.3)],
     "chimneys": [{"x": -1.2, "y": 1.2, "h": 0.9, "sx": 0.5, "sy": 0.5, "mat": "concrete"}],
     "openings": cot_open},
    # porch floors (grey paving) under the recessed corners
    {"kind": "box", "c": (2.9, -5.45, -0.35), "s": (4.2, 1.9, 0.8), "mat": "concrete"},
    {"kind": "box", "c": (2.9, 5.45, -0.35), "s": (4.2, 1.9, 0.8), "mat": "concrete"},
]}
for ce, cn in ((214.3, 650.2), (234.0, 652.6), (253.6, 655.5)):
    place("cottage", ce, cn, 174.0)

# ---------------------------------------------------------------------------------------------
# Reception / shop hut (OSM 6931): photo 18. 5 x 7.6 m, mono roof falling from the SSW front
# (3.4 m) to the back (2.75 m), deep white fascia, big window + glass door + sign on the front.
# ---------------------------------------------------------------------------------------------
RC = (166.2, 641.1, 282.7)  # local +x WNW, +y SSW (front, high side)
assets["reception"] = {"category": "building", "parts": [
    {"kind": "building", "length": 5.0, "width": 7.6, "wall": "falu_red_vertical", "trim": "white_trim",
     "plinth": {"h": 0.15, "mat": "concrete"},
     "roof": {"type": "mono", "low": 2.75, "high": 3.35, "overhang": 0.6, "gableOverhang": 0.5, "thick": 0.28, "mat": "roof_metal_charcoal"},
     "openings": [win("+y", 1.1, 1.3, 1.3, 0.9, bars=[1, 1]),
                  {"side": "+y", "at": -1.3, "w": 1.0, "h": 2.1, "sill": 0.15, "kind": "glassdoor", "bars": [1, 1]},
                  win("+x", 1.5, 0.9, 0.9, 1.2, bars=[1, 1]), win("-x", 0.0, 1.0, 0.9, 1.2, bars=[1, 1])]},
    {"kind": "box", "c": (-1.3, 3.83, 2.55), "s": (1.5, 0.05, 0.28), "mat": "sign_black"},
    {"kind": "box", "c": (-0.1, 3.84, 1.5), "s": (0.4, 0.04, 0.55), "mat": "sign_black"},
]}
# Set by hand in Unity (Marcus, 2026-09-26): 3.2 m WSW of the lidar fit and turned 35 deg. RC stays the measured
# frame the trolley rack hangs off.
place("reception", 163.09, 640.21, 248.0)

# ---------------------------------------------------------------------------------------------
# Cart shelter (OSM 6932): photos 9, 19. Open carport, white posts and fascia, red boarded back and
# end walls (photo, Marcus 2026-09-26), graphite sheet-metal mono roof (Marcus, 2026-09-26), 2.3 m (NNE back) to 2.7 m (SSW open front). Ortho: 16 m long.
# ---------------------------------------------------------------------------------------------
CS = (180.8, 644.8, 116.7)
assets["cart_shelter"] = {"category": "structure", "parts": [
    {"kind": "shelter", "length": 16.0, "width": 5.0, "low": 2.3, "high": 2.7, "highSide": "-y", "bay": 2.7,
     "wall": "falu_red_vertical", "innerWall": "falu_red_vertical", "endWalls": True, "roofMat": "roof_metal_charcoal",
     "postMat": "white_trim", "overhang": 0.3},
]}
# Shelter and carts as set by hand in Unity (Marcus, 2026-09-26); CS is the ortho/lidar measurement.
place("cart_shelter", 178.75, 647.92, 110.0)
# The club's carts are dark with black roofs (photo 19): the pack's beige body panels recoloured.
# The prefab is the merged copy of the pack's golf-cart-ezgo (2 renderers, same materials): see the parked cars below.
assets["golf_cart"] = {"prefab": "Assets/GolfMap/Vreta/Props/VehiclesLowPoly/Golf Cart.prefab", "axis": "x", "category": "vehicle", "collider": "box",
                       "recolor": [{"material": "Cart Color", "color": [0.07, 0.07, 0.075], "as": "Cart body dark"},
                                   {"material": "Scratched_Polyvinyl_Hood", "color": [0.10, 0.10, 0.11], "as": "Cart hood dark"},
                                   {"material": "Scratched_Polyvinyl_Carbonate_sccnbdnp", "color": [0.10, 0.10, 0.11], "as": "Cart panels dark"}]}
for e, n in ((172.53, 649.47), (175.04, 648.46), (177.32, 647.46), (180.2, 646.36), (182.25, 645.45), (184.85, 644.47)):
    place("golf_cart", e, n, CS[2] - 90 + 180, ground="centre")  # nose to the back wall

# ---------------------------------------------------------------------------------------------
# Gazebo by the 1st tee: photos 14-16. Octagonal, red boarded half-walls in white frames, white
# posts and brackets, dark shingle roof with a small lantern. Ortho/lidar centre (156.5, 649.5).
# ---------------------------------------------------------------------------------------------
assets["gazebo"] = {"category": "structure", "parts": [{"kind": "gazebo", "radius": 1.9, "height": 2.3, "roofRise": 1.3, "open": 4}]}
place("gazebo", 156.5, 649.5, 90.0)
# Second lusthus S of the path fork W of the clubhouse (2025 ortho only, built after the 2023 photo and the
# lidar): roof centre (-7.0, 902.0), ~3.5 m across; open side to the path (N).
place("gazebo", -7.0, 902.0, 225.0)

# ---------------------------------------------------------------------------------------------
# Course toilet by the path at hole 14 (site photos 2026-09-26 12:51, ids 994d7db8, 1c9ce347, 1a772bc7;
# 2025 ortho roof 2.6 x 1.7 m, centre (-221.25, 551.6), long axis 133 deg). Falu red vertical boards, white
# corner boards and fascia, mono roof falling from the door end (SE, by the path) to the NW, white door
# with a round window on a concrete step, galvanised service hatch and a vent on the SW wall.
# ---------------------------------------------------------------------------------------------
assets["course_toilet"] = {"category": "building", "parts": [  # local +y SE (door, high side), +x SW
    {"kind": "building", "length": 1.3, "width": 2.0, "wall": "falu_red_vertical", "trim": "white_trim",
     "plinth": {"h": 0.15, "mat": "concrete"},
     "roof": {"type": "mono", "low": 2.3, "high": 2.9, "overhang": 0.3, "gableOverhang": 0.2, "thick": 0.16, "mat": "roof_metal_charcoal"},
     "openings": [{"side": "+y", "at": 0.0, "w": 0.9, "h": 2.0, "sill": 0.15, "kind": "door", "mat": "door_white", "lamp": False}]},
    {"kind": "box", "c": (0.0, 1.06, 1.7), "s": (0.24, 0.04, 0.24), "mat": "window_dark"},
    {"kind": "box", "c": (0.0, 1.2, 0.07), "s": (0.9, 0.4, 0.15), "mat": "concrete"},
    {"kind": "box", "c": (0.67, 0.4, 0.73), "s": (0.04, 0.5, 1.15), "mat": "galvanised"},
    {"kind": "box", "c": (0.68, 0.72, 2.45), "s": (0.06, 0.25, 0.25), "mat": "white_trim"},
]}
place("course_toilet", -220.12, 551.97, 225.0, dz=-0.075)  # set by hand in Unity 2026-10-11 (ortho fit: -221.25, 551.6, 223)

# ---------------------------------------------------------------------------------------------
# Pump house at the S tip of the pond by the 10th green, where the gravel path ends (Marcus 2026-10-21:
# small red wooden house, white corners). 2023 leaf-off ortho roof 7.7 x 3.9 m, centre (-226.4, 1281.8),
# ridge along 141 deg, dark grey roof; lidar (roofs.tif) ridge 3.3 m, eaves ~2.4 m. No photo: door on the
# SE gable facing the path, a small window on the pond side.
# ---------------------------------------------------------------------------------------------
assets["pump_house"] = {"category": "building", "parts": [  # local +x SE (path, door gable), +y NE (pond)
    {"kind": "building", "length": 7.1, "width": 3.3, "wall": "falu_red_vertical", "trim": "white_trim",
     "cornerBoard": 0.15, "plinth": {"h": 0.2, "mat": "concrete"},
     "roof": {"type": "gable", "eave": 2.3, "ridge": 3.25, "overhang": 0.3, "gableOverhang": 0.3, "mat": "roof_metal_charcoal"},
     "openings": [{"side": "+x", "at": 0.0, "w": 1.0, "h": 1.95, "sill": 0.2, "kind": "door", "mat": "door_red", "lamp": False},
                  win("+y", 1.2, 0.8, 0.6, 1.3, bars=[1, 1])]},
    {"kind": "box", "c": (3.75, 0.0, 0.07), "s": (0.4, 1.2, 0.15), "mat": "concrete"},
]}
place("pump_house", -226.4, 1281.8, 141.0)

# ---------------------------------------------------------------------------------------------
# Driving range house (OSM 7222): photos 12, 124. Mono roof falling from 6.3 m (NNW, range side)
# to 4.2 m (SSE, path side), brown felt roof, white fascia; door, windows and sign boards on the
# SSE front. Lidar centre (165.3, 689.5), 11.2 x 12.8 m walls.
# ---------------------------------------------------------------------------------------------
assets["range_house"] = {"category": "building", "parts": [
    {"kind": "building", "length": 11.2, "width": 12.8, "wall": "falu_red_vertical", "trim": "white_trim",
     "plinth": {"h": 0.2, "mat": "concrete"},
     "roof": {"type": "mono", "low": 4.2, "high": 6.3, "overhang": 0.4, "gableOverhang": 0.35, "thick": 0.3, "mat": "roof_felt_brown"},
     "openings": [win("-y", -3.5, 1.2, 1.1, 1.0, bars=[2, 1]),
                  {"side": "-y", "at": 0.6, "w": 1.0, "h": 2.1, "sill": 0.2, "kind": "door", "bars": [1, 3]},
                  win("-y", 3.8, 1.0, 1.0, 1.1, bars=[1, 1]),
                  win("+x", -3.0, 1.2, 1.0, 1.2, bars=[2, 1]), win("+x", 3.0, 1.2, 1.0, 1.2, bars=[2, 1]),
                  win("-x", 0.0, 1.2, 1.0, 1.2, bars=[2, 1]),
                  win("+y", -3.0, 1.4, 1.0, 3.6, bars=[2, 1]), win("+y", 3.0, 1.4, 1.0, 3.6, bars=[2, 1])]},
    {"kind": "box", "c": (-1.6, -6.43, 1.6), "s": (1.0, 0.04, 0.7), "mat": "sign_black"},
    {"kind": "box", "c": (2.2, -6.43, 1.7), "s": (0.9, 0.04, 0.5), "mat": "paint_white"},
]}
place("range_house", 165.3, 689.5, 77.5)

# Small range hut by the path (photo 12 right): 3.4 x 2.8 m, mono roof, sign board.
assets["range_hut"] = {"category": "building", "parts": [
    {"kind": "building", "length": 3.4, "width": 2.8, "wall": "falu_red_vertical", "trim": "white_trim",
     "plinth": {"h": 0.15, "mat": "concrete"},
     "roof": {"type": "mono", "low": 2.4, "high": 2.9, "overhang": 0.35, "gableOverhang": 0.3, "thick": 0.22, "mat": "roof_felt_brown"},
     "openings": [{"side": "+y", "at": 0.6, "w": 0.9, "h": 2.0, "sill": 0.15, "kind": "door", "mat": "door_red"}]},
    {"kind": "box", "c": (-0.8, 1.43, 1.5), "s": (1.0, 0.04, 0.6), "mat": "sign_black"},
]}
place("range_hut", 179.4, 678.2, 167.5)

# ---------------------------------------------------------------------------------------------
# Range bays (OSM 7223): photos 10, 11, 13. Open to the range (NNW), white posts and fascia, red
# back and end walls, net dividers, brown felt mono roof 4.4 -> 4.9 m. Lidar 23.3 x 8.4 m, 61.6 deg.
# ---------------------------------------------------------------------------------------------
RB = (235.1, 711.9, 61.6)
assets["range_bays"] = {"category": "structure", "parts": [
    {"kind": "shelter", "length": 23.0, "width": 7.4, "low": 4.4, "high": 4.9, "highSide": "+y", "bay": 2.875,
     "wall": "falu_red_vertical", "endWalls": True, "dividers": False, "roofMat": "roof_felt_brown",
     "postMat": "white_trim", "overhang": 0.4, "floorMat": "turf_mat_dark"},
    {"kind": "box", "c": (-6.0, -3.64, 3.3), "s": (2.4, 0.05, 0.6), "mat": "paint_white"},
]}
place("range_bays", *RB)
assets["range_mat"] = {"category": "prop", "parts": [{"kind": "range_mat"}]}
# between the bays, towards the open front: the Anaheim bay divider (1.52 m deep along its z, 0.96 m high)
assets["range_divider"] = {"prefab": "Assets/MacGyverGT Assets/Range Divider Anaheim/Range Divider Anaheim NoLogo.prefab", "axis": "z", "category": "prop", "collider": "box"}
for i in range(1, 8):
    e, n = world(-11.5 + 2.875 * i, 2.2, RB[0], RB[1], RB[2])
    place("range_divider", e, n, RB[2] - 90, ground="centre")
for i in range(8):  # one mat per bay, 1.5 m in from the open front
    e, n = world(-11.5 + 2.875 * (i + 0.5), 2.0, RB[0], RB[1], RB[2])
    place("range_mat", e, n, RB[2], ground="centre")

# Outdoor tee line in front of the putting green (ortho 16 px/m; photo 13): mats every 2.9 m along
# 67.4 deg, white stone embankment behind (SSE), a stone divider and sponsor banners.
p0, p1 = (186.9, 692.2), (221.9, 706.75)
L = math.dist(p0, p1)
ux, uy = (p1[0] - p0[0]) / L, (p1[1] - p0[1]) / L
for i in range(-3, 14):
    e, n = p0[0] + ux * 2.9 * i, p0[1] + uy * 2.9 * i
    if 199.0 < e < 203.8:
        continue
    place("range_mat", e, n, 67.4, ground="centre")
# Behind the mats: flat light gravel paths (not embankments - Marcus, 2026-09-26), draped on the DEM.
def gravel_strip(name, ce, cn, yaw, length, width):
    poly = [(-length / 2, -width / 2), (length / 2, -width / 2), (length / 2, width / 2), (-length / 2, width / 2)]
    assets[name] = {"category": "prop", "collider": "none", "parts": [
        {"kind": "drape", "poly": poly, "grid": height_grid(poly, ce, cn, yaw, cell=0.5), "mat": "white_stones", "lift": 0.03, "edge": "white_stones"}]}
    place(name, ce, cn, yaw, ground="centre")


gravel_strip("gravel_path_a", 188.8, 690.4, 67.4, 21.0, 2.4)
gravel_strip("gravel_path_b", 216.5, 701.7, 67.4, 20.5, 2.4)
gravel_strip("gravel_path_cross", 201.6, 695.6, 157.4, 10.0, 2.6)
assets["banner_ahlsell"] = {"category": "prop", "parts": [{"kind": "banner", "width": 3.2, "height": 0.75, "z": 0.7, "face": "sign_blue", "stripe": "paint_white"}]}
place("banner_ahlsell", 193.0, 693.6, 247.4, ground="centre")
place("banner_ahlsell", 212.5, 701.5, 247.4, ground="centre")

# Range field: target greens (ortho) get flags, the east boundary along the road a ball-stop net.
assets["target_flag_red"] = {"category": "prop", "parts": [{"kind": "target_flag", "mat": "target_flag_red"}]}
assets["target_flag_yellow"] = {"category": "prop", "parts": [{"kind": "target_flag", "mat": "target_flag_yellow"}]}
for (e, n), a in zip(((173.0, 745.0), (203.0, 772.0), (152.0, 792.0), (160.0, 857.0)), ("target_flag_red", "target_flag_yellow", "target_flag_red", "target_flag_yellow")):
    place(a, e, n, 0.0, ground="centre")
assets["distance_board"] = {"category": "prop", "parts": [{"kind": "distance_board"}]}
for e, n in ((178.0, 741.0), (208.0, 768.0), (157.0, 788.0)):
    place("distance_board", e, n, 247.4, ground="centre")
net = [(247.0, 718.0), (237.0, 735.0), (222.0, 765.0), (205.0, 805.0), (190.0, 845.0), (176.0, 885.0)]
assets["range_net"] = {"category": "structure", "collider": "none", "parts": [
    {"kind": "net_poles", "pts": [(e - net[0][0], n - net[0][1]) for e, n in net], "height": 10.0, "spacing": 10.0}]}
place("range_net", net[0][0], net[0][1], 90.0, ground="centre")

# ---------------------------------------------------------------------------------------------
# Range / golf centre (OSM 6930): photos 6, 10, 11. Not in the 2021 lidar (few returns); size from
# the 2025 ortho roof corners (224.2,689.6) (247.1,692.5) (250.4,671.3) (227.5,667.9): 23 x 21.5 m
# roof at 82.8 deg. Long red walls ~4.6 m, very low-pitch brown roof (OSM/lidar p95 6.2 m), white
# fascia; entrance with canopy + sign on the S side, second entrance E, window + team banner + AC
# on the W side facing the putting green.
# ---------------------------------------------------------------------------------------------
GC = (237.3, 680.3, 82.8)
assets["golf_centre"] = {"category": "building", "parts": [
    {"kind": "building", "length": 22.2, "width": 20.7, "wall": "falu_red_vertical", "trim": "white_trim",
     "plinth": {"h": 0.25, "mat": "concrete"},
     "roof": {"type": "gable", "eave": 4.6, "ridge": 6.1, "overhang": 0.4, "gableOverhang": 0.4, "thick": 0.3, "mat": "roof_felt_brown"},
     "openings": [
         {"side": "-y", "at": 1.6, "w": 1.9, "h": 2.2, "sill": 0.1, "kind": "glassdoor", "bars": [2, 1]},
         {"side": "-y", "at": 3.9, "w": 1.5, "h": 1.9, "sill": 0.3, "kind": "glassdoor", "bars": [1, 1]},
         win("-y", -4.5, 1.2, 1.0, 1.3), win("-y", -8.0, 1.2, 1.0, 1.3),
         win("-x", 2.0, 1.4, 1.1, 1.3, bars=[1, 1]),
         {"side": "+x", "at": -3.0, "w": 1.6, "h": 2.2, "sill": 0.1, "kind": "glassdoor", "bars": [2, 1]},
         win("+x", 4.0, 1.2, 1.0, 1.3),
         win("+y", -6.0, 1.2, 1.0, 1.3), win("+y", 0.0, 1.2, 1.0, 1.3), win("+y", 6.0, 1.2, 1.0, 1.3),
         {"side": "+y", "at": -9.0, "w": 1.0, "h": 2.1, "sill": 0.1, "kind": "door"}]},
    {"kind": "box", "c": (2.6, -11.2, 2.75), "s": (4.8, 1.8, 0.22), "mat": "white_trim", "mats": {"top": "roof_felt_brown"}},
    {"kind": "box", "c": (2.6, -10.39, 3.45), "s": (3.8, 0.06, 0.55), "mat": "paint_white"},
    {"kind": "box", "c": (2.6, -10.43, 3.45), "s": (3.2, 0.02, 0.25), "mat": "paint_red"},
    {"kind": "box", "c": (-11.13, -6.0, 1.9), "s": (0.05, 2.6, 2.0), "mat": "sign_blue", "mats": {"-x": "sign_yellow"}},
    {"kind": "box", "c": (-11.35, -1.2, 0.55), "s": (0.4, 0.9, 0.75), "mat": "paint_white"},
    {"kind": "box", "c": (12.0, -3.0, 2.7), "s": (1.6, 3.4, 0.22), "mat": "white_trim", "mats": {"top": "roof_felt_brown"}},
]}
place("golf_centre", *GC)

# ---------------------------------------------------------------------------------------------
# Big barn / indoor hall on the knoll SE of the car park (OSM 1733): photos 131, 132, 137.
# Dark red boards, charcoal metal roof, steep asymmetric gable: ridge 13.3 m, SE eave 5.6 m
# (9.5 m from the ridge), NW eave 3.8 m (13.5 m, a catslide over the lean-to side). Walls 53 x 23 m
# on 44 deg; big doors in both gables; a lower annex on the SW end (lidar 4.6-5.6 m).
# ---------------------------------------------------------------------------------------------
HALL = (241.87, 519.82, 44.0)
hall_open = [
    {"side": "+x", "at": -0.5, "w": 4.0, "h": 4.2, "sill": 0.2, "kind": "garage", "mat": "door_black", "frame": "black_trim", "bars": [1, 1]},
    {"side": "+x", "at": 4.5, "w": 1.0, "h": 2.1, "sill": 0.2, "kind": "door", "mat": "door_black", "frame": "black_trim"},
    {"side": "+x", "at": -1.5, "w": 1.6, "h": 1.6, "sill": 8.2, "kind": "shutter", "frame": "black_trim"},
    {"side": "-x", "at": -0.5, "w": 4.0, "h": 4.0, "sill": 0.2, "kind": "garage", "mat": "door_black", "frame": "black_trim", "bars": [1, 1]},
]
for x in range(-20, 24, 8):
    hall_open.append(win("-y", float(x), 1.2, 1.0, 1.8, frame="black_trim", bars=[1, 1]))
    hall_open.append(win("+y", float(x) + 4.0, 1.0, 0.8, 1.6, frame="black_trim", bars=[1, 1]))
assets["hall"] = {"category": "building", "parts": [
    {"kind": "building", "length": 53.0, "width": 23.0, "wall": "falu_red_dark_vertical", "trim": "black_trim",
     "plinth": {"h": 0.4, "mat": "concrete"},
     "roof": {"type": "gable", "eaveA": 5.6, "eaveB": 3.8, "ridge": 13.3, "ridgeY": -2.0, "overhang": 0.5,
              "gableOverhang": 0.4, "thick": 0.25, "mat": "roof_metal_charcoal", "under": "black_trim", "edge": "black_trim", "seams": False},
     "openings": hall_open},
    {"kind": "building", "at": (-29.5, 0.0, 0.0), "length": 6.0, "width": 16.0, "wall": "falu_red_dark_vertical", "trim": "black_trim",
     "plinth": {"h": 0.4, "mat": "concrete"},
     "roof": {"type": "gable", "eave": 3.2, "ridge": 5.4, "overhang": 0.4, "gableOverhang": 0.3, "mat": "roof_metal_charcoal", "under": "black_trim", "edge": "black_trim"},
     "openings": [{"side": "-x", "at": 2.0, "w": 2.6, "h": 2.4, "sill": 0.2, "kind": "garage", "mat": "door_black", "frame": "black_trim"}]},
]}
place("hall", *HALL)

# Small sheds: gable shed W of the putting green (ortho 9 x 5.5 m at 160 deg; graphite roof - Marcus, 2026-09-26), and the
# little black-roofed shed SE of the golf centre (photo 1-2, lidar 2-3 m at (261, 668)).
assets["shed_grey"] = {"category": "building", "parts": [
    {"kind": "building", "length": 9.0, "width": 5.5, "wall": "falu_red_vertical", "trim": "white_trim", "plinth": {"h": 0.2, "mat": "concrete"},
     "roof": {"type": "gable", "eave": 2.5, "ridge": 3.8, "overhang": 0.35, "gableOverhang": 0.3, "mat": "roof_metal_charcoal"},
     "openings": [{"side": "+y", "at": 0.0, "w": 2.6, "h": 2.1, "sill": 0.1, "kind": "garage", "bars": [2, 1]}, win("-x", 0.0, 0.8, 0.8, 1.2)]}]}
place("shed_grey", 163.5, 662.0, 160.0)
assets["shed_black"] = {"category": "building", "parts": [
    {"kind": "building", "length": 4.0, "width": 3.0, "wall": "falu_red_vertical", "trim": "white_trim", "plinth": {"h": 0.2, "mat": "concrete"},
     "roof": {"type": "gable", "eave": 2.2, "ridge": 3.2, "overhang": 0.3, "gableOverhang": 0.25, "mat": "roof_metal_black"},
     "openings": [win("-y", 0.0, 0.7, 0.7, 1.1, bars=[1, 1]), {"side": "+x", "at": 0.0, "w": 0.9, "h": 1.9, "sill": 0.1, "kind": "door", "mat": "door_red"}]}]}
place("shed_black", 261.0, 668.0, 82.8)

# ---------------------------------------------------------------------------------------------
# Landscape props
# ---------------------------------------------------------------------------------------------
# Granite outcrop N of the clubhouse (photo 20; ortho 176-189 / 622-634; not in the DEM) and the
# memorial stone in front of it.
# The lidar ground model holds only the W half of the rock (a 1.5 m hump at E 176-180); photo 20 shows the
# bare granite rising to ~82.3 m (eye height from the photo spot) across E 176-187. The dome caps the hump.
assets["granite_outcrop"] = {"category": "structure", "parts": [{"kind": "rock", "sx": 12.5, "sy": 9.5, "sz": 2.3, "seed": 5, "mat": "granite_rock"}]}
place("granite_outcrop", 179.8, 627.0, 95.0, ground="min")
assets["memorial_stone"] = {"category": "prop", "collider": "box", "parts": [
    {"kind": "box", "c": (0, 0, 0.5), "s": (0.4, 0.3, 1.6), "mat": "granite_plinth"},
    {"kind": "box", "c": (0, -0.16, 1.05), "s": (0.3, 0.02, 0.2), "mat": "sign_black"}]}
place("memorial_stone", 172.6, 626.2, 68.0, ground="centre")  # W foot of the outcrop, by the asphalt (photo 20)

# Hedges along the road N of the car park (lidar ~1-1.2 m, ortho four clipped segments).
# One straight hedge with three walk-throughs, on the centre of the ~1.9 m grass strip between the road and the
# lawn-side path (the app's `path` features leave the strip open along n = 636.8 + 0.1159 (e - 226)).
road_hedge = lambda e: (e, round(636.8 + 0.1159 * (e - 226.0), 2))
hedges = [(road_hedge(a), road_hedge(b)) for a, b in ((197.0, 211.0), (212.3, 226.0), (227.0, 244.3), (245.6, 253.5))]
# Around the putting-green lawn (photos 127, 128; lidar 0.9-1 m, 2021): straight along the car park's W edge, and
# curving along the path on the lawn's SW side (lidar centreline, 4 m bins, set 0.95 m clear of the path so the
# whole hedge stands on the lawn).
HEDGE_CARPARK = ((216.5, 628.0), (242.4, 566.1))
hedges.append(HEDGE_CARPARK)
lawn_sw = [(205.89, 590.93), (208.68, 585.38), (212.34, 579.12), (217.77, 573.3), (224.0, 567.78), (228.2, 564.4), (235.1, 561.2)]
hedges += list(zip(lawn_sw, lawn_sw[1:]))
# Real foliage from the course project's CESimgolf landscaping pack (a Unity prefab, not a Blender asset):
# clipped boxwood blocks (6.35 x 1.59 m, 1.49 m tall, long axis local x) tiled along each segment with a
# little overlap, scaled to the ~1 m hedge width.
BOXWOOD = "Assets/CESimgolf 3D Assets/BUSHES - Boxwood/PREFABS/Boxwood Rectangle Small.prefab"
assets["hedge_boxwood"] = {"prefab": BOXWOOD, "category": "prop", "collider": "keep"}
for a, b in hedges:
    L = math.dist(a, b)
    n = max(1, int(math.ceil(L / 6.0)))
    yaw = math.degrees(math.atan2(b[0] - a[0], b[1] - a[1]))
    piece = L / n
    for k in range(n):
        t = (k + 0.5) / n
        instances.append({"asset": "hedge_boxwood", "e": round(E0 + a[0] + (b[0] - a[0]) * t, 2), "n": round(N0 + a[1] + (b[1] - a[1]) * t, 2),
                          "yawDeg": round(yaw, 2), "ground": "centre", "scale": [round(piece / 6.35 * 1.06, 3), 0.9, 0.68]})

# Round the back (E end) of the 1st tee (photo 18 looks along it; Marcus's line 2026-09-26): a ~1 m clipped hedge
# from the tee's S side round the E end to just short of the path. Newer than the 2021 lidar; the centreline is
# the 2025 ortho's dark band (its shadow: sun from the WNW, as the buildings' shadows) moved 0.7 m back towards
# the sun. Short blocks (~2 m) so the curve stays round; more overlap so the outer corners close.
tee1_shadow = [(140.0, 615.7), (142.0, 615.5), (144.0, 615.45), (146.0, 615.6), (147.8, 616.3), (149.3, 617.3), (150.4, 618.6),
               (151.0, 619.9), (151.2, 621.8), (151.0, 623.3), (150.5, 624.6), (149.8, 625.8), (148.8, 626.7), (147.5, 627.2),
               (146.3, 627.6), (145.3, 627.9)]
tee1_hedge = [(e - 0.55, n + 0.45) for e, n in tee1_shadow]
assets["hedge_tee"] = {"prefab": BOXWOOD, "category": "prop", "collider": "keep"}
_seg = [math.dist(a, b) for a, b in zip(tee1_hedge, tee1_hedge[1:])]
_n = max(1, round(sum(_seg) / 2.0))


def _at(s):
    """Point at arc length s along tee1_hedge."""
    for (a, b), L in zip(zip(tee1_hedge, tee1_hedge[1:]), _seg):
        if s <= L:
            return (a[0] + (b[0] - a[0]) * s / L, a[1] + (b[1] - a[1]) * s / L)
        s -= L
    return tee1_hedge[-1]


for k in range(_n):
    a, b = _at(sum(_seg) * k / _n), _at(sum(_seg) * (k + 1) / _n)
    instances.append({"asset": "hedge_tee", "e": round(E0 + (a[0] + b[0]) / 2, 2), "n": round(N0 + (a[1] + b[1]) / 2, 2),
                      "yawDeg": round(math.degrees(math.atan2(b[0] - a[0], b[1] - a[1])), 2), "ground": "centre",
                      "scale": [round(math.dist(a, b) / 6.35 * 1.15, 3), 0.65, 0.65]})

# Flags. Row of 12 along the W edge of the car park (ortho shadows; photos 7, 20, 31, 126, 135),
# 5 sponsor flags at the entrance (photo 130), the Swedish flag by the road (photo 134), two in
# front of the barn gable (photo 137).
flag_styles = {
    "flag_club": ["flag_white", "flag_navy", "flag_white"],
    "flag_blue": ["flag_blue"],
    "flag_orange": ["flag_orange"],
    "flag_white": ["flag_white"],
    "flag_redwhite": ["flag_red", "flag_white", "flag_blue"],
    "flag_green": ["flag_white", "flag_green"],
}
for nm, cols in flag_styles.items():
    assets[nm] = {"category": "prop", "collider": "none", "parts": [{"kind": "flagpole", "height": 8.0, "colors": cols, "flagW": 1.0, "flagH": 2.6}]}
assets["flag_sweden"] = {"category": "prop", "collider": "none", "parts": [{"kind": "flagpole", "height": 10.0, "style": "flag", "bands": "cross", "colors": ["flag_blue", "flag_yellow"], "flagW": 2.4, "flagH": 1.5}]}
row = ["flag_club", "flag_blue", "flag_redwhite", "flag_white", "flag_orange", "flag_club", "flag_green", "flag_blue", "flag_white", "flag_orange", "flag_redwhite", "flag_club"]
# The row stands just behind the car-park hedge (photo 127: the hedge hides the pole feet), 1 m E of its centreline.
for i, nm in enumerate(row):
    place(nm, 220.04 + 1.83 * i, 622.14 - 4.22 * i, 67.0 + (i % 3) * 8, ground="centre")
for (e, n), nm in zip(((288.5, 601.0), (290.0, 596.5), (291.0, 592.0), (294.5, 603.0), (298.0, 603.5)), ("flag_blue", "flag_white", "flag_redwhite", "flag_orange", "flag_club")):
    place(nm, e, n, 80.0, ground="centre")
place("flag_sweden", 313.0, 573.0, 80.0, ground="centre")
place("flag_club", 266.5, 548.5, 75.0, ground="centre")
place("flag_white", 269.0, 546.0, 75.0, ground="centre")
assets["entrance_sign"] = {"category": "prop", "collider": "box", "parts": [{"kind": "banner", "width": 2.6, "height": 1.3, "z": 0.5, "face": "paint_white", "back": "paint_grey"}]}
place("entrance_sign", 303.0, 590.5, 200.0, ground="centre")
assets["utility_cabinet"] = {"category": "prop", "collider": "box", "parts": [{"kind": "box", "c": (0, 0, 0.7), "s": (1.2, 0.5, 1.4), "mat": "paint_grey"}]}
place("utility_cabinet", 296.0, 597.5, 80.0, ground="centre")

# Seating and small furniture.
assets["picnic_table"] = {"category": "prop", "collider": "box", "parts": [{"kind": "picnic_table"}]}
for e, n, dz in ((155.17, 642.04, 0.182), (159.72, 644.55, 0.07)):  # by the gazebo (photos 15, 16; set by hand in Unity)
    place("picnic_table", e, n, 80.0, ground="centre", dz=dz)
# On the terrace W of the gable (2025 ortho, photos 21, 22): two rows of four, side by side along the
# building, each table's long axis parallel to the gable wall. None on the veranda deck (ortho, photo 22).
# Props stand on the terrain, so dz lifts each onto the paving where the terrace is built up.
for y in (-7.2, -11.0):
    for x in (-21.2, -19.5, -17.8, -16.1):
        e, n = world(x, y, CH[0], CH[1], CH[2])
        g = ground(e, n) - _base
        place("picnic_table", e, n, CH[2] - 90, ground="centre", dz=round(max(DECK, g + 0.04) - g, 3))
assets["bench"] = {"category": "prop", "collider": "box", "parts": [{"kind": "bench"}]}
assets["bench_stone"] = {"category": "prop", "collider": "box", "parts": [{"kind": "bench", "style": "stone", "mat": "wood_grey"}]}
place("bench", 163.44, 635.66, 68.0, ground="centre", dz=0.039)  # in front of reception (photo 18; set by hand in Unity)
place("bench", 161.33, 636.47, 155.0, ground="centre", dz=-0.034)  # set by hand in Unity
# Every hole: the club's tee sign (number, par, index, hole view, tee lengths) and a slab bench by the yellow
# tee - positions and board faces from hole-signs.gen.py (holes 1 and 10 from photos 17 and 28-29).
HS = json.load(open(os.path.join(HERE, "hole-signs.json"), encoding="utf-8"))
MATS = {}
# Set by hand in Unity (wins over hole-signs.json): hole -> sign (e, n, yaw, dz), bench (e, n, yaw, dz).
HS_HAND = {
    14: ((-204.86, 569.23, 170.13, 0.355), (-205.11, 570.71, 170.13, -0.022)),  # 2026-10-11: 17.6 m E, by the path
}
for s in HS["signs"]:
    if s["hole"] in HS_HAND:
        (se, sn, sy, sdz), (be, bn, by, bdz) = HS_HAND[s["hole"]]
        s = dict(s, sign=[se, sn, sy], bench=[be, bn, by], signDz=sdz, benchDz=bdz)
    aid, mat = "tee_sign_%02d" % s["hole"], "hole_board_%02d" % s["hole"]
    MATS[mat] = {"image": s["texture"], "smoothness": 0.35}
    assets[aid] = {"category": "prop", "collider": "box", "parts": [
        {"kind": "tee_sign", "face": mat, "width": HS["board"]["width"], "height": HS["board"]["height"], "outline": HS["board"]["outline"]}]}
    place(aid, *s["sign"], ground="centre", dz=s.get("signDz", 0.0))
    place("bench_stone", *s["bench"], ground="centre", dz=s.get("benchDz", 0.0))
assets["signpost"] = {"category": "prop", "collider": "box", "parts": [{"kind": "signpost", "arms": [{"dir": 20}, {"dir": 200}, {"dir": 110}, {"dir": 290}]}]}
place("signpost", 194.0, 627.7, 0.0, ground="centre")  # on the lawn's NW corner (photos 127-128; 2025 ortho pole shadow)
assets["bollard_light"] = {"category": "prop", "collider": "none", "parts": [{"kind": "bollard_light"}]}
# The range-path row stands 0.6 m off the path's east edge (the app's `path` feature; it runs NNW here). The
# putting-green row: five on the lawn's N edge E of the signpost, ~3.8 m apart (2025 ortho shadow feet; photos 127,
# 128), 0.6 m off the path.
for e, n in ((189.0, 659.5), (187.6, 667.0), (186.3, 674.5), (186.5, 682.0),
             (197.1, 628.5), (200.9, 628.9), (204.8, 629.3), (208.5, 629.7), (212.1, 630.2)):
    place("bollard_light", e, n, 0.0, ground="centre")
assets["trolley_rack"] = {"category": "prop", "collider": "none", "parts": [{"kind": "trolley_rack", "length": 2.4}]}
place("trolley_rack", *world(2.6, 2.0, RC[0], RC[1], RC[2]), RC[2] + 90, ground="centre")
assets["bin"] = {"category": "prop", "collider": "box", "parts": [{"kind": "bin"}]}
# The one by the clubhouse stands just off the outcrop's E tip (local x 6.28), clear of the asphalt.
for e, n, yaw in ((165.12, 636.22, 250.0), (186.75, 626.4, 70.0), (185.6, 583.0, 70.0), (225.0, 644.0, 70.0)):  # the first set by hand in Unity
    place("bin", e, n, yaw, ground="centre")

# Footbridges where the cart paths cross the creek: timber on the 10th (photo 30; creek at
# (186.9, 554.8) flowing 98 deg), brick on the 18th (photos 34-37; creek at (56.0, 562.5), 152 deg).
# The span joins the two cart-path ends (the app's `path` features, end centres (194.11, 558.46) and
# (191.08, 550.85) - 8.2 m, bearing 21.7 deg, both at 75.1 m; creek bed 72.8 m), plus 0.7 m onto each path.
BRIDGES = []  # (name, centre e, n, yaw, length, width): also written as `path` features (see end of file)
assets["bridge_wood"] = {"category": "structure", "parts": [{"kind": "bridge_wood", "length": 9.6, "width": 2.2, "rise": 0.3}]}
place("bridge_wood", 192.6, 554.65, 21.7, ground="max", dz=-0.05)
BRIDGES.append(("bridge_wood", 192.6, 554.65, 21.7, 9.6, 2.2))
assets["bridge_brick"] = {"category": "structure", "parts": [{"kind": "bridge_brick", "length": 8.0, "width": 2.0, "rise": 0.35}]}
place("bridge_brick", 56.0, 562.5, 62.2, ground="max")
BRIDGES.append(("bridge_brick", 56.0, 562.5, 62.2, 8.0, 2.0))
# Rope footbridge over the creek on the 14th (photos 83-84, taken from its E and NE ends): flat grey plank deck,
# white fascia, 6 dark brown posts a side with two hemp rope swags per bay and knots on the posts, three
# railway-sleeper steps at the NE end. The creek (the app's water feature, dug 0.9 m into the edited DEM) runs
# ~151 deg here, bed centre (-187.5, 366.0), 7 m bank to bank at 75.6 m; the span is square to it (photo 84
# looks 230 deg along it). A striped yellow/black post stands on the SE side near the NE end (photo 83).
BR = (-187.5, 366.0, 58.0)
# 2026-10-11: built for pulling a trolley over, not as photographed - a low deck with a plank ramp at each end
# in place of the sleeper steps (was "deck": 0.4, "steps": [1, 3]).
assets["bridge_rope"] = {"category": "structure", "parts": [{"kind": "bridge_rope", "length": 10.0, "width": 1.8, "deck": 0.15, "steps": [0, 0], "ramps": [1.2, 1.2], "pileDepth": 3.0}]}
place("bridge_rope", *BR, ground="max")
BRIDGES.append(("bridge_rope", BR[0], BR[1], BR[2], 10.0, 1.8))
assets["marker_post"] = {"category": "prop", "collider": "box", "parts": [{"kind": "marker_post"}]}
place("marker_post", *world(3.6, -2.2, BR[0], BR[1], BR[2]), BR[2], ground="centre")
# The same kind of bridge further N (2025 ortho: a grey deck 10.0 m long on bearing 80.5 deg, centre
# (-141.32, 971.88), a pale worn pad off its E end and the walked path leaving its W end southwards). The creek
# is 2.5 m deep here (bed 72.9 m, banks 75.4-75.5 m at +-5 m), hence the 3 m piles on the shared asset.
place("bridge_rope", -141.32, 971.88, 80.5, ground="max")
BRIDGES.append(("bridge_rope_n", -141.32, 971.88, 80.5, 10.0, 1.8))
# The footbridge W of the pond by the 5th green (2025 ortho: a pale deck 2 m wide over the channel between the pond
# and the ditch, its shadow on the water side): the rope bridge again, but one trolleys are pulled over, so a low
# deck with a plank ramp at each end and no steps. It joins the ends of the two gravel paths drawn in the app
# ((-354.7, 1541.7) and (-351.6, 1551.1): 9.9 m on bearing 18.3 deg; banks 74.7-74.8 m, the channel between them
# 74.05 m under the pond's water plane at 74.17 m); the ramps lie on the path ends.
assets["bridge_rope_cart"] = {"category": "structure", "parts": [
    {"kind": "bridge_rope", "length": 10.0, "width": 2.0, "deck": 0.15, "steps": [0, 0], "ramps": [1.2, 1.2], "pileDepth": 1.6}]}
place("bridge_rope_cart", -353.15, 1546.4, 18.3, ground="max")
BRIDGES.append(("bridge_rope_cart", -353.15, 1546.4, 18.3, 12.4, 2.0))
# The jetty in the same pond's N end (2025 ortho): an 11.7 x 4.2 m timber deck on bearing 57 deg from its water end
# (-335.7, 1541.9), a paler board across each end, and a grey 3.4 m gangway from the bank down to it (the edited
# DEM's waterline is where the timber ends). Origin on the bank at the gangway's land end, +x out over the water;
# the deck stands 0.45 m over the water plane (74.17 m = Unity y 8.949 + the inner sidecar's minM).
JETTY = (-323.04, 1550.12, 237.0)
POND5_WATER = 74.17
assets["jetty"] = {"category": "structure", "parts": [
    {"kind": "jetty", "length": 11.7, "width": 4.2, "ramp": 3.4, "rampWidth": 3.6, "pileDepth": 2.6,
     "deckZ": round(POND5_WATER + 0.45 - ground(JETTY[0], JETTY[1]), 2) if _dem else -0.2}]}
place("jetty", *JETTY, ground="centre")
BRIDGES.append(("jetty", *world(7.55, 0.0, *JETTY), JETTY[2], 15.1, 4.2))

# ---------------------------------------------------------------------------------------------
# Parked cars (clubhouse-cars.json: stall rows tuned on the 2025 ortho, occupancy + colour).
# ---------------------------------------------------------------------------------------------
# Two realistic models from the course project's vehicle pack (Standard shader, +z forward): a 5-door
# hatchback and a small sedan. The pack's prefabs (Assets/Vehicles/Prefabs/, 43 and 29 renderers, 26k and
# 19k triangles a car) are not placed: the course's own low-poly copies are (2 renderers, ~10k triangles,
# same materials; blender/tools/vehicle_models_10k.py + golfmap.vehicles.build, docs/unity-tool-notes.md).
# The pack's colours cover white, black, navy and red; the rest (grey and silver are 2/3 of the car park)
# are recoloured copies of the body materials. clubhouse-cars.json lists every stall the 2025 ortho shows a
# car in; "parked": false leaves a stall empty (30 of 89 stay, for frame rate).
VEH = "Assets/GolfMap/Vreta/Props/VehiclesLowPoly/"
PAINT = {"grey": (0.20, 0.21, 0.22), "silver": (0.55, 0.56, 0.58), "blue": (0.06, 0.10, 0.24), "red": (0.42, 0.03, 0.03), "black": (0.02, 0.02, 0.025)}


def hatch(col):
    if col in ("white", "black"):
        return {"prefab": VEH + "Hatchback %s.prefab" % col.title(), "axis": "z", "category": "vehicle", "collider": "box"}
    c = PAINT[col]
    return {"prefab": VEH + "Hatchback White.prefab", "axis": "z", "category": "vehicle", "collider": "box",
            "recolor": [{"material": "BodyMat 5", "color": list(c), "as": "Hatchback body " + col},
                        {"material": "SeamsMat 5", "color": [v * 0.7 for v in c], "as": "Hatchback seams " + col}]}


def sedan(col):
    if col == "white":
        return {"prefab": VEH + "Sedan.prefab", "axis": "z", "category": "vehicle", "collider": "box"}
    return {"prefab": VEH + "Sedan.prefab", "axis": "z", "category": "vehicle", "collider": "box",
            "recolor": [{"material": "Tocus_Body White", "color": list(PAINT[col]), "as": "Sedan body " + col}]}


for col in ("white", "silver", "grey", "black", "blue", "red"):
    assets["car_hatch_" + col] = hatch(col)
    assets["car_sedan_" + col] = sedan(col)
cars = json.load(open(os.path.join(HERE, "clubhouse-cars.json"), encoding="utf-8"))

# Stall lines (2025 ortho: white paint on the asphalt; a centre line down each double row with a divider
# between the stalls either side of it, dividers only in the single rows along the hedge (A) and the E edge (D)).
# The stalls are clubhouse-cars.json's rows on their 2.5 m pitch, 5 m deep; each row's lines span its first to
# its last stall. Every car stands centred in its stall, nose in: towards the centre line in a double row,
# towards the edge in a single one (NOSE), the odd one reversed in.
PITCH, DEPTH, LINE_W = 2.5, 5.0, 0.12
NOSE = {"A": 1, "D": -1}  # single rows: 1 = nose along the row's yawDeg (A: into the hedge), -1 = against it (D: E edge)
# Set by hand in Unity: stall entry (e, n) -> stalls along the row (+ = SSE).
HAND_STALL = {(530224.17, 6487620.25): -1}  # car_sedan_white#207 (placed.json, 2026-10-14)
OPEN_ENDS = {"D"}  # rows with no divider at either end (D's N one stood alone by the entrance; Marcus, 2026-10-14)
# Stalls per line mesh. Unity grounds a prop at its origin and the course surface there is the DEM tilted
# ~1 cm in 10 m, so a row-long mesh (60 m) would sink at one end: each 10 m piece is grounded on its own.
CHUNK = 4


def row_axes(yaw):
    """A row's unit vectors in (e, n): along the row (bearing yaw - 90) and the car's forward (bearing yaw)."""
    a, f = math.radians(yaw - 90), math.radians(yaw)
    return (math.sin(a), math.cos(a)), (math.sin(f), math.cos(f))


rows = {}
for c in cars:
    rows.setdefault(c["row"], []).append(c)
for r in sorted(rows):
    cs = rows[r]
    yaw = cs[0]["yawDeg"]
    A, F = row_axes(yaw)

    def en(u, v):
        return (u * A[0] + v * F[0], u * A[1] + v * F[1])

    for c in cs:
        e, n = c["e"] - E0, c["n"] - N0
        c["_u"], c["_v"] = e * A[0] + n * A[1], e * F[0] + n * F[1]
    uref = min(c["_u"] for c in cs)
    vs = sorted(c["_v"] for c in cs)
    sides = [[vs[0]]]  # stalls by v: one side in a single row, two back to back in a double row
    for v in vs[1:]:
        if v - sides[-1][-1] > 1.0:
            sides.append([v])
        else:
            sides[-1].append(v)
    assert len(sides) in (1, 2), "row %s: %d stall lines" % (r, len(sides))
    double = len(sides) == 2
    vmid = (sum(sides[0]) / len(sides[0]) + sum(sides[1]) / len(sides[1])) / 2 if double else sum(vs) / len(vs)
    taken = {}  # side -> stall numbers
    for c in cs:
        k = round((c["_u"] - uref) / PITCH)
        assert abs(c["_u"] - uref - k * PITCH) < 0.1, "row %s: stall off the 2.5 m pitch at %s" % (r, (c["e"], c["n"]))
        c["_k"] = k + HAND_STALL.get((c["e"], c["n"]), 0)
        c["_s"] = 1 if double and c["_v"] > vmid else 0
        taken.setdefault(c["_s"], set()).update((k, c["_k"]))

    # the cars
    for c in cs:
        if c.get("parked") is False:
            continue  # stall left empty (delete the flag in clubhouse-cars.json to bring the car back)
        h = int(hashlib.md5(("%.2f%.2f" % (c["e"], c["n"])).encode()).hexdigest(), 16)
        kind = "hatch" if h % 10 < 5 else "sedan"
        if double:
            v, nose = vmid + (DEPTH / 2 if c["_s"] else -DEPTH / 2), (-1 if c["_s"] else 1)
        else:
            v, nose = vmid, NOSE[r]
        if (h >> 8) % 10 == 0:
            nose = -nose  # the odd one reversed in
        e, n = en(uref + c["_k"] * PITCH, v)
        instances.append({"asset": "car_%s_%s" % (kind, c["col"]), "e": round(E0 + e, 2), "n": round(N0 + n, 2),
                          "yawDeg": round((yaw + (0 if nose > 0 else 180)) % 360, 1), "ground": "centre"})

    # the lines, in pieces of CHUNK stalls; boundary j lies between stall j - 1 and stall j
    k0 = min(min(t) for t in taken.values())
    k1 = max(max(t) for t in taken.values())
    if double:
        span = {s: (vmid, vmid + DEPTH) if s else (vmid - DEPTH, vmid) for s in taken}
    else:  # 0.5 m short at the edge the noses point to: the asphalt ends just past the cars there (D)
        span = {0: tuple(sorted((vmid - NOSE[r] * DEPTH / 2, vmid + NOSE[r] * (DEPTH / 2 - 0.5))))}
    pieces = range(0, k1 - k0 + 1, CHUNK)
    for p, j0 in enumerate(pieces):
        j1 = min(j0 + CHUNK, k1 - k0 + 1)  # this piece's boundaries: k0 + j0 .. k0 + j1 (the last piece takes its end one)
        ua, ub = uref + (k0 + j0 - 0.5) * PITCH, uref + (k0 + j1 - 0.5) * PITCH
        segs = []
        if double:
            segs.append((ua - LINE_W / 2, vmid, ub + LINE_W / 2, vmid))
        for j in range(k0 + j0, k0 + j1 + (1 if j1 == k1 - k0 + 1 else 0)):
            u = uref + (j - 0.5) * PITCH
            for s, (va, vb) in span.items():
                lo, hi = min(taken[s]), max(taken[s]) + 1
                if lo <= j <= hi and not (r in OPEN_ENDS and j in (lo, hi)):
                    segs.append((u, va, u, vb))
        ce, cn = en((ua + ub) / 2, vmid)
        ayaw = yaw - 90  # local +x along the row
        lines = []
        for ua_, va_, ub_, vb_ in segs:
            lines.append([*local(*en(ua_, va_), ce, cn, ayaw), *local(*en(ub_, vb_), ce, cn, ayaw)])
        xs = [q for l in lines for q in (l[0], l[2])]
        ys = [q for l in lines for q in (l[1], l[3])]
        box = [(min(xs) - 0.3, min(ys) - 0.3), (max(xs) + 0.3, min(ys) - 0.3), (max(xs) + 0.3, max(ys) + 0.3), (min(xs) - 0.3, max(ys) + 0.3)]
        aid = "stall_lines_%s%d" % (r, p)
        assets[aid] = {"category": "marking", "collider": "none", "parts": [
            {"kind": "markings", "lines": lines, "width": LINE_W, "lift": 0.03, "mat": "line_paint",
             "grid": height_grid(box, ce, cn, ayaw, cell=0.5)}]}
        place(aid, ce, cn, ayaw, ground="centre")


spec = {
    "format": "golfmap-props-spec-v1",
    "materials": MATS,
    "course": "vreta",
    "origin": [E0 + 205.0, N0 + 640.0],
    "assets": assets,
    "instances": instances,
    "layoutViews": [
        {"name": "top", "at": [0, -20], "size": 190},
        {"name": "club", "at": [-18, -35], "size": 70},
        {"name": "oblique_se", "from": [110, -150, 70], "at": [-10, -10], "lens": 28},
        {"name": "oblique_w", "from": [-120, -20, 30], "at": [0, -10], "lens": 30},
        {"name": "clubhouse_w", "from": [-60, -45, 6], "at": [-18, -35], "atZ": 4, "lens": 35},
    ],
}
with open(os.path.join(HERE, "clubhouse-props.json"), "w", encoding="utf-8") as f:
    json.dump(spec, f, indent=1)

# Bridge decks as the course's `path` features (import-generated-features, source "props-bridges"): the
# creek-bank zones keep their path clearance across them, so no thicket grows through a bridge.
feats = []
for name, ce, cn, yaw, length, width in BRIDGES:
    hw = width / 2 + 1.2  # + room for bushes that lean: nothing roots within ~1 m of the railing
    ring = [world(x, y, ce, cn, yaw) for x, y in ((-length / 2, -hw), (length / 2, -hw), (length / 2, hw), (-length / 2, hw))]
    ring = [[round(E0 + e, 2), round(N0 + n, 2)] for e, n in ring]
    feats.append({"type": "Feature", "geometry": {"type": "Polygon", "coordinates": [ring + [ring[0]]]},
                  "properties": {"type": "path", "source": "props-bridges", "source_ref": name, "license": "own", "surface": "bridge"}})
with open(os.path.join(HERE, "clubhouse-bridges.geojson"), "w", encoding="utf-8") as f:
    json.dump({"type": "FeatureCollection", "crs": {"type": "name", "properties": {"name": "EPSG:3006"}}, "features": feats}, f, indent=1)
print("%d assets, %d instances" % (len(assets), len(instances)))
