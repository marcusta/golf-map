// How far golfmap.course.build has got, read straight off disk.
//
// The build holds the editor's main thread inside OPCD's builder for about 12
// minutes, so the bridge answers no command meanwhile; the build writes its
// progress to <project>/GolfMapSpelunk/<Course>_build-status.json instead
// (GolfMapCourseBuild.cs). That file is what survives, so this reader needs no
// editor at all - the bridge command golfmap.course.build.status returns the same
// thing when the editor can answer.
//
//   bun unity/mcp/build-status.ts [project]      project: a path, or a substring of
//                                                an open editor's project (default:
//                                                the only open editor)
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { pickBridge } from "./bridge";

export interface BuildStatus {
  /** Course the file belongs to (its name is in the file name). */
  course: string;
  file: string;
  running: boolean;
  startedAt: string | null;
  /** A running build: how long it has been going; a finished one: how long it took. */
  seconds: number;
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
      const running = stored.running === true;
      const startedAt = typeof stored.startedAt === "string" ? stored.startedAt : null;
      const since = startedAt ? Math.round((Date.now() - Date.parse(startedAt)) / 1000) : 0;
      out.push({
        course: name.slice(0, -SUFFIX.length),
        file: file.replace(/\\/g, "/"),
        running,
        startedAt,
        // A running build cannot update its own file: count from when it started.
        seconds: running && since >= 0 ? since : Number(stored.seconds ?? 0),
        phase: String(stored.phase ?? "unknown"),
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
  const head = `${s.course}: ${s.running ? "building" : "idle"} (${s.phase}), ${s.seconds} s, file written ${s.staleSeconds} s ago`;
  return `${head}\n  ${JSON.stringify(s.lastResult)}`;
}

if (import.meta.main) {
  const arg = process.argv[2];
  const projectPath = arg && existsSync(join(arg, "Assets")) ? arg : pickBridge(arg || undefined).projectPath;
  const all = readBuildStatus(projectPath);
  console.log(all.length ? all.map(describeBuildStatus).join("\n") : `No course build status under ${projectPath}/GolfMapSpelunk.`);
}
