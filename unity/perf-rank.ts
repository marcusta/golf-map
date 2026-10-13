// The performance ranking's shared model: what costs frame time on a course, per category.
// Pure logic, no bridge: the category rules (Editor/GolfMap/GolfMapPerfCategories.json), the
// statistics that turn readings into a cost, the report (golfmap-perf-rank-v1) and its markdown.
// The game side (ArboristMod/perf.ts --rank) builds its report here; the editor side
// (Editor/GolfMap/GolfMapPerf.cs, golfmap.perf.report) does the same sums in C# and writes the same
// JSON, so the two can be laid side by side. Change a rule of the statistics in both.
// Tests: bun test unity/perf-rank.test.ts
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const FORMAT = "golfmap-perf-rank-v1";
export const RULES_FILE = join(import.meta.dir, "Editor/GolfMap/GolfMapPerfCategories.json");

export interface Rule {
  id: string;
  label: string;
  group: string;
  kind: "renderers" | "component" | "vsp" | "shadows";
  match?: string; // renderers: regex on the hierarchy path
  component?: string; // component: part of the full type name
  system?: string; // vsp: key of vspSystems
  type?: string; // vsp: Grass | Plant | Tree | Billboard | Object
}
export interface Rules {
  format: string;
  vspSystems: Record<string, string>;
  categories: Rule[];
}

export function loadRules(file = RULES_FILE): Rules {
  const rules = JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, "")) as Rules;
  if (rules.format !== "golfmap-perf-categories-v1") throw new Error(`${file} is not golfmap-perf-categories-v1.`);
  return rules;
}

// One unit of a category (a car, a wall, a course mesh): the path up to the end of the segment the
// match ends in, or of the next one when the match ends on a slash.
function unitOf(path: string, matchEnd: number): string {
  const slash = path.indexOf("/", matchEnd);
  return slash < 0 ? path : path.slice(0, slash);
}

// The category of a renderer by its hierarchy path. The mod (scene.geometry groups=) and the editor
// (GolfMapPerf.GroupOf) do the same with the same rules; this one is what the tests run.
export function categoryOf(rules: Rules, path: string): { id: string; label: string; group: string; unit: string } {
  for (const rule of rules.categories) {
    if (rule.kind !== "renderers" || !rule.match) continue;
    const m = new RegExp(rule.match).exec(path);
    if (m) return { id: rule.id, label: rule.label, group: rule.group, unit: unitOf(path, m.index + m[0].length) };
  }
  const root = path.split("/")[1] ?? "";
  const key = otherKey(root);
  return { id: "other:" + key, label: "Other: " + key, group: "Other", unit: "/" + root };
}

// Numbered siblings and instantiated copies share one "other" row: FlagAssembly_0..17 -> FlagAssembly_#,
// teeMarker(Clone)143 -> teeMarker#. One unit of it is a root object.
export function otherKey(root: string): string {
  return root.split("(Clone)").join("").replace(/[0-9]+/g, "#").trim();
}

export const SMALL_OTHER = "other:small";

// Every "other" row holding under 0.5 % of the scene's triangles and under 0.5 % of its renderers goes into
// one row, "Other: small objects (N roots)", whose members are listed in the JSON only (a game scene has
// dozens of such roots: flags, cups, tee markers, hazard stakes). A single small row stays as it is.
// Distinct meshes and materials cannot be added up from counts, so the folded row leaves them out here
// (the editor, which holds the objects, counts them).
export function foldOthers(categories: Category[]): Category[] {
  const mesh = categories.filter((c) => c.kind === "renderers");
  const total = (key: "renderers" | "triangles") => mesh.reduce((n, c) => n + (c.geometry[key] ?? 0), 0);
  const renderers = total("renderers"), triangles = total("triangles");
  const small = mesh.filter((c) => c.id.startsWith("other:") && (c.geometry.triangles ?? 0) < 0.005 * triangles && (c.geometry.renderers ?? 0) < 0.005 * renderers);
  if (small.length < 2) return categories;
  const sum = (key: keyof Geometry) => small.reduce((n, c) => n + ((c.geometry[key] as number | null | undefined) ?? 0), 0);
  const folded: Category = {
    id: SMALL_OTHER, label: `Other: small objects (${sum("objects")} roots)`, group: "Other", kind: "renderers", members: small.map((c) => c.id),
    geometry: {
      objects: sum("objects"), renderers: sum("renderers"), inactiveRenderers: sum("inactiveRenderers"), triangles: sum("triangles"), trianglesLod0: sum("trianglesLod0"),
      meshes: null, materials: null, shadowCasters: sum("shadowCasters"), lodGroups: sum("lodGroups"), batchedRenderers: sum("batchedRenderers"),
    },
  };
  return [...categories.filter((c) => !small.includes(c)), folded];
}

// ---- statistics ---------------------------------------------------------------------------------

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// A viewpoint's readings in the order they were taken: baselines (everything on) with the cases
// (one category off) between them.
export interface Reading {
  id?: string; // none: a baseline
  ms: number; // frame time
}
export type Status = "measured" | "floor" | "noise" | "capped";
export interface Cost {
  id: string;
  savedMs: number; // median over the rounds of (baseline around the case) - (case)
  spreadMs: number; // largest minus smallest of those differences
  fpsGain: number | null; // what savedMs is in fps at this viewpoint
  share: number; // savedMs / baseline frame time
  status: Status;
  caseMs: number;
  deltas: number[];
}
export interface ViewCosts {
  baselineMs: number;
  baselineFps: number;
  noiseMs: number;
  capped: boolean;
  baselines: number[];
  costs: Cost[];
}

// A frame time within 3 % of the cap's is at the cap (a 5 s reading at a 120 Hz vSync reads 119.6 to 120.0).
// Slower than that is below the cap and measures normally; faster means the cap is not what was assumed
// (the display reported 60 Hz while the game ran at 86 fps, 2026-10-13), and is not "at the cap" either.
export const atCap = (ms: number, capMs: number | null | undefined) => capMs != null && capMs > 0 && Math.abs(ms - capMs) <= capMs * 0.03;

// What each category costs at one viewpoint.
// - A case is compared with the baselines taken just before and just after it (their mean), so slow
//   drift (GPU clocks, cells loading) does not land on the case.
// - noiseMs: the median difference between one baseline and the next, i.e. how much the same scene
//   differs from one reading to another.
// - status noise ("not measurable"): the saving is no larger than the noise, or than half the spread
//   of its own rounds. capped: the baseline itself is at the frame-rate cap, so nothing can be
//   measured here. floor: the case reached the cap, so the saving is at least this much.
export function viewCosts(readings: Reading[], capMs?: number | null): ViewCosts {
  const baselines = readings.filter((r) => r.id == null).map((r) => r.ms);
  const baselineMs = median(baselines);
  const steps: number[] = [];
  for (let i = 1; i < baselines.length; i++) steps.push(Math.abs(baselines[i] - baselines[i - 1]));
  const noiseMs = median(steps);
  const capped = atCap(baselineMs, capMs);
  const deltas = new Map<string, number[]>();
  const caseMs = new Map<string, number[]>();
  readings.forEach((r, i) => {
    if (r.id == null) return;
    let before: number | null = null, after: number | null = null;
    for (let j = i - 1; j >= 0 && before == null; j--) if (readings[j].id == null) before = readings[j].ms;
    for (let j = i + 1; j < readings.length && after == null; j++) if (readings[j].id == null) after = readings[j].ms;
    const around = before != null && after != null ? (before + after) / 2 : (before ?? after ?? baselineMs);
    if (!deltas.has(r.id)) { deltas.set(r.id, []); caseMs.set(r.id, []); }
    deltas.get(r.id)!.push(around - r.ms);
    caseMs.get(r.id)!.push(r.ms);
  });
  const costs: Cost[] = [];
  for (const [id, d] of deltas) {
    const savedMs = median(d);
    const spreadMs = Math.max(...d) - Math.min(...d);
    const off = median(caseMs.get(id)!);
    let status: Status = "measured";
    if (capped) status = "capped";
    else if (Math.abs(savedMs) <= noiseMs || Math.abs(savedMs) <= spreadMs / 2) status = "noise";
    else if (atCap(off, capMs)) status = "floor";
    costs.push({
      id, savedMs, spreadMs, status, caseMs: off, deltas: d,
      fpsGain: baselineMs > 0 && baselineMs - savedMs > 0 ? 1000 / (baselineMs - savedMs) - 1000 / baselineMs : null,
      share: baselineMs > 0 ? savedMs / baselineMs : 0,
    });
  }
  costs.sort((a, b) => b.savedMs - a.savedMs);
  return { baselineMs, baselineFps: baselineMs > 0 ? 1000 / baselineMs : 0, noiseMs, capped, baselines, costs };
}

// ---- report -------------------------------------------------------------------------------------

export interface Geometry {
  objects?: number | null;
  renderers?: number | null; // active and enabled
  inactiveRenderers?: number | null;
  triangles?: number | null; // every LOD level of the active renderers
  trianglesLod0?: number | null; // the nearest level only (and renderers in no LODGroup)
  meshes?: number | null;
  materials?: number | null;
  shadowCasters?: number | null;
  lodGroups?: number | null;
  batchedRenderers?: number | null; // game: static batching, triangles are then an upper bound
  items?: number | null; // VSP
  storedInstances?: number | null; // VSP
}
export interface Category {
  id: string;
  label: string;
  group: string;
  kind: string;
  geometry: Geometry;
  members?: string[]; // other:small: the "other" rows folded into it
}
export interface View extends ViewCosts {
  name: string;
  position?: number[];
  rotation?: number[];
  // editor: what the Scene view camera drew of each VSP category at this viewpoint
  inView?: Record<string, { instances: number; triangles: number }>;
}
export interface RankRow {
  id: string;
  savedMs: number | null; // mean over the viewpoints that could measure (noise counts as 0); null: none could
  share: number | null;
  fpsGain: number | null;
  measuredViews: number;
  views: number;
  status: Status | "not run";
}
export interface Report {
  format: string;
  source: "editor" | "game";
  course: string;
  created: string;
  conditions: Record<string, unknown>;
  categories: Category[];
  absent: string[]; // rule ids with nothing in the scene
  coverage: { renderers: number; categorisedRenderers: number; rendererShare: number; triangles: number; categorisedTriangles: number; triangleShare: number; other: string[] };
  views: View[];
  ranking: RankRow[];
}

const round = (n: number | null | undefined, digits = 3) => (n == null || !isFinite(n) ? null : Math.round(n * 10 ** digits) / 10 ** digits);

// How much of the scene's mesh renderers the named rules caught; the rest is in "other:<root>".
export function coverage(categories: Category[]): Report["coverage"] {
  const mesh = categories.filter((c) => c.kind === "renderers");
  const sum = (list: Category[], key: "renderers" | "triangles") => list.reduce((n, c) => n + (c.geometry[key] ?? 0), 0);
  const named = mesh.filter((c) => !c.id.startsWith("other:"));
  const renderers = sum(mesh, "renderers"), triangles = sum(mesh, "triangles");
  return {
    renderers, categorisedRenderers: sum(named, "renderers"), rendererShare: round(renderers ? sum(named, "renderers") / renderers : 1, 4)!,
    triangles, categorisedTriangles: sum(named, "triangles"), triangleShare: round(triangles ? sum(named, "triangles") / triangles : 1, 4)!,
    other: mesh.filter((c) => c.id.startsWith("other:")).map((c) => c.id),
  };
}

// Overall: the mean saving over the viewpoints that could measure it. A capped viewpoint says
// nothing and is left out; a saving inside the noise counts as none.
export function ranking(categories: Category[], views: ViewCosts[]): RankRow[] {
  const rows = categories.map((c): RankRow => {
    const costs = views.map((v) => ({ v, cost: v.costs.find((k) => k.id === c.id) })).filter((x) => x.cost) as { v: ViewCosts; cost: Cost }[];
    const usable = costs.filter((x) => x.cost.status !== "capped");
    if (costs.length === 0) return { id: c.id, savedMs: null, share: null, fpsGain: null, measuredViews: 0, views: 0, status: "not run" };
    if (usable.length === 0) return { id: c.id, savedMs: null, share: null, fpsGain: null, measuredViews: 0, views: costs.length, status: "capped" };
    const counted = (x: { cost: Cost }) => x.cost.status === "noise" ? 0 : 1;
    const mean = (f: (x: { v: ViewCosts; cost: Cost }) => number) => usable.reduce((n, x) => n + counted(x) * f(x), 0) / usable.length;
    const real = usable.filter((x) => x.cost.status !== "noise");
    return {
      id: c.id, savedMs: mean((x) => x.cost.savedMs), share: mean((x) => x.cost.share), fpsGain: mean((x) => x.cost.fpsGain ?? 0),
      measuredViews: real.length, views: costs.length,
      status: real.length === 0 ? "noise" : real.some((x) => x.cost.status === "floor") ? "floor" : "measured",
    };
  });
  // Measured savings first, largest first; then what could not be measured or was not run, by triangles;
  // the "other" rows last.
  const cat = new Map(categories.map((c) => [c.id, c]));
  const real = (r: RankRow) => r.status === "measured" || r.status === "floor";
  const tier = (r: RankRow) => (real(r) ? 0 : r.id.startsWith("other:") ? 2 : 1);
  const tris = (r: RankRow) => cat.get(r.id)?.geometry.triangles ?? -1;
  return rows.sort((a, b) => tier(a) - tier(b) || (real(a) ? b.savedMs! - a.savedMs! : tris(b) - tris(a)));
}

export function buildReport(input: {
  source: Report["source"]; course: string; created?: string; conditions: Record<string, unknown>;
  categories: Category[]; absent?: string[]; views: (View | (ViewCosts & { name: string }))[];
}): Report {
  const tidyCost = (c: Cost): Cost => ({ ...c, savedMs: round(c.savedMs)!, spreadMs: round(c.spreadMs)!, fpsGain: round(c.fpsGain, 1), share: round(c.share, 4)!, caseMs: round(c.caseMs)!, deltas: c.deltas.map((d) => round(d)!) });
  const views = input.views.map((v) => ({
    ...v, baselineMs: round(v.baselineMs)!, baselineFps: round(v.baselineFps, 1)!, noiseMs: round(v.noiseMs)!,
    baselines: v.baselines.map((b) => round(b)!), costs: v.costs.map(tidyCost),
  })) as View[];
  return {
    format: FORMAT, source: input.source, course: input.course, created: input.created ?? new Date().toISOString().slice(0, 19),
    conditions: input.conditions, categories: input.categories, absent: input.absent ?? [], coverage: coverage(input.categories), views,
    ranking: ranking(input.categories, input.views).map((r) => ({ ...r, savedMs: round(r.savedMs), share: round(r.share, 4), fpsGain: round(r.fpsGain, 1) })),
  };
}

export function isReport(value: any): value is Report {
  return !!value && value.format === FORMAT && (value.source === "editor" || value.source === "game")
    && Array.isArray(value.categories) && Array.isArray(value.views) && Array.isArray(value.ranking) && !!value.coverage
    && value.categories.every((c: any) => typeof c.id === "string" && typeof c.label === "string" && !!c.geometry)
    && value.views.every((v: any) => typeof v.name === "string" && typeof v.baselineMs === "number" && Array.isArray(v.costs));
}

// ---- markdown -----------------------------------------------------------------------------------

const count = (n: number | null | undefined) => (n == null ? "-" : n >= 1e6 ? (n / 1e6).toFixed(2) + " M" : n >= 1e4 ? Math.round(n / 1e3) + " k" : String(n));
const signed = (n: number, digits: number) => (n >= 0 ? "+" : "") + n.toFixed(digits);

// One saving as text: "1.20 ms (+9.1 fps, 12 %)", "not measurable", "at the cap", ">= 0.80 ms".
export function costText(c: { savedMs: number | null; fpsGain: number | null; share: number | null; status: string } | undefined): string {
  if (!c || c.status === "not run") return "-";
  if (c.status === "capped" || c.savedMs == null) return "at the cap";
  if (c.status === "noise") return "not measurable";
  const fps = c.fpsGain == null ? "" : `${signed(c.fpsGain, 1)} fps, `;
  return `${c.status === "floor" ? ">= " : ""}${c.savedMs.toFixed(2)} ms (${fps}${((c.share ?? 0) * 100).toFixed(0)} %)`;
}

function table(head: string[], rows: string[][]): string {
  return [`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n");
}

// One report, or the editor's and the game's side by side (same categories, a cost column each).
export function toMarkdown(reports: Report[]): string {
  const out: string[] = [`# What costs frame time: ${reports[0].course}`, ""];
  const title = (r: Report) => (r.source === "editor" ? "Unity editor" : "GSPro");
  for (const r of reports) {
    const c = r.conditions as any;
    out.push(`- **${title(r)}** (${r.created}): ${[c.resolution, c.quality, c.reading && `${c.rounds} x ${c.reading}`, c.capFps ? `capped at ${c.capFps} fps` : r.source === "game" ? "frame-rate cap unknown" : "no frame-rate cap"].filter(Boolean).join(", ")}.`
      + ` Rules caught ${(r.coverage.rendererShare * 100).toFixed(1)} % of the renderers and ${(r.coverage.triangleShare * 100).toFixed(1)} % of the triangles${r.coverage.other.length ? ` (the rest: ${r.coverage.other.slice(0, 6).join(", ")}${r.coverage.other.length > 6 ? ` and ${r.coverage.other.length - 6} more` : ""})` : ""}.`);
    for (const note of (c.notes ?? []) as string[]) out.push(`  - ${note}`);
  }
  const ids: string[] = [];
  for (const r of reports) for (const row of r.ranking) if (!ids.includes(row.id)) ids.push(row.id);
  const find = (r: Report, id: string) => r.categories.find((c) => c.id === id);
  // The short answer first: the largest costs overall, and each viewpoint's baseline with its largest.
  const real = (c: { status: string; savedMs: number | null }) => (c.status === "measured" || c.status === "floor") && (c.savedMs ?? 0) > 0;
  const brief = (r: Report, c: { id: string; savedMs: number | null; fpsGain: number | null; status: string }) =>
    `${find(r, c.id)?.label ?? c.id} ${c.status === "floor" ? ">= " : ""}${(c.savedMs ?? 0).toFixed(2)} ms${c.fpsGain == null ? "" : ` (${signed(c.fpsGain, 1)} fps)`}`;
  out.push("", "## Summary", "");
  for (const r of reports) {
    const top = r.ranking.filter(real).slice(0, 5);
    out.push(`**${title(r)}**, the largest costs overall: ${top.length ? "" : r.views.length ? "none measurable." : "nothing was timed (geometry only)."}`, "");
    top.forEach((row, i) => out.push(`${i + 1}. ${brief(r, row)}`));
    if (top.length) out.push("");
    for (const v of r.views) {
      const best = v.costs.filter(real).slice(0, 3);
      out.push(`- ${v.name}: ${v.baselineMs.toFixed(2)} ms (${v.baselineFps.toFixed(0)} fps) with everything on${v.capped ? ", at the cap: nothing measurable here" : best.length ? `; largest: ${best.map((k) => brief(r, k)).join(", ")}` : "; nothing measurable"}.`);
    }
    if (r.views.length) out.push("");
  }
  if (out[out.length - 1] === "") out.pop();
  // Geometry from the editor when there is one: the real meshes, where a built player has combined batches.
  const geometrySource = reports.find((r) => r.source === "editor") ?? reports[0];
  out.push("", "## Overall (mean over the viewpoints)", "",
    `Saving = frame time with everything on minus with that category off; frame time adds up, fps is derived. Geometry: ${title(geometrySource)}.`, "",
    table(["category", "triangles (LOD0)", "renderers", "shadow casters", ...reports.map((r) => `saved, ${title(r)}`)],
      ids.map((id) => {
        const cat = find(geometrySource, id) ?? reports.map((r) => find(r, id)).find(Boolean)!;
        const g = cat.geometry;
        const tris = g.triangles == null ? (g.storedInstances != null ? `${count(g.items)} items, ${count(g.storedInstances)} placed` : g.objects != null ? `${count(g.objects)} objects` : "-")
          : `${g.batchedRenderers ? "<= " : ""}${count(g.triangles)}${g.trianglesLod0 != null && g.trianglesLod0 !== g.triangles ? ` (${count(g.trianglesLod0)})` : ""}`;
        return [cat.label, tris, count(g.renderers), count(g.shadowCasters), ...reports.map((r) => costText(r.ranking.find((x) => x.id === id)))];
      })));
  for (const r of reports) {
    out.push("", `## ${title(r)}: per viewpoint`, "");
    const head = ["category", ...r.views.map((v) => `${v.name} (${v.baselineMs.toFixed(2)} ms, ${v.baselineFps.toFixed(0)} fps${v.capped ? ", at the cap" : ""}; noise ${v.noiseMs.toFixed(2)} ms)`)];
    out.push(table(head, r.ranking.map((row) => [find(r, row.id)?.label ?? row.id, ...r.views.map((v) => costText(v.costs.find((k) => k.id === row.id)))])));
    out.push("", "### Geometry", "", table(["category", "objects", "renderers", "triangles", "LOD0 triangles", "meshes", "materials", "shadow casters", "LODGroups", "VSP items", "placed instances"],
      r.ranking.map((row) => find(r, row.id)!).filter(Boolean).map((c) => { const g = c.geometry; return [c.label, count(g.objects), count(g.renderers), (g.batchedRenderers ? "<= " : "") + count(g.triangles), count(g.trianglesLod0), count(g.meshes), count(g.materials), count(g.shadowCasters), count(g.lodGroups), count(g.items), count(g.storedInstances)]; })));
    if (r.absent.length) out.push("", `Not in this scene: ${r.absent.join(", ")}.`);
  }
  return out.join("\n") + "\n";
}

// ---- viewpoints ---------------------------------------------------------------------------------

export interface Viewpoint {
  name: string;
  note?: string;
  position: number[];
  rotation: number[]; // euler: pitch, yaw, roll
  eye?: number; // metres over the ground instead of position's y
}

// A course's judged viewpoints: docs/gspro/<course>/perf-views.json (golfmap-perf-views-v1,
// { views: [...] }); the editor reads a copy in the course folder. A file of the first shape,
// { "<Course>": [...] }, still reads.
export function loadViews(course: string, file?: string): Viewpoint[] {
  const path = file ?? join(import.meta.dir, "..", "docs", "gspro", course.toLowerCase(), "perf-views.json");
  if (!existsSync(path)) throw new Error(`No viewpoints file ${path}. Write one (see docs/gspro/vreta/perf-views.json) or pass --views <file>.`);
  const doc = JSON.parse(readFileSync(path, "utf8").replace(/^﻿/, ""));
  const views = Array.isArray(doc.views) ? doc.views : doc[course];
  if (!Array.isArray(views)) throw new Error(`${path} holds no views (and none for '${course}').`);
  for (const v of views) if (typeof v.name !== "string" || !Array.isArray(v.position) || !Array.isArray(v.rotation)) throw new Error(`${path}: a view needs name, position and rotation.`);
  return views;
}
