# blender

Blender tooling for the OPCD/GSPro course stage, starting with bunkers.

## Bunker paint conventions

`conventions/bunker-channels.json` describes each way of vertex-painting bunkers and their
blend meshes:

- **Paint:** for a bunker, the colour of each ring counted in from its seam (`rings`) and the
  colours further in (`interior`). For a blend, the colour on the edge it shares with the
  bunker (`inner`) and on its outer edge (`outer`).
- **Materials:** for each paint channel, which material (`$bunker`, `$blend`, `$outer` or a
  material name) and which of its channels fills it in Unity, with an optional `tint` (a
  value below 1 darkens it, e.g. the fake rolled-lip shadow on black) and `blendStrength`.

Two conventions ship:

| id | Bunker paint | Blend paint | Notes |
|---|---|---|---|
| `opcd-default` | red rim, green, then blue floor | red at the bunker, black at the rough | What OPCD conform and Adjust Bunker Vertex Painting produce. |
| `ce-simgolf` | red, red, black rings, then green sand (blue wet floor optional) | red rough outside, blue browning grass at the bunker | ce.simgolf's setup: black is the lip without 3D grass, darken it to fake a rolled-lip shadow. Blend side not yet verified. |

The Unity window `GolfMap > Bunker Materials` builds materials from this file and checks
the paint (see `unity/README.md`).

## Paint report

```bash
"C:/Program Files/Blender Foundation/Blender 4.5/blender.exe" -b "D:/gspro_courses/vreta-opcd/vreta_svg_1602.blend" --python blender/tools/bunker_paint_report.py -- --convention ce-simgolf
```

This prints, for each bunker, the colour share of each ring and of the interior, and for
each blend its inner and outer edge, plus the best-matching convention. Results are
`ok` / `!!` against the convention you pass with `--convention`, and `--json out.json`
also writes the results as JSON. It never saves the `.blend`.

## FBX sync

OPCD's Batch Export rewrites every course FBX (~800 on Vreta), so Unity reimports all of them. `tools/fbx_sync.py`
exports only the visible meshes that changed since the last export. It uses the same file names and exporter call
as OPCD, and the same folder: the OPCD tools' export folder, else `<blend folder>/fbx`.

- **Install:** Edit > Preferences > Add-ons > Install from Disk > `blender/tools/fbx_sync.py`. The panel is in the
  3D View sidebar, **GolfMap** tab.
- **First time:** if the folder already matches the `.blend` (e.g. right after an OPCD Batch Export), click
  **Mark all as exported**. Otherwise click **Export all FBX** once.
- **After that:** **Export changed FBX** (or **Preview** for a dry run). An object is exported when its evaluated
  mesh (positions, faces, UVs, colours, other attributes), world matrix or material slots changed, or when its
  FBX is missing. Fingerprints are kept in `<folder>/.golfmap-fbx-sync.json` (Unity skips dot files).
  Fingerprinting all ~800 meshes takes about 5 s.
- FBX whose mesh object no longer exists in the `.blend` are listed. They are deleted only with **Delete FBX of
  removed meshes** ticked.
- **Then in Unity:** `GolfMap > Meshes > Sync from FBX folder` (see
  [unity/README.md](../unity/README.md#course-meshes-fbx-sync)).

Headless (never saves the `.blend`):

```bash
"C:/Program Files/Blender Foundation/Blender 4.5/blender.exe" -b course.blend --python blender/tools/fbx_sync.py -- --dry-run
```

Flags: `--folder`, `--baseline` (mark as exported), `--all`, `--delete-orphans`, `--json out.json`.
`tools/fbx_sync_test.py` checks it on a course file in a temp folder (`-- --compare <OPCD fbx folder>` also
compares file sizes with OPCD's export).

## Planned

A bunker lip tool on top of the Afrod operators, with Bunker Studio's preview, validate
and restore workflow:
- metric lip stacks (ce.simgolf's recipe expressed in metres from the seam rather than as
  ring indices)
- lip height that varies around the rim, raised inside-out or outside-in, with an automatic
  pull-back so faces don't stretch the texture
- automatic normal transfer across seams
- a one-click satellite reference material for fixing perimeters
- painting driven by the shared conventions file
