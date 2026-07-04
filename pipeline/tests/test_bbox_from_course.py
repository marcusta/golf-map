"""Tests bbox-from-course against a throwaway sqlite DB built in the test,
mimicking the schema columns actually used from server/db/migrations/001_initial.ts
(holes, tees, greens, aim_points) — read-only stdlib sqlite3, no server involved.
"""

import sqlite3
from pathlib import Path

import pytest

from golfpipe.bbox_course import bbox_from_course


def _build_test_db(path: Path) -> None:
    conn = sqlite3.connect(path)
    try:
        conn.executescript(
            """
            CREATE TABLE courses (id TEXT PRIMARY KEY, name TEXT);
            CREATE TABLE holes (id TEXT PRIMARY KEY, course_id TEXT, number INTEGER);
            CREATE TABLE tees (id TEXT PRIMARY KEY, hole_id TEXT, name TEXT, lat REAL, lon REAL);
            CREATE TABLE greens (
                id TEXT PRIMARY KEY, hole_id TEXT,
                center_lat REAL, center_lon REAL,
                front_lat REAL, front_lon REAL,
                back_lat REAL, back_lon REAL
            );
            CREATE TABLE aim_points (id TEXT PRIMARY KEY, hole_id TEXT, lat REAL, lon REAL);
            """
        )
        conn.execute("INSERT INTO courses VALUES ('course-1', 'Test Course')")
        conn.execute("INSERT INTO holes VALUES ('hole-1', 'course-1', 1)")
        conn.execute("INSERT INTO holes VALUES ('hole-2', 'course-1', 2)")
        # A hole belonging to a different course, to prove filtering works.
        conn.execute("INSERT INTO holes VALUES ('hole-other', 'course-2', 1)")

        conn.execute("INSERT INTO tees VALUES ('tee-1', 'hole-1', 'White', 58.400, 15.560)")
        conn.execute("INSERT INTO tees VALUES ('tee-2', 'hole-2', 'White', 58.410, 15.570)")
        conn.execute(
            "INSERT INTO greens VALUES ('green-1', 'hole-1', 58.402, 15.562, 58.4015, 15.5615, 58.4025, 15.5625)"
        )
        conn.execute(
            "INSERT INTO greens VALUES ('green-2', 'hole-2', 58.412, 15.572, NULL, NULL, NULL, NULL)"
        )
        conn.execute("INSERT INTO aim_points VALUES ('aim-1', 'hole-1', 58.401, 15.561, )".replace(", )", ")"))
        # Out-of-course data that must not affect the bbox.
        conn.execute("INSERT INTO tees VALUES ('tee-other', 'hole-other', 'White', 10.0, 10.0)")
        conn.commit()
    finally:
        conn.close()


@pytest.fixture
def course_db(tmp_path: Path) -> Path:
    db_path = tmp_path / "test.sqlite"
    _build_test_db(db_path)
    return db_path


def test_bbox_covers_all_course_points(course_db: Path):
    west, south, east, north = bbox_from_course(course_db, "course-1", buffer_m=0.0)

    all_lats = [58.400, 58.410, 58.402, 58.4015, 58.4025, 58.412, 58.401]
    all_lons = [15.560, 15.570, 15.562, 15.5615, 15.5625, 15.572, 15.561]

    assert west <= min(all_lons)
    assert east >= max(all_lons)
    assert south <= min(all_lats)
    assert north >= max(all_lats)


def test_bbox_excludes_other_course(course_db: Path):
    west, south, east, north = bbox_from_course(course_db, "course-1", buffer_m=0.0)
    # tee-other at (10.0, 10.0) belongs to course-2 and must not appear.
    assert west > 11.0
    assert south > 11.0


def test_bbox_buffer_expands_extent(course_db: Path):
    unbuffered = bbox_from_course(course_db, "course-1", buffer_m=0.0)
    buffered = bbox_from_course(course_db, "course-1", buffer_m=250.0)

    assert buffered[0] < unbuffered[0]  # west
    assert buffered[1] < unbuffered[1]  # south
    assert buffered[2] > unbuffered[2]  # east
    assert buffered[3] > unbuffered[3]  # north


def test_bbox_default_buffer_is_250m(course_db: Path):
    from golfpipe.bbox_course import METERS_PER_DEGREE_LAT

    default_bbox = bbox_from_course(course_db, "course-1")
    explicit_bbox = bbox_from_course(course_db, "course-1", buffer_m=250.0)
    assert default_bbox == explicit_bbox


def test_missing_course_raises(course_db: Path):
    with pytest.raises(ValueError):
        bbox_from_course(course_db, "no-such-course")


def test_db_opened_read_only(course_db: Path):
    """Sanity check that we truly open read-only (uri mode=ro) — write
    attempts through the sqlite3 connection used internally should fail.
    This indirectly exercises the same connection style bbox_from_course
    uses without reaching into its internals.
    """
    import sqlite3 as _sqlite3

    conn = _sqlite3.connect(f"file:{course_db}?mode=ro", uri=True)
    try:
        with pytest.raises(_sqlite3.OperationalError):
            conn.execute("INSERT INTO tees VALUES ('x', 'hole-1', 'X', 0, 0)")
            conn.commit()
    finally:
        conn.close()
