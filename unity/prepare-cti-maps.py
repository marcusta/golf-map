"""Course-local texture copies for the CTI trial materials: NM tint baked in, leaf reflection off.

CTI's leaf and bark shaders have no tint and no specular/smoothness controls - they draw what the
textures hold - so every look change is a texture copy under <course>/CTITrial/Textures/, recorded
in trial.json as a texture override of that swap's CTI material. golfmap.cti.apply sets the
overrides (on an applied trial it only updates the materials). Forst's files are never touched.

tint - the NM materials the trial swaps out multiply their albedo: the oak leaves by _HealthyColor
    (0.51 grey), the bark by _Color (0.49). In this linear-space project a colour property is
    linearised before it multiplies, so that is x0.22 and x0.21; untinted, the CTI oaks came out
    about 4.5x brighter than the approved oak (Marcus, 2026-09-26: "very bright"). The copy is
    each texel's linear RGB times the linearised tint, alpha untouched (transparency on leaves,
    smoothness on bark). An optional green shift (Marcus: "just a tad greener" on the oak) scales
    the tint's red by (1 - shift) and renormalises it to the same luma, so only the hue moves. An
    optional gain then scales the whole tint: the birch keeps the original birch hue (not the
    darker look's) but at the approved birch/oak brightness ratio - prepare-foliage-luma.py's
    measured references are birch 0.125 vs oak 0.078 (1.6x); the plain NM tint left the CTI birch
    at 2.3x the CTI oak and pale. That gain (0.69) was "much better but slightly darker" (Marcus,
    2026-09-27): now 0.60, x0.87 linear.

nospec - with the albedo at the approved level the oak crowns turned grey-white ("too little olive
    green"): Forst's leaves are a 4% dielectric (_BumpSpecMap B = 0.043) with smoothness up to 0.41
    (_TranslucencyMap A, x0.8 on back faces), and the Fresnel sky reflection now outshone the
    darkened leaf. It is the reflection the NM oak fix of 2026-09-17 removed (zero specular + zero
    smoothness: Unity 2018's BRDF1 then drops direct and indirect specular). The copies zero only
    B of the normal/spec map and A of the AO/translucency/smoothness map; the normal (G, A), AO (G)
    and translucency (B) channels stay bit for bit. Packed maps are always imported as Forst
    requires - Default texture type, linear - whatever the source's meta says: the project's birch
    normal/spec PSD was switched to "Normal map" on 2026-09-14 (Forst ships it as Default), and a
    Normal map import repacks the channels, so the shader's specular (B) was no longer our zero -
    a black-albedo probe still showed grey-white birch leaves.

Each override records its "source" and the linear "tint" it was baked with. GolfMap > Vegetation
Palettes bakes the same formula in Unity (source x tint) when the leaves or bark are tuned there and
records its tint; a recorded tint wins over the one computed here, so re-running this script keeps
that tuning. Delete an override's "tint" to go back to the computed one. So that a bake in Unity
starts from the same texels as this one (not from the DXT-compressed import), every tinted source is
also written untinted and lossless to <project>/GolfMapSpelunk/cti-trial/sources/<source>.png
(outside Assets: never imported or built).

Outputs get a fixed guid derived from their path. A target that exists is regenerated only if it
carries that guid (one of ours); anything else is refused. To go back to Forst's own texture, point
the override's path at the source again.

Usage: pipeline/.venv/Scripts/python unity/prepare-cti-maps.py UNITY_ROOT [COURSE_FOLDER] [SPECIES...]
       COURSE_FOLDER defaults to Assets/GolfMap/Vreta, SPECIES to oak
"""
import hashlib
import json
import re
import sys
from pathlib import Path

import numpy as np
from PIL import Image

SRC = "Assets/Oak Trees Package/Oak Trees Version 2.0/Sources/Shared Textures/"
BIRCH = "Assets/Birch Trees Package/Birches Version 3.0/Sources/Shared Textures/"
# species -> [(swaps it overrides (their "from", relative to the course), material slot,
#              source texture, edit)]
# edit: ("tint", <material the colour comes from>, <NM colour property>, <green shift>, <gain>)
#       or ("zero", <channels>)
# Both birch variants take the ORIGINAL birch colour: the "darker" look was never liked, so its
# prefabs get the same textures as the plain birch (through their own trial materials).
# Birch bark is not here: CTI's Bark Array shader samples a Texture2DArray asset, not a texture,
# and the CTI birch trunks already read right.
OAK_LEAVES, OAK_BARK = "FoliageTrialV2/Oak Leaves.mat", "FoliageTrialV2/Oak Bark.mat"
BIRCHES = ("FoliageTrialV2/Birch Leaves.mat", "Looks/birch/darker/Birch Leaves.mat")
MAPS = {
    "oak": [
        ((OAK_LEAVES,), "_MainTex", SRC + "Oak Branches [Albedo] [Alpha].psd", ("tint", OAK_LEAVES, "_HealthyColor", 0.12, 1)),
        ((OAK_LEAVES,), "_BumpSpecMap", SRC + "Oak Branches [Normal] [Specular].psd", ("zero", "B")),
        ((OAK_LEAVES,), "_TranslucencyMap", SRC + "Oak Branches [AO] [Translucency] [Smoothness].psd", ("zero", "A")),
        ((OAK_BARK,), "_MainTex", SRC + "Oak Bark [Albedo] [Smoothness].psd", ("tint", OAK_BARK, "_Color", 0, 1)),
    ],
    "birch": [
        (BIRCHES, "_MainTex", BIRCH + "Birch Leaves [Albedo] [Alpha] 4K.psd", ("tint", BIRCHES[0], "_HealthyColor", 0, 0.60)),
        (BIRCHES, "_BumpSpecMap", BIRCH + "Birch Leaves [Normal] [Spec] 4K.psd", ("zero", "B")),
        (BIRCHES, "_TranslucencyMap", BIRCH + "Birch Leaves [AO] [Trans] [Smoothness] 4K.psd", ("zero", "A")),
    ],
}

args = sys.argv[1:]
root = Path(args[0])
course = (args[1] if len(args) > 1 and args[1].startswith("Assets/") else "Assets/GolfMap/Vreta").rstrip("/")
species = [a for a in args[1:] if not a.startswith("Assets/")] or ["oak"]
trial_path = root / course / "CTITrial/trial.json"
if not trial_path.exists():
    raise SystemExit("%s not found: run prepare-cti-trial.py first" % trial_path)
trial = json.loads(trial_path.read_text(encoding="utf-8"))
W = np.array([0.2126, 0.7152, 0.0722])


def lin(c):
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def srgb(c):
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * np.power(np.maximum(c, 0), 1 / 2.4) - 0.055)


def colour(mat_text, key):
    m = re.search(r"- %s: \{r: ([\d.e-]+), g: ([\d.e-]+), b: ([\d.e-]+)" % re.escape(key), mat_text)
    if not m:
        raise SystemExit("No %s in material" % key)
    return np.array([float(v) for v in m.groups()])


writes = {}
report = []
for sp in species:
    if sp not in MAPS:
        raise SystemExit("No map table for '%s' (have: %s)" % (sp, ", ".join(MAPS)))
    for froms, slot, source, edit in MAPS[sp]:
        kind = edit[0]
        swaps = []
        for frm in froms:
            swap = next((s for s in trial["swaps"] if s["from"] == "%s/%s" % (course, frm)), None)
            if not swap:
                raise SystemExit("trial.json has no swap from %s/%s: run prepare-cti-trial.py" % (course, frm))
            swaps.append(swap)
        img = Image.open(root / source).convert("RGBA")
        recorded = next((t.get("tint") for s in swaps for t in s.get("textures", []) if t["name"] == slot and t.get("tint")), None)
        if kind == "tint":
            lossless = root / "GolfMapSpelunk/cti-trial/sources" / (Path(source).stem + ".png")
            if not lossless.exists() or lossless.stat().st_mtime < (root / source).stat().st_mtime:
                lossless.parent.mkdir(parents=True, exist_ok=True)
                img.save(lossless, optimize=False)
                print("wrote", lossless.relative_to(root))
            _, tint_from, what, shift, gain = edit
            tint = colour((root / course / tint_from).read_text(encoding="utf-8"), what)
            scale = lin(tint)
            if shift:
                shifted = scale * np.array([1 - shift, 1, 1])
                scale = shifted * (scale @ W) / (shifted @ W)
            scale = scale * gain
            if recorded:
                scale = np.array(recorded, dtype=np.float64)   # tuned in Vegetation Palettes
            px = np.asarray(img).astype(np.float64) / 255
            out = px.copy()
            out[..., :3] = srgb(lin(px[..., :3]) * scale)
            data = np.round(np.clip(out, 0, 1) * 255).astype(np.uint8)
            opaque = px[..., 3] > 0.2 if "Leaves" in tint_from else np.ones(px.shape[:2], bool)
            before = float(np.percentile(lin(px[..., :3])[opaque] @ W, 90))
            after = float(np.percentile((lin(px[..., :3]) * scale)[opaque] @ W, 90))
            name = Path(source).stem + " tinted.png"
            report.append("%s: %s -> linear x%s; p90 linear luma %.3f -> %.3f"
                          % (name, "recorded tint" if recorded else "%s of %s %s, green shift %s, gain %s" % (what, tint_from, tint.round(3).tolist(), shift, gain),
                             scale.round(3).tolist(), before, after))
        else:
            data = np.asarray(img).copy()
            report.append("%s: channel means %s" % (Path(source).name, " ".join(
                "%s %.3f" % (c, data[..., i].mean() / 255) for i, c in enumerate("RGBA"))))
            for ch in edit[1]:
                i = "RGBA".index(ch)
                report.append("   %s -> 0" % ch)
                data[..., i] = 0
            name = Path(source).stem + " nospec.png"
        target = "%s/CTITrial/Textures/%s" % (course, name)
        guid = hashlib.md5(b"golfmap-cti-tint:" + target.encode()).hexdigest()
        meta = re.sub(r"^guid: \w+", "guid: " + guid, (root / (source + ".meta")).read_text(encoding="utf-8"), count=1, flags=re.M)
        if kind == "zero":
            meta = re.sub(r"^(\s+)textureType: \d+$", r"\g<1>textureType: 0", meta, count=1, flags=re.M)
            meta = re.sub(r"^(\s+)sRGBTexture: \d+$", r"\g<1>sRGBTexture: 0", meta, count=1, flags=re.M)
        writes[target] = (Image.fromarray(data), meta, guid)
        for swap in swaps:
            textures = [t for t in swap.get("textures", []) if t["name"] != slot]
            entry = {"name": slot, "path": target, "source": source}
            if kind == "tint":
                entry["tint"] = [round(float(v), 6) for v in scale]
            textures.append(entry)
            swap["textures"] = textures

refused = []
for target, (_, _, guid) in writes.items():
    meta = root / (target + ".meta")
    if (root / target).exists() and not (meta.exists() and ("guid: " + guid) in meta.read_text(encoding="utf-8")):
        refused.append(target)
if refused:
    raise SystemExit("Refusing to overwrite files that are not ours:\n  " + "\n  ".join(refused))
for target, (png, meta, _) in writes.items():
    dest = root / target
    dest.parent.mkdir(parents=True, exist_ok=True)
    png.save(dest, optimize=False)
    (root / (target + ".meta")).write_text(meta, encoding="utf-8", newline="\n")
    print("wrote", target)
trial_path.write_text(json.dumps(trial, indent=2) + "\n", encoding="utf-8")
print("updated", trial_path.relative_to(root))
print("\n".join(report))
print("\nNext, in Unity: golfmap.cti.apply (updates the materials of an applied trial).")
