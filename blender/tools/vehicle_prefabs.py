"""Step 1 of the low-poly vehicles (README "Low-poly vehicles"): parse the Unity prefabs a props spec places
as category `vehicle` (Unity 2018.2 text YAML) into <work>/prefabs.json - hierarchy, transforms, mesh
references (model file + mesh name through the .meta GUIDs), materials per renderer and each material's
colour, textures and render mode. Plain Python, reads the Unity project only.

    python blender/tools/vehicle_prefabs.py --project <Unity project> --spec <spec.json written BEFORE the
        spec pointed at low-poly prefabs, or any spec whose vehicle assets name the pack's prefabs> [--work <dir>]
        [--prefab <Assets/...prefab> ...]   (instead of --spec: just these prefabs)

Next: vehicle_models.py (merged ~20k models), vehicle_models_10k.py (background models + vehicles.json).
"""
import argparse
import collections
import json
import os
import re
import sys

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
WORK = os.path.join(REPO, "tree-export", "vehicles-lowpoly")  # git-ignored


def guid_index(root):
    idx = {}
    for d, _dirs, files in os.walk(root):
        for f in files:
            if not f.endswith(".meta"):
                continue
            p = os.path.join(d, f)
            try:
                with open(p, "r", encoding="utf-8", errors="replace") as fh:
                    head = fh.read(400)
            except OSError:
                continue
            m = re.search(r"^guid: ([0-9a-f]{32})", head, re.M)
            if m:
                idx[m.group(1)] = p[:-5]
    return idx


def vec(s):
    return [float(x) for x in re.findall(r"[xyzw]: ([-0-9.e+]+)", s)]


def parse_docs(text):
    docs = {}
    for m in re.finditer(r"^--- !u!(\d+) &(\d+)\n(\w+):\n(.*?)(?=^--- |\Z)", text, re.M | re.S):
        docs[int(m.group(2))] = (int(m.group(1)), m.group(3), m.group(4))
    return docs


def ref(body, key):
    m = re.search(r"^  %s: \{fileID: (-?\d+)(?:, guid: ([0-9a-f]{32}), type: \d+)?\}" % key, body, re.M)
    return (int(m.group(1)), m.group(2)) if m else (0, None)


def model_meta(path):
    """fileID -> name for a model's sub-assets, plus import scale settings."""
    with open(path + ".meta", "r", encoding="utf-8", errors="replace") as fh:
        t = fh.read()
    names = {int(a): b.strip() for a, b in re.findall(r"^    (\d+): (.*)$", t, re.M)}
    out = {"names": names}
    for k in ("globalScale", "useFileScale", "useFileUnits", "swapUVChannels", "meshCompression", "importNormals", "normalSmoothingAngle", "optimizeMeshForGPU", "weldVertices"):
        m = re.search(r"^\s+%s: (.*)$" % k, t, re.M)
        out[k] = m.group(1).strip() if m else None
    return out


def material_info(path, idx):
    t = open(path, encoding="utf-8", errors="replace").read()
    tex = {}
    for m in re.finditer(r"- (_\w+):\s+m_Texture: \{fileID: (\d+)(?:, guid: (\w+))?", t):
        if m.group(3):
            tex[m.group(1)] = idx.get(m.group(3))
    fl = {k: float(v) for k, v in re.findall(r"- (_Mode|_Metallic|_Glossiness|_Cutoff): ([-\d.e]+)", t)}
    col = re.search(r"- _Color: \{r: ([\d.e-]+), g: ([\d.e-]+), b: ([\d.e-]+), a: ([\d.e-]+)", t)
    return {"path": path, "color": [float(x) for x in col.groups()] if col else [1, 1, 1, 1], "textures": tex, **fl}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--project", required=True, help="Unity project root")
    ap.add_argument("--spec", help="props spec (golfmap-props-spec-v1): its vehicle assets' prefabs are parsed")
    ap.add_argument("--prefab", action="append", default=[], help="a prefab asset path (repeatable), instead of --spec")
    ap.add_argument("--work", default=WORK)
    a_ = ap.parse_args()
    PROJECT, OUT = a_.project, os.path.join(a_.work, "prefabs.json")
    os.makedirs(a_.work, exist_ok=True)
    prefabs = collections.OrderedDict()
    for path in a_.prefab:
        prefabs[path] = {"assets": {}, "instances": 0, "axis": "z"}
    if a_.spec:
        spec = json.load(open(a_.spec, encoding="utf-8"))
        counts = collections.Counter(i["asset"] for i in spec["instances"])
        for aid, a in spec["assets"].items():
            if a.get("category") != "vehicle":
                continue
            p = prefabs.setdefault(a["prefab"], {"assets": {}, "instances": 0, "axis": a.get("axis", "x")})
            p["assets"][aid] = {"instances": counts[aid], "recolor": a.get("recolor", [])}
            p["instances"] += counts[aid]
    if not prefabs:
        sys.exit("No vehicle prefabs: pass --spec or --prefab.")

    idx = guid_index(os.path.join(PROJECT, "Assets"))
    metas = {}
    for ppath, p in prefabs.items():
        full = os.path.join(PROJECT, ppath.replace("/", os.sep))
        text = open(full, "r", encoding="utf-8").read().replace("\r\n", "\n")
        docs = parse_docs(text)
        root_go = int(re.search(r"m_RootGameObject: \{fileID: (\d+)\}", text).group(1))
        gos = {}
        comp_types = collections.Counter(v[1] for v in docs.values())
        tr_of_go, go_of_tr = {}, {}
        trs = {}
        for fid, (_cls, kind, body) in docs.items():
            if kind == "GameObject":
                gos[fid] = {"name": re.search(r"^  m_Name: (.*)$", body, re.M).group(1).strip(),
                            "active": re.search(r"^  m_IsActive: (\d)", body, re.M).group(1) == "1",
                            "layer": int(re.search(r"^  m_Layer: (\d+)", body, re.M).group(1)),
                            "components": [int(x) for x in re.findall(r"- component: \{fileID: (\d+)\}", body)]}
            elif kind == "Transform":
                go = ref(body, "m_GameObject")[0]
                children = [int(x) for x in re.findall(r"^  - \{fileID: (\d+)\}", body, re.M)]
                trs[fid] = {"go": go, "parent": ref(body, "m_Father")[0], "children": children,
                            "pos": vec(re.search(r"m_LocalPosition: (\{.*\})", body).group(1)),
                            "rot": vec(re.search(r"m_LocalRotation: (\{.*\})", body).group(1)),  # x y z w
                            "scale": vec(re.search(r"m_LocalScale: (\{.*\})", body).group(1))}
                tr_of_go[go] = fid
        nodes = []
        for tid, t in trs.items():
            g = gos[t["go"]]
            node = {"id": tid, "name": g["name"], "active": g["active"], "parent": t["parent"] or None,
                    "pos": t["pos"], "rot": t["rot"], "scale": t["scale"], "root": t["go"] == root_go}
            for cid in g["components"]:
                _c, kind, body = docs[cid]
                if kind == "MeshFilter":
                    fid, guid = ref(body, "m_Mesh")
                    if guid:
                        mpath = idx.get(guid)
                        if mpath and mpath not in metas:
                            metas[mpath] = model_meta(mpath)
                        node["mesh"] = {"fileID": fid, "guid": guid, "model": mpath,
                                        "name": metas[mpath]["names"].get(fid) if mpath else None}
                elif kind == "MeshRenderer":
                    mats = re.findall(r"^  - \{fileID: (\d+)(?:, guid: ([0-9a-f]{32}), type: \d+)?\}", body.split("m_Materials:")[1].split("m_StaticBatchInfo")[0], re.M)
                    node["materials"] = [os.path.splitext(os.path.basename(idx.get(g, "?" + str(g))))[0] if g else None for _f, g in mats]
                    node["materialPaths"] = [idx.get(g) if g else None for _f, g in mats]
                    node["enabled"] = re.search(r"^  m_Enabled: (\d)", body, re.M).group(1) == "1"
                    node["castShadows"] = int(re.search(r"^  m_CastShadows: (\d)", body, re.M).group(1))
                elif kind not in ("Transform",):
                    node.setdefault("other", []).append(kind)
            nodes.append(node)
        p["path"] = full
        p["components"] = dict(comp_types)
        p["nodes"] = nodes
    for mp, m in metas.items():
        m["names"] = {str(k): v for k, v in m["names"].items()}
    materials = {}
    for p in prefabs.values():
        for n in p["nodes"]:
            for mp in n.get("materialPaths", []):
                if mp and os.path.splitext(os.path.basename(mp))[0] not in materials:
                    materials[os.path.splitext(os.path.basename(mp))[0]] = material_info(mp, idx)
    json.dump({"prefabs": prefabs, "models": metas, "materials": materials}, open(OUT, "w", encoding="utf-8"), indent=1)

    for ppath, p in prefabs.items():
        print("==", ppath, "instances", p["instances"], p["components"])
        models = collections.Counter(n["mesh"]["model"] for n in p["nodes"] if "mesh" in n)
        for m, c in models.items():
            mm = metas.get(m, {})
            print("   model", c, m, {k: v for k, v in mm.items() if k != "names"})
        mats = collections.Counter(m for n in p["nodes"] for m in n.get("materials", []))
        print("   materials", dict(mats))
        for n in p["nodes"]:
            if n["root"]:
                print("   root", n["name"], n["pos"], n["rot"], n["scale"], n.get("other"))
        print("   inactive/disabled:", [n["name"] for n in p["nodes"] if not n["active"] or n.get("enabled") is False])
        print("   others:", [(n["name"], n["other"]) for n in p["nodes"] if n.get("other")])


if __name__ == "__main__":
    sys.exit(main())
