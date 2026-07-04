"""Unit tests for download-auth logic — no network. Verifies that missing
LANTMATERIET_USER/LANTMATERIET_PASS fails fast with a clear message before
any request is attempted, and that a stubbed session receives basic auth
when credentials are set.
"""

from pathlib import Path

import pytest

from golfpipe import stac


class _StubResponse:
    def __init__(self, content: bytes):
        self._content = content
        self.status_code = 200

    def raise_for_status(self):
        pass

    def iter_content(self, chunk_size):
        yield self._content

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class _StubSession:
    def __init__(self):
        self.calls = []

    def get(self, url, auth=None, stream=None, timeout=None, params=None):
        self.calls.append({"url": url, "auth": auth, "params": params})
        return _StubResponse(b"fake-tiff-bytes")


def test_download_fails_fast_without_credentials(tmp_path: Path, monkeypatch):
    monkeypatch.delenv("LANTMATERIET_USER", raising=False)
    monkeypatch.delenv("LANTMATERIET_PASS", raising=False)

    session = _StubSession()
    with pytest.raises(stac.MissingCredentialsError, match="free account"):
        stac.download_asset("https://dl1.lantmateriet.se/hojd/data/grid/mhm/64_5/m647_53.tif", tmp_path / "out.tif", session=session)

    assert session.calls == [], "no HTTP request should be attempted without credentials"


def test_download_uses_basic_auth_when_credentials_present(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("LANTMATERIET_USER", "someuser")
    monkeypatch.setenv("LANTMATERIET_PASS", "somepass")

    session = _StubSession()
    dest = tmp_path / "out.tif"
    result = stac.download_asset("https://dl1.lantmateriet.se/hojd/data/grid/mhm/64_5/m647_53.tif", dest, session=session)

    assert result == dest
    assert dest.read_bytes() == b"fake-tiff-bytes"
    assert session.calls[0]["auth"] == ("someuser", "somepass")


def test_search_parses_items_from_stub(monkeypatch):
    class _SearchStubResponse:
        def raise_for_status(self):
            pass

        def json(self):
            return {
                "features": [
                    {
                        "id": "647_53",
                        "collection": "dtm-cog",
                        "bbox": [15.5, 58.3, 15.6, 58.4],
                        "assets": {
                            "data": {"href": "https://dl1.lantmateriet.se/hojd/data/grid/mhm/64_5/m647_53.tif", "type": "image/tiff"},
                        },
                        "properties": {"datetime": "2024-01-01T00:00:00Z"},
                    }
                ]
            }

    class _SearchStubSession:
        def get(self, url, params=None, timeout=None):
            assert "search" in url
            return _SearchStubResponse()

    items = stac.search_dem((15.5, 58.3, 15.6, 58.4), session=_SearchStubSession())
    assert len(items) == 1
    assert items[0].id == "647_53"
    assert items[0].data_href.endswith("m647_53.tif")
