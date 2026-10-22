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
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

import requests

DEM_STAC_URL = "https://api.lantmateriet.se/stac-hojd/v1"
ORTHO_STAC_URL = "https://api.lantmateriet.se/stac-bild/v1"
# Open vector data (CC BY 4.0): per-kommun GeoPackage downloads. The
# Marktäcke collection is the Topografi 10 land-cover layer, which carries
# the water surfaces (objekttyp Sjö / Anlagt vatten / Vattendragsyta / Hav)
# used by fetch-water.
VEKTOR_STAC_URL = "https://api.lantmateriet.se/stac-vektor/v1"

DEM_COLLECTION = "dtm-cog"
LIDAR_COLLECTION = "dsm-skoglig-copc"
MARKTACKE_COLLECTION = "marktacke"

# Basic-auth error surfaced to the user when credentials are missing. Kept as
# a constant so tests can assert on the exact message.
MISSING_CREDENTIALS_MSG = (
    "Lantmateriet download requires a free account. "
    "Set LANTMATERIET_USER and LANTMATERIET_PASS environment variables."
)


# Times a dropped download is resumed before giving up.
DOWNLOAD_RETRIES = 8


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
    ids: Iterable[str] | None = None,
) -> list[StacItem]:
    """Anonymous STAC item search. bbox is (west, south, east, north) in WGS84.
    `ids` restricts the result to those item ids (STAC `ids` query parameter),
    used to refetch a pinned recipe instead of the newest coverage.

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
    if ids:
        ids = list(ids)
        params["ids"] = ",".join(ids)
        params["limit"] = max(limit, len(ids))

    resp = sess.get(f"{stac_url}/search", params=params, timeout=30)
    resp.raise_for_status()
    data = resp.json()
    return [_parse_item(f) for f in data.get("features", [])]


def search_dem(
    bbox: tuple[float, float, float, float],
    limit: int = 10,
    session: requests.Session | None = None,
    ids: Iterable[str] | None = None,
) -> list[StacItem]:
    return search(DEM_STAC_URL, bbox, collections=[DEM_COLLECTION], limit=limit, session=session, ids=ids)


def search_lidar(
    bbox: tuple[float, float, float, float],
    limit: int = 10,
    session: requests.Session | None = None,
    ids: Iterable[str] | None = None,
) -> list[StacItem]:
    """Searches the classified lidar point-cloud collection (dsm-skoglig-copc)
    on the elevation STAC catalog. Items' 'data' asset is a COPC (cloud-
    optimized point cloud) .copc.laz file — see download_asset for fetching.
    """
    return search(DEM_STAC_URL, bbox, collections=[LIDAR_COLLECTION], limit=limit, session=session, ids=ids)


def search_marktacke(
    bbox: tuple[float, float, float, float],
    limit: int = 10,
    session: requests.Session | None = None,
) -> list[StacItem]:
    """Searches the open vector catalog's Marktäcke collection (Topografi 10
    land cover, kommun-split GeoPackages inside zip assets — one item per
    kommun). Items' 'data' asset is an application/zip containing the
    kommun's .gpkg; see golfpipe.water for reading water features out of it.
    """
    return search(VEKTOR_STAC_URL, bbox, collections=[MARKTACKE_COLLECTION], limit=limit, session=session)


def search_ortho(
    bbox: tuple[float, float, float, float],
    limit: int = 10,
    session: requests.Session | None = None,
    ids: Iterable[str] | None = None,
) -> list[StacItem]:
    """Search all orthophoto collections for bbox coverage.

    Lantmateriet's ortho catalog (stac-bild) is not one continuous mosaic —
    it's split into ~400 collections by municipality/region and capture
    year (e.g. orto-l2-2025, orto-l2-2023, ...). The search API already
    returns items newest-datetime-first, so taking items in returned order
    and de-duplicating by covered area gives the freshest available
    coverage without needing to special-case a "best" collection name.
    """
    return search(ORTHO_STAC_URL, bbox, collections=None, limit=limit, session=session, ids=ids)


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
    _credentials()
    # The same resuming download as the lidar's: dl1 drops orthophoto streams too
    # (Landeryd 2026-10-21: two map builds failed on 700 MB 2023 photos at 230-580 MB).
    return download_asset_with_progress(href, dest, session=session, chunk_size=chunk_size,
                                        skip_if_present=False, progress=False)


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

    # dl1 drops long streams now and then (IncompleteRead after a few hundred
    # MB). Keep the .part and resume it with a Range request — also across
    # runs, so a re-run after a failure carries on where the last one stopped.
    attempt = 0
    while True:
        written = tmp_dest.stat().st_size if tmp_dest.exists() else 0
        headers = {"Range": f"bytes={written}-"} if written else None
        try:
            with sess.get(href, auth=(user, password), stream=True, timeout=120, headers=headers) as resp:
                if resp.status_code == 416:
                    # The .part already holds the whole file (or is bogus): start over.
                    tmp_dest.unlink()
                    continue
                resp.raise_for_status()
                if written and resp.status_code != 206:
                    written = 0  # server ignored the Range: full body follows
                length = resp.headers.get("Content-Length")
                total_bytes = written + int(length) if length is not None else None
                if written and progress:
                    print(f"  {dest.name}: resuming at {written / 1e6:,.0f} MB")
                last_report = written
                with open(tmp_dest, "ab" if written else "wb") as f:
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
            if total_bytes is not None and written < total_bytes:
                raise requests.ConnectionError(f"stream ended at {written:,} of {total_bytes:,} bytes")
            break
        except (requests.ConnectionError, requests.Timeout, requests.exceptions.ChunkedEncodingError) as exc:
            attempt += 1
            if attempt > DOWNLOAD_RETRIES:
                raise
            wait = min(60, 5 * attempt)
            print(f"  {dest.name}: connection lost ({exc.__class__.__name__}); retry {attempt}/{DOWNLOAD_RETRIES} in {wait} s")
            time.sleep(wait)

    tmp_dest.replace(dest)
    if progress:
        print(f"  {dest.name}: done ({dest.stat().st_size:,} bytes)")
    return dest
