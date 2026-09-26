import * as path from 'node:path';

/**
 * The repo's `pipeline/` folder — gspro.py, golfpipe and their venv — found
 * from this file's location, not the process's working directory: the server
 * runs from the repo root (`bun run start`, `bun run dev`) as well as from
 * `server/` (`dev:server`), and a cwd-relative `../pipeline` pointed past the
 * repo from the root. `MAP_PIPELINE_DIR` still overrides it per service.
 */
export const DEFAULT_PIPELINE_DIR = path.resolve(import.meta.dir, '..', '..', 'pipeline');
