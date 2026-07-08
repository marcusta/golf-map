# Green scan payload contract (v1)

The wire format for `POST /api/green-calibration/scans` (`payload_json` /
`quality_json`), shared by the iOS producers (spot-level D2, LiDAR corridor E1)
and the server calibration consumer (E2). The server stores payloads verbatim
(schema-agnostic storage, task S1); this document is the contract that makes
them interpretable. Version every payload — consumers must ignore kinds or
versions they don't understand, never guess.

Source design: docs/feature-putting-green-reading.md §4.1–4.2.

## Envelope (all kinds)

```json
{
    "version": 1,
    "kind": "spot_level" | "corridor",
    "capturedAt": "2026-07-07T14:00:00Z",
    "device": "iPhone17,2",
    "appVersion": "0.1.0"
}
```

`kind` duplicates the `green_scans.kind` column on purpose: the payload must be
self-describing when read in bulk.

## `spot_level` payload (v1)

Phone laid flat on the green ~1 s; gravity-anchored tilt is ~0.1° truth
(doc §4.2). One reading = one calibration sample against the DEM.

```json
{
    ...envelope,
    "location": { "lat": 58.4, "lon": 15.6, "horizontalAccuracyM": 3.2 },
    "slopePct": 2.3,
    "fallLineBearingDeg": 213.5,
    "sampleDurationS": 1.2,
    "sampleCount": 120,
    "tiltStdDeg": 0.04,
    "headingAccuracyDeg": 5.0
}
```

- `slopePct` / `fallLineBearingDeg`: tilt magnitude (rise/run × 100) and the
  DOWNHILL compass bearing — same conventions as `shared/strategy/putting/`.
- `tiltStdDeg`: std-dev of the tilt over the sampling window; the capture UI
  should refuse a reading that won't settle.
- `headingAccuracyDeg`: compass accuracy — the weak link for bearing; the
  consumer down-weights the bearing (not the magnitude) accordingly.

## `corridor` payload (v1)

The out-and-back LiDAR line-walk (doc §4.1). Local frame: gravity-aligned,
origin at the BALL anchor point, +z up along gravity, +x = the horizontal
projection of the ball→hole direction at scan start, +y completing a
right-handed frame (left of the line, looking at the hole). Yaw/position drift
is unbounded in ARKit; roll/pitch (what slope needs) is gravity-anchored —
which is why the frame is defined this way.

```json
{
    ...envelope,
    "ball": { "lat": ..., "lon": ..., "horizontalAccuracyM": ... },
    "hole": { "lat": ..., "lon": ..., "horizontalAccuracyM": ... },
    "endpointLevels": [ <spot_level-shaped reading at ball>, <at hole> ],
    "frame": { "originalLineBearingDeg": 213.5, "lineLengthM": 8.2 },
    "points": [[x, y, z], ...],
    "fit": {
        "type": "poly2",
        "coefficients": [c00, c10, c01, c20, c11, c02],
        "rmseM": 0.004,
        "corridorWidthM": 2.1,
        "coverageFrac": 0.93
    },
    "passes": [
        { "direction": "out",  "fit": { ...same shape... } },
        { "direction": "back", "fit": { ...same shape... } }
    ],
    "passMismatchSlopePct": 0.12
}
```

- `points`: decimated gravity-frame point cloud, ≤ 5000 points, meters — kept
  so the server can refit/re-diff with better math later without re-scanning.
- `fit.type = "poly2"`: h(x, y) = c00 + c10·x + c01·y + c20·x² + c11·xy +
  c02·y², fitted over the combined passes. This is the Phase-E starting choice
  for open question Q4; a future `"tps"` (thin-plate spline) type may be added
  — consumers must switch on `type`.
- `endpointLevels`: the two static IMU readings bracketing the walk — the
  free drift check (§4.1). Their disagreement with the fit at the endpoints is
  QC signal.
- `passMismatchSlopePct`: mean |slope difference| between the out and back
  fits over the corridor — THE quality number (§4.1).

## `quality_json` (both kinds)

```json
{
    "verdict": "green" | "yellow" | "red",
    "passMismatchSlopePct": 0.12,
    "rmseM": 0.004,
    "coverageFrac": 0.93,
    "endpointLevelDeltaPct": 0.08
}
```

Verdict thresholds live in the iOS capture code (they gate the UI: green =
show read, yellow = suggest re-scan, red = refuse). For `spot_level`, verdict
derives from `tiltStdDeg` settling; mismatch/rmse/coverage are corridor-only
(omit for spot levels).

**Server rule (E2): only `green` and `yellow` scans count toward calibration
(yellow at half weight); `red` is stored but never used. Never show a
confident read from a bad scan — doc §4.1.**

## `green_calibration.bias_json` (v1, written by the server consumer)

Low-frequency plane correction to the DEM gradient over a green:

```json
{ "version": 1, "tiltE": 0.004, "tiltN": -0.002, "fittedAt": "...", "sampleCount": 7 }
```

Applied by Tier-2 consumers as: corrected ∇h = DEM ∇h + (tiltE, tiltN)
(rise/run fractions, EPSG:3006 east/north axes — matching
`shared/strategy/putting/green-surface.ts` conventions).
