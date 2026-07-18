# T40 report — Freehand trace → spline fit

## Summary

Drawing a bunker used to mean clicking control points one by one. T40 adds
**press-drag freehand tracing** alongside click-to-place, in two parts:

- **Pure fitter** — new `web/src/geo/spline-fit.ts` exports
  `fitClosedBspline(stroke, toleranceM): { controls, maxDeviation }`: a
  least-squares fit of a CLOSED uniform cubic b-spline (the repo's basis,
  geo/bspline.ts — segment j spans controls (P_j…P_{j+3}) mod m with the 1/6
  weights, so a `curveType:'bspline'` ring of the returned controls flattens
  to exactly the measured curve). The stroke is deduped, pre-simplified with
  `rdpSimplify` at toleranceM/2 (solve only — deviation is measured against
  every original sample), chord-length parameterised around the CLOSED ring
  onto [0, m), densified so every basis window has sample support, centered
  on its centroid (EPSG:3006 northings are ~7 digits — conditioning), and
  solved via the normal equations (dense Gaussian solve, m ≤ 20, plus a
  1e-9 ridge as a rank guard). Control count adapts 8 → 12 → 16 → 20 until
  `maxDeviation` (max distance from the stroke samples to the curve
  flattened via the shared `flattenRing`) is within tolerance; the best fit
  is returned regardless. All controls smooth — **no corner detection in
  v1**; EPSG:3006 in/out; no map/DOM/network — ready for T45 to consume on
  SAM mask contours. A partial trace (released before closing) closes
  itself across the gap with a straight-chord completion.

- **Interaction** — in `draw-tool.service.ts`, draw-mode left-mousedown no
  longer bails to native dragPan: with an EMPTY draft it `preventDefault`s +
  `dragPan.disable()` (marquee pattern) and starts a `TraceGesture`
  (draw-state.ts): pointermoves sampled at ≥ `TRACE_SAMPLE_PX` (3 px) screen
  spacing, converted via `lngLatToSweref99tm`; the live stroke renders as
  the dashed draft line in the preview overlay. On mouseup, a press that
  never strayed ≥ `TRACE_CLICK_DECAY_PX` (5 px) from its start decays to the
  plain click — click-to-place, Shift-corner, and the close-ring hit are
  untouched (the decay flag is latched, NOT start→end distance, which is ~0
  on a closed loop). Otherwise `commitTrace` fits at
  `TRACE_TOLERANCE_M = 0.75`, requires ≥ 3 controls (else discard), writes
  the controls as the draft and commits through the normal `closeDraft`
  funnel — a regular editable bspline feature of the armed type, ONE create
  history entry (`before: null`), and T38 chain-draw keeps the tool armed
  for the next shape. ESC mid-trace discards the stroke only (stays armed;
  the next ESC disarms). dragPan is restored on mouseup/ESC/deactivate.

## Fit quality (synthetic strokes at tolerance 0.75 m, EPSG:3006-scale coords)

| Stroke | Controls | maxDeviation |
|---|---|---|
| Circle r=15 m (240 samples) | 8 | 0.010 m |
| Ellipse 25×10 m (300) | 8 | 0.445 m |
| Kidney r=12+4cosθ−3cos2θ (300) | 8 | 0.400 m |
| Jittered circle ±0.15 m (200) | 8 | 0.159 m |
| 5-lobe wave 14±2.5 m (400) | 16 | 0.503 m |
| Partial 300° arc r=12 m (200) | 8 | 0.657 m |

Fits run 2–16 ms per gesture. Reported deviations match an independently
recomputed deviation (finer flatten + fresh point-to-segment scan) within
0.05 m in tests; flattened area matches stroke area within 2–3%.

## Files touched

- `web/src/geo/spline-fit.ts` — NEW: the pure fitter (above). Imports only
  `flattenRing`/`Point` (geo/bezier) and `rdpSimplify` (draw/draw-state, per
  the brief).
- `web/src/draw/draw-state.ts` — new pure `TraceGesture` class +
  `TRACE_SAMPLE_PX`/`TRACE_CLICK_DECAY_PX` (sampling gate, latched decay
  flag, `finish` appends the release point once). Nothing existing changed.
- `web/src/draw/draw-tool.service.ts`
  - `TRACE_TOLERANCE_M = 0.75` exported; `traceGesture` field + `trace`
    preview signal (updates only on KEPT samples).
  - `onMouseDown`: draw mode now routes to new `onDrawMouseDown` (⌘/Ctrl
    press returns without hijacking → native pan escape hatch, matching the
    select-mode meta-pan; non-empty draft returns too — see deviations).
  - `onMouseMove` drawing branch samples the gesture; `onMouseUp` gets a
    leading trace block (decay without click suppression / fit + commit);
    `onEscape` gets a leading discard step; `deactivate` cancels; new
    `commitTrace` (public commit seam) + private `cancelTrace`.
  - `previewGeojson`: live trace polyline as the existing `draft-line` role.
  - Class + onEscape doc comments updated.
- `web/tests/spline-fit.test.ts` — NEW (12 tests): circle/ellipse/kidney/
  jittered/wavy fit quality — `maxDeviation ≤ tolerance` verified against an
  independently recomputed deviation, control count in [8,20]; adaptive
  step-up past 8; closed-ring correctness (no duplicate endpoint, flattened
  area ≈ stroke area); explicit-closure equivalence; partial-arc closure;
  degenerate/empty strokes.
- `web/tests/draw-trace.test.ts` — NEW (9 tests): `TraceGesture` decay/latch/
  sampling-gate/finish state tests; `commitTrace` through the fake-API
  harness (draw-stamp.test.ts pattern): feature lands as an armed-type
  bspline with 8–20 smooth controls, chain-draw retained with cleared draft,
  ONE history entry (single undo removes it), degenerate stroke discarded,
  no-op outside draw mode.
- `docs/reports/T40-report.md` — this report.

## Deviations / interpretations

- **Trace starts only from an EMPTY draft.** The brief doesn't address a
  drag while click-placement is mid-flight; hijacking there would have to
  either destroy the open draft or commit a second shape under it. So a
  press-drag traces a FRESH shape only; with a non-empty draft, left-drag
  keeps today's native pan and clicks keep placing points — "clicks behave
  exactly as before" holds everywhere.
- **⌘/Ctrl-drag added as a pan escape hatch while armed**, mirroring the
  select-mode meta-pan comment the brief points at; middle-button remains
  the primary escape hatch (map.service).
- **`commitTrace` is public**, same rationale and shape as T42's
  `stampClones`: the pointer wiring needs a live MaplibreMap, and this is
  the sole commit seam the tests drive.
- **Densification + closure chord in the solver** (not in the brief's
  sketch): RDP leaves long sample gaps on straight edges, and a partial
  trace leaves the wrap region sample-free — either starves basis windows
  and makes the normal equations rank-deficient. Synthesizing samples along
  the simplified polyline (including the closing edge, ≤ half a segment's
  arc apart) keeps the system well-conditioned and gives partial strokes a
  sensible straight-chord completion. Deviation is still measured only
  against the user's actual samples.
- Brief file:line refs verified against current code first — T38/T39/T42
  had shifted everything (draw-mode bail was :639, now ~:775; closeDraft
  funnel :977 → ~:1290). T38's sticky close is respected: a trace commit
  chains into the next shape.

## Test results

`cd web && bun test`:

```text
700 pass
0 fail
6721 expect() calls
Ran 700 tests across 54 files.
```

Baseline before this task was 679 pass / 0 fail; net **+21** tests (12 in
`spline-fit.test.ts`, 9 in `draw-trace.test.ts`). `bun run check:client` and
`bun run check:test` (tsc --noEmit) both pass clean.
