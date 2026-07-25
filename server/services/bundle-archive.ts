/**
 * tar.zst pack/unpack for publish bundles (T59). Uses the system `tar` + `zstd`
 * (present on the Mac builder and the Linux VPS) piped process-to-process so a
 * ~80 MB bundle never lands wholesale in memory. No shell — args are passed
 * directly, so bundle paths (always server-controlled, under `dataDir`) can't
 * be misinterpreted.
 */
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

/** Extracts a zstd-compressed tar `archivePath` into `destDir` (created if needed). */
export async function extractTarZst(archivePath: string, destDir: string): Promise<void> {
    const unzstd = spawn(['zstd', '-dc', archivePath], { pipeStdout: true });
    const untar = spawn(['tar', '-xf', '-', '-C', destDir], { stdin: unzstd.stdout as ReadableStream });
    await Promise.all([finish(unzstd, 'zstd -d'), finish(untar, 'tar -x')]);
}
