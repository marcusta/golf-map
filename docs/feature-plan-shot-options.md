# Plan: Shot Options — alternative plan shots as variants of the same decision

**Status:** built 2026-07-17 — T28 `0f2e5c44` (tree API), T29 `6cc5062e` (planner authoring),
T30 `72d4c411` (chain EV + score chips), T32 `9c379e9c` (on-course consumption). Open per O4:
no Swift `scoreOptionChain` — authored options are unpriced on device until an on-course
consumer justifies the mirror. Briefs:
[delegation-briefs-oncourse.md](delegation-briefs-oncourse.md); reports in `docs/reports/`.
**Scope:** `server` (one additive migration + game-plans service/API), `shared/strategy` (option
chain scoring), `web/src/planner` (authoring + overlay), `ios` (consumption — see the round-loop
doc for the on-course UX).
**Related:**
- [feature-oncourse-round-loop.md](feature-oncourse-round-loop.md) — the consumer. Options are
  what the on-course "decide" moment picks between; authored options and engine-generated
  candidates render through the same UI.
- [decade-planner-strategy-engine.md](decade-planner-strategy-engine.md) — `optimizeAim` /
  `shotsToHoleOut` price each option; the par-5 attack chain (smart-caddy §5) is the same math
  this feature surfaces as authored content.

---

## 1. Purpose

Today a game plan is a strictly linear shot sequence per hole (`plan_shots.sort_order`). Real
strategy is often a **choice**: driver at the corner vs 4-iron short of the bunkers off the same
tee. The player wants to author both, see them priced against each other, and pick one on the
day — on the tee, based on wind, pin, and how they're swinging.

This feature makes a plan shot able to carry **alternatives**: options of the same decision, each
optionally with its own continuation (driver → wedge in; 4-iron → 7-iron in). The primary line
stays a linear chain so every existing consumer keeps working; options hang off it.

## 2. The core insight

1. **An option is a branch, not a flag.** "Driver vs 4-iron" differ not just in the one shot but
   in everything after it. Modelling options as sibling shots in a **tree** (each shot knows its
   parent) captures continuations for free; a linear plan is just the degenerate single-chain
   tree. Any flat "variant group" encoding would need a second concept the moment a continuation
   is planned.

2. **Options only earn their place if they're priced.** Two drawn lines are decoration; "driver:
   probable 4.2, 12% penalty — 4-iron: probable 4.5, 1%" is a decision. The engine already
   prices exactly this shape (the par-5 attack rule chains two-shot EVs; `optimizeAim` already
   returns the expectation, the CVaR₈₀ tail, and the per-lie sample breakdown); this feature
   generalises the chain evaluation to any authored branch and shows score + risk as a chip on
   each option.

3. **Authored options and engine candidates are the same thing at consumption time.** On course,
   the decide moment (round-loop doc §4) presents ranked choices; whether a choice came from the
   planner (authored) or from `optimizeAim`/layup enumeration (computed) is provenance, not a
   different UI. Locking this now prevents two parallel "alternatives" systems.

## 3. Data model (decisions to lock)

### O1 — Tree via `parent_shot_id`; sibling order is option rank; rank 0 is the primary

Additive migration `009_plan_shot_options.ts`:

```
plan_shots + parent_shot_id  TEXT NULL REFERENCES plan_shots(id) ON DELETE CASCADE
```

- `parent_shot_id NULL` = a first shot of the hole (origin = active tee). Multiple roots =
  options off the tee.
- `sort_order` is **reinterpreted as sibling order** among shots sharing
  `(game_plan_hole_id, parent_shot_id)`. Index 0 = the primary choice at that decision point.
  The **primary line** of a hole = follow rank-0 children from the rank-0 root; it is exactly
  the pre-migration linear chain.
- Backfill: for each hole, order existing shots by `sort_order`, set each shot's
  `parent_shot_id` to its predecessor (first shot keeps NULL), set all `sort_order = 0`.
  Round-trip property: primary-line extraction after backfill equals the old flat list.
- Leg index = depth in the tree (0 = tee shot). No stored leg column — derived.

### O2 — Delete semantics: splice by default, cascade for "delete option"

`removeShot` gains `mode: 'splice' | 'cascade'` (default `'splice'`):
- **splice** — children re-parent to the removed shot's parent, taking its sibling slot
  (preserves today's "remove a mid-chain point, chain heals" behaviour).
- **cascade** — the DB FK does the work; the whole branch dies. This is the planner's
  "delete option" action.

### O3 — `setPrimary(shotId)` is a sibling reorder, not a flag write

Promoting an option = rewrite `sort_order` within its sibling group so it becomes index 0 (same
idempotent pattern as `reorderShots`, which itself becomes sibling-scoped: the id set must match
one sibling group exactly). No `is_primary` column — one source of truth for rank.

### O4 — Option EV is a chain score computed client-side, never persisted

Consistent with "EV is derived" (DECADE §4.5). New pure function in `shared/strategy`:

```ts
scoreOptionChain(legs: ChainLeg[], ctx): {
    expectedStrokes: number;      // EV to hole out from the decision point
    tailStrokes: number;          // CVaR₈₀ over the same chain (D16 semantics) — the blow-up number
    penaltyProb: number;          // chain-aggregate: 1 − Π(1 − legPenaltyProb)
    perLeg: LegScore[];           // per-leg EV/tail/lie breakdown
}
```

- Each authored leg contributes its dispersion-aware EV where a club is set (reuse the
  `optimizeAim` machinery the overlay already runs per leg — its `breakdown` lie fractions give
  the leg's penalty/water/OB probability, its `tailStrokes` the leg tail), else the point
  estimate `1 + shotsToHoleOut(remaining, lie(landing))` with zero tail spread and zero penalty.
- Terminal: expected strokes from the chain's last landing to hole-out.
- **Presentation is "probable score", Arccos-style:** probable hole score = legs already behind
  the decision point + `expectedStrokes` (on the tee that is just `expectedStrokes`). The
  EV *difference* between siblings is the strokes-gained value of the decision — same number,
  two framings; the UI leads with probable score, risk beside it.
- The par-5 attack rule's two-shot chain is the reference behaviour; this generalises to depth n
  and both must agree on a shared fixture (expectation, tail, and penalty aggregation all
  pinned).
- A full hole-score *distribution* (P(birdie), P(double-or-worse)) needs Monte Carlo whole-hole
  simulation (the old T18 sketch) — explicitly not this feature; expectation + tail + penalty%
  is the v1 risk vocabulary.
- Swift mirror is **deferred** until the on-course option picker needs live re-pricing (T32 ships
  with EVs computed at plan-sync time being *absent*, showing authored options unpriced or with
  planner-cached labels — decide in T32; do not block on the mirror).

### O5 — Gates and hole fields stay hole-level

`plan_gates` are self-contained stations (absolute lat/lon + bearing); they do not reference
shots and need no branch association. A gate drawn for an option's corridor is just another gate;
if branch-scoped gates ever matter, that's a nullable `plan_gates.shot_id` later — explicitly not
now.

### O6 — API shape

- `addShot` gains optional `parentShotId` (append as last sibling of that parent; omitted =
  append to the primary line's tail — today's behaviour, so existing web/iOS callers keep
  working unchanged).
- `updateShot`, `reorderShots` (sibling-scoped per O3), `removeShot` (+`mode` per O2),
  `setPrimary` new.
- `getByCourse` returns shots flat with `parentShotId` (clients assemble the tree) — keeps the
  gen-client shape close to today's and the Swift decode additive/tolerant.
- `bun run generate` regen; iOS `GamePlanModels.swift` adds the optional field (absent = legacy
  linear plan).

## 4. Planner UX (web)

- **Add option:** select a shot → "Add alternative" → next click places the sibling's landing;
  it renders immediately as an option of that decision. Continuation shots are added by clicking
  with the option selected (`addShot(parentShotId: option)`).
- **Overlay** (`plan-overlay.ts`): primary line solid (unchanged); non-primary branches dashed
  and dimmed, with their dispersion ellipses at reduced opacity; each decision point with >1
  sibling gets **score chips** per option ("Dr · prob. 4.2 · 12% pen" / "4i · prob. 4.5 · 1%")
  from `scoreOptionChain`, tail on hover/expand, recomputed on the existing enrich cadence
  (shot-place / drag-release, never per drag frame).
- **Panel** (`planner-panel.component.ts`): shots list groups siblings under the decision point;
  actions: set primary, delete option (cascade), label each option (existing `label` field —
  "safe line" / "attack line").
- **Selection/drag semantics** unchanged per shot — an option shot is a normal shot that happens
  to have a sibling.

## 5. On-course consumption (summary — details in the round-loop doc)

The leg card shows the primary choice; when the current decision point has siblings, option chips
appear (label + club + EV). Tapping one makes that branch the **active line for this round** —
transient round state, never a plan mutation (the plan is the author's; the day's choice is the
round's). Divergence/replan then tracks against the active line.

## 6. Explicitly out of scope

- Conditional/rule-based branch selection ("if wind > X play B") — the player picks; the engine
  prices. Revisit only if real usage begs for it.
- Branch-scoped gates (O5), per-shot notes, plan version history.
- Persisting chosen options or EVs server-side.
- Swift `scoreOptionChain` mirror before an on-course consumer exists (O4).
