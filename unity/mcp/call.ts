// Calls a bridge command of the open Unity editor from a shell, for when the result is too long to
// read whole (the `unity` MCP tools return everything):
//   bun unity/mcp/call.ts <command> ['{"json": "args"}'] [timeoutSec] [project]
// Prints the result as JSON; pipe it through a filter.
import { pickBridge, run } from "./bridge.ts";

const [command, json, timeout, project] = process.argv.slice(2);
if (!command) {
  console.log("usage: call.ts <command> ['{json args}'] [timeoutSec] [project]");
} else {
  const result = await run(pickBridge(project || undefined), command, json ? JSON.parse(json) : {}, timeout ? Number(timeout) : 300);
  console.log(JSON.stringify(result, null, 1));
}
