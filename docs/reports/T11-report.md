# T11 Report — Par-5 Attack Rule

## Files touched

- `shared/strategy/caddy/rules/par5-attack.ts`
- `shared/strategy/caddy/rules/par5-attack.test.ts`
- `shared/strategy/caddy/index.ts` (T11 export only; pre-existing T9 export lines were already dirty in the worktree)
- `docs/reports/T11-report.md`

## Verification

Command:

```sh
bun test shared/strategy/
```

Verbatim final summary:

```text
129 pass
0 fail
2166 expect() calls
Ran 129 tests across 12 files. [58.00ms]
```

## Deviations from brief/register

- No deviation from the locked two-shot EV chain: each strategy is scored with one `optimizeAim` call for shot 1, and `optimizeAim` prices each sample with `shotsToHoleOut(remaining-to-green, sampledLie)`. There is no nested sampling and no shot-to-shot correlation.
- The advice headline wording is intentionally factual and is pending Opus tone review, per the brief. Current examples include "Attack the green in two — ..." and "Lay up to a full 100 m wedge — ...".

## Under-specified choices

- "2nd shot" is represented as `ctx.leg === 'layup'` because the existing `CaddyContext` has no shot ordinal. `appliesTo` is therefore `hole.par === 5 && (leg === 'tee' || leg === 'layup')`.
- "Full number" is defined as a 100 m remaining shot (`FULL_NUMBER_LAYUP_M = 100`). The first-shot club must be within 18 m of the target lay-up distance, so the rule does not label a very different shot as a full-number lay-up.
- "Lay back of pinch" uses the first along-line hazard/pinch and targets 10 m short of its front edge (`LAY_BACK_OF_PINCH_BUFFER_M = 10`), again requiring a club within 18 m.
- The go-in-2 carry-clearance test uses `hazardsAlongLine` on the origin-to-green bearing, inspects every crossed hazard whose near edge is at or before the green center, and requires the hazard far edge (`carryM`) to be within the selected club's `maxCarryM`. This catches front hazards that overlap or extend beyond the green center.
- `CaddyContext` currently provides `hazards` and `target.greenPoly`, but not full fairway/rough surface rings. For this rule's `optimizeAim` call, those rings are passed as surfaces and unclassified safe landing is treated as `fairway` via `fallbackLie: 'fairway'`; hazards and green still classify explicitly.
- Go-in-2 uses the club whose `maxCarryM` reaches the green and whose nominal carry is closest to the remaining distance. Lay-up strategies use the club whose nominal carry is closest to their target distance.
- Ranking uses `aim.best.score`, so the existing D16 `riskAversion` term participates in the strategy comparison.

## Open concerns

- When the planner eventually supplies full surface rings in `CaddyContext`, the par-5 rule should use them instead of the current hazard-plus-green/fairway-fallback approximation.
- A future context field for shot ordinal would remove the `layup` = second-shot convention.
- The 100 m full number, 10 m pinch buffer, and 18 m club-fit tolerance are named constants for calibration after real-hole review.
- Headline copy is pending Opus tone review.
