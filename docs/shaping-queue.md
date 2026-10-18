# Shaping queue: one Blender run for many requests (design, 2026-10-18)

Status: built 2026-10-18 (`server/services/shaping-queue.ts`, `ShapingService.apply`, the CLI, the web's
Update meshes). Live test on Omberg, 2026-10-19: three `--dry-run` CLI processes started 10 s and 12 s
apart gave two runs, A on its own and B + C together, all done in ~34 s each (most of it the 30 s
Unity probe, as the editor was busy).

## Problem

There is one Blender shaping worker per machine. Every `bun run shaping -- <course>` builds its own
`ShapingService` in its own process (scripts/shaping-apply.ts runs without the server), so N agents that
finish a change at about the same time start N full chains. Each chain regenerates the layers, waits for
the worker to be idle, syncs, refreshes Unity and replants grass if a slab changed. The waits only see the
worker's `/status`. Two waiters that see it idle at the same moment both POST `/sync` and one gets a 409.
Every agent then reads the whole run's report and has to work out which part is its own.

Most of a run's input comes from the database: `gspro.py shaping-global` writes `00-global.gen.json` and
`10-features.gen.json` from the course's features and terrain edits at the start of the run. **A run
covers every change saved before it starts.** So the agents waiting behind a run need ONE more run
between them, not one each.

That also means a batch cannot leave one agent's change out (it is already in the database), so there is
no bisecting by request. A failure is attributed by area instead (below).

## Design

### The queue (shared by the server and every CLI process)

State lives in files under `<data>/shaping-queue/` (`DATA_DIR`), so the web server and CLI processes with
no server share it:

- `requests/<id>.json` - one per call: `courseId`, `note` (one line: what the caller changed), `region`
  (EPSG:3006 box) and/or `featureIds`, the flags (`dryRun`, `paths`, `save`, `skipUnity`), `createdAt`,
  `pid`, `state` (`queued` | `running` | `done`), `runId`.
- `lease.json` - the process that runs the queue: `pid`, `startedAt`, `heartbeat` (every 10 s). Taken by
  an exclusive create; stale when its pid is gone or the heartbeat is older than 2 min, and then the next
  waiting process takes it over.
- `runs/<runId>.json` - the run's `ShapingJob` snapshot (phases, step), rewritten at every phase change.
  When the run is done it also holds the result and one slice per request.

A caller writes its request and then tries to take the lease. With the lease it becomes the runner and
runs batches until nothing is queued, then releases the lease. Without the lease it polls its request
file (1 s) and shows the run's phases from `runs/<runId>.json`. Whichever agent comes first does the work
for everyone behind it.

### A batch

- All queued requests for one course with the same kind: dry runs go together and real runs go together.
  `paths` and `save` are on when any request asks for them. `skipUnity` is on only when every request
  asks for it.
- Course order: first the course the worker already holds (so the worker does not keep reloading between
  courses), then the course with the oldest request.
- One `perform` as today: layers, worker, Blender, Unity, vegetation.

### Each request's slice of the result

- `places` (the worker's `changedPlaces`, with `bounds.epsg3006` and `featureIds`) that intersect the
  request's region, grown by 5 m, or that name one of its `featureIds`. The changed objects are those
  places' `objects`, and the warnings are those that name one of them. A request with no region and no
  features gets the whole report.
- **Overlap:** another request in the same batch whose region intersects this one shows up as one line:
  "also changed here in this run: <its note>".
- **Failure:** the whole batch fails. Every request gets the error and the notes of the other requests
  in the batch, so the agent whose change broke it can recognise it. A failed sync carries no place, so
  there is no "in your area" yet. There are no automatic retries.

### Entry points

- `ShapingService.apply(courseId, opts)` takes `note`, `region` and `featureIds` and queues instead of
  answering 409. It returns the request as a job: `id` is the request's, `runId` names the run that
  serves it, `queued` is true while it waits (`status` stays `running`, `step` says what it waits behind),
  and `slice` is its part once the run is done. `job(id)` follows it. A request served by another
  process's run is read from that run's file.
- **CLI:** `bun run shaping -- <course> [--note "..."] [--region x0,y0,x1,y1] [--feature <id>]...
  [--dry-run] [--paths]` (a feature's box joins the region). The output is the same as before, plus the
  queued line while it waits and a "Your part" block at the end. A process that took the lease finishes
  the batches queued behind it before it exits. Exit 1 when the run failed.
- **Web:** Update meshes (this feature) sends the selection as `featureIds`; the button reads "Waiting for
  Blender…" while the request is queued. Not built yet: the command bar line
  `Blender: running 3 · 2 waiting`.
- **GSPro board:** its `meshes` chain calls `apply` as before; the wait for another course's run
  (`runningAnywhere()`) still sees only the server's own runs, and the queue does the rest.

## Around the queue (later steps, not built)

These fit the agent model Marcus wants: one coordinator agent he talks to turns his wishes into Beads
(steveyegge/beads, `bd`) and schedules sub-agents to work them. The coordinator decides what is done and
in what order. Mechanical queues, not the coordinator, decide who uses the worker and the Unity editor.

### The Unity editor lease

The editor is single-threaded and an agent's work in it is often interactive (placing props, tuning
materials, screenshots), so it cannot be batched the way a Blender run is. Instead it gets a lease:

- `<data>/unity-lease/<project>.json`: holder (`pid`, `note`/bead id), `since`, `heartbeat`, and a
  maximum hold of 10 min, renewed by the holder's own calls. It is stale the same way as the queue's
  lease.
- Every bridge call (`unity-bridge.ts` `editor.run`, and the Unity MCP server's commands) runs under the
  caller's lease when it holds one. Otherwise it takes a lease for that one command, waiting while
  someone else holds it. The shaping run takes the lease for its Unity and vegetation phases.
- **C# pushes are coalesced** like the Blender runs. A `unity_sync push` that comes while a compile is
  going joins the next push, so N agents' script changes cost one domain reload, not N.

### Questions to Marcus, and what he sees

- A bead has two steps. **Edit**: database features, layer specs, Blender scripts tested on Vreta or a
  copy, C# code; any number of agents in parallel, on disjoint files. **Integrate**: a queue request
  whose `--note` is the bead id; the agent reads its slice, verifies it and closes the bead.
- A sub-agent that needs Marcus writes the question into its bead (label `needs:marcus`, status blocked),
  releases every lease and stops. It never waits on him while holding the worker or the editor. The
  coordinator collects the open questions, asks them in one go, writes the answers back and schedules
  the bead again.
- A Claude mod (a live pane plus a band above the prompt) shows, in a few words:
  - the Blender queue: running, and how many waiting;
  - who holds the Unity editor;
  - the beads in progress;
  - how many questions are waiting for Marcus, as one count he can click.

  It reads the queue files, the lease files and `bd ... --json`.

## Not in this step

- A Unity top-down capture cropped to each request's region: no command for it exists yet
  (`unity_screenshot` takes a camera view). It would come as `golfmap.capture.region`.
- The Unity lease, Beads, the coordinator skill and the mod (above).
- A second worker for previews.

## Expected effect

N agents that finish within one run's length: 2 runs instead of N. No 409 races. Each agent reads only
its own part.

## Tests

- **Service (synthetic worker and Unity, as in shaping.service.test.ts):**
  - Three requests while a run is going become one next run, and each gets its slice.
  - A dry-run request and a real one land in separate batches.
  - When the lease holder dies, a waiter takes over.
  - Overlap lines appear for overlapping regions.
  - A failure is attributed "in your area" or to another request.
- **Vreta:** two CLI processes started a few seconds apart, each with its own feature change in a
  different area. Expected: one run serves both, both get their own slice, and Unity is refreshed once.
