# T29 report — planner shot-option authoring and overlay

Implemented O4–O5 on top of T28's flat `PlanShot` tree. The planner now
authors sibling options and branch continuations, promotes a sibling to the
primary line, applies splice/cascade deletion deliberately, and renders the
complete option tree without changing the existing primary-line strategy
views or drag enrichment cadence. No T30 EV/score chips were added.

## Files touched

- `web/src/planner/plan.service.ts` — parent index, deterministic tree order,
  rank-0 primary-line selector, parent-aware creation, sibling promotion, and
  local splice/cascade reconciliation.
- `web/src/planner/planner-tool.service.ts` — alternative and continuation
  placement, option promotion/deletion actions, branch-aware geometry uses,
  and microtask-coalesced MapLibre overlay side effects.
- `web/src/planner/plan-overlay.ts` — complete tree geometry while preserving
  primary-only route semantics, plus primary/option feature metadata and
  dashed/dimmed option rendering with reduced-opacity option ellipses.
- `web/src/planner/planner-panel.component.ts` — indented decision-point
  grouping, option labels, set-primary, cascade delete-option, and splice
  delete-shot controls.
- `web/tests/plan.service.test.ts` — parent-index, primary-line, promotion,
  cascade, and splice coverage using a tree-aware fake API.
- `web/tests/plan-overlay.test.ts` — primary-route/full-tree geometry and
  option-style metadata/layer coverage.
- `e2e/tests/14-plan-options.spec.ts` — real UI journey for Driver versus
  4-iron options, continuations, primary promotion, and reload persistence.
- `e2e/playwright.config.ts` — consumes `E2E_API_PORT` and `E2E_WEB_PORT` so
  the brief's documented 3200/5474 fallback pair is usable.
- `docs/reports/T29-report.md` — this report.

## Tests / verification

From `web/`, the final unit-test run passed:

```text
 630 pass
 0 fail
 6453 expect() calls
Ran 630 tests across 48 files. [640.00ms]
```

`bun run check:client` from `web/` completed successfully (`tsc --noEmit`, no
diagnostics).

Focused serial E2E verification on fallback ports passed the existing drag
cadence and apply-aim regressions together with the new option journey:

```text
E2E_API_PORT=3200 E2E_WEB_PORT=5474 bun run e2e -- e2e/tests/03-drag-cadence.spec.ts e2e/tests/04-apply-aim.spec.ts e2e/tests/14-plan-options.spec.ts
4 passed (22.0s)
```

The complete E2E command was also run on fallback ports. T29's new test passed,
as did 20 other tests; the suite ended `21 passed, 1 failed (1.4m)`. The sole
failure is an existing cross-spec state leak: `07-furniture-editor.spec.ts`
adds hole 3 to the intentionally shared serial database, then
`11-course-list.spec.ts` expects the untouched two-hole seed and receives 3.
That unrelated furniture/course-list cleanup was left outside T29's scope.

## Deviations from the brief / locked decisions

- None. O1–O6 and D1–D27 were not reopened, and no T30 score/EV-chip work was
  added.
- The E2E port variables are a harness correction rather than a behavioral
  deviation: the brief said the alternate ports were supported, while the
  checked-in config still hard-coded the defaults. The config now honors the
  named environment variables and retains the same default ports.

## Under-specified choices

- After placing an alternative, the tool returns to ordinary `add-shot` mode
  with the new option selected. The next map click therefore creates its
  continuation immediately, matching the brief's authoring journey.
- Existing consumers of `HolePlan.nodes` / `legs` continue to receive only the
  primary route. New `allNodes` / `allLegs` collections carry the complete tree
  for overlay, hit testing, and per-option row readouts, preventing option
  branches from silently changing primary-line caddy/profile semantics.
- Panel rows use a depth-first tree order, indentation, and compact sibling
  labels (`1A`, `1B`, `2A`, etc.) to group continuations under each decision
  point without introducing a second nested store.
- `Delete shot` uses splice semantics; `Delete option` uses cascade semantics
  and names the destructive continuation removal explicitly in its confirm
  dialog.

## Open concerns for the reviewer

- The complete E2E suite has the unrelated shared-state ordering failure
  described above. T29-specific E2E coverage and the neighboring planner
  regressions pass together.
- Option-chain EV/score comparison remains intentionally deferred to T30.
