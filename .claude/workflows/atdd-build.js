export const meta = {
  name: 'atdd-build',
  description:
    'Autonomous ATDD build: make frozen acceptance tests green (vertical slices, no mocks), verify the freeze held, two-axis review, refactor to deep modules, review again, capture proof. Returns a bundle for the main loop to render into a visual test report + human smoke test.',
  whenToUse:
    'Run after /atdd has frozen a feature\'s acceptance tests. Pass args {feature, testPaths, testCmd, seamNotes}.',
  phases: [
    { title: 'Green' },
    { title: 'Freeze check' },
    { title: 'Review' },
    { title: 'Refactor' },
    { title: 'Review 2' },
    { title: 'Capture' },
  ],
}

// ---- args -------------------------------------------------------------------
// {
//   feature:   string  — human name of the feature
//   testPaths: string[]— repo-relative paths of the FROZEN acceptance tests
//   testCmd:   string  — command that runs exactly those tests (e.g.
//                        "cd server && bun test services/aim-points.service.test.ts")
//   seamNotes: string? — the seams agreed in /atdd Phase A, for context
// }
const feature = (args && args.feature) || 'the feature'
const testPaths = (args && args.testPaths) || []
const testCmd = (args && args.testCmd) || ''
const seamNotes = (args && args.seamNotes) || '(none provided)'

if (!testPaths.length || !testCmd) {
  throw new Error(
    'atdd-build requires args.testPaths (frozen test files) and args.testCmd (how to run them).',
  )
}

const pathsList = testPaths.join(', ')

// The doctrine every agent must honour. Kept in one string so it can't drift
// between agents.
const DOCTRINE = `
Project testing doctrine (binding):
- Integration-first. Real service graph, real migrated DB (createTestDb), real seeds. Playwright e2e is the system layer.
- No mocks, with two DI exceptions ONLY: (a) a stand-in for a real EXTERNAL actor we cannot drive in a test (e.g. Lantmateriet STAC/tiles) is fine; (b) a stand-in for an INTERNAL collaborator is the exception — allowed only with a specific strong reason, and it MUST carry a "// stand-in: <why>" comment. Default to the real thing.
- Unit tests only for hard algorithms (geometry, scoring, strokes-gained, expected-strokes, caddy EV).
- Work in VERTICAL slices: one complete path through the stack at a time. Never write a horizontal layer of code detached from an outcome.
- THE ACCEPTANCE TESTS ARE FROZEN. You must NOT edit, delete, weaken, or skip any test in: ${pathsList}. Make the code satisfy them. If a frozen test looks wrong, STOP and report it — do not change it.
`.trim()

// ---- schemas ----------------------------------------------------------------
const GREEN_SCHEMA = {
  type: 'object',
  required: ['claimsPassing', 'summary', 'filesTouched'],
  properties: {
    claimsPassing: { type: 'boolean', description: 'Agent believes all frozen tests now pass' },
    summary: { type: 'string' },
    filesTouched: { type: 'array', items: { type: 'string' } },
    testFilesEdited: {
      type: 'boolean',
      description: 'True if the agent had to touch any frozen test file (should be false)',
    },
    blocked: { type: 'string', description: 'Non-empty if stuck / a frozen test looks wrong' },
  },
}

const VERIFY_SCHEMA = {
  type: 'object',
  required: ['allPass', 'detail'],
  properties: {
    allPass: { type: 'boolean' },
    detail: { type: 'string', description: 'Test runner summary line(s)' },
  },
}

const FREEZE_SCHEMA = {
  type: 'object',
  required: ['unchanged', 'detail'],
  properties: {
    unchanged: { type: 'boolean', description: 'True if the frozen test files are byte-identical to git HEAD' },
    detail: { type: 'string', description: 'Output of git diff --stat for the frozen paths' },
  },
}

const REVIEW_SCHEMA = {
  type: 'object',
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['severity', 'summary', 'location'],
        properties: {
          severity: { type: 'string', enum: ['blocker', 'major', 'minor', 'nit'] },
          summary: { type: 'string' },
          location: { type: 'string', description: 'file:line' },
          suggestion: { type: 'string' },
        },
      },
    },
  },
}

const REFACTOR_SCHEMA = {
  type: 'object',
  required: ['summary', 'deepenings'],
  properties: {
    summary: { type: 'string' },
    deepenings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['before', 'after'],
        properties: {
          before: { type: 'string', description: 'the shallow shape (glossary terms)' },
          after: { type: 'string', description: 'the deepened module' },
          category: {
            type: 'string',
            enum: ['in-process', 'local-substitutable', 'ports-and-adapters', 'true-external'],
          },
        },
      },
    },
  },
}

const CAPTURE_SCHEMA = {
  type: 'object',
  required: ['shots'],
  properties: {
    shots: {
      type: 'array',
      items: {
        type: 'object',
        required: ['criterion', 'imagePath', 'caption', 'pass'],
        properties: {
          criterion: { type: 'string', description: 'the acceptance case this shot demonstrates' },
          imagePath: { type: 'string', description: 'absolute path to the PNG on disk' },
          caption: { type: 'string' },
          pass: { type: 'boolean' },
        },
      },
    },
    notes: { type: 'string' },
  },
}

// ---- helpers ----------------------------------------------------------------
async function verifyTests(label) {
  return agent(
    `Run exactly this command and report whether every test passed:\n\n    ${testCmd}\n\n` +
      `Do not edit any code. Return allPass=true only if the runner reports zero failures. ` +
      `Put the runner's summary line(s) in detail.`,
    { label, phase: 'Freeze check', schema: VERIFY_SCHEMA },
  )
}

async function checkFreeze(label) {
  return agent(
    `The following files are FROZEN acceptance tests:\n\n    ${pathsList}\n\n` +
      `Run: git diff --stat -- ${testPaths.join(' ')}\n` +
      `If the output is empty, the freeze held: return unchanged=true. If any of those files ` +
      `show changes, return unchanged=false and put the diff --stat output in detail. ` +
      `Do not edit anything.`,
    { label, phase: 'Freeze check', schema: FREEZE_SCHEMA },
  )
}

// ---- Phase: Green (loop until tests pass or cap) ----------------------------
phase('Green')
log(`Making ${testPaths.length} frozen acceptance test file(s) green for "${feature}".`)

const MAX_GREEN_ROUNDS = 4
let green = null
let verified = null
for (let round = 1; round <= MAX_GREEN_ROUNDS; round++) {
  green = await agent(
    `${DOCTRINE}\n\n` +
      `Feature: ${feature}\nAgreed seams: ${seamNotes}\n\n` +
      `The frozen acceptance tests (${pathsList}) currently fail. Implement the production ` +
      `code to make them pass. Work in vertical slices — one complete path at a time, run the ` +
      `single test file after each slice. Keep a TIGHT feedback loop: a fast deterministic test ` +
      `run beats a slow flaky one. Run ${testCmd} when you believe you are done.\n\n` +
      (round > 1 ? `This is retry ${round}: the previous attempt did not make every test pass. Fix the remaining failures.\n\n` : '') +
      `Return testFilesEdited=true ONLY if you were forced to touch a frozen test (you should not be). ` +
      `If a frozen test appears wrong, set blocked and stop.`,
    { label: `green:r${round}`, phase: 'Green', schema: GREEN_SCHEMA },
  )

  if (green && green.blocked) {
    log(`Green agent blocked: ${green.blocked}`)
    return { status: 'blocked', where: 'green', reason: green.blocked, feature }
  }

  verified = await verifyTests(`verify:r${round}`)
  if (verified && verified.allPass) {
    log(`Green after ${round} round(s).`)
    break
  }
  log(`Round ${round}: tests still failing — ${verified ? verified.detail : 'no verify result'}`)
}

if (!verified || !verified.allPass) {
  return { status: 'not-green', feature, lastVerify: verified, lastGreen: green }
}

// ---- Phase: Freeze check (code-enforced guarantee) -------------------------
phase('Freeze check')
const freeze = await checkFreeze('freeze:post-green')
if (!freeze || !freeze.unchanged) {
  // The frozen tests were altered to reach green — this INVALIDATES the run.
  return {
    status: 'freeze-violated',
    where: 'post-green',
    feature,
    detail: freeze ? freeze.detail : 'freeze check failed to run',
  }
}
log('Freeze intact after green.')

// ---- Phase: Review (two-axis, parallel — borrowed from code-review) --------
phase('Review')
const review1 = await parallel([
  () =>
    agent(
      `Review ONLY the production code changed to make "${feature}" pass (not the frozen tests). ` +
        `AXIS: STANDARDS. Judge against code smells — Mysterious Name, Duplicated Code, Long Function, ` +
        `Feature Envy, Data Clumps, Primitive Obsession, Shotgun Surgery. Report concrete findings with file:line.`,
      { label: 'review:standards', phase: 'Review', schema: REVIEW_SCHEMA },
    ),
  () =>
    agent(
      `${DOCTRINE}\n\nReview ONLY the production code changed to make "${feature}" pass. ` +
        `AXIS: SPEC. Does the code actually satisfy the intent behind the frozen acceptance tests, ` +
        `including edges the tests imply? Flag doctrine violations (mocks without a stated reason, ` +
        `horizontal slicing, tests coupled to internals). Report concrete findings with file:line.`,
      { label: 'review:spec', phase: 'Review', schema: REVIEW_SCHEMA },
    ),
])
const review1Findings = review1.filter(Boolean).flatMap((r) => r.findings || [])
log(`Review 1: ${review1Findings.length} finding(s).`)

// ---- Phase: Refactor (deep modules — codebase-design glossary/DEEPENING) ---
phase('Refactor')
const refactor = await agent(
  `${DOCTRINE}\n\n` +
    `Refactor the production code for "${feature}" toward DEEP MODULES, using review 1's findings as input:\n` +
    `${JSON.stringify(review1Findings, null, 2)}\n\n` +
    `Vocabulary (use exactly): module, interface, implementation, depth, deep, shallow, seam, adapter, leverage, locality. ` +
    `A module is deep when a lot of behaviour sits behind a small interface. Collapse shallow wrappers; ` +
    `let the interface shrink while the implementation absorbs the logic. The interface is the test surface. ` +
    `Classify each deepening's dependencies: in-process / local-substitutable / ports-and-adapters / true-external — ` +
    `that decides how it's tested (local-substitutable = our real SQLite test DB, not a mock).\n\n` +
    `HARD CONSTRAINTS: behaviour must not change; the frozen tests (${pathsList}) must stay green and unedited. ` +
    `Make small steps so the program keeps working. Run ${testCmd} when done.`,
  { label: 'refactor', phase: 'Refactor', schema: REFACTOR_SCHEMA },
)

// re-verify green + freeze after refactor
const verifyAfter = await verifyTests('verify:post-refactor')
const freezeAfter = await checkFreeze('freeze:post-refactor')
if (!verifyAfter || !verifyAfter.allPass) {
  return { status: 'refactor-broke-green', feature, detail: verifyAfter ? verifyAfter.detail : 'verify failed', refactor }
}
if (!freezeAfter || !freezeAfter.unchanged) {
  return { status: 'freeze-violated', where: 'post-refactor', feature, detail: freezeAfter ? freezeAfter.detail : 'freeze check failed' }
}
log('Refactor done; tests green and freeze intact.')

// ---- Phase: Review 2 (additional improvements after refactor) --------------
phase('Review 2')
const review2 = await agent(
  `Review the refactored production code for "${feature}" once more. The design was just deepened; ` +
    `look for what the deepening MISSED or newly introduced: leaky seams, an interface still as wide as ` +
    `its implementation, a single-adapter seam that's just indirection, remaining shallow wrappers. ` +
    `Report concrete, actionable findings with file:line. Empty is a fine answer if it's clean.`,
  { label: 'review:post-refactor', phase: 'Review 2', schema: REVIEW_SCHEMA },
)
const review2Findings = (review2 && review2.findings) || []
log(`Review 2: ${review2Findings.length} finding(s).`)

// ---- Phase: Capture (screenshots tied to acceptance criteria) --------------
phase('Capture')
const capture = await agent(
  `Produce visual PROOF that "${feature}" works, for a human-facing report.\n\n` +
    `Drive the app the way the frozen acceptance tests (${pathsList}) do — reuse the Playwright e2e ` +
    `harness and its seeded stack (see e2e/). For EACH acceptance case, navigate to the state it asserts, ` +
    `take a screenshot (save PNGs under e2e/test-results/atdd/ or the scratchpad), and tie each shot to ` +
    `the acceptance criterion it demonstrates with a one-line caption and pass/fail. ` +
    `Return the manifest. Do not edit production code or the frozen tests.`,
  { label: 'capture', phase: 'Capture', schema: CAPTURE_SCHEMA },
)
log(`Captured ${capture && capture.shots ? capture.shots.length : 0} shot(s).`)

// ---- Return the bundle for the MAIN LOOP to render -------------------------
// The visual test report (via web/src/reports/diagrams.ts + the HTML-REPORT
// layout) and the human smoke test (Marcus's manual-test-plan spec: checkable
// HTML, localStorage, copy-summary) are authored and PUBLISHED by the main loop
// as Artifacts — a workflow cannot publish Artifacts. This bundle is their input.
return {
  status: 'green',
  feature,
  testPaths,
  green: { summary: green.summary, filesTouched: green.filesTouched },
  review1: review1Findings,
  refactor,
  review2: review2Findings,
  capture,
  next: 'Main loop: build the visual test report (diagrams.ts) and the human smoke test, publish both as Artifacts.',
}
