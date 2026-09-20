/**
 * Provisioning CLI: imports a generated terrain-edits file (the pipeline's
 * D-TE5 handoff — `golfpipe building-pads` output) into a site's
 * terrain_edits under one origin, replacing that origin's previous
 * generation and nothing else. Buildings the user had disabled stay
 * disabled (matched by originRef).
 *
 * Usage:
 *   bun run import-terrain-edits <site id or name> <edits.geojson> [origin]
 *
 * origin defaults to the file's own `origin` property (building-pads).
 * Connects directly to config.dbPath like create-user.
 */
import * as path from 'node:path';
import { config } from '@basics/core/server/config';
import { createDb } from '@basics/core/server/db';
import { runMigrations } from '@basics/core/server/migrate';
import type { Database } from './schema';
import { SitesService } from '../services/sites.service';
import { TerrainEditsService, parseEditsGeojson } from '../services/terrain-edits.service';

async function main() {
    const [siteArg, file, originArg] = Bun.argv.slice(2);
    if (!siteArg || !file) {
        console.error('Usage: bun run import-terrain-edits <site id or name> <edits.geojson> [origin]');
        process.exit(1);
    }

    const doc = JSON.parse(await Bun.file(file).text()) as { features?: { properties?: { origin?: string } }[] };
    const origin = originArg ?? doc.features?.find(f => f.properties?.origin)?.properties?.origin;
    if (!origin) {
        console.error('No origin: pass one as the third argument (the file carries none)');
        process.exit(1);
    }

    const db = createDb<Database>(config.dbPath);
    await runMigrations(db, path.join(import.meta.dir, 'migrations'));
    try {
        const sites = await new SitesService(db).list();
        const site = sites.find(s => s.id === siteArg) ?? sites.find(s => s.name === siteArg);
        if (!site) {
            console.error(`No site ${JSON.stringify(siteArg)}; sites: ${sites.map(s => `${s.name} (${s.id})`).join(', ') || '(none)'}`);
            process.exit(1);
        }
        const { edits, skipped } = parseEditsGeojson(doc);
        for (const note of skipped) console.warn(`skipped ${note}`);
        const svc = new TerrainEditsService(db);
        const before = (await svc.listBySite(site.id)).filter(e => e.origin === origin).length;
        const imported = await svc.replaceByOrigin(site.id, origin, edits);
        const disabled = imported.filter(e => !e.enabled).length;
        console.log(`Imported ${imported.length} ${origin} edit(s) for site ${site.name} (replaced ${before}`
            + (disabled ? `, ${disabled} kept disabled` : '') + `)`);
    } finally {
        await db.destroy();
    }
}

await main();
