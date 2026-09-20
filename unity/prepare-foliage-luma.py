"""Set a species' leaf tint from the measured texture instead of by eye.

Every leaf material multiplies its albedo texture by a tint (_HealthyColor/_DryColor on the
NatureManufacture leaf shaders). The textures differ a lot in brightness and hue - elm's is far
darker and more blue-starved than oak's - so the same tint lands somewhere different on each
species, which is how this palette ended up with canopies four times darker than each other.

This measures each material's own albedo texture over its opaque texels, folds in the AO map the
shader applies, then solves for the tint that puts the result at a target linear luma with a
target chroma, and clamps to 1 where the texture simply cannot get there.

Reference points measured from the approved trees: oak 0.078, birch 0.125, both at R/G 0.48,
B/G 0.31 (leaf textures here are yellow-biased, so the tint has to lift blue rather than just
scale everything down).

Usage: python unity/prepare-foliage-luma.py UNITY_ROOT NEW_STAGE SPECIES [TARGET_P90]
"""
import json
import re
import sys
from pathlib import Path

import numpy as np
from PIL import Image

RG, BG = 0.48, 0.31          # chroma ratios of the approved oak
PERCENTILE = 90              # which end of the texture the target refers to
# The ceiling sits at p99.9, not p99: elm's texture carries baked highlights running to 4x oak's
# brightest texel, and a p99 match still leaves 3-6% of its leaves brighter than anything on an
# oak. 1.283 is oak's own p99.9/p90, so the cap scales with the target.
CEILING_PERCENTILE = 99.9
CEILING_RATIO = 1.283
W = np.array([0.2126, 0.7152, 0.0722])

root, stage, species = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3]
target = float(sys.argv[4]) if len(sys.argv) > 4 else 0.096   # oak p90 0.107; below it reads darker
if stage.exists():
    raise SystemExit("Stage %s already exists" % stage)


def lin(c):
    c = np.asarray(c, dtype=float)
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def srgb(c):
    c = np.asarray(c, dtype=float)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * c ** (1 / 2.4) - 0.055)


index = {}
for meta in root.joinpath("Assets").rglob("*.meta"):
    # lower(): fir's albedo is a .TGA, and an unindexed texture silently skips its material.
    if meta.name.lower().endswith((".mat.meta", ".shader.meta", ".png.meta", ".tga.meta", ".psd.meta")):
        found = re.search(r"^guid: (\w+)", meta.read_text(encoding="utf-8", errors="ignore"), re.M)
        if found:
            index[found.group(1)] = meta.with_suffix("")


def slot(text, key):
    found = re.search(r"^    - %s:\n        m_Texture: \{fileID: \d+, guid: (\w+)" % key, text, re.M)
    return index.get(found.group(1)) if found else None


def colour(text, key):
    found = re.search(r"^    - %s: \{r: ([^,]+), g: ([^,]+), b: ([^,]+), a: ([^}]+)\}$" % key, text, re.M)
    return [float(v) for v in found.groups()] if found else None


palette = json.loads(root.joinpath("Assets/GolfMap/Vreta/palette.json").read_text(encoding="utf-8"))
wanted, report = {}, []
for asset in palette["assets"]:
    # Match the species field, or the asset name: the firs carry no species in the palette.
    name = (asset.get("name") or "").lower()
    if not asset.get("enabled") or not (asset.get("species") == species or species.lower() in name):
        continue
    prefab = root.joinpath(asset["path"]).read_text(encoding="utf-8", errors="ignore")
    for guid in dict.fromkeys(re.findall(r"fileID: 2100000, guid: (\w+)", prefab)):
        path = index.get(guid)
        if path and path.suffix == ".mat":
            wanted.setdefault(path, []).append(asset["name"])
if not wanted:
    raise SystemExit("No enabled %s assets in the palette" % species)

for path, users in sorted(wanted.items()):
    text = path.read_text(encoding="utf-8")
    shader = index.get(re.search(r"m_Shader: \{fileID: \d+, guid: (\w+)", text).group(1))
    # NM leaf shaders tint with _HealthyColor/_DryColor; Arboreum (maple) uses plain _Color.
    key = "_HealthyColor" if colour(text, "_HealthyColor") else "_Color"
    healthy = colour(text, key)
    main = slot(text, "_MainTex")
    found_cut = re.search(r"^    - _Cutoff: ([-0-9.]+)$", text, re.M)
    cutoff = float(found_cut.group(1)) if found_cut else 0.0
    leaf = shader and ("Bark" not in shader.name and (("Leaves" in shader.name) or cutoff > 0))
    if not healthy or not main or not leaf:
        continue
    pixels = np.asarray(Image.open(main).convert("RGBA")).astype(np.float32) / 255
    opaque = pixels[..., 3] > cutoff
    tex_pixels = lin(pixels[..., :3][opaque])
    # Per texel, not averaged: AO is lowest exactly where the leaves are brightest, so a mean
    # occlusion hides the bright tail that actually reads as glare.
    occlusion = np.ones(int(opaque.sum()))
    for mask_key in ("_AmbientOcclusionGSmoothnessA", "_MetalicRAOGSmothnessA"):
        mask = slot(text, mask_key)
        if mask:
            power = float(re.search(r"^    - _AmbientOcclusionPower: ([-0-9.]+)$", text, re.M).group(1))
            g = np.asarray(Image.open(mask).convert("RGBA")).astype(np.float32)[..., 1][opaque] / 255
            occlusion = np.clip(g, 1 - power, 1)
            break
    # Match the bright end, not the average. Leaf textures differ in spread as much as in mean:
    # elm's p99 sits 51% above oak's at equal means, so equal-mean tints leave elm's lit leaves
    # glaring next to an oak that looks right. The eye reads the bright patches, so aim those.
    # Solve the scale first, then the chroma. Clipping the chroma solve and rescaling afterwards
    # throws the hue away (every channel pinned at 1 rescales to grey), so find the linear scale
    # that satisfies the brightness constraints and only then bend the result toward the target
    # ratios with whatever headroom is left.
    # Two constraints, whichever binds: p90 at the target, and p99 no brighter than the reference
    # (the eye picks out the few brightest leaves, and those are what read as glare).
    # A tint of s * unit puts the mean final colour at the target chroma for any s, so solve the
    # brightness on the luma the texels actually produce through that tint, then scale it.
    texels = tex_pixels * occlusion[:, None]
    tex = texels.mean(0)
    unit = np.array([RG, 1.0, BG]) / tex
    probe = (texels * unit) @ W
    scale = min(target / np.percentile(probe, PERCENTILE),
                target * CEILING_RATIO / np.percentile(probe, CEILING_PERCENTILE))
    tint = np.clip(srgb(scale * unit), 0, 1)
    lit = (texels * lin(tint)) @ W
    final = tex * lin(tint)
    dry = colour(text, "_DryColor")
    ratio = np.array(dry[:3]) / np.array(healthy[:3]) if dry else np.ones(3)
    new_dry = np.clip(tint * ratio, 0, 1)

    def put(body, prop, value):
        return re.sub(r"^(    - %s: \{r: )[^,]+, g: [^,]+, b: [^,]+, a: ([^}]+)\}$" % prop,
                      lambda m: "%s%s, g: %s, b: %s, a: %s}" % (m.group(1), round(value[0], 3),
                                                                round(value[1], 3), round(value[2], 3), m.group(2)),
                      body, count=1, flags=re.M)

    patched = put(text, key, tint)
    if dry:
        patched = put(patched, "_DryColor", new_dry)
    rel = path.relative_to(root).as_posix()
    dest = stage / rel
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(patched, encoding="utf-8")
    report.append({
        "material": path.stem,
        "prefabs": sorted(set(users)),
        "texture_sRGB": [round(v, 3) for v in srgb(tex)],
        "occlusion": round(float(occlusion.mean()), 3),
        "healthy_was": healthy[:3], "healthy_now": [round(v, 3) for v in tint],
        "mean_now": round(float(final @ W), 4),
        "p90_now": round(float(np.percentile(lit, PERCENTILE)), 4),
        "p99_now": round(float(np.percentile(lit, 99)), 4),
        "p999_now": round(float(np.percentile(lit, 99.9)), 4),
        "max_now": round(float(lit.max()), 4),
        "clipped": bool(tint.max() >= 1.0),
    })

if not report:
    raise SystemExit("No %s leaf materials with a tint to set" % species)
(stage / "report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
print(json.dumps(report, indent=2))
