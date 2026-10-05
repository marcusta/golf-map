// Unity 2018.2 / C# 6.
//
// Trial of Forst's own CTI shaders on the palette oaks and birches, reversibly. The materials and the
// renamed shader copies come from unity/prepare-cti-trial.py, which also explains why the copies drop
// "301" from their names (GSPro's VSP matches CTI shaders by the stock names only).
//
// apply: backs up every file it is about to change - the palette prefabs that use a "from" material,
// each GolfMap tree catalogue and its _billboards folder (the refresh re-derives items whose shader
// moved and regenerates their billboards) - to GolfMapSpelunk/cti-trial/<stamp>/, outside Assets.
// Then it points the "to" materials at the stock-named CTI shaders with "Use Wind from Script" on,
// swaps them onto the prefabs and refreshes vegetation from materials. A failure after the backup
// restores it before rethrowing. Tree instances, palette.json, the storage packages and the scene are
// never written.
//
// restore has to put back the editor's memory as well as the files. Unity 2018.2 does not reload a
// loaded prefab or ScriptableObject when its file is replaced and reimported - the first version only
// copied files, and the open editor kept drawing (and would have saved back) the trial. So: the prefab
// swap is reversed in memory and saved (checked byte-identical to the backup), the catalogues and
// billboards are copied back and unloaded so the next access reads them from disk, and the result is
// verified in memory before the systems are reset.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using AwesomeTechnologies.Vegetation.PersistentStorage;
using AwesomeTechnologies.VegetationSystem;
using GolfMap.Bridge;
using UnityEditor;
using UnityEngine;

namespace GolfMap.Editor
{
    public static class GolfMapCtiTrial
    {
        const string BackupRoot = "GolfMapSpelunk/cti-trial";
        const string RenderingTestsBaseline = "Library/GolfMapTreeRenderingBaseline.json";

        [Serializable] class Tex { public string name = "", path = ""; }
        [Serializable] class Swap { public string from = "", to = "", shader = ""; public Tex[] textures = new Tex[0]; }
        [Serializable] class Trial { public Swap[] swaps = new Swap[0]; }
        [Serializable] class Backup { public string created = "", course = ""; public string[] files = new string[0], folders = new string[0], prefabs = new string[0]; public Swap[] swaps = new Swap[0]; }

        // Everything takes the course folder, resolved once up front: an AssetDatabase.Refresh can leave
        // a GolfMapCourse reference stale with no asset path (see GolfMapTerrainSculpt).
        static string TrialFile(string folder) { return folder + "CTITrial/trial.json"; }

        static Trial LoadTrial(string folder)
        {
            var path = TrialFile(folder);
            if (!File.Exists(path)) throw new BridgeError(path + " not found. Run unity/prepare-cti-trial.py first.");
            var trial = JsonUtility.FromJson<Trial>(File.ReadAllText(path));
            if (trial.swaps == null || trial.swaps.Length == 0) throw new BridgeError(path + " lists no swaps.");
            // Restore reverses the swap in memory (trial material -> the material it replaced), so
            // a trial material shared by two swaps would put the wrong one back.
            var shared = trial.swaps.GroupBy(s => s.to).Where(g => g.Count() > 1).Select(g => g.Key).ToArray();
            if (shared.Length > 0) throw new BridgeError(path + ": each swap needs its own trial material; shared: " + string.Join(", ", shared));
            return trial;
        }

        // For GolfMapLooks. While the trial is applied the palette's source prefabs draw trial materials,
        // but a look is still defined against the materials those replaced: its copies are copies of the
        // NM originals, recorded in palette.json by their guids. Without this a Regenerate took the trial
        // materials for the species' sources, copied them into the look folder and pointed the look's
        // prefabs there - outside trial.json, so the palette's baked tint no longer applied (2026-09-27).
        static Swap[] SwapsIn(string courseFolder)
        {
            var path = courseFolder + "CTITrial/trial.json";
            if (!File.Exists(path)) return new Swap[0];
            return JsonUtility.FromJson<Trial>(File.ReadAllText(path)).swaps ?? new Swap[0];
        }

        // The material a trial material replaced (m itself when it is not a trial material).
        public static Material Original(string courseFolder, Material m)
        {
            if (!m) return m;
            var path = AssetDatabase.GetAssetPath(m);
            var s = SwapsIn(courseFolder).FirstOrDefault(x => x.to == path);
            var from = s == null ? null : AssetDatabase.LoadAssetAtPath<Material>(s.from);
            return from ? from : m;
        }

        // The trial material that replaces m, or null.
        public static Material TrialFor(string courseFolder, Material m)
        {
            if (!m) return null;
            var path = AssetDatabase.GetAssetPath(m);
            var s = SwapsIn(courseFolder).FirstOrDefault(x => x.from == path);
            return s == null ? null : AssetDatabase.LoadAssetAtPath<Material>(s.to);
        }

        static Material Mat(string path)
        {
            var m = AssetDatabase.LoadAssetAtPath<Material>(path);
            if (!m) throw new BridgeError("Material not found: " + path);
            return m;
        }

        // The GolfMap tree catalogues on the active scene's systems, as the refresh finds them.
        static List<VegetationPackagePro> Catalogues()
        {
            var scene = UnityEngine.SceneManagement.SceneManager.GetActiveScene();
            return UnityEngine.Object.FindObjectsOfType<PersistentVegetationStorage>()
                .Where(s => s && s.gameObject.scene == scene && s.VegetationSystemPro)
                .SelectMany(s => s.VegetationSystemPro.VegetationPackageProList)
                .Where(GolfMapTreePlanter.IsImportedCatalogue).Distinct().ToList();
        }

        static IEnumerable<Renderer> Renderers(GameObject prefab)
        {
            return prefab.GetComponentsInChildren<Renderer>(true).Where(r => !(r is BillboardRenderer));
        }

        // Prefab asset paths the catalogues draw that use any of these materials.
        // Prefabs the catalogues draw, plus every prefab under the course folder: the palette's own
        // prefabs are not always the planted ones (a look plants copies), but they are what the palette
        // falls back to and what GolfMap Lab shows as "original", so they must not stay on the old
        // material either.
        static List<string> PrefabsUsing(string folder, IEnumerable<VegetationPackagePro> catalogues, HashSet<Material> materials)
        {
            var course = AssetDatabase.FindAssets("t:Prefab", new[] { folder.TrimEnd('/') })
                .Select(g => AssetDatabase.LoadAssetAtPath<GameObject>(AssetDatabase.GUIDToAssetPath(g)));
            return catalogues.SelectMany(c => c.VegetationInfoList).Where(i => i.VegetationPrefab)
                .Select(i => i.VegetationPrefab).Concat(course).Where(p => p).Distinct()
                .Where(p => Renderers(p).SelectMany(r => r.sharedMaterials).Any(materials.Contains))
                .Select(AssetDatabase.GetAssetPath).Where(p => !string.IsNullOrEmpty(p))
                .Distinct().OrderBy(p => p, StringComparer.Ordinal).ToList();
        }

        static List<string> Backups()
        {
            return Directory.Exists(BackupRoot)
                ? Directory.GetDirectories(BackupRoot).Where(d => File.Exists(Path.Combine(d, "backup.json")))
                    .Select(Path.GetFileName).OrderBy(n => n, StringComparer.Ordinal).ToList()
                : new List<string>();
        }

        [BridgeCommand("golfmap.cti.status", "CTI shader trial on the palette oaks/birches: the swaps in <course>/CTITrial/trial.json, whether each material and shader is ready and known to GSPro's VSP, which prefabs use the current and the trial materials, and the backups apply made.")]
        static object Status(BridgeArgs a)
        {
            var folder = GolfMapCourses.Folder(GolfMapCourses.Require());
            var trial = LoadTrial(folder);
            var catalogues = Catalogues();
            var swaps = new List<object>();
            foreach (var s in trial.swaps)
            {
                var from = AssetDatabase.LoadAssetAtPath<Material>(s.from);
                var to = AssetDatabase.LoadAssetAtPath<Material>(s.to);
                var shader = Shader.Find(s.shader);
                swaps.Add(new Dictionary<string, object>
                {
                    { "from", s.from }, { "fromShader", from ? from.shader.name : "MISSING" },
                    { "to", s.to }, { "toShader", to ? to.shader.name : "MISSING" },
                    { "targetShader", s.shader }, { "targetShaderFound", (bool)shader },
                    { "gsproKnowsTarget", GolfMapTreePlanter.VspKnowsShader(s.shader) },
                    { "useWindFromScript", to && to.HasProperty("_LODTerrain") ? (object)to.GetFloat("_LODTerrain") : null },
                    { "fromInMemory", Describe(from) },
                    { "toInMemory", Describe(to) },
                    { "prefabsUsingFrom", from ? PrefabsUsing(folder, catalogues, new HashSet<Material> { from }).Count : 0 },
                    { "prefabsUsingTo", to ? PrefabsUsing(folder, catalogues, new HashSet<Material> { to }).Count : 0 },
                });
            }
            return new Dictionary<string, object>
            {
                { "catalogues", catalogues.Select(c => (object)AssetDatabase.GetAssetPath(c)).ToList() },
                { "swaps", swaps },
                { "backups", Backups().Cast<object>().ToList() },
            };
        }

        // What the editor holds for a material right now (it can differ from the file).
        static object Describe(Material m)
        {
            if (!m) return null;
            var main = m.HasProperty("_MainTex") ? m.GetTexture("_MainTex") : null;
            return new Dictionary<string, object>
            {
                { "shader", m.shader.name }, { "queue", m.renderQueue },
                { "keywords", string.Join(" ", m.shaderKeywords) },
                { "mainTex", main ? AssetDatabase.GetAssetPath(main) : null },
                { "textures", new[] { "_BumpSpecMap", "_TranslucencyMap", "_MetalicRAOGSmothnessA", "_AmbientOcclusionGSmoothnessA" }
                    .Where(m.HasProperty).Where(n => m.GetTexture(n))
                    .Select(n => (object)(n + " = " + AssetDatabase.GetAssetPath(m.GetTexture(n)))).ToList() },
                { "floats", new[] { "_TranslucencyStrength", "_AmbientTranslucency", "_ViewDependency", "_BackFaceSmoothness", "_NormalLerp", "_OcclusionStrength" }
                    .Where(m.HasProperty).Select(n => (object)(n + " = " + m.GetFloat(n))).ToList() },
                { "mainTexScale", m.HasProperty("_MainTex") ? m.GetTextureScale("_MainTex").ToString() : null },
                { "cutoff", m.HasProperty("_Cutoff") ? (object)m.GetFloat("_Cutoff") : null },
            };
        }

        [BridgeCommand("golfmap.cti.apply", "Back up, then swap the palette oaks/birches onto Forst's CTI materials (stock-named shader copies, wind from script, trial.json texture overrides) and refresh vegetation from materials. On an applied trial it only updates the trial materials. Undo with golfmap.cti.restore.")]
        static object Apply(BridgeArgs a)
        {
            var folder = GolfMapCourses.Folder(GolfMapCourses.Require());
            if (File.Exists(RenderingTestsBaseline))
                throw new BridgeError("A Tree rendering tests session is still open (" + RenderingTestsBaseline + "). End it first.");
            // Import what the prepare scripts wrote (tint textures, materials) before looking them up.
            AssetDatabase.Refresh();
            var trial = LoadTrial(folder);
            var swap = new Dictionary<Material, Material>();
            foreach (var s in trial.swaps)
            {
                var from = Mat(s.from); var to = Mat(s.to);
                var shader = Shader.Find(s.shader);
                if (!shader) throw new BridgeError("Shader '" + s.shader + "' not found. Did prepare-cti-trial.py run and Unity import it?");
                if (!GolfMapTreePlanter.VspKnowsShader(shader.name))
                    throw new BridgeError("'" + shader.name + "' is not a shader name GSPro's VSP knows.");
                swap[from] = to;
            }
            var catalogues = Catalogues();
            if (catalogues.Count == 0) throw new BridgeError("No GolfMap tree catalogue in the open scene.");
            var prefabs = PrefabsUsing(folder, catalogues, new HashSet<Material>(swap.Keys));
            if (prefabs.Count == 0)
            {
                // Already applied: only the trial materials change (a new tint texture, say). They
                // are trial-only files and the catalogue keeps its CTI items, so no backup is taken.
                if (PrefabsUsing(folder, catalogues, new HashSet<Material>(swap.Values)).Count == 0)
                    throw new BridgeError("No catalogue prefab uses the current or the trial materials.");
                var updated = new List<string> { "trial already applied; updating the trial materials only" };
                PrepareTrialMaterials(trial, updated);
                AssetDatabase.SaveAssets();
                GolfMapVegetationRefresh.Refresh();
                ResetSystems(updated);
                return new Dictionary<string, object> { { "log", updated.Cast<object>().ToList() } };
            }

            // Disk must match memory before it is copied.
            AssetDatabase.SaveAssets();
            var files = new List<string>(prefabs);
            var folders = new List<string>();
            foreach (var c in catalogues)
            {
                var path = AssetDatabase.GetAssetPath(c);
                files.Add(path);
                var billboards = path.Substring(0, path.Length - ".asset".Length) + "_billboards";
                if (Directory.Exists(billboards)) folders.Add(billboards);
            }
            var stamp = DateTime.Now.ToString("yyyyMMdd-HHmmss");
            var dir = Path.Combine(BackupRoot, stamp);
            var backup = new Backup { created = stamp, course = folder, files = files.ToArray(), folders = folders.ToArray(), prefabs = prefabs.ToArray(), swaps = trial.swaps };
            WriteBackup(dir, backup);

            var log = new List<string> { "backup " + dir + ": " + files.Count + " files, " + folders.Count + " billboard folders" };
            try
            {
                PrepareTrialMaterials(trial, log);
                int slots = 0;
                foreach (var path in prefabs)
                {
                    var prefab = AssetDatabase.LoadAssetAtPath<GameObject>(path);
                    foreach (var r in Renderers(prefab))
                    {
                        var mats = r.sharedMaterials;
                        bool changed = false;
                        for (int i = 0; i < mats.Length; i++)
                        {
                            Material to;
                            if (mats[i] && swap.TryGetValue(mats[i], out to)) { mats[i] = to; changed = true; slots++; }
                        }
                        if (changed) { r.sharedMaterials = mats; EditorUtility.SetDirty(r); }
                    }
                    EditorUtility.SetDirty(prefab);
                }
                AssetDatabase.SaveAssets();
                log.Add("swapped " + slots + " material slots on " + prefabs.Count + " prefabs");
                GolfMapVegetationRefresh.Refresh();
                log.Add("refreshed vegetation from materials");
                ResetSystems(log);
            }
            catch (Exception e)
            {
                RestoreFrom(dir, log);
                throw new BridgeError("Apply failed and was rolled back from " + dir + ": " + e.Message);
            }
            return new Dictionary<string, object>
            {
                { "backup", stamp }, { "prefabs", prefabs.Cast<object>().ToList() },
                { "log", log.Cast<object>().ToList() },
                { "next", "Inspect in Unity; build for GSPro to test there. Undo: golfmap.cti.restore backup=" + stamp },
            };
        }

        // CTI's per-material wind response (x: primary bending, y: branch turbulence, z: edge flutter).
        // Forst ships 1/1/1, which under the scene's wind looked like a storm (2026-09-27). The global
        // wind stays as it is for the other trees. Leaves and bark take the same value so the leaves
        // stay on their branches. VSP's CTI controller does not override this property.
        static readonly Vector4 WindMultipliers = new Vector4(0.5f, 0.5f, 0.5f, 0);

        // The trial materials: stock-named CTI shader, wind from script, the damped wind multipliers and
        // trial.json's texture overrides (prepare-cti-maps.py's tinted / no-spec copies).
        static void PrepareTrialMaterials(Trial trial, List<string> log)
        {
            foreach (var s in trial.swaps)
            {
                var to = Mat(s.to);
                var shader = Shader.Find(s.shader);
                if (to.shader != shader) { to.shader = shader; log.Add(s.to + " -> " + shader.name); }
                // Terrain-engine/VSP placement: wind comes from VSP's CTIWindController (_TerrainLODWind).
                if (to.HasProperty("_LODTerrain")) { to.SetFloat("_LODTerrain", 1); to.EnableKeyword("_METALLICGLOSSMAP"); }
                if (to.HasProperty("_BaseWindMultipliers") && to.GetVector("_BaseWindMultipliers") != WindMultipliers)
                {
                    to.SetVector("_BaseWindMultipliers", WindMultipliers);
                    log.Add(s.to + " _BaseWindMultipliers -> " + WindMultipliers);
                }
                foreach (var tex in s.textures ?? new Tex[0])
                {
                    var texture = AssetDatabase.LoadAssetAtPath<Texture>(tex.path);
                    if (!texture) throw new BridgeError("Texture not found: " + tex.path);
                    if (!to.HasProperty(tex.name)) throw new BridgeError(s.to + " has no " + tex.name + ".");
                    if (to.GetTexture(tex.name) != texture) { to.SetTexture(tex.name, texture); log.Add(s.to + " " + tex.name + " -> " + tex.path); }
                }
                EditorUtility.SetDirty(to);
            }
        }

        [BridgeCommand("golfmap.cti.restore", "Put back what golfmap.cti.apply changed, byte for byte from its backup (prefabs, tree catalogues, billboards), and refresh the vegetation systems.",
            args = "backup (folder name under GolfMapSpelunk/cti-trial; default the latest)")]
        static object Restore(BridgeArgs a)
        {
            var all = Backups();
            if (all.Count == 0) throw new BridgeError("No backup under " + BackupRoot + ".");
            var name = a.String("backup", all.Last());
            if (!all.Contains(name)) throw new BridgeError("No backup '" + name + "'. Have: " + string.Join(", ", all.ToArray()));
            var log = new List<string>();
            RestoreFrom(Path.Combine(BackupRoot, name), log);
            return new Dictionary<string, object> { { "backup", name }, { "log", log.Cast<object>().ToList() } };
        }

        static void WriteBackup(string dir, Backup backup)
        {
            Directory.CreateDirectory(dir);
            foreach (var f in backup.files) { Copy(f, Path.Combine(dir, f)); Copy(f + ".meta", Path.Combine(dir, f + ".meta")); }
            foreach (var folder in backup.folders)
                foreach (var f in Directory.GetFiles(folder, "*", SearchOption.AllDirectories))
                    Copy(f, Path.Combine(dir, f));
            File.WriteAllText(Path.Combine(dir, "backup.json"), JsonUtility.ToJson(backup, true));
        }

        static void Copy(string from, string to)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(to));
            File.Copy(from, to, true);
        }

        static void RestoreFrom(string dir, List<string> log)
        {
            var backup = JsonUtility.FromJson<Backup>(File.ReadAllText(Path.Combine(dir, "backup.json")));
            var swaps = backup.swaps != null && backup.swaps.Length > 0 ? backup.swaps
                : JsonUtility.FromJson<Trial>(File.ReadAllText(backup.course + "CTITrial/trial.json")).swaps;
            var back = new Dictionary<Material, Material>();
            foreach (var s in swaps) back[Mat(s.to)] = Mat(s.from);

            // 1. Prefabs: reverse the swap in memory and save, so memory and file agree.
            foreach (var path in backup.prefabs)
            {
                var prefab = AssetDatabase.LoadAssetAtPath<GameObject>(path);
                if (!prefab) throw new InvalidOperationException("Prefab missing: " + path);
                foreach (var r in Renderers(prefab))
                {
                    var mats = r.sharedMaterials;
                    bool changed = false;
                    for (int i = 0; i < mats.Length; i++)
                    {
                        Material from;
                        if (mats[i] && back.TryGetValue(mats[i], out from)) { mats[i] = from; changed = true; }
                    }
                    if (changed) { r.sharedMaterials = mats; EditorUtility.SetDirty(r); }
                }
                EditorUtility.SetDirty(prefab);
            }
            AssetDatabase.SaveAssets();
            int same = backup.prefabs.Count(p => File.ReadAllBytes(p).SequenceEqual(File.ReadAllBytes(Path.Combine(dir, p))));
            log.Add("prefabs reverted in memory; Unity's save matches the backup byte for byte for " + same + " of " + backup.prefabs.Length);

            // 2. Files: billboards the trial generated go, everything backed up is copied back.
            foreach (var folder in backup.folders)
                foreach (var f in Directory.Exists(folder) ? Directory.GetFiles(folder, "*", SearchOption.TopDirectoryOnly) : new string[0])
                {
                    var rel = f.Replace('\\', '/');
                    if (rel.EndsWith(".meta") || File.Exists(Path.Combine(dir, rel))) continue;
                    AssetDatabase.DeleteAsset(rel);
                    log.Add("removed " + rel);
                }
            var restored = backup.files.Concat(backup.folders.SelectMany(folder =>
                Directory.GetFiles(Path.Combine(dir, folder), "*", SearchOption.AllDirectories)
                    .Where(f => !f.EndsWith(".meta"))
                    .Select(f => f.Substring(dir.Length + 1).Replace('\\', '/')))).ToList();
            foreach (var rel in restored)
            {
                File.Copy(Path.Combine(dir, rel), rel, true);
                File.SetLastWriteTime(rel, DateTime.Now);
                // A .meta is only written when it is missing: an existing one already holds the same guid.
                if (!File.Exists(rel + ".meta") && File.Exists(Path.Combine(dir, rel + ".meta")))
                    File.Copy(Path.Combine(dir, rel + ".meta"), rel + ".meta");
            }
            AssetDatabase.StartAssetEditing();
            try { foreach (var rel in restored) AssetDatabase.ImportAsset(rel, ImportAssetOptions.ForceUpdate); }
            finally { AssetDatabase.StopAssetEditing(); }
            log.Add("copied back " + restored.Count + " files from " + dir);

            // 3. Catalogues: drop the in-memory copies; the next access loads the restored file.
            var catalogues = backup.files.Where(f => f.EndsWith(".asset")).ToList();
            foreach (var path in catalogues)
            {
                var loaded = AssetDatabase.LoadAssetAtPath<VegetationPackagePro>(path);
                if (loaded) Resources.UnloadAsset(loaded);
            }

            // 4. Verify memory against the files before anything can save again.
            var problems = new List<string>();
            // Exactly the materials the restored file references - not just "no trial material": a prefab
            // re-pointed by something else during the trial (a look Regenerate) must not slip through.
            foreach (var path in backup.prefabs)
            {
                var inFile = new HashSet<string>(System.Text.RegularExpressions.Regex.Matches(File.ReadAllText(path), @"fileID: 2100000, guid: (\w+)")
                    .Cast<System.Text.RegularExpressions.Match>().Select(m => m.Groups[1].Value));
                var inMemory = new HashSet<string>(Renderers(AssetDatabase.LoadAssetAtPath<GameObject>(path)).SelectMany(r => r.sharedMaterials)
                    .Where(m => m).Select(m => AssetDatabase.AssetPathToGUID(AssetDatabase.GetAssetPath(m))));
                if (!inFile.SetEquals(inMemory))
                    problems.Add(path + " draws " + string.Join(", ", inMemory.Except(inFile).Select(g => Path.GetFileName(AssetDatabase.GUIDToAssetPath(g))).ToArray()) + " in memory, not its file's materials");
            }
            foreach (var path in catalogues)
            {
                var catalog = AssetDatabase.LoadAssetAtPath<VegetationPackagePro>(path);
                var memory = catalog.VegetationInfoList.Select(i => i.ShaderName ?? "").ToList();
                var disk = System.Text.RegularExpressions.Regex.Matches(File.ReadAllText(path), @"^\s+ShaderName: ?(.*?)\r?$", System.Text.RegularExpressions.RegexOptions.Multiline)
                    .Cast<System.Text.RegularExpressions.Match>().Select(m => m.Groups[1].Value).ToList();
                if (!memory.SequenceEqual(disk)) problems.Add(path + " in memory differs from its file (" + memory.Count(n => n.StartsWith("CTI/")) + " CTI items in memory)");
            }
            if (problems.Count > 0)
                throw new InvalidOperationException("Files are restored, but the editor still holds trial state: " + string.Join("; ", problems.ToArray())
                    + ". Do not save; restart Unity without saving assets to load the restored files.");
            log.Add("verified: prefabs and " + catalogues.Count + " catalogues in memory match the restored files");
            ResetSystems(log);
        }

        // After a restore VSP kept drawing the oaks from stale state (opaque leaf cards, no alpha cut)
        // through a refresh and through a disable/enable of the systems; only a script reload cleared
        // it, so it lives in managed memory. Both are done: the reset now, the reload once the command
        // has returned. Only the editor is affected - GSPro loads the bundle fresh.
        static void ResetSystems(List<string> log)
        {
            var scene = UnityEngine.SceneManagement.SceneManager.GetActiveScene();
            foreach (var s in UnityEngine.Object.FindObjectsOfType<PersistentVegetationStorage>())
                if (s && s.gameObject.scene == scene && s.VegetationSystemPro)
                {
                    var system = s.VegetationSystemPro;
                    try { system.enabled = false; }
                    catch (Exception e) { log.Add("disabling " + system.name + ": " + e.GetType().Name + ": " + e.Message); }
                    system.enabled = true;
                    system.RefreshVegetationSystem();
                    system.ClearCache();
                }
            SceneView.RepaintAll();
            UnityEditorInternal.InternalEditorUtility.RequestScriptReload();
            log.Add("reset vegetation systems (disable, enable, refresh) and requested a script reload");
        }
    }
}
