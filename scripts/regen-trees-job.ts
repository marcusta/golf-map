// Runs the app's "Regenerate trees" (MapBuildService.reTrees) for one course from
// the command line: canopy tiles + the tree-stems asset from the persisted lidar
// and DEM, then waits for the job and prints its steps. The same job the
// Create-mode actions menu starts, woodland stands included; scripts/regen-trees.sh
// is the older shell version (needs sqlite3 on PATH, skips the stands).
//
//   bun run trees:regen -- <courseId>
import '../server/env-paths';
import * as path from 'node:path';
import { createDb } from '@basics/core/server/db';
import type { Database } from '../server/db/schema';
import { AssetsService } from '../server/services/assets.service';
import { TerrainEditsService } from '../server/services/terrain-edits.service';
import { venvPython } from '../server/services/gspro-export.service';
import { MapBuildService } from '../server/services/map-build.service';

const ROOT = path.resolve(import.meta.dir, '..');
const courseId = process.argv[2];
if (!courseId) { console.error('usage: bun scripts/regen-trees-job.ts <courseId>'); process.exit(2); }
const dataDir = process.env.DATA_DIR ?? path.join(ROOT, 'data');
const pipelineDir = process.env.MAP_PIPELINE_DIR ?? path.join(ROOT, 'pipeline');
const db = createDb<Database>(process.env.DB_PATH ?? path.join(dataDir, 'app.sqlite'));
const assets = new AssetsService(db, dataDir);
const mapBuild = new MapBuildService({
    db, assets, dataDir, pipelineDir, terrainEdits: new TerrainEditsService(db),
    python: process.env.MAP_PIPELINE_PYTHON ?? venvPython(pipelineDir),
});

let job = await mapBuild.reTrees(courseId);
const t0 = Date.now();
let last = '';
while (job.status === 'running' || job.status === 'pending') {
    await Bun.sleep(3000);
    job = await mapBuild.get(job.id);
    const line = job.step ?? '';
    if (line !== last) { console.log(`${Math.round((Date.now() - t0) / 1000)} s ${line}`); last = line; }
}
console.log(`${job.status}${job.error ? ': ' + job.error : ''}
${job.log.slice(-3000)}`);
process.exit(job.status === 'succeeded' ? 0 : 1);
