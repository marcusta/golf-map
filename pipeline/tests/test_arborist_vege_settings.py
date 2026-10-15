"""The species file's vegeSettings reach the Arborist file's system settings."""
import pytest

import arborist


def doc():
    return {"VSProSettings": {"vegeSettings": {"PlantDistance": 350, "AdditionalTreeMeshDistance": 313}}}


def test_known_keys_are_written_and_comments_skipped():
    d = doc()
    arborist.apply_vege_settings(d, {"vegeSettings": {"PlantDistance": 250, "_why": "frame time"}})
    assert d["VSProSettings"]["vegeSettings"] == {"PlantDistance": 250, "AdditionalTreeMeshDistance": 313}


def test_no_key_leaves_the_file_as_it_was():
    d = doc()
    arborist.apply_vege_settings(d, {})
    assert d == doc()


def test_an_unknown_key_stops_the_run():
    with pytest.raises(SystemExit, match="PlantDistanse"):
        arborist.apply_vege_settings(doc(), {"vegeSettings": {"PlantDistanse": 250}})
