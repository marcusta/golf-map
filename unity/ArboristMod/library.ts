// Builds golf-map's species library inside a running Arborist (course open, mod loaded):
//   bun unity/ArboristMod/library.ts [--spec pipeline/arborist-library.json] [--out data/arborist/GolfMap library.biome] [--biome "GolfMap library"] [--dry]
// Every catalogue asset the spec matches is added to one biome through Arborist's own "add"
// (arb.biome.add), so each item carries Arborist's default settings and freshly baked billboards;
// the biome is then exported with Arborist's exporter. Re-running skips what the biome already has.
// Items go in with runtime spawn off: the library biome must not plant anything by itself.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pickBridge, run } from "../mcp/bridge.ts";

const args = process.argv.slice(2);
const opt = (name: string, fallback: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const repo = resolve(import.meta.dir, "../..");
const spec = JSON.parse(readFileSync(resolve(repo, opt("--spec", "pipeline/arborist-library.json")), "utf8"));
const out = resolve(repo, opt("--out", "data/arborist/GolfMap library.biome"));
const biomeName = opt("--biome", "GolfMap library");
const dry = args.includes("--dry");

const bridge = pickBridge(process.env.GOLFMAP_PLAYER || "arborist", join(process.env.LOCALAPPDATA ?? ".", "GolfMapPlayerBridge"));
const has = (text: string, parts: string[] = []) => parts.some((p) => text.toLowerCase().includes(p.toLowerCase()));

const catalog: { address: string; label: string }[] = (await run(bridge, "arb.catalog", { contains: "", limit: 5000 })).assets;
const wanted: { address: string; label: string; type: string }[] = [];
for (const group of spec.groups)
  for (const asset of catalog)
    if (has(asset.label, group.match) && !has(asset.label, spec.exclude) && !has(asset.label, group.exclude) && !wanted.some((w) => w.address === asset.address))
      wanted.push({ ...asset, type: group.type });
console.log(`${wanted.length} catalogue assets match the spec (${catalog.length} prefabs in the catalogue).`);
if (dry) {
  for (const w of wanted) console.log(`  ${w.type.padEnd(8)} ${w.label}`);
  process.exit(0);
}

let biomes: any[] = await run(bridge, "arb.biomes", { items: true });
let biome = biomes.find((b) => b.name === biomeName);
if (!biome) {
  await run(bridge, "arb.biome.new", { name: biomeName });
  biomes = await run(bridge, "arb.biomes", { items: true });
  biome = biomes.find((b) => b.name === biomeName);
}
// What an earlier run exported stays in the file: only the species it lacks are added, and the
// session's biome is merged into it (Arborist forgets the biome when the course is reloaded).
const existing: any = existsSync(out) ? JSON.parse(readFileSync(out, "utf8").replace(/^﻿/, "")) : null;
const present = new Set<string>([...(biome.itemList ?? []).map((i: any) => i.name), ...(existing?.VegetationInfoList ?? []).map((i: any) => i.Name)]);
let added = 0;
const failed: string[] = [];
for (const [n, w] of wanted.entries()) {
  if (present.has(w.label.trim()) || present.has(w.label)) continue;
  try {
    const item = await run(bridge, "arb.biome.add", { biome: String(biome.index), address: w.address, type: w.type, spawn: false }, 300);
    added++;
    console.log(`  ${n + 1}/${wanted.length} ${w.type.padEnd(8)} ${item.name}  sample ${Number(item.sampleDistance).toFixed(1)} m  collider ${item.collider}`);
  } catch (e: any) {
    failed.push(`${w.label}: ${e?.message ?? e}`);
    console.log(`  ${n + 1}/${wanted.length} FAILED ${w.label}: ${e?.message ?? e}`);
  }
}
const session = out + ".session";
await run(bridge, "arb.biome.export", { biome: String(biome.index), file: session }, 300);
const fresh = JSON.parse(readFileSync(session, "utf8").replace(/^﻿/, ""));
const merged = existing ?? fresh;
if (existing) {
  const names = new Set(existing.VegetationInfoList.map((i: any) => i.Name));
  for (const item of fresh.VegetationInfoList) if (!names.has(item.Name)) existing.VegetationInfoList.push(item);
}
writeFileSync(out, JSON.stringify(merged));
rmSync(session, { force: true });
console.log(`Added ${added}, ${failed.length} failed. The library now holds ${merged.VegetationInfoList.length} items: ${out}`);
if (failed.length) console.log("Failed:\n  " + failed.join("\n  "));
