// Surface lab: every drawn feature of each course that has a map, as WGS84 GeoJSON per site, for prepare.py.
//
//   bun tools/surface-lab/export-labels.ts
//
// Writes data/experiments/surfaces/<siteId>/features-<courseId>.geojson (the server's geojsonByCourse: raw, with
// stackKey, so prepare.py burns the shapes bottom-up in the same order the editor paints them) and courses.json.
// Opens the database read-only in effect: nothing is written to it.
import '../../server/env-paths';
import * as path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { createDb } from '@basics/core/server/db';
import type { Database } from '../../server/db/schema';
import { CourseFeaturesService } from '../../server/services/course-features.service';

const ROOT = path.resolve(import.meta.dir, '..', '..');
const dataDir = process.env.DATA_DIR ?? path.join(ROOT, 'data');
const outRoot = path.join(dataDir, 'experiments', 'surfaces');
const db = createDb<Database>(process.env.DB_PATH ?? path.join(dataDir, 'app.sqlite'));
try {
    const courses = await db.selectFrom('courses').select(['id', 'name', 'site_id']).where('site_id', 'is not', null).execute();
    const service = new CourseFeaturesService(db);
    const index: { siteId: string; courseId: string; name: string; features: number }[] = [];
    for (const course of courses) {
        const fc = await service.geojsonByCourse(course.id);
        if (fc.features.length === 0) continue;
        const dir = path.join(outRoot, course.site_id!);
        await mkdir(dir, { recursive: true });
        await writeFile(path.join(dir, `features-${course.id}.geojson`), JSON.stringify(fc));
        index.push({ siteId: course.site_id!, courseId: course.id, name: course.name, features: fc.features.length });
        console.log(`${course.name}: ${fc.features.length} features -> ${course.site_id}`);
    }
    await mkdir(outRoot, { recursive: true });
    await writeFile(path.join(outRoot, 'courses.json'), JSON.stringify(index, null, 2));
} finally {
    await db.destroy();
}
