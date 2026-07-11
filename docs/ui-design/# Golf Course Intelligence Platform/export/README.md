# Golf Intel — Design Tokens · v0.1 · "Links & Loam"

Platform-neutral token set for the golf course intelligence platform. Author once, ship to web and iOS.

## Files
- **`tokens.css`** — CSS custom properties. Default `:root` is light; add `[data-theme="dark"]` on `<html>` to switch.
- **`Tokens.swift`** — SwiftUI. Light/dark resolve automatically via `UITraitCollection` (no asset catalog needed). Drop in and use `Color.textPrimary`, `Space.s4`, `AppFont.metricXL`, `MapFeature.fairway`, etc.

## Naming convention
| Neutral token         | Web (CSS)                 | iOS (Swift)          |
|-----------------------|---------------------------|----------------------|
| `color.text.primary`  | `--color-text-primary`    | `Color.textPrimary`  |
| `space.4`             | `--space-4`               | `Space.s4`           |
| `radius.md`           | `--radius-md`             | `Radius.md`          |
| `map.fairway.fill`    | `--map-fairway-fill`      | `MapFeature.fairway.fill` |

## Token layers
1. **Primitives** — raw palette (reference only; code should use semantic names).
2. **Semantic** — text / surface / border / accent / status. Light + dark.
3. **Map overlay** — frosted panel fills, scrims, over-map text, control fills. Light + dark. Kept as explicit rgba because they sit on imagery.
4. **Cartography** — SVG feature fills (fill / draw / outline). **Theme-independent** — the map renders the same regardless of UI theme. Adapted from the source course palette: chroma pulled down ~25–35%, hues warmed toward the earthy system, each feature tied to a brand token where one exists.
5. **Data-viz** — sequential (elevation, heat), diverging (target), semantic (good/neutral/risk/bad), categorical (cool counter-hues for turf separation). Theme-independent.
6. **Scale** — 4-pt spacing, radius, elevation (dark swaps shadow → warm glow).
7. **Type** — Schibsted Grotesk (UI) + JetBrains Mono (numerics, `tabular-nums`).
8. **Motion** — durations + easings; no bounce. Respects `prefers-reduced-motion`.

## Fonts
- **Schibsted Grotesk** — weights 400/500/600/700/800
- **JetBrains Mono** — weights 400/500/600/700

Web: load via Google Fonts or self-host. iOS: add both to the bundle and register `SchibstedGrotesk` / `JetBrainsMono` PostScript names (adjust the names in `AppFont` to match your embedded files).

## Notes
- Dispersion stroke differs by map render: `#E6D8BE` (light) / `#E6C08A` (dark) — the one map-overlay value that follows the UI theme.
- Two densities share one scale: the desktop **builder** lives in the tight end (space 1–4, radius xs–sm); the on-course **companion** in the roomy end (space 6+, radius md–lg, ≥44px touch targets).

_Source of truth for the visual language: `Design Tokens.dc.html` and `Mood Direction.dc.html` in this project._
