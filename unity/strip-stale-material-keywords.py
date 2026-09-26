"""Strip material keywords that the material's own shader never declares.

Unity 2018.2 has a hard cap of 256 *global* shader keywords, and a keyword takes a slot as soon
as any loaded material lists it in `m_ShaderKeywords` - whether or not that material's shader
has a variant for it. Asset Store materials authored against HDRP/LWRP (NatureManufacture, and
the copies under `Assets/GolfMap`) carry dozens of these (`_DISABLE_DBUFFER`, `_MASKMAP0`,
`_NORMALMAP_TANGENT_SPACE0-3`, ...), which is what pushes the project over the cap
("Maximum number (256) of shader keywords exceeded").

A keyword is stripped from a material only when it cannot select a variant:

  * custom shader (source under Assets/): the keyword appears nowhere in the .shader file nor in
    any .cginc/.hlsl in the project;
  * built-in Standard / Standard (Specular setup): the keyword is not one of the keywords those
    shaders declare in 2018.2.

Left alone: everything under `Assets/Resources` (the OPCD course materials carry `_RED*`/
`_BLACK*`/... keywords the local OPCD shader does not declare, but GSPro may bind its own OPCD
shader that does; TextMeshPro lives there too), materials on any other built-in shader, and
materials whose shader has no source in Assets/ (packages, missing shaders).

Dry run by default; `--apply` rewrites the .mat files after copying the originals to
`<project>/_keyword_strip_backup/`. Run with Unity closed, then restart it - the editor's
keyword table is only rebuilt on startup.

    python strip-stale-material-keywords.py [--project <dir>] [--apply]
"""
import argparse
import collections
import os
import re
import shutil

DEFAULT_PROJECT = r"D:\gspro_courses\vreta_v4_2025_12_02"
SKIP_DIRS = ("Assets" + os.sep + "Resources",)
BUILTIN_GUID = "0000000000000000f000000000000000"
STANDARD_KEYWORDS = {
    "_NORMALMAP", "_ALPHATEST_ON", "_ALPHABLEND_ON", "_ALPHAPREMULTIPLY_ON", "_EMISSION",
    "_DETAIL_MULX2", "_SMOOTHNESS_TEXTURE_ALBEDO_CHANNEL_A", "_SPECULARHIGHLIGHTS_OFF",
    "_GLOSSYREFLECTIONS_OFF", "_PARALLAXMAP",
}
# fileID of the built-in shader -> keywords it declares
BUILTIN_SHADERS = {
    "46": STANDARD_KEYWORDS | {"_METALLICGLOSSMAP"},  # Standard
    "45": STANDARD_KEYWORDS | {"_SPECGLOSSMAP"},      # Standard (Specular setup)
}

WORD = re.compile(r"\w+")
KEYWORDS = re.compile(r"(m_ShaderKeywords:)((?:[^\r\n]*)(?:\r?\n {4,}[^\r\n]*)*)")
SHADER_REF = re.compile(r"m_Shader:\s*\{fileID:\s*(-?\d+)(?:,\s*guid:\s*(\w+))?")


def read(path):
    with open(path, encoding="utf-8", errors="ignore", newline="") as f:
        return f.read()


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--project", default=DEFAULT_PROJECT)
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()
    root = args.project
    assets = os.path.join(root, "Assets")

    shader_words = {}     # guid -> words in the .shader file
    include_words = set() # words in every .cginc/.hlsl
    materials = []
    for dp, _, files in os.walk(assets):
        for name in files:
            path = os.path.join(dp, name)
            ext = os.path.splitext(name)[1].lower()
            if ext == ".shader" and os.path.exists(path + ".meta"):
                guid = re.search(r"guid:\s*(\w+)", read(path + ".meta"))
                if guid:
                    shader_words[guid.group(1)] = set(WORD.findall(read(path)))
            elif ext in (".cginc", ".hlsl", ".glslinc"):
                include_words |= set(WORD.findall(read(path)))
            elif ext == ".mat":
                materials.append(path)

    stripped = collections.Counter()  # keyword -> materials it was removed from
    kept = collections.Counter()      # keyword -> materials still listing it (incl. skipped ones)
    changed = []
    for path in materials:
        text = read(path)
        kw = KEYWORDS.search(text)
        ref = SHADER_REF.search(text)
        if not kw or not ref:
            continue
        keywords = kw.group(2).split()
        if keywords == ["[]"]:
            continue
        rel = os.path.relpath(path, root)
        fileid, guid = ref.group(1), ref.group(2)
        if rel.startswith(SKIP_DIRS):
            allowed = None
        elif guid == BUILTIN_GUID:
            allowed = BUILTIN_SHADERS.get(fileid)
        elif guid in shader_words:
            allowed = shader_words[guid] | include_words
        else:
            allowed = None
        keep = [k for k in keywords if allowed is None or k in allowed]
        kept.update(keep)
        if len(keep) == len(keywords):
            continue
        stripped.update(k for k in keywords if k not in keep)
        changed.append(rel)
        if args.apply:
            backup = os.path.join(root, "_keyword_strip_backup", rel)
            if not os.path.exists(backup):
                os.makedirs(os.path.dirname(backup), exist_ok=True)
                shutil.copy2(path, backup)
            new = text[:kw.start()] + kw.group(1) + (" " + " ".join(keep) if keep else " ") + text[kw.end():]
            with open(path, "w", encoding="utf-8", newline="") as f:
                f.write(new)

    freed = sorted(k for k in stripped if k not in kept)
    partial = sorted(k for k in stripped if k in kept)
    print("%s %d of %d materials" % ("rewrote" if args.apply else "would rewrite", len(changed), len(materials)))
    print("\nkeywords gone from every material (%d slots freed):" % len(freed))
    for k in freed:
        print("  %-44s %3d mats" % (k, stripped[k]))
    print("\nstripped where dead, still listed elsewhere (%d):" % len(partial))
    for k in partial:
        print("  %-44s -%3d, %3d remain" % (k, stripped[k], kept[k]))
    if not args.apply:
        print("\ndry run - pass --apply to rewrite the .mat files")


if __name__ == "__main__":
    main()
