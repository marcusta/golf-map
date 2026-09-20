"""Move the oaks off the private CTI shader copies onto NatureManufacture's tree shaders.

GSPro runs a *forked* Vegetation Studio runtime - it has
`VegetationItemModelInfo.SetShaderControllers(GameObject _sourceLOD0)`, `Arb_*ShaderController`
and `useShaderControllerOverrides`, none of which exist in the Asset Store build in this project
- and its shader-controller lookup has no `DefaultShaderController` fallback. A shader name it
does not know null-refs out of the `VegetationItemModelInfo` constructor, which aborts
`SetupVegetationItemModels` for the *whole package*: one unknown shader silently removes every
tree in that system from the course. That is why the built course loaded no trees at all while
the editor looked perfect - the Asset Store selector ends with `return new
DefaultShaderController()`, so nothing is ever reported here.

The names GSPro's build resolves are a fixed list. `GolfMap/CTI Oak Bark Tinted` and
`GolfMap/CTI Oak Leaves Trial` are not on it - and neither are the stock oak shaders
`CTI/LOD Bark 301` / `CTI/LOD Leaves 301`, so reverting to the untouched NM FORST materials
would not have helped either. NM's `Tree Bark Metalic` / `Tree Leaves Metalic` are on it, are
what every other broadleaf in the palette already uses, and are what the birches were converted
to for the same reason - so the oaks follow the birches.

Both materials keep their path and .meta, so their guids are unchanged and the four
`PF_Oak_* Terrain` prefabs, the palette and the planted catalogues all still resolve: no
replant is needed for geometry. The catalogue items cache `ShaderName` and
`ShaderControllerSettings` though, so run `GolfMap > Vreta > Refresh vegetation from materials`
afterwards to re-derive them.

The oak textures are packed CTI-style and have to be rebuilt, exactly as the birch leaves did
(`prepare-birch-leaf-normal.py`). Measured channel layouts:

    Oak Branches [Normal] [Specular]      R 0, G normal Y, B flat spec, A normal X
    Oak Branches [AO] [Trans] [Smoothness] R 0, G AO, B translucency, A smoothness
    Oak Bark [Normal] [Specular] [AO]     R flat spec, G normal Y, B AO, A normal X
    Oak Bark [Albedo] [Smoothness]        RGB albedo, A smoothness

NM reads normals with `UnpackScaleNormal`, which starts `packednormal.x *= packednormal.w`; with
R empty every texel would decode to a normal lying flat in the tangent plane, so the normals are
decoded from A/G and re-encoded as plain RGB imported as NormalMap. The leaf mask is already in
NM's `_MetalicRAOGSmothnessA` layout (R metallic, G AO, A smoothness) and is reused as-is, as the
birch one was. Bark has no such map - its AO and smoothness live in two different textures - so
one is packed here.

Usage: pipeline/.venv/Scripts/python unity/prepare-oak-nm-shader.py UNITY_ROOT NEW_STAGE
"""
import hashlib
import re
import sys
from pathlib import Path

import numpy as np
from PIL import Image

SRC = "Assets/Oak Trees Package/Oak Trees Version 2.0/Sources/Shared Textures/"
FOLIAGE = "Assets/GolfMap/Vreta/FoliageTrialV2/"

LEAF_PACKED = SRC + "Oak Branches [Normal] [Specular].psd"
BARK_PACKED = SRC + "Oak Bark [Normal] [Specular] [AO].psd"
BARK_ALBEDO = SRC + "Oak Bark [Albedo] [Smoothness].psd"

LEAF_NORMAL = FOLIAGE + "Oak Branches Normal.png"
BARK_NORMAL = FOLIAGE + "Oak Bark Normal.png"
BARK_MASK = FOLIAGE + "Oak Bark MT_AO_SM.png"

# Existing imports, reused unchanged.
LEAF_ALBEDO_GUID = "872698bae6fb8466b88fa8816349222e"   # Oak Branches [Albedo] [Alpha]
LEAF_MASK_GUID = "497969cf22b5d420d89ff4d846e5ac94"     # Oak Branches [AO] [Translucency] [Smoothness]
LEAF_SHADOW_GUID = "a8a8fb513a77146caae89449639f5316"   # Oak Branches Shadow Map [Alpha]
BARK_ALBEDO_GUID = "aab2ceb1f91514161af11367483b04ee"   # Oak Bark [Albedo] [Smoothness]

# Already-converted NM materials in the same folder: every property the shader expects exists
# with values that were tuned against this course's lighting.
# Wind. VSP overrides _InitialBend/_Stiffness/_Drag (and the leaf shiver) at draw time from the
# catalogue item's controller settings, which CreateDefaultSettings reads off these materials - so
# these values are what the course actually uses, and the birch template's would make an oak sway
# like a birch. With the private shader the oaks had *no* controller at all (DefaultShaderController
# creates empty settings), so nothing clamped them and they moved far more than everything else.
# The palette's range, for reference: pine 0.93/0.1, fir and poplar 1/0.3, birch 1/1, elm 1/1 with
# the tall elm at 2/1. Oaks carry the widest crowns here, so they sit stiffer than the tall elm and
# drag between poplar and elm. To re-tune later, edit the item's Wind settings in the
# VegetationSystemPro inspector - that is the value in effect; the material is only its seed.
WIND = {"_InitialBend": 1, "_Stiffness": 2, "_Drag": 0.5}
LEAF_WIND = {"_ShiverDrag": 0.03, "_ShiverDirectionality": 0.5}

LEAF_TEMPLATE = FOLIAGE + "Birch Leaves.mat"
BARK_TEMPLATE = FOLIAGE + "Birch Bark.mat"
LEAF_TARGET = FOLIAGE + "Oak Leaves.mat"
BARK_TARGET = FOLIAGE + "Oak Bark.mat"

root, stage = (Path(a) for a in sys.argv[1:3])
if stage.exists():
    raise SystemExit("Stage %s already exists" % stage)


def read(rel):
    return (root / rel).read_text(encoding="utf-8").replace("\r\n", "\n")


def save(rel, write):
    dest = stage / rel
    dest.parent.mkdir(parents=True, exist_ok=True)
    write(dest)


def load(rel):
    return np.asarray(Image.open(root / rel).convert("RGBA")).astype(np.float32) / 255


def guid_for(target):
    return hashlib.md5(b"golfmap-oak-nm:" + target.encode()).hexdigest()


def write_meta(target, source, normal_map):
    """Reuse the source PSD's importer settings, with a fresh guid and the right texture type."""
    meta = read(source + ".meta")
    meta = re.sub(r"^guid: \w+", "guid: " + guid_for(target), meta, count=1, flags=re.M)
    want = 1 if normal_map else 0
    meta = re.sub(r"^(\s*)textureType: \d+$", r"\g<1>textureType: %d" % want, meta, count=1, flags=re.M)
    if not normal_map:
        # A mask is data, not colour: sampling it through sRGB would skew AO and smoothness.
        meta = re.sub(r"^(\s*)sRGBTexture: \d+$", r"\g<1>sRGBTexture: 0", meta, count=1, flags=re.M)
    if "textureType: %d" % want not in meta:
        raise SystemExit("Could not set textureType on " + target)
    save(target + ".meta", lambda dest: dest.write_text(meta, encoding="utf-8"))


def decode_normal(packed):
    """CTI stores normal X in alpha and Y in green; rebuild Z and write plain RGB."""
    x = packed[..., 3] * 2 - 1
    y = packed[..., 1] * 2 - 1
    z = np.sqrt(np.clip(1 - np.clip(x * x + y * y, 0, 1), 0, 1))
    return np.stack([x, y, z], -1)


def write_png(target, source, rgba, normal_map):
    image = Image.fromarray(np.round(np.clip(rgba, 0, 1) * 255).astype(np.uint8))
    save(target, lambda dest: image.save(dest, optimize=True))
    write_meta(target, source, normal_map)


leaf_packed = load(LEAF_PACKED)
write_png(LEAF_NORMAL, LEAF_PACKED, decode_normal(leaf_packed) * 0.5 + 0.5, True)

bark_packed = load(BARK_PACKED)
write_png(BARK_NORMAL, BARK_PACKED, decode_normal(bark_packed) * 0.5 + 0.5, True)

# NM's mask is R metallic, G AO, A smoothness. Oak bark keeps AO in the packed map's blue and
# smoothness in the albedo's alpha, so pack the two together at the albedo's resolution.
bark_albedo = load(BARK_ALBEDO)
if bark_albedo.shape[:2] != bark_packed.shape[:2]:
    raise SystemExit("Oak bark albedo and packed map differ in size; resize before packing")
zero = np.zeros_like(bark_packed[..., 0])
write_png(
    BARK_MASK,
    BARK_ALBEDO,
    np.stack([zero, bark_packed[..., 2], zero, bark_albedo[..., 3]], -1),
    False,
)


def slot(key):
    return re.compile(r"^    - " + key + r":\n        m_Texture: \{([^}]*)\}", re.M)


def texture(text, key, guid):
    found = slot(key).search(text)
    if not found:
        raise SystemExit("Template has no texture slot " + key)
    body = "fileID: 2800000, guid: %s, type: 3" % guid if guid else "fileID: 0"
    return slot(key).sub(lambda m: m.group(0).replace(found.group(1), body), text, count=1)


def number(text, key, value):
    pattern = re.compile(r"^(    - " + key + r": )[-0-9.]+$", re.M)
    if not pattern.search(text):
        raise SystemExit("Template has no float " + key)
    return pattern.sub(lambda m: m.group(1) + str(value), text, count=1)


def colour(text, key, rgb):
    pattern = re.compile(
        r"^(    - " + key + r": \{r: )[^,]+, g: [^,]+, b: [^,]+(, a: [^}]+\})$", re.M
    )
    if not pattern.search(text):
        raise SystemExit("Template has no colour " + key)
    return pattern.sub(
        lambda m: "%s%s, g: %s, b: %s%s" % (m.group(1), rgb[0], rgb[1], rgb[2], m.group(2)),
        text,
        count=1,
    )


def carried(rel, key, fallback):
    found = re.search(
        r"^    - " + key + r": \{r: ([^,]+), g: ([^,]+), b: ([^,]+), a: [^}]+\}$",
        read(rel),
        re.M,
    )
    return [found.group(i) for i in (1, 2, 3)] if found else fallback


# Carry the tuned tints across: the leaf tint the private shader applied as an albedo multiplier
# is what NM drives through _HealthyColor/_DryColor, which is also what VSP's shader controller
# syncs and overrides at draw time.
leaf_tint = carried(LEAF_TARGET, "_GolfMapLeafTint", ["1", "1", "1"])
bark_tint = carried(BARK_TARGET, "_Color", ["1", "1", "1"])

leaves = read(LEAF_TEMPLATE)
leaves = re.sub(r"^  m_Name: .*$", "  m_Name: Oak Leaves", leaves, count=1, flags=re.M)
leaves = texture(leaves, "_MainTex", LEAF_ALBEDO_GUID)
leaves = texture(leaves, "_BumpMap", guid_for(LEAF_NORMAL))
leaves = texture(leaves, "_MetalicRAOGSmothnessA", LEAF_MASK_GUID)
leaves = texture(leaves, "_TranslucencyMap", LEAF_MASK_GUID)
leaves = texture(leaves, "_ShadowMap", LEAF_SHADOW_GUID)
leaves = number(leaves, "_Cutoff", 0.2)
leaves = number(leaves, "_BumpScale", 1)
leaves = number(leaves, "_MetallicPower", 0)
# The foliage-v2 pass capped the trial oak's specular at 0.02 and smoothness at 0.15 to kill the
# mint highlights; _SmoothnessPower scales the mask's alpha, so keep it in that range.
leaves = number(leaves, "_SmoothnessPower", 0.15)
leaves = number(leaves, "_AmbientOcclusionPower", 1)
leaves = number(leaves, "_BackFaceMirrorNormal", 1)
for key, value in list(WIND.items()) + list(LEAF_WIND.items()):
    leaves = number(leaves, key, value)
leaves = colour(leaves, "_HealthyColor", leaf_tint)
leaves = colour(leaves, "_DryColor", leaf_tint)
save(LEAF_TARGET, lambda dest: dest.write_text(leaves, encoding="utf-8"))

bark = read(BARK_TEMPLATE)
bark = re.sub(r"^  m_Name: .*$", "  m_Name: Oak Bark", bark, count=1, flags=re.M)
bark = texture(bark, "_MainTex", BARK_ALBEDO_GUID)
bark = texture(bark, "_BumpMap", guid_for(BARK_NORMAL))
bark = texture(bark, "_MetalicRAOGSmothnessA", guid_for(BARK_MASK))
bark = number(bark, "_Cutoff", 0)
bark = number(bark, "_BumpScale", 1)
bark = number(bark, "_MetallicPower", 0)
bark = number(bark, "_SmoothnessPower", 1)
bark = number(bark, "_AmbientOcclusionPower", 1)
for key, value in WIND.items():
    bark = number(bark, key, value)
bark = colour(bark, "_Color", bark_tint)
save(BARK_TARGET, lambda dest: dest.write_text(bark, encoding="utf-8"))


def shader_of(text):
    return re.search(r"m_Shader: \{fileID: \d+, guid: (\w+)", text).group(1)


for label, target, before, after in (
    ("leaves", LEAF_TARGET, read(LEAF_TARGET), leaves),
    ("bark", BARK_TARGET, read(BARK_TARGET), bark),
):
    print("%-7s %s\n        shader %s -> %s" % (label, target, shader_of(before), shader_of(after)))
print("wind: %s + leaves %s" % (WIND, LEAF_WIND))
print("leaf tint carried to _HealthyColor/_DryColor: %s" % leaf_tint)
print("bark tint carried to _Color: %s" % bark_tint)
print("staged textures: %s, %s, %s" % (LEAF_NORMAL, BARK_NORMAL, BARK_MASK))
print("After copying the stage in, run GolfMap > Vreta > Refresh vegetation from materials")
print("so the catalogue items re-derive ShaderName and ShaderControllerSettings.")
