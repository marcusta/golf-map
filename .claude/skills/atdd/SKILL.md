---
name: atdd
description: Acceptance-test-driven development, Phase A. Use when starting a new feature or behavioural change and you want to agree the acceptance tests BEFORE any implementation — "let's ATDD this", "write the acceptance tests first", "spec this out test-first". Produces frozen, high-level, prose-driven acceptance tests (red, not yet passing) and hands off to the autonomous build (/goal or the /atdd-build workflow).
---

# ATDD — Phase A: formulate the acceptance tests

This is the **human-gated front half** of our ATDD loop. You and Marcus agree a
small set of high-level acceptance tests together, in prose, then you write them
as failing tests and **freeze** them. The autonomous half — make them green,
review, refactor, review, prove it works — runs afterward and is *not* this
skill (see [Handoff](#handoff)).

The whole point of Phase A is to catch a misunderstanding while it's still a
sentence, not a diff. Do not rush to code.

```
  ▸ Phase A  (this skill, interactive)          ▸ Phase B/C  (autonomous)
  describe → propose cases → discuss →          green → review → refactor →
  write failing tests → FREEZE → inspect        review → visual report → smoke test
                                    │
                              human gate
```

## The doctrine (read before proposing anything)

This project's testing stance — follow it exactly, it is not generic TDD:

- **Integration-first.** Test through the real service graph and real
  infrastructure. Server tests run against a real migrated DB (`createTestDb`);
  the acceptance/system layer is Playwright e2e against the seeded stack.
- **No mocks — with two DI exceptions.** Dependency injection is fine. You may
  inject a **stand-in for a real *external* actor** we cannot drive in a test
  (e.g. Lantmäteriet's STAC/tile services) — that's legitimate and expected.
  A stand-in for an **internal** collaborator is the *exception*: allowed only
  when you can state a specific, strong reason, and you must flag it in the test
  with a comment saying why. Default to the real thing.
- **Unit tests only for hard algorithms.** Geometry, scoring, strokes-gained,
  expected-strokes, caddy EV. Everything else is exercised at the service or
  system level.
- **Acceptance cases are vertical slices — always.** Each case expresses one
  complete path through the stack *and its outcome* (given → when → then). Never
  a horizontal slice of a single layer. The case IS a thin feature slice; the
  implementation underneath is then iterated as further vertical slices.

See [AGENTS.md](../../../AGENTS.md) and [TESTING.md](../../../TESTING.md) for the
full rationale.

## Step 1 — Understand the feature

Marcus describes what he wants. Before proposing anything, **restate the feature
back in one paragraph**: the capability, who uses it, and the observable outcome.
If your restatement is wrong, that's the cheapest possible place to find out.

If the behaviour or a domain model is genuinely unclear and cheap to probe,
consider a throwaway `/prototype` to answer the question before you freeze a
spec around a wrong assumption. Don't freeze on a guess.

## Step 2 — Sharpen the domain language

Acceptance tests only read like a spec if the nouns are stable. Consult
`CONTEXT.md` (repo root) for the project's domain vocabulary if it exists.

- **Flag ambiguous terms immediately.** If Marcus uses a term that's fuzzy or
  conflicts with existing language, call it out before writing tests:
  *"you said 'cancel a round' — do you mean discard it, or mark it abandoned but
  keep the strokes so far?"* Resolve it now.
- If a resolved term is worth keeping, add a one-line entry to `CONTEXT.md`
  right there (create the file if it doesn't exist yet — a short glossary of
  domain nouns and what they mean). Don't batch these up.

## Step 3 — Propose the acceptance cases (prose)

Draft a **small** set — a handful — of acceptance cases as structured prose.
This is a proposal to discuss, not final tests.

Each case must be:

- **A vertical slice.** One complete path through the stack, ending in an
  observable outcome. Format: **Given** (seeded state) → **When** (the action)
  → **Then** (the observable result, with real values).
- **Falsifiable.** The "Then" must be able to go red *for the right reason*. The
  expected value comes from an **independent source of truth** — a known-good
  literal, a worked example, the spec — never recomputed the way the code
  computes it (that's a tautology that can never disagree with the code).
  *"caddy gives good advice"* is not a test; *"given 150m to a back-right pin,
  the caddy recommends the 8-iron and flags the front bunker"* is.
- **Behavioural, not structural.** Assert what the user observes, not how it's
  built — so the test survives the refactor phase.

Cover the **behavioural envelope**: the happy path plus the 2–3 edges that
*define* correctness. Not one case per branch — the hard-algorithm unit tests
carry exhaustive coverage underneath.

Then **agree the seams**. State, for each case, the seam you'll test at
(Playwright e2e journey / service integration / algorithm unit) and confirm it
with Marcus. **No test gets written at an unconfirmed seam** — this is how
effort lands on the critical paths instead of every edge case.

## Step 4 — Discuss and iterate (still prose)

Work the cases with Marcus in prose until you both agree. Cut cases that are
really implementation detail; sharpen vague "Then"s into concrete numbers; split
a case that's secretly two. This back-and-forth is the highest-leverage part of
the whole flow — stay here until the set is right.

**Offer an ADR only if all three hold:** the decision is hard to reverse, it's
surprising without context, and it's the result of a real trade-off. Otherwise
don't — ADRs on obvious calls are noise.

## Step 5 — Write the failing tests

Encode each agreed prose case as a test, at its agreed seam:

- Playwright e2e in `e2e/tests/` for user journeys (select by `data-*` via the
  `tid()` helper, never CSS).
- Service-level integration for backend logic (`createTestDb`, real seeds).
- Unit tests only for the hard-algorithm cases.
- Integration-first, no mocks — except the DI stand-in rules in the doctrine
  above. If you inject an internal stand-in, add a comment: `// stand-in: <why>`.

The tests **will not pass, and may not even run cleanly** — that's expected;
they're the red target. Do write them so they'd fail *for the right reason*
(assertion fails / endpoint missing), not because of a typo.

Keep the acceptance-test files **tightly scoped and clearly named** — Marcus is
about to read them as the spec, and they're about to be frozen.

## Step 6 — Freeze and hand off (human gate)

Present the written tests for inspection. Tell Marcus plainly:

> These are the frozen acceptance tests for `<feature>`. Once you approve, they
> become the contract — the build phase makes them pass without editing them.
> Inspect now, or approve to hand off.

List the exact test files. This is **gate 1**. Nothing proceeds without approval.

**On approval, write the freeze manifest** so the guard hook can enforce it —
`.claude/atdd-frozen.json`:

```json
{ "feature": "<feature>", "paths": ["e2e/tests/<file>.spec.ts", "..."] }
```

While that file exists, `.claude/hooks/atdd-frozen-guard.ts` (wired as a
PreToolUse hook) **blocks any edit to those paths** — so no build agent can
weaken a frozen test to fake a pass. The manifest is deleted when the build is
done and the feature merged (the unfreeze step).

## Handoff

Once approved, the acceptance tests are **frozen**: the autonomous build phase
must make them pass *without modifying them*. Offer Marcus the two ways to run
the build phase, and print the ready-to-use launch:

- **Light (in-session, no infra):** drive the green phase with `/goal`. Print a
  line he can paste, e.g.:
  `/goal all acceptance tests in <path> pass AND git diff --stat shows <path> unchanged from HEAD, or stop after 15 turns`
- **Full (autonomous, isolated agents + code-enforced gates):** the `/atdd-build`
  workflow — green → freeze check → review (two-axis) → refactor (deep modules) →
  review → screenshot-capture. It returns a bundle; **then this main loop builds
  the visual test report (via `web/src/reports/diagrams.ts`) and the human smoke
  test, publishing both as Artifacts** (a workflow can't publish Artifacts).
  Launch it with the frozen paths, e.g.:

  > Run /atdd-build with args {"feature":"apply aim point","testPaths":["e2e/tests/04-apply-aim.spec.ts"],"testCmd":"cd e2e && bun run e2e --grep apply-aim","seamNotes":"e2e journey"}

Do **not** file issues or break the feature into tracker tasks here — that's a
separate outer loop, deliberately outside this one.

## Guardrails

- Never skip the prose discussion to save a round-trip. The discussion IS the
  product of Phase A.
- Never write more than a handful of acceptance cases. If you want ten, you're
  specifying implementation — push the detail down into unit tests.
- Never soften a "Then" to something unfalsifiable to make it easier to pass
  later. A test that can't go red is worse than no test.
- After the freeze, you (or any build agent) must not edit the acceptance tests
  to make them pass. Changing a frozen test means coming back to Marcus.
