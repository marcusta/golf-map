import { ORTHO_IMPORT_MAX_BYTES } from '../shared/ortho-import';

/**
 * Server run mode (T59 — Local Builder / VPS Serve split).
 *
 *  - `builder` (default): the full local stack — map-build, ortho patches,
 *    hydro/OSM fetch, terrain edits, plus every runtime API. Owns all raw data.
 *  - `serve`: the lean VPS — runtime APIs + tile serving + the `ingest`
 *    endpoint only. Builder-only routes are simply not mounted (they 404), and
 *    builder-only boot work (map-build orphan reconcile) is skipped so a box
 *    without `sources/`, `models/`, or the pipeline never stats missing files.
 *
 * One codebase, one deploy: `bun main.ts` with `SERVER_MODE` set per box.
 */
export type ServerMode = 'builder' | 'serve';

/** Reads the mode from `SERVER_MODE`; anything other than `serve` is `builder`. */
export function serverMode(env: Record<string, string | undefined> = process.env): ServerMode {
    return env.SERVER_MODE === 'serve' ? 'serve' : 'builder';
}

/**
 * Raises `BODY_LIMIT` to the ortho import cap in builder mode; never lowers
 * it, and leaves serve mode alone. Called from `env-builder.ts` before the
 * framework config reads the variable.
 */
export function raiseBuilderBodyLimit(env: Record<string, string | undefined> = process.env): void {
    if (serverMode(env) !== 'builder') return;
    const current = Number(env.BODY_LIMIT ?? '0');
    if (!(current >= ORTHO_IMPORT_MAX_BYTES)) env.BODY_LIMIT = String(ORTHO_IMPORT_MAX_BYTES);
}
