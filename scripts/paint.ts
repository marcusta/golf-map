// Vertex paint of the course meshes from the command line: the same PaintService as the web Terrain editor's
// Paint tool (server/services/paint.service.ts). A change is checked by the paint engine, previewed at once in
// the course's open Unity editor (temporary, until the mesh's next FBX), then saved to docs/gspro/<course>/paint.json
// and the Blender paint layer regenerated (while PAINT_LAYER_LIVE is on); --sync then runs the shaping apply so
// Blender paints it for good.
//
//   bun run paint -- <course> list
//   bun run paint -- <course> stroke (--line e,n e,n ... | --polygon e,n e,n e,n ... | --circle e,n --radius R)
//                    --channel red|green|blue|black [--width W] [--feather F] [--strength S] [--mode replace|overlay]
//                    [--surfaces Rough,Deep] [--match <name part>] [--id ID]
//   bun run paint -- <course> rule set '<json>' | @rule.json
//   bun run paint -- <course> rule disable <id>
//   bun run paint -- <course> remove <id>
//   ... [--dry-run] [--sync]
//
// Points are EPSG:3006 easting,northing. --dry-run previews only (nothing written). <course> is a course id, slug
// or name (a unique name substring works too). Exit 1 on failure.
import '../server/env-paths';
import * as path from 'node:path';
import { readFileSync } from 'node:fs';
import { createDb } from '@basics/core/server/db';
import type { Database } from '../server/db/schema';
import { CoursesService } from '../server/services/courses.service';
import { AssetsService } from '../server/services/assets.service';
import { TerrainEditsService } from '../server/services/terrain-edits.service';
import { GsproExportService, courseSlug } from '../server/services/gspro-export.service';
import { ShapingService } from '../server/services/shaping.service';
import { PaintService, type PaintChangeResult, type PaintRule, type PaintStroke } from '../server/services/paint.service';

const ROOT = path.resolve(import.meta.dir, '..');
const POLL_MS = 1000;
const USAGE = `usage: bun run paint -- <course> list
       bun run paint -- <course> stroke (--line e,n e,n ... | --polygon e,n e,n e,n ... | --circle e,n --radius R)
            --channel red|green|blue|black [--width W] [--feather F] [--strength S] [--mode replace|overlay]
            [--surfaces Rough,Deep] [--match <name part>] [--id ID]
       bun run paint -- <course> rule set '<json>' | @file.json
       bun run paint -- <course> rule disable <id>
       bun run paint -- <course> remove <id>
       ... [--dry-run] [--sync]`;

function usage(message?: string): never {
    if (message) console.error(`error: ${message}\n`);
    console.error(USAGE);
    process.exit(2);
}

const pair = (text: string): [number, number] => {
    const p = text.split(',').map(Number);
    if (p.length !== 2 || !p.every(Number.isFinite)) usage(`'${text}' is not e,n`);
    return [p[0]!, p[1]!];
};
const isPair = (text: string | undefined) => !!text && /^-?[\d.]+,-?[\d.]+$/.test(text);

// --- arguments ---
const argv = process.argv.slice(2);
let dryRun = false;
let sync = false;
const rest: string[] = [];
for (const a of argv) {
    if (a === '--dry-run') dryRun = true;
    else if (a === '--sync') sync = true;
    else rest.push(a);
}
const [ident, verb, ...args] = rest;
if (!ident || !verb) usage();

function parseStroke(a: string[]): Omit<PaintStroke, 'id'> & { id?: string } {
    const s: Record<string, unknown> = {};
    for (let i = 0; i < a.length; i++) {
        const flag = a[i]!;
        const value = () => a[++i] ?? usage(`${flag} needs a value`);
        const num = () => {
            const v = Number(value());
            if (!Number.isFinite(v)) usage(`${flag} needs a number`);
            return v;
        };
        if (flag === '--line' || flag === '--polygon') {
            s.geometry = flag.slice(2);
            const pts: [number, number][] = [];
            while (isPair(a[i + 1])) pts.push(pair(a[++i]!));
            s.points3006 = pts;
        } else if (flag === '--circle') {
            s.geometry = 'circle';
            s.centre3006 = pair(value());
        } else if (flag === '--radius') s.radiusM = num();
        else if (flag === '--width') s.widthM = num();
        else if (flag === '--feather') s.featherM = num();
        else if (flag === '--strength') s.strength = num();
        else if (flag === '--channel') s.channel = value();
        else if (flag === '--mode') s.mode = value();
        else if (flag === '--surfaces') s.surfaces = value().split(',').map(x => x.trim()).filter(Boolean);
        else if (flag === '--match') s.match = value();
        else if (flag === '--id') s.id = value();
        else usage(`unknown stroke option ${flag}`);
    }
    if (!s.geometry) usage('a stroke needs --line, --polygon or --circle');
    if (!s.channel) usage('a stroke needs --channel');
    return s as unknown as PaintStroke;
}

// --- services ---
const dataDir = process.env.DATA_DIR ?? path.join(ROOT, 'data');
const dbPath = process.env.DB_PATH ?? path.join(dataDir, 'app.sqlite');
const pipelineDir = process.env.MAP_PIPELINE_DIR ?? path.join(ROOT, 'pipeline');
const db = createDb<Database>(dbPath);
const courses = new CoursesService(db);
const exporter = new GsproExportService({
    db, courses, assets: new AssetsService(db, dataDir), dataDir,
    terrainEdits: new TerrainEditsService(db), pipelineDir,
});
const shaping = new ShapingService({ courses, exportSettings: exporter, dataDir, pipelineDir, dbPath });
const paint = new PaintService({ courses, exportSettings: exporter, shaping, pipelineDir });

async function resolveCourse(text: string): Promise<{ id: string; name: string }> {
    const rows = await db.selectFrom('courses').select(['id', 'name']).execute();
    const q = text.toLowerCase();
    const exact = rows.filter((r) => r.id.toLowerCase() === q || r.name.toLowerCase() === q || courseSlug(r.name) === q);
    if (exact.length === 1) return exact[0]!;
    const partial = rows.filter((r) => r.name.toLowerCase().includes(q));
    if (partial.length === 1) return partial[0]!;
    const names = (partial.length ? partial : rows).map((r) => `  ${r.name} (${r.id})`).join('\n');
    usage(`${partial.length ? 'several' : 'no'} courses match '${text}':\n${names}`);
}

const strokeLine = (s: PaintStroke) => {
    const where = s.geometry === 'circle'
        ? `circle ${s.centre3006!.join(',')} r ${s.radiusM} m`
        : `${s.geometry} ${s.points3006!.length} pts${s.widthM ? ` ${s.widthM} m wide` : ''}`;
    return `  ${s.id.padEnd(16)} ${s.channel.padEnd(5)} ${where}, feather ${s.featherM ?? 0.5} m, strength ${s.strength ?? 1}`
        + `${s.mode === 'overlay' ? ' overlay' : ''}${s.surfaces ? ` on ${s.surfaces.join(',')}` : ''}${s.enabled === false ? ' (off)' : ''}`;
};

function printChange(r: PaintChangeResult): void {
    const p = r.preview;
    const shown = p.status === 'shown'
        ? `preview on ${p.previewed.length} mesh(es)${p.cleared.length ? `, ${p.cleared.length} back to FBX` : ''}`
        : `preview ${p.status}`;
    console.log(`${r.action} ${r.id}: ${r.dryRun ? 'dry run, nothing written' : r.saved ? `saved ${path.relative(ROOT, r.file)}` : 'not saved'}; ${shown}`);
    if (!r.dryRun) console.log(`layer: ${r.layer.note}`);
    if (p.previewed.length) console.log(`  ${p.previewed.slice(0, 6).join(', ')}${p.previewed.length > 6 ? ', ...' : ''}`);
    for (const s of p.skipped) console.log(`  skipped ${s.object}: ${s.why}`);
    for (const w of r.warnings) console.log(`warning: ${w}`);
}

async function followSync(jobId: string): Promise<boolean> {
    console.log(`sync: shaping apply ${jobId}`);
    for (;;) {
        const job = shaping.job(jobId);
        if (job.status !== 'running') {
            console.log(`sync ${job.status}${job.error ? `: ${job.error}` : ''} (${job.seconds} s)`
                + (job.result ? `, ${job.result.changedObjects.length} object(s) re-shaped` : ''));
            return job.status === 'succeeded';
        }
        await Bun.sleep(POLL_MS);
    }
}

async function main(): Promise<number> {
    const course = await resolveCourse(ident!);
    const opts = { dryRun, sync };
    let r: PaintChangeResult;
    if (verb === 'list') {
        const l = await paint.list(course.id);
        console.log(`${course.name}: ${path.relative(ROOT, l.file)}${l.exists ? '' : ' (none yet)'}; layer ${l.layerLive ? 'live' : 'not live yet'}`);
        console.log(`rules (${l.rules.length}):`);
        for (const x of l.rules) console.log(`  ${x.id.padEnd(16)} ${x.kind}${x.enabled === false ? ' (off)' : ''}`);
        console.log(`strokes (${l.strokes.length}):`);
        for (const s of l.strokes) console.log(strokeLine(s));
        return 0;
    } else if (verb === 'stroke') {
        r = await paint.stroke(course.id, parseStroke(args), opts);
    } else if (verb === 'rule' && args[0] === 'set') {
        const text = args[1] ?? usage('rule set needs the rule as JSON or @file');
        let rule: PaintRule;
        try {
            rule = JSON.parse(text.startsWith('@') ? readFileSync(text.slice(1), 'utf8') : text) as PaintRule;
        } catch (e) {
            usage(`rule set: ${(e as Error).message}`);
        }
        r = await paint.ruleSet(course.id, rule, opts);
    } else if (verb === 'rule' && args[0] === 'disable') {
        r = await paint.ruleDisable(course.id, args[1] ?? usage('rule disable needs an id'), opts);
    } else if (verb === 'remove') {
        r = await paint.remove(course.id, args[0] ?? usage('remove needs an id'), opts);
    } else {
        usage(`unknown command ${verb}${args[0] ? ` ${args[0]}` : ''}`);
    }
    printChange(r);
    if (r.sync) return (await followSync(r.sync.jobId)) ? 0 : 1;
    return 0;
}

try {
    process.exit(await main());
} catch (e) {
    console.error(`error: ${(e as Error).message}`);
    process.exit(1);
}
