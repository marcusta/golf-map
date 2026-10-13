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
cannot be tinted as needed. One list decides: `"vsp"` in `arborist-species.json` (parts of prefab
names). `arborist.py trees` leaves those prefabs' full-model trees out, and Unity draws only them:
`golfmap.vsp.trees on=true keep=<the same list>` hides every other item of the inner tree
catalogue (nothing deleted; `on=true` without `keep` shows all again) and leaves the background
system off, so the background trees of every species, these included, are Arborist's
billboard-only copies. Not yet seen in GSPro: whether the two draw together.

| | |
|---|---|
| Arborist app | `D:\gspro\Arborist_Launcher\Data\Application` (the launcher only updates and starts it; an update may remove the mod); log in `%USERPROFILE%\AppData\LocalLow\OPCD\Arborist\output_log.txt` |
| The mod | [unity/ArboristMod/README.md](../../unity/ArboristMod/README.md): `bun unity/ArboristMod/call.ts <command> ['{json}'] [timeoutSec]`; `call.ts commands` lists them. Marcus opens the course in Arborist; ask him when no bridge answers. |
| Course folder | `C:\GSProV1\Core\GSP\Courses\<course>` (Vreta: `Vreta_lidar_scene`): `arboristdata.dat`, `arboristversion.dat`, GKD with `IsArborist: true` |
| Per-course choices | `docs/gspro/<course>/arborist-species.json`: species mapping (`species`, `trees`) and looks (`treeSettings`, `plantSettings`; keys in `arborist.py apply_look`) |
| Inputs (git-ignored, `data/arborist/`) | `GolfMap library.biome` (species library), `catalog-sizes.json` (`arb.catalog` with `sizes`), `<course>-planted-trees.json` (Unity `golfmap.trees.dump file=<abs path>`), `lineup-items.txt` (the tree species in calibration order) |
| File key | `data/arborist-wrapper.key` (git-ignored; never into the repo) |

### Who writes the file: Plant for GSPro

The web Vegetation mode's **Plant for GSPro** writes `arboristdata.dat` after it has planted into
Unity, so the Arborist vegetation follows the zones without a shell (`ArboristService`,
`server/services/arborist.service.ts`, run by `GsproExportService.plantVegetation`):

| Step | Needs | Without it |
|---|---|---|
| Generators, zones export, Unity import + grass apply | Unity open for the import | zones exported only, reported |
| `arborist.py lower` (about 10 s on Vreta) | the zones export, the palette, the species file | fails the job with the reason |
| `golfmap.trees.dump` in Unity, then `arborist.py trees` (far rule and ring with the surface map and the `.GKD`'s boundary; about 5 s plus the dump) | Unity open: the trees' positions and ground heights are its scene's | skipped, reported; the file keeps the trees as last generated |

- **Update for GSPro** (selected zones) patches the masks, respawns them in Unity and runs `lower`
  again. It leaves the trees.
- The file alone, e.g. after an edit to `arborist-species.json`: `bun run gspro:export -- <course> arborist`
  (`lower`, then the trees when Unity is open). `--arborist-out <folder>` writes there instead of into
  the course folder, for a trial. `bun run grass:zones` runs `lower` after its zones export
  (`--no-arborist` leaves it), and so does the shaping run's replant after a rock slab.
- Still by hand: the first `arboristdata.dat` of a course (golf-map only replaces its own packages
  in an existing file), `arborist.py post` (look.json's post values), `lineup`, and after the trees
  changed owner the trim in Unity (the reload in Arborist is `bun run arborist`, below): the report then ends with
  a warning naming `golfmap.vsp.trees.trim restore=true`, then `file=<path>`, save, build.
  The trim is not run for you, because `restore` after a replant in Unity would put the old trees
  back beside the new ones.
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
  naming the step. The file is written by the same `ArboristService` as **Plant for GSPro**, so the
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
- Items: the palette's prefab items (`grass-palette.json`), each a clone of its Arborist species
  out of the library with the palette's sample distance, density, scale, steepness and noise.
  Species by name rule (the OPCD copies of the same NatureManufacture models are
  `<pack>_<model>`), exceptions in `docs/gspro/<course>/arborist-species.json`.
- Not carried over yet: the palette's tints and material overrides (Arborist's defaults are
  kept), and the zones' height range (D-VZ17, the `@height` item copies with a scale mask).
- The same items must not spawn in VSP too: `golfmap.vsp.plants on=false` in Unity
  (`golfmap.grass.apply` puts the palette's spawning back).

## The planted trees (`arborist.py trees`)

Seen drawing in Arborist (2026-10-12, Vreta: 144 475 trees, 24 species, 12.5 MB file with the lower
vegetation); not yet seen in GSPro.

- Source: Unity's `golfmap.trees.dump` (golfmap-planted-trees-v1): every stored instance of the tree
  catalogues with world position, scale and rotation, plus each prefab's model size. What stands
  in Unity is what goes over, hand edits and ground heights included.
- Species by the same name rule, exceptions under `"trees"` in `arborist-species.json`. Arborist's
  model sizes come from the mod (`arb.catalog` with `sizes`), measured the same way as Unity's.
- A tree keeps its height: scale x (our model height / Arborist's). Vreta's pines, firs, oaks and
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
  `storedNow` must equal the "kept in the course's VSP" count `arborist.py` printed. Then
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
- NatureManufacture's grass-shader ground plants (bilberry, lingonberry, heather, ferns) are white
  from the sun's side in Arborist and GSPro; no value Arborist stores cures it (smoothness, AO,
  tint, specular all tried live). They stay in the course's VSP, where the palette's `material`
  override `_BackFaceMirrorNormal` does: `"prefabItemsInVsp"` in grass-palette.json. The course's
  VSP draws NatureManufacture plants in GSPro (tested live).
- Arborist bushes and saplings beyond the player's shadow distance (250 m on Medium) stand unshaded
  and glint against the dark floor: `renderDistance` 0.55 in `plantSettings`.
- The look is `docs/gspro/<course>/look.json` -> Unity `golfmap.look.apply` (ambient, colour
  grading saturation and exposure, AO colour); try values live in GSPro first with `set` on
  `UnityEngine.RenderSettings` and the `/PostProcessingVolume` profile.
