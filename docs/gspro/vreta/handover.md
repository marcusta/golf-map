# Vreta in GSPro: handover 2026-10-13 (whole day; the "Update" section at the top is the current state)

For an agent with no context. Read `docs/gspro/arborist.md` and `unity/ArboristMod/README.md` first
for the tools; this file is what one session found and left. Nothing is committed. The session was
stopped early: several things are prepared but not built.

## Update 2026-10-13 (10:00 to 23:00; supersedes what it contradicts below, the last bullets are the latest)

Built and loaded in GSPro: `Vreta_lidar_scene.gspcrse` of 10:33 and `arboristdata.dat` of about 10:40.
Unity and Arborist are closed. Nothing committed. Screenshots: `tree-export/arborist-shots/day3/`.

- **Bilberry, lingonberry, heather, ferns: verified after the build.** Green from the sun's side and
  against it, no white, no black (`b5-*.png`).
- **The black bush was Arborist's hazel** (`MountainEnv_bush_hazel_*`, material `M_Hazel`): its leaf
  texture is dark and the common plant tint `#6f7c63` took it to near black from every side. Fix in
  `arborist-species.json` (`plantSettings`, match `hazel`: tint `#b9c79f`, ao 0.5), `arborist.py
  lower` run, seen green in GSPro (`h1-hazel-*.png`). Found with red/blue probe tints (`veg.material`).
- **White specks in the hole 4 woods: not seen** at the perf viewpoint after the build (`v3-h4woods.png`).
  Only that one viewpoint was looked at.
- **Wispy rough had no Stix grass at all in GSPro, in every zone** (the pale straws there were VSP
  grass). Cause, read from the running game: GSPro's `DisableGrassRenderer` (added at run time by
  `grassonoffnew`) switches a `GrassRenderer` off beyond 300 m from the camera, measured to the
  MeshCollider's bounds, or with no collider to the **mesh's local bounds centre taken as a world
  point**. Our wispy objects stood at the zone centre with local vertices and no collider: 1 455 m,
  always off. Fix: `GolfMapWispyRough.cs` builds world-space meshes on objects at the origin.
  Verified in GSPro (`w1-*.png`). Any future Stix object without a MeshCollider needs the same.
- **Unity start-up**: the editor came up with a modal "Sign into your Unity Account" window and its
  bridge stopped answering (CPU idle, a second visible window titled `Unity 2018.2.8f1`). Marcus:
  click **Work offline** (no asset store needed). Clicking from a script needs a DPI-aware process
  (`SetProcessDPIAware`; the display is at 125 %).
- **`golfmap.course.build` through `call.ts` returned after 74 s with no output while the build ran
  on** (11 minutes). Wait for the `.gspcrse` time stamp to change and the bridge to answer again.
- **Quality level**: GSPro's own graphics panel only has the resolution. The Unity quality level is
  the "Graphics quality" list of the start-up (screen) dialog, stored in the registry as
  `HKCU\Software\GSPro\GSPro\UnityGraphicsQuality_h1669003810` = 4 = VeryHigh. So VeryHigh is what
  runs unless another level is picked in that dialog.
- **Frame rate, new build, VeryHigh 1920x1440, Unity and Arborist closed** (`perf-a.json`,
  `perf-b.json`), mean / 1 % low: tee 1 114.0 / 63.6 and 113.1 / 73.5; hole 6 104.3 / 93.0 and
  109.6 / 87.9; woods 120.0 / 104.7 and 119.2 / 98.9 (cap); hole 4 tee 103.3 / 73.5 and 102.9 / 78.4.
  Target met at all four.
- **The vehicles are not 182 M triangles.** `scene.geometry` summed the whole combined static-batch
  mesh once per renderer. Fixed in the mod (a combined mesh counts once per group; Unity 2018.2 does
  not expose a batched renderer's own submesh range). Real numbers: whole scene 26.1 M triangles
  (every LOD level counted), vehicles 2.35 M in 3 238 renderers with 3 189 shadow casters, props
  0.9 M. The wall and tee-stone rows of the table further down are inflated the same way.
- **Vehicles, decided by Marcus 2026-10-13**: about 10 000 triangles per car and about 30 cars (the 6
  golf carts stay). Staged, not in Unity: `tree-export/vehicles-lowpoly/` (FBX with 2 renderers per
  car, manifest, comparison sheets, the swap proposal and a keep/remove list). Swap steps are in the
  manifest folder's notes; capture hand edits before `golfmap.props.place`.

- **Vehicles are in the Unity scene (saved, not built)**: 30 cars + 6 carts, 72 renderers, no shadow
  casters (Marcus: no shadows from cars), 348 238 triangles (was 3 189 renderers, 2.04 M). Commands
  `golfmap.vehicles.build`, `golfmap.props.stats`, `scene.save`; `"parked": false` in
  `clubhouse-cars.json` removes a car. Details in `docs/unity-tool-notes.md`.
- **GSPro takes the post-processing from the course folder's `arborist_postprocess.dat`, not from the
  scene's profile** (it fills the volume's internal profile at course load): the saturation -18 of
  `look.json` had never reached the game; ambient, sun and fog do come from the scene.
  `arborist.py post --course-dir <course> --look <look.json>` (new) writes look.json's `post` values
  into that file; run it after every change to them. Done at 11:09 (the old file is
  `tree-export/arborist_postprocess.before-look.dat`); seen in GSPro only as live values so far.
- **Look, second pass** (tried live, one value at a time, with measured colour; before/after
  `day3/look/SBS-*.png`; reasons in `look.json`'s comment): shadow strength 0.8, fog 0 / 2500 / 2.0,
  AO intensity 0.6, saturation stays -18 (not grey: grass 38-45 % saturation), bloom unchanged,
  beech leaves `#87955a` with smoothness 0.3 (`arborist-species.json`; `arborist.py trees` not rerun
  yet: dump the trees from Unity first and pass `--surfaces`, the far rule). `GolfMapLook.cs` now
  applies fog, bloom and liftW: **not compiled yet**. Not fixed: hazel still lime with black shaded
  leaves against the sun; a near-black patch of low plants around (910, 1505); the far billboard wall
  is brownish without fog; beech billboards were calibrated to the old dark leaves.

- **Marcus's look brief (2026-10-13)**: a fine summer day, 10:00, late June in Sweden; sun, a few
  clouds, blue sky; lush green, drying a little here and there. He found the second pass too cold.
  Third pass in `look.json` (reasons in its comment; `JUNE-compare-*.png`): sun elevation 43 /
  azimuth 119 (was an evening sun, 34 degrees from WNW), colour temperature 22, skybox exposure 0.75
  on a course-local copy of the skybox material. `GolfMapLook.cs` (sun direction, sky, fog, bloom,
  liftW) is synced, compiled and applied; `arborist.py post` run again. Whether GSPro's own light
  file resets the skybox exposure or the sun at course load is **not checked yet**.
- **Grass pass, in Unity (scene saved)**: details in `.claude/skills/grass-planting/SKILL.md`.
  Uneven height (items of a palette had the same scale-noise size and rose and fell together; each
  now has its own); `creek_bank/reed` and `thicket` thinned about 40 % (Marcus: the red penalty area
  right of hole 6 was too thick; the shared items thin `reed_wet`, `vass*`, `thicket_wet` too; the
  drawn reed and thicket zones overlap there and add up); far rule regenerated (30 / 10 / 0.56, not
  tuned by eye); new palette `rough_tall/far` for tall grass more than 40 m from play (2 m cards,
  about 0.9 instances per m2 against 5). Visible grass instances: hole 6 water -33 %, woods by
  hole 4 -38 %, hole 4 tee -9 %, tee 1 -1 %; whole course by the masks -25 %.
- **Range net**: seen from the range it showed only its poles. `net_poles` drew the back side on the
  front's corners and the build's weld merged the two faces; the back is now 4 mm behind
  (`props_kit.py`, same for `target_flag`). Model rebuilt and reimported (10 net faces, both ways).
- **Performance ranking tool** (new, for any course): `bun unity/ArboristMod/perf.ts --rank` in GSPro
  and `golfmap.perf.report` / `GolfMap > Performance Ranking` in the editor, one category model
  (`unity/Editor/GolfMap/GolfMapPerfCategories.json`), docs in `unity/README.md`. The game side is
  smoke-tested; **the editor side compiles but has never run**. Viewpoints moved to
  `docs/gspro/vreta/perf-views.json`. On this machine pass `--cap 120`.
- Build of 12:03 started with all of the above, the trees regenerated (`arborist.py trees
  --surfaces`, beech tint) and the vehicles. Not verified in GSPro at the time of writing.

- **Forst ring (evening, 17:20 to 20:40)**: `forstRing` in `arborist-species.json` + `arborist.ForstRing`
  (docs: `arborist.md`, "The ring rule"). Forst trees only within R of the playing field, beyond it
  the same tree as an Arborist full model: oaks as `Oak__*` (Arborist's copies of the very same
  Forst meshes, tint `#a0acc4`), birches as `S7_European_White_Birch` from 30 m. Built and measured
  at 45, 30 and 15 m: **no frame-time gain at any** (table in `arborist.md`), the oak swap is not
  visible, the birch swap is (white trunks). **Loaded now: R = 30**, build of 19:51, `arboristdata.dat`
  of 19:38, Unity closed, storage trimmed to 1 449 trees. The built scene carries the June sun and
  sky exposure 0.7 (read back in GSPro). Everything in `tree-export/arborist-shots/day3/rings/`
  (`arboristdata.baseline.dat` = the file before). Traps: always `trim restore=true` before a new
  trim list; lineup items carry their prefab names in GSPro.

- **Late evening (20:40 to 23:00), supersedes the ring bullet above:**
  - **The mod's `veg.draw` / `veg.set` matched a system by any part of its path**, and GSPro's own
    (Arborist) system is `/MainGameObjects/VegetationStudioPro/...`, so `system: "/VegetationStudioPro"`
    also took Arborist's. Fixed (`VegCommands.OfSystem`: a pattern starting with `/` must match the
    path's start). **Every "Course VSP: ..." row measured before 21:53 (perf.ts --cases, --rank,
    `rank-2026-10-13.md`) hid both systems' vegetation of that type.** So "Forst trees cost 0.98 ms,
    ten times Arborist's per tree" was wrong, and the ring was built on it.
  - **Ring switched off**: the key is renamed `forstRing_off` (Marcus: the Forst oaks look better lit
    in the course's VSP than as Arborist's `Oak__`, closer up the usual light problems). Trees
    regenerated without it, Unity trim `restore=true` then the far list (2 519 Forst trees stored),
    scene saved with the June sun, **build of 22:13**, `arboristdata.dat` of 22:01 (both in the course
    folder now). Trap: that `restore` gave 47 789 stored instead of 25 154 (duplicates of the trimmed
    trees); the trim after it removed them pairwise and the end count is right, but restore needs a fix.
  - **Beech** (`Forest_Large_beech_tree_03/04/05`, Arborist): tint `#729182`, saturation 0.85, chosen
    live by Marcus; lowering the leaf saturation alone turned them brown (the texture is yellow), a
    bluer tint fixed the yellow-green. Written into `arborist-species.json` and the 22:01 file; the
    species file's `saturation` writes Arborist's `TextureSaturation`, the live trial set the shader's
    `_Saturation`: check the beech in GSPro against `rings/beech-tints2.jpg` (rightmost).
  - **Horizon thinning** `outerKeep` [[400, 0.8], [1000, 0.6], [null, 0.2]] (billboard-only trees outside
    the boundary, by distance from it): 75 015 of 113 831 left out, no visible loss from play height,
    about +2 fps at three of four viewpoints. Kept.
  - **Ranking with the corrected tool, 22:15** (`tree-export/perf/rank-3.md`, `--only vsp,shadows`):
    Arborist trees 0.83 ms, Arborist billboards 0.77, course grass 0.35, shadows 0.32, **course (Forst)
    trees 0.11 ms** (0.44 in the woods). **Not trustworthy in detail**: noise 0.2-0.35 ms per view
    (0.06 in the afternoon), the all-on baseline swung 10.4-11.6 ms within minutes; Marcus was
    watching YouTube and working in the web app on the same GPU. Run it again with the machine idle.
  - Viewpoint fps after the 22:13 build: tee 1 92.5, hole 6 103.3, woods 104.6, hole 4 tee 103.3.
  - `perf.ts` reads the cap by looking at the sky; on this machine pass `--cap 120`, or measure
    uncapped with the mod's `vsync '{"on":false}'` (GSPro sets vSync every frame; the command sets it
    back at the end of each frame) and `vsync '{"on":true}'` after. The display has been at
    3840x2160 59 Hz since about 11:00 (it was 120 Hz in the morning): under vSync anything below
    59 fps shows as 30.
  - Unity can start with a modal "Sign into your Unity Account" window that blocks the bridge:
    Marcus's instruction is **Work offline**. `TimeAdjust` (OPCD) on the sun turned it back to its own
    hour in the editor; `golfmap.look.apply` now switches it off before setting the direction.

Still open: the vegetation ranking on an idle machine (`perf.ts --rank --rounds 3` with vSync held
off; it takes about 75 minutes); what the fixed ~6 ms is (the sky alone with no vegetation ran at
about 168 fps); fix `golfmap.vsp.trees.trim restore`; hazel still lime with black shaded leaves
against the sun; a near-black patch of low plants around (910, 1505); far billboard wall brownish;
beech and `Oak__` billboards not recalibrated; Arborist's copy of the mod is not rebuilt; `arborist.md`
and the mod's README lack the system-match finding.

## State of the programs (as of 09:50, before the update above)

| | |
|---|---|
| GSPro | Running, Vreta loaded (round started 08:57 with `gspro.ts open Vreta`), camera back at the default tee-1 view. No live changes pending (`veg.set`, `veg.draw`, `scene.hide` all restored). `MainGameObjects` is at the origin, unrotated (see "Trees in the sky"). |
| Unity | **Closed** (for the frame-rate runs). Scene and project were saved before closing. Start: `pwsh unity/ArboristMod/apps.ps1 start`. |
| Arborist | **Closed.** Same command starts it (no course loaded). |
| The build in GSPro | `Vreta_lidar_scene.gspcrse` of 00:58 and `arboristdata.dat` of 00:29, i.e. last night's. **Nothing from this session is built.** |

## What is where

| Change | Repo | Unity project | Built / in GSPro |
|---|---|---|---|
| Bilberry, lingonberry, heather, fern materials and tints (below) | `docs/gspro/vreta/grass-palette.json` | palette copied, `golfmap.grass.apply` run, material copies written (`Assets/GolfMap/Vreta/Grass/Prefabs/Woodland * .mat` carry `_WindNormalInfluence: -3`), scene saved | **not built**; seen in GSPro only as live shader values |
| Heather thinned, lingonberry denser (sample distances) | same file | applied with the same `grass.apply` | not built |
| Creek-bank grass more uneven and a little thinner (25 item blocks) | same file | palette file copied to `Assets/GolfMap/Vreta/grass-palette.json` **after** Unity was closed: **not applied** (needs `golfmap.grass.apply`) | not built |
| Tall grass thinner beyond 30 m from play | `pipeline/grass_zones.py` (`Rules.far_start/far_ramp/far_weight`), test in `pipeline/tests/test_grass_zones.py` (18 pass) | **not run**: zones not regenerated, not exported, not imported | not built |
| Mod: `ground`, `camera eye=`, `screenshot eye=`, `scene.geometry`, `scene.hide`, `veg.draw`, camera fix | `unity/ArboristMod/Commands/PlayerCommands.cs`, `SceneCommands.cs` (new), `VegCommands.cs` | - | built and loaded in **GSPro's** mod (`build.ps1 -App C:/GSProV1/Core/GSP -OutDir tree-export/gspro-mod` + `reload`). **Arborist's copy of the mod is not rebuilt** (`build.ps1` with no arguments, then `call.ts reload`, once Arborist runs). |
| `unity/ArboristMod/perf.ts`, `perf-views.json` (new), `vegcost.ts` (baseline case fixed, but see the warning below) | yes | - | - |

`docs/gspro/arborist.md` and `unity/ArboristMod/README.md` were **not** updated; the facts for them
are in this file.

## Black bilberry, heather and ferns: cause and fix (seen live, not built)

- Reproduced in GSPro at the bilberry and heath patch around world (1025, 232) and the fern patch
  around (1079, 485). Sun: the light points towards heading 99 degrees at 34 degrees elevation, so
  "from the sun's side" is a camera yaw of 99 and "against it" 279.
- Cause: `_BackFaceMirrorNormal: 1` on NatureManufacture's `Grass/Advanced Grass Specular`. The
  shader is `Cull Off`; mirroring flips the whole tangent-space normal of a back face, so every
  face seen against the sun is unlit, and with the dark ambient ground of `look.json` nothing fills
  it: black, and the dry bilberry's red texture reads maroon. With 0 the same faces are lit as
  fronts with a specular sheen: white. No value in between is right (0.5 is a zero normal).
- Fix that works: point the vertex normals up, so a leaf is lit the same from every side, like the
  ground. `NMWind.cginc` does `v.normal.y += -_WindNormalInfluence + ...`, so a material float does
  it: `_BackFaceMirrorNormal: 0, _WindNormalInfluence: -3, _SmoothnessPower: 0, _Specular: 0`
  (`_AmbientOcclusionPower` kept at 0.8, ferns 1.0). Tried live with `veg.material`: green from
  both sides, near and from 70 m, tree shadows still fall on them.
- Not the cause: the plants' AO power, the Arborist system (hiding it changes nothing on these).
  Ambient colour, saturation and tints were not needed and not changed.
- Palette changes with it: bilberry, lingonberry and dry bilberry tint `#66785e` / `#6d755c` (were
  `#78876f` / `#7f8670`; lit from above they came out yellow-green), ferns `#8ea285` / `#87937a`,
  heather `#8c9684` / `#868c7c`. Heather (both items carry the pink spikes) sample distance 0.9 ->
  2.7 and 1.1 -> 3.3, dry bilberry 1.4 -> 2.5, lingonberry 1.0 -> 0.75 so that it is the base of the
  heath patches.
- `veg.material` values are put back by any `veg.set` (it refreshes the items): set them again
  after one.
- Screenshots (`tree-export/arborist-shots/night2/`): before `b1-bilberry-sunside.png`,
  `b1-bilberry-against.png` (black, maroon, pink); live fix `b2-up-sunside.png`,
  `b2-up-against.png`; with the new tints and thinned heather `b3-sunside.png`, `b3-against.png`;
  ferns `b3-fern-sunside.png`, `b3-fern-against.png`; from 70 m `b2-far-against.png`.
- Still open: one dark plant in `b3-fern-against.png` is an **Arborist** sapling or bush
  (`Tree_Leaves_Specular`; it disappears when the Arborist lower vegetation is hidden,
  `b3-fern-against-noarb.png`). It stands in a tree's shade and is seen from behind. AO power 0 and
  `_WindNormalInfluence` -3 on the Arborist items made no difference (`b4-arb-ao0.png`,
  `b4-arb-up.png`). Not identified further.
- Not verified: the white specks in the woods on hole 4 (needs the build).

## Trees in the sky: reproduced, cause found, fixed in the mod

- The mod's `camera` command moved the camera's parent. In Arborist that is the camera rig; in
  GSPro the camera (`TVGCamera`) hangs straight under `MainGameObjects`, the root that also holds
  GSPro's own Vegetation Studio system (the Arborist file's trees). VSP has a floating origin: it
  shifts all its vegetation by how far its object has moved since the last setup or refresh. So
  every `camera` call (and `vegcost.ts`, which uses it) moved and rotated that root, and a
  `veg.set` refresh then re-captured the origin: the far trees' billboards hung in the sky and the
  forest wall was gone. Picture: `p1-tee1-after-refresh.png`. Found with the object at
  (672, 1688, 1052) and `FloatingOriginOffset` (137, 1715, 1437).
- Fix: `PlayerCommands.Rig()` moves a parent only when it is a small rig (at most 3 children, no
  light); otherwise the camera itself. In GSPro the camera keeps a pose set this way. I put
  `MainGameObjects` back to position and rotation 0 and reloaded the course; it stays at 0.
- Assumption: 0 / unrotated is that root's native pose (its children's local positions fit; GSPro
  was not restarted to check).
- Consequence: **frame rates measured before this fix with `camera` or `vegcost.ts`, last night's
  71 / 86 / 104 included, were taken with the Arborist vegetation displaced and are not valid.**
  Screenshots posed with `from` / `rotation` were never affected (they move only the camera).
- Whether GSPro's own Free Flight Mode can cause it by itself was not tested.

## Frame rate

Conditions for every number below: GSPro 1920x1440, Unity quality level 4 of GSPro's six
(`GSProLite, Low, Medium, High, VeryHigh, Ultra`): the `fps` command reports **"VeryHigh"**, shadow
distance 250 m, 4 cascades, LOD bias 1.5. The task text said "Medium"; I did not find which GSPro
menu setting this level is, and did not change it. Unity and Arborist closed. vSync is on and GSPro
sets it again every frame (setting `vSyncCount` 0 does not hold), so **120 fps is the cap** of this
display: a number at 120 is a floor, not a measurement. Camera settled 25 s (20 s in one run),
5 s per reading. Target (Marcus): mean at least 90, 1 % low at least 50.

Viewpoints (`docs/gspro/vreta/perf-views.json`, moved there from `unity/ArboristMod/`; pictures `p1-tee1.png` (taken from an earlier
pose 14 m further back), `p2-h6water.png`, `p3-h4woods.png`, `p4-h4tee-left.png`):

| | position | rotation (pitch, yaw) |
|---|---|---|
| tee 1 | 1100.52, 16.08, 953.34 | 0, 279.16 (GSPro's own default tee view, read from the camera) |
| hole 6 water hazard | 823.4, 10.8, 1800.8 | 1.7, 135 (Marcus's screenshot spot) |
| woods right of hole 4 | 703, 22.27, 1317 (1.7 m over the ground) | 2, 327 |
| hole 4 tee, forward-left | 720, 18.43, 1190.6 (1.7 m over the ground) | -3, 287 |

As built (last night's build), after the camera fix and a fresh course load, four separate runs
(`bun unity/ArboristMod/perf.ts`), mean fps / 1 % low:

| | run 1 | run 2 | run 3 | run 4 |
|---|---|---|---|---|
| tee 1 | 107.1 / 58.0 | 105.6 / 58.0 | 106.4 / 57.3 | 104.2 / 56.9 |
| hole 6 water hazard | 107.4 / 69.3 | 103.9 / 83.7 | - | 97.6 / 73.8 |
| woods right of hole 4 | 119.9 / 102.0 | 119.6 / 81.1 | - | 111.6 / 64.1 |
| hole 4 tee, forward-left | 98.3 / 58.3 | 99.5 / 59.5 | - | 91.3 / 52.3 |

So the target is met at all four as built, with little room: the 1 % low is 52 to 58 at tee 1 and
the hole 4 tee, and run 4 read lower than runs 1 and 2 at three of the four (same build, about
30 minutes later; cause not found). No performance change was made.

What each part costs to draw, run 4 (`perf.ts --cases veg,stix`; `veg.draw` hides a kind at once
without a refresh; raw output `tree-export/arborist-shots/night2/perf/perf3.txt`). Mean fps, with
the gain over "as built" of the same viewpoint:

| | tee 1 | hole 6 | woods h4 | h4 tee |
|---|---|---|---|---|
| as built | 104.2 | 97.6 | 111.6 | 91.3 |
| no course grass (VSP texture grass) | 116.5 (+12.3) | 100.3 (+2.7) | 117.5 (+5.9) | 115.6 (+24.3) |
| no course plants (woodland floor) | 108.1 (+3.9) | 98.1 (+0.5) | 114.2 (+2.6) | 92.1 (+0.8) |
| no course trees (oaks, birches) | 119.1 (+14.9) | 104.3 (+6.7) | 118.7 (+7.1) | 91.5 (+0.2) |
| no Arborist plants (bushes, saplings) | 107.0 (+2.8) | 96.9 (-0.7) | 114.9 (+3.3) | 92.0 (+0.7) |
| no Arborist trees (full models) | 113.5 (+9.3) | 96.1 (-1.5) | 118.1 (+6.5) | 89.8 (-1.5) |
| no Arborist billboards | 108.2 (+4.0) | 97.7 (+0.1) | 114.0 (+2.4) | 93.1 (+1.8) |
| no VSP vegetation, Stix on | 120.0 (cap) | 103.3 | 136.7 (*) | 102.0 (*) |
| no vegetation, Stix off too | 119.9 (cap) | 98.5 | 119.3 (cap) | 119.8 (cap) |
| no Stix 3D grass only | 104.1 (-0.1) | 80.1 (*) | 113.2 (+1.6) | 90.5 (-0.8) |
| as built again (drift check) | 103.4 | 93.9 | 114.3 | 92.0 |

(*) readings I do not trust: 136.7 is above the cap, 102.0 came with a 1 % low of 10.9 (a hitch),
and "no Stix" at hole 6 read 80 here but 104.6 (+0.7) in run 2. A single 5 s reading swings by
several fps: repeat before acting on a small difference.

- **The no-vegetation baseline is at or above the 120 cap** at tee 1, the woods and the hole 4
  tee, so it could not be measured there, only bounded. At hole 6 it read 98 to 103 with all
  vegetation off, i.e. no higher than as built within the noise: vegetation is not what limits
  that view. What does was not found (the vehicles cost about 5 fps there, see below).
- The big levers by these numbers: the course's own texture grass (hole 4 tee +24, tee 1 +12) and
  the course's own oaks and birches (tee 1 +15, woods +7, hole 6 +7). The woodland floor plants,
  the Arborist bushes and the billboards are each within about 4 fps.
- `veg.draw` leaves the cells loaded and culled, so it measures the drawing only.

Non-vegetation, run 2 (`perf.ts --cases scene`, `scene.hide`; `perf/perf1.txt`), gain in mean fps:

| | tee 1 | hole 6 | woods h4 | h4 tee |
|---|---|---|---|---|
| no Stix 3D grass | 0.0 | +0.7 | -0.8 | -1.5 |
| no vehicles | +2.0 | +5.1 | -1.0 | -0.1 |
| all of GolfMap Props off | +1.9 | +5.2 | +0.4 | -0.1 |
| no stone walls and rocks | +1.7 | +0.3 | +0.4 | -0.2 |
| props and walls cast no shadows | +1.6 | -0.2 | +0.4 | -0.2 |
| no water planes and creeks | +2.2 | +0.8 | +0.2 | -0.5 |

**Do not trust** `perf/perf0.txt`, the vegetation rows of `perf1.txt`, or `perf2.txt`: taken
before the camera fix, or 9 to 25 s after a `veg.set` refresh. A refresh of the course's system
makes it load its cells again, and GSPro then ran at a steady 28.6 fps for about four minutes
before it came back to 104 (timed once at tee 1). `vegcost.ts` still measures that way: use
`perf.ts --cases`.

## Geometry of what we added (`scene.geometry`, read-only, in GSPro)

Mesh renderers in the loaded scenes: 253.6 million triangles, every LOD level and every instance
counted (so more than is drawn at once). By group:

| group | renderers | triangles | materials | shadow casters | LODGroups |
|---|---|---|---|---|---|
| `/GolfMap Props/Vehicles` (95 vehicles: cars, golf carts) | 3 238 | 181.6 M | 52 | 3 189 | 0 |
| `/GolfMap Walls` | 575 | 48.1 M | 8 | 575 | 106 |
| ... of which tee wall stones (`h#-front-tee`, `h#-middle-tee` `wallstone_*`) | 258 | 25.8 M | 2 | 258 | 0 |
| `/Meshes` (OPCD course meshes) | 1 037 | 12.0 M | 60 | 32 | 0 |
| `/GolfMap Props/Props` | 221 | 10.2 M | 51 | 221 | 46 |
| ... hedges (`hedge_boxwood`, `hedge_tee`) | 92 | 3.8 M | | | 46 |
| ... `bench_stone` 18 | 18 | 1.3 M | | | 0 |
| ... `range_mat` 23 | 23 | 0.9 M | | | 0 |
| ... `picnic_table` 10, `tee_sign` 18 | 28 | 1.4 M | | | 0 |
| `/GolfMap Props/Structures` | 12 | 0.6 M | 20 | 12 | 0 |
| `/GolfMap Props/Buildings` | 12 | 0.5 M | 29 | 12 | 0 |
| `/Waterplanes` | 24 | 0.23 M | 1 | 0 | 0 |
| `Prefab_Big_rock_02` x2, `Prefab_flat_rock_03_moss` | 5 | 0.32 M | | 5 | 3 |
| `/GolfMap Power Lines` | 6 | 0.025 M | 3 | 6 | 0 |
| `/GolfMap Creeks` | 15 | 0.004 M | 1 | 0 | 0 |

- The vehicles are the finding: about 1.9 million triangles and 34 renderers per car, no LODs,
  all casting shadows. They cost about 5 fps at hole 6 and 2 at tee 1 and nothing measurable at
  the two hole 4 views. Options, none done: LODs or a low-poly stand-in, fewer cars, no shadow
  casting on the small parts, combined meshes per car.
- Tee wall stones: about 100 000 triangles each, no LOD. Cost at these four views at most 1.7 fps
  (tee 1); not measured beside a tee wall.
- Nothing else cost more than about 2 fps at any of the four.

## Stix 3D grass

- Vreta's rough material `NewRough` (`Assets/Terrain Backup/vreta/NewRough.mat`): `_TargetDensity`
  0.03 (the distance between blades, so lower is denser), blades 0.11 to 0.14 m, width 0.008,
  fade 5.1 to 50 m, LOD max 2, disorder 2. `NewRough Lip` (bunker blends) 0.021, 0.127 to 0.161 m.
  `NewRough Wispy Floor` 0.03, 0.143 to 0.182 m. `NewRough Wispy` 0.059, 0.20 to 0.38 m.
- Reference courses (`docs/gspro/reference-courses.md`): rough 0.04 to 0.05 with 0.03 to 0.08 m
  blades, deep rough 0.10. So Vreta's rough is denser than every reference (by spacing, 1.8 to 2.8
  times the blades) and its blades are longer.
- Cost at the four viewpoints: not measurable (table above), so I changed nothing. No density
  steps and no near-ground comparison shots were made. `s0-stix-on.png` / `s0-stix-off.png` show
  the rough by tee 1 with and without it.
- 220 `GrassRenderer`s: 204 on course meshes (rough, bunker blends and lips, some bunker and road
  meshes) and 16 on the 8 wispy zones. **No `Deep_-_Mesh` carries one**: deep rough has Stix only
  inside wispy zones.

## Hole 4: Stix missing on a wispy deep rough (not solved)

- The zones export has 8 `rough_wispy` zones; five are on hole 4: `9cce513f` (626, 1367),
  `6d68de25` (681, 1282), `ede5f0c2` (682, 1281), `879ac0ac` (602, 1451), `415d3cdc` (572, 1234).
- In the running build every zone has its object under `/GolfMap Wispy Rough` with both renderers
  (floor and `Wisps`), all active, and the mesh assets in `Assets/GolfMap/Vreta/WispyRough/` are
  not empty (7 KB to 430 KB; they were rewritten at 08:30 today, which is when I ran
  `golfmap.grass.apply`, so that command or something beside it rebuilds them).
- The ground under `9cce513f`, `6d68de25` and `879ac0ac` is `Spline_Outer_Deep_Sat_2_2_piece2_-_Mesh`.
  `GolfMapSurfaces.Classify` calls that Deep, so `golfmap.wispy.build` should include it.
- Not done: looking at these three zones in GSPro from 1 to 2 m (is the floor there, are only the
  wisps there, does the 5 to 50 m fade hide it), and `golfmap.wispy.build dryRun=true` in Unity to
  read each zone's `triangles` / `floorTriangles` / `from`. That is the next step.

## Not done

- No build, so nothing of task 1 is verified "after a real build".
- Task 3 (look) not started: shadow strength, bloom threshold, fog, AO intensity, the beech tint,
  the grey-or-not check of grass and bushes, the willow / hazel balance.
- Performance: no change made (target met as built at this quality level). Arborist LOD factor 2,
  tree shadows, render distances: not tried.
- Grass: "more uneven" and the thinning of the creek grass are in the palette only; "thinner beyond
  30 m" is code only; the out-of-bounds palette is not started; whether the tall grass kinds are
  thin enough was not judged.
- Docs: `arborist.md` and the mod's README not updated.

## Next steps, in order

1. `pwsh unity/ArboristMod/apps.ps1 start`; wait for Unity's bridge (`bun unity/mcp/call.ts status`).
2. `bun unity/mcp/call.ts golfmap.grass.apply '{}' 300` (takes the creek changes; the bilberry ones
   are already in).
3. Optional, the 30 m rule: `bun run grass:zones -- <course>` regenerates the generated tall-grass
   zones in the golf-map database (hand-drawn zones are not touched) and exports them; then
   `golfmap.zones.import '{"terrain":"inner"}'` and `golfmap.grass.apply`. Look at one area in
   Unity first: `far_weight` 0.56 is a first guess.
4. `golfmap.wispy.build '{"dryRun":true}'` and a near-ground look at the three hole 4 zones.
5. `bun unity/ArboristMod/gspro.ts end`, then `bun unity/mcp/call.ts golfmap.course.build '{}' 1500`.
6. `pwsh unity/ArboristMod/apps.ps1 close`, `gspro.ts open Vreta`, then the same screenshots as
   above (the `b1` poses: from (1010, 1.6 m over ground, 232) yaw 99 and from (1045, ..., 236) yaw
   279, pitch 14; ferns from (1062, ..., 485) yaw 99 and (1095, ..., 487) yaw 279) and
   `bun unity/ArboristMod/perf.ts`, twice.
7. Find out which GSPro graphics setting Unity level "VeryHigh" is, and measure at the one Marcus
   means.
8. Rebuild Arborist's copy of the mod (`unity/ArboristMod/build.ps1`, `call.ts reload`) so its
   `camera` has the same code.

## Decision after the handover was written (Marcus, 2026-10-13): cheaper vehicles

182 M triangles and about 5 fps for background decoration is too much. Target: about **20 000
triangles per car** (no need for extreme low-poly), down from about 1.9 M. The cars are props:
placed from `docs/gspro/vreta/clubhouse-props.json` (category `vehicle`, prefabs under
`Assets/Vehicles/Prefabs/` in the Unity project) by `unity/Editor/GolfMap/GolfMapProps.cs`
(`blender/tools/build_props.py` writes the spec). Ways to get there, to be weighed by the next
session: decimated course-local copies of the prefabs' meshes made in Blender (mesh work belongs
in Blender here) with the parts of a car merged into few renderers, or a cheaper vehicle pack if
the project has one. Keep hand-placed positions and rotations (capture them into the spec before
any re-place), no shadow casting from small parts, and verify the result in GSPro: look (a car
at 20-100 m must still read as that car), the triangle count with `scene.geometry`, and the fps
at the hole 6 viewpoint.
