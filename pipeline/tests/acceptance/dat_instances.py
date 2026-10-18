"""The trees package of an arboristdata.dat as JSON, for the acceptance tests that drive Unity from TypeScript.

usage: python dat_instances.py <arboristdata.dat> <x0> <z0>      (x0 z0: the terrains square's south-west corner)
Prints {"items": [{name, tint, barkTint}], "instances": [{item, x, y, z, yawDeg, scaleY}]}, positions in world metres.
"""
import json
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
import arborist  # noqa: E402


def _hex(colour) -> str | None:
    """'RGBA(r, g, b, a)' (0-1, three decimals) as '#rrggbb'."""
    if not isinstance(colour, str) or "(" not in colour:
        return None
    r, g, b = (float(v) for v in colour[colour.index("(") + 1:colour.index(")")].split(",")[:3])
    return "#" + "".join(f"{round(c * 255):02x}" for c in (r, g, b))


def _first(item: dict, names: tuple[str, ...]) -> str | None:
    for block in [item.get("ShaderControllerSettings")] + list(item.get("ShaderControllerSettingsArray") or []):
        for prop in (block or {}).get("ControlerPropertyList") or []:
            if prop.get("PropertyName") in names:
                return _hex(prop.get("ColorValue"))
    return None


def main(dat: str, x0: float, z0: float) -> None:
    doc = arborist.read_dat(Path(dat), arborist.key_file(None))
    package = next(p for p in doc["VSProSettings"]["vegetationPackages"] if p.get("PackageName") == arborist.TREES_PACKAGE)
    names = {i["VegetationItemID"]: i["Name"] for i in package["VegetationInfoList"]}
    items = [{"name": i["Name"], "tint": _first(i, arborist.FOLIAGE_COLOURS), "barkTint": _first(i, arborist.BARK_COLOURS)}
             for i in package["VegetationInfoList"]]
    instances = []
    for cell in doc["PersistentVegetationPackage"]["PersistentVegetationCellList"]:
        for info in cell["PersistentVegetationInfoList"]:
            name = names.get(info["VegetationItemID"])
            if name is None:
                continue
            for it in info["VegetationItemList"]:
                p, r, s = it["Position"], it["Rotation"], it["Scale"]
                yaw = math.degrees(math.atan2(2 * (r["w"] * r["y"] + r["x"] * r["z"]), 1 - 2 * (r["y"] ** 2 + r["x"] ** 2))) % 360
                instances.append({"item": name, "x": p["x"] + x0, "y": p["y"], "z": p["z"] + z0, "yawDeg": yaw, "scaleY": s["y"]})
    print(json.dumps({"items": items, "instances": instances}))


if __name__ == "__main__":
    main(sys.argv[1], float(sys.argv[2]), float(sys.argv[3]))
