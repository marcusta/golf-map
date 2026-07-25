import { describe, expect, test } from 'bun:test';
import * as path from 'node:path';
import * as os from 'node:os';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { assertSafeMemberPath, createTarZst, extractTarZst, listTarZstMembers } from './bundle-archive';

function tmp(prefix: string): string {
    return mkdtempSync(path.join(os.tmpdir(), `golf-${prefix}-`));
}

/** Builds a tar.zst whose members are exactly `memberSpecs` (relative to cwd). */
function craftArchive(cwd: string, memberSpecs: string[]): string {
    const tarPath = path.join(cwd, 'evil.tar');
    const zstPath = path.join(cwd, 'evil.tar.zst');
    const tar = Bun.spawnSync(['tar', '-cf', tarPath, ...memberSpecs], { cwd });
    if (tar.exitCode !== 0) throw new Error(`tar craft failed: ${tar.stderr.toString()}`);
    const zstd = Bun.spawnSync(['zstd', '-q', '-o', zstPath, tarPath]);
    if (zstd.exitCode !== 0) throw new Error(`zstd craft failed: ${zstd.stderr.toString()}`);
    return zstPath;
}

describe('assertSafeMemberPath', () => {
    test('accepts ordinary relative members', () => {
        for (const ok of ['content/sites.jsonl', './tiles/ortho/14/1/1.jpg', 'meta.json', '.', './']) {
            expect(() => assertSafeMemberPath(ok)).not.toThrow();
        }
    });

    test('rejects absolute paths', () => {
        expect(() => assertSafeMemberPath('/etc/passwd')).toThrow(/absolute/);
        expect(() => assertSafeMemberPath('C:\\windows\\system32')).toThrow(/absolute/);
    });

    test('rejects parent-escaping members', () => {
        for (const bad of ['../escape.txt', 'a/../../etc/passwd', 'foo/..', '..']) {
            expect(() => assertSafeMemberPath(bad)).toThrow(/'\.\.' segment/);
        }
    });
});

describe('extractTarZst path-traversal guard', () => {
    test('rejects an archive with a .. member before writing anything', async () => {
        const work = tmp('craft');
        mkdirSync(path.join(work, 'sub'), { recursive: true });
        writeFileSync(path.join(work, 'escape.txt'), 'PAYLOAD');
        writeFileSync(path.join(work, 'sub', 'ok.txt'), 'inner');
        // From sub/, member names become "../escape.txt" and "ok.txt".
        const archive = craftArchive(path.join(work, 'sub'), ['../escape.txt', 'ok.txt']);

        const members = await listTarZstMembers(archive);
        expect(members).toContain('../escape.txt');

        const dest = tmp('dest');
        await expect(extractTarZst(archive, dest)).rejects.toThrow(/Unsafe archive member/);
        // Nothing extracted — the guard runs before the untar.
        expect(existsSync(path.join(dest, 'ok.txt'))).toBe(false);
        expect(existsSync(path.join(path.dirname(dest), 'escape.txt'))).toBe(false);
    });

    test('rejects an archive with an absolute-path member', async () => {
        const work = tmp('craft');
        writeFileSync(path.join(work, 'escape.txt'), 'PAYLOAD');
        const archive = craftArchive(work, ['-P', path.join(work, 'escape.txt')]);
        const dest = tmp('dest');
        await expect(extractTarZst(archive, dest)).rejects.toThrow(/Unsafe archive member.*absolute/);
    });

    test('extracts a well-formed archive normally', async () => {
        const src = tmp('src');
        mkdirSync(path.join(src, 'content'), { recursive: true });
        writeFileSync(path.join(src, 'meta.json'), '{}');
        writeFileSync(path.join(src, 'content', 'sites.jsonl'), '{"id":"s1"}');
        const archive = path.join(tmp('arc'), 'good.tar.zst');
        await createTarZst(src, archive);

        const members = await listTarZstMembers(archive);
        for (const m of members) expect(() => assertSafeMemberPath(m)).not.toThrow();

        const dest = tmp('dest');
        await extractTarZst(archive, dest);
        expect(existsSync(path.join(dest, 'meta.json'))).toBe(true);
        expect(existsSync(path.join(dest, 'content', 'sites.jsonl'))).toBe(true);
    });
});
