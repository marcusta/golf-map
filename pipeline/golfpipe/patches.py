"""Replayable orthophoto patch log (T55 interactive photo cleaning).

The web editor's "Clean photo" tool lets the user mask a blemish (player,
cart, shadow, stray object) on a 512 px ortho-tile crop and previews a
locally-inpainted result. On accept, the server stores the MASK — not fill
pixels — as a patch: a grayscale/alpha PNG (white/opaque = pixel to inpaint)
plus a JSON log entry carrying its exact georeferencing. The fill itself is
computed HERE, by running LaMa (golfpipe.inpaint) on a context window of the
current patched raster — so the inpaint sees pristine source pixels, not the
WebP-lossy, mercator-resampled tile pixels the client previews with. That is
what keeps baked patches seam-free: fill and surroundings share provenance.

The pristine source ortho is NEVER modified — mirroring the terrain-edit
plan's edits-as-replayable-log philosophy — so this module can always rebuild
the patched raster from scratch:

    data/sources/<mapKey>/patches/
        patches.json     the ordered log (written by the server, read here)
        1.png, 2.png, …  mask PNGs, luminance/alpha > 127 = pixel to inpaint

Log format is VERSIONED: this module reads version 2 (mask payloads).
Version 1 stored pre-rendered RGBA fill pixels (the seam-y design); a
non-empty version-1 log is refused with a clear error instead of being
misread as masks.

Version 2 carries TWO entry kinds (`kind`, absent = "mask"):

  * mask  — a mask PNG; the fill is LaMa-inpainted (torch needed).
  * stamp — a clone-stamp STROKE: brush params (sizeM/opacity/flow/
    hardness), a source→dest offset in EPSG:3006 metres, the dest polyline
    (EPSG:3006), and the aligned/tone-match capture state. The stroke is
    re-rendered here with the pure numpy brush engine (golfpipe.stamp) —
    source pixels read from the CURRENT patched raster shifted by the
    offset — so stamp entries need NO torch and replay byte-identically.

A log with only stamp entries is therefore fully bakeable without LaMa
weights or torch; the inpaint_fn is only required when mask entries exist.

Two bake paths (commands.py):

  * `bake-ortho-patch` — incremental accept: ONE windowed inpaint into the
    existing `<stem>.patched.tif` (created lazily from the pristine source on
    first patch) + affected-subtree retile. No full-raster rewrite.
  * `apply-ortho-patches` — full replay from pristine, iterating masks →
    windowed inpaints in log order. Used for revert and for rebuilding after
    vintage changes.

Determinism: a replay re-RUNS LaMa, so the regenerated fills depend on the
model weights and torch device. A revert-replay therefore reproduces fills
that are visually equivalent, not byte-identical, to the originally accepted
bake — accepted by design (the mask log, not the fill bytes, is the source
of truth).

Georeferencing: masks are drawn on Web-Mercator XYZ tile crops, so their
native, exact frame is an axis-aligned EPSG:3857 rectangle (`bounds3857` in
the log). The mask is reprojected onto the ortho's own grid (EPSG:3006)
before inpainting — using 3006 bounds instead would silently ignore the
~0.5° meridian-convergence rotation between the two frames and shift mask
edges by decimetres.
"""

from __future__ import annotations

import json
import math
import shutil
from dataclasses import dataclass
from pathlib import Path

import mercantile
import numpy as np
import rasterio
from rasterio.crs import CRS
from rasterio.enums import Resampling
from rasterio.transform import Affine, from_bounds
from rasterio.warp import reproject, transform_bounds
from rasterio.windows import Window

from .inpaint import InpaintFn, inpaint_tiled
from .stamp import render_stamp

WEB_MERCATOR = CRS.from_epsg(3857)
WGS84 = CRS.from_epsg(4326)
SWEREF99_TM = CRS.from_epsg(3006)

PATCH_LOG_NAME = "patches.json"
PATCH_LOG_VERSION = 2

# Context margin (in destination-raster pixels) around the mask's bounding
# box for the inpaint window: LaMa fills from surroundings, so it needs to
# see a healthy band of intact imagery. 256 px each side puts the window for
# a typical small mask around 512-1024 px — one to four model crops.
DEFAULT_CONTEXT_PX = 256


class PatchError(RuntimeError):
    """User-actionable patch-log / bake error."""


@dataclass(frozen=True)
class PatchEntry:
    seq: int
    file: str
    """Mask PNG file name relative to the patches dir."""
    bounds3857: tuple[float, float, float, float]
    """(west, south, east, north) in EPSG:3857 metres — the mask's frame."""
    tool: str
    created_at: str


@dataclass(frozen=True)
class StampEntry:
    """One clone-stamp STROKE (see the module header). No pixel payload —
    the stroke is re-rendered deterministically from these parameters."""

    seq: int
    bounds3857: tuple[float, float, float, float]
    """Dest stroke bbox + brush radius in EPSG:3857 — the retile frame."""
    size_m: float
    """Brush DIAMETER in ground metres."""
    opacity: float
    flow: float
    hardness: float
    offset_m: tuple[float, float]
    """source = dest + offset, EPSG:3006 metres (dx east, dy north)."""
    path: tuple[tuple[float, float], ...]
    """Dest polyline, EPSG:3006 metres (easting, northing)."""
    aligned: bool
    """Aligned-clone flag state at capture (informational for replay —
    the offset above is already resolved per stroke)."""
    tone_match: bool
    tool: str
    created_at: str


LogEntry = PatchEntry | StampEntry


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


def _parse_stamp(raw: dict, context: str) -> StampEntry:
    stamp = raw.get("stamp")
    if not isinstance(stamp, dict):
        raise PatchError(f"{context}: stamp entry needs a `stamp` object")
    brush = stamp.get("brush")
    if not isinstance(brush, dict):
        raise PatchError(f"{context}: stamp entry needs `stamp.brush`")
    try:
        size_m = float(brush["sizeM"])
        opacity = float(brush["opacity"])
        flow = float(brush["flow"])
        hardness = float(brush["hardness"])
    except (KeyError, TypeError, ValueError) as exc:
        raise PatchError(f"{context}: stamp.brush needs numeric sizeM/opacity/flow/hardness") from exc
    if not (math.isfinite(size_m) and size_m > 0):
        raise PatchError(f"{context}: stamp.brush.sizeM must be a positive number")
    for name, v in (("opacity", opacity), ("flow", flow), ("hardness", hardness)):
        if not (math.isfinite(v) and 0.0 <= v <= 1.0):
            raise PatchError(f"{context}: stamp.brush.{name} must be in [0, 1]")
    offset = stamp.get("offsetM")
    if not isinstance(offset, dict):
        raise PatchError(f"{context}: stamp entry needs `stamp.offsetM` (dx/dy metres)")
    try:
        dx, dy = float(offset["dx"]), float(offset["dy"])
    except (KeyError, TypeError, ValueError) as exc:
        raise PatchError(f"{context}: stamp.offsetM needs numeric dx/dy") from exc
    if not (math.isfinite(dx) and math.isfinite(dy)):
        raise PatchError(f"{context}: stamp.offsetM must be finite")
    raw_path = stamp.get("path")
    if not isinstance(raw_path, list) or not raw_path:
        raise PatchError(f"{context}: stamp entry needs a non-empty `stamp.path`")
    path: list[tuple[float, float]] = []
    for p in raw_path:
        try:
            x, y = float(p[0]), float(p[1])
        except (TypeError, ValueError, IndexError, KeyError) as exc:
            raise PatchError(f"{context}: stamp.path points must be [easting, northing] pairs") from exc
        if not (math.isfinite(x) and math.isfinite(y)):
            raise PatchError(f"{context}: stamp.path points must be finite")
        path.append((x, y))
    return StampEntry(
        seq=int(raw["seq"]),
        bounds3857=_parse_bounds(raw.get("bounds3857"), context),
        size_m=size_m,
        opacity=opacity,
        flow=flow,
        hardness=hardness,
        offset_m=(dx, dy),
        path=tuple(path),
        aligned=bool(stamp.get("aligned", False)),
        tone_match=bool(stamp.get("toneMatch", True)),
        tool=str(raw.get("tool", "stamp")),
        created_at=str(raw.get("createdAt", "")),
    )


def load_patch_log(patches_dir: Path) -> list[LogEntry]:
    """Reads and validates `patches.json` from a patches dir, sorted by seq.
    A missing file (course never patched) is an empty log, not an error.
    A NON-empty version-1 log (pre-rendered fill pixels, the retired format)
    is refused: its payloads are not masks and must not be baked as such.
    Entries are mask entries unless `kind` is "stamp" (see module header).
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
    version = doc.get("version")
    if version not in (1, 2):
        raise PatchError(f"{log_path} has unsupported patch log version {version!r}")
    if version != PATCH_LOG_VERSION and raw_patches:
        raise PatchError(
            f"{log_path} is a legacy version-1 pixel-patch log ({len(raw_patches)} "
            "entr(y/ies)); its payloads are fill pixels, not masks — revert the "
            "legacy patches (or delete the patches dir) before baking"
        )

    entries: list[LogEntry] = []
    for i, raw in enumerate(raw_patches):
        context = f"{log_path} entry {i}"
        if not isinstance(raw, dict):
            raise PatchError(f"{context}: not an object")
        kind = raw.get("kind", "mask")
        if kind == "stamp":
            try:
                int(raw["seq"])
            except (KeyError, TypeError, ValueError) as exc:
                raise PatchError(f"{context}: needs an integer `seq`") from exc
            entries.append(_parse_stamp(raw, context))
            continue
        if kind != "mask":
            raise PatchError(f"{context}: unknown entry kind {kind!r}")
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


def load_patch_mask(patches_dir: Path, entry: PatchEntry) -> np.ndarray:
    """Reads a mask PNG as an (H, W) bool array (luminance > 127 = inpaint;
    an alpha channel, when present, gates it — fully transparent pixels are
    never part of the mask)."""
    from PIL import Image

    path = patches_dir / entry.file
    if not path.is_file():
        raise PatchError(f"mask file missing: {path} (log entry seq {entry.seq})")
    with Image.open(path) as img:
        rgba = np.array(img.convert("RGBA"))
    return (rgba[..., :3].max(axis=2) > 127) & (rgba[..., 3] > 127)


def mask_tight_bounds3857(
    mask: np.ndarray,
    bounds3857: tuple[float, float, float, float],
) -> tuple[float, float, float, float] | None:
    """EPSG:3857 bounds of the mask's True-pixel bounding box (the mask's
    frame is the axis-aligned `bounds3857` rectangle, row 0 = north edge),
    padded by one mask pixel for resampling support. None for an empty mask.
    """
    rows = np.any(mask, axis=1)
    cols = np.any(mask, axis=0)
    if not rows.any():
        return None
    h, w = mask.shape
    r0 = int(np.argmax(rows))
    r1 = h - int(np.argmax(rows[::-1]))  # exclusive
    c0 = int(np.argmax(cols))
    c1 = w - int(np.argmax(cols[::-1]))  # exclusive
    west, south, east, north = bounds3857
    xres = (east - west) / w
    yres = (north - south) / h
    return (
        west + (c0 - 1) * xres,
        north - (r1 + 1) * yres,
        west + (c1 + 1) * xres,
        north - (r0 - 1) * yres,
    )


def window_for_bounds(
    transform: Affine,
    crs: CRS,
    width: int,
    height: int,
    bounds3857: tuple[float, float, float, float],
    pad_px: int = 0,
) -> tuple[int, int, int, int] | None:
    """Destination-raster pixel window (r0, r1, c0, c1; end-exclusive)
    covering the given EPSG:3857 bounds reprojected into `crs`, padded by
    `pad_px` on every side and clipped to the raster. None when the bounds
    miss the raster entirely.
    """
    db = transform_bounds(WEB_MERCATOR, crs, *bounds3857)
    inv = ~transform
    c0f, r0f = inv * (db[0], db[3])
    c1f, r1f = inv * (db[2], db[1])
    r0 = max(0, math.floor(min(r0f, r1f)) - pad_px)
    c0 = max(0, math.floor(min(c0f, c1f)) - pad_px)
    r1 = min(height, math.ceil(max(r0f, r1f)) + pad_px)
    c1 = min(width, math.ceil(max(c0f, c1f)) + pad_px)
    if r1 <= r0 or c1 <= c0:
        return None
    return (r0, r1, c0, c1)


def rasterize_mask_window(
    mask: np.ndarray,
    bounds3857: tuple[float, float, float, float],
    window_transform: Affine,
    crs: CRS,
    shape: tuple[int, int],
) -> np.ndarray:
    """Reprojects an EPSG:3857-framed bool mask onto a destination-grid
    window (`window_transform`/`crs`, `shape` = (rows, cols)) as a bool
    array. Warped bilinearly and thresholded at half-coverage, so the mask
    boundary lands where it visually sits on the map — meridian-convergence
    rotation between the frames is preserved, not snapped to a 3006-axis-
    aligned box.
    """
    ph, pw = mask.shape
    src_transform = from_bounds(*bounds3857, pw, ph)
    warped = np.zeros(shape, dtype=np.float32)
    reproject(
        source=mask.astype(np.float32) * 255.0,
        destination=warped,
        src_transform=src_transform,
        src_crs=WEB_MERCATOR,
        dst_transform=window_transform,
        dst_crs=crs,
        resampling=Resampling.bilinear,
    )
    return warped >= 128.0


def inpaint_entry_into(
    dataset,
    mask: np.ndarray,
    bounds3857: tuple[float, float, float, float],
    inpaint_fn: InpaintFn,
    context_px: int = DEFAULT_CONTEXT_PX,
) -> bool:
    """Windowed in-place inpaint of one mask entry into `dataset` (a rasterio
    dataset opened "r+"): reads a context window around the mask, reprojects
    the mask into it, runs `inpaint_fn` (LaMa via inpaint_tiled — pixels
    outside the mask come back byte-identical), and writes the window back.
    Returns False (writing nothing) when the mask misses the raster.
    """
    tight = mask_tight_bounds3857(mask, bounds3857)
    if tight is None:
        return False
    win = window_for_bounds(
        dataset.transform, dataset.crs, dataset.width, dataset.height, tight, pad_px=context_px,
    )
    if win is None:
        return False
    r0, r1, c0, c1 = win
    window = Window(c0, r0, c1 - c0, r1 - r0)
    window_transform = dataset.transform * Affine.translation(c0, r0)
    window_mask = rasterize_mask_window(
        mask, bounds3857, window_transform, dataset.crs, (r1 - r0, c1 - c0),
    )
    if not window_mask.any():
        return False
    image = np.moveaxis(dataset.read([1, 2, 3], window=window), 0, -1)
    filled = inpaint_tiled(image, window_mask, inpaint_fn)
    dataset.write(np.moveaxis(filled, -1, 0), window=window, indexes=[1, 2, 3])
    return True


def stamp_entry_into(dataset, entry: StampEntry) -> bool:
    """Windowed in-place render of one clone-stamp stroke into `dataset` (a
    rasterio dataset opened "r+"): reads the dest window around the stroke
    path plus the offset-shifted source window (a snapshot BEFORE the stroke
    composites), runs the pure numpy brush engine (golfpipe.stamp), and
    writes the dest window back. Pixels whose shifted source falls off the
    raster are left untouched. Returns False (writing nothing) when the
    stroke misses the raster entirely. Deterministic — byte-reproducible on
    replay, no torch involved.
    """
    xs = [p[0] for p in entry.path]
    ys = [p[1] for p in entry.path]
    sx0, sy0 = xs[0] + entry.offset_m[0], ys[0] + entry.offset_m[1]
    if dataset.crs != SWEREF99_TM:
        from rasterio.warp import transform as warp_transform

        xs, ys = warp_transform(SWEREF99_TM, dataset.crs, xs, ys)
        (sx0,), (sy0,) = warp_transform(SWEREF99_TM, dataset.crs, [sx0], [sy0])

    inv = ~dataset.transform
    path_px = np.array([inv * (x, y) for x, y in zip(xs, ys)], dtype=np.float64)
    radius_px = (entry.size_m / 2.0) / abs(dataset.transform.a)
    # The clone offset as an integer pixel shift (≤ half a pixel of rounding
    # — centimetres at ortho resolution), measured at the stroke's start.
    scol, srow = inv * (sx0, sy0)
    shift_c = round(scol - path_px[0][0])
    shift_r = round(srow - path_px[0][1])

    pad = int(math.ceil(radius_px)) + 2
    r0 = max(0, int(math.floor(path_px[:, 1].min())) - pad)
    r1 = min(dataset.height, int(math.ceil(path_px[:, 1].max())) + pad)
    c0 = max(0, int(math.floor(path_px[:, 0].min())) - pad)
    c1 = min(dataset.width, int(math.ceil(path_px[:, 0].max())) + pad)
    if r1 <= r0 or c1 <= c0:
        return False

    dest = np.moveaxis(dataset.read([1, 2, 3], window=Window(c0, r0, c1 - c0, r1 - r0)), 0, -1)
    src = np.zeros_like(dest)
    valid = np.zeros(dest.shape[:2], dtype=bool)
    sr0, sc0 = r0 + shift_r, c0 + shift_c
    ir0 = max(sr0, 0)
    ir1 = min(r1 + shift_r, dataset.height)
    ic0 = max(sc0, 0)
    ic1 = min(c1 + shift_c, dataset.width)
    if ir1 > ir0 and ic1 > ic0:
        data = dataset.read([1, 2, 3], window=Window(ic0, ir0, ic1 - ic0, ir1 - ir0))
        src[ir0 - sr0:ir1 - sr0, ic0 - sc0:ic1 - sc0] = np.moveaxis(data, 0, -1)
        valid[ir0 - sr0:ir1 - sr0, ic0 - sc0:ic1 - sc0] = True

    local_path = path_px - np.array([c0, r0], dtype=np.float64)
    result = render_stamp(
        dest, src, valid, local_path, radius_px,
        entry.opacity, entry.flow, entry.hardness, entry.tone_match,
    )
    if np.array_equal(result, dest):
        return False
    dataset.write(np.moveaxis(result, -1, 0), window=Window(c0, r0, c1 - c0, r1 - r0), indexes=[1, 2, 3])
    return True


def bake_entry_into(
    dataset,
    patches_dir: Path,
    entry: LogEntry,
    inpaint_fn: InpaintFn | None,
    context_px: int = DEFAULT_CONTEXT_PX,
) -> bool:
    """Bakes ONE log entry (mask or stamp) into an open "r+" dataset."""
    if isinstance(entry, StampEntry):
        return stamp_entry_into(dataset, entry)
    if inpaint_fn is None:
        raise PatchError(f"baking mask entry seq {entry.seq} needs an inpaint_fn (LaMa)")
    mask = load_patch_mask(patches_dir, entry)
    return inpaint_entry_into(dataset, mask, entry.bounds3857, inpaint_fn, context_px=context_px)


def needs_inpaint(entries: list[LogEntry]) -> bool:
    """True when any entry is a mask (LaMa/torch required); a stamp-only log
    is fully bakeable without torch."""
    return any(isinstance(e, PatchEntry) for e in entries)


def apply_patches_to_ortho(
    ortho_path: Path,
    patches_dir: Path,
    entries: list[LogEntry],
    out_path: Path,
    inpaint_fn: InpaintFn | None = None,
    context_px: int = DEFAULT_CONTEXT_PX,
) -> None:
    """Full replay: copies the pristine ortho at `ortho_path` to `out_path`
    and windowed-bakes every entry (in seq order) into the copy — masks are
    LaMa-inpainted, stamp strokes are re-rendered by the brush engine. The
    pristine source is never modified. An empty or stamp-only log needs no
    `inpaint_fn` (those paths stay torch-free).

    Mask fills are regenerated by the model, so two replays of a mask-bearing
    log are visually equivalent but not guaranteed byte-identical; stamp
    strokes replay byte-identically (see the module header).
    """
    if out_path.resolve() == ortho_path.resolve():
        raise PatchError(f"refusing to overwrite the source ortho ({ortho_path}) — pass a different --out")
    if needs_inpaint(entries) and inpaint_fn is None:
        raise PatchError("replaying a patch log with mask entries needs an inpaint_fn (LaMa)")

    with rasterio.open(ortho_path) as src:
        if src.count < 3:
            raise PatchError(f"{ortho_path} has {src.count} band(s); ortho patching needs an RGB ortho")

    out_path.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(ortho_path, out_path)
    if not entries:
        return
    with rasterio.open(out_path, "r+") as dst:
        for entry in entries:
            bake_entry_into(dst, patches_dir, entry, inpaint_fn, context_px=context_px)


def affected_tiles(
    bounds3857_list: list[tuple[float, float, float, float]],
    minzoom: int,
    maxzoom: int,
) -> list[mercantile.Tile]:
    """The deduplicated XYZ tiles intersecting any of the given EPSG:3857
    bounds, across every zoom in [minzoom, maxzoom] — the tile-pyramid
    subtree a bake must rewrite. Sorted by (z, x, y) for determinism.
    """
    seen: set[mercantile.Tile] = set()
    for bounds in bounds3857_list:
        w, s, e, n = transform_bounds(WEB_MERCATOR, WGS84, *bounds)
        for z in range(minzoom, maxzoom + 1):
            for tile in mercantile.tiles(w, s, e, n, [z]):
                seen.add(tile)
    return sorted(seen, key=lambda t: (t.z, t.x, t.y))
