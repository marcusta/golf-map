from pathlib import Path

from golfpipe.commands import cmd_tile_ortho, cmd_tile_terrain
from golfpipe.manifest import ATTRIBUTION, build_manifest, write_manifest


def test_manifest_fields(tmp_path: Path, synthetic_dem: Path, synthetic_ortho: Path):
    ortho_dir = tmp_path / "ortho"
    terrain_dir = tmp_path / "terrain"
    cmd_tile_ortho(synthetic_ortho, ortho_dir, minzoom=15, maxzoom=16)
    cmd_tile_terrain(synthetic_dem, terrain_dir, minzoom=14, maxzoom=15)

    manifest = build_manifest(
        "course-123",
        ortho_tiles_dir=ortho_dir,
        terrain_tiles_dir=terrain_dir,
        dem_path=synthetic_dem,
    )

    assert manifest["courseId"] == "course-123"
    assert manifest["attribution"] == ATTRIBUTION
    assert manifest["attribution"] == "© Lantmäteriet, CC BY 4.0"

    assert manifest["layers"]["ortho"] == {"minzoom": 15, "maxzoom": 16}
    assert manifest["layers"]["terrain"] == {"minzoom": 14, "maxzoom": 15}

    assert manifest["bounds"] is not None
    for key in ("west", "south", "east", "north"):
        assert key in manifest["bounds"]
    assert manifest["bounds"]["west"] < manifest["bounds"]["east"]
    assert manifest["bounds"]["south"] < manifest["bounds"]["north"]

    # Synthetic DEM gradient is 100..150 m.
    assert manifest["elevation"]["min"] >= 99.0
    assert manifest["elevation"]["max"] <= 151.0

    assert manifest["generatedAt"].endswith("Z")


def test_manifest_omits_missing_layers(tmp_path: Path, synthetic_dem: Path):
    manifest = build_manifest("course-abc", dem_path=synthetic_dem)
    assert manifest["layers"] == {}
    assert manifest["bounds"] is not None


def test_write_manifest_round_trips_json(tmp_path: Path, synthetic_dem: Path):
    manifest = build_manifest("course-xyz", dem_path=synthetic_dem)
    out_path = tmp_path / "manifest.json"
    write_manifest(manifest, out_path)

    import json

    loaded = json.loads(out_path.read_text(encoding="utf-8"))
    assert loaded == manifest


def test_cmd_manifest_merges_into_existing_and_bumps_generated_at(tmp_path: Path, synthetic_dem: Path):
    """iOS keys its tile cache on generatedAt: re-running `manifest` over an
    existing manifest.json must move it forward and keep server-written
    fields, and must not overwrite an existing .bak."""
    import json

    from golfpipe.commands import cmd_manifest, cmd_tile_terrain

    tiles = tmp_path / "tiles"
    cmd_tile_terrain(synthetic_dem, tiles / "terrain", minzoom=14, maxzoom=15)
    target = tiles / "manifest.json"
    target.write_text(json.dumps({
        "courseId": "c1",
        "layers": {"ortho": {"minzoom": 14, "maxzoom": 20}},
        "generatedAt": "2020-01-01T00:00:00Z",
        "activeOrtho": "orto-l2-2025", "builtOrtho": "orto-l2-2025",
    }))
    (tiles / "manifest.json.bak").write_text("older backup")

    cmd_manifest("c1", tiles, dem_path=synthetic_dem)

    written = json.loads(target.read_text())
    assert written["layers"] == {"ortho": {"minzoom": 14, "maxzoom": 20}, "terrain": {"minzoom": 14, "maxzoom": 15}}
    assert written["generatedAt"] > "2020-01-01T00:00:00Z" and written["generatedAt"].endswith("Z")
    assert written["activeOrtho"] == "orto-l2-2025" and written["builtOrtho"] == "orto-l2-2025"
    assert written["elevation"]["min"] >= 99.0
    assert (tiles / "manifest.json.bak").read_text() == "older backup"
    assert json.loads((tiles / "manifest.json.bak2").read_text())["generatedAt"] == "2020-01-01T00:00:00Z"


def test_merge_manifest_layers_always_bumps_generated_at():
    from golfpipe.manifest import merge_manifest_layers, next_backup_path

    existing = {"courseId": "c", "layers": {}, "generatedAt": "2020-01-01T00:00:00Z"}
    merged = merge_manifest_layers(existing, {"courseId": "c", "layers": {}})
    assert merged["generatedAt"] > "2020-01-01T00:00:00Z"
    assert next_backup_path(Path("/nonexistent/manifest.json")) == Path("/nonexistent/manifest.json.bak")
