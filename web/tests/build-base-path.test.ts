import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyManifestBase } from '../scripts/manifest-base';

/**
 * The deploy prefix is invisible until it is wrong (T66).
 *
 * Behind the sig-infra Caddy route the browser loads the app from
 * `/golf-map/`, so every URL the BROWSER resolves — hashed asset srcs, the
 * manifest link, the manifest's own scope/icons — must carry that prefix, while
 * the bun server behind `handle_path` keeps seeing rooted paths. Nothing in the
 * unit suites exercises that: it is produced by `vite build`'s `base`, which no
 * test would otherwise touch. A regression drops the app to a blank page with
 * 404s on its own bundles, and only on the VPS.
 *
 * So this runs the real build twice into throwaway dirs and reads the output.
 */

const WEB_ROOT = join(import.meta.dir, '..');

let outRoot: string;

/** Runs `vite build --outDir <dir>` and returns the built artefacts. */
function buildInto(dir: string, env: Record<string, string>) {
    const result = Bun.spawnSync(['bunx', 'vite', 'build', '--outDir', dir, '--emptyOutDir'], {
        cwd: WEB_ROOT,
        env: { ...process.env, ...env },
        stdout: 'pipe',
        stderr: 'pipe',
    });
    if (result.exitCode !== 0) {
        throw new Error(`vite build failed:\n${result.stderr.toString()}`);
    }
    return {
        index: readFileSync(join(dir, 'index.html'), 'utf8'),
        mobile: readFileSync(join(dir, 'mobile.html'), 'utf8'),
        manifest: JSON.parse(readFileSync(join(dir, 'm', 'manifest.webmanifest'), 'utf8')),
    };
}

let prefixed: ReturnType<typeof buildInto>;
let rooted: ReturnType<typeof buildInto>;

beforeAll(() => {
    outRoot = mkdtempSync(join(tmpdir(), 'golf-map-build-base-'));
    // Default build → the sig-infra deploy prefix. Note NODE_ENV is 'test'
    // here (bun test sets it) and the prefix must appear anyway: the base is
    // keyed on vite's `command`, not on NODE_ENV, precisely so an inherited
    // NODE_ENV cannot silently produce a root-based bundle.
    prefixed = buildInto(join(outRoot, 'prefixed'), {});
    // WEB_BASE escape hatch → a box serving at the origin root.
    rooted = buildInto(join(outRoot, 'rooted'), { WEB_BASE: '/' });
}, 180_000);

afterAll(() => {
    if (outRoot && existsSync(outRoot)) rmSync(outRoot, { recursive: true, force: true });
});

/** Every `src=`/`href=` in the document that points at the same origin. */
function localUrls(html: string): string[] {
    return [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
        .map((m) => m[1]!)
        .filter((u) => !u.startsWith('http'));
}

describe('production build carries the deploy base path', () => {
    test('both html entries reference /golf-map/-prefixed assets', () => {
        for (const html of [prefixed.index, prefixed.mobile]) {
            const urls = localUrls(html);
            expect(urls.length).toBeGreaterThan(0);
            // No same-origin URL may escape the prefix — a single bare
            // "/assets/..." is a 404 on the VPS.
            for (const url of urls) expect(url.startsWith('/golf-map/')).toBe(true);
            expect(urls.some((u) => u.startsWith('/golf-map/assets/'))).toBe(true);
        }
    });

    test('the mobile entry links the manifest and icon under the prefix', () => {
        expect(prefixed.mobile).toContain('href="/golf-map/m/manifest.webmanifest"');
        expect(prefixed.mobile).toContain('href="/golf-map/m/icon-192.png"');
    });

    test('the emitted manifest scope, start_url and icons carry the prefix', () => {
        expect(prefixed.manifest.scope).toBe('/golf-map/m');
        expect(prefixed.manifest.start_url).toBe('/golf-map/m');
        expect(prefixed.manifest.id).toBe('/golf-map/m');
        expect(prefixed.manifest.icons.map((i: { src: string }) => i.src)).toEqual([
            '/golf-map/m/icon-192.png',
            '/golf-map/m/icon-512.png',
        ]);
    });

    test('scope covers the bare /m route, not just /m/', () => {
        // guardMobileRoute redirects to MOBILE_ROOT === '/m' (no trailing
        // slash). A scope of '/golf-map/m/' would put the app's own landing
        // route out of scope and bounce a standalone launch into the browser —
        // which is why the manifest keeps absolute paths instead of relative.
        expect(prefixed.manifest.scope.endsWith('/')).toBe(false);
        expect('/golf-map/m'.startsWith(prefixed.manifest.scope)).toBe(true);
        expect('/golf-map/m/course/x'.startsWith(prefixed.manifest.scope)).toBe(true);
    });

    test('WEB_BASE=/ still builds a root-mounted app', () => {
        for (const url of localUrls(rooted.index)) expect(url.startsWith('/golf-map/')).toBe(false);
        expect(rooted.index).toMatch(/src="\/assets\/[^"]+\.js"/);
        expect(rooted.manifest.scope).toBe('/m');
        expect(rooted.manifest.icons[0].src).toBe('/m/icon-192.png');
    });
});

describe('applyManifestBase', () => {
    const source = readFileSync(join(WEB_ROOT, 'public', 'm', 'manifest.webmanifest'), 'utf8');

    test("a base of '/' is a byte-for-byte no-op", () => {
        expect(applyManifestBase(source, '/')).toBe(source);
        expect(applyManifestBase(source, '')).toBe(source);
    });

    test('applies the prefix to every root-absolute URL member', () => {
        const out = JSON.parse(applyManifestBase(source, '/golf-map/'));
        expect(out.scope).toBe('/golf-map/m');
        expect(out.start_url).toBe('/golf-map/m');
        expect(out.icons.map((i: { src: string }) => i.src)).toEqual([
            '/golf-map/m/icon-192.png',
            '/golf-map/m/icon-512.png',
        ]);
    });

    test('leaves non-URL members and relative URLs alone', () => {
        const out = JSON.parse(
            applyManifestBase(
                JSON.stringify({ name: '/not/a/url is fine', scope: 'relative', theme_color: '#14281c' }),
                '/golf-map/',
            ),
        );
        expect(out.name).toBe('/not/a/url is fine');
        expect(out.scope).toBe('relative');
        expect(out.theme_color).toBe('#14281c');
    });
});
