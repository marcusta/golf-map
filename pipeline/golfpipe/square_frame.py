"""The fixed square frame of a site's cleaned-photo export (D-OX1 in
docs/feature-ortho-export-import.md).

One site has ONE frame: a square EPSG:3006 extent and a pixel size, stored in

    data/sources/<siteId>/sim-frame.json
        { "extent3006": [e0, n0, e1, n1], "size": 8192 }

Every `export-ortho-square`, every `import-ortho-square` and the Unity texture
use it, so an exported image always covers the same ground with the same
pixels: an edit made in an old export still lands where it was painted, and a
new texture drops into Unity without re-aligning. The frame is therefore
created once and never changed here — a different area or size is refused
(delete the file by hand to start over, which orphans the old exports).

The square is the WGS84 bbox squared the way `gspro.py ortho` squares its
extent (`_square_3006_extent`): reprojected to EPSG:3006, side rounded up to
the next 10 m, centred on the bbox. gspro.py imports golfpipe, so the rule
lives here a second time; tests/test_square_frame.py pins the two together.

The frame grid is north-up: pixel (0, 0) is the north-west corner.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from pathlib import Path

from rasterio.crs import CRS
from rasterio.transform import Affine, from_bounds
from rasterio.warp import transform_bounds

from .patches import PatchError

WGS84 = CRS.from_epsg(4326)
SWEREF99_TM = CRS.from_epsg(3006)

FRAME_NAME = "sim-frame.json"
DEFAULT_SIZE = 8192
# Frame sides are whole multiples of this (metres) — gspro.py's SIDE_STEP_M.
SIDE_STEP_M = 10.0
# Two extents closer than this (metres) are the same frame.
EXTENT_TOLERANCE_M = 1e-6

Extent = tuple[float, float, float, float]


@dataclass(frozen=True)
class SquareFrame:
    extent3006: Extent
    """(e0, n0, e1, n1) in EPSG:3006 metres; a true square."""
    size: int
    """Pixels per side."""

    @property
    def side_m(self) -> float:
        return self.extent3006[2] - self.extent3006[0]

    @property
    def res_m(self) -> float:
        """Ground metres per pixel."""
        return self.side_m / self.size

    @property
    def transform(self) -> Affine:
        return from_bounds(*self.extent3006, self.size, self.size)

    def pixel_bounds3006(self, r0: int, r1: int, c0: int, c1: int) -> Extent:
        """EPSG:3006 bounds (west, south, east, north) of the pixel window
        rows [r0, r1) x cols [c0, c1) — exact pixel edges, row 0 = north."""
        e0, _n0, _e1, n1 = self.extent3006
        res = self.res_m
        return (e0 + c0 * res, n1 - r1 * res, e0 + c1 * res, n1 - r0 * res)

    def to_json(self) -> dict:
        return {"extent3006": list(self.extent3006), "size": self.size}


def square_extent_3006(bbox_wgs84: Extent) -> Extent:
    """The WGS84 bbox (west, south, east, north) reprojected to EPSG:3006 and
    expanded to a true square whose side is the next whole multiple of
    SIDE_STEP_M, centred where the bbox is centred."""
    e0, n0, e1, n1 = transform_bounds(WGS84, SWEREF99_TM, *bbox_wgs84)
    cx, cy = (e0 + e1) / 2.0, (n0 + n1) / 2.0
    side = math.ceil(max(e1 - e0, n1 - n0) / SIDE_STEP_M - 1e-9) * SIDE_STEP_M
    return (cx - side / 2, cy - side / 2, cx + side / 2, cy + side / 2)


def _parse_frame(doc: object, source: str) -> SquareFrame:
    if not isinstance(doc, dict):
        raise PatchError(f"{source} is not a frame (expected {{\"extent3006\": […], \"size\": n}})")
    try:
        e0, n0, e1, n1 = (float(v) for v in doc["extent3006"])
        size = doc["size"]
    except (KeyError, TypeError, ValueError) as exc:
        raise PatchError(f"{source}: needs `extent3006` [e0, n0, e1, n1] and an integer `size`") from exc
    if not isinstance(size, int) or isinstance(size, bool) or size <= 0:
        raise PatchError(f"{source}: size must be a positive integer, got {size!r}")
    if not all(math.isfinite(v) for v in (e0, n0, e1, n1)) or e1 <= e0 or n1 <= n0:
        raise PatchError(f"{source}: degenerate extent3006 ({e0}, {n0}, {e1}, {n1})")
    if abs((e1 - e0) - (n1 - n0)) > EXTENT_TOLERANCE_M:
        raise PatchError(f"{source}: extent3006 is not square ({e1 - e0:.3f} × {n1 - n0:.3f} m)")
    return SquareFrame((e0, n0, e1, n1), size)


def load_frame(path: Path) -> SquareFrame:
    """Reads and validates a `sim-frame.json`."""
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise PatchError(f"cannot read frame {path}: {exc}") from exc
    return _parse_frame(doc, str(path))


def frame_from_json(doc: object, source: str) -> SquareFrame:
    """A frame from an already-parsed object carrying `extent3006` and `size`
    (an `export.json` does)."""
    return _parse_frame(doc, source)


def ensure_frame(
    path: Path,
    bounds_wgs84: Extent | None = None,
    size: int | None = None,
) -> tuple[SquareFrame, bool]:
    """The site's frame, created on first use. Returns (frame, created).

    Missing file: `bounds_wgs84` is required and is squared into the frame
    (`size` defaults to DEFAULT_SIZE); the file is written. Existing file: it
    is the frame — `bounds_wgs84` and `size` are only checked against it, and
    a different square or size is refused rather than applied.
    """
    if path.is_file():
        frame = load_frame(path)
        if size is not None and size != frame.size:
            raise PatchError(
                f"refusing to change the frame {path}: it is {frame.size} px, not {size} px "
                "(every export and import of the site shares one frame)"
            )
        if bounds_wgs84 is not None:
            wanted = square_extent_3006(bounds_wgs84)
            if any(abs(a - b) > EXTENT_TOLERANCE_M for a, b in zip(wanted, frame.extent3006)):
                raise PatchError(
                    f"refusing to change the frame {path}: it covers "
                    f"{', '.join(f'{v:.3f}' for v in frame.extent3006)} and the given bounds square to "
                    f"{', '.join(f'{v:.3f}' for v in wanted)} (every export and import of the site shares one frame)"
                )
        return frame, False

    if bounds_wgs84 is None:
        raise PatchError(f"no frame at {path} yet — pass --bounds-wgs84 west,south,east,north to create it")
    west, south, east, north = bounds_wgs84
    if not all(math.isfinite(v) for v in bounds_wgs84) or west >= east or south >= north:
        raise PatchError(f"degenerate --bounds-wgs84 ({west}, {south}, {east}, {north})")
    size = DEFAULT_SIZE if size is None else size
    if size <= 0:
        raise PatchError(f"frame size must be a positive integer, got {size}")
    frame = SquareFrame(square_extent_3006(bounds_wgs84), size)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(frame.to_json(), indent=2) + "\n", encoding="utf-8")
    return frame, True


def world_file_text(frame: SquareFrame) -> str:
    """ESRI world file (`.pgw` / `.jgw`) for an image on the frame grid: x
    pixel size, two rotation terms, negative y pixel size, then the CENTRE of
    the north-west pixel — EPSG:3006 metres."""
    res = frame.res_m
    e0, _n0, _e1, n1 = frame.extent3006
    values = (res, 0.0, 0.0, -res, e0 + res / 2.0, n1 - res / 2.0)
    return "".join(f"{v!r}\n" for v in values)
