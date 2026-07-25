/**
 * Rewrite the PWA manifest's root-absolute URLs for a deploy base path (T66).
 *
 * `public/m/manifest.webmanifest` is a static file: vite copies it to `dist/`
 * verbatim and does NOT apply `base` to JSON contents the way it does to html
 * attributes. Served at https://app.swedenindoorgolf.se/golf-map/m/ its
 * `"scope": "/m"` would point at the origin root, so an installed app would
 * either fail to install or immediately navigate out of scope into the browser.
 *
 * Relative URLs ("." / "icon-192.png") were the tempting fix, but they resolve
 * against the manifest's DIRECTORY — `/golf-map/m/` WITH a trailing slash —
 * and `/m` (no slash) is a real route: the mobile course list, and the value
 * `guardMobileRoute` redirects to (src/mobile/guard.ts MOBILE_ROOT). A scope of
 * `/golf-map/m/` excludes it, which is exactly the standalone-window bug this
 * is meant to avoid. So the paths stay root-absolute and get the prefix applied
 * at build time instead.
 *
 * Kept as a pure string→string function so it is unit-tested without running a
 * build; `vite.config.ts` wraps it in a plugin that rewrites the emitted file.
 */

/** Manifest members whose value is a single URL that may be root-absolute. */
const URL_MEMBERS = ['id', 'start_url', 'scope'] as const;

/**
 * Applies `base` (vite's, e.g. '/golf-map/' or '/') to every root-absolute URL
 * in a web app manifest. A base of '/' (or '') is a no-op and returns the
 * source unchanged, so dev and a root-mounted deploy keep the committed file
 * byte for byte.
 */
export function applyManifestBase(source: string, base: string): string {
    const prefix = base.replace(/\/+$/, '');
    if (!prefix) return source;

    const manifest = JSON.parse(source) as Record<string, unknown>;
    const prefixed = (value: unknown): unknown =>
        typeof value === 'string' && value.startsWith('/') ? prefix + value : value;

    for (const key of URL_MEMBERS) {
        if (key in manifest) manifest[key] = prefixed(manifest[key]);
    }
    for (const key of ['icons', 'screenshots', 'shortcuts']) {
        const list = manifest[key];
        if (!Array.isArray(list)) continue;
        manifest[key] = list.map((entry: Record<string, unknown>) => ({
            ...entry,
            ...(entry.src !== undefined ? { src: prefixed(entry.src) } : {}),
            ...(entry.url !== undefined ? { url: prefixed(entry.url) } : {}),
        }));
    }

    return JSON.stringify(manifest, null, 4) + '\n';
}
