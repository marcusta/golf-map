# T42 report — Stamp: duplicate-drag + repeat placement

## Summary

Duplicating a feature used to require Cmd/Ctrl+D (a fixed +10 m offset) or a
manual re-draw. T42 adds a **direct-manipulation stamp** on the committed
**Alt** modifier:

- **Duplicate-drag** — Alt+press INSIDE the selection (not on a vertex/handle,
  which Alt still bends on bezier features) starts a moveDrag-style gesture
  over *clones*. A ghost tracks the cursor via `translateGeometry` from the
  drag-start geometry (absolute dx/dy, no store reads mid-drag). On drop the
  clones are created (`before: null`, `beforeVersion: null` — mirroring
  `duplicateSelection`), selected, and pushed as ONE history entry. A
  sub-threshold Alt-drag decays to the existing Alt-cycle click — a stationary
  Alt-click still steps the hit stack exactly as before.
- **Repeat stamp** — the duplicate-drop arms stamp mode: each subsequent
  empty-ground drag stamps another copy of the same template, anchored under
  the cursor (grab point = the previous drop point). Every drop creates + pushes
  its OWN history entry (one undo = one stamp). Stamps inherit the source's
  `holeId`. Stamp mode exits on Esc (inserted ahead of the marquee in the
  `onEscape` chain), tool `deactivate`, or arming a draw (an effect on
  `state.isDrawing`).

`DUPLICATE_OFFSET_M` and Cmd/Ctrl+D (`duplicateSelection`) are untouched.

## Files touched

- `web/src/draw/draw-tool.service.ts`
  - New `StampSource` / `StampDrag` / `StampTemplate` interfaces and two
    private fields (`stampDrag`, `stampMode`).
  - `onMouseDown`: new step **1b** — Alt+press inside `selectedFeatures`
    starts a `kind:'duplicate'` `stampDrag` (placed AFTER the vertex/handle
    hit-test so Alt+vertex-drag still pulls handles, and after the meta-pan
    guard). Step **4** (empty-ground) now starts a `kind:'stamp'` drag when
    stamp mode is armed, else the existing feature marquee.
  - `onMouseMove`: new `stampDrag` branch renders the clone ghost via the
    existing `dragGhost` signal (duplicate is threshold-gated at
    `MOVE_THRESHOLD_PX`; stamp shows the copy immediately).
  - `onMouseUp`: new leading `stampDrag` block — sub-threshold duplicate
    returns without suppressing the synthesized click (decay to Alt-cycle);
    otherwise commits via `stampClones` and, for a duplicate, arms stamp mode
    with the fresh clones as the template.
  - New methods: `startStampDrag` (arms a stamp gesture + initial ghost),
    `cancelStampDrag` (abort without committing), and `stampClones` (the
    shared drop-commit: create N clones translated by dx/dy as ONE history
    entry, select them; returns the created features or null on save failure).
  - `activate`: effect clearing stamp mode when `state.isDrawing` becomes true.
  - `deactivate` + `onEscape`: clear `stampDrag`/`stampMode`. Class + `onEscape`
    doc comments updated.
- `web/tests/draw-stamp.test.ts` — new colocated test file (5 tests) driving
  the `stampClones` commit primitive with a create-echoing fake
  `CourseFeaturesApi`: clone translation correctness (and source non-mutation),
  multi-feature duplicate = one entry + clones selected, `holeId` inheritance,
  undo peels one stamp at a time then the original clone batch, and empty-source
  no-op.
- `docs/reports/T42-report.md` — this report.

Nothing else was touched (no `draw-state.ts` change was needed —
`translateGeometry` there was reused as-is).

## Why the tests target `stampClones`

The full gesture is bound to raw MaplibreMap `mousedown`/`mouseup` handlers and
needs a live map (dragPan, screen projection, hit-testing), which the headless
DI harness cannot supply. Both the duplicate-drop and every repeat stamp funnel
through the pure-ish `stampClones` commit, so the tests exercise that directly —
covering the three behaviours the brief calls out (clone translation, holeId
inheritance, per-stamp undo peeling) plus the one-entry-per-action contract.

## Test results

`cd web && bun test`:

```text
679 pass
0 fail
6653 expect() calls
Ran 679 tests across 52 files.
```

Baseline before this task was 674 pass / 0 fail (the brief's 651 figure
predates T38/T39 landing); net **+5** tests, all in the new
`draw-stamp.test.ts`. `bun run check:client` and `bun run check:test`
(tsc --noEmit) both pass clean.

## Deviations / interpretations

- **`stampClones` is a non-private method.** It is the shared drop-commit for
  both the Alt-duplicate-drag and each repeat stamp, and is the sole testable
  seam (the gesture needs a live map). Exposing it matches how this file already
  exposes commit primitives for tests (`buildMoveEntry` exported,
  `duplicateSelection` public).
- **Stamp anchoring.** "Anchored under the cursor" is implemented as: the
  template's grab point is the previous drop point, and each stamp translates so
  that grab point sits under the cursor — so a stamp click drops a copy exactly
  where you click, and dragging offsets it from there. This keeps the grab
  handle consistent with how the first clone was made.
- **`duplicateSelection` left as-is** per the brief ("stays as-is"); it shares
  the create-diff shape with `stampClones` but was not refactored to delegate,
  to avoid any risk to the Cmd/Ctrl+D path.
- Brief file:line refs were verified against current code first — T38/T39 had
  shifted them (e.g. the empty-ground marquee is now ~:858, `duplicateSelection`
  ~:1180). No stale ref was relied on.
