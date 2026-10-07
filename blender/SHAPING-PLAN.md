# Course mesh shaping in Blender - plan

Status: agreed 2026-09-28, being implemented. Replaces the DEM-edit round trip for everything the course
meshes cover, and the Unity-side mesh reshaping.

## Why

Terrain work used to go DEM edit → Unity terrain → Terrain.obj export → Blender conform → FBX → Unity: slow,
and the meshes only saw it at the conform's 1-2 m. Blender has the better mesh tools, and the community
tools (OPCD, Afrod Mod v4 recipes, Bunker Studio) already do bunker lips, lake and creek banks, cart-path
cutting/smoothing and tee flattening - including edits that ripple across neighbouring meshes (a vertex of
any `Spline*` mesh moves by a function of its XY distance only, so shared seam vertices stay welded).
We drive those tools from data kept outside the `.blend`, so every regenerated `.blend` gets the same work
replayed in seconds to minutes.

## The loop

1. **New `.blend`** (Marcus: "we have a new Blend file"; built by OPCD from a golf-map SVG).
2. **Prepare** (`blender/tools/shape_prepare.py`, headless, slow once): import the course's `terrain.obj`
   and conform every `Spline*` mesh with OPCD's own operators. Result cached as a derived file
   `<name>.conformed.blend` next to the source; the source `.blend` is never saved.
3. **Apply** (`blender/tools/shape_apply.py`, headless, fast): open the conformed cache, replay the shaping
   layers in order, write `shaping-report.json`, export changed FBX (fbx_sync logic) to the export folder
   (a staging folder until the loop is trusted).
4. **Read the report**: meshes no layer covers, targets not found, outlines that changed under hand edits,
   validation failures. Fix layers, re-run 3.
5. **Refresh Unity** (`golfmap.course.refresh`, bridge): mesh sync (prune) + OPCD default materials +
   Bunker Materials convention + vertex paint + terrain match (both ways, just under the meshes) + water
   planes + creek splines refit + stone walls + surfaces/zones + props re-placed (hand-moved ones kept).
6. **Review**: `GolfMap > Review` lists the changed places (from the report) with Go / Next / Prev framing
   the Scene view; plus a before/after screenshot page. Marcus inspects, we iterate.

## Shaping layers

Data, not scripts: one engine replays JSON layers. Course layers live in the repo next to the course's
other specs: `docs/gspro/<course>/shaping/NN-<id>.json`, applied in file-name order.

- `00-global.gen.json` - **generated** by golf-map (`gspro.py shaping-global`) from the course's features
  and terrain edits: tees flattened, paths/roads cut + smoothed, merged roads of mixed surfaces split into one
  object per surface (`golfmap.split_surfaces`), building pads and parking levelled.
  A path drawn tomorrow is picked up by the next generation without editing anything.
- `10-hole-<n>.json` - per-hole work, written with Marcus: bunker recipes, creeks, ponds, overrides.
- `90-water.json` - water planes (after all digs).
- `hand/` - snapshots of meshes sculpted by hand in Blender (later).

Recipes (Afrod JSON) are referenced by path. Third-party recipes stay in a local folder
(`GOLFMAP_AFROD_RECIPES`, default `D:/gspro/afrod-recipes`); our own adapted ones go in `blender/recipes/`.

### Layer format (`golfmap-shaping-layer-v1`)

```json
{
  "format": "golfmap-shaping-layer-v1",
  "id": "global",
  "generated": true,
  "ops": [
    { "id": "tees", "op": "afrod.flattentees", "select": { "type": "tee" },
      "params": { "tees_flat_inset": 1, "tees_flat_outset": 3.0 } },
    { "id": "paths-cut", "op": "afrod.cutcartpaths", "select": { "feature": ["<concrete path id>"] } },   // concrete paths only (slabs)
    { "id": "paths-smooth", "op": "afrod.smoothcartpaths", "select": { "type": "path" },
      "params": { "smooth_path_distance": 3.0, "smooth_path_amt": 20 } },
    { "id": "pad-3fa9", "op": "golfmap.flatten_footprint",
      "footprint3006": [[530100.5, 6487700.2], [530112.0, 6487701.0], [530111.2, 6487690.4]],
      "level": "median", "falloffM": 3.0 },
    { "id": "bunker-1c", "op": "afrod.recipe", "select": { "feature": "<feature uuid>" },
      "recipe": "cesimgolf-Conway_Bunker_Standard.json", "seed": 28 }
  ]
}
```

- `select`: `feature` (golf-map feature id, or a list), `type` (golf-map type), `hole`, `kind`
  (`mesh`/`blend`, default mesh). Resolved **by feature id**: the SVG that built the `.blend` maps its path
  ids to `data-feature-id`, OPCD stamps each object with `opcd_shape_id`/`opcd_parent_id`/`opcd_kind`.
  So layers do not depend on the naming scheme (old index names or the new `hole_<n>_<feature_no hex>`).
  The engine finds the SVG by matching its path ids to the `.blend`'s shape ids.
- `seed`: default the feature's number; every random call is seeded per op, so a replay is identical.
- World positions (`...3006`) are EPSG:3006; the engine maps them into the `.blend` from the inner DEM
  sidecar (`<prefix>-inner-dem-<side>m.tif.json`).
- Ops wrap Afrod/OPCD operators (`afrod.*`, `opcd.*`, `afrod.recipe` = the JSON recipe runner) plus a few of
  ours in the same style where no tool exists (`golfmap.flatten_footprint` for pads/parking).

### Coordinates

The `.blend` (meshes and the imported `terrain.obj`) is the course turned 180° about the SW corner of the
inner DEM square (`square3006` = [e0, n0, e1, n1] in the sidecar; Unity terrain position (px, py, pz), zero
on Vreta): `x = -(E - e0 + px)`, `y = -(N - n0 + pz)`, `z = H - minM + py`. So the square spans x, y in
[-side, 0]. Code: `blender/tools/shape_coords.py` (`to_blend` / `from_blend`, reads the sidecar). Checked
on Vreta (`vreta_svg_1985.blend`): 279 mesh outlines vs their `vreta.svg` paths (SVG x = E - e0,
y = n1 - N), bounds centres agree to 0.01 m (meshes sit ~0.1 m inside the outline); the imported Terrain vs the
inner DEM `.raw` at 400 random points: median 0.00 m, p95 0.07 m (x mirrored instead: 24 m).

### Order inside a run

conform (cached) → global area edits (tees, paths, pads) → per-feature edge recipes (bunkers, lakes,
creeks, path edges) → water planes. Area smoothing ripples into neighbours, bunker blends included, so
lips come after.

## Report (`shaping-report.json`)

Per op: status, targets resolved (mesh names), vertices moved, max |dz|, time. Course-wide: `Spline*`
meshes of a shaped type no op touched (new features: defaults applied or flagged), selectors that resolved
to nothing, and checks: seam gaps between neighbouring meshes, flipped normals, meshes below the terrain,
slivers. Also the list of changed places (object, hole, centre, bounds) that Unity's Review window reads.

## Unity side

- `golfmap.terrain.conform` gains `mode=match` (raise AND lower the terrain to `margin` under the meshes).
- `golfmap.course.refresh` chains the existing commands with a report; `dryRun` plans only.
- `GolfMap > Review` window reads the shaping report (and the refresh report): list, Go/Next/Prev.

## golf-map side

- Merged roads get stable names (`roads_<lowest feature number in hex>`), like every other shape; the SVG has one
  road shape per connected network, of every surface (OPCD needs the junction fillets dissolved inside one
  shape; a per-surface split in the SVG was tried 2026-10-04/05 and dropped). `data-surface` is only on grass
  tracks (written as rough); the surfaces come from the sidecar `<stem>-paths.json` (`shapes`: dominant surface,
  `regions`: every piece's surface and outline), and `golfmap.split_surfaces` (built 2026-10-05, README "Shaping:
  surfaces of a merged road") cuts a mixed shape's meshes along the seams (the higher surface's own kerb
  lines; a kerb fillet widens the road it lies along most, ties to the higher; slits the merge filled split on
  their medial line), separates one object per surface (`Spline_roads_124_<surface>_<rest>`, opcd ids
  `roads_124_<surface>[_<n>]`) and paints a 0.5 m red -> black fade on the lower surface's side, so Unity can
  give each its own material (Unity side: read the surface token from the name; not done here).
- `gspro.py shaping-global` writes `00-global.gen.json` from the course DB.
- Later: DEM edits under meshes are dropped from the heightmap export (the terrain only carries edits
  outside the meshes); the base `terrain.obj` could be written from our 0.5 m DEM instead of Unity's export.

## Terrain editor → Blender (fast per-feature loop)

Decided 2026-09-28: the web Terrain editor is where all of this is edited. Its concepts stay (generators
that replace only their own edits, hand-drawn edits, per-site list, enable/disable, history); where an edit
lands changes: under the course meshes → Blender → Unity; outside them → DEM → `terrain.update` as before.

| Terrain editor | Shaping op |
|---|---|
| Dig bunkers / ponds / creeks | `afrod.recipe` per feature: the course default recipe for its type, overridable per feature |
| Grade roads | `afrod.cutcartpaths` + `afrod.smoothcartpaths` (+ path edge recipes) |
| Building pads, hand-drawn pads, parking | `golfmap.flatten_footprint` |
| (new) Flatten tees | `afrod.flattentees` |

**Store**: the site's `terrain_edits` table stays the one source. A recipe is an edit with `op: "recipe"`,
`params: {recipe: <library id>, overrides?: {...}}`, `origin: "feature"`, `origin_ref: "feature:<feature id>"`
(course-scoped like digs). `gspro.py shaping-global` generates `00-global.gen.json` (area ops) and
`10-features.gen.json` (per-feature recipes, incl. type defaults) from the DB; hand layers (`20-*.json`) stay.

**Recipe library**: `blender/recipes/library.json` indexes recipe files (third-party files stay untouched in
`GOLFMAP_AFROD_RECIPES`, ours in `blender/recipes/`): `{id, name, file, author, surfaces:[bunker|lake|creek|path],
paint: {mesh: {red|green|blue|black: role}, blend: {...}}, default?: bool}`. After a recipe runs, the engine
remaps the touched meshes' paint to the canonical `golfmap` roles (paint is channel weights, so exact):

| Channel | Bunker / water mesh | Blend strip |
|---|---|---|
| red | grass lip (adjoining grass look; 3D grass grows) | the adjoining surface |
| green | dirt / bank soil face | longer, darker grass |
| black | dark lip without 3D grass (shadow line) / dark wet edge | the adjoining surface (Unity renders it as `$outer`; was browning grass / dirt toward the hazard, dropped 2026-09-29 for grass right to the sand) |
| blue | sand / water bed | - |

No wet-sand channel (texture variation in the sand material instead). `bunker-channels.json` gets the
`golfmap` convention; Unity's Bunker Materials builds one material set per course from it.

**Shaping worker** (`blender/tools/shape_worker.py`): a long-running headless Blender on
`127.0.0.1:8766` (env `GOLFMAP_SHAPING_PORT`), JSON over HTTP:
- `GET /status` → `{state: starting|ready|busy|error, blend, conformed, layersDir, appliedOps, lastRun}`
- `POST /load {blend?, layersDir?, fbxFolder?}` → load the conformed cache (preparing it first when missing or
  stale), apply every layer, snapshot each object after the global (area) layers.
- `POST /sync {dryRun?}` → re-read the layer files, diff ops against the applied ones by `id` + content, restore
  the affected objects from the snapshots and re-run what touches them (area-op changes re-run area ops on
  their targets and everything after them there), seam-check, export the changed objects' FBX into
  `fbxFolder` (fbx_sync manifest kept) → `{changedObjects:[names], exported:[fbx], removed:[fbx], seconds,
  report:{warnings, seams, changedPlaces}}`.
One op-result cache (keyed by op content + the fingerprint of the input objects) makes cold starts fast.

**Server**: `GET /api/shaping/recipes?surface=` (the library); recipe edits through the existing terrain edits
API; `POST /api/courses/:courseId/shaping/apply` → job: regenerate layers (`gspro.py shaping-global`) → worker
`/sync` → Unity bridge `golfmap.course.refresh only=<changedObjects>` → `{changedObjects, unityReport, places}`;
`GET /api/courses/:courseId/shaping/status` (worker + last job). The server starts the worker on demand.

**Unity**: `golfmap.course.refresh only=<comma-separated object names>` re-imports just those FBX, swaps the
objects, applies the course's bunker convention to the touched sets, vertex paint + terrain match only
inside their bounds; `golfmap.review.goto` also takes `object=`.

## Composite and parameterised recipes (decided 2026-09-29)

A recipe is a list of steps from any toolset: `bunkerstudio.shape {preset, depth, edgeVariation, edgeDirt,
highSide?}`, `shorelinestudio.shape {preset, ...}`, any Afrod step (an Afrod JSON file is a recipe of Afrod
steps only), `golfmap.*`. Studio steps come first (they need OPCD's untouched one-quad blend ring). Paint
from every step is remapped to the canonical roles (per-step paint maps in the library).

Library entries declare their knobs:

```json
"params": [
  { "id": "depth", "label": "Depth", "unit": "m", "min": 0.2, "max": 1.2, "step": 0.05, "default": 0.45,
    "maps": [{ "step": "bunkerstudio.shape", "field": "depth", "mode": "set" }] },
  { "id": "lipHeight", "label": "Lip height", "unit": "×", "min": 0.5, "max": 2, "step": 0.1, "default": 1,
    "maps": [{ "step": "bunkereditlip", "field": "bunker_lip_depth", "mode": "scale" }] }
]
```

`maps`: `set` a field, `scale` it (every matching step, or one step by `tag`). Shared vocabulary (a recipe
shows only what it supports): `depth`, `faceSteepness`, `highSideBearing`/`highSideStrength`, `lipHeight`,
`lipRaggedness`, `edgeDirt`, `grassLipWidth`, plus the seed. The recipe edit's `overrides` is
`{"<param id>": value, ..., "seed": <int>}`; missing = the param's default; the seed defaults to the
feature number. Material look (shadow darkness, sand colour) is the course's convention, not a param.

Blender side implemented 2026-09-29 (README "Composite and parameterised recipes", "The cut's paint"): golfmap
recipes with studio steps driven through the studios' own operators, per-step paint maps, library params, per-unit
`changedPlaces`, and Afrod's blue cut paint restored (or kept as crisp concrete joints) per path surface.

Review: the report's `changedPlaces` become places per op/feature (a tee, a path, a pad, a recipe'd bunker)
with max |dz|, sub-centimetre ripple moves left out.

## Phases

1. Plan (this file). Prepare + apply engine + report; spike on Vreta (`vreta_svg_1985.blend`): one tee, one
   path stretch, one bunker (Conway recipe); headless, run twice, identical output. Unity: terrain match,
   refresh (dry run), Review window. golf-map: stable road names, `shaping-global`.
2. Full Vreta global layer; per-hole bunkers/creeks/ponds with Marcus; first full refresh into Unity.
3. Retire the DEM edits under meshes and the Unity mesh reshaping (`GolfMapWallGround`) where Blender does it.

## Open questions

- OPCD's split pieces (`_pieceK_`, `_hole0_`) and blend numbering across regenerations: resolved through
  `opcd_parent_id`, to be checked on the next regeneration.
- Afrod operators are unseeded and UI-driven (scene props, Edit Mode, selections): the engine sets
  `scene.opcdtools` props, seeds `random`, and drives selection itself. Afrod's `normalsdatatransfer` uses
  `use_auto_smooth` (gone in 4.1+); use OPCD's version.
- Recipe parameters are ring counts, not metres: tune per course; per-feature overrides.
