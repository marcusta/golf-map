// What the loaded course is made of besides vegetation, and what each part costs: an inventory of
// the scene's mesh renderers by hierarchy group, and a reversible switch for a group's renderers
// (or any component type), so a frame rate can be measured with and without it.
using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;
using UnityEngine;

namespace GolfMap.Bridge
{
    static class SceneCommands
    {
        static string PathOf(Transform t, int depth = int.MaxValue)
        {
            var parts = new List<string>();
            for (; t; t = t.parent) parts.Add(t.name);
            parts.Reverse();
            return "/" + string.Join("/", parts.Take(depth).ToArray());
        }

        static long Triangles(Mesh mesh)
        {
            long indices = 0;
            for (int i = 0; i < mesh.subMeshCount; i++) indices += mesh.GetIndexCount(i);
            return indices / 3;
        }

        // Caller-given groups instead of hierarchy levels: groups=[{id, match}], match = a regex on the object's path, tried
        // in order, the first that matches wins; anything else is "other:<root object, digits as #>". The performance ranking sends
        // its categories this way (unity/perf-rank.ts; the editor's GolfMapPerf does the same with the same rules).
        sealed class Rule { public string id; public Regex match; }

        static List<Rule> Rules(BridgeArgs a)
        {
            var list = a.List("groups");
            if (list == null) return null;
            var rules = new List<Rule>();
            foreach (var o in list)
            {
                var d = o as Dictionary<string, object>;
                if (d == null || !d.ContainsKey("id") || !d.ContainsKey("match")) throw new BridgeError("groups: each entry needs id and match.");
                rules.Add(new Rule { id = Convert.ToString(d["id"]), match = new Regex(Convert.ToString(d["match"])) });
            }
            return rules;
        }

        // The group of a path, and how many levels deep one unit of it is (a car, a wall, a course mesh): the path up
        // to the end of the segment the match ends in, or of the next one when the match ends on a slash.
        static string GroupOf(List<Rule> rules, string path, out int unitDepth)
        {
            string unit = null, id = null;
            foreach (var rule in rules)
            {
                var m = rule.match.Match(path);
                if (!m.Success) continue;
                int slash = path.IndexOf('/', m.Index + m.Length);
                unit = slash < 0 ? path : path.Substring(0, slash);
                id = rule.id;
                break;
            }
            if (id == null)
            {
                // Numbered siblings and instantiated copies share one row (FlagAssembly_0..17 -> FlagAssembly_#,
                // teeMarker(Clone)143 -> teeMarker#); one unit of it is a root object.
                var parts = path.Split('/');
                string root = parts.Length > 1 ? parts[1] : "";
                id = "other:" + Regex.Replace(root.Replace("(Clone)", ""), "[0-9]+", "#").Trim();
                unit = "/" + root;
            }
            unitDepth = unit.Count(c => c == '/');
            return id;
        }

        static Transform Ancestor(Transform t, int depth)
        {
            int own = 0;
            for (var p = t; p; p = p.parent) own++;
            for (; own > depth && t.parent; own--) t = t.parent;
            return t;
        }

        sealed class Group
        {
            public int renderers, active, skinned, shadowCasters, lodGroups, batched;
            public long triangles, activeTriangles, lod0Triangles;
            public readonly HashSet<Transform> units = new HashSet<Transform>();
            public readonly HashSet<Material> materials = new HashSet<Material>();
            public readonly HashSet<Mesh> meshes = new HashSet<Mesh>();
            public readonly Dictionary<string, int> shaders = new Dictionary<string, int>();
        }

        [BridgeCommand("scene.geometry", "Read-only inventory of the loaded scenes' mesh renderers (vegetation drawn by Vegetation Studio is instanced and not in it), grouped by the first `depth` levels of the hierarchy, or by groups=[{id, match}] (match = a regex on the object's path, the first that matches wins, the rest is other:<root object>): renderers (and how many are active and enabled), triangles (every instance counted; activeTriangles = of the active ones; lod0Triangles = of those, the nearest LOD level only), units (with groups: the cars, walls, meshes), distinct meshes and materials, shadow casters, LODGroups, batched (statically batched renderers: their triangles are the whole combined mesh, counted once a group, so an upper bound), and the most used shaders. `path` keeps only objects whose path starts with it (to open a group up: raise depth). Sorted by triangles.",
            args = "depth=2, groups=[{id, match}], path, scene (part of a scene name), limit=40, digits=true (false: digits taken out of names, so numbered siblings fall into one group)")]
        static object Geometry(BridgeArgs a)
        {
            int depth = Mathf.Clamp(a.Int("depth", 2), 1, 12), limit = a.Int("limit", 40);
            string prefix = a.String("path"), sceneName = a.String("scene");
            bool digits = a.Bool("digits", true);
            var rules = Rules(a);
            var groups = new Dictionary<string, Group>();
            Func<Transform, Group> groupOf = t =>
            {
                string key;
                int unitDepth = 0;
                if (rules != null) key = GroupOf(rules, PathOf(t), out unitDepth);
                else
                {
                    key = t.gameObject.scene.name + ":" + PathOf(t, depth);
                    if (!digits) key = Regex.Replace(key, @"[\d]+", "#");
                }
                Group g;
                if (!groups.TryGetValue(key, out g)) groups[key] = g = new Group();
                if (rules != null) g.units.Add(Ancestor(t, unitDepth));
                return g;
            };
            Func<Transform, bool> wanted = t => t.gameObject.scene.IsValid()
                && (sceneName == null || t.gameObject.scene.name.IndexOf(sceneName, StringComparison.OrdinalIgnoreCase) >= 0)
                && (prefix == null || PathOf(t).StartsWith(prefix, StringComparison.OrdinalIgnoreCase));
            // The LOD level a renderer is first drawn at; a renderer in no LODGroup counts as level 0.
            var lodOf = new Dictionary<Renderer, int>();
            foreach (var l in Resources.FindObjectsOfTypeAll<LODGroup>())
            {
                if (!l || !wanted(l.transform)) continue;
                var lods = l.GetLODs();
                for (int i = 0; i < lods.Length; i++)
                    foreach (var lr in lods[i].renderers ?? new Renderer[0])
                    {
                        int was;
                        if (lr && (!lodOf.TryGetValue(lr, out was) || i < was)) lodOf[lr] = i;
                    }
            }
            long total = 0, totalActive = 0;
            foreach (var r in Resources.FindObjectsOfTypeAll<Renderer>())
            {
                if (!r || !wanted(r.transform)) continue;
                Mesh mesh = null;
                var skinned = r as SkinnedMeshRenderer;
                if (skinned) mesh = skinned.sharedMesh;
                else if (r is MeshRenderer) { var f = r.GetComponent<MeshFilter>(); if (f) mesh = f.sharedMesh; }
                else continue;   // particle systems, lines, trails: no mesh to count
                var g = groupOf(r.transform);
                bool on = r.enabled && r.gameObject.activeInHierarchy;
                // A statically batched renderer's sharedMesh is the whole combined mesh (Unity 2018.2 does not expose which
                // submeshes are the renderer's own): count each combined mesh once per group. Counting it per renderer
                // gave 182 M triangles for 95 cars that hold 2 M (2026-10-13).
                long tris = !mesh || (r.isPartOfStaticBatch && g.meshes.Contains(mesh)) ? 0 : Triangles(mesh);
                g.renderers++; g.triangles += tris; total += tris;
                int lod;
                if (on) { g.active++; g.activeTriangles += tris; totalActive += tris; if (!lodOf.TryGetValue(r, out lod) || lod == 0) g.lod0Triangles += tris; }
                if (on && r.isPartOfStaticBatch) g.batched++;
                if (skinned) g.skinned++;
                if (on && r.shadowCastingMode != UnityEngine.Rendering.ShadowCastingMode.Off) g.shadowCasters++;
                if (mesh) g.meshes.Add(mesh);
                foreach (var m in r.sharedMaterials)
                {
                    if (!m) continue;
                    g.materials.Add(m);
                    var shader = m.shader ? m.shader.name : "(none)";
                    int n; g.shaders.TryGetValue(shader, out n); g.shaders[shader] = n + 1;
                }
            }
            foreach (var l in Resources.FindObjectsOfTypeAll<LODGroup>()) if (l && wanted(l.transform)) groupOf(l.transform).lodGroups++;
            var rows = groups.OrderByDescending(kv => kv.Value.triangles).Take(limit).Select(kv => (object)new Dictionary<string, object>
            {
                { "group", kv.Key }, { "renderers", kv.Value.renderers }, { "active", kv.Value.active },
                { "triangles", kv.Value.triangles }, { "activeTriangles", kv.Value.activeTriangles }, { "lod0Triangles", kv.Value.lod0Triangles },
                { "units", kv.Value.units.Count }, { "batched", kv.Value.batched },
                { "meshes", kv.Value.meshes.Count }, { "materials", kv.Value.materials.Count },
                { "shadowCasters", kv.Value.shadowCasters }, { "lodGroups", kv.Value.lodGroups }, { "skinned", kv.Value.skinned },
                { "shaders", string.Join("; ", kv.Value.shaders.OrderByDescending(s => s.Value).Take(3).Select(s => s.Key + " x" + s.Value).ToArray()) },
            }).ToList();
            return new Dictionary<string, object> { { "groups", groups.Count }, { "triangles", total }, { "activeTriangles", totalActive }, { "shown", rows } };
        }

        // What scene.hide switched off, to put back: the component and the value it had.
        static readonly Dictionary<UnityEngine.Object, bool> hidden = new Dictionary<UnityEngine.Object, bool>();
        static readonly Dictionary<Renderer, UnityEngine.Rendering.ShadowCastingMode> unshadowed = new Dictionary<Renderer, UnityEngine.Rendering.ShadowCastingMode>();

        [BridgeCommand("scene.hide", "Switch off, for measuring, the renderers under a hierarchy path (path = the start of the object's path, as scene.geometry prints it after the scene name), or of one group of scene.geometry's groups (groups=[{id, match}] with group=<id>, other:<root> included), or with component=<part of a type name> every enabled component of that type instead (e.g. GrassRenderer: Stix 3D grass). shadows=false only stops the picked renderers casting shadows. restore=true puts back everything scene.hide changed. Nothing is saved.",
            args = "path, groups + group, component, shadows=false, restore=true")]
        static object Hide(BridgeArgs a)
        {
            if (a.Bool("restore", false))
            {
                int back = 0;
                foreach (var kv in hidden)
                {
                    if (!kv.Key) continue;
                    var r = kv.Key as Renderer; var b = kv.Key as Behaviour;
                    if (r) r.enabled = kv.Value; else if (b) b.enabled = kv.Value;
                    back++;
                }
                foreach (var kv in unshadowed) if (kv.Key) { kv.Key.shadowCastingMode = kv.Value; back++; }
                hidden.Clear(); unshadowed.Clear();
                return new Dictionary<string, object> { { "restored", back } };
            }
            string prefix = a.String("path"), component = a.String("component");
            var rules = Rules(a);
            string group = a.String("group");
            if ((group == null) != (rules == null)) throw new BridgeError("Give groups and group together.");
            if (prefix == null && component == null && group == null) throw new BridgeError("Give path, groups + group and/or component (or restore=true).");
            bool shadowsOnly = a.Has("shadows") && !a.Bool("shadows", true);
            int changed = 0, unitDepth;
            Func<Transform, bool> wanted = t => t.gameObject.scene.IsValid() && (prefix == null || PathOf(t).StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
                && (group == null || GroupOf(rules, PathOf(t), out unitDepth) == group);
            if (component == null)
            {
                foreach (var r in Resources.FindObjectsOfTypeAll<Renderer>())
                {
                    if (!r || !wanted(r.transform)) continue;
                    if (shadowsOnly)
                    {
                        if (r.shadowCastingMode == UnityEngine.Rendering.ShadowCastingMode.Off) continue;
                        if (!unshadowed.ContainsKey(r)) unshadowed[r] = r.shadowCastingMode;
                        r.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off; changed++;
                    }
                    else if (r.enabled) { if (!hidden.ContainsKey(r)) hidden[r] = true; r.enabled = false; changed++; }
                }
            }
            else
            {
                foreach (var b in Resources.FindObjectsOfTypeAll<Behaviour>())
                {
                    if (!b || !b.enabled || !wanted(b.transform)) continue;
                    if (b.GetType().FullName.IndexOf(component, StringComparison.OrdinalIgnoreCase) < 0) continue;
                    if (!hidden.ContainsKey(b)) hidden[b] = true;
                    b.enabled = false; changed++;
                }
            }
            return new Dictionary<string, object> { { "changed", changed }, { "pendingRestore", hidden.Count + unshadowed.Count } };
        }
    }
}
