# T45 report — SAM click-to-feature assist

## Summary

New `sam` editor tool: click inside a bunker/green/water on the ortho and a
SAM 3 segmentation sidecar traces it into an **editable b-spline feature of
the armed type**, one undoable create. Flow:

click → `planCrop` (512 px ortho crop centered on the click, composed from
tiles fetched straight off the tile server at the manifest's ortho maxzoom —
the MapLibre canvas is **never** read) → sidecar `POST /segment` (point
prompt at crop center) → largest mask polygon by shoelace area → crop px →
WGS84 (exact inverse slippy math) → EPSG:3006 → `rdpSimplifyClosed` (0.4 m)
→ T40's `fitClosedBspline` (0.5 m tolerance, 8–20 smooth controls) →
`FeaturesService.create` with `{crs:'EPSG:3006', curveType:'bspline'}` →
ONE create history entry pushed onto the DRAW tool's history, so ⌘Z in draw
mode peels it like any hand-drawn shape. `create()` selects it — immediately
refinable in Draw.

**Health-gated:** the panel probes the sidecar's `/health` on activation and
shows online/offline (+ retry); clicks while offline are ignored with an
explanatory notice. The sidecar is a developer-workstation tool — absence is
a normal, non-error state.

**Sidecar** vendored from the `~/dev/SAM-test` prototype into
`tools/sam-server/` (point mode only; text mode, static demo mount, and
`python-multipart` dropped; `MAX_INFERENCE_SIZE = 512`, `mask_to_polygons`
and localhost-CORS unchanged). Weights are NOT committed — `SAM_WEIGHTS`
env var; without weights it serves a mock centered ellipse (handy for
exercising the web flow). Run:

```sh
cd tools/sam-server
python3 -m venv venv && venv/bin/pip install -r requirements.txt
SAM_WEIGHTS=/Users/marcust/dev/SAM-test/sam3.pt venv/bin/python server.py
```

Verified with `py_compile` only (per brief — the model is never run by
agents).

## Takeover note (partial state inherited)

A prior agent left three finished pieces uncommitted, kept as-is:
`tools/sam-server/*` (server.py + requirements + README),
`web/src/sam/sam-client.ts` (typed `/health` + `/segment` client with a
fetch seam; moved from `web/src/draw/` into the new `web/src/sam/` area),
and `web/src/geo/webmercator-tiles.ts` (pure XYZ tile math mirroring
`ios/GolfMap/Geo/WebMercatorTiles.swift`, incl. the trap-free out-of-domain
guard, plus the fractional inverse this task needs). Everything else —
crop planning/georeferencing, the tool service, panel, registry entry, and
all tests — is new in this task.

## Files touched

- `tools/sam-server/server.py` / `requirements.txt` / `README.md` —
  vendored sidecar (inherited, unchanged; `__pycache__` scrubbed).
- `web/src/geo/webmercator-tiles.ts` — pure tile math (inherited, unchanged).
- `web/src/sam/sam-client.ts` — sidecar HTTP client (inherited; relocated
  from `web/src/draw/`). `largestPolygon` picks by shoelace AREA — the
  prototype's vertex-count proxy loses to skinny noise contours.
- `web/src/sam/sam-crop.ts` — NEW, pure: `planCrop` (origin snapped to whole
  pixels so tiles composite unresampled; off-pyramid tiles skipped; null for
  out-of-domain clicks), `cropPixelToLngLat`/`cropPixelToSweref`,
  `cropPolygonToSweref` (+0.5 pixel-center semantics), `fillTileUrl`.
- `web/src/sam/sam-tool.service.ts` — NEW: `SamToolService` DI singleton.
  Health/armedType/busy/notice signals; `activate` probes health + registers
  the claim-gated click handler; `segmentAt` (public test seam, same
  rationale as T40's `commitTrace`) orchestrates the full pipeline;
  `browserCropSource` = fetch + OffscreenCanvas composite → base64 JPEG
  (failed/missing tiles leave background — out-of-coverage 404s are normal).
  Constants: `SAM_SIMPLIFY_EPS_M = 0.4`, `SAM_FIT_TOLERANCE_M = 0.5`.
- `web/src/sam/sam-panel.component.ts` — NEW: dock panel (status dot +
  retry, armed-type picker over `FEATURE_TYPES`, busy/notice lines, hints).
- `web/src/sam/sam-tool.ts` — NEW: `EditorTool` descriptor (`id: 'sam'`,
  order 50, D27 help sections).
- `web/src/editor/tools/index.ts` — one import + one registry line (the
  command bar sub-mode list, dock panel hosting, and help modal all derive
  from the registry).
- `web/tests/webmercator-tiles.test.ts` — NEW (14): pinned tiles for known
  Swedish locations, agreement with `elevation.service.ts`'s
  `lngLatToTilePixel` (the original port source), fractional inverse round
  trips, bounding boxes, trap-free guard (incl. the live lat-553.9 crash
  value), and the required **tile-pixel ↔ EPSG:3006 round trip against
  Lantmäteriet control points** (< 5 cm at z19, three points spanning
  Sweden).
- `web/tests/sam-client.test.ts` — NEW (8): `/health` + `/segment` contract
  with canned responses (URL/method/body pinned, incl. `offset_x/y = 0`),
  malformed-response degradation, HTTP-error throw, `largestPolygon`
  area-vs-count, crop size = sidecar `MAX_INFERENCE_SIZE`.
- `web/tests/sam-tool.service.test.ts` — NEW (15): `planCrop` centering/
  coverage/out-of-domain, crop-pixel georef round trip (< 0.01 px through
  the independent forward path), the required **synthetic-ellipse mask →
  simplify → fit round trip** (control count in [8,20], deviation ≤
  tolerance, fitted area within 3% of the projected mask, curve-on-contour
  check), **health-gate states** (online/offline/retry/offline-click
  no-op), and full `segmentAt` orchestration over a real `FeaturesService` +
  fake API (armed-type bspline created + selected, tile URLs =
  `/tiles/<mapKey>/ortho/19/x/y.jpg?v=…`, ONE history entry → single undo,
  interaction-claim gating, empty-mask notice, mid-flight sidecar death →
  notice + re-probe, out-of-domain rejected before any network).
- `docs/reports/T45-report.md` — this report.

## Deviations / interpretations

- **Health gate lives in the panel + click path, not the tool button.** The
  registry/command-bar has no per-tool disabled concept; adding one would
  touch shared chrome for all tools. The tool stays selectable — its panel
  states the gate ("sidecar offline — clicks are disabled" + Retry) and
  `segmentAt` refuses with the same notice. Matches the brief's
  "tool disabled cleanly when sidecar absent" in behavior.
- **History goes into `DrawToolService.history`** (injected as a seam).
  The SAM tool has no keybindings of its own; parking the create diff on the
  draw history means ⌘Z works the moment the user switches to Draw to
  refine — which is the designed next step.
- **`holeId: null`** — the brief specifies type + geometry only; hole
  assignment stays a draw-panel concern.
- **Crop origin snapped to integer pixels** (≤ 0.5 px off perfect
  centering): tiles then draw at integer offsets — no resampling blur in
  the JPEG the model sees — and the pixel↔world mapping stays exact.
- **`largestPolygon` measures area, not vertex count** (documented in the
  inherited client): a long skinny noise contour can out-count the real
  shape; pinned by test.
- Not verified live in a browser: needs the sidecar + a tiled course, and
  MapLibre doesn't load in the preview pane (rAF throttling — see memory).
  The full pipeline below the pointer wiring is covered by the service
  tests; manual smoke: start the sidecar (mock weights suffice), open a
  tiled course, pick "SAM assist" in the sub-mode dropdown, click a bunker.

## Test results

`cd web && bun test`:

```text
751 pass
0 fail
6960 expect() calls
Ran 751 tests across 58 files.
```

Baseline before this task was 714 pass / 0 fail; net **+37** tests (14 + 8 +
15 across the three new files).
`bun run check:client` and `bun run check:test` both pass clean.
`python3 -m py_compile tools/sam-server/server.py` OK.
