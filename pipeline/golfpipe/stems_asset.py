"""The tree-stems asset (tiles/<site>/tree-stems.json and the accepted photo stems' tree-stems-photo.json):
EPSG:3006, `fields` naming the columns of each `trees` row.

One reader for both gspro.py trees and golfpipe photo-stems, the one stem id format (`epsg3006:<x>:<y>`, 2
decimals: what the Unity planter keys a stem by, and what an accepted or skipped photo stem is remembered by)
and the photo stems' source tag. Light on purpose (json only): gspro.py imports it at the top.
"""
from __future__ import annotations

import json
from pathlib import Path

CRS = "EPSG:3006"
# The source of a stem found from its shadow in the summer photo (golfpipe photo-stems). The same wire value as
# PHOTO_STEM_SOURCE in server/services/photo-stems.service.ts.
PHOTO_SOURCE = "ortho-shadow"


class StemsAssetError(ValueError):
    pass


def stem_id(x: float, y: float) -> str:
    """The id of a stem at (x, y), EPSG:3006 metres."""
    return f"epsg3006:{x:.2f}:{y:.2f}"


def read_rows(path: Path) -> list[dict]:
    """Each row of a tree-stems asset as a dict keyed by its `fields`."""
    asset = json.loads(path.read_text(encoding="utf-8"))
    fields = asset.get("fields") or []
    if asset.get("crs") != CRS or not isinstance(asset.get("trees"), list) or "x" not in fields:
        raise StemsAssetError(f"{path} is not a tree-stems asset")
    return [dict(zip(fields, row)) for row in asset["trees"]]
