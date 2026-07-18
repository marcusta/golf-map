# T39 report — Keyboard feature-type switching

## Summary

Digit keys now arm a draw feature type without opening the command-bar
palette dropdown. The mapping follows panel order (`FEATURE_TYPES`):
`1`–`9` = tee, fairway, green, bunker, semi_rough, rough, deep_rough,
trees, water; `0` = water_creek. The five rules/misc types
(penalty_yellow, penalty_red, oob, path, outside) stay panel-only — no
digit binding. A bare digit mirrors the palette button exactly: with a
non-empty selection it retypes the selection, otherwise it sets the draw
type (which also recolors an in-progress draft, since there's no selection
then). `⌘/Ctrl/Alt`-digit is left entirely alone (browser tab switching,
etc.) — never `preventDefault`ed.

## Files touched

- `web/src/draw/feature-palette.ts` — exported `DIGIT_FEATURE_TYPES`
  (digit → `FeatureType`, the shared source of truth for both the panel and
  the key handler) plus a `digitForFeatureType()` inverse helper for the
  panel badges. Ten distinct types keyed `1`–`9`, `0`.
- `web/src/draw/draw-tool.service.ts` — imported `DIGIT_FEATURE_TYPES` and
  added a bare-digit branch at the end of `onKeyDown`'s key chain. Guard:
  `!meta && !e.altKey && DIGIT_FEATURE_TYPES[e.key]` — so meta/ctrl/alt
  combos never enter the branch and never `preventDefault`. The existing
  input/select/textarea guard and `isMyClaim()` claim guard already cover
  the branch. Selection non-empty → `retypeSelection(type)`, else
  `drawType.set(type)`.
- `web/src/app/command-bar.component.ts` — `buildFeaturePanel` now renders a
  `.cmd-ft__digit` badge on each mapped row (via `digitForFeatureType`);
  added the badge's CSS to the inline style block, and gave `.cmd-ft__name`
  `flex: 1` + ellipsis so the badge sits flush-right.
- `web/src/draw/draw-tool.ts` — added a "Drawing" help entry:
  `1–9, 0 → Arm a feature type (or retype the selection) — tee…water,
  0 = creek`.
- `web/tests/feature-palette.test.ts` — pinned the digit→type table, panel
  order, panel-only types, the `digitForFeatureType` inverse, and
  distinctness (5 new tests).
- `web/tests/draw-tool-keys.test.ts` — new file: keydown dispatch through a
  live activated tool. Asserts a bare digit sets `drawType`, retypes when a
  selection is present, ignores meta/ctrl/alt, ignores digits typed into an
  input, and ignores shifted digit-adjacent keys (`!`).
- `docs/reports/T39-report.md` — this report.

## Test results

`cd web && bun test`:

```text
651 pass
0 fail
6557 expect() calls
Ran 651 tests across 49 files.
```

`bun run check:client` and `bun run check:test` (tsc --noEmit) pass clean.
Net +13 tests over T38's 641 baseline (5 palette-mapping tests + 5 keydown
dispatch tests + T38's already-landed tests).

## Deviations / interpretations

- The brief cited `command-bar.component.ts:720`–`722` for the panel button
  behavior and `draw-tool.service.ts:857` for `onKeyDown`; both verified
  against current code (unchanged after T38's landing). `retypeSelection`
  lives at `:1246`, `drawType` at `:234`.
- The brief said "export the map as `DIGIT_FEATURE_TYPES`"; I also added a
  small `digitForFeatureType()` inverse helper in the same module so the
  panel can render badges without duplicating the mapping. This keeps the
  panel and key handler sharing one source of truth, per the brief's intent.
- Brief-listed token `color-border` is not a valid `t()` token; used the
  existing `color-border-subtle` for the badge border instead.

## Working-tree caveat (for the reviewer)

Other active sessions have uncommitted changes in this tree (round-stimp work
in `server/`, `ios/`, `shared/`, `web/tests/round-sg.test.ts`,
`docs/reports/T35-report.md`, untracked migration `010_round_stimp.ts`, and a
concurrent T43 agent in `pipeline/` and `web/src/import/`). Those were left
untouched; only T39's files were staged explicitly by path.
