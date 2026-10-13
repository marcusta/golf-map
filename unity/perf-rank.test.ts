// The performance ranking's pure parts: category rules, the statistics, the report and its markdown.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atCap, buildReport, categoryOf, costText, foldOthers, isReport, loadRules, loadViews, median, toMarkdown, viewCosts, type Category, type Reading } from "./perf-rank";

const rules = loadRules();

describe("category rules", () => {
  // [path, category id, unit]; names as OPCD, the GolfMap tools and the handover's scene.geometry print them.
  const cases: [string, string, string][] = [
    ["/Meshes/Spline_hole_1_3_Fairway_-_Mesh", "mesh.fairway", "/Meshes/Spline_hole_1_3_Fairway_-_Mesh"],
    ["/Meshes/Spline_hole_4_1_piece2_Rough_-_Mesh", "mesh.rough", "/Meshes/Spline_hole_4_1_piece2_Rough_-_Mesh"],
    ["/Meshes/Spline_Outer_1_Outer_Deep_Sat_-_Mesh", "mesh.deep", "/Meshes/Spline_Outer_1_Outer_Deep_Sat_-_Mesh"],
    ["/Meshes/Spline_hole_2_5_Semi_-_Mesh", "mesh.semi", "/Meshes/Spline_hole_2_5_Semi_-_Mesh"],
    ["/Meshes/Spline_hole_2_1_Green_-_Mesh", "mesh.green", "/Meshes/Spline_hole_2_1_Green_-_Mesh"],
    ["/Meshes/Spline_hole_2_2_Tee_-_Mesh", "mesh.tee", "/Meshes/Spline_hole_2_2_Tee_-_Mesh"],
    ["/Meshes/Spline_hole_2_7_Bunker_-_Mesh", "mesh.bunker", "/Meshes/Spline_hole_2_7_Bunker_-_Mesh"],
    // Classify's order: a blend strip is a blend whatever surfaces it names, a gap filler too.
    ["/Meshes/Spline_hole_2_7_B_Rough_Bunker_-_Blend", "mesh.blend", "/Meshes/Spline_hole_2_7_B_Rough_Bunker_-_Blend"],
    ["/Meshes/Gap_Issue_12", "mesh.blend", "/Meshes/Gap_Issue_12"],
    ["/Meshes/Spline_klippa_3_Rock_-_Mesh", "mesh.slab", "/Meshes/Spline_klippa_3_Rock_-_Mesh"],
    ["/Meshes/Spline_others_4_Water_Base_Lake_-_Mesh", "mesh.water", "/Meshes/Spline_others_4_Water_Base_Lake_-_Mesh"],
    // Paths before blends: a path's fringe strip is part of the path (GolfMapPathMaterials.IsPathMesh).
    ["/Meshes/Spline_others_9_Concrete_-_Mesh", "mesh.path", "/Meshes/Spline_others_9_Concrete_-_Mesh"],
    ["/Meshes/Spline_others_9_B_Rough_Concrete_-_Blend", "mesh.path", "/Meshes/Spline_others_9_B_Rough_Concrete_-_Blend"],
    ["/Meshes/Spline_others_2_Something_-_Mesh", "mesh.other", "/Meshes/Spline_others_2_Something_-_Mesh"],
    // A course may keep its meshes under another parent (GolfMapCourse.meshParent): the name decides.
    ["/Course/Holes/Spline_hole_9_1_Fairway_-_Mesh", "mesh.fairway", "/Course/Holes/Spline_hole_9_1_Fairway_-_Mesh"],
    // Water planes are Spline_* named but not ground (IsWaterPlane, any case), wherever they sit.
    ["/Waterplanes/Spline_others_4_Water_Base_Lake_-_WaterPlane", "water", "/Waterplanes/Spline_others_4_Water_Base_Lake_-_WaterPlane"],
    ["/Meshes/Spline_others_4_Water_Base_Lake_-_Mesh_waterplane", "water", "/Meshes/Spline_others_4_Water_Base_Lake_-_Mesh_waterplane"],
    ["/GolfMap Creeks/creek-3", "water", "/GolfMap Creeks/creek-3"],
    ["/GolfMap Props/Vehicles/sedan#12/Model/sedan_body", "props.vehicles", "/GolfMap Props/Vehicles/sedan#12"],
    ["/GolfMap Props/Buildings/clubhouse#1", "props.buildings", "/GolfMap Props/Buildings/clubhouse#1"],
    ["/GolfMap Props/Structures/bridge#2/deck", "props.structures", "/GolfMap Props/Structures/bridge#2"],
    ["/GolfMap Props/Props/bench_stone#4/LOD0", "props.small", "/GolfMap Props/Props/bench_stone#4"],
    ["/GolfMap Props/Signs/tee_sign#1", "props.other", "/GolfMap Props/Signs/tee_sign#1"],
    ["/Terrain (Inner)/GolfMap Buildings/osm-way-1/Model", "buildings", "/Terrain (Inner)/GolfMap Buildings/osm-way-1"],
    ["/GolfMap Walls/h4-front-tee/wallstone_12", "stone", "/GolfMap Walls/h4-front-tee"],
    ["/Prefab_Big_rock_02/LOD1", "stone", "/Prefab_Big_rock_02"],
    ["/GolfMap Power Lines/line-1/pole-3", "powerlines", "/GolfMap Power Lines/line-1"],
    ["/GolfMap Wispy Rough/zone-7", "wispy", "/GolfMap Wispy Rough/zone-7"],
    // Nothing is dropped: an unknown root is its own category.
    ["/MainGameObjects/Sky/Dome", "other:MainGameObjects", "/MainGameObjects"],
    ["/Some Tool Output", "other:Some Tool Output", "/Some Tool Output"],
    // GSPro's and OPCD's numbered roots and instantiated copies share one row (seen in the game, 2026-10-13).
    ["/FlagAssembly_17/Pole", "other:FlagAssembly_#", "/FlagAssembly_17"],
    ["/FlagAssembly_0/Flag/Cloth", "other:FlagAssembly_#", "/FlagAssembly_0"],
    ["/CupAssembly_3/Cup", "other:CupAssembly_#", "/CupAssembly_3"],
    ["/teeMarker(Clone)143", "other:teeMarker#", "/teeMarker(Clone)143"],
    ["/MiniMapPointOfInterest(Clone)/Icon", "other:MiniMapPointOfInterest", "/MiniMapPointOfInterest(Clone)"],
    ["/OHaz0b", "other:OHaz#b", "/OHaz0b"],
    ["/Haz12", "other:Haz#", "/Haz12"],
  ];
  for (const [path, id, unit] of cases)
    test(path, () => {
      const c = categoryOf(rules, path);
      expect(c.id).toBe(id);
      expect(c.unit).toBe(unit);
    });

  test("ids are unique and every rule has what its kind needs", () => {
    const ids = rules.categories.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of rules.categories) {
      expect(c.label && c.group).toBeTruthy();
      if (c.kind === "renderers") expect(() => new RegExp(c.match!)).not.toThrow();
      else if (c.kind === "component") expect(c.component).toBeTruthy();
      else if (c.kind === "vsp") { expect(rules.vspSystems[c.system!]).toBeTruthy(); expect(["Grass", "Plant", "Tree", "Billboard", "Object"]).toContain(c.type!); }
      else expect(c.kind).toBe("shadows");
      // .NET reads the same patterns: nothing JavaScript-only or .NET-only in them.
      if (c.match) expect(c.match).not.toMatch(/\(\?[<i!=]|\\[dwsDWSbB]/);
    }
  });
});

describe("statistics", () => {
  test("median", () => {
    expect(median([])).toBe(0);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  const b = (ms: number): Reading => ({ ms });
  const c = (id: string, ms: number): Reading => ({ id, ms });

  test("a case is compared with the baselines around it, so drift does not land on it", () => {
    // The scene slows by 1 ms per block; grass always saves 2 ms.
    const r = viewCosts([b(10), c("grass", 8.5), b(11), c("grass", 9.5), b(12), c("grass", 10.5), b(13)]);
    const grass = r.costs[0];
    expect(grass.deltas).toEqual([2, 2, 2]);
    expect(grass.savedMs).toBe(2);
    expect(grass.spreadMs).toBe(0);
    expect(r.noiseMs).toBe(1);
    expect(grass.status).toBe("measured");
    expect(r.baselineMs).toBe(11.5);
    // 11.5 ms -> 9.5 ms
    expect(grass.fpsGain!).toBeCloseTo(1000 / 9.5 - 1000 / 11.5, 6);
    expect(grass.share).toBeCloseTo(2 / 11.5, 6);
  });

  test("several cases between two baselines share them", () => {
    const r = viewCosts([b(10), c("a", 9), c("b", 10.1), b(10.2)]);
    expect(r.costs.map((x) => x.id)).toEqual(["a", "b"]);
    expect(r.costs[0].savedMs).toBeCloseTo(1.1, 6);
    expect(r.costs[1].savedMs).toBeCloseTo(0, 6);
  });

  test("a saving no larger than the noise, or than half its own spread, is not measurable", () => {
    const quiet = viewCosts([b(10), c("small", 9.9), b(10.2), c("small", 10.05), b(10), c("wild", 7), b(10.2), c("wild", 10), b(10), c("wild", 9.9), b(10.2)]);
    const small = quiet.costs.find((x) => x.id === "small")!, wild = quiet.costs.find((x) => x.id === "wild")!;
    expect(quiet.noiseMs).toBeCloseTo(0.2, 6);
    expect(small.status).toBe("noise");
    // wild: deltas 3.1, 0.1, 0.2 -> median 0.2, spread 3.0
    expect(wild.savedMs).toBeCloseTo(0.2, 6);
    expect(wild.status).toBe("noise");
  });

  test("the frame-rate cap: a capped baseline measures nothing, a capped case is a floor", () => {
    const cap = 1000 / 120;
    const capped = viewCosts([b(8.34), c("grass", 8.33), b(8.35)], cap);
    expect(capped.capped).toBe(true);
    expect(capped.costs[0].status).toBe("capped");
    const floor = viewCosts([b(10), c("grass", 8.34), b(10.1), c("grass", 8.35), b(10)], cap);
    expect(floor.capped).toBe(false);
    expect(floor.costs[0].status).toBe("floor");
    expect(viewCosts([b(10), c("grass", 8.34), b(10.1), c("grass", 8.35), b(10)]).costs[0].status).toBe("measured");
  });

  test("a baseline slower or faster than the cap is not at the cap", () => {
    // The first game run: the display reported 60 Hz, the baselines read 22.53, 11.62 and 10.31 ms (44 to 97 fps)
    // and the cases about 11 ms. Nothing there sits at a 60 fps cap.
    const cap60 = 1000 / 60;
    const r = viewCosts([b(22.53), c("props.vehicles", 11.01), c("props.buildings", 11.26), c("props.structures", 11.25), b(11.62), c("stone", 10.29), c("props.small", 11.44), b(10.31)], cap60);
    expect(r.capped).toBe(false);
    expect(r.costs.some((x) => x.status === "capped" || x.status === "floor")).toBe(false);
    expect(atCap(22.53, cap60)).toBe(false);
    expect(atCap(13, cap60)).toBe(false);
    expect(atCap(11.62, cap60)).toBe(false);
    expect(atCap(16.7, cap60)).toBe(true);
    expect(atCap(8.36, 1000 / 120)).toBe(true);
    // No cap known: nothing is ever at it.
    expect(atCap(8.33, null)).toBe(false);
    expect(viewCosts([b(8.33), c("grass", 8.33), b(8.33)], null).capped).toBe(false);
  });
});

describe("report", () => {
  const categories: Category[] = [
    { id: "props.vehicles", label: "Props: vehicles", group: "Props", kind: "renderers", geometry: { objects: 30, renderers: 60, triangles: 300000, trianglesLod0: 300000, shadowCasters: 0 } },
    { id: "stone", label: "Stone walls and rocks", group: "Stone", kind: "renderers", geometry: { renderers: 30, triangles: 600000, trianglesLod0: 200000, shadowCasters: 30, lodGroups: 10 } },
    { id: "other:Leftovers", label: "Other: Leftovers", group: "Other", kind: "renderers", geometry: { renderers: 10, triangles: 100000 } },
    { id: "vsp.course.grass", label: "Course VSP: grass", group: "Vegetation", kind: "vsp", geometry: { items: 12, storedInstances: 0 } },
  ];
  const b = (ms: number): Reading => ({ ms });
  const c = (id: string, ms: number): Reading => ({ id, ms });
  const open = viewCosts([b(12), c("vsp.course.grass", 9), c("props.vehicles", 11.4), c("stone", 12.02), b(12.1), c("vsp.course.grass", 9.1), c("props.vehicles", 11.5), c("stone", 12.0), b(12)]);
  const atCap = viewCosts([b(8.34), c("vsp.course.grass", 8.33), c("props.vehicles", 8.34), c("stone", 8.33), b(8.33)], 1000 / 120);
  const report = buildReport({
    source: "game", course: "Test", created: "2026-10-13T12:00:00", conditions: { resolution: "1920x1440", quality: "VeryHigh", capFps: 120, rounds: 2, reading: "5 s" },
    categories, absent: ["wispy"], views: [{ name: "open", ...open }, { name: "capped", ...atCap }],
  });

  test("has the shared shape and survives JSON", () => {
    expect(isReport(JSON.parse(JSON.stringify(report)))).toBe(true);
    expect(isReport({ ...report, format: "other" })).toBe(false);
  });

  test("coverage counts what the named rules caught", () => {
    expect(report.coverage.renderers).toBe(100);
    expect(report.coverage.categorisedRenderers).toBe(90);
    expect(report.coverage.rendererShare).toBe(0.9);
    expect(report.coverage.triangleShare).toBe(0.9);
    expect(report.coverage.other).toEqual(["other:Leftovers"]);
  });

  test("overall ranking: mean over the viewpoints that could measure, noise as none, capped left out", () => {
    expect(report.ranking.map((r) => r.id)).toEqual(["vsp.course.grass", "props.vehicles", "stone", "other:Leftovers"]);
    const grass = report.ranking[0], stone = report.ranking[2], other = report.ranking[3];
    expect(grass.savedMs).toBeCloseTo(3, 1);
    expect(grass.measuredViews).toBe(1);
    expect(grass.views).toBe(2);
    expect(grass.status).toBe("measured");
    expect(stone.status).toBe("noise");
    expect(stone.savedMs).toBe(0);
    expect(other.status).toBe("not run");
    expect(other.savedMs).toBeNull();
  });

  test("markdown: one table, and two reports side by side", () => {
    const md = toMarkdown([report]);
    expect(md).toContain("| Course VSP: grass | 12 items, 0 placed |");
    expect(md).toContain("not measurable");
    expect(md).toContain("at the cap");
    expect(md).toContain("capped at 120 fps");
    expect(md).toContain("Not in this scene: wispy.");
    const editor = buildReport({ source: "editor", course: "Test", conditions: { resolution: "1920x1080" }, categories, views: [{ name: "open", ...open }] });
    const both = toMarkdown([editor, report]);
    expect(both).toContain("saved, Unity editor | saved, GSPro |");
    expect(both).toContain("600 k (200 k)");
  });

  test("small other rows fold into one, listed in the JSON only", () => {
    const other = (id: string, renderers: number, triangles: number): Category => ({ id, label: "Other: " + id.slice(6), group: "Other", kind: "renderers", geometry: { objects: 1, renderers, triangles, trianglesLod0: triangles, shadowCasters: 1, meshes: 2, materials: 2 } });
    const scene: Category[] = [
      { id: "mesh.deep", label: "Course meshes: deep rough", group: "Course meshes", kind: "renderers", geometry: { objects: 100, renderers: 1000, triangles: 1000000 } },
      other("other:FlagAssembly_#", 4, 900), other("other:Haz#", 0, 0), other("other:teeMarker#", 1, 46),
      other("other:BigThing", 2, 400000),   // few renderers, many triangles: stays
      other("other:ManySmall", 200, 100),   // few triangles, many renderers: stays
      { id: "stix", label: "Stix 3D grass", group: "Grass", kind: "component", geometry: { objects: 53 } },
    ];
    const folded = foldOthers(scene);
    expect(folded.map((c) => c.id)).toEqual(["mesh.deep", "other:BigThing", "other:ManySmall", "stix", "other:small"]);
    const small = folded[folded.length - 1];
    expect(small.label).toBe("Other: small objects (3 roots)");
    expect(small.members).toEqual(["other:FlagAssembly_#", "other:Haz#", "other:teeMarker#"]);
    expect(small.geometry.renderers).toBe(5);
    expect(small.geometry.triangles).toBe(946);
    expect(small.geometry.meshes).toBeNull();
    // One small row is not worth a fold.
    expect(foldOthers(scene.filter((c) => c.id !== "other:Haz#" && c.id !== "other:teeMarker#")).some((c) => c.id === "other:small")).toBe(false);
    // The fold changes no totals.
    expect(buildReport({ source: "game", course: "T", conditions: {}, categories: folded, views: [] }).coverage.triangles)
      .toBe(buildReport({ source: "game", course: "T", conditions: {}, categories: scene, views: [] }).coverage.triangles);
  });

  test("order: measured savings first, then by triangles, the other rows last", () => {
    const cats: Category[] = [
      { id: "other:small", label: "Other: small objects (40 roots)", group: "Other", kind: "renderers", geometry: { renderers: 90, triangles: 50000 } },
      { id: "mesh.deep", label: "Course meshes: deep rough", group: "Course meshes", kind: "renderers", geometry: { renderers: 172, triangles: 5500000 } },
      { id: "mesh.tee", label: "Course meshes: tee", group: "Course meshes", kind: "renderers", geometry: { renderers: 67, triangles: 15000 } },
      { id: "props.vehicles", label: "Props: vehicles", group: "Props", kind: "renderers", geometry: { renderers: 60, triangles: 300000 } },
      { id: "shadows", label: "Shadows (all off)", group: "Lighting", kind: "shadows", geometry: { shadowCasters: 900 } },
      { id: "stix", label: "Stix 3D grass", group: "Grass", kind: "component", geometry: { objects: 53 } },
    ];
    const v = viewCosts([b(12), c("shadows", 9), c("props.vehicles", 11), c("mesh.tee", 12.3), b(12), c("shadows", 9), c("props.vehicles", 11), c("mesh.tee", 12.3), b(12.02), c("mesh.deep", 12.01), c("mesh.deep", 12.01), b(12)]);
    const r = buildReport({ source: "game", course: "Test", conditions: {}, categories: cats, views: [{ name: "tee 1", ...v }] });
    // shadows 3 ms, vehicles 1 ms, tee -0.3 ms (measured, a loss), then deep (noise) and stix (not run) by triangles, other last.
    expect(r.ranking.map((x) => x.id)).toEqual(["shadows", "props.vehicles", "mesh.tee", "mesh.deep", "stix", "other:small"]);
    const md = toMarkdown([r]);
    expect(md.indexOf("## Summary")).toBeLessThan(md.indexOf("## Overall"));
    expect(md).toContain("1. Shadows (all off) 3.00 ms (+27.8 fps)");
    expect(md).toContain("2. Props: vehicles 1.00 ms (+7.6 fps)");
    expect(md).toContain("- tee 1: 12.00 ms (83 fps) with everything on; largest: Shadows (all off) 3.00 ms (+27.8 fps), Props: vehicles 1.00 ms (+7.6 fps).");
    expect(md).not.toContain("3. Course meshes: tee");
    const rows = md.split("## Overall")[1].split("\n").filter((l) => l.startsWith("| ") && !l.startsWith("| category"));
    expect(rows[0]).toContain("Shadows");
    expect(rows[5]).toContain("Other: small objects");
  });

  test("cost text", () => {
    expect(costText({ savedMs: 1.2, fpsGain: 9.14, share: 0.12, status: "measured" })).toBe("1.20 ms (+9.1 fps, 12 %)");
    expect(costText({ savedMs: 0.8, fpsGain: 8, share: 0.08, status: "floor" })).toBe(">= 0.80 ms (+8.0 fps, 8 %)");
    expect(costText({ savedMs: -0.5, fpsGain: -3, share: -0.05, status: "measured" })).toBe("-0.50 ms (-3.0 fps, -5 %)");
    expect(costText(undefined)).toBe("-");
  });
});

describe("viewpoints", () => {
  test("the course's own file, and a file of the first shape", () => {
    const views = loadViews("Vreta");
    expect(views.length).toBeGreaterThan(0);
    expect(views[0].position.length).toBe(3);
    const dir = mkdtempSync(join(tmpdir(), "perf-views-"));
    const legacy = join(dir, "perf-views.json");
    writeFileSync(legacy, JSON.stringify({ comment: "x", Vreta: [{ name: "a", position: [1, 2, 3], rotation: [0, 90, 0], eye: 1.7 }] }));
    try {
      expect(loadViews("Vreta", legacy)[0].eye).toBe(1.7);
      expect(() => loadViews("Other", legacy)).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
