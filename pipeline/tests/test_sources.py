"""Source recipe (sources.json): recording fetches, merging vintages, and
pinned refetch via --items. No network: stac search/download are stubbed."""

import json
from pathlib import Path

import pytest

from golfpipe import commands, sources, stac


def test_recipe_path_sits_next_to_output(tmp_path: Path):
    site = tmp_path / "sources" / "site-1"
    assert sources.recipe_path_for(site / "lidar") == site / "sources.json"
    assert sources.recipe_path_for(site / "ortho-orto-l2-2025.tif") == site / "sources.json"
    assert sources.recipe_path_for(site / "dem.tif") == site / "sources.json"


def test_record_fetch_merges_kinds_and_ortho_vintages(tmp_path: Path):
    path = tmp_path / "sources.json"
    bbox = (15.5, 58.3, 15.6, 58.4)
    sources.record_fetch(path, "lidar", collection="dsm-skoglig-copc", items=["b", "a"], bbox_wgs84=bbox, files=["b.copc.laz", "a.copc.laz"])
    sources.record_fetch(path, "ortho", collection="orto-l2-2025", items=["o1"], bbox_wgs84=bbox, files=["ortho-orto-l2-2025.tif"], buffer_m=250)
    sources.record_fetch(path, "ortho", collection="orto-l2-2023", items=["o2"], bbox_wgs84=bbox, files=["ortho-orto-l2-2023.tif"], buffer_m=250)
    # re-record one vintage: only that key changes
    recipe = sources.record_fetch(path, "ortho", collection="orto-l2-2025", items=["o1b"], bbox_wgs84=bbox, files=["ortho-orto-l2-2025.tif"], buffer_m=250)

    on_disk = json.loads(path.read_text())
    assert on_disk == recipe
    assert recipe["version"] == sources.RECIPE_VERSION
    assert recipe["bboxWgs84"] == [15.5, 58.3, 15.6, 58.4]
    assert recipe["lidar"]["items"] == ["a", "b"]
    assert recipe["lidar"]["files"] == ["a.copc.laz", "b.copc.laz"]
    assert set(recipe["orthos"]) == {"orto-l2-2025", "orto-l2-2023"}
    assert recipe["orthos"]["orto-l2-2025"]["items"] == ["o1b"]
    assert recipe["orthos"]["orto-l2-2023"]["items"] == ["o2"]
    assert recipe["orthos"]["orto-l2-2025"]["bufferM"] == 250
    assert recipe["lidar"]["fetchedAt"].endswith("Z")


def test_record_fetch_rejects_bad_input(tmp_path: Path):
    path = tmp_path / "sources.json"
    bbox = (0.0, 0.0, 1.0, 1.0)
    with pytest.raises(ValueError):
        sources.record_fetch(path, "ortho", collection=None, items=[], bbox_wgs84=bbox)
    with pytest.raises(ValueError):
        sources.record_fetch(path, "water", collection=None, items=[], bbox_wgs84=bbox)
    path.write_text(json.dumps({"version": 99}))
    with pytest.raises(ValueError, match="version"):
        sources.read_recipe(path)


def test_parse_items_arg():
    assert sources.parse_items_arg(None) is None
    assert sources.parse_items_arg("") is None
    assert sources.parse_items_arg(" a, b ,,c") == ["a", "b", "c"]


def test_search_passes_ids_and_raises_limit():
    class Resp:
        def raise_for_status(self): pass
        def json(self): return {"features": []}

    class Sess:
        def __init__(self): self.params = None
        def get(self, url, params=None, timeout=None):
            self.params = params
            return Resp()

    sess = Sess()
    stac.search("https://x", (0, 0, 1, 1), collections=["c"], limit=2, session=sess, ids=["i1", "i2", "i3"])
    assert sess.params["ids"] == "i1,i2,i3"
    assert sess.params["limit"] == 3
    assert sess.params["collections"] == "c"


def _item(id_: str, collection: str, href: str) -> stac.StacItem:
    return stac.StacItem(id=id_, collection=collection, bbox=[0, 0, 1, 1], assets={"data": stac.StacAsset(href=href)})


def test_fetch_lidar_records_recipe_and_pins_items(tmp_path: Path, monkeypatch):
    seen = {}

    def fake_search(bbox, limit=10, session=None, ids=None):
        seen["ids"] = ids
        return [_item("m21c011-647_53", stac.LIDAR_COLLECTION, "https://dl/m21c011-647_53.copc.laz")]

    def fake_download(href, dest, session=None):
        Path(dest).write_bytes(b"laz")
        return dest

    monkeypatch.setattr(stac, "search_lidar", fake_search)
    monkeypatch.setattr(stac, "download_asset_with_progress", fake_download)

    out_dir = tmp_path / "sources" / "site-1" / "lidar"
    bbox = (15.5, 58.3, 15.6, 58.4)
    got = commands.cmd_fetch_lidar(bbox, out_dir, out_dir, items=["m21c011-647_53"])

    assert seen["ids"] == ["m21c011-647_53"]
    assert [p.name for p in got] == ["m21c011-647_53.copc.laz"]
    recipe = json.loads((tmp_path / "sources" / "site-1" / "sources.json").read_text())
    assert recipe["lidar"] == {
        "collection": stac.LIDAR_COLLECTION,
        "items": ["m21c011-647_53"],
        "files": ["m21c011-647_53.copc.laz"],
        "fetchedAt": recipe["lidar"]["fetchedAt"],
    }
    assert recipe["bboxWgs84"] == [15.5, 58.3, 15.6, 58.4]


def test_fetch_ortho_records_selected_collection(tmp_path: Path, monkeypatch):
    def fake_search(bbox, limit=10, session=None, ids=None):
        return [_item("o-2025", "orto-l2-2025", "https://dl/o-2025.tif"), _item("o-2023", "orto-l2-2023", "https://dl/o-2023.tif")]

    def fake_download(href, dest, session=None):
        Path(dest).write_bytes(b"tif")
        return dest

    mosaicked = {}

    def fake_mosaic(paths, bbox, out, buffer_m=250):
        mosaicked["paths"] = [p.name for p in paths]
        Path(out).parent.mkdir(parents=True, exist_ok=True)
        Path(out).write_bytes(b"tif")

    monkeypatch.setattr(stac, "search_ortho", fake_search)
    monkeypatch.setattr(stac, "download_asset", fake_download)
    monkeypatch.setattr(commands, "mosaic_and_crop", fake_mosaic)
    monkeypatch.setattr(commands, "_drop_to_rgb_bands", lambda path: None)

    site = tmp_path / "sources" / "site-1"
    out = site / "ortho-orto-l2-2023.tif"
    commands.cmd_fetch_ortho((15.5, 58.3, 15.6, 58.4), tmp_path / "work", out, buffer_m=200, collection="orto-l2-2023")

    assert mosaicked["paths"] == ["o-2023.tif"]
    recipe = json.loads((site / "sources.json").read_text())
    assert list(recipe["orthos"]) == ["orto-l2-2023"]
    assert recipe["orthos"]["orto-l2-2023"]["items"] == ["o-2023"]
    assert recipe["orthos"]["orto-l2-2023"]["files"] == ["ortho-orto-l2-2023.tif"]
    assert recipe["orthos"]["orto-l2-2023"]["bufferM"] == 200
