# T38 report — Sticky auto-continue (chain-draw)

## Summary

Closing a drawn ring used to drop back to select mode, so drawing six
bunkers meant re-arming (N + type pick) six times. Chain-draw is now
**sticky by default — no toggle**: on a successful close the draft and the
mid-draw redo stack are cleared but the tool stays in `'draw'` mode, so the
next click begins the next shape of the same `drawType` (which already
persists across closes on the service). All exits are unchanged because they
route through `disarm` (Esc, 'B' box-select, `deactivate`).

## Files touched

- `web/src/draw/draw-state.ts` — `closeDraft()` no longer calls `disarm()`.
  It now clears `draft` and the `redoPoints` stack directly and RETAINS draw
  mode. Doc comment updated to describe the sticky behaviour and note that
  exits route through `disarm`. `arm`/`disarm`/`handleEscape` untouched.
- `web/src/draw/draw-tool.service.ts` — `onKeyDown` Cmd/Ctrl+Z and
  Cmd/Ctrl+Y interplay fix. While drawing, the mid-draw ephemeral stack is
  still tried first, but when it has nothing to do (`undoPoint()` returns
  `null` / `redoPoint()` returns `false` — e.g. an empty draft just re-armed
  by a sticky close), the handler now falls through to committed
  `undo()`/`redo()`. This keeps the just-created feature undoable without
  leaving chain mode. The service's own `closeDraft()` (and its
  `cursor.set(null)`) is untouched; both close paths (click-near-start,
  Enter) still funnel through it.
- `web/tests/draw-state.test.ts` — rewrote the ex-`'closeDraft returns the
  ring and resets to select mode'` test to assert draw mode is retained and
  the draft + redo stack are cleared (parks a point on the redo stack before
  close, then asserts `redoPoint()` returns `false` after). Added two tests:
  `close → addPoint` starts ring 2 while still armed, and Esc-after-close
  exits to select mode.
- `docs/reports/T38-report.md` — this report.

No UI change: the command-bar `newPoly` button keys off `isDrawing` and
already shows "Cancel drawing (Esc)" while armed-idle, which is now the
correct state between chained shapes.

## Test results

`cd web && bun test`:

```text
641 pass
0 fail
6505 expect() calls
Ran 641 tests across 48 files.
```

`bun run check:client` (tsc --noEmit) passes clean. Net +2 tests from this
task: the existing sticky-close test was rewritten in place (its assertions
flipped from select-mode to draw-mode), and two new tests were added
(`close → addPoint` starts ring 2; Esc-after-close exits).

## Deviations / interpretations

None. The brief's file:line references were verified against current code
before relying on them (`closeDraft` state variant, service `closeDraft`,
the two close paths, `onKeyDown` undo/redo block, `onEscape`/`deactivate`
exits). No toggle, no UI change, per the brief.

## Working-tree caveat (for the reviewer)

Other active sessions have uncommitted changes in this tree (round-stimp work
in `server/`, `ios/`, `shared/`, `web/tests/round-sg.test.ts`,
`docs/reports/T35-report.md`, and an untracked migration `010_round_stimp.ts`).
Those were left untouched; only T38's four files were staged explicitly by
path.
