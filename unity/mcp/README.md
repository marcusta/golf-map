# Unity MCP bridge

Lets an agent drive an open Unity editor for any GSPro/OPCD course project: sync the repo's
scripts in, recompile without focusing Unity, run menus and tooling, read the console, query
the scene and take Scene-view screenshots. Built for Unity 2018.2 (C# 6), where none of the
public Unity MCP packages run.

```
agent ──stdio MCP──▶ unity/mcp/server.ts ──HTTP 127.0.0.1──▶ GolfMapBridge (inside each open editor)
                         │                                     └─ [BridgeCommand] methods from any script
                         └─ unity_sync: files repo ⇄ project (unity/install.json)
```

## Pieces

| | |
|---|---|
| `unity/Editor/GolfMapBridge/` | The editor side. Course-agnostic, installs into any project under an `Editor` folder. `[InitializeOnLoad]` starts an `HttpListener` on the first free port in 8765–8784, runs commands on the main thread (one step per editor frame for long ones), and captures the console and compiler messages (both survive recompiles through `SessionState`). Menu: `GolfMap > Bridge > Status / Restart`. |
| `unity/Editor/GolfMap/GolfMapBridgeCommands.cs` | GolfMap's own commands (`golfmap.course`). Course tooling adds commands here or next to its scripts. |
| `unity/mcp/server.ts` | Dependency-free stdio MCP server (bun). Registered as `unity` in the repo's `.mcp.json`. |
| `unity/mcp/bridge.ts` | Finds editors, calls commands, follows a refresh through compile and domain reload. |
| `unity/mcp/build-status.ts` | Reads a course build's progress file off disk, for when the editor is inside OPCD's builder and answers nothing. `bun unity/mcp/build-status.ts [project]`. |
| `unity/mcp/sync.ts` | Three-way file sync between the repo and a project, driven by `unity/install.json`. |

Discovery: each editor writes `%LOCALAPPDATA%\GolfMapBridge\bridge-<pid>.json` (port, token, project
path). Every request carries that token, so a web page can't reach the bridge by guessing the port.
Several projects can be open at once. Tools take `project` (a folder name or path substring) and
default to the only open editor.

## Tools

| Tool | Use |
|---|---|
| `unity_editors` | Open editors and their state. |
| `unity_status` | Scenes (dirty?), compiling, busy command, selection, Scene view pose, console position; `courseBuild` when a `golfmap.course.build` is running or lately finished (read from its file, so it shows while the editor is inside the builder). |
| `unity_sync` | `check` / `push` / `pull` against the project, then recompile and report errors. |
| `unity_compile` | Refresh + recompile + errors, after editing assets or files directly in the project. |
| `unity_console` | Console since a sequence number, filtered by type/text; `clear`. |
| `unity_menu` | Run a menu item (returns the console output it caused), or list script menus under a prefix. |
| `unity_screenshot` | The Scene view's own render target (`mode: view`, default) or a fresh camera render (`mode: camera`); never screen pixels, so it works while Unity is covered. Pose via `from`/`at` (+ `eye` metres above the visible ground) or `pivot`/`rotation`/`size`; `warmup` frames pan the view by a hair so VSP redraws. The view stays where it was moved unless `restore: true` puts its pivot, rotation, size and orthographic flag back after the capture (the result then says `"restored": true`). |
| `unity_scene` | `find` objects by name/component, `inspect` serialized fields, `select` for the user. Saving has no tool of its own: `unity_command scene.save` saves the open scenes that are dirty. Paths look like `/VegetationStudioPro/VegetationSystemPro#1`: `#n` picks among siblings with the same name. |
| `unity_command` | Any registered `[BridgeCommand]`; no name lists them. |

## Course exports and imports

The exports the Unity tools read come from the app's GSPro Export panel, or from the command line
through the same service (no server or login needed): `bun run gspro:export -- courses | status
<course> | <course> <kind[:inner|:outer]>...` (`scripts/gspro-export.ts`; kinds `svg ortho
outer-ortho dem hillshade trees buildings zones`). Imports on the Unity side are bridge commands:
`golfmap.zones.check` and `golfmap.zones.import` (`terrain: inner|outer`) run the Vegetation Zones
window's own steps headless. Zones and zone-type item bindings are authored with `bun run zones --
types|list|add|set|remove|bind` (`scripts/vegetation-zones.ts`, the web editor's services). Grass
palettes: `golfmap.grass.apply`; the course's surface map from its meshes: `golfmap.surfaces.export`
(see the `grass-planting` skill). Other helpers: `editor.tick` (pump the editor as
if panned), `terrain.height`, `golfmap.vsp` (VSP systems, cameras, packages, items).

## Sync rules

The repo is the source of truth, but the Unity copy is sometimes edited in place. The sync keeps a
base (content hash per file as of the last sync) in `<project>/Library/GolfMapBridge/sync-state.json`:

- repo changed since the base → `push` copies it; Unity changed → `pull` copies it back;
- both changed, or no base yet and they differ → **conflict**: merge in the repo, then `push` + `force`;
- CRLF vs LF and a BOM are not differences (git's autocrlf makes the repo CRLF, the Unity copy is LF);
- `.meta` files are Unity's and never touched; deletions are reported, never propagated.

## New course project

1. `unity_sync` with `projectPath: "D:/gspro_courses/<project>"`, `mode: "push"` installs the bridge
   and the GolfMap scripts while the editor is closed (or before the bridge is in it).
2. Open the project in Unity (or click into it once): it compiles and the bridge starts. From then
   on `unity_sync` / `unity_compile` recompile without focusing Unity.
3. `unity_menu` `GolfMap/Course/New course for this scene` (or adopt), then `unity_command golfmap.course`.

## Adding a command

```csharp
using GolfMap.Bridge;

static class MyCommands
{
    [BridgeCommand("golfmap.something", "What it does.", args = "name, count=3")]
    static object Something(BridgeArgs a)        // or no parameters
    {
        var name = a.Require("name");
        return new Dictionary<string, object> { { "name", name }, { "count", a.Int("count", 3) } };
    }

    // Long work: return an IEnumerator; yield null per frame, yield the result to finish.
}
```

Throw `BridgeError` for a caller mistake (message only). Other exceptions return their stack. A
command that opens a modal dialog blocks the main thread until the user answers it; the MCP call
returns "still running" and the job keeps going. Add new bridge files to `unity/check-planter.ps1`.

**Every command must be idempotent** (ours are: sync and refresh steps re-read the scene and the
exported files and do only what is still missing), because two robustness retries run a command a
second time on their own:

| Retried when | Where | Shows as |
|---|---|---|
| The command's `AssetDatabase.Refresh()` set off a script reload, so the job died with the domain ("Unknown job (jobs do not survive a script reload)" / "The editor is reloading scripts; call again") - the known "`course.refresh` returned null right after `meshes.sync`" | `bridge.ts` `call()`: waits up to 90 s for the bridge to answer and the editor to be idle (`waitForBridge`), then submits the same command once | `retried: true` on the response and in the result, plus a stderr line from `run()`. A second failure surfaces as itself. |
| The command threw VSP's "previously scheduled job ... JobHandle.Complete()" | `BridgeServer.Fail`: runs `golfmap.vsp.reset` through the registry, then the command once | `vspReset: true` with `vspResetAfter` / `vspResetResult` (see [unity-gotchas.md](../../docs/unity-gotchas.md)) |

Both retry **once per call**; neither retries a command that is still pending.

## Tests

`bun test unity/mcp/`: sync rules against temp folders, the client against a fake bridge (including
the lost-job retry), and the course build's progress file.
