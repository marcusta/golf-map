# README notes: the conform cache and the conformed cache's staleness

Notes for the orchestrator to merge into [README.md](README.md) — "The per-mesh conform cache" and
"Shaping worker". Another agent holds README.md, so they live here for now.

## Into "The per-mesh conform cache"

**Key.** Two more things are in it, both of them silent staleness before:

- **Every conform target's state hash** (`shape_prepare.target_fingerprints`, `CONFORM_TARGETS` =
  `Outer`, `Terrain`). The Shrinkwrap's result is decided by the object it projects onto, and an
  Outerplot mesh projects onto `Outer`, which OPCD builds *inside* the `.blend` — the terrain OBJ's
  content hash says nothing about it, so a regenerated `.blend` with a new outer plot was served the old
  results. Vreta has no `Outer` (`conform targets Outer -, Terrain 07f70b941617` in the summary), so
  this costs it only the Terrain hash: **4.8–4.9 s** per run, the one new cost in the table below.
- **The mesh's modifier stack** (names + types). `capture_state` cannot see modifiers and the conform
  clears them before flattening, so two inputs that differ only in their stack hashed the same.

**Hit.** A hit now does the two things the operator's own per-object body does and the replay did not:

- it **clears the mesh's modifiers**, as `flatten`/`project` are preceded by `if o.modifiers:
  o.modifiers.clear()`. A mesh that arrived with a modifier used to keep it through a hit, so the hit
  and the miss left different objects behind (`cache.modifiersCleared` counts them);
- it adds the **`fixed` count stored with the result** — how many vertices Afrod's retry nudged when the
  result was computed — into the report, so `fixFailedProjections` on a warm run is what the cold run
  said (`cache.fixedHits` counts the results that carried one). The nudged positions and the `TempFix`
  vertex group were always replayed; only the count was lost, and the report was quietly wrong.

**Terrain sidecar.** Every run — cache or not — now writes `<name>.conformed.terrain.json`
(`golfmap-conformed-terrain-v1`): the content sha of the terrain.obj the conformed `.blend` holds, plus
the conform-target hashes. The report gained `terrainSha`, `terrainSidecar` and `conformTargets`; the
cache block gained `targets`, `targetHashS`, `fixedHits` and `modifiersCleared`.

Vreta `vreta_svg_1988.blend` (996 Spline meshes, 4.11 M vertices, 644 MB OBJ, 51 MB of cache), with the
target hash in the key:

| run | import | conform | total | cache |
|---|---|---|---|---|
| cold, empty cache | 5.4 s | 151.4 s | **160.6 s** | 0 hits, 996 misses (hash 7.4, targets 4.9, compute 128.9, store 9.0) |
| warm, same `.blend` | 5.6 s | 18.4 s | **25.9 s** | 996 hits (hash 7.2, targets 4.8, replay 4.9) |

Both runs' reports agree on `fixFailedProjections` (`{objects: 0, vertices: 0, byObject: {}}`),
`failedObjects`, `failures` and `unchanged`, and all **1039 mesh objects hash identically** to each
other and to the existing `vreta_svg_1988.conformed.blend` (built by the Conform All button).

Vreta cannot exercise any of this (nothing fails to project, no mesh arrives with a modifier, no
`Outer`), so there is a synthetic headless test — a tilted `Terrain`, a flat `Outer`, a Spline mesh
hanging off the terrain, an `Outerplot` mesh — over one cache:

```powershell
& 'C:/Program Files/Blender Foundation/Blender 4.5/blender.exe' -b --python-exit-code 1 --python blender/tools/shape_prepare_cache_test.py
```

## Into "Shaping worker"

`/load` re-prepares when `shape_worker.conformed_stale(source, conformed)` says so, which is now three
inputs instead of one:

- the conformed `.blend` is missing;
- the source course `.blend` is newer (OPCD regenerated it — which also covers `Outer`, since that
  object lives in the source file);
- **`terrain.obj` holds other bytes than the ones the cache was conformed against.** `terrain_obj.py`
  rewrites it from every DEM export, so its mtime moves on its own and a mtime test would re-conform the
  whole course for nothing; the sha in `<name>.conformed.terrain.json` (or `terrainSha` in the prepare
  report next to it) is what is compared. Only a conformed `.blend` that never recorded a sha falls back
  to the mtime. Before this, a regenerated terrain was *never* noticed: the course kept being shaped
  against the old heights.

The `prepared` block of a `/load` result gained `stale` (why it re-prepared) and `terrainSha`.

```powershell
& 'C:/Program Files/Blender Foundation/Blender 4.5/blender.exe' -b --factory-startup --python-exit-code 1 --python blender/tools/shape_worker_stale_test.py
```

On the real files, the existing `vreta_svg_1988.conformed.blend` (no sidecar, a report from before the
field) stays valid: terrain.obj is older than it, so the mtime fallback says "not stale" and nobody pays
a 2.5-minute conform for this change.

## Into AGENTS.md's layout table

The `tools/shape_prepare.py` row says the cache is "keyed on the mesh's pre-conform state + the
terrain's content hash" — it is now also keyed on the mesh's modifier stack and on the state of every
conform target (`Outer`, `Terrain`), and it writes `<name>.conformed.terrain.json`. Two new rows:

| `tools/shape_prepare_cache_test.py` | Headless (OPCD add-on, no `--factory-startup`): the per-mesh conform cache on a synthetic four-object course — what the key covers (conform targets, modifier stack) and what a hit restores (modifiers cleared, the retry count in the report). |
| `tools/shape_worker_stale_test.py` | Headless, files only: `shape_worker.conformed_stale` — the conformed cache against its source `.blend` and against terrain.obj's content sha. |
