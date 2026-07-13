"""Re-encode an existing ortho tile tree from JPEG to WebP in place.

Walks `<tiles_root>/ortho/**/*.jpg`, writes a sibling `.webp` (quality 80)
for each, and deletes the `.jpg` only after its `.webp` has been written
successfully. Idempotent: a tile that already has a `.webp` sibling is left
untouched (its `.jpg`, if still present, is removed). Never touches
`terrain/` (elevation PNGs must stay lossless).

Usage:
    python -m golfpipe.reencode_webp <tiles_root> [--quality 80] [--dry-run]

`<tiles_root>` is a site/course tile directory containing an `ortho/`
subdir (i.e. `data/tiles/{courseId}/`). You may also point it directly at
an `ortho/` dir; both are accepted.
"""

from __future__ import annotations

import argparse
import sys
from io import BytesIO
from pathlib import Path

from PIL import Image

DEFAULT_QUALITY = 80


def _resolve_ortho_dir(tiles_root: Path) -> Path:
    """Accept either a course tile root (containing ortho/) or an ortho/
    dir directly."""
    if tiles_root.name == "ortho":
        return tiles_root
    return tiles_root / "ortho"


def reencode_ortho_tree(ortho_dir: Path, quality: int = DEFAULT_QUALITY, dry_run: bool = False) -> dict:
    """Convert every .jpg under ortho_dir to a sibling .webp (quality
    `quality`), deleting each .jpg only after its .webp exists. Skips tiles
    that already have a .webp. Returns a summary dict with counts and byte
    totals.
    """
    converted = 0
    skipped = 0
    bytes_before = 0
    bytes_after = 0

    if not ortho_dir.exists():
        raise FileNotFoundError(f"ortho tile directory not found: {ortho_dir}")

    for jpg in sorted(ortho_dir.rglob("*.jpg")):
        webp = jpg.with_suffix(".webp")
        jpg_size = jpg.stat().st_size

        if webp.exists():
            # Already converted on a prior run; drop the stale .jpg.
            skipped += 1
            if not dry_run:
                jpg.unlink()
            continue

        bytes_before += jpg_size

        if dry_run:
            converted += 1
            continue

        with Image.open(jpg) as img:
            rgb = img.convert("RGB")
            buf = BytesIO()
            rgb.save(buf, format="WEBP", quality=quality)

        webp.write_bytes(buf.getvalue())
        bytes_after += webp.stat().st_size
        # Only remove the source now that the .webp is safely on disk.
        jpg.unlink()
        converted += 1

    return {
        "converted": converted,
        "skipped": skipped,
        "bytes_before": bytes_before,
        "bytes_after": bytes_after,
    }


def _fmt_bytes(n: int) -> str:
    step = 1024.0
    val = float(n)
    for unit in ("B", "KiB", "MiB", "GiB", "TiB"):
        if val < step:
            return f"{val:.1f} {unit}"
        val /= step
    return f"{val:.1f} PiB"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="golfpipe.reencode_webp",
        description="Re-encode an ortho tile tree from JPEG to WebP in place.",
    )
    parser.add_argument("tiles_root", help="course tile root (containing ortho/) or an ortho/ dir")
    parser.add_argument("--quality", type=int, default=DEFAULT_QUALITY, help=f"WebP quality (default {DEFAULT_QUALITY})")
    parser.add_argument("--dry-run", action="store_true", help="report what would change without writing/deleting")
    args = parser.parse_args(argv)

    ortho_dir = _resolve_ortho_dir(Path(args.tiles_root))
    try:
        summary = reencode_ortho_tree(ortho_dir, quality=args.quality, dry_run=args.dry_run)
    except FileNotFoundError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    prefix = "[dry-run] " if args.dry_run else ""
    before = summary["bytes_before"]
    after = summary["bytes_after"]
    if args.dry_run:
        savings = ""
    elif before > 0:
        pct = 100.0 * (before - after) / before
        savings = f" ({pct:+.1f}% vs JPEG)"
    else:
        savings = ""

    print(
        f"{prefix}ortho: {summary['converted']} converted, {summary['skipped']} skipped "
        f"(already webp); bytes {_fmt_bytes(before)} -> {_fmt_bytes(after)}{savings}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
