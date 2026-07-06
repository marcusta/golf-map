# T10 report — EV-backed caddy rules + live caddy context

**Task:** four EV-backed caddy rules under `shared/strategy/caddy/rules/`, plus making the whole
smart caddy live in the planner (assemble a `CaddyContext` per leg, run the full rule set, render
advice), on the shot-place / drag-release cadence, respecting the locked leg contract.

## Files touched

**shared/strategy (rules — pure, zero-dep, fixture-tested):**
- `shared/strategy/caddy/rules/no-doubles.ts` (new) — reads `AimResult.best.tailStrokes` per D16, no risk math.
- `shared/strategy/caddy/rules/no-doubles.test.ts` (new)
- `shared/strategy/caddy/rules/short-side-guard.ts` (new)
- `shared/strategy/caddy/rules/short-side-guard.test.ts` (new)
- `shared/strategy/caddy/rules/take-your-medicine.ts` (new) — recovery leg, `shotsToHoleOut` two-outcome compare.
- `shared/strategy/caddy/rules/take-your-medicine.test.ts` (new)
- `shared/strategy/caddy/rules/specific-target.ts` (new)
- `shared/strategy/caddy/rules/specific-target.test.ts` (new)
- `shared/strategy/caddy/index.ts` (barrel — re-export the four rules + their constants). **Did NOT touch `shared/strategy/index.ts`.**

**web (live wiring):**
- `web/src/planner/planner-tool.service.ts` — full CaddyContext-per-leg assembly + rule run on the `refreshStrategy` cadence; exported pure `caddyLegKind()` (the locked contract).
- `web/tests/caddy-leg-kind.test.ts` (new) — locks the leg-contract mapping.

Did NOT modify `planner-panel.component.ts`: its stubbed Caddy section already renders `tool.caddyAdvice`
generically (headline + detail cards, ranked, hides when empty), so making `caddyAdvice` surface the
full multi-leg ranked list was sufficient — no panel change needed.

Did NOT modify `rule.ts` / `run.ts` / `aim.ts` / the existing rules / `shared/strategy/index.ts` /
`plan-overlay.ts`.

## Verbatim results

`bun test shared/strategy/` (from repo root):
```
bun test v1.3.11 (af24e281)
 171 pass
 0 fail
 2290 expect() calls
Ran 171 tests across 17 files. [153.00ms]
```

`cd web && bun test`:
```
bun test v1.3.11 (af24e281)
 462 pass
 0 fail
 2500 expect() calls
Ran 462 tests across 30 files. [234.00ms]
```

`cd web && bunx tsc --noEmit -p tsconfig.json`: clean (no output, exit 0).

## How the CaddyContext is assembled (per leg)

`refreshStrategy()` (already the shot-place / drag-release, microtask-coalesced cadence from T7) now,
after enriching the plan, calls `computeCaddyAdvice(enriched)` and stores `{ base, advice }` in a new
`caddyResult` Signal. `caddyAdvice` is a `Computed` that surfaces that advice **only while `base ===
holePlan.get()`** — the same live-plan guard `overlayPlan` uses, so during a drag (when `holePlan`
recomputes into a fresh object) the advice falls silent and re-appears on release. No `optimizeAim`
ever runs on the per-frame path.

`computeCaddyAdvice` iterates every plan leg and builds one `CaddyContext` via `buildLegContext`:
- **leg kind** from the exported pure `caddyLegKind()` (see contract below);
- **origin** = leg `from` node (x/y/elevation);
- **target** = green centre (leg `to` for the approach, else the hole green centre), with `front`/`back`
  the centre nudged ±`NOMINAL_GREEN_DEPTH_M` (9 m) along the leg bearing — the plan model carries only
  the green centre, not its polygon (honest stand-in until T6 wires full green geometry, same
  approximation the T9 stub used);
- **aim** = a fresh `optimizeAim` for the leg when it has a club, giving the full `AimResult` (with the
  per-candidate `tailStrokes` `no-doubles` reads per D16 — the plan legs only carry
  `expectedStrokes`/`lieBreakdown`, not the full result, and `plan-overlay.ts` is out of my edit scope,
  so re-optimising here is the in-scope way to get the tail; it runs only on the enrichment cadence);
- **greenSlope** = the `greenSlopeSummary` signal, passed **only on the green-terminated approach leg**
  (it describes that green; green-slope-half is an approach rule);
- **hazards** / **surfaces** from `lieMap.hazardRings()` / `.surfaces()` (T9 seam, now fed);
- **distances** = `featureDistances(...)` (T4) — green front/centre/back rows + front/carry rows for each
  hazard ring the leg crosses, cast along the leg bearing (D6); ready for the future carry rule;
- **clubs** = player bag, **wind** = effective wind, **hole** = par/index, **risk** = `{ riskAversion: 0 }`.

A leg no rule can act on (no aim, not recovery, no slope) is skipped.

## Leg contract enforcement (locked)

Extracted to an exported pure function `caddyLegKind({ index, toKind, par, originLie })` in the service
(unit-tested in `web/tests/caddy-leg-kind.test.ts`):
- `originLie === 'recovery'` → `'recovery'` (wins over position — a jailed shot is a punch-out);
- `toKind === 'green'` → `'approach'`;
- `index === 0` → `'tee'`;
- `par === 5 && index === 1` → `'layup'` (**what `par5AttackRule.appliesTo` checks**);
- otherwise `'tee'` (full shot to a landing area; no rule mis-fires on it).

Origin lie comes from `lieMap.classifyLie(leg.from)`.

## Cadence

Caddy runs strictly inside `refreshStrategy`'s coalescing microtask (shot-place via `placeShot`,
drag-release via `persistDrag`, and once on load). The `start()` effect that watches `strategyInputs`
+ `lieMap` now also subscribes to `greenSlopeSummary`, so an async slope feed re-runs the caddy — still
off the hot loop (it just schedules the same coalesced `refreshStrategy`). The per-frame drag path
(`applyDrag`/`patchShotLocal`) is untouched and never reaches `optimizeAim`/`runCaddy`.

## Vetoes wired (§4.4)

The three safety/recovery rules carry `vetoes` against the two aggressive-line rule ids
(`par5-attack`, `specific-target`); the evaluator demotes (does not drop) the vetoed advice:
- `no-doubles` — vetoes when the recommended aim's `tailStrokes − expectedStrokes` gap ≥ `TAIL_GAP_WARN`
  (0.5 strokes); `riskWeighted: true` so a cautious player floats it above attack advice.
- `short-side-guard` — vetoes when the aim's trouble share (sand+penalty+recovery) ≥
  `SHORT_SIDE_TROUBLE_SHARE` (0.08); `riskWeighted: true`.
- `take-your-medicine` — vetoes from a recovery lie when the punch-out-to-fairway outcome prices below
  the force-it-and-stay-stuck outcome (both `shotsToHoleOut` lookups).

`specific-target` (aggressive) and `par5-attack` (already existed) are the veto targets.

## Deviations / choices where the brief under-specified

1. **Re-running `optimizeAim` per leg for the caddy** rather than threading the full `AimResult` onto
   `PlanLeg`. The plan legs only carry `expectedStrokes`/`lieBreakdown`/`recommendedBearingDeg`, but
   `no-doubles` needs `tailStrokes`. Extending `PlanLeg` means editing `plan-overlay.ts`, which is not in
   my sanctioned edit set (T6/T7 territory), so I re-optimise in the service on the enrichment cadence.
   Cost is one extra sweep per clubbed leg per place/release — acceptable off the hot loop. If a later
   task wants to avoid the double sweep, thread the `AimResult` through `enrichLegStrategy` and drop the
   re-optimise here.
2. **No panel edit.** The T9 stub already renders `caddyAdvice` generically and ranked; it needed nothing
   to display the fuller list.
3. **`take-your-medicine` models the medicine/hero comparison** with two `shotsToHoleOut` outcomes
   (escape→fairway vs force-it→still-recovery) driven by `ESCAPE_ADVANCE_FRACTION` (0.6) and
   `HERO_EXTRA_ADVANCE_M` (60 m). The brief said "target that maximises return-to-play via lie +
   `shotsToHoleOut`" without a formula; this is a self-contained, table-backed, calibratable model that
   correctly prefers the punch-out (recovery baseline is flat + expensive, D18). Constants are named.
4. **`specific-target` anchor / club fit.** Projects `aim.bestBearingDeg` forward by the distance to the
   green centre for the ghost anchor and names the `clubAdvice` centre (bracketing front/back when the
   bag straddles the number). Confidence scales with the aim's green-hit share.
5. **`short-side-guard` uses the trouble share as the short-side proxy** (the plan carries no
   pin-relative geometry), anchoring the "aim fat" advice at the green centre — the honest thing this
   context supports (same reasoning as `plan-overlay.ts legLight`).
6. **Green reference front/back** are a ±9 m nudge of the green centre (carried over from the T9 stub) —
   not real green polygon geometry. green-slope-half's front-clean (D9) and the front/centre/back
   distance rows are therefore approximate until T6 supplies the polygon.

## Open concerns for the reviewer

- The ±9 m green-depth stand-in and the empty `greenPoly` mean the approach-rule geometry is coarse;
  once T6 threads the real green polygon, feed it into `buildLegContext` (target.greenPoly currently
  `{ kind:'green', points:[] }`).
- The caddy `optimizeAim` re-sweep duplicates the enrichment sweep for the same legs. Deliberate
  (scope), flagged above — a natural cleanup is to carry the full `AimResult` on `PlanLeg`.
- `take-your-medicine`'s two constants and `no-doubles`/`short-side-guard`'s thresholds are first-pass
  calibrations (named constants), same calibration risk the caddy doc §8 already flags for the risk knob.
- `greenSlopeSummary` is still only fed by whatever calls `setGreenSlopeSummary` (the T9 seam); if no one
  feeds it, the green-slope rule stays silent by design — the other rules still fire from the aim results.
