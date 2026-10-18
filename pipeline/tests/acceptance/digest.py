"""A compact, order-free summary of the trees an arboristdata.dat holds, for comparing two runs.

Per Arborist item of the trees package: its settings (the whole item, sorted) and every instance
(position, scale, rotation), each as a count and a sha256, so a golden file stays small.
"""
import hashlib
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
import arborist  # noqa: E402


def _sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def trees_package_digest(dat: Path, key_file: str | None = None) -> dict:
    doc = arborist.read_dat(dat, arborist.key_file(key_file))
    package = next(p for p in doc["VSProSettings"]["vegetationPackages"] if p.get("PackageName") == arborist.TREES_PACKAGE)
    names = {item["VegetationItemID"]: item["Name"] for item in package["VegetationInfoList"]}
    settings = {item["Name"]: _sha(json.dumps(item, sort_keys=True)) for item in package["VegetationInfoList"]}
    rows: dict[str, list[str]] = {}
    for cell in doc["PersistentVegetationPackage"]["PersistentVegetationCellList"]:
        for info in cell["PersistentVegetationInfoList"]:
            name = names.get(info["VegetationItemID"])
            if name is None:
                continue
            for it in info["VegetationItemList"]:
                p, s, r = it["Position"], it["Scale"], it["Rotation"]
                rows.setdefault(name, []).append(
                    f"{cell['cellIndex']}|{p['x']:.3f},{p['y']:.3f},{p['z']:.3f}|{s['x']:.4f},{s['y']:.4f},{s['z']:.4f}"
                    f"|{r['x']:.5f},{r['y']:.5f},{r['z']:.5f},{r['w']:.5f}")
    return {name: {"settings": settings[name], "count": len(rows.get(name, [])), "instances": _sha("\n".join(sorted(rows.get(name, []))))}
            for name in sorted(settings)}
