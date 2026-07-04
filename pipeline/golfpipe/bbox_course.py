"""Computes a WGS84 bbox for a course from its tees/greens/aim_points
coordinates, read directly from the server's SQLite DB (read-only, stdlib
sqlite3 — no server involvement, no ORM).

Schema reference (server/db/migrations/001_initial.ts):
  holes(id, course_id, ...)
  tees(id, hole_id, lat, lon, ...)
  greens(id, hole_id, center_lat, center_lon, front_lat, front_lon,
         back_lat, back_lon, ...)
  aim_points(id, hole_id, lat, lon, ...)
"""

from __future__ import annotations

import math
import sqlite3
from pathlib import Path

METERS_PER_DEGREE_LAT = 111_320.0


def _collect_points(conn: sqlite3.Connection, course_id: str) -> list[tuple[float, float]]:
    points: list[tuple[float, float]] = []

    cur = conn.execute(
        """
        SELECT t.lat, t.lon
        FROM tees t
        JOIN holes h ON h.id = t.hole_id
        WHERE h.course_id = ?
        """,
        (course_id,),
    )
    points.extend((row[0], row[1]) for row in cur.fetchall())

    cur = conn.execute(
        """
        SELECT g.center_lat, g.center_lon, g.front_lat, g.front_lon, g.back_lat, g.back_lon
        FROM greens g
        JOIN holes h ON h.id = g.hole_id
        WHERE h.course_id = ?
        """,
        (course_id,),
    )
    for center_lat, center_lon, front_lat, front_lon, back_lat, back_lon in cur.fetchall():
        points.append((center_lat, center_lon))
        if front_lat is not None and front_lon is not None:
            points.append((front_lat, front_lon))
        if back_lat is not None and back_lon is not None:
            points.append((back_lat, back_lon))

    cur = conn.execute(
        """
        SELECT a.lat, a.lon
        FROM aim_points a
        JOIN holes h ON h.id = a.hole_id
        WHERE h.course_id = ?
        """,
        (course_id,),
    )
    points.extend((row[0], row[1]) for row in cur.fetchall())

    return points


def bbox_from_course(
    db_path: Path, course_id: str, buffer_m: float = 250.0
) -> tuple[float, float, float, float]:
    """Returns (west, south, east, north) in WGS84 degrees, expanded by
    buffer_m metres in every direction.
    """
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        points = _collect_points(conn, course_id)
    finally:
        conn.close()

    if not points:
        raise ValueError(f"No coordinates found for course {course_id!r}")

    lats = [p[0] for p in points]
    lons = [p[1] for p in points]
    min_lat, max_lat = min(lats), max(lats)
    min_lon, max_lon = min(lons), max(lons)

    mean_lat = (min_lat + max_lat) / 2.0
    lat_buffer_deg = buffer_m / METERS_PER_DEGREE_LAT
    meters_per_degree_lon = METERS_PER_DEGREE_LAT * math.cos(math.radians(mean_lat))
    # Guard against polar degenerate cases (not realistic for golf courses,
    # but keeps this from dividing by ~0).
    meters_per_degree_lon = max(meters_per_degree_lon, 1.0)
    lon_buffer_deg = buffer_m / meters_per_degree_lon

    west = min_lon - lon_buffer_deg
    east = max_lon + lon_buffer_deg
    south = min_lat - lat_buffer_deg
    north = max_lat + lat_buffer_deg

    return (west, south, east, north)
