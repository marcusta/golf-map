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
- FBX whose mesh object no longer exists in the `.blend` are deleted (**Delete FBX of removed meshes**, on by
  default, applies to all three buttons). OPCD renumbers and merges meshes when it regenerates the `.blend`, so
  the folder would otherwise keep old meshes that Unity still treats as current.
- Meshes whose name starts with a **Skip** prefix are never exported (default `Gap_Issue`: OPCD's gap-check
  markers), and their FBX already in the folder are deleted like removed meshes. Comma-separated; kept in the
  add-on preferences. Headless: `--exclude`.
- The folder is remembered in the add-on preferences, because a regenerated `.blend` loses both the panel's
  and OPCD's folder setting.
- **Then in Unity:** `GolfMap > Meshes > Sync from FBX folder` (see
  [unity/README.md](../unity/README.md#course-meshes-fbx-sync)).

Headless (never saves the `.blend`):

```bash
"C:/Program Files/Blender Foundation/Blender 4.5/blender.exe" -b course.blend --python blender/tools/fbx_sync.py -- --dry-run
```

Flags: `--folder`, `--baseline` (mark as exported), `--all`, `--keep-orphans`, `--json out.json`.
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

## Course props (buildings, shelters, flags, cars ...)

`tools/build_props.py` + `tools/props_kit.py` build every prop of a course area from a spec, headless, in about 15 s:

```bash
python docs/gspro/vreta/clubhouse-props.gen.py        # measurements -> docs/gspro/vreta/clubhouse-props.json
"C:/Program Files/Blender Foundation/Blender 4.5/blender.exe" -b --factory-startup --python blender/tools/build_props.py -- --spec docs/gspro/vreta/clubhouse-props.json --out "<Unity project>/Assets/GolfMap/Vreta/Props"
```

- **Spec** (`golfmap-props-spec-v1`): `assets` (parametric parts: `building` with gable/mono roofs, openings,
  cladding, gutters, solar arrays; `veranda`, `steps`, `shelter`, `gazebo`, `drape` (paving laid on the DEM),
  `car2`, `flagpole`, `hedge`, `rock`, `boulder` (a round field stone, moss or ivy on top; with `exponent`, `flats` and `lumps` a wall stone: a block with rounded edges, a flat face and beds), `net_poles` ...) and `instances` (EPSG:3006 `e`/`n`, `yawDeg` = compass
  bearing of the asset's local +x, `ground` max/min/centre/median, `dz`, optional `scale`). An asset with
  `prefab` instead of `parts` is a Unity prefab already in the course project (e.g. a vegetation pack's hedge).
- The Vreta generator documents where every number comes from: lidar roof fits (positions, footprints, eave and
  ridge heights), the 2025 ortho (buildings newer than the lidar, flags, parked cars in `clubhouse-cars.json`) and
  the 2026-09-26 reference photos (looks). The ortho shows shadows as dark patches: check against a photo before
  drawing paving.
- **Out:** `Models/<id>.fbx` (one mesh per asset, material names only), `Textures/` (generated albedo, normal
  and Standard metallic/occlusion/smoothness masks, sized in metres; only the materials the assets use), `props.json`
  (`golfmap-props-v1`). The stone walls' boulders are such a build too: `docs/gspro/vreta/wall-stones.json` (from
  `stone-walls.gen.py`) into `<course>/Walls/Stones`, used by `golfmap.walls.build` (unity/README.md "Stone walls").
  `--preview` renders each asset, `--layout --ortho <png> --ortho-bounds x0,y0,x1,y1` renders the whole area over
  an ortho, `--only a,b` rebuilds just those.
- **Photo textures:** a material spec `photo:<path>` / `photoblocks:<path>:<courses>:<blocks>:<colours>` takes
  a texture pack's photo under the Unity project's `Assets/` (found from `--out`, else `$GOLFMAP_UNITY_PROJECT`)
  and keeps only its relief; the colours come from the spec (`photoblocks` recolours each block from a palette).
  Nothing from the pack is copied into the repo. Built outside a Unity project, those materials are skipped and
  only an asset that uses one fails (the 18th's footbridge: `splitface_block`, `concrete_weathered`).
- **Printed faces (signs):** the spec's `materials: {name: {image, smoothness}}` adds materials whose albedo is a
  finished picture (`image` relative to the spec), copied into `Textures/` as is. The `tee_sign` part (post, arm,
  curved brace, a board of any `outline` hung under the arm) maps its `face` material once over the board, UV
  0..1, readable from both sides. Vreta's 18 hole boards: `docs/gspro/vreta/hole-signs.gen.py` (par/index from the
  app, tee lengths from the club's card, hole view from the 2025 ortho, sign + bench spot by the yellow tee) writes
  the pictures to `data/props/<site>/hole-signs/` and `hole-signs.json`; run it before `clubhouse-props.gen.py`.
- **Then in Unity:** `golfmap.props.place` (GolfMap > Props), see [unity/README.md](../unity/README.md#course-props).
