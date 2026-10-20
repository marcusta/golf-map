"""Arborist course data (GSPro's own vegetation) written from golf-map.

GSPro treats a course as an Arborist course when its folder holds `arboristdata.dat`
(+ `arboristversion.dat`, the asset catalogue's version). At course load GSPro builds a
Vegetation Studio Pro system of its own from that file: packages of items whose prefabs
come out of Arborist's asset bundles (`Address`), stored instances per cell, texture masks,
biome and vegetation mask areas. The file is JSON in the wrapper `arborist-wrap.ps1`
handles (format read out of GSPro 3.1.6.20 and real course files; see docs/gspro/arborist.md).

Commands:
  decode <dat> <json>     unwrap an arboristdata.dat
  encode <json> <dat>     wrap a JSON file
  init                    a new course's first arboristdata.dat, from another course's without its vegetation
  trial                   a few trees round two spots of a course, to see GSPro draw them
  edit                    hand changes to placed trees in the file, in place (the Arborist edit loop)
  route                   before planting: each tree by id drawn by its own model ("own"), an Arborist billboard or left out

The item definitions (about 140 settings each, the baked billboards included) are never
written from scratch: they are cloned from real Arborist files (`--templates`).
"""
from __future__ import annotations

import argparse
import copy
import json
import math
import os
import shutil
import subprocess
import sys
import tempfile
import zlib
from pathlib import Path

import vegetation_rules

HERE = Path(__file__).resolve().parent
WRAP = HERE / "arborist-wrap.ps1"
DEFAULT_KEY = HERE.parent / "data" / "arborist-wrapper.key"
CELL_M = 100.0  # VSP's vegetation cell size, GSPro's Arborist system included
CATALOG_VERSION = 20250709005421  # the asset catalogue the templates were saved against
# The far rule's distances when neither the course's routing rules nor its species file's billboardBeyondM
# set them (pipeline/vegetation-rules/routing.json).
ROUTING_RULES = vegetation_rules.load("routing")
BILLBOARD_OUTSIDE_OOB_M = ROUTING_RULES["routing.farBillboard.outsideOob"]
BILLBOARD_FROM_PLAY_M = ROUTING_RULES["routing.farBillboard.fromPlay"]
ROUTING_FORMAT = "golfmap-routing-v1"
OWN, BILLBOARD, OUT = "own", "billboard", "out"
TRIAL_SOURCE_ID = 1


def key_file(arg: str | None) -> Path:
    path = Path(arg or os.environ.get("GOLFMAP_ARBORIST_KEY") or DEFAULT_KEY)
    if not path.is_file():
        sys.exit(f"No wrapper key at {path}. It is the 16-byte array GSPro's Arborist importer decrypts with "
                 "(ImportArboristToVSPro.DecryptData); export it once to that file or pass --key-file.")
    return path


def wrap(mode: str, src: Path, dst: Path, key: Path) -> None:
    subprocess.run(["pwsh", "-NoProfile", "-File", str(WRAP), "-Mode", mode, "-In", str(src), "-Out", str(dst),
                    "-KeyFile", str(key)], check=True)


def read_dat(path: Path, key: Path) -> dict:
    with tempfile.TemporaryDirectory() as tmp:
        out = Path(tmp) / "a.json"
        wrap("decode", path, out, key)
        return json.loads(out.read_text(encoding="utf-8-sig"))


def write_dat(doc: dict, path: Path, key: Path) -> None:
    with tempfile.TemporaryDirectory() as tmp:
        src = Path(tmp) / "a.json"
        src.write_text(json.dumps(doc, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        wrap("encode", src, path, key)


def load_any(path: Path, key: Path) -> dict:
    return read_dat(path, key) if path.suffix.lower() == ".dat" else json.loads(path.read_text(encoding="utf-8-sig"))


class Grid:
    """GSPro's Arborist system is laid out over the union of the course's terrains
    (CalculateVegetationSystemBounds): instance positions are relative to its south-west
    corner at y 0, cells are 100 m, numbered column by column from that corner
    (index = x cell * cells per side in z + z cell). Checked against Baylands_GSP's cells."""

    def __init__(self, x0: float, z0: float, x1: float, z1: float):
        self.x0, self.z0 = x0, z0
        self.nx = max(1, math.ceil((x1 - x0) / CELL_M - 1e-6))
        self.nz = max(1, math.ceil((z1 - z0) / CELL_M - 1e-6))

    def cell(self, x: float, z: float) -> tuple[int, dict]:
        xi, zi = int((x - self.x0) // CELL_M), int((z - self.z0) // CELL_M)
        if not (0 <= xi < self.nx and 0 <= zi < self.nz):
            raise ValueError(f"({x}, {z}) is outside the terrains")
        return xi * self.nz + zi, {"x": self.x0 + xi * CELL_M, "y": self.z0 + zi * CELL_M, "width": CELL_M, "height": CELL_M}

    def instance(self, x: float, y: float, z: float, yaw_deg: float, scale: float) -> dict:
        half = math.radians(yaw_deg) / 2
        return {"Position": {"x": x - self.x0, "y": y, "z": z - self.z0}, "Scale": {"x": scale, "y": scale, "z": scale},
                "Rotation": {"x": 0, "y": math.sin(half), "z": 0, "w": math.cos(half)},
                "VegetationSourceID": TRIAL_SOURCE_ID, "DistanceFalloff": 1}


def find_items(templates: list[dict], names: list[str]) -> list[dict]:
    found = []
    for name in names:
        hit = next((item for doc in templates for package in doc["VSProSettings"]["vegetationPackages"]
                    for item in package.get("VegetationInfoList") or [] if item.get("Name") == name), None)
        if hit is None:
            sys.exit(f"No item named '{name}' in the template files.")
        item = copy.deepcopy(hit)
        item["EnableRuntimeSpawn"] = False  # placed instances only; nothing spawned by rule
        found.append(item)
    return found


def empty_package(templates: list[dict], name: str) -> dict:
    """A package with every scalar setting a real one has, and its lists emptied."""
    base = next(package for doc in templates for package in doc["VSProSettings"]["vegetationPackages"])
    package = {k: ([] if isinstance(v, list) else copy.deepcopy(v)) for k, v in base.items()}
    package["PackageName"] = name
    package["BiomeType"] = "Default"
    return package


def trial(args) -> None:
    key = key_file(args.key_file)
    templates = [load_any(Path(p), key) for p in args.templates]
    course_dir = Path(args.course_dir)
    gkd_path = next((p for p in course_dir.iterdir() if p.suffix.lower() == ".gkd"), None)
    if gkd_path is None:
        sys.exit(f"No .GKD in {course_dir}.")
    gkd = json.loads(gkd_path.read_text(encoding="utf-8-sig"))
    hole = gkd["Holes"][args.hole - 1]
    tee = next(t["Position"] for t in hole["Tees"] if t.get("Enabled") and t.get("Position"))
    pin = next(p["Position"] for p in hole["Pins"] if p.get("Position"))

    x0, z0, x1, z1 = args.terrains_square
    grid = Grid(x0, z0, x1, z1)
    items = find_items(templates, args.items)
    package = empty_package(templates, "GolfMap trial trees")
    package["VegetationInfoList"] = items

    cells: dict[int, dict] = {}
    count = 0
    for centre, radius, n in ((tee, args.radius, args.per_ring), (pin, args.radius, args.per_ring)):
        for i in range(n):
            a = 2 * math.pi * i / n
            x, z = centre["x"] + radius * math.sin(a), centre["z"] + radius * math.cos(a)
            index, rect = grid.cell(x, z)
            cell = cells.setdefault(index, {"cellIndex": index, "cellRect": rect, "PersistentVegetationInfoList": []})
            item = items[i % len(items)]
            info = next((r for r in cell["PersistentVegetationInfoList"] if r["VegetationItemID"] == item["VegetationItemID"]), None)
            if info is None:
                info = {"VegetationItemID": item["VegetationItemID"], "VegetationItemList": []}
                cell["PersistentVegetationInfoList"].append(info)
            info["VegetationItemList"].append(grid.instance(x, centre["y"], z, 37.0 * i, 1.0))
            count += 1

    doc = copy.deepcopy(templates[0])
    settings = doc["VSProSettings"]
    settings["terrains"] = [{"Name": name, "TerrainSourceID": 0} for name in args.terrain_names]
    settings["meshterrains"] = []
    settings["vegetationPackages"] = [package]
    settings["totalPrefabs"] = len(items)
    doc["PersistentVegetationPackage"] = {"PersistentVegetationCellList": [cells[k] for k in sorted(cells)]}
    doc["biomeMasks"], doc["vegeMasks"], doc["vegeLines"], doc["quicksets"] = [], [], [], []
    doc["PersistentItems"] = None
    doc["originalImportGameObjectsParents"], doc["originalImportTerrains"] = [], []
    doc["catalogVersion"] = CATALOG_VERSION
    doc["terrainSize"] = int(args.inner_side)
    doc["satImagePath"] = ""
    doc["lastCamPos"] = {"x": tee["x"], "y": tee["y"] + 20, "z": tee["z"]}

    out_dir = Path(args.out_dir or course_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    write_dat(doc, out_dir / "arboristdata.dat", key)
    (out_dir / "arboristversion.dat").write_text(str(CATALOG_VERSION), encoding="ascii")
    check = read_dat(out_dir / "arboristdata.dat", key)
    stored = sum(len(r["VegetationItemList"]) for c in check["PersistentVegetationPackage"]["PersistentVegetationCellList"]
                 for r in c["PersistentVegetationInfoList"])
    print(f"wrote {out_dir / 'arboristdata.dat'}: {stored} trees of {len(items)} kinds in {len(cells)} cell(s), "
          f"grid {grid.nx} x {grid.nz} from ({x0}, {z0})")
    print(f"  ring of {args.per_ring} at {args.radius} m round hole {args.hole}'s tee ({tee['x']:.0f}, {tee['z']:.0f}) "
          f"and its pin ({pin['x']:.0f}, {pin['z']:.0f})")
    print("  items: " + ", ".join(i["Name"] for i in items))


# ---- lower vegetation: the palettes' prefab items, spread by the zones export's masks ------------

LOWER_PACKAGE = "GolfMap lower vegetation"
INCLUDE_THRESHOLD = 0.02  # as unity/Editor/GolfMap/GolfMapZoneImporterVsp.cs: below this mask value nothing grows
# VSP reads an ARGB32 mask's raw bytes as (A, R, G, B) and a rule's ChannelSelector as the byte's
# index (TextureMask.cs), so a zones PNG channel (R, G, B, A = 0..3) is selector 1, 2, 3, 0.
ARGB32 = 5
PNG_CHANNEL_TO_SELECTOR = (1, 2, 3, 0)


def encode_mask_texture(png: Path) -> tuple[str, int, int]:
    """A zones mask PNG as Arborist stores a mask texture: raw ARGB32 bytes, bottom row first,
    as base64 text, gzipped behind its length, as base64 (ExportVSPro.TexToBase64)."""
    import base64
    import gzip
    import struct

    import numpy as np
    from PIL import Image

    Image.MAX_IMAGE_PIXELS = None
    rgba = np.asarray(Image.open(png).convert("RGBA"))
    argb = np.ascontiguousarray(rgba[::-1, :, [3, 0, 1, 2]])
    text = base64.b64encode(argb.tobytes())
    packed = struct.pack("<i", len(text)) + gzip.compress(text, compresslevel=6)
    return base64.b64encode(packed).decode("ascii"), rgba.shape[1], rgba.shape[0]


def mask_rule(group_id: str, selector: int, min_density: float) -> dict:
    def prop(kind: str, name: str, description: str, int_value: int = 0) -> dict:
        return {"SerializedControlerPropertyType": kind, "PropertyName": name, "PropertyDescription": description, "PropertyInfo": "",
                "IntValue": int_value, "IntMinValue": 0, "IntMaxValue": 0, "FloatValue": 0, "FloatMinValue": 0, "FloatMaxValue": 0,
                "ColorValue": "RGBA(0.000, 0.000, 0.000, 0.000)", "BoolValue": False, "TextureValue": None, "Width": 0, "Height": 0,
                "Format": 0, "StringList": []}
    return {"TextureMaskGroupID": group_id, "MinDensity": min_density, "MaxDensity": 1, "ScaleMultiplier": 1, "DensityMultiplier": 1,
            "TextureMaskPropertiesList": [prop("RgbaSelector", "ChannelSelector", "Select channel", selector), prop("Boolean", "Inverse", "Inverse")]}


def species_for(prefab: str, labels: list[str], overrides: dict) -> str | None:
    """The Arborist label a palette prefab becomes: the species file's entry, else the one catalogue
    label that ends with the prefab's name without its 'prefab_' (the OPCD copies of the same
    NatureManufacture models are named <pack>_<model>)."""
    stem = Path(prefab).stem
    if stem in overrides:
        return overrides[stem] or None
    core = stem[7:] if stem.lower().startswith("prefab_") else stem
    hits = [label for label in labels if label.lower().endswith("_" + core.lower())]
    return hits[0] if len(hits) == 1 else None


def lower(args) -> None:
    import uuid

    key = key_file(args.key_file)
    library = json.loads(Path(args.library).read_text(encoding="utf-8-sig"))
    by_label = {item["Name"].strip(): item for item in library["VegetationInfoList"]}
    palette_doc = json.loads(Path(args.palette).read_text(encoding="utf-8"))
    palettes, in_vsp = palette_doc["palettes"], palette_doc.get("prefabItemsInVsp", [])
    zones_path = Path(args.zones)
    zones = json.loads(zones_path.read_text(encoding="utf-8"))
    species_path = Path(args.species)
    species_file = json.loads(species_path.read_text(encoding="utf-8")) if species_path.is_file() else {}
    overrides = species_file.get("species", {})
    plant_look = species_file.get("plantSettings", [])
    channel_of = {row["item"]: (row["texture"], row["channel"]) for row in zones["items"]}
    side = float(zones["plot"]["sizeM"])

    package = {k: ([] if isinstance(v, list) else copy.deepcopy(v)) for k, v in library.items()}
    package["PackageName"] = LOWER_PACKAGE
    package["BiomeType"] = "Default"
    groups: dict[int, dict] = {}
    unmapped, unzoned, written, kept = [], [], [], []
    for palette in palettes:
        for spec in palette["items"]:
            name, prefab = spec["name"], spec.get("prefab")
            if not prefab or (args.only and not any(o.lower() in name.lower() for o in args.only)):
                continue
            if any(part.lower() in name.lower() for part in in_vsp):   # the palette's "prefabItemsInVsp": the course's own VSP draws it
                kept.append(name)
                continue
            label = species_for(prefab, list(by_label), overrides)
            if label is None or label not in by_label:
                unmapped.append(f"{name} ({Path(prefab).stem}" + (f" -> {label}, not in the library" if label else "") + ")")
                continue
            if name not in channel_of:
                unzoned.append(name)
                continue
            texture, channel = channel_of[name]
            if texture not in groups:
                mask = zones["masks"][texture]
                encoded, width, height = encode_mask_texture(zones_path.parent / mask["file"])
                groups[texture] = {"TextureMaskName": f"golfmap-zones-{texture}", "TextureMaskGroupID": str(uuid.uuid5(uuid.NAMESPACE_URL, "golfmap-zones/" + mask["file"])),
                                   "TextureMaskList": [{"TextureRect": {"x": 0, "y": 0, "width": side, "height": side}, "Repeat": {"x": 1, "y": 1},
                                                        "MaskTexture": encoded, "Width": width, "Height": height, "Format": ARGB32}]}
            group_id, selector = groups[texture]["TextureMaskGroupID"], PNG_CHANNEL_TO_SELECTOR[channel]
            item = copy.deepcopy(by_label[label])
            width_scale, height_scale = spec.get("width", 1), spec.get("height", 1)
            item.update({
                "Name": name, "VegetationItemID": str(uuid.uuid5(uuid.NAMESPACE_URL, "golfmap-lower/" + name)),
                "VegetationType": "Plant", "EnableRuntimeSpawn": True, "rotation": "RotateY",
                "SampleDistance": spec.get("sampleDistance", 0.6), "Density": spec.get("density", 1), "RandomizePosition": True,
                "MinScale": spec.get("minScale", 0.8), "MaxScale": spec.get("maxScale", 1.2),
                "ScaleMultiplier": {"x": width_scale, "y": height_scale, "z": width_scale},
                "Offset": {"x": 0, "y": spec.get("verticalOffset", 0), "z": 0},
                "UseHeightRule": False, "UseSteepnessRule": True, "MinSteepness": 0, "MaxSteepness": spec.get("maxSteepness", 75),
                "UseNoiseDensity": spec.get("noiseDensityScale", 8) > 0, "NoiseDensityScale": spec.get("noiseDensityScale", 8),
                "UseNoiseCutoff": spec.get("noiseCutoff", 0) > 0, "NoiseCutoffValue": spec.get("noiseCutoff", 0), "NoiseCutoffScale": spec.get("noiseCutoffScale", 14),
                "UseNoiseScaleRule": spec.get("noiseScaleScale", 12) > 0, "NoiseScaleMinScale": spec.get("noiseScaleMin", 0.8),
                "NoiseScaleMaxScale": spec.get("noiseScaleMax", 1.2), "NoiseScaleScale": spec.get("noiseScaleScale", 12),
                "DisableShadows": not spec.get("shadows", True),
                "UseTextureMaskDensityRules": True, "TextureMaskDensityRuleList": [mask_rule(group_id, selector, 0)],
                "UseTextureMaskIncludeRules": True, "TextureMaskIncludeRuleList": [mask_rule(group_id, selector, INCLUDE_THRESHOLD)],
                "UseTextureMaskExcludeRules": False, "TextureMaskExcludeRuleList": [],
                "UseTextureMaskScaleRules": False, "TextureMaskScaleRuleList": [],
            })
            # The palette's own leaf colours (tuned in Unity on the same models) come along; they win
            # over the caps of plantSettings and lose to a tint named there (rules match the palette
            # item's name or its Arborist species).
            carried = [{"match": ["*"], "tint1": spec["healthy"], "tint2": spec.get("dry", spec["healthy"])}] if spec.get("healthy") else []
            apply_look(item, carried + plant_look, also=label)
            package["VegetationInfoList"].append(item)
            written.append(f"{name} = {label} (mask {texture}, channel {channel})")
    package["TextureMaskGroupList"] = [groups[k] for k in sorted(groups)]

    course_dir = Path(args.course_dir)
    doc = load_any(Path(args.base) if args.base else course_dir / "arboristdata.dat", key)
    settings = doc["VSProSettings"]
    apply_vege_settings(doc, species_file)
    settings["vegetationPackages"] = [p for p in settings["vegetationPackages"] if p.get("PackageName") != LOWER_PACKAGE] + [package]
    settings["totalPrefabs"] = sum(len(p.get("VegetationInfoList") or []) for p in settings["vegetationPackages"])
    out_dir = Path(args.out_dir or course_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    write_dat(doc, out_dir / "arboristdata.dat", key)
    (out_dir / "arboristversion.dat").write_text(str(doc.get("catalogVersion", CATALOG_VERSION)), encoding="ascii")
    print(f"wrote {out_dir / 'arboristdata.dat'} ({(out_dir / 'arboristdata.dat').stat().st_size / 1e6:.1f} MB): "
          f"{len(written)} item(s), {len(groups)} mask texture(s) in package '{LOWER_PACKAGE}'")
    for line in written:
        print("  " + line)
    if unmapped:
        print(f"no Arborist species for {len(unmapped)} item(s) (add them to {species_path}):\n  " + "\n  ".join(unmapped))
    if unzoned:
        print(f"not in the zones export, left out: {', '.join(unzoned)}")
    if kept:
        print(f"left to the course's own VSP (the palette's prefabItemsInVsp): {', '.join(kept)}")


# ---- the planted trees --------------------------------------------------------------------------

TREES_PACKAGE = "GolfMap trees"
TREE_SOURCE_ID = 42  # as the Unity planter's imported trees
FAR_SUFFIX = " (far)"

# A tree model's id (CONTEXT.md "Model"): '<renderer>:<label>', the label being what the renderer calls
# it - 'arborist:<catalogue label>' or 'vsp:<Unity prefab>'. Parsed and built only here in Python; the
# twins are shared/vegetation/model-id.ts and GolfMapModels.Parse/Id in Unity.
ARBORIST, VSP = "arborist", "vsp"


def model_id(renderer: str, label: str) -> str:
    return f"{renderer}:{label}"


def parse_model_id(model: str) -> tuple[str | None, str]:
    """'arborist:S7_American_Elm' -> ('arborist', 'S7_American_Elm'); an id of another shape -> (None, the id)."""
    renderer, sep, label = str(model).partition(":")
    return (renderer, label) if sep and label and renderer in (ARBORIST, VSP) else (None, str(model))


# The dump's trees are matched to their placements by position in whole centimetres, within
# NUDGE_TOLERANCE_CM: Unity's planter moves a stem lying on a VSP cell edge 1 cm into the cell
# (GolfMapTreePlanterVsp.cs ResolveCell), and stores it there.
CM = 100
NUDGE_TOLERANCE_CM = 2
FOLIAGE_COLOURS = ("TintColor1", "TintColor2", "HealthyColorTint", "DryColorTint")
BARK_COLOURS = ("BarkColor", "BarkTintColor", "BarkTint")


def _cap_colour(text: str, cap: float) -> str:
    """'RGBA(r, g, b, a)' scaled down so that no channel is above cap; darker colours are left alone."""
    r, g, b, alpha = (float(v) for v in text[text.index("(") + 1:text.index(")")].split(","))
    top = max(r, g, b)
    k = cap / top if top > cap else 1.0
    return f"RGBA({r * k:.3f}, {g * k:.3f}, {b * k:.3f}, {alpha:.3f})"


def _hex_colour(value: str) -> str:
    v = value.lstrip("#")
    return "RGBA(%.3f, %.3f, %.3f, 1.000)" % tuple(int(v[i:i + 2], 16) / 255 for i in (0, 2, 4))


def apply_vege_settings(doc: dict, species_file: dict) -> None:
    """The species file's "vegeSettings" into the file's system settings (what GSPro's Arborist system
    runs with: PlantDistance, AdditionalTreeMeshDistance, AdditionalBillboardDistance ...). Only keys
    the file already has; an unknown one stops the run, as a typo would otherwise do nothing."""
    wanted = {k: v for k, v in species_file.get("vegeSettings", {}).items() if not k.startswith("_")}
    if not wanted:
        return   # nothing to set: a file without the section is left as it is
    settings = doc["VSProSettings"]["vegeSettings"]
    unknown = sorted(set(wanted) - set(settings))
    if unknown:
        sys.exit(f"vegeSettings: no such setting in the file: {', '.join(unknown)} (it has {', '.join(settings)})")
    for key, value in wanted.items():
        if settings[key] != value:
            print(f"vegeSettings.{key}: {settings[key]} -> {value}")
        settings[key] = value


def apply_look(item: dict, rules: list[dict], also: str = "") -> None:
    """The species file's `treeSettings` / `plantSettings` rules. Every rule one of whose `match`
    strings the item's name (or `also`, its Arborist species) contains ("*" = all) is merged, later ones winning key by key, and
    the result applied once: tint / barkTint ("#rrggbb", the leaf / bark tint itself), else
    tint1 / tint2 / bark1 (colours carried over from Unity), else tintCap / barkCap (the brightest the default tint may be; 1 = leave it), saturation, brightness, smoothness, ao, mainColor / occlusion (the Lake Plants shader),
    even (true: the second leaf tone = the first), lodFactor, renderDistance, scale, sampleDistance, shadows, billboardTint / billboardBrightness. Arborist's default tints are near white, far too bright under a course's
    own light; a grey tint makes leaves muddy, so a tint is normally a green."""
    look: dict = {}
    for rule in rules:
        if any(m == "*" or m.lower() in item["Name"].lower() or (also and m.lower() in also.lower()) for m in rule.get("match", ["*"])):
            look.update({k: v for k, v in rule.items() if k != "match"})
    blocks = [item.get("ShaderControllerSettings")] + list(item.get("ShaderControllerSettingsArray") or [])
    for block in blocks:
        for prop in (block or {}).get("ControlerPropertyList") or []:
            name = prop.get("PropertyName")
            if name in FOLIAGE_COLOURS:
                carried = look.get("tint2" if name in ("TintColor2", "DryColorTint") else "tint1")
                if "tint" in look:
                    prop["ColorValue"] = _hex_colour(look["tint"])
                elif carried:
                    prop["ColorValue"] = _hex_colour(carried)
                elif "tintCap" in look:
                    prop["ColorValue"] = _cap_colour(prop["ColorValue"], look["tintCap"])
            elif name in BARK_COLOURS:
                if "barkTint" in look:
                    prop["ColorValue"] = _hex_colour(look["barkTint"])
                elif "bark1" in look:
                    prop["ColorValue"] = _hex_colour(look["bark1"])
                elif "barkCap" in look:
                    prop["ColorValue"] = _cap_colour(prop["ColorValue"], look["barkCap"])
            elif name == "TextureSaturation" and "saturation" in look:
                prop["FloatValue"] = look["saturation"]
            elif name == "TextureBrightness" and "brightness" in look:
                prop["FloatValue"] = look["brightness"]
            elif name == "Smoothness" and "smoothness" in look:  # NatureManufacture items default to 1: wet-looking leaves
                prop["FloatValue"] = look["smoothness"]
            elif name == "AOPower" and "ao" in look:
                prop["FloatValue"] = look["ao"]
            elif name == "MainColor" and "mainColor" in look:  # the Lake Plants shader (Arb_Standard) has this one colour
                prop["ColorValue"] = _hex_colour(look["mainColor"])
            elif name == "OcclusionStrength" and "occlusion" in look:
                prop["FloatValue"] = look["occlusion"]
    if look.get("even"):
        # One leaf tone instead of the shader's healthy/dry pair, which mottles the crown.
        for block in blocks:
            props = {p.get("PropertyName"): p for p in (block or {}).get("ControlerPropertyList") or []}
            for first, second in (("TintColor1", "TintColor2"), ("HealthyColorTint", "DryColorTint")):
                if first in props and second in props:
                    props[second]["ColorValue"] = props[first]["ColorValue"]
    if "lodFactor" in look:
        item["LODFactor"] = look["lodFactor"]
    # The share of the system's plant (or tree) distance the item is drawn to. Ground plants and
    # bushes stand in the trees' shade; beyond the player's shadow distance (GSPro Medium: 250 m)
    # nothing shades them and they glint as white specks against the dark floor (seen from Vreta's
    # first tee 2026-10-12), so they must end before it.
    if "renderDistance" in look:
        item["RenderDistanceFactor"] = look["renderDistance"]
    # Thinning instead of a line: from this share of the item's render distance on, fewer and fewer of its
    # instances are drawn, so the planting fades out rather than ending in a visible edge (null = off).
    if "falloffStart" in look:
        item["UseDistanceFalloff"] = look["falloffStart"] is not None
        if look["falloffStart"] is not None:
            item["DistanceFalloffStartDistance"] = look["falloffStart"]
    # x the item's own size range: a stand-in model is seldom the size of the prefab it replaces.
    if "scale" in look:
        item["MinScale"], item["MaxScale"] = item["MinScale"] * look["scale"], item["MaxScale"] * look["scale"]
    if "sampleDistance" in look:   # x the item's own spacing (2 = a quarter as many)
        item["SampleDistance"] = item["SampleDistance"] * look["sampleDistance"]
    # The billboard is baked from the model once, by Arborist; its own tint and brightness bring
    # it to the colour the model has on screen (measured: unity/ArboristMod/calibrate.py billboards).
    if "billboardTint" in look:
        item["BillboardTintColor"] = _hex_colour(look["billboardTint"])
    if "billboardBrightness" in look:
        item["BillboardBrightness"] = look["billboardBrightness"]
    if "billboardDesat" in look:
        item["BillboardDesat"] = look["billboardDesat"]
    if "billboardNormal" in look:  # below 1: less of the billboard's hard light and shadow sides
        item["BillboardNormalStrength"] = look["billboardNormal"]
    if "shadows" in look:
        item["DisableShadows"] = not look["shadows"]


def tree_item(base: dict, variant: str, looks: list[dict], far: bool) -> dict:
    """The trees package's item `variant`: the library item `base` under that name in `looks` (apply_look's
    rules, the species file's treeSettings first), or with `far` its billboard-only copy. Its id follows
    from the name, so every run (and the edit loop) gives the same item the same id."""
    import uuid
    item = copy.deepcopy(base)
    item.update({"Name": variant, "VegetationItemID": str(uuid.uuid5(uuid.NAMESPACE_URL, "golfmap-trees/" + variant)), "EnableRuntimeSpawn": False})
    apply_look(item, looks)
    return far_copy(item) if far else item


def far_copy(item: dict) -> dict:
    """A background tree, as Arborist courses make them (e.g. OconeeGC's "Pine Forest Billboards"):
    render distance factor 0, so no mesh at any distance and the billboard from the first metre;
    no collider, no shadow."""
    import uuid
    far = copy.deepcopy(item)
    far.update({"Name": item["Name"] + FAR_SUFFIX, "VegetationItemID": str(uuid.uuid5(uuid.NAMESPACE_URL, "golfmap-trees-far/" + item["Name"])),
                "RenderDistanceFactor": 0, "ColliderType": "Disabled", "DisableShadows": True, "UseBillboards": True})
    return far


class FarRule:
    """Which trees are scenery: billboard only. A tree that is both more than `outside_m` outside the
    course boundary (the GKD's pOOB) and more than `play_m` from the playing field (the surface
    map's rough, semi, fairway, green, tee and bunker, wherever they lie: the driving range and the
    club's holes outside this layout's boundary count too) is never seen from close by. Every tree
    inside the boundary is a full model. Both distances are looked up on 1 m grids over the
    terrains' square. (Until 2026-10-14 either distance alone made a billboard: the range, about
    100 m outside Vreta's boundary, then stood among billboards a few metres away.)"""

    PLAY = ("rough", "semi", "fairway", "green", "tee", "bunker")

    def __init__(self, surfaces: Path, gkd: Path, square: tuple[float, float, float, float], outside_m: float, play_m: float):
        import numpy as np
        from PIL import Image, ImageDraw
        from scipy import ndimage

        self.x0, self.z0, x1, z1 = square
        self.w, self.h = int(math.ceil(x1 - self.x0)), int(math.ceil(z1 - self.z0))
        self.outside_m, self.play_m = outside_m, play_m
        meta = json.loads(surfaces.read_text(encoding="utf-8"))
        classes = [int(k) for k, v in meta["classes"].items() if v in self.PLAY]
        cell = meta["cellM"]
        fine = np.isin(np.fromfile(surfaces.with_name(meta["data"]), dtype=np.uint8).reshape(meta["height"], meta["width"]), classes)
        step = int(round(1 / cell))
        coarse = fine[:fine.shape[0] // step * step, :fine.shape[1] // step * step].reshape(fine.shape[0] // step, step, fine.shape[1] // step, step).any(axis=(1, 3))
        play = np.zeros((self.h, self.w), bool)   # [z - z0, x - x0]
        ox, oz = meta.get("worldOrigin", [0, 0])
        r0, c0 = int(round(oz - self.z0)), int(round(ox - self.x0))
        play[r0:r0 + coarse.shape[0], c0:c0 + coarse.shape[1]] = coarse[::-1]   # the map is north-up
        boundary = [(c["x"] - self.x0, c["z"] - self.z0) for c in (json.loads(gkd.read_text(encoding="utf-8-sig")).get("pOOB") or {}).get("coords") or []]
        self.to_play = ndimage.distance_transform_edt(~play)
        if len(boundary) < 3:
            # A course still being drawn (Omberg's first hole, 2026-10-16) has no `oob` ring yet: the playing
            # field stands in for the boundary, so the trees are judged by their distance from play alone.
            print(f"warning: {gkd.name} has no course boundary (pOOB): the playing field stands in for it "
                  "(draw an `oob` ring and export the GKD again)", file=sys.stderr)
            self.inside = play
            self.to_boundary = self.to_play
            return
        image = Image.new("1", (self.w, self.h), 0)
        ImageDraw.Draw(image).polygon(boundary, fill=1)
        self.inside = np.array(image, dtype=bool)
        self.to_boundary = ndimage.distance_transform_edt(~self.inside)

    def outside(self, x: float, z: float) -> float:
        """Metres outside the course boundary; 0 inside it."""
        c, r = min(max(int(x - self.x0), 0), self.w - 1), min(max(int(z - self.z0), 0), self.h - 1)
        return float(self.to_boundary[r, c])

    def far(self, x: float, z: float) -> bool:
        c, r = min(max(int(x - self.x0), 0), self.w - 1), min(max(int(z - self.z0), 0), self.h - 1)
        return bool(self.to_boundary[r, c] > self.outside_m and self.to_play[r, c] > self.play_m)

    def from_play(self, x: float, z: float) -> float:
        """Metres to the playing field; 0 on it."""
        c, r = min(max(int(x - self.x0), 0), self.w - 1), min(max(int(z - self.z0), 0), self.h - 1)
        return float(self.to_play[r, c])


class SizeFit:
    """A tree whose Arborist model is another shape than its Unity prefab aims at the stem Unity's palette
    matched it against (GolfMapBiome.Match): the lidar height and crown width (plus openCrownPadM outside
    woodland, x woodlandCrownMultiplier in it), weighed as there. Keeping the height only would hand the
    other model's proportions the width (Arborist's birch is twice as wide as Forst's slim one, its beech
    half as wide as the generic broadleaf). The scale goes on as a ratio to Unity's own fit, so the
    palette's jitter and hand-set scales carry over. Unity's scale limits are its prefabs', not applied to
    Arborist's model."""

    def __init__(self, stems: list[dict], rules: dict):
        self.r = rules
        self.at = {(round(s["x"] * 100), round(s["z"] * 100)): s for s in stems}
        self.woodland = self._woodland(stems)

    def _woodland(self, stems: list[dict]) -> set[str]:
        # GolfMapTreePlanter.WoodlandStems: tree-form stems with enough others of them within the radius.
        radius, need = float(self.r.get("woodlandRadiusM") or 0), int(self.r.get("woodlandMinNeighbours") or 0)
        if radius <= 0 or need <= 0:
            return set()
        tall = [s for s in stems if s["h"] > self.r.get("shrubMaxHeightM", 0)]
        grid: dict[tuple[int, int], list[dict]] = {}
        for s in tall:
            grid.setdefault((math.floor(s["x"] / radius), math.floor(s["z"] / radius)), []).append(s)
        out = set()
        for s in tall:
            gx, gz = math.floor(s["x"] / radius), math.floor(s["z"] / radius)
            n = sum(1 for dx in (-1, 0, 1) for dz in (-1, 0, 1) for o in grid.get((gx + dx, gz + dz), [])
                    if o is not s and (o["x"] - s["x"]) ** 2 + (o["z"] - s["z"]) ** 2 <= radius * radius)
            if n >= need:
                out.add(s["id"])
        return out

    def stem(self, x: float, z: float) -> dict | None:
        kx, kz = round(x * 100), round(z * 100)
        return next((self.at[k] for k in ((kx + dx, kz + dz) for dx in (-1, 0, 1) for dz in (-1, 0, 1)) if k in self.at), None)

    def scale(self, stem: dict, height_m: float, width_m: float, limits: bool) -> float:
        r = self.r
        form_tree = stem["h"] > r.get("shrubMaxHeightM", 0)
        mult, wood_weight = r.get("woodlandCrownMultiplier") or 0, r.get("woodlandWidthWeight") or 0
        canopy = form_tree and stem["id"] in self.woodland and mult >= 1 and wood_weight > 0
        if canopy:
            target, weight = 2 * stem["r"] * mult, wood_weight
        elif form_tree:
            target, weight = 2 * stem["r"] + (r.get("openCrownPadM") or 0), (r.get("openWidthWeight") or 0) or 1
        else:
            target, weight = 2 * stem["r"], 1
        s = math.exp((2 * math.log(stem["h"] / height_m) + weight * math.log(target / width_m)) / (2 + weight))
        if limits:
            s = max(r["minScale"], min(r["maxScale"], s))
        boost = r.get("woodlandScaleBoost") or 0
        if canopy and boost > 1:
            s = min(r["maxScale"], s * boost) if limits else s * boost
        return s

    def ratio(self, x: float, z: float, unity: dict, arborist: dict) -> float | None:
        """The factor on the Unity instance's scale for Arborist's model; None without a stem there (moved by hand)."""
        stem = self.stem(x, z)
        if stem is None or not (stem["h"] > 0 and stem["r"] > 0):
            return None
        return self.scale(stem, arborist["heightM"], arborist["widthM"], False) / self.scale(stem, unity["heightM"], unity["widthM"], True)


class ForstRing:
    """The species file's `forstRing`: the course's own full-model trees (the "vsp" prefabs) stand only on the
    playing field and within `playM` metres of it. Further out, and still inside the far rule, the same tree
    (position, rotation, height) is a full model of Arborist's: the species `replace` names for its prefab.
    `minM` widens the ring per prefab (part of a prefab name -> metres), for a species whose replacement
    only passes from further away. A prefab with no replacement stays the course's everywhere.

    {"playM": 30, "minM": {"PF Birch": 30}, "replace": {"PF_Oak_big Terrain": "Oak__big", "PF Birch": "S7_European_White_Birch@tint=#527e4b"}}

    `replace` keys are prefab file names (without .prefab) or parts of them; the whole name wins, then the
    longest part. Values are written as in "trees" (Label@look)."""

    def __init__(self, spec: dict):
        self.play_m = float(spec["playM"])
        self.min_m = {part.lower(): float(m) for part, m in (spec.get("minM") or {}).items()}
        self.replace = {part.lower(): label for part, label in (spec.get("replace") or {}).items() if label}

    def radius(self, stem: str) -> float:
        return max([self.play_m] + [m for part, m in self.min_m.items() if part in stem.lower()])

    def target(self, stem: str) -> str | None:
        name = stem.lower()
        if name in self.replace:
            return self.replace[name]
        parts = [part for part in self.replace if part in name]
        return self.replace[max(parts, key=len)] if parts else None

    def replaced(self, stem: str, from_play_m: float) -> bool:
        """Whether a tree of this prefab, inside the far rule and that many metres from the playing field, is Arborist's."""
        return self.target(stem) is not None and from_play_m > self.radius(stem)


class OuterKeep:
    """`outerKeep`: thins the billboard trees outside the course boundary, more the further out.
    [[400, 0.8], [1000, 0.6], [null, 0.2]] keeps 80 % within 400 m of the boundary, 60 % within 1000 m and 20 %
    beyond; a number = that share everywhere; none = every one kept. Which trees go follows from their position,
    so every run leaves the same ones out. The one implementation for the routing (`route`) and the trees writer
    (`trees`, the outer catalogue's trees); it tallies per band what it was asked and what it left out."""

    def __init__(self, spec):
        if spec is None:
            self.bands = None
        elif isinstance(spec, (int, float)):
            self.bands = [[None, float(spec)]]
        else:
            self.bands = [[None if limit is None else float(limit), float(share)] for limit, share in spec]
        # The report names the bands as the rules file writes them (400, not 400.0).
        self.shown = [list(band) for band in spec] if isinstance(spec, list) else self.bands
        self.tally = [[0, 0] for _ in self.bands or []]   # per band: billboard trees there, left out

    def __bool__(self) -> bool:
        return bool(self.bands)

    def leaves_out(self, x: float, z: float, out_m: float) -> str | None:
        """Why the billboard tree at x, z, out_m metres outside the boundary, is left out; None when it is kept."""
        if not self.bands or out_m <= 0:
            return None
        band = next(i for i, (limit, _) in enumerate(self.bands) if limit is None or out_m <= limit)
        share = self.bands[band][1]
        self.tally[band][0] += 1
        if zlib.crc32(f"o{x:.2f},{z:.2f}".encode()) / 0xFFFFFFFF < share:
            return None
        self.tally[band][1] += 1
        return f"outerKeep: {out_m:.0f} m outside the course boundary, keep {share:g}"

    def report_lines(self, skip_empty: bool = False) -> list[str]:
        """One line per band: the billboard trees there, kept and left out (skip_empty: not the bands nothing reached)."""
        return [f"outside the boundary, {'within ' + str(limit) + ' m' if limit is not None else 'further out'}: {there} billboard trees, keep {share}: {gone} left out, {there - gone} drawn"
                for (limit, share), (there, gone) in zip(self.shown or [], self.tally) if there or not skip_empty]


class Routing:
    """The course's routing rules (vegetation-rules.json `routing`, defaults pipeline/vegetation-rules/routing.json):

      {"farBillboard": {"outsideOob": 40, "fromPlay": 40}, "outerKeep": [[400, 0.8], [1000, 0.6], [null, 0.2]]}

    A tree is routed before planting, by tree id: "billboard" when FarRule calls it far (both distances
    exceeded), "out" when outerKeep then leaves that billboard out (outside the boundary, by distance band and
    position), else "own" - drawn by its own model's renderer (the course's VSP for a vsp model, Arborist's
    full model for an arborist one)."""

    def __init__(self, spec: dict | None):
        spec = spec or {}
        far = spec.get("farBillboard") or {}
        self.outside_oob = float(far.get("outsideOob", BILLBOARD_OUTSIDE_OOB_M))
        self.from_play = float(far.get("fromPlay", BILLBOARD_FROM_PLAY_M))
        self.outer_keep = OuterKeep(spec.get("outerKeep"))
        # The outer terrain plants no tree lower than this (Marcus 2026-10-21: the smallest trees add nothing to the
        # horizon forest, and a sapling model there broke the outer planting). None: every height.
        least = spec.get("outerMinHeightM")
        self.outer_min_height = float(least) if least is not None else None

    @classmethod
    def of_rules_file(cls, path: Path) -> "Routing":
        doc = json.loads(Path(path).read_text(encoding="utf-8-sig"))
        return cls(doc.get("routing"))

    def as_doc(self) -> dict:
        """The rules as a routing file records them (`rules`): what a later run compares its own rules with."""
        doc = {"farBillboard": {"outsideOob": self.outside_oob, "fromPlay": self.from_play}, "outerKeep": self.outer_keep.bands}
        if self.outer_min_height is not None:
            doc["outerMinHeightM"] = self.outer_min_height
        return doc

    def route_outer(self, x: float, z: float, outside_m: float, height: float) -> tuple[str, str | None]:
        """(the route, why it is left out) of an outer-terrain tree at world x, z, outside_m metres outside the
        course boundary. It is never the course's VSP's: an Arborist billboard, or left out when lower than
        outerMinHeightM or thinned by outerKeep."""
        if self.outer_min_height is not None and height < self.outer_min_height:
            return OUT, f"outerMinHeightM: {height:.1f} m, lower than {self.outer_min_height:g} m"
        reason = self.outer_keep.leaves_out(x, z, outside_m)
        return (OUT, reason) if reason else (BILLBOARD, None)

    def route(self, rule: "FarRule", x: float, z: float) -> tuple[str, str | None]:
        """(the route, why it is left out) of a tree at world x, z."""
        if not rule.far(x, z):
            return OWN, None
        reason = self.outer_keep.leaves_out(x, z, rule.outside(x, z))
        return (OUT, reason) if reason else (BILLBOARD, None)


def covering_square(square: tuple[float, float, float, float], surfaces: Path, gkd: Path, points: list[tuple[float, float]]) -> tuple[float, float, float, float]:
    """The part of the terrains square FarRule needs for these points: everything it measures from (the surface
    map, the boundary) and the points, on the square's own 1 m grid, so every distance comes out as over the
    whole square - a tenth of the cells on Omberg (its outer terrain is 5 km, the play 1.5 km)."""
    x0, z0, x1, z1 = square
    meta = json.loads(surfaces.read_text(encoding="utf-8"))
    sx, sz = meta.get("worldOrigin", [0, 0])
    xs = [sx, sx + meta["width"] * meta["cellM"]] + [p[0] for p in points]
    zs = [sz, sz + meta["height"] * meta["cellM"]] + [p[1] for p in points]
    for c in (json.loads(gkd.read_text(encoding="utf-8-sig")).get("pOOB") or {}).get("coords") or []:
        xs.append(c["x"])
        zs.append(c["z"])
    if not xs:
        return square
    return (max(x0, x0 + math.floor(min(xs) - x0) - 2), max(z0, z0 + math.floor(min(zs) - z0) - 2),
            min(x1, x0 + math.ceil(max(xs) - x0) + 2), min(z1, z0 + math.ceil(max(zs) - z0) + 2))


EDIT_MATCH_M = 1.0   # GolfMapTreeEdits.FallbackMatchM: an edit whose id the survey lacks takes the stem this near its original place


def edited_stems(trees_doc: dict, edits_doc: dict | None) -> tuple[list[dict], list[str]]:
    """The survey's stems ({id, x, z}, terrain-local) with the tree edits applied first, as Unity's planter applies
    them (GolfMapTreeEdits.Apply): add, delete, modify (moved) by id, else by the stem nearest the record's
    original position. Returns the stems and the warnings for records that matched nothing."""
    stems = [{"id": t["id"], "x": float(t["x"]), "z": float(t["z"]), "h": float(t.get("h") or 0)} for t in trees_doc["trees"]]
    by_id = {}
    for s in stems:
        by_id.setdefault(s["id"], s)
    taken: set[int] = set()
    removed: set[int] = set()
    warnings: list[str] = []

    def add_stem(e: dict) -> None:
        """A stem the survey lacks, where the edit puts it (taken: no later record matches it by position)."""
        s = {"id": e["id"], "x": float(e["x"]), "z": float(e["z"]), "h": float(e.get("heightM") or e.get("h") or 0)}
        stems.append(s)
        by_id[s["id"]] = s
        taken.add(id(s))

    for e in (edits_doc or {}).get("edits") or []:
        op = e.get("op")
        if op == "add":
            if e["id"] in by_id:
                warnings.append(f"added tree id already in the survey: {e['id']}")
            else:
                add_stem(e)
            continue
        target = by_id.get(e["id"])
        if target is None:
            best, best_d = None, EDIT_MATCH_M * EDIT_MATCH_M
            for s in stems:
                if id(s) in taken or id(s) in removed:
                    continue
                d = (s["x"] - float(e.get("ox", 0))) ** 2 + (s["z"] - float(e.get("oz", 0))) ** 2
                if d < best_d:
                    best, best_d = s, d
            target = best
            if target is None and op == "modify" and e.get("h", 0) > 0 and e.get("r", 0) > 0:
                add_stem(e)   # a modify of a tree the survey no longer has: Unity plants it as recorded
                continue
            if target is None:
                warnings.append(f"edit {op} {e['id']} matches no survey tree")
                continue
        if op == "delete":
            removed.add(id(target))
            continue
        target["x"], target["z"] = float(e["x"]), float(e["z"])
        if float(e.get("heightM") or 0) > 0:
            target["h"] = float(e["heightM"])   # a resized tree is judged at its new height
        taken.add(id(target))
    return [s for s in stems if id(s) not in removed], warnings


def route_command(args) -> None:
    """Route a terrain's trees before planting (the routing policy as rules): the trees export with the tree edits
    applied, judged by the course's `routing` rules (Routing, FarRule) on its surface map and the GKD's
    boundary. Writes golfmap-routing-v1 {routes: {tree id: own | billboard | out}} to --out (not with --dry-run)
    and prints 'own N, billboard M, left out L'; with --json the last line is {"counts": ..., "out": ...} too."""
    trees_path = Path(args.trees)
    trees_doc = json.loads(trees_path.read_text(encoding="utf-8-sig"))
    if trees_doc.get("format") != "unity-trees-v1":
        sys.exit(f"{trees_path}: not a unity-trees-v1 file")
    edits_doc = None
    if args.edits and Path(args.edits).is_file():
        edits_doc = json.loads(Path(args.edits).read_text(encoding="utf-8-sig"))
        if edits_doc.get("format") != "golfmap-tree-edits-v1":
            sys.exit(f"{args.edits}: not a golfmap-tree-edits-v1 file")
    rules = Routing.of_rules_file(Path(args.rules)) if args.rules else Routing(None)
    stems, warnings = edited_stems(trees_doc, edits_doc)
    # --ids: only these trees are routed again (an edit touched them), the rest keep the routes of --from. Every
    # other tree then stays as Unity's last planting stored it. A routing of other trees or other rules is
    # routed whole instead.
    base = None
    if args.ids:
        source = Path(args.base or args.out)
        base = json.loads(source.read_text(encoding="utf-8-sig")) if source.is_file() else None
        why = ("no routing yet" if base is None else
               "not a " + ROUTING_FORMAT + " file" if base.get("format") != ROUTING_FORMAT else
               "made from " + str(base.get("trees")) if base.get("trees") != trees_path.name else
               "made with other rules" if base.get("rules") != rules.as_doc() else None)
        if why:
            print(f"routing every tree: {source.name} is {why}" if base is not None else f"routing every tree: {why} ({source.name})")
            base = None
    wanted = set(args.ids) if base is not None else None
    # The terrain's local metres to Unity's world (the inner terrain stands at the origin).
    ox, oz = args.origin
    judged = [s for s in stems if wanted is None or s["id"] in wanted]
    outer = (trees_doc.get("plot") or {}).get("terrain") == "outer"
    boundary = [(c["x"], c["z"]) for c in (json.loads(Path(args.gkd).read_text(encoding="utf-8-sig")).get("pOOB") or {}).get("coords") or []]
    if outer and len(boundary) >= 3:
        # The outer terrain needs only the distance outside the course boundary (outerKeep), straight from the
        # GKD's ring: no grid over the 5 km square, so the whole terrain routes in a second.
        import shapely
        ring = shapely.Polygon(boundary)
        outside = shapely.distance(ring, shapely.points([(s["x"] + ox, s["z"] + oz) for s in judged])) if judged else []
        routed = {s["id"]: rules.route_outer(s["x"] + ox, s["z"] + oz, float(d), s.get("h", 0.0))[0] for s, d in zip(judged, outside)}
    else:
        square = covering_square(tuple(args.terrains_square), Path(args.surfaces), Path(args.gkd), [(s["x"] + ox, s["z"] + oz) for s in judged])
        rule = FarRule(Path(args.surfaces), Path(args.gkd), square, rules.outside_oob, rules.from_play)
        if outer:   # no boundary ring: FarRule's stand-in (the playing field) gives the distance outside
            routed = {s["id"]: rules.route_outer(s["x"] + ox, s["z"] + oz, rule.outside(s["x"] + ox, s["z"] + oz), s.get("h", 0.0))[0] for s in judged}
        else:
            routed = {s["id"]: rules.route(rule, s["x"] + ox, s["z"] + oz)[0] for s in judged}
    if base is None:
        routes = routed
    else:
        # A deleted tree leaves the routing; an added or moved one takes its new route.
        routes = {i: r for i, r in base["routes"].items() if i not in wanted}
        routes.update(routed)
    counts = {k: sum(1 for v in routes.values() if v == k) for k in (OWN, BILLBOARD, OUT)}
    for w in warnings:
        print(f"warning: {w}", file=sys.stderr)
    print(f"own {counts[OWN]}, billboard {counts[BILLBOARD]}, left out {counts[OUT]}"
          f" ({len(routes)} trees of {trees_path.name}{' with ' + Path(args.edits).name if edits_doc else ''}"
          + (f"; routed again: {', '.join(f'{i} {r}' for i, r in sorted(routed.items())) or 'none'} of {len(wanted)}" if wanted is not None else "")
          + f"; billboard beyond {rules.outside_oob:g} m outside the boundary and {rules.from_play:g} m from play"
          + (", outerKeep " + json.dumps(rules.outer_keep.bands) if rules.outer_keep else "") + ")")

    def summary(out: Path | None) -> None:
        if args.json:
            print(json.dumps({"counts": counts, "out": str(out) if out else None}))

    if args.dry_run:
        print("dry run: nothing written")
        summary(None)
        return
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    doc = {"format": ROUTING_FORMAT,
           "comment": "Each tree by id, routed before planting (arborist.py route): own = drawn by its model's renderer, billboard = an Arborist billboard whatever the model, out = left out (outerKeep). Unity's planter puts into the course's VSP only vsp models routed own; arborist.py trees draws the rest.",
           "trees": trees_path.name, "edits": Path(args.edits).name if edits_doc else None,
           "rules": rules.as_doc(), "counts": counts, "routes": routes}
    tmp = out.with_name(out.name + ".tmp")
    tmp.write_text(json.dumps(doc, indent=0), encoding="utf-8")
    os.replace(tmp, out)
    print(f"wrote {out}")
    summary(out)


def tree_policy(args, species_file: dict) -> "LegacyPolicy | RoutedPolicy":
    """Who draws which tree. A course is routed when its vegetation-rules.json has `routing` (the app then passes
    --routing and --rules together, ArboristService.trees): the routing file is derived from those rules, so one
    without the other is refused, and so is a routing file made with other rules than the course's now."""
    if not args.routing:
        if args.rules:
            sys.exit("--rules goes with --routing (a routed course): without a routing file the species file's far rule applies")
        return LegacyPolicy(species_file)
    if not args.rules:
        sys.exit("--routing needs --rules (the course's vegetation-rules.json whose `routing` made it): "
                 "without them the outer catalogue would be drawn by the defaults, not the course's far rule and outerKeep")
    rules = Routing.of_rules_file(Path(args.rules))
    routes: dict[str, str] = {}
    # One routing file per terrain (<prefix>-inner-routing.json, and -outer- when the outer terrain is routed too).
    for path in args.routing:
        doc = json.loads(Path(path).read_text(encoding="utf-8-sig"))
        if doc.get("format") != ROUTING_FORMAT:
            sys.exit(f"{path}: not a {ROUTING_FORMAT} file")
        if doc.get("rules") != rules.as_doc():
            sys.exit(f"{Path(path).name} was routed with other rules ({json.dumps(doc.get('rules'))}) than {args.rules} has now "
                     f"({json.dumps(rules.as_doc())}): route again (bun run arborist -- route <course>), then plant in Unity")
        routes.update(doc["routes"])
    return RoutedPolicy(routes, ", ".join(args.routing), rules)


def fit_lines(fitted: int, unfitted: int) -> list[str]:
    """The palette fit's report: the trees sized to their lidar stem (SizeFit)."""
    return [f"{fitted} tree(s) of another shape than their Unity prefab sized to their lidar stem (palette rules)"
            + (f", {unfitted} without a stem at their position kept the height" if unfitted else "")]


class LegacyPolicy:
    """Who draws a tree on a course that is not routed (no --routing; Vreta): the species file's "vsp" list keeps
    those prefabs' full-model trees in the course's own VSP; the far rule (and forstRing) decides while drawing
    which of them Arborist draws after all, and Unity trims those from its VSP (the -vsp-far.json list)."""

    placements_what = "of Arborist models from the placements"
    ids_comment = "id null: a tree of the course's VSP with no placement at its position (no --placements, or moved by hand in VSP)."

    def __init__(self, species_file: dict):
        # Hybrid course: prefabs named under "vsp" keep their full-model trees in the course's own VSP
        # (Unity: golfmap.vsp.trees on=true keep=[...], the same list). Their scenery trees still come
        # from here as billboard-only copies; with the far rule those are also trees of the inner
        # catalogue, which Unity must then stop drawing (golfmap.vsp.trees.trim with the file written
        # beside --planted).
        self.in_vsp = [part.lower() for part in species_file.get("vsp", [])]
        # The far rule and outerKeep: the species file's billboardBeyondM and outerKeep.
        beyond = species_file.get("billboardBeyondM", {})
        self.far_rule_m = (float(beyond.get("outsideOob", BILLBOARD_OUTSIDE_OOB_M)), float(beyond.get("fromPlay", BILLBOARD_FROM_PLAY_M)))
        self.outer_keep = OuterKeep(species_file.get("outerKeep"))

    def check_vsp(self, in_dump: set[str], vsp_ids: list[str]) -> list[str]:
        return []   # the species file's list decides while drawing: nothing was decided before planting

    def kept_in_vsp(self, prefab: str) -> bool:
        """Whether this prefab's trees are the course's VSP's (unless the far rule or the ring hands them over)."""
        return any(part in Path(prefab).stem.lower() for part in self.in_vsp)

    def vsp_draws_all(self, outer: bool) -> bool:
        """Whether the course's VSP draws every dump tree of this catalogue, whatever its prefab."""
        return False

    def tree_route(self, placement: dict, outer: bool) -> str | None:
        """The placement's route decided before planting; None = decided here (the far rule, outerKeep)."""
        return None

    def lists(self, entry: dict) -> bool:
        """Whether arboristdata.ids.json lists this tree (drawn or left out)."""
        return True

    def band_lines(self, outer_keep: OuterKeep) -> list[str]:
        return outer_keep.report_lines()

    def vsp_lines(self, *, rule, total: int, far_total: int, left: dict, routed_away: dict, ring, ringed: dict,
                  trim: list, planted: str) -> list[str]:
        """What the course's VSP keeps and what Arborist took over; with the far rule, writes the trim list."""
        lines = []
        if left:
            lines.append("left to the course's VSP (\"vsp\" in the species file): " + ", ".join(f"{k} x{v}" for k, v in left.items()))
        if not rule:
            return lines
        lines.append(f"far rule (more than {rule.outside_m:g} m outside the boundary and more than {rule.play_m:g} m from the play): "
                     f"{far_total} billboard-only, {total - far_total} full models here")
        trim_file = Path(planted).with_name(Path(planted).stem.replace("-planted-trees", "") + "-vsp-far.json")
        trim_file.write_text(json.dumps({"format": "golfmap-vsp-far-v1", "comment": "x, z of the trees of the course's own VSP (the \"vsp\" prefabs, inner catalogue) that Arborist now draws, as billboards (the far rule) or as full models of another species (forstRing): Unity must not draw them (golfmap.vsp.trees.trim restore=true, then file=<this file>).", "positions": trim}), encoding="utf-8")
        full = sum(sum(v.values()) for v in ringed.values())
        if ring:
            lines.append(f"ring rule (forstRing: the course's own trees within {ring.play_m:g} m of the play"
                         + "".join(f", {part} {m:g} m" for part, m in ring.min_m.items() if m > ring.play_m)
                         + f"): {sum(left.values())} kept in the course's VSP, {full} replaced by Arborist full models")
            for slot in sorted(ringed):
                lines.append(f"  {slot}: " + ", ".join(f"{name} x{n}" for name, n in ringed[slot].items()))
        lines.append(f"{len(trim)} tree(s) of the course's VSP are now Arborist's ({len(trim) - full} billboards, {full} full models): "
                     f"{trim_file} (Unity: golfmap.vsp.trees.trim restore=true, then file=<that path>)")
        return lines


class RoutedPolicy:
    """Who draws a tree on a routed course (--routing, golfmap-routing-v1 from `route`): decided before planting.
    The course's VSP holds exactly its vsp models routed "own" (Unity's planter stored only those), so the dump's
    trees of the inner catalogue are its to draw; every other inner placement is Arborist's - "own" an Arborist
    model in full, "billboard" a billboard-only copy whatever the model, "out" left out (outerKeep). The outer
    catalogue's trees are not routed: the far rule and outerKeep decide them while drawing. Nothing is trimmed."""

    placements_what = "drawn from the placements"
    ids_comment = "Routed (--routing): only trees with a tree id are listed (the placements); the outer catalogue's trees have none."

    def __init__(self, routes: dict[str, str], path: str, rules: Routing):
        self.routes = routes
        self.path = path
        # The far rule and outerKeep of the rules that made the routing: the outer catalogue's trees are drawn by them.
        self.far_rule_m = (rules.outside_oob, rules.from_play)
        self.outer_keep = rules.outer_keep
        self.in_vsp: set[str] = set()

    def check_vsp(self, in_dump: set[str], vsp_ids: list[str]) -> list[str]:
        """What the course's VSP holds now (the dump's inner trees by tree id) against the routing of the inner
        vsp placements. A tree the routing sends to Arborist but VSP still holds (routed again after the last
        planting) stays VSP's, so it is drawn once; a vsp tree routed own that VSP lacks is drawn by nobody.
        Both until Unity plants again."""
        self.in_vsp = in_dump
        held = sorted(i for i in in_dump if self.routes.get(i, OWN) != OWN)
        missing = sorted(i for i in vsp_ids if i not in in_dump and self.routes.get(i, OWN) == OWN)
        some = lambda ids: ", ".join(ids[:3]) + (", ..." if len(ids) > 3 else "")
        return ([f"warning: {len(held)} tree(s) the course's VSP holds are routed to Arborist since the last planting ({some(held)}): "
                 "VSP still draws them; plant again in Unity"] if held else []) + \
               ([f"warning: {len(missing)} vsp tree(s) routed own are not in the course's VSP ({some(missing)}): "
                 "nobody draws them; plant again in Unity"] if missing else [])

    def kept_in_vsp(self, prefab: str) -> bool:
        return False   # no "vsp" list: the routing decided per tree

    def vsp_draws_all(self, outer: bool) -> bool:
        return not outer

    def tree_route(self, placement: dict, outer: bool) -> str | None:
        # An outer placement goes where the outer terrain's routing says; one it does not name (no outer routing
        # file) is decided here by the far rule and outerKeep. An inner one: what VSP holds, it draws.
        if outer:
            return self.routes.get(placement["id"])
        return OWN if placement["id"] in self.in_vsp else self.routes.get(placement["id"], OWN)

    def lists(self, entry: dict) -> bool:
        # One with no tree id (the outer catalogue's dump trees) is counted only.
        return entry.get("id") is not None

    def band_lines(self, outer_keep: OuterKeep) -> list[str]:
        # outerKeep thinned the inner trees in the routing already; the bands here are the outer catalogue's.
        return outer_keep.report_lines(skip_empty=True)

    def vsp_lines(self, *, rule, total: int, far_total: int, left: dict, routed_away: dict, ring, ringed: dict,
                  trim: list, planted: str) -> list[str]:
        lines = [f"routed ({self.path}): {sum(left.values())} tree(s) of vsp models routed own are the course's VSP's; "
                 f"{sum(routed_away.values())} of vsp models are Arborist billboards"
                 + (" (" + ", ".join(f"{k} x{v}" for k, v in sorted(routed_away.items())) + ")" if routed_away else "")
                 + "; no trim: Unity's VSP holds only what is routed own"]
        if rule:
            lines.append(f"{far_total} billboard-only, {total - far_total} full models here")
        return lines


def trees(args) -> None:
    """The trees Unity's `golfmap.trees.dump` wrote, as placed instances of Arborist's species.
    A tree keeps its position, rotation and height: its scale is multiplied by
    (our model's height / Arborist's model's height), 1 where the model is the same. The planter's
    own stretch (crown width against height) is kept as a ratio; a different model keeps its own
    proportions otherwise. Prefabs under "vsp" in the species file are left out (see below).
    With --surfaces, FarRule decides tree by tree which are billboard-only copies; without it the
    whole outer catalogue is. With --surfaces and "forstRing" in the species file, the "vsp" trees
    beyond the ring are full models of the species it names (ForstRing).

    --placements (golfmap-placements-v1, Unity's planter: <prefix>-<terrain>-placements.json) hands over the
    trees of Arborist models, which the course's VSP never holds: each is drawn at its position, rotation and
    scale as Unity placed it, through the same routing policy (the far rule's billboards, outerKeep), in the
    model's look from --models (the course's models.json). The VSP placements name the tree ids of the dump's
    trees. Every placement Arborist is handed - drawn, or left out by the routing policy and why - is listed
    by tree id in arboristdata.ids.json beside the .dat (golfmap-arborist-ids-v1).

    --routing (golfmap-routing-v1, `route`: the course's routing rules decided before planting) replaces the
    "vsp" list, the far rule and the trim for the placements of that terrain: the course's VSP holds exactly its
    vsp models routed "own" (Unity's planter stored only those), so the dump's trees of the inner catalogue are
    left to it; every other placement is Arborist's - "own" an Arborist model drawn in full, "billboard" a
    billboard-only copy whatever the model (a vsp model's billboard is the Arborist model its library entry
    names as `billboardAs`, else the name rule's), "out" left out with the reason outerKeep. No trim list is
    written. --rules (the course's vegetation-rules.json) gives the far rule and outerKeep for the rest (the
    outer catalogue's trees)."""

    species_file = json.loads(Path(args.species).read_text(encoding="utf-8")) if Path(args.species).is_file() else {}
    # Who draws which tree: the routing file's decisions, or the species file's "vsp" list, far rule and trim.
    policy = tree_policy(args, species_file)
    key = key_file(args.key_file)
    # Several catalogue names end in a space; names are compared without it.
    library = {item["Name"].strip(): item for item in json.loads(Path(args.library).read_text(encoding="utf-8-sig"))["VegetationInfoList"]}
    sizes = {a["label"].strip(): a for a in json.loads(Path(args.sizes).read_text(encoding="utf-8"))["result"]["assets"] if a.get("heightM")}
    overrides = species_file.get("trees", {})
    look = species_file.get("treeSettings", [])
    planted = json.loads(Path(args.planted).read_text(encoding="utf-8"))["items"]
    fit = SizeFit(json.loads(Path(args.stems).read_text(encoding="utf-8-sig"))["trees"],
                  json.loads(Path(args.palette).read_text(encoding="utf-8-sig"))["rules"]) if args.stems and args.palette else None
    fitted, unfitted = 0, 0
    x0, z0, x1, z1 = args.terrains_square
    grid = Grid(x0, z0, x1, z1)

    items: dict[str, dict] = {}
    cells: dict[int, dict] = {}
    rule = None
    if args.surfaces:
        gkds = [Path(args.gkd)] if args.gkd else sorted(Path(args.course_dir).glob("*.GKD"))
        if not gkds:
            sys.exit("No .GKD in the course folder for the course boundary; give --gkd.")
        rule = FarRule(Path(args.surfaces), gkds[0], (x0, z0, x1, z1), *policy.far_rule_m)
    rows, unmapped, outside, thinned, left, trim = [], [], 0, 0, {}, []
    # Tree ids (arboristdata.ids.json): the placements of every tree handed to Arborist, drawn or left out.
    drawn: list[dict] = []
    left_out: list[dict] = []
    placement_docs = [json.loads(Path(p).read_text(encoding="utf-8-sig")) for p in (args.placements or [])]
    for p, doc in zip(args.placements or [], placement_docs):
        if doc.get("format") != "golfmap-placements-v1":
            sys.exit(f"{p}: not a golfmap-placements-v1 file")
    # The dump's trees by position, to their placement (the VSP ones; Unity's 1 cm cell-edge nudge included).
    placed_at: dict[tuple[int, int], dict] = {}
    for doc in placement_docs:
        for placement in doc["placements"]:
            if parse_model_id(placement.get("model", ""))[0] != ARBORIST:
                placed_at[(round(placement["x"] * CM), round(placement["z"] * CM))] = placement
    nudges = range(-NUDGE_TOLERANCE_CM, NUDGE_TOLERANCE_CM + 1)

    def placement_at(x: float, z: float) -> dict | None:
        kx, kz = round(x * CM), round(z * CM)
        return next((placed_at[k] for k in ((kx + dx, kz + dz) for dx in nudges for dz in nudges) if k in placed_at), None)

    def dump_entry(x: float, z: float, name: str) -> dict:
        """A dump tree's tree id and model: its placement's, or none for a tree of the course's VSP without one."""
        placement = placement_at(x, z) if placed_at else None
        return {"id": placement["id"] if placement else None, "model": placement["model"] if placement else model_id(VSP, name)}

    def record_drawn(entry: dict, slot: str, x: float, z: float) -> None:
        if policy.lists(entry):
            drawn.append({**entry, "item": slot, "x": round(x, 3), "z": round(z, 3)})

    def record_left_out(entry: dict, reason: str) -> None:
        if policy.lists(entry):
            left_out.append({**entry, "reason": reason})

    def billboarded(base: dict):
        """Whether a library item gets a billboard-only copy for the scenery trees (--far, a tree with a billboard)."""
        return args.far and base.get("VegetationType") == "Tree" and bool(base.get("BillboardTexture"))

    def ensure_items(base: dict, variant: str, can_far: bool, looks: list[dict]) -> None:
        """The Arborist item `variant` (the library's `base` under that name, in the species file's treeSettings
        and then `looks`) and, when it can_far, its billboard-only copy; each made once."""
        for far in (False, True):
            slot = variant + (FAR_SUFFIX if far else "")
            if slot in items or (far and not can_far):
                continue
            items[slot] = tree_item(base, variant, look + looks, far)

    def place_in_cell(x: float, z: float, far: bool) -> tuple[int | None, dict | None, str | None]:
        """Where a tree Arborist draws goes: (its cell index, the cell's rect, None), or (None, None, why it is
        left out). A billboard-only tree (far) outside the course boundary is thinned by outerKeep (OuterKeep)."""
        nonlocal outside
        if far and rule and outer_keep:
            reason = outer_keep.leaves_out(x, z, rule.outside(x, z))
            if reason:
                return None, None, reason
        try:
            index, rect = grid.cell(x, z)
        except ValueError:
            outside += 1
            return None, None, "outside the terrains"
        return index, rect, None

    def bucket(index: int, rect: dict, item_id: str, position: tuple, scale: tuple, rotation: tuple) -> None:
        """One tree instance into its cell, under its item."""
        cell = cells.setdefault(index, {"cellIndex": index, "cellRect": rect, "PersistentVegetationInfoList": [], "_by": {}})
        info = cell["_by"].get(item_id)
        if info is None:
            info = cell["_by"][item_id] = {"VegetationItemID": item_id, "VegetationItemList": []}
            cell["PersistentVegetationInfoList"].append(info)
        (x, y, z), (sx, sy, sz), (qx, qy, qz, qw) = position, scale, rotation
        info["VegetationItemList"].append({
            "Position": {"x": round(x - x0, 3), "y": y, "z": round(z - z0, 3)},
            "Scale": {"x": round(sx, 4), "y": round(sy, 4), "z": round(sz, 4)},
            "Rotation": {"x": qx, "y": qy, "z": qz, "w": qw}, "VegetationSourceID": TREE_SOURCE_ID, "DistanceFalloff": 1})

    # "forstRing" (ForstRing): the "vsp" trees beyond the ring and inside the far rule become full models here.
    ring = ForstRing(species_file["forstRing"]) if rule and species_file.get("forstRing") else None
    ringed: dict[str, dict[str, int]] = {}   # Arborist item -> prefab -> trees
    outer_keep = policy.outer_keep
    # The inner trees the course's VSP holds now, by tree id: checked against the routing before the placements are drawn.
    in_dump = {e["id"] for source in planted if "(billboards)" not in source["catalogue"]
               for e in (dump_entry(i[0], i[2], source["name"]) for i in source["instances"]) if e["id"]} if args.routing and placed_at else set()
    vsp_ids = [p["id"] for doc in placement_docs if doc.get("terrain") != "outer"
               for p in doc["placements"] if parse_model_id(p.get("model", ""))[0] != ARBORIST]
    held_lines = policy.check_vsp(in_dump, vsp_ids)
    for source in planted:
        kept_in_vsp = policy.kept_in_vsp(source["prefab"])
        outer = "(billboards)" in source["catalogue"]
        if policy.vsp_draws_all(outer):
            left[source["name"]] = left.get(source["name"], 0) + len(source["instances"])
            continue
        if kept_in_vsp and not rule and not (args.far and outer):
            left[source["name"]] = left.get(source["name"], 0) + len(source["instances"])
            continue
        def variant_of(target: str | None, far_too: bool = True):
            """The items of "Label@tint=#rrggbb,...": the species with a look of its own, as its own item (two
            of our prefabs can share a model and still differ in colour). Returns the label, the item's name,
            whether it has a billboard-only copy, the share to keep and the scale factor; None when unmapped."""
            label, _, extra = (target or "").partition("@")
            label = label.strip() or None
            own = {k: (v if v.startswith("#") else float(v)) for k, v in (pair.split("=") for pair in extra.split(",") if pair)}
            # keep=0.8: only that share of the prefab's trees (which ones follows from their position,
            # so a rerun thins the same trees).
            keep = float(own.pop("keep", 1.0))
            extra = ",".join(pair for pair in extra.split(",") if pair and not pair.startswith("keep="))
            if label is None or label not in library or label not in sizes:
                unmapped.append(f"{source['name']} ({len(source['instances'])} trees" + (f" -> {label}, not in the library" if label else "") + ")")
                return None
            # Scenery trees are billboards only, where the species has a billboard: the outer catalogue's,
            # or with the far rule every tree it names.
            base = library[label]
            can_far = far_too and billboarded(base)
            variant = label + (" [" + extra + "]" if extra else "")
            # The billboard takes its colour from the same tints (seen in Arborist 2026-10-12: far
            # copies left at the defaults stood out yellow-green), so the look goes on both.
            # Where the model is the same NatureManufacture one (scale factor 1), the leaf and bark
            # colours approved in Unity come along (tint1/tint2/bark1): they win over the caps and
            # lose to a tint the species file or the variant names.
            unity = source.get("colours") or {}
            same_model = source["heightM"] > 0 and abs(source["heightM"] / sizes[label]["heightM"] - 1) < 0.02
            carried = {}
            if same_model and "HealtyColor" in unity:
                carried = {"match": ["*"], "tint1": unity["HealtyColor"], "tint2": unity.get("DryColor", unity["HealtyColor"])}
                if "BarkColor" in unity:
                    carried["bark1"] = unity["BarkColor"]
            ensure_items(base, variant, can_far, ([carried] if carried else []) + ([dict(own, match=["*"])] if own else []))
            return label, variant, can_far, keep, (source["heightM"] / sizes[label]["heightM"] if source["heightM"] > 0 else 1.0)

        main = variant_of(species_for(source["prefab"], list(library), overrides))
        if main is None:
            continue
        label, variant, can_far, keep, factor = main
        stem = Path(source["prefab"]).stem
        ring_as = variant_of(ring.target(stem), far_too=False) if ring and kept_in_vsp and not outer and ring.target(stem) else None
        ring_m = ring.radius(stem) if ring_as else 0.0
        counts: dict[str, int] = {}
        scales: dict[str, float] = {}   # per slot, summed: the report shows the mean factor
        for x, y, z, sx, sy, sz, qx, qy, qz, qw in source["instances"]:
            far = can_far and (rule.far(x, z) if rule else outer)
            slot, scale, share, model = variant + (FAR_SUFFIX if far else ""), factor, keep, label
            if kept_in_vsp and not outer:
                if not far:
                    if not (ring_as and rule.from_play(x, z) > ring_m):   # a full model near the play: the course's VSP draws it
                        left[source["name"]] = left.get(source["name"], 0) + 1
                        continue
                    # beyond the ring: the same tree as Arborist's full model
                    slot, share, scale, model = ring_as[1], ring_as[3], ring_as[4], ring_as[0]
                    of = ringed.setdefault(slot, {})
                    of[source["name"]] = of.get(source["name"], 0) + 1
                trim.append([round(x, 3), round(z, 3)])
            other = sizes[model]
            if fit and source["heightM"] > 0 and source.get("widthM", 0) > 0 and other.get("widthM", 0) > 0                     and not (abs(source["heightM"] / other["heightM"] - 1) < 0.02 and abs(source["widthM"] / other["widthM"] - 1) < 0.02):
                ratio = fit.ratio(x, z, source, other)
                if ratio is None:
                    unfitted += 1
                else:
                    scale, fitted = ratio, fitted + 1
            if share < 1 and zlib.crc32(f"{x:.2f},{z:.2f}".encode()) / 0xFFFFFFFF >= share:
                thinned += 1
                record_left_out(dump_entry(x, z, source["name"]), f"thinned: keep={share:g} in the species file")
                continue
            index, rect, reason = place_in_cell(x, z, far)
            if reason:
                record_left_out(dump_entry(x, z, source["name"]), reason)
                continue
            bucket(index, rect, items[slot]["VegetationItemID"], (x, y, z), (sx * scale, sy * scale, sz * scale), (qx, qy, qz, qw))
            counts[slot] = counts.get(slot, 0) + 1
            scales[slot] = scales.get(slot, 0.0) + scale
            record_drawn(dump_entry(x, z, source["name"]), slot, x, z)
        for slot, count in counts.items():
            rows.append((source["catalogue"], source["name"], slot, count, scales[slot] / count))

    # The trees of Arborist models (--placements): never in the course's VSP, so not in the dump.
    models = {m["id"]: m for m in json.loads(Path(args.models).read_text(encoding="utf-8-sig"))["models"]} if args.models else {}
    placed = 0
    routed_away: dict[str, int] = {}   # routed: vsp placements Arborist draws as billboards, by model
    for doc in placement_docs:
        outer = doc.get("terrain") == "outer"
        rows_by_model_slot: dict[tuple[str, str], int] = {}   # (model, slot) -> trees
        for placement in doc["placements"]:
            model = str(placement.get("model", ""))
            renderer, label = parse_model_id(model)
            tree_route = policy.tree_route(placement, outer)   # None: not routed, decided here
            if renderer != ARBORIST and tree_route in (None, OWN):
                continue   # the course's VSP draws it
            entry = {"id": placement["id"], "model": model}
            if tree_route == OUT:
                record_left_out(entry, "outerKeep: left out by the course's routing rules")
                continue
            hs = float(placement["scale"])
            ws = float(placement.get("widthScale") or hs)
            model_look = dict(models.get(model, {}).get("look") or {}) if renderer == ARBORIST else {}
            if renderer != ARBORIST:
                # A vsp model routed to Arborist: drawn as the billboard of the Arborist model its library entry names.
                stand_in = models.get(model, {}).get("billboardAs")
                label = parse_model_id(stand_in)[1] if stand_in else species_for(label + ".prefab", list(library), {})
                if not label or label not in library or label not in sizes:
                    record_left_out(entry, f"no Arborist model for the billboard of {model} (billboardAs in models.json)")
                    unmapped.append(f"{model} (placement {placement['id']}): no billboardAs in models.json")
                    continue
                # Its drawn size on Arborist's model: the height kept, the planter's stretch (width against height) too.
                own_height = float(placement.get("heightM") or float(models.get(model, {}).get("heightM") or 0) * hs)
                if own_height > 0:
                    k = own_height / sizes[label]["heightM"]
                    hs, ws = k, k * ws / hs
                routed_away[model] = routed_away.get(model, 0) + 1
            base = library.get(label)
            if base is None or label not in sizes:
                record_left_out(entry, f"Arborist has no model {label} (not in the library or its sizes)")
                unmapped.append(f"{model} (placement {placement['id']}): not in the library")
                continue
            # The model's own look, in Arborist's terms (models.json), on top of the species file's treeSettings.
            extra = ",".join(f"{k}={v}" for k, v in model_look.items())
            variant = label + (" [" + extra + "]" if extra else "")
            can_far = billboarded(base)
            ensure_items(base, variant, can_far, [dict(model_look, match=["*"])] if model_look else [])
            x, y, z = float(placement["x"]), float(placement["y"]), float(placement["z"])
            # Routed: billboard as the routing says (a model without a billboard stays a full model); outerKeep is behind it.
            routed = tree_route is not None
            far = can_far and (tree_route == BILLBOARD if routed else (rule.far(x, z) if rule else outer))
            slot = variant + (FAR_SUFFIX if far else "")
            index, rect, reason = place_in_cell(x, z, far and not routed)
            if reason:
                record_left_out(entry, reason)
                continue
            # Drawn as Unity placed it: the placement's scale is relative to the model's own size.
            bucket(index, rect, items[slot]["VegetationItemID"], (x, y, z), (ws, hs, ws), tuple(float(v) for v in placement["q"]))
            record_drawn(entry, slot, x, z)
            rows_by_model_slot[(model, slot)] = rows_by_model_slot.get((model, slot), 0) + 1
            placed += 1
        # No scale factor to report: a placement carries Unity's own scale, not a prefab's to correct.
        for (model, slot), count in rows_by_model_slot.items():
            rows.append((f"placements ({doc.get('terrain', '?')})", model, slot, count, 1.0))
    for cell in cells.values():
        del cell["_by"]

    package = {"PackageName": TREES_PACKAGE, "BiomeType": "Default", "BiomeName": "", "BiomeSortOrder": 1,
               "VegetationInfoList": [item for slot, item in items.items() if slot in {r[2] for r in rows}], "TextureMaskGroupList": [], "Enabled": False}
    course_dir = Path(args.course_dir)
    doc = load_any(Path(args.base) if args.base else course_dir / "arboristdata.dat", key)
    settings = doc["VSProSettings"]
    apply_vege_settings(doc, species_file)
    replaced = [p for p in settings["vegetationPackages"] if p.get("PackageName") in (TREES_PACKAGE, *args.drop_package)]
    gone = {item["VegetationItemID"] for p in replaced for item in p.get("VegetationInfoList") or []} | {i["VegetationItemID"] for i in items.values()}
    settings["vegetationPackages"] = [p for p in settings["vegetationPackages"] if p not in replaced] + [package]
    settings["totalPrefabs"] = sum(len(p.get("VegetationInfoList") or []) for p in settings["vegetationPackages"])
    for old in doc["PersistentVegetationPackage"]["PersistentVegetationCellList"]:  # instances of other packages stay
        kept = [info for info in old["PersistentVegetationInfoList"] if info["VegetationItemID"] not in gone]
        if kept:
            cell = cells.setdefault(old["cellIndex"], {"cellIndex": old["cellIndex"], "cellRect": old["cellRect"], "PersistentVegetationInfoList": []})
            cell["PersistentVegetationInfoList"].extend(kept)
    doc["PersistentVegetationPackage"] = {"PersistentVegetationCellList": [cells[k] for k in sorted(cells)]}

    out_dir = Path(args.out_dir or course_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    write_dat(doc, out_dir / "arboristdata.dat", key)
    (out_dir / "arboristversion.dat").write_text(str(doc.get("catalogVersion", CATALOG_VERSION)), encoding="ascii")
    total = sum(r[3] for r in rows)
    (out_dir / "arboristdata.ids.json").write_text(json.dumps({
        "format": "golfmap-arborist-ids-v1",
        "comment": "Every tree arborist.py trees handed to Arborist, by tree id: drawn (the item it is drawn as, its x/z in world metres) or left out by the routing policy (and why). "
                   + policy.ids_comment,
        "drawn": drawn, "leftOut": left_out}), encoding="utf-8")
    print(f"wrote {out_dir / 'arboristdata.dat'} ({(out_dir / 'arboristdata.dat').stat().st_size / 1e6:.1f} MB): {total} trees of "
          f"{len(items)} Arborist species in {len(cells)} cells, package '{TREES_PACKAGE}'"
          + (f"; replaced {', '.join(p['PackageName'] for p in replaced)}" if replaced else ""))
    by_label: dict[str, list] = {}
    for catalogue, name, label, count, factor in rows:
        by_label.setdefault(label, []).append(f"{name} x{count}" + ("" if abs(factor - 1) < 0.005 else f" (scale x{factor:.2f})"))
    for label in sorted(by_label):
        print(f"  {label}: " + ", ".join(by_label[label]))
    if outside:
        print(f"{outside} tree(s) outside the terrains, left out")
    if thinned:
        print(f"{thinned} tree(s) thinned out (keep=)")
    if placement_docs:
        print(f"{placed} tree(s) {policy.placements_what} ({', '.join(Path(p).name for p in args.placements)}); "
              f"{len(drawn)} drawn and {len(left_out)} left out by tree id: {out_dir / 'arboristdata.ids.json'}")
    report = held_lines + (fit_lines(fitted, unfitted) if fit else []) + policy.band_lines(outer_keep)
    far_total = sum(r[3] for r in rows if r[2].endswith(FAR_SUFFIX))
    report += policy.vsp_lines(rule=rule, total=total, far_total=far_total, left=left, routed_away=routed_away,
                               ring=ring, ringed=ringed, trim=trim, planted=args.planted)
    for line in report:
        print(line)
    if unmapped:
        print(f"no Arborist species for (add them under \"trees\" in {args.species}):\n  " + "\n  ".join(unmapped))


EDIT_WITHIN_M = 0.5  # how far from `at` an edited instance may stand (Unity's 1 cm cell-edge nudge, rounding)


def patch_instances(doc: dict, ops: list[dict], grid: Grid, make_item=None) -> dict:
    """Hand changes to placed instances of the trees package, in place (the Arborist edit loop,
    server/services/arborist-edit.service.ts; the mod's veg.edit makes the same change live). Each op:

      item       the instance's VegetationItemID
      at         [x, z] world: the instance of `item` nearest to it (within `within`, default EDIT_WITHIN_M)
                 is taken out; none = a new instance
      delete     true: only taken out
      position   [x, y, z] world; scale [x, y, z]; rotation [x, y, z, w]: the instance as it is now (what is
                 not given stays as it was; a new one needs all three)
      as         another item id: the instance becomes one of that item
      newItem    {label, variant, far, look}: how to make the item it ends as when the package lacks it
                 (make_item(newItem) returns it; its id must be the one asked for)

    An instance that moves into another 100 m cell moves into that cell's list. Returns what was done."""
    package = next((p for p in doc["VSProSettings"]["vegetationPackages"] if p.get("PackageName") == TREES_PACKAGE), None)
    if package is None:
        raise ValueError(f"no package '{TREES_PACKAGE}' in the file: write the trees first (arborist.py trees)")
    known = {item["VegetationItemID"]: item for item in package.get("VegetationInfoList") or []}
    cells = doc["PersistentVegetationPackage"]["PersistentVegetationCellList"]
    by_index = {cell["cellIndex"]: cell for cell in cells}
    done = {"removed": [], "added": [], "newItems": []}
    for op in ops:
        item_id = op["item"]
        was = None
        if op.get("at") is not None:
            ax, az = float(op["at"][0]) - grid.x0, float(op["at"][1]) - grid.z0
            within = float(op.get("within", EDIT_WITHIN_M))
            best = None
            for cell in cells:
                for info in cell["PersistentVegetationInfoList"]:
                    if info["VegetationItemID"] != item_id:
                        continue
                    for i, inst in enumerate(info["VegetationItemList"]):
                        d = math.hypot(inst["Position"]["x"] - ax, inst["Position"]["z"] - az)
                        if d <= within and (best is None or d < best[0]):
                            best = (d, cell, info, i)
            if best is None:
                name = known[item_id]["Name"] if item_id in known else item_id
                raise ValueError(f"no instance of '{name}' within {within:g} m of ({op['at'][0]}, {op['at'][1]}) in the file")
            _, cell, info, i = best
            was = info["VegetationItemList"].pop(i)
            if not info["VegetationItemList"]:
                cell["PersistentVegetationInfoList"].remove(info)
            done["removed"].append({"item": item_id, "cellIndex": cell["cellIndex"],
                                    "position": [was["Position"]["x"] + grid.x0, was["Position"]["y"], was["Position"]["z"] + grid.z0]})
        if op.get("delete"):
            continue
        if was is None and not all(op.get(k) is not None for k in ("position", "scale", "rotation")):
            raise ValueError("a new instance needs position, scale and rotation")
        target = op.get("as") or item_id
        if target not in known:
            if not op.get("newItem") or make_item is None:
                raise ValueError(f"the package has no item {target}, and the op says not how to make it")
            item = make_item(op["newItem"])
            if item["VegetationItemID"] != target:
                raise ValueError(f"the item made for {op['newItem'].get('variant')} has the id {item['VegetationItemID']}, not {target}")
            package.setdefault("VegetationInfoList", []).append(item)
            known[target] = item
            done["newItems"].append(item["Name"])
        if op.get("position") is not None:
            x, y, z = (float(v) for v in op["position"])
        else:
            x, y, z = was["Position"]["x"] + grid.x0, was["Position"]["y"], was["Position"]["z"] + grid.z0
        index, rect = grid.cell(x, z)
        cell = by_index.get(index)
        if cell is None:
            cell = by_index[index] = {"cellIndex": index, "cellRect": rect, "PersistentVegetationInfoList": []}
            cells.append(cell)
        info = next((i for i in cell["PersistentVegetationInfoList"] if i["VegetationItemID"] == target), None)
        if info is None:
            info = {"VegetationItemID": target, "VegetationItemList": []}
            cell["PersistentVegetationInfoList"].append(info)
        sx, sy, sz = (float(v) for v in op["scale"]) if op.get("scale") is not None else (was["Scale"][k] for k in "xyz")
        qx, qy, qz, qw = (float(v) for v in op["rotation"]) if op.get("rotation") is not None else (was["Rotation"][k] for k in "xyzw")
        info["VegetationItemList"].append({
            "Position": {"x": round(x - grid.x0, 3), "y": round(y, 3), "z": round(z - grid.z0, 3)},
            "Scale": {"x": round(sx, 4), "y": round(sy, 4), "z": round(sz, 4)},
            "Rotation": {"x": qx, "y": qy, "z": qz, "w": qw},
            "VegetationSourceID": was["VegetationSourceID"] if was else TREE_SOURCE_ID,
            "DistanceFalloff": was["DistanceFalloff"] if was else 1})
        done["added"].append({"item": target, "cellIndex": index, "position": [round(x, 3), round(y, 3), round(z, 3)]})
    # Cells emptied by the edit go, as arborist.py trees writes none; the list stays in cell order.
    doc["PersistentVegetationPackage"]["PersistentVegetationCellList"] = sorted(
        (c for c in cells if c["PersistentVegetationInfoList"]), key=lambda c: c["cellIndex"])
    doc["VSProSettings"]["totalPrefabs"] = sum(len(p.get("VegetationInfoList") or []) for p in doc["VSProSettings"]["vegetationPackages"])
    return done


def edit(args) -> None:
    """The Arborist edit loop's file half: patch_instances on the course's file, written back in place
    (or to --out). --ops is a JSON file {"ops": [...]}; prints what was done as one JSON line."""
    src = Path(args.dat)
    out = Path(args.out or args.dat)
    key = key_file(args.key_file) if ".dat" in (src.suffix.lower(), out.suffix.lower()) else None
    doc = load_any(src, key)
    ops = json.loads(Path(args.ops).read_text(encoding="utf-8-sig"))["ops"]
    library = species_file = None

    def make_item(spec: dict) -> dict:
        nonlocal library, species_file
        if library is None:
            if not args.library or not Path(args.library).is_file():
                raise ValueError(f"a new item ({spec.get('variant')}) needs the species library (--library)")
            library = {item["Name"].strip(): item for item in json.loads(Path(args.library).read_text(encoding="utf-8-sig"))["VegetationInfoList"]}
            species_file = json.loads(Path(args.species).read_text(encoding="utf-8")) if args.species and Path(args.species).is_file() else {}
        base = library.get(str(spec["label"]).strip())
        if base is None:
            raise ValueError(f"Arborist's library has no {spec['label']}")
        look = dict(spec.get("look") or {})
        return tree_item(base, spec["variant"], species_file.get("treeSettings", []) + ([dict(look, match=["*"])] if look else []), bool(spec.get("far")))

    try:
        done = patch_instances(doc, ops, Grid(*args.terrains_square), make_item)
    except ValueError as e:
        sys.exit(str(e))
    if out.suffix.lower() == ".dat":
        write_dat(doc, out, key)
    else:
        out.write_text(json.dumps(doc, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(json.dumps(done))


LINEUP_PACKAGE = "GolfMap lineup"


def lineup(args) -> None:
    """Species side by side for judging on screen: one of each named library item in a row, each
    scaled to the same height, in a package of its own that the next run replaces (--items with
    nothing removes it). The look rules of the species file apply, as for the planted trees."""
    import uuid

    key = key_file(args.key_file)
    library = {item["Name"].strip(): item for item in json.loads(Path(args.library).read_text(encoding="utf-8-sig"))["VegetationInfoList"]}
    sizes = {a["label"].strip(): a for a in json.loads(Path(args.sizes).read_text(encoding="utf-8"))["result"]["assets"] if a.get("heightM")}
    species_file = json.loads(Path(args.species).read_text(encoding="utf-8")) if args.species and Path(args.species).is_file() else {}
    grid = Grid(*args.terrains_square)
    course_dir = Path(args.course_dir)
    doc = load_any(course_dir / "arboristdata.dat", key)
    settings = doc["VSProSettings"]
    old = [p for p in settings["vegetationPackages"] if p.get("PackageName") == LINEUP_PACKAGE]
    gone = {i["VegetationItemID"] for p in old for i in p.get("VegetationInfoList") or []}
    settings["vegetationPackages"] = [p for p in settings["vegetationPackages"] if p not in old]
    cells = {c["cellIndex"]: c for c in doc["PersistentVegetationPackage"]["PersistentVegetationCellList"]}
    for c in cells.values():
        c["PersistentVegetationInfoList"] = [i for i in c["PersistentVegetationInfoList"] if i["VegetationItemID"] not in gone]
    x, y, z = args.at
    dx, dz = math.sin(math.radians(args.heading)), math.cos(math.radians(args.heading))
    items = []
    for n, spec in enumerate(args.items or []):
        # "Name@tintCap=0.3,brightness=-0.2": the species with a look of its own on top of the file's.
        name, _, extra = spec.partition("@")
        if name not in library:
            sys.exit(f"'{name}' is not in the library.")
        item = copy.deepcopy(library[name])
        item.update({"Name": f"{n + 1}: {spec}", "VegetationItemID": str(uuid.uuid5(uuid.NAMESPACE_URL, "golfmap-lineup/" + spec)), "EnableRuntimeSpawn": False})
        own = {k: (v if v.startswith("#") else float(v)) for k, v in (pair.split("=") for pair in extra.split(",") if pair)}
        far = bool(own.pop("far", 0))  # far=1: the billboard-only copy, to see the billboard up close
        apply_look(item, species_file.get("treeSettings", []) + ([dict(own, match=["*"])] if own else []), also=name)
        if far:
            item = dict(far_copy(item), Name=item["Name"], VegetationItemID=item["VegetationItemID"])
        items.append(item)
        px, pz = x + dx * args.spacing * n, z + dz * args.spacing * n
        index, rect = grid.cell(px, pz)
        cell = cells.setdefault(index, {"cellIndex": index, "cellRect": rect, "PersistentVegetationInfoList": []})
        scale = args.height / sizes[name]["heightM"] if args.height and name in sizes else 1.0
        row = grid.instance(px, args.ys[n] if args.ys and n < len(args.ys) else y, pz, 0, round(scale, 4))
        row["VegetationSourceID"] = 7
        cell["PersistentVegetationInfoList"].append({"VegetationItemID": item["VegetationItemID"], "VegetationItemList": [row]})
        print(f"  {n + 1}: {spec} at ({px:.0f}, {pz:.0f}), model {sizes.get(name, {}).get('heightM', 0):.1f} m x{scale:.2f}")
    if items:
        settings["vegetationPackages"].append({"PackageName": LINEUP_PACKAGE, "BiomeType": "Default", "BiomeName": "", "BiomeSortOrder": 1,
                                               "VegetationInfoList": items, "TextureMaskGroupList": [], "Enabled": False})
    settings["totalPrefabs"] = sum(len(p.get("VegetationInfoList") or []) for p in settings["vegetationPackages"])
    doc["PersistentVegetationPackage"] = {"PersistentVegetationCellList": [cells[k] for k in sorted(cells) if cells[k]["PersistentVegetationInfoList"]]}
    write_dat(doc, course_dir / "arboristdata.dat", key)
    print(f"wrote {course_dir / 'arboristdata.dat'}: lineup of {len(items)}")


def init(args) -> None:
    """A new course's first arboristdata.dat, which `trees` and `lower` then fill: another course's file with
    its packages and stored instances taken out, the system settings and terrain list kept (the names are the
    GolfMap scenes' own), terrainSize and the camera set for this course. Refuses to overwrite a course file."""
    key = Path(args.key_file) if args.key_file else DEFAULT_KEY
    out = Path(args.course_dir) / "arboristdata.dat"
    if out.exists() and not args.force:
        sys.exit(f"{out} exists: `trees` and `lower` replace their own packages in it (--force starts it again)")
    doc = load_any(Path(args.source), key)
    settings = doc["VSProSettings"]
    settings["vegetationPackages"] = []
    settings["totalPrefabs"] = 0
    doc["PersistentVegetationPackage"] = {"PersistentVegetationCellList": []}
    for name in ("biomeMasks", "vegeMasks", "vegeLines", "originalImportGameObjectsParents", "originalImportTerrains", "quicksets"):
        doc[name] = []
    doc["terrainSize"] = int(round(args.inner_side))  # GSPro's parser takes an integer here: 1510.0 fails the whole file
    doc["satImagePath"] = ""
    if args.camera:
        doc["lastCamPos"] = {"x": args.camera[0], "y": args.camera[1], "z": args.camera[2]}
    out.parent.mkdir(parents=True, exist_ok=True)
    write_dat(doc, out, key)
    (out.parent / "arboristversion.dat").write_text(str(doc.get("catalogVersion", CATALOG_VERSION)), encoding="ascii")
    print(f"wrote {out}: no packages, terrains {[t.get('Name') for t in settings.get('terrains', [])]}, terrainSize {args.inner_side}")
    # GSPro takes an Arborist course's post-processing from this file (see `post`), so the course gets one
    # from the start: the source course's, with this course's look.json written in when given.
    pp = out.parent / "arborist_postprocess.dat"
    source_pp = Path(args.source).parent / pp.name
    if not pp.exists():
        if not source_pp.exists():
            print(f"no {pp.name} beside {args.source}: copy another course's into {out.parent}, then run `post`")
            return
        shutil.copyfile(source_pp, pp)
        print(f"copied {source_pp} -> {pp}")
    if args.look:
        post(argparse.Namespace(course_dir=str(out.parent), look=args.look, out_dir=None, key_file=args.key_file))


def post(args) -> None:
    """The course folder's arborist_postprocess.dat with look.json's `post` values written in. GSPro takes the
    post-processing of an Arborist course from that file, not from the scene's profile (seen 2026-10-13: a
    saturation set in Unity never reached the game), so the look's post values have to go here as well."""
    key = key_file(args.key_file)
    path = Path(args.course_dir) / "arborist_postprocess.dat"
    doc = read_dat(path, key)
    look = json.loads(Path(args.look).read_text(encoding="utf-8")).get("post", {})
    grading, ao, bloom = doc["colorGrading"], doc["ambientOcclusion"], doc["bloom"]
    changed = []

    def put(block: dict, name: str, value) -> None:
        if block.get(name) != value:
            changed.append(f"{name}: {block.get(name)} -> {value}")
        block[name] = value
        block[name + "OverrideState"] = True

    def rgba(value: str) -> str:
        r, g, b = (int(value[i:i + 2], 16) / 255 for i in (1, 3, 5))
        return f"RGBA({r:.3f}, {g:.3f}, {b:.3f}, 1.000)"

    if "saturation" in look:
        put(grading, "saturation", look["saturation"])
    for name in ("postExposure", "temperature", "contrast"):
        if name in look:
            put(grading, name, look[name])
    for name in ("lift", "gamma", "gain"):  # trackballs, [x, y, z, w] in look.json
        if name in look:
            put(grading, name, dict(zip("xyzw", look[name])))
    if "liftW" in look:
        put(grading, "lift", dict(grading["lift"], w=look["liftW"]))
    if "aoColor" in look:
        put(ao, "color", rgba(look["aoColor"]))
    if "aoIntensity" in look:
        put(ao, "intensity", look["aoIntensity"])
    for name in ("threshold", "intensity"):
        if name in look.get("bloom", {}):
            put(bloom, name, look["bloom"][name])
    if "color" in look.get("bloom", {}):
        put(bloom, "color", rgba(look["bloom"]["color"]))
    write_dat(doc, Path(args.out_dir or args.course_dir) / path.name, key)
    print("\n".join(changed) if changed else "arborist_postprocess.dat already holds the look's post values")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("lineup", help="library species side by side at a spot, to judge them on screen")
    p.add_argument("--course-dir", required=True)
    p.add_argument("--items", nargs="*", help="library item names, in row order; none removes the lineup")
    p.add_argument("--at", nargs=3, type=float, required=True, metavar=("X", "Y", "Z"), help="world position of the first one")
    p.add_argument("--heading", type=float, default=90.0, help="direction of the row, degrees clockwise from north (+z)")
    p.add_argument("--spacing", type=float, default=14.0)
    p.add_argument("--height", type=float, default=0.0, help="scale every one to this height in metres (0 = model size)")
    p.add_argument("--ys", nargs="*", type=float, help="the ground height under each one in row order, for a row on the course (default: the y of --at for all)")
    p.add_argument("--sizes", required=True)
    p.add_argument("--species")
    p.add_argument("--library", default=str(HERE.parent / "data" / "arborist" / "GolfMap library.biome"))
    p.add_argument("--terrains-square", nargs=4, type=float, required=True, metavar=("X0", "Z0", "X1", "Z1"))
    p.add_argument("--key-file")
    p = sub.add_parser("trees", help="the planted trees (Unity's golfmap.trees.dump) as placed instances of Arborist's species")
    p.add_argument("--course-dir", required=True)
    p.add_argument("--base", help="another arboristdata.dat / .json to start from")
    p.add_argument("--out-dir")
    p.add_argument("--planted", required=True, help="golfmap-planted-trees-v1 JSON from Unity's golfmap.trees.dump")
    p.add_argument("--sizes", required=True, help="Arborist's model sizes: the output of `call.ts arb.catalog '{\"limit\":5000,\"sizes\":true}'`")
    p.add_argument("--library", default=str(HERE.parent / "data" / "arborist" / "GolfMap library.biome"))
    p.add_argument("--species", required=True)
    p.add_argument("--terrains-square", nargs=4, type=float, required=True, metavar=("X0", "Z0", "X1", "Z1"))
    p.add_argument("--drop-package", nargs="*", default=["GolfMap trial trees"], help="packages to remove with their instances")
    p.add_argument("--no-far", dest="far", action="store_false", help="every tree a full model, no billboard-only copies")
    p.add_argument("--surfaces", help=f"<course>-inner-surfaces.json of the export: turns on the far rule (FarRule; distances under billboardBeyondM in the species file, default {BILLBOARD_OUTSIDE_OOB_M:g} / {BILLBOARD_FROM_PLAY_M:g} m)")
    p.add_argument("--stems", help="<course>-inner-trees.json of the export (unity-trees-v1): with --palette, a tree whose Arborist model differs from its Unity prefab is sized to its lidar stem (SizeFit), not to the prefab's height")
    p.add_argument("--palette", help="the course's tree palette.json (rules as in Unity's GolfMapBiome)")
    p.add_argument("--placements", nargs="*", help="<course>-<terrain>-placements.json of the export (golfmap-placements-v1, Unity's planter): the trees of Arborist models, drawn as placed; the VSP ones give the dump's trees their ids")
    p.add_argument("--models", help="the course's model library (models.json, golfmap-models-v1): an Arborist model's look")
    p.add_argument("--gkd", help="the course's .GKD for the boundary (default: the one in --course-dir)")
    p.add_argument("--routing", nargs="+", help="<prefix>-<terrain>-routing.json files (golfmap-routing-v1, `route`; inner, and outer when routed): the placements go where they say; no \"vsp\" list, no trim. Needs --rules")
    p.add_argument("--rules", help="with --routing: the course's vegetation-rules.json, whose `routing` made the routing file; its far rule and outerKeep draw the outer catalogue")
    p.add_argument("--key-file")
    p = sub.add_parser("route", help="before planting: route each tree by id - own (its model's renderer), billboard (Arborist) or out - by the course's routing rules")
    p.add_argument("--trees", required=True, help="the terrain's trees export (<prefix>-<terrain>-trees.json, unity-trees-v1)")
    p.add_argument("--edits", help="its tree edits (<prefix>-<terrain>-tree-edits.json), applied first")
    p.add_argument("--surfaces", required=True, help="<prefix>-inner-surfaces.json: the playing field the far rule measures from")
    p.add_argument("--gkd", required=True, help="the course's .GKD: the boundary (pOOB)")
    p.add_argument("--terrains-square", nargs=4, type=float, required=True, metavar=("X0", "Z0", "X1", "Z1"))
    p.add_argument("--origin", nargs=2, type=float, default=[0.0, 0.0], metavar=("X", "Z"), help="the terrain's Unity world position (the inner stands at 0 0)")
    p.add_argument("--rules", help="the course's vegetation-rules.json (its `routing`; the defaults without)")
    p.add_argument("--out", required=True, help="<prefix>-<terrain>-routing.json (golfmap-routing-v1)")
    p.add_argument("--ids", nargs="+", help="route only these tree ids again (an edit touched them; one the edits deleted leaves the routing); "
                                            "the rest keep their routes from --from. Every tree is routed when --from is missing or was made from another trees file or other rules")
    p.add_argument("--from", dest="base", help="with --ids: the routing to start from (default --out)")
    p.add_argument("--dry-run", action="store_true", help="print the counts, write nothing")
    p.add_argument("--json", action="store_true", help="also print the counts as the last line, one JSON object {counts, out} (out null with --dry-run): what the app reads")
    p = sub.add_parser("edit", help="hand changes to placed trees (move, resize, rotate, delete, add, another item) in the file, in place")
    p.add_argument("--dat", required=True, help="the course's arboristdata.dat (or a decoded .json)")
    p.add_argument("--out", help="write here instead (default: in place)")
    p.add_argument("--ops", required=True, help='JSON file {"ops": [...]} (patch_instances)')
    p.add_argument("--terrains-square", nargs=4, type=float, required=True, metavar=("X0", "Z0", "X1", "Z1"))
    p.add_argument("--library", default=str(HERE.parent / "data" / "arborist" / "GolfMap library.biome"), help="for an item the package lacks")
    p.add_argument("--species", help="the course's arborist-species.json (its treeSettings) for an item the package lacks")
    p.add_argument("--key-file")
    p = sub.add_parser("lower", help="the palettes' prefab items (bushes, woodland floor) spread by the zones export's masks")
    p.add_argument("--course-dir", required=True, help="GSPro course folder; its arboristdata.dat is the document the package goes into")
    p.add_argument("--base", help="another arboristdata.dat / .json to start from")
    p.add_argument("--out-dir", help="where to write (default: the course folder)")
    p.add_argument("--palette", required=True, help="the course's grass-palette.json")
    p.add_argument("--zones", required=True, help="the inner zones export (<course>-inner-zones.json, its PNGs beside it)")
    p.add_argument("--library", default=str(HERE.parent / "data" / "arborist" / "GolfMap library.biome"))
    p.add_argument("--species", required=True, help="JSON {\"species\": {<prefab file stem>: <Arborist label or null>}} for what the name rule does not find")
    p.add_argument("--only", nargs="*", help="only items whose name contains one of these")
    p.add_argument("--key-file")
    p = sub.add_parser("post", help="look.json's post values into the course folder's arborist_postprocess.dat (what GSPro reads)")
    p.add_argument("--course-dir", required=True, help="GSPro course folder")
    p.add_argument("--look", required=True, help="the course's look.json")
    p.add_argument("--out-dir", help="where to write (default: the course folder)")
    p.add_argument("--key-file")
    p = sub.add_parser("init", help="a new course's first arboristdata.dat, from another course's file without its vegetation")
    p.add_argument("--course-dir", required=True, help="the new course's GSPro course folder")
    p.add_argument("--source", required=True, help="another course's arboristdata.dat / decoded .json (its settings and terrain list are kept)")
    p.add_argument("--inner-side", type=float, required=True, help="the inner terrain's side in metres (terrainSize)")
    p.add_argument("--camera", nargs=3, type=float, metavar=("X", "Y", "Z"), help="where Arborist opens the view")
    p.add_argument("--force", action="store_true", help="replace an existing arboristdata.dat")
    p.add_argument("--look", help="the course's look.json: its post values into the arborist_postprocess.dat copied from beside --source")
    p.add_argument("--key-file")
    for name in ("decode", "encode"):
        p = sub.add_parser(name)
        p.add_argument("src")
        p.add_argument("dst")
        p.add_argument("--key-file")
    p = sub.add_parser("trial")
    p.add_argument("--course-dir", required=True, help="GSPro course folder (holds the .GKD)")
    p.add_argument("--out-dir", help="where to write the two files (default: the course folder)")
    p.add_argument("--templates", nargs="+", required=True, help="real arboristdata.dat / decoded .json files to clone items from; the first is the base document")
    p.add_argument("--items", nargs="+", required=True, help="item names to clone, as the templates spell them")
    p.add_argument("--terrain-names", nargs="+", default=["Terrain (Inner)", "Plot (Outer)"])
    p.add_argument("--terrains-square", nargs=4, type=float, required=True, metavar=("X0", "Z0", "X1", "Z1"),
                   help="Unity world extent of all the terrains together")
    p.add_argument("--inner-side", type=float, required=True)
    p.add_argument("--hole", type=int, default=1)
    p.add_argument("--radius", type=float, default=14.0)
    p.add_argument("--per-ring", type=int, default=12)
    p.add_argument("--key-file")
    args = parser.parse_args()
    if args.command == "trial":
        trial(args)
    elif args.command == "lower":
        lower(args)
    elif args.command == "trees":
        trees(args)
    elif args.command == "edit":
        edit(args)
    elif args.command == "route":
        route_command(args)
    elif args.command == "lineup":
        lineup(args)
    elif args.command == "init":
        init(args)
    elif args.command == "post":
        post(args)
    else:
        wrap(args.command, Path(args.src), Path(args.dst), key_file(args.key_file))


if __name__ == "__main__":
    main()
