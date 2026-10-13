// Calls a command of the player bridge running inside Arborist or GSPro (unity/ArboristMod):
//   bun unity/ArboristMod/call.ts                      which players are up
//   bun unity/ArboristMod/call.ts status
//   bun unity/ArboristMod/call.ts <command> ['{"json": "args"}'] [timeoutSec]
// The player announces itself in %LOCALAPPDATA%\GolfMapPlayerBridge, apart from the editors.
// The three exports below are the same discovery for other scripts (scripts/arborist.ts).
import { join } from "node:path";
// Extensionless, like server/services/unity-bridge.ts: this file is now part of the
// server's typecheck program (scripts/arborist.ts imports it) and tsc rejects a '.ts' path.
import { call, listBridges, pickBridge, status, type BridgeInfo } from "../mcp/bridge";

/** Where a player bridge announces itself — apart from the editors' GolfMapBridge folder. */
export const playerDir = () => join(process.env.LOCALAPPDATA ?? ".", "GolfMapPlayerBridge");

/** The players up right now. */
export const players = (): BridgeInfo[] => listBridges(playerDir());

/** One player: `app` is a part of its path ("arborist", "gspro"); none picks the only one up. Throws when there is no single match. */
export const player = (app?: string): BridgeInfo => pickBridge(app, playerDir());

if (import.meta.main) {
  const [command, json, timeout] = process.argv.slice(2);
  if (!command) {
    console.log(JSON.stringify(players(), null, 2));
  } else {
    // Arborist and GSPro can both be up: GOLFMAP_PLAYER=gspro (or arborist) picks one by its path.
    const bridge = player(process.env.GOLFMAP_PLAYER || undefined);
    const result = command === "status" ? await status(bridge) : await call(bridge, command, json ? JSON.parse(json) : {}, timeout ? Number(timeout) : 120);
    console.log(JSON.stringify(result, null, 2));
  }
}
