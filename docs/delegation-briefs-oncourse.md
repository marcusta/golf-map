# Delegation briefs — plan options + on-course round loop (T28–T36)

**Written 2026-07-17.** Implements [feature-plan-shot-options.md](feature-plan-shot-options.md)
(decisions O1–O6) and [feature-oncourse-round-loop.md](feature-oncourse-round-loop.md) (R1–R8) —
read the relevant spec FIRST; do not re-open O/R decisions or the strategy register D1–D27.

**Model tiers this wave** (capability order: **Fable** highest, then **GPT-5.6**, then **Opus**):
- **Fable** — tasks that amend engine semantics or integrate into the two giant orchestration
  surfaces (`OnCourseModel.swift` ~3.5k lines, decide-moment correctness).
- **GPT-5.6** — spec-driven work with real invariants (tree migration, planner tool wiring,
  state-machine plumbing) where the decisions are locked but the surface is subtle.
- **Opus** — contained UX passes and wiring over existing patterns.

**Kickoff prompt (paste into a fresh session, fill in the task number):**

> Read the spec named in task T\<n\> of docs/delegation-briefs-oncourse.md, then implement it.
> Follow the standing constraints and reporting protocol exactly: one commit starting `T<n>:`,
> write docs/reports/T\<n\>-report.md, do not re-open decisions (O*, R*, D1–D27), do not spawn
> sub-agents, and stop when the report is written — no adjacent work.

**Standing constraints (all tasks):**
- House style per area AGENTS.md; colocated tests; server work = descriptor pattern + numbered
  migration + `bun run generate`.
- Run web tests from `web/` (`cd web && bun test`); respect the reactive-cascade gotcha
  (coalesce derived-geometry effects via `queueMicrotask`).
- iOS: `xcodegen` after project.yml changes; **iOS tasks serialize** (shared
  xcodegen/xcodebuild); Swift strategy work is parity-pinned to `strategy-goldens.json` — never
  hand-edit goldens; fixture goldens are macOS-libm-only.
- Strategy-engine changes keep TS + Swift in step **when a Swift consumer exists** (O4 defers the
  chain-score mirror).
- **No sub-agents.** Reporting protocol as in [delegation-briefs.md](delegation-briefs.md).

## Sequencing

```
T28 (server: parent_shot_id tree)            — first; blocks T29, T30, T32
T29 (web planner: option authoring/overlay)  — after T28
T30 (shared: scoreOptionChain + EV chips)    — after T28; UI bits after T29
T31 (iOS: PlayingState + card modes)         — independent of T28–T30; blocks T32–T35
T32 (iOS: options on course)                 — after T28 + T31
T33 (iOS: decide moment + caddy ports)       — after T31 (T32 not required)
T34 (iOS: capture drivetrain)                — after T31
T35 (iOS: green handoff)                     — after T31
T36 (iOS: laser entry + residual refresh)    — independent (touches OnCourseModel: schedule
                                               around T31 in the serial iOS lane)
Suggested iOS lane order: T31 → T33 → T34 → T35 → T32 → T36 (T32 waits on T28 anyway).
Web lane (T28 → T29 → T30) runs in parallel with the iOS lane.
```

---

### T28 · Plan-shot tree: migration, service, API — **GPT-5.6**

Spec: options doc §3 (O1–O3, O6). Server-only. Migration `009_plan_shot_options.ts`: add
`parent_shot_id TEXT NULL REFERENCES plan_shots(id) ON DELETE CASCADE`; backfill per O1
(per-hole chain by old `sort_order`, then all `sort_order = 0`). In
`server/services/game-plans.service.ts`: `toPlanShot`/tree assembly (flat rows +
`parentShotId` in `getByCourse` per O6), `addShot(parentShotId?)` (omitted = primary-line tail —
preserve existing callers), `removeShot(mode)` per O2 (splice re-parents children into the
removed shot's sibling slot, single transaction), sibling-scoped `reorderShots` (id set must
equal one sibling group), new `setPrimary` per O3. Descriptor API + `bun run generate`. Tests:
backfill round-trip property (primary line == old flat list), splice vs cascade, setPrimary
idempotence, sibling-reorder validation, version conflicts on option shots.
**Done:** migration + endpoints + regenerated clients; service tests green.

### T29 · Planner option authoring + overlay — **GPT-5.6**

Spec: options doc §4. After T28. `web/src/planner/`: `plan.service.ts` stores the tree (flat
EntityStore + parent index; primary-line selector); `planner-tool.service.ts` add-alternative
mode (select shot → place sibling), continuation placement (selected option = parent), delete
option (cascade) vs delete shot (splice), set-primary; `plan-overlay.ts` primary solid /
branches dashed+dimmed, option ellipses reduced opacity; `planner-panel.component.ts` sibling
grouping + actions + option labels. Drag semantics per shot unchanged; keep the enrich cadence
(strategy recompute on place/release only). E2E: author driver-vs-4-iron with continuations,
set primary, reload survives.
**Done:** author/see/reprioritise options end-to-end; web tests + e2e green.

### T30 · Option chain EV — `scoreOptionChain` + chips — **Fable**

Spec: options doc O4. `shared/strategy/`: new `option-chain.ts` — chain scoring generalising the
par-5 two-shot chain to depth n, returning the full triple: `expectedStrokes`, `tailStrokes`
(CVaR₈₀, D16 semantics carried through the chain), `penaltyProb` (chain aggregate
`1 − Π(1 − legPenaltyProb)`, leg probabilities from `optimizeAim`'s `breakdown` lie fractions),
plus `perLeg`. Dispersion-aware per-leg EV where a club is set (reuse the `optimizeAim` path
`enrichLegStrategy` runs), point estimate `1 + shotsToHoleOut` with zero tail/penalty otherwise;
terminal ES from last landing. Must agree with the par-5 rule on a shared fixture — add that
fixture and pin all three outputs. Web: **score chips** at multi-sibling decision points on the
overlay + panel — probable hole score (legs behind the decision point + EV) leading, penalty%
beside, tail on expand — recomputed on the enrich cadence. No Swift mirror (O4). This task owns
the *semantics*; keep it pure and small — the risk is subtle chain assumptions (σ compounding,
tail composition across legs), which is why it is Fable-tier. Whole-hole Monte Carlo score
distributions are explicitly out of scope (O4).
**Done:** pure function + goldens + par-5 agreement fixture pinning EV/tail/penalty; chips
rendering; tests green.

### T31 · PlayingState + card context machine — **Fable**

Spec: round-loop R1–R3 (decide-mode *content* is T33; this task ships the mode switch with a
placeholder decide state). `ios/GolfMap/Screens/OnCourseModel.swift`: PlayingState derived from
the active `RoundModel` round; capture-driven advancement; currentLeg matching + divergence rule
(constants in one place); nil-round ⇒ exact current behaviour (regression tests over existing
`OnCourseModelTests`). `CourseScreen.swift` card: tee-preview strip, plan leg card (planned
club/aim label/gate width/notes, from `CoursePlan`), mode switching, F/C/B block always present,
competition gating untouched. Respect the memoization discipline (`StrategyKey`/`LadderKey`
patterns) — no per-frame recompute. Headless-verify hooks in the established `-launchArg` style
for leg matching + mode switching.
**Done:** round-active card follows the plan by itself; no-round behaviour byte-identical;
tests + headless verify green.

### T32 · Options on course — **GPT-5.6**

Spec: options doc §5, round-loop R2/R8. After T28 + T31. `GamePlanModels.swift` +
`GamePlanSync`/`GamePlanRecords`: tolerant additive decode of `parentShotId`; `CoursePlan`
gains the tree + primary-line resolution (legacy plans = single chain). Leg card option chips
(label + club; EV only if trivially available — do NOT build the Swift chain-score mirror, per
O4; note the gap in the report); tap sets `activeLine` (round-scoped, R8); divergence tracks the
active line. Sync reconciliation must not clobber pending local plan edits (existing
`PlanSyncService` rules).
**Done:** authored options visible and pickable on the tee; chosen line drives leg tracking;
decode/parity tests green.

### T33 · Decide moment + caddy rule ports — **Fable**

Spec: round-loop R4. After T31. Two parts, one task (the ports are meaningless unranked):
(a) Port `take-your-medicine`, `short-side-guard`, `can-you-carry-it` to
`ios/GolfMap/Strategy/Caddy/`, parity-pinned against the TS goldens (extend
`strategy-goldens.json` from the TS side, same harness as existing rules). (b) Decide-mode
assembly in `OnCourseModel` + card UI: merge authored options (from T32 when present — degrade
gracefully without it) + engine candidates (Layup enumeration + go-for-it aim EV from classified
lie) + caddy ranking/vetoes → ≤3 choices, one headline each carrying the probable-score /
penalty% / tail triple (R4): probable score = strokes taken on the hole + choice EV; penalty%
and tail read straight off `Aim.swift`'s `breakdown`/`tailStrokes` for single-shot candidates
(no chain scorer on device — O4). One shared formatter for the triple so decide choices and
option chips speak identically. Tap → working target consumed by
capture prefill and the distance line. Recompute on demand/capture only. This is the
advice-correctness surface — wrong ranking is worse than no ranking; hence Fable.
**Done:** off-plan position yields 3 sane ranked choices on a golden hole (fixture-tested);
parity tests green; headless-verify hook drives a divergence scenario.

### T34 · Capture drivetrain — **Opus**

Spec: round-loop R5. After T31. `ShotCapture.swift`/`CapturePanel.swift`/`RoundModel.swift`:
capture advances PlayingState (the R1 hook lands in T31; this task closes the loop end-to-end),
penalty quick-action + one-tap hole-out on the round card, auto hole advance on hole-out, GPS
tee-geofence **prompt** (never silent). Capture target prefill order becomes: working target
(T33) → pin → plan landing → green centre.
**Done:** a simulated 3-hole round drives itself by taps only (headless-verify script);
scorecard totals correct incl. penalties; sync round-trips.

### T35 · Green handoff — **Opus**

Spec: round-loop R6. After T31. Ball-on-green flips card to green mode;
`PuttReadModel` hole position = pin override ?? active pin (closes laser-doc Q3); stimp field on
round start (persist per round like wind; default from previous round at the course) replacing
the hardcoded default; Tier-1 scanned surface still wins when present. Competition gating
unchanged.
**Done:** walk-on-green (simulated fix) shows putt-first card; lasered pin is the read's hole;
stimp affects pace figures; tests green.

### T36 · One laser entry + opportunistic residual refresh — **GPT-5.6**

Spec: round-loop R7, laser doc §6.4. Independent, but touches `OnCourseModel` — schedule in the
iOS lane. Single laser affordance on the card routing: bare pin-plausible number →
existing `PinEntrySheet` solve; picked mapped feature + no live calibration → existing
trilateration session; picked feature + live calibration → residual gate on
`OriginCalibration` (≤ gate: silent `.residualRefresh`; large: stale + badge + re-shoot prompt).
Always render the plain carry check against the picked target. Tests: residual-gate state
machine (refresh/stale/floor), routing table, voice-number reuse of `PinPhraseParser` numeric
path.
**Done:** one button covers pin/calibrate/verify; calibration stays fresh across a simulated
round of periodic laser shots; tests green.
