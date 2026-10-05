// `bun run py <script|-m module> [args]` — the one way to run pipeline Python.
import { join, resolve } from "node:path";

const pipeline = resolve(import.meta.dir, "..", "pipeline");
const python = join(pipeline, ".venv", "Scripts", "python.exe");

const proc = Bun.spawn([python, ...process.argv.slice(2)], {
    cwd: pipeline,
    env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    stdio: ["inherit", "inherit", "inherit"],
});
process.exit(await proc.exited);
