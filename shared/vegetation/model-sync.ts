// The repo's model libraries and tree palette are the course's only hand-kept copies; Unity's
// (Assets/GolfMap/<Course>/models.json and palette.json, which GolfMapPalette.Load reads) are generated
// from them by `syncCourseModels` (`bun run models -- sync`, and after every `models -- add / promote /
// palette` that finds the course's Unity folder):
//   models.json   the course's RESOLVED library: docs/gspro/model-library.json with the course's
//                 docs/gspro/<course>/models.json over it (tree-models.ts loadModelLibrary, modelLibraryText);
//   palette.json  docs/gspro/<course>/palette.json, byte for byte.
//
// Unity's copy may still be edited by hand (or by an old tool), and a plain copy would lose that. The
// project keeps a base: the content hash of each file as of the last sync, in
// <project>/Library/GolfMapBridge/course-docs-sync.json. A Unity copy that differs from the repo's is then
//   repo-changed  Unity's is what the last sync wrote (or differs only in line endings/BOM, or is the same
//                 JSON written another way): copied;
//   drift         Unity's was changed since (or there is no base yet): refused, with the diff, unless force.
// A file the repo lacks is left alone (`unity-only` when Unity has one: copy it into the repo by hand).
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PALETTE_FORMAT, SHARED_LIBRARY_FILE, loadModelLibrary, modelLibraryText, resolvePalette, sharedLibraryFile } from './tree-models';

export const SYNCED_FILES = ['models.json', 'palette.json'] as const;
export type SyncedFile = (typeof SYNCED_FILES)[number];

export type SyncState = 'same' | 'new' | 'repo-changed' | 'drift' | 'unity-only' | 'absent';

export interface FileSync {
    file: SyncedFile;
    /** What Unity's copy is made from (models.json: the course's file, resolved with the shared library). */
    repoFile: string;
    unityFile: string;
    state: SyncState;
    /** copied: written now; would-copy: dry run; refused: drift without force. */
    action?: 'copied' | 'would-copy' | 'refused';
    /** Unity's copy against the repo's, for a drift: '-' Unity's line, '+' the repo's. */
    diff?: string;
}

export interface SyncOptions {
    /** docs/gspro/<course>/ */
    docsDir: string;
    /** The course's folder in the Unity project (<project>/Assets/GolfMap/<Course>/). */
    unityDir: string;
    files?: readonly SyncedFile[];
    dryRun?: boolean;
    /** Overwrite a drifted Unity copy (repo wins). */
    force?: boolean;
}

const BASE_FORMAT = 'golfmap-course-docs-sync-v1';

/** The text as a sync compares it: no BOM, LF line endings. */
const normalise = (bytes: Buffer) => bytes.toString('utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n');
const hash = (bytes: Buffer) => createHash('sha1').update(normalise(bytes)).digest('hex');

/** The Unity project holding `unityDir` (the folder above its Assets). */
export function unityProjectOf(unityDir: string): string {
    let dir = path.resolve(unityDir);
    for (;;) {
        if (path.basename(dir).toLowerCase() === 'assets') return path.dirname(dir);
        const up = path.dirname(dir);
        if (up === dir) throw Error(`${unityDir} is not inside a Unity project's Assets folder`);
        dir = up;
    }
}

interface BaseFile { file: string; key: (unityFile: string) => string; hashes: Record<string, string> }

function readBase(unityDir: string): BaseFile {
    const project = unityProjectOf(unityDir);
    const file = path.join(project, 'Library', 'GolfMapBridge', 'course-docs-sync.json');
    let hashes: Record<string, string> = {};
    try {
        const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (doc.format === BASE_FORMAT && doc.files) hashes = doc.files;
    } catch { /* no base yet */ }
    const key = (unityFile: string) => path.relative(project, unityFile).replace(/\\/g, '/');
    return { file, key, hashes };
}

function writeBase(base: BaseFile): void {
    fs.mkdirSync(path.dirname(base.file), { recursive: true });
    fs.writeFileSync(base.file, JSON.stringify({ format: BASE_FORMAT, files: base.hashes }, null, 2) + '\n');
}

/** The same JSON (keys in any order; a library's models in any order), whatever the text. */
export function sameJson(a: Buffer, b: Buffer): boolean {
    const sortKeys = (v: unknown): unknown => Array.isArray(v) ? v.map(sortKeys)
        : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sortKeys((v as Record<string, unknown>)[k])])) : v;
    const canon = (bytes: Buffer) => {
        const doc = JSON.parse(normalise(bytes));
        if (Array.isArray(doc?.models)) doc.models = [...doc.models].sort((x: { id?: string }, y: { id?: string }) => String(x?.id).localeCompare(String(y?.id)));
        return JSON.stringify(sortKeys(doc));
    };
    try { return canon(a) === canon(b); } catch { return false; }
}

/**
 * What Unity's copy of `file` is made of: models.json = the course's resolved library (none while neither
 * the shared library nor the course file exists), palette.json = the course's file.
 */
export function sourceOf(docsDir: string, file: SyncedFile): { bytes?: Buffer; label: string } {
    if (file === 'models.json') {
        const own = path.join(docsDir, file), shared = sharedLibraryFile(docsDir);
        const label = `${own} resolved with ${SHARED_LIBRARY_FILE}`;
        if (!fs.existsSync(own) && !fs.existsSync(shared)) return { label };
        return { bytes: Buffer.from(modelLibraryText(loadModelLibrary(docsDir))), label };
    }
    const own = path.join(docsDir, file);
    return { bytes: fs.existsSync(own) ? fs.readFileSync(own) : undefined, label: own };
}

/** Where one file stands, read only. */
function stateOf(repo: Buffer | undefined, unityFile: string, baseHash: string | undefined): { state: SyncState; unity?: Buffer } {
    const unity = fs.existsSync(unityFile) ? fs.readFileSync(unityFile) : undefined;
    if (!repo) return { state: unity ? 'unity-only' : 'absent', unity };
    if (!unity) return { state: 'new' };
    if (repo.equals(unity)) return { state: 'same', unity };
    const u = hash(unity);
    if (u === baseHash || u === hash(repo) || sameJson(unity, repo)) return { state: 'repo-changed', unity };
    return { state: 'drift', unity };
}

/** Each file's state against Unity's copy; writes nothing. */
export function checkCourseModels(opts: SyncOptions): FileSync[] {
    return syncCourseModels({ ...opts, dryRun: true });
}

/**
 * The repo's files into Unity's course folder, byte-equal. A drifted Unity copy is refused (with the
 * diff) unless `force`; a dry run reports what would happen and writes nothing (not even the base).
 */
export function syncCourseModels({ docsDir, unityDir, files = SYNCED_FILES, dryRun = false, force = false }: SyncOptions): FileSync[] {
    if (!fs.existsSync(unityDir)) throw Error(`No Unity course folder ${unityDir}`);
    const base = readBase(unityDir);
    const out: FileSync[] = [];
    let baseChanged = false;
    for (const file of files) {
        const { bytes: repo, label: repoFile } = sourceOf(docsDir, file);
        const unityFile = path.join(unityDir, file);
        const key = base.key(unityFile);
        const { state, unity } = stateOf(repo, unityFile, base.hashes[key]);
        const entry: FileSync = { file, repoFile, unityFile, state };
        if (state === 'drift') entry.diff = lineDiff(normalise(unity!), normalise(repo!));
        const copy = state === 'new' || state === 'repo-changed' || (state === 'drift' && force);
        if (state === 'drift' && !force) entry.action = 'refused';
        else if (copy) entry.action = dryRun ? 'would-copy' : 'copied';
        if (!dryRun && copy) fs.writeFileSync(unityFile, repo!);
        if (!dryRun && repo && (copy || state === 'same') && base.hashes[key] !== hash(repo)) {
            base.hashes[key] = hash(repo);
            baseChanged = true;
        }
        out.push(entry);
    }
    if (baseChanged) writeBase(base);
    return out;
}

/** True when a sync left a file refused (drift) or the repo lacks one Unity has. */
export const syncRefused = (report: FileSync[]) => report.some(r => r.action === 'refused' || r.state === 'unity-only');

/** The report as lines for a terminal (a drift loudly, with its diff). */
export function formatSync(report: FileSync[]): string {
    const lines: string[] = [];
    for (const r of report) {
        switch (r.state) {
            case 'same': lines.push(`${r.file}: Unity's copy is the repo's`); break;
            case 'absent': lines.push(`${r.file}: neither the repo nor Unity has one`); break;
            case 'unity-only': lines.push(`DRIFT ${r.file}: Unity has ${r.unityFile}, the repo has none - copy it into ${r.repoFile} by hand if it is wanted`); break;
            case 'new': case 'repo-changed':
                lines.push(`${r.file}: ${r.action === 'copied' ? 'copied' : 'would copy'} ${r.repoFile} -> ${r.unityFile}${r.state === 'new' ? ' (new in Unity)' : ''}`);
                break;
            case 'drift':
                lines.push(r.action === 'refused'
                    ? `DRIFT ${r.file}: Unity's copy was changed since the last sync (or never synced) and differs from the repo's. `
                        + `Nothing copied. Carry the change into ${r.repoFile} (the repo is the source), or overwrite Unity's with --force.`
                    : `DRIFT ${r.file}: Unity's changes ${r.action === 'copied' ? 'overwritten' : 'would be overwritten'} (--force): ${r.repoFile} -> ${r.unityFile}`);
                lines.push(`--- ${r.unityFile} (Unity)`, `+++ ${r.repoFile} (repo)`, r.diff ?? '');
                break;
        }
    }
    return lines.join('\n');
}

/** A short line diff (a: '-', b: '+', 2 lines of context), LCS on lines. */
export function lineDiff(a: string, b: string, context = 2, maxLines = 120): string {
    const x = a.split('\n'), y = b.split('\n');
    // Trim the common head and tail first: the files are mostly equal.
    let head = 0;
    while (head < x.length && head < y.length && x[head] === y[head]) head++;
    let tail = 0;
    while (tail < x.length - head && tail < y.length - head && x[x.length - 1 - tail] === y[y.length - 1 - tail]) tail++;
    // ...but keep `context` lines of each as context.
    head = Math.max(0, head - context);
    tail = Math.max(0, tail - context);
    const xs = x.slice(head, x.length - tail), ys = y.slice(head, y.length - tail);
    const n = xs.length, m = ys.length;
    const ops: { op: ' ' | '-' | '+'; line: string; at: number }[] = [];
    if (n * m <= 4_000_000) {
        const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
        for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
            lcs[i]![j] = xs[i] === ys[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
        let i = 0, j = 0;
        while (i < n || j < m) {
            if (i < n && j < m && xs[i] === ys[j]) { ops.push({ op: ' ', line: xs[i]!, at: head + i }); i++; j++; }
            else if (i < n && (j === m || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) { ops.push({ op: '-', line: xs[i]!, at: head + i }); i++; }
            else { ops.push({ op: '+', line: ys[j]!, at: head + i }); j++; }
        }
    } else {
        for (const line of xs) ops.push({ op: '-', line, at: head });
        for (const line of ys) ops.push({ op: '+', line, at: head });
    }
    const keep = new Set<number>();
    ops.forEach((o, k) => { if (o.op !== ' ') for (let d = -context; d <= context; d++) keep.add(k + d); });
    const out: string[] = [];
    let last = -2;
    ops.forEach((o, k) => {
        if (!keep.has(k)) return;
        if (k !== last + 1) out.push(`@@ line ${o.at + 1} @@`);
        out.push(`${o.op}${o.line}`);
        last = k;
    });
    if (out.length > maxLines) return [...out.slice(0, maxLines), `... ${out.length - maxLines} more diff lines`].join('\n');
    return out.join('\n');
}

/**
 * The Unity course folders whose Course.asset exports as `slug` (its exportPrefix), in the given
 * projects and in every project folder under the given roots (`<root>/<project>/Assets/GolfMap/<Course>/`).
 */
export function findUnityCourseFolders(slug: string, { projects = [], roots = [] }: { projects?: string[]; roots?: string[] }): string[] {
    const candidates = new Set(projects.map(p => path.resolve(p)));
    for (const root of roots) {
        if (!fs.existsSync(root)) continue;
        for (const e of fs.readdirSync(root, { withFileTypes: true })) if (e.isDirectory()) candidates.add(path.resolve(root, e.name));
    }
    const found = new Set<string>();
    for (const project of candidates) {
        const golfmap = path.join(project, 'Assets', 'GolfMap');
        if (!fs.existsSync(golfmap)) continue;
        for (const e of fs.readdirSync(golfmap, { withFileTypes: true })) {
            const asset = path.join(golfmap, e.name, 'Course.asset');
            if (!e.isDirectory() || !fs.existsSync(asset)) continue;
            const prefix = /^\s*exportPrefix:\s*(.*?)\s*$/m.exec(fs.readFileSync(asset, 'utf8'))?.[1];
            if (prefix === slug) found.add(path.join(golfmap, e.name));
        }
    }
    return [...found].sort();
}

/**
 * A new palette for the repo (Unity's Palette panel Save, or `models -- palette --from`): checked (its
 * format, and every model it refers to is in the repo's library) and written as the bytes given.
 */
export function writeCoursePalette(docsDir: string, bytes: Buffer): void {
    checkCoursePalette(docsDir, bytes);
    fs.writeFileSync(path.join(docsDir, 'palette.json'), bytes);
}

/** `writeCoursePalette`'s check alone: throws what is wrong with the new palette. */
export function checkCoursePalette(docsDir: string, bytes: Buffer): void {
    let doc: { format?: string };
    try { doc = JSON.parse(normalise(bytes)); } catch (e) { throw Error(`The new palette is not JSON: ${(e as Error).message}`); }
    if (doc.format !== PALETTE_FORMAT) throw Error(`The new palette's format must be ${PALETTE_FORMAT}`);
    resolvePalette(doc as { format: string }, loadModelLibrary(docsDir));
}
