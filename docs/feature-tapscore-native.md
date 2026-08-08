# Plan: Native Tapscore Play in golf-map

**Status:** planned
**Date:** 2026-07-26
**Wave:** T67
**Supersedes the entry point of:** [feature-tapscore-bridge.md](feature-tapscore-bridge.md)
(the bridge's publish path stays; its "link an existing round by pasting a
token" flow becomes one option among several rather than the only way in.)

---

## 1. Why

The V1 bridge works but is unusable in practice. To play a scored round you
must: open Tapscore's web app, set up the round, copy a share token, switch to
golf-map, start a round, wait for it to sync, paste the token. And once
playing, golf-map can only publish *your own* gross score — entering a friend's
score or checking the leaderboard means leaving the app.

What's actually wanted, on the phone, at the tee, without leaving golf-map:

1. **Set up the round** — course, route, players (friends + guests), teams,
   format — and start it.
2. **Enter scores for everyone in the group**, not just yourself.
3. **See the live leaderboard(s)** for whatever formats are in play.

Native. No embedded web view.

## 2. Why native is bounded work

The obvious objection to a native client is format drift: Tapscore has
match play, better ball, taliban, umbrella, köpenhamnare, and more coming, each
with its own config and scoring. Reimplementing per-format UI in Swift would be
a treadmill.

It isn't one, because **Tapscore's format plugin contract was designed to drive
a generic client.** From `server/domain/formats/plugin.ts`:

> Serializable format metadata. Drives the server `GET /formats` catalog and
> the generic mobile UI. Carries NO functions — `JSON.parse(JSON.stringify(descriptor))`
> must round-trip identically.

Concretely, everything a play client needs is declared as data:

- **`ScoreEntryCapabilities`** — `strokes: boolean` plus `metadata: MetadataInput[]`,
  each with `kind: 'boolean' | 'number'` → a toggle or a stepper. No format
  branching.
- **`MetadataApplies`** — a serializable predicate (`minPar`, `maxPar`, `pars`,
  `holes`) the client evaluates against the play-hole. Rules like "fairway hit
  only on par 4/5" stay *out* of the client.
- **`FormatMetric`** — `direction: 'high' | 'low'` and an optional `pace`
  (`{ perHole: n }` or `'par'`) so a live board with entries at different
  `thru` ranks correctly. The contract is explicit that leaderboard code
  "ranks by this metric's `direction` and never guesses direction from a string."
- **`FormatConfigField`** — `kind: 'select'` with localized `labels` and
  `options`, written to `formatConfig[key]`. Introduced precisely to kill the
  client anti-pattern of branching on format id.
- **`FormatPreset`** — the curated "game card" for the setup picker, with
  ball shape derived from `requirements.balls`.

So the Swift work is **one generic renderer against these descriptors**, the
same shape Tapscore's own web client already is. A new format registered
server-side appears in golf-map with no golf-map change — identical to how it
appears on web.

**The one real drift surface** is the plugin contract's escape hatch: "Anything
richer uses the optional client adapter." Formats that need a bespoke client
adapter will need a Swift adapter too. No such format exists in tapscore's
`src/` today (there is no client-adapter registry yet), so this is a future
cost, not a present one — but it is the thing to watch, and §8 makes it a
tracked risk rather than a surprise.

## 3. The API surface — all token-scoped, no auth

A friendly round's **share token is the whole credential** (Tapscore's no-login
front door). Every endpoint below takes it. golf-map needs no Tapscore account,
no OAuth, no identity coupling — the same property that made the V1 bridge
cheap.

| Capability | Endpoint |
| --- | --- |
| Create round from a setup draft | `POST /friendly-rounds` → `{ friendlyRound: { shareToken } }` |
| Read round | `GET /friendly-rounds/by-token` |
| Balls / seats | `GET /friendly-rounds/balls` |
| Whole-group scorecard | `GET /friendly-rounds/scorecard` |
| **Leaderboard / results** | `GET /friendly-rounds/result?token&cursor` |
| **Score any ball** | `POST /friendly-rounds/score` |
| Setup read / edit | `GET /friendly-rounds/setup`, `POST /friendly-rounds/setup` |
| Seats & people | `join`, `leave`, `claim-guest`, `claim-seat`, `release-seat` |
| Lifecycle | `POST /friendly-rounds/finish`, `/reopen`, `DELETE /friendly-rounds/:token` |
| Format catalog | `GET /formats` |
| Format actions (presses etc.) | `POST /format-actions` |

Supporting surfaces for setup: `courses`, `tees`, `handicap`, `friends`,
`guest-players`.

Note `POST /friendly-rounds/score` takes an explicit `ballId` — **that is how
friends' scores get entered.** No new Tapscore endpoint is required for any of
the three goals in §1.

## 4. Architecture decision: iOS talks to Tapscore directly

Two options existed: proxy everything through golf-map's server (reusing the
existing bridge service), or have the iOS app call Tapscore directly.

**Decision: direct, local-first from iOS.**

Rationale:

- golf-map iOS is *already* an offline-first GRDB app with a sync engine
  (`RoundStore` + `RoundSyncService`). Play data belongs in the same pattern.
- Proxying puts golf-map's server on the critical path of every score write. On
  a course, golf-map's server is exactly as unreachable as Tapscore's — the hop
  buys nothing and adds a failure mode.
- The share token is the credential, so there is nothing for a proxy to
  authenticate or hide.
- ~10 API surfaces would otherwise need proxy routes, doubling the maintenance.

The existing **server-side bridge stays** and keeps auto-publishing your own
ball's gross score from shot capture. §7 covers the resulting overlap.

## 5. Offline behaviour

Mandatory — this runs on golf courses. The web client already solved it and the
solution ports directly (`src/round/pending-queue.ts`):

- Every score write is persisted **before** it is attempted, with its original
  `clientEventId`. The server dedupes per round, so replay is a no-op — retry
  is always safe.
- **Coalesce to one pending entry per cell** (`token|ballId|playHoleId`). The
  score event log is last-write-wins per cell, so intermediate offline values
  are disposable; only the final state must land. A coalesced entry keeps its
  first-touch FIFO position but takes the newest payload and `clientEventId`.
- Hygiene: prune entries older than 14 days, cap the queue at 200, key by token
  so other rounds' leftovers never leak in.

In Swift this is a GRDB table plus a drain task, mirroring `RoundStore`'s
existing `syncState` machinery rather than inventing a second one.

Reads (scorecard, leaderboard) cache locally and render stale-with-indicator
when offline. Leaderboard polling follows `poll-gate.ts`: poll only when the
leaderboard is the active surface, the app is foreground, and the round isn't
complete. Score entry is optimistic-local and never polls.

## 6. Scope, in slices

**S1 — Tapscore client + offline queue (foundation).**
Swift client for the friendly-rounds surface; GRDB tables for round, balls,
scorecard cells, pending writes; the drain task. No UI. Parity-tested against
the TypeScript queue's coalescing/pruning rules.

**S2 — Play: score entry for the group.**
Hole carousel, seat cards, strokes entry for every ball, generic metadata
controls driven by `ScoreEntryCapabilities` + `MetadataApplies`. Optimistic
local write → queue → drain.

**S3 — Leaderboards.**
Generic ranked-section renderer driven by `FormatMetric` (`direction`, `pace`)
and the result payload's ordered sections. Multiple formats → multiple boards.

**S4 — Setup: create the round from golf-map.**
Course + route, players from friends/guests with handicap index and per-player
tee, teams, format picker from `FormatPreset` cards, config via generic
`FormatConfigField` rendering. Submits a draft to `POST /friendly-rounds`, gets
the token, links the golf-map round automatically.

**S5 — Integration with the map.**
Current hole stays in step between map and scorecard. Entry points from the
on-course UI. Finish/reopen. Design-token pass so it reads as golf-map.

S1→S2→S3 is the shortest path to "useful on a real round". S4 removes the last
reason to open Tapscore's web app at all.

## 7. Overlap with the existing bridge

Once golf-map can write any ball's score directly, two paths can write **your**
ball: the server-side auto-publish from shot capture, and native entry. Same
cell, last-write-wins → churn.

Resolution: a per-round **"golf-map keeps my score"** toggle. On (default when a
round is linked from shot capture) → auto-publish owns your ball and native
entry for your own cells is read-only-with-override. Off → native entry owns it
and the bridge stops publishing for that round.

The bridge's versioned `clientEventId` scheme (`golfmap:{roundId}:{hole}:{version}`,
monotonic per `tapscore_published_scores`) already prevents the frozen-cell bug;
native writes mint their own ids and don't collide with it.

## 8. Risks

1. **Client-adapter formats.** A future format needing a bespoke client adapter
   needs a Swift one. Watch `GET /formats` for descriptors the generic renderer
   can't satisfy and fail *visibly* (an explicit "open in Tapscore for this
   format" fallback) rather than rendering something wrong.
2. **Setup draft shape.** `POST /friendly-rounds` takes a `RoundSetupDraft`
   whose validation authority is server-side (`validateConfig`). golf-map must
   never re-implement validation — surface server diagnostics instead.
3. **Handicap derivation.** Course handicap is computed from index + tee +
   course. Must come from Tapscore's `handicap` surface, not be recomputed.
4. **Two design systems.** Format labels are localized (`FormatLabels`, `sv`
   included); golf-map's iOS Tokens must absorb Tapscore's semantics without a
   visual seam.
5. **Cross-repo contract drift.** Descriptor shapes are Tapscore's. Golden
   fixtures captured from a live `GET /formats` + `/result`, tested in both
   repos, are the guard.

## 9. Explicitly out of scope

- Competitions, multi-round series, handicap records — Tapscore's web app stays
  the place for those.
- golf-map becoming a scoring engine. Every score is still computed by Tapscore;
  golf-map renders results and posts events.
- Identity/auth coupling. Share token remains the only credential.
