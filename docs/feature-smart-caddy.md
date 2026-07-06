# Plan: Smart Caddy — a rule-based advice layer

**Status:** proposal (for evaluation against other candidate work)
**Date:** 2026-07-06
**Scope:** new `shared/strategy/caddy`, `web/src/planner` wiring, planner panel UI. No schema change.
**Related:**
- [decade-planner-strategy-engine.md](decade-planner-strategy-engine.md) — the *scoring* engine (expected strokes + aim). The caddy interprets its output.
- [feature-distances-yardages.md](feature-distances-yardages.md) — the *measurement* layer. Caddy rules consume its distances/carries as inputs.

---

## 1. Purpose

Turn engine **numbers** into player **advice**.

The DECADE engine answers *"what is the expected score of aiming here?"* and the distances
feature answers *"how far is it?"*. Neither answers the question a player actually voices to a
caddy: *"what should I do on this shot, and why?"* — "favour the front half, the green runs away
from you", "lay up to a full wedge", "aim right of the pin, water's short-left", "take your
medicine".

The Smart Caddy is the **interpretation layer** that produces those sentences. It adds almost no
new math. Its job is to translate the engine's continuous outputs (EV per aim, lie breakdown,
slope, carries, club fit) into a small set of **ranked, explained recommendations** — and to
resolve the conflicts between them, which is the actual course-management decision.

## 2. The core insight (the "thinking")

Two ideas separate this from "more overlays":

1. **Advice is a distinct concern from calculation.** A calculator emits a number; a caddy emits
   a *decision with a reason*, at a priority, that can be **vetoed by a safety concern**. Mixing
   the two produces either bare numbers no one acts on, or hard-coded advice that can't be tuned.
   So the caddy is a layer *on top of* the engine, not a second engine.

2. **The value is in the conflicts.** "Attack the pin" and "don't short-side yourself" contradict
   on the same shot — that contradiction *is* the decision. A rule set that surfaces both and
   ranks them (risk rules can demote/veto aggressive ones, weighted by a player's risk tolerance)
   is more useful than any single formula.

The keystone is therefore an **open–closed rule system**: a fixed evaluator over a growing list of
pure, self-gating rules. Adding "how to attack a par 5" is a new rule file, never an edit to the
evaluator or to existing rules.

## 3. Why this fits the codebase

- `shared/strategy` is a pure, zero-dep, tested, Swift-mirrored math library. A rule registry +
  an advice type is the same shape as the existing modules and slots straight in. Rules stay pure;
  the platform pre-flattens rings and pre-computes engine outputs (same contract as `corridor.ts`
  and the two sibling proposals).
- **The marquee example is buildable today.** `computeSlopeGrid()` in
  [analysis-math.ts](web/src/analysis/analysis-math.ts:31) already produces per-cell slope %, a
  downhill unit vector, the fall-line arrow, and per-green stats (max/avg slope, mean elevation).
  The "green falls back-to-front → favour the short half" rule needs *no* new geometry and does
  not even depend on the unbuilt DECADE phases.
- Lie classification and hazard ray-casting precedents exist (`hitGreen()` in
  `analysis-tool.service.ts`, `corridorWidth()` / `hazardsAlongLine()`), so the higher-value rules
  are composition over proven primitives.
- The engine outputs the caddy consumes are exactly what the two sibling docs already design
  (`optimizeAim` → EV + lie breakdown; `featureDistances` → line/carry/club). The caddy is the
  reason to build those: it's what makes their numbers *actionable*.

## 4. Key design decisions (lock before building)

### 4.1 A rule is a pure, self-gating function

```ts
// shared/strategy/caddy/rule.ts
interface CaddyRule {
  id: string;
  appliesTo(ctx: CaddyContext): boolean;      // cheap gate — leg type, par, data presence
  evaluate(ctx: CaddyContext): CaddyAdvice[];  // pure; 0..n advice items
}
```

The evaluator is fixed; the rule *set* is the extension point (open–closed). No rule knows about
any other rule — conflict handling is the evaluator's job (4.4), not a rule's.

### 4.2 The context is pre-computed engine output, not raw domain entities

Mirroring the sibling docs' purity boundary, the caddy never reads the feature store, the DEM, or
HTTP. The platform assembles a `CaddyContext` from things already computed elsewhere and passes it
in:

```ts
interface CaddyContext {
  leg: 'tee' | 'approach' | 'layup' | 'recovery';
  origin: StrategyPoint;
  target: { greenPoly: FlatRing; center: Vec2; front: Vec2; back: Vec2; pin?: Vec2 };
  distances: FeatureDistance[];        // ◄ feature-distances.ts
  aim?: AimResult;                     // ◄ aim.ts (EV per candidate + lie breakdown)
  greenSlope?: GreenSlopeSummary;      // ◄ derived from computeSlopeGrid (fall-line bearing + %)
  hazards: readonly FlatRing[];
  clubs: readonly ClubSpec[];
  wind?: { speedMps: number; directionDeg: number };
  hole: { par: number; index: number };
  risk: RiskProfile;                   // player risk tolerance (4.3)
}
```

Adding a new input later (e.g. pin sheet, lie of the ball) is a context field + the rules that
read it — never a change to the evaluator.

### 4.3 Risk tolerance is an explicit input, not baked into rules

"Favour the short half" and "no doubles" are only *correct* for a given risk appetite. A single
`RiskProfile` knob (e.g. `doubleAversion: 0..1`) feeds both the aim scoring term and the rule
priorities, so the caddy is tunable rather than preachy. This is the same sensitivity risk as
DECADE §4.4's `sigmaScale`; keep it a real parameter and calibrate it.

### 4.4 Conflict resolution lives in the evaluator

```ts
interface CaddyAdvice {
  ruleId: string;
  kind: 'aim' | 'club' | 'target-half' | 'layup' | 'lay-back' | 'warning';
  priority: number;      // base severity of the concern
  confidence: number;    // rule gates its own certainty; low-confidence is suppressible
  headline: string;      // "Favour the front half — green falls 3% toward you"
  detail?: string;       // the "why", one sentence
  anchor?: Vec2;         // where to draw it on the overlay
  vetoes?: string[];     // rule ids this advice overrides
}

function runCaddy(ctx: CaddyContext, rules: readonly CaddyRule[]): CaddyAdvice[];
// filter by appliesTo → evaluate → apply vetoes → rank by priority×confidence×risk → dedupe
```

Safety rules (no-doubles, short-side) can carry `vetoes` that demote or remove an aggressive
aim/attack recommendation. The evaluator, not the rules, owns ranking and vetoing — so no rule has
to know the others exist.

### 4.5 Advice is derived, never persisted

Like DECADE's EV, caddy output is recomputed client-side on shot-place / drag-release. No
migration, no stored advice. Same compute cadence as the engine (never per drag frame).

### 4.6 A `GreenSlopeSummary` adapter, not a dependency on the analysis tool

The slope rule needs a compact summary (dominant fall-line bearing + magnitude + a "front is
clean?" flag), not the full RGBA grid. Web derives `GreenSlopeSummary` from `computeSlopeGrid` +
the green polygon and passes it in; the pure rule never touches `analysis-math.ts`. iOS mirrors the
summary the same way. This keeps the marquee rule shippable independent of the DECADE phases.

## 5. Rule catalogue (v1 target set)

Each rule is one file under `shared/strategy/caddy/rules/`, pure and unit-tested in isolation.

| Rule | Fires when | Emits | Inputs it needs | Depends on |
|------|-----------|-------|-----------------|-----------|
| **green-slope-half** | approach; green fall-line ≈ back-to-front, ≥~3%, **front approach clean** | "favour short half; short miss OK" | `greenSlope`, hazards short | ready **today** (slope engine only) |
| **short-side-guard** | approach; pin-side dispersion tail has bunker/water/steep + green edge close | "aim to fat side of pin" (+ veto attack) | `aim.lieBreakdown`, hazards | DECADE A+B |
| **par5-attack** | tee/2nd on a par 5 | ranked strategies: go-in-2 / lay-up-to-full-number / lay-back-of-pinch | two-shot EV chain via `shotsToHoleOut` | DECADE A |
| **no-doubles** | any full shot with high penalty/recovery share at the low-EV aim | risk term + veto of the aggressive aim | `aim.perCandidate` breakdown | DECADE B |
| **take-your-medicine** | leg = recovery / sand / trees | target that maximises return-to-play, not distance | lie + `shotsToHoleOut` | DECADE A |
| **can-you-carry-it** | any hazard the shot line crosses | "can't carry the bunker under a 6i — lay up / club up" | `hazardsAlongLine.carryM` vs `maxCarryM` | distances feature (carry.ts) |
| **specific-target** | any approach | the ghost aim marker + front/centre/back club advice | `aim.bestBearingDeg`, `clubAdvice` | DECADE B/D |

The last five are DECADE's own concepts *verbalised* — the engine already prefers them; these rules
name the reason ("aiming 6 m right, water short-left") instead of showing a bare EV number.

### "Tiger 5" mapping

The five commonly-cited Tiger course-management principles are **not new math** — they are weights
and vetoes over the same EV engine:

1. *No doubles (bogey is fine)* → `no-doubles` risk term + veto.
2. *Par 5s are scoring holes* → `par5-attack`.
3. *Never short-side yourself* → `short-side-guard`.
4. *Take your medicine* → `take-your-medicine`.
5. *Specific target / play your shape* → `specific-target` (aim ghost + club).

This mapping is the argument that the rule model is the right abstraction: an entire named system
drops in as five rules with zero evaluator change.

## 6. Implementation phases

### Phase A — Rule engine skeleton (shared, pure) ⭐ keystone
- New `shared/strategy/caddy/`: `rule.ts` (`CaddyRule`, `CaddyAdvice`, `CaddyContext`,
  `RiskProfile`), `run.ts` (`runCaddy` filter→evaluate→veto→rank→dedupe), `index.ts` re-export
  from `shared/strategy/index.ts`.
- One trivial rule + `run.test.ts`: ranking order, veto removes/demotes, empty context → no advice.
- **No engine dependency yet** — validates the abstraction standalone.

### Phase B — Green-slope rule (shared + web adapter) — first real value, ships alone
- New `caddy/rules/green-slope-half.ts` + tests (fall-line aligned & steep & front-clean ⇒ advice;
  front hazard ⇒ suppressed; shallow slope ⇒ no advice).
- Web `GreenSlopeSummary` adapter over `computeSlopeGrid` + green polygon.
- Panel row + overlay hint for the advice. **Depends on nothing unbuilt.**

### Phase C — EV-backed rules (shared, after DECADE A/B)
- `short-side-guard`, `no-doubles`, `take-your-medicine`, `specific-target` over `AimResult` /
  `shotsToHoleOut`. Each pure + tested against fixtures.

### Phase D — Par-5 attack (shared, after DECADE A)
- `par5-attack.ts`: enumerate {go-in-2, lay-up-to-full-number, lay-back-of-pinch}; score each as a
  two-shot EV chain; recommend the min. Tests: awkward 42 m beats-out by a full 100 m wedge;
  go-in-2 only when carry clears and `maxCarryM ≥ remaining`.

### Phase E — Carry rule + web wiring
- `can-you-carry-it.ts` over `hazardsAlongLine` (distances feature) + `maxCarryM`.
- Planner assembles `CaddyContext` per leg from engine outputs; renders ranked advice list +
  overlay anchors; risk knob in the panel.

## 7. Sequencing & dependencies

```
A ─► B                         (B ships value with only the existing slope engine)
A ─► C   (needs DECADE A+B)
A ─► D   (needs DECADE A)
A ─► E   (needs distances feature)
```

- **A unblocks everything** and is pure/UI-free.
- **B is the cheap early win** — the marquee example, no dependency on unbuilt engine work.
- C/D/E follow as their engine prerequisites land; each rule is independently shippable.

## 8. Effort / value / risk (for cross-item evaluation)

| Phase | Effort | Value | Risk | Notes |
|-------|--------|-------|------|-------|
| A engine skeleton | S | High (unlocks all) | Low | Pure, isolated, fully testable |
| B green-slope rule | S | **High** (marquee; ships now) | Low–Med | Only "front-clean" heuristic to calibrate |
| C EV-backed rules | M | High | Med | Inherits DECADE σ/aversion sensitivity |
| D par-5 attack | M | **High** (signature) | Med | Two-shot chain assumptions |
| E carry + wiring | M | Med | Low | Mostly plumbing + UI |

**Biggest risks:** (1) the risk-tolerance knob (4.3) — advice quality is only as good as its
calibration; (2) the two-shot EV chain in par-5 (compounding the DECADE σ assumption). Mitigation:
make `RiskProfile` a first-class input and validate against a couple of known holes, same playbook
as DECADE §4.4.

**Why this is a strong candidate:** it is the layer that makes the other two proposals *visible to
the player as decisions rather than numbers*. It adds almost no new math — one green-slope adapter
and a two-shot chain — and the marquee rule (B) ships on data that already exists today, before any
DECADE phase lands.

## 9. Open questions to resolve

1. "Front approach clean" test for the slope rule — reuse `hazardsAlongLine` short of the front
   edge, or a simpler "any hazard ring within N m of front"? (Affects B.)
2. `GreenSlopeSummary` shape — single dominant fall-line, or per-third (front/middle/back) slope so
   the rule can say *which* half? (Default: dominant + front/back split.)
3. Should the risk knob be per-player (persisted with club config) or a transient planner control?
   (Default: transient in v1, mirrors "EV is derived".)
4. Advice ranking — pure priority×confidence, or a learned/weighted blend later? (Default: simple
   product; revisit.)

## 10. Explicitly out of scope / non-goals

- Any new scoring math — the caddy *consumes* `shotsToHoleOut` / `optimizeAim`, it does not
  reimplement them (build them in the DECADE doc).
- Green-reading / putt-line advice — the slope engine could support it, but v1 caddy is
  tee-to-green strategy only.
- Copying DECADE's or any book's proprietary tables or trademarked branding — rules encode public
  course-management *principles* over the public baseline (same stance as the DECADE doc).
- Per-player learned models / shot history — `RiskProfile` is a manual knob in v1.
- Server-side advice storage — derive client-side, no migration.
</content>
</invoke>
