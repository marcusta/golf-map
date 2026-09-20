"""Rebuild the birch leaf normal map in the layout NatureManufacture's shader decodes.

`Birch Leaves [Normal] [Spec] 4K.psd` is packed CTI-style: normal X in A, Y in G, R empty, B a
flat specular constant. CTI reads that with UnpackNormalDXT5nm, which takes A and G directly.
NM's Tree Leaves Metalic uses UnpackScaleNormal instead, and that starts with

    packednormal.x *= packednormal.w

i.e. X comes from R * A, not A. With R = 0 across the whole texture every texel decodes to
x = -1, y = 0, z = 0: a normal lying flat in the tangent plane, perpendicular to the leaf. Cards
then light by the direction of their tangent rather than their face, so a card is bright or
pitch black depending on which way it happens to be rotated - and which cards you see changes
with the camera angle.

So decode the CTI packing and re-encode as a plain RGB normal map, imported as textureType 1
(NormalMap), which is what UnpackScaleNormal is built to read.

Usage: python unity/prepare-birch-leaf-normal.py UNITY_ROOT NEW_STAGE
"""
import hashlib
import re
import sys
from pathlib import Path

import numpy as np
from PIL import Image

SOURCE = "Assets/Birch Trees Package/Birches Version 3.0/Sources/Shared Textures/Birch Leaves [Normal] [Spec] 4K.psd"
TARGET = "Assets/GolfMap/Vreta/FoliageTrialV2/Birch Leaves Normal.png"
MATERIAL = "Assets/GolfMap/Vreta/FoliageTrialV2/Birch Leaves.mat"
SIZE = 2048  # the source's own maxTextureSize; the extra 4K detail never reaches the GPU.

root, stage = (Path(a) for a in sys.argv[1:3])
if stage.exists():
    raise SystemExit("Stage %s already exists" % stage)


def save(rel, write):
    dest = stage / rel
    dest.parent.mkdir(parents=True, exist_ok=True)
    write(dest)


packed = np.asarray(Image.open(root / SOURCE).convert("RGBA").resize((SIZE, SIZE), Image.LANCZOS))
packed = packed.astype(np.float32) / 255
x = packed[..., 3] * 2 - 1           # CTI stores normal X in alpha
y = packed[..., 1] * 2 - 1           # and Y in green
z = np.sqrt(np.clip(1 - np.clip(x * x + y * y, 0, 1), 0, 1))
rgb = (np.stack([x, y, z], -1) * 0.5 + 0.5)
image = Image.fromarray(np.round(rgb * 255).astype(np.uint8))
save(TARGET, lambda dest: image.save(dest, optimize=True))

guid = hashlib.md5(b"golfmap-birch-leaf-normal:" + TARGET.encode()).hexdigest()
meta = (root / (SOURCE + ".meta")).read_text(encoding="utf-8")
meta = re.sub(r"^guid: \w+", "guid: " + guid, meta, count=1, flags=re.M)
meta = re.sub(r"^(\s*)textureType: 0$", r"\g<1>textureType: 1", meta, count=1, flags=re.M)
if "textureType: 1" not in meta:
    raise SystemExit("Could not switch the importer to NormalMap")
save(TARGET + ".meta", lambda dest: dest.write_text(meta, encoding="utf-8"))

material = (root / MATERIAL).read_text(encoding="utf-8")
slot = re.compile(r"^    - _BumpMap:\n        m_Texture: \{([^}]*)\}", re.M)
found = slot.search(material)
if not found:
    raise SystemExit("No _BumpMap slot in the material")
patched = slot.sub(
    lambda m: m.group(0).replace(found.group(1), "fileID: 2800000, guid: %s, type: 3" % guid),
    material,
    count=1,
)
save(MATERIAL, lambda dest: dest.write_text(patched, encoding="utf-8"))

sample = np.stack([x, y, z], -1).reshape(-1, 3)
print("normal map %dx%d  z mean %.3f (was 0.0 through UnpackScaleNormal)" % (SIZE, SIZE, sample[:, 2].mean()))
print("_BumpMap %s -> guid %s" % (found.group(1), guid))
