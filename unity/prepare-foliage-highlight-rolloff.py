"""Compress the baked highlights in a species' leaf textures.

Some leaf atlases carry lighting baked into the albedo. Elm's runs to four times oak's brightest
texel, so a handful of leaves blow out however the tint is set: scaling the tint down to tame them
drags the whole canopy far below the species it should sit beside, because brightness and contrast
are different problems and a tint only controls the first.

This writes a private copy of each albedo with a soft knee above a threshold, so the body of the
distribution is untouched and only the outliers are pulled in. Hue is preserved - the knee scales
all three channels by the same factor per texel - and alpha is copied through so cutout is
unchanged. Afterwards run prepare-foliage-luma.py to set the brightness against the new texture.

Usage: python unity/prepare-foliage-highlight-rolloff.py UNITY_ROOT NEW_STAGE SPECIES [SHAPE]
       SHAPE is max/p90; the default is the approved oak's own ratio.
"""
import hashlib
import json
import re
import sys
from pathlib import Path

import numpy as np
from PIL import Image

W = np.array([0.2126, 0.7152, 0.0722])
# Oak's own shape, measured on its albedo: the brightest texel sits 1.41x its p90, and p99.9 at
# 1.28x. Expressing the knee and ceiling as multiples of each texture's OWN p90 keeps the body of
# the distribution untouched and pulls only the outliers into oak-like proportions - an absolute
# ceiling would flatten the whole atlas, since these are raw textures measured before any tint.
SHAPE = 1.41

root, stage, species = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3]
shape = float(sys.argv[4]) if len(sys.argv) > 4 else SHAPE
if stage.exists():
    raise SystemExit("Stage %s already exists" % stage)
folder = "Assets/GolfMap/Vreta/FoliageTrialV2/%s Textures" % species.capitalize()


def lin(c):
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def srgb(c):
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * np.maximum(c, 0) ** (1 / 2.4) - 0.055)


index = {}
for meta in root.joinpath("Assets").rglob("*.meta"):
    # lower(): fir's albedo is a .TGA, and an unindexed texture silently skips its material.
    if meta.name.lower().endswith((".mat.meta", ".shader.meta", ".png.meta", ".tga.meta", ".psd.meta")):
        found = re.search(r"^guid: (\w+)", meta.read_text(encoding="utf-8", errors="ignore"), re.M)
        if found:
            index[found.group(1)] = meta.with_suffix("")


def save(rel, write):
    dest = stage / rel
    dest.parent.mkdir(parents=True, exist_ok=True)
    write(dest)


palette = json.loads(root.joinpath("Assets/GolfMap/Vreta/palette.json").read_text(encoding="utf-8"))
materials = {}
for asset in palette["assets"]:
    # Match the species field, or the asset name: the firs carry no species in the palette.
    name = (asset.get("name") or "").lower()
    if not asset.get("enabled") or not (asset.get("species") == species or species.lower() in name):
        continue
    prefab = root.joinpath(asset["path"]).read_text(encoding="utf-8", errors="ignore")
    for guid in dict.fromkeys(re.findall(r"fileID: 2100000, guid: (\w+)", prefab)):
        path = index.get(guid)
        if path and path.suffix == ".mat":
            materials.setdefault(path, []).append(asset["name"])

done, report = {}, []
for path, users in sorted(materials.items()):
    text = path.read_text(encoding="utf-8")
    shader = index.get(re.search(r"m_Shader: \{fileID: \d+, guid: (\w+)", text).group(1))
    found = re.search(r"^    - _MainTex:\n        m_Texture: \{fileID: \d+, guid: (\w+)", text, re.M)
    cut = re.search(r"^    - _Cutoff: ([-0-9.]+)$", text, re.M)
    # Arboreum (maple) has no "Leaves" in the shader name and bark shares the shader,
    # so fall back to the alpha cutout: leaves are cut out, bark is not.
    if not shader or not found or not ("Bark" not in shader.name and (("Leaves" in shader.name) or (cut and float(cut.group(1)) > 0))):
        continue
    source = index.get(found.group(1))
    if not source or not source.exists():
        continue
    cutoff = float(re.search(r"^    - _Cutoff: ([-0-9.]+)$", text, re.M).group(1))

    if source not in done:
        pixels = np.asarray(Image.open(source).convert("RGBA")).astype(np.float32) / 255
        rgb, alpha = lin(pixels[..., :3]), pixels[..., 3]
        luma = rgb @ W
        kept = alpha > cutoff
        knee = float(np.percentile(luma[kept], 90))
        ceiling = knee * shape
        # Soft knee: below `knee` untouched, above it the excess is compressed asymptotically
        # toward `ceiling`, so the brightest texel lands just under it and nothing is clipped flat.
        excess = np.maximum(luma - knee, 0)
        span = max(ceiling - knee, 1e-6)
        rolled = knee + span * (1 - np.exp(-excess / span))
        scale = np.where(luma > knee, rolled / np.maximum(luma, 1e-6), 1.0)
        out = np.clip(srgb(rgb * scale[..., None]), 0, 1)
        image = Image.fromarray(np.round(np.dstack([out, alpha]) * 255).astype(np.uint8))
        target = "%s/%s.png" % (folder, source.stem)
        guid = hashlib.md5(("golfmap-rolloff:" + target).encode()).hexdigest()
        save(target, lambda dest, im=image: im.save(dest, optimize=True))
        meta = root.joinpath(str(source) + ".meta").read_text(encoding="utf-8")
        save(target + ".meta", lambda dest, m=meta, g=guid: dest.write_text(
            re.sub(r"^guid: \w+", "guid: " + g, m, count=1, flags=re.M), encoding="utf-8"))
        before, after = luma[kept], (lin(out) @ W)[kept]
        done[source] = (guid, target)
        report.append({
            "texture": source.name, "private": target,
            "p99_9": [round(float(np.percentile(before, 99.9)), 4), round(float(np.percentile(after, 99.9)), 4)],
            "max": [round(float(before.max()), 4), round(float(after.max()), 4)],
            "p90_kept": [round(float(np.percentile(before, 90)), 4), round(float(np.percentile(after, 90)), 4)],
        })

    guid, target = done[source]
    rel = path.relative_to(root).as_posix()
    patched = re.sub(r"^(    - _MainTex:\n        m_Texture: \{)[^}]*\}",
                     lambda m: m.group(1) + "fileID: 2800000, guid: %s, type: 3}" % guid, text, count=1, flags=re.M)
    save(rel, lambda dest, body=patched: dest.write_text(body, encoding="utf-8"))

if not report:
    raise SystemExit("No %s leaf textures to roll off" % species)
save("report.json", lambda dest: dest.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8"))
print(json.dumps(report, indent=2))
