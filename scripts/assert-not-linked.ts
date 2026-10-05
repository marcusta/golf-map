// Guard: fail while `@basics/core` is `bun link`ed (live framework work).
// The framework is a vendored tarball; never commit or run `test` against a link.
import { lstatSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const linked: string[] = [];

for (const dir of [root, join(root, "server"), join(root, "web")]) {
    const p = join(dir, "node_modules", "@basics", "core");
    try {
        // A normal bun install is also a symlink (into node_modules/.bun/);
        // a `bun link` points outside the repo's node_modules. Junctions report as symlinks.
        if (lstatSync(p).isSymbolicLink()) {
            const target = realpathSync(p).replaceAll("\\", "/").toLowerCase();
            const store = join(root, "node_modules", ".bun").replaceAll("\\", "/").toLowerCase();
            if (!target.startsWith(`${store}/`)) linked.push(`${p} -> ${realpathSync(p)}`);
        }
    } catch {
        // not installed here
    }
}

if (linked.length > 0) {
    console.error(
        `@basics/core is linked (bun link):\n${linked.map((p) => `  ${p}`).join("\n")}\n` +
            "Unlink it (bun install, or `bun run fw:update`) before committing or testing.",
    );
    process.exit(1);
}
