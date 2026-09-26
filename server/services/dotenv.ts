import * as path from 'node:path';
import { readFileSync } from 'node:fs';

/**
 * Parse KEY=VALUE lines the way pipeline/golfpipe/__main__.py _load_dotenv
 * does: blank/comment/`=`-less lines skipped, values stripped of quotes.
 */
export function parseDotenv(text: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const rawLine of text.split('\n')) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#') || !line.includes('=')) continue;
        const idx = line.indexOf('=');
        const key = line.slice(0, idx).trim();
        const value = line.slice(idx + 1).trim().replace(/^['"]|['"]$/g, '');
        if (key && value) out[key] = value;
    }
    return out;
}

/** server/.env, then the repo root's .env — located from this file, not the cwd. */
export const DOTENV_FILES = [
    path.resolve(import.meta.dir, '..', '.env'),
    path.resolve(import.meta.dir, '..', '..', '.env'),
];

/**
 * `keys` from the process env, each falling back to the first of `files` that
 * sets it. Bun only auto-loads the .env in the cwd, but scripts run from
 * server/ and the dev server from the repo root, and a box may keep the publish
 * settings in either file (server/.env on the Mac, the root .env on Windows).
 */
export function envWithDotenvFallback<K extends string>(
    keys: readonly K[],
    opts: { env?: Record<string, string | undefined>; files?: readonly string[] } = {},
): Partial<Record<K, string>> {
    const env = opts.env ?? process.env;
    const out: Partial<Record<K, string>> = {};
    for (const key of keys) if (env[key]) out[key] = env[key];
    for (const file of opts.files ?? DOTENV_FILES) {
        if (keys.every((k) => out[k])) break;
        let parsed: Record<string, string>;
        try {
            parsed = parseDotenv(readFileSync(file, 'utf8'));
        } catch {
            continue; // no .env there
        }
        for (const key of keys) out[key] ||= parsed[key];
    }
    return out;
}
