"""Report which bunker paint convention each bunker and bunker blend is painted with.

The Blender twin of the Unity Bunker Materials "Check paint" (unity/Editor/GolfMap/
GolfMapBunkerChannels.cs): same conventions file, same ring counting, same scores,
so both ends of a course can be compared line by line.

Run headless against a course file (read-only, nothing is saved):

    blender -b course.blend --python blender/tools/bunker_paint_report.py -- \
        [--conventions blender/conventions/bunker-channels.json] [--convention ce-simgolf] [--json out.json]
"""

import argparse
import json
import os
import sys
from collections import Counter

import bmesh
import bpy

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_CONVENTIONS = os.path.join(HERE, "..", "conventions", "bunker-channels.json")
CHANNELS = ("red", "green", "blue", "black")
PASS_SCORE = 0.6
SEAM_TOLERANCE = 0.05  # metres between a blend's inner edge and the bunker seam
BUNKER_SUFFIX = "_Bunker_-_Mesh"
BLEND_MARKER = "_Bunker_-_Blend"


def dominant(color):
    r, g, b = color[0], color[1], color[2]
    if max(r, g, b) < 0.25:
        return "black"
    if r >= g and r >= b:
        return "red"
    return "green" if g >= b else "blue"


class Tally:
    def __init__(self):
        self.counts = Counter()

    @property
    def total(self):
        return sum(self.counts.values())

    def share(self, channels):
        if isinstance(channels, str):
            channels = [channels]
        return sum(self.counts[c] for c in set(channels)) / self.total if self.total else 0.0

    def __str__(self):
        if not self.total:
            return "-"
        short = {"red": "R", "green": "G", "blue": "B", "black": "BL"}
        return " ".join(f"{short[c]}{round(100 * self.counts[c] / self.total)}%" for c in CHANNELS if self.counts[c])


def vertex_colors(ob):
    """Per-vertex colour: the corner colour of each vertex's first loop, as FBX export writes it."""
    me = ob.data
    attr = me.color_attributes.active_color or (me.color_attributes[0] if me.color_attributes else None)
    if attr is None:
        return None
    if attr.domain == "POINT":
        return [tuple(d.color) for d in attr.data]
    colors = [None] * len(me.vertices)
    for loop in me.loops:
        if colors[loop.vertex_index] is None:
            colors[loop.vertex_index] = tuple(attr.data[loop.index].color)
    return [c if c is not None else (0, 0, 0, 1) for c in colors]


def ring_depths(ob, max_rings):
    """Vertex index -> rings in from the open boundary, for the first max_rings rings."""
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    frontier = {e.verts[i].index for e in bm.edges if e.is_boundary for i in (0, 1)}
    links = {v.index: [e.other_vert(v).index for e in v.link_edges] for v in bm.verts}
    bm.free()
    depth = {i: 0 for i in frontier}
    for d in range(1, max_rings):
        nxt = set()
        for i in frontier:
            for n in links[i]:
                if n not in depth:
                    depth[n] = d
                    nxt.add(n)
        frontier = nxt
    return depth


def tally_bunker(ob, max_rings):
    colors = vertex_colors(ob)
    if colors is None:
        return None, None
    depth = ring_depths(ob, max_rings)
    rings = [Tally() for _ in range(max_rings)]
    interior = Tally()
    for i, c in enumerate(colors):
        (rings[depth[i]] if i in depth else interior).counts[dominant(c)] += 1
    return rings, interior


def seam_points(ob):
    depth = ring_depths(ob, 1)
    mw = ob.matrix_world
    return [mw @ ob.data.vertices[i].co for i in depth]


def tally_blend(ob, bunker_seam):
    colors = vertex_colors(ob)
    if colors is None:
        return None, None
    inner, outer = Tally(), Tally()
    mw = ob.matrix_world
    tol2 = SEAM_TOLERANCE * SEAM_TOLERANCE
    for i in ring_depths(ob, 1):
        p = mw @ ob.data.vertices[i].co
        near = any((p - q).length_squared <= tol2 for q in bunker_seam)
        (inner if near else outer).counts[dominant(colors[i])] += 1
    return inner, outer


def score_bunker(rule, rings, interior):
    if not rings or not rings[0].total:
        return 0.0
    s = 1.0
    for expected, tally in zip(rule.get("rings", []), rings):
        if tally.total:
            s *= tally.share(expected)
    return s if not interior.total else s * interior.share(rule.get("interior", []))


def score_blend(rule, inner, outer):
    if not inner.total or not outer.total:
        return 0.0
    return inner.share(rule["inner"]) * outer.share(rule["outer"])


def main(argv):
    ap = argparse.ArgumentParser()
    ap.add_argument("--conventions", default=DEFAULT_CONVENTIONS)
    ap.add_argument("--convention", default="ce-simgolf")
    ap.add_argument("--json", default=None)
    args = ap.parse_args(argv)
    with open(args.conventions, encoding="utf-8") as f:
        conventions = json.load(f)["conventions"]
    chosen = conventions[args.convention]
    max_rings = max(len(c["bunker"].get("rings", [])) for c in conventions.values())

    meshes = [o for o in bpy.data.objects if o.type == "MESH"]
    bunkers = {o.name[: o.name.index(BUNKER_SUFFIX)]: o for o in meshes if BUNKER_SUFFIX in o.name and "Potwall" not in o.name}
    blends = {}
    for o in meshes:
        if BLEND_MARKER not in o.name:
            continue
        # "X_B_Rough_Bunker_-_Blend" and split "X_piece1_Rough_B_Bunker_-_Blend" belong to bunker X.
        owners = [k for k in bunkers if o.name.startswith(k + "_")]
        blends.setdefault(max(owners, key=len) if owners else o.name.split("_B_")[0], []).append(o)

    rows, best = [], Counter()
    ok_b = ok_bl = n_bl = 0
    print(f"Bunker paint check - {args.conventions}, selected: {chosen['label']}")
    for key in sorted(set(bunkers) | set(blends)):
        seam = None
        if key in bunkers:
            ob = bunkers[key]
            rings, interior = tally_bunker(ob, max_rings)
            if rings is None:
                print(f"  {ob.name}: no vertex colours")
            else:
                scores = {cid: score_bunker(c["bunker"], rings, interior) for cid, c in conventions.items()}
                top = max(scores, key=scores.get)
                if scores[top] >= PASS_SCORE:
                    best[top] += 1
                ok = scores[args.convention] >= PASS_SCORE
                ok_b += ok
                print(f"  {'ok' if ok else '!!'}  {ob.name}  rings {' | '.join(str(r) for r in rings)}  interior {interior}"
                      f"  -> {conventions[top]['label']} {scores[top]:.2f}")
                rows.append({"mesh": ob.name, "kind": "bunker", "best": top, "scores": scores})
            seam = seam_points(ob)
        for bl in blends.get(key, []):
            n_bl += 1
            if seam is None:
                print(f"  ??  {bl.name}: no bunker mesh {key}{BUNKER_SUFFIX}")
                continue
            inner, outer = tally_blend(bl, seam)
            if inner is None:
                print(f"  {bl.name}: no vertex colours")
                continue
            scores = {cid: score_blend(c["blend"], inner, outer) for cid, c in conventions.items()}
            top = max(scores, key=scores.get)
            ok = scores[args.convention] >= PASS_SCORE
            ok_bl += ok
            print(f"  {'ok' if ok else '!!'}  {bl.name}  inner {inner}  outer {outer}  -> {conventions[top]['label']} {scores[top]:.2f}")
            rows.append({"mesh": bl.name, "kind": "blend", "best": top, "scores": scores})
    best_text = ", ".join(conventions[k]["label"] + " " + str(v) for k, v in best.items())
    summary = (f"{ok_b}/{len(bunkers)} bunkers and {ok_bl}/{n_bl} blends match {chosen['label']}. "
               f"Best match per bunker: {best_text}.")
    print(summary)
    if args.json:
        with open(args.json, "w", encoding="utf-8") as f:
            json.dump({"summary": summary, "meshes": rows}, f, indent=1)


if __name__ == "__main__":
    main(sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else [])
