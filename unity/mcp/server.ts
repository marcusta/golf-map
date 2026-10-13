#!/usr/bin/env bun
// MCP server for driving Unity course projects (GSPro/OPCD, Unity 2018.2+) from
// an agent. Stdio JSON-RPC, no dependencies. Talks to the editor bridge
// (unity/Editor/GolfMapBridge) that runs inside each open editor; see
// unity/mcp/README.md. Registered in the repo's .mcp.json as "unity".
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type BridgeInfo, listBridges, pickBridge, refreshAndCompile, run, status } from "./bridge";
import { readBuildStatus } from "./build-status";
import { loadInstallFolders, summarize, sync, type SyncMode } from "./sync";

const UNITY_DIR = join(dirname(import.meta.path), "..");

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: any) => Promise<Content[] | string>;
}

const project = { type: "string", description: "Unity project folder name or path (substring). Optional when one editor is open." };
const text = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value, null, 2));

async function compileReport(b: BridgeInfo, since: number): Promise<string> {
  const c = await refreshAndCompile(b);
  const lines = [`compile: ${c.outcome} in ${c.seconds}s`];
  for (const e of c.errors.slice(0, 50)) lines.push(`  ${e.file}(${e.line}): ${e.message}`);
  const log = await run(pickBridge(b.projectPath), "console", { since, types: ["error", "exception", "assert"], limit: 30 }, 30).catch(() => null);
  if (log?.entries?.length) {
    lines.push(`console errors since #${since}:`);
    for (const e of log.entries) lines.push(`  #${e.seq} ${e.type}: ${e.message.split("\n")[0]}`);
  }
  return lines.join("\n");
}

const tools: Tool[] = [
  {
    name: "unity_editors",
    description: "List open Unity editors running the bridge (project, path, Unity version, compiling/busy state).",
    inputSchema: { type: "object", properties: {} },
    async handler() {
      const all = listBridges();
      if (!all.length) return "No editor with the bridge is open.";
      const rows = await Promise.all(
        all.map(async (b) => ({ project: b.projectName, path: b.projectPath, unity: b.unityVersion, pid: b.pid, port: b.port, state: (await status(b)) ?? "reloading" })),
      );
      return text(rows);
    },
  },
  {
    name: "unity_status",
    description:
      "Editor state for one project: open scenes (dirty?), compiling, busy command, selection, Scene view camera, console position. " +
      "A golfmap.course.build running or lately finished is reported under courseBuild, read from its progress file on disk, " +
      "so it shows even while the build holds the editor's main thread and no command is answered.",
    inputSchema: { type: "object", properties: { project } },
    async handler(a) {
      const b = pickBridge(a.project);
      const builds = readBuildStatus(b.projectPath).filter((s) => s.running || s.staleSeconds < 3600);
      let live: unknown;
      try {
        live = await run(b, "status", {}, 20);
      } catch (e) {
        // A command holding the main thread (golfmap.course.build: minutes inside
        // OPCD's builder) leaves only the off-thread snapshot and the build's own file.
        live = { snapshot: (await status(b)) ?? null, commandError: (e as Error).message.split("\n")[0] };
      }
      return text(builds.length ? { ...(live as object), courseBuild: builds } : live);
    },
  },
  {
    name: "unity_sync",
    description:
      "Sync the repo's Unity scripts (unity/install.json: the bridge, Editor/GolfMap, Runtime/GolfMap) with a course project, then recompile in the open editor and report compile errors. " +
      "check = report only; push = copy repo edits into the project (new + repo-changed); pull = bring Unity-side edits into the repo. " +
      "Line endings are ignored. Conflicts (both sides changed, or no sync base yet) need force: push+force = repo wins, pull+force = Unity wins. " +
      "Works on a closed project too via projectPath (no compile then) - that is how the bridge gets into a new course project.",
    inputSchema: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["check", "push", "pull"], default: "check" },
        project,
        projectPath: { type: "string", description: "Unity project root, for a project whose editor is not open." },
        force: { type: "boolean", default: false },
        only: { type: "array", items: { type: "string" }, description: "Limit to paths containing any of these substrings." },
        compile: { type: "boolean", default: true, description: "After a push, refresh and wait for the editor's compile." },
      },
    },
    async handler(a) {
      const mode = (a.mode ?? "check") as SyncMode;
      let b: BridgeInfo | undefined;
      let projectPath = a.projectPath as string | undefined;
      if (!projectPath) {
        b = pickBridge(a.project);
        projectPath = b.projectPath;
      } else {
        b = listBridges().find((x) => x.projectPath.toLowerCase() === projectPath!.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase());
      }
      const reports = sync({ repoRoot: UNITY_DIR, projectPath, folders: loadInstallFolders(UNITY_DIR), mode, force: a.force, only: a.only });
      let out = `${projectPath}\n${summarize(reports, mode)}`;
      const pushed = reports.some((r) => r.action === "pushed");
      if (pushed && a.compile !== false) {
        if (b) {
          const s = await status(b, 30);
          out += "\n" + (await compileReport(b, s?.consoleSeq ?? 0));
        } else out += "\nEditor not open: open the project in Unity to compile (the bridge starts with it).";
      }
      return out;
    },
  },
  {
    name: "unity_compile",
    description: "Refresh assets and recompile in the open editor without focusing Unity; waits for the domain reload and returns compile errors and new console errors.",
    inputSchema: { type: "object", properties: { project } },
    async handler(a) {
      const b = pickBridge(a.project);
      const s = await status(b, 30);
      return compileReport(b, s?.consoleSeq ?? 0);
    },
  },
  {
    name: "unity_console",
    description: "Unity console messages captured by the bridge (survive recompiles). Use since=<seq> from a previous result to get only new messages.",
    inputSchema: {
      type: "object",
      properties: {
        project,
        since: { type: "number", description: "Return messages after this sequence number." },
        types: { type: "array", items: { type: "string", enum: ["error", "exception", "assert", "warning", "log"] } },
        contains: { type: "string" },
        limit: { type: "number", default: 100 },
        stacks: { type: "boolean", default: false },
        clear: { type: "boolean", description: "Clear the bridge buffer and Unity's Console window instead of reading." },
      },
    },
    async handler(a) {
      const b = pickBridge(a.project);
      if (a.clear) return text(await run(b, "console.clear", { unity: true }));
      const r = await run(b, "console", { since: a.since ?? 0, types: a.types ?? [], contains: a.contains, limit: a.limit ?? 100, stacks: a.stacks ?? false });
      const lines = r.entries.map((e: any) => `#${e.seq} ${e.time} ${e.type}: ${e.message}${e.stack ? "\n" + e.stack : ""}`);
      return [`lastSeq ${r.lastSeq}, ${r.entries.length} shown`, ...lines].join("\n");
    },
  },
  {
    name: "unity_menu",
    description: "Run a Unity menu item by path (e.g. 'GolfMap/Refresh vegetation from materials'), or list script menu items under a prefix. Items that open a modal dialog block until the user answers it.",
    inputSchema: {
      type: "object",
      properties: { project, path: { type: "string", description: "Menu path to run." }, prefix: { type: "string", description: "List menu items starting with this instead." }, timeout: { type: "number", default: 300 } },
    },
    async handler(a) {
      const b = pickBridge(a.project);
      if (!a.path) return text(await run(b, "menu.list", { prefix: a.prefix ?? "" }));
      const s = await status(b);
      const result = await run(b, "menu", { path: a.path }, a.timeout ?? 300);
      const log = await run(b, "console", { since: s?.consoleSeq ?? 0, limit: 40 });
      return text({ ...result, console: log.entries.map((e: any) => `#${e.seq} ${e.type}: ${e.message.split("\n")[0]}`) });
    },
  },
  {
    name: "unity_screenshot",
    description:
      "Screenshot of the Scene view camera, rendered offscreen at width x height (includes VSP vegetation; works while Unity is unfocused or covered). " +
      "Optionally place the view first: from + at (world points, e.g. a tee and a green) or pivot/rotation/size. The view stays where it was moved unless restore=true puts it back after the capture.",
    inputSchema: {
      type: "object",
      properties: {
        project,
        from: { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 },
        at: { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 },
        pivot: { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 },
        rotation: { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3, description: "Euler degrees." },
        size: { type: "number" },
        width: { type: "number", default: 1280 },
        height: { type: "number", default: 720 },
        mode: { type: "string", enum: ["view", "camera"], default: "view", description: "view = the Scene view's own render target (what it shows, VSP included, window size); camera = fresh offscreen render at width x height." },
        eye: { type: "number", description: "With from/at: stand this many metres above the terrain under `from` and look at 0.5 m above the terrain under `at` (their y values are ignored)." },
        hide: { type: "array", items: { type: "string" }, description: "Object paths whose renderers are switched off for this capture only (see what is under a mesh)." },
        warmup: { type: "number", default: 12, description: "Editor frames pumped before the capture so VSP spawns/loads cells while Unity is unfocused; raise it (60+) after a VSP refresh." },
        restore: { type: "boolean", default: false, description: "Put the Scene view back to the pose (pivot, rotation, size) it had before the call, once the image is captured." },
      },
    },
    async handler(a) {
      const { project: p, ...args } = a;
      const r = await run(pickBridge(p), "screenshot", args, 600);
      const data = readFileSync(r.file).toString("base64");
      const { file, ...pose } = r;
      return [
        { type: "image", data, mimeType: "image/png" },
        { type: "text", text: `${file}\n${JSON.stringify(pose)}` },
      ];
    },
  },
  {
    name: "unity_scene",
    description:
      "Query the open scenes. find: objects by name substring and/or component type (e.g. VegetationSystemPro, Terrain, GolfMapTrees), optionally under a path. " +
      "inspect: component list of the object at path, or the serialized fields of one component (filter by property path). select: select and ping an object for the user.",
    inputSchema: {
      type: "object",
      properties: {
        project,
        action: { type: "string", enum: ["find", "inspect", "select"] },
        path: { type: "string", description: "Object path like /GolfMap Trees or /VegetationStudioPro/VegetationSystemPro." },
        name: { type: "string" },
        component: { type: "string" },
        under: { type: "string" },
        filter: { type: "string" },
        depth: { type: "number" },
        limit: { type: "number" },
      },
      required: ["action"],
    },
    async handler(a) {
      const { project: p, action, ...args } = a;
      const command = action === "find" ? "scene.find" : action === "inspect" ? "scene.inspect" : "selection";
      return text(await run(pickBridge(p), command, args, 60));
    },
  },
  {
    name: "unity_command",
    description:
      "Run any [BridgeCommand] registered in the project, e.g. golfmap.course (active course, export files, reports). Omit name to list every command with its arguments. " +
      "Course tooling adds commands in C# without changes here.",
    inputSchema: {
      type: "object",
      properties: { project, name: { type: "string" }, args: { type: "object" }, timeout: { type: "number", default: 300, description: "Seconds to wait before returning; the command keeps running in Unity." } },
    },
    async handler(a) {
      const b = pickBridge(a.project);
      return text(await run(b, a.name ?? "commands", a.args ?? {}, a.timeout ?? 300));
    },
  },
];

// ---- stdio JSON-RPC ----

function send(message: unknown) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

async function handle(msg: any) {
  const { id, method, params } = msg;
  if (id === undefined) return; // notification
  try {
    switch (method) {
      case "initialize":
        return send({
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: params?.protocolVersion ?? "2025-06-18",
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "unity-bridge", version: "0.1.0" },
            instructions:
              "Drives open Unity editors (GSPro course projects) through the GolfMap editor bridge. Typical loop: edit scripts in the repo -> unity_sync mode=push (copies + recompiles, returns errors) -> unity_menu / unity_command to run tooling -> unity_console since=<seq> and unity_screenshot to verify.",
          },
        });
      case "ping":
        return send({ jsonrpc: "2.0", id, result: {} });
      case "tools/list":
        return send({ jsonrpc: "2.0", id, result: { tools: tools.map(({ handler, ...t }) => t) } });
      case "tools/call": {
        const tool = tools.find((t) => t.name === params?.name);
        if (!tool) return send({ jsonrpc: "2.0", id, error: { code: -32602, message: `Unknown tool ${params?.name}` } });
        try {
          const out = await tool.handler(params?.arguments ?? {});
          const content = typeof out === "string" ? [{ type: "text", text: out }] : out;
          return send({ jsonrpc: "2.0", id, result: { content } });
        } catch (e: any) {
          return send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: String(e?.message ?? e) }], isError: true } });
        }
      }
      default:
        return send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
    }
  } catch (e: any) {
    send({ jsonrpc: "2.0", id, error: { code: -32603, message: String(e?.message ?? e) } });
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  let nl: number;
  while ((nl = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      continue;
    }
    void handle(msg);
  }
});
process.stdin.on("end", () => process.exit(0));
