import { defineConfig, devices } from '@playwright/test';
import * as path from 'node:path';

/**
 * T20 — the project's first E2E smoke harness. LOCAL only (no CI wiring this
 * round). `bun run e2e` from the repo root boots an ISOLATED, freshly-seeded
 * API + the web dev server, logs in as the seed user once (storageState), and
 * runs a small durable smoke suite against http://localhost:5273.
 *
 * Ports are deliberately OFF the dev defaults (API 3100 not 3000, web 5273 not
 * 5173) so a running dev environment doesn't collide with the harness. The web
 * dev server proxies /api + /tiles to the isolated API via API_PROXY_TARGET
 * (see web/vite.config.ts).
 */

export const E2E_API_PORT = 3100;
export const E2E_WEB_PORT = 5273;
export const E2E_BASE_URL = `http://localhost:${E2E_WEB_PORT}`;

const repoRoot = path.join(__dirname, '..');
const tmpDir = path.join(__dirname, '.tmp');

// Isolated DB paths — seeded fresh in global-setup, never the dev data/*.sqlite.
export const E2E_DB_PATH = path.join(tmpDir, 'e2e-app.sqlite');
const E2E_SESSION_DB = path.join(tmpDir, 'e2e-sessions.sqlite');
const E2E_OBS_DB = path.join(tmpDir, 'e2e-obs.sqlite');
export const E2E_STORAGE_STATE = path.join(tmpDir, 'storage-state.json');

export default defineConfig({
    testDir: path.join(__dirname, 'tests'),
    // Keep artifacts under e2e/ (gitignored) rather than the repo root.
    outputDir: path.join(__dirname, 'test-results'),
    // Serial: the flows share one seeded DB and mutate the plan (autosave).
    // A tiny smoke suite doesn't need parallelism and stays deterministic.
    fullyParallel: false,
    workers: 1,
    forbidOnly: !!process.env.CI,
    retries: 0,
    reporter: [['list']],
    timeout: 60_000,
    expect: { timeout: 15_000 },

    use: {
        baseURL: E2E_BASE_URL,
        trace: 'retain-on-failure',
        // MapLibre WebGL needs a real GPU-ish context; headless chromium with
        // SwiftShader handles it. Give actions room — the map inits async.
        actionTimeout: 15_000,
    },

    projects: [
        // Login runs first (after webServers are up) and persists the session
        // cookie to storageState; every smoke test starts authenticated.
        { name: 'setup', testMatch: /auth\.setup\.ts$/ },
        {
            name: 'chromium',
            use: { ...devices['Desktop Chrome'], storageState: E2E_STORAGE_STATE },
            dependencies: ['setup'],
        },
    ],

    webServer: [
        {
            // Isolated API server. Playwright starts webServers BEFORE running
            // globalSetup, so seeding must happen HERE, inline, before main.ts
            // opens the DB — otherwise the seed rewrites the file under the
            // server's open handle and reads hit a "disk I/O error". Chaining
            // `seed && main.ts` guarantees a fully-migrated, seeded, self-
            // contained sqlite exists before the server ever opens it.
            command: `bun db/seed-e2e.ts "${E2E_DB_PATH}" && bun main.ts`,
            cwd: path.join(repoRoot, 'server'),
            port: E2E_API_PORT,
            reuseExistingServer: false,
            stdout: 'pipe',
            stderr: 'pipe',
            timeout: 30_000,
            env: {
                PORT: String(E2E_API_PORT),
                DATA_DIR: path.join(repoRoot, 'data'),
                DB_PATH: E2E_DB_PATH,
                SESSION_DB_PATH: E2E_SESSION_DB,
                OBS_DB_PATH: E2E_OBS_DB,
                CROSS_ORIGIN_RESOURCE_POLICY: 'same-site',
            },
        },
        {
            // Web dev server (vite), proxying /api + /tiles to the isolated API.
            command: 'bunx vite',
            cwd: path.join(repoRoot, 'web'),
            port: E2E_WEB_PORT,
            reuseExistingServer: false,
            stdout: 'pipe',
            stderr: 'pipe',
            timeout: 30_000,
            env: {
                PORT: String(E2E_WEB_PORT),
                API_PROXY_TARGET: `http://localhost:${E2E_API_PORT}`,
            },
        },
    ],
});
