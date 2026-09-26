"""NVDB (Trafikverket's national road database) for fetch-roads.

OSM stays the road source — it has the cart paths, footpaths, service roads
and tracks NVDB never lists — but NVDB knows what OSM only guesses: the
measured carriageway width (`Vägbredd`), paved vs gravel (`Slitlager`) and a
road type (`Vägslag`) that tells a 3 m gravel lane from a 6 m county road.
At Vreta the OSM class table gave the `unclassified` lanes 5 m; NVDB measures
2.9-3.5 m. The two networks agree on geometry to a few decimetres (median
0.1-0.4 m), so OSM's centerlines are kept and NVDB lends its attributes.

Access is Trafikverket's open data API (api.trafikinfo.trafikverket.se,
"API Öppna Data"): one POST carrying one QUERY per object type, each filtered
to a SWEREF99 TM box. Needs a free API key (TRAFIKVERKET_API_KEY). Every NVDB
object type is the same shape: rows that each cover [Start_Measure,
End_Measure] (fractions) of one network element (`Element_Id`) and carry the
covered piece's 3D WKT. The network rows (`Vägtrafiknät`, with `Nättyp`
bilnät / cykelnät / gångnät) are the lines; the attribute rows are looked up
per element by measure.

Fusion (`fuse`), per OSM way with a centerline:

1. Sample the centerline every SAMPLE_STEP_M. A sample matches the nearest
   NVDB link within MATCH_M whose direction is within MATCH_ANGLE_DEG and
   whose network fits the way (roads and tracks ↔ bilnät, paths ↔
   cykel-/gångnät — a cycleway 5 m beside a street must not take the
   street's width).
2. A way with at least MIN_MATCH_FRACTION of its samples matched is the NVDB
   road: its width becomes the median measured `Bredd` of the matched
   samples (when at least half of them have one), else — only when OSM's own
   width is a class guess — the NVDB road-type default (VAGSLAG_WIDTH_M).
   Surface is the majority `Slitlager`. The corridor is re-buffered.
3. NVDB links (inside the clip area) that no OSM way runs along are added as
   their own roads (`source: nvdb`), extended MATCH_M back into the gap the
   match buffer cut so they reach the road they join.

Everything is offline-testable: the HTTP call is the `fetch` seam, parsing
and fusion are pure over hand-built rows.

LICENSING — Trafikverket's open data is CC0 1.0; NVDB-only roads carry
`license: CC0-1.0`. A fused road keeps OSM's geometry and so stays ODbL.
"""

from __future__ import annotations

import math
import statistics
from collections import Counter
from dataclasses import dataclass, field

from shapely import wkt as shapely_wkt
from shapely.geometry import LineString, Point
from shapely.geometry.base import BaseGeometry
from shapely.ops import substring, unary_union
from shapely.strtree import STRtree

API_URL = "https://api.trafikinfo.trafikverket.se/v2/data.json"
API_KEY_ENV = "TRAFIKVERKET_API_KEY"
LICENSE = "CC0-1.0"
ATTRIBUTION = "Vägdata: Trafikverket NVDB (CC0)"

SCHEMA_VERSION = "1.2"
GEOMETRY_FIELD = "Geometry.WKT-SWEREF99TM-3D"
# (object type, namespace) — the network first, then the attributes.
NETWORK_TYPE = "Vägtrafiknät"
WIDTH_TYPE = "Vägbredd"
SURFACE_TYPE = "Slitlager"
KIND_TYPE = "Vägslag"
OBJECT_TYPES: tuple[tuple[str, str], ...] = (
    (NETWORK_TYPE, "Vägdata.NVDB_DK_O"),
    (WIDTH_TYPE, "Vägdata.NVDB_DK_O"),
    (SURFACE_TYPE, "Vägdata.NVDB_DK_O"),
    (KIND_TYPE, "Vägdata.AGGREGAT_O"),
)
# Per QUERY. An inner square holds ~100 rows per type; hitting this means the
# area is far larger than a course and the result is truncated (reported).
QUERY_LIMIT = 5000

# Which NVDB networks an OSM road group may match.
NETWORKS_FOR_GROUP: dict[str, frozenset[str]] = {
    "road": frozenset({"bilnät"}),
    "track": frozenset({"bilnät"}),
    "path": frozenset({"cykelnät", "gångnät"}),
}
# Slitlager is generalised to two classes; a paved Swedish road is asphalt.
SURFACE_BY_SLITLAGER = {"belagd": "asphalt", "grus": "gravel"}

# Total carriageway width by Vägslag road type, for NVDB roads without a
# measured `Bredd`. From Vreta's measured widths (Småväg enkel standard
# 2.7-3.3 m, Småväg 3.0-3.5 m, Landsväg liten 6 m) and Trafikverket's
# design widths for the larger types.
VAGSLAG_WIDTH_M: dict[str, float] = {
    "Motorväg": 22.0,
    "Motortrafikled": 13.0,
    "Mötesfri väg": 13.0,
    "Landsväg": 8.0,
    "Landsväg liten": 6.0,
    "Småväg": 3.5,
    "Småväg enkel standard": 3.0,
    "Huvudgata": 8.0,
    "Lokalgata stor": 6.5,
    "Lokalgata liten": 5.0,
}
# The OSM highway class an NVDB-only road is labelled with.
VAGSLAG_HIGHWAY: dict[str, str] = {
    "Motorväg": "motorway",
    "Motortrafikled": "trunk",
    "Mötesfri väg": "trunk",
    "Landsväg": "secondary",
    "Landsväg liten": "tertiary",
    "Småväg": "unclassified",
    "Småväg enkel standard": "track",
    "Huvudgata": "secondary",
    "Lokalgata stor": "residential",
    "Lokalgata liten": "residential",
}
HIGHWAY_BY_NETWORK = {"bilnät": "unclassified", "cykelnät": "cycleway", "gångnät": "footway"}

MATCH_M = 6.0
MATCH_ANGLE_DEG = 30.0
SAMPLE_STEP_M = 2.0
MIN_MATCH_FRACTION = 0.5
# NVDB-only pieces shorter than this are junction slop, not missing roads.
MIN_ADDED_M = 25.0


class NvdbError(RuntimeError):
    pass


# ─── fetch ───────────────────────────────────────────────────────────────────

def build_request(api_key: str, box_3006: tuple[float, float, float, float]) -> str:
    """One REQUEST with a QUERY per OBJECT_TYPES entry, each the rows whose
    geometry intersects the SWEREF99 TM box (min_e, min_n, max_e, max_n),
    current (not deleted) rows only."""
    from xml.sax.saxutils import quoteattr

    e0, n0, e1, n1 = box_3006
    box = f"{e0:.1f} {n0:.1f}, {e1:.1f} {n1:.1f}"
    queries = "".join(
        f'<QUERY objecttype={quoteattr(name)} namespace={quoteattr(ns)} schemaversion="{SCHEMA_VERSION}" limit="{QUERY_LIMIT}">'
        f'<FILTER><AND><EQ name="Deleted" value="false"/>'
        f'<INTERSECTS name="{GEOMETRY_FIELD}" shape="box" value="{box}"/></AND></FILTER></QUERY>'
        for name, ns in OBJECT_TYPES
    )
    return f"<REQUEST><LOGIN authenticationkey={quoteattr(api_key)}/>{queries}</REQUEST>"


def fetch_nvdb(api_key: str, box_3006: tuple[float, float, float, float], *, url: str = API_URL, timeout: int = 120) -> dict[str, list[dict]]:
    """POSTs the request and returns {object type: rows}. The offline-test
    seam: tests pass a stub returning hand-built rows instead."""
    import requests

    body = build_request(api_key, box_3006)
    try:
        resp = requests.post(url, data=body.encode("utf-8"), headers={"Content-Type": "text/xml"}, timeout=timeout)
    except requests.RequestException as exc:
        raise NvdbError(f"NVDB request failed: {exc}") from exc
    return parse_response(resp.status_code, resp.text)


def parse_response(status: int, text: str) -> dict[str, list[dict]]:
    import json

    try:
        results = json.loads(text)["RESPONSE"]["RESULT"]
    except (ValueError, KeyError, TypeError):
        raise NvdbError(f"NVDB answered HTTP {status} with no RESULT: {text[:200]}") from None
    out: dict[str, list[dict]] = {}
    for (name, _), result in zip(OBJECT_TYPES, results):
        if "ERROR" in result:
            raise NvdbError(f"NVDB {name}: {result['ERROR'].get('MESSAGE', result['ERROR'])}")
        out[name] = result.get(name, [])
    if status >= 400:
        raise NvdbError(f"NVDB answered HTTP {status}")
    return out


# ─── the network ─────────────────────────────────────────────────────────────

@dataclass
class NvdbLink:
    element_id: str
    start: float  # element measure range this piece covers (fractions)
    end: float
    network: str  # bilnät | cykelnät | gångnät
    line: LineString  # EPSG:3006, 2D


@dataclass
class NvdbAttrs:
    width_m: float | None = None
    surface: str | None = None  # roads.PATH_SURFACES value (asphalt | gravel from Slitlager)
    kind: str | None = None  # Vägslag Typ


@dataclass
class NvdbNetwork:
    links: list[NvdbLink]
    # element id -> [(start, end, value)]
    widths: dict[str, list[tuple[float, float, float]]] = field(default_factory=dict)
    surfaces: dict[str, list[tuple[float, float, str]]] = field(default_factory=dict)
    kinds: dict[str, list[tuple[float, float, str]]] = field(default_factory=dict)
    truncated: list[str] = field(default_factory=list)

    def attrs_at(self, link: NvdbLink, point: Point) -> NvdbAttrs:
        """The attributes in force where `point` projects onto `link`."""
        frac = link.line.project(point, normalized=True) if link.line.length > 0 else 0.0
        m = link.start + (link.end - link.start) * frac
        return NvdbAttrs(
            width_m=_at(self.widths.get(link.element_id), m),
            surface=_at(self.surfaces.get(link.element_id), m),
            kind=_at(self.kinds.get(link.element_id), m),
        )


def _at(spans, m: float):
    if not spans:
        return None
    for start, end, value in spans:
        if start - 1e-9 <= m <= end + 1e-9:
            return value
    return None


def _current(row: dict, today: str) -> bool:
    if row.get("Deleted"):
        return False
    return str(row.get("Valid_From", "")) <= today < str(row.get("Valid_To", "9999-12-31"))


def _line(row: dict) -> LineString | None:
    raw = (row.get("Geometry") or {}).get("WKT-SWEREF99TM-3D")
    if not raw:
        return None
    try:
        geom = shapely_wkt.loads(raw)
    except Exception:  # noqa: BLE001 — a malformed row is skipped, not fatal
        return None
    if geom.geom_type != "LineString" or len(geom.coords) < 2:
        return None
    return LineString([(x, y) for x, y, *_ in geom.coords])


def _span(row: dict) -> tuple[float, float]:
    return float(row.get("Start_Measure", 0.0)), float(row.get("End_Measure", 1.0))


def build_network(rows: dict[str, list[dict]], *, today: str) -> NvdbNetwork:
    """{object type: rows} (as `fetch_nvdb` returns) -> the network with its
    attributes indexed by element."""
    links: list[NvdbLink] = []
    for row in rows.get(NETWORK_TYPE, []):
        line = _line(row) if _current(row, today) else None
        if line is None or line.length <= 0:
            continue
        start, end = _span(row)
        links.append(NvdbLink(str(row["Element_Id"]), start, end, str(row.get("Nättyp", "")), line))

    def spans(type_name: str, field_name: str, convert) -> dict[str, list]:
        out: dict[str, list] = {}
        for row in rows.get(type_name, []):
            if not _current(row, today) or row.get(field_name) is None:
                continue
            value = convert(row[field_name])
            if value is None:
                continue
            out.setdefault(str(row["Element_Id"]), []).append((*_span(row), value))
        return out

    def width(raw):
        try:
            w = float(raw)
        except (TypeError, ValueError):
            return None
        return w if 0.5 <= w <= 40.0 else None

    truncated = [name for name, _ in OBJECT_TYPES if len(rows.get(name, [])) >= QUERY_LIMIT]
    return NvdbNetwork(
        links=links,
        widths=spans(WIDTH_TYPE, "Bredd", width),
        surfaces=spans(SURFACE_TYPE, "Slitlagertyp", lambda v: SURFACE_BY_SLITLAGER.get(str(v).lower())),
        kinds=spans(KIND_TYPE, "Typ", lambda v: str(v) or None),
        truncated=truncated,
    )


# ─── fusion ──────────────────────────────────────────────────────────────────

def _bearing(line: LineString, at_m: float) -> float:
    a = line.interpolate(max(at_m - 1.0, 0.0))
    b = line.interpolate(min(at_m + 1.0, line.length))
    return math.degrees(math.atan2(b.y - a.y, b.x - a.x))


def _aligned(a_deg: float, b_deg: float, limit: float = MATCH_ANGLE_DEG) -> bool:
    d = abs((a_deg - b_deg) % 180.0)
    return min(d, 180.0 - d) <= limit


@dataclass
class FuseStats:
    matched: int = 0
    measured_width: int = 0
    kind_width: int = 0
    surface: int = 0
    added: int = 0
    added_m: float = 0.0


def fuse(ways: list, network: NvdbNetwork, *, clip: BaseGeometry | None = None) -> tuple[list, FuseStats]:
    """OSM RoadWays + the NVDB network -> the ways with NVDB widths/surfaces
    where they run along an NVDB link, plus NVDB-only roads (see the module
    doc). Returns new RoadWay objects; the input list is not modified."""
    from dataclasses import replace

    from golfpipe import roads as roads_mod

    stats = FuseStats()
    if not network.links:
        return list(ways), stats
    tree = STRtree([link.line for link in network.links])

    out = []
    for way in ways:
        line = way.centerline
        allowed = NETWORKS_FOR_GROUP.get(way.group, frozenset())
        if line is None or line.length <= 0 or not allowed:
            out.append(way)
            continue
        n = max(int(line.length // SAMPLE_STEP_M) + 1, 2)
        hits: list[tuple[NvdbLink, NvdbAttrs]] = []
        for i in range(n):
            at = line.length * i / (n - 1)
            pt = line.interpolate(at)
            heading = _bearing(line, at)
            best = None
            for idx in tree.query(pt.buffer(MATCH_M)):
                link = network.links[int(idx)]
                if link.network not in allowed:
                    continue
                d = link.line.distance(pt)
                if d > MATCH_M or not _aligned(heading, _bearing(link.line, link.line.project(pt))):
                    continue
                if best is None or d < best[0]:
                    best = (d, link)
            if best is not None:
                hits.append((best[1], network.attrs_at(best[1], pt)))
        if len(hits) < MIN_MATCH_FRACTION * n:
            out.append(way)
            continue

        stats.matched += 1
        width, width_source = way.width_m, way.width_source
        measured = [a.width_m for _, a in hits if a.width_m is not None]
        kinds = [a.kind for _, a in hits if a.kind in VAGSLAG_WIDTH_M]
        if len(measured) >= 0.5 * len(hits):
            width, width_source = statistics.median(measured), "nvdb"
            stats.measured_width += 1
        elif kinds and way.width_source == "class":
            width, width_source = VAGSLAG_WIDTH_M[Counter(kinds).most_common(1)[0][0]], "nvdb type"
            stats.kind_width += 1
        surfaces = [a.surface for _, a in hits if a.surface]
        surface = Counter(surfaces).most_common(1)[0][0] if surfaces else way.surface
        if surfaces:
            stats.surface += 1
        geometry = way.geometry
        if width != way.width_m:
            geometry = line.buffer(width / 2.0, quad_segs=roads_mod.BUFFER_QUAD_SEGS, cap_style="round", join_style="round")
        out.append(replace(
            way, width_m=width, width_source=width_source, geometry=geometry, surface=surface,
            nvdb_ids=sorted({link.element_id for link, _ in hits}),
        ))

    # NVDB links no OSM way runs along (any OSM class: a gravel road OSM
    # mis-tags as a path is still covered).
    osm_lines = [w.centerline for w in ways if w.centerline is not None]
    covered = unary_union(osm_lines).buffer(MATCH_M) if osm_lines else None
    for link in network.links:
        line = link.line if clip is None else link.line.intersection(clip)
        rest = line.difference(covered) if covered is not None else line
        for part in _lines(rest):
            if part.length < MIN_ADDED_M:
                continue
            # Grow back over the match buffer so the added road meets the
            # road it joins instead of stopping MATCH_M short of it.
            a = link.line.project(Point(part.coords[0]))
            b = link.line.project(Point(part.coords[-1]))
            lo, hi = sorted((a, b))
            grown = substring(link.line, max(lo - MATCH_M, 0.0), min(hi + MATCH_M, link.line.length))
            if clip is not None:
                grown = max(_lines(grown.intersection(clip)), key=lambda g: g.length, default=part)
            attrs = network.attrs_at(link, grown.interpolate(0.5, normalized=True))
            highway = (VAGSLAG_HIGHWAY.get(attrs.kind or "") if link.network == "bilnät" else None) \
                or HIGHWAY_BY_NETWORK.get(link.network, "unclassified")
            if attrs.width_m is not None:
                width, width_source = attrs.width_m, "nvdb"
            elif attrs.kind in VAGSLAG_WIDTH_M:
                width, width_source = VAGSLAG_WIDTH_M[attrs.kind], "nvdb type"
            else:
                width, width_source = roads_mod.CLASS_WIDTH_M.get(highway, roads_mod.CLASS_WIDTH_M["road"]), "class"
            out.append(roads_mod.RoadWay(
                osm_id=None, highway=highway, group=roads_mod.ROAD_GROUP.get(highway, "road"),
                width_m=width, width_source=width_source,
                geometry=grown.buffer(width / 2.0, quad_segs=roads_mod.BUFFER_QUAD_SEGS, cap_style="round", join_style="round"),
                centerline=grown, surface=attrs.surface, nvdb_ids=[link.element_id],
            ))
            stats.added += 1
            stats.added_m += grown.length
    return out, stats


def _lines(geom: BaseGeometry) -> list[LineString]:
    if geom.is_empty:
        return []
    if geom.geom_type == "LineString":
        return [geom]
    if geom.geom_type in ("MultiLineString", "GeometryCollection"):
        return [g for part in geom.geoms for g in _lines(part)]
    return []
