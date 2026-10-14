// The course build's progress file, read without an editor (GolfMapCourseBuild.cs writes it).
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readBuildStatus } from "./build-status";

function project(files: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), "build-status-"));
  mkdirSync(join(root, "GolfMapSpelunk"), { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(root, "GolfMapSpelunk", name), JSON.stringify(body));
  return root;
}

test("a project with no status file reports nothing", () => {
  expect(readBuildStatus(mkdtempSync(join(tmpdir(), "build-status-")))).toEqual([]);
});

// The editor writes DateTime.Now.ToString("s"): local time, no zone - which is how
// Date.parse reads a zoneless timestamp too.
function localStamp(at: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}T${p(at.getHours())}:${p(at.getMinutes())}:${p(at.getSeconds())}`;
}

test("a running build's seconds count from when it started, not from the file", () => {
  const startedAt = localStamp(new Date(Date.now() - 300_000));
  const root = project({
    "Vreta_build-status.json": { running: true, startedAt, seconds: 1, phase: "building-bundle", lastResult: { file: "old.gspcrse" } },
  });
  const [s] = readBuildStatus(root);
  expect(s.course).toBe("Vreta");
  expect(s.running).toBe(true);
  expect(s.phase).toBe("building-bundle");
  expect(s.seconds).toBeGreaterThanOrEqual(299); // the file says 1: the build cannot update it while it runs
  expect(s.seconds).toBeLessThan(320); // and the timestamp is read as local time, as the editor wrote it
  expect(s.staleSeconds).toBeLessThan(5);
  expect(s.lastResult).toEqual({ file: "old.gspcrse" });
});

// A build cannot write "I stopped": it holds the main thread to the end, so an editor that
// died inside it leaves running: true for ever. The pid is what gives it away.
test("a build whose editor is gone reads as interrupted, not as still running", () => {
  const startedAt = localStamp(new Date(Date.now() - 600_000));
  const root = project({
    "Vreta_build-status.json": { running: true, pid: 999999, startedAt, seconds: 3, phase: "building-bundle", lastResult: null },
  });
  const [s] = readBuildStatus(root);
  expect(s.running).toBe(false);
  expect(s.phase).toBe("interrupted");
  expect(s.pid).toBe(999999);
  expect(s.seconds).toBeGreaterThanOrEqual(599); // when it started, not the milestone it reached
});

test("a build running in a live editor stays running", () => {
  const startedAt = localStamp(new Date(Date.now() - 60_000));
  const root = project({
    "Vreta_build-status.json": { running: true, pid: process.pid, startedAt, seconds: 3, phase: "building-bundle", lastResult: null },
  });
  expect(readBuildStatus(root)[0]).toMatchObject({ running: true, phase: "building-bundle", pid: process.pid });
});

// Written before the pid was in the file: nothing to check it against, so it is taken as it reads.
test("a status file with no pid keeps its own running flag", () => {
  const root = project({ "Vreta_build-status.json": { running: true, startedAt: "2026-10-14T09:00:00", seconds: 3, phase: "building-bundle" } });
  expect(readBuildStatus(root)[0]).toMatchObject({ running: true, pid: null, phase: "building-bundle" });
});

test("a finished build keeps the elapsed seconds and the result it wrote", () => {
  const root = project({
    "Vreta_build-status.json": { running: false, startedAt: "2026-10-14T09:00:00", seconds: 740, phase: "done", lastResult: { megabytes: 812.3 } },
  });
  expect(readBuildStatus(root)[0]).toMatchObject({ running: false, seconds: 740, phase: "done", lastResult: { megabytes: 812.3 } });
});
