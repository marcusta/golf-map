"""The Arborist edit loop's file patch (patch_instances): one placed tree moved, resized, turned,
deleted, added or made another item, in the trees package of a course file."""
import copy

import pytest

import arborist

GRID = arborist.Grid(-200, -200, 200, 200)   # 4 x 4 cells of 100 m
BUSH = "id-bush"
ELM = "id-elm"


def inst(x, z, y=10.0, s=1.0):
    """An instance at world x, z (stored relative to the square's corner)."""
    return {"Position": {"x": x + 200, "y": y, "z": z + 200}, "Scale": {"x": s, "y": s, "z": s},
            "Rotation": {"x": 0, "y": 0, "z": 0, "w": 1}, "VegetationSourceID": 42, "DistanceFalloff": 1}


def course():
    index, rect = GRID.cell(10, 10)
    return {
        "VSProSettings": {"totalPrefabs": 2, "vegetationPackages": [
            {"PackageName": "GolfMap trees", "VegetationInfoList": [{"Name": "Bush", "VegetationItemID": BUSH}, {"Name": "Elm", "VegetationItemID": ELM}]}]},
        "PersistentVegetationPackage": {"PersistentVegetationCellList": [
            {"cellIndex": index, "cellRect": rect, "PersistentVegetationInfoList": [
                {"VegetationItemID": BUSH, "VegetationItemList": [inst(10, 10), inst(30, 30, s=2.0)]},
                {"VegetationItemID": ELM, "VegetationItemList": [inst(50, 50)]}]}]},
    }


def instances(doc, item):
    """(cellIndex, world x, z, y, scale y) of every instance of `item`."""
    return sorted((c["cellIndex"], round(i["Position"]["x"] - 200, 3), round(i["Position"]["z"] - 200, 3), i["Position"]["y"], i["Scale"]["y"])
                  for c in doc["PersistentVegetationPackage"]["PersistentVegetationCellList"]
                  for info in c["PersistentVegetationInfoList"] if info["VegetationItemID"] == item for i in info["VegetationItemList"])


def test_a_move_within_its_cell_keeps_scale_and_turn():
    doc = course()
    done = arborist.patch_instances(doc, [{"item": BUSH, "at": [10.2, 9.9], "position": [12, 11, 14]}], GRID)
    cell = GRID.cell(10, 10)[0]
    assert instances(doc, BUSH) == [(cell, 12, 14, 11, 1.0), (cell, 30, 30, 10.0, 2.0)]
    assert done["removed"][0]["position"] == [10, 10.0, 10]


def test_a_move_across_a_cell_edge_lands_in_the_new_cell_and_an_emptied_cell_goes():
    doc = course()
    arborist.patch_instances(doc, [{"item": ELM, "at": [50, 50], "position": [-150, 5, 120]}], GRID)
    new_cell, rect = GRID.cell(-150, 120)
    assert instances(doc, ELM) == [(new_cell, -150, 120, 5, 1.0)]
    cells = doc["PersistentVegetationPackage"]["PersistentVegetationCellList"]
    assert [c["cellIndex"] for c in cells] == sorted(c["cellIndex"] for c in cells)
    assert next(c for c in cells if c["cellIndex"] == new_cell)["cellRect"] == rect
    # The bush's cell still holds the bushes; the elm's list in it is gone.
    old = next(c for c in cells if c["cellIndex"] == GRID.cell(10, 10)[0])
    assert [i["VegetationItemID"] for i in old["PersistentVegetationInfoList"]] == [BUSH]


def test_resize_turn_and_delete():
    doc = course()
    q = [0, 0.7071, 0, 0.7071]
    arborist.patch_instances(doc, [
        {"item": BUSH, "at": [30, 30], "scale": [3, 2.5, 3], "rotation": q},
        {"item": BUSH, "at": [10, 10], "delete": True},
    ], GRID)
    assert instances(doc, BUSH) == [(GRID.cell(30, 30)[0], 30, 30, 10.0, 2.5)]
    kept = doc["PersistentVegetationPackage"]["PersistentVegetationCellList"][0]["PersistentVegetationInfoList"][0]["VegetationItemList"][0]
    assert [kept["Rotation"][k] for k in "xyzw"] == q and kept["Scale"]["x"] == 3


def test_another_item_the_package_lacks_is_made_once():
    doc = course()
    made = []

    def make_item(spec):
        made.append(spec["variant"])
        return {"Name": spec["variant"], "VegetationItemID": "id-oak"}

    new = {"label": "Oak", "variant": "Oak", "far": False}
    done = arborist.patch_instances(doc, [
        {"item": ELM, "at": [50, 50], "as": "id-oak", "newItem": new},
        {"item": "id-oak", "position": [60, 9, 60], "scale": [1, 1, 1], "rotation": [0, 0, 0, 1], "newItem": new},
    ], GRID, make_item)
    assert made == ["Oak"] and done["newItems"] == ["Oak"]
    assert instances(doc, ELM) == [] and len(instances(doc, "id-oak")) == 2
    assert doc["VSProSettings"]["totalPrefabs"] == 3


def test_what_cannot_be_done_is_refused_and_the_file_is_left_alone():
    doc = course()
    before = copy.deepcopy(doc)
    with pytest.raises(ValueError, match="no instance of 'Bush' within 0.5 m"):
        arborist.patch_instances(doc, [{"item": BUSH, "at": [11, 10]}], GRID)
    with pytest.raises(ValueError, match="no item id-oak"):
        arborist.patch_instances(copy.deepcopy(before), [{"item": ELM, "at": [50, 50], "as": "id-oak"}], GRID)
    with pytest.raises(ValueError, match="needs position, scale and rotation"):
        arborist.patch_instances(copy.deepcopy(before), [{"item": BUSH, "position": [1, 1, 1]}], GRID)
