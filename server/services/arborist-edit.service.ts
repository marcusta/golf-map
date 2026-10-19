// The Arborist edit loop: one tree or bush that Arborist draws (an `arborist:` model) moved, resized,
// turned, deleted, added or made another model, seen in the running Arborist at once and saved, with
// no Unity round trip (docs/gspro/arborist.md, "The edit loop").
//
// Optimistic: the change is made live first, through the GolfMap mod in Arborist (`veg.edit`: the
// instance taken out of VSP's persistent storage and added again; drawn on the next frame), and then
// written where every later run reads it:
//
//   arboristdata.dat        the instance itself (`arborist.py edit`), so a reload or GSPro shows it
//   arboristdata.ids.json   the tree's drawn entry (item, x, z), so the next edit finds it
//   <prefix>-<terrain>-placements.json
//                           the placement, so the next `gspro:export arborist` draws it so
//   <prefix>-<terrain>-tree-edits.json
//                           the tree edit (the format golfmap.trees.edit writes), so the next plant
//                           in Unity places it so. Unity is never called.
//
// A tree is named by its tree id, as the point nearest to world x, z, or as what stands under the
// mouse (or at a point of the picture) in Arborist (`veg.pick`), or the one marked there with the P key
// (`veg.picker`, put up by the first edit after Arborist starts; `veg.picked`).
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { courseSlug, placementsExportFileName, statOrNull, treesExportFileName, type ExportRunner } from './gspro-export.service';
import { terrainsSquare, type ArboristCourse } from './arborist.service';

/** The trees package's items: the id of item `variant` follows from its name (pipeline/arborist.py tree_item). */
export const FAR_SUFFIX = ' (far)';
/** Arborist's own system in the player (the course's VSP also runs there): veg.edit / veg.pick look only in it. */
export const ARBORIST_SYSTEM = '/ArbVegetationStudioPro';
/** A placement and its instance are the same tree within this distance (Unity's 1 cm cell-edge nudge, rounding). */
export const SAME_TREE_M = 0.5;
/** `near` takes the nearest Arborist tree within this many metres. */
export const NEAR_MAX_M = 15;
export const TREE_EDITS_FORMAT = 'golfmap-tree-edits-v1';
const ADDED_PREFIX = 'manual:';
const SMALL_CALL_SEC = 30;
const EDIT_TIMEOUT_MS = 120_000;
const LOCK_WAIT_MS = 60_000;

type Vec3 = [number, number, number];
type Quat = [number, number, number, number];
type TerrainKind = 'inner' | 'outer';

/** The running Arborist's mod (unity/ArboristMod), or what stands in for it. */
export interface ArboristPlayer {
    call(command: string, args?: Record<string, unknown>, timeoutSec?: number): Promise<any>;
}

export interface ArboristEditDeps {
    dataDir: string;
    pipelineDir: string;
    /** `<root>/<course slug>/` holds the course's models.json and arborist-species.json. */
    courseDocsRoot: string;
    runner: ExportRunner;
    /** The mod in the running Arborist; null when nothing answers (the files are still written). */
    player(): Promise<ArboristPlayer | null>;
    /** ResetVSPro + LoadData and the wait, for a change Arborist cannot make live (an item it has not loaded). */
    reload?(player: ArboristPlayer, scene: string): Promise<string>;
}

/** Which tree: by tree id, nearest to world x, z, what stands at a point of Arborist's picture (or under the mouse), or the one marked there with the P key. */
export type TreeTarget =
    | { id: string }
    | { near: [number, number] }
    | { pick: { u: number; v: number } | 'mouse' | 'marked' };

export type TreeChange =
    | { op: 'show' }
    | { op: 'move'; to?: [number, number]; by?: [number, number]; yM?: number }
    | { op: 'resize'; factor?: number; heightM?: number; crownWidthM?: number }
    | { op: 'rotate'; by?: number; yaw?: number }
    | { op: 'delete' }
    | { op: 'swap'; model: string }
    | { op: 'add'; model: string; at: [number, number]; heightM?: number; crownWidthM?: number; yaw?: number; yM?: number };

/** One planted tree as Unity's planter wrote it (golfmap-placements-v1); world metres. */
export interface Placement {
    id: string;
    model: string;
    species: string;
    renderer: string;
    x: number; y: number; z: number;
    rotationY: number;
    leanDeg?: number;
    leanDirectionY?: number;
    scale: number;
    widthScale?: number;
    q: Quat;
    heightM?: number;
    crownWidthM?: number;
}

/** A model of the course's library (models.json, golfmap-models-v1). */
export interface TreeModel {
    id: string;
    species: string;
    renderer: string;
    heightM: number;
    crownWidthM: number;
    kind?: string;
    form?: string;
    look?: Record<string, string | number | boolean>;
}

/** A record of the tree-edits file, as Unity's GolfMapTreeEdit (terrain-local metres). */
export interface TreeEditRecord {
    id: string;
    op: 'modify' | 'delete' | 'add';
    ox: number; oz: number;
    x: number; z: number; h: number; r: number;
    k: number;
    bush: boolean;
    species: string;
    guid: string;
    model: string;
    sized: boolean;
    rotation: number;
    rotationSet: boolean;
    dy: number;
    /** Absolute world y, used by Unity instead of ground + dy when `ySet` (`--y`: a lily on the water; Unity's ground is the pond bed). */
    y?: number;
    ySet?: boolean;
}

export interface TreeView {
    id: string;
    model: string;
    /** The trees package's item it is drawn as (with " (far)" for a billboard-only one). */
    item: string;
    terrain: TerrainKind;
    position: Vec3;
    rotationY: number;
    heightM: number;
    crownWidthM: number;
}

export interface EditResult {
    op: TreeChange['op'];
    dryRun: boolean;
    /** The tree before; null for an add. */
    before: TreeView | null;
    /** The tree after; null for a delete. */
    after: TreeView | null;
    /** How the tree was found (pick / near), one line. */
    found: string | null;
    /** The live change: done in `ms` (the mod's own time) and `seconds` (the round trip), or why not. */
    live: { done: boolean; ms?: number; seconds: number; note: string };
    /** The files written, each a line; empty for a dry run or show. */
    saved: string[];
    /** Seconds the files took. */
    saveSeconds: number;
    /** The reload a new item needed, when one ran. */
    reload: string | null;
    warnings: string[];
}

// ───────────────────────────── model ids, items ─────────────────────────────

/** RFC 4122 version 5 (SHA-1) id of `name` in the URL namespace, as Python's uuid.uuid5(uuid.NAMESPACE_URL, name). */
export function uuid5(name: string): string {
    const ns = Buffer.from('6ba7b8119dad11d180b400c04fd430c8', 'hex');
    const hash = createHash('sha1').update(Buffer.concat([ns, Buffer.from(name, 'utf8')])).digest();
    hash[6] = (hash[6]! & 0x0f) | 0x50;
    hash[8] = (hash[8]! & 0x3f) | 0x80;
    const h = hash.subarray(0, 16).toString('hex');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** The VegetationItemID of a trees-package item by its name ("<variant>" or "<variant> (far)"). */
export function treeItemId(item: string): string {
    return item.endsWith(FAR_SUFFIX)
        ? uuid5(`golfmap-trees-far/${item.slice(0, -FAR_SUFFIX.length)}`)
        : uuid5(`golfmap-trees/${item}`);
}

/** A value as Python's f"{v}" writes it (arborist.py names an item variant by its model's look). */
function pyText(v: string | number | boolean): string {
    if (typeof v === 'boolean') return v ? 'True' : 'False';
    return String(v);
}

/** The item a model is drawn as: its label, and its look in brackets (arborist.py trees: `variant`). */
export function modelItem(model: TreeModel): string {
    const label = arboristLabel(model.id) ?? model.id;
    const look = Object.entries(model.look ?? {}).map(([k, v]) => `${k}=${pyText(v)}`).join(',');
    return look ? `${label} [${look}]` : label;
}

/** 'arborist:<label>' -> the label; anything else -> null. */
export function arboristLabel(model: string): string | null {
    const at = model.indexOf(':');
    return at > 0 && model.slice(0, at) === 'arborist' && at < model.length - 1 ? model.slice(at + 1) : null;
}

// ───────────────────────────── the change itself ─────────────────────────────

const rad = (deg: number) => deg * Math.PI / 180;
const norm360 = (deg: number) => ((deg % 360) + 360) % 360;
const r3 = (v: number) => Math.round(v * 1000) / 1000;

/** a * b (Hamilton): b first, then a. */
function qmul(a: Quat, b: Quat): Quat {
    const [ax, ay, az, aw] = a, [bx, by, bz, bw] = b;
    return [
        aw * bx + ax * bw + ay * bz - az * by,
        aw * by - ax * bz + ay * bw + az * bx,
        aw * bz + ax * by - ay * bx + az * bw,
        aw * bw - ax * bx - ay * by - az * bz,
    ];
}

const yawQ = (deg: number): Quat => [0, Math.sin(rad(deg) / 2), 0, Math.cos(rad(deg) / 2)];

/** A placement's turn: Unity's Euler(0, yaw) * AngleAxis(lean, Euler(0, leanDirection) * right) (GolfMapTreePlanter.Orientation). */
export function orientation(yaw: number, leanDeg = 0, leanDirectionY = 0): Quat {
    const axis: Vec3 = [Math.cos(rad(leanDirectionY)), 0, -Math.sin(rad(leanDirectionY))];
    const half = rad(leanDeg) / 2;
    const lean: Quat = [axis[0] * Math.sin(half), 0, axis[2] * Math.sin(half), Math.cos(half)];
    return qmul(yawQ(yaw), lean);
}

/**
 * The placement as it is after `change` (null = deleted). `ground` is the ground height at the new
 * x, z (a move or add); without it a moved tree keeps its height. `id` names an added tree.
 */
export function changedPlacement(p: Placement | null, change: TreeChange, models: Map<string, TreeModel>, ground: number | null, id?: string): Placement | null {
    const modelOf = (m: string) => {
        const found = models.get(m);
        if (!found) throw new Error(`the model library has no ${m} (bun run models -- add <course> ${m} --species <s>)`);
        if (!(found.heightM > 0) || !(found.crownWidthM > 0)) throw new Error(`model ${m} has no size in the library`);
        return found;
    };
    const sized = (q: Placement, model: TreeModel): Placement => ({
        ...q,
        heightM: Math.round(model.heightM * q.scale * 100) / 100,
        crownWidthM: Math.round(model.crownWidthM * (q.widthScale ?? q.scale) * 100) / 100,
    });
    if (change.op === 'add') {
        const model = modelOf(change.model);
        if (!arboristLabel(model.id)) throw new Error(`${model.id} is not an Arborist model: Unity's VSP draws it (golfmap.trees.edit)`);
        if (ground === null) throw new Error('an added tree needs the ground height from the running Arborist (its mod\'s `ground`)');
        const scale = (change.heightM ?? model.heightM) / model.heightM;
        const widthScale = change.crownWidthM ? change.crownWidthM / model.crownWidthM : scale;
        const yaw = norm360(change.yaw ?? (parseInt(createHash('sha1').update(id ?? '').digest('hex').slice(0, 8), 16) % 360));
        return sized({
            id: id ?? `${ADDED_PREFIX}${randomUUID().replace(/-/g, '').slice(0, 12)}`, model: model.id, species: model.species, renderer: 'arborist',
            x: r3(change.at[0]), y: r3(ground), z: r3(change.at[1]), rotationY: r3(yaw), leanDeg: 0, leanDirectionY: 0,
            scale, widthScale, q: yawQ(yaw),
        }, model);
    }
    if (!p) throw new Error(`${change.op} needs a tree`);
    if (change.op === 'show') return p;
    if (change.op === 'delete') return null;
    const model = modelOf(p.model);
    if (change.op === 'move') {
        const [x, z] = change.to ?? [p.x + (change.by?.[0] ?? 0), p.z + (change.by?.[1] ?? 0)];
        if (!change.to && !change.by) throw new Error('move needs where to (to: [x, z]) or by how much (by: [dx, dz])');
        return { ...p, x: r3(x), z: r3(z), y: ground === null ? p.y : r3(ground) };
    }
    if (change.op === 'resize') {
        let scale = p.scale, widthScale = p.widthScale ?? p.scale;
        if (change.factor !== undefined) {
            if (!(change.factor > 0)) throw new Error('resize needs a factor above 0');
            scale *= change.factor; widthScale *= change.factor;
        }
        if (change.heightM !== undefined) {
            if (!(change.heightM > 0)) throw new Error('heightM must be above 0');
            const f = change.heightM / model.heightM / scale;
            scale *= f;
            if (change.crownWidthM === undefined) widthScale *= f;   // the tree's own proportions
        }
        if (change.crownWidthM !== undefined) {
            if (!(change.crownWidthM > 0)) throw new Error('crownWidthM must be above 0');
            widthScale = change.crownWidthM / model.crownWidthM;
        }
        if (change.factor === undefined && change.heightM === undefined && change.crownWidthM === undefined) throw new Error('resize needs a factor, heightM or crownWidthM');
        return sized({ ...p, scale: Math.round(scale * 1e5) / 1e5, widthScale: Math.round(widthScale * 1e5) / 1e5 }, model);
    }
    if (change.op === 'rotate') {
        if (change.by === undefined && change.yaw === undefined) throw new Error('rotate needs by (degrees) or yaw (degrees)');
        const delta = change.by ?? (change.yaw! - p.rotationY);
        const q = qmul(yawQ(delta), p.q).map(v => Math.round(v * 1e6) / 1e6) as Quat;
        return { ...p, rotationY: r3(norm360(p.rotationY + delta)), q };
    }
    // swap: another model at the same height, in its own proportions (as golfmap.trees.edit with a model and no crown width)
    const other = modelOf(change.model);
    if (!arboristLabel(other.id)) throw new Error(`${other.id} is not an Arborist model: Unity's VSP draws it (golfmap.trees.edit)`);
    const scale = Math.round((p.heightM ?? model.heightM * p.scale) / other.heightM * 1e5) / 1e5;
    return sized({ ...p, model: other.id, species: other.species, scale, widthScale: scale }, other);
}

/**
 * The tree-edits record after the change, as Unity's golfmap.trees.edit leaves it (null = no record:
 * an added tree deleted again). Positions in terrain-local metres (world - the terrain's position).
 */
export function editRecord(
    existing: TreeEditRecord | null, survey: { x: number; z: number; k: number; bush: boolean } | null,
    after: Placement | null, before: Placement | null, origin: { x: number; z: number }, model: TreeModel | null, turned: boolean,
    absoluteY?: number | null,
): TreeEditRecord | null {
    const id = (after ?? before)!.id;
    if (!after) {
        if (existing?.op === 'add') return null;
        const base = existing ?? blank(id, 'modify', survey?.x ?? before!.x - origin.x, survey?.z ?? before!.z - origin.z, survey);
        return { ...base, op: 'delete' };
    }
    const kind = model?.kind === 'broadleaf' ? 0 : model?.kind === 'conifer' ? 1 : 2;
    const x = r3(after.x - origin.x), z = r3(after.z - origin.z);
    const found = existing ?? (before ? blank(id, 'modify', survey?.x ?? before.x - origin.x, survey?.z ?? before.z - origin.z, survey) : blank(id, 'add', x, z, null));
    // absoluteY: a number sets the height (`--y`), null drops it (moved onto the ground again), undefined keeps it.
    const { y: _y, ySet: _ySet, ...unset } = found;
    const base = absoluteY === null ? unset : typeof absoluteY === 'number' ? { ...found, y: r3(absoluteY), ySet: true } : found;
    return {
        ...base,
        op: base.op === 'add' ? 'add' : 'modify',
        x, z, h: after.heightM!, r: r3(after.crownWidthM! / 2), k: kind,
        bush: base.op === 'add' ? model?.form === 'shrub' : base.bush,
        species: after.species, guid: '', model: after.model, sized: true,
        ...(turned || base.rotationSet ? { rotation: after.rotationY, rotationSet: true } : {}),
    };
}

function blank(id: string, op: TreeEditRecord['op'], ox: number, oz: number, survey: { k: number; bush: boolean } | null): TreeEditRecord {
    return { id, op, ox: r3(ox), oz: r3(oz), x: 0, z: 0, h: 0, r: 0, k: survey?.k ?? 0, bush: survey?.bush ?? false, species: '', guid: '', model: '', sized: false, rotation: 0, rotationSet: false, dy: 0 };
}

// ───────────────────────────── the service ─────────────────────────────

interface PlacementsDoc { file: string; terrain: TerrainKind; header: Record<string, unknown>; placements: Placement[] }
interface IdsDoc { format: string; comment?: string; drawn: { id: string | null; model: string; item: string; x: number; z: number }[]; leftOut: { id: string | null; model: string; reason: string }[] }

interface Context {
    course: ArboristCourse;
    slug: string;
    dat: string;
    idsFile: string;
    ids: IdsDoc;
    placements: PlacementsDoc[];
    models: Map<string, TreeModel>;
    square: [number, number, number, number];
}

export class ArboristEditService {
    /** One edit at a time per process; the lock file keeps two processes apart. */
    private queue: Promise<unknown> = Promise.resolve();

    constructor(private readonly deps: ArboristEditDeps) {}

    private docs(course: ArboristCourse, file: string): string {
        return path.join(this.deps.courseDocsRoot, courseSlug(course.name), file);
    }

    /** Make the change live in Arborist, then save it (dryRun: only say what it would do). */
    async edit(course: ArboristCourse, target: TreeTarget | null, change: TreeChange, opts: { dryRun?: boolean } = {}): Promise<EditResult> {
        const run = this.queue.then(() => this.editNow(course, target, change, !!opts.dryRun));
        this.queue = run.catch(() => undefined);
        return run;
    }

    private async editNow(course: ArboristCourse, target: TreeTarget | null, change: TreeChange, dryRun: boolean): Promise<EditResult> {
        const ctx = await this.context(course);
        const player = await this.deps.player();
        if (player) await ensurePicker(player);
        const warnings: string[] = [];
        let found: string | null = null;
        let before: Placement | null = null;
        let item: string | null = null;
        if (change.op === 'add') {
            if (target) throw new Error('add takes no tree: it makes a new one (at: [x, z])');
        } else {
            if (!target) throw new Error(`${change.op} needs a tree: its id, near: [x, z], or pick`);
            ({ placement: before, item, found } = await this.resolve(ctx, target, player));
        }

        // The ground under a moved or new tree, from Arborist's own colliders, unless `yM` says where (a water lily floats on the water surface).
        let ground: number | null = null;
        if ((change.op === 'move' || change.op === 'add') && change.yM !== undefined) {
            ground = change.yM;
        } else if ((change.op === 'move' || change.op === 'add') && player) {
            const [x, z] = change.op === 'add' ? change.at : change.to ?? [before!.x + (change.by?.[0] ?? 0), before!.z + (change.by?.[1] ?? 0)];
            const hit = await player.call('ground', { x, z }, SMALL_CALL_SEC);
            if (hit?.hit) ground = Number(hit.y);
            else warnings.push(`no ground under (${x}, ${z}) in Arborist: the tree keeps its height`);
        } else if (change.op === 'move') {
            warnings.push('Arborist is not running: the moved tree keeps its old ground height');
        }
        const after = changedPlacement(before, change, ctx.models, ground);
        const afterItem = after ? (after.model === before?.model ? item! : modelItem(ctx.models.get(after.model)!) + (item?.endsWith(FAR_SUFFIX) ? FAR_SUFFIX : '')) : null;
        const result: EditResult = {
            op: change.op, dryRun, found,
            before: before ? view(before, item!, terrainOf(ctx, before.id)) : null,
            after: after ? view(after, afterItem!, before ? terrainOf(ctx, before.id) : 'inner') : null,
            live: { done: false, seconds: 0, note: '' }, saved: [], saveSeconds: 0, reload: null, warnings,
        };
        if (change.op === 'show' || dryRun) {
            result.live.note = change.op === 'show' ? 'nothing to change' : 'dry run: nothing changed';
            return result;
        }

        // 1. Live, first: Arborist shows it on the next frame.
        let needsReload = false;
        const t0 = Date.now();
        if (!player) result.live.note = 'Arborist is not running (or its mod does not answer): saved only';
        else {
            const args: Record<string, unknown> = { system: ARBORIST_SYSTEM };
            if (before) {
                args.item = treeItemId(item!);
                args.at = [before.x, before.y, before.z];
            } else args.item = treeItemId(afterItem!);
            if (after) {
                args.position = [after.x, after.y, after.z];
                args.scale = [after.widthScale ?? after.scale, after.scale, after.widthScale ?? after.scale];
                args.rotation = after.q;
                if (before && afterItem !== item) args.as = treeItemId(afterItem!);
            } else args.delete = true;
            try {
                const r = await player.call('veg.edit', args, SMALL_CALL_SEC);
                result.live = { done: true, ms: r?.ms, seconds: secondsSince(t0), note: `live in Arborist in ${r?.ms ?? '?'} ms` };
            } catch (e) {
                const why = (e as Error).message.split('\n')[0]!;
                needsReload = /needs the file reloaded/.test(why);
                result.live = { done: false, seconds: secondsSince(t0), note: needsReload ? `Arborist has not loaded ${afterItem} yet: reloading after the save` : `not live: ${why}` };
            }
        }

        // 2. Saved: the .dat, the ids, the placements, the tree edits.
        const t1 = Date.now();
        await this.locked(ctx.dat, async () => {
            // An added tree's yaw is chosen here, so Unity must take it too (it would hash one of its own).
            result.saved.push(...await this.save(ctx, before, after, item, afterItem, change.op === 'rotate' || change.op === 'add',
                change.op === 'move' || change.op === 'add' ? change.yM ?? null : undefined));
        });
        result.saveSeconds = secondsSince(t1);

        if (needsReload && player) {
            if (this.deps.reload) result.reload = await this.deps.reload(player, path.basename(course.courseDir!));
            else warnings.push('Arborist needs a reload to show it (bun run arborist -- <course> --no-... or ResetVSPro + LoadData)');
        }
        return result;
    }

    /** Everything an edit reads, checked. */
    private async context(course: ArboristCourse): Promise<Context> {
        if (!course.courseDir) throw new Error('the course has no GSPro course folder set (export panel), so no arboristdata.dat to edit');
        const slug = courseSlug(course.name);
        const dat = path.join(course.courseDir, 'arboristdata.dat');
        if (!await statOrNull(dat)) throw new Error(`no ${dat}: write the course's Arborist file first (bun run arborist -- <course>)`);
        const idsFile = path.join(course.courseDir, 'arboristdata.ids.json');
        if (!await statOrNull(idsFile)) throw new Error(`no ${idsFile}: the trees have not been written with their ids yet (bun run gspro:export -- <course> arborist)`);
        const ids = JSON.parse(await readFile(idsFile, 'utf8')) as IdsDoc;
        const placements: PlacementsDoc[] = [];
        for (const terrain of ['inner', 'outer'] as const) {
            const file = path.join(course.exportDir, placementsExportFileName(course.name, terrain));
            if (!await statOrNull(file)) continue;
            const doc = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown> & { placements: Placement[] };
            if (doc.format !== 'golfmap-placements-v1') throw new Error(`${file}: not a golfmap-placements-v1 file`);
            const { placements: list, ...header } = doc;
            placements.push({ file, terrain, header, placements: list });
        }
        if (!placements.length) throw new Error(`no placements in ${course.exportDir}: plant the trees in Unity once (it writes <prefix>-inner-placements.json)`);
        const modelsFile = this.docs(course, 'models.json');
        if (!await statOrNull(modelsFile)) throw new Error(`no model library at ${modelsFile}`);
        const models = new Map((JSON.parse(await readFile(modelsFile, 'utf8')).models as TreeModel[]).map(m => [m.id, m]));
        const square = await terrainsSquare(course.exportDir, slug);
        if (!square) throw new Error(`no inner heightmap sidecar in ${course.exportDir}: the terrains square is unknown`);
        return { course, slug, dat, idsFile, ids, placements, models, square };
    }

    /** The placement a target names, and the item it is drawn as. */
    private async resolve(ctx: Context, target: TreeTarget, player: ArboristPlayer | null): Promise<{ placement: Placement; item: string; found: string | null }> {
        const drawn = new Map(ctx.ids.drawn.filter(d => d.id).map(d => [d.id!, d]));
        const arborist = ctx.placements.flatMap(d => d.placements).filter(p => arboristLabel(p.model));
        const checked = (p: Placement, found: string | null) => {
            if (!arboristLabel(p.model)) throw new Error(`tree ${p.id} is ${p.model}: Unity's VSP draws it, so edit it there (golfmap.trees.edit)`);
            const d = drawn.get(p.id);
            if (!d) {
                const left = ctx.ids.leftOut.find(l => l.id === p.id);
                throw new Error(`tree ${p.id} (${p.model}) is not drawn by Arborist${left ? `: ${left.reason}` : ' (not in arboristdata.ids.json; write the trees again)'}`);
            }
            return { placement: p, item: d.item, found };
        };
        if ('id' in target) {
            const p = ctx.placements.flatMap(d => d.placements).find(q => q.id === target.id);
            if (!p) throw new Error(`no tree ${target.id} in the placements (${ctx.placements.map(d => path.basename(d.file)).join(', ')})`);
            return checked(p, null);
        }
        if ('near' in target) {
            const [x, z] = target.near;
            let best: Placement | null = null, bestD = Infinity;
            for (const p of arborist) {
                if (!drawn.has(p.id)) continue;
                const d = Math.hypot(p.x - x, p.z - z);
                if (d < bestD) { best = p; bestD = d; }
            }
            if (!best || bestD > NEAR_MAX_M) throw new Error(`no tree Arborist draws within ${NEAR_MAX_M} m of (${x}, ${z})`);
            return checked(best, `nearest to (${x}, ${z}): ${bestD.toFixed(1)} m away`);
        }
        if (!player) throw new Error('pick needs the running Arborist (its GolfMap mod); name the tree by id or near: [x, z] instead');
        type Hit = { item: string; itemId: string; position: Vec3; distance: number };
        let picked: { instances: Hit[] };
        let where: string;
        if (target.pick === 'marked') {
            const r = await player.call('veg.picked', {}, SMALL_CALL_SEC) as { marked: (Hit & { when: string }) | null };
            if (!r?.marked) throw new Error('nothing is marked in Arborist: point at the tree or bush there and press P');
            picked = { instances: [r.marked] };
            where = `marked with P at ${r.marked.when}`;
        } else {
            const at = target.pick === 'mouse' ? { mouse: true } : { mouse: false, u: target.pick.u, v: target.pick.v };
            picked = await player.call('veg.pick', { ...at, system: ARBORIST_SYSTEM, limit: 8 }, SMALL_CALL_SEC);
            where = target.pick === 'mouse' ? 'under the mouse' : `at (${target.pick.u}, ${target.pick.v}) of the picture`;
        }
        for (const hit of picked.instances ?? []) {
            const p = arborist.find(q => drawn.has(q.id) && treeItemId(drawn.get(q.id)!.item) === hit.itemId
                && Math.hypot(q.x - hit.position[0], q.z - hit.position[2]) <= SAME_TREE_M);
            if (p) return checked(p, `${where}: ${hit.item}, ${hit.distance} m from the camera`);
        }
        const seen = (picked.instances ?? []).map(h => h.item).slice(0, 3).join(', ');
        throw new Error(`no tree of an Arborist model ${where}${seen ? ` (there: ${seen} - lower vegetation or the course's own trees)` : ''}; point at its stem and try again`);
    }

    /** The four files, in order; each line says what was written. */
    private async save(ctx: Context, before: Placement | null, after: Placement | null, item: string | null, afterItem: string | null, turned: boolean, absoluteY?: number | null): Promise<string[]> {
        const lines: string[] = [];
        const terrain = before ? terrainOf(ctx, before.id) : 'inner';

        // The .dat: arborist.py edit.
        const op: Record<string, unknown> = { item: treeItemId(item ?? afterItem!) };
        if (before) op.at = [before.x, before.z];
        if (after) {
            op.position = [after.x, after.y, after.z];
            op.scale = [after.widthScale ?? after.scale, after.scale, after.widthScale ?? after.scale];
            op.rotation = after.q;
            if (afterItem !== item || !before) {
                if (before) op.as = treeItemId(afterItem!);
                const model = ctx.models.get(after.model)!;
                op.newItem = { label: arboristLabel(model.id), variant: afterItem!.replace(FAR_SUFFIX, ''), far: afterItem!.endsWith(FAR_SUFFIX), look: model.look ?? {} };
            }
        } else op.delete = true;
        const tmp = await mkdtemp(path.join(os.tmpdir(), 'arborist-edit-'));
        try {
            const opsFile = path.join(tmp, 'ops.json');
            await writeFile(opsFile, JSON.stringify({ ops: [op] }));
            const key = process.env.GOLFMAP_ARBORIST_KEY ?? path.join(this.deps.dataDir, 'arborist-wrapper.key');
            const args = [path.join(this.deps.pipelineDir, 'arborist.py'), 'edit', '--dat', ctx.dat, '--ops', opsFile,
                '--terrains-square', ...ctx.square.map(String), '--key-file', key,
                '--library', path.join(this.deps.dataDir, 'arborist', 'GolfMap library.biome'), '--species', this.docs(ctx.course, 'arborist-species.json')];
            const { code, stdout, stderr } = await this.deps.runner(args, this.deps.pipelineDir, { timeoutMs: EDIT_TIMEOUT_MS });
            if (code !== 0) {
                const last = (stderr.trim() || stdout.trim() || `exit ${code}`).split('\n').filter(l => l.trim()).at(-1)!.trim();
                throw new Error(`arboristdata.dat not changed: ${last}`);
            }
            const done = JSON.parse(stdout.trim().split('\n').at(-1)!) as { newItems: string[] };
            lines.push(`${ctx.dat}${done.newItems.length ? ` (new item ${done.newItems.join(', ')})` : ''}`);
        } finally {
            await rm(tmp, { recursive: true, force: true });
        }

        // The ids: the tree's drawn entry.
        const id = (after ?? before)!.id;
        const at = ctx.ids.drawn.findIndex(d => d.id === id);
        if (after) {
            const entry = { id, model: after.model, item: afterItem!, x: r3(after.x), z: r3(after.z) };
            if (at >= 0) ctx.ids.drawn[at] = entry; else ctx.ids.drawn.push(entry);
        } else if (at >= 0) {
            ctx.ids.drawn.splice(at, 1);
            ctx.ids.leftOut.push({ id, model: before!.model, reason: 'deleted by hand (tree edit)' });
        }
        await writeAtomic(ctx.idsFile, JSON.stringify(ctx.ids));
        lines.push(ctx.idsFile);

        // The placements: what the next `gspro:export arborist` draws.
        const doc = ctx.placements.find(d => d.terrain === terrain) ?? ctx.placements[0]!;
        const i = doc.placements.findIndex(p => p.id === id);
        if (after) { if (i >= 0) doc.placements[i] = after; else doc.placements.push(after); }
        else if (i >= 0) doc.placements.splice(i, 1);
        await writeAtomic(doc.file, placementsText(doc));
        lines.push(doc.file);

        // The tree edit: what the next plant in Unity places.
        const editsFile = path.join(ctx.course.exportDir, treeEditsFileName(ctx.course.name, doc.terrain));
        const edits = await readEdits(editsFile, treesExportFileName(ctx.course.name, doc.terrain));
        const survey = await surveyTree(path.join(ctx.course.exportDir, treesExportFileName(ctx.course.name, doc.terrain)), id);
        const origin = await terrainOrigin(ctx.course.exportDir, ctx.slug, doc.terrain);
        const existing = edits.edits.find(e => e.id === id) ?? null;
        const record = editRecord(existing, survey, after, before, origin, after ? ctx.models.get(after.model) ?? null : null, turned, absoluteY);
        const where = edits.edits.findIndex(e => e.id === id);
        if (record) { if (where >= 0) edits.edits[where] = record; else edits.edits.push(record); }
        else if (where >= 0) edits.edits.splice(where, 1);
        await writeAtomic(editsFile, JSON.stringify(edits, null, 4));
        lines.push(`${editsFile} (${record ? `${record.op} ${id}` : `${id}'s record dropped`})`);
        return lines;
    }

    /** `body` while holding <file>.edit.lock (another process editing the same course waits). */
    private async locked<T>(file: string, body: () => Promise<T>): Promise<T> {
        const lock = `${file}.edit.lock`;
        const t0 = Date.now();
        for (;;) {
            try {
                const handle = await open(lock, 'wx');
                await handle.writeFile(String(process.pid));
                await handle.close();
                break;
            } catch (e) {
                if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
                const age = Date.now() - ((await statOrNull(lock))?.mtimeMs ?? Date.now());
                if (age > LOCK_WAIT_MS) { await rm(lock, { force: true }); continue; }   // left by a run that died
                if (Date.now() - t0 > LOCK_WAIT_MS) throw new Error(`another edit holds ${lock}`);
                await Bun.sleep(100);
            }
        }
        try {
            return await body();
        } finally {
            await rm(lock, { force: true });
        }
    }
}

/** The P key in Arborist (veg.picker), put up when it is not (a fresh start, a commands reload); a mod without it is left be. */
async function ensurePicker(player: ArboristPlayer): Promise<void> {
    try {
        const r = await player.call('veg.picked', {}, SMALL_CALL_SEC);
        if (!r?.picker) await player.call('veg.picker', { system: ARBORIST_SYSTEM }, SMALL_CALL_SEC);
    } catch {
        // an older mod build: no picker, the rest still works
    }
}

// ───────────────────────────── files ─────────────────────────────

/** `Vreta`, inner -> `vreta-inner-tree-edits.json` (golfmap-tree-edits-v1, beside the trees export). */
export function treeEditsFileName(courseName: string, kind: TerrainKind): string {
    return `${courseSlug(courseName)}-${kind}-tree-edits.json`;
}

async function readEdits(file: string, trees: string): Promise<{ format: string; trees: string; edits: TreeEditRecord[] }> {
    if (!await statOrNull(file)) return { format: TREE_EDITS_FORMAT, trees, edits: [] };
    const doc = JSON.parse((await readFile(file, 'utf8')).replace(/^﻿/, ''));
    if (doc.format !== TREE_EDITS_FORMAT) throw new Error(`${file}: not a ${TREE_EDITS_FORMAT} file`);
    return { format: doc.format, trees: doc.trees || trees, edits: doc.edits ?? [] };
}

/** The survey's tree (unity-trees-v1, terrain-local metres), for a new record's original position and kind. */
async function surveyTree(file: string, id: string): Promise<{ x: number; z: number; k: number; bush: boolean } | null> {
    if (!await statOrNull(file)) return null;
    const doc = JSON.parse(await readFile(file, 'utf8')) as { trees: { id: string; x: number; z: number; k: number; bush?: boolean }[] };
    const t = doc.trees.find(q => q.id === id);
    return t ? { x: t.x, z: t.z, k: t.k, bush: !!t.bush } : null;
}

/** The terrain's Unity position (its heightmap sidecar's unity.position): world = local + this. */
async function terrainOrigin(exportDir: string, slug: string, kind: TerrainKind): Promise<{ x: number; z: number }> {
    let newest: { name: string; t: number } | null = null;
    for (const n of await readdir(exportDir)) {
        if (!n.startsWith(`${slug}-${kind}-dem-`) || !n.endsWith('m.tif.json')) continue;
        const t = (await stat(path.join(exportDir, n))).mtimeMs;
        if (!newest || t > newest.t) newest = { name: n, t };
    }
    if (!newest) return { x: 0, z: 0 };
    const sidecar = JSON.parse(await readFile(path.join(exportDir, newest.name), 'utf8')) as { unity?: { position?: { x?: number; z?: number } } };
    return { x: sidecar.unity?.position?.x ?? 0, z: sidecar.unity?.position?.z ?? 0 };
}

/** A placements file as Unity's planter writes it: the header, then one placement per line. */
function placementsText(doc: PlacementsDoc): string {
    const head = JSON.stringify(doc.header);
    return `${head.slice(0, -1)},"placements":[\n${doc.placements.map(p => JSON.stringify(p)).join(',\n')}]}`;
}

async function writeAtomic(file: string, text: string): Promise<void> {
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, text, 'utf8');
    await rename(tmp, file);
}

function terrainOf(ctx: Context, id: string): TerrainKind {
    return ctx.placements.find(d => d.placements.some(p => p.id === id))?.terrain ?? 'inner';
}

function view(p: Placement, item: string, terrain: TerrainKind): TreeView {
    return { id: p.id, model: p.model, item, terrain, position: [p.x, p.y, p.z], rotationY: p.rotationY, heightM: p.heightM ?? 0, crownWidthM: p.crownWidthM ?? 0 };
}

const secondsSince = (t0: number) => Math.round((Date.now() - t0) / 10) / 100;
