/**
 * tar.zst pack/unpack for publish bundles (T59). Uses the system `tar` + `zstd`
 * (present on the Mac builder and the Linux VPS) piped process-to-process so a
 * ~80 MB bundle never lands wholesale in memory. No shell — args are passed
 * directly, so bundle paths (always server-controlled, under `dataDir`) can't
 * be misinterpreted.
 */
import * as path from 'node:path';

type Proc = ReturnType<typeof Bun.spawn>;

function spawn(cmd: string[], opts: { stdin?: ReadableStream; pipeStdout?: boolean }): Proc {
    return Bun.spawn(cmd, {
        stdin: opts.stdin ?? 'ignore',
        stdout: opts.pipeStdout ? 'pipe' : 'inherit',
        stderr: 'pipe',
    } as Parameters<typeof Bun.spawn>[1]);
}

async function finish(proc: Proc, label: string): Promise<void> {
    const code = await proc.exited;
    if (code !== 0) {
        const err = proc.stderr ? await new Response(proc.stderr as ReadableStream).text() : '';
        throw new Error(`${label} failed (exit ${code}): ${err.trim()}`);
    }
}

/**
 * Packs the contents of `srcDir` into `outPath` as a zstd-compressed tar.
 * Entry names are relative to `srcDir` (no leading directory), so extraction
 * lands the tree directly under the destination.
 */
export async function createTarZst(srcDir: string, outPath: string): Promise<void> {
    const tar = spawn(['tar', '-cf', '-', '-C', srcDir, '.'], { pipeStdout: true });
    const zstd = spawn(['zstd', '-q', '-o', outPath, '-'], { stdin: tar.stdout as ReadableStream });
    await Promise.all([finish(tar, 'tar'), finish(zstd, 'zstd')]);
}

/**
 * Rejects an archive member whose name is absolute or contains a `..` segment
 * (a path-traversal / zip-slip attempt that could write outside `destDir`).
 * System `tar` refuses these too, but the VPS `tar` implementation isn't under
 * our control, so we guard in-code as defense-in-depth.
 */
export function assertSafeMemberPath(name: string): void {
    const clean = name.replace(/^\.\//, '').replace(/\/$/, '');
    if (clean.length === 0) return;
    if (name.startsWith('/') || path.isAbsolute(name) || /^[A-Za-z]:[\\/]/.test(name)) {
        throw new Error(`Unsafe archive member (absolute path): ${name}`);
    }
    const segments = clean.split(/[/\\]/);
    if (segments.some((s) => s === '..')) {
        throw new Error(`Unsafe archive member ('..' segment): ${name}`);
    }
}

/** Lists the member names in a zstd-compressed tar (via `tar -t`). */
export async function listTarZstMembers(archivePath: string): Promise<string[]> {
    const unzstd = spawn(['zstd', '-dc', archivePath], { pipeStdout: true });
    const list = spawn(['tar', '-tf', '-'], { stdin: unzstd.stdout as ReadableStream, pipeStdout: true });
    const namesText = await new Response(list.stdout as ReadableStream).text();
    await Promise.all([finish(unzstd, 'zstd -d'), finish(list, 'tar -t')]);
    return namesText
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
}

/**
 * Extracts a zstd-compressed tar `archivePath` into `destDir` (created if
 * needed). Every member is vetted (`assertSafeMemberPath`) before extraction,
 * so a malicious bundle can't escape `destDir` even on a tar that would allow
 * it.
 */
export async function extractTarZst(archivePath: string, destDir: string): Promise<void> {
    for (const member of await listTarZstMembers(archivePath)) {
        assertSafeMemberPath(member);
    }
    const unzstd = spawn(['zstd', '-dc', archivePath], { pipeStdout: true });
    const untar = spawn(['tar', '-xf', '-', '-C', destDir], { stdin: unzstd.stdout as ReadableStream });
    await Promise.all([finish(unzstd, 'zstd -d'), finish(untar, 'tar -x')]);
}
