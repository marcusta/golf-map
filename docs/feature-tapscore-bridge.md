# Plan: Tapscore Scoring Bridge

**Status:** in progress (V1 built, server-side only)
**Date:** 2026-07-25
**Wave:** T60
**Scope:** `server/` only — one migration, a hand-written Tapscore HTTP client, a
bridge service, a small link/unlink/status API, and a shot-write hook on
`RoundsService`. No `web/`, `ios/`, or `pipeline/` changes.

---

## 1. Purpose

[Tapscore](https://github.com/marcust/tapscore) (a Bun + Hono + Kysely/SQLite
sibling of golf-map) is the scoring **system of record** — rounds, players,
handicaps, competitions, leaderboards. golf-map is the on-course **capture
device**: it already records every shot with GPS, club, lie, and penalties.

The bridge lets a golf-map round **publish its per-hole score into a Tapscore
round** so the two stop being islands. golf-map stays the capture device; it does
not become a scoring engine, and Tapscore does not learn about maps.

The design goal is the *smallest* coupling that works: **no auth/identity
coupling, no new sync protocol.** A Tapscore *friendly round* is reachable by a
**share token** that is the whole credential (Tapscore's no-login front door).
golf-map holds that token and POSTs scores over HTTP.

## 2. V1 scope (this wave)

Friendly rounds via share token, server-side only:

- **One migration** — `014_tapscore_link.ts` adds two nullable columns to
  `rounds`: `tapscore_round_token` (the share token; null = unlinked) and
  `ball_id` (which Tapscore ball/scorecard-column the scores land on).
- **`services/tapscore-client.ts`** — a hand-written HTTP client (`fetch`, not
  `apiFetch`) against Tapscore's friendly-rounds-by-token endpoints. Base URL
  from `TAPSCORE_BASE_URL` (origin only; the client appends `/api/...`).
- **`services/tapscore-bridge.service.ts`** — link/unlink/status + the publish
  logic. After each shot-sync write lands, it recomputes per-hole gross strokes
  for the changed hole(s) and POSTs Tapscore score events.
- **`api/tapscore-bridge.api.ts`** — `GET/POST /rounds/tapscore-link` and
  `POST /rounds/tapscore-unlink`, following the descriptor pattern so the typed
  client (`shared/api/tapscore-bridge.gen.ts`) regenerates.
- **Shot-write hook** — `RoundsService` gained an optional `onShotsChanged`
  callback fired after `addShot`/`updateShot`/`removeShot`; `createServices`
  wires it to `TapscoreBridgeService.syncHoles`.

**Out of scope for V1** (see §7 phasing): iOS link UI, identity linking /
competitions, GIR / putts metadata, engine extraction.

## 3. How it works

### 3.1 Linking

A client links a golf-map round to a Tapscore round with the **share token**
(and optionally an explicit `ballId`):

1. `link(roundId, token, ballId?)` fetches the token's balls
   (`GET /api/friendly-rounds/balls`). An unknown token → `NotFoundError` (404).
2. Ball resolution: an explicit `ballId` must be one of the round's balls (else
   `ConflictError`); when omitted, a **single-ball** round auto-picks it, and a
   multi-ball round is rejected as ambiguous (`ConflictError`).
3. The token + resolved ball are stored on the round, and current scores are
   pushed immediately (`syncAll`, best-effort) so an in-progress round appears
   in Tapscore right away.

Linking is a deliberate action, so it *may* throw (bad token, ambiguous ball,
Tapscore unreachable). This is the one place failure surfaces to the caller.

### 3.2 Publishing (the hook)

Every golf-map shot write (`addShot`/`updateShot`/`removeShot`) fires
`onShotsChanged(roundId, holeNumbers)`. For an unlinked round this is one cheap
DB read and a return — near-zero cost, which is the common case. For a linked
round, `syncHoles`:

1. Fetches the round's **itinerary** via `GET /api/friendly-rounds/by-token`
   (`round.playHoles`) and builds `courseHoleNumber → playHoleId`.
2. Recomputes **gross strokes per changed hole** = shots played on the hole +
   Σ penalty strokes (`computeHoleStrokes`, a pure, unit-tested helper).
3. POSTs one score event per hole to `POST /api/friendly-rounds/score` with a
   **deterministic** `client_event_id` = `golfmap:{roundId}:{holeNumber}`, event
   type `score_entered` (or `score_cleared` with `strokes: null` when a hole's
   last shot is removed).

`updateShot` that moves a shot between holes publishes **both** the old and new
hole. Tapscore's idempotency (dedupe on `client_event_id`) plus last-write-wins
per cell makes re-posts, out-of-order retries, and full re-syncs all safe.

### 3.3 Resilience (load-bearing invariant)

`syncHoles`/`syncAll` **never throw.** A Tapscore that is down, slow, or
returning errors is caught and logged; the golf-map shot write always succeeds.
The next shot-sync write re-posts the same deterministic ids, so a missed
publish self-heals — no queue, no retry table needed for V1. The hook is
awaited (making it deterministic to test) precisely *because* the bridge is
guaranteed non-throwing; `RoundsService` also wraps the call defensively.

### 3.4 Hole mapping — why `by-token`, not the scorecard

The original design note said "fetch the round's scorecard by token" for the
hole map. In practice Tapscore's `scorecards` table is trigger-maintained and
holds a row only for holes that have been **scored** — so before any score
exists there is nothing to map. The itinerary on `round.playHoles` (returned by
`by-token`) lists **every** play hole, scored or not, so the bridge maps from
there instead. This handles shotgun starts naturally (each course hole still
appears once, just rotated). For a physical hole played more than once (a 9
played twice), the map takes the first occurrence (lowest ordinal) — see §6.

## 4. Files

| File | Role |
|------|------|
| `server/db/migrations/014_tapscore_link.ts` | `tapscore_round_token` + `ball_id` on `rounds` |
| `server/services/tapscore-client.ts` | Hand-written Tapscore HTTP client + typed shapes |
| `server/services/tapscore-bridge.service.ts` | Link/unlink/status + publish + `computeHoleStrokes` |
| `server/services/tapscore-bridge.service.test.ts` | Integration test (fake Tapscore Hono server) |
| `server/api/tapscore-bridge.api.ts` | link / unlink / status descriptor |
| `server/services/rounds.service.ts` | `onShotsChanged` hook on shot writes |
| `server/services/index.ts` | Wires client + bridge; `tapscoreBaseUrl` config |
| `server/main.ts` | Mounts the API |
| `shared/api/tapscore-bridge.gen.ts` | Generated typed client |

## 5. Config

- `TAPSCORE_BASE_URL` — origin of the Tapscore server (e.g.
  `http://localhost:3001`). Unset → the bridge is inert (unlinked rounds never
  call out; a link attempt fails at the client). Injectable in tests via
  `createServices(db, { tapscoreBaseUrl })` / `createTestDbWith`.

## 6. Known gaps / by design (V1)

- **Course data is duplicated.** golf-map and Tapscore each hold their own
  course/hole model; the bridge maps by `courseHoleNumber`, not by any shared
  course identity. A mismatch between the two courses' hole numbering is the
  operator's responsibility.
- **Handicaps live in Tapscore.** The bridge publishes **gross** strokes only.
  Net/points/format scoring is entirely Tapscore's job.
- **Repeated holes collapse.** A physical hole played twice in one Tapscore
  round maps to its first itinerary occurrence. golf-map's `hole_number` has no
  occurrence dimension in V1, so the second visit is not distinguished.
- **No per-write coalescing.** A batch iOS sync of N shots produces N
  by-token GETs + POSTs (idempotent, but chatty). Debounce/coalesce is a future
  optimization, not correctness.
- **No back-propagation.** Scores edited in Tapscore do not flow back to
  golf-map. golf-map is the writer; Tapscore is the record.
- **Deletion is one-way.** Unlinking (or deleting a golf-map round) leaves the
  already-published Tapscore scores in place.
- **VPS deployment.** In the local-builder / VPS-serve split
  (`feature-local-builder-vps-serve.md`), the serve tier is the process that
  owns live rounds, so `TAPSCORE_BASE_URL` must be reachable from **that** tier.
  Both apps are Bun + Hono + SQLite siblings and can co-reside.

## 7. Phasing (V2–V4)

- **V2 — identity & competitions.** Link golf-map users to Tapscore players;
  publish into competition rounds (not just friendly ones), which needs the
  identity-gated endpoints rather than the token front door.
- **V3 — richer metadata.** Attach per-hole GIR / putts / fairway to the score
  event `metadata` (Tapscore already carries a permissive metadata field).
- **V4 — engine extraction.** If a third consumer appears, extract the shared
  scoring/itinerary contract into a package instead of a hand-written client.

## 8. Testing

Integration-first (`server/services/tapscore-bridge.service.test.ts`): a real
migrated DB + a **real in-process Hono fake** of Tapscore's three endpoints
(no mocking library), exercising link (auto-pick / ambiguous / unknown token /
unknown ball), publish with deterministic ids, re-sync idempotency (same cell
id, last-write-wins), a moved shot updating both holes, cell clearing, an
unlinked round staying silent, and **Tapscore unreachable → shot write still
succeeds.** Plus focused unit tests for `computeHoleStrokes`. Full server suite:
490 pass.
