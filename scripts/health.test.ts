import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `scripts/health.ts` is the gate sig-infra runs after migrating a deploy
 * snapshot: if a required table is missing it exits 1 and the deploy rolls back
 * to the pre-migration database. That makes its REQUIRED_TABLES list a
 * duplicate of the `Database` interface in server/db/schema.ts — and a silent
 * one. A table added to the schema but not to the list is simply never checked,
 * so a migration that failed to create it sails through validation and the
 * server crashes on first query in production.
 *
 * The list cannot be imported (health.ts calls process.exit at module scope),
 * so both files are read as source and compared.
 */
const ROOT = join(import.meta.dir, '..');

function requiredTables(): string[] {
    const src = readFileSync(join(ROOT, 'scripts', 'health.ts'), 'utf8');
    const block = src.match(/const REQUIRED_TABLES = \[([\s\S]*?)\];/);
    if (!block) throw new Error('REQUIRED_TABLES not found in scripts/health.ts');
    return [...block[1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
}

function schemaTables(): string[] {
    const src = readFileSync(join(ROOT, 'server', 'db', 'schema.ts'), 'utf8');
    const block = src.match(/export interface Database \{([\s\S]*?)\n\}/);
    if (!block) throw new Error('Database interface not found in server/db/schema.ts');
    return [...block[1]!.matchAll(/^\s*(\w+):/gm)].map((m) => m[1]!);
}

describe('deploy DB health check', () => {
    test('REQUIRED_TABLES matches the Database interface exactly', () => {
        expect([...requiredTables()].sort()).toEqual([...schemaTables()].sort());
    });

    test('the schema actually parsed (guards the regexes above)', () => {
        expect(schemaTables().length).toBeGreaterThan(20);
        expect(schemaTables()).toContain('tapscore_published_scores');
        expect(requiredTables()).toContain('users');
    });
});
