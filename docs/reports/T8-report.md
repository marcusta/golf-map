# T8 — Caddy rule-engine skeleton — report

**Task:** Phase A of feature-smart-caddy.md — the open–closed caddy rule engine
(pure, zero-dep, Swift-mirrorable), standalone with no engine dependency.

## Files touched

New:
- `shared/strategy/caddy/rule.ts` — `CaddyRule`, `CaddyAdvice`, `CaddyContext`, `RiskProfile`,
  `CaddyLeg`, `CaddyAdviceKind`, plus the two forward-declared inputs `FeatureDistance`,
  `GreenSlopeSummary`.
- `shared/strategy/caddy/run.ts` — `runCaddy(ctx, rules)`: filter → evaluate → veto → rank → dedupe.
- `shared/strategy/caddy/rules/example-long-par.ts` — the one trivial example rule (NOT a catalogue rule).
- `shared/strategy/caddy/index.ts` — barrel re-export.
- `shared/strategy/caddy/run.test.ts` — engine tests (12 tests).

Modified:
- `shared/strategy/index.ts` — added the caddy re-export block (ADD-only, per constraint).

Not touched: `lie.ts`, `expected-strokes.ts`, `aim.ts` (as required).

## Test result (verbatim)

```
bun test v1.3.11 (af24e281)

 103 pass
 0 fail
 2066 expect() calls
Ran 103 tests across 8 files. [68.00ms]
```

91 pre-existing + 12 new. All green.

## Forward-declared not-yet-built context types (my choices)

The brief said: import `AimResult` from `aim.ts` (done); for `FeatureDistance` and
`GreenSlopeSummary` (not yet built) define minimal forward declarations that later tasks can
replace without churn. My approach:

- Both are declared as **minimal structural interfaces** in `rule.ts`, each in a block tagged
  `FORWARD-DECL` with a header comment naming the task that retires it (T4 for `FeatureDistance`,
  T9 for `GreenSlopeSummary`).
- Field names are chosen so the **real type will be a superset** — i.e. the canonical type stays
  assignable to the forward declaration, so rules written against these fields keep compiling when
  the real module lands. `FeatureDistance` uses `label`/`lineM`/`playsLikeM`/`club` matching the
  distances feature's null-propagation contract (null = uncomputable). `GreenSlopeSummary` uses
  `fallLineBearingDeg`/`fallLinePct`/`frontHalfPct`/`backHalfPct` per **D10** (dominant fall line +
  front/back split).
- Retirement path documented: when T4/T9 land and export the canonical type, delete the
  `FORWARD-DECL` block and re-import from that module; the `shared/strategy/index.ts` re-export has a
  matching NOTE flagging that those exports then supersede the forward declarations.

## Design notes / interpretation choices

- **`RiskProfile`** is `{ riskAversion: number }` — the thin D16 wrapper, exactly as the brief and
  register require. The caddy consumes `AimResult.perCandidate[].tailStrokes`; it invents no risk
  math of its own (documented in the type's JSDoc).
- **Ranking (D12)** = `priority × confidence`. Implemented in `run.ts` `rankOf`. Risk weighting is
  **opt-in per advice** via a `riskWeighted?: boolean` flag on `CaddyAdvice` — the register says
  "risk-weighted per rule where the rule declares it", and putting the opt-in on the advice item is
  the cleanest way for a rule to declare it without the evaluator hard-coding which rules are
  safety rules. A risk-weighted advice scales its priority by `0.5 + 0.5·riskAversion` (lerp), so a
  safety concern is *quieter* at riskAversion 0, never *silent* — chosen so a safety rule doesn't
  vanish entirely for a risk-neutral player. **This lerp shape is under-specified by the register**
  (D12 only says "risk-weighted"); flagged for reviewer.
- **Vetoes DEMOTE, not delete.** §4.4 says "demote or remove"; the brief says "demotes/removes". I
  chose **demote** (vetoed advice sorts strictly after all non-vetoed advice, kept visible) so the
  player still sees the aggressive option was considered and rejected — matches the §2 framing that
  "the value is in the conflicts". A caller/UI can trivially drop the demoted tail if it wants
  hard removal. Flagged for reviewer in case hard-remove was intended.
- **Determinism.** `runCaddy` is a total sort: ties break by rank → priority → confidence → ruleId →
  headline, so output is independent of rule input order and stable across runs (tested).
- **Dedupe key** = `ruleId + kind + headline`. Same recommendation collapses to the highest-ranked
  instance; same rule/kind with a *different* headline stays distinct (tested both ways).

## Open concerns for the reviewer

1. The risk-weight lerp (`0.5 + 0.5·riskAversion`) is my invention where D12 is silent. If the
   intended semantics are "risk-weighted advice's priority is multiplied straight by riskAversion"
   (so it truly vanishes at 0), swap `effectivePriority` in `run.ts` — one line.
2. Veto = demote (kept) vs remove (dropped): confirm the intended behaviour. Current = demote.
3. Forward-declared `FeatureDistance` overlaps in *spirit* with T3's just-landed `carry.ts`
   `CarryOverHazard`, but they are different concerns (per-hazard carry vs per-target distance/club);
   no collision. T4's real `FeatureDistance` should export the canonical type and this
   forward declaration should then be retired.
4. `shared/` has no standalone `tsconfig.json`; `bun test` is the verification path (green). A raw
   `tsc` invocation reports a spurious `Cannot find module 'bun:test'` only because no config
   supplies the bun ambient types — not a defect in the caddy code.
```
