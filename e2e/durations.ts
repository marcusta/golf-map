/**
 * Prints per-test durations from the last Playwright run (e2e/results/results.json,
 * written by the json reporter in playwright.config.ts), slowest first, plus the total.
 * Usage: bun e2e/durations.ts [path-to-results.json]
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

interface Result { duration: number; status: string }
interface Test { results: Result[]; status?: string }
interface Spec { title: string; file: string; tests: Test[] }
interface Suite { specs?: Spec[]; suites?: Suite[] }

const file = process.argv[2] ?? path.join(import.meta.dir, 'results', 'results.json');
if (!fs.existsSync(file)) {
    console.error(`No results at ${file}. Run bun run e2e or bun run e2e:create first.`);
    process.exit(1);
}
const report = JSON.parse(fs.readFileSync(file, 'utf8')) as { suites: Suite[] };

const rows: { file: string; title: string; ms: number; status: string }[] = [];
const walk = (s: Suite): void => {
    for (const spec of s.specs ?? []) {
        for (const t of spec.tests) {
            const last = t.results[t.results.length - 1];
            rows.push({
                file: spec.file,
                title: spec.title,
                ms: t.results.reduce((n, r) => n + r.duration, 0),
                status: last?.status ?? 'unknown',
            });
        }
    }
    (s.suites ?? []).forEach(walk);
};
report.suites.forEach(walk);
rows.sort((a, b) => b.ms - a.ms);

const w = Math.max(4, ...rows.map((r) => r.file.length));
console.log(`${'spec'.padEnd(w)}  ${'ms'.padStart(7)}  status    title`);
for (const r of rows) console.log(`${r.file.padEnd(w)}  ${String(Math.round(r.ms)).padStart(7)}  ${r.status.padEnd(8)}  ${r.title}`);
console.log(`${'total'.padEnd(w)}  ${String(Math.round(rows.reduce((n, r) => n + r.ms, 0))).padStart(7)}  (${rows.length} tests)`);
