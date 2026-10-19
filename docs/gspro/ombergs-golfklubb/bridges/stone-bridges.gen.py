"""Omberg's old stone crossings: one parametric kind (props_kit `stone_bridge`), one asset per site so each has its own
length, seed and stable name (placed.json keeps a hand move per asset). Writes stone-bridges.json (props spec).

    python docs/gspro/ombergs-golfklubb/bridges/stone-bridges.gen.py [--all]     # --all also writes the candidate sites
    blender -b --factory-startup --python blender/tools/build_props.py -- --spec docs/gspro/ombergs-golfklubb/bridges/stone-bridges.json --out data/omberg-stone-bridges/build --preview
    pwsh docs/gspro/ombergs-golfklubb/clubhouse/install.ps1 -Build data/omberg-stone-bridges/build -UnityProject D:/gspro_courses/omberg_v4_2025_12_02 -CourseFolder Omberg
    then golfmap.props.place only=<asset> save=true in Unity (after the terrain / creek digs: the bridge stands on the highest ground under it).

Parameters of a site (see props_kit.stone_bridge): style `mound` (a low heap of warm blocky stones, Marcus's hole 6 photo) or
`arch` (the old coursed grey-stone arch bridge with a parapet: holes 7/9 photos); length (x, the way across), width (y, along the
creek), height (crest over the bank), opening / openingHeight (the culvert, 0 = solid), seed; e/n = EPSG:3006, yawDeg = compass
bearing of the long axis (across the creek), dz.

Colour per bridge: `darkness` (multiplies all channels of the stones' albedo, 1 = as built, 0.8 = darker, 1.15 = lighter) and `tint`
[r, g, b] multipliers, kept in stone-bridges.tune.json (asset -> {darkness, tint}) so a retune is one command, no Blender build:

    python .../stone-bridges.gen.py --tune omberg_stone_bridge_h6a darkness=0.8 tint=1,0.95,0.9
      -> writes the tune file and the spec, patches the stones' colour in the build's props.json and in the Unity project's
         Assets/GolfMap/Omberg/Props/props.json; then golfmap.props.place only=<asset> save=true in Unity applies it.

Sites come from the 2025 ortho (pale slabs on the creeks, centre by eye at 40 px/m) and the app's creek features
(water_creek 575, the hole 6 creek the DB tags hole 7; 233 on hole 17). `active` False = a candidate Marcus has not OK'd yet.
"""
import json
import os
import sys

UNITY_MANIFEST = "D:/gspro_courses/omberg_v4_2025_12_02/Assets/GolfMap/Omberg/Props/props.json"
BUILD_MANIFEST = os.path.join(os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "..")), "data", "omberg-stone-bridges", "build", "props.json")
TUNE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "stone-bridges.tune.json")

HERE = os.path.dirname(os.path.abspath(__file__))

SITES = {
    # hole 6's creek (feature 575), the two old bridges on the way to the single-bunker green; the first one of the reference photo
    "omberg_stone_bridge_h6a": dict(hole=6, e=477447.4, n=6457784.8, yawDeg=154.0, style="arch", length=7.0, width=2.6, height=1.2, seed=11, active=True,
                                    note="creek 575, deck 6.5 x 3.5 m in the ortho, creek WSW-ENE"),
    "omberg_stone_bridge_h6b": dict(hole=6, e=477521.1, n=6457810.1, yawDeg=180.0, style="arch", length=7.0, width=2.6, height=1.3, seed=23, active=True,
                                    note="creek 575, deck 6.7 x 3.3 m, creek W-E, a parapet strip on the east side"),
    # hole 3's long bridge over the pond arm east of the green (Google photo; ortho 2025: a pale deck about 16 x 2.6 m on bearing 52, lidar
    # points 0.9 m over the ground; no waterfall feature there). Three arches over piers. Centre by eye at 40 px/m.
    "omberg_stone_bridge_h3c": dict(hole=3, e=477955.0, n=6457780.0, yawDeg=52.0, style="arch", length=16.0, width=2.6, height=1.8, seed=51, active=True,
                                    opening=6.5, openingHeight=1.3, hump=5.0, depth=1.6,
                                    note="pond 572, the pale bridge SE of the green; Marcus's Street View photo: ONE wide shallow arch, long solid abutments, a flat coping"),
    # candidates: ask Marcus first
    "omberg_stone_bridge_h9c": dict(hole=9, e=477635.0, n=6457827.0, yawDeg=27.0, style="arch", length=6.5, width=2.6, height=1.2, seed=31, active=True,
                                    note="creek 575 where it enters hole 9's west pond (pale slab 5 x 3 m); not the 'bridge at hole 9's green' (sill E)"),
    # hole 9's green: the bridge over the channel from the upper pond 576 to the bay and fall E's lip just west of it
    # (Marcus 2026-10-19, photo from the west: "fallet är under bron"); deck 10.5 x 2.8 m in the 2025 ortho, N-S
    "omberg_stone_bridge_h9e": dict(hole=9, e=477742.9, n=6457804.8, yawDeg=175.0, style="arch", length=10.0, width=2.8, height=1.0, seed=53,
                                    opening=3.2, dz=-0.3, active=True,   # Marcus: 2 dm lower in the ground
                                    note="pond 576's channel under the bridge (E 477741-477745, N 6457803-6457808), fall E 5 m west"),
    "omberg_stone_bridge_h17": dict(hole=17, e=477672.6, n=6457220.5, yawDeg=69.0, style="arch", length=6.5, width=2.4, height=1.1, seed=41, active=True,
                                    note="replaces omberg_creek_bridge_17 (creek-bridge.json, 4.8 m on bearing 69) - Marcus 2026-10-19: the arch bridge on 17"),
}


def tune():
    return json.load(open(TUNE, encoding="utf-8")) if os.path.exists(TUNE) else {}


def spec(all_sites=False):
    tn = tune()
    assets, instances = {}, []
    for name, s in SITES.items():
        if not (s["active"] or all_sites):
            continue
        part = {"kind": "stone_bridge", "style": s["style"], "length": s["length"], "width": s["width"], "height": s["height"], "seed": s["seed"], "colorKey": name.replace("omberg_stone_bridge_", "")}
        part.update({k: v for k, v in tn.get(name, {}).items() if k in ("darkness", "tint")})
        part.update({k: s[k] for k in ("arches", "hump", "depth", "abutment", "pier", "opening", "openingHeight") if k in s and s["style"] == "arch"})
        if s["style"] == "arch":
            part["deck"] = s.get("deck", "turf_mat_dark")
        if s["style"] == "mound":
            part["stone"] = s.get("stone", 0.2)
            part["opening"] = s.get("opening", 1.8)
            part["openingHeight"] = s.get("openingHeight", 0.5)
        if "opening" in s:
            part["opening"] = s["opening"]
        assets[name] = {"category": "structure", "collider": "mesh", "parts": [part]}
        instances.append({"asset": name, "e": s["e"], "n": s["n"], "yawDeg": s["yawDeg"], "ground": s.get("ground", "median"), "dz": s.get("dz", -0.1)})
    return {"format": "golfmap-props-spec-v1", "course": "ombergs-golfklubb", "origin": [477520.0, 6457800.0],
            "note": "Omberg's old stone crossings, generated by stone-bridges.gen.py", "assets": assets, "instances": instances}


def patch_manifest(path, asset, key, base_mats, darkness, tint):
    if not os.path.exists(path):
        return 0
    m = json.load(open(path, encoding="utf-8"))
    n = 0
    for name, d in m.get("materials", {}).items():
        if name.endswith("@" + key) and name.split("@")[0] in base_mats:
            d["color"] = [round(darkness * c, 4) for c in tint]
            n += 1
    json.dump(m, open(path, "w", encoding="utf-8"), indent=1)
    return n


def cmd_tune(argv):
    asset = argv[0]
    if asset not in SITES:
        raise SystemExit("unknown bridge %s; sites: %s" % (asset, ", ".join(SITES)))
    tn = tune()
    cur = tn.setdefault(asset, {})
    for kv in argv[1:]:
        k, v = kv.split("=", 1)
        cur[k] = [float(x) for x in v.split(",")] if k == "tint" else float(v)
    json.dump(tn, open(TUNE, "w", encoding="utf-8"), indent=1)
    dk, tint = cur.get("darkness", 1.0), cur.get("tint", [1.0, 1.0, 1.0])
    key = asset.replace("omberg_stone_bridge_", "")
    mats = {"bridge_granite_a", "bridge_granite_b", "bridge_granite_c", "bridge_granite_core", "sandstone_ochre", "sandstone_rust", "sandstone_dark", "sandstone_core"}
    for p in (BUILD_MANIFEST, UNITY_MANIFEST):
        print(p, "->", patch_manifest(p, asset, key, mats, dk, tint), "materials")
    json.dump(spec(), open(os.path.join(HERE, "stone-bridges.json"), "w", encoding="utf-8"), indent=1)
    print("now: golfmap.props.place only=%s save=true" % asset)


if __name__ == "__main__":
    if "--tune" in sys.argv:
        cmd_tune(sys.argv[sys.argv.index("--tune") + 1:])
        raise SystemExit
    out = os.path.join(HERE, "stone-bridges.json")
    sp = spec("--all" in sys.argv)
    json.dump(sp, open(out, "w", encoding="utf-8"), indent=1)
    print("wrote", out, list(sp["assets"]))
