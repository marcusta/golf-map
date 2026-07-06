# T3 Report

## Files touched

- `shared/strategy/carry.ts`
- `shared/strategy/carry.test.ts`
- `shared/strategy/corridor.ts`
- `shared/strategy/index.ts`
- `shared/strategy/ray.ts`
- `docs/reports/T3-report.md`

## Verification

Command run:

```sh
bun test shared/strategy/
```

Final summary line:

```text
Ran 106 tests across 9 files. [62.00ms]
```

## Deviations

None from the T3 brief or the decision register.

Note: this working tree already contained unrelated untracked `shared/strategy/caddy/` tests before
the T3 commit was prepared, so the full `bun test shared/strategy/` count is higher than the
brief's historical 91 plus the three new carry tests. The command above was still run exactly as
requested and completed green.

## Under-specified choices

- `maxM` is treated as a cap on collected ray/ring intersections. A ring must have enough boundary
  crossings within that cap to be reported.
- Duplicate boundary hits at shared vertices are de-duplicated before carry/front evaluation.
- Tangent contacts are omitted by requiring at least one interval between adjacent boundary hits to
  lie inside the ring.
- For an origin inside a ring, `frontM` is reported as `0` and `carryM` as the farthest forward exit
  crossing; at least one forward exit crossing is required.

## Concerns

- The ray/ring helper intentionally keeps the low-level segment-intersection primitive simple and
  Swift-mirrorable. It ignores coincident parallel edges; carry's interior-interval check filters
  boundary-only tangencies for the hazard listing use case.
