// The `creeks` target's own facts: what Unity's creek import left open. The
// chain itself is `GsproSyncService.updateCreeks`.
//
// `golfmap.creeks.import` (unity/Editor/GolfMap/GolfMapCreeks.cs) fits each
// R.A.M. creek to the course meshes and closes the gaps under its water's
// edge (CloseGaps: widen a side, move an end on, lower the water in 2 cm
// steps). What it cannot close needs a deeper bed — dug in the DEM or cut in
// Blender — and the import writes it down beside the creeks export it read:
// `<prefix>-inner-creek-gaps.json` (`golfmap-creek-gaps-v1`, GolfMapCreeks
// `GapsDoc`), per creek id its open gaps, the `needsBed` spots near play, the
// `farFromPlay` spots of a creek wholly far from play (left as they are), and
// its collider error. Until this was read, "Update creeks" ended "done" while
// Vreta had 85 gaps open; the board now says which creeks need a bed (the
// phase, the report, the row's note and its manual step).
import * as path from 'node:path';
import { readFile } from 'node:fs/promises';
import { courseSlug } from './gspro-export.service';

export const CREEK_GAPS_FORMAT = 'golfmap-creek-gaps-v1';

/** `Vreta Kloster GK` -> `vreta-kloster-gk-inner-creek-gaps.json`, beside `…-inner-creeks.json`. */
export function creekGapsFileName(courseName: string): string {
    return `${courseSlug(courseName)}-inner-creek-gaps.json`;
}

/** One spot where the water's edge still hangs over the ground: plot metres and EPSG:3006. */
export interface CreekGapSpot {
    x: number;
    z: number;
    /** How far the edge hangs over the ground there; null over no ground at all (`noGround`). */
    hangM: number | null;
    e: number;
    n: number;
    noGround?: boolean;
}

/** One creek's entry, keyed by its export id (`feature:<uuid>`). */
export interface CreekGapsEntry {
    status?: string;
    importedAt?: string;
    /** Every point of the creek is farther than `fit.farFromPlayM` from the playing field. */
    far?: boolean;
    /** A channel on a pond's water plane: no gaps of its own. */
    onLake?: boolean;
    /** Edge vertices still hanging over the ground after CloseGaps. */
    gaps?: number;
    needsBed?: CreekGapSpot[];
    farFromPlay?: CreekGapSpot[];
    colliderError?: string | null;
    /** CloseGaps could not run (`no R.A.M. mesh`). */
    error?: string;
}

export interface CreekGaps {
    format: typeof CREEK_GAPS_FORMAT;
    /** Local time of the import that wrote it. */
    written?: string;
    creeks: Record<string, CreekGapsEntry>;
}

/** What the gaps say, by creek id (full ids, in file order). */
export interface CreekGapsFindings {
    creeks: number;
    /** Open edge vertices over all creeks. */
    gaps: number;
    needsBed: string[];
    farFromPlay: string[];
    colliderErrors: string[];
    errors: string[];
}

/** The file, or null when it is not there, cannot be read or is not ours. */
export async function readCreekGaps(file: string): Promise<CreekGaps | null> {
    try {
        const doc = JSON.parse(await readFile(file, 'utf8')) as Partial<CreekGaps>;
        if (doc.format !== CREEK_GAPS_FORMAT || !doc.creeks || typeof doc.creeks !== 'object') return null;
        return doc as CreekGaps;
    } catch {
        return null;
    }
}

/** Counted from the entries themselves (the file's own `summary` is only words). */
export function creekGapsFindings(doc: CreekGaps): CreekGapsFindings {
    const entries = Object.entries(doc.creeks).filter(([, e]) => !!e && typeof e === 'object');
    const having = (has: (e: CreekGapsEntry) => boolean) => entries.filter(([, e]) => has(e)).map(([id]) => id);
    return {
        creeks: entries.length,
        gaps: entries.reduce((n, [, e]) => n + (typeof e.gaps === 'number' ? e.gaps : 0), 0),
        needsBed: having(e => Array.isArray(e.needsBed) && e.needsBed.length > 0),
        farFromPlay: having(e => Array.isArray(e.farFromPlay) && e.farFromPlay.length > 0),
        colliderErrors: having(e => typeof e.colliderError === 'string' && e.colliderError.length > 0),
        errors: having(e => typeof e.error === 'string' && e.error.length > 0),
    };
}

/** `feature:b37cf073-7ad6-…` -> `b37cf073`, the way the reports name a creek. */
export function shortCreekId(id: string): string {
    let s = id.includes(':') ? id.slice(id.indexOf(':') + 1) : id;
    const dash = s.indexOf('-');
    if (dash > 0) s = s.slice(0, dash);
    return s.length > 12 ? s.slice(0, 8) : s;
}

/** How many short ids a line names before "+N more". */
const IDS_SHOWN = 8;

function shortIds(ids: string[]): string {
    const shown = ids.slice(0, IDS_SHOWN).map(shortCreekId).join(', ');
    return ids.length > IDS_SHOWN ? `${shown} +${ids.length - IDS_SHOWN} more` : shown;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "2 creeks need a bed: b37cf073, 4a8c6c7a" — the phase's warning; null when none does. */
export function needsBedLine(f: CreekGapsFindings): string | null {
    if (f.needsBed.length === 0) return null;
    return `${plural(f.needsBed.length, 'creek')} ${f.needsBed.length === 1 ? 'needs' : 'need'} a bed: ${shortIds(f.needsBed)}`;
}

/**
 * The Creeks row's note: which creeks need a bed (or that none does), and
 * what else the last import left — creeks far from play with gaps left as
 * they are, collider errors, creeks it could not check.
 */
export function creekGapsNote(doc: CreekGaps): string {
    const f = creekGapsFindings(doc);
    const parts = [needsBedLine(f) ?? `no creek needs a bed (${plural(f.creeks, 'creek')})`];
    if (f.farFromPlay.length) parts.push(`${f.farFromPlay.length} far from play left open`);
    if (f.colliderErrors.length) parts.push(`${plural(f.colliderErrors.length, 'collider error')}: ${shortIds(f.colliderErrors)}`);
    if (f.errors.length) parts.push(`${f.errors.length} not checked: ${shortIds(f.errors)}`);
    return parts.join('; ');
}

/** The way a CLI line names the course: as it is, or quoted when the shell would split it. */
function courseArg(courseName: string): string {
    return /^[\w.-]+$/.test(courseName) ? courseName : JSON.stringify(courseName);
}

/** The step a creek that needs a bed leaves: find where the bed is too shallow, then dig it deeper or cut it in Blender. */
export function creekBedStep(courseName: string): string {
    return `dig deeper or a Blender bed: \`bun run water:depth -- ${courseArg(courseName)}\``;
}

/**
 * One line per creek that needs a bed (the first `max`): its open gaps, the
 * spots to dig, how far the water hangs over the ground at the worst and
 * where the first spot is (EPSG:3006). The rest are in `file`.
 */
export function needsBedDetails(doc: CreekGaps, file: string, max = 10): string[] {
    const ids = creekGapsFindings(doc).needsBed;
    const lines = ids.slice(0, max).map((id) => {
        const e = doc.creeks[id]!;
        const spots = e.needsBed ?? [];
        const hangs = spots.map(s => s.hangM).filter((h): h is number => typeof h === 'number');
        const first = spots[0];
        return `  ${shortCreekId(id)}: ${plural(e.gaps ?? 0, 'gap')} open, ${plural(spots.length, 'spot')} to dig`
            + (hangs.length ? `, the water up to ${Math.max(...hangs).toFixed(2)} m over the ground` : '')
            + (first ? ` (first at E ${first.e} N ${first.n})` : '');
    });
    if (ids.length > max) lines.push(`  … and ${ids.length - max} more in ${path.basename(file)}`);
    return lines;
}
