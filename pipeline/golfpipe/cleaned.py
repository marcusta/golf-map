"""The cleaned photo: ONE square RGB image per site, edited in place.

`ortho-<collection>.cleaned.tif` is a `size` x `size` (8192) uint8 RGB GeoTIFF
in EPSG:3006 on the site's inner terrain square, the square every GSPro ortho
export and the Unity textures are rendered over. It is the whole state of
photo cleaning. There is no edit log, no export record and no second frame:

  * `cleaned-init`     makes it from an ortho GeoTIFF (the pristine photo, or
                       a working raster of the retired patch-log model).
  * `cleaned-replace`  overwrites it with any image of the same pixel size
                       (an edit made in an image editor, or an undo
                       snapshot), whatever the image shows.
  * `cleaned-patch`    writes rectangles of pixels straight into it (the
                       Clean tool's strokes, painted in the browser).
  * `cleaned-export`   writes it out as a PNG or JPEG, or as raw RGB bytes
                       (what the Clean tool loads).

The pristine source ortho is never modified. Undo is the server's business:
it keeps copies of this file. Each command that changes pixels rewrites the
map tiles under the change (the sparse `ortho-sim` overlay, see
commands._retile_affected) and prints one JSON line on stdout, last.
"""

from __future__ import annotations

import os
from pathlib import Path

import numpy as np
import rasterio
from rasterio.enums import Resampling
from rasterio.transform import from_bounds
from rasterio.warp import reproject
from rasterio.windows import Window

from . import patches as patches_mod
from .patches import PatchError, SWEREF99_TM

CLEANED_SIZE = 8192
EXPORT_FORMATS = ("png", "jpg", "rgb")
EXPORT_JPEG_QUALITY = 95
# An 8192 px photo barely compresses whatever the zlib level, and level 6
# takes several times as long as level 1 for a few percent.
EXPORT_PNG_COMPRESS_LEVEL = 1
_STRIP_ROWS = 512
# A change is retiled per cell of this many pixels, not as one box round
# everything: edits at opposite ends of the photo then cost their own tiles
# and not all the ground between them.
RETILE_CELL_PX = 256

Extent = tuple[float, float, float, float]


def _check_square(extent: Extent) -> None:
    e0, n0, e1, n1 = extent
    if not (e1 > e0 and n1 > n0) or abs((e1 - e0) - (n1 - n0)) > 1e-6:
        raise PatchError(f"the cleaned photo's extent must be a square in EPSG:3006 metres, got {extent}")


def _bounds_json(bounds: Extent) -> dict:
    west, south, east, north = bounds
    return {"west": west, "south": south, "east": east, "north": north}


def _open_cleaned(path: Path, mode: str = "r"):
    if not path.is_file():
        raise PatchError(f"no cleaned photo at {path}: run cleaned-init first")
    return rasterio.open(path, mode)


def window_bounds3006(dataset, r0: int, r1: int, c0: int, c1: int) -> Extent:
    """EPSG:3006 bounds (west, south, east, north) of the pixel window rows
    [r0, r1) x cols [c0, c1) of a north-up dataset."""
    west, north = dataset.transform * (c0, r0)
    east, south = dataset.transform * (c1, r1)
    return (west, south, east, north)


def create_cleaned(ortho_path: Path, extent3006: Extent, out_path: Path, size: int = CLEANED_SIZE) -> None:
    """Resamples bands 1..3 of `ortho_path` onto the square `extent3006` at
    `size` px per side and writes `out_path`. Cubic, like `gspro.py ortho`'s
    own render of the photo, so a texture rendered from this file is the
    texture that render made. Ground the ortho does not cover is black."""
    _check_square(extent3006)
    if size <= 0:
        raise PatchError("--size must be > 0")
    if out_path.resolve() == ortho_path.resolve():
        raise PatchError(f"refusing to overwrite the source ortho ({ortho_path})")
    rgb = np.zeros((3, size, size), dtype=np.uint8)
    transform = from_bounds(*extent3006, size, size)
    with rasterio.open(ortho_path) as src:
        if src.count < 3:
            raise PatchError(f"{ortho_path} has {src.count} band(s); the cleaned photo needs an RGB ortho")
        reproject(
            source=rasterio.band(src, [1, 2, 3]), destination=rgb,
            src_crs=src.crs, src_transform=src.transform,
            dst_crs=SWEREF99_TM, dst_transform=transform,
            resampling=Resampling.cubic, num_threads=os.cpu_count() or 1,
        )
    out_path.parent.mkdir(parents=True, exist_ok=True)
    # Written beside the target and renamed: a failed write leaves no half file.
    tmp = out_path.with_name(out_path.name + ".tmp")
    profile = {
        "driver": "GTiff", "height": size, "width": size, "count": 3, "dtype": "uint8",
        "crs": SWEREF99_TM, "transform": transform, "photometric": "RGB",
        "tiled": True, "blockxsize": min(512, size), "blockysize": min(512, size),
        "compress": "deflate", "predictor": 2,
    }
    if size < 16:
        profile.update(tiled=False)
        del profile["blockxsize"], profile["blockysize"]
    with rasterio.open(tmp, "w", **profile) as dst:
        dst.write(rgb)
    os.replace(tmp, out_path)


def read_image_rgba(image_path: Path) -> tuple[np.ndarray, np.ndarray | None]:
    """An image file as (rgb uint8 (rows, cols, 3), alpha uint8 (rows, cols)
    or None when it has none). Any PNG/JPEG/TIFF Pillow reads: grey, palette,
    CMYK and 16-bit images are converted, an embedded colour profile is
    ignored (the pixel values are taken as they are)."""
    from PIL import Image

    Image.MAX_IMAGE_PIXELS = None
    try:
        with Image.open(image_path) as im:
            im.load()
            if im.mode in ("I;16", "I;16B", "I;16L", "I"):
                im = Image.fromarray((np.asarray(im, dtype=np.uint32) >> 8).clip(0, 255).astype(np.uint8))
            has_alpha = im.mode in ("RGBA", "LA", "PA") or (im.mode == "P" and "transparency" in im.info)
            rgba = np.asarray(im.convert("RGBA" if has_alpha else "RGB"))
    except PatchError:
        raise
    except Exception as exc:  # Pillow raises a zoo: OSError, SyntaxError, ValueError, DecompressionBomb…
        raise PatchError(f"cannot read {image_path.name} as an image: {exc}") from exc
    if has_alpha:
        alpha = rgba[..., 3]
        return rgba[..., :3], (None if bool((alpha == 255).all()) else alpha)
    return rgba, None


def replace_pixels(dataset, rgb: np.ndarray, alpha: np.ndarray | None = None,
                   ) -> tuple[int, tuple[int, int, int, int] | None, list[tuple[int, int, int, int]]]:
    """Makes the open "r+" `dataset` show `rgb` (composited over what is
    there where `alpha` is below 255). Only the bounding box of the pixels
    that actually differ is written. Returns (changed pixel count, their
    window (r0, r1, c0, c1) or None when nothing differs, the windows of the
    RETILE_CELL_PX cells holding a changed pixel)."""
    height, width = dataset.height, dataset.width
    if rgb.shape[:2] != (height, width):
        raise PatchError(
            f"the image is {rgb.shape[1]} x {rgb.shape[0]} px and the cleaned photo is {width} x {height} px: "
            f"save it at {width} x {height} px, uncropped")
    changed = 0
    cell = RETILE_CELL_PX
    dirty = np.zeros((-(-height // cell), -(-width // cell)), dtype=bool)
    r_lo, r_hi, c_lo, c_hi = height, -1, width, -1
    target = np.empty((height, width, 3), dtype=np.uint8)
    for r0 in range(0, height, _STRIP_ROWS):
        r1 = min(height, r0 + _STRIP_ROWS)
        current = np.moveaxis(dataset.read([1, 2, 3], window=Window(0, r0, width, r1 - r0)), 0, -1)
        strip = rgb[r0:r1]
        if alpha is not None:
            a = alpha[r0:r1].astype(np.float32)[..., None] / 255.0
            strip = np.round(strip.astype(np.float32) * a + current.astype(np.float32) * (1.0 - a)).astype(np.uint8)
        target[r0:r1] = strip
        diff = (strip != current).any(axis=-1)
        n = int(diff.sum())
        if n == 0:
            continue
        changed += n
        rows = np.nonzero(diff.any(axis=1))[0]
        cols = np.nonzero(diff.any(axis=0))[0]
        rr, cc = np.nonzero(diff)
        dirty[(r0 + rr) // cell, cc // cell] = True
        r_lo, r_hi = min(r_lo, r0 + int(rows[0])), max(r_hi, r0 + int(rows[-1]))
        c_lo, c_hi = min(c_lo, int(cols[0])), max(c_hi, int(cols[-1]))
    if changed == 0:
        return 0, None, []
    win = (r_lo, r_hi + 1, c_lo, c_hi + 1)
    dataset.write(np.moveaxis(target[win[0]:win[1], win[2]:win[3]], -1, 0),
                  window=Window(win[2], win[0], win[3] - win[2], win[1] - win[0]), indexes=[1, 2, 3])
    cells = [(int(r) * cell, min(height, (int(r) + 1) * cell), int(c) * cell, min(width, (int(c) + 1) * cell))
             for r, c in zip(*np.nonzero(dirty))]
    return changed, win, cells


def _retile(cleaned: Path, bounds3857: list[Extent], tiles_out: Path | None, pristine_tiles: Path | None,
            minzoom: int, maxzoom: int, webp_quality: int) -> int:
    from . import commands

    if tiles_out is None or not bounds3857:
        return 0
    return commands._retile_affected(cleaned, bounds3857, tiles_out, minzoom, maxzoom, webp_quality,
                                     pristine_tiles=pristine_tiles)


def cmd_cleaned_init(ortho_path: Path, extent3006: Extent, out: Path, size: int = CLEANED_SIZE) -> dict:
    """Creates the cleaned photo `out` from `ortho_path` on the square
    `extent3006` (see create_cleaned). Refuses to replace an existing one:
    that would throw away its edits. No tiles are written: the map already
    shows this photo (the pristine tiles, or the sim tiles of the working
    raster it was made from)."""
    from . import commands

    if out.exists():
        raise PatchError(f"{out} exists: a cleaned photo is never re-created over its edits")
    create_cleaned(ortho_path, extent3006, out, size)
    doc = {"file": out.name, "size": size, "extent3006": list(extent3006), "source": ortho_path.name}
    commands._emit_json(doc)
    return doc


def cmd_cleaned_replace(
    cleaned: Path,
    image: Path,
    tiles_out: Path | None = None,
    pristine_tiles: Path | None = None,
    minzoom: int | None = None,
    maxzoom: int | None = None,
    webp_quality: int = 80,
) -> dict:
    """Makes the cleaned photo show `image`: any image of the photo's pixel
    size, whatever is on it and wherever it came from. A transparent or
    partly transparent image is laid over the photo. `image` may also be
    another cleaned GeoTIFF (an undo snapshot). The map tiles under the
    pixels that changed are rewritten; an identical image changes nothing."""
    from . import commands

    if not image.is_file():
        raise PatchError(f"no such image: {image}")
    if image.suffix.lower() in (".tif", ".tiff"):
        with rasterio.open(image) as src:
            if src.count < 3:
                raise PatchError(f"{image.name} has {src.count} band(s); the cleaned photo is RGB")
            rgb, alpha = np.moveaxis(src.read([1, 2, 3]), 0, -1), None
        if rgb.dtype != np.uint8:
            rgb, alpha = read_image_rgba(image)
    else:
        rgb, alpha = read_image_rgba(image)
    with _open_cleaned(cleaned, "r+") as dst:
        changed, win, cells = replace_pixels(dst, rgb, alpha)
        size = dst.width
        bounds3006 = window_bounds3006(dst, *win) if win else None
        cell_bounds = [patches_mod.bounds3006_to_3857(window_bounds3006(dst, *c)) for c in cells]
    doc: dict = {"changed": changed > 0, "changedPixels": changed, "size": size}
    if bounds3006 is not None:
        bounds3857 = patches_mod.bounds3006_to_3857(bounds3006)
        doc["bounds3006"] = _bounds_json(bounds3006)
        doc["bounds3857"] = _bounds_json(bounds3857)
        doc["tiles"] = _retile(cleaned, cell_bounds, tiles_out, pristine_tiles,
                               minzoom or commands.DEFAULT_ORTHO_MINZOOM, maxzoom or commands.DEFAULT_ORTHO_MAXZOOM,
                               webp_quality)
    commands._emit_json(doc)
    return doc


def cmd_cleaned_patch(
    cleaned: Path,
    patches_dir: Path,
    tiles_out: Path | None = None,
    pristine_tiles: Path | None = None,
    minzoom: int | None = None,
    maxzoom: int | None = None,
    webp_quality: int = 80,
) -> dict:
    """Writes the rectangles listed in `patches_dir/patches.json` into the
    cleaned photo, in order, and rewrites the map tiles under them in one
    pass. Each entry is `{"x", "y", "w", "h", "file"}`: a pixel rectangle of
    the photo and a file of its raw RGBA bytes (row by row, alpha ignored).
    These are finished pixels: nothing is computed here."""
    import json

    from . import commands

    try:
        entries = json.loads((patches_dir / "patches.json").read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise PatchError(f"cannot read {patches_dir / 'patches.json'}: {exc}") from exc
    if not isinstance(entries, list) or not entries:
        raise PatchError(f"nothing to write: {patches_dir} lists no patches")
    bounds: list[Extent] = []
    pixels = 0
    with _open_cleaned(cleaned, "r+") as dst:
        for i, e in enumerate(entries):
            try:
                x, y, w, h = (int(e[k]) for k in ("x", "y", "w", "h"))
                name = str(e["file"])
            except (KeyError, TypeError, ValueError) as exc:
                raise PatchError(f"patch {i}: needs integer x, y, w, h and a file") from exc
            if w <= 0 or h <= 0 or x < 0 or y < 0 or x + w > dst.width or y + h > dst.height:
                raise PatchError(f"patch {i}: {x},{y} {w}x{h} is outside the {dst.width} x {dst.height} px photo")
            raw = np.fromfile(patches_dir / Path(name).name, dtype=np.uint8)
            if raw.size != w * h * 4:
                raise PatchError(f"patch {i}: {raw.size} bytes is not {w} x {h} RGBA pixels")
            rgb = raw.reshape(h, w, 4)[..., :3]
            dst.write(np.moveaxis(rgb, -1, 0), window=Window(x, y, w, h), indexes=[1, 2, 3])
            pixels += w * h
            # Per RETILE_CELL_PX cell, like cleaned-replace: a long thin
            # stroke costs its own tiles, not its whole bounding box.
            cell = RETILE_CELL_PX
            for r0 in range(y // cell * cell, y + h, cell):
                for c0 in range(x // cell * cell, x + w, cell):
                    win = (max(r0, y), min(r0 + cell, y + h), max(c0, x), min(c0 + cell, x + w))
                    bounds.append(patches_mod.bounds3006_to_3857(window_bounds3006(dst, *win)))
    tiles = _retile(cleaned, bounds, tiles_out, pristine_tiles,
                    minzoom or commands.DEFAULT_ORTHO_MINZOOM, maxzoom or commands.DEFAULT_ORTHO_MAXZOOM, webp_quality)
    doc = {"patches": len(entries), "pixels": pixels, "tiles": tiles}
    commands._emit_json(doc)
    return doc


def cmd_cleaned_export(cleaned: Path, out: Path, fmt: str = "png") -> dict:
    """Writes the cleaned photo to `out` as a PNG (lossless: what an image
    editor should get), a JPEG (q95) or raw RGB bytes (3 per pixel, row by
    row: what the Clean tool loads into its pixel engine)."""
    from PIL import Image

    from . import commands

    if fmt not in EXPORT_FORMATS:
        raise PatchError(f"unknown export format {fmt!r} (png, jpg or rgb)")
    with _open_cleaned(cleaned) as src:
        rgb = np.ascontiguousarray(np.moveaxis(src.read([1, 2, 3]), 0, -1))
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_name(out.name + ".tmp")
    if fmt == "rgb":
        rgb.tofile(tmp)
        os.replace(tmp, out)
        doc = {"file": out.name, "format": fmt, "size": int(rgb.shape[0]), "bytes": out.stat().st_size}
        commands._emit_json(doc)
        return doc
    im = Image.fromarray(rgb)
    if fmt == "png":
        im.save(tmp, format="PNG", compress_level=EXPORT_PNG_COMPRESS_LEVEL)
    else:
        im.save(tmp, format="JPEG", quality=EXPORT_JPEG_QUALITY, subsampling=0)
    os.replace(tmp, out)
    doc = {"file": out.name, "format": fmt, "size": int(rgb.shape[0]), "bytes": out.stat().st_size}
    commands._emit_json(doc)
    return doc
