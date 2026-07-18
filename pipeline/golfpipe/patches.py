"""Replayable orthophoto patch log (T55 interactive photo cleaning).

The web editor's "Clean photo" tool inpaints blemishes (players, carts,
shadows, stray objects) out of 512 px ortho-tile crops and, on accept, the
server stores each result as a PATCH: an RGBA PNG (alpha marks the inpainted
pixels) plus a JSON log entry carrying its exact georeferencing. The pristine
source ortho is NEVER modified — mirroring the terrain-edit plan's
edits-as-replayable-log philosophy — so this module can always rebuild the
patched raster from scratch:

    data/sources/<mapKey>/patches/
        patches.json     the ordered log (written by the server, read here)
        1.png, 2.png, …  RGBA patches, alpha 255 = inpainted pixel

`apply-ortho-patches` (commands.cmd_apply_ortho_patches) replays every logged
patch onto the pristine ortho into a working `<stem>.patched.tif` and retiles
only the affected tile-pyramid subtree.

Georeferencing: patches are produced from Web-Mercator XYZ tile crops, so
their native, exact frame is an axis-aligned EPSG:3857 rectangle
(`bounds3857` in the log). Replay reprojects each patch onto the ortho's own
grid (EPSG:3006) with bilinear resampling and alpha-composites it — storing
3006 bounds instead would silently ignore the ~0.5° meridian-convergence
rotation between the two frames and shift patch edges by decimetres.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from pathlib import Path

import mercantile
import numpy as np
import rasterio
from rasterio.crs import CRS
from rasterio.enums import Resampling
from rasterio.transform import Affine, from_bounds
from rasterio.warp import reproject, transform_bounds

WEB_MERCATOR = CRS.from_epsg(3857)
WGS84 = CRS.from_epsg(4326)

PATCH_LOG_NAME = "patches.json"


class PatchError(RuntimeError):
    """User-actionable patch-log / replay error."""


@dataclass(frozen=True)
class PatchEntry:
    seq: int
    file: str
    """PNG file name relative to the patches dir."""
    bounds3857: tuple[float, float, float, float]
    """(west, south, east, north) in EPSG:3857 metres — the patch's frame."""
    tool: str
    created_at: str


def _parse_bounds(raw: object, context: str) -> tuple[float, float, float, float]:
    if not isinstance(raw, dict):
        raise PatchError(f"{context}: bounds3857 must be an object with west/south/east/north")
    try:
        w, s, e, n = (float(raw[k]) for k in ("west", "south", "east", "north"))
    except (KeyError, TypeError, ValueError) as exc:
        raise PatchError(f"{context}: bounds3857 must carry numeric west/south/east/north") from exc
    if not all(math.isfinite(v) for v in (w, s, e, n)) or w >= e or s >= n:
        raise PatchError(f"{context}: degenerate bounds3857 ({w}, {s}, {e}, {n})")
    return (w, s, e, n)


def load_patch_log(patches_dir: Path) -> list[PatchEntry]:
    """Reads and validates `patches.json` from a patches dir, sorted by seq.
    A missing file (course never patched) is an empty log, not an error.
    """
    log_path = patches_dir / PATCH_LOG_NAME
    if not log_path.is_file():
        return []
    try:
        doc = json.loads(log_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise PatchError(f"cannot read patch log {log_path}: {exc}") from exc
    raw_patches = doc.get("patches") if isinstance(doc, dict) else None
    if not isinstance(raw_patches, list):
        raise PatchError(f"{log_path} is not a patch log (expected {{\"patches\": […]}})")

    entries: list[PatchEntry] = []
    for i, raw in enumerate(raw_patches):
        context = f"{log_path} entry {i}"
        if not isinstance(raw, dict):
            raise PatchError(f"{context}: not an object")
        try:
            seq = int(raw["seq"])
            file = str(raw["file"])
        except (KeyError, TypeError, ValueError) as exc:
            raise PatchError(f"{context}: needs integer `seq` and string `file`") from exc
        if "/" in file or file.startswith("."):
            raise PatchError(f"{context}: patch file name {file!r} must be a plain name")
        entries.append(PatchEntry(
            seq=seq,
            file=file,
            bounds3857=_parse_bounds(raw.get("bounds3857"), context),
            tool=str(raw.get("tool", "")),
            created_at=str(raw.get("createdAt", "")),
        ))
    entries.sort(key=lambda e: e.seq)
    return entries


def load_patch_rgba(patches_dir: Path, entry: PatchEntry) -> np.ndarray:
    """Reads a patch PNG as an (H, W, 4) uint8 RGBA array."""
    from PIL import Image

    path = patches_dir / entry.file
    if not path.is_file():
        raise PatchError(f"patch file missing: {path} (log entry seq {entry.seq})")
    with Image.open(path) as img:
        return np.array(img.convert("RGBA"))


def composite_patch(
    image: np.ndarray,
    transform: Affine,
    crs: CRS,
    patch_rgba: np.ndarray,
    bounds3857: tuple[float, float, float, float],
) -> None:
    """Alpha-composites one EPSG:3857-framed RGBA patch onto `image` (an
    (H, W, 3) uint8 array on the `transform`/`crs` grid), in place.

    The patch is reprojected onto the destination grid (bilinear, matching
    the tiler's own resampling); its alpha channel is reprojected the same
    way, so patch edges blend smoothly instead of stair-stepping. Pixels
    where the reprojected alpha is 0 (everything outside the inpainted
    region) are left byte-identical.
    """
    h, w = image.shape[:2]
    ph, pw = patch_rgba.shape[:2]
    west, south, east, north = bounds3857
    src_transform = from_bounds(west, south, east, north, pw, ph)

    # Destination window: the patch bounds in the ortho's CRS, padded a
    # couple of pixels for resampling support, clipped to the raster.
    db = transform_bounds(WEB_MERCATOR, crs, west, south, east, north)
    inv = ~transform
    c0f, r0f = inv * (db[0], db[3])
    c1f, r1f = inv * (db[2], db[1])
    pad = 2
    r0 = max(0, math.floor(min(r0f, r1f)) - pad)
    c0 = max(0, math.floor(min(c0f, c1f)) - pad)
    r1 = min(h, math.ceil(max(r0f, r1f)) + pad)
    c1 = min(w, math.ceil(max(c0f, c1f)) + pad)
    if r1 <= r0 or c1 <= c0:
        return  # patch lies entirely outside the raster

    dst_transform = transform * Affine.translation(c0, r0)
    dh, dw = r1 - r0, c1 - c0
    warped = np.zeros((4, dh, dw), dtype=np.float32)
    for band in range(4):
        reproject(
            source=patch_rgba[:, :, band].astype(np.float32),
            destination=warped[band],
            src_transform=src_transform,
            src_crs=WEB_MERCATOR,
            dst_transform=dst_transform,
            dst_crs=crs,
            resampling=Resampling.bilinear,
        )

    alpha = (warped[3] / 255.0)[..., None]
    region = image[r0:r1, c0:c1].astype(np.float32)
    blended = np.moveaxis(warped[:3], 0, -1) * alpha + region * (1.0 - alpha)
    image[r0:r1, c0:c1] = np.clip(np.rint(blended), 0, 255).astype(np.uint8)


def apply_patches_to_ortho(
    ortho_path: Path,
    patches_dir: Path,
    entries: list[PatchEntry],
    out_path: Path,
) -> None:
    """Replays `entries` (in seq order) onto the pristine ortho at
    `ortho_path`, writing the result to `out_path` with the source profile
    (CRS/transform/dtype/compression) preserved. An empty log writes an
    unmodified copy — replay is always pristine + full log, never
    incremental, so the output is deterministic for a given log.
    """
    if out_path.resolve() == ortho_path.resolve():
        raise PatchError(f"refusing to overwrite the source ortho ({ortho_path}) — pass a different --out")

    with rasterio.open(ortho_path) as src:
        if src.count < 3:
            raise PatchError(f"{ortho_path} has {src.count} band(s); apply-ortho-patches needs an RGB ortho")
        profile = src.profile.copy()
        image = np.moveaxis(src.read([1, 2, 3]), 0, -1)
        transform = src.transform
        crs = src.crs

    for entry in entries:
        patch_rgba = load_patch_rgba(patches_dir, entry)
        composite_patch(image, transform, crs, patch_rgba, entry.bounds3857)

    profile.update(count=3, dtype="uint8")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with rasterio.open(out_path, "w", **profile) as dst:
        dst.write(np.moveaxis(image, -1, 0))


def affected_tiles(
    bounds3857_list: list[tuple[float, float, float, float]],
    minzoom: int,
    maxzoom: int,
) -> list[mercantile.Tile]:
    """The deduplicated XYZ tiles intersecting any of the given EPSG:3857
    bounds, across every zoom in [minzoom, maxzoom] — the tile-pyramid
    subtree a replay must rewrite. Sorted by (z, x, y) for determinism.
    """
    seen: set[mercantile.Tile] = set()
    for bounds in bounds3857_list:
        w, s, e, n = transform_bounds(WEB_MERCATOR, WGS84, *bounds)
        for z in range(minzoom, maxzoom + 1):
            for tile in mercantile.tiles(w, s, e, n, [z]):
                seen.add(tile)
    return sorted(seen, key=lambda t: (t.z, t.x, t.y))
