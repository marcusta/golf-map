"""Stage Forst's own CTI look for the oaks and birches, under shader names GSPro's VSP knows.

Forst recommends its CTI shaders (`CTI/LOD Leaves 301`, `CTI/LOD Bark 301`, `CTI/LOD Bark Array
301`) plus `VSPro_CTIShaderController.unitypackage` for Vegetation Studio Pro. That package only
patches `CTIShaderController.cs` - C#, which never reaches GSPro (courses load as asset bundles;
GSPro runs its own VSP build). Both GSPro builds on this machine were checked by IL:
`ShaderUtility.GetShaderController` asks every `IShaderController` in the VSP runtime assembly and
has no fallback, and `CTIShaderController.MatchShader` lists `CTI/LOD Leaves`, `CTI/LOD Bark` and
`CTI/LOD Bark Array` - exact `==` in the release (2025-12), `AllShaderNames[i].Contains(name)` in
the public beta (2026-06; Forst's patch, which compares the wrong way round). A "301" name matches
neither, and an unmatched shader drops every tree in its package (unity/AGENTS.md).

So this copies the three shaders with the "301" dropped from the name - the stock CTI names the
lookup expects - and nothing else changed, except that the leaves also get `exclude_path:deferred
exclude_path:prepass`. CTI leaves in deferred pack translucency into the specular G-buffer and need
Forst's `CTI_Internal-DeferredShading` assigned in Graphics settings ("otherwise the trees will look
pretty colorful"); GSPro's Graphics settings are not ours to change, and its camera's rendering path
is unknown. Forward-only leaves light correctly on either path.

The materials come from the pristine Asset Store packages, not the project: every Forst material in
the project has already been converted in place to NatureManufacture shaders. They are extracted as
they shipped (binary, Unity 5.6) into NEW files, so Unity gives them fresh guids; `golfmap.cti.apply`
retargets them to the renamed shaders and turns on "Use Wind from Script" (VSP's `CTIWindController`
feeds `_TerrainLODWind`, which that switch reads). Their look is tuned by texture copies
(prepare-cti-maps.py), recorded in trial.json.

Only files that do not exist yet are written: an existing shader, include or material is left as it
is (Unity has re-saved the materials since). trial.json is merged - swaps it has keep their entry
(and their texture overrides), new SWAPS rows are added - so re-running after adding a row only adds
that swap. Every swap needs its own trial material: golfmap.cti.restore reverses the swap in memory,
which a shared trial material would make ambiguous. Swapping onto the prefabs, and back, is the
Unity side: `golfmap.cti.status|apply|restore` (`Editor/GolfMap/GolfMapCtiTrial.cs`), which backs
up everything it changes first.

Usage: pipeline/.venv/Scripts/python unity/prepare-cti-trial.py UNITY_ROOT [COURSE_FOLDER]
       COURSE_FOLDER defaults to Assets/GolfMap/Vreta
"""
import json
import os
import re
import sys
import tarfile
from pathlib import Path

SHADERS = "Assets/GolfMap/CTI/Shaders"
FORST_CACHE = Path(os.environ.get("APPDATA", "")) / "Unity/Asset Store-5.x/forst/3D ModelsVegetationTrees"
OAK_PKG, BIRCH_PKG = "Oak Trees Package.unitypackage", "Birch Trees Package.unitypackage"

# Shader source guid (same in the Oak and Birch packages) -> the copy's file and stock name.
SHADER_COPIES = {
    "6ae32366f15a64fc19f245f040af8f21": ("CTI_LOD_Leaves.shader", "CTI/LOD Leaves"),
    "6934a0dff195b47e5913f17edb3770ec": ("CTI_LOD_Bark.shader", "CTI/LOD Bark"),
    "00baf766089b44ee3b05e340b19c821c": ("CTI_LOD_Bark_Array.shader", "CTI/LOD Bark Array"),
}

# What the planted prefabs use now (relative to the course folder) -> the pristine Forst material
# that replaces it. The prefabs are Forst's "Terrain" LOD prefabs, so these are what they shipped with.
SWAPS = [
    ("FoliageTrialV2/Oak Leaves.mat", OAK_PKG, "0d94b19c5836243a8b36801da94bb962", "CTI Oak Leaves.mat", "CTI/LOD Leaves"),
    ("FoliageTrialV2/Oak Bark.mat", OAK_PKG, "fd83e3e5763514b0ab1a37a94b994a2b", "CTI Oak Bark.mat", "CTI/LOD Bark"),
    ("FoliageTrialV2/Birch Leaves.mat", BIRCH_PKG, "a049c29ed09c143049fdd06320ddb15c", "CTI Birch Leaves.mat", "CTI/LOD Leaves"),
    ("FoliageTrialV2/Birch Bark.mat", BIRCH_PKG, "8c4c891bbca4f442c901310648633202", "CTI Birch Bark.mat", "CTI/LOD Bark Array"),
    # Most planted birches are the "darker" look variants (GolfMapTreeLooks) with their own
    # materials. They get their own trial materials (restore needs that), tuned like the plain
    # birch's - from the original birch colour, not the dark look (Marcus never liked it).
    ("Looks/birch/darker/Birch Leaves.mat", BIRCH_PKG, "a049c29ed09c143049fdd06320ddb15c", "CTI Birch Leaves (darker look).mat", "CTI/LOD Leaves"),
    ("Looks/birch/darker/Birch Bark.mat", BIRCH_PKG, "8c4c891bbca4f442c901310648633202", "CTI Birch Bark (darker look).mat", "CTI/LOD Bark Array"),
]
if len({name for _, _, _, name, _ in SWAPS}) != len(SWAPS):
    raise SystemExit("Every swap needs its own trial material")

root = Path(sys.argv[1])
course = (sys.argv[2] if len(sys.argv) > 2 else "Assets/GolfMap/Vreta").rstrip("/")
trial = course + "/CTITrial"


def guid_index():
    found = {}
    for meta in (root / "Assets").rglob("*.shader.meta"):
        m = re.search(r"^guid: (\w+)", meta.read_text(encoding="utf-8", errors="ignore"), re.M)
        if m:
            found[m.group(1)] = meta.with_suffix("")
    return found


def no_dither_crossfade(text, src):
    """Compile the LOD_FADE_CROSSFADE variant out. VSP switches that keyword on for the last mesh
    LOD (CTIShaderController.LODFadeCrossfade), and there the dither cut random pixels out of the
    crowns for single frames (black speckles, 2026-10-09; gone with the keyword off). GSPro's VSP
    sets the keyword itself, so the shader has to ignore it. The trees then pop at the tree
    distance instead of dithering out over its last 10 m."""
    text, n = re.subn(r"^(\s*#pragma surface .*?)\s+dithercrossfade\b", r"\1", text, flags=re.M)
    if n != 1:
        raise SystemExit("%s: expected one surface pragma with dithercrossfade, found %d" % (src, n))
    return re.sub(r"^(\s*#pragma multi_compile\s+LOD_FADE_PERCENTAGE)\s+LOD_FADE_CROSSFADE\s*$", r"\1", text, flags=re.M)


writes = {}  # project-relative path -> bytes

# Shaders: the project's copy of Forst's CTI runtime (it came with the Birch package).
shaders = guid_index()
source_dir = None
for guid, (name, stock) in SHADER_COPIES.items():
    src = shaders.get(guid)
    if not src:
        raise SystemExit("Forst CTI shader %s not found in the project" % guid)
    source_dir = src.parent
    text = src.read_text(encoding="utf-8-sig")
    text, n = re.subn(r'^(\s*Shader\s+)"CTI/[^"]+ 301"', r'\1"%s"' % stock, text, count=1, flags=re.M)
    if n != 1:
        raise SystemExit("%s: no 'CTI/... 301' shader name to replace" % src)
    if stock == "CTI/LOD Leaves":
        text, n = re.subn(r"^(\s*#pragma surface surf StandardTranslucent .*?)\s*$",
                          r"\1 exclude_path:deferred exclude_path:prepass", text, flags=re.M)
        if n != 1:
            raise SystemExit("%s: expected one StandardTranslucent surface pragma, found %d" % (src, n))
    writes["%s/%s" % (SHADERS, name)] = no_dither_crossfade(text, src).encode("utf-8")

for inc in sorted((source_dir / "Includes").glob("*.cginc")):
    writes["%s/Includes/%s" % (SHADERS, inc.name)] = inc.read_bytes()

# Materials, straight out of the pristine packages (only the ones not written yet).
wanted = {}
for _, package, guid, name, _ in SWAPS:
    if not (root / trial / name).exists():
        wanted.setdefault(package, {}).setdefault(guid + "/asset", []).append(name)
for package, members in wanted.items():
    path = FORST_CACHE / package
    if not path.exists():
        raise SystemExit("Pristine Forst package not in the Asset Store cache: %s" % path)
    with tarfile.open(path, "r:gz") as tar:
        for member in tar:
            key = member.name.lstrip("./")
            if key in members:
                data = tar.extractfile(member).read()
                for name in members[key]:
                    writes["%s/%s" % (trial, name)] = data
missing = [n for m in wanted.values() for names in m.values() for n in names if "%s/%s" % (trial, n) not in writes]
if missing:
    raise SystemExit("Not found in the Forst packages: %s" % ", ".join(missing))

manifest_path = root / trial / "trial.json"
manifest = json.loads(manifest_path.read_text(encoding="utf-8")) if manifest_path.exists() else {
    "note": "Swaps from unity/prepare-cti-trial.py, texture overrides from prepare-cti-maps.py. Read by golfmap.cti.apply/restore.",
    "swaps": []}
have = {s["from"] for s in manifest["swaps"]}
added = []
for frm, _, _, name, shader in SWAPS:
    if not (root / course / frm).exists():
        raise SystemExit("Current material missing: %s/%s" % (course, frm))
    if "%s/%s" % (course, frm) not in have:
        manifest["swaps"].append({"from": "%s/%s" % (course, frm), "to": "%s/%s" % (trial, name), "shader": shader})
        added.append(frm)

for rel, data in writes.items():
    dest = root / rel
    if dest.exists():
        continue
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(data)
    print("wrote", rel)
manifest_path.parent.mkdir(parents=True, exist_ok=True)
manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
print("trial.json: %d swaps, %s" % (len(manifest["swaps"]), ("added " + ", ".join(added)) if added else "none added"))
print("\nExisting files were left alone. Next: prepare-cti-maps.py for the look, then in Unity")
print("golfmap.cti.status and golfmap.cti.apply.")
print("To remove the trial entirely: golfmap.cti.restore, then delete %s and %s." % (SHADERS, trial))
