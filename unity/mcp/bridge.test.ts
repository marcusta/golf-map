// The bridge client against a stand-in for the Unity editor's HTTP endpoint.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { call, listBridges, pickBridge, run } from "./bridge";

let dir: string;
let server: ReturnType<typeof Bun.serve>;
const jobs = new Map<string, number>(); // job id -> polls left before it finishes

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (req.headers.get("X-Bridge-Token") !== "secret") return Response.json({ ok: false, error: "Bad or missing X-Bridge-Token." }, { status: 403 });
      const path = new URL(req.url).pathname;
      if (path === "/cmd/echo") return Response.json({ ok: true, result: await req.json() });
      if (path === "/cmd/fail") return Response.json({ ok: false, error: "BridgeError: nope", stack: "at Fail()" });
      if (path === "/cmd/slow") {
        jobs.set("7", 2);
        return Response.json({ ok: false, pending: true, job: "7" });
      }
      if (path === "/job/7") {
        const left = jobs.get("7")! - 1;
        jobs.set("7", left);
        return Response.json(left > 0 ? { ok: false, pending: true, job: "7" } : { ok: true, result: "done" });
      }
      return Response.json({ ok: false, error: "Unknown endpoint" });
    },
  });
});
afterAll(() => server.stop(true));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bridge-disc-"));
});

function publish(pid: number, projectPath: string, token = "secret") {
  const name = projectPath.split("/").pop()!;
  writeFileSync(
    join(dir, `bridge-${pid}.json`),
    JSON.stringify({ pid, port: server.port, token, projectPath, projectName: name, unityVersion: "2018.2.8f1", started: "2026-09-23T10:00:00" }),
  );
}

describe("discovery", () => {
  test("lists live editors and removes files left by dead ones", () => {
    publish(process.pid, "D:/gspro_courses/vreta_v4");
    publish(999999, "D:/gspro_courses/crashed");
    expect(listBridges(dir).map((b) => b.projectName)).toEqual(["vreta_v4"]);
    expect(readdirSync(dir)).toEqual([`bridge-${process.pid}.json`]);
  });

  test("picks the only editor, or the one matching the project", () => {
    publish(process.pid, "D:/gspro_courses/vreta_v4");
    expect(pickBridge(undefined, dir).projectName).toBe("vreta_v4");
    expect(pickBridge("VRETA", dir).projectName).toBe("vreta_v4");
    expect(pickBridge("D:\\gspro_courses\\vreta_v4\\", dir).projectName).toBe("vreta_v4");
    expect(() => pickBridge("landeryd", dir)).toThrow(/No single open editor/);
  });

  test("explains when no editor is open", () => {
    rmSync(dir, { recursive: true });
    expect(existsSync(dir)).toBe(false);
    expect(() => pickBridge(undefined, dir)).toThrow(/No Unity editor/);
  });
});

describe("commands", () => {
  test("sends args and returns the result", async () => {
    publish(process.pid, "D:/p/one");
    const b = pickBridge(undefined, dir);
    expect(await run(b, "echo", { path: "GolfMap/Bridge/Status" })).toEqual({ path: "GolfMap/Bridge/Status" });
  });

  test("a failing command throws with the editor's message and stack", async () => {
    publish(process.pid, "D:/p/one");
    await expect(run(pickBridge(undefined, dir), "fail")).rejects.toThrow(/nope[\s\S]*at Fail\(\)/);
  });

  test("a long command is polled until it finishes", async () => {
    publish(process.pid, "D:/p/one");
    expect(await run(pickBridge(undefined, dir), "slow", {}, 30)).toBe("done");
  });

  test("a wrong token is refused", async () => {
    publish(process.pid, "D:/p/one", "wrong");
    const r = await call(pickBridge(undefined, dir), "echo", {});
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Token/);
  });
});
