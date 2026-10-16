"""The water surface of a big lake as Unity plane meshes (`golfpipe lake-plane`).

A pond's plane is built in Unity from its OPCD lake mesh (GolfMapWaterplanes). A big lake
like Vättern at Omberg reaches far past both terrain squares and must look endless out to
the horizon backdrop (a pano cylinder some 4 km out, inside GSPro's 5 km draw distance),
so its surface is cut here from the lake's outline instead:

- the outline is the `shore` terrain edit's polygon (shore-edits: Hydrografi trimmed by
  lidar land) within the squares, and Hydrografi's lake beyond them, out to `radiusM`
  from the inner square's centre;
- it is buffered by `underBankM` so the flat plane runs in under the banks (ground above
  the level hides it), the way OPCD's water plane is pushed out;
- three meshes of square cells, coarser with distance: `near` (the inner square plus
  `nearMarginM`, fine enough for Lux's Gerstner vertex waves), `outer` (the rest of the
  outer square) and `far` (beyond it); cells are kept where they touch the buffered lake;
- one flat `collider` mesh over the near part, what the ball hits (GSPro's water is the
  collider's GSPwater physic material);
- a reflection probe spot over open water inside the inner square.

Coordinates are Unity's for the course: x = E - inner square's west edge, z = N - its
south edge, y = level - the inner sidecar's minM + its unity position y (the frame the
heightmap export puts the inner terrain in). Triangles wind clockwise seen from above
(Unity's front face). Output format `golfmap-lake-plane-v1`, read by the Unity command
`golfmap.lake.build`.
"""

from __future__ import annotations

import base64
import json
import math
from pathlib import Path

import numpy as np
import rasterio.features
from rasterio.transform import from_origin
from shapely.geometry import Point, Polygon, box, mapping, shape
from shapely.ops import unary_union

FORMAT = "golfmap-lake-plane-v1"
DEFAULT_RADIUS_M = 4000.0
DEFAULT_UNDER_BANK_M = 4.0
DEFAULT_NEAR_MARGIN_M = 150.0
DEFAULT_NEAR_CELL_M = 2.0
DEFAULT_OUTER_CELL_M = 10.0
DEFAULT_FAR_CELL_M = 25.0
DEFAULT_COLLIDER_CELL_M = 5.0
PROBE_ABOVE_M = 15.0
SHORE_GRID_CELL_M = 1.0
SHORE_GRID_STEP_M = 0.2      # uint8 steps: distances up to 51 m


class LakePlaneError(RuntimeError):
    """User-actionable lake-plane input error."""


def _polygons(doc: dict) -> list[Polygon]:
    feats = doc.get("features") if doc.get("type") == "FeatureCollection" else [doc]
    out = []
    for f in feats or []:
        g = f.get("geometry") if isinstance(f, dict) and f.get("type") == "Feature" else f
        if not g:
            continue
        geom = shape(g)
        out.extend(getattr(geom, "geoms", [geom]))
    return [p for p in out if isinstance(p, Polygon) and not p.is_empty]


def _is_wgs84(polys: list[Polygon]) -> bool:
    x, y = polys[0].exterior.coords[0][:2]
    return abs(x) <= 180 and abs(y) <= 90


def read_shore(path: Path) -> tuple[Polygon, float | None]:
    """The lake polygon in EPSG:3006 and the edit's levelM (None for a plain GeoJSON).
    Takes the shore-edits D-TE5 file (WGS84) or its `--out-3006` inspection file."""
    doc = json.loads(Path(path).read_text(encoding="utf-8"))
    polys = _polygons(doc)
    if not polys:
        raise LakePlaneError(f"{path}: no polygon")
    level = None
    for f in doc.get("features", []) if doc.get("type") == "FeatureCollection" else []:
        props = f.get("properties") or {}
        if props.get("levelM") is not None:
            level = float(props["levelM"])
    if _is_wgs84(polys):
        from rasterio.warp import transform_geom
        polys = [shape(transform_geom("EPSG:4326", "EPSG:3006", mapping(p))) for p in polys]
    return max(polys, key=lambda p: p.area).buffer(0), level


def read_shore_props(path: Path) -> dict:
    """The shore edit's properties (its cliff settings, for the sand band), {} for a plain GeoJSON."""
    doc = json.loads(Path(path).read_text(encoding="utf-8"))
    for f in doc.get("features", []) if doc.get("type") == "FeatureCollection" else []:
        props = f.get("properties") or {}
        if props.get("op") == "shore":
            return props
    return {}


def read_hydro_lake(path: Path, near: Polygon) -> Polygon:
    """The fetch-hydro `water` polygon that overlaps `near` (the shore polygon) most."""
    doc = json.loads(Path(path).read_text(encoding="utf-8"))
    polys = [shape(f["geometry"]).buffer(0) for f in doc.get("features", [])
             if (f.get("properties") or {}).get("type") == "water"]
    best, overlap = None, 0.0
    for p in polys:
        a = p.intersection(near).area
        if a > overlap:
            best, overlap = p, a
    if best is None:
        raise LakePlaneError(f"{path}: no water polygon overlaps the shore polygon")
    return best


def read_square(sidecar: Path) -> dict:
    doc = json.loads(Path(sidecar).read_text(encoding="utf-8"))
    sq = doc.get("square3006")
    if not sq:
        raise LakePlaneError(f"{sidecar}: no square3006")
    unity = doc.get("unity") or {}
    pos = unity.get("position") or {}
    return {"square": [float(v) for v in sq], "minM": float(doc["minM"]), "y": float(pos.get("y", 0.0))}


def lake_outline(shore: Polygon, hydro_lake: Polygon | None, known: Polygon, centre: tuple[float, float],
                 radius_m: float) -> Polygon:
    """The lake out to `radius_m`: the shore polygon inside `known` (where it was worked out
    from lidar), Hydrografi's lake outside it."""
    disk = Point(centre).buffer(radius_m, 256)
    parts = [shore.intersection(known)]
    if hydro_lake is not None:
        parts.append(hydro_lake.difference(known))
    return unary_union(parts).intersection(disk).buffer(0)


def cell_mesh(region, origin: tuple[float, float], size: tuple[float, float], cell_m: float,
              frame: tuple[float, float], exclude: tuple[float, float, float, float] | None = None,
              ) -> tuple[np.ndarray, np.ndarray, int]:
    """Square cells of `cell_m` over the box at `origin` (west, south) of `size`, kept where
    they touch `region` and their centre is outside `exclude` (a finer zone's box, on this
    grid's lines, so no two meshes overlap); vertices (x, z) in the Unity frame
    (E - frame[0], N - frame[1]) and clockwise-from-above triangles.
    Returns (vertices[n, 2], triangles[m], cells)."""
    if region.is_empty:
        return np.zeros((0, 2)), np.zeros(0, np.int64), 0
    w0, s0 = origin
    nx, nz = int(math.ceil(size[0] / cell_m)), int(math.ceil(size[1] / cell_m))
    north = s0 + nz * cell_m
    mask = rasterio.features.rasterize(
        [(mapping(region), 1)], out_shape=(nz, nx), transform=from_origin(w0, north, cell_m, cell_m),
        fill=0, all_touched=True, dtype="uint8").astype(bool)
    if exclude is not None:
        ce = w0 + (np.arange(nx) + 0.5) * cell_m
        cn = north - (np.arange(nz) + 0.5) * cell_m
        inside_e = (ce > exclude[0]) & (ce < exclude[2])
        inside_n = (cn > exclude[1]) & (cn < exclude[3])
        mask &= ~(inside_n[:, None] & inside_e[None, :])
    rows, cols = np.nonzero(mask)
    if len(rows) == 0:
        return np.zeros((0, 2)), np.zeros(0, np.int64), 0
    # Cell (r, c) spans E [w0 + c·s, w0 + (c+1)·s], N [north - (r+1)·s, north - r·s]. Corner
    # (i, j) = E w0 + j·s, N north - i·s, i in 0..nz, j in 0..nx.
    corner = np.full((nz + 1, nx + 1), -1, np.int64)
    ii = np.concatenate([rows, rows, rows + 1, rows + 1])
    jj = np.concatenate([cols, cols + 1, cols, cols + 1])
    used = np.zeros((nz + 1, nx + 1), bool)
    used[ii, jj] = True
    ui, uj = np.nonzero(used)
    corner[ui, uj] = np.arange(len(ui))
    verts = np.stack([w0 + uj * cell_m - frame[0], north - ui * cell_m - frame[1]], axis=1)
    nw, ne = corner[rows, cols], corner[rows, cols + 1]
    sw, se = corner[rows + 1, cols], corner[rows + 1, cols + 1]
    # In (x east, z north): sw -> nw -> se and nw -> ne -> se are clockwise seen from above.
    tris = np.stack([sw, nw, se, nw, ne, se], axis=1).reshape(-1)
    return verts, tris, len(rows)


def _mesh_doc(name: str, role: str, cell_m: float, verts: np.ndarray, tris: np.ndarray) -> dict:
    return {
        "name": name, "role": role, "cellM": cell_m,
        "vertices": [round(float(v), 3) for v in verts.reshape(-1)],
        "triangles": [int(t) for t in tris],
    }


def probe_spot(water: Polygon, inner_box: Polygon, frame: tuple[float, float], surface_y: float) -> dict:
    """Over open water inside the inner square, as far from every shore as it gets."""
    inner_water = water.intersection(inner_box)
    target = inner_water
    for erode in (60.0, 30.0, 10.0, 0.0):
        candidate = inner_water.buffer(-erode) if erode else inner_water
        if not candidate.is_empty:
            target = candidate
            break
    p = target.representative_point()
    return {"x": round(p.x - frame[0], 2), "y": round(surface_y + PROBE_ABOVE_M, 2), "z": round(p.y - frame[1], 2)}


def shore_distance_grid(water, near_box: Polygon, frame: tuple[float, float], cell_m: float = SHORE_GRID_CELL_M,
                        step_m: float = SHORE_GRID_STEP_M, dem_path: Path | None = None, level_m: float | None = None,
                        cliff: dict | None = None) -> dict | None:
    """Distance from the shore (m) over the lake's near part, for golfmap.lake.bed's band of light
    bed: 0 on land (islands and skerries too), growing out over the water; the grid's own edges
    are open water, not shore. Cells of `cell_m` (row 0 at the south, as Unity's z grows), uint8
    in `step_m` steps, base64."""
    from scipy.ndimage import distance_transform_edt
    near_water = water.intersection(near_box)
    if near_water.is_empty:
        return None
    w0, s0, e1, n1 = near_water.bounds
    w0, s0 = math.floor(w0 / cell_m) * cell_m - cell_m, math.floor(s0 / cell_m) * cell_m - cell_m
    nx, nz = int(math.ceil((e1 - w0) / cell_m)) + 1, int(math.ceil((n1 - s0) / cell_m)) + 1
    north = s0 + nz * cell_m
    wet = rasterio.features.rasterize(
        [(mapping(water), 1)], out_shape=(nz, nx), transform=from_origin(w0, north, cell_m, cell_m),
        fill=0, dtype="uint8").astype(bool)
    d = distance_transform_edt(wet) * cell_m
    q = np.clip(np.round(d / step_m), 0, 255).astype(np.uint8)[::-1]   # south row first
    out = {
        "x0": round(w0 - frame[0], 3), "z0": round(s0 - frame[1], 3), "cellM": cell_m, "stepM": step_m,
        "width": nx, "height": nz, "data": base64.b64encode(q.tobytes()).decode("ascii"),
    }
    if dem_path is not None and level_m is not None:
        # How much of a cliff each water cell's shore is (the shore dig's own measure, dem_edit.shore_cliffness):
        # golfmap.lake.bed keeps the sand off the foot of the cliffs, where the rock goes on down.
        from rasterio.enums import Resampling
        from rasterio.windows import from_bounds
        from golfpipe.dem_edit import shore_cliffness
        with rasterio.open(dem_path) as r:
            z = r.read(1, window=from_bounds(w0, s0, w0 + nx * cell_m, north, r.transform), out_shape=(nz, nx),
                       boundless=True, fill_value=np.nan, resampling=Resampling.average).astype(np.float64)
        k = dict(cliff or {})
        c = shore_cliffness(wet, np.where(wet, np.nan, z), level_m, cell_m, k.get("runM", 4.0), k.get("riseLowM", 1.5),
                            k.get("riseHighM", 3.5), k.get("smoothM", 6.0))
        out["cliff"] = base64.b64encode(np.round(c * 255).astype(np.uint8)[::-1].tobytes()).decode("ascii")
    return out


def low_ground(dem_path: Path, level_m: float, water, sink_m: float = 0.0, skip_box: Polygon | None = None,
               tolerance_m: float = 0.02):
    """Ground that Unity draws under the water surface and that touches the lake: the plane must
    cover it too, or it shows as a dry hole beside the water. Heights are the DEM's less `sink_m`
    (the outer terrain is placed that far under its sidecar position so it never pokes through
    the inner); `skip_box` is a square another terrain draws (the inner over the outer)."""
    from rasterio.features import shapes
    from scipy import ndimage
    with rasterio.open(dem_path) as r:
        z = r.read(1).astype(np.float64) - sink_m
        transform, res = r.transform, abs(r.transform.a)
    low = z < level_m + tolerance_m
    if skip_box is not None:
        low &= ~rasterio.features.rasterize([(mapping(skip_box), 1)], out_shape=z.shape, transform=transform,
                                            fill=0, dtype="uint8").astype(bool)
    wet = rasterio.features.rasterize([(mapping(water), 1)], out_shape=z.shape, transform=transform,
                                      fill=0, all_touched=True, dtype="uint8").astype(bool)
    lab, _ = ndimage.label(low | wet)
    keep = np.unique(lab[wet])
    region = np.isin(lab, keep[keep > 0]) & low & ~wet
    if not region.any():
        return None
    polys = [shape(g) for g, v in shapes(region.astype(np.uint8), mask=region, transform=transform) if v == 1]
    return unary_union(polys).simplify(res / 2).buffer(0)


def build_lake_plane(shore: Polygon, hydro_lake: Polygon | None, inner: dict, outer: dict | None, level_m: float,
                     name: str = "Lake", radius_m: float = DEFAULT_RADIUS_M, under_bank_m: float = DEFAULT_UNDER_BANK_M,
                     near_margin_m: float = DEFAULT_NEAR_MARGIN_M, near_cell_m: float = DEFAULT_NEAR_CELL_M,
                     outer_cell_m: float = DEFAULT_OUTER_CELL_M, far_cell_m: float = DEFAULT_FAR_CELL_M,
                     collider_cell_m: float = DEFAULT_COLLIDER_CELL_M, low=None, inner_dem: Path | None = None,
                     cliff: dict | None = None, log=print) -> dict:
    iw, isth, ie, inn = inner["square"]
    frame = (iw, isth)
    centre = ((iw + ie) / 2, (isth + inn) / 2)
    inner_box = box(iw, isth, ie, inn)
    known = box(*outer["square"]) if outer else inner_box
    water = lake_outline(shore, hydro_lake, known, centre, radius_m)
    if water.is_empty:
        raise LakePlaneError("the lake does not reach within radiusM of the course")
    covered = water if low is None or low.is_empty else unary_union([water, low])
    under = covered.buffer(under_bank_m, join_style=2).intersection(Point(centre).buffer(radius_m + far_cell_m, 256))
    surface_y = level_m - inner["minM"] + inner["y"]

    # Zone boxes on each other's grid lines: the near box on the outer grid, the outer square on
    # the far grid, so a coarse cell is wholly inside or outside the finer zone (no overlap, no gap).
    def snap_out(b, origin, cell):
        return (origin[0] + math.floor((b[0] - origin[0]) / cell) * cell, origin[1] + math.floor((b[1] - origin[1]) / cell) * cell,
                origin[0] + math.ceil((b[2] - origin[0]) / cell) * cell, origin[1] + math.ceil((b[3] - origin[1]) / cell) * cell)
    ob = tuple(outer["square"]) if outer else None
    grid0 = (ob[0], ob[1]) if ob else (iw, isth)
    coarse = math.lcm(int(round(outer_cell_m)), int(round(near_cell_m))) if outer else near_cell_m
    nb = snap_out(inner_box.buffer(near_margin_m, join_style=2).bounds, grid0, coarse)
    near_box = box(*nb)
    r = radius_m + far_cell_m
    fb = snap_out((centre[0] - r, centre[1] - r, centre[0] + r, centre[1] + r), grid0, far_cell_m)
    zones = [("near", nb, near_cell_m, None)]
    if ob:
        zones.append(("outer", ob, outer_cell_m, nb))
    zones.append(("far", fb, far_cell_m, ob or nb))

    meshes, report = [], []
    for role, bounds, cell, exclude in zones:
        region = under.intersection(box(*bounds))
        w0, s0 = bounds[0], bounds[1]
        verts, tris, cells = cell_mesh(region, (w0, s0), (bounds[2] - w0, bounds[3] - s0), cell, frame, exclude)
        if cells == 0:
            report.append(f"{role}: no water")
            continue
        suffix = "" if role == "near" else "_" + role.capitalize()
        meshes.append(_mesh_doc(f"{name}_WaterPlane{suffix}", role, cell, verts, tris))
        report.append(f"{role}: {cells} cells of {cell:g} m, {len(verts)} vertices")

    collider_region = water.intersection(near_box)
    cv, ct, cc = cell_mesh(collider_region, (nb[0], nb[1]), (nb[2] - nb[0], nb[3] - nb[1]), collider_cell_m, frame)
    report.append(f"collider: {cc} cells of {collider_cell_m:g} m over the near part")
    for line in report:
        log("  " + line)
    return {
        "format": FORMAT,
        "name": name,
        "levelM": round(level_m, 3),
        "surfaceY": round(surface_y, 3),
        "frame": {"west3006": iw, "south3006": isth, "minM": inner["minM"], "unityY": inner["y"]},
        "radiusM": radius_m,
        "areaKm2": round(water.area / 1e6, 3),
        "meshes": meshes,
        "collider": _mesh_doc(f"{name}_WaterPlane_Collider", "collider", collider_cell_m, cv, ct) if cc else None,
        "probe": probe_spot(water, inner_box, frame, surface_y),
        "shoreDistance": shore_distance_grid(water, near_box, frame, dem_path=inner_dem, level_m=level_m, cliff=cliff),
    }
