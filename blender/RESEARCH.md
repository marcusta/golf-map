# blender — research notes (bunkers)

Findings from the 2026-09 session "Blender bunker manipulation and OPCD extension setup". Code was
read, not run in Blender, unless stated. Read this before building the lip tool (README "Planned").

## Installed add-ons (Blender 4.5)

All in `%APPDATA%\Blender Foundation\Blender\4.5\extensions\user_default\`, all GPL-3.0-or-later
(reusing code with attribution is allowed; a golf-map Blender add-on would be GPL anyway).

| Add-on | Folder | What matters |
|---|---|---|
| OPCD Mesh Editing Tools 3.5.8 | `opcd_blender_tools` | The OPCD pipeline (import, conform, export). Bunker ops in `operators/bunker.py`; community **Afrod Mod v4** panel + JSON recipe runner in `operators/afrod/afrod_operators.py`. Installed by the OPCD installer script (Google Drive zip; also pulls Edit Mesh Tools + LoopTools). Also in Blender 5.2. |
| Bunker Studio 0.11.5 (jannesep, janneseppanen.com/course-tools) | `bunker_studio` | Metric bunker shaper. Pure-Python math in `core.py`; UI in `__init__.py`. |
| Shoreline Studio 0.5.5 (same author) | `shoreline_studio` | Lakes/creeks only (`water_base_lake`/`water_base_creek`). **No bunker tools.** |

## Comparison

| | OPCD + Afrod | Bunker Studio |
|---|---|---|
| Profile units | Edge-ring counts (`scaleX = 10/num_face_loops`): same settings, different shape on dense vs sparse meshes | Metres from the sand edge; per-side face widths, crown, flatten |
| Around the rim | Uniform | High side + entry (auto or captured) |
| Blends / 3DG grass | Untouched | Writes 3DG grass density into blend UV0 |
| Paint | Fixed ring bands (Clean/Wet/Pot) | Continuous dirt/sand mask |
| Safety | Destructive (applies `Project` modifier), undo or manual `_-_bak` only; "Selected" mode digs any `Spline…` mesh incl. greens; unseeded random lip; dig steepness 0 divides by zero | Preview copy, validate (seam gap ≤ 1e-4 m, normals, flips, counts), all-or-nothing apply, restore |
| Freedom | Any ring, any amount | Panel shows only preset + Depth/Edge Variation/Edge Dirt; advanced params hidden, presets reset them; Overhang/Undercut/Detached Sod defined but unused |

Verdict: use OPCD for import/conform/export, Bunker Studio (or our tool) to shape in between.
Bunker Studio **cannot** make ce.simgolf's lip: one smooth profile per rim position, ~12 cm edge
resampling (his ledges are 1–4 cm), no overhang.

## ce.simgolf's method

Sources: his *GSPro Bunker Masterclass* (YouTube `E7tSnj-oBsA`, auto-captions; re-fetch with yt-dlp)
and his Afrod JSON recipe (pasted by Marcus; not in the repo).

- **Recipe mechanics:** `meshblendjoin` merges bunker + blend so rings count in from the blend's outer
  edge; `loopcut`/`spaceloops`/`bunkereditlip`/`randomslideloop`/`widenbunkerinterior` build a stack of
  1–3 cm terraces across the seam; paint; `meshblendseparate`. Fragile because ring indices shift after
  each `loopcut` and random steps are unseeded.
- **Order of work:** finish terrain (conform, flatten tees/pads) → recipe one hole at a time → fix
  perimeters by hand (satellite material in top view, proportional editing) → vary lip height by hand
  (start low; outside-in raises rough/blend, inside-out raises bunker rings; pull back in top view; one
  facing stretch at a time; tall on the green/steep side, low at entries; exaggerate) → normal data
  transfer across every seam → materials + 3DG in Unity. Re-conforming undoes everything after step 2.
- **Paint** (encoded as `ce-simgolf` in `conventions/bunker-channels.json`): bunker red = lip with short
  3DG, green = sand, blue = wet floor (optional), black = lip without 3DG, darkened to fake a rolled-lip
  shadow. Blend colours unverified (narration and recipe disagree).
- **Why Unity scripts matter:** OPCD's default bunker material (`OPCD 4 color Vert Paint MAHS`) maps
  red/green → dirt (array index 4), blue/black → sand (index 6). His green sand renders as dirt there;
  `GolfMap > Bunker Materials` builds matching materials.

## Plan: lip tool (Afrod technique, Bunker Studio workflow)

Lip stack as data in metres from the seam (negative = into the blend): height step, jitter, colour per
layer; ce.simgolf's recipe is the first preset. Cut rings by offsetting the seam outline, not loopcut by
index. Scale layers by high-side/entry weights. Seed per bunker. Preview → validate → apply → restore
over a selection. Afrod JSON recipes run on the preview copy as a legacy mode. Auto normal transfer,
one-click satellite material, paint from the conventions file. Build order: legacy runner with
preview/restore → metric core as pure Python with tests → rim variation/presets → verify on Vreta.

## Vreta findings (2026-09-23)

- 36 bunkers in the `.blend`, 35 in the Unity scene: `Spline_hole_8_52_Bunker_-_Mesh` was never placed
  (FBX exists in `Assets/fbx/`); its blend is there.
- `Spline_others_40_Bunker_-_Mesh` is a ~1.5 × 6 cm sliver; its six split blends border nothing. Redraw
  or remove in the course drawing.
- Fairway-side blends (`hole_8_45/47/52/55`, `_B_Fairway_`) fade to **rough** material in OPCD's output.
  Possible fix: read `_B_Fairway_` and fade to fairway.
- Bunker Materials round trip with `opcd-default`: 75 meshes applied, 1 failed (the missing 8_52).
