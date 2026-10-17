// The planting rules of a course's vegetation, as the web's Planting rules panel shows
// them (VegetationRulesService): every generator's rules with the course's own values
// marked, the mixes its zone types bind, and the tree rules. Reads only.
//
//   bun run vegetation:rules -- <course> [--json] [--only <source>]
//
// A value the course sets in docs/gspro/<course>/vegetation-rules.json (or its
// palette.json / arborist-species.json) is shown as `course (default ...)`.
import '../server/env-paths';
import * as path from 'node:path';
import { createDb } from '@basics/core/server/db';
import type { Database } from '../server/db/schema';
import { CoursesService } from '../server/services/courses.service';
import { CourseFeaturesService } from '../server/services/course-features.service';
import { ZoneTypesService } from '../server/services/zone-types.service';
import { VegetationRulesService, type PlantingRuleSection } from '../server/services/vegetation-rules.service';

const ROOT = path.resolve(import.meta.dir, '..');
const args = process.argv.slice(2);
const json = args.includes('--json');
const onlyAt = args.indexOf('--only');
const only = onlyAt >= 0 ? args[onlyAt + 1] : undefined;
const ident = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--only');
if (!ident) {
    console.error('usage: bun run vegetation:rules -- <course> [--json] [--only <source>]');
    process.exit(2);
}

const show = (v: unknown): string => typeof v === 'string' ? v : JSON.stringify(v);

function print(s: PlantingRuleSection): void {
    console.log(`\n== ${s.label} (${s.source}${s.script ? `, ${s.script}` : ''})`);
    console.log(`   ${s.summary}`);
    if (s.courseFile) console.log(`   course values: ${s.courseFile}`);
    for (const step of s.steps) console.log(`   - ${step}`);
    for (const g of s.groups) {
        console.log(`  ${g.title}`);
        for (const r of g.rules) {
            const value = r.value === null ? '(not set)' : show(r.value);
            const by = r.courseSets && r.defaultValue !== null ? `   course (default ${show(r.defaultValue)})` : r.courseSets ? '   course' : '';
            console.log(`    ${r.key} = ${value}${r.unit ? ` ${r.unit}` : ''}${by}`);
            console.log(`        ${r.text}`);
        }
    }
    for (const e of s.courseExtras) console.log(`    ${e.key} = ${show(e.value)}   course (a flag of the script)`);
    if (s.mixes.length) {
        console.log('  Mixes');
        for (const m of s.mixes) console.log(`    ${m.zoneType}/${m.variant || 'default'} (${m.variantName}): ${m.items.length ? m.items.join(', ') : 'no items: nothing grows'}`);
    }
}

const dataDir = process.env.DATA_DIR ?? path.join(ROOT, 'data');
const db = createDb<Database>(process.env.DB_PATH ?? path.join(dataDir, 'app.sqlite'));
try {
    const rows = await db.selectFrom('courses').select(['id', 'name']).execute();
    const q = ident.toLowerCase();
    const exact = rows.filter((r) => r.id.toLowerCase() === q || r.name.toLowerCase() === q);
    const pick = exact.length === 1 ? exact : rows.filter((r) => r.name.toLowerCase().includes(q));
    if (pick.length !== 1) throw new Error(`${pick.length ? 'several' : 'no'} courses match '${ident}'`);
    const svc = new VegetationRulesService({
        courses: new CoursesService(db), features: new CourseFeaturesService(db), zoneTypes: new ZoneTypesService(db),
    });
    const rules = await svc.forCourse(pick[0]!.id);
    if (json) {
        console.log(JSON.stringify(rules, null, 2));
    } else {
        console.log(`${rules.courseName}: planting rules (course files in ${rules.courseDocs}/)`);
        for (const s of [...rules.generators, ...rules.trees]) if (!only || s.source === only) print(s);
        if (!only || only === 'trees') {
            console.log('\n== Tree species areas');
            for (const a of rules.treeAreas) console.log(`    ${a.name || '(unnamed)'}: ${a.mix}${a.ignoreKind ? ' (ignores kind)' : ''}`);
            if (!rules.treeAreas.length) console.log('    none');
            console.log(`  Palette assets: ${rules.treeAssets.map((a) => `${a.species} ${a.enabled}/${a.total}`).join(', ')}`);
        }
    }
} catch (e) {
    console.error(`error: ${(e as Error).message}`);
    process.exitCode = 1;
} finally {
    await db.destroy();
}
