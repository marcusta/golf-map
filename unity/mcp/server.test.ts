// The MCP server's tool list, read over stdio the way an agent does.
import { expect, test } from "bun:test";
import { join } from "node:path";

async function toolList(): Promise<any[]> {
  const proc = Bun.spawn(["bun", join(import.meta.dir, "server.ts")], { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) + "\n");
  proc.stdin.end();
  const out = await new Response(proc.stdout).text();
  return JSON.parse(out.split("\n")[0]).result.tools;
}

test("unity_screenshot offers restore, off by default, and says the view stays unless it is set", async () => {
  const shot = (await toolList()).find((t) => t.name === "unity_screenshot");
  expect(shot.inputSchema.properties.restore).toMatchObject({ type: "boolean", default: false });
  expect(shot.description).toMatch(/restore=true/);
});
