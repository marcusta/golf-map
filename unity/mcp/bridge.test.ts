// The bridge client against a stand-in for the Unity editor's HTTP endpoint.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { call, listBridges, pickBridge, run, status } from "./bridge";

let dir: string;
let server: ReturnType<typeof Bun.serve>;
const jobs = new Map<string, number>(); // job id -> polls left before it finishes
// The reload cases: what the editor was asked to run, and how many /status polls
// still report a compile (the bridge of a reloading editor is down or busy).
let submitted: string[] = [];
let busyStatusPolls = 0;

const LOST_JOB = "Unknown job (jobs do not survive a script reload).";
const RELOADING = "The editor is reloading scripts; call again.";
// Job ids are "<domainStamp>-<n>" (BridgeServer.cs): the counter restarts at 1 in each new
// domain, so the stamp is what keeps a stale /job/<id> from reading the new domain's job 1.
const STAMP = "7f3a9c01";
const OLD_STAMP = "0000aaaa"; // the domain that went down with the job in it
const SLOW_JOB = `${STAMP}-7`;
const LOST_JOB_ID = `${OLD_STAMP}-1`;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (req.headers.get("X-Bridge-Token") !== "secret") return Response.json({ ok: false, error: "Bad or missing X-Bridge-Token." }, { status: 403 });
      const path = new URL(req.url).pathname;
      if (path === "/status")
        return Response.json({ ok: true, result: { compiling: busyStatusPolls-- > 0, updating: false, domainStarted: "2026-09-23T10:00:00", jobStamp: STAMP } });
      if (path === "/cmd/echo") return Response.json({ ok: true, result: await req.json() });
      if (path === "/cmd/fail") return Response.json({ ok: false, error: "BridgeError: nope", stack: "at Fail()" });
      if (path === "/cmd/slow") {
        jobs.set(SLOW_JOB, 2);
        return Response.json({ ok: false, pending: true, job: SLOW_JOB });
      }
      if (path === `/job/${SLOW_JOB}`) {
        const left = jobs.get(SLOW_JOB)! - 1;
        jobs.set(SLOW_JOB, left);
        return Response.json(left > 0 ? { ok: false, pending: true, job: SLOW_JOB } : { ok: true, result: "done" });
      }
      // A command whose refresh reloads the scripts: the first run is accepted as a
      // job and then loses it with the domain; the second run (new domain) answers.
      if (path === "/cmd/golfmap.reloads-once") {
        submitted.push("golfmap.reloads-once");
        return Response.json(
          submitted.filter((c) => c === "golfmap.reloads-once").length === 1 ? { ok: false, pending: true, job: LOST_JOB_ID } : { ok: true, result: { synced: 3 } },
        );
      }
      // The job id belongs to a domain that is gone: this domain has no such job.
      if (path === `/job/${LOST_JOB_ID}`) return Response.json({ ok: false, error: LOST_JOB });
      // An editor that keeps reloading: both runs come back empty.
      if (path === "/cmd/golfmap.reloads-always") {
        submitted.push("golfmap.reloads-always");
        return Response.json({ ok: false, error: RELOADING });
      }
      // A builtin, not one of ours: same lost job, but it is not resubmitted.
      if (path === "/cmd/menu") {
        submitted.push("menu");
        return Response.json({ ok: false, pending: true, job: LOST_JOB_ID });
      }
      return Response.json({ ok: false, error: "Unknown endpoint" });
    },
  });
});
afterAll(() => server.stop(true));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bridge-disc-"));
  submitted = [];
  busyStatusPolls = 0;
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

// The known "course.refresh returned null right after meshes.sync": the command's
// AssetDatabase.Refresh compiled something, the domain reload took the job with it.
// The job id it was polling carries the old domain's stamp, so the new domain answers
// "Unknown job" instead of handing out its own job of that number.
describe("a job lost to a script reload", () => {
  test("waits for the bridge and submits the same command once more", async () => {
    publish(process.pid, "D:/p/one");
    busyStatusPolls = 2; // still compiling for the first two polls
    const started = Date.now();
    const result = await run(pickBridge(undefined, dir), "golfmap.reloads-once", {}, 30);
    expect(result).toEqual({ synced: 3, retried: true });
    expect(submitted).toEqual(["golfmap.reloads-once", "golfmap.reloads-once"]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(900); // waited out the reload
  });

  test("a second failure surfaces instead of retrying again", async () => {
    publish(process.pid, "D:/p/one");
    await expect(run(pickBridge(undefined, dir), "golfmap.reloads-always", {}, 30)).rejects.toThrow(/reloading scripts[\s\S]*submitted a second time/);
    expect(submitted).toEqual(["golfmap.reloads-always", "golfmap.reloads-always"]);
  });

  test("a bridge that never comes back is reported, with no second submission", async () => {
    publish(process.pid, "D:/p/one");
    busyStatusPolls = 99;
    const r = await call(pickBridge(undefined, dir), "golfmap.reloads-once", {}, 30, 0);
    expect(r.ok).toBe(false);
    expect(r.retried).toBeUndefined();
    expect(r.error).toMatch(/Unknown job[\s\S]*did not come back within 0 s/);
    expect(submitted).toEqual(["golfmap.reloads-once"]);
  });

  // Only golfmap.* commands promise to be idempotent, so only they are run twice on their own.
  test("a command that is not ours is not resubmitted, and says so", async () => {
    publish(process.pid, "D:/p/one");
    const r = await call(pickBridge(undefined, dir), "menu", { path: "GolfMap/Bridge/Restart" }, 30);
    expect(r.ok).toBe(false);
    expect(r.retried).toBe(false);
    expect(r.error).toMatch(/Unknown job[\s\S]*not a golfmap\.\* command, so it was not submitted again/);
    expect(submitted).toEqual(["menu"]);
  });

  test("the editor publishes its domain's job stamp, which is the id's first half", async () => {
    publish(process.pid, "D:/p/one");
    const s = await status(pickBridge(undefined, dir));
    expect(s.jobStamp).toBe(STAMP);
    expect(SLOW_JOB.startsWith(`${s.jobStamp}-`)).toBe(true);
    expect(LOST_JOB_ID.startsWith(`${s.jobStamp}-`)).toBe(false); // another domain's: lost
  });
});
