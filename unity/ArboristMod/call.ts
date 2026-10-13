// Calls a command of the player bridge running inside Arborist or GSPro (unity/ArboristMod):
//   bun unity/ArboristMod/call.ts                      which players are up
//   bun unity/ArboristMod/call.ts status
//   bun unity/ArboristMod/call.ts <command> ['{"json": "args"}'] [timeoutSec]
// The player announces itself in %LOCALAPPDATA%\GolfMapPlayerBridge, apart from the editors.
import { join } from "node:path";
import { call, listBridges, pickBridge, status } from "../mcp/bridge.ts";

const dir = join(process.env.LOCALAPPDATA ?? ".", "GolfMapPlayerBridge");
const [command, json, timeout] = process.argv.slice(2);

if (!command) {
  console.log(JSON.stringify(listBridges(dir), null, 2));
} else {
  // Arborist and GSPro can both be up: GOLFMAP_PLAYER=gspro (or arborist) picks one by its path.
  const bridge = pickBridge(process.env.GOLFMAP_PLAYER || undefined, dir);
  const result = command === "status" ? await status(bridge) : await call(bridge, command, json ? JSON.parse(json) : {}, timeout ? Number(timeout) : 120);
  console.log(JSON.stringify(result, null, 2));
}
