/**
 * Guards the sig-infra deploy contract.
 *
 * sig-infra's `service_create` writes a systemd unit with `ExecStart=<start
 * command>` and `Environment=NODE_ENV=production` — and nothing else. Every
 * other setting this service needs therefore lives in the `start:vps` script,
 * which is what the unit runs, so a `git pull` + restart always brings the
 * right environment with it and no hand-edited unit can drift from the repo.
 *
 * These assertions pin the values that silently break a deploy when wrong:
 * a PORT that disagrees with `deploy.json`'s health check makes `deploy.ts`
 * treat a healthy release as failed and roll it back; a missing
 * SERVER_MODE=serve exposes every builder route on the VPS; body/timeout
 * limits below the bundle size make publish fail at the edge.
 */
import { describe, expect, test } from 'bun:test';
import * as path from 'node:path';

const repoRoot = path.resolve(import.meta.dir, '..');
const pkg = await Bun.file(path.join(repoRoot, 'package.json')).json();
const deployJson = await Bun.file(path.join(repoRoot, 'deploy.json')).json();

const vpsScript: string = pkg.scripts['start:vps'] ?? '';

/** Extracts `KEY=value` assignments from the script's env prefix. */
function envOf(script: string): Record<string, string> {
    const env: Record<string, string> = {};
    for (const token of script.split(/\s+/)) {
        const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(token);
        if (!m) break; // first non-assignment token is the command itself
        env[m[1]] = m[2];
    }
    return env;
}

describe('start:vps (sig-infra unit entrypoint)', () => {
    const env = envOf(vpsScript);

    test('exists and runs the server', () => {
        expect(vpsScript).toContain('bun server/main.ts');
    });

    test('runs in serve mode — builder routes must not exist on the VPS', () => {
        expect(env.SERVER_MODE).toBe('serve');
    });

    test('PORT matches the port deploy.json health-checks', () => {
        const healthPort = /localhost:(\d+)/.exec(deployJson.healthCheck ?? '')?.[1];
        expect(healthPort).toBeDefined();
        expect(env.PORT).toBe(healthPort ?? '');
    });

    test('DB paths match the database deploy.json migrates', () => {
        expect(env.DB_PATH).toBe(`./${deployJson.database.path}`);
        expect(env.DATA_DIR).toBe(`./${path.dirname(deployJson.database.path)}`);
    });

    test('body limit and timeout fit a publish bundle', () => {
        // Bundles run 60–80 MB; framework defaults are 1 MB / 30 s.
        expect(Number(env.BODY_LIMIT)).toBeGreaterThanOrEqual(128 * 1024 * 1024);
        expect(Number(env.REQUEST_TIMEOUT)).toBeGreaterThanOrEqual(300_000);
    });

    test('serves the built web app from the checkout', () => {
        expect(env.WEB_DIST_DIR).toBe('./web/dist');
    });
});
