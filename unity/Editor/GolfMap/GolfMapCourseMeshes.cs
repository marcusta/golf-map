// Unity 2018.2 / C# 6. Keeps the scene's course meshes in step with the FBX folder
// the Blender export writes into (course.meshFolder, one FBX per OPCD mesh), the way
// the manual step does it: an FBX whose content changed gets its scene object
// deleted and added again, like GSP > Add OPCD Meshes (instantiate under
// course.meshParent, MeshCollider, then OPCD's own GameObject > Set Default
// Materials), and only those objects; unchanged meshes are left alone. A creek bed
// (*_WaterBrook_-_Mesh) gets the GSPwater physic material after it (OPCD leaves it without).
//   - Changed = the FBX file's size or time differs from the last sync
//     (<course>/meshes-sync.json). The Blender FBX sync only rewrites meshes that
//     changed; after OPCD's Batch Export every mesh is replaced. The first sync has nothing to compare
//     with: it records the scene as it is (replaceAll=true rebuilds everything).
//   - FBX whose name starts with a course.meshExclude prefix (default: OPCD's Gap_Issue
//     markers) are never added; objects showing one are stale.
//   - An FBX with no scene object is added; an object under the parent that shows no
//     current FBX (deleted FBX, or a painted copy left of one) is stale (prune deletes).
//   - An FBX the Blender FBX sync's record (<folder>/.golfmap-fbx-sync.json) does not
//     list is a leftover of an older .blend (OPCD renumbers meshes when it regenerates
//     the file): never added, reported with its objects; the Blender export deletes it.
//     A record older than any FBX is ignored (OPCD's Batch Export bypasses it).
// The course meshes' shape and vertex paint are Blender's and come with the FBX (shaping layers 80-walls and
// 90-paint): a sync never paints. An object re-added from a new FBX shows the FBX mesh, so its entry in the
// paint's <course>/PaintedMeshes/restore.json (a temporary paint preview, the material it wore before a copy) is
// dropped (GolfMapVertexPaint.Forget); an object still showing a preview copy maps to its FBX through the collider
// (always the FBX mesh) or that record. With paint=true the materials are given again on what it re-added
// (golfmap.paint.materials: creek beds, pond shores, wall stone; OPCD's Set Default Materials undoes them), and
// the walls and boulders standing on a replaced or added mesh are built again (GolfMapWalls.RebuildOver), so their
// stones meet it; the rest keep theirs, hand edits included.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using GolfMap.Bridge;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;

namespace GolfMap.Editor
{
    public static class GolfMapCourseMeshes
    {
        const string StateFormat = "golfmap-meshes-sync-v2";
        const string StateFile = "meshes-sync.json";
        const string BlenderManifest = ".golfmap-fbx-sync.json";
        const string SetDefaultMaterialsMenu = "GameObject/Set Default Materials";  // OPCD, SetMeshEditorDLL: acts on Selection.gameObjects
        const string GrassRendererType = "StixGames.GrassShader.GrassRenderer";

        [MenuItem("GolfMap/Meshes/Preview sync from FBX folder")]
        static void PreviewMenu() { Log(Sync(true, false, true)); }

        [MenuItem("GolfMap/Meshes/Sync from FBX folder")]
        static void SyncMenu()
        {
            var plan = Sync(true, false, true);
            int stale = ((List<object>)plan["stale"]).Count;
            bool prune = stale > 0 && EditorUtility.DisplayDialog("Sync course meshes",
                stale + " object(s) under '" + plan["parent"] + "' no longer have an FBX (see the Console). Delete them?", "Delete", "Keep");
            if (plan.ContainsKey("leftoversHint")) Debug.LogWarning("[GolfMap Meshes] " + plan["leftoversHint"]);
            if (plan.ContainsKey("warnings")) foreach (var w in (List<object>)plan["warnings"]) Debug.LogWarning("[GolfMap Meshes] " + w);
            Log(Sync(false, prune, true));
        }

        [MenuItem("GolfMap/Meshes/Rebuild all from FBX folder")]
        static void RebuildMenu()
        {
            if (!EditorUtility.DisplayDialog("Rebuild course meshes", "Delete every course mesh object and add it again from the FBX folder (collider, OPCD Set Default Materials, course mesh materials)?", "Rebuild", "Cancel")) return;
            Log(Sync(false, true, true, null, null, true));
        }

        [BridgeCommand("golfmap.meshes.sync", "Bring the scene's course meshes in step with the course's FBX folder (Blender export) the way deleting and re-adding them by hand does, but only where something changed: an FBX whose content changed since the last sync (file size+time) has its object deleted and added again, new FBX are added (under the course's mesh parent, MeshCollider, OPCD's Set Default Materials), objects that show no current FBX are stale (deleted with prune); a re-added object's paint preview / material record is dropped (its new FBX carries Blender's paint), then (paint=true) golfmap.paint.materials runs on what it re-added and the stone walls on them are built again. The first sync only records the scene (replaceAll rebuilds everything). FBX the Blender manifest does not list (leftovers of an older .blend) are never added. Marks the scene dirty; save=true saves it (and the assets it changed) once the sync has succeeded.",
            args = "dryRun=false (plan only), prune=false (delete stale objects), paint=true (course mesh materials and stone walls on what it re-added; never vertex paint), replaceAll=false, folder (under Assets; default: the course's meshFolder), parent (default: the course's meshParent), exclude (comma-separated FBX name prefixes; default: the course's meshExclude), " + GolfMapSceneSave.Arg)]
        static object Command(BridgeArgs a)
        {
            return Sync(a.Bool("dryRun", false), a.Bool("prune", false), a.Bool("paint", true), a.String("folder"), a.String("parent"), a.Bool("replaceAll", false), a.String("exclude"));
        }

        // Read-only: renderers that may draw white or untextured after a sync/refresh. Per active MeshRenderer of the
        // scene: a missing mesh or material, Unity's default material, the error shader, a material with no texture
        // at all, a Standard-type material without _MainTex, an OPCD MAHS material whose satellite/array textures are
        // missing, and a painted copy whose collider shows another vertex count than the renderer (the two drew
        // different shapes before GolfMapVertexPaint.Overwrite). Findings are grouped by material: objects per material.
        [BridgeCommand("golfmap.materials.audit", "Read-only: active renderers that may draw white/untextured - no mesh or material, Unity's default material, error shader, material without any texture, Standard without _MainTex, OPCD MAHS without satellite/arrays, ortho material on a mesh without UVs, renderer and collider meshes that differ in vertex count.",
            args = "under (object path prefix; default the whole scene), limit=40 (objects listed per finding)")]
        internal static object AuditMaterials(BridgeArgs a)
        {
            string under = a.String("under");
            int limit = (int)a.Number("limit", 40);
            var findings = new Dictionary<string, List<string>>();
            Action<string, string> add = (reason, what) => { List<string> l; if (!findings.TryGetValue(reason, out l)) findings[reason] = l = new List<string>(); l.Add(what); };
            int renderers = 0;
            var scene = EditorSceneManager.GetActiveScene();
            foreach (var r in scene.GetRootGameObjects().SelectMany(g => g.GetComponentsInChildren<MeshRenderer>(false)))
            {
                if (!r.enabled) continue;
                var path = "/" + string.Join("/", r.GetComponentsInParent<Transform>(true).Reverse().Select(t => t.name).ToArray());
                if (under != null && !path.StartsWith(under, StringComparison.Ordinal)) continue;
                renderers++;
                var mf = r.GetComponent<MeshFilter>();
                var mesh = mf != null ? mf.sharedMesh : null;
                if (mf != null && mesh == null) add("no mesh", path);
                var mc = r.GetComponent<MeshCollider>();
                if (mesh != null && mc != null && mc.sharedMesh != null && mc.sharedMesh != mesh && mc.sharedMesh.vertexCount != mesh.vertexCount
                    && AssetDatabase.GetAssetPath(mesh) != AssetDatabase.GetAssetPath(mc.sharedMesh) && AssetDatabase.GetAssetPath(mesh).Contains("/PaintedMeshes/")
                    && !AssetDatabase.GetAssetPath(mc.sharedMesh).EndsWith(".fbx", StringComparison.OrdinalIgnoreCase))
                    add("renderer and collider meshes differ", path);
                var mats = r.sharedMaterials;
                if (mats.Length == 0) add("no material", path);
                foreach (var m in mats)
                {
                    if (m == null) { add("empty material slot", path); continue; }
                    var mp = AssetDatabase.GetAssetPath(m);
                    string what = m.name + " (" + (m.shader != null ? m.shader.name : "no shader") + ") | " + path;
                    if (m.shader == null || m.shader.name == "Hidden/InternalErrorShader") { add("error shader (pink)", what); continue; }
                    // OPCD's Set Default Materials reads the MAHS channel properties off such a renderer and logs
                    // "Material doesn't have a color property '_RedOverallColor'" (and the rest) for it.
                    if (r.GetComponent("MeshChannelMaterialsStore") != null && !m.HasProperty("_RedOverallColor")) add("OPCD channel store on a material without the MAHS channels", what);
                    if (m.name == "Default-Material" || mp == "Resources/unity_builtin_extra") add("Unity default material", what);
                    var texProps = Enumerable.Range(0, ShaderUtil.GetPropertyCount(m.shader))
                        .Where(i => ShaderUtil.GetPropertyType(m.shader, i) == ShaderUtil.ShaderPropertyType.TexEnv)
                        .Select(i => ShaderUtil.GetPropertyName(m.shader, i)).ToList();
                    if (texProps.Count > 0 && texProps.All(p => m.GetTexture(p) == null)) add("material without any texture", what);
                    if (m.shader.name.StartsWith("Standard", StringComparison.Ordinal) && m.HasProperty("_MainTex") && m.GetTexture("_MainTex") == null)
                    {
                        var c = m.HasProperty("_Color") ? m.color : Color.white;
                        if (c.r > 0.8f && c.g > 0.8f && c.b > 0.8f) add("Standard, no _MainTex, white colour", what);
                    }
                    if (m.HasProperty("_Satellite"))
                    {
                        bool usesSat = m.shaderKeywords.Any(k => k.EndsWith("USESATELLITEFORBASE_ON", StringComparison.Ordinal));
                        if (usesSat && m.GetTexture("_Satellite") == null) add("OPCD MAHS: satellite used but missing", what);
                        foreach (var arr in new[] { "_BaseArray", "_DetailArray", "_NormalArray" })
                            if (m.HasProperty(arr) && m.GetTexture(arr) == null) add("OPCD MAHS: " + arr + " missing", what);
                    }
                }
            }
            return new Dictionary<string, object>
            {
                { "scene", scene.name }, { "renderers", renderers },
                { "findings", findings.ToDictionary(kv => kv.Key, kv => (object)new Dictionary<string, object> {
                    { "objects", kv.Value.Count },
                    { "groups", kv.Value.GroupBy(w => w.Split('|')[0].Trim()).OrderByDescending(g => g.Count()).Take(limit)
                        .Select(g => g.Key + " x" + g.Count() + "  e.g. " + g.First().Split('|').Last().Trim()).ToList() } }) },
            };
        }

        // only: object names (= FBX names without extension), the fast per-feature path of golfmap.course.refresh only=.
        // Then just those FBX are imported (AssetDatabase.ImportAsset each, no full Refresh), every named FBX is replaced
        // (or added when no object shows it) whatever the record says - the caller knows they changed -, only named
        // objects whose FBX is gone are stale, and only their entries of the sync record are updated.
        public static Dictionary<string, object> Sync(bool dryRun, bool prune, bool paint, string folderName = null, string parentName = null, bool replaceAll = false, string excludePrefixes = null, bool importChanged = true,
            ICollection<string> only = null)
        {
            var laps = new GolfMapTerrainConform.Laps();
            var course = GolfMapCourses.Require();
            var folder = "Assets/" + (folderName ?? course.meshFolder).Trim('/', '\\').Replace('\\', '/');
            var parentObject = parentName ?? course.meshParent;
            // Read everything from the course now: OPCD's Set Default Materials saves assets and unloads
            // unused ones, and the course asset (referenced by nothing in the scene) goes with them.
            var courseFolder = GolfMapCourses.Folder(course);
            var originals = GolfMapVertexPaint.OriginalAssets(courseFolder);
            var painted = courseFolder + "PaintedMeshes/";
            var exclude = (excludePrefixes ?? course.meshExclude ?? "").Split(',').Select(x => x.Trim()).Where(x => x.Length > 0).ToArray();
            course = null;
            if (!AssetDatabase.IsValidFolder(folder)) throw new InvalidOperationException("Course mesh folder " + folder + " does not exist (course.meshFolder).");
            // imports what the export rewrote, like focusing Unity would; importChanged=false plans from the files on
            // disk without importing (golfmap.course.refresh dryRun)
            var named = only == null ? null : new HashSet<string>(only, StringComparer.OrdinalIgnoreCase);
            var files = Directory.GetFiles(folder, "*.fbx", SearchOption.AllDirectories)
                .Select(f => f.Replace('\\', '/')).OrderBy(f => f, StringComparer.Ordinal).ToList();
            if (named != null) files = files.Where(f => named.Contains(Path.GetFileNameWithoutExtension(f))).ToList();
            if (importChanged)
            {
                if (named == null) AssetDatabase.Refresh();
                else foreach (var f in files) AssetDatabase.ImportAsset(f, ImportAssetOptions.ForceUpdate);
            }
            laps.Mark("import");

            var scene = EditorSceneManager.GetActiveScene();
            var all = scene.GetRootGameObjects().SelectMany(r => r.GetComponentsInChildren<Transform>(true)).Select(t => t.gameObject).ToList();
            var parent = all.FirstOrDefault(g => g.transform.parent == null && g.name == parentObject)
                      ?? all.FirstOrDefault(g => g.name == parentObject);
            var underParent = parent == null ? new List<GameObject>()
                : parent.GetComponentsInChildren<Transform>(true).Select(t => t.gameObject).Where(g => g != parent).ToList();
            if (named != null)
            {
                // only the named objects (a painted copy keeps its object's name); the parent was found above from all
                all = all.Where(g => named.Contains(g.name)).ToList();
                underParent = underParent.Where(g => named.Contains(g.name)).ToList();
            }

            // Which scene objects show which FBX. Course mesh objects are leaves: the parent, or anything
            // with children, is never one (replacing it would delete everything under it), even when it
            // carries a mesh of its own - e.g. a parent made by dragging an FBX in and renaming it. A water plane is
            // the exception: OPCD's Set Default Materials gives it a child 'Default Reflection Probe', and it is the
            // FBX's object (else a sync adds the plane a second time).
            var byFile = new Dictionary<string, List<GameObject>>(StringComparer.OrdinalIgnoreCase);
            var holders = new List<object>();
            foreach (var go in all)
            {
                var src = SourceFbx(go, folder, originals, painted);
                if (src != null && (go == parent || (go.transform.childCount > 0 && !GolfMapWaterplanes.IsWaterPlane(go.name))))
                {
                    holders.Add(PathOf(go) + " renders " + Path.GetFileNameWithoutExtension(src) + " itself: it draws twice where that mesh's own object is. Remove its MeshFilter/MeshRenderer/MeshCollider.");
                    continue;
                }
                if (src == null) continue;
                List<GameObject> list;
                if (!byFile.TryGetValue(src, out list)) byFile[src] = list = new List<GameObject>();
                list.Add(go);
            }
            // The Blender record is only current while no FBX is newer than it (OPCD's own Batch Export
            // rewrites the files without it); a stale one would hide new meshes as leftovers.
            var manifest = BlenderExport(folder);
            bool manifestStale = manifest != null && files.Any(f => File.GetLastWriteTimeUtc(f) > File.GetLastWriteTimeUtc(folder + "/" + BlenderManifest).AddSeconds(2));
            if (manifestStale) manifest = null;
            var leftovers = manifest == null ? new List<string>() : files.Where(f => !manifest.ContainsKey(Path.GetFileNameWithoutExtension(f))).ToList();
            Func<string, bool> excluded = f => f != null && exclude.Any(x => Path.GetFileNameWithoutExtension(f).StartsWith(x, StringComparison.Ordinal));
            var skipped = files.Where(excluded).ToList();
            leftovers = leftovers.Where(f => !excluded(f)).ToList();
            var current = files.Where(f => !leftovers.Contains(f) && !excluded(f)).ToList();
            var versions = current.ToDictionary(f => f, Version, StringComparer.OrdinalIgnoreCase);
            laps.Mark("scan");

            var statePath = courseFolder + StateFile;
            var previous = LoadState(statePath, folder);
            var missing = current.Where(f => !byFile.ContainsKey(f)).ToList();
            var changed = current.Where(f => byFile.ContainsKey(f) &&
                (replaceAll || named != null || (previous != null &&(!previous.ContainsKey(f) || previous[f] != versions[f])))).ToList();
            // Stale: a course mesh object under the parent that shows no current FBX. Its mesh reads
            // null once the FBX is deleted, but a painted copy keeps rendering, so that alone is not enough.
            // Objects showing an excluded FBX (course.meshExclude, e.g. OPCD's Gap_Issue markers) go the same way.
            // A painted copy's source comes from the paint record, which still names the FBX after it was deleted
            // (renamed meshes after a new .blend): stale too when that file is gone.
            Func<GameObject, bool> isStale = g =>
            {
                var src = SourceFbx(g, folder, originals, painted);
                return src == null || excluded(src) || !File.Exists(src);
            };
            var stale = underParent.Where(g => g.transform.childCount == 0 && g.GetComponent<MeshFilter>() != null && isStale(g)).ToList();
            var duplicates = byFile.Where(kv => kv.Value.Count > 1)
                .Select(kv => (object)new Dictionary<string, object> { { "fbx", kv.Key }, { "objects", kv.Value.Select(g => (object)PathOf(g)).ToList() } }).ToList();

            var result = new Dictionary<string, object>
            {
                { "scene", scene.name },
                { "folder", folder },
                { "parent", parentObject },
                { "dryRun", dryRun },
                { "fbx", current.Count },
                { "excluded", skipped.Count },
                { "firstSync", previous == null && !replaceAll && named == null },
                { "added", missing.Select(f => (object)Path.GetFileNameWithoutExtension(f)).ToList() },
                { "replaced", changed.Select(f => (object)Path.GetFileNameWithoutExtension(f)).ToList() },
                { "stale", stale.Select(g => (object)PathOf(g)).ToList() },
                { "duplicates", duplicates },
                { "leftovers", manifest == null ? (object)(manifestStale
                        ? "not checked: FBX were written after " + BlenderManifest + " (e.g. by OPCD's Batch Export)"
                        : "not checked: no " + BlenderManifest + " (Blender FBX sync not used on this folder)")
                    : leftovers.Select(f => (object)new Dictionary<string, object> {
                        { "fbx", Path.GetFileNameWithoutExtension(f) },
                        { "objects", byFile.ContainsKey(f) ? byFile[f].Select(g => (object)PathOf(g)).ToList() : new List<object>() } }).ToList() },
            };
            if (holders.Count > 0) result["warnings"] = holders;
            if (leftovers.Count > 0)
                result["leftoversHint"] = leftovers.Count + " FBX are not exported by the current .blend: run Export changed FBX in Blender with 'Delete FBX of removed meshes' ticked, then sync again.";
            if (named != null)
            {
                var known = new HashSet<string>(files.Select(f => Path.GetFileNameWithoutExtension(f)), StringComparer.OrdinalIgnoreCase);
                known.UnionWith(all.Select(g => g.name));
                result["only"] = named.Count;
                result["unknown"] = named.Where(n => !known.Contains(n)).OrderBy(n => n, StringComparer.Ordinal).Cast<object>().ToList();
            }
            if (previous == null && !replaceAll && named == null)
                result["firstSyncNote"] = "No record of a previous sync: the scene's existing objects are taken as current and recorded. Use Rebuild all (replaceAll=true) if they may be out of date.";
            // the stone walls a sync builds again: those standing on a mesh it replaces (see GolfMapWalls.RebuildOver)
            var wallsOver = GolfMapWalls.WallsOver(changed.SelectMany(f => byFile[f]).ToList());
            if (wallsOver != null && paint) result["wallsToRebuild"] = wallsOver.Cast<object>().ToList();
            laps.Mark("plan");
            result["timings"] = laps.times;
            if (dryRun) return result;

            Undo.IncrementCurrentGroup();
            int undoGroup = Undo.GetCurrentGroup();
            Undo.SetCurrentGroupName("Sync course meshes");
            var errors = new List<object>();
            var created = new List<GameObject>();
            if (missing.Count + changed.Count > 0 && parent == null)
            {
                parent = new GameObject(parentObject);
                Undo.RegisterCreatedObjectUndo(parent, "Sync course meshes");
            }
            foreach (var file in missing.Concat(changed))
            {
                var model = AssetDatabase.LoadAssetAtPath<GameObject>(file);
                if (model == null) { errors.Add(file + ": Unity did not import it as a model."); continue; }
                // A replaced object keeps its place under its parent.
                List<GameObject> old;
                byFile.TryGetValue(file, out old);
                var place = old != null ? old[0].transform : null;
                var at = place != null && place.parent != null ? place.parent : parent.transform;
                int index = place != null ? place.GetSiblingIndex() : -1;
                if (old != null) foreach (var g in old) Undo.DestroyObjectImmediate(g);
                var go = (GameObject)PrefabUtility.InstantiatePrefab(model, scene);
                Undo.RegisterCreatedObjectUndo(go, "Sync course meshes");
                go.transform.SetParent(at, false);
                if (index >= 0) go.transform.SetSiblingIndex(index);
                go.transform.localPosition = Vector3.zero;
                go.transform.localRotation = Quaternion.identity;
                var filter = go.GetComponent<MeshFilter>();
                if (filter != null && go.GetComponent<MeshCollider>() == null)
                    Undo.AddComponent<MeshCollider>(go).sharedMesh = filter.sharedMesh;
                created.Add(go);
            }
            laps.Mark("swap");
            if (created.Count > 0) result["opcdMaterials"] = SetDefaultMaterials(created, errors);
            laps.Mark("opcdMaterials");
            if (prune)
                foreach (var g in stale) if (g != null) Undo.DestroyObjectImmediate(g);
            Undo.CollapseUndoOperations(undoGroup);

            // A re-added object shows its new FBX mesh: a paint preview of the old one, or the material it wore before a
            // material copy, no longer holds (OPCD's Set Default Materials dressed it afresh).
            if (created.Count > 0)
            {
                var forgotten = GolfMapVertexPaint.Forget(courseFolder, created.Where(g => g != null).Select(g => PathOf(g)));
                if (forgotten.Count > 0) result["paintRecordsDropped"] = forgotten.Cast<object>().ToList();
            }
            // The materials read the FBX colours (the wall stone), so they come after the new objects exist.
            if (paint && created.Count > 0)
            {
                var names = created.Where(g => g != null).Select(g => g.name).ToList();
                try { result["materials"] = Summary(GolfMapVertexPaint.Materials(false, names)); }
                catch (Exception e) { errors.Add("golfmap.paint.materials: " + e.Message); Debug.LogException(e); }
                var walls = GolfMapWalls.RebuildOver(created);
                if (walls != null) result["walls"] = walls;
            }

            if (created.Count > 0 || (prune && stale.Count > 0)) EditorSceneManager.MarkSceneDirty(scene);
            if (named == null) SaveState(statePath, folder, versions);
            else if (previous != null)
            {
                // only the named entries; the rest keep what the last sync recorded (with no record yet none is started,
                // so the next full sync still takes the scene as current)
                foreach (var k in previous.Keys.Where(k => named.Contains(Path.GetFileNameWithoutExtension(k))).ToList()) previous.Remove(k);
                foreach (var kv in versions) previous[kv.Key] = kv.Value;
                SaveState(statePath, folder, previous);
            }
            result["created"] = created.Where(g => g != null).Select(g => (object)PathOf(g)).ToList();

            result["prunedStale"] = prune && stale.Count > 0;
            result["errors"] = errors;
            result["followUps"] = FollowUps(created, created.Count > 0 || (prune && stale.Count > 0));
            laps.Mark("record");
            return result;
        }

        const int MaterialsBatch = 50;

        // OPCD's Set Default Materials on the objects, checked: on a large selection (a whole course re-added: 789
        // objects) it left 668 of them with the material their FBX carries, while each alone gets its OPCD material.
        // So what still wears an FBX material afterwards goes again in batches, then one by one. A rock slab is left
        // out altogether (golfmap.slabs.materials dresses it): OPCD knows no such surface, so it makes a ChannelMaterials
        // out of the slab's FBX material (Resources/Materials/SOs/Rough.asset) and then logs ~140 "Material doesn't
        // have a ... property '_Red...'" errors per slab reading MAHS channels off that Standard material.
        static Dictionary<string, object> SetDefaultMaterials(List<GameObject> objects, List<object> errors)
        {
            objects = objects.Where(g => g != null && !GolfMapRockSlabs.IsSlab(g.name)).ToList();
            if (objects.Count == 0) return new Dictionary<string, object> { { "objects", 0 } };
            // a slab that got OPCD's store some other way (the menu run by hand on it) would make every run below log errors
            int slabStores = GolfMapRockSlabs.StripChannelStores(EditorSceneManager.GetActiveScene());
            var selection = Selection.objects;
            int passes = 0;
            Func<List<GameObject>, bool> run = batch =>
            {
                passes++;
                Selection.objects = batch.Cast<UnityEngine.Object>().ToArray();
                return EditorApplication.ExecuteMenuItem(SetDefaultMaterialsMenu);
            };
            Func<List<GameObject>> undressed = () => objects.Where(g => g != null && WearsFbxMaterial(g)).ToList();
            var result = new Dictionary<string, object> { { "objects", objects.Count } };
            if (slabStores > 0) result["slabStoresRemoved"] = slabStores;
            if (!run(objects))
            {
                Selection.objects = selection;
                errors.Add("OPCD's '" + SetDefaultMaterialsMenu + "' is not in this project; the new meshes have no materials.");
                return result;
            }
            var left = undressed();
            result["leftByFirstPass"] = left.Count;
            foreach (int size in new[] { MaterialsBatch, 1 })
            {
                if (left.Count == 0) break;
                for (int i = 0; i < left.Count; i += size) run(left.GetRange(i, Math.Min(size, left.Count - i)));
                left = undressed();
            }
            Selection.objects = selection;
            result["passes"] = passes;
            int brooks = BrookPhysics(objects);
            if (brooks > 0) result["brookWater"] = brooks;
            result["left"] = left.Select(g => (object)g.name).ToList();
            if (left.Count > 0)
                errors.Add(left.Count + " object(s) still wear their FBX material after OPCD's '" + SetDefaultMaterialsMenu + "' (e.g. " + left[0].name + ").");
            return result;
        }

        const string BrookMarker = "_WaterBrook_-_Mesh";
        const string WaterPhysics = "Assets/Resources/Physics/GSPwater.physicMaterial";

        // OPCD's Set Default Materials leaves a creek bed (Spline_*_WaterBrook_-_Mesh) without the water physic
        // material: its MeshCollider gets GSPwater (what golfmap.course.ready checks), so the ball in the creek is wet.
        // Returns how many changed.
        static int BrookPhysics(IEnumerable<GameObject> objects)
        {
            var water = AssetDatabase.LoadAssetAtPath<PhysicMaterial>(WaterPhysics);
            if (water == null) return 0;
            int changed = 0;
            foreach (var g in objects)
            {
                if (g == null || !g.name.EndsWith(BrookMarker, StringComparison.Ordinal)) continue;
                var c = g.GetComponent<MeshCollider>();
                if (c == null || c.sharedMaterial == water) continue;
                Undo.RecordObject(c, "Creek bed physics");
                c.sharedMaterial = water;
                changed++;
            }
            return changed;
        }

        // A material that is a sub-asset of a model file: what a freshly instantiated FBX wears.
        static bool WearsFbxMaterial(GameObject go)
        {
            var r = go.GetComponent<MeshRenderer>();
            return r != null && r.sharedMaterials.Any(m => m != null && AssetDatabase.GetAssetPath(m).EndsWith(".fbx", StringComparison.OrdinalIgnoreCase));
        }

        [BridgeCommand("golfmap.meshes.materials", "OPCD's Set Default Materials on the course meshes that still wear the material their FBX carries (a sync whose material step did not reach them), in batches, checked. Afterwards run golfmap.course.refresh skip=meshes.sync: OPCD's defaults undo the bunker convention, the path look and the rough grass on what they touch. Marks the scene dirty, does not save it.",
            args = "dryRun=false, parent (default: the course's meshParent)")]
        static object MaterialsCommand(BridgeArgs a)
        {
            var course = GolfMapCourses.Require();
            var parentObject = a.String("parent") ?? course.meshParent;
            course = null;   // OPCD's Set Default Materials unloads it
            var scene = EditorSceneManager.GetActiveScene();
            var parent = scene.GetRootGameObjects().FirstOrDefault(g => g.name == parentObject);
            if (parent == null) throw new BridgeError("No root object '" + parentObject + "' in " + scene.name + ".");
            var todo = parent.GetComponentsInChildren<MeshRenderer>(true).Select(r => r.gameObject)
                .Where(g => g != parent && !GolfMapRockSlabs.IsSlab(g.name) && WearsFbxMaterial(g)).ToList();
            var result = new Dictionary<string, object> { { "scene", scene.name }, { "parent", parentObject }, { "dryRun", a.Bool("dryRun", false) }, { "wearFbxMaterial", todo.Count },
                { "first", todo.Take(12).Select(g => (object)g.name).ToList() } };
            if (a.Bool("dryRun", false) || todo.Count == 0) return result;
            var errors = new List<object>();
            // batches from the start: the whole selection at once is what failed
            for (int i = 0; i < todo.Count; i += MaterialsBatch)
            {
                Selection.objects = todo.GetRange(i, Math.Min(MaterialsBatch, todo.Count - i)).Cast<UnityEngine.Object>().ToArray();
                if (!EditorApplication.ExecuteMenuItem(SetDefaultMaterialsMenu)) throw new BridgeError("OPCD's '" + SetDefaultMaterialsMenu + "' is not in this project.");
            }
            var left = todo.Where(g => g != null && WearsFbxMaterial(g)).ToList();
            if (left.Count > 0) result["opcdMaterials"] = SetDefaultMaterials(left, errors);
            else { int brooks = BrookPhysics(todo); if (brooks > 0) result["brookWater"] = brooks; }
            Selection.objects = new UnityEngine.Object[0];
            result["left"] = todo.Where(g => g != null && WearsFbxMaterial(g)).Select(g => (object)g.name).ToList();
            result["errors"] = errors;
            EditorSceneManager.MarkSceneDirty(scene);
            return result;
        }

        // What the scene object was built from: the file's size and time. The Blender FBX sync only
        // rewrites changed meshes; OPCD's Batch Export rewrites all, which then all get replaced.
        static string Version(string file)
        {
            var info = new FileInfo(file);
            return info.Length + "@" + info.LastWriteTimeUtc.Ticks;
        }

        static Dictionary<string, object> Summary(Dictionary<string, object> paint)
        {
            return paint.Where(kv => kv.Key != "wearing").ToDictionary(kv => kv.Key, kv => kv.Value);
        }

        // Name -> fingerprint of what the current .blend exports (the Blender FBX sync's manifest); null without one.
        static Dictionary<string, string> BlenderExport(string folder)
        {
            var path = folder + "/" + BlenderManifest;
            if (!File.Exists(path)) return null;
            var files = GolfMapJsonDoc.ParseObject(File.ReadAllText(path)).Object("files");
            if (files == null) return null;
            var map = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (var key in files.keys) map[key] = files.String(key) ?? "";
            return map;
        }

        // The FBX (under folder) an object's mesh comes from: the collider keeps the
        // FBX mesh when a paint preview has swapped the MeshFilter to a copy; when both
        // show a copy under `painted` (an old stone-wall ground copy), the paint's record names it.
        static string SourceFbx(GameObject go, string folder, Dictionary<string, string> originals, string painted)
        {
            var collider = go.GetComponent<MeshCollider>();
            var filter = go.GetComponent<MeshFilter>();
            bool copy = false;
            foreach (var mesh in new[] { collider != null ? collider.sharedMesh : null, filter != null ? filter.sharedMesh : null })
            {
                if (mesh == null) continue;
                var p = AssetDatabase.GetAssetPath(mesh);
                if (p.StartsWith(folder + "/", StringComparison.OrdinalIgnoreCase) && p.EndsWith(".fbx", StringComparison.OrdinalIgnoreCase)) return p;
                copy |= p.StartsWith(painted, StringComparison.OrdinalIgnoreCase);
            }
            string o;
            if (copy && originals.TryGetValue(PathOf(go), out o) && o != null &&
                o.StartsWith(folder + "/", StringComparison.OrdinalIgnoreCase) && o.EndsWith(".fbx", StringComparison.OrdinalIgnoreCase)) return o;
            return null;
        }

        // A course mesh object whose mesh asset was deleted: the references read null.
        static bool LostMesh(GameObject go)
        {
            var filter = go.GetComponent<MeshFilter>();
            if (filter == null || filter.sharedMesh != null) return false;
            var collider = go.GetComponent<MeshCollider>();
            return collider == null || collider.sharedMesh == null;
        }

        static List<object> FollowUps(List<GameObject> created, bool meshesChanged)
        {
            var list = new List<object>();
            var grass = AppDomain.CurrentDomain.GetAssemblies().Select(a => a.GetType(GrassRendererType, false)).FirstOrDefault(t => t != null);
            // Only where the course already grows it on its rough meshes.
            if (grass != null && created.Any(g => IsRough(g.name)) &&
                UnityEngine.Object.FindObjectsOfType(grass).Cast<Component>().Any(c => IsRough(c.name) && !created.Contains(c.gameObject)))
                list.Add("New rough meshes have no Stix 3D grass: golfmap.roughgrass.plant (GolfMap > Plant 3D grass to roughs).");
            if (meshesChanged)
                list.Add("Meshes changed: if the terrain was conformed to them, re-run golfmap.terrain.conform; re-export surfaces (golfmap.surfaces.export) before regenerating grass zones.");
            return list;
        }

        static bool IsRough(string name)
        {
            return name.StartsWith("Spline_", StringComparison.Ordinal) && GolfMapSurfaces.Classify(name) == GolfMapSurfaces.Surface.Rough;
        }

        static Dictionary<string, string> LoadState(string path, string folder)
        {
            if (!File.Exists(path)) return null;
            var root = GolfMapJsonDoc.ParseObject(File.ReadAllText(path));
            var files = root.Object("files");
            var state = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            if (root.String("format") != StateFormat || root.String("folder") != folder || files == null) return null;
            foreach (var key in files.keys) state[key] = files.String(key);
            return state;
        }

        static void SaveState(string path, string folder, Dictionary<string, string> stamps)
        {
            var files = new Dictionary<string, object>();
            foreach (var kv in stamps.OrderBy(k => k.Key, StringComparer.Ordinal)) files[kv.Key] = kv.Value;
            File.WriteAllText(path, GolfMapJson.Serialize(new Dictionary<string, object> { { "format", StateFormat }, { "folder", folder }, { "files", files } }));
        }

        static string PathOf(GameObject go)
        {
            var path = go.name;
            for (var t = go.transform.parent; t != null; t = t.parent) path = t.name + "/" + path;
            return "/" + path;
        }

        static void Log(Dictionary<string, object> result)
        {
            Debug.Log("[GolfMap Meshes] " + GolfMapJson.Serialize(result));
        }
    }
}
