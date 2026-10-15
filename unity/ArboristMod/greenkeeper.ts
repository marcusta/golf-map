// Drives GreenKeeper's Course Flyover Benchmark (mod loaded, see README "GreenKeeper") and puts
// every slow stretch on the map:
//   bun unity/ArboristMod/greenkeeper.ts load <file.gspcrse>        the course, from GreenKeeper's start-up file dialog
//   bun unity/ArboristMod/greenkeeper.ts bench [--label <name>] [--veg <variant>] [--props off] [--built off] [--note <text>] [--settle <s>]
//   bun unity/ArboristMod/greenkeeper.ts report <run folder>        the report of a run again
// A run lands in tree-export/perf/greenkeeper/<stamp>-<label>/: greenkeeper.json (GreenKeeper's own
// table: AVG / MIN per hole, the scores), frames.csv (the mod's frame recorder: every frame's time,
// camera pose, hole and main-thread split), report.md and track.svg (the flight path coloured by
// frame rate). GreenKeeper's MIN is the lowest of its half-second readings (InfoGatherer,
// updateInterval 0.5 s), so the report reads the frames in half-second windows the same way.
// Nothing else may use the CPU while it runs (GSPro and GreenKeeper are main-thread bound).
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { pickBridge, run } from "../mcp/bridge.ts";

const bridge = pickBridge(process.env.GOLFMAP_PLAYER || "greenkeeper", join(process.env.LOCALAPPDATA ?? ".", "GolfMapPlayerBridge"));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const root = resolve(import.meta.dir, "../../tree-export/perf/greenkeeper");
const tools = "/MainGameObjects/GSDcanvas/PanelTools/CourseFlyover";
const browser = "/SimpleFileBrowserCanvas(Clone)/SimpleFileBrowserWindow/Padding";
const GOAL = 110;

const get = async (path: string) => (await run(bridge, "get", { type: "MainLogic", instance: 0, path, items: 40 })).value;
const click = (path: string) => run(bridge, "ui.click", { path });
const shown = async (path: string) => ((await run(bridge, "ui", { contains: path, limit: 50 })).controls as { path: string; interactable: boolean }[]).some((c) => c.path === path && c.interactable);
const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const stamp = () => {
  const d = new Date(), p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
};

async function load(file: string) {
  if (!(await shown(`${browser}/BottomView/Padding/BottomRow/SubmitButton`))) throw new Error("GreenKeeper's Load Course File dialog is not up (it shows at start-up).");
  const full = resolve(file).replace(/\\/g, "/");
  await run(bridge, "ui.type", { path: `${browser}/TopView/PathInputFieldSlotTop/PathInputField`, text: dirname(full) });
  await sleep(1500);
  await run(bridge, "ui.type", { path: `${browser}/BottomView/Padding/TopRow/FilenameInputField`, text: basename(full) });
  await click(`${browser}/BottomView/Padding/BottomRow/SubmitButton`);
  const start = Date.now();
  for (;;) {
    await sleep(5000);
    if (await get("GKDLoaded").catch(() => false)) break;
    if (Date.now() - start > 15 * 60_000) throw new Error("The course did not load within 15 minutes.");
  }
  console.log(`Loaded ${basename(full)} in ${Math.round((Date.now() - start) / 1000)} s.`);
}

type Frame = { t: number; dt: number; pre: number; scripts: number; late: number; render: number; after: number; x: number; y: number; z: number; yaw: number; pitch: number; hole: number; gc: number };
type Window = { i0: number; i1: number; fps: number; hole: number; x: number; y: number; z: number; yaw: number; pitch: number; split: Record<string, number>; gc: number; worstMs: number };

// The recording runs a few seconds past the flyover's end (the results panel is polled), with the
// camera standing still wherever it was before the run: those frames are not the flyover.
const readFrames = (file: string): Frame[] => {
  const [head, ...rows] = readFileSync(file, "utf8").trim().split(/\r?\n/);
  const keys = head.split(",");
  const frames = rows.map((r) => Object.fromEntries(r.split(",").map((v, i) => [keys[i], Number(v)])) as unknown as Frame);
  let end = frames.length;
  while (end > 1 && Math.hypot(frames[end - 1].x - frames[end - 2].x, frames[end - 1].z - frames[end - 2].z) < 0.01 && frames[end - 1].yaw === frames[end - 2].yaw) end--;
  return frames.slice(0, end);
};

// Half-second windows, as GreenKeeper's InfoGatherer reads them.
function windows(frames: Frame[], seconds = 0.5): Window[] {
  const out: Window[] = [];
  let i0 = 0, ms = 0;
  for (let i = 0; i < frames.length; i++) {
    ms += frames[i].dt;
    if (ms < seconds * 1000) continue;
    const span = frames.slice(i0, i + 1);
    const mid = frames[Math.floor((i0 + i) / 2)];
    const mean = (k: keyof Frame) => Math.round((span.reduce((s, f) => s + f[k], 0) / span.length) * 100) / 100;
    out.push({
      i0, i1: i, fps: Math.round((span.length / ms) * 10000) / 10, hole: mid.hole, x: mid.x, y: mid.y, z: mid.z, yaw: mid.yaw, pitch: mid.pitch,
      split: { dt: mean("dt"), pre: mean("pre"), scripts: mean("scripts"), late: mean("late"), render: mean("render"), after: mean("after") },
      gc: span.reduce((s, f) => s + f.gc, 0), worstMs: Math.max(...span.map((f) => f.dt)),
    });
    i0 = i + 1; ms = 0;
  }
  return out;
}

// The slowest windows, at least `apart` metres from a slower one already taken.
const HITCH_MS = 100;
function hotspots(ws: Window[], n: number, apart = 60): Window[] {
  const taken: Window[] = [];
  for (const w of [...ws].filter((w) => w.worstMs < HITCH_MS).sort((a, b) => a.fps - b.fps)) {
    if (taken.length >= n) break;
    if (taken.every((t) => Math.hypot(t.x - w.x, t.z - w.z) > apart)) taken.push(w);
  }
  return taken;
}

function trackSvg(ws: Window[]): string {
  const xs = ws.map((w) => w.x), zs = ws.map((w) => w.z);
  const [x0, x1, z0, z1] = [Math.min(...xs) - 40, Math.max(...xs) + 40, Math.min(...zs) - 40, Math.max(...zs) + 40];
  const scale = 1000 / Math.max(x1 - x0, z1 - z0);
  const px = (x: number) => ((x - x0) * scale).toFixed(1), pz = (z: number) => ((z1 - z) * scale).toFixed(1);
  const colour = (fps: number) => (fps >= GOAL ? "#2e9e5b" : fps >= 100 ? "#e0a52a" : fps >= 90 ? "#e0662a" : "#c8202a");
  const parts: string[] = [];
  for (let i = 1; i < ws.length; i++) {
    const a = ws[i - 1], b = ws[i];
    if (Math.hypot(a.x - b.x, a.z - b.z) > 150) continue; // a jump between holes
    parts.push(`<line x1="${px(a.x)}" y1="${pz(a.z)}" x2="${px(b.x)}" y2="${pz(b.z)}" stroke="${colour(b.fps)}" stroke-width="5" stroke-linecap="round"/>`);
  }
  const seen = new Set<number>();
  for (const w of ws) if (w.hole > 0 && !seen.has(w.hole)) { seen.add(w.hole); parts.push(`<text x="${px(w.x)}" y="${pz(w.z)}" font-size="22" font-family="sans-serif" fill="#222">${w.hole}</text>`); }
  hotspots(ws, 12).forEach((w, i) => parts.push(`<circle cx="${px(w.x)}" cy="${pz(w.z)}" r="10" fill="none" stroke="#000" stroke-width="2"/><text x="${Number(px(w.x)) + 12}" y="${Number(pz(w.z)) + 18}" font-size="16" font-family="sans-serif">#${i + 1} ${w.fps}</text>`));
  const w = ((x1 - x0) * scale).toFixed(0), h = ((z1 - z0) * scale).toFixed(0);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"><rect width="100%" height="100%" fill="#f4f4ef"/>${parts.join("")}<text x="10" y="24" font-size="18" font-family="sans-serif">fps per 0.5 s: green >= ${GOAL}, yellow 100-110, orange 90-100, red &lt; 90. North up; x right.</text></svg>`;
}

function report(dir: string) {
  const gk = JSON.parse(readFileSync(join(dir, "greenkeeper.json"), "utf8"));
  const frames = readFrames(join(dir, "frames.csv"));
  const ws = windows(frames);
  const holes = [...new Set(ws.map((w) => w.hole).filter((h) => h > 0))].sort((a, b) => a - b);
  const lines: string[] = [
    `# GreenKeeper flyover: ${gk.label}`, "",
    `${gk.started}, ${gk.resolution} ${gk.quality}, vegetation '${gk.veg ?? "all"}'${gk.propsOff ? ", props off" : ""}${gk.builtOff ? ", props/walls/power lines off" : ""}, ${frames.length} frames over ${Math.round(frames.reduce((s, f) => s + f.dt, 0) / 1000)} s. ${gk.note ?? ""}`, "",
    `GreenKeeper: whole course score **${gk.scoreAvg}**, worst hole score ${gk.worstHoleScore}; goal: no hole under ${GOAL}.`, "",
    "| hole | GK avg | GK min | our avg | our min (0.5 s) | ms at the min: pre / scripts / late / render / after | where (x, y, z, yaw) |",
    "|---|---|---|---|---|---|---|",
  ];
  for (const h of holes) {
    const hw = ws.filter((w) => w.hole === h);
    const frs = hw.flatMap((w) => frames.slice(w.i0, w.i1 + 1));
    const avg = Math.round((frs.length / frs.reduce((s, f) => s + f.dt, 0)) * 10000) / 10;
    const steady = hw.filter((w) => w.worstMs < HITCH_MS);
    const min = (steady.length ? steady : hw).reduce((a, b) => (b.fps < a.fps ? b : a));
    const s = min.split;
    const flag = (v: number) => (v < GOAL ? `**${v}**` : `${v}`);
    lines.push(`| ${h} | ${flag(gk.holeAvg?.[h - 1])} | ${flag(gk.holeMin?.[h - 1])} | ${avg} | ${min.fps} | ${s.pre} / ${s.scripts} / ${s.late} / ${s.render} / ${s.after} | ${Math.round(min.x)}, ${Math.round(min.y)}, ${Math.round(min.z)}, ${Math.round(min.yaw)} |`);
  }
  const hitches = ws.filter((w) => w.worstMs >= HITCH_MS);
  lines.push("", `Hitches (a frame of ${HITCH_MS} ms or more; left out of "our min" and the places below): ${hitches.map((w) => `hole ${w.hole} ${Math.round(w.worstMs)} ms at ${Math.round(w.x)}, ${Math.round(w.z)}`).join("; ") || "none"}.`);
  lines.push("", "## The slowest places (0.5 s windows, at least 60 m apart)", "", "| # | fps | hole | x, y, z | yaw / pitch | dt | pre | scripts | late | render | after | gc |", "|---|---|---|---|---|---|---|---|---|---|---|---|");
  hotspots(ws, 15).forEach((w, i) => {
    const s = w.split;
    lines.push(`| ${i + 1} | ${w.fps} | ${w.hole} | ${Math.round(w.x)}, ${Math.round(w.y)}, ${Math.round(w.z)} | ${Math.round(w.yaw)} / ${Math.round(w.pitch)} | ${s.dt} | ${s.pre} | ${s.scripts} | ${s.late} | ${s.render} | ${s.after} | ${w.gc} |`);
  });
  lines.push("", "Split: pre = present / wait for the GPU and early scripts, scripts = Update/LateUpdate scripts around ours, late = the LateUpdate scripts after ours, Cinemachine and VSP's culling, render = the game camera's cull and draw, after = other cameras, post, UI. A large pre with a small rest means the GPU is the limit.", "");
  writeFileSync(join(dir, "report.md"), lines.join("\n"));
  writeFileSync(join(dir, "track.svg"), trackSvg(ws));
  writeFileSync(join(dir, "windows.json"), JSON.stringify(ws.map(({ i0, i1, ...w }) => w)));
  console.log(lines.join("\n"));
}

// Which vegetation draws (--veg). Everything goes through veg.set (runtime spawn off for the picked
// items, stored=false for the placed instances), never through switching a VegetationSystemPro
// component off: in GreenKeeper the systems draw through the camera GreenKeeper hands them when its
// VSPRO ("ARBORIST") toggle is ON, and a component switched off and on again came back drawing
// nothing or only part (2026-10-14: the first queue's variants after "none" were not what they said).
// Stix 3D grass is plain GrassRenderer components (scene.hide component=GrassRenderer).
const arborist = "/MainGameObjects";
const course = "/VegetationStudioPro";
type Veg = { stix: boolean; arborist: boolean; course: string[] };
const ALL = ["Grass", "Plant", "Tree"];
const VEG: Record<string, Veg> = {
  all: { stix: true, arborist: true, course: ALL },
  none: { stix: false, arborist: false, course: [] },
  stix: { stix: true, arborist: false, course: [] },
  grass: { stix: false, arborist: false, course: ["Grass"] },
  "stix-grass": { stix: true, arborist: false, course: ["Grass"] },
  "grass-arborist": { stix: false, arborist: true, course: ["Grass"] },
  "grass-trees": { stix: false, arborist: false, course: ["Grass", "Tree"] },
  "stix-grass-arborist": { stix: true, arborist: true, course: ["Grass"] },
  "stix-grass-trees": { stix: true, arborist: false, course: ["Grass", "Tree"] },
  "stix-grass-plants": { stix: true, arborist: false, course: ["Grass", "Plant"] },
  "no-stix": { stix: false, arborist: true, course: ALL },
  "no-arborist": { stix: true, arborist: false, course: ALL },
  "no-course-trees": { stix: true, arborist: true, course: ["Grass", "Plant"] },
  "no-course-grass": { stix: true, arborist: true, course: ["Plant", "Tree"] },
  arborist: { stix: false, arborist: true, course: [] },
  trees: { stix: false, arborist: false, course: ["Tree"] },
};

async function applyVeg(name: string) {
  const v = VEG[name];
  if (!v) throw new Error(`--veg is one of ${Object.keys(VEG).join(", ")}`);
  await ensureVspro();
  if (!v.stix) {
    const r = await run(bridge, "scene.hide", { component: "GrassRenderer" });
    console.log(`  Stix 3D grass: ${r.changed} renderer(s) off`);
    if (!r.changed) throw new Error("Stix 3D grass: nothing was switched off (a scene.hide restore missing?)");
  }
  if (!v.arborist) {
    const st = await run(bridge, "veg.set", { system: arborist, stored: false });
    const sp = await run(bridge, "veg.set", { system: arborist, spawn: false });
    console.log(`  Arborist: placed off in ${st.storages} storage(s), spawn off on ${sp.items} item(s)`);
    if (!st.storages) throw new Error("Arborist: no storage switched off");
  }
  for (const type of [...ALL, "Objects", "LargeObjects"].filter((t) => !v.course.includes(t))) {
    const r = await run(bridge, "veg.set", { system: course, type, spawn: false });
    if (r.items) console.log(`  course VSP ${type}: spawn off on ${r.items} item(s)`);
  }
  if (!v.course.includes("Tree")) {
    const r = await run(bridge, "veg.set", { system: course, stored: false });
    console.log(`  course VSP placed trees: off in ${r.storages} storage(s)`);
  }
  return v;
}

// GreenKeeper's VSPRO toggle (Base panel, labelled ARBORIST ON/OFF) is OFF after a restart and
// after every flyover, and then neither system draws: ON hands both active systems the game camera
// (TVGCamera). The toggle lives on the Base panel; the benchmark button on the Tools panel.
const opDD = "/MainGameObjects/GSDcanvas/panelBase/opDD";
const vsproOn = async () =>
  ((await run(bridge, "veg.systems", { items: false })) as { active: boolean; cameras: string[] }[])
    .filter((s) => s.active).every((s) => s.cameras.some((c) => c !== "(none)"));
async function ensureVspro() {
  if (await vsproOn()) return;
  await run(bridge, "ui.click", { path: opDD, value: 0 });
  await sleep(1500);
  await click("/MainGameObjects/GSDcanvas/PanelData/TogglePnlVSPRO/toggleGroup1/VSPROEnabled");
  await sleep(3000);
  await run(bridge, "ui.click", { path: opDD, value: 7 });
  await sleep(1500);
  if (!(await vsproOn())) throw new Error("Switched GreenKeeper's VSPRO toggle ON, but the vegetation systems still have no camera.");
  console.log("  VSPRO switched ON (the vegetation was not drawing)");
}

// Every prop (cars, buildings, structures, small props: the "/GolfMap Props" tree), stone walls
// and rocks, power lines: --props off / --built off.
async function applyBuilt(props: boolean, built: boolean) {
  if (props) await run(bridge, "scene.hide", { path: "/GolfMap Props" });
  if (built) for (const path of ["/GolfMap Props", "/GolfMap Walls", "/GolfMap Power Lines"]) await run(bridge, "scene.hide", { path });
}

async function restoreVeg() {
  await run(bridge, "scene.hide", { restore: true });
  await run(bridge, "veg.set", { restore: true });
}

async function bench() {
  const label = arg("label", "run")!;
  const veg = arg("veg", "all")!;
  const propsOff = arg("props") === "off", builtOff = arg("built") === "off";
  if (!(await get("GKDLoaded"))) throw new Error("No course is loaded in GreenKeeper (greenkeeper.ts load <file>).");
  // The last run's results panel stays up until closed; a run that starts with it up would read the
  // old table at once (2026-10-14: "base-b" was base-a's numbers).
  if (await get("BenchMarkResultsPnl.activeSelf")) await run(bridge, "call", { type: "MainLogic", instance: 0, path: "BenchMarkResultsPnl", method: "SetActive", args: [false] });
  const benchUp = async () => (await shown(`${tools}/FlyOverBtn`)) || (await shown(`${tools}/FlyoverConfirm/StartButton`));
  // A freshly loaded course shows the Base panel, its dropdown at Tools or not: the dropdown only
  // switches panels on a change, so go through Base (0) to Tools (7).
  if (!(await benchUp())) {
    await run(bridge, "ui.click", { path: opDD, value: 0 }); await sleep(1500);
    await run(bridge, "ui.click", { path: opDD, value: 7 }); await sleep(1500);
  }
  if (!(await benchUp()))
    throw new Error("The Course Flyover Benchmark button is not up: a flyover still running, or another Select Operation than Tools.");
  const dir = join(root, `${stamp()}-${label.replace(/[^\w.-]+/g, "_")}`);
  mkdirSync(dir, { recursive: true });
  const changed = veg !== "all" || propsOff || builtOff;
  let recording = false;
  try {
    const vegState = await applyVeg(veg);
    await applyBuilt(propsOff, builtOff);
    // A refreshed VSP system loads its cells again for a while: give a changed one longer.
    const settle = Number(arg("settle", changed ? "90" : "20"));
    if (settle > 0) { console.log(`Vegetation '${veg}'${propsOff ? ", props off" : ""}${builtOff ? ", built off" : ""}; settling ${settle} s...`); await sleep(settle * 1000); }
    const info = await run(bridge, "fps", { seconds: 1 });
    await run(bridge, "trace.start", { hole: "MainLogic.CartOnHole" });
    recording = true;
    if (!(await shown(`${tools}/FlyoverConfirm/StartButton`))) await click(`${tools}/FlyOverBtn`);
    for (let i = 0; !(await shown(`${tools}/FlyoverConfirm/StartButton`)); i++) {
      if (i > 20) throw new Error("The flyover's Start button did not come up.");
      await sleep(500);
    }
    await click(`${tools}/FlyoverConfirm/StartButton`);
    const started = new Date();
    console.log(`Flyover started ${started.toLocaleTimeString()}, writing to ${dir}`);
    let lastHole = -1;
    for (;;) {
      await sleep(10_000);
      const st = await run(bridge, "trace.status", {});
      if (st.hole !== lastHole) { console.log(`  hole ${st.hole} (${st.fpsLastSecond} fps, ${st.frames} frames)`); lastHole = st.hole; }
      if (await get("BenchMarkResultsPnl.activeSelf")) break;
      if (Date.now() - started.getTime() > 60 * 60_000) throw new Error("The flyover did not finish within an hour.");
    }
    await sleep(3000);
    await run(bridge, "trace.stop", { file: join(dir, "frames.csv") });
    recording = false;
    const gk = {
      label, veg, vegetation: vegState, propsOff, builtOff, note: arg("note"), started: started.toISOString(), seconds: Math.round((Date.now() - started.getTime()) / 1000),
      resolution: info.resolution, quality: info.quality,
      holeAvg: await get("holefpsaverages"), holeMin: await get("holefpsmins"), holeScores: await get("holefpsscores"),
      avgOfAvg: await get("avgofavg"), worstHoleFpsMin: await get("worstholefpsmin"),
      scoreAvg: await get("ScoreAvgInt"), worstHoleScore: await get("WorstHoleScoreInt"), targetFps: await get("TargetFPS"),
    };
    writeFileSync(join(dir, "greenkeeper.json"), JSON.stringify(gk, null, 2));
    const card = "C:/GSProV1/Core/GSP/Courses/Vreta_lidar_scene/vreta_lidar_scene_benchmark.jpg";
    await sleep(5000);
    if (existsSync(card)) copyFileSync(card, join(dir, "benchmark.jpg"));
    const shot = await run(bridge, "screen", {}).catch(() => undefined);
    if (shot?.file) copyFileSync(shot.file, join(dir, "results.png"));
  } finally {
    if (recording) await run(bridge, "trace.stop", { file: join(dir, "frames.partial.csv") }).catch(() => undefined);
    if (changed) await restoreVeg();
  }
  report(dir);
  console.log(`
${dir}`);
}

const [action, target] = process.argv.slice(2);
if (action === "load" && target) await load(target);
else if (action === "bench") await bench();
else if (action === "report" && target) report(resolve(target));
else console.log("usage: greenkeeper.ts load <file.gspcrse> | bench [--label <name>] [--note <text>] [--settle <s>] | report <run folder>");
