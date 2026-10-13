"""Leaf colours by measurement, in a running Arborist (course open, mod loaded).

The species to tune stand in a row high above the course (pipeline/arborist.py lineup --at X Y Z
--heading 90), so each can be photographed against the sky alone. Per species this script sets a
leaf tint live (arb.tint: both of the shader's leaf tones, so a crown is one even colour), takes a
screenshot, measures the crown's mean colour, and corrects the tint until the crown is the colour
asked for. The result goes into the course's species file as one `tint` rule per species.

  python unity/ArboristMod/calibrate.py measure   --lineup-at 400 120 1000 --spacing 14 --height 14 --items A B C
  python unity/ArboristMod/calibrate.py calibrate ... --target "#566b3a" --conifer-target "#47583a" --write docs/gspro/<course>/arborist-species.json

  python unity/ArboristMod/calibrate.py billboards --lineup-at 400 120 1000 --items A B C --write docs/gspro/<course>/arborist-species.json

`billboards`: a tree's billboard (what stands in for it at a distance) is baked by Arborist from the
untinted model and lit by its own normal map, so it comes out another colour than the model, and
the trees change colour as one walks towards them. The lineup holds each species twice, the model
and then its billboard-only copy (`A A@far=1 B B@far=1`); the script measures both and writes the
billboard brightness, saturation and tint that bring the billboard to the model's colour. Billboard settings
cannot be set live: regenerate the lineup, reload and run again until the difference is small.

A tint multiplies the leaf texture, and every model's texture is a different green, so the same
tint gives different crowns: the measurement is what makes the species sit close together.
`--spread` keeps a little of each species' own character (0 = all the same colour).
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.request
from pathlib import Path

import numpy as np
from PIL import Image

CONIFERS = ("pine", "Fir_")
# Where the billboard calibration starts for a species with no rule yet; a lineup made before the
# first run must use the same (arborist-species.json, a "*" rule), or the first correction is off.
START = {"billboardTint": "#ffffff", "billboardBrightness": 1.3, "billboardDesat": 0.65}


def bridge():
    folder = Path(os.environ["LOCALAPPDATA"]) / "GolfMapPlayerBridge"
    # GSPro may be up with the same bridge: the calibration is Arborist's (GOLFMAP_PLAYER overrides).
    want = os.environ.get("GOLFMAP_PLAYER", "arborist").lower()
    found = [json.loads(p.read_text(encoding="utf-8")) for p in sorted(folder.glob("bridge-*.json"), key=lambda p: p.stat().st_mtime)]
    found = [b for b in found if want in str(b.get("projectPath", "")).lower()]
    if not found:
        sys.exit(f"No player bridge of '{want}' is running (start it with the mod).")
    return found[-1]


def call(info, command, args=None, timeout=120):
    request = urllib.request.Request(f"http://127.0.0.1:{info['port']}/cmd/{command}", data=json.dumps(args or {}).encode(),
                                     headers={"X-Bridge-Token": info["token"], "X-Bridge-Timeout": str(timeout), "Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(request, timeout=timeout + 10) as response:
        result = json.loads(response.read())
    if not result.get("ok"):
        sys.exit(f"{command}: {result.get('error')}")
    return result["result"]


def to_linear(c):
    c = np.asarray(c, dtype=np.float64)
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def to_srgb(c):
    c = np.clip(np.asarray(c, dtype=np.float64), 0, 1)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * c ** (1 / 2.4) - 0.055)


def hex_of(rgb):
    return "#%02x%02x%02x" % tuple(int(round(float(v) * 255)) for v in np.clip(rgb, 0, 1))


def rgb_of(text):
    v = text.lstrip("#")
    return np.array([int(v[i:i + 2], 16) / 255 for i in (0, 2, 4)])


def crown(info, args, index):
    """Mean linear colour of tree `index`'s crown and how uneven it is (std / mean of its luminance)."""
    x0, y0, z0 = args.lineup_at
    x = x0 + args.spacing * index
    top = y0 + args.height
    shot = call(info, "screenshot", {"from": [x, y0 - 0.2 * args.height, z0 - args.distance], "at": [x, y0 + 0.62 * args.height, z0],
                                     "frames": args.frames, "width": 960, "height": 540})
    image = np.asarray(Image.open(shot["file"]).convert("RGB"), dtype=np.float64) / 255
    h, w, _ = image.shape
    half = int(w * 0.5 * (0.42 * args.spacing) / (args.distance * np.tan(np.radians(20)) * (w / h)))
    strip = image[:, w // 2 - half:w // 2 + half]
    r, g, b = strip[..., 0], strip[..., 1], strip[..., 2]
    luma = 0.2126 * r + 0.7152 * g + 0.0722 * b
    # Not sky (blue or white), not a pale trunk: leaves are green or dark.
    leaves = ((np.maximum(r, g) > b + 0.03) | (luma < 0.33)) & ~((luma > 0.6) & (np.abs(g - b) < 0.06))
    if leaves.sum() < 200:
        return None, 0.0, int(leaves.sum())
    linear = to_linear(strip[leaves])
    lum = linear @ np.array([0.2126, 0.7152, 0.0722])
    return linear.mean(axis=0), float(lum.std() / max(lum.mean(), 1e-6)), int(leaves.sum())


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("mode", choices=["measure", "calibrate", "billboards"])
    parser.add_argument("--lineup-at", nargs=3, type=float, required=True, metavar=("X", "Y", "Z"))
    parser.add_argument("--spacing", type=float, default=14)
    parser.add_argument("--height", type=float, default=14)
    parser.add_argument("--distance", type=float, default=42)
    parser.add_argument("--frames", type=int, default=12)
    parser.add_argument("--items", nargs="+", required=True, help="the lineup's species, in row order")
    parser.add_argument("--target", default="#566b3a", help="crown colour for broadleaves")
    parser.add_argument("--conifer-target", default="#47583a")
    parser.add_argument("--spread", type=float, default=0.25, help="how much of each species' own colour difference to keep (0-1)")
    parser.add_argument("--iterations", type=int, default=4)
    parser.add_argument("--write", help="species JSON to put the tints into")
    parser.add_argument("--section", default="treeSettings", help="treeSettings or plantSettings")
    parser.add_argument("--billboard-normal", type=float, default=0.3, help="billboards: normal strength (1 = hard light and shadow sides)")
    args = parser.parse_args()
    info = bridge()

    if args.mode == "measure":
        for i, name in enumerate(args.items):
            mean, uneven, n = crown(info, args, i)
            print(f"{name:38s} " + ("no crown found" if mean is None else f"crown {hex_of(to_srgb(mean))}  unevenness {uneven:.2f}  ({n} px)"))
        return

    if args.mode == "billboards":
        path = Path(args.write) if args.write else None
        doc = json.loads(path.read_text(encoding="utf-8")) if path else {}
        rules = doc.get(args.section, [])
        weights = np.array([0.2126, 0.7152, 0.0722])
        worst, made = 0.0, []
        for i, name in enumerate(args.items):
            model, _, _ = crown(info, args, 2 * i)
            board, _, _ = crown(info, args, 2 * i + 1)
            if model is None or board is None:
                print(f"{name:38s} no crown found")
                continue
            old = next((r for r in rules if r.get("billboardCalibrated") and r.get("match") == [name]), None) or START
            # Three handles, each corrected a part of the way (the billboard does not answer in
            # proportion): brightness for how light, desat for how grey, the tint for the hue left.
            light = float((model @ weights) / max(board @ weights, 1e-4))
            grey = lambda c: 1 - float(c.min() / max(c.max(), 1e-4))
            brightness = float(np.clip(old["billboardBrightness"] * light ** 0.8, 0.2, 3.0))
            desat = float(np.clip(old["billboardDesat"] * (grey(model) / max(grey(board), 1e-3)) ** 0.8, 0.3, 1.0))
            hue = (model / (model @ weights)) / (board / (board @ weights))
            tint = to_linear(rgb_of(old["billboardTint"])) * np.array([hue[0], hue[1], 1.0]) ** 0.5
            tint = np.clip(tint / tint.max(), 0.4, 1.0)
            off = max(abs(light - 1), abs(grey(model) - grey(board)), abs(float(hue[0] / hue[1]) - 1))
            worst = max(worst, off)
            print(f"{name:38s} model {hex_of(to_srgb(model))}  billboard {hex_of(to_srgb(board))}  off {off * 100:3.0f} %  -> x{brightness:.2f} desat {desat:.2f} tint {hex_of(to_srgb(tint))}")
            made.append({"match": [name], "billboardTint": hex_of(to_srgb(tint)), "billboardBrightness": round(brightness, 3), "billboardDesat": round(desat, 3),
                         "billboardNormal": args.billboard_normal, "billboardCalibrated": True})
        print(f"largest difference {worst * 100:.0f} %")
        if path:
            names = {r["match"][0] for r in made}
            doc[args.section] = [r for r in rules if not (r.get("billboardCalibrated") and r.get("match", [""])[0] in names)] + made
            path.write_text(json.dumps(doc, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
            print(f"wrote {len(made)} billboard rules to {path}")
        return

    start = rgb_of("#808080")
    tints = {name: to_linear(start) for name in args.items}
    for name in args.items:
        call(info, "arb.tint", {"item": name, "leaf": hex_of(to_srgb(tints[name]))})
    first = {}
    for i, name in enumerate(args.items):
        first[name], _, _ = crown(info, args, i)
    # Each species' own colour at the same tint, relative to the average of its group: a part of that
    # difference is kept (--spread), so the species do not all become one flat green.
    targets = {}
    for group in (True, False):
        names = [n for n in args.items if any(k in n for k in CONIFERS) == group and first[n] is not None]
        if not names:
            continue
        base = to_linear(rgb_of(args.conifer_target if group else args.target))
        average = np.exp(np.mean([np.log(first[n] + 1e-6) for n in names], axis=0))
        for n in names:
            targets[n] = base * (first[n] / average) ** args.spread
    measured = dict(first)
    for step in range(args.iterations):
        for name in targets:
            if measured[name] is None:
                continue
            ratio = np.clip(targets[name] / np.maximum(measured[name], 1e-4), 0.4, 2.5)
            tints[name] = np.clip(tints[name] * ratio, 0.002, 1.0)
            call(info, "arb.tint", {"item": name, "leaf": hex_of(to_srgb(tints[name]))})
        worst = 0.0
        for i, name in enumerate(args.items):
            if name not in targets:
                continue
            measured[name], uneven, _ = crown(info, args, i)
            if measured[name] is not None:
                worst = max(worst, float(np.max(np.abs(measured[name] / targets[name] - 1))))
        print(f"pass {step + 1}: largest difference from the target {worst * 100:.0f} %")
        if worst < 0.05:
            break
    print()
    for i, name in enumerate(args.items):
        if name in targets and measured[name] is not None:
            _, uneven, _ = crown(info, args, i)
            print(f"{name:38s} tint {hex_of(to_srgb(tints[name]))}  crown {hex_of(to_srgb(measured[name]))}  wanted {hex_of(to_srgb(targets[name]))}  unevenness {uneven:.2f}")
    if args.write:
        path = Path(args.write)
        doc = json.loads(path.read_text(encoding="utf-8"))
        rules = [r for r in doc.get(args.section, []) if not (r.get("calibrated") and r.get("match", [""])[0] in args.items)]
        for name in args.items:
            if name in targets:
                rules.append({"match": [name], "tint": hex_of(to_srgb(tints[name])), "calibrated": True})
        doc[args.section] = rules
        path.write_text(json.dumps(doc, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        print(f"\nwrote {len(targets)} calibrated tints to {path}")


if __name__ == "__main__":
    main()
