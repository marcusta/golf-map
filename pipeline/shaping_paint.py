"""shaping-paint: a course's paint.json -> the generated Blender shaping layer 90-paint.gen.json.

The rule-based vertex paint of the course meshes, which Unity's GolfMap > Vertex Paint (GolfMapVertexPaint) and the
big lake's bed (GolfMapLake.Bed) used to paint, as `golfmap.paint` ops replayed by the Blender shaping step
(blender/tools/shape_paintop.py, maths in shape_paintrules.py). One op per enabled rule, in Unity's order:

    object rules -> road rules -> edge rules (each kind in file order), then the lake bed, then the strokes (file order)

Input `docs/gspro/<course>/paint.json`, format `golfmap-paint-v1` (unchanged; Unity ignores the two new top-level
keys, so the file stays v1):
- `rules`: as Unity reads them (kinds object, road, edge; `enabled: false` keeps a rule without painting it). The
  Unity-only keys (`material`, `grassFrom`) stay in the file for Unity and are left out of the ops.
- `lakebed` (optional): `{"enabled": true, "bandM": 25, "fadeM": 20}` - the big lake's light sand band (red within
  bandM of the shore, fading out over fadeM; GolfMapLake.Bed's defaults). The op paints every lake bed mesh under the
  water and over the shore grid of the course's `<prefix>-inner-lake-plane.json`, and nothing on a course without one.
- `strokes` (optional): persistent hand paint, `{"id", "geometry": "line" | "polygon" | "circle", "points3006":
  [[E, N], ...] (line, polygon) | "centre3006": [E, N] + "radiusM" (circle), "widthM" (a line's full width),
  "featherM", "channel", "strength", "mode": "replace" | "overlay", "surfaces", "match", "enabled"}`.

Op ids are stable: `paint-<rule id>`, `paint-lakebed`, `paint-stroke-<stroke id>`. Deterministic output.
Run: `gspro.py shaping-paint --course-dir docs/gspro/<course> [--out-dir <shaping dir>]`.
"""

import argparse
import json
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
TOOLS = REPO_ROOT / "blender" / "tools"
PAINT_FORMAT = "golfmap-paint-v1"
LAYER_FORMAT = "golfmap-shaping-layer-v1"
LAYER_ID = "paint"
OUT_FILE = "90-paint.gen.json"
OP = "golfmap.paint"
GENERATOR = "pipeline/gspro.py shaping-paint"
RULE_ORDER = ("object", "road", "edge")   # GolfMapVertexPaint's order on a vertex
UNITY_ONLY_KEYS = ("material", "grassFrom", "enabled", "notes", "note")
LAKEBED_DEFAULTS = {"bandM": 25.0, "fadeM": 20.0}


class PaintError(ValueError):
    pass


def _rules_module():
    """blender/tools/shape_paintrules.py (numpy + shape_coords): the engine's own rule check."""
    if str(TOOLS) not in sys.path:
        sys.path.insert(0, str(TOOLS))
    import shape_paintrules
    return shape_paintrules


def _op(op_id: str, rule: dict, where: str) -> dict:
    errors = _rules_module().validate(rule, where)
    if errors:
        raise PaintError(errors[0])
    return {"id": op_id, "op": OP, "rule": rule}


def paint_layer(paint: dict, course: str | None = None, source: str | None = None) -> dict:
    """The 90-paint layer of a paint.json document."""
    if not isinstance(paint, dict) or paint.get("format") != PAINT_FORMAT:
        raise PaintError(f"paint.json: format must be {PAINT_FORMAT}")
    rules = paint.get("rules") or []
    if not isinstance(rules, list):
        raise PaintError("paint.json: rules must be a list")
    ops = []
    for i, r in enumerate(rules):
        if not isinstance(r, dict):
            raise PaintError(f"paint.json rules[{i}]: not an object")
        if r.get("kind") not in RULE_ORDER:
            raise PaintError(f"paint.json rules[{i}]: kind must be 'edge', 'object' or 'road'")
    for kind in RULE_ORDER:
        for i, r in enumerate(rules):
            if r.get("kind") != kind or r.get("enabled") is False:
                continue
            rule = {k: v for k, v in r.items() if k not in UNITY_ONLY_KEYS}
            rule["id"] = str(r.get("id") or f"rule{i}")
            ops.append(_op(f"paint-{rule['id']}", rule, f"paint.json rules[{i}]"))
    lake = paint.get("lakebed") or {}
    if not isinstance(lake, dict):
        raise PaintError("paint.json: lakebed must be an object")
    if lake.get("enabled", True) is not False:
        rule = {"id": "lakebed", "kind": "lakebed"}
        rule.update({k: lake.get(k, v) for k, v in LAKEBED_DEFAULTS.items()})
        ops.append(_op("paint-lakebed", rule, "paint.json lakebed"))
    strokes = paint.get("strokes") or []
    if not isinstance(strokes, list):
        raise PaintError("paint.json: strokes must be a list")
    for i, s in enumerate(strokes):
        if not isinstance(s, dict) or not isinstance(s.get("id"), str) or not re.fullmatch(r"[\w.-]+", s["id"]):
            raise PaintError(f"paint.json strokes[{i}]: needs an id (letters, digits, _ . -)")
        if s.get("enabled") is False:
            continue
        rule = {k: v for k, v in s.items() if k not in UNITY_ONLY_KEYS}
        rule["kind"] = "stroke"
        ops.append(_op(f"paint-stroke-{s['id']}", rule, f"paint.json strokes[{i}]"))
    seen = set()
    for op in ops:
        if op["id"] in seen:
            raise PaintError(f"paint.json: op id {op['id']!r} repeats (two rules or strokes with one id)")
        seen.add(op["id"])
    layer = {"format": LAYER_FORMAT, "id": LAYER_ID, "generated": True, "generator": GENERATOR}
    if course:
        layer["course"] = {"folder": course}
    if source:
        layer["source"] = source
    layer["ops"] = ops
    return layer


def _layer_json(doc: dict) -> str:
    """Indented JSON with each [x, y] pair on one line (as gspro.py's shaping layers)."""
    text = json.dumps(doc, indent=2, ensure_ascii=False)
    return re.sub(r"\[\s+(-?[\d.eE+-]+),\s+(-?[\d.eE+-]+)\s+\]", r"[\1, \2]", text) + "\n"


def cmd_shaping_paint(course_dir: Path, out_dir: Path | None = None, out: Path | None = None) -> Path | None:
    """Write <out_dir or course_dir/shaping>/90-paint.gen.json from <course_dir>/paint.json. Returns its path; None
    for a course without paint.json (a stale layer is removed: the shaping run calls this for every course)."""
    course_dir = Path(course_dir)
    src = course_dir / "paint.json"
    if not src.is_file():
        stale = out or (Path(out_dir) if out_dir else course_dir / "shaping") / OUT_FILE
        if stale.is_file():
            stale.unlink()
        print(f"No paint.json in {course_dir}: no paint layer")
        return None
    try:
        paint = json.loads(src.read_text(encoding="utf-8"))
        rel = src.resolve().relative_to(REPO_ROOT).as_posix() if src.resolve().is_relative_to(REPO_ROOT) else str(src)
        doc = paint_layer(paint, course_dir.resolve().name, rel)
    except (ValueError, PaintError) as e:
        raise SystemExit(f"error: {src}: {e}")
    out = out or (Path(out_dir) if out_dir else course_dir / "shaping") / OUT_FILE
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(_layer_json(doc), encoding="utf-8", newline="\n")
    kinds = {}
    for op in doc["ops"]:
        kinds[op["rule"]["kind"]] = kinds.get(op["rule"]["kind"], 0) + 1
    print(f"Wrote {out}")
    print(f"  {len(doc['ops'])} golfmap.paint op(s): " + ", ".join(f"{k} {v}" for k, v in kinds.items()))
    return out


def add_parser(sub) -> None:
    """The `shaping-paint` subcommand on gspro.py's subparsers."""
    p = sub.add_parser("shaping-paint", help="write a course's generated Blender paint layer 90-paint.gen.json "
                       "(golfmap.paint ops) from its paint.json; blender/tools/shape_paintop.py")
    p.add_argument("--course-dir", dest="course_dir", required=True, help="the course's docs folder (docs/gspro/<course>)")
    p.add_argument("--out-dir", dest="out_dir", help="the layer folder (default <course-dir>/shaping)")
    p.add_argument("--out", help=f"the layer's path (default <out-dir>/{OUT_FILE})")


def run(args) -> int:
    cmd_shaping_paint(Path(args.course_dir), Path(args.out_dir) if args.out_dir else None,
                      Path(args.out) if args.out else None)
    return 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    add_parser(parser.add_subparsers(dest="command", required=True))
    raise SystemExit(run(parser.parse_args()))
