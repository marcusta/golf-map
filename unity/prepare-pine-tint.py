"""One shared leaf tint for the pines, solved across needles and branch cards together.

VSP's NM tree controller writes the item's single stored HealtyColor/DryColor onto EVERY non-bark
material of the tree (NMTreeShaderControler.UpdateMaterial), and the planter's colour sync takes
that colour from the first NM leaf material - the needles. So the needle material
(Tree_Leaves_Specular) and the branch-card material (Cross Model Shader) always end up with the
same tint, and a tint tuned for one texture alone lands wrong on the other. This searches for the
single tint whose result on BOTH textures is closest to the target look, then writes it to all
of them so the files agree with what VSP will draw.

Target: Scots pine next to the approved fir - a little lighter, cooler, less saturated:
  brightness ~1.25x the fir (linear luma 0.026 -> 0.032)
  hue ~115 degrees (fir sits at 101; pine must not be warmer)
  saturation ~0.17 (fir 0.33) - greyer than the first pass at 0.23, which read emerald
Dry colour: same hue, 10% darker in linear.

Usage: python unity/prepare-pine-tint.py UNITY_ROOT NEW_STAGE
"""
import json
import re
import sys
from pathlib import Path

import numpy as np
from PIL import Image

LUMA, HUE, SAT = 0.032, 115.0, 0.17
W = np.array([0.2126, 0.7152, 0.0722])

root, stage = Path(sys.argv[1]), Path(sys.argv[2])
if stage.exists():
    raise SystemExit("Stage %s already exists" % stage)


def lin(c):
    c = np.asarray(c, dtype=float)
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def srgb(c):
    c = np.asarray(c, dtype=float)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * np.maximum(c, 0) ** (1 / 2.4) - 0.055)


def hls(rgb):
    """Vectorised colorsys.rgb_to_hls over the last axis; hue in degrees."""
    mx, mn = rgb.max(-1), rgb.min(-1)
    light = (mx + mn) / 2
    delta = mx - mn
    sat = np.where(delta == 0, 0, delta / np.where(light <= 0.5, mx + mn, 2 - mx - mn + 1e-12))
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    d = np.where(delta == 0, 1, delta)
    hue = np.where(mx == r, ((g - b) / d) % 6, np.where(mx == g, (b - r) / d + 2, (r - g) / d + 4)) * 60
    return np.where(delta == 0, 0, hue), light, sat


index = {}
for meta in root.joinpath("Assets").rglob("*.meta"):
    if meta.name.lower().endswith((".mat.meta", ".shader.meta", ".png.meta", ".tga.meta", ".psd.meta")):
        found = re.search(r"^guid: (\w+)", meta.read_text(encoding="utf-8", errors="ignore"), re.M)
        if found:
            index[found.group(1)] = meta.with_suffix("")

palette = json.loads(root.joinpath("Assets/GolfMap/Vreta/palette.json").read_text(encoding="utf-8"))
materials = {}
for asset in palette["assets"]:
    name = asset["name"].lower()
    if not asset.get("enabled") or "pine" not in name or "dwarf" in name:
        continue
    prefab = root.joinpath(asset["path"]).read_text(encoding="utf-8", errors="ignore")
    for guid in dict.fromkeys(re.findall(r"fileID: 2100000, guid: (\w+)", prefab)):
        path = index.get(guid)
        if path and path.suffix == ".mat":
            materials.setdefault(path, set()).add(asset["name"])

leaves = []
for path, users in sorted(materials.items()):
    text = path.read_text(encoding="utf-8")
    shader = index.get(re.search(r"m_Shader: \{fileID: \d+, guid: (\w+)", text).group(1))
    main = re.search(r"^    - _MainTex:\n        m_Texture: \{fileID: \d+, guid: (\w+)", text, re.M)
    if not shader or "Bark" in shader.name or "_HealthyColor" not in text or not main:
        continue
    cut = re.search(r"^    - _Cutoff: ([-0-9.]+)$", text, re.M)
    pixels = np.asarray(Image.open(index[main.group(1)]).convert("RGBA")).astype(np.float32) / 255
    mean = lin(pixels[..., :3][pixels[..., 3] > (float(cut.group(1)) if cut else 0.5)]).mean(0)
    kind = "needles" if "Leaves" in shader.name else "cards"
    leaves.append(dict(path=path, text=text, mean=mean, kind=kind, users=sorted(users)))
if not leaves:
    raise SystemExit("No pine leaf materials found")

# Needles and cards weigh the same in total, however many card materials there are.
cards = sum(1 for m in leaves if m["kind"] == "cards")
needles = len(leaves) - cards
weights = np.array([1 / needles if m["kind"] == "needles" else 1 / cards for m in leaves])
means = np.stack([m["mean"] for m in leaves])                       # (M, 3) linear texel means

grid = np.arange(0.30, 1.0001, 0.01)
tints = np.stack(np.meshgrid(grid, grid, grid, indexing="ij"), -1).reshape(-1, 3)   # (T, 3) sRGB
final = means[None, :, :] * lin(tints)[:, None, :]                  # (T, M, 3) linear
luma = final @ W
hue, _, sat = hls(srgb(final))
dh = (hue - HUE + 180) % 360 - 180
loss = ((dh / 12) ** 2 + ((sat - SAT) / 0.04) ** 2 + ((luma - LUMA) / (0.15 * LUMA)) ** 2) @ weights
best = int(np.argmin(loss))
tint = np.round(tints[best], 3)
dry = np.round(np.clip(srgb(lin(tint) * 0.90), 0, 1), 3)


def put(body, key, value):
    return re.sub(r"^(    - %s: \{r: )[^,]+, g: [^,]+, b: [^,]+, a: ([^}]+)\}$" % key,
                  lambda m: "%s%s, g: %s, b: %s, a: %s}" % (m.group(1), value[0], value[1], value[2], m.group(2)),
                  body, count=1, flags=re.M)


report = {"tint": tint.tolist(), "dry": dry.tolist(), "materials": []}
for i, m in enumerate(leaves):
    body = put(put(m["text"], "_HealthyColor", tint), "_DryColor", dry)
    dest = stage / m["path"].relative_to(root)
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(body, encoding="utf-8")
    report["materials"].append({
        "material": m["path"].relative_to(root).as_posix(), "kind": m["kind"], "prefabs": m["users"],
        "luma": round(float(luma[best, i]), 4), "hue": round(float(hue[best, i])), "sat": round(float(sat[best, i]), 2),
    })
(stage / "report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
print(json.dumps(report, indent=2))
