"""Live network test against the real Lantmateriet STAC API (anonymous
search, no auth). Skippable via GOLFPIPE_SKIP_NETWORK_TESTS=1 for offline
CI/dev environments — everything else in this suite runs with no network.
"""

import os

import pytest

from golfpipe import stac

pytestmark = pytest.mark.skipif(
    os.environ.get("GOLFPIPE_SKIP_NETWORK_TESTS") == "1",
    reason="network test disabled via GOLFPIPE_SKIP_NETWORK_TESTS=1",
)

# Linkoping-area bbox from the verified probe in the task brief.
LINKOPING_BBOX = (15.55, 58.39, 15.58, 58.41)


def test_dem_search_returns_known_item():
    items = stac.search_dem(LINKOPING_BBOX, limit=3)
    ids = [item.id for item in items]
    assert "647_53" in ids

    item = next(i for i in items if i.id == "647_53")
    assert item.collection == "dtm-cog"
    assert "data" in item.assets
    assert item.data_href.startswith("https://dl1.lantmateriet.se/hojd/")
