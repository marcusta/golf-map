// Keeps the repo's Unity scripts and a course project's copy in step.
//
// The repo is the source of truth, but the Unity copy is sometimes edited in
// place (by the user or another agent), so a plain copy could lose work. Each
// project keeps a base: the content hash of every file as of the last sync,
// in <project>/Library/GolfMapBridge/sync-state.json. With it a difference is
// "repo changed" (push), "unity changed" (pull) or "both changed" (conflict,
// needs force). Line endings are ignored for text files: git's autocrlf leaves
// the repo with CRLF while the Unity copy is LF, which is not a change.
//
// Folders come from unity/install.json. .meta files are Unity's and never synced.
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export type SyncMode = "check" | "push" | "pull";

export type FileState =
  | "same"
  | "new" // repo only, never synced: push
  | "repo-changed" // push
  | "unity-changed" // pull
  | "unity-only" // Unity only, never synced: pull
  | "conflict" // both differ from the base, or no base yet: force picks the side
  | "unity-deleted" // synced before, now gone from Unity
  | "repo-deleted"; // synced before, now gone from the repo

export interface FileReport {
  path: string; // project-relative, forward slashes
  repoFile: string;
  unityFile: string;
  state: FileState;
  action?: "pushed" | "pulled";
  newer?: "repo" | "unity"; // modified-time hint for conflicts
}

export interface InstallFolder {
  repo: string; // relative to the unity/ folder
  project: string; // relative to the Unity project root
}

export interface SyncOptions {
  repoRoot: string; // the unity/ folder
  projectPath: string;
  folders: InstallFolder[];
  mode: SyncMode;
  force?: boolean;
  only?: string[]; // substrings of project-relative paths; empty = everything
}

const TEXT = /\.(cs|shader|cginc|hlsl|compute|json|md|txt|html|js|mjs|ts|xml|asmdef|uss|uxml|py)$/i;

export function loadInstallFolders(repoRoot: string): InstallFolder[] {
  const doc = JSON.parse(readFileSync(join(repoRoot, "install.json"), "utf8"));
  return doc.folders as InstallFolder[];
}

export function contentHash(file: string): string {
  let bytes = readFileSync(file);
  if (TEXT.test(file)) {
    const text = bytes.toString("utf8").replace(/\r\n/g, "\n");
    bytes = Buffer.from(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text, "utf8");
  }
  return createHash("sha1").update(bytes).digest("hex");
}

function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory() && entry.name === "__pycache__") continue;
    if (entry.isDirectory()) out.push(...listFiles(full).map((f) => join(entry.name, f)));
    else if (!entry.name.endsWith(".meta")) out.push(entry.name);
  }
  return out;
}

function statePath(projectPath: string) {
  return join(projectPath, "Library", "GolfMapBridge", "sync-state.json");
}

function loadBase(projectPath: string): Record<string, string> {
  const file = statePath(projectPath);
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).files ?? {} : {};
}

// `repo`: the golf-map checkout the scripts came from (the folder above unity/), so the editor tools that run the
// repo's CLI (GolfMapModels.RepoRoot: `bun run models`) find it without being told.
function saveBase(projectPath: string, files: Record<string, string>, repoRoot: string) {
  const file = statePath(projectPath);
  mkdirSync(dirname(file), { recursive: true });
  const repo = resolve(repoRoot, "..").replace(/\\/g, "/");
  writeFileSync(file, JSON.stringify({ updated: new Date().toISOString(), repo, files }, null, 2) + "\n");
}

function classify(repoHash: string | undefined, unityHash: string | undefined, base: string | undefined): FileState {
  if (repoHash && unityHash) {
    if (repoHash === unityHash) return "same";
    if (base === unityHash) return "repo-changed";
    if (base === repoHash) return "unity-changed";
    return "conflict";
  }
  if (repoHash) return base ? "unity-deleted" : "new";
  return base ? "repo-deleted" : "unity-only";
}

function copy(from: string, to: string) {
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
}

export function sync(opts: SyncOptions): FileReport[] {
  if (!existsSync(join(opts.projectPath, "Assets"))) throw new Error(`${opts.projectPath} is not a Unity project (no Assets folder).`);
  const base = loadBase(opts.projectPath);
  const reports: FileReport[] = [];

  for (const folder of opts.folders) {
    const repoDir = join(opts.repoRoot, folder.repo);
    const unityDir = join(opts.projectPath, folder.project);
    const names = new Set([...listFiles(repoDir), ...listFiles(unityDir)]);
    for (const name of [...names].sort()) {
      const path = `${folder.project}/${name}`.replace(/\\/g, "/");
      if (opts.only?.length && !opts.only.some((o) => path.toLowerCase().includes(o.toLowerCase()))) continue;
      const repoFile = join(repoDir, name);
      const unityFile = join(unityDir, name);
      const repoHash = existsSync(repoFile) ? contentHash(repoFile) : undefined;
      const unityHash = existsSync(unityFile) ? contentHash(unityFile) : undefined;
      const state = classify(repoHash, unityHash, base[path]);
      const report: FileReport = { path, repoFile, unityFile, state };
      if (state === "conflict") report.newer = statSync(repoFile).mtimeMs >= statSync(unityFile).mtimeMs ? "repo" : "unity";

      const push =
        opts.mode === "push" &&
        (state === "new" || state === "repo-changed" || (opts.force && (state === "conflict" || state === "unity-changed" || state === "unity-deleted")));
      const pull =
        opts.mode === "pull" &&
        (state === "unity-changed" || state === "unity-only" || (opts.force && (state === "conflict" || state === "repo-changed" || state === "repo-deleted")));
      if (push) {
        copy(repoFile, unityFile);
        report.action = "pushed";
        base[path] = repoHash!;
      } else if (pull) {
        copy(unityFile, repoFile);
        report.action = "pulled";
        base[path] = unityHash!;
      } else if (state === "same") {
        base[path] = repoHash!;
      }
      reports.push(report);
    }
  }

  saveBase(opts.projectPath, base, opts.repoRoot);
  return reports;
}

// One line per file that needs attention; "same" files are only counted.
export function summarize(reports: FileReport[], mode: SyncMode): string {
  const same = reports.filter((r) => r.state === "same" && !r.action).length;
  const lines = reports
    .filter((r) => r.state !== "same" || r.action)
    .map((r) => {
      const hint = r.state === "conflict" ? ` (${r.newer} copy is newer)` : "";
      return `${r.action ?? "skipped"}  ${r.state}${hint}  ${r.path}`;
    });
  const pending = reports.filter((r) => !r.action && r.state !== "same");
  const advice: string[] = [];
  if (pending.some((r) => r.state === "conflict"))
    advice.push("Conflicts: diff repoFile against unityFile, merge in the repo, then push with force (repo wins) or pull with force (Unity wins).");
  if (mode === "push" && pending.some((r) => r.state === "unity-changed" || r.state === "unity-only"))
    advice.push("Unity-side edits exist: pull them into the repo first.");
  if (pending.some((r) => r.state === "repo-deleted")) advice.push("Files deleted in the repo still exist in Unity; delete them there by hand if intended.");
  return [`${mode}: ${same} unchanged, ${lines.length} listed`, ...lines, ...advice].join("\n");
}

