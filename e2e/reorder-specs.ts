/**
 * Build a differently-ORDERED copy of the spec suite, so the serial,
 * shared-DB E2E suite can be proven ORDER-INDEPENDENT (see TESTING.md).
 *
 * Playwright always runs spec files in alphabetical order, so the only way to
 * change the order is to rename them. This copies `e2e/tests/*` into
 * `e2e/.tests-reordered/` (gitignored), rewriting each `NN-name.spec.ts`
 * prefix; helpers (fixtures.ts, tool-ids.ts, auth.setup.ts) are copied as-is
 * so relative imports keep resolving.
 *
 *   bun e2e/reorder-specs.ts              # reverse the file order
 *   bun e2e/reorder-specs.ts --shift=7    # rotate the file order by 7
 *
 * `bun run e2e:reordered` (repo root) does this and runs the suite against the
 * copy via the config's E2E_TEST_DIR hook.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const SRC = path.join(import.meta.dir, 'tests');
const OUT = path.join(import.meta.dir, '.tests-reordered');

const shiftArg = process.argv.find(a => a.startsWith('--shift='));
const shift = shiftArg ? Number(shiftArg.slice('--shift='.length)) : null;

const entries = fs.readdirSync(SRC);
const specs = entries.filter(f => /^\d\d-.*\.spec\.ts$/.test(f)).sort();
const helpers = entries.filter(f => !/^\d\d-.*\.spec\.ts$/.test(f));

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
for (const helper of helpers) fs.copyFileSync(path.join(SRC, helper), path.join(OUT, helper));

specs.forEach((spec, i) => {
    // Reverse by default; --shift=N rotates instead. Either way every spec
    // keeps a unique prefix, so the copy is the same suite in a new order.
    const target = shift === null ? specs.length - 1 - i : (i + shift) % specs.length;
    const renamed = `${String(target + 1).padStart(2, '0')}${spec.slice(2)}`;
    fs.copyFileSync(path.join(SRC, spec), path.join(OUT, renamed));
});

// eslint-disable-next-line no-console
console.log(
    `${specs.length} specs copied to ${path.relative(path.join(import.meta.dir, '..'), OUT)} ` +
    `(${shift === null ? 'reversed' : `shifted by ${shift}`})`,
);
