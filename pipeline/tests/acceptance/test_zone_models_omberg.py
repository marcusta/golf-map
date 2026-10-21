"""Acceptance C1 (Arborist half) and C2 (pipeline half), zone palettes on the model library.

Omberg's zone palettes (grass-palette.json, golfmap-grass-v1) refer to models instead of naming textures and
prefabs: every palette item has "model": "<model id>" and keeps only where and how densely it grows and its
size (name, model, sampleDistance, density, maxDensity, noise*, maxSteepness, lodFactor, copies,
renderDistance, width, height, minScale, maxScale, verticalOffset). The look (healthy / dry, the shader
"material" floats, randomDarkening, rootAmbient, alphaCutoff, whitePoint, shadows, and an Arborist model's
tint / saturation / brightness / ...) is the model's, in the model library (docs/gspro/model-library.json and
the course's models.json). Lower-vegetation models have form "grass" (a VSP texture item; id
vsp:texture:<texture file stem>), "plant" (a ground plant) or "shrub" (a bush); one asset in several looks
is several models, the later ones with a "#<variant>" suffix (vsp:texture:Rustic Grass_15#blond). The
renderer is the model's: a vsp model's item is drawn by the course's own VSP, an arborist model's by
Arborist's "GolfMap lower vegetation" package. No "prefabItems" / "prefabItemsInVsp" in the palette and no
"species" map in arborist-species.json decide that any more (plantSettings stays: course-wide defaults, the
model's own look wins over them).

  arborist.py lower ... --palette <grass-palette.json> --zones <inner zones export> --models <resolved library>

The resolved library is what the app hands arborist.py (shared/vegetation/tree-models.ts loadModelLibrary).
Runs on Omberg's real files (copied into a scratch docs root where a test changes them) and its GSPro course
folder, zones export and the Arborist key: machine data, required.

  python -m pytest pipeline/tests/acceptance/test_zone_models_omberg.py
"""
import json
import shutil
import subprocess
import sys
from collections import Counter
from pathlib import Path

from lower_digest import lower_package

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
import arborist  # noqa: E402

REPO = Path(__file__).resolve().parents[3]
PIPELINE = REPO / "pipeline"
DOCS_ROOT = REPO / "docs" / "gspro"
COURSE_DOCS = DOCS_ROOT / "ombergs-golfklubb"
COURSE_DIR = Path("C:/GSProV1/Core/GSP/Courses/Omberg_lidar_scene")
ZONES = Path("D:/gspro_courses/omberg-opcd/ombergs-golfklubb-inner-zones.json")
LIBRARY = REPO / "data" / "arborist" / "GolfMap library.biome"
LOOK_KEYS = {"healthy", "dry", "source", "prefab", "material", "randomDarkening", "rootAmbient", "alphaCutoff", "whitePoint", "shadows"}
LOWER_FORMS = {"grass", "plant", "shrub"}


def docs_copy(tmp: Path) -> Path:
    """Omberg's docs (and the shared library beside them) in a scratch docs root a test may change."""
    course = tmp / "docs" / "ombergs-golfklubb"
    course.mkdir(parents=True)
    shutil.copy(DOCS_ROOT / "model-library.json", tmp / "docs" / "model-library.json")
    for name in ("grass-palette.json", "models.json", "arborist-species.json"):
        shutil.copy(COURSE_DOCS / name, course / name)
    return course


def resolved(course_docs: Path) -> dict:
    script = ("import { loadModelLibrary, modelLibraryText } from './shared/vegetation/tree-models.ts';"
              f"process.stdout.write(modelLibraryText(loadModelLibrary({json.dumps(str(course_docs))})));")
    run = subprocess.run(["bun", "-e", script], cwd=REPO, check=True, capture_output=True, text=True, encoding="utf-8")
    return json.loads(run.stdout)


def write_lower(course_docs: Path, out: Path) -> dict:
    """arborist.py lower as the app runs it, into `out`; the lower-vegetation package it wrote."""
    out.mkdir(parents=True, exist_ok=True)
    models = out / "models.resolved.json"
    models.write_text(json.dumps(resolved(course_docs)), encoding="utf-8")
    subprocess.run([sys.executable, str(PIPELINE / "arborist.py"), "lower",
                    "--course-dir", str(COURSE_DIR),
                    "--species", str(course_docs / "arborist-species.json"),
                    "--library", str(LIBRARY),
                    "--palette", str(course_docs / "grass-palette.json"),
                    "--zones", str(ZONES),
                    "--models", str(models),
                    "--out-dir", str(out)],
                   check=True, cwd=PIPELINE, capture_output=True, text=True)
    return lower_package(out / "arboristdata.dat")


def palette_items(palette: dict) -> list[tuple[str, dict]]:
    return [(p["key"], item) for p in palette["palettes"] for item in p["items"]]


def zoned() -> set[str]:
    return {row["item"] for row in json.loads(ZONES.read_text(encoding="utf-8"))["items"]}


def label(model_id: str) -> str:
    return model_id.split(":", 1)[1].split("#", 1)[0]


def addresses() -> dict[str, object]:
    library = json.loads(LIBRARY.read_text(encoding="utf-8-sig"))
    return {item["Name"].strip(): item.get("Address") for item in library["VegetationInfoList"]}


def foliage_colours(item: dict) -> list[str]:
    blocks = [item.get("ShaderControllerSettings")] + list(item.get("ShaderControllerSettingsArray") or [])
    return [prop["ColorValue"] for block in blocks for prop in (block or {}).get("ControlerPropertyList") or []
            if prop.get("PropertyName") in arborist.FOLIAGE_COLOURS]


def test_omberg_zone_items_refer_to_models_and_hold_no_look(tmp_path):
    palette = json.loads((COURSE_DOCS / "grass-palette.json").read_text(encoding="utf-8"))
    assert "prefabItems" not in palette and "prefabItemsInVsp" not in palette
    species = json.loads((COURSE_DOCS / "arborist-species.json").read_text(encoding="utf-8"))
    assert "species" not in species, "who draws a zone item is its model's renderer, not a prefab-to-label map"
    by_id = {m["id"]: m for m in resolved(COURSE_DOCS)["models"]}
    items = palette_items(palette)
    assert len(items) >= 150
    for key, item in items:
        assert item.get("model") in by_id, f"{key} / {item['name']}: model {item.get('model')!r} is not in the library"
        assert by_id[item["model"]]["form"] in LOWER_FORMS, f"{item['name']}: {item['model']} is not a lower-vegetation model"
        assert not LOOK_KEYS & set(item), f"{key} / {item['name']} still holds look keys {sorted(LOOK_KEYS & set(item))}"
    # Both renderers draw some of it, and a texture grass is always VSP's.
    renderers = Counter(by_id[item["model"]]["renderer"] for _, item in items)
    assert renderers["vsp"] > 0 and renderers["arborist"] > 0
    assert all(by_id[item["model"]]["renderer"] == "vsp" for _, item in items if by_id[item["model"]]["form"] == "grass")


def test_arborist_draws_exactly_the_zone_items_of_arborist_models(tmp_path):
    palette = json.loads((COURSE_DOCS / "grass-palette.json").read_text(encoding="utf-8"))
    by_id = {m["id"]: m for m in resolved(COURSE_DOCS)["models"]}
    package = write_lower(COURSE_DOCS, tmp_path)
    in_zones = zoned()
    wanted = {item["name"]: item["model"] for _, item in palette_items(palette)
              if by_id[item["model"]]["renderer"] == "arborist" and item["name"] in in_zones}
    assert wanted, "Omberg has bushes and ground plants drawn by Arborist"
    written = {item["Name"]: item for item in package["VegetationInfoList"]}
    assert sorted(written) == sorted(wanted)
    known = addresses()
    for name, model in wanted.items():
        assert label(model) in known, f"{model}: Arborist has no {label(model)}"
        assert written[name]["Address"] == known[label(model)], f"{name} is not drawn with {model}'s Arborist item"


def test_a_models_look_shows_in_every_zone_that_uses_it(tmp_path):
    course = docs_copy(tmp_path)
    palette = json.loads((course / "grass-palette.json").read_text(encoding="utf-8"))
    by_id = {m["id"]: m for m in resolved(course)["models"]}
    in_zones = zoned()
    uses: dict[str, list[tuple[str, str]]] = {}
    for key, item in palette_items(palette):
        if by_id[item["model"]]["renderer"] == "arborist" and item["name"] in in_zones:
            uses.setdefault(item["model"], []).append((key, item["name"]))
    model, used = max(uses.items(), key=lambda kv: len({k for k, _ in kv[1]}))
    assert len({k for k, _ in used}) >= 2, "an Arborist model used in two zone palettes"

    # One change, in the course's model library only.
    doc = json.loads((course / "models.json").read_text(encoding="utf-8"))
    entry = next((m for m in doc["models"] if m["id"] == model), None)
    if entry is None:
        doc["models"].append(entry := {"id": model})
    entry["look"] = {**entry.get("look", {}), "tint": "#3a5f2b"}
    (course / "models.json").write_text(json.dumps(doc, indent=2), encoding="utf-8")

    package = {item["Name"]: item for item in write_lower(course, tmp_path / "out")["VegetationInfoList"]}
    tint = arborist._hex_colour("#3a5f2b")
    for key, name in used:
        colours = foliage_colours(package[name])
        assert colours and all(c == tint for c in colours), f"{key} / {name} ({model}) does not show the model's new tint: {colours}"
    others = [name for name, item in package.items() if name not in {n for _, n in used}]
    assert others and not all(foliage_colours(package[n]) and all(c == tint for c in foliage_colours(package[n])) for n in others)


def test_swapping_a_zone_items_model_moves_it_between_renderers(tmp_path):
    course = docs_copy(tmp_path)
    palette = json.loads((course / "grass-palette.json").read_text(encoding="utf-8"))
    models = resolved(course)["models"]
    by_id = {m["id"]: m for m in models}
    in_zones = zoned()
    items = [item for _, item in palette_items(palette) if item["name"] in in_zones]
    to_vsp = next(i for i in items if by_id[i["model"]]["renderer"] == "arborist")
    to_arborist = next(i for i in items if by_id[i["model"]]["renderer"] == "vsp" and by_id[i["model"]]["form"] != "grass")
    vsp_bush = next(m["id"] for m in models if m["renderer"] == "vsp" and m["form"] in ("plant", "shrub"))
    arborist_bush = next(m["id"] for m in models if m["renderer"] == "arborist" and m["form"] in ("plant", "shrub") and m["id"] != to_vsp["model"])
    to_vsp["model"], to_arborist["model"] = vsp_bush, arborist_bush
    (course / "grass-palette.json").write_text(json.dumps(palette, indent=2), encoding="utf-8")

    written = {item["Name"]: item for item in write_lower(course, tmp_path)["VegetationInfoList"]}
    assert to_vsp["name"] not in written, f"{to_vsp['name']} now has a VSP model ({vsp_bush}) but Arborist still draws it"
    assert to_arborist["name"] in written, f"{to_arborist['name']} now has an Arborist model ({arborist_bush}) but Arborist does not draw it"
    assert written[to_arborist["name"]]["Address"] == addresses()[label(arborist_bush)]
