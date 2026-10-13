// Drives a running GSPro (mod loaded, see README "GSPro") to a course without a hand on the mouse:
//   bun unity/ArboristMod/gspro.ts open Vreta      from the home menu or a running round: (end round,) Local Match, search, Play, start
//   bun unity/ArboristMod/gspro.ts end             end the running round, back to the menus
// A course's arboristdata.dat is read when the round starts, so `open` is also how a regenerated
// vegetation file is brought in. Loading Vreta takes about three minutes.
import { join } from "node:path";
import { pickBridge, run } from "../mcp/bridge.ts";

const bridge = pickBridge(process.env.GOLFMAP_PLAYER || "gspro", join(process.env.LOCALAPPDATA ?? ".", "GolfMapPlayerBridge"));
const [action, course] = process.argv.slice(2);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const menu = "/MainGameObjects/MenuCanvas";
const game = "/MainGameObjects/RunTimeCanvas";

type Control = { path: string; kind: string; label: string; interactable: boolean };
const controls = async (contains?: string): Promise<Control[]> => (await run(bridge, "ui", { contains, limit: 400 })).controls;
const click = (path: string) => run(bridge, "ui.click", { path });
const shown = async (path: string) => (await controls(path)).some((c) => c.path === path && c.interactable);

// GSPro has one terrain of its own; a loaded course adds its terrains.
const terrains = async (): Promise<number> => (await run(bridge, "objects", { type: "UnityEngine.Terrain", limit: 5 })).count;

async function waitFor(path: string, seconds: number) {
  for (let i = 0; i < seconds * 2; i++) {
    if (await shown(path)) return;
    await sleep(500);
  }
  throw new Error(`${path} did not come up within ${seconds} s.`);
}

async function endRound() {
  if ((await terrains()) <= 1 && (await shown(`${menu}/homeMenu/localGameBtn`))) return false;
  if (!(await shown(`${game}/PnlActiveHole/BtnInGamePlayMenu`))) throw new Error("Neither the home menu nor a running round: bring GSPro to one of them.");
  await click(`${game}/PnlActiveHole/BtnInGamePlayMenu`);
  await waitFor(`${game}/playMenu/BtnEndRound`, 10);
  await click(`${game}/playMenu/BtnEndRound`);
  await waitFor(`${game}/PnlConfirmAction/BtnYes`, 10);
  await click(`${game}/PnlConfirmAction/BtnYes`);
  // The home menu's buttons answer before GSPro has finished "Returning to Main Menu": a new
  // round started in that gap loads under a stuck overlay (2026-10-12). Wait for the course to go.
  for (let i = 0; ; i++) {
    if (i > 90) throw new Error("The round did not end within 3 minutes.");
    await sleep(2000);
    if ((await terrains()) <= 1 && (await shown(`${menu}/homeMenu/localGameBtn`))) break;
  }
  await sleep(4000);
  return true;
}

if (action === "end") {
  console.log((await endRound()) ? "Round ended." : "No round was running.");
} else if (action === "open" && course) {
  if (await endRound()) console.log("Round ended.");
  await click(`${menu}/homeMenu/localGameBtn`);
  const search = `${menu}/CourseManagerV3/PnlMainHolder/PnlMainWindow/PnlSearch/SearchBar`;
  await waitFor(search, 20);
  await run(bridge, "ui.type", { path: search, text: course });
  await sleep(1500);
  const plays = (await controls("PnlCourseItemV3")).filter((c) => c.path.endsWith("/BtnPlay"));
  if (plays.length !== 1) throw new Error(`${plays.length} installed course(s) match '${course}'; the search must leave exactly one.`);
  await click(plays[0].path);
  await waitFor(`${menu}/newRoundMenu/PnlCTA/GOBtn`, 20);
  await click(`${menu}/newRoundMenu/PnlCTA/GOBtn`);
  console.log(`Loading ${course}...`);
  const started = Date.now();
  // The in-game button is there in the menus too: GSPro has one terrain of its own; the course is in when there are more.
  for (let i = 0; ; i++) {
    if (i > 300) throw new Error("The course did not load within 10 minutes.");
    await sleep(2000);
    if ((await terrains()) > 1 && !(await shown(`${menu}/newRoundMenu/PnlCTA/GOBtn`))) break;
  }
  await sleep(15000);
  console.log(`On the first tee after ${Math.round((Date.now() - started) / 1000)} s.`);
} else {
  console.log("usage: gspro.ts open <course name> | end");
}
