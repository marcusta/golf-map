"""The stone walls' ground as a Blender shaping layer: `docs/gspro/<course>/stone-walls.json` ->
`docs/gspro/<course>/shaping/80-walls.gen.json` (`golfmap-shaping-layer-v1`, generated).

One `golfmap.wall_ground` op per wall with `ground` (blender/tools/shape_wallground.py), its id the wall's id. The
wall's settings are merged as Unity's GolfMapWalls reads them: Unity's built-in defaults, then the spec's `defaults`,
then the preset `styles[<style>]` (style: the wall's own, else the defaults'), then the wall itself; a preset named
for its look (`teewall`) says which builder it is in its own `style`. Only the ground settings go into the op, all of
them written out (the op does not depend on the defaults below changing): `profile` cliff for a cliff, else terrace;
`stoneFace` = the wall has a `stoneAlbedo` (its stone turns green on steep faces). Coordinates stay EPSG:3006.

A course without stone-walls.json gets no layer (a stale generated one is removed). Run by
`gspro.py shaping-walls --course-dir docs/gspro/<course> [--out-dir <folder>]`.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

WALLS_FORMAT = "golfmap-walls-v1"
LAYER_FORMAT = "golfmap-shaping-layer-v1"
LAYER_ID = "walls"
LAYER_FILE = "80-walls.gen.json"
SPEC_FILE = "stone-walls.json"
OP = "golfmap.wall_ground"
GENERATOR = "pipeline/gspro.py shaping-walls"
STYLES = ("rose", "wall", "cliff")

# Unity's GolfMapWalls.Settings defaults for what the ground reads (the rest of the settings place stones)
UNITY_DEFAULTS = {
    "style": "rose", "ground": False, "faceDeg": 60.0, "baseInM": 0.2, "beyondM": 0.5, "taperM": 1.5,
    "subdivideM": 0.35, "paintFeatherM": 0.25, "groundChannel": "blue", "minFaceM": 0.35, "jitterDeg": 0.0,
    "paintOnly": False, "paintInsetM": 0.0, "roundTopM": 0.0, "stoneAlbedo": "",
}
NUMBERS = ("faceDeg", "baseInM", "beyondM", "taperM", "subdivideM", "paintFeatherM", "minFaceM", "jitterDeg",
           "paintInsetM", "roundTopM")


class WallsError(ValueError):
    pass


def _over(base: dict, layer: dict | None) -> dict:
    """Settings.Over: every key the layer sets replaces the base's (only the keys the ground reads are kept)."""
    out = dict(base)
    for k in UNITY_DEFAULTS:
        if layer and k in layer and layer[k] is not None:
            out[k] = layer[k]
    return out


def _pairs(v, what: str, wall: str) -> list:
    if not isinstance(v, list) or not all(isinstance(p, list) and len(p) >= 2 for p in v):
        raise WallsError(f"wall {wall}: {what} must be a list of [E, N] pairs")
    return [[float(p[0]), float(p[1])] for p in v]


def _ground(s: dict, wall: str) -> dict:
    for k in NUMBERS:
        if not isinstance(s[k], (int, float)) or isinstance(s[k], bool):
            raise WallsError(f"wall {wall}: {k} must be a number")
    channel = str(s["groundChannel"]).lower()
    if channel not in ("red", "green", "blue", "black"):
        raise WallsError(f"wall {wall}: groundChannel must be red, green, blue or black")
    g = {"profile": "cliff" if s["style"] == "cliff" else "terrace"}
    g.update({k: float(s[k]) for k in NUMBERS})
    g.update(groundChannel=channel, paintOnly=bool(s["paintOnly"]), stoneFace=bool(s["stoneAlbedo"]))
    return g


def wall_ops(spec: dict, source: str = SPEC_FILE) -> list[dict]:
    """The `golfmap.wall_ground` ops of a golfmap-walls-v1 spec, in the spec's wall order."""
    if spec.get("format") != WALLS_FORMAT:
        raise WallsError(f"{source} is not {WALLS_FORMAT}")
    defaults = _over(UNITY_DEFAULTS, spec.get("defaults"))
    styles = spec.get("styles")
    ops, seen = [], set()
    for w in spec.get("walls") or []:
        wid = w.get("id")
        if not wid:
            raise WallsError(f"{source}: a wall has no id")
        if wid in seen:
            raise WallsError(f"{source}: wall id {wid} repeats")
        seen.add(wid)
        style = w.get("style") or defaults["style"]
        preset = styles.get(style) if isinstance(styles, dict) else None
        if isinstance(styles, dict) and preset is None:
            raise WallsError(f"{source}: wall {wid} has style '{style}', which `styles` does not define")
        s = _over(_over(defaults, preset), w)
        s["style"] = (preset or {}).get("style") or style
        if s["style"] not in STYLES:
            raise WallsError(f"{source}: wall {wid}: style must be rose, wall or cliff")
        toe, lip = _pairs(w.get("toe"), "toe", wid), _pairs(w.get("lip"), "lip", wid)
        if len(toe) != len(lip) or len(toe) < 2:
            raise WallsError(f"{source}: wall {wid} needs toe and lip with the same number (>= 2) of stations")
        if not s["ground"]:
            continue
        op = {"id": wid, "op": OP, "wall": wid, "seed": int(w.get("seed", 1))}
        if w.get("note"):
            op["note"] = w["note"]
        op["toe3006"], op["lip3006"] = toe, lip
        if w.get("outline") is not None:
            op["outline3006"] = _pairs(w["outline"], "outline", wid)
        patches = []
        for p in w.get("grassPatches") or []:
            rx = float(p[2])
            rz = float(p[3]) if len(p) > 3 else rx
            if rx <= 0 or rz <= 0:
                raise WallsError(f"wall {wid}: grass patch radii must be positive")
            patches.append([float(p[0]), float(p[1]), rx, rz])
        if patches:
            op["grassPatches3006"] = patches
        op["ground"] = _ground(s, wid)
        ops.append(op)
    return ops


def shaping_walls(course_dir: Path) -> dict | None:
    """The generated walls layer of a course folder (docs/gspro/<course>), None when it has no stone-walls.json."""
    path = Path(course_dir) / SPEC_FILE
    if not path.exists():
        return None
    spec = json.loads(path.read_text(encoding="utf-8"))
    rel = path.as_posix()
    for marker in ("docs/gspro/",):
        if marker in rel:
            rel = rel[rel.index(marker):]
    return {
        "format": LAYER_FORMAT, "id": LAYER_ID, "generated": True, "generator": GENERATOR, "source": rel,
        "note": "The ground under the stone walls (Unity's GolfMapWallGround, now shaped in Blender): one op per wall "
                "with ground, settings merged defaults -> style -> wall. Generated: edit stone-walls.json.",
        "ops": wall_ops(spec, rel),
    }


def layer_json(doc: dict) -> str:
    """Indented JSON with each [x, y] pair on one line (as gspro.py's shaping layers)."""
    text = json.dumps(doc, indent=2, ensure_ascii=False)
    return re.sub(r"\[\s+(-?[\d.eE+-]+),\s+(-?[\d.eE+-]+)\s+\]", r"[\1, \2]", text) + "\n"


def write_shaping_walls(course_dir: Path, out_dir: Path | None = None) -> Path | None:
    """Write 80-walls.gen.json into out_dir (default <course_dir>/shaping); without a spec remove a stale one.
    Returns the written path, or None."""
    course_dir = Path(course_dir)
    out = Path(out_dir or course_dir / "shaping") / LAYER_FILE
    doc = shaping_walls(course_dir)
    if doc is None:
        if out.exists():
            out.unlink()
            print(f"Removed {out} (no {SPEC_FILE} in {course_dir})")
        else:
            print(f"No {SPEC_FILE} in {course_dir}: no walls layer")
        return None
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(layer_json(doc), encoding="utf-8", newline="\n")
    styles = {}
    for op in doc["ops"]:
        styles[op["ground"]["profile"]] = styles.get(op["ground"]["profile"], 0) + 1
    print(f"Wrote {out}")
    print(f"  {len(doc['ops'])} wall ground op(s)" + (": " + ", ".join(f"{k} {v}" for k, v in sorted(styles.items())) if styles else "")
          + " - " + ", ".join(op["id"] for op in doc["ops"]))
    return out
