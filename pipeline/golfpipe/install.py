"""Copies generated tiles + manifest into the server's data directory
layout (data/tiles/{courseId}/{layer}/{z}/{x}/{y}.<ext>) and prints the
assets.register API payloads the next step (or a human) should POST to
/assets/register for each asset kind. Matches server/services/assets.service.ts
and server/api/assets.api.ts exactly:
  AssetKind = 'ortho_cog' | 'dem_cog' | 'svg_source' | 'tile_manifest'
  register input: { courseId, kind, filename, metaJson? }

We do not POST automatically by default (no session-cookie plumbing exists
in this pipeline); --api-url + --cookie are supported for convenience but
printing payloads is sufficient per spec.
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path

import requests

TILE_LAYERS = ("ortho", "terrain")


def _copy_tree(src: Path, dst: Path) -> None:
    if dst.exists():
        shutil.rmtree(dst)
    shutil.copytree(src, dst)


def install_course_tiles(
    course_id: str,
    data_dir: Path,
    ortho_dir: Path | None = None,
    terrain_dir: Path | None = None,
    hillshade_dir: Path | None = None,
    manifest_path: Path | None = None,
) -> dict[str, Path]:
    """Copies ortho_dir -> data/tiles/{courseId}/ortho,
    terrain_dir -> data/tiles/{courseId}/terrain,
    hillshade_dir -> data/tiles/{courseId}/hillshade, and manifest_path ->
    data/tiles/{courseId}/manifest.json. Any of them may be omitted.
    Returns a dict of layer/kind -> installed path.
    """
    course_root = data_dir / "tiles" / course_id
    installed: dict[str, Path] = {}

    if ortho_dir is not None:
        dst = course_root / "ortho"
        _copy_tree(ortho_dir, dst)
        installed["ortho"] = dst

    if terrain_dir is not None:
        dst = course_root / "terrain"
        _copy_tree(terrain_dir, dst)
        installed["terrain"] = dst

    if hillshade_dir is not None:
        dst = course_root / "hillshade"
        _copy_tree(hillshade_dir, dst)
        installed["hillshade"] = dst

    if manifest_path is not None:
        dst = course_root / "manifest.json"
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(manifest_path, dst)
        installed["manifest"] = dst

    return installed


def build_register_payloads(
    course_id: str,
    installed: dict[str, Path],
) -> list[dict]:
    """Builds the /assets/register payload(s) matching RegisterAssetInput:
    { courseId, kind, filename, metaJson? }. `filename` is the path
    relative to data_dir since that's what the server resolves tiles from.
    """
    payloads = []

    if "ortho" in installed:
        payloads.append({
            "courseId": course_id,
            "kind": "ortho_cog",
            "filename": f"tiles/{course_id}/ortho",
        })
    if "terrain" in installed:
        payloads.append({
            "courseId": course_id,
            "kind": "dem_cog",
            "filename": f"tiles/{course_id}/terrain",
        })
    if "manifest" in installed:
        payloads.append({
            "courseId": course_id,
            "kind": "tile_manifest",
            "filename": f"tiles/{course_id}/manifest.json",
        })

    return payloads


def post_payloads(
    payloads: list[dict],
    api_url: str,
    cookie: str | None = None,
    session: requests.Session | None = None,
) -> list[requests.Response]:
    sess = session or requests
    headers = {"Cookie": cookie} if cookie else {}
    responses = []
    for payload in payloads:
        resp = sess.post(f"{api_url.rstrip('/')}/assets/register", json=payload, headers=headers, timeout=30)
        responses.append(resp)
    return responses


def print_payloads(payloads: list[dict]) -> None:
    for payload in payloads:
        print(json.dumps(payload))
