// The Arborist edit loop from the command line: one tree or bush that Arborist draws (an
// `arborist:` model) changed in the running Arborist at once and saved, with no Unity round trip
// (server/services/arborist-edit.service.ts, docs/gspro/arborist.md "The edit loop").
//
//   bun run arborist -- edit <course> <op> [value] <tree> [options] [--dry-run] [--json]
//
// <tree> (every op but add):
//   --id <tree id>          as the placements and arboristdata.ids.json name it
//   --near <x,z>            the nearest tree Arborist draws to world x, z (within 15 m)
//   --pick [<u,v>]          what stands under the mouse in Arborist, or at viewport u, v (0.5,0.5 = the middle)
//   --picked                the one marked in Arborist with the P key (point at it there, press P)
//
// <op>:
//   show                    print the tree, change nothing
//   move --to <x,z> | --by <dx,dz> [--y <m>]   world metres (x east, z north); the ground height from Arborist, or --y (absolute world y)
//   resize <factor> | --height <m> [--width <m>]
//   rotate <degrees> | --yaw <degrees>    turn by, or to a heading
//   delete
//   swap <model>            another model, the same height (arborist:<label> or the label)
//   add <model> --at <x,z> [--height <m>] [--width <m>] [--yaw <degrees>] [--y <m>]   --y: absolute world y instead of the ground (a lily on the water)
import {
    ArboristEditService, type ArboristPlayer, type EditResult, type TreeChange, type TreeTarget, type TreeView,
} from '../server/services/arborist-edit.service';
import { defaultRunner } from '../server/services/gspro-export.service';
import { openCourse, realDeps, reloadInArborist, DEFAULT_WAIT_SEC } from './arborist';
import { player as playerBridge } from '../unity/ArboristMod/call';
import { run as bridgeRun } from '../unity/mcp/bridge';

const OPS = ['show', 'move', 'resize', 'rotate', 'delete', 'swap', 'add'] as const;

export function editUsage(): string {
    return [
        'usage: bun run arborist -- edit <course> <op> [value] (--id <id> | --near <x,z> | --pick [<u,v>] | --picked) [options] [--dry-run] [--json]',
        '',
        '  show                                  the tree, nothing changed',
        '  move --to <x,z> | --by <dx,dz> [--y <m>]   world metres, x east, z north; --y = absolute world y, not the ground',
        '  resize <factor> | --height <m> [--width <m>]',
        '  rotate <degrees> | --yaw <degrees>    turn by, or to a heading',
        '  delete',
        '  swap <model>                          another model at the same height (arborist:<label> or <label>)',
        '  add <model> --at <x,z> [--height <m>] [--width <m>] [--yaw <deg>] [--y <m>]   (no tree; --y = absolute world y, not the ground)',
        '',
        '--picked         the tree marked in Arborist: point at it there and press P (Esc unmarks)',
        '--pick           the tree under the mouse in Arborist; --pick 0.5,0.5 the one in the middle of the picture',
        '--dry-run        say what would change, change nothing',
        '--json           the result as JSON',
        'Live in the running Arborist first (well under a second), then saved: arboristdata.dat, arboristdata.ids.json,',
        'the placements (the next gspro:export arborist) and the tree edits (the next plant in Unity). Unity is not called.',
    ].join('\n');
}

export interface EditArgs { course: string; target: TreeTarget | null; change: TreeChange; dryRun: boolean; json: boolean }

/** The `edit` command line, or an error to print with the usage. */
export function parseEditArgs(argv: string[]): EditArgs | { error: string } {
    const words: string[] = [];
    const flags = new Map<string, string | true>();
    const pair = (v: string | true | undefined, what: string): [number, number] | { error: string } => {
        const m = typeof v === 'string' ? /^(-?[\d.]+),(-?[\d.]+)$/.exec(v) : null;
        return m ? [Number(m[1]), Number(m[2])] : { error: `${what} needs <a,b> (two numbers, no space)` };
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i]!;
        if (!a.startsWith('--')) { words.push(a); continue; }
        if (['--dry-run', '--json', '--help', '--picked'].includes(a)) { flags.set(a, true); continue; }
        if (a === '--pick') {
            const v = argv[i + 1];
            if (v !== undefined && /^-?[\d.]+,-?[\d.]+$/.test(v)) { flags.set(a, v); i++; } else flags.set(a, true);
            continue;
        }
        if (!['--id', '--near', '--to', '--by', '--height', '--width', '--yaw', '--at', '--y'].includes(a)) return { error: `unknown option ${a}` };
        const v = argv[i + 1];
        if (v === undefined || (v.startsWith('--'))) return { error: `${a} needs a value` };
        flags.set(a, v);
        i++;
    }
    if (flags.has('--help')) return { error: 'help' };
    const [course, op, value, ...extra] = words;
    if (!course) return { error: 'name a course' };
    if (!op || !(OPS as readonly string[]).includes(op)) return { error: `name an op: ${OPS.join(', ')}` };
    if (extra.length) return { error: `one value after ${op}, not '${[value, ...extra].join(' ')}'` };
    const num = (flag: string) => {
        const v = flags.get(flag);
        if (v === undefined) return undefined;
        const n = Number(v);
        return Number.isFinite(n) ? n : NaN;
    };
    for (const f of ['--height', '--width', '--yaw', '--y']) if (Number.isNaN(num(f))) return { error: `${f} needs a number` };

    const targets = ['--id', '--near', '--pick', '--picked'].filter(f => flags.has(f));
    if (targets.length > 1) return { error: 'name the tree one way: --id, --near, --pick or --picked' };
    let target: TreeTarget | null = null;
    if (flags.has('--id')) target = { id: String(flags.get('--id')) };
    else if (flags.has('--near')) {
        const p = pair(flags.get('--near'), '--near');
        if ('error' in p) return p;
        target = { near: p };
    } else if (flags.has('--picked')) target = { pick: 'marked' };
    else if (flags.has('--pick')) {
        const v = flags.get('--pick')!;
        if (v === true) target = { pick: 'mouse' };
        else {
            const p = pair(v, '--pick');
            if ('error' in p) return p;
            target = { pick: { u: p[0], v: p[1] } };
        }
    }
    if (op === 'add' ? target : !target) return { error: op === 'add' ? 'add makes a new tree: no --id, --near, --pick or --picked' : `${op} needs the tree: --id, --near, --pick or --picked` };
    const model = (v: string | undefined) => (v && !v.includes(':') ? `arborist:${v}` : v);

    let change: TreeChange;
    switch (op) {
        case 'show': case 'delete':
            if (value) return { error: `${op} takes no value` };
            change = { op };
            break;
        case 'move': {
            const to = flags.has('--to') ? pair(flags.get('--to'), '--to') : undefined;
            const by = flags.has('--by') ? pair(flags.get('--by'), '--by') : undefined;
            if (to && 'error' in to) return to;
            if (by && 'error' in by) return by;
            if (!to === !by) return { error: 'move needs --to <x,z> or --by <dx,dz>' };
            change = to ? { op, to: to as [number, number], yM: num('--y') } : { op, by: by as [number, number], yM: num('--y') };
            break;
        }
        case 'resize': {
            const factor = value !== undefined ? Number(value.replace(/%$/, '')) / (value.endsWith('%') ? 100 : 1) : undefined;
            if (factor !== undefined && !(factor > 0)) return { error: `resize needs a factor above 0 (1.2, or 120%), not '${value}'` };
            if (factor === undefined && !flags.has('--height') && !flags.has('--width')) return { error: 'resize needs a factor, --height or --width' };
            change = { op, factor, heightM: num('--height'), crownWidthM: num('--width') };
            break;
        }
        case 'rotate': {
            const by = value !== undefined ? Number(value) : undefined;
            if (by !== undefined && !Number.isFinite(by)) return { error: `rotate needs degrees, not '${value}'` };
            if ((by === undefined) === !flags.has('--yaw')) return { error: 'rotate needs degrees to turn by, or --yaw <heading>' };
            change = { op, by, yaw: num('--yaw') };
            break;
        }
        case 'swap':
            if (!value) return { error: 'swap needs a model' };
            change = { op, model: model(value)! };
            break;
        default: {
            if (!value) return { error: 'add needs a model' };
            const at = pair(flags.get('--at'), '--at');
            if ('error' in at) return at;
            change = { op: 'add', model: model(value)!, at, heightM: num('--height'), crownWidthM: num('--width'), yaw: num('--yaw'), yM: num('--y') };
        }
    }
    return { course, target, change, dryRun: flags.has('--dry-run'), json: flags.has('--json') };
}

const f1 = (v: number) => (Math.round(v * 10) / 10).toString();
const f2 = (v: number) => (Math.round(v * 100) / 100).toString();
const describe = (t: TreeView) =>
    `${t.model} at (${f2(t.position[0])}, ${f2(t.position[1])}, ${f2(t.position[2])}), ${f2(t.heightM)} m high, ${f2(t.crownWidthM)} m wide, heading ${f1(t.rotationY)}°`;

/** The result as the lines the command prints. */
export function editReport(r: EditResult): string[] {
    const lines: string[] = [];
    const id = (r.before ?? r.after)!.id;
    lines.push(`tree ${id} (${(r.before ?? r.after)!.item}, ${(r.before ?? r.after)!.terrain})`);
    if (r.found) lines.push(`  found ${r.found}`);
    if (r.before) lines.push(`  was  ${describe(r.before)}`);
    if (r.op !== 'show') lines.push(`  now  ${r.after ? describe(r.after) : 'deleted'}`);
    if (r.op === 'show') return lines;
    lines.push(`${r.live.done ? 'live' : r.dryRun ? 'dry run' : 'NOT live'}: ${r.live.note}${r.live.seconds ? ` (${r.live.seconds} s round trip)` : ''}`);
    if (r.saved.length) lines.push(`saved in ${r.saveSeconds} s:`, ...r.saved.map(s => `  ${s}`));
    if (r.reload) lines.push(`reload: ${r.reload}`);
    for (const w of r.warnings) lines.push(`warning: ${w}`);
    return lines;
}

/** The mod in the running Arborist, or null (GOLFMAP_PLAYER picks another player). */
async function arboristPlayer(): Promise<ArboristPlayer | null> {
    let info;
    try {
        info = playerBridge(process.env.GOLFMAP_PLAYER || 'arborist');
    } catch {
        return null;
    }
    return { call: (command, args = {}, timeoutSec = 30) => bridgeRun(info, command, args, timeoutSec) };
}

export async function editMain(argv: string[]): Promise<void> {
    const parsed = parseEditArgs(argv);
    if ('error' in parsed) {
        if (parsed.error === 'help') { console.log(editUsage()); return; }
        console.error(`error: ${parsed.error}\n\n${editUsage()}`);
        process.exit(2);
    }
    const { course, paths, close } = await openCourse(parsed.course);
    const loop = realDeps();
    const service = new ArboristEditService({
        ...paths, runner: defaultRunner(paths.python), player: arboristPlayer,
        reload: async (player, scene) => (await reloadInArborist({ name: 'Arborist', call: player.call }, scene, DEFAULT_WAIT_SEC, loop)).join('; '),
    });
    try {
        const result = await service.edit(course, parsed.target, parsed.change, { dryRun: parsed.dryRun });
        console.log(parsed.json ? JSON.stringify(result, null, 2) : editReport(result).join('\n'));
    } catch (e) {
        console.error(`error: ${(e as Error).message}`);
        process.exitCode = 1;
    } finally {
        await close();
    }
}
