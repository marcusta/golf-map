// The frame rate at the course's judged viewpoints (docs/gspro/<course>/perf-views.json), in a running
// GSPro with the course loaded. Close Unity and Arborist first (`pwsh unity/ArboristMod/apps.ps1 close`):
// they take the graphics card.
//   bun unity/ArboristMod/perf.ts [--course Vreta] [--views <file>] [--view <part of a name>] [--settle 25] [--seconds 5]
//       the table: fps (mean) and 1 % low per viewpoint, as built
//   bun unity/ArboristMod/perf.ts --rank [--rounds 3] [--only <id or group>,...] [--pause 4] [--baseline-every 3] [--cap <fps>]
//       what costs frame time, ranked, per category (unity/Editor/GolfMap/GolfMapPerfCategories.json, the
//       same categories as the editor's golfmap.perf.report): geometry per category, then per viewpoint the
//       frame time with everything on and with exactly one category off, baselines in between, `rounds`
//       times; median ms saved, the fps that is, "not measurable" inside the noise, "at the cap" where the
//       frame rate is capped. --json <file> writes golfmap-perf-rank-v1, --md <file> the tables.
//   bun unity/ArboristMod/perf.ts --md <file> --from <report.json> [<report.json>]
//       the tables of reports already written, e.g. the editor's and the game's side by side
//   bun unity/ArboristMod/perf.ts --cases [veg,scene,stix] [--only <part of a case name>,...]
//       the older, single-pass look: per viewpoint the fps with one named part off (veg.draw / scene.hide)
//   --json <file> also writes the numbers
// Nothing is saved in the game; everything switched off is put back after each case.
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { pickBridge, run } from "../mcp/bridge.ts";
import { SMALL_OTHER, atCap, buildReport, costText, foldOthers, isReport, loadRules, loadViews, toMarkdown, viewCosts, type Category, type Reading, type Report, type Rule, type View } from "../perf-rank.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const args = process.argv.slice(2);
const opt = (name: string, fallback?: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const course = opt("--course", "Vreta")!;
const settle = Number(opt("--settle", "25")), seconds = Number(opt("--seconds", "5"));

// Reports already on disk: no game needed.
if (args.includes("--from")) {
  const files = args.slice(args.indexOf("--from") + 1).filter((a) => !a.startsWith("--") && a !== opt("--md"));
  const reports = files.map((f) => JSON.parse(readFileSync(f, "utf8").replace(/^﻿/, "")));
  for (const [i, r] of reports.entries()) if (!isReport(r)) throw new Error(`${files[i]} is not a golfmap-perf-rank-v1 report.`);
  const md = toMarkdown(reports as Report[]);
  if (opt("--md")) writeFileSync(opt("--md")!, md);
  else console.log(md);
  process.exit(0);
}

const bridge = pickBridge(process.env.GOLFMAP_PLAYER || "gspro", join(process.env.LOCALAPPDATA ?? ".", "GolfMapPlayerBridge"));
const viewFilter = opt("--view");
const sets = args.includes("--cases") ? (opt("--cases", "")!.startsWith("--") || !opt("--cases") ? "veg,scene,stix" : opt("--cases")!).split(",") : [];
const only = opt("--only")?.split(",");
const views = loadViews(course, opt("--views")).filter((v) => !viewFilter || v.name.includes(viewFilter));

type Step = [string, Record<string, unknown>];
const own = "/VegetationStudioPro"; // the course's own systems; GSPro's (the Arborist file) is under /MainGameObjects
// veg.draw hides a kind at once (its render layer goes to one the camera does not draw). veg.set's
// spawn/stored switches refresh the system instead, and in GSPro it then loads its cells again for
// minutes at under 30 fps: numbers taken 9 s or 25 s after one were wrong both ways (2026-10-13).
const arb = "/MainGameObjects";
const noGrass: Step = ["veg.draw", { system: own, type: "Grass" }];
const noPlants: Step = ["veg.draw", { system: own, type: "Plant" }];
const noOwnTrees: Step[] = [["veg.draw", { system: own, type: "Tree" }], ["veg.draw", { system: own, type: "Billboard" }]];
const noArbPlants: Step = ["veg.draw", { system: arb, type: "Plant" }];
const noArbTrees: Step = ["veg.draw", { system: arb, type: "Tree" }];
const noArbBillboards: Step = ["veg.draw", { system: arb, type: "Billboard" }];
const noStix: Step = ["scene.hide", { component: "GrassShader.GrassRenderer" }];
const allVeg: Step[] = [["veg.draw", { system: own }], ["veg.draw", { system: arb }]];
const cases: Record<string, [string, Step[]][]> = {
  veg: [
    ["no course grass (VSP texture grass)", [noGrass]],
    ["no course plants (woodland floor)", [noPlants]],
    ["no course trees (oaks, birches)", noOwnTrees],
    ["no Arborist plants (bushes, saplings)", [noArbPlants]],
    ["no Arborist trees (full models)", [noArbTrees]],
    ["no Arborist billboards (far trees)", [noArbBillboards]],
    ["no VSP vegetation at all, Stix on", allVeg],
    ["no vegetation at all, Stix off too", [...allVeg, noStix]],
  ],
  stix: [["no Stix 3D grass", [noStix]]],
  scene: [
    ["no vehicles", [["scene.hide", { path: "/GolfMap Props/Vehicles" }]]],
    ["no props (all of GolfMap Props)", [["scene.hide", { path: "/GolfMap Props" }]]],
    ["no stone walls and rocks", [["scene.hide", { path: "/GolfMap Walls" }]]],
    ["props and walls cast no shadows", [["scene.hide", { path: "/GolfMap Props", shadows: false }], ["scene.hide", { path: "/GolfMap Walls", shadows: false }]]],
    ["no water planes and creeks", [["scene.hide", { path: "/Waterplanes" }], ["scene.hide", { path: "/GolfMap Creeks" }]]],
  ],
};

async function restore() {
  await run(bridge, "veg.draw", { restore: true });
  await run(bridge, "scene.hide", { restore: true });
}
async function measure() {
  const f = await run(bridge, "fps", { seconds });
  return { fps: Number(f.fps), low: Number(f.onePercentLowFps), ms: Number(f.meanMs), resolution: f.resolution, quality: f.quality, raw: f };
}
async function pose(view: { position: number[]; rotation: number[]; eye?: number }) {
  const p: any = { position: view.position, rotation: view.rotation };
  if (view.eye != null) p.eye = view.eye;
  const at = await run(bridge, "camera", p);
  // A moved camera loads cells for a while, and the first measurement after it reads low.
  await sleep(settle * 1000);
  return at;
}

if (args.includes("--rank")) await rank();
else await table();

// GSPro runs with vSync on and sets it again every frame, so the numbers are capped at the display's
// refresh rate (120 Hz here: a cost that leaves the frame rate at 120 is not measured, only hidden).
async function table() {
  const out: any[] = [];
  for (const view of views) {
    const at = await pose(view);
    const built = await measure();
    const row: any = { view: view.name, position: at.position, rotation: view.rotation, asBuilt: built, cases: {} };
    console.log(`\n${view.name}  at ${at.position.map((n: number) => n.toFixed(1)).join(", ")} looking ${view.rotation.slice(0, 2).join(", ")}  (${built.resolution ?? ""} ${built.quality ?? ""})`);
    console.log(`  ${"as built".padEnd(40)} ${built.fps.toFixed(1).padStart(6)} fps   1% low ${built.low.toFixed(1)}`);
    for (const set of sets)
      for (const [name, steps] of cases[set] ?? []) {
        if (only && !only.some((o) => name.includes(o))) continue;
        for (const [command, a] of steps) await run(bridge, command, a);
        await sleep(6000);
        const f = await measure();
        row.cases[name] = f;
        console.log(`  ${name.padEnd(40)} ${f.fps.toFixed(1).padStart(6)} fps   1% low ${f.low.toFixed(1).padStart(5)}   ${(f.fps - built.fps >= 0 ? "+" : "") + (f.fps - built.fps).toFixed(1)}`);
        await restore();
        await sleep(3000);
      }
    if (sets.length) {
      await sleep(5000);
      const again = await measure();
      row.asBuiltAgain = again;
      console.log(`  ${"as built (again: the drift check)".padEnd(40)} ${again.fps.toFixed(1).padStart(6)} fps   1% low ${again.low.toFixed(1)}`);
    }
    out.push(row);
  }
  console.log("\n" + "viewpoint".padEnd(28) + "fps".padStart(7) + "1% low".padStart(9));
  for (const r of out) console.log(r.view.padEnd(28) + r.asBuilt.fps.toFixed(1).padStart(7) + r.asBuilt.low.toFixed(1).padStart(9));
  if (opt("--json")) writeFileSync(opt("--json")!, JSON.stringify(out, null, 1));
}

// ---- --rank ---------------------------------------------------------------------------------------

// A category as the game can switch it: the commands that take it off, and the one that puts it back.
interface Case { category: Category; off: Step[]; on: Step[] }

async function rank() {
  const rules = loadRules();
  const rounds = Math.max(1, Number(opt("--rounds", "3"))), pause = Number(opt("--pause", "4")), every = Math.max(1, Number(opt("--baseline-every", "3")));
  const groups = rules.categories.filter((c) => c.kind === "renderers").map((c) => ({ id: c.id, match: c.match }));
  const sceneBack: Step = ["scene.hide", { restore: true }], vegBack: Step = ["veg.draw", { restore: true }];
  const absent: string[] = [], notes: string[] = [], list: Case[] = [];

  // Geometry: the mesh renderers by the rules, the rest as other:<root>.
  const geometry = await run(bridge, "scene.geometry", { groups, limit: 1000 });
  if (!geometry.shown?.every((g: any) => "lod0Triangles" in g)) throw new Error("The mod in the game is older than this script (scene.geometry has no groups): build it (unity/ArboristMod/build.ps1 -App <GSPro folder>) and `call.ts reload`.");
  const rows = new Map<string, any>(geometry.shown.map((g: any) => [g.group, g]));
  const mesh = (id: string, label: string, group: string): Case => {
    const g = rows.get(id);
    return {
      category: { id, label, group, kind: "renderers", geometry: {
        objects: g.units, renderers: g.active, inactiveRenderers: g.renderers - g.active, triangles: g.activeTriangles, trianglesLod0: g.lod0Triangles,
        meshes: g.meshes, materials: g.materials, shadowCasters: g.shadowCasters, lodGroups: g.lodGroups, batchedRenderers: g.batched } },
      off: g.active > 0 ? [["scene.hide", { groups, group: id }]] : [], on: [sceneBack],
    };
  };
  for (const rule of rules.categories.filter((c) => c.kind === "renderers")) rows.has(rule.id) ? list.push(mesh(rule.id, rule.label, rule.group)) : absent.push(rule.id);
  for (const id of rows.keys()) if (id.startsWith("other:")) list.push(mesh(id, "Other: " + id.slice(6), "Other"));
  // The many small roots of a game scene (flags, cups, tee markers) as one row; switching it off switches its members.
  const folded = foldOthers(list.map((c) => c.category)).find((c) => c.id === SMALL_OTHER);
  if (folded) {
    const members = list.filter((c) => folded.members!.includes(c.category.id));
    list.splice(0, list.length, ...list.filter((c) => !members.includes(c)), { category: folded, off: members.flatMap((c) => c.off), on: [sceneBack] });
  }
  if (list.some((c) => c.category.geometry.batchedRenderers)) notes.push("Static batching: a batched renderer's mesh is the whole combined mesh, counted once a category, so those triangle counts are upper bounds. The editor's report has the real ones.");

  // Vegetation Studio: the course's own systems and GSPro's (the Arborist file), per type.
  const systems = (await run(bridge, "veg.systems", { items: true })) as any[];
  const vegTypes: Record<string, { is: (i: any) => boolean; draw: string[] }> = {
    Grass: { is: (i) => i.type === "Grass", draw: ["Grass"] }, Plant: { is: (i) => i.type === "Plant", draw: ["Plant"] }, Tree: { is: (i) => i.type === "Tree", draw: ["Tree"] },
    Billboard: { is: (i) => i.type === "Tree" && i.billboards, draw: ["Billboard"] }, Object: { is: (i) => i.type === "Objects" || i.type === "LargeObjects", draw: ["Object", "LargeObject"] },
  };
  const veg = (rule: Rule): Case | null => {
    const part = rules.vspSystems[rule.system!], type = vegTypes[rule.type!];
    const items = systems.filter((s) => s.active && s.path.toLowerCase().includes(part.toLowerCase())).flatMap((s) => s.packages.flatMap((p: any) => p.itemList ?? [])).filter(type.is);
    if (items.length === 0) return null;
    return {
      category: { id: rule.id, label: rule.label, group: rule.group, kind: "vsp", geometry: { items: items.length, storedInstances: items.reduce((n: number, i: any) => n + i.stored, 0) } },
      off: type.draw.map((t): Step => ["veg.draw", { system: part, type: t }]), on: [vegBack],
    };
  };

  // Components (Stix grass, terrains, post-processing volumes): how many there are is what one switch-off changes.
  const component = async (rule: Rule): Promise<Case | null> => {
    const changed = (await run(bridge, "scene.hide", { component: rule.component })).changed as number;
    await run(bridge, ...sceneBack);
    if (!changed) return null;
    return { category: { id: rule.id, label: rule.label, group: rule.group, kind: "component", geometry: { objects: changed } }, off: [["scene.hide", { component: rule.component }]], on: [sceneBack] };
  };

  // Shadows: the quality level's shadow setting, through the mod's generic get / set.
  const quality = { type: "UnityEngine.QualitySettings", path: "shadows" };
  const shadowsNow = async () => String((await run(bridge, "get", quality)).value);
  const shadowsWas = await shadowsNow();
  const shadows = async (rule: Rule): Promise<Case | null> => {
    const was = shadowsWas;
    if (/^(Disable|0)$/.test(was)) return null;
    const casters = list.reduce((n, c) => n + (c.category.geometry.shadowCasters ?? 0), 0);
    return { category: { id: rule.id, label: rule.label, group: rule.group, kind: "shadows", geometry: { shadowCasters: casters } }, off: [["set", { ...quality, value: "Disable" }]], on: [["set", { ...quality, value: was }]] };
  };

  for (const rule of rules.categories) {
    if (rule.kind === "renderers") continue;
    const made = rule.kind === "vsp" ? veg(rule) : rule.kind === "component" ? await component(rule) : await shadows(rule);
    made ? list.push(made) : absent.push(rule.id);
  }
  await sleep(2000);

  // The "other" rows are counted but not timed unless asked for (--only other).
  const wanted = (c: Case) => !only ? c.category.group !== "Other" : only.some((o) => c.category.id.toLowerCase().startsWith(o.toLowerCase()) || c.category.group.toLowerCase() === o.toLowerCase());
  const run1 = list.filter((c) => c.off.length > 0 && wanted(c));
  const perCase = pause + seconds;
  const minutes = (views.length * (settle + rounds * (run1.length * perCase + (Math.ceil(run1.length / every) + 1) * perCase))) / 60;
  console.log(`${list.length} categories in the scene, ${run1.length} to measure at ${views.length} viewpoint(s), ${rounds} round(s): about ${Math.ceil(minutes)} minutes.`);

  // The cap. --cap says it; a target frame rate without vSync is it; under vSync (GSPro sets it again every
  // frame) it is the display's refresh rate, but Screen.currentResolution has read 60 Hz while the game ran at
  // 75-120 fps (2026-10-13), so it is read off the game itself: straight up at the sky almost nothing is drawn
  // and vSync alone limits. A sky reading that is no common refresh rate means the cap is unknown (something
  // else is loading the graphics card, or vSync is not what limits): then nothing is called "at the cap".
  const probe = (await measure()).raw;
  let capFps: number | null = opt("--cap") ? Number(opt("--cap")) : probe.vSync > 0 ? null : probe.targetFrameRate > 0 ? probe.targetFrameRate : null;
  if (!opt("--cap") && probe.vSync > 0) {
    const before = await run(bridge, "camera", {});
    let sky = 0, steady = false;
    try {
      await run(bridge, "camera", { rotation: [-89, before.rotation[1], 0] });
      await sleep(3000);
      const f = await run(bridge, "fps", { seconds: 3 });
      sky = Number(f.fps);
      // At a vSync cap every frame is one refresh: the median frame is the mean, and the slowest 1 % is close to it.
      // A graphics card shared with another app gave 99.4 fps here once, which is no 100 Hz display (2026-10-13).
      steady = Math.abs(Number(f.medianMs) - Number(f.meanMs)) <= Number(f.meanMs) * 0.01 && Number(f.onePercentLowFps) >= sky * 0.9;
    } finally {
      // Back to where the camera stood (each viewpoint is posed again below).
      await run(bridge, "camera", { position: before.position, rotation: before.rotation });
    }
    capFps = !steady ? null : [60, 75, 90, 120, 144, 165, 240].map((hz) => hz / probe.vSync).find((hz) => Math.abs(hz - sky) <= hz * 0.01) ?? null;
    if (capFps) console.log(`Looking at the sky: ${sky.toFixed(1)} fps, so the frame rate is capped at ${capFps} fps (the display reports ${probe.refreshRate} Hz).`);
    else {
      console.log(`WARNING: looking at the sky the game draws ${sky.toFixed(1)} fps${steady ? "" : ", unsteadily"}, which is no display refresh rate (the display reports ${probe.refreshRate} Hz).`);
      console.log(`  The cap is unknown and nothing will be marked "at the cap". Most likely something else is using the graphics card (Unity, Arborist, a browser): these timings are not the game's own. Close it, or pass --cap <fps>.`);
      notes.push(`The cap could not be found: looking at the sky the game drew ${sky.toFixed(1)} fps, no display refresh rate. Something else was probably using the graphics card, so these timings are not the game's own.`);
    }
  }
  const capMs = capFps ? 1000 / capFps : null;

  const switchTo = async (steps: Step[]) => { for (const [command, a] of steps) await run(bridge, command, a); await sleep(pause * 1000); };
  const reading = async () => (await measure()).ms;
  const done: View[] = [];
  let conditions: any = {};
  try {
    for (const view of views) {
      const at = await pose(view);
      const readings: Reading[] = [];
      for (let round = 0; round < rounds; round++) {
        const first = await measure();
        conditions = { resolution: first.resolution, quality: first.quality };
        readings.push({ ms: first.ms });
        console.log(`\n${view.name}, round ${round + 1}/${rounds}: everything on ${first.ms.toFixed(2)} ms (${first.fps.toFixed(1)} fps, 1 % low ${first.low.toFixed(1)})${atCap(first.ms, capMs) ? "  AT THE CAP" : ""}`);
        for (const [i, c] of run1.entries()) {
          let ms: number;
          await switchTo(c.off);
          try { ms = await reading(); }
          finally { await switchTo(c.on); }
          readings.push({ id: c.category.id, ms });
          console.log(`  ${c.category.label.padEnd(40)} ${ms.toFixed(2).padStart(6)} ms`);
          if (i % every === every - 1 || i === run1.length - 1) readings.push({ ms: await reading() });
        }
      }
      const costs = viewCosts(readings, capMs);
      done.push({ name: view.name, position: at.position, rotation: view.rotation, ...costs });
      if (costs.capped) console.log(`  ${view.name}: everything on is already at the ${capFps} fps cap. Nothing can be measured here: use a heavier viewpoint or a higher resolution.`);
    }
  } finally {
    // Whatever stopped the run, the game is left as it was.
    await restore().catch(() => {});
    for (const c of run1) if (c.category.kind === "shadows") for (const [command, a] of c.on) await run(bridge, command, a).catch(() => {});
  }
  // Proof that it is: nothing was left for the restores to do (each case put its own switch back), and the
  // shadow setting and quality level read as they did at the start.
  const after = (await measure()).raw;
  const left = {
    sceneHideLeft: (await run(bridge, "scene.hide", { restore: true })).restored, vegDrawLeft: (await run(bridge, "veg.draw", { restore: true })).restored,
    shadows: `${shadowsWas} -> ${await shadowsNow()}`, quality: `${probe.quality} -> ${after.quality}`, vSync: `${probe.vSync} -> ${after.vSync}`,
  };
  const leftAsFound = left.sceneHideLeft === 0 && left.vegDrawLeft === 0 && [left.shadows, left.quality, left.vSync].every((s) => s.split(" -> ")[0] === s.split(" -> ")[1]);
  console.log(`\nGame left as found: ${leftAsFound ? "yes" : "NO"}  ${JSON.stringify(left)}`);

  if (rounds < 2) notes.push("One round only: there is no spread to judge a saving by, so treat every number as a smoke test.");
  notes.unshift("Frame time is the mean over a reading (with vSync a frame is a whole number of refreshes, so the median would step).");
  notes.push("veg.draw stops the drawing only: the cells stay loaded and culled, so VSP's CPU work for a type is not in its row (the editor's rows include it).");
  if (capFps) notes.push(`The frame rate is capped at ${capFps} fps: a viewpoint at the cap measures nothing ("at the cap"), and a saving that reaches the cap is a floor (">=").`);
  const report = buildReport({
    source: "game", course, absent, views: done, categories: list.map((c) => c.category),
    conditions: { ...conditions, capFps, rounds, reading: `${seconds} s`, frameMsIs: "mean over a reading", settleSeconds: settle, pauseSeconds: pause, baselineEvery: every, vSync: probe.vSync, reportedRefreshRate: probe.refreshRate, leftAsFound, restoreCheck: left, notes },
  });

  const label = (id: string) => report.categories.find((c) => c.id === id)?.label ?? id;
  console.log(`\nOverall (mean over ${done.length} viewpoint(s)); the rules caught ${(report.coverage.rendererShare * 100).toFixed(1)} % of the renderers, ${(report.coverage.triangleShare * 100).toFixed(1)} % of the triangles`);
  for (const r of report.ranking) if (r.status !== "not run") console.log(`  ${label(r.id).padEnd(40)} ${costText(r)}`);
  if (opt("--json")) writeFileSync(opt("--json")!, JSON.stringify(report, null, 1));
  if (opt("--md")) writeFileSync(opt("--md")!, toMarkdown([report]));
}
