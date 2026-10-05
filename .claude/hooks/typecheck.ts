// Stop hook: typecheck server + web when .ts files under server/, web/ or shared/ changed.
// Exit 2 with the compiler output on stderr so Claude sees and fixes the errors.
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..", "..");

let input: { stop_hook_active?: boolean } = {};
try {
    input = JSON.parse(await Bun.stdin.text());
} catch {
    // no/invalid stdin: carry on
}
if (input.stop_hook_active) process.exit(0);

const status = Bun.spawnSync(["git", "status", "--porcelain", "-uall"], { cwd: root });
const touched = status.stdout
    .toString()
    .split("\n")
    .map((l) => l.slice(3).trim().replace(/^"|"$/g, "").split(" -> ").pop()!)
    .some((f) => f.endsWith(".ts") && /^(server|web|shared)\//.test(f));
if (!touched) process.exit(0);

const failures: string[] = [];
for (const [script, dir] of [
    ["check:server", "server"],
    ["check:client", "web"],
] as const) {
    const r = Bun.spawnSync(["bun", "run", script], { cwd: resolve(root, dir) });
    if (r.exitCode !== 0) {
        failures.push(`$ bun run ${script} (cwd ${dir})\n${r.stdout}${r.stderr}`);
    }
}

if (failures.length > 0) {
    console.error(`Typecheck failed:\n\n${failures.join("\n")}`);
    process.exit(2);
}
