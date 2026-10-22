"""How deep a creek's bed comes out in the course meshes, worked out from the DEM before anything is baked.

A creek dug 0.35 m into the 0.5 m DEM (the ``dig`` edit with ``reference: stream``, dem_edit.py) reaches
GSPro through three resamplings, and each one fills a narrow channel in a little more:

1. The inner heightmap (``gspro.py dem``): the DEM bilinear at the ``.raw``'s pixel centres (4097 a side).
2. ``terrain.obj`` (blender/tools/terrain_obj.py): every second ``.raw`` sample, about 1 m between nodes,
   which OPCD's Import Terrain OBJ smooths once (Terrain Smooth 1.5: each node a quarter itself and three
   quarters the mean of its six neighbours along the OBJ's edges; terrain_obj.smooth_grid).
3. The OPCD course meshes conformed onto that surface: each vertex takes its height, and a mesh is flat
   between vertices about 1.2 m apart.

So a channel one or two terrain nodes wide comes out at half its depth or less (Vreta 2026-10-22: a 0.35 m
dig 0.1-0.3 m shallower in the meshes, 85 R.A.M. gaps; Omberg hole 17's 0.7 m brook about 0.2 m deep).
``terrain_surface`` and ``MeshSurface`` model the three steps; ``creek_sections`` measures every station
across a creek on any surface: the bed (the lowest ground across the water) and each bank (the highest
ground within ``BANK_BAND_M`` outside it), depth = the lower bank over the bed. Unity puts the R.A.M. water
``WATER_ABOVE_BED_M`` over the bed (GolfMapCreeks ``aboveBedM``) and CloseGaps needs the banks to stand over
it, so a station is shallow when its depth in the meshes is under ``min_depth_m`` (the water plus
``MIN_FREEBOARD_M``). ``shallow_stretches`` joins those stations into the stretches a report names, and
``mouth_block`` measures a bank left across the mouth where a creek runs on into a pond.

Pure numpy (scipy for the bilinear sample); ``gspro.py creek-depth`` reads the course and runs it.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

__all__ = [
    "BANK_BAND_M", "DEFAULT_MESH_EDGE_M", "DEFAULT_OBJ_STEP", "DEFAULT_TERRAIN_SMOOTH", "MESH_PHASES",
    "MIN_FREEBOARD_M", "MIN_STRETCH_M", "MOUTH_BLOCK_M", "STATION_M", "WATER_ABOVE_BED_M",
    "HeightmapFrame", "MeshSurface", "Sections", "TerrainSurface",
    "creek_sections", "dem_sample", "mouth_block", "plane_height", "shallow_stretches", "smooth_grid",
    "terrain_surface",
]

# terrain.obj takes every second .raw sample (Unity's Export To OBJ "half"; terrain_obj.SAMPLE_STEP).
DEFAULT_OBJ_STEP = 2
# OPCD's Import Terrain OBJ smooths the heights once by the scene's Terrain Smooth (terrain_obj.smooth_grid).
DEFAULT_TERRAIN_SMOOTH = 1.5
# OPCD's course meshes round a creek: about this far between vertices (the rough's triangles, Omberg / Landeryd /
# Vreta 2026-10).
DEFAULT_MESH_EDGE_M = 1.2
# Where a mesh's vertices fall is not known before the build: the lattice is laid at each of these offsets (as a
# fraction of an edge, east and north) and a station's depth is the median over them.
MESH_PHASES = ((0.0, 0.0), (0.5, 0.0), (0.0, 0.5), (0.5, 0.5))
# GolfMapCreeks puts the R.A.M. water this far over the lowest ground across the creek (its `aboveBedM`; a creek's
# `ramAboveBedM` attribute overrides it) ...
WATER_ABOVE_BED_M = 0.15
# ... and a bank should stand at least this much over that water, or the water reads as lying on the grass.
MIN_FREEBOARD_M = 0.10
# A bank is the highest ground within this far outside the water's edge: CloseGaps widens the water about as far
# to reach it.
BANK_BAND_M = 1.0
# Stations along the creek and the step across it.
STATION_M = 0.5
ACROSS_STEP_M = 0.1
# Shallow stations closer than this along the creek are one stretch; a stretch shorter than MIN_STRETCH_M is a
# bend or a single station, not a finding.
JOIN_GAP_M = 1.5
MIN_STRETCH_M = 2.0
# A bank across a creek's mouth higher than this over its bed holds the creek back from the pond.
MOUTH_BLOCK_M = 0.10


def smooth_grid(g, factor: float = DEFAULT_TERRAIN_SMOOTH) -> np.ndarray:
    """OPCD's Import Terrain OBJ smooth: one pass of Blender's Smooth modifier over the OBJ's grid, each node
    ``(1 - f/2)`` itself and ``f/2`` the mean of its neighbours along the OBJ's edges (east, west, north, south
    and the anti-diagonal ``(iz+1,ix)-(iz,ix+1)``; fewer on the border). The same as
    blender/tools/terrain_obj.smooth_grid (tests/test_creek_depth.py holds them equal); a NaN node spreads to
    its neighbours."""
    g = np.asarray(g, np.float64)
    acc = np.zeros(g.shape, np.float64)
    cnt = np.zeros(g.shape, np.int32)
    for dst, src in (((slice(None), slice(0, -1)), (slice(None), slice(1, None))),       # east
                     ((slice(None), slice(1, None)), (slice(None), slice(0, -1))),       # west
                     ((slice(0, -1), slice(None)), (slice(1, None), slice(None))),       # north
                     ((slice(1, None), slice(None)), (slice(0, -1), slice(None))),       # south
                     ((slice(1, None), slice(0, -1)), (slice(0, -1), slice(1, None))),   # anti-diagonal
                     ((slice(0, -1), slice(1, None)), (slice(1, None), slice(0, -1)))):
        acc[dst] += g[src]
        cnt[dst] += 1
    half = 0.5 * float(factor)
    return (1.0 - half) * g + half * (acc / np.maximum(cnt, 1))


def plane_height(u, v, g, qu, qv):
    """Height on a grid of nodes ``g[iz, ix]`` at eastings ``u`` and northings ``v`` (both ascending) at the
    query points, flat over the OBJ's two triangles a cell (``(iz,ix) (iz+1,ix) (iz,ix+1)`` and
    ``(iz,ix+1) (iz+1,ix) (iz+1,ix+1)``), and whether each point is on the grid. The same as
    blender/tools/terrain_obj.plane_height."""
    u, v, g = np.asarray(u, np.float64), np.asarray(v, np.float64), np.asarray(g, np.float64)
    qu, qv = np.asarray(qu, np.float64), np.asarray(qv, np.float64)
    inside = (qu >= u[0]) & (qu <= u[-1]) & (qv >= v[0]) & (qv <= v[-1])
    ix = np.clip(np.searchsorted(u, qu, side="right") - 1, 0, u.size - 2)
    iz = np.clip(np.searchsorted(v, qv, side="right") - 1, 0, v.size - 2)
    fx = (qu - u[ix]) / (u[ix + 1] - u[ix])
    fz = (qv - v[iz]) / (v[iz + 1] - v[iz])
    h00, h01 = g[iz, ix], g[iz, ix + 1]
    h10, h11 = g[iz + 1, ix], g[iz + 1, ix + 1]
    return np.where(fx + fz <= 1.0,
                    h00 + fx * (h01 - h00) + fz * (h10 - h00),
                    h11 + (1.0 - fx) * (h10 - h11) + (1.0 - fz) * (h01 - h11)), inside


def dem_sample(dem, transform, x, y, valid=None) -> np.ndarray:
    """The DEM bilinear at EPSG:3006 points (any shape), NaN off it or next to a nodata cell."""
    from scipy.ndimage import map_coordinates

    grid = np.asarray(dem, np.float64)
    if valid is not None:
        grid = np.where(valid, grid, np.nan)
    x, y = np.broadcast_arrays(np.asarray(x, np.float64), np.asarray(y, np.float64))
    col = (x - transform.c) / transform.a - 0.5
    row = (y - transform.f) / transform.e - 0.5
    rows, cols = grid.shape
    off = (col < -0.5) | (col > cols - 0.5) | (row < -0.5) | (row > rows - 0.5)
    out = map_coordinates(grid, [row.ravel(), col.ravel()], order=1, mode="nearest").reshape(x.shape)
    return np.where(off, np.nan, out)


@dataclass(frozen=True)
class HeightmapFrame:
    """The inner heightmap's grid in EPSG:3006, from its sidecar: ``res`` samples a side over the square
    ``[e0, n0, e0 + side, n0 + side]``, the ``.raw``'s pixel (row r from the north, column c) taken from the
    DEM at its pixel centre (``gspro.py dem``'s reprojection), and terrain.obj's node (ix east, iz north) =
    that sample at row ``res - 1 - step*iz``, column ``step*ix``, placed at ``(e0 + ix*spacing, n0 + iz*spacing)``
    (terrain_obj.height_grid / obj_chunks)."""

    e0: float
    n0: float
    side: float
    res: int
    step: int = DEFAULT_OBJ_STEP

    @property
    def grid(self) -> int:
        return (self.res - 1) // self.step + 1

    @property
    def spacing(self) -> float:
        return self.side / (self.grid - 1)

    @classmethod
    def from_sidecar(cls, sidecar: dict, step: int = DEFAULT_OBJ_STEP) -> "HeightmapFrame":
        e0, n0, e1, _ = (float(v) for v in sidecar["square3006"])
        res = int((sidecar.get("raw") or {}).get("size") or (sidecar.get("unity") or {}).get("heightmapResolution") or 0)
        if res < 3 or (res - 1) % step:
            raise ValueError(f"the sidecar's heightmap ({res} a side) has no terrain.obj grid at step {step}")
        return cls(e0=e0, n0=n0, side=e1 - e0, res=res, step=step)


@dataclass(frozen=True)
class TerrainSurface:
    """terrain.obj as OPCD has it after the import's smooth, over a window of its nodes: ``g[iz, ix]`` (metres,
    NaN off the DEM) at eastings ``u`` and northings ``v``."""

    u: np.ndarray
    v: np.ndarray
    g: np.ndarray

    def at(self, x, y) -> np.ndarray:
        h, inside = plane_height(self.u, self.v, self.g, x, y)
        return np.where(inside, h, np.nan)


def terrain_surface(dem, transform, frame: HeightmapFrame, bounds, valid=None,
                    smooth: float = DEFAULT_TERRAIN_SMOOTH, margin_nodes: int = 3) -> TerrainSurface:
    """The smoothed terrain.obj over the nodes covering ``bounds`` (EPSG:3006 x0, y0, x1, y1) plus
    ``margin_nodes`` (the smooth reads one node out; the margin keeps the window's own border away)."""
    x0, y0, x1, y1 = bounds
    sp = frame.spacing
    last = frame.grid - 1
    ix = np.arange(max(int(np.floor((x0 - frame.e0) / sp)) - margin_nodes, 0),
                   min(int(np.ceil((x1 - frame.e0) / sp)) + margin_nodes, last) + 1)
    iz = np.arange(max(int(np.floor((y0 - frame.n0) / sp)) - margin_nodes, 0),
                   min(int(np.ceil((y1 - frame.n0) / sp)) + margin_nodes, last) + 1)
    if ix.size < 2 or iz.size < 2:
        raise ValueError("the bounds are off the heightmap's square")
    pix = frame.side / frame.res
    sx = frame.e0 + (frame.step * ix + 0.5) * pix
    sy = frame.n0 + frame.side - ((frame.res - 1 - frame.step * iz) + 0.5) * pix
    g = dem_sample(dem, transform, sx[None, :], sy[:, None], valid)
    return TerrainSurface(u=frame.e0 + ix * sp, v=frame.n0 + iz * sp, g=smooth_grid(g, smooth))


@dataclass(frozen=True)
class MeshSurface:
    """The course meshes conformed onto ``terrain``: vertices ``edge`` apart on a square lattice laid at each of
    ``phases``, every vertex at the terrain's height, flat between them over the same two triangles a cell.
    ``at`` returns one row of heights per phase."""

    terrain: TerrainSurface
    edge: float = DEFAULT_MESH_EDGE_M
    phases: tuple = MESH_PHASES

    def at(self, x, y) -> np.ndarray:
        x, y = np.broadcast_arrays(np.asarray(x, np.float64), np.asarray(y, np.float64))
        e = float(self.edge)
        rows = []
        for px, py in self.phases:
            ox, oy = px * e, py * e
            gx, gy = (x - ox) / e, (y - oy) / e
            i, j = np.floor(gx), np.floor(gy)
            fx, fz = gx - i, gy - j
            x00, y00 = ox + i * e, oy + j * e
            h00 = self.terrain.at(x00, y00)
            h01 = self.terrain.at(x00 + e, y00)
            h10 = self.terrain.at(x00, y00 + e)
            h11 = self.terrain.at(x00 + e, y00 + e)
            rows.append(np.where(fx + fz <= 1.0,
                                 h00 + fx * (h01 - h00) + fz * (h10 - h00),
                                 h11 + (1.0 - fx) * (h10 - h11) + (1.0 - fz) * (h01 - h11)))
        return np.stack(rows)


@dataclass
class Sections:
    """A creek measured at each station ``s`` (metres along its line, at ``x``, ``y``): ``depth`` = the lower bank
    over the bed. ``depth`` is NaN where the surface has no ground across the section. For a surface with
    phases (``MeshSurface``) ``depth`` is their median and ``worst`` their minimum."""

    s: np.ndarray
    x: np.ndarray
    y: np.ndarray
    bed: np.ndarray
    depth: np.ndarray
    worst: np.ndarray = field(default=None)


def _stations(line, station_m: float):
    line = np.asarray(line, np.float64)
    seg = np.hypot(*np.diff(line, axis=0).T)
    cum = np.concatenate([[0.0], np.cumsum(seg)])
    total = float(cum[-1])
    n = max(int(np.ceil(total / station_m)) + 1, 2)
    s = np.linspace(0.0, total, n)
    x, y = np.interp(s, cum, line[:, 0]), np.interp(s, cum, line[:, 1])
    dx, dy = np.gradient(x), np.gradient(y)
    norm = np.hypot(dx, dy)
    norm[norm == 0] = 1.0
    return s, x, y, -dy / norm, dx / norm


def creek_sections(line, width_m, surface_at, station_m: float = STATION_M,
                   band_m: float = BANK_BAND_M) -> Sections:
    """``surface_at(x, y)`` measured across ``line`` ([[x, y], ...], EPSG:3006) every ``station_m``: the bed is
    the lowest ground within half the width of the line, each bank the highest ground from there out to
    ``band_m`` beyond. ``width_m`` is one width, or ``width_m(x, y)`` the width at each station (a polygon
    creek's own: a run of ponds is wide at a pond and narrow at a sill). ``surface_at`` returns heights the
    shape of its query, or with one more leading axis (a row per mesh phase, MeshSurface.at)."""
    s, x, y, nx, ny = _stations(line, station_m)
    widths = np.asarray(width_m(x, y) if callable(width_m) else np.full(s.size, float(width_m)), np.float64)
    half = np.maximum(widths / 2.0, ACROSS_STEP_M)
    across = np.linspace(-1.0, 1.0, max(int(np.ceil(2.0 * float(half.max()) / ACROSS_STEP_M)) + 1, 3))[None, :] * half[:, None]
    out = half[:, None] + np.linspace(0.0, band_m, max(int(round(band_m / ACROSS_STEP_M)) + 1, 2))[None, :]

    def heights(offsets):
        px = x[:, None] + nx[:, None] * offsets
        py = y[:, None] + ny[:, None] * offsets
        h = np.asarray(surface_at(px, py), np.float64)
        return h if h.ndim == 3 else h[None]

    with np.errstate(invalid="ignore"), _quiet_nan():
        bed = np.nanmin(heights(across), axis=2)
        left = np.nanmax(heights(out), axis=2)
        right = np.nanmax(heights(-out), axis=2)
        depth = np.minimum(left, right) - bed
        return Sections(s=s, x=x, y=y, bed=np.nanmedian(bed, axis=0), depth=np.nanmedian(depth, axis=0),
                        worst=np.nanmin(depth, axis=0))


class _quiet_nan:
    """All-NaN slices (a station off the DEM) are expected: NaN out, no RuntimeWarning."""

    def __enter__(self):
        import warnings

        self._w = warnings.catch_warnings()
        self._w.__enter__()
        warnings.simplefilter("ignore", category=RuntimeWarning)

    def __exit__(self, *exc):
        return self._w.__exit__(*exc)


def shallow_stretches(s, depth, min_depth_m: float, skip=None, join_gap_m: float = JOIN_GAP_M,
                      min_length_m: float = MIN_STRETCH_M) -> list[tuple[int, int]]:
    """The stretches where ``depth`` is under ``min_depth_m`` (a NaN depth counts as shallow: no ground to hold
    the water), as (first, last) station indices: neighbours closer than ``join_gap_m`` joined, stretches shorter
    than ``min_length_m`` dropped. ``skip`` (bool per station) leaves stations out: a sill left undug on purpose,
    the part of a creek inside a pond."""
    s = np.asarray(s, np.float64)
    depth = np.asarray(depth, np.float64)
    low = ~(depth >= min_depth_m)
    if skip is not None:
        low &= ~np.asarray(skip, bool)
    idx = np.flatnonzero(low)
    if idx.size == 0:
        return []
    runs = [[int(idx[0]), int(idx[0])]]
    for i in idx[1:]:
        if s[i] - s[runs[-1][1]] <= join_gap_m:
            runs[-1][1] = int(i)
        else:
            runs.append([int(i), int(i)])
    step = float(s[1] - s[0]) if s.size > 1 else 0.0
    return [(a, b) for a, b in runs if s[b] - s[a] + step >= min_length_m]


def mouth_block(end, toward, bed_m, surface_at, reach_m: float, step_m: float = 0.25) -> float:
    """How far the ground stands over a creek's bed where the creek meets a pond: the highest the ground along the
    line from ``end`` ([x, y], a station of the creek near the pond) toward ``toward`` (on the pond's shore) for
    ``reach_m`` rises over the bed, ``bed_m`` (one height, or ``bed_m(t)`` at ``t`` metres along: the creek's bed
    carried on along its own slope, so a steep creek climbing to a pond is no bank). Over MOUTH_BLOCK_M = a bank
    across the mouth. A surface with phases gives their median."""
    end = np.asarray(end, np.float64)
    d = np.asarray(toward, np.float64) - end
    n = float(np.hypot(*d))
    if n == 0 or reach_m <= 0:
        return 0.0
    t = np.arange(step_m, reach_m + 1e-9, step_m)
    px, py = end[0] + d[0] / n * t, end[1] + d[1] / n * t
    h = np.asarray(surface_at(px, py), np.float64)
    if h.ndim == 1:
        h = h[None]
    bed = np.asarray(bed_m(t), np.float64) if callable(bed_m) else np.full(t.size, float(bed_m))
    with _quiet_nan():
        top = np.nanmedian(np.nanmax(h - bed[None, :], axis=1))
    return float(top) if np.isfinite(top) else 0.0
