"""Lantmateriet STAC search + authenticated asset download.

Two STAC APIs are used:
  - elevation (DEM):  https://api.lantmateriet.se/stac-hojd/v1
  - orthophoto:       https://api.lantmateriet.se/stac-bild/v1

Both support anonymous *search*. Downloading the actual COG assets from
dl1.lantmateriet.se requires HTTP Basic auth with a free Lantmateriet
account (env vars LANTMATERIET_USER / LANTMATERIET_PASS). We cannot test
real downloads in this environment, so download logic here is exercised by
unit tests with a stubbed `requests` session rather than live network calls.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

import requests

DEM_STAC_URL = "https://api.lantmateriet.se/stac-hojd/v1"
ORTHO_STAC_URL = "https://api.lantmateriet.se/stac-bild/v1"

DEM_COLLECTION = "dtm-cog"
LIDAR_COLLECTION = "dsm-skoglig-copc"

# Basic-auth error surfaced to the user when credentials are missing. Kept as
# a constant so tests can assert on the exact message.
MISSING_CREDENTIALS_MSG = (
    "Lantmateriet download requires a free account. "
    "Set LANTMATERIET_USER and LANTMATERIET_PASS environment variables."
)


class MissingCredentialsError(RuntimeError):
    pass


@dataclass(frozen=True)
class StacAsset:
    href: str
    type: str | None = None


@dataclass(frozen=True)
class StacItem:
    id: str
    collection: str | None
    bbox: list[float]
    assets: dict[str, StacAsset]
    datetime: str | None = None

    @property
    def data_href(self) -> str:
        asset = self.assets.get("data")
        if asset is None:
            raise ValueError(f"STAC item {self.id!r} has no 'data' asset")
        return asset.href


def _parse_item(raw: dict) -> StacItem:
    assets = {
        name: StacAsset(href=a["href"], type=a.get("type"))
        for name, a in raw.get("assets", {}).items()
    }
    props = raw.get("properties", {}) or {}
    return StacItem(
        id=raw["id"],
        collection=raw.get("collection"),
        bbox=raw.get("bbox", []),
        assets=assets,
        datetime=props.get("datetime"),
    )


def search(
    stac_url: str,
    bbox: tuple[float, float, float, float],
    collections: Iterable[str] | None = None,
    limit: int = 10,
    session: requests.Session | None = None,
) -> list[StacItem]:
    """Anonymous STAC item search. bbox is (west, south, east, north) in WGS84.

    When `collections` is omitted, searches across all collections in the
    catalog (used for orthophoto, where coverage is split into many
    region/year collections rather than one canonical mosaic) — the API
    returns newest-first, which is what we want.
    """
    sess = session or requests
    params: dict[str, object] = {
        "bbox": ",".join(str(v) for v in bbox),
        "limit": limit,
    }
    if collections:
        params["collections"] = ",".join(collections)

    resp = sess.get(f"{stac_url}/search", params=params, timeout=30)
    resp.raise_for_status()
    data = resp.json()
    return [_parse_item(f) for f in data.get("features", [])]


def search_dem(
    bbox: tuple[float, float, float, float],
    limit: int = 10,
    session: requests.Session | None = None,
) -> list[StacItem]:
    return search(DEM_STAC_URL, bbox, collections=[DEM_COLLECTION], limit=limit, session=session)


def search_lidar(
    bbox: tuple[float, float, float, float],
    limit: int = 10,
    session: requests.Session | None = None,
) -> list[StacItem]:
    """Searches the classified lidar point-cloud collection (dsm-skoglig-copc)
    on the elevation STAC catalog. Items' 'data' asset is a COPC (cloud-
    optimized point cloud) .copc.laz file — see download_asset for fetching.
    """
    return search(DEM_STAC_URL, bbox, collections=[LIDAR_COLLECTION], limit=limit, session=session)


def search_ortho(
    bbox: tuple[float, float, float, float],
    limit: int = 10,
    session: requests.Session | None = None,
) -> list[StacItem]:
    """Search all orthophoto collections for bbox coverage.

    Lantmateriet's ortho catalog (stac-bild) is not one continuous mosaic —
    it's split into ~400 collections by municipality/region and capture
    year (e.g. orto-l2-2025, orto-l2-2023, ...). The search API already
    returns items newest-datetime-first, so taking items in returned order
    and de-duplicating by covered area gives the freshest available
    coverage without needing to special-case a "best" collection name.
    """
    return search(ORTHO_STAC_URL, bbox, collections=None, limit=limit, session=session)


def ortho_vintages(
    bbox: tuple[float, float, float, float],
    limit: int = 10,
    session: requests.Session | None = None,
) -> list[tuple[str, list[StacItem]]]:
    """Group ortho search results by collection (= capture vintage, e.g.
    orto-l2-2025), preserving the API's newest-first order. Returns
    [(collection, items), …] newest vintage first — used to fetch/compare the
    two most recent flights of an area (often different seasons)."""
    order: list[str] = []
    groups: dict[str, list[StacItem]] = {}
    for item in search_ortho(bbox, limit=limit, session=session):
        collection = item.collection or "unknown"
        if collection not in groups:
            groups[collection] = []
            order.append(collection)
        groups[collection].append(item)
    return [(c, groups[c]) for c in order]


def _credentials() -> tuple[str, str]:
    user = os.environ.get("LANTMATERIET_USER")
    password = os.environ.get("LANTMATERIET_PASS")
    if not user or not password:
        raise MissingCredentialsError(MISSING_CREDENTIALS_MSG)
    return user, password


def download_asset(
    href: str,
    dest: Path,
    session: requests.Session | None = None,
    chunk_size: int = 1 << 20,
) -> Path:
    """Downloads a STAC data asset with HTTP Basic auth.

    Raises MissingCredentialsError before making any request if
    LANTMATERIET_USER/LANTMATERIET_PASS are unset, per the spec ("fetch
    commands must fail with a clear message").
    """
    user, password = _credentials()
    sess = session or requests
    dest.parent.mkdir(parents=True, exist_ok=True)

    with sess.get(href, auth=(user, password), stream=True, timeout=120) as resp:
        resp.raise_for_status()
        with open(dest, "wb") as f:
            for chunk in resp.iter_content(chunk_size=chunk_size):
                if chunk:
                    f.write(chunk)
    return dest


def remote_content_length(
    href: str,
    session: requests.Session | None = None,
) -> int | None:
    """HEAD request (with basic auth) to read Content-Length, used to decide
    whether an already-downloaded file matches the remote size and can be
    skipped. Returns None if the server doesn't report a length.
    """
    user, password = _credentials()
    sess = session or requests
    resp = sess.head(href, auth=(user, password), timeout=30)
    resp.raise_for_status()
    length = resp.headers.get("Content-Length")
    return int(length) if length is not None else None


def download_asset_with_progress(
    href: str,
    dest: Path,
    session: requests.Session | None = None,
    chunk_size: int = 1 << 20,
    skip_if_present: bool = True,
    progress: bool = True,
) -> Path:
    """Like download_asset, but for large lidar point-cloud files:

    - Streams to disk showing byte-count progress (files here are
      hundreds of MB to low GB — a silent multi-minute download is
      indistinguishable from a hang otherwise).
    - If `skip_if_present` and dest already exists with a size matching
      the remote Content-Length, the download is skipped entirely (lets
      `fetch-lidar` be re-run safely without re-downloading gigabytes).

    Raises MissingCredentialsError before any request if credentials are
    missing, same as download_asset.
    """
    user, password = _credentials()
    sess = session or requests

    if skip_if_present and dest.exists():
        try:
            remote_size = remote_content_length(href, session=sess)
        except requests.RequestException:
            remote_size = None
        if remote_size is not None and dest.stat().st_size == remote_size:
            print(f"  {dest.name} already present ({remote_size:,} bytes), skipping download")
            return dest

    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp_dest = dest.with_suffix(dest.suffix + ".part")

    with sess.get(href, auth=(user, password), stream=True, timeout=120) as resp:
        resp.raise_for_status()
        total = resp.headers.get("Content-Length")
        total_bytes = int(total) if total is not None else None
        written = 0
        last_report = 0
        with open(tmp_dest, "wb") as f:
            for chunk in resp.iter_content(chunk_size=chunk_size):
                if not chunk:
                    continue
                f.write(chunk)
                written += len(chunk)
                if progress and written - last_report >= 50 * (1 << 20):
                    last_report = written
                    if total_bytes:
                        pct = 100.0 * written / total_bytes
                        print(f"  {dest.name}: {written / 1e6:,.0f} MB / {total_bytes / 1e6:,.0f} MB ({pct:.0f}%)")
                    else:
                        print(f"  {dest.name}: {written / 1e6:,.0f} MB")

    tmp_dest.replace(dest)
    if progress:
        print(f"  {dest.name}: done ({dest.stat().st_size:,} bytes)")
    return dest
