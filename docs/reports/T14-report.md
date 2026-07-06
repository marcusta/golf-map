# T14 — Strokes-gained computation + follow-up analytics view

## Files touched

**New (shared/strategy — pure core, my lane per brief):**
- `shared/strategy/strokes-gained-round.ts` — `RecordedStroke`/`HoleRound` input types,
  `holeStrokesGained`, `categorize`, `distanceBand`, `aggregateStrokesGained`, `roundStrokesGained`.
- `shared/strategy/strokes-gained-round.test.ts` — hand-computed fixtures.

**Edited:**
- `shared/strategy/index.ts` — added the new module's exports (my lane; nothing else in this file
  touched).

**New (web — adapter + follow-up analytics view):**
- `web/src/rounds/round-sg.ts` — `RoundWithShots` → `HoleRound[]` adapter (projects lat/lon via
  `geo/transform.ts`, classifies lie via the recorded override or `planner/lie-map.ts`'s
  `buildLieMap`).
- `web/src/rounds/round-sg-table.ts` — pure row-shaping for the distance-band/category/total
  tables (no DOM).
- `web/src/rounds/round-sg-panel.component.ts` — the headline distance-band SG table view (+
  category breakdown + round total), self-contained `Component<{ summary: RoundSgSummary }>`.
- `web/tests/round-sg.test.ts` — adapter tests (projection correctness, tee/lie-override rules,
  hole/round grouping, end-to-end sanity check against the pure core).

No other files modified. Did not touch `expected-strokes.ts`, `lie.ts`, `aim.ts`, anything under
`web/src/planner/`, or `shared/strategy/caddy/`.

## Verbatim results

`bun test shared/strategy/` (from repo root):
```
bun test v1.3.11 (af24e281)

 171 pass
 0 fail
 2290 expect() calls
Ran 171 tests across 17 files. [137.00ms]
```
(includes the caddy subtree; my own file's slice: 12 tests, all pass.)

`cd web && bun test` (full web suite):
```
bun test v1.3.11 (af24e281)

 455 pass
 0 fail
 2491 expect() calls
Ran 455 tests across 29 files. [174.00ms]
```

`bunx tsc --noEmit -p web/tsconfig.json` (from repo root):
```
web/src/planner/planner-tool.service.ts(497,25): error TS2304: Cannot find name 'caddyLegKind'.
```
This is the **only** typecheck error, and it is entirely inside `web/src/planner/planner-tool.service.ts`
— a file this brief explicitly forbids touching. Confirmed pre-existing and NOT caused by this
task: `git diff --stat web/src/planner/planner-tool.service.ts` shows local uncommitted changes to
that file already present before I started (44 insertions / 4 deletions vs. HEAD, HEAD itself has
neither `caddyResult` nor `computeCaddyAdvice`/`caddyLegKind`). The specific missing-name error
even changed identity between two of my own typecheck runs minutes apart (`caddyResult`/
`computeCaddyAdvice` → `caddyLegKind`), meaning another task/process is actively editing that file
concurrently in this workspace. `grep -i "rounds/"` over the tsc output returns nothing — zero
errors originate from any file I touched.

## SG input type shape (core)

```ts
export interface RecordedStroke {
    position: { x: number; y: number };   // projected meters, caller's job
    lie: Lie;                              // caller classifies; first stroke = 'tee'
    penaltyStrokes: number;
    shotType: 'full' | 'partial' | 'putt' | 'recovery';
}

export interface HoleRound {
    par: number;                           // only used to gate the off-tee category
    strokes: readonly RecordedStroke[];    // stroke 0 first, last stroke holes out
    hole: { x: number; y: number };        // pin or green-centre, projected meters
}
```

`holeStrokesGained(round: HoleRound): ShotSg[]` computes, per §5 exactly:
```
d_i   = ‖p_i → hole‖
sg_i  = shotsToHoleOut(d_i, lie_i) − shotsToHoleOut(d_{i+1}, lie_{i+1}) − 1 − penaltyStrokes_i
```
with the last stroke's "next" state modeled as distance 0 (`shotsToHoleOut(0,·) = 0`, D20 — lie is
irrelevant there since the boundary check short-circuits before touching the lie table).
`aggregateStrokesGained`/`roundStrokesGained` fold a flat `ShotSg[]` (or multiple holes) into
per-round / per-category / per-distance-band `SgBucket` (count, total, mean).

## Category and distance-band boundaries used

**Categories** (§5 exact wording, resolved to a total function in `categorize()`):
1. `off-tee` — stroke index 0 **and** `par >= 4`.
2. `putting` — `shotType === 'putt'` (checked after off-tee, so a par-3 ace-attempt tee shot that
   happens to be typed `'putt'` — doesn't happen in practice — would still not be `off-tee`; order
   only matters for the documented par-3 edge case below).
3. `short` — not a putt, `distanceM < 30`.
4. `approach` — everything else (not a putt, `distanceM >= 30`; this is also where a par-3 tee shot
   lands — see "Open concerns").

**Distance bands** (half-open, chosen to match §5's "120–160 m" example style and common
strokes-gained reporting conventions; not otherwise specified in the docs, so this is my choice):
`0-30m` (`< 30`), `30-100m` (`< 100`), `100-150m` (`< 150`), `150-200m` (`< 200`), `200m+`
(`>= 200`). The 30 m boundary matches the `short`/`approach` category split so the two views agree
at that edge.

## Where the follow-up view lives

No `follow-up`/`analytics` directory existed under `web/src` (checked; `analysis/` is the existing
green-slope DEM analysis tool, unrelated). Per the brief's fallback instruction, created a new
sibling module `web/src/rounds/` (mirrors the naming of `courses/`, `player/`, etc.):
- `round-sg.ts` (adapter, pure — no DOM/DI)
- `round-sg-table.ts` (pure row-shaping, no DOM)
- `round-sg-panel.component.ts` (the actual rendered table)

## Deviations from the brief

1. **Component has no DI service / router wiring.** Every existing `.component.ts` in this
   codebase is wired through a DI-registered `*.service.ts` singleton and mounted via the app
   router (`app.component.ts`/`Router`). Building that full chain (a `RoundsService`, a route,
   nav entry) was not asked for by T14 ("a distance-band SG table view") and would have meant
   touching shared app-shell files outside this task's declared scope. `RoundSgPanelComponent`
   instead takes `RoundSgSummary` as a **plain constructor prop** (`Component<P>` supports this
   natively — see `core.ts`'s `constructor(protected readonly props: P)`), so it is fully
   self-contained and can be `spawn()`ed/mounted by whichever task wires up the actual
   round-review page. Flagging this explicitly since "self-contained module" was the brief's own
   fallback language, but the no-DI shape is a step further than the codebase's norm and a
   reviewer may want it turned into a proper service+route.
2. **Hole position uses green centre only, not "pin if recorded for the round's date."** §5 defines
   the hole position as pin-if-available-else-green-centre. There is no round-dated pin lookup
   anywhere in the codebase yet (`pins.gen.ts` has no date-scoped query), so `round-sg.ts` always
   uses the green centre. Documented in the adapter's header; the pure core is agnostic to how the
   caller chose the hole position, so this is a pure adapter-level simplification, easy to extend
   later.

## Open concerns for the reviewer

- **§5 under-specifies the par-3 tee-shot category.** "off-tee (stroke 0, par 4/5)" explicitly
  excludes par 3, but doesn't say what a par-3 tee shot's category IS. I resolved it as: falls
  through to `approach` or `short` by distance like any other full/partial swing (a typical par-3
  tee shot is `full`, `>= 30 m`, so in practice it becomes `approach`). This means a round's
  `approach` bucket is a mix of "par-4/5 second shots" and "par-3 tee shots," which may or may not
  be the intended read for the headline table. Flagging for explicit sign-off rather than guessing
  further — easy to add a fifth category (`tee-par3` or similar) if the reviewer wants tee shots
  kept separate regardless of par.
- **Distance-band boundaries are my invention** — §5 names the concept ("the distance-band table is
  the headline view") but never states the bands. Chosen 0-30/30-100/100-150/150-200/200+ for
  round-number simplicity and alignment with the short/approach split; not sourced from any doc.
  Easy to change (`distanceBand()` is one small pure function) if the reviewer wants different cuts
  (e.g. finer bands inside 100–200 m, which is where most strokes-gained-approach nuance lives).
- **Last-stroke-with-a-penalty is a degenerate but accepted input shape** (tested): if the final
  recorded stroke itself carries `penaltyStrokes > 0` (e.g. player picked up / conceded after a
  lost ball with no further stroke recorded), the formula still subtracts the penalty from that
  stroke's SG even though it's also treated as holing out. This seems like the correct reading of
  §2/§5 (penalty is a property of the stroke, independent of whether it's the last one) but is an
  edge case the docs don't call out explicitly.
- **`planner-tool.service.ts` typecheck error is pre-existing/concurrent, not mine** — see the
  verbatim results section above for the evidence trail (git diff, HEAD comparison, and the error
  changing identity between two of my own tsc runs). Not fixed, per the constraint against
  touching that file.
