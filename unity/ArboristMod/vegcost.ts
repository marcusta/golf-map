// What each part of the vegetation costs, measured in a running GSPro with the course loaded:
//   bun unity/ArboristMod/vegcost.ts [--at x,y,z --look pitch,yaw] ...   (several --at/--look pairs = several viewpoints)
// For each viewpoint it measures the frame rate as it is, then with one thing changed at a time
// through `veg.set` (nothing is saved or rebuilt; everything is restored after each case).
import { join } from "node:path";
import { pickBridge, run } from "../mcp/bridge.ts";

const bridge = pickBridge(process.env.GOLFMAP_PLAYER || "gspro", join(process.env.LOCALAPPDATA ?? ".", "GolfMapPlayerBridge"));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const args = process.argv.slice(2);
const views: { position: number[]; rotation: number[] }[] = [];
for (let i = 0; i < args.length; i++)
  if (args[i] === "--at") views.push({ position: args[i + 1].split(",").map(Number), rotation: [0, 0, 0] });
  else if (args[i] === "--look") views[views.length - 1].rotation = [...args[i + 1].split(",").map(Number), 0];
const only = args.includes("--cases") ? args[args.indexOf("--cases") + 1].split(",") : null;

const course = "/VegetationStudioPro"; // the course's own systems; GSPro's (the Arborist file) is under /MainGameObjects
const cases: [string, Record<string, unknown>[]][] = [
  ["as built", []],
  ["no course grass", [{ system: course, type: "Grass", spawn: false }]],
  ["course grass half as dense", [{ system: course, type: "Grass", sampleDistance: 1.414 }]],
  ["course grass a quarter as dense", [{ system: course, type: "Grass", sampleDistance: 2 }]],
  ["no course plants (woodland floor)", [{ system: course, type: "Plant", spawn: false }]],
  ["no Arborist bushes and saplings", [{ system: "/MainGameObjects", package: "lower", spawn: false }]],
  ["no Arborist trees", [{ system: "/MainGameObjects", stored: false }]],
  ["no course trees (oaks, birches)", [{ system: course, stored: false }]],
  // Stix 3D grass on the rough meshes is not VSP and stays on here: perf.ts measures it (scene.hide).
  ["no VSP vegetation at all (Stix on)", [{ system: course, type: "Grass", spawn: false }, { system: course, type: "Plant", spawn: false }, { system: "/MainGameObjects", package: "lower", spawn: false }, { system: "/MainGameObjects", stored: false }, { system: course, stored: false }]],
  ["as built (again)", []],
];

for (const view of views.length ? views : [null]) {
  if (view) await run(bridge, "camera", view);
  // A moved camera loads cells for a while, and the first measurement after it reads low
  // (2026-10-13: 50 fps, then 77 with nothing changed): settle first, and "as built" is measured
  // again at the end as the check on drift.
  await sleep(25000);
  console.log(view ? `\nat ${view.position.join(", ")} looking ${view.rotation.slice(0, 2).join(", ")}` : "\nwhere the camera stands");
  for (const [name, changes] of cases) {
    if (only && !only.some((o) => name.includes(o))) continue;
    for (const change of changes) await run(bridge, "veg.set", change);
    await sleep(changes.length ? 9000 : 6000);
    const f = await run(bridge, "fps", { seconds: 4 });
    console.log(`  ${name.padEnd(38)} ${String(f.fps).padStart(6)} fps   ${String(f.meanMs).padStart(6)} ms   1% low ${f.onePercentLowFps}`);
    if (changes.length) await run(bridge, "veg.set", { restore: true });
  }
}
await sleep(3000);
