// Client for the Unity editor bridge (unity/Editor/GolfMapBridge).
//
// Every open editor with the bridge installed publishes
// %LOCALAPPDATA%/GolfMapBridge/bridge-<pid>.json (port, token, project path).
// Nothing here is tied to a course: tools pick an editor by project name or
// path, and default to the only one open.
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

export interface BridgeInfo {
  pid: number;
  port: number;
  token: string;
  projectPath: string;
  projectName: string;
  unityVersion: string;
  started: string;
  file: string;
}

export interface BridgeResponse {
  ok: boolean;
  result?: any;
  error?: string;
  stack?: string;
  pending?: boolean;
  job?: string;
  consoleSeq?: number;
}

export function discoveryDir(): string {
  const base = process.env.GOLFMAP_BRIDGE_DIR ?? join(process.env.LOCALAPPDATA ?? join(process.env.HOME ?? ".", ".local"), "GolfMapBridge");
  return base;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === "EPERM";
  }
}

// Open editors. Files left behind by a crashed editor are removed.
export function listBridges(dir = discoveryDir()): BridgeInfo[] {
  if (!existsSync(dir)) return [];
  const out: BridgeInfo[] = [];
  for (const name of readdirSync(dir)) {
    if (!/^bridge-\d+\.json$/.test(name)) continue;
    const file = join(dir, name);
    try {
      const info = { ...JSON.parse(readFileSync(file, "utf8")), file } as BridgeInfo;
      if (alive(info.pid)) out.push(info);
      else rmSync(file, { force: true });
    } catch {
      // Being rewritten by the editor right now; the next call sees it.
    }
  }
  return out.sort((a, b) => a.projectName.localeCompare(b.projectName));
}

const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

// `project`: a project folder name or path (or a unique substring of either).
export function pickBridge(project?: string, dir = discoveryDir()): BridgeInfo {
  const all = listBridges(dir);
  const describe = () => all.map((b) => `${b.projectName} (${b.projectPath}, Unity ${b.unityVersion})`).join("; ") || "none";
  if (!project) {
    if (all.length === 1) return all[0];
    if (all.length === 0) throw new Error("No Unity editor with the bridge is open. Open the course project in Unity (the bridge starts with it), or install it with unity_sync.");
    throw new Error(`Several editors are open; pass project. Open: ${describe()}`);
  }
  const q = norm(project);
  const exact = all.filter((b) => norm(b.projectPath) === q || b.projectName.toLowerCase() === q);
  if (exact.length === 1) return exact[0];
  const partial = all.filter((b) => norm(b.projectPath).includes(q));
  if (partial.length === 1) return partial[0];
  throw new Error(`No single open editor matches '${project}'. Open: ${describe()}`);
}

// Re-reads the discovery file: a reload may have moved the bridge to another port.
function refreshInfo(b: BridgeInfo): BridgeInfo {
  try {
    return { ...JSON.parse(readFileSync(b.file, "utf8")), file: b.file };
  } catch {
    return b;
  }
}

async function request(b: BridgeInfo, method: string, path: string, body: unknown, timeoutSec: number): Promise<BridgeResponse> {
  const res = await fetch(`http://127.0.0.1:${b.port}${path}`, {
    method,
    headers: { "X-Bridge-Token": b.token, "X-Bridge-Timeout": String(timeoutSec), "Content-Type": "application/json" },
    body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
    signal: AbortSignal.timeout((timeoutSec + 15) * 1000),
  });
  return (await res.json()) as BridgeResponse;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Connection refused while the editor process lives = scripts reloading. Wait it out.
async function withReloadRetry<T>(b: BridgeInfo, waitSec: number, fn: (b: BridgeInfo) => Promise<T>): Promise<T> {
  const deadline = Date.now() + waitSec * 1000;
  for (;;) {
    try {
      return await fn(b);
    } catch (e: any) {
      const refused = e?.code === "ConnectionRefused" || /ECONNREFUSED|Unable to connect|ConnectionRefused|socket/i.test(String(e?.message ?? e));
      if (!refused || Date.now() > deadline || !alive(b.pid)) throw e;
      await sleep(500);
      b = refreshInfo(b);
    }
  }
}

export async function status(b: BridgeInfo, waitSec = 0): Promise<any | null> {
  try {
    const r = await withReloadRetry(b, waitSec, (x) => request(x, "GET", "/status", undefined, 5));
    return r.ok ? r.result : null;
  } catch {
    return null; // reloading
  }
}

// Runs a bridge command. Commands that outlive `timeoutSec` per request are polled until `totalSec`.
export async function call(b: BridgeInfo, command: string, args: Record<string, unknown> = {}, totalSec = 120): Promise<BridgeResponse> {
  const deadline = Date.now() + totalSec * 1000;
  const perRequest = Math.max(1, Math.min(60, totalSec));
  let r = await withReloadRetry(b, 60, (x) => request(x, "POST", `/cmd/${encodeURIComponent(command)}`, args, perRequest));
  while (r.pending && r.job && Date.now() < deadline) {
    const job = r.job;
    r = await withReloadRetry(b, 60, (x) => request(x, "GET", `/job/${job}`, undefined, perRequest));
  }
  return r;
}

export async function run(b: BridgeInfo, command: string, args: Record<string, unknown> = {}, totalSec = 120): Promise<any> {
  const r = await call(b, command, args, totalSec);
  if (r.ok) return r.result;
  if (r.pending) throw new Error(`'${command}' is still running in Unity (job ${r.job}). Check unity_status; it keeps going in the editor.`);
  throw new Error(r.error + (r.stack ? `\n${r.stack}` : ""));
}

export interface CompileOutcome {
  outcome: "reloaded" | "failed" | "nothing-to-compile" | "timeout";
  errors: { file: string; line: number; message: string }[];
  seconds: number;
}

// AssetDatabase.Refresh, then follow the compile: a successful one reloads the
// domain (new domainStarted), a failed one leaves the old domain up with errors.
export async function refreshAndCompile(b: BridgeInfo, timeoutSec = 180): Promise<CompileOutcome> {
  const t0 = Date.now();
  const before = await status(b, 30);
  if (!before) throw new Error("The bridge is not answering.");
  await run(b, "refresh", {}, 120);
  let sawCompiling = false;
  let idleSince = Date.now();
  let outcome: CompileOutcome["outcome"] = "timeout";
  while (Date.now() - t0 < timeoutSec * 1000) {
    await sleep(500);
    b = refreshInfo(b);
    const s = await status(b);
    if (!s) {
      sawCompiling = true; // mid-reload
      idleSince = Date.now();
      continue;
    }
    if (s.domainStarted !== before.domainStarted) {
      if (!s.compiling && !s.updating) {
        outcome = "reloaded";
        break;
      }
      continue;
    }
    if (s.compiling || s.updating) {
      sawCompiling = true;
      idleSince = Date.now();
      continue;
    }
    // Compile finished without a reload = errors. Never started within a few seconds = nothing changed.
    if (sawCompiling && Date.now() - idleSince > 1500) {
      outcome = "failed";
      break;
    }
    if (!sawCompiling && Date.now() - idleSince > 5000) {
      outcome = "nothing-to-compile";
      break;
    }
  }
  const compile = await run(b, "compile", {}, 30);
  const errors: CompileOutcome["errors"] = [];
  for (const asm of Object.values<any>(compile.assemblies ?? {}))
    for (const m of asm.messages ?? []) if (m.type === "error") errors.push({ file: m.file, line: m.line, message: m.message });
  if (errors.length && outcome !== "timeout") outcome = "failed";
  return { outcome, errors, seconds: Math.round((Date.now() - t0) / 100) / 10 };
}
