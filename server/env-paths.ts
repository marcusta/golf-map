// Bun on Windows (1.3.x) throws EEXIST from `mkdirSync(p, { recursive: true })`
// when `p` is a relative path through `..` that already exists, e.g. the
// `DATA_DIR=../data` the dev script passes. Absolute paths are fine. Resolve the
// data-path env vars before `@basics/core/server/config` reads them, so every
// mkdir/open downstream sees an absolute path. Imported first from main.ts and
// the CLI scripts that open the DB (photos-pull, publish); ES
// module evaluation order guarantees it runs before the config module.
import * as path from 'node:path';

for (const key of ['DATA_DIR', 'DB_PATH', 'SESSION_DB_PATH', 'OBS_DB_PATH', 'WEB_DIST_DIR'] as const) {
    const value = process.env[key];
    if (value && !path.isAbsolute(value)) process.env[key] = path.resolve(value);
}
