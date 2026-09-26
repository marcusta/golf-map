import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sync, type SyncMode } from "./sync";

let root: string, repo: string, project: string;
const folders = [{ repo: "Editor/Tools", project: "Assets/Editor/Tools" }];

const repoFile = (name: string) => join(repo, "Editor/Tools", name);
const unityFile = (name: string) => join(project, "Assets/Editor/Tools", name);
function write(file: string, text: string) {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, text);
}
const run = (mode: SyncMode, force = false) => sync({ repoRoot: repo, projectPath: project, folders, mode, force });
const states = (mode: SyncMode, force = false) => Object.fromEntries(run(mode, force).map((r) => [r.path.split("/").pop(), `${r.state}${r.action ? ":" + r.action : ""}`]));

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "unity-sync-"));
  repo = join(root, "repo");
  project = join(root, "project");
  mkdirSync(join(project, "Assets"), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("sync", () => {
  test("a new repo file is pushed and becomes the base", () => {
    write(repoFile("A.cs"), "class A {}\n");
    expect(states("check")).toEqual({ "A.cs": "new" });
    expect(existsSync(unityFile("A.cs"))).toBe(false);
    expect(states("push")).toEqual({ "A.cs": "new:pushed" });
    expect(readFileSync(unityFile("A.cs"), "utf8")).toBe("class A {}\n");
    expect(states("check")).toEqual({ "A.cs": "same" });
  });

  test("line endings and a BOM are not a difference", () => {
    write(repoFile("A.cs"), "﻿line one\r\nline two\r\n");
    write(unityFile("A.cs"), "line one\nline two\n");
    expect(states("check")).toEqual({ "A.cs": "same" });
  });

  test("an unsynced difference is a conflict and is only overwritten with force", () => {
    write(repoFile("A.cs"), "repo\n");
    write(unityFile("A.cs"), "unity\n");
    expect(states("push")).toEqual({ "A.cs": "conflict" });
    expect(readFileSync(unityFile("A.cs"), "utf8")).toBe("unity\n");
    expect(states("push", true)).toEqual({ "A.cs": "conflict:pushed" });
    expect(readFileSync(unityFile("A.cs"), "utf8")).toBe("repo\n");
  });

  test("after a sync, the base tells which side changed", () => {
    write(repoFile("A.cs"), "v1\n");
    write(repoFile("B.cs"), "v1\n");
    run("push");

    write(repoFile("A.cs"), "v2 in repo\n");
    write(unityFile("B.cs"), "v2 in unity\n");
    expect(states("check")).toEqual({ "A.cs": "repo-changed", "B.cs": "unity-changed" });

    // push takes the repo edit and leaves the Unity edit alone
    expect(states("push")).toEqual({ "A.cs": "repo-changed:pushed", "B.cs": "unity-changed" });
    expect(readFileSync(unityFile("B.cs"), "utf8")).toBe("v2 in unity\n");

    // pull brings the Unity edit into the repo
    expect(states("pull")).toEqual({ "A.cs": "same", "B.cs": "unity-changed:pulled" });
    expect(readFileSync(repoFile("B.cs"), "utf8")).toBe("v2 in unity\n");
  });

  test("both sides changed since the base is a conflict", () => {
    write(repoFile("A.cs"), "v1\n");
    run("push");
    write(repoFile("A.cs"), "repo edit\n");
    write(unityFile("A.cs"), "unity edit\n");
    expect(states("push")).toEqual({ "A.cs": "conflict" });
    expect(states("pull", true)).toEqual({ "A.cs": "conflict:pulled" });
    expect(readFileSync(repoFile("A.cs"), "utf8")).toBe("unity edit\n");
  });

  test("Unity-only files are pulled, .meta files are ignored, deletions are reported not propagated", () => {
    write(unityFile("Extra.cs"), "extra\n");
    write(unityFile("Extra.cs.meta"), "guid: 1\n");
    write(repoFile("Gone.cs"), "gone\n");
    run("push");
    rmSync(repoFile("Gone.cs"));
    expect(states("pull")).toEqual({ "Extra.cs": "unity-only:pulled", "Gone.cs": "repo-deleted" });
    expect(existsSync(unityFile("Gone.cs"))).toBe(true);
    expect(existsSync(join(repo, "Editor/Tools/Extra.cs.meta"))).toBe(false);
  });

  test("files in subfolders keep their relative path", () => {
    write(repoFile("Sub/C.cs"), "c\n");
    run("push");
    expect(readFileSync(unityFile("Sub/C.cs"), "utf8")).toBe("c\n");
  });

  test("refuses a folder that is not a Unity project", () => {
    expect(() => sync({ repoRoot: repo, projectPath: join(root, "nope"), folders, mode: "check" })).toThrow(/not a Unity project/);
  });
});
