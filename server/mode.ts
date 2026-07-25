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
export function serverMode(): ServerMode {
    return process.env.SERVER_MODE === 'serve' ? 'serve' : 'builder';
}
