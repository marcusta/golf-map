# Arborist course data from golf-map

Arborist is OPCD's GSPro-native vegetation tool. `pipeline/arborist.py` writes its course file
directly, so trees and bushes can use Arborist's asset bundles instead of prefabs in the course
bundle. Status 2026-10-12: files written by us load and draw in Arborist (placed trees, and bushes
spread by texture masks); **none has been loaded in GSPro yet**.

## Working in Arborist (start here)

What goes where: trees and all lower vegetation except grass (bushes, ferns, bilberry, saplings)
go through Arborist; **grass stays in the course's own VSP**. Placement stays ours: trees stand
where the lidar put them, lower vegetation follows the zone masks.

The course is a hybrid (Marcus, 2026-10-12): use Arborist wherever it has a good model
(NatureManufacture pines, firs and poplars are the same models and look good there; bushes and
ground plants are cheaper there) and fall back on the course's VSP where it does not. Forst's oaks
and birches are far better than anything in Arborist, whose birches are SpeedTree models that
cannot be tinted as needed. Who draws a tree follows from its model (models.json: `arborist:` or
`vsp:`) and the course's **routing**, decided before planting (below, "Routing before planting");
Omberg since 2026-10-20. Vreta still runs the older path: one list, `"vsp"` in
`arborist-species.json` (parts of prefab names); `arborist.py trees` leaves those prefabs' full-model
trees out, Unity draws only them (`golfmap.vsp.trees on=true keep=<the same list>` hides every other
item of the inner tree catalogue; `on=true` without `keep` shows all again) and the far ones are
trimmed out of its storage afterwards. Not yet seen in GSPro: whether the two draw together.

### Routing before planting (a course with `routing` rules)

`bun run arborist -- route <course> [--dry-run]` (`ArboristService.route`, `arborist.py route`) routes
every inner tree by id - the trees export with the tree edits applied first - into
`<export>/<prefix>-inner-routing.json` (golfmap-routing-v1, `golfmap.course` lists it as
`exports['inner-routing']`) and prints `own N, billboard M, left out L`:

- `own`: drawn by its model's renderer - the course's VSP for a `vsp:` model, Arborist's full model
  for an `arborist:` one.
- `billboard`: an Arborist billboard whatever the model (the far rule, `FarRule`: more than
  `outsideOob` outside the GKD's pOOB and more than `fromPlay` from rough/semi/fairway/green/tee/bunker).
  A vsp model's billboard is the Arborist model its models.json entry names as `billboardAs`.
- `out`: left out by the `outerKeep` bands (by position, the same trees every run).

The rules are the course's `docs/gspro/<course>/vegetation-rules.json` `routing`
(`{farBillboard: {outsideOob, fromPlay}, outerKeep: [[maxM|null, share], ...]}`; defaults
`pipeline/vegetation-rules/routing.json`, shown in the Planting rules). A course without `routing` is
refused by name. The trees export (`gspro:export ... trees:inner`, the sync board's Trees) routes again
after writing the trees file, so the planting that follows it uses the new routes.

Unity's planter (`golfmap.trees.plant`) stores in the course's VSP only the vsp models routed `own`;
the placements file still records every tree. `arborist.py trees --routing --rules` draws every other
placement and lists it in `arboristdata.ids.json` (left out with reason outerKeep); it writes no
`vsp-far.json` and asks for no trim. The course's `golfmap.vsp.trees` is `on=true` without `keep`.
**One rule for a routed course**: it is routed when its vegetation-rules.json has `routing`; the routing
file is derived from those rules. The app removes the file of a course without them (the trees export, and
`gspro:export arborist` refuses once until Unity plants again); `arborist.py trees` refuses `--routing`
without `--rules`, `--rules` without `--routing`, and a routing file made with other rules than the course's
now (it records them under `rules`). It also checks the routing against what the course's VSP holds (the
dump): a tree VSP holds stays VSP's even when routed to Arborist since, and both cases are warnings to plant
again.

**Edits re-route.** The Arborist edit loop routes the tree it changed again
(`ArboristService.routeEdited`, `arborist.py route --ids <id> [--from <routing>]`): only that id, the rest
keep the routes Unity's last planting stored (a whole route instead when the routing was already older than
the trees export or edits, made with other rules, or missing). It runs beside the `.dat` save (Omberg: the
whole save 1.3 s) and writes the routing after the edits file. Unity's own edits (`golfmap.trees.edit`, the
Scene view editor) cannot route: the planter then warns that the routing is out of date (older than the
trees export or the edits file) and plants those trees by their old route - route, then plant (the sync
board's Trees does both). `golfmap.trees.edits.applied` returns the trees after Unity's `Apply`;
`unity/tests/tree-edits-parity.test.ts` checks arborist.py's `edited_stems` against it on Omberg.

| | |
|---|---|
| Arborist app | `D:\gspro\Arborist_Launcher\Data\Application` (the launcher only updates and starts it; an update may remove the mod); log in `%USERPROFILE%\AppData\LocalLow\OPCD\Arborist\output_log.txt` |
| The mod | [unity/ArboristMod/README.md](../../unity/ArboristMod/README.md): `bun unity/ArboristMod/call.ts <command> ['{json}'] [timeoutSec]`; `call.ts commands` lists them. Marcus opens the course in Arborist; ask him when no bridge answers. |
| Course folder | `C:\GSProV1\Core\GSP\Courses\<course>` (Vreta: `Vreta_lidar_scene`): `arboristdata.dat`, `arboristversion.dat`, GKD with `IsArborist: true` |
| Per-course choices | `docs/gspro/<course>/arborist-species.json`: species mapping (`species`; `trees` on the older, unrouted path) and looks (`treeSettings`, `plantSettings`; keys in `arborist.py apply_look`); `vegeSettings` = the Arborist system's own settings (`PlantDistance` ...), written by `trees` and `lower` |
| Inputs (git-ignored, `data/arborist/`) | `GolfMap library.biome` (species library), `catalog-sizes.json` (`arb.catalog` with `sizes`), `<course>-planted-trees.json` (Unity `golfmap.trees.dump file=<abs path>`), `lineup-items.txt` (the tree species in calibration order) |
| File key | `data/arborist-wrapper.key` (git-ignored; never into the repo) |

### Who writes the file: Update vegetation

The command bar's **Update vegetation** (Vegetation mode) writes `arboristdata.dat` after it has planted into
Unity, so the Arborist vegetation follows the zones without a shell (`ArboristService`,
`server/services/arborist.service.ts`, run by `GsproExportService.plantVegetation`):

| Step | Needs | Without it |
|---|---|---|
| Generators, zones export, Unity import + grass apply | Unity open for the import | zones exported only, reported |
| `arborist.py lower` (about 10 s on Vreta) | the zones export, the palette, the species file | fails the job with the reason |
| `golfmap.trees.dump` in Unity, then `arborist.py trees` (far rule and ring with the surface map and the `.GKD`'s boundary; about 5 s plus the dump) | Unity open: the trees' positions and ground heights are its scene's | skipped, reported; the file keeps the trees as last generated |

- **Update N zones** (selected zones) patches the masks, respawns them in Unity and runs `lower`
  again. It leaves the trees.
- **The outer terrain** goes into none of the course's VSP: Arborist draws all its vegetation (the
  outer catalogue's trees as billboards; no grass out there). Planting it writes its zones file only,
  with no generators and no Unity import (`OUTER_VEGETATION_IS_ARBORIST`); `lower` reads the inner
  zones export only, so the outer has no lower vegetation yet.
- The file alone, e.g. after an edit to `arborist-species.json`: `bun run gspro:export -- <course> arborist`
  (`lower`, then the trees when Unity is open). `--arborist-out <folder>` writes there instead of into
  the course folder, for a trial. `bun run grass:zones` runs `lower` after its zones export
  (`--no-arborist` leaves it), and so does the shaping run's replant after a rock slab.
- A new course's first `arboristdata.dat` (golf-map only replaces its own packages in an existing
  file): `bun run py arborist.py init --course-dir <GSPro course folder> --source <another course's
  arboristdata.dat> --inner-side <m> [--camera x y z] --look docs/gspro/<slug>/look.json` (Omberg, 2026-10-16).
  `terrainSize` must be an integer: `1510.0` made GreenKeeper's parser throw (`JsonParsingException ... actual '.'`)
  and load no Arborist vegetation at all. It also copies the `arborist_postprocess.dat` beside `--source` into
  the new folder (when there is none) and, with `--look`, writes the look's post values into it (what `post` does),
  so GSPro grades the new course like the one it came from.
  Then load the course in GreenKeeper, switch ARBORIST ON and SAVE (overwrite): that writes
  `coursedetails.txt`, which GSPro's course list reads (without it every hole shows "500 yards, par 0"
  and the round refuses to start), and `IsArborist: true` in the GKD. GreenKeeper refuses to save
  without a `splash.jpg` in the course folder.
- Still by hand: `arborist.py post` (look.json's post values), `lineup`, and (a course without
  routing rules only) after the trees changed owner the trim in Unity (the reload in Arborist is `bun run arborist`, below): the report then ends with
  a warning naming `golfmap.vsp.trees.trim restore=true`, then `file=<path>`, save, build.
  The trim is not run for you, because `restore` after a replant in Unity would put the old trees
  back beside the new ones. A replant (`golfmap.trees.plant`) drops its own items' rows from the trim
  file (the old file goes beside the planting backup) and says so: the storage is full again, so
  the dump writes no stem twice; then `arborist`, then `trim file=<path>` (no restore needed).
- GSPro reads the file when the course loads. The course's own VSP half (grass, the Forst trees,
  the `prefabItemsInVsp` plants) still needs the scene saved and `golfmap.course.build`.

Where it finds things (nothing is set per course beyond the first row):

| Input | Where |
|---|---|
| GSPro course folder (the base `arboristdata.dat`, the `.GKD` boundary) | the course's **GSPro course folder** setting (export panel, GreenKeeper course file; `courses.gspro_course_dir`; `bun run gspro:export -- <course> gkd --course-dir <folder>` sets it too) |
| Species file, palette | `docs/gspro/<course slug>/arborist-species.json`, `grass-palette.json`. No species file = not an Arborist course: the button only says so. The palette is this repo copy, not the one in the Unity course folder: keep the two the same. |
| Zones export, surface map | the course's export folder: `<slug>-inner-zones.json`, `<slug>-inner-surfaces.json` |
| Terrains square | the heightmap sidecars in the export folder (`unity.position` + `sideM` of the inner and, when exported, the outer) |
| Library, model sizes, planted trees | `data/arborist/` (the planted trees are rewritten from Unity on every run) |
| Key | `data/arborist-wrapper.key` (or `GOLFMAP_ARBORIST_KEY`) |

Follow-up, not built: trees without Unity. `arborist.py trees` would need, instead of the dump,
(1) the stems of the trees export (`<prefix>-<terrain>-trees.json`) with the prefab, scale and
rotation the Unity planter gives each one (that choice is made in C# today), (2) the hand edits in
`<prefix>-<terrain>-tree-edits.json` applied, and (3) ground heights from the course meshes, which
only Unity (or the course `.blend`) has: the DEM differs from the meshes by 15-50 cm in places on
Vreta.

### The loop: one command

Edit `arborist-species.json` → regenerate → reload in the open Arborist → screenshot. All of it,
with Marcus's Arborist already open on the course (`scripts/arborist.ts`):

```bash
bun run arborist -- vreta                                  # the whole file, then the reload
bun run arborist -- vreta --lower                          # only the lower vegetation (about 10 s)
bun run arborist -- vreta --trees --screenshot "hole 6"    # and a picture at a judged viewpoint
bun run arborist -- vreta --no-reload                      # the file only (= gspro:export -- <course> arborist)
bun run arborist -- vreta --close-others --screenshot      # Unity and GreenKeeper closed first, every viewpoint
```

- One status line per step with its elapsed seconds; the first failure stops the rest and exits 1
  naming the step. The file is written by the same `ArboristService` as **Update vegetation**, so the
  inputs, arguments and report lines are the panel's.
- `--trees` takes the trees out of the open Unity editor's scene when it is open
  (`golfmap.trees.dump`, read-only there) and otherwise keeps the dump the last run wrote, which is
  what an iteration over looks and species wants — the planting has not changed. `--close-others`
  never asks Unity (it has just closed it).
- The reload is `ResetVSPro` + `LoadData` through the mod, and then it **waits for a real signal**:
  `veg.systems` polled every 3 s until the stored-instance count is above zero and the same twice
  in a row (Vreta: about 15 s, not the documented 85). The 85 s is only the cap — reached, or
  without `veg.systems` in the build, it says so and carries on. `--wait <s>` moves the cap.
- `--screenshot` poses the camera at the course's judged viewpoints
  (`docs/gspro/<course>/perf-views.json`, the same file `unity/ArboristMod/perf.ts` reads; a name is
  a part of one, no name = every one), lets it settle (`--settle`, 6 s; 25 s for a frame rate worth
  quoting) and prints the PNG, `fps` and what `veg.at` finds in the middle of the picture.
- No bridge answered is diagnosed instead of timing out: whether Arborist is running at all (then
  the mod is not loaded — BepInEx), what else holds the memory, and how much is free. An Arborist
  that died of out-of-memory at start looks exactly like a closed one.
- Nothing here starts Arborist or loads a course in it: ask Marcus, or
  `pwsh unity/ArboristMod/apps.ps1 start`.
- `--out <folder>` writes the `.dat` there for a trial and leaves the course folder's alone (pair it
  with `--no-reload`: Arborist reloads its own). `arborist.py` still rewrites
  `data/arborist/<slug>-vsp-far.json` beside the planted trees, so after a trial that trim list can
  be ahead of the course folder's file.

### The edit loop: one tree or bush, live

A tree or bush Arborist draws (an `arborist:` model) is moved, resized, turned, deleted, added or
made another model in the running Arborist at once, and saved — **never through Unity** (Marcus,
2026-10-19: a Unity replant for one bush is minutes, this is under a second):

```bash
bun run arborist -- edit omberg move --by 2,0 --picked        # the bush marked with P in Arborist, 2 m east
bun run arborist -- edit omberg resize 1.2 --near 268,472     # the Arborist tree nearest world x, z
bun run arborist -- edit omberg rotate 45 --pick              # the one under the mouse in Arborist
bun run arborist -- edit omberg delete --id epsg3006:477289.50:6457208.50
bun run arborist -- edit omberg swap S7_American_Elm --picked # another model, the same height
bun run arborist -- edit omberg add CE_Plants_buckthorn-bush --at 270,475 --height 2.4
bun run arborist -- edit omberg show --picked                 # which tree it is; --dry-run on any op
```

- **Naming the tree**: Marcus points at it in Arborist and presses **P**: the mod marks the instance
  under the mouse with a yellow ▼ (Esc unmarks) and `--picked` takes it. The key is put up by the
  first edit after Arborist starts (or `call.ts veg.picker`). `--pick [u,v]` takes what is under the
  mouse (or at a point of the picture) right now; `--near x,z` the nearest Arborist tree within
  15 m; `--id` a tree id.
- **Optimistic**: live first — the mod's `veg.edit` takes the instance out of VSP's persistent
  storage and adds it again as it now is (item id, position, scale, rotation; 6 ms in Arborist,
  0.1 s round trip, drawn on the next frame). Then saved, about 1.5 s (Omberg, 8.8 MB file), in
  this order: `arboristdata.dat` (`arborist.py edit`: the instance, into another 100 m cell when it
  crosses one), `arboristdata.ids.json` (its drawn entry), `<prefix>-<terrain>-placements.json`
  (the placement: the next `gspro:export arborist` draws it the same) and
  `<prefix>-<terrain>-tree-edits.json` (the record `golfmap.trees.edit` would write: model, drawn
  height and crown width with `sized`, terrain-local x/z, rotation when turned — so the next plant in
  Unity places it the same), then on a routed course `<prefix>-inner-routing.json` with that tree routed
  again (worked out beside the `.dat` save; "Routing before planting"). Checked 2026-10-19 on Omberg: a bush moved, grown and another deleted,
  then the trees export rerun from the dump on disk drew them so.
- A moved or added tree stands on Arborist's own ground (the mod's `ground`, the highest collider).
- A model whose item the file lacks (a `swap` or `add` to a model the course has not drawn yet)
  cannot be shown live: the item is made from the species library and Arborist reloads (about 15 s).
- With Arborist closed the files are still written (a moved tree keeps its height then). A freshly
  started Arborist waits at Unity's "Arborist Configuration" dialog until Play is pressed
  (`apps.ps1 start` sends Enter), and the mod's bridge is not up before that: an `edit` right after a
  start finds no Arborist and only saves.
- Verified live 2026-10-19 on Omberg: a bush moved 1 m live in 10 ms, saved in 2 s (2.6 s for the
  whole command), and moved back (5 ms live, 1.5 s saved).
- One edit at a time: the service queues them, and `arboristdata.dat.edit.lock` keeps two processes apart.
- Only `arborist:` models: a tree of the course's VSP is refused (edit it with `golfmap.trees.edit`).
  Code: `server/services/arborist-edit.service.ts`, `scripts/arborist-edit.ts`,
  `unity/ArboristMod/Commands/EditCommands.cs`.

### The same by hand

`bun run gspro:export -- <course> arborist` is the regenerate step on its own; the commands below
are what it runs, for when an argument has to differ.

```bash
C="C:/GSProV1/Core/GSP/Courses/Vreta_lidar_scene"; SQ="-1475 -1475 3525 3525"   # union of the terrains, world x0 z0 x1 z1
bun run py arborist.py trees --course-dir "$C" --planted ../data/arborist/vreta-planted-trees.json --sizes ../data/arborist/catalog-sizes.json --species ../docs/gspro/vreta/arborist-species.json --terrains-square $SQ --surfaces D:/gspro_courses/vreta-opcd/vreta-inner-surfaces.json
bun run py arborist.py lower --course-dir "$C" --palette ../docs/gspro/vreta/grass-palette.json --zones D:/gspro_courses/vreta-opcd/vreta-inner-zones.json --species ../docs/gspro/vreta/arborist-species.json
bun unity/ArboristMod/call.ts call '{"type":"AAT.ExportVSPro","method":"ResetVSPro","args":["Vreta_lidar_scene"]}'
bun unity/ArboristMod/call.ts call '{"type":"AAT.ExportVSPro","instance":0,"method":"LoadData"}' 120    # then wait: 85 s, or poll veg.systems until the stored count stops changing (what bun run arborist does)
bun unity/ArboristMod/call.ts screenshot '{"from":[1040,60,900],"at":[930,18,1000],"width":1280,"height":720,"frames":20}'   # Vreta hole 1
```

- Each command replaces only its own package (`GolfMap trees`, `GolfMap lower vegetation`,
  `GolfMap lineup`); `lineup` with no `--items` removes the lineup. Nothing is saved from Arborist
  itself: the `.dat` on disk is ours, `arb.tint` and other live changes are lost on reload.
- Judging species or colours: `arborist.py lineup` puts named library items in a row (`--at 400 120
  1000` is clear air over Vreta); `Name@key=value,...` gives one a look of its own, `@far=1` its
  billboard-only copy. Colours by measurement: `calibrate.py` in the mod's README (run it with
  `pipeline/.venv/Scripts/python`; it needs numpy).
- What Marcus wants from the colours: an even colour within a species, small differences between
  species, the same colour near and far, nothing brighter than the fairway allows. Arborist's
  defaults are far too bright; a grey tint turns leaves muddy.
- Blotchy crowns at 50-150 m in Arborist's view are aliasing, not colour: the same frame rendered
  at 4K and scaled down is even; shadows, AO and gloss make no difference (2026-10-12). Do not
  chase it with tints.
- GSPro shows the truth: the mod runs there too, and an agent can build the course, open it and
  measure by itself (`unity/ArboristMod/README.md`, "GSPro"). Judge colours, mottling and frame
  rate there, not only in Arborist.
- Models: SpeedTree-type items (`S7_*`, shader `VS_SpeedTree`) have large leaf cards that read as
  blotches in GSPro; NatureManufacture's (`MeadowEnv_*`, `MountainEnv_*`, `Forest_*`, `NM_*`) hold
  up. `Forest_Large_beech_tree_07`-`09` are near-bare, `06` spindly; `03`-`05` are full crowns.
- Memory: Arborist with Vreta takes 11-12 GB; with Unity and GreenKeeper open on the same course
  it has died at start.
- Bash heredocs break on these JSON arguments; put longer scripts in a file.

## What GSPro reads (3.1.6.20, read from its Assembly-CSharp)

- A course is an Arborist course when its folder holds `arboristdata.dat`
  (`MenuOrchestrator.LoadScene`). `arboristversion.dat` is the asset catalogue version as 14
  digits of text. The `.GKD` flag `IsArborist` feeds the course list and the asset download
  (`DownloadArboristForSpecificCourse`); real Arborist courses have it `true`.
- Wrapper: `IV (16) || AES-CBC( int32 JSON length || GZip(UTF-8 JSON) )`, PKCS7.
  `pipeline/arborist-wrap.ps1` does both directions. The 16-byte key is the static array
  `ImportArboristToVSPro.DecryptData` uses; it is kept out of the repo, in
  `data/arborist-wrapper.key` (or `GOLFMAP_ARBORIST_KEY` / `--key-file`).
- JSON (`AAT.VSProClasses.PortableVSPro`): `VSProSettings` (`vegeSettings`, `terrains[]` by scene
  object name, `vegetationPackages[]` with `VegetationInfoList[]` and `TextureMaskGroupList[]`),
  `PersistentVegetationPackage.PersistentVegetationCellList[]`, `biomeMasks[]`, `vegeMasks[]`,
  `vegeLines[]`, `catalogVersion`, `terrainSize`.
- Items name their prefab by Addressables key (`Address`, the asset path inside Arborist's
  bundles) and carry about 140 settings plus the baked billboard textures. Several fields are
  parsed with `Enum.Parse` and must be valid, so items are **cloned from real course files**,
  never written from scratch.
- The vegetation is drawn by a VSP system of GSPro's own (`MenuOrchestrator.ArboristVegetationStudioGO`),
  not by the course scene's. The importer clears that system's packages first.

## Cells and positions

GSPro lays the Arborist system out over the union of the listed terrains. Instance positions are
relative to that square's south-west corner with y = world height; cells are 100 m and numbered
`x cell * cells per side in z + z cell` (`arborist.Grid`; checked against Baylands_GSP's 142
cells). Vreta: terrains from (-1475, -1475) to (3525, 3525), 50 x 50 cells.

## Texture masks and the lower vegetation (`arborist.py lower`)

Written and seen drawing in Arborist (2026-10-12, Vreta: 46 items, 13 mask textures, 4.4 MB file);
not yet seen in GSPro.

- One `TextureMaskGroup` per zones-export PNG: `{TextureMaskName, TextureMaskGroupID,
  TextureMaskList[{TextureRect (world x/z of the inner terrain), Repeat, MaskTexture, Width, Height,
  Format}]}`. `MaskTexture` is the raw ARGB32 bytes, bottom row first, as
  `base64(int32 length + gzip(base64 text))`; `Format` 5.
- Per item a density rule (0..1) and an include rule (0.02..1) on that group, each with its own
  `ChannelSelector`: VSP reads the bytes as (A, R, G, B), so a PNG channel R, G, B, A is selector
  1, 2, 3, 0.
- Items: the zone palettes' items (`grass-palette.json`) Arborist draws, each a clone of its Arborist
  item out of the library with the zone item's sample distance, density, scale, steepness and noise.
  **On the model library** (Omberg, since 2026-10-21): a zone item is `{name, model, <placement and
  size keys>}` and its model decides - an `arborist:<label>[#<variant>]` model's item is written here as
  `<label>` (the part before `#`), a `vsp:` model's is the course's own VSP's (left out, listed as "left to
  the course's own VSP"). Its look is `plantSettings` (the course-wide defaults) then the model's
  `look` (`tint`, `saturation`, `brightness`, `ao`, `shadows`, ...; a Unity `healthy`/`dry` is carried as
  `tint1`/`tint2`, which a `tint` beats), so one `bun run models -- look "<course>" <model> --set tint=#rrggbb`
  shows in every zone that uses the model. `arborist.py lower --models <slug>-models.resolved.json`
  (ArboristService passes it, as for the trees). Lower-vegetation models have form `grass` (a VSP texture,
  `vsp:texture:<texture stem>`), `plant` or `shrub`, and need no kind; `bun run models -- add "<course>"
  arborist:<label> --species <s> --form plant|shrub` sizes one from `catalog-sizes.json`, `bun run models
  -- zone "<course>" <palette key> "<item>" --model <id> [--set k=v,...]` swaps an item's model (printing
  VSP/Arborist before and after) or sets its size and placement. Both refuse a model the library lacks.
  The Planting rules panel lists each zone item with its renderer (the model id in the tooltip).
  **The older form** (Vreta): items name their `prefab` and hold their own look; species by name rule
  (the OPCD copies of the same NatureManufacture models are `<pack>_<model>`), exceptions in the species
  file's `species` map, `prefabItems` / `prefabItemsInVsp` in the palette decide who draws a bush, and
  the item's `healthy`/`dry` are carried under `plantSettings`.
- Not carried over yet: material overrides (Arborist stores no `_BackFaceMirrorNormal`), and the zones'
  height range (D-VZ17, the `@height` item copies with a scale mask).
- The same items must not spawn in VSP too: `golfmap.vsp.plants on=false` in Unity
  (`golfmap.grass.apply` puts the palette's spawning back).

## Models, placements and tree ids

A course's trees are models of its model library: the shared library `docs/gspro/model-library.json`
(golfmap-model-library-v1, every model any course can draw, with its base look) with the course's
`docs/gspro/<course>/models.json` (golfmap-models-v1) over it - an entry for a shared model is an override,
deep-merged onto it (a look for the course's light, `disabled: true`), any other entry a course-only model
(Omberg: the dead oak `arborist:S7_AmurCork_Winter`, the buckthorn bush; its Vreta-only vsp models are
disabled); a course without models.json inherits everything. `loadModelLibrary` resolves the two. The repo's
files are the source; Unity's copies (`Assets/GolfMap/<Course>/`) are generated by `bun run models -- sync
"<course>" [--dry-run] [--force]`: models.json = the resolved library, palette.json byte-equal; a Unity copy
changed by hand since the last sync is refused with its diff unless `--force`; grass-palette.json (the
zone palettes) is synced byte-equal the same way. arborist.py gets the resolved
library as `<export>/<slug>-models.resolved.json` (ArboristService). A model is `arborist:<catalogue label>` or
`vsp:<Unity prefab>` with its species, renderer, size (an Arborist model's from `catalog-sizes.json`,
first LOD) and look; the palette refers to models (`assets[].model`) and never names a renderer
(CONTEXT.md). `shared/vegetation/tree-models.ts loadCoursePalette` resolves the two for the matcher
(the server and `unity/*.mjs` read it; a model id is parsed and built only in
`shared/vegetation/model-id.ts`, `GolfMapModels.Parse/Id` and `arborist.py parse_model_id/model_id`),
Unity's `GolfMapPalette.Load` the same. A resolved asset's `guid` is its Unity prefab's only (none for an
Arborist model); the matcher hashes `key` / `MatchKey` (the prefab guid, else the model id).

- **Add an Arborist model**: `bun run models -- add "<course>" arborist:<label> --species <s> [--shared] [--dry-run]`
  (refuses a label Arborist lacks; a course-only model in the course's models.json, or with `--shared` in the
  shared library; syncs the course into Unity); `bun run models -- promote "<course>" <model>` moves a course's
  override or course-only model into the shared library. Or Unity's Palette
  panel, **Add Arborist model** (a model the library has is only referenced; else it runs that same command
  with `--unity <course folder>`, then adds the palette reference; Save runs `bun run models -- palette "<course>" --from <draft> --replace-unity`). The panel needs
  the golf-map repo folder (its Repo picker, EditorPrefs `GolfMap.RepoRoot`) and bun (`GOLFMAP_BUN` if not on PATH).
- **Placements**: Unity's planter writes `<export>/<prefix>-<terrain>-placements.json`
  (golfmap-placements-v1; `golfmap.course` lists it as `exports['inner-placements']`): every planted tree
  by id with its model, position, rotation and scale. Only vsp models go into the course's VSP; the
  Arborist ones exist only as placements, and `ArboristService` passes the file to `arborist.py trees
  --placements` with `--models` (the model's look).
- **Tree ids**: `arborist.py trees` writes `arboristdata.ids.json` beside the `.dat`
  (golfmap-arborist-ids-v1): every tree it was handed, `drawn` (item, x, z) or `leftOut` by the routing
  policy with the reason.
- **Tree edits by id** without the Scene view: `golfmap.trees.edit {terrain, op: modify|add|delete|revert, id,
  model | species, heightM, crownWidthM, rotationY, x, z}` records into the tree-edits file; plant to apply.
  `golfmap.vsp.trees.stored` counts what the course's VSP holds (or lists it `near: [x, z]`).
- Omberg 2026-10-18: beech (Forest_Large_beech_tree_03/04/05, CE_DA_Forest_Tree_16018/18195/11164) and elm
  (S7_American_Elm, darkened, and CE_Oak_CE_Tall_Fanned_1/2/3) are Arborist models; the Unity stand-ins
  and the list mapping under `"trees"` are gone. 2026-10-20: the poplars (MeadowEnv_02/03/05/06/07_Poplar), pines
  (MountainEnv_Forest_pine_01/03-06, _tree_00_B/C), firs (NM_Fir_02_Small/03_Medium/05_Standalone/07_Forest) and
  dwarf pines (MountainEnv_bush_dwarf_pine_big/medium_04) are `arborist:` models too, their calibrated looks moved
  from the species file into models.json; the Forst oaks and birches stay `vsp:` models with `billboardAs`
  (their Arborist billboard stand-in). The species file lost `vsp`, `trees`, `billboardBeyondM`, `outerKeep`
  and `forstRing_off` (the routing rules are in vegetation-rules.json).
- Open (first delivery): the Scene view tree editor handles VSP trees only - a tree that would become an
  Arborist model, or is one, is edited with `golfmap.trees.edit`. Unity's terrain-tree and GameObject planting
  modes plant no Arborist model and write no placements. The model library and palette have one source (the
  repo's shared library, course overrides and palette; Unity's copies are synced from them) and one add
  implementation (`bun run models`, which the Palette panel runs). A vsp model's `unity` node (prefab guid and
  path) is the project it was seeded from (Omberg's, else Vreta's); a course in another project overrides it; the Vegetation session window (`GolfMapVegSession.cs`) still saves Unity's palette.json in
  place, which the next sync reports as drift. Vreta's two palettes differ (2026-10-21; Unity's is the tuned one).
  A hand-picked model that is disabled in the palette plants for an Arborist model, not for a vsp one.

## The planted trees (`arborist.py trees`)

Seen drawing in Arborist (2026-10-12, Vreta: 144 475 trees, 24 species, 12.5 MB file with the lower
vegetation); not yet seen in GSPro.

- Source: Unity's `golfmap.trees.dump` (golfmap-planted-trees-v1): every stored instance of the tree
  catalogues with world position, scale and rotation, plus each prefab's model size. What stands
  in Unity is what goes over, hand edits and ground heights included.
- Species by the same name rule, exceptions under `"trees"` in `arborist-species.json`. Arborist's
  model sizes come from the mod (`arb.catalog` with `sizes`), measured the same way as Unity's.
- A tree of another shape in Arborist than its Unity prefab is sized to its lidar stem by the
  palette's rules (`SizeFit`: `--stems <slug>-inner-trees.json --palette palette.json`, passed when
  both exist), as a ratio to Unity's own fit so jitter and hand-set scales carry over. Omberg
  2026-10-17, 78 solitary trees against their ortho shadows: width error 0.37 -> 0.35 (log), height
  0.12 -> 0.13; the slim Unity birches drawn as Arborist's broad S7 birch come out about 20 % lower
  than the lidar, the generic broadleaf's beech and poplar 01's MeadowEnv 02 closer in width.
- Otherwise (no stem at the position, the same model) a tree keeps its height: scale x (our model height / Arborist's). Vreta's pines, firs, oaks and
  poplars 03-07 are the same models (factor 1); the birches, elms and the generic broadleaf are
  replaced by a different model.
- One item per Arborist species and look, runtime spawn off, source id 42. The outer catalogue's
  trees become billboard-only copies, `<name> (far)` (render distance factor 0, no collider, no
  shadow), as OconeeGC's background forest; `--no-far` keeps them full models.
- `Label@tint=#rrggbb,keep=0.8` in the mapping: a look of its own for that prefab (its own item),
  and `keep` thins it to that share (which trees follows from their position).
- Looks: `treeSettings` rules merge in order, later ones winning. Leaf tints per species are
  measured (`"calibrated": true`), and so are the billboards (`"billboardCalibrated": true`:
  brightness, saturation, tint, normal strength), since a billboard is baked from the untinted
  model and came out half as light as its tree.

## The ring rule: the course's own trees only near the play (`forstRing`)

The course's own full-model trees (the `"vsp"` prefabs; Vreta: Forst's CTI oaks and birches) are the
most expensive vegetation per tree: no billboards, drawn as meshes at any distance. `"forstRing"` in
`arborist-species.json` keeps them on the playing field and within `playM` metres of it (the same
playing field as the far rule: rough, semi, fairway, green, tee, bunker; not deep rough). A tree
further out, and still inside the far rule, is the **same tree** (position, rotation, height) as a
full model of the Arborist species `replace` names for its prefab. `arborist.ForstRing` holds the
rule; the key's `_comment` in the species file the reasons for Vreta's values.

```json
"forstRing": { "playM": 30, "minM": { "PF Birch": 30 },
               "replace": { "PF_Oak_big Terrain": "Oak__big", "PF Birch": "S7_European_White_Birch@tint=#527e4b" } }
```

- `replace`: prefab file name (or a part of one; the whole name wins, then the longest part) to
  `Label@look`, as in `"trees"`. A prefab without an entry stays the course's everywhere.
- `minM`: part of a prefab name to metres; that prefab's ring is the larger of it and `playM`.
- Only with `--surfaces` (the rule needs the far rule's distance map). Without the key the output is
  the plain far rule's, byte for byte (checked 2026-10-13).
- The replaced trees' positions go into the trim list with the billboard ones
  (`data/arborist/<course>-vsp-far.json`). In Unity always from the full storage:
  `golfmap.vsp.trees.trim restore=true`, then `golfmap.vsp.trees.trim file=<abs path>`; its
  `storedNow` must equal the "kept in the course's VSP" count `arborist.py` printed. Restore is
  idempotent (since 2026-10-14): a tree goes back only where its item does not stand already, a tree
  stored or written twice counts once (`alreadyStored`, `duplicatesRemoved`, `fileDoubles` in the
  result), so after it `storedNow` is the full storage (Vreta 25 154) however often it runs. Then
  `scene.save`, `golfmap.course.build`.
- Arborist's `Oak__big / medium / small / tall / wide` **are Forst's oaks**: the same meshes
  (first-LOD size and triangle count identical to `PF_Oak_*`) under Arborist's own shader
  (`Arb_DEC/Cutout Wind Translucency`, leaf tint = `_Color`). With the default tint they are olive
  brown; `#a0acc4` brings the crown to the course's CTI oaks within 2 % (measured in GSPro, 22 m,
  June sun). There is no bare-crowned one. The CE.Simgolf oaks (`CE_Oak_*`) are denser, rounder
  trees with 10 000-48 000 triangles in the first LOD and read as another species beside the Forst
  oaks; `S7_White_Oak` is a sparse SpeedTree. Sheets: `tree-export/arborist-shots/day3/rings/lineup-L2-*.jpg`.
- A lineup on the course itself: `lineup --at x y z --heading .. --ys <ground height per tree>`
  (heights from the mod's `ground`); in GSPro the items carry their prefab names (`veg.material
  item=Oak__big`), not the lineup's numbered ones.

Three rings built and measured on Vreta 2026-10-13 (GSPro 1920x1440 Very High, vSync off, Unity
closed; pictures, raw numbers and `results-table.md` in `tree-export/arborist-shots/day3/rings/`):

| | Forst kept (oaks / birches) | replaced oaks | replaced birches | frame, mean of 4 viewpoints, 2 runs | "Course VSP: trees" | "Arborist: trees" |
|---|---|---|---|---|---|---|
| no ring (far rule 80 m) | 2 519 (992 / 1 527) | 0 | 0 | 9.64 / 9.60 ms (104 fps) | 1.10 ms | 0.71 ms |
| 45 m | 1 866 (726 / 1 140) | 266 | 387 | 9.82 / 9.83 ms (102 fps) | 0.93 ms | 0.68 ms |
| 30 m | 1 449 (563 / 886) | 429 | 641 | 9.88 / 9.91 ms (101 fps) | 0.98 ms | 0.78 ms |
| 15 m (birches 30 m) | 1 233 (347 / 886) | 645 | 641 | 10.00 / 9.79 ms (101 fps) | 0.92 ms | 0.70 ms |

- **No ring bought frame time.** Half the Forst trees gone takes "Course VSP: trees" from 1.10 to
  about 0.95 ms, and the whole frame is not shorter (0.2-0.3 ms longer in all three builds, which
  were not compared with a fresh no-ring build of the same scene, so that part may be the build).
  Read: the cost sits in the trees near the camera (first LODs, shadows), which every ring keeps;
  and the oaks' replacements are the same meshes. A cheaper last LOD or a shorter shadow distance
  for the Forst items is the lever, not who draws the distant ones.
- **Oaks: the swap does not show from the fairway** at any of the three (same model, tint matched).
  Standing in the woods beside one, its trunk was darker than its Forst neighbours in one view
  (hole 4 woods); in open sun the trunks measured alike. Cause not found.
- **Birches: the swap shows.** `S7_European_White_Birch` has chalk-white trunks with black patches
  and a bluer green (crown mean 68/82/53 against Forst's 77/81/53); from the fairway the white stems
  stand out at 30-60 m, and a player in the deep rough more than 30 m out stands among them.
- `golfmap.vsp.trees.trim` now also matches a position one centimetre off (float against decimal
  rounding left 2 of 6 451 trees in both systems before).
- Left as built: 30 m. Dropping the ring = remove `forstRing`, `trees`, restore + trim, build.

## The species library

`unity/ArboristMod/library.ts` has a running Arborist add every catalogue asset
`pipeline/arborist-library.json` selects to a "GolfMap library" biome and export it to
`data/arborist/GolfMap library.biome` (232 items, 14 MB, git-ignored): each item then carries
Arborist's own default settings and billboards instead of another course's tweaks. A `.biome` is
one vegetation package as JSON, the same structure as a package in `arboristdata.dat`.

## What Arborist's users do (KAustin Designs' tutorial playlist)

Transcripts: `bun run yt "https://www.youtube.com/playlist?list=PLSVaNhf_G64UbnnnX3C2es9leVJve6RvD"`
→ `data/youtube/arborist-vegetation-program-field-to-forest/` (18 videos, read 2026-10-12; sources
below are video number @ time). They are UI tutorials by a course author: nothing on the file
format, and everything here is **said in a video, not tested by us**.

Hybrid courses:

- Leaving the course's VSP on after importing it into Arborist gives "double trees everywhere"
  (16 @ 1:06): the course's VSP draws beside Arborist's vegetation, at least in Arborist's view.
  The advice is to turn it off or delete it, so side by side is not a supported setup.
- Prefabs placed as plain GameObjects in the Unity scene load with the course and draw beside
  Arborist's trees; that is how the author keeps trees Arborist has no model for (12 @ 9:25,
  16 @ 18:42). Own prefabs cannot be brought into Arborist (12 @ 0:01). **The fallback for the
  Forst oaks and birches if VSP and Arborist do not draw together in GSPro.**

Files in the course folder:

- `arborist_postprocess.dat` (written when Arborist saves; Vreta has one) **controls the
  post-processing in GSPro from then on, whatever Unity's profile says** (15 @ 18:32). Round trip:
  Unity `Tools > Arborist Postprocessing` and Arborist's post-processing editor both import and
  export it; point them at the folder that holds the course folder. A course that looks different
  in GSPro than in Unity: look here first.
- Arborist's `Export vegetation` writes a spawn-positions `.dat` that the Unity helper
  (`Tools > Arborist > Show vegetation positions`) draws as dots, mask outlines and lines
  (12 @ 2:40). Format not read.
- "Use beta bundles" in Arborist's settings makes a course unpublishable (13 @ 3:11).

Stored instances are "quick plant" items in the UI. An item's scale multiplier (x, y, z) and
vertical offset act on every instance already planted from it (11 @ 12:06), so the author sets a
quick-plant item's scale range to 1 and offset to 0. Not checked: whether our cloned items' library
ranges scale our stored trees.

Colour:

- Tint from scratch: take the item's texture saturation to near 0, then set hue, brightness,
  healthy and dry colour; about half keeps some of the texture's variation; on pines it also takes
  the shine off (4 @ 2:41, 12:24). Try this where a tint turns leaves muddy.
- Billboards: a higher alpha cutoff removes the dark outline, most on pines and firs; start from the
  tree's colour values, then a little darker and less saturated (4 @ 7:42). The 2025-11 update adds
  smoothness and AO to the shader controls (distant shine on pine bark), an alternate billboard
  shader and collider primitives with a physics material (15 @ 6:35); our library export may
  predate those fields.
- Set the lighting and the grass first, the trees after, with the sun near noon: a low sun makes one
  side of a tree lighter than the other (2 @ 1:04, 14 @ 2:10).

Performance (no tree-count limit is ever given; the author watches the frame rate and runs GSPro's
bench):

- Draw calls follow the number of items per biome; 15-20 is called a big hit (3 @ 5:49, 17).
- LOD0 distance 32-37 m on high-poly trees (the "CE" trees; 8 000-17 000 triangles saved per tree),
  LOD0 kept only for trees standing alone (17).
- Render distance (where the billboard takes over) up to 600; about 400 in forest; factor about 150
  for short grass and small plants (10 @ 6:55, 17).
- Density or sample distance on dense stands is the biggest lever (10 @ 3:14).
- Billboard-only items as our `(far)` copies: render distance 0, no collider, and shadows left on
  for one species so the shadows do not end on a line (10 @ 8:28-12:38).

Features we do not write yet:

- Vegetation areas and lines (`vegeMasks[]`, `vegeLines[]`) add or remove items by a "vegetation
  type" number each item carries; a line has a width. Used for hedges (plant-type items, random
  position and rotation off) and for clearing paths (9 @ 11:11, 18). Types are global across
  default biomes. Unknown: whether they act on stored instances.
- "Vegetation at base": a tree item spawns the items of one vegetation type around each of its
  trees, radius 1 m by default, 5-6 m for wide crowns (6 @ 0:34). Unknown for stored instances.
- Terrain source IDs: each terrain, and each mesh made into a "mesh terrain" in Arborist, has an
  ID; items include or exclude by ID (7 @ 1:38-7:22). Planting hits the first terrain in the list,
  so the inner terrain goes first. The author lowers the Unity terrain to the meshes so that
  planting on the terrain fits (2 @ 4:48).
- Biome priority is the biome type's sort order, higher wins, a tie goes to the last one edited
  (9 @ 6:28). A biome marked default plants everywhere.

## Open questions

- Whether a course's own VSP (our grass) and Arborist vegetation draw together: GSPro gives its
  camera to one `FindObjectOfType<VegetationSystemPro>()`. The tutorials suggest they do (above).
- The asset catalogue is fixed (`catalog_2025.07.09.00.54.21`): 1 058 prefabs, 126 grass textures.
- The public beta (Unity 6) keeps the file names and key but parses with Newtonsoft and adds
  fields; untested.
- The licence terms for writing the file outside Arborist have not been read.

## Findings from the first full loops in GSPro (2026-10-13)

- Measure only with the graphics card free: Arborist with a course loaded renders uncapped and
  took 79 % of it (`set UnityEngine.Application targetFrameRate 5` and `QualitySettings
  vSyncCount 0` in Arborist), and Unity's scene view takes 40 % after a build. Let the camera
  settle 25 s after a move (`vegcost.ts` does). Clean numbers, 1920x1440 Medium, build of 00:24:
  71 fps in tall grass by hole 18 (grass 11 fps, Arborist trees 19, course trees 19 of the 104
  with no vegetation), 86 fps on tee 1.
- Trees: the far rule (`trees --surfaces`, `billboardBeyondM` 80 m) makes 114 000 of 140 000
  trees billboard-only; Unity's `golfmap.vsp.trees.trim` takes the trees Arborist draws out of the
  course's storage (22 600 of 25 100; `restore=true` puts them back, and `golfmap.trees.dump`
  still writes them).
- **The far rule makes a billboard only where a tree is far from both the boundary and the play**
  (changed 2026-10-14). It used to take either distance alone: the GKD boundary (`pOOB`) covers only
  the layout's 18 holes, and Vreta's driving range (surface class fairway) lies about 100 m outside
  it, so seen from the range tee the trees beyond the net were billboard-only blobs a few metres
  away, and so were trees on the club's holes outside the layout. Now: 0 billboards within 80 m of
  the range tee (11 before); +1 191 full models over the course (+4 %, of them 613 Forst trees back
  in the course's VSP, so the trim list shrinks from 6 451 to 5 838). Measured on a scratch run,
  not yet built or seen in GSPro.
- **Frame time on Vreta is main-thread CPU** (2026-10-14, GSPro Very High 1920x1440, vSync off): the
  main thread is 80-90 % busy in every case and a quarter of the pixels changes nothing. Looking
  straight up at the sky a frame is 6.3 ms, of which Arborist's VSP system (switched off whole)
  2.25 ms and the course's 1.1 ms, though almost nothing is drawn; at tee 1 (9.6 ms) 2.0 and 1.7 ms.
  `veg.draw` rows measure only the drawing. Levers tried live: Arborist's `PlantDistance` 350 -> 250
  m -0.6 ms at tee 1 (now `vegeSettings` in the species file), 150 m -0.85 ms; the course system's
  tree-mesh distance 3 000 -> 700 m and `PlantDistance` 300 -> 200 m about nothing. A trial file
  with the new far rule and `PlantDistance` 250 ran 3-5 fps faster than the 22:01 one at the four
  viewpoints (two rounds each, course reloaded per file). **Shadows only within 25 m of the play**
  (a "(no shadow)" copy of each species beyond it: 26 045 of 26 935 full models, 19 more items) ran
  2-6 fps slower than without: the extra items cost more CPU than the shadows saved; dropped.
- NatureManufacture's grass-shader ground plants (bilberry, lingonberry, heather, ferns) are white
  from the sun's side in Arborist and GSPro; no value Arborist stores cures it (smoothness, AO,
  tint, specular all tried live). They stay in the course's VSP, where the model's `material`
  override `_BackFaceMirrorNormal` does: their zone items refer to `vsp:<prefab>` models (Omberg; the
  older form: `"prefabItemsInVsp"` in grass-palette.json). The course's VSP draws NatureManufacture
  plants in GSPro (tested live).
- Arborist bushes and saplings beyond the player's shadow distance (250 m on Medium) stand unshaded
  and glint against the dark floor: `renderDistance` 0.55 in `plantSettings`.
- **The mod's `system` argument once matched any part of a system's path** (fixed 2026-10-13 21:53,
  `VegCommands.OfSystem`): GSPro's own Arborist system is `/MainGameObjects/VegetationStudioPro/...`,
  so `system: "/VegetationStudioPro"` also took it, and every "Course VSP: ..." row of `veg.draw` /
  `veg.set` measured before then (perf.ts `--cases`, `--rank`, the ring table above) hid both systems'
  vegetation of that type. A pattern starting with `/` now has to match the path's start; a pattern
  without one still matches any part. Pick a system by its root (`/VegetationStudioPro` = the course's,
  `/MainGameObjects` = Arborist's).
- The look is `docs/gspro/<course>/look.json` -> Unity `golfmap.look.apply` (ambient, sun intensity /
  direction / TimeAdjust clock, skybox and reflections, fog, colour grading saturation / exposure /
  temperature / contrast / lift / gamma / gain, AO, bloom) and `arborist.py post` (the post values into
  GSPro's `arborist_postprocess.dat`); a new course gets both from `golfmap.course.scene` and
  `arborist.py init --look`. Try values live in GSPro first with `set` on
  `UnityEngine.RenderSettings` and the `/PostProcessingVolume` profile.
