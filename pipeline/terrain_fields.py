"""Terrain fields that say what the ground is like for plants, from a DEM.

  slope   degrees.
  tpi     terrain position: metres above (+, knoll, ridge) or below (-, hollow) the mean of
          the ground within TPI_RADIUS_M. On Vreta 84 % of the hand-drawn rock slabs sit
          above +0.3 m, against 34 % of the deep rough.
  twi     topographic wetness index, ln(catchment per metre of contour / tan slope): high
          where water gathers and stays (flat hollows, valley floors), low on ridges and
          steep ground. Vreta's deep rough: 4.3 (p5) .. 6.9 (median) .. 11 (p95).

Computed on WORK_CELL_M cells (a 0.5 m lidar grid is noise at the scale plants answer to) and
resampled back to the DEM's own grid. The wetness needs every cell to drain: closed
depressions are filled first (priority flood), then each cell's catchment is passed downhill
to all lower neighbours by slope (multiple flow direction). Both walk the grid cell by cell
in Python: about 5 s for a 2 km square at 2 m.

Used by woodland_floor_zones.py. tests/test_terrain_fields.py.
"""

from __future__ import annotations

import heapq
from dataclasses import dataclass

import numpy as np

WORK_CELL_M = 2.0
TPI_RADIUS_M = 50.0
TWI_SMOOTH_M = 3.0          # a wet strip, not a one-cell thread down the flow line
MIN_SLOPE_DEG = 0.5         # dead flat ground would give infinite wetness
FILL_EPSILON_M = 1e-4       # filled flats keep a fall towards their outlet
FLOW_EXPONENT = 1.1         # Freeman's multiple flow direction

_NEIGHBOURS = ((-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1))
_DISTANCES = (2 ** 0.5, 1.0, 2 ** 0.5, 1.0, 1.0, 2 ** 0.5, 1.0, 2 ** 0.5)


@dataclass
class Fields:
    slope: np.ndarray
    tpi: np.ndarray
    twi: np.ndarray


def fill_depressions(z: np.ndarray) -> np.ndarray:
    """`z` with every closed depression filled to its spill level (plus a hair of fall
    towards the outlet), so every cell has a way down to the grid's edge."""
    rows, cols = z.shape
    done = [[False] * cols for _ in range(rows)]
    filled = z.astype(np.float64).tolist()
    heap = []
    for r in range(rows):
        for c in ((0, cols - 1) if 0 < r < rows - 1 else range(cols)):
            if not done[r][c]:
                done[r][c] = True
                heap.append((filled[r][c], r, c))
    heapq.heapify(heap)
    while heap:
        h, r, c = heapq.heappop(heap)
        for dr, dc in _NEIGHBOURS:
            a, b = r + dr, c + dc
            if 0 <= a < rows and 0 <= b < cols and not done[a][b]:
                done[a][b] = True
                v = filled[a][b]
                if v <= h:
                    v = filled[a][b] = h + FILL_EPSILON_M
                heapq.heappush(heap, (v, a, b))
    return np.array(filled)


def flow_accumulation(filled: np.ndarray) -> np.ndarray:
    """Cells draining through each cell (itself included) on a depression-free surface."""
    rows, cols = filled.shape
    padded = np.pad(filled, 1, constant_values=np.inf)   # nothing flows off the grid
    drops = np.stack([(filled - padded[1 + dr:1 + dr + rows, 1 + dc:1 + dc + cols]) / d
                      for (dr, dc), d in zip(_NEIGHBOURS, _DISTANCES)], axis=-1)
    share = np.clip(drops, 0.0, None) ** FLOW_EXPONENT
    total = share.sum(axis=-1, keepdims=True)
    share = np.where(total > 0, share / np.maximum(total, 1e-30), 0.0).reshape(rows * cols, 8).tolist()
    offsets = [dr * cols + dc for dr, dc in _NEIGHBOURS]
    acc = [1.0] * (rows * cols)
    for cell in np.argsort(filled, axis=None)[::-1].tolist():   # highest first
        a = acc[cell]
        s = share[cell]
        for k in range(8):
            if s[k] > 0.0:
                acc[cell + offsets[k]] += a * s[k]
    return np.array(acc).reshape(rows, cols)


def _disc_mean(a: np.ndarray, radius_cells: float) -> np.ndarray:
    from scipy.ndimage import convolve
    r = max(1, int(round(radius_cells)))
    yy, xx = np.ogrid[-r:r + 1, -r:r + 1]
    disc = (yy * yy + xx * xx <= r * r).astype(np.float64)
    return convolve(a, disc / disc.sum(), mode="nearest")


def terrain_fields(z: np.ndarray, cell: float, work_cell: float = WORK_CELL_M,
                   tpi_radius: float = TPI_RADIUS_M) -> Fields:
    """Slope, terrain position and wetness for a DEM (`cell` metres, rows north to south), on
    the DEM's own grid."""
    from scipy.ndimage import gaussian_filter, zoom

    z = np.asarray(z, dtype=np.float64)
    k = max(1, int(round(work_cell / cell)))
    if k > 1:
        rows, cols = (z.shape[0] // k) * k, (z.shape[1] // k) * k
        coarse = z[:rows, :cols].reshape(rows // k, k, cols // k, k).mean(axis=(1, 3))
    else:
        coarse = z
    wc = cell * k
    gy, gx = np.gradient(gaussian_filter(coarse, 1.0), wc)
    slope = np.degrees(np.arctan(np.hypot(gx, gy)))
    tpi = coarse - _disc_mean(coarse, tpi_radius / wc)
    catchment = flow_accumulation(fill_depressions(coarse)) * wc
    twi = np.log(catchment / np.tan(np.radians(np.maximum(slope, MIN_SLOPE_DEG))))
    twi = gaussian_filter(twi, TWI_SMOOTH_M / wc)

    def back(a: np.ndarray) -> np.ndarray:
        if a.shape == z.shape:
            return a.astype(np.float32)
        return zoom(a, (z.shape[0] / a.shape[0], z.shape[1] / a.shape[1]), order=1, mode="nearest", grid_mode=True).astype(np.float32)

    return Fields(back(slope), back(tpi), back(twi))
