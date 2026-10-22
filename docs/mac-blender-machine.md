# The Mac as a second machine (Blender worker first)

Marcus's MacBook Pro (M1 Pro, 32 GB, macOS) is the first extra machine beside the Windows box
(`D:\golf-map`, which keeps GSPro, Unity 2018, Arborist, GreenKeeper and the web/server). This file is the
brief for the Claude session on the Mac: set it up, then take the roles below in order.

## Roles

| # | Role | Why the Mac | Status |
|---|---|---|---|
| 1 | **Blender shaping worker** (`blender/tools/shape_worker.py`) | One worker per machine is the bottleneck (docs/shaping-queue.md, a 40-60 min Omberg load, 6.6 GB). A second worker lets two courses shape at once and frees RAM/CPU on Windows while GSPro is measured. | to set up |
| 2 | **Code sessions** (server, web, shared, pipeline Python, blender pure-Python tests) | Offloads agent CPU from Windows. `node` exists here, so Playwright e2e (`bun run e2e`) runs — it cannot on Windows. No symlink/`\` path failures in `server` tests. | after 1 |
| 3 | **iOS app** (`ios/`) | Xcode and the Simulator only run on a Mac (ios/AGENTS.md). | when iOS work resumes |
| 4 | OPCD cloud build (`bun run opcd:build`) | Playwright runs under plain Node here. The `.blend` it saves must land in the Windows export folder (share). | optional |

Stays on Windows: GSPro, Unity 2018.2 + the `unity` MCP bridge, Arborist, GreenKeeper, the SAM server (CUDA),
the live `data/app.sqlite` and the server the web UI talks to.

## 1. Base setup (once)

1. Xcode command line tools (`xcode-select --install`), Homebrew, then `brew install git bun python@3.11 zstd`.
2. Clone: `git clone https://github.com/marcusta/golf-map.git ~/golf-map`, then `git checkout unity-course-context`
   (the working branch; it must be pushed from Windows first — only `main` is on origin as of 2026-10-22).
   `bun install` at the repo root.
3. Claude Code on the Mac: open `~/golf-map` as the project. The Windows memory notes do not travel; the repo's
   AGENTS.md files do. Read AGENTS.md (the "This machine" section is the Windows box, not this one).
4. `.env`: copy the keys from the Windows `.env` by hand (Lantmäteriet, Trafikverket, publish). Never commit it.
5. Pipeline venv only if role 2 needs it: `cd pipeline && python3.11 -m venv .venv && .venv/bin/pip install -r ...`
   (pipeline/AGENTS.md). `bun run py` finds `.venv/bin/python` here without the Windows junction.

## 2. Blender worker

### Install

1. Blender **4.5 LTS** for Apple Silicon (blender.org). Same version as Windows: the op cache keys on code, and a
   different Blender can move vertices.
2. Add-ons — copy the folders from Windows `%APPDATA%\Blender Foundation\Blender\4.5\extensions\user_default\`
   to `~/Library/Application Support/Blender/4.5/extensions/user_default/`: OPCD Mesh Editing Tools 3.5.8
   (+ Afrod panel), Bunker Studio 0.11.5, Shoreline Studio 0.5.5. Enable them once in the UI. Afrod's
   third-party recipes: copy the folder and set `GOLFMAP_AFROD_RECIPES` (blender/AGENTS.md).
3. Smoke test, headless:
   `/Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup --python-exit-code 1 --python blender/tools/shape_region_test.py`
   plus the other `*_test.py` in blender/tools (blender/AGENTS.md lists them).

### Files the worker needs

The worker opens three paths it is given: the course `.blend` (and writes `<blend folder>/shaping-staging/`,
the conform + op caches), the layers folder `docs/gspro/<course>/shaping`, and the FBX folder
(`<Unity project>/Assets/fbx` on Windows). Plan:

- **`.blend` + `shaping-staging/` local on the Mac** (e.g. `~/gspro_courses/omberg-opcd/`), copied from
  `D:\gspro_courses\<course>-opcd\`. The caches are large and hit hard; over SMB they would be slow. Copy
  `shaping-staging/` too, or the first load is cold (40-60 min on Omberg).
- **Layers and FBX folder over SMB from Windows.** The web Terrain editor writes the layers on Windows
  (uncommitted), and Unity reads the FBX there. Windows shares `D:\golf-map\docs\gspro` and the Unity
  projects' `Assets\fbx`; the Mac mounts them (Finder › Connect to Server `smb://<windows-host>/...`,
  under `/Volumes/...`).
- After each new OPCD build, the new `<prefix>_svg_<n>.blend` (and its `-shapes.json`) must be copied to the
  Mac before the worker loads it.

### Run

Start it detached so closing Claude does not kill it:
`bun run shaping:worker -- --blend <mac .blend> --layers <mounted layers dir> --fbx-folder <mounted fbx dir> --port 8766`
with `GOLFMAP_SHAPING_HOST=0.0.0.0` and `GOLFMAP_SHAPING_TOKEN=<shared secret>` in its environment
(`server/services/detached-process.ts` uses an unref'd spawn off Windows; check it survives quitting Claude,
else use `nohup` or a launchd agent). macOS asks once to allow incoming connections for Blender — allow it.

On Windows, a run against the Mac worker:
`GOLFMAP_SHAPING_URL=http://<mac>.local:8766 GOLFMAP_SHAPING_TOKEN=<secret> bun run shaping -- <course>`.

### Open item: paths are seen from two machines

`ShapingService` (server/services/shaping.service.ts) sends the worker paths and also checks some itself
(`GOLFMAP_SHAPING_BLEND` must exist on the server, line ~950; the FBX folder comes from the Unity editor's
project path, a `D:\` path). A Mac worker cannot open `D:\...`. Needed: a prefix map for paths sent to a
remote worker (e.g. `GOLFMAP_SHAPING_PATH_MAP="D:\gspro_courses=/Users/marcus/gspro_courses;D:\golf-map\docs\gspro=/Volumes/gspro-docs"`),
applied only to the request bodies, with the server's own checks on the Windows side of the map. Build it in
the Windows repo (it is server code, tested there), then try one `/load` + a dry-run `/sync` against the Mac.

### First measurement

Before moving a course to the Mac for good: load the same course on both machines from warm caches and compare
`/status` job `seconds` for the load and for a one-layer `/sync`. bpy is single-threaded, so single-core speed
decides. Do it while GSPro is not being measured on Windows.

## 3. Rules that carry over from the Windows box

- Never `POST /shutdown` a worker you did not start; one sync at a time per worker.
- Editing `shape_apply.py` / `shape_layers.py` invalidates the whole op cache — on both machines.
- Code edits are made in one tree and committed; the other machine pulls. Do not edit the same files on both
  machines at once. Commit messages in English, no `Co-Authored-By` lines (AGENTS.md "Git").
- Chat with Marcus in Swedish; everything in the repo in English.
