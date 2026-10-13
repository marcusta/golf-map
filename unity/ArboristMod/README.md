# Arborist mod: the GolfMap bridge inside Arborist

Lets an agent see and drive Arborist (OPCD's vegetation tool, a Unity 2018.2 Mono player) the way
`unity/mcp` drives the Unity editor: same HTTP protocol, commands as `[BridgeCommand]` methods.
For personal use on the machine it is built on; it is not distributed, and it does not read
Arborist's encrypted asset bundles out of the app.

```
bun unity/ArboristMod/call.ts ──HTTP 127.0.0.1:8790+──▶ GolfMapPlayerBridge (in Arborist.exe)
                                                         ├─ Core:     bridge, registry, commands, reload
                                                         └─ Commands: loaded from bytes, hot-reloadable
```

## Pieces

| | |
|---|---|
| BepInEx 5.4.23.2 (x64) | The loader, unpacked next to `Arborist.exe` (`winhttp.dll`, `doorstop_config.ini`, `BepInEx/`). Not in the repo. Arborist's own files are untouched; deleting `winhttp.dll` switches the mod off. An Arborist update through the launcher may remove it. |
| `Loader/BepInExLoader.cs` | BepInEx plugin whose `Awake` calls `PlayerBridge.Boot()`. |
| `Core/` | `PlayerBridge` (HTTP listener, jobs on the main thread, log capture, discovery file) and `PlayerRegistry` (`commands`, `reload`). Reuses `BridgeJson.cs` and `BridgeCommands.cs` from `unity/Editor/GolfMapBridge/`. |
| `Commands/` | `PlayerCommands` (`console`, `scene`, `camera`, `screenshot`), `ReflectCommands` (`types`, `objects`, `get`, `set`, `call`) and `ArboristCommands` (`arb.catalog`, `arb.biomes`, `arb.biome.new/add/export`, `arb.tint`), and for reading how a loaded course is made (read-only; results in `docs/gspro/reference-courses.md`) `LookCommands` (`look`: render settings, lights, cameras, post-processing and fog components, VSP settings per item, shader use) and `MeshCommands` (`mesh.bunkers`, `mesh.classes`, `material`, `veg.surfaces`). |
| `library.ts`, `calibrate.py` | The species library (Arborist's own default item settings, exported as a biome) and the colour calibration. |
| `build.ps1` | Compiles with the Unity editor's Roslyn against Arborist's `Managed` folder and installs into `BepInEx/plugins/GolfMapPlayerBridge/`. |
| `call.ts` | `bun unity/ArboristMod/call.ts [command] ['{json args}'] [timeoutSec]`; no command lists the running players. |

## Colours by measurement

`calibrate.py` tunes leaf tints against what the screen shows. `pipeline/arborist.py lineup --at X Y Z
--heading 90` puts the species in a row high above the course, so each is seen against the sky; the
script sets a tint live (`arb.tint`, both leaf tones the same, so a crown is one even colour),
photographs the crown, measures its mean colour and corrects the tint until the crown is the colour
asked for. `--spread` keeps a part of each species' own character. `--write` puts one `tint` rule
per species into the course's `arborist-species.json` (`treeSettings`), which `arborist.py trees`
applies. Vreta 2026-10-12: 23 tree species, broadleaves on target within 1 %, the thin pine crowns
a little bluer than asked. Small Plant-type items (bilberry, fern, most bushes) do not draw in the
air, so the lower vegetation has one tint by eye instead (`plantSettings`).

A tree's billboard is baked from the untinted model and lit by its own normal map, so at a distance
the same tree was about half as light, more saturated and hard-shadowed (seen 2026-10-12: every
species the same dark green beyond the model distance, and a colour change on the way in).
`calibrate.py billboards` measures a lineup of pairs (`A A@far=1 B B@far=1`: the model, then its
billboard-only copy) and writes `billboardBrightness`, `billboardDesat` (saturation, 0 = grey),
`billboardTint` and `billboardNormal` per species. They cannot be set live: lineup, reload, run,
three times over; broadleaves end within about 10 % of their model.

## Working with it

- A change under `Commands/`: `build.ps1`, then `call.ts reload`. Arborist keeps running.
- A change under `Core/` or `Loader/`: close Arborist, `build.ps1`, start Arborist.
- Discovery: `%LOCALAPPDATA%\GolfMapPlayerBridge\bridge-<pid>.json`, apart from the editors'
  `GolfMapBridge` folder, so the `unity` MCP tools never pick the player.
- Codex's Windows sandbox redirects `LOCALAPPDATA` to its package folder and can hide host
  processes. If Arborist is open but `call.ts` reports no editor, run the bridge command with
  host permissions. Verified 2026-10-12: no app restart or mod reinstall was needed. Do not
  treat the sandbox's empty process list as proof that Arborist is closed.
- `screenshot` captures the camera's own next frame into a texture (VSP queues its vegetation in
  LateUpdate, so a `Camera.Render()` on the side shows none); screenshots land in
  `%TEMP%\GolfMapPlayerBridge\`.
- Arborist steers the camera's parent (`CameraParent`, `CameraControlScript`), the camera a child
  at no offset. `camera` therefore moves the parent, and `screenshot` puts the camera back in
  local terms. If the user's WASDQE keys go the wrong way (the rig was knocked out of line, e.g.
  by a generic `set` on the camera's transform): `call.ts camera '{"reset":true}'`.
- A new course build (`.gspcrse`) without restarting Arborist (done 2026-10-12; about 100 s, and
  memory ends some GB higher than a fresh start): `call` on `OPCD_Arborist.MenuSystem` instance 0,
  in this order: method `CloseCourse`; a few seconds later path `myLoadedAssetBundle` method
  `Unload` args `[true]` (Arborist's own close keeps the bundle, and the same bundle cannot be
  loaded twice); then method `LoadScene` args `["<course folder>/<course>.gspcrse"]`. The
  vegetation file loads by itself after the scene. Nothing is saved on the way.
- BepInEx's log: `BepInEx/LogOutput.log` next to the app. Arborist's own:
  `%USERPROFILE%\AppData\LocalLow\OPCD\Arborist\output_log.txt`.

## GSPro

The same bridge runs in GSPro (3.1.6.20 is the same Unity 2018.2.8 Mono player), installed
2026-10-12 at `C:\GSProV1\Core\GSP`: BepInEx unpacked next to `GSPro.exe`, then
`build.ps1 -App C:/GSProV1/Core/GSP -OutDir tree-export/gspro-mod`. With both apps up, pick one:
`GOLFMAP_PLAYER=gspro bun unity/ArboristMod/call.ts ...` (or `arborist`). It is for looking at
and measuring our own course locally: keep it out of online rounds, and delete `winhttp.dll`
next to `GSPro.exe` to switch it off. A GSPro update may remove it.

What it gives in GSPro:

- `bun unity/ArboristMod/gspro.ts open Vreta` goes from the home menu (or a running round, which
  it ends first) to the first tee: Local Match, search, Play, start; `gspro.ts end` goes back to
  the menu. A course's `arboristdata.dat` and `.gspcrse` are read when the round starts, so this
  is also how a new vegetation file or build is brought in (Vreta: about two minutes).
- `screen` (the window with its UI; `screenshot` is the camera's picture without it), `ui`,
  `ui.click`, `ui.type` for anything the script does not cover.
- `veg.systems`: GSPro's own system (`/MainGameObjects/...`, the Arborist file's trees and
  bushes) and the course's systems, each with its camera, items and stored instances. Both get
  the game camera, so a course's own VSP and Arborist vegetation draw together (seen 2026-10-12).
- `veg.at u v`: which placed tree stands at that spot of the picture, in which system.
- `fps`: the frame rate where the camera stands (mean, 1 % low, resolution, quality level, and
  vSync / refresh rate, i.e. where it is capped).
- `perf.ts`: the frame rate at the course's judged viewpoints, and with `--rank` what costs frame
  time per category, ranked (`scene.geometry groups=`, `scene.hide`, `veg.draw`; the same
  categories and result file as the editor's `golfmap.perf.report`):
  [unity/README.md](../README.md#performance-ranking).

The whole loop without a hand on the mouse: Unity `golfmap.course.build` (about 12 minutes; end
the GSPro round first, and close the course in Arborist if memory is short), `arborist.py trees` /
`lower`, `gspro.ts open <course>`, then `screen`, `veg.at`, `fps`.

The same loop in Arborist is one command: **`bun run arborist -- <course> [--trees|--lower]
[--no-reload] [--screenshot [<view>...]] [--close-others]`** (`scripts/arborist.ts`) — it
regenerates the course's `arboristdata.dat` with the server's own service, calls `ResetVSPro` and
`LoadData` here, waits for the load by polling `veg.systems` until the stored-instance count stops
changing (the documented 85 s only as the cap), and then takes the screenshots with `fps` and
`veg.at` at the course's judged viewpoints. When nothing answers it says why — Arborist not
running, the mod not loaded, or the memory gone — instead of timing out. See
[docs/gspro/arborist.md](../../docs/gspro/arborist.md), "The loop: one command". It never starts
Arborist or loads a course in it.

`call.ts` also exports its discovery for other scripts: `players()`, `player(app?)`, `playerDir()`.

## Memory

Arborist, Unity and GreenKeeper with the same course loaded do not fit in 48 GB together
(2026-10-11: Arborist died of out-of-memory at start while Unity held 22 GB). Close the others.
