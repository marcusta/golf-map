"""OSM golf + terrain features from the Overpass API (fetch-osm).

Overpass serves OpenStreetMap geometry for a bbox; this module turns the
golf / land-cover polygons it returns into the same EPSG:3006 typed-GeoJSON
draft the web import wizard consumes (shared convention with fetch-water and
detect-trees: a FeatureCollection with a legacy `crs` member and a
`properties.type` naming an app feature type).

Everything here is offline-testable: the HTTP call lives behind one seam
(`fetch_overpass`, stdlib urllib only), and assembly/classification are pure
functions over the Overpass JSON that pytest fixtures hand-build. The
WGS84→EPSG:3006 reprojection is injected as a callable so this module needs
no rasterio import (the command wires in `rasterio.warp.transform`).

LICENSING — OSM is ODbL (Open Database License): attribution *and*
share-alike apply to any derived database. Every emitted feature therefore
carries provenance properties (`source`, `osm_type`, `osm_id`, `fetched`)
and the collection carries a top-level `attribution` field. `CourseFeature`
has no provenance column and — per the T44 brief — must not gain one here;
durable provenance/attribution before any public distribution of
OSM-derived course data is a flagged wave-level decision.
"""

from __future__ import annotations

import json
import re
from typing import Callable, Iterable

from golfpipe.water import GEOJSON_CRS_3006, SWEREF99_TM_SRID, write_geojson  # noqa: F401  (re-exported for callers)

OVERPASS_URL = "https://overpass-api.de/api/interpreter"

# Sent as User-Agent so Overpass can identify the client (its usage policy
# asks for a descriptive UA rather than the default urllib one).
USER_AGENT = "golf-map-pipeline/1.0 (fetch-osm)"

ATTRIBUTION = "© OpenStreetMap contributors, ODbL (opendatacommons.org/licenses/odbl)"

# A reproject callable maps parallel lon/lat sequences to EPSG:3006
# easting/northing sequences (e.g. rasterio.warp.transform bound to 4326→3006).
Reproject = Callable[[list[float], list[float]], tuple[Iterable[float], Iterable[float]]]


class OsmError(RuntimeError):
    def __init__(self, message: str, *, transient: bool = False):
        super().__init__(message)
        # Worth retrying: the public instance was busy (429/502/503/504) or
        # slow (timeout), not the query being wrong.
        self.transient = transient


# HTTP statuses a busy Overpass instance answers with. Under load
# overpass-api.de turns requests away at random — tiny and large queries
# alike (measured 2026-09-24: 2 of 6 identical requests got through, each
# answer or refusal in 5-12 s) — so a retry of the same request is what
# helps, not splitting the area into more requests.
TRANSIENT_HTTP = frozenset({429, 502, 503, 504})
# Stop starting new attempts after this long. At a 1-in-3 success rate that
# is ~6 attempts, ~90 % to get through; the app's Fetch buttons wait for it
# (dev:server REQUEST_TIMEOUT is 300 s, the VPS 900 s).
RETRY_BUDGET_S = 60.0
RETRY_PAUSE_S = 2.0


_METRES_RE = re.compile(r"^\s*(\d+(?:[.,]\d+)?)\s*(?:m|meter|metres|meters)?\s*$", re.IGNORECASE)


def parse_metres(raw, lo: float, hi: float) -> float | None:
    """An OSM length tag (`width`, `height`, …) as metres: "3", "3.5", "3,5",
    "4 m" parse; "narrow", feet, "3 lanes" and values outside [lo, hi]
    (mis-tags: a "30" km/h, a "0.3" kerb) give None.
    """
    if raw is None:
        return None
    m = _METRES_RE.match(str(raw))
    if not m:
        return None
    value = float(m.group(1).replace(",", "."))
    return value if lo <= value <= hi else None


def classify_osm_tags(tags: dict) -> str | None:
    """Maps an OSM element's tags to an app FEATURE_TYPE, or None when the
    element is not a golf/terrain polygon we import (linear ways, cartpaths,
    clubhouses, …). Golf tags win over land-cover tags.
    """
    if not tags:
        return None
    golf = tags.get("golf")
    if golf is not None:
        return {
            "green": "green",
            "tee": "tee",
            "fairway": "fairway",
            "bunker": "bunker",
            "rough": "rough",
            "water_hazard": "water",
            "lateral_water_hazard": "water",
        }.get(golf)
    if tags.get("natural") == "water":
        return "water"
    if tags.get("natural") == "wood" or tags.get("landuse") == "forest":
        return "trees"
    return None


def build_overpass_query(bbox_wgs84: tuple[float, float, float, float]) -> str:
    """Builds an Overpass QL query for golf + land-cover features in bbox
    (west, south, east, north WGS84). `out geom;` inlines each way/relation
    member's coordinates so no separate node resolution is needed.
    """
    west, south, east, north = bbox_wgs84
    b = f"{south},{west},{north},{east}"  # Overpass bbox is (S,W,N,E)
    selectors = [
        'way["golf"]',
        'relation["golf"]',
        'way["natural"="water"]',
        'relation["natural"="water"]',
        'way["natural"="wood"]',
        'relation["natural"="wood"]',
        'way["landuse"="forest"]',
        'relation["landuse"="forest"]',
    ]
    body = "".join(f"  {sel}({b});\n" for sel in selectors)
    return f"[out:json][timeout:180];\n(\n{body});\nout geom;"


def fetch_overpass(query: str, *, url: str = OVERPASS_URL, timeout: int = 180) -> dict:
    """POSTs an Overpass QL query and returns the parsed JSON. Stdlib urllib
    only (the offline-test seam: pytest passes a stub in place of this).
    """
    import urllib.error
    import urllib.parse
    import urllib.request

    data = urllib.parse.urlencode({"data": query}).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raise OsmError(f"Overpass request to {url} failed: {exc}", transient=exc.code in TRANSIENT_HTTP) from exc
    except urllib.error.URLError as exc:
        raise OsmError(f"Overpass request to {url} failed: {exc}", transient=isinstance(exc.reason, TimeoutError)) from exc
    except TimeoutError as exc:
        raise OsmError(f"Overpass request to {url} timed out after {timeout} s", transient=True) from exc


def with_retries(fetch, *, budget_s: float = RETRY_BUDGET_S, pause_s: float = RETRY_PAUSE_S, sleep=None, clock=None):
    """Wraps an Overpass fetch (fetch_overpass or a test stub) so a transient
    OsmError is retried after `pause_s` until `budget_s` has passed since the
    first attempt; the last error is raised with the attempt count. Other
    errors pass straight through."""
    import time

    sleep = sleep or time.sleep
    clock = clock or time.monotonic

    def fetch_retrying(query: str, *, url: str = OVERPASS_URL) -> dict:
        start = clock()
        attempt = 0
        while True:
            attempt += 1
            try:
                return fetch(query, url=url)
            except OsmError as exc:
                if not exc.transient or clock() - start + pause_s >= budget_s:
                    if attempt == 1:
                        raise
                    raise OsmError(f"{exc} ({attempt} attempts over {clock() - start:.0f} s — Overpass is busy, try again in a while)",
                                   transient=exc.transient) from exc
                print(f"Overpass busy ({exc}), retrying ...")
                sleep(pause_s)

    return fetch_retrying


# ─── ring assembly ───────────────────────────────────────────────────────────

def _way_points(geometry: list[dict]) -> list[tuple[float, float]]:
    """Overpass `out geom` way geometry ([{lat, lon}, …]) → [(lon, lat), …]."""
    return [(pt["lon"], pt["lat"]) for pt in geometry if "lon" in pt and "lat" in pt]


def _pt_eq(a: tuple[float, float], b: tuple[float, float]) -> bool:
    return round(a[0], 7) == round(b[0], 7) and round(a[1], 7) == round(b[1], 7)


def _closed(ring: list[tuple[float, float]]) -> bool:
    return len(ring) >= 4 and _pt_eq(ring[0], ring[-1])


def _close(ring: list[tuple[float, float]]) -> list[tuple[float, float]] | None:
    """Returns a closed ring (first == last, ≥ 4 points), auto-closing an
    open one, or None if there aren't enough distinct points for a polygon.
    """
    if len(ring) < 3:
        return None
    closed = ring if _pt_eq(ring[0], ring[-1]) else [*ring, ring[0]]
    return closed if len(closed) >= 4 else None


def stitch_rings(ways: list[list[tuple[float, float]]]) -> list[list[tuple[float, float]]]:
    """Stitches multipolygon member ways (each a run of (lon, lat) points)
    into closed rings by matching shared endpoints. Ways may arrive split
    and in any direction; dangling chains that never close are dropped.
    """
    segments = [list(w) for w in ways if len(w) >= 2]
    rings: list[list[tuple[float, float]]] = []
    while segments:
        chain = segments.pop(0)
        extended = True
        while extended and not _pt_eq(chain[0], chain[-1]):
            extended = False
            for i, seg in enumerate(segments):
                if _pt_eq(chain[-1], seg[0]):
                    chain = chain + seg[1:]
                elif _pt_eq(chain[-1], seg[-1]):
                    chain = chain + list(reversed(seg))[1:]
                elif _pt_eq(chain[0], seg[-1]):
                    chain = seg[:-1] + chain
                elif _pt_eq(chain[0], seg[0]):
                    chain = list(reversed(seg))[:-1] + chain
                else:
                    continue
                segments.pop(i)
                extended = True
                break
        if _closed(chain):
            rings.append(chain)
    return rings


def _reproject_ring(ring_lonlat: list[tuple[float, float]], reproject: Reproject) -> list[tuple[float, float]]:
    lons = [p[0] for p in ring_lonlat]
    lats = [p[1] for p in ring_lonlat]
    xs, ys = reproject(lons, lats)
    return list(zip((float(x) for x in xs), (float(y) for y in ys)))


def _rings_to_polygons(outer_rings, inner_rings):
    """Builds shapely Polygons (EPSG:3006) — one per outer ring — assigning
    each inner ring as a hole of the outer ring that contains it.
    """
    from shapely.geometry import Polygon

    outers = [Polygon(r) for r in outer_rings]
    holes: list[list] = [[] for _ in outers]
    for inner in inner_rings:
        try:
            point = Polygon(inner).representative_point()
        except Exception:
            continue
        for i, outer in enumerate(outers):
            if outer.covers(point):
                holes[i].append(inner)
                break
    return [
        Polygon(outer_rings[i], holes[i]) if holes[i] else outers[i]
        for i in range(len(outers))
    ]


def _polygon_coordinates(polygon, ndigits: int = 2) -> list[list[list[float]]]:
    def ring(coords):
        return [[round(x, ndigits), round(y, ndigits)] for x, y, *_ in coords]

    return [ring(polygon.exterior.coords)] + [ring(i.coords) for i in polygon.interiors]


def assemble_features(
    overpass_json: dict,
    reproject: Reproject,
) -> tuple[list[dict], list[str]]:
    """Turns Overpass `out geom` JSON into (features, skipped):

    - Closed ways whose tags classify → one Polygon feature (no holes).
    - `type=multipolygon` relations whose tags classify → member ways
      stitched into outer/inner rings, one Polygon per outer ring, inners
      as holes.

    Each feature dict carries the reprojected shapely Polygon (EPSG:3006)
    plus its type + provenance; `skipped` collects human-readable notes for
    everything ignored (unclassified tags, non-closed geometry, empty rings).
    """
    features: list[dict] = []
    skipped: list[str] = []

    for element in overpass_json.get("elements", []):
        etype = element.get("type")
        eid = element.get("id")
        ftype = classify_osm_tags(element.get("tags", {}))

        if etype == "way":
            if ftype is None:
                continue  # unclassified / linear way — silently common, not logged
            ring = _close(_way_points(element.get("geometry", [])))
            if ring is None:
                skipped.append(f"way/{eid}: {ftype} way is not a closed ring")
                continue
            polygon = _rings_to_polygons([_reproject_ring(ring, reproject)], [])[0]
            features.append(_feature(ftype, "way", eid, polygon))

        elif etype == "relation":
            if ftype is None:
                continue
            outer_ways = []
            inner_ways = []
            for member in element.get("members", []):
                if member.get("type") != "way" or not member.get("geometry"):
                    continue
                pts = _way_points(member["geometry"])
                if member.get("role") == "inner":
                    inner_ways.append(pts)
                else:  # "outer" or unrolled
                    outer_ways.append(pts)
            outer_rings = [_reproject_ring(r, reproject) for r in stitch_rings(outer_ways)]
            inner_rings = [_reproject_ring(r, reproject) for r in stitch_rings(inner_ways)]
            if not outer_rings:
                skipped.append(f"relation/{eid}: {ftype} relation has no closed outer ring")
                continue
            for polygon in _rings_to_polygons(outer_rings, inner_rings):
                features.append(_feature(ftype, "relation", eid, polygon))

    return features, skipped


def _feature(ftype: str, osm_type: str, osm_id, polygon) -> dict:
    return {"type": ftype, "osm_type": osm_type, "osm_id": osm_id, "polygon": polygon}


def build_osm_geojson(features: list[dict], *, fetch_date: str) -> dict:
    """Builds the EPSG:3006 FeatureCollection from assemble_features output.
    Each feature gets `properties.type` + ODbL provenance
    (source/osm_type/osm_id/fetched); the collection carries the top-level
    ODbL `attribution` string.
    """
    out_features: list[dict] = []
    for feat in features:
        polygon = feat["polygon"]
        if polygon.is_empty:
            continue
        out_features.append({
            "type": "Feature",
            "properties": {
                "type": feat["type"],
                "source": "osm",
                "osm_type": feat["osm_type"],
                "osm_id": feat["osm_id"],
                "fetched": fetch_date,
            },
            "geometry": {"type": "Polygon", "coordinates": _polygon_coordinates(polygon)},
        })
    return {
        "type": "FeatureCollection",
        "crs": GEOJSON_CRS_3006,
        "attribution": ATTRIBUTION,
        "features": out_features,
    }
