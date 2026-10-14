// How far golfmap.course.build has got, read straight off disk.
//
// The build holds the editor's main thread inside OPCD's builder for about 12
// minutes, so the bridge answers no command meanwhile; the build writes its
// progress to <project>/GolfMapSpelunk/<Course>_build-status.json instead
// (GolfMapCourseBuild.cs). That file is what survives, so this reader needs no
// editor at all - the bridge command golfmap.course.build.status returns the same
// thing when the editor can answer.
//
// The file also carries the editor's pid, because a build that holds the main thread to
// its end can never write "I stopped": an editor that died inside the build leaves
// running: true behind for ever. A running file whose process is gone reads as phase
// "interrupted", running false, here and in unity_status.
//
//   bun unity/mcp/build-status.ts [project]      project: a path, or a substring of
//                                                an open editor's project (default:
//                                                the only open editor)
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { alive, pickBridge } from "./bridge";

export interface BuildStatus {
  /** Course the file belongs to (its name is in the file name). */
  course: string;
  file: string;
  running: boolean;
  /** The editor process that was building, as the file names it (older files have none). */
  pid: number | null;
  startedAt: string | null;
  /** A running build: how long it has been going; a finished one: how long it took. */
  seconds: number;
  /** The file's phase, or "interrupted" when it says running and that editor is gone. */
  phase: string;
  /** Since the build last wrote the file: a running build is silent through its long phase. */
  staleSeconds: number;
  lastResult: unknown;
}

const SUFFIX = "_build-status.json";

// Every course's build status in the project, the most recently written first.
export function readBuildStatus(projectPath: string): BuildStatus[] {
  const dir = join(projectPath, "GolfMapSpelunk");
  if (!existsSync(dir)) return [];
  const out: BuildStatus[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(SUFFIX)) continue;
    const file = join(dir, name);
    try {
      const stored = JSON.parse(readFileSync(file, "utf8")) as Record<string, any>;
      const written = statSync(file).mtimeMs;
      const pid = Number.isFinite(stored.pid) ? Number(stored.pid) : null;
      // A build holds its editor's main thread to the end, so it can never write "finished":
      // an editor that crashed (or was killed) inside the build leaves running: true for ever.
      // The pid is what tells the difference - with that process gone, nobody is building.
      const interrupted = stored.running === true && pid !== null && !alive(pid);
      const running = stored.running === true && !interrupted;
      const startedAt = typeof stored.startedAt === "string" ? stored.startedAt : null;
      const since = startedAt ? Math.round((Date.now() - Date.parse(startedAt)) / 1000) : 0;
      out.push({
        course: name.slice(0, -SUFFIX.length),
        file: file.replace(/\\/g, "/"),
        running,
        pid,
        startedAt,
        // A running build cannot update its own file: count from when it started (an
        // interrupted one likewise - the file's own seconds stopped at its last milestone).
        seconds: (running || interrupted) && since >= 0 ? since : Number(stored.seconds ?? 0),
        phase: interrupted ? "interrupted" : String(stored.phase ?? "unknown"),
        staleSeconds: Math.round((Date.now() - written) / 1000),
        lastResult: stored.lastResult ?? null,
      });
    } catch {
      // Being written right now; the next read sees it.
    }
  }
  return out.sort((a, b) => a.staleSeconds - b.staleSeconds);
}

export function describeBuildStatus(s: BuildStatus): string {
  const state = s.running ? "building" : s.phase === "interrupted" ? `interrupted (editor ${s.pid} is gone)` : "idle";
  const head = `${s.course}: ${state} (${s.phase}), ${s.seconds} s, file written ${s.staleSeconds} s ago`;
  return `${head}\n  ${JSON.stringify(s.lastResult)}`;
}

if (import.meta.main) {
  const arg = process.argv[2];
  const projectPath = arg && existsSync(join(arg, "Assets")) ? arg : pickBridge(arg || undefined).projectPath;
  const all = readBuildStatus(projectPath);
  console.log(all.length ? all.map(describeBuildStatus).join("\n") : `No course build status under ${projectPath}/GolfMapSpelunk.`);
}
