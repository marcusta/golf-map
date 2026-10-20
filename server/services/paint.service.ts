// Hand paint and paint rules of the course meshes (the Spline_* meshes' vertex colours), edited from the web
// Terrain editor's Paint tool and `bun run paint`.
//
// The paint itself is Blender's: `docs/gspro/<course>/paint.json` (golfmap-paint-v1: `rules`, optional `lakebed`,
// and `strokes`, the hand paint kept as rules) goes through `gspro.py shaping-paint` into the shaping layer
// `shaping/90-paint.gen.json`, one `golfmap.paint` op per rule and stroke, and the shaping worker's next /sync paints
// and exports the changed FBX (blender/tools/shape_paintop.py, maths in shape_paintrules.py). Unity only shows a
// TEMPORARY preview, so a change is seen at once: optimistic, like the Arborist edit loop
// (arborist-edit.service.ts) — live first, then persist:
//
//   1. golfmap.paint.meshes over the change's box (EPSG:3006) in the course's open Unity editor;
//   2. blender/tools/shape_paintpreview.py: EVERY enabled rule and stroke of the new paint.json, in the layer's
//      order, on those meshes' FBX colours (so overlapping paint composes as Blender's ops do), with the same
//      maths; it also checks every rule, with or without meshes;
//   3. golfmap.paint.preview with the meshes whose colours changed, golfmap.paint.clear for those that no longer
//      differ from their FBX (a stroke removed); a preview lasts until that mesh's next FBX is imported.
//      Once PAINT_LAYER_LIVE is on, the FBX colours carry every rule and stroke as last synced, so step 2 paints
//      only what the change adds or changes (`only`); a removal or disable cannot be taken off them: the meshes in
//      its box go back to the FBX (clear) and it shows after the next sync; a replaced stroke's old paint stays
//      visible until then;
//   4. paint.json written (atomically, 2-space JSON), the layer regenerated (behind PAINT_LAYER_LIVE);
//   5. `sync`: ShapingService.apply, so Blender paints it for good.
//
// dryRun = 1-3 only. With Unity closed the change is checked and saved all the same, the preview reported skipped.
// Edits queue per course (one at a time).
import * as path from 'node:path';
import * as os from 'node:os';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { ConflictError, NotFoundError } from '@basics/core/server/auth';
import type { CoursesService } from './courses.service';
import {
    defaultRunner, ensureDir, failure, venvPython, type ExportRunner, type GsproExportService,
} from './gspro-export.service';
import type { ShapingApplyOptions, ShapingJob, ShapingService } from './shaping.service';
import { defaultUnityBridge, editorForExportDir, type UnityBridge, type UnityEditor } from './unity-bridge';
import { DEFAULT_PIPELINE_DIR } from './pipeline-dir';
import { writeAtomic } from './json-file';

/**
 * THE SWITCH: whether a paint change regenerates the real shaping layer `docs/gspro/<course>/shaping/90-paint.gen.json`.
 * Off while Unity still paints the course meshes by rules (both at once would paint twice): paint.json is written
 * and previewed, the layer is only generated into a temp file as a check. Flip to true (or GOLFMAP_PAINT_LAYER_LIVE=1)
 * when Unity's rule paint is gone.
 */
export const PAINT_LAYER_LIVE = false;

export const PAINT_FORMAT = 'golfmap-paint-v1';
export const PAINT_FILE = 'paint.json';
export const PAINT_LAYER_FILE = '90-paint.gen.json';
export const STROKE_GEOMETRIES = ['line', 'polygon', 'circle'] as const;
export const PAINT_CHANNELS = ['red', 'green', 'blue', 'black'] as const;
export const PAINT_MODES = ['replace', 'overlay'] as const;
/** GolfMapSurfaces.Surface, as shape_paintrules.SURFACES. */
export const PAINT_SURFACES = ['None', 'Deep', 'Rough', 'Semi', 'Fairway', 'Green', 'Tee', 'Bunker', 'Water', 'Blend', 'Other', 'Rock', 'Slab'] as const;
/** paint.json rule kinds (the lake bed is the top-level `lakebed`). */
export const RULE_KINDS = ['object', 'road', 'edge'] as const;
const ID_RE = /^[\w.-]+$/;
const REPO_DIR = path.resolve(import.meta.dir, '..', '..');
const PREVIEW_SCRIPT = path.join(REPO_DIR, 'blender', 'tools', 'shape_paintpreview.py');
const MESHES_SEC = 120;
const PREVIEW_SEC = 60;
const PYTHON_TIMEOUT_MS = 180_000;

export type StrokeGeometry = (typeof STROKE_GEOMETRIES)[number];
export type PaintChannel = (typeof PAINT_CHANNELS)[number];
export type PaintMode = (typeof PAINT_MODES)[number];
export type Box3006 = [number, number, number, number];

/** One stroke of hand paint (paint.json `strokes`): shape_paintrules.normalise kind 'stroke'. */
export interface PaintStroke {
    id: string;
    geometry: StrokeGeometry;
    /** line (>= 2), polygon (>= 3): [E, N] EPSG:3006. */
    points3006?: [number, number][];
    /** circle: centre and radius. */
    centre3006?: [number, number];
    radiusM?: number;
    /** A line's full width (default 1). */
    widthM?: number;
    /** Fade outside the shape (default 0.5; 0 = hard edge). */
    featherM?: number;
    channel: PaintChannel;
    /** 0..1 (default 1). */
    strength?: number;
    mode?: PaintMode;
    /** Only meshes of these surface classes. */
    surfaces?: string[];
    /** Only meshes whose name has this substring. */
    match?: string;
    enabled?: boolean;
}

/** A paint.json rule (kinds object, road, edge); the engine checks its keys. */
export interface PaintRule {
    id: string;
    kind: (typeof RULE_KINDS)[number];
    enabled?: boolean;
    [key: string]: unknown;
}

export interface PaintDoc {
    format: string;
    notes?: unknown;
    rules?: PaintRule[];
    lakebed?: Record<string, unknown>;
    strokes?: PaintStroke[];
    [key: string]: unknown;
}

export interface PaintList {
    courseId: string;
    /** docs/gspro/<course>/paint.json. */
    file: string;
    exists: boolean;
    rules: PaintRule[];
    strokes: PaintStroke[];
    lakebed: Record<string, unknown> | null;
    /** Whether a change regenerates the real shaping layer (PAINT_LAYER_LIVE). */
    layerLive: boolean;
}

export interface PaintChangeOptions {
    /** Preview only: nothing written. */
    dryRun?: boolean;
    /** Afterwards ShapingService.apply, so Blender paints it and exports the FBX. */
    sync?: boolean;
}

export interface PaintPreviewReport {
    status: 'shown' | 'skipped' | 'failed';
    /** Why skipped or failed; null when shown. */
    note: string | null;
    /** EPSG:3006 box the meshes were fetched in. */
    within: number[] | null;
    /** Meshes Unity sent. */
    meshes: number;
    /** Meshes now showing a preview. */
    previewed: string[];
    /** Meshes put back to their FBX colours. */
    cleared: string[];
    skipped: Array<{ object: string; why: string }>;
}

export interface PaintChangeResult {
    courseId: string;
    action: 'stroke' | 'rule' | 'disable' | 'remove';
    id: string;
    dryRun: boolean;
    /** paint.json written. */
    saved: boolean;
    file: string;
    layer: { written: boolean; path: string | null; ops: number | null; note: string };
    preview: PaintPreviewReport;
    /** The shaping apply started by `sync`. */
    sync: { jobId: string; status: ShapingJob['status'] } | null;
    warnings: string[];
}

export interface PaintDeps {
    courses: Pick<CoursesService, 'get'>;
    /** The course's export folder (frame sidecar, road / creek / lake exports; the Unity editor that imports it). */
    exportSettings: Pick<GsproExportService, 'settings'>;
    /** The course's layer folder (its parent is docs/gspro/<course>) and the apply `sync` starts. */
    shaping: { layersDir(courseId: string): Promise<string>; apply(courseId: string, opts?: ShapingApplyOptions): Promise<ShapingJob> };
    pipelineDir?: string;
    python?: string;
    runner?: ExportRunner;
    unityBridge?: UnityBridge;
    /** Default PAINT_LAYER_LIVE (GOLFMAP_PAINT_LAYER_LIVE=1 turns it on too). */
    layerLive?: boolean;
}

/** A paint.json that cannot be: 409 with the engine's words. */
export class PaintError extends ConflictError {}

// --- Pure helpers ---

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isPair = (v: unknown): v is [number, number] => Array.isArray(v) && v.length === 2 && v.every(isNum);
const cm = (v: number) => Math.round(v * 100) / 100;

/** The stroke checked and put in the file's key order (coordinates to the centimetre); throws PaintError. */
export function normaliseStroke(input: unknown): PaintStroke {
    const s = input as Record<string, unknown>;
    if (!s || typeof s !== 'object' || Array.isArray(s)) throw new PaintError('stroke: not an object');
    const known = new Set(['id', 'geometry', 'points3006', 'centre3006', 'radiusM', 'widthM', 'featherM', 'channel', 'strength', 'mode', 'surfaces', 'match', 'enabled', 'kind']);
    const extra = Object.keys(s).filter(k => !known.has(k));
    if (extra.length) throw new PaintError(`stroke: unknown key(s) ${extra.join(', ')}`);
    if (s.kind !== undefined && s.kind !== 'stroke') throw new PaintError('stroke: kind must be stroke');
    const where = `stroke ${typeof s.id === 'string' ? s.id : ''}`.trim();
    if (typeof s.id !== 'string' || !ID_RE.test(s.id)) throw new PaintError(`${where}: needs an id (letters, digits, _ . -)`);
    if (!STROKE_GEOMETRIES.includes(s.geometry as StrokeGeometry)) throw new PaintError(`${where}: geometry must be line, polygon or circle`);
    if (!PAINT_CHANNELS.includes(s.channel as PaintChannel)) throw new PaintError(`${where}: channel must be red, green, blue or black`);
    const out: PaintStroke = { id: s.id, geometry: s.geometry as StrokeGeometry, channel: 'black' };
    const num = (key: string, ok: (v: number) => boolean, rule: string) => {
        if (s[key] === undefined) return undefined;
        if (!isNum(s[key]) || !ok(s[key] as number)) throw new PaintError(`${where}: ${key} must be ${rule}`);
        return s[key] as number;
    };
    if (out.geometry === 'circle') {
        if (!isPair(s.centre3006)) throw new PaintError(`${where}: a circle needs centre3006 [E, N]`);
        const r = num('radiusM', v => v > 0, 'a number > 0');
        if (r === undefined) throw new PaintError(`${where}: a circle needs radiusM > 0`);
        if (s.points3006 !== undefined) throw new PaintError(`${where}: a circle has centre3006, not points3006`);
        out.centre3006 = [cm(s.centre3006[0]), cm(s.centre3006[1])];
        out.radiusM = r;
    } else {
        const min = out.geometry === 'line' ? 2 : 3;
        if (!Array.isArray(s.points3006) || s.points3006.length < min || !s.points3006.every(isPair)) {
            throw new PaintError(`${where}: points3006 must be a list of >= ${min} [E, N] pairs`);
        }
        if (s.centre3006 !== undefined || s.radiusM !== undefined) throw new PaintError(`${where}: centre3006 / radiusM are for a circle`);
        out.points3006 = (s.points3006 as [number, number][]).map(p => [cm(p[0]), cm(p[1])]);
    }
    const width = num('widthM', v => v > 0, 'a number > 0');
    if (width !== undefined) {
        if (out.geometry !== 'line') throw new PaintError(`${where}: widthM is a line's width`);
        out.widthM = width;
    }
    const feather = num('featherM', v => v >= 0, 'a number >= 0');
    if (feather !== undefined) out.featherM = feather;
    out.channel = s.channel as PaintChannel;
    const strength = num('strength', v => v >= 0 && v <= 1, 'a number 0..1');
    if (strength !== undefined) out.strength = strength;
    if (s.mode !== undefined) {
        if (!PAINT_MODES.includes(s.mode as PaintMode)) throw new PaintError(`${where}: mode must be replace or overlay`);
        if (s.mode === 'overlay' && out.channel === 'black') throw new PaintError(`${where}: black has no overlay; use mode replace`);
        out.mode = s.mode as PaintMode;
    }
    if (s.surfaces !== undefined) {
        if (!Array.isArray(s.surfaces)) throw new PaintError(`${where}: surfaces must be a list`);
        out.surfaces = s.surfaces.map(x => {
            const hit = PAINT_SURFACES.find(k => k.toLowerCase() === String(x).toLowerCase());
            if (!hit) throw new PaintError(`${where}: unknown surface ${JSON.stringify(x)}`);
            return hit;
        });
        if (!out.surfaces.length) delete out.surfaces;
    }
    if (s.match !== undefined) {
        if (typeof s.match !== 'string') throw new PaintError(`${where}: match must be a name substring`);
        if (s.match) out.match = s.match;
    }
    if (s.enabled !== undefined) {
        if (typeof s.enabled !== 'boolean') throw new PaintError(`${where}: enabled must be true or false`);
        if (!s.enabled) out.enabled = false;
    }
    return out;
}

/** A rule's outer shape (the engine checks the rest). */
export function checkRule(input: unknown): PaintRule {
    const r = input as Record<string, unknown>;
    if (!r || typeof r !== 'object' || Array.isArray(r)) throw new PaintError('rule: not an object');
    if (typeof r.id !== 'string' || !ID_RE.test(r.id)) throw new PaintError('rule: needs an id (letters, digits, _ . -)');
    if (!RULE_KINDS.includes(r.kind as PaintRule['kind'])) throw new PaintError(`rule ${r.id}: kind must be object, road or edge`);
    if (r.enabled !== undefined && typeof r.enabled !== 'boolean') throw new PaintError(`rule ${r.id}: enabled must be true or false`);
    return r as PaintRule;
}

/** Where a stroke paints, EPSG:3006 [minE, minN, maxE, maxN] (its shape + half width or radius + feather). */
export function strokeBox(s: PaintStroke): Box3006 {
    const feather = s.featherM ?? 0.5;
    if (s.geometry === 'circle') {
        const [e, n] = s.centre3006!;
        const r = s.radiusM! + feather;
        return [e - r, n - r, e + r, n + r];
    }
    const pad = feather + (s.geometry === 'line' ? (s.widthM ?? 1) / 2 : 0);
    const es = s.points3006!.map(p => p[0]);
    const ns = s.points3006!.map(p => p[1]);
    return [Math.min(...es) - pad, Math.min(...ns) - pad, Math.max(...es) + pad, Math.max(...ns) + pad];
}

export function unionBox(a: Box3006 | null, b: Box3006 | null): Box3006 | null {
    if (!a) return b;
    if (!b) return a;
    return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}

const growBox = (b: Box3006, m: number): Box3006 => [b[0] - m, b[1] - m, b[2] + m, b[3] + m];

/**
 * paint.json's text: 2-space JSON with arrays of plain values (an [E, N] pair, a surfaces list, a tint) on one
 * line while they fit, so a stroke's points read one pair per line. Ends with a newline.
 */
export function paintJson(doc: unknown): string {
    const flat = (v: unknown) => v === null || typeof v !== 'object';
    const write = (v: unknown, indent: string): string => {
        if (flat(v)) return JSON.stringify(v);
        const inner = indent + '  ';
        if (Array.isArray(v)) {
            if (!v.length) return '[]';
            if (v.every(flat)) {
                const one = `[${v.map(x => JSON.stringify(x)).join(', ')}]`;
                if (one.length + indent.length <= 100) return one;
            }
            return `[\n${v.map(x => inner + write(x, inner)).join(',\n')}\n${indent}]`;
        }
        const entries = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined);
        if (!entries.length) return '{}';
        return `{\n${entries.map(([k, x]) => `${inner}${JSON.stringify(k)}: ${write(x, inner)}`).join(',\n')}\n${indent}}`;
    };
    return write(doc, '') + '\n';
}

/** A stroke's and a rule's op id in the layer (pipeline/shaping_paint.py). */
export const strokeOpId = (id: string) => `paint-stroke-${id}`;
export const ruleOpId = (id: string) => `paint-${id}`;

/** The next free `stroke-<n>` id. */
export function nextStrokeId(strokes: PaintStroke[]): string {
    let n = 0;
    for (const s of strokes) {
        const m = /^stroke-(\d+)$/.exec(s.id);
        if (m) n = Math.max(n, Number(m[1]));
    }
    return `stroke-${n + 1}`;
}

// --- Service ---

interface PreviewOutput {
    objects: Array<{ object: string; colors: string }>;
    unchanged: string[];
    changed: number;
    ops: number;
    warnings: string[];
}

interface Change {
    action: PaintChangeResult['action'];
    id: string;
    next: PaintDoc;
    /** Where the change paints or painted (null: the whole inner square). */
    box: Box3006 | null;
    /** The layer op ids of what the change adds or changes ([]: it only takes paint away — a removal, a disable). */
    apply: string[];
    /** It replaces an item of the same id (whose old paint the FBX colours keep until the sync). */
    replaced: boolean;
}

export class PaintService {
    private readonly courses: PaintDeps['courses'];
    private readonly exportSettings: PaintDeps['exportSettings'];
    private readonly shaping: PaintDeps['shaping'];
    private readonly pipelineDir: string;
    private readonly runner: ExportRunner;
    private readonly unityBridge: UnityBridge;
    private readonly layerLive: boolean;
    /** One edit at a time per course. */
    private readonly queues = new Map<string, Promise<unknown>>();

    constructor(deps: PaintDeps) {
        this.courses = deps.courses;
        this.exportSettings = deps.exportSettings;
        this.shaping = deps.shaping;
        this.pipelineDir = deps.pipelineDir ?? process.env.MAP_PIPELINE_DIR ?? DEFAULT_PIPELINE_DIR;
        const python = deps.python ?? process.env.MAP_PIPELINE_PYTHON ?? venvPython(this.pipelineDir);
        this.runner = deps.runner ?? defaultRunner(python);
        this.unityBridge = deps.unityBridge ?? defaultUnityBridge();
        this.layerLive = deps.layerLive ?? (PAINT_LAYER_LIVE || process.env.GOLFMAP_PAINT_LAYER_LIVE === '1');
    }

    /** docs/gspro/<course> (the shaping layers' parent). */
    async docsDir(courseId: string): Promise<string> {
        return path.dirname(await this.shaping.layersDir(courseId));
    }

    /** The course's rules and strokes (empty lists while it has no paint.json). */
    async list(courseId: string): Promise<PaintList> {
        await this.courses.get(courseId);
        const file = path.join(await this.docsDir(courseId), PAINT_FILE);
        const doc = await this.read(file);
        return {
            courseId, file, exists: doc !== null,
            rules: doc?.rules ?? [], strokes: doc?.strokes ?? [], lakebed: doc?.lakebed ?? null,
            layerLive: this.layerLive,
        };
    }

    /** Add a stroke, or replace the one with its id (no id: the next `stroke-<n>`). */
    stroke(courseId: string, stroke: Omit<PaintStroke, 'id'> & { id?: string }, opts: PaintChangeOptions = {}): Promise<PaintChangeResult> {
        return this.change(courseId, opts, doc => {
            const strokes = doc.strokes ?? [];
            const s = normaliseStroke({ ...stroke, id: stroke.id || nextStrokeId(strokes) });
            const i = strokes.findIndex(x => x.id === s.id);
            const old = i >= 0 ? strokes[i]! : null;
            const next = i >= 0 ? strokes.map((x, j) => j === i ? s : x) : [...strokes, s];
            return {
                action: 'stroke', id: s.id, next: { ...doc, strokes: next }, box: unionBox(strokeBox(s), old ? strokeBox(old) : null),
                apply: s.enabled === false ? [] : [strokeOpId(s.id)], replaced: old !== null,
            };
        });
    }

    /** Add a rule, or replace the one with its id (in its place). `within` narrows the preview (default: the whole inner square). */
    ruleSet(courseId: string, rule: PaintRule, opts: PaintChangeOptions & { within?: Box3006 } = {}): Promise<PaintChangeResult> {
        return this.change(courseId, opts, doc => {
            const r = checkRule(rule);
            const rules = doc.rules ?? [];
            const i = rules.findIndex(x => x.id === r.id);
            const next = i >= 0 ? rules.map((x, j) => j === i ? r : x) : [...rules, r];
            return {
                action: 'rule', id: r.id, next: { ...doc, rules: next }, box: opts.within ?? null,
                apply: r.enabled === false ? [] : [ruleOpId(r.id)], replaced: i >= 0,
            };
        });
    }

    /** Keep a rule (or stroke) without painting it: `enabled: false`. */
    ruleDisable(courseId: string, id: string, opts: PaintChangeOptions = {}): Promise<PaintChangeResult> {
        return this.change(courseId, opts, doc => {
            const rules = doc.rules ?? [];
            if (rules.some(r => r.id === id)) {
                return { action: 'disable', id, next: { ...doc, rules: rules.map(r => r.id === id ? { ...r, enabled: false } : r) }, box: null, apply: [], replaced: false };
            }
            const s = (doc.strokes ?? []).find(x => x.id === id);
            if (!s) throw new NotFoundError(`No paint rule or stroke '${id}'`);
            return {
                action: 'disable', id,
                next: { ...doc, strokes: doc.strokes!.map(x => x.id === id ? { ...x, enabled: false } : x) }, box: strokeBox(s), apply: [], replaced: false,
            };
        });
    }

    /** Remove a stroke or rule by id. */
    remove(courseId: string, id: string, opts: PaintChangeOptions = {}): Promise<PaintChangeResult> {
        return this.change(courseId, opts, doc => {
            const s = (doc.strokes ?? []).find(x => x.id === id);
            if (s) return { action: 'remove', id, next: { ...doc, strokes: doc.strokes!.filter(x => x.id !== id) }, box: strokeBox(s), apply: [], replaced: false };
            if (!(doc.rules ?? []).some(r => r.id === id)) throw new NotFoundError(`No paint rule or stroke '${id}'`);
            return { action: 'remove', id, next: { ...doc, rules: doc.rules!.filter(r => r.id !== id) }, box: null, apply: [], replaced: false };
        });
    }

    // --- The change ---

    private change(courseId: string, opts: PaintChangeOptions, make: (doc: PaintDoc) => Change): Promise<PaintChangeResult> {
        const prev = this.queues.get(courseId) ?? Promise.resolve();
        const run = prev.then(() => this.changeNow(courseId, opts, make));
        const tail = run.catch(() => undefined);
        this.queues.set(courseId, tail);
        void tail.then(() => { if (this.queues.get(courseId) === tail) this.queues.delete(courseId); });
        return run;
    }

    private async changeNow(courseId: string, opts: PaintChangeOptions, make: (doc: PaintDoc) => Change): Promise<PaintChangeResult> {
        await this.courses.get(courseId);
        const dryRun = opts.dryRun === true;
        const docsDir = await this.docsDir(courseId);
        const file = path.join(docsDir, PAINT_FILE);
        const before = await this.read(file);
        const change = make(before ?? { format: PAINT_FORMAT, rules: [], strokes: [] });
        const warnings: string[] = [];
        const { dir: exportDir } = await this.exportSettings.settings(courseId);

        // 1-3: preview (and the engine's check of every rule, Unity or not)
        const preview = await this.preview(change, exportDir, warnings);

        const result: PaintChangeResult = {
            courseId, action: change.action, id: change.id, dryRun, saved: false, file,
            layer: { written: false, path: null, ops: null, note: dryRun ? 'dry run: nothing written' : '' },
            preview, sync: null, warnings,
        };
        if (dryRun) return result;

        // 4: persist
        await writeAtomic(file, paintJson(change.next));
        result.saved = true;
        try {
            result.layer = await this.writeLayer(courseId, docsDir);
        } catch (e) {
            // the engine refused the file after all: put the old one back
            if (before) await writeAtomic(file, paintJson(before));
            else await rm(file, { force: true });
            result.saved = false;
            throw e;
        }

        // 5: Blender takes over
        if (opts.sync) {
            if (!this.layerLive) warnings.push('sync: the paint layer is not live yet, so this sync does not paint');
            const job = await this.shaping.apply(courseId, { note: `paint ${change.action} ${change.id}` });
            result.sync = { jobId: job.id, status: job.status };
        }
        return result;
    }

    private async read(file: string): Promise<PaintDoc | null> {
        let text: string;
        try {
            text = await readFile(file, 'utf8');
        } catch {
            return null;
        }
        let doc: PaintDoc;
        try {
            doc = JSON.parse(text) as PaintDoc;
        } catch (e) {
            throw new PaintError(`${file}: not JSON (${(e as Error).message})`);
        }
        if (doc?.format !== PAINT_FORMAT) throw new PaintError(`${file}: format must be ${PAINT_FORMAT}`);
        return doc;
    }

    /** `gspro.py shaping-paint`: into the real layer folder when live, else into a temp file (the engine's check). */
    private async writeLayer(courseId: string, docsDir: string): Promise<PaintChangeResult['layer']> {
        const layersDir = await this.shaping.layersDir(courseId);
        const tmp = this.layerLive ? null : await mkdtemp(path.join(os.tmpdir(), 'paint-layer-'));
        const out = tmp ? path.join(tmp, PAINT_LAYER_FILE) : path.join(layersDir, PAINT_LAYER_FILE);
        try {
            if (!tmp) await ensureDir(layersDir);
            const args = [path.join(this.pipelineDir, 'gspro.py'), 'shaping-paint', '--course-dir', docsDir, '--out', out];
            const { code, stdout, stderr } = await this.runner(args, this.pipelineDir, { timeoutMs: PYTHON_TIMEOUT_MS });
            if (code !== 0) throw failure('Paint layer (gspro.py shaping-paint)', code, stdout, stderr);
            const ops = ((JSON.parse(await readFile(out, 'utf8')) as { ops?: unknown[] }).ops ?? []).length;
            return tmp
                ? { written: false, path: null, ops, note: `layer not live yet (PAINT_LAYER_LIVE): ${ops} op(s) checked, ${PAINT_LAYER_FILE} not written` }
                : { written: true, path: out, ops, note: `${ops} golfmap.paint op(s) in ${PAINT_LAYER_FILE}` };
        } finally {
            if (tmp) await rm(tmp, { recursive: true, force: true });
        }
    }

    /** The preview in the course's open Unity editor; the engine's check of the new paint.json either way. */
    private async preview(change: Change, exportDir: string, warnings: string[]): Promise<PaintPreviewReport> {
        const report: PaintPreviewReport = { status: 'skipped', note: null, within: null, meshes: 0, previewed: [], cleared: [], skipped: [] };
        let editor: UnityEditor | null = null;
        let seen: string[] = [];
        try {
            ({ editor, seen } = await editorForExportDir(this.unityBridge, exportDir));
        } catch (e) {
            seen = [(e as Error).message.split('\n')[0]!];
        }
        let within: Box3006 | null = change.box;
        if (editor) {
            within = within ?? await innerSquare(exportDir);
            if (!within) {
                editor = null;
                report.note = `no inner DEM sidecar in ${exportDir}: no frame for the preview`;
            }
        } else {
            report.note = `Unity closed: no open Unity editor imports from ${exportDir}${seen.length ? ` (${seen.join('; ')})` : ''}`;
        }
        // the bunker blends an edge rule reads lie up to its widthM beyond the meshes it paints
        const edge = Math.max(0, ...(change.next.rules ?? [])
            .filter(r => r.kind === 'edge' && r.enabled !== false).map(r => Number(r.widthM ?? 1.5)).filter(Number.isFinite));
        let meshes: unknown[] = [];
        if (editor && within) {
            report.within = edge ? growBox(within, edge) : within;
            try {
                const got = await editor.run('golfmap.paint.meshes', { within: report.within }, MESHES_SEC);
                meshes = Array.isArray(got?.meshes) ? got.meshes : [];
            } catch (e) {
                report.status = 'failed';
                report.note = `golfmap.paint.meshes: ${(e as Error).message.split('\n')[0]}`;
                editor = null;
            }
        }
        report.meshes = meshes.length;
        // Live layer: the FBX colours carry every rule and stroke as last synced, so only what this change adds goes on
        // top; what it takes away cannot be taken off them (the meshes go back to the FBX, the sync shows the rest).
        // Not live: the FBX colours carry no rule paint, so every enabled item goes on top.
        const live = this.layerLive;
        const takesAway = live && change.apply.length === 0;
        const out = await this.runPreview({
            folder: exportDir, paint: change.next, meshes: takesAway ? [] : meshes, ...(live ? { only: change.apply } : {}),
        });
        if (takesAway) {
            out.objects = [];
            out.unchanged = meshes.map(m => String((m as { object?: unknown }).object));
            warnings.push(`${change.id}: shows after the next sync (--sync); until then the meshes there are back to their FBX`);
        } else if (live) {
            out.unchanged = [];   // their previews may be other unsynced paint: kept
            if (change.replaced) warnings.push(`${change.id}: the old version's paint stays visible until the next sync`);
        }
        warnings.push(...out.warnings);
        if (!editor) {
            if (report.status === 'failed') warnings.push(`preview failed: ${report.note}`);
            else warnings.push(`preview skipped: ${report.note}`);
            return report;
        }
        try {
            if (out.objects.length) {
                const r = await editor.run('golfmap.paint.preview', { objects: out.objects }, PREVIEW_SEC);
                report.previewed = Array.isArray(r?.previewed) ? r.previewed.map(String) : [];
                report.skipped = Array.isArray(r?.skipped) ? r.skipped : [];
            }
            if (out.unchanged.length) {
                const r = await editor.run('golfmap.paint.clear', { objects: out.unchanged }, PREVIEW_SEC);
                report.cleared = Array.isArray(r?.cleared) ? r.cleared.map(String) : [];
            }
            report.status = 'shown';
        } catch (e) {
            report.status = 'failed';
            report.note = `golfmap.paint.preview: ${(e as Error).message.split('\n')[0]}`;
            warnings.push(`preview failed: ${report.note}`);
        }
        return report;
    }

    /** blender/tools/shape_paintpreview.py on an input file (the meshes are megabytes; no argv, no stdin pipe). */
    private async runPreview(input: { folder: string; paint: PaintDoc; meshes: unknown[]; only?: string[] }): Promise<PreviewOutput> {
        const tmp = await mkdtemp(path.join(os.tmpdir(), 'paint-preview-'));
        try {
            const inFile = path.join(tmp, 'in.json');
            const outFile = path.join(tmp, 'out.json');
            await writeFile(inFile, JSON.stringify(input));
            const { code, stdout, stderr } = await this.runner([PREVIEW_SCRIPT, '--in', inFile, '--out', outFile], this.pipelineDir, { timeoutMs: PYTHON_TIMEOUT_MS });
            if (code !== 0) {
                const detail = (stderr.trim() || stdout.trim() || `exit ${code}`).split('\n').slice(-3).join(' ').replace(/^error:\s*/, '');
                throw new PaintError(detail);
            }
            return JSON.parse(await readFile(outFile, 'utf8')) as PreviewOutput;
        } finally {
            await rm(tmp, { recursive: true, force: true });
        }
    }
}

/** The inner square (EPSG:3006) from the export folder's `<prefix>-inner-dem-<side>m.tif.json`; null without one. */
export async function innerSquare(exportDir: string): Promise<Box3006 | null> {
    let names: string[];
    try {
        names = await readdir(exportDir);
    } catch {
        return null;
    }
    const sidecar = names.filter(n => /-inner-dem-.*m\.tif\.json$/.test(n)).sort()[0];
    if (!sidecar) return null;
    try {
        const sq = (JSON.parse(await readFile(path.join(exportDir, sidecar), 'utf8')) as { square3006?: unknown }).square3006;
        return Array.isArray(sq) && sq.length === 4 && sq.every(isNum) ? sq as Box3006 : null;
    } catch {
        return null;
    }
}
