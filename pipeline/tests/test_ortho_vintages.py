"""ortho vintage grouping — newest-first, grouped by collection. No network."""

import json

from golfpipe import stac, commands


def _item(item_id, collection, date):
    return stac.StacItem(
        id=item_id, collection=collection, bbox=[15.5, 58.5, 15.6, 58.6],
        assets={"data": stac.StacAsset(href=f"https://x/{item_id}.tif")},
        datetime=f"{date}T10:00:00Z",
    )


# search_ortho returns items newest-first, possibly several per collection.
FAKE_ITEMS = [
    _item("a1", "orto-l2-2025", "2025-05-01"),
    _item("a2", "orto-l2-2025", "2025-05-01"),
    _item("b1", "orto-l2-2023", "2023-08-15"),
    _item("c1", "orto-l2-2021", "2021-06-10"),
]


def test_ortho_vintages_groups_newest_first(monkeypatch):
    monkeypatch.setattr(stac, "search_ortho", lambda bbox, **kw: FAKE_ITEMS)
    vintages = stac.ortho_vintages((15.5, 58.5, 15.6, 58.6))

    assert [c for c, _ in vintages] == ["orto-l2-2025", "orto-l2-2023", "orto-l2-2021"]
    assert len(vintages[0][1]) == 2  # two tiles in the newest vintage


def test_list_ortho_vintages_prints_json(monkeypatch, capsys):
    monkeypatch.setattr(stac, "search_ortho", lambda bbox, **kw: FAKE_ITEMS)
    commands.cmd_list_ortho_vintages((15.5, 58.5, 15.6, 58.6))

    out = json.loads(capsys.readouterr().out)
    assert out[0] == {"collection": "orto-l2-2025", "dates": ["2025-05-01"], "count": 2}
    assert [v["collection"] for v in out] == ["orto-l2-2025", "orto-l2-2023", "orto-l2-2021"]
