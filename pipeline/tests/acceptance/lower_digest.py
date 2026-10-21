"""A compact, order-free summary of the lower-vegetation package an arboristdata.dat holds (arborist.py lower),
for comparing two runs: per item its whole settings as a sha256, and the package's mask groups by name and id
(the mask bytes are the zones export's, not the writer's).
"""
import hashlib
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
import arborist  # noqa: E402


def lower_package(dat: Path, key_file: str | None = None) -> dict:
    doc = arborist.read_dat(dat, arborist.key_file(key_file))
    return next(p for p in doc["VSProSettings"]["vegetationPackages"] if p.get("PackageName") == arborist.LOWER_PACKAGE)


def lower_package_digest(dat: Path, key_file: str | None = None) -> dict:
    package = lower_package(dat, key_file)
    items = {item["Name"]: hashlib.sha256(json.dumps(item, sort_keys=True).encode("utf-8")).hexdigest()
             for item in package["VegetationInfoList"]}
    groups = sorted(f"{g['TextureMaskName']}|{g['TextureMaskGroupID']}" for g in package.get("TextureMaskGroupList") or [])
    return {"items": dict(sorted(items.items())), "maskGroups": groups}
