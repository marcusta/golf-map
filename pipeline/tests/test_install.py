"""Partial-install semantics (T56): the fast re-terrain job installs ONLY
terrain + hillshade, so layers/manifest that are not passed must be left
exactly as previously installed (the ortho tree includes per-vintage subdirs
that a re-terrain must never disturb). Offline, tmpdir-only.
"""

from pathlib import Path

from golfpipe.install import build_register_payloads, install_course_tiles


def _write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def _full_install(tmp_path: Path, course: str = "site-1") -> tuple[Path, Path]:
    """A first full install: ortho (+ a per-vintage subdir added afterwards,
    as the map-build service does), terrain, hillshade, manifest."""
    src = tmp_path / "src-full"
    _write(src / "ortho" / "14" / "0" / "0.webp", "ortho-v1")
    _write(src / "terrain" / "12" / "0" / "0.png", "terrain-v1")
    _write(src / "hillshade" / "12" / "0" / "0.png", "hillshade-v1")
    _write(src / "manifest.json", '{"generatedAt": "v1"}')

    data_dir = tmp_path / "data"
    install_course_tiles(
        course,
        data_dir,
        ortho_dir=src / "ortho",
        terrain_dir=src / "terrain",
        hillshade_dir=src / "hillshade",
        manifest_path=src / "manifest.json",
    )
    root = data_dir / "tiles" / course
    # Simulate the post-install per-vintage tiling (ortho/<collection>/).
    _write(root / "ortho" / "orto-l2-2023" / "14" / "0" / "0.webp", "vintage-2023")
    return data_dir, root


def test_partial_install_replaces_only_the_given_layers(tmp_path: Path) -> None:
    data_dir, root = _full_install(tmp_path)

    # Re-terrain: fresh terrain + hillshade only.
    src = tmp_path / "src-reterrain"
    _write(src / "terrain" / "12" / "0" / "0.png", "terrain-v2")
    _write(src / "terrain" / "16" / "1" / "1.png", "terrain-v2-z16")
    _write(src / "hillshade" / "12" / "0" / "0.png", "hillshade-v2")

    installed = install_course_tiles(
        "site-1",
        data_dir,
        terrain_dir=src / "terrain",
        hillshade_dir=src / "hillshade",
    )

    assert set(installed) == {"terrain", "hillshade"}

    # The passed layers are REPLACED (old tree gone, new content in).
    assert (root / "terrain" / "12" / "0" / "0.png").read_text() == "terrain-v2"
    assert (root / "terrain" / "16" / "1" / "1.png").read_text() == "terrain-v2-z16"
    assert (root / "hillshade" / "12" / "0" / "0.png").read_text() == "hillshade-v2"

    # Everything omitted is untouched: ortho (flat + per-vintage) and manifest.
    assert (root / "ortho" / "14" / "0" / "0.webp").read_text() == "ortho-v1"
    assert (root / "ortho" / "orto-l2-2023" / "14" / "0" / "0.webp").read_text() == "vintage-2023"
    assert (root / "manifest.json").read_text() == '{"generatedAt": "v1"}'


def test_reinstalling_a_layer_drops_its_stale_tiles(tmp_path: Path) -> None:
    data_dir, root = _full_install(tmp_path)
    stale = root / "terrain" / "16" / "9" / "9.png"
    _write(stale, "stale-tile")

    src = tmp_path / "src-reterrain"
    _write(src / "terrain" / "12" / "0" / "0.png", "terrain-v2")
    install_course_tiles("site-1", data_dir, terrain_dir=src / "terrain")

    # copytree replaces the whole layer dir — stale coordinates disappear.
    assert not stale.exists()
    assert (root / "terrain" / "12" / "0" / "0.png").read_text() == "terrain-v2"


def test_register_payloads_cover_only_installed_kinds(tmp_path: Path) -> None:
    data_dir = tmp_path / "data"
    src = tmp_path / "src"
    _write(src / "terrain" / "12" / "0" / "0.png", "terrain")
    _write(src / "hillshade" / "12" / "0" / "0.png", "hillshade")

    installed = install_course_tiles(
        "site-1", data_dir, terrain_dir=src / "terrain", hillshade_dir=src / "hillshade"
    )
    payloads = build_register_payloads("site-1", installed)

    # No ortho/manifest installed -> no ortho_cog/tile_manifest payloads
    # (hillshade has no asset kind; it is referenced via the manifest).
    assert [p["kind"] for p in payloads] == ["dem_cog"]
