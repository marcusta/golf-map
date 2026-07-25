import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const MOBILE_ROOT = join(import.meta.dir, '..', 'src', 'mobile');

/**
 * The mobile companion bundle must stay independent of the desktop builder.
 * These areas are either frozen by an iOS golden (draw), heavy editor-only
 * machinery (editor, map-build, import), or the interactive planner tools
 * (planner-tool.service / planner-panel) — none belong in a read-only,
 * touch-first on-course view. Reusing the pure planner ENGINES (browse-ladder,
 * plan-overlay, plan.service) is allowed; the tool services are not.
 */
const FORBIDDEN = [
    /\/editor\//,
    /\/draw\//,
    /\/import\//,
    /\/map-build\//,
    /\/planner-tool\.service/,
    /\/planner-panel/,
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
});
