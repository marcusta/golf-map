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
