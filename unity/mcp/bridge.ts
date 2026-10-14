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
  /** The command lost its job to a script reload and was submitted a second time (see `call`). */
  retried?: boolean;
  /** The editor hit VSP's stalled job lists, ran `golfmap.vsp.reset` and ran the command again. */
  vspReset?: boolean;
  /** VSP's job lists were stalled and the command was NOT run again (the error says why). */
  vspStall?: boolean;
  /** `save: true`: what the editor saved once the command had succeeded, or why it did not. */
  saved?: { scenes?: string[]; seconds?: number; skippedScenes?: string[]; skipped?: string; failed?: string };
}

export function discoveryDir(): string {
  const base = process.env.GOLFMAP_BRIDGE_DIR ?? join(process.env.LOCALAPPDATA ?? join(process.env.HOME ?? ".", ".local"), "GolfMapBridge");
  return base;
}

// Is that process still there? Used for discovery files left by a crashed editor, and by
// build-status.ts for a course build whose editor went down mid-build.
export function alive(pid: number): boolean {
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

// Waits for the bridge to answer and the editor to be idle again after a script
// reload. The editor restarts the listener on the same port and token when the new
// domain loads (another port only if that one was taken meanwhile), so the discovery
// file is re-read every poll. Returns the live info, or null when it never came back
// within `waitSec` or the editor is gone.
export async function waitForBridge(b: BridgeInfo, waitSec: number): Promise<BridgeInfo | null> {
  const deadline = Date.now() + waitSec * 1000;
  for (;;) {
    const info = refreshInfo(b);
    const s = await status(info);
    if (s && !s.compiling && !s.updating) return info;
    if (Date.now() >= deadline || !alive(info.pid)) return null;
    await sleep(500);
  }
}

// The editor's own words when a command's job did not survive the domain reload its
// AssetDatabase.Refresh set off (BridgeServer.cs: Route's /job lookup, Stop's queue
// drain). The command usually ran to its end in the old domain, but its result is gone.
//
// A job id is "<domainStamp>-<n>" (/status publishes the live stamp as jobStamp), so an id
// we were polling across a reload belongs to a domain that no longer exists and reads as
// "Unknown job" here - it can no longer collide with the new domain's own job 1.
const LOST_TO_RELOAD = /Unknown job \(jobs do not survive a script reload\)|The editor is reloading scripts; call again/i;

// Only our own commands are resubmitted on their own (see `call`): golfmap.* is idempotent by
// design, while `menu`, `selection`, `screenshot` or a project's own command may not be.
const RESUBMITTABLE = /^golfmap\./;

// One submission: POST the command, then poll its job until it finishes or `totalSec` runs out.
async function submit(b: BridgeInfo, command: string, args: Record<string, unknown>, totalSec: number): Promise<BridgeResponse> {
  const deadline = Date.now() + totalSec * 1000;
  const perRequest = Math.max(1, Math.min(60, totalSec));
  let r = await withReloadRetry(b, 60, (x) => request(x, "POST", `/cmd/${encodeURIComponent(command)}`, args, perRequest));
  while (r.pending && r.job && Date.now() < deadline) {
    const job = r.job;
    r = await withReloadRetry(b, 60, (x) => request(x, "GET", `/job/${job}`, undefined, perRequest));
  }
  return r;
}

// Runs a bridge command. Commands that outlive `timeoutSec` per request are polled
// until `totalSec`. A command that took the domain down with it (a refresh that
// compiles something, e.g. golfmap.meshes.sync right after a unity_sync push) ends
// as a lost job; the bridge is waited for (up to `reloadWaitSec`) and the same
// command is submitted once more, with `retried` set on the response.
//
// Resubmitting is safe because every command of OURS is idempotent by design: sync
// and refresh steps re-read the scene and the exported files and do only what is
// still missing, so running one twice costs time, never correctness. That is a
// promise golfmap.* commands make (mcp/README.md, "Adding a command") and nothing
// else does, so anything else gets the lost-job error with `retried: false` and is
// left to the caller - a `menu` item or a project's own command may well not be
// idempotent, and this is the last place that could tell.
export async function call(
  b: BridgeInfo,
  command: string,
  args: Record<string, unknown> = {},
  totalSec = 120,
  reloadWaitSec = 90,
): Promise<BridgeResponse> {
  const first = await submit(b, command, args, totalSec);
  if (first.ok || first.pending || !LOST_TO_RELOAD.test(first.error ?? "")) return first;
  if (!RESUBMITTABLE.test(command))
    return {
      ...first,
      retried: false,
      error: `${first.error} '${command}' is not a golfmap.* command, so it was not submitted again (only ours promise to be idempotent). It may well have run to its end in the old domain: check unity_console / unity_scene before calling it once more.`,
    };
  const back = await waitForBridge(b, reloadWaitSec);
  if (!back)
    return { ...first, error: `${first.error} The bridge did not come back within ${reloadWaitSec} s, so '${command}' was not submitted again.` };
  const second = await submit(back, command, args, totalSec);
  second.retried = true;
  return second;
}

export async function run(b: BridgeInfo, command: string, args: Record<string, unknown> = {}, totalSec = 120): Promise<any> {
  const r = await call(b, command, args, totalSec);
  // Logged (stderr) as well as reported in the result: callers that see only the
  // result still get the line (server/services/unity-bridge.ts wraps run()).
  if (r.retried) console.error(`[bridge] '${command}' lost its job to a script reload; submitted again once (${r.ok ? "ok" : "failed again"}).`);
  if (r.vspReset) console.error(`[bridge] '${command}' ran again after golfmap.vsp.reset (VSP's job lists were stalled).`);
  if (r.ok) {
    if (r.retried && r.result && typeof r.result === "object" && !Array.isArray(r.result) && r.result.retried === undefined) r.result.retried = true;
    return r.result;
  }
  if (r.pending) throw new Error(`'${command}' is still running in Unity (job ${r.job}). Check unity_status; it keeps going in the editor.`);
  throw new Error(
    r.error +
      (r.stack ? `\n${r.stack}` : "") +
      (r.retried ? "\n(the command was submitted a second time after a script reload and failed again)" : ""),
  );
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
