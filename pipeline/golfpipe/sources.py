"""Source recipe: `sources/<siteId>/sources.json` records what the fetch
commands downloaded (STAC collection + item ids, bbox, buffer) so another
machine can fetch the same bytes with `--items` instead of searching for
the newest coverage. See docs/feature-site-transfer.md section 4.

The file is merged, never replaced: each fetch overwrites only its own key
(`lidar`, `dem`, or `orthos.<collection>`)."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

RECIPE_NAME = "sources.json"
RECIPE_VERSION = 1


def recipe_path_for(output: Path) -> Path:
    """The recipe sits next to the fetch output: `sources/<site>/sources.json`.
    fetch-lidar writes into `sources/<site>/lidar/`, so its recipe is one
    level up; fetch-ortho/fetch-dem write files directly into `sources/<site>/`."""
    output = Path(output)
    parent = output.parent if output.suffix else output.parent
    return parent / RECIPE_NAME


def read_recipe(path: Path) -> dict:
    path = Path(path)
    if not path.exists():
        return {"version": RECIPE_VERSION}
    data = json.loads(path.read_text(encoding="utf-8"))
    if data.get("version") != RECIPE_VERSION:
        raise ValueError(f"Unsupported sources recipe version {data.get('version')!r} in {path}")
    return data


def _now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def record_fetch(
    path: Path,
    kind: str,
    *,
    collection: str | None,
    items: list[str],
    bbox_wgs84: tuple[float, float, float, float],
    files: list[str] | None = None,
    buffer_m: float | None = None,
) -> dict:
    """Merge one fetch into the recipe at `path`. `kind` is 'lidar', 'dem' or
    'ortho'; ortho entries are keyed by collection under `orthos` so several
    vintages coexist. Returns the merged recipe."""
    recipe = read_recipe(path)
    entry: dict = {
        "collection": collection,
        "items": sorted(items),
        "fetchedAt": _now_iso(),
    }
    if files is not None:
        entry["files"] = sorted(files)
    if buffer_m is not None:
        entry["bufferM"] = buffer_m
    recipe["bboxWgs84"] = [round(v, 7) for v in bbox_wgs84]
    if kind == "ortho":
        if not collection:
            raise ValueError("ortho fetch needs a collection to record")
        recipe.setdefault("orthos", {})[collection] = entry
    elif kind in ("lidar", "dem"):
        recipe[kind] = entry
    else:
        raise ValueError(f"unknown fetch kind {kind!r}")
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(json.dumps(recipe, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return recipe


def parse_items_arg(value: str | None) -> list[str] | None:
    """`--items a,b,c` -> ['a', 'b', 'c']; None/empty -> None (search instead)."""
    if not value:
        return None
    items = [v.strip() for v in value.split(",") if v.strip()]
    return items or None
