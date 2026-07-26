# Phase 5 kickoff prompt — Strategy planning (shared math + web planner)

Start Phase 5 of the golf-map project: **game strategy planning**. This prompt is deliberately scoped to the two highest-leverage, still-greenfield pieces — the **shared strategy math** and the **web plan editor + plan/sync data model**. The iOS planner and on-course "plan-vs-reality" display are explicitly **out of scope here** (they become a cheap port once this lands — see "Why this scope").

## Context

Repo: `/Users/marcust/dev/github/golf-map`. Read `ROADMAP.md` first (Phase 5, plus §1 "Strategy math worth porting" and §2.6 web framework), then `README.md`. Phases 0–4 are complete and committed:

- **Server** (`server/`): Bun + `@basics/core` (Marcus's framework at `/Users/marcust/dev/github/mackans-client-fw`), SQLite source of truth, cookie-session auth, descriptor APIs → generated TS clients in `shared/api/`.
- **Web** (`web/`): `@basics/core` client app (NOT React), MapLibre GL JS, editor tools drawn in a screen-space SVG/canvas overlay, geometry in projected CRS (SWEREF99TM), WGS84 derived. Course builder is complete; Landeryd Masters (id `26D37361-D79C-41AA-AA49-92F2C2277222`) is fully built and published.
- **iOS** (`ios/`): on-course app, offline bundles, live distances + plays-like + green view. Mature (300+ tests).

## Phase 5 goal (this prompt)

ROADMAP exit criterion for the phase: *"a plan built on web is the on-course guidance on the phone."* This prompt delivers the **web + shared** half so that criterion is reachable:

1. **One tested strategy-math library** in `shared/` (pure TS, zero framework deps) that both web (now) and iOS (later, ported to Swift) consume as the single reference implementation.
2. **A web plan editor** — per tee, per hole, shot sequence, dispersion overlays, wind scenarios, plays-like distances.
3. A **plan/sync data model** clean enough that iOS light-edits sync back without conflict pain (optimistic-lock `version` columns already exist — design the semantics, don't just inherit them).

## What already exists (don't rebuild — verify + extend)

The Phase-5 **server surface is largely built** from Phase 0's schema-from-day-one policy. Read these before designing anything:

- `server/db/schema.ts`: `ClubsTable` (`carry_m`, `dispersion_m`, `sort_order`), `GamePlansTable` (per-plan `wind_speed_mps`, `wind_direction_deg`), `GamePlanHolesTable` (`tee_id`, `preferred_club_id`, `planned_direction_deg`), `PlanShotsTable` (ordered `lat`/`lon`/`elevation`/`club_id`). All carry `version`.
- `server/api/game-plans.api.ts` + `server/api/clubs.api.ts`, with gen clients `shared/api/game-plans.gen.ts` (`getByCourse`/`upsert`/`setHole`/`addShot`/`updateShot`/`removeShot`/`reorderShots`) and `shared/api/clubs.gen.ts`.

So the API is mostly there. Your server work is **gap-filling, not greenfield** — and each gap is a data-model decision, which is exactly the Fable-worthy part:

- **Wind is per-plan today**, but real planning wants per-hole (or at least per-hole override) wind. Decide: per-hole wind fields vs a "wind scenario" the user toggles vs both. Migrate the schema if needed.
- **Units mismatch to resolve up front**: schema stores `wind_speed_mps`; v1's wind rules are stated per-mph (see below). Pick canonical storage (m/s) and keep mph purely a display/input concern. Document it.
- Confirm the plan shape is complete for on-course consumption (what does the phone need to *render* guidance that the current shape can't express?).

## The math to port (v1 reference)

Source of truth for the domain math: **v1 iOS app** at `/Users/marcust/dev/golf-course-map/GolfCourseMap` (proven on 20 courses / 326 holes). Port concepts, re-implement cleanly in TS:

- **Dispersion ellipse** (core feature, v1 parity — keep it): lateral × length axes, rotated by shot bearing. Lateral from club `dispersion_m`; length dispersion is derived (see v1). Render as a MapLibre overlay in projected space. It must be **anchorable to any planning node** — a **tee box**, an **aim point**, or a **plan shot point** — showing the selected club's zone projected forward from that origin along its bearing. Changing the club at a node updates its ellipse. This is the primary "where does this shot land" visual; the corridor ruler below is a separate, complementary tool.
- **Wind adjustment**: headwind ≈ −1%/mph, tailwind ≈ +0.5%/mph, harsher above ~18 mph — port the exact v1 curve, don't approximate from this summary. Cross-wind → lateral shift. Store canonical in m/s.
- **Plays-like distance**: geometric distance + elevation delta (uphill plays longer). iOS already computes plays-like from Terrain-RGB on-course — reuse the same formula so web and phone agree. Web can sample elevation from the `analysis` service / terrain tiles.
- **Distance rings** and club-carry selection helpers.

`shared/` currently holds only generated API clients. Add a `shared/strategy/` (or similar) module: pure functions, unit-tested against v1 behavior, **no MapLibre / no `@basics/core` imports** so the Swift port later is a mechanical translation of the same reference, not a redesign.

Optional seed material: `data/golfcoursemap-export-2026-03-24.json` has 13 clubs + 18 v1 game plans — useful as fixtures / to validate the ported math reproduces v1 numbers.

## The web plan editor

- Lives in `web/`, on `@basics/core` client conventions (study the course builder's component/service/EntityStore patterns and reuse the map + feature-palette rendering — don't fork a second map stack).
- Reuse the existing course MapLibre view; add planning overlays in the screen-space SVG/canvas layer (same pattern the editor uses for tools).
- Per hole: pick tee → place aim/shot sequence → per-shot club → dispersion ellipse conforms to bearing + wind → running plays-like and remaining distance. Wind scenario control at plan and/or hole level per the decision above.
- Persist through the existing `game-plans` API (optimistic locking already wired). Design edits so they're granular (per-hole, per-shot) — that granularity IS the sync story for iOS.

### Corridor-width ruler (in-play width) — required, new entity

Club dispersion zones (above) stay — but in v1 the *only* way to judge "how much can I miss?" was eyeballing that arc against the hole, which was clumsy. Add a first-class tool **alongside** the dispersion overlay (both visible at once):

- **A draggable ruler perpendicular to the aim/shot line** at a station the user places along the leg. Drag its ends to widen/narrow; it shows the current width in metres. Answers "how wide is the playing corridor here — how far offline before I'm in trees / hazard / bunker / OOB (ordinary rough is fine)?"
- **Persistent annotation, not a transient measure.** The user can leave a ruler behind. It's saved with the plan and re-renders when returning to planning AND in on-course **playing mode** on the phone. This is the key differentiator from a scratch measuring tool — model it as saved plan data.
- This means a **new plan-attached entity** (e.g. `plan_gates` / corridor markers): parent `game_plan_hole` (or anchored to a specific shot/leg), a station position along the line, a width (or half-width each side, since corridors aren't symmetric), `version`. It syncs and renders exactly like `plan_shots` — add it to the `game-plans` API surface and the on-course plan render, same optimistic-lock pattern.
- **Strongly consider auto-computed width**, not just manual drag: the course vector polygons already exist (`course_features`: green/fairway/bunker/water/rough/outside). At any station you can compute the actual in-play half-widths left/right by ray-casting the perpendicular against the hazard/OOB/tree boundaries (rough = in play). That is the "ideal" the old arc never delivered. Manual drag is the MVP; make the entity + math shape able to hold a computed width so auto-fill is a later add, not a remodel. Put the ray-cast width math in `shared/strategy/` (pure, tested) alongside the dispersion math.

### Player config UI (parallel Opus track — not a prerequisite)

The active player needs a UI to configure their **clubs** (name, carry, dispersion, order — CRUD) and other player-level settings. This is low-ambiguity CRUD: hand it to a cheaper model. It is **not** a prerequisite for the planner — seed the 13 clubs from `data/golfcoursemap-export-2026-03-24.json` and planner dev is unblocked. The only ordering constraint runs the other way: **the math port finalizes what fields a club needs** (schema today is just `carry_m` + `dispersion_m`; v1's math may require more). So: land `shared/strategy/` first to settle the club model, then build the config UI against those fields — concurrent with the web planner, different files, no contention.

## Why this scope (and what's deferred)

Getting the **shared math + plan shape + sync semantics** right once makes the *iOS planner (deferred)*, *on-course plan-vs-reality (deferred)*, and *Phase 7 follow-up calibration (deferred)* into cheap follow-on work on any model. That's why this is the piece to spend the strong model on. Do **not** start the Swift planner or the pipeline/new-course wizard here.

Cross-cutting risk to hold in mind while modeling: **the plan is the contract between web (authoring) and phone (light edits + guidance).** Whatever shape you settle drives both clients and the follow-up loop — treat the data model as the deliverable, the UI as its first consumer.

## Working conventions (established phases 0–4)

- Run server: `cd server && bun run dev:server` (port 3000, DB `data/app.sqlite`, user `marcus`/`change-me`). Web dev per `web/` scripts.
- Orchestrate with sub-agents: **strong model (Fable) for the demanding design** (math port, schema/sync decisions, planner architecture), cheaper model for well-specified mechanical work. Parallel agents only with strict per-agent file ownership; review between batches.
- Every piece gets unit tests AND live verification (preview the web app, confirm overlays render + numbers match v1) before "done". Honest reporting — failed/skipped things said plainly.
- Don't modify `mackans-client-fw` unless the task is explicitly about the framework (golf-map consumes it as a versioned tarball in `vendor/`; a framework change means a real release there, then `bun run fw:update` here).
- Commit at reviewed milestones, descriptive messages, **never Co-Authored-By**. Record decisions in `ROADMAP.md` as they're made.

## Suggested opening move

Recon batch (parallel, read-only), then plan build batches:
1. Extract the exact v1 math — dispersion axes + length-dispersion derivation, the precise wind curve, plays-like formula — from `/Users/marcust/dev/golf-course-map/GolfCourseMap`. Produce a spec with numbers to test against.
2. Audit the current `game-plans`/`clubs` server surface + schema against what full planning needs; list the schema/API gaps (wind granularity, units, anything the phone can't render) as concrete decisions.
3. Study the web course-builder's map + overlay + EntityStore patterns for reuse in the planner.

Then: land `shared/strategy/` (tested) first, fill server gaps second, build the web editor on top.
