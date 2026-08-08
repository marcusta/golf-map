# Refocus roadmap — back to fundamentals, then earn everything back

**Status:** proposed
**Date:** 2026-08-04
**Amends:** [feature-tapscore-native.md](feature-tapscore-native.md) (scope cut, see §4)
**Defers (does not change):** [feature-smart-caddy.md](feature-smart-caddy.md),
[feature-hole-sim-and-variants.md](feature-hole-sim-and-variants.md),
[feature-plan-shot-options.md](feature-plan-shot-options.md),
[feature-putting-green-reading.md](feature-putting-green-reading.md)

---

## 1. Why

The plan/play/review side grew wide before it grew good. Most of the so-so
quality lives there: many features work, few are *finished* from a UX and math
perspective. As a single part-time developer the fix is not more building — it
is narrowing what the app *shows* until each layer passes a quality bar, then
re-adding the next layer on top of a foundation that is already trusted.

The ordering is a **trust ladder**: strategy advice is only credible if the
measurement under it is exact, and measurement is only credible if the data
display under it is solid. Build trust bottom-up — in the app and in the user.

## 2. Principles

1. **Hide, don't delete.** Nothing is removed from the codebase. Features are
   gated off at their *entry points* (menu items, chips, panels, card modes) —
   cheap to hide, cheap to restore, no surgery in the engines.
2. **Tests keep running for hidden features.** Hidden code rots silently as
   shared models evolve. Unit tests, parity pins (TS↔Swift golden fixtures)
   and e2e stay green the whole time, so re-enabling is a flag flip, not
   archaeology.
3. **A feature returns only through the quality bar** (§6). "It works" is not
   the bar; "I used it for N rounds and it never annoyed me or lied to me" is.
4. **One tier at a time.** While a tier is being polished, the tiers above it
   stay dark. No parallel dabbling.
5. **Engines are not features.** The shared strategy core (`shared/strategy/`
   + the Swift twins) stays intact and tested regardless of what UI is
   visible. Hiding club advice does not touch `club.ts`/`Club.swift`.

## 3. The tier ladder (high level)

| Tier | Theme | One-liner |
|---|---|---|
| **T1 — See the data** | Map & measurement display | The great data from "create" made visible: distances, slopes, elevations, green topology. No advice, no plans, no scoring. |
| **T2 — Measure, plan, score** | Exact measuring + simple planning + group scoring | Laser-calibrated on-course measuring, pin entry, a simple manual game plan (primary line only), shot capture, scorecard, native group scoring via Tapscore descriptors. |
| **T3 — Advise & simulate** | Strategy, caddy, putting reads, simulation | Everything that *recommends*: club advice, dispersion, decide mode, caddy rules, putt reads, hole simulation, strokes-gained review. Returns feature-by-feature, each through the bar. |

Within T3 the re-add order is decided later, feature by feature — likely
putting reads first (active doc work exists), then club advice/layup, then
decide/caddy, then simulation. Each T3 feature graduates independently.

## 4. Tapscore decision (supersedes T67's scope)

Ownership split: **golf-map produces play data** (shots, positions,
laser-exact distances, the map); **Tapscore owns formats, results,
leaderboards and review**. No duplication of scoring engines — every score is
still computed by Tapscore.

What changes vs [feature-tapscore-native.md](feature-tapscore-native.md):

- **Build S1 + S2 only** (T2 of this roadmap): Swift friendly-rounds client +
  offline queue, then group score entry — hole carousel, seat cards, strokes
  for every ball, and **generic metadata controls** driven by
  `ScoreEntryCapabilities` + `MetadataApplies`. This covers formats like
  Umbrella (GIR toggle etc.) with zero per-format Swift — the descriptors are
  data. Groups score together in golf-map, Gamebook-style.
- **S3 (leaderboards) and S4 (native setup UI) become deep links** to
  Tapscore's web app carrying the share token. Boards are glance-frequency,
  not per-shot — a link is enough. Round *creation* may later become a single
  `POST /friendly-rounds` call from golf-map (no setup UI), which auto-links
  the round.
- **S5 shrinks** to: entry points from the on-course UI, a `golfmap://` /
  universal link back from Tapscore's mobile web, token-pass in both
  directions.
- **The T60 bridge stays**, with T67 §7's per-round "golf-map keeps my score"
  toggle to prevent two-writer churn on your own ball.
- **Later enhancement (T3-era):** prefill your own metadata from shot capture
  — putts from strokes on the green, fairway hit from position vs polygon,
  GIR from position + stroke count. Confirm with one tap.

T67 S2–S5-as-written stay on the shelf as the documented upgrade path if
linked boards ever grate.

## 5. Mechanism — FeatureGates

The app already has both halves of this pattern; FeatureGates copies them
rather than inventing anything:

- **Competition mode** (`App/AppSettings.swift`) — an observable setting on
  `AppEnvironment`, consulted *inside the deriving models*
  (`OnCourseDistances`, `PuttReadModel`, `CaddyAdviceModel`, `decideContent`),
  so gated surfaces simply come back nil/empty and the views need no logic.
- **Serve-mode tool gating** (`web/src/app/server-mode.service.ts`) — a
  declarative `builderOnly` flag on each tool plus a *pure, exported, tested*
  function (`visibleEditorTools(mode)`); the service is only the signal that
  carries the answer.

### 5.1 The gate set — one JSON file, generated typed accessors

**Source of truth:** `shared/feature-gates.json`, hand-edited, one entry per
**Hide/Build** row in the catalogue (§7), named after the feature, not the
tier — per-feature names are what let T3 features graduate one at a time:

```json
{
    "pinEntry":        { "enabled": false, "tier": "T2" },
    "laserCalibration": { "enabled": false, "tier": "T2" },
    "planEditing":     { "enabled": false, "tier": "T2" },
    "planOptionsTree": { "enabled": false, "tier": "T3" },
    "decideMode":      { "enabled": false, "tier": "T3" },
    "puttRead":        { "enabled": false, "tier": "T3" }
}
```

(`tier` is documentation — where the feature is scheduled to return — since
JSON has no comments. `enabled` is the toggle.)

**Checks in code are never stringly-typed.** A raw `isOn("planEditng")` typo
would silently read as *off* — indistinguishable from "gated on purpose", the
worst failure mode this system can have. Instead a small bun script (the
`shared/api/*.gen.ts` codegen pattern) generates typed accessors from the
JSON:

- `ios/GolfMap/App/FeatureGates.gen.swift` — a struct with one `let` per
  gate, defaults baked in at build time. No runtime JSON parsing, no bundle
  resource.
- `shared/feature-gates.gen.ts` — a typed record + key union for web.

A misspelled or removed gate is a **compile error** on both platforms.
Shipping a tier = flipping `enabled` in the JSON and re-running the
generator; the JSON diff is the audit trail (§5.4). CI (or a pre-commit
check) verifies the generated files are in sync with the JSON, same as the
API codegen.

**Deliberately static.** Gates are baked at build — not fetched, not remote,
not changeable mid-session. This is a ship toggle for a solo developer, not
runtime remote config; release behavior stays auditable from the repo.

### 5.2 iOS

- `FeatureGates.gen.swift` provides the struct + defaults; a thin hand-written
  `App/FeatureGates.swift` resolves `static let current` once at launch:
  generated defaults, then `#if DEBUG` per-gate `UserDefaults` overrides
  (`gates.<name>`) and launch-argument overrides so the existing headless
  verify hooks (`-verifyPlanOptions` etc.) can force their feature on.
  Release builds see only the generated defaults.
- A plain struct (value type — trivially constructible in tests), injected the
  same way as `AppSettings`: held by `AppEnvironment`, handed into
  `OnCourseModel` and friends at construction. Not observable — gates don't
  change mid-session (the DEBUG override panel says "relaunch to apply", same
  contract as the server-origin setting).
- **Where the checks live — two kinds of entry point:**
  1. *Derived surfaces gate in the model*, mirroring competition mode:
     `planOptionChips` returns `[]`, `decideContent`/`roundCardMode` skips
     gated modes, the ladder's rung builders drop gated rung kinds,
     `hazardCarries`/advice fields return nil. Views then need no branching
     and degraded variants (§7's "Keep (degraded)") fall out naturally.
  2. *Chrome gates in the view* with a plain `if env.gates.x`: control-rail
     chips, `DistanceCardView` rows, sheet-presenting buttons, scorecard
     row, settings rows (e.g. default-stimp hides with `puttRead`).
- **Tool modes:** `MapToolMode` and the `enter*` methods stay untouched —
  gate the *buttons* that call them. A hidden tool is unreachable UI, not a
  removed capability; DEBUG overrides and tests can still drive `enterPlan()`
  directly.
- A `#if DEBUG` "Feature gates" section in `SettingsScreen` lists every gate
  with its default and override toggle.

### 5.3 Web

- `shared/feature-gates.gen.ts` provides the typed record + key union;
  `web/src/app/feature-gates.ts` adds pure predicate functions exported and
  unit-tested directly (the `visibleEditorTools` shape), e.g.
  `visiblePlannerSections(gates)`, `visibleLadderRows(gates, rows)`. A thin
  `FeatureGatesService` carries the resolved record as a signal for
  components.
- Resolution: generated defaults, overridable per-gate via
  `localStorage['gates.<name>']` (dev + e2e) — e2e helpers set gates the way
  they already prime auth/localStorage.
- Consulted by: planner panel section builders (gates collapse EV lights,
  gates UI, caddy, sim, quiz sections), the shots-list advice chips, mobile
  companion rows (plan legs, green-read entry). Route components stay
  mounted-able (deep links don't 404); a gated route renders its degraded
  variant or redirects to the hole view.

### 5.4 Rules

- **Gates gate presentation, never math.** No gate checks inside
  `shared/strategy/` or the Swift `Strategy/` twins; engines, parity pins and
  their tests run regardless.
- **Server APIs are never gated** (§7.J) — hiding is a client concern.
- **Competition mode stays orthogonal**: it is a *user* runtime toggle over
  visible features; gates are a *developer* ship toggle. `puttRead` gate off →
  no putt UI at all; gate on + competition mode → the existing behavior.
- Every gated-off surface keeps its unit tests; degraded variants ("ladder
  without plan rungs") get their own tests so partial states don't crash.
- Flipping a gate's `enabled` requires the §6 quality bar and a decision-log
  line — the `shared/feature-gates.json` diff *is* the audit trail.

## 6. Quality bar (the gate to return)

A hidden feature comes back when all of:

1. **Math validated** — engine output checked against ground truth (laser,
   level, known slopes) or golden fixtures; TS↔Swift parity pinned where both
   exist.
2. **UX pass on-device** — real phone, in sunlight, with a glove in the other
   hand. One-handed, ≤2 taps to the common action, no dead ends.
3. **Field-tested N real rounds** (default N=3) without the feature lying,
   annoying, or being ignored. The scratch-golfer author is the test lab;
   rounds-played is part of the gate, not optional.
4. **Tests cover the re-enabled path** (unit + the relevant e2e/headless
   verify hook).

Each returning feature gets a one-line entry in the decision log when it
passes (date, N rounds, what changed).

---

## 7. Feature catalogue

Every player-facing feature, its fate, and where it comes back. Legend:

- **Keep** — visible from day one (T1).
- **Hide → T2 / T3** — gated off now, returns at that tier through the bar.
- **Build** — new work scheduled in that tier.
- **Infra** — invisible plumbing; untouched and always on.

### A. Map & data display — the T1 core

| Feature | Fate | Notes |
|---|---|---|
| On-course map (ortho + feature polygons) | **Keep** | T1 polish target: rendering, palette, load feel |
| Hole framing / camera, recenter, zoom | **Keep** | |
| Hole navigation header | **Keep** | |
| Immersive / chrome toggle + compact chip | **Keep** | |
| Distance card — big number, Front/Center/Back, pin row | **Keep** | Advice rows on the card are hidden (see E) |
| Plays-like (slope-adjusted) distances | **Keep** | This *is* "seeing elevation". Validate the model in T1 |
| Elevation Δ / slope readouts | **Keep** | |
| Elevation profile sheet | **Keep** | T1 polish target |
| Distance ladder rail | **Keep (degraded)** | T1 rungs: green F/C/B, pin, hazards, aim points. Plan-landing rungs return T2; layup-outcome rung returns T3 |
| Hazard carries (front/carry figures) | **Keep** | Mapped data, not advice |
| Hole route + per-leg labels | **Keep** | |
| Course route overlay | **Keep** | |
| Green view — slope/height/relative heat overlay + legend + fall lines | **Keep** | Data display. Caddy strip inside it is hidden (E) |
| Green stats popover + surrounds buffer | **Keep** | |
| Tee selection & tee menu | **Keep** | |
| GPS / Browse toggle, browse-point inspection, "browse from here" | **Keep** | |
| Far-from-course degraded state | **Keep** | |

### B. Measuring & calibration

| Feature | Fate | Notes |
|---|---|---|
| Measure tool (multi-point, Δ elev, slope %, plays-like, profile) | **Keep** | Fundamentals: "measuring the data". T1 polish target |
| Adjust mode (move tee/aim/green locally) | **Keep** | Data correction, low risk |
| Pin entry (voice sv/en + schematic confirm) | **Hide → T2** | First T2 wave |
| Clear placed pin | **Hide → T2** | With pin entry |
| Laser entry (contextual routing) | **Hide → T2** | |
| GPS calibration — anchor ("I am here") | **Hide → T2** | |
| GPS calibration — laser trilateration | **Hide → T2** | |
| Calibration status chip / staleness / residual refresh | **Hide → T2** | Open TODO rides along: opportunistic residual refresh |
| Laser carry check row | **Hide → T2** | |
| Spot level capture (IMU) | **Hide → T3** | Serves putt reads; returns with them (data capture could return late-T2 if wanted) |
| LiDAR corridor scan | **Hide → T3** | Same — Tier-1 putt surface input |

### C. Planning

| Feature | Fate | Notes |
|---|---|---|
| Game plan viewer (violet line, P-nodes, leg tints) | **Hide → T2** | Returns *without* ellipses/ghost aims (those are T3) |
| Plan editing on iOS (place/drag/remove shots, club per shot) | **Hide → T2** | "Simple manual planning" |
| Plan option chips / shot options tree | **Hide → T3** | T2 plan = primary line only |
| Apply recommended aim (iOS + web) | **Hide → T3** | Depends on aim optimizer |
| Wind chip + wind editor (plan + per-hole) | **Hide → T2** | Simple input, feeds plays-as |
| Web planner — mode bar, shots list, tee/notes/hole settings, browse ladder | **Hide → T2** | Basic manual planner returns; strip the advice sections below |
| Web planner — gates + auto-gates | **Hide → T3** | Strategy-engine adjacent |
| Web planner — legs EV readout + leg lights | **Hide → T3** | |
| Web planner — caddy section | **Hide → T3** | |
| Web planner — elevation profile section | **Keep** | Data display; harmless to leave in the panel |
| Hole simulation / variants (histogram, landings, suggest lines) | **Hide → T3** | Last to return |
| Plan sync / storage (iOS + web + server) | **Infra** | Always on |

### D. On-course play

| Feature | Fate | Notes |
|---|---|---|
| Round lifecycle (start/finish/resume) | **Hide → T2** | |
| Shot capture (crosshair, club, type, confirm, hole-out, penalty) | **Hide → T2** | Core T2 loop |
| Playing state / divergence detection | **Infra → T2** | Engine on; drives card modes when T2 lands |
| Round card — teePreview mode | **Hide → T2 (degraded)** | Tee club + first aim + the one hazard; drop suggested-club until T3 |
| Round card — plan mode (leg you're playing) | **Hide → T2** | |
| Round card — decide mode (ranked choices, score triple, caddy why) | **Hide → T3** | The flagship advice surface — earns its way back |
| Working target | **Hide → T3** | With decide |
| Round card — green mode | **Hide → T2 (degraded)** | "On the green · N m to hole"; the Read-putt handoff returns T3 |
| Tee geofence advance prompt | **Hide → T2** | |
| Web mobile companion — hole screen | **Keep (degraded)** | T1: map, F/C/B, GPS dot, tap distances. Plan-leg rows return T2 |
| Web mobile companion — course list / login | **Keep** | |

### E. Advice & strategy — all T3

| Feature | Fate | Notes |
|---|---|---|
| Club advice (F/C/B + pin clubs) | **Hide → T3** | |
| Layup line ("Driver 243 · 58 m in") | **Hide → T3** | |
| Selected-target advice banner | **Hide → T3** | Selected-target *distance/Δ* stays (data); club/carry advice hides |
| Dispersion ellipse + label | **Hide → T3** | |
| Wind hold / crosswind aim marker | **Hide → T3** | |
| Plays-as (wind) distances | **Hide → T2** | Returns with the wind editor |
| Aim optimizer (engine) | **Infra** | |
| Expected strokes / EV (engine) | **Infra** | |
| Forward-route aim filter | **Infra** | Serves T1 routing |
| Lie / surface classification (engine) | **Infra** | |
| Smart caddy — all rules (slope-half, carry-it, no-doubles, short-side, specific-target, medicine, par5-attack) | **Hide → T3** | Rule-by-rule return is allowed |
| Caddy in Green view | **Hide → T3** | |
| Plan caddy advice | **Hide → T3** | |
| Competition mode gating | **Keep** | Orthogonal runtime gate, unchanged |

### F. Putting / green reading — T3 (first T3 candidate)

| Feature | Fate | Notes |
|---|---|---|
| Putt read panel (ball/hole markers, break path, aim/pace) | **Hide → T3** | Active doc: feature-putting-green-reading.md |
| Read tiers (scan / DEM / tour-read / manual) | **Hide → T3** | |
| Rolling-ball integrator | **Infra** | |
| Stimp control (iOS slider, mobile stepper, default in settings) | **Hide → T3** | Returns with reads |
| Putt-read training quiz (iOS + web) | **Hide → T3** | |
| Web planner putt tool | **Hide → T3** | |
| Web mobile green screen | **Hide → T3** | Green *view* (slope display) stays T1; the read flow hides |
| Green calibration confidence | **Infra → T3** | |

### G. Scoring — T2 (mostly Build)

| Feature | Fate | Notes |
|---|---|---|
| Scorecard sheet + stroke editor | **Hide → T2** | |
| Tapscore bridge (token link, ball pick, auto-publish own score) | **Hide → T2** | Built (T60); returns with scoring + "keeps my score" toggle |
| Native Tapscore client + offline queue (T67 S1) | **Build T2** | GRDB queue mirrors RoundStore syncState |
| Group score entry, descriptor-driven metadata (T67 S2) | **Build T2** | Covers Umbrella-style GIR etc. generically |
| Deep links: leaderboard/scorecard → Tapscore web; `golfmap://` back | **Build T2** | Replaces T67 S3 |
| One-call round creation (`POST /friendly-rounds`) + auto-link | **Build T2 (late)** | Replaces T67 S4; optional if token-paste holds up |
| Own-metadata prefill from shot capture | **Build T3** | Enhancement after capture + scoring both trusted |

### H. Review / stats — T3

| Feature | Fate | Notes |
|---|---|---|
| Strokes-gained round analysis (web) | **Hide → T3** | Component exists, currently unmounted anyway |
| Putt read accuracy trend (web) | **Hide → T3** | Also unmounted |
| Round history data (API + store) | **Infra** | |
| Deeper review (trends, SG over time) | **T3, prefer Tapscore-side** | Tapscore pulls shot/plan data from golf-map's API rather than golf-map growing a stats UI |

### I. Settings, account, offline — Keep

| Feature | Fate | Notes |
|---|---|---|
| Login / auth, course list + download, offline bundles, sync engine | **Keep / Infra** | T1 polish: download/update UX |
| Settings screen (competition mode, units, server origin) | **Keep** | Default-stimp row hides with putt reads |
| Clubs screen (iOS) + player settings (web) | **Keep** | Needed by T2 capture; harmless in T1 |
| Distance unit formatting | **Keep** | |

### J. Server APIs

All stay up (**Infra**) — hiding is a client-side concern. No endpoint is
removed; `putt-estimate`, `green-calibration`, `game-plans` etc. keep serving
their tests and the debug overrides.

---

## 8. Wave plan (what actually gets done, in order)

**W0 — Gate it.** Introduce `shared/feature-gates.json` + the generator
(§5.1), the iOS/web resolution layers, wire every entry point in §7, debug
override panel, e2e/headless hooks keep passing with gates off. Small,
mechanical, one wave.

**W1 — T1 polish.** Live with the fundamentals app for real rounds. Fix what
grates: distance card, ladder (degraded set), plays-like validation against
laser numbers, elevation profile, green view readability, measure tool,
bundle download UX. Exit: T1 passes the bar as a *product* — a great
map-and-numbers app you'd happily use with zero advice.

**W2 — T2 measuring.** Re-enable pin entry, laser entry, both calibration
paths, status chip, laser carry check. Close the opportunistic-residual-refresh
TODO. Exit: measured distances trusted to laser-grade over ≥3 rounds.

**W3 — T2 planning.** Re-enable plan viewer + simple editing (primary line
only), wind editor, web planner basics. Exit: a plan authored on web, followed
on the phone, without confusion.

**W4 — T2 scoring.** Re-enable rounds + capture + scorecard + bridge; build
T67 S1+S2 + deep links. Exit: a full group round scored in golf-map start to
finish, boards checked via link, no Tapscore-web score entry needed.

**W5+ — T3, feature by feature.** Each candidate gets its own mini-brief,
math validation, and field rounds before its gate flips. Proposed first:
putting reads (doc momentum), then club advice + layup, then decide + caddy,
then options tree, then simulation, then SG review. Order can be reshuffled
freely — the mechanism doesn't care.

## 9. Risks / notes

- **Degraded-mode edges:** the ladder, tee card and green card have "degraded"
  T1/T2 variants — those partial states need their own tests so hiding a rung
  doesn't crash a builder.
- **Docs stay authoritative for engines:** the deferred feature docs
  (smart-caddy, hole-sim, plan-shot-options, putting) are not rewritten by
  this plan; only their *visibility* is deferred.
- **Don't let W1 become a rewrite.** T1 polish is finish-work, not
  rebuild-work. If something needs deep rework, it gets a brief and a
  decision, not a quiet detour.
