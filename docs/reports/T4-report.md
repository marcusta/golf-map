# T4 report — feature-distances.ts engine

## Files touched

- `shared/strategy/feature-distances.ts` (new) — `PointRole`, `DistanceTarget`, `FeatureDistance`,
  `FeatureDistancesInput`, `featureDistances()`.
- `shared/strategy/feature-distances.test.ts` (new) — golden-hole fixture, wind present/absent,
  missing-elevation (origin and target), hazard-crossing (two ordered rows), hazard-miss (no rows),
  empty-targets.
- `shared/strategy/index.ts` (edited) — added the T4 export block; removed `FeatureDistance` from
  the `./caddy` re-export (was a forward-declared placeholder whose own header comment says to
  retire it once T4 lands — see "Deviations" below). `GreenSlopeSummary` (T9's forward-decl) is
  untouched.

No other files modified. Did not touch `carry.ts`, `plays-like.ts`, `wind.ts`, `club.ts`,
`corridor.ts`, `aim.ts`, `expected-strokes.ts`, `lie.ts`, or `caddy/rule.ts` / `caddy/index.ts`.

## Verbatim final test summary

```
bun test shared/strategy/
 124 pass
 0 fail
 2152 expect() calls
Ran 124 tests across 11 files. [63.00ms]
```

Baseline was 106 (per brief); this wave adds 18 new assertions-worth of tests in
`feature-distances.test.ts`, all passing, none of the pre-existing 106 broken.

Also ran the full monorepo suite (`bun test` at repo root) as an extra sanity check, not part of
the required gate: 816 pass / 10 fail. The 10 failures are all in
`web/tests/svg-import.service.test.ts`, last touched by an unrelated "Phase 3: web course builder"
commit, with zero references to `shared/strategy`, `strategy`, or anything T4 touches — confirmed
pre-existing and out of scope.

## carry.ts signature actually consumed (T3's real code, not the doc's draft)

```ts
export interface CarryOverHazard {
    ring: FlatRing;
    frontM: number;   // near-edge distance along the shot line
    carryM: number;   // far-edge distance
}

export function hazardsAlongLine(
    origin: Vec2,
    bearingDeg: number,
    obstacles: readonly FlatRing[],
    maxM = Infinity,
): CarryOverHazard[]
```

This matches §5.2 exactly — no deviation needed. `Vec2` is `{ x: number; y: number }` from
`ellipse.ts`; `StrategyPoint` (`plays-like.ts`) structurally satisfies it (extra optional
`elevation` field ignored), so `origin: StrategyPoint` passes straight into `hazardsAlongLine`
without adaptation.

## Deviations from brief / decision register, with justification

1. **Dropped `FeatureDistance` from `caddy`'s top-level re-export in `index.ts`, kept it in
   `caddy/rule.ts` and `caddy/index.ts` untouched.** The two `FeatureDistance` types (T4's real one
   and the caddy's structural forward-declaration) are different declarations; re-exporting both
   under the same name from `shared/strategy/index.ts` is a duplicate-export compile error. The
   caddy module's own header comment anticipated exactly this ("when the real modules land, those
   modules should EXPORT the canonical type and this file should re-import it... this line should
   re-source them"). I did not touch `caddy/rule.ts` (out of my file list) so its internal
   `FeatureDistance` forward-decl still exists and is still used inside `CaddyContext`; I only
   stopped re-exporting it from the parent barrel so the parent barrel has one canonical
   `FeatureDistance` (mine). Retiring the caddy-internal forward-decl and rewiring `caddy/rule.ts`
   to import the real type is T9/whoever next touches the caddy module's job, per that file's own
   comment — not mine to do since I was told not to modify files outside my list. Flagging this as
   a concern below for the parent reviewer / next task.
2. No other deviations. Types match §5.3 verbatim: `DistanceTarget` union (`'point'` with
   `PointRole`, `'hazard'` with `FlatRing`), `FeatureDistance` fields and names, `FeatureDistancesInput`
   shape (`origin`, `targets`, `wind?`, `clubs?`), null-propagation rules as specified.

## Under-specified in the brief — choices made

1. **Bearing for hazard targets.** §5.3's `DistanceTarget` hazard variant carries only `label` +
   `ring` — no point, so there's no origin→target bearing to derive the way there is for a
   `'point'` target. `hazardsAlongLine` requires a `bearingDeg` to cast the ray along, and D6 (the
   only bearing decision in the register) explicitly scopes the origin→green-centre default /
   aim-point override to the **adapter** layer (web planner, T5), not the engine. I added one field
   to `FeatureDistancesInput`: `bearingDeg: number` — the resolved reference/shot-line bearing the
   caller (adapter) has already picked per D6. The engine uses it (a) to cast every hazard ray, and
   (b) as the wind-projection bearing for the resulting `hazard_front`/`hazard_carry` rows (there is
   no other bearing available for those rows). Point targets are unaffected — they still get their
   own origin→target bearing, computed internally via `atan2` (the inverse of `bearingToUnitVector`,
   the module's own convention; no existing point→bearing helper existed anywhere in
   `shared/strategy` to reuse, so this one atan2 line is the only "new math," and it's pure
   coordinate geometry, not a modeling decision).
2. **Single `club` field vs. `clubAdvice`'s `{front, center, back}`.** §5.3 specifies
   `club?: ClubSpec` (singular) on `FeatureDistance`, but the existing `clubAdvice()` returns three
   slots. I chose `advice.center` (nearest-carry match to the wind-adjusted plays-like distance) —
   the plain-language spec ("the club that covers the plays-like distance") reads as "the one club
   for this number," and center is the natural single answer; front/back remain available via a
   direct `clubAdvice()` call by any consumer that wants the full triple (the doc's §5.4 UI
   description shows a single arrow to one club, e.g. `→ 6i`, reinforcing `center`).
3. **Hazard row elevation.** A hazard front/carry point is a projection along the bearing at a
   given distance — it has no elevation sample of its own (ring vertices in `FlatRing` carry no
   elevation; the engine doesn't fabricate one). I model it as a `StrategyPoint` with no
   `elevation` field, so `segmentStats` degrades it exactly like any other missing-elevation
   endpoint: `elevationDeltaM`/`playsLikeM` both null, `windDeltaM` null (needs a non-null
   playsLikeM), `lineM` unaffected. This is the null-propagation contract applied uniformly rather
   than a special case — matches §5.3's "zero new math" instruction.
4. **Club advice's target distance under wind.** Used `(playsLikeM ?? lineM) + (windDeltaM ?? 0)`
   as the input to `clubAdvice`, i.e. club fit is against the fully wind-and-elevation-adjusted
   number when available, degrading gracefully to plain `lineM` when elevation/wind are unknown
   (e.g. hazard rows). Not specified in §5.3 beyond "clubAdvice for the club" — this is the most
   natural reading ("the club that covers the plays-like distance" extended to include wind since
   the row already carries a wind delta).

## Open concerns for the reviewer

1. **`FeatureDistancesInput.bearingDeg` is a new field not in the doc's §5.3 code sketch.** It's
   necessary for hazard-ray casting given D6 lives at the adapter layer; flagging in case the
   reviewer wants a different name/shape (e.g. per-target override) before T5 locks its adapter
   contract against it.
2. **Caddy's forward-declared `FeatureDistance` (`shared/strategy/caddy/rule.ts`) still exists and
   is now shadowed rather than retired.** It is structurally a subset of the real type (per its own
   comment) so nothing is unsound, but `CaddyContext.distances: readonly FeatureDistance[]` in
   `rule.ts` still refers to the *local* forward-decl, not the real T4 type, until whoever picks up
   the caddy module next imports the real one and deletes the local declaration. Did not do this
   myself since `caddy/rule.ts` was outside my assigned file list.
3. **No `bun typecheck` script exists at the repo or `shared` package level** — verified type
   correctness instead via an ad hoc `tsc --noEmit --strict` pass over
   `feature-distances.ts` + `index.ts` (clean, zero errors) rather than a project-wide typecheck
   command referenced by the brief. If the parent reviewer has a canonical typecheck command,
   worth re-running it, though `bun test` also exercises the module's actual runtime types via the
   test file's usage.
