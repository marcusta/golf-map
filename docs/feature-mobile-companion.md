# Plan: Mobile Companion — golf-map in iOS Safari (v1)

**Status:** proposal
**Date:** 2026-07-23
**Scope:** `web/` (new mobile entry + screens, no editor changes), trivial `server/` static-serve wiring. No `ios/`, no `pipeline/` changes.

---

## 1. Purpose

App Store / TestFlight distribution is blocked until the paid Apple dev plan lands
(free-account sideloads expire in ≤7 days). Ship the on-course *viewing* experience to
mobile Safari so the phone is useful on the course today:

- **See the plan** — hole map with plan shots/gates, read-only.
- **Get distances** — live GPS distances (front/middle/back, plan targets, hazard
  carries) + plays-like.
- **Green view + green reading** — slope overlay, tap-to-read putt (break + Tour Read).

Explicitly NOT v1: shot capture, scoring, round sync, laser pin, calibration. Data
collection stays the iOS app's job. This is a permanent companion (share links,
quick look on anyone's phone), not a throwaway stopgap.

## 2. Reuse inventory (verified 2026-07-23)

The brains are already TS; the mobile app is a new shell, not new capability.

| Piece | Where | Coupling check |
|---|---|---|
| Strategy math: `feature-distances`, `plays-like`, `expected-strokes`, `layup`, putting (`readPutt`, `tourRead`, `demSurface`) | `shared/strategy/` | Pure TS, no DOM |
| Plan data layer | `web/src/planner/plan.service.ts` (459 L) | Clean: signals + API client only |
| Plan rendering | `web/src/planner/plan-overlay.ts` (1242 L) | Depends only on `map.service` `OverlayLayerSpec` + shared types — no editor imports |
| Putt read | `web/src/planner/putt-read.service.ts` (570 L) + `putt-overlay.ts`, `green-slope.ts` | Needs a `PuttContext` (courseId, green feature id + geometry, greenId, default hole) — constructible from course features + pins, no planner-tool needed |
| Green slope/height overlays | `web/src/analysis/` (math + overlay) | Reused by putt read already |
| Map stack | `web/src/map/` — `map.service` (MapLibre), `tileset.service`, `map-style`, `elevation.service` | `map.service` imports only maplibre + tileset + `interaction.ts`; no editor coupling |
| Auth | `web/src/auth/` + `@basics/core` cookie session | Works as-is; PWA installs share Safari cookies |
| Typed API clients | `shared/api/*.gen.ts` | As-is |

**Do not reuse:** `editor/`, `draw/`, `import/`, `map-build/`, `planner-tool.service.ts`
(2291 L of desktop tool arming), `planner-panel.component.ts`, docks/command bar. Desktop
UI is mouse-shaped; mobile UI is written fresh.

## 3. Architecture

**Second Vite entry in `web/`, not a new workspace package.**

```
web/
  index.html            # desktop (unchanged)
  mobile.html           # NEW → src/mobile/main.ts
  src/mobile/
    main.ts             # startApp(MobileAppComponent), own route table under /m/*
    app/                # shell: fullscreen map, bottom sheet, hole strip
    course/             # course list + hole screen
    gps/                # geolocation.service.ts, gps-dot overlay, wake lock
    green/              # green screen (putt read + slope overlay)
```

- Same `@basics/core` DI + signals; mobile composes the shared services
  (`MapService`, `TilesetService`, `PlanService`, `PuttReadService`, `ElevationService`)
  into its own component tree.
- Separate entry ⇒ tree-shaking keeps editor code out of the mobile bundle. Guard with
  a lint/test that `src/mobile/**` never imports from `editor|draw|import|map-build`.
- Vite: `build.rollupOptions.input = { main: index.html, mobile: mobile.html }`. Dev:
  `http://localhost:5173/mobile.html` (proxies `/api` + `/tiles` as today).
- Routes live under `/m/…` (`/m` course list, `/m/course/:id/hole/:n`,
  `/m/course/:id/hole/:n/green`) so the VPS static server can map the prefix to
  `mobile.html`. Desktop routes untouched.
- Fits the local-builder/VPS split (`feature-local-builder-vps-serve.md`): serve mode
  ships the static web build — mobile rides along in the same publish, and the VPS
  provides the HTTPS that Safari geolocation requires.

⚠️ Signals are eager/push-based (see `web/AGENTS.md`) — GPS tick → distance recompute →
overlay update chains must coalesce with `queueMicrotask` like the editor does.

## 4. Slices

### S1 — Shell + plan viewing (read-only)

1. `mobile.html` entry, viewport meta (`viewport-fit=cover`, no user scaling), safe-area
   CSS, `src/mobile/main.ts` with auth guard + login reuse.
2. Mobile shell: fullscreen MapLibre canvas, top hole strip (1–18 swipe/tap), bottom
   sheet for details. Touch targets ≥44 px. Light/dark via existing tokens.
3. Course list screen (reuse `CoursesApi`; card list, no editor affordances).
4. Hole screen: map framed tee→green per hole (bearing = hole axis, like iOS), ortho +
   vector features + `plan-overlay` in read-only mode (no drag handlers claimed).
5. Bottom sheet hole summary: par, plan primary line, shots with club + carry.
6. Import-boundary guard test + e2e smoke (course list → hole 1 → overlay renders).

### S2 — GPS + distances

1. `geolocation.service.ts`: `watchPosition` → `Signal<GpsFix | null>` (WGS84→SWEREF
   via existing `geo/transform`), accuracy + staleness surfaced. Secure-context check
   with a clear in-UI error when not HTTPS.
2. GPS dot + accuracy ring overlay (`OverlayLayerSpec`).
3. Distance readout (the big number): front/middle/back of the current green via
   `feature-distances`, plus tap-anywhere point distance.
4. Distances to plan targets + hazard carries for the current hole (reuse
   `browse-ladder` where it fits).
5. Plays-like: elevation at ball + target from `elevation.service`, shared
   `plays-like` math. Show delta beside raw.
6. Screen wake lock (`navigator.wakeLock`, iOS 16.4+) while the hole screen is open;
   re-acquire on `visibilitychange`.
7. Auto-advance suggestion: nearest hole by GPS on open (manual override always wins).

### S3 — Green view + putt read

1. Green screen: zoomed green framing, slope-arrow / height overlay reusing the
   analysis overlays via `PuttOverlayMode` ('slope' default, as desktop).
2. Build `PuttContext` from course features + active pin (default hole = pin else
   green centre — same rule as `putt-read.service`).
3. Tap ball position (or seed from GPS fix when on the green), drag to adjust; hole
   position editable. Read renders via `putt-overlay` + Tour Read verbal line.
4. Stimp input (default 10, clamp 4–16 as desktop); persists per session.
5. Honour `MIN_READ_CONFIDENCE` softening — never a confident read from bad data.

### S4 — Ship it

1. PWA manifest (name, icons, `display: standalone`, theme color) so Add-to-Home-Screen
   is fullscreen. **No service worker in v1** — offline tiles deferred; 4G + server
   is fine on-course.
2. Serve-mode wiring: static route maps `/m/*` → `mobile.html` (builder-mode dev uses
   the vite path). Belongs with the publish work in the VPS split plan.
3. Interim HTTPS for testing before the VPS exists: Tailscale Serve (or mkcert + LAN)
   — plain `http://<lan-ip>` gets **no geolocation** in Safari.
4. E2E: Playwright mobile viewport (iPhone profile) journey — login → course →
   hole → distances (mock geolocation via CDP) → green read. Run on the alt-port
   harness (3200/5474) per convention; never the preview pane (rAF-throttled).

## 5. Safari constraints (accepted for v1)

- No background GPS; screen must stay on → wake lock in S2.
- Geolocation only in secure contexts → HTTPS story in S4.3.
- GPS accuracy ~5–10 m, noisier than CoreLocation — fine for distances, why shot
  capture stays iOS.
- Compass heading needs a permission gesture (`DeviceOrientationEvent.requestPermission`)
  — **deferred**; map orients by hole axis instead.
- `localStorage` in PWA standalone mode is a separate store from Safari tabs — don't
  rely on it for anything the server should own.

## 6. Testing

Integration-first per `TESTING.md`: no new unit tests except hard algorithms (none new
— math is already tested in `shared/strategy`). Service-level tests for
`geolocation.service` mapping/staleness in happy-dom; the journey lives in the
Playwright e2e (S4.4).

## 7. Out of scope / later

- Shot capture, scoring, round sync (iOS owns; revisit only if TestFlight stays blocked).
- Offline tile caching service worker (tile-bundle concept exists from iOS if wanted).
- Compass map rotation; hole flyover animations; club advice UI (math is ready —
  `layup`/`option-chain` — UI deliberately deferred to keep v1 read-only).
- Mobile-detection redirect from `/` — separate URL is enough for v1.

## 8. Open questions

1. Do plan overlays need a decluttered mobile style (fewer labels at phone widths), or
   is the desktop overlay acceptable at z16+? Decide after S1 on a real phone.
2. Pin freshness: v1 reads the active pin from the server — good enough, or does the
   green screen need a "move pin locally" affordance for the day's cut?
3. Wave numbering: next free is T57 per the decision register — verify at kickoff
   (T54/T55 were double-booked once already).
