import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const WEB_ROOT = join(import.meta.dir, '..');
const REPO_ROOT = join(WEB_ROOT, '..');
const MOBILE_ROOT = join(WEB_ROOT, 'src', 'mobile');

/**
 * The mobile companion bundle must stay independent of the desktop builder.
 * These areas are either frozen by an iOS golden (draw), heavy editor-only
 * machinery (editor, map-build, import), or the interactive planner tools
 * (planner-tool.service / planner-panel) — none belong in a read-only,
 * touch-first on-course view. Reusing the pure planner ENGINES (browse-ladder,
 * plan-overlay, plan.service, putt-read.service, putt-overlay, analysis-math)
 * is allowed; the tool services are not.
 *
 * analysis-overlay is listed too: it is a RENDERER, not an engine — it imports
 * maplibre-gl directly (DOM label markers) and draw/features.service, so
 * pulling it in would breach the draw boundary transitively. The green screen
 * rebuilds its thin geometry in mobile/green/green-overlay.ts and reuses the
 * analysis MATH instead.
 */
const FORBIDDEN = [
    /\/editor\//,
    /\/draw\//,
    /\/import\//,
    /\/map-build\//,
    /\/planner-tool\.service/,
    /\/planner-panel/,
    /\/analysis-overlay/,
];

function walk(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) out.push(...walk(full));
        else if (entry.name.endsWith('.ts')) out.push(full);
    }
    return out;
}

/** Every module specifier of a static or dynamic import in `source`. */
function importSpecifiers(source: string): string[] {
    const specs: string[] = [];
    const patterns = [
        /import\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g,
        /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
        /export\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g,
    ];
    for (const pattern of patterns) {
        for (const match of source.matchAll(pattern)) specs.push(match[1]!);
    }
    return specs;
}

/** Resolve a relative specifier to a real file, or null when it is a package. */
function resolveSpecifier(fromFile: string, spec: string): string | null {
    if (!spec.startsWith('.')) return null; // bare package — not ours to follow
    const base = resolve(dirname(fromFile), spec);
    const candidates = [
        base,
        `${base}.ts`,
        `${base}.tsx`,
        join(base, 'index.ts'),
        join(base, 'index.tsx'),
    ];
    for (const candidate of candidates) {
        if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    }
    return null;
}

describe('mobile import boundary', () => {
    const files = walk(MOBILE_ROOT);

    test('there are mobile source files to check', () => {
        expect(files.length).toBeGreaterThan(0);
    });

    for (const file of files) {
        test(`${file.slice(MOBILE_ROOT.length + 1)} imports no forbidden area`, () => {
            const specs = importSpecifiers(readFileSync(file, 'utf8'));
            for (const spec of specs) {
                for (const forbidden of FORBIDDEN) {
                    expect(forbidden.test(spec)).toBe(false);
                }
            }
        });
    }

    /**
     * The direct scan above only sees each file's own specifiers — it would
     * miss a forbidden module reached THROUGH an allowed one (mobile imports
     * planner/putt-read.service, which imports …). Walk the whole reachable
     * graph out of src/mobile and check every module that lands in it.
     */
    test('the transitive module graph out of src/mobile stays clean', () => {
        const seen = new Set<string>();
        const queue = [...files];
        const offenders: string[] = [];

        while (queue.length > 0) {
            const file = queue.pop()!;
            if (seen.has(file)) continue;
            seen.add(file);

            const rel = `/${relative(REPO_ROOT, file).split('\\').join('/')}`;
            for (const forbidden of FORBIDDEN) {
                if (forbidden.test(rel)) offenders.push(rel);
            }

            for (const spec of importSpecifiers(readFileSync(file, 'utf8'))) {
                for (const forbidden of FORBIDDEN) {
                    if (forbidden.test(spec)) offenders.push(`${rel} → ${spec}`);
                }
                const target = resolveSpecifier(file, spec);
                if (target && !seen.has(target)) queue.push(target);
            }
        }

        expect(offenders).toEqual([]);
        // The walk must actually have gone somewhere: the green screen alone
        // pulls in the planner read engine, the analysis math, the geo stack
        // and the shared strategy package. A resolver regression that silently
        // stopped following imports would otherwise pass this test.
        expect(seen.size).toBeGreaterThan(60);
        expect([...seen].some(f => f.includes(join('src', 'planner')))).toBe(true);
        expect([...seen].some(f => f.includes(join('shared', 'strategy')))).toBe(true);
    });
});
