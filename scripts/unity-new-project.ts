// Sets up a new GSPro course project from a finished one: the bought packages
// (VSP, Forst oaks and birches, NatureManufacture with RAM, RUSTIC grass, Stix),
// our editor scripts and the bridge, the asset edits made in the source project
// (OPCD material tuning, stale-keyword fixes) and the course's presets.
//
//   bun run unity:new-project -- --from <project> --to <project> --course <Name>
//                                [--from-course <Name>] [--prefix <slug>] [--dry-run]
//
// --prefix is the file prefix the app's exports carry: the app course name as a
// slug ("Ombergs Golfklubb" -> ombergs-golfklubb; gspro:status lists the files).
// Without it the lowercased --course name is used.
//
// <project> is a Unity project folder or a name under D:/gspro_courses
// ("vreta_v4_2025_12_02"). The new project is a fresh GSPro base project
// unzip; close it in Unity first (copies under an open 2018.2 editor do not
// reload). Safe to re-run: files already there and the same are left alone.
//
// What goes over, in this order (unity/project-template.json lists the names):
//   1. packages        whole folders, missing and newer files (robocopy /XO)
//   2. asset edits     files elsewhere in Assets that the source project
//                      changed after it was created, or that its course scene
//                      and presets use and the new project lacks. Code (.cs/.dll)
//                      only when added after the source project was created,
//                      since the newer base project carries newer GSPro tools.
//                      A copied material keeps the new project's own texture in
//                      slots that point at the source course (its photo).
//   3. define symbols  VSP, TouchReact and Stix need theirs
//   4. scripts         the repo's unity/ folders pushed over (unity_sync push --force)
//   5. course folder   Assets/GolfMap/<Name>/: Course.asset with the pipeline's
//                      names, the presets (palette, grass palette, look, Stix,
//                      paint, bunker channels, path surfaces) and the course-folder
//                      assets they point at, paths rewritten to the new course
//
// Course-specific things stay behind: the FBX meshes, terrains, backups, the
// scene, walls, props, trees and zones. The pipeline makes those for the new
// course.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, copyFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadInstallFolders, sync, summarize } from '../unity/mcp/sync';

const REPO = resolve(import.meta.dir, '..');
const COURSES_ROOT = 'D:/gspro_courses';
const CODE = /\.(cs|dll|asmdef|js)$/i;
const YAML_ASSET = /\.(unity|prefab|mat|asset|controller|overrideController|anim|physicMaterial|terrainlayer|preset)$/i;

interface Template { packages: string[]; projectFolders: string[]; skip: string[]; defines: string[]; coursePresets: string[] }

function parseArgs(argv: string[]) {
    const out: Record<string, string | boolean> = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (!a.startsWith('--')) throw new Error(`Unexpected argument ${a}`);
        const key = a.slice(2);
        if (key === 'dry-run') out[key] = true;
        else out[key] = argv[++i];
    }
    return out;
}

function projectPath(arg: string): string {
    const p = existsSync(arg) ? resolve(arg) : join(COURSES_ROOT, arg);
    if (!existsSync(join(p, 'Assets'))) throw new Error(`${p} is not a Unity project (no Assets folder).`);
    return p.replace(/\\/g, '/');
}

function listFiles(root: string, rel = ''): string[] {
    const dir = join(root, rel);
    if (!existsSync(dir)) return [];
    const out: string[] = [];
    for (const e of readdirSync(dir, { withFileTypes: true })) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) out.push(...listFiles(root, r));
        else out.push(r);
    }
    return out;
}

function sameBytes(a: string, b: string): boolean {
    const sa = statSync(a), sb = statSync(b);
    if (sa.size !== sb.size) return false;
    return readFileSync(a).equals(readFileSync(b));
}

function copy(from: string, to: string, dryRun: boolean) {
    if (dryRun) return;
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
}

// An editor with the project open: its bridge file names the project and its process lives.
function openEditor(project: string): number | null {
    const dir = join(process.env.LOCALAPPDATA ?? '', 'GolfMapBridge');
    if (!existsSync(dir)) return null;
    for (const f of readdirSync(dir).filter(f => /^bridge-\d+\.json$/.test(f))) {
        try {
            const doc = JSON.parse(readFileSync(join(dir, f), 'utf8'));
            if (resolve(doc.projectPath).toLowerCase() !== resolve(project).toLowerCase()) continue;
            process.kill(doc.pid ?? Number(f.match(/\d+/)![0]), 0);
            return doc.pid ?? Number(f.match(/\d+/)![0]);
        } catch { /* stale file or dead process */ }
    }
    return null;
}

// robocopy: missing and newer files. Exit codes below 8 are success.
function robocopy(from: string, to: string, dryRun: boolean): { files: number; bytes: number } {
    const args = [from.replace(/\//g, '\\'), to.replace(/\//g, '\\'), '/E', '/XO', '/R:1', '/W:1', '/MT:16', '/NDL', '/NJH', '/NP', '/BYTES', '/FP'];
    if (dryRun) args.push('/L');
    const res = spawnSync('robocopy', args, { encoding: 'utf8', maxBuffer: 1 << 28 });
    if (res.status === null || res.status >= 8) throw new Error(`robocopy ${from} failed (${res.status}): ${res.stdout?.slice(-2000)}`);
    const m = /Files\s*:\s*\d+\s+(\d+)/.exec(res.stdout);
    const b = /Bytes\s*:\s*\d+\s+(\d+)/.exec(res.stdout);
    return { files: m ? Number(m[1]) : 0, bytes: b ? Number(b[1]) : 0 };
}

// GUID -> Assets-relative path, from the .meta files.
function guidIndex(assets: string, files: string[]): Map<string, string> {
    const map = new Map<string, string>();
    for (const f of files) {
        if (!f.endsWith('.meta')) continue;
        const m = /guid: ([0-9a-f]{32})/.exec(readFileSync(join(assets, f), 'utf8').slice(0, 400));
        if (m) map.set(m[1], f.slice(0, -5));
    }
    return map;
}

// Every asset reachable from the seeds through GUID references and "Assets/..." strings in JSON.
function closure(assets: string, seeds: string[], guids: Map<string, string>): Set<string> {
    const seen = new Set<string>();
    const queue = [...seeds];
    while (queue.length) {
        const p = queue.pop()!;
        if (seen.has(p)) continue;
        seen.add(p);
        const abs = join(assets, p);
        if (!existsSync(abs) || statSync(abs).isDirectory()) continue;
        let refs: string[] = [];
        if (YAML_ASSET.test(p)) {
            const buf = readFileSync(abs);
            if (buf.subarray(0, 5).toString() !== '%YAML') continue;
            refs = [...buf.toString('utf8').matchAll(/guid: ([0-9a-f]{32})/g)].map(m => guids.get(m[1])).filter((x): x is string => !!x);
        } else if (/\.json$/i.test(p)) {
            refs = [...readFileSync(abs, 'utf8').matchAll(/"Assets\/([^"]+)"/g)].map(m => m[1]);
        }
        for (const r of refs) if (!seen.has(r)) queue.push(r);
    }
    return seen;
}

// A source material with the target's texture kept in slots whose source
// texture fails `keep` (the source course's photo, an asset not carried over).
function mergeMaterial(srcText: string, dstText: string | null, keep: (guid: string) => boolean): { text: string; kept: string[] } {
    const dstSlots = new Map<string, string[]>();
    if (dstText) {
        const lines = dstText.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
            const m = /^ {4}- (\w+):$/.exec(lines[i]);
            if (m && /^ {8}m_Texture:/.test(lines[i + 1] ?? '')) dstSlots.set(m[1], lines.slice(i + 1, i + 4));
        }
    }
    const lines = srcText.split(/\r?\n/);
    const kept: string[] = [];
    for (let i = 0; i < lines.length; i++) {
        const m = /^ {4}- (\w+):$/.exec(lines[i]);
        const tex = /^ {8}m_Texture: \{fileID: \d+, guid: ([0-9a-f]{32})/.exec(lines[i + 1] ?? '');
        if (!m || !tex || keep(tex[1])) continue;
        const replacement = dstSlots.get(m[1]) ?? ['        m_Texture: {fileID: 0}', '        m_Scale: {x: 1, y: 1}', '        m_Offset: {x: 0, y: 0}'];
        lines.splice(i + 1, 3, ...replacement);
        kept.push(m[1]);
    }
    return { text: lines.join('\n'), kept };
}

function addDefines(settingsFile: string, defines: string[], dryRun: boolean): string[] {
    const text = readFileSync(settingsFile, 'utf8');
    const added: string[] = [];
    const next = text.replace(/(scriptingDefineSymbols:\r?\n {4}1: )([^\r\n]*)/, (_all, head: string, list: string) => {
        const have = list.split(';').filter(Boolean);
        for (const d of defines) if (!have.includes(d)) { have.push(d); added.push(d); }
        return head + have.join(';');
    });
    if (!/scriptingDefineSymbols:\r?\n {4}1: /.test(text)) {
        throw new Error(`${settingsFile}: no Standalone scriptingDefineSymbols line; add ${defines.join(';')} in Player Settings.`);
    }
    if (added.length && !dryRun) writeFileSync(settingsFile, next);
    return added;
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    if (!args.from || !args.to || !args.course) {
        console.error('Usage: bun run unity:new-project -- --from <project> --to <project> --course <Name> [--from-course <Name>] [--prefix <slug>] [--dry-run]');
        process.exit(2);
    }
    const dryRun = args['dry-run'] === true;
    const src = projectPath(String(args.from));
    const dst = projectPath(String(args.to));
    const course = String(args.course);
    const template: Template = JSON.parse(readFileSync(join(REPO, 'unity/project-template.json'), 'utf8'));
    const srcAssets = `${src}/Assets`, dstAssets = `${dst}/Assets`;

    const pid = openEditor(dst);
    if (pid && !dryRun) throw new Error(`${dst} is open in Unity (pid ${pid}); close it first.`);

    // The source course: --from-course, else the only course folder with a Course.asset.
    const srcCourses = readdirSync(`${srcAssets}/GolfMap`, { withFileTypes: true })
        .filter(e => e.isDirectory() && existsSync(`${srcAssets}/GolfMap/${e.name}/Course.asset`)).map(e => e.name);
    const srcCourse = args['from-course'] ? String(args['from-course']) : srcCourses.length === 1 ? srcCourses[0] : '';
    if (!srcCourse || !srcCourses.includes(srcCourse)) throw new Error(`Name the source course with --from-course (${srcCourses.join(', ')}).`);
    const srcCourseDir = `GolfMap/${srcCourse}`;
    const courseAsset = readFileSync(`${srcAssets}/${srcCourseDir}/Course.asset`, 'utf8');
    const sceneName = /sceneName: (.*)/.exec(courseAsset)?.[1].trim() ?? '';

    console.log(`${dryRun ? '[dry run] ' : ''}${src} (${srcCourse}) -> ${dst} (${course})`);

    // 1. Packages.
    console.log('\n1. packages');
    let total = 0;
    for (const p of template.packages) {
        if (!existsSync(`${srcAssets}/${p}`)) { console.log(`   ${p}: not in the source, skipped`); continue; }
        const r = robocopy(`${srcAssets}/${p}`, `${dstAssets}/${p}`, dryRun);
        total += r.bytes;
        console.log(`   ${p}: ${r.files} files, ${(r.bytes / 1e6).toFixed(0)} MB`);
    }
    for (const p of template.projectFolders) {
        if (!existsSync(`${src}/${p}`)) continue;
        const r = robocopy(`${src}/${p}`, `${dst}/${p}`, dryRun);
        total += r.bytes;
        console.log(`   ${p} (project root): ${r.files} files`);
    }
    console.log(`   ${(total / 1e9).toFixed(1)} GB`);

    // 2. Asset edits and what the source course uses.
    console.log('\n2. asset edits');
    const srcFiles = listFiles(srcAssets);
    const guids = guidIndex(srcAssets, srcFiles);
    const created = statSync(src).birthtimeMs;
    const inPackage = (p: string) => template.packages.some(pk => p === pk || p.startsWith(pk + '/') || p === pk + '.meta');
    const skipGlobs = template.skip.map(g => new Bun.Glob(g));
    const skipped = (p: string) => skipGlobs.some(g => g.match(p));
    const scene = srcFiles.find(f => f.endsWith(`/${sceneName}.unity`));
    const presetSeeds = template.coursePresets.map(f => `${srcCourseDir}/${f}`).filter(f => existsSync(`${srcAssets}/${f}`));
    const used = closure(srcAssets, [...(scene ? [scene] : []), ...presetSeeds], guids);
    const topInDst = new Set(readdirSync(dstAssets));

    const plan = new Map<string, 'new' | 'edited'>();
    const codeHeld: string[] = [];
    for (const f of srcFiles) {
        if (f.endsWith('.meta') || inPackage(f) || skipped(f)) continue;
        if (!topInDst.has(f.split('/')[0]) && f.includes('/')) continue; // a top folder not listed as a package
        const from = `${srcAssets}/${f}`, to = `${dstAssets}/${f}`;
        const edited = statSync(from).mtimeMs > created || (existsSync(from + '.meta') && statSync(from + '.meta').mtimeMs > created);
        const there = existsSync(to);
        if (there && sameBytes(from, to) && (!existsSync(from + '.meta') || !existsSync(to + '.meta') || sameBytes(from + '.meta', to + '.meta'))) continue;
        if (CODE.test(f)) {
            if (!there && edited) plan.set(f, 'new');
            else if (edited) codeHeld.push(f);
            continue;
        }
        if (!there && (edited || used.has(f))) plan.set(f, 'new');
        else if (there && edited) plan.set(f, 'edited');
    }

    // A texture is carried when the target has it or gets it; never the source course's own.
    const reaches = (guid: string) => {
        const p = guids.get(guid);
        if (!p) return true; // built-in or a package reference
        if (p.startsWith(srcCourseDir + '/') || skipped(p)) return false;
        return existsSync(`${dstAssets}/${p}`) || plan.has(p) || inPackage(p);
    };
    const byFolder = new Map<string, { n: number; edited: number }>();
    const keptSlots: string[] = [];
    for (const [f, kind] of plan) {
        const from = `${srcAssets}/${f}`, to = `${dstAssets}/${f}`;
        if (f.endsWith('.mat')) {
            const merged = mergeMaterial(readFileSync(from, 'utf8'), existsSync(to) ? readFileSync(to, 'utf8') : null, reaches);
            if (merged.kept.length) keptSlots.push(`${f}: ${merged.kept.join(', ')}`);
            if (!dryRun) { mkdirSync(dirname(to), { recursive: true }); writeFileSync(to, merged.text); }
        } else copy(from, to, dryRun);
        if (existsSync(from + '.meta')) copy(from + '.meta', to + '.meta', dryRun);
        const key = f.split('/').slice(0, 2).join('/');
        const e = byFolder.get(key) ?? { n: 0, edited: 0 };
        e.n++; if (kind === 'edited') e.edited++;
        byFolder.set(key, e);
    }
    for (const [k, v] of [...byFolder].sort()) console.log(`   ${k}: ${v.n} files (${v.edited} replaced, ${v.n - v.edited} new)`);
    for (const k of keptSlots) console.log(`   kept the new project's texture: ${k}`);
    if (codeHeld.length) console.log(`   code changed in the source but not copied (the base project has its own): ${codeHeld.join(', ')}`);

    // 3. Define symbols.
    console.log('\n3. define symbols');
    const added = addDefines(`${dst}/ProjectSettings/ProjectSettings.asset`, template.defines, dryRun);
    console.log(added.length ? `   added ${added.join(';')}` : '   all there');

    // 4. Scripts from the repo (the source's copies, with their .meta GUIDs, came with the packages).
    console.log('\n4. scripts from the repo');
    if (!dryRun) {
        const reports = sync({ repoRoot: join(REPO, 'unity'), projectPath: dst, folders: loadInstallFolders(join(REPO, 'unity')), mode: 'push', force: true });
        console.log('   ' + summarize(reports, 'push').split('\n').join('\n   '));
    } else console.log('   unity_sync push --force (skipped in a dry run)');

    // 5. The course folder.
    console.log(`\n5. course folder GolfMap/${course}`);
    const dstCourseDir = `${dstAssets}/GolfMap/${course}`;
    if (existsSync(`${dstCourseDir}/Course.asset`)) {
        console.log('   already there, left alone');
    } else {
        const lower = course.toLowerCase();
        // The Terrain Importer names the inner TerrainData <prefix>_Lidar_Inner.
        const prefix = typeof args.prefix === 'string' ? args.prefix : lower;
        const fields: Record<string, string> = {
            courseName: course, sceneName: '', fallbackTreesFile: '',
            exportFolder: `../../${lower}-opcd`, exportPrefix: prefix, innerTerrainData: `${prefix}_Lidar_Inner`,
        };
        let asset = courseAsset;
        for (const [k, v] of Object.entries(fields)) asset = asset.replace(new RegExp(`^(  ${k}:).*$`, 'm'), `$1 ${v}`);
        const rewrite = (text: string) => text.split(`GolfMap/${srcCourse}/`).join(`GolfMap/${course}/`);
        const courseUsed = [...closure(srcAssets, presetSeeds, guids)].filter(p => p.startsWith(srcCourseDir + '/') && existsSync(`${srcAssets}/${p}`));
        if (!dryRun) {
            mkdirSync(dstCourseDir, { recursive: true });
            writeFileSync(`${dstCourseDir}/Course.asset`, asset);
        }
        for (const p of courseUsed) {
            const to = `${dstAssets}/${rewrite(p)}`;
            if (/\.json$/i.test(p)) { if (!dryRun) { mkdirSync(dirname(to), { recursive: true }); writeFileSync(to, rewrite(readFileSync(`${srcAssets}/${p}`, 'utf8'))); } }
            else copy(`${srcAssets}/${p}`, to, dryRun);
            if (existsSync(`${srcAssets}/${p}.meta`)) copy(`${srcAssets}/${p}.meta`, `${to}.meta`, dryRun);
        }
        console.log(`   Course.asset (scene: any, export ../../${lower}-opcd), ${courseUsed.length} preset files and the assets they use`);
    }

    console.log(`\nNext: open ${dst} in Unity 2018.2.8f1 (the first import of the packages takes a while), make the course scene, then set its name as Scene Name on GolfMap/${course}/Course.asset.`);
}

main();
