// Vegetation palette editor, session: one working copy of the course's palettes shared by the
// window and the bridge commands (an agent's "make the creek palettes 10% darker" shows up in
// an open window, and the other way round). Edits are undoable (Unity Undo on the working
// copy; the scene follows on undo), pushed live (GolfMapVegLive) and written to the files only
// on Save. The working copy survives script reloads; unsaved edits are kept until Save/Revert.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using GolfMap.Bridge;
using UnityEditor;
using UnityEngine;

namespace GolfMap.Editor
{
    public static class GolfMapVegSession
    {
        // File metadata rides on the saved-values object: it survives script reloads and does
        // not move with Undo.
        static GolfMapVegState current, saved;
        static GolfMapBiome biome;
        public static event Action Changed;

        public static GolfMapVegState Current { get { Ensure(); return current; } }
        public static GolfMapVegState Saved { get { Ensure(); return saved; } }
        public static List<string> Notes { get { Ensure(); return saved.notes; } }
        public static string LastResult = "";

        static void Ensure()
        {
            if (current && saved) return;
            foreach (var s in Resources.FindObjectsOfTypeAll<GolfMapVegState>())
            {
                if (s.name == "GolfMapVeg current") current = s;
                else if (s.name == "GolfMapVeg saved") saved = s;
            }
            if (current && saved && saved.coursePath == CoursePath()) { GolfMapVegPalette.DescribeRoles(current.entries); GolfMapVegLive.Assume(current.entries); return; }
            Load();
        }

        static string CoursePath() { var c = GolfMapCourses.Active(); return c ? AssetDatabase.GetAssetPath(c) : ""; }
        public static GolfMapCourse Course() { var c = AssetDatabase.LoadAssetAtPath<GolfMapCourse>(Saved.coursePath); return c ? c : GolfMapCourses.Require(); }

        static GolfMapVegState Make(string name)
        {
            var s = ScriptableObject.CreateInstance<GolfMapVegState>();
            s.name = name; s.hideFlags = HideFlags.HideAndDontSave;
            return s;
        }

        // Reads both files. Unsaved edits are dropped: callers ask first.
        public static void Load()
        {
            if (!current) current = Make("GolfMapVeg current");
            if (!saved) saved = Make("GolfMapVeg saved");
            biome = null;
            var course = GolfMapCourses.Require();
            string previousCourse = saved.coursePath;
            var loaded = GolfMapVegPalette.Load(course);
            saved.coursePath = AssetDatabase.GetAssetPath(course);
            saved.grassPath = loaded.grassPath; saved.treePath = loaded.treePath;
            saved.grassStamp = Stamp(loaded.grassPath); saved.treeStamp = Stamp(loaded.treePath);
            saved.notes = loaded.notes;
            saved.entries = loaded.entries.Select(e => e.Copy()).ToList(); saved.Reindex();
            Undo.ClearUndo(current);
            current.entries = loaded.entries; current.Reindex();
            GolfMapVegLive.Invalidate();
            // First load: the scene is what the files were last applied as. A reload (a file
            // edited by hand or by an agent, Reload): the scene follows the files.
            if (GolfMapVegLive.ShowsAnything && previousCourse == saved.coursePath) GolfMapVegLive.Push(course, current, current.entries, false);
            else { GolfMapVegLive.Forget(); GolfMapVegLive.Assume(current.entries); }
            Raise();
        }

        static long Stamp(string path) { return path != null && File.Exists(path) ? File.GetLastWriteTimeUtc(path).Ticks : 0; }

        // Follow the files when they changed on disk and nothing is pending here (the window does
        // this on its own; bridge commands call it first).
        public static void Fresh() { if (DiskChanged && DirtyEntries().Count == 0) Load(); }

        // A file changed on disk since it was loaded or saved here.
        public static bool DiskChanged { get { Ensure(); return Stamp(saved.grassPath) != saved.grassStamp || Stamp(saved.treePath) != saved.treeStamp; } }

        public static GolfMapBiome Biome()
        {
            Ensure();
            if (biome == null && File.Exists(saved.treePath)) { try { biome = GolfMapPalette.Load(saved.treePath); } catch (Exception) { biome = null; } }
            return biome;
        }

        static void Raise() { if (Changed != null) Changed(); }

        public static bool IsDirty(GolfMapVegEntry e) { return GolfMapVegPalette.Dirty(e, Saved.Get(e.key)); }
        public static List<GolfMapVegEntry> DirtyEntries() { return Current.entries.Where(IsDirty).ToList(); }

        // ---- editing ---------------------------------------------------------------------

        public static void Record(string what) { Undo.RecordObject(Current, what); }

        // Push to the scene; `dragging` holds respawns back while a slider moves.
        public static GolfMapVegLive.Result Push(IEnumerable<GolfMapVegEntry> entries, bool dragging)
        {
            var result = GolfMapVegLive.Push(Course(), Current, entries, dragging);
            LastResult = result.Summary();
            Raise();
            return result;
        }

        public static GolfMapVegLive.Result PushAll() { return Push(Current.entries, false); }

        // Absolute value for a role on every selected entry that has it (part/slot narrow it).
        public static void Set(IEnumerable<GolfMapVegEntry> entries, string role, string part, string slot, float? f, Color? c)
        {
            foreach (var e in entries)
            {
                if (e.readOnly) continue;
                foreach (var v in e.values)
                {
                    if (v.role != role || (part != null && v.part != part) || (slot != null && v.slot != slot)) continue;
                    if (c.HasValue && v.colour) v.c = GolfMapVegPalette.Quantise(e, c.Value);
                    if (f.HasValue && !v.colour) v.f = v.toggle ? (f.Value > 0.5f ? 1 : 0) : GolfMapVegPalette.Round(f.Value, GolfMapVegPalette.Role(role).decimals + 1);
                }
            }
        }

        // Copy one entry's settings onto others, by section (role -> every value of that role/part).
        public static void Paste(GolfMapVegEntry from, IEnumerable<GolfMapVegEntry> to, HashSet<string> sections)
        {
            foreach (var e in to)
            {
                if (e.readOnly || e.key == from.key) continue;
                foreach (var v in e.values)
                {
                    var role = GolfMapVegPalette.Role(v.role);
                    if (!sections.Contains(role.section) || v.role == "maxDensity" || v.role == "weight") continue;
                    var src = from.values.FirstOrDefault(s => s.role == v.role && s.part == v.part) ?? from.values.FirstOrDefault(s => s.role == v.role);
                    if (src == null) continue;
                    if (v.colour && src.colour) v.c = GolfMapVegPalette.Quantise(e, src.c);
                    else if (!v.colour && !src.colour) v.f = src.f;
                }
            }
        }

        // ---- save / revert -------------------------------------------------------------

        public static string Save()
        {
            Ensure();
            GolfMapVegLive.Unsolo();
            var course = Course();
            var dirty = DirtyEntries();
            var notes = new List<string>();
            if (dirty.Any(e => e.kind != GolfMapVegKind.Tree) && File.Exists(saved.grassPath))
            {
                var text = File.ReadAllText(saved.grassPath);
                var updated = GolfMapVegPalette.GrassText(text, current, saved);
                if (updated != text)
                {
                    File.WriteAllText(saved.grassPath, updated);
                    if (GolfMapCourses.Owns(saved.grassPath)) AssetDatabase.ImportAsset(saved.grassPath);
                    notes.Add("grass-palette.json");
                }
            }
            var trees = dirty.Where(e => e.kind == GolfMapVegKind.Tree).ToList();
            if (trees.Count > 0)
            {
                GolfMapJsonObject doc;
                var fresh = GolfMapPalette.Load(saved.treePath, out doc);
                foreach (var e in trees)
                {
                    var group = fresh.Species(e.species);
                    var look = group == null ? null : group.looks.FirstOrDefault(l => l.id == e.look);
                    if (look == null) continue;
                    var weight = e.values.FirstOrDefault(v => v.role == "weight");
                    if (weight != null) look.weight = Math.Round(weight.f, 3);
                    GolfMapLooks.Capture(course, fresh, e.species, look);
                }
                AssetDatabase.SaveAssets();
                GolfMapPalette.Save(saved.treePath, fresh, doc);
                if (GolfMapCourses.Owns(saved.treePath)) AssetDatabase.ImportAsset(saved.treePath);
                biome = null;
                notes.Add("palette.json (" + trees.Count + " look(s))");
            }
            // VSP packages were changed live; make sure they are written too.
            AssetDatabase.SaveAssets();
            foreach (var e in dirty) { var s = saved.Get(e.key); if (s != null) saved.entries[saved.entries.IndexOf(s)] = e.Copy(); }
            saved.Reindex();
            saved.grassStamp = Stamp(saved.grassPath); saved.treeStamp = Stamp(saved.treePath);
            LastResult = notes.Count == 0 ? "Nothing to save." : "Saved " + string.Join(" and ", notes.ToArray()) + ".";
            Raise();
            return LastResult;
        }

        public static void Revert(IEnumerable<GolfMapVegEntry> only = null)
        {
            Ensure();
            Record("Revert vegetation palette");
            var keys = only == null ? null : new HashSet<string>(only.Select(e => e.key));
            for (int i = 0; i < current.entries.Count; i++)
            {
                var e = current.entries[i];
                if (keys != null && !keys.Contains(e.key)) continue;
                var s = saved.Get(e.key);
                if (s != null) current.entries[i] = s.Copy();
            }
            current.Reindex();
            PushAll();
        }

        // Show the saved values in the scene (before) or the working ones (after).
        public static void ShowSaved(bool before)
        {
            var dirty = DirtyEntries();
            if (before) GolfMapVegLive.Push(Course(), Saved, dirty.Select(e => saved.Get(e.key)).Where(e => e != null), false);
            else GolfMapVegLive.Push(Course(), Current, dirty, false);
        }

        // ---- tree looks: structure (saved to palette.json at once) ----------------------------

        // Looks need material and prefab copies; the first look for a species keeps the source
        // prefabs as "original" (weight 0: every stem takes the new look at the next Plant).
        public static string CreateLook(string species, string id, GolfMapVegEntry from)
        {
            Ensure();
            SaveTreesIfDirty();
            var course = Course();
            GolfMapJsonObject doc;
            var fresh = GolfMapPalette.Load(saved.treePath, out doc);
            var group = fresh.Species(species);
            if (group == null) { group = new GolfMapBiomeSpecies { name = species }; fresh.species.Add(group); }
            if (group.looks.Count == 0) group.looks.Add(new GolfMapBiomeLook { id = "original", weight = 0, original = true });
            id = UniqueLookId(group, id);
            var source = from == null ? null : group.looks.FirstOrDefault(l => l.id == from.look);
            var look = new GolfMapBiomeLook { id = id, weight = source != null && !source.original ? source.weight : 1, shapes = source != null && source.shapes != null ? new List<string>(source.shapes) : null };
            string made = GolfMapLooks.Generate(course, fresh, species, look, source);
            // The asset copies leave `course` a stale reference with no asset path (see GolfMapGrass.Apply).
            course = Course();
            GolfMapLooks.Capture(course, fresh, species, look);
            group.looks.Add(look);
            GolfMapPalette.Save(saved.treePath, fresh, doc);
            if (GolfMapCourses.Owns(saved.treePath)) AssetDatabase.ImportAsset(saved.treePath);
            ReloadSpecies(species);
            LastResult = species + " look '" + id + "': " + made + ". Tune it now (the Lab shows it at once); planted trees take it at the next Plant.";
            return id;
        }

        public static string RemoveLook(GolfMapVegEntry e)
        {
            Ensure();
            SaveTreesIfDirty();
            GolfMapJsonObject doc;
            var fresh = GolfMapPalette.Load(saved.treePath, out doc);
            var group = fresh.Species(e.species);
            if (group == null || group.looks.Count <= 1) return LastResult = "A species keeps at least one look.";
            group.looks.RemoveAll(l => l.id == e.look);
            // Only the source left: the species plants as it did before it had looks.
            if (group.looks.All(l => l.original)) fresh.species.Remove(group);
            GolfMapPalette.Save(saved.treePath, fresh, doc);
            if (GolfMapCourses.Owns(saved.treePath)) AssetDatabase.ImportAsset(saved.treePath);
            ReloadSpecies(e.species);
            return LastResult = e.species + " look '" + e.look + "' removed from the palette. Its folder stays: planted trees use it until the next Plant.";
        }

        // Missing copies, then the values palette.json records (how a palette rebuilds its looks
        // in another project). Pending edits are saved first so the record is what you see.
        public static string RegenerateLook(GolfMapVegEntry e)
        {
            SaveTreesIfDirty();
            var fresh = GolfMapPalette.Load(Saved.treePath);
            var group = fresh.Species(e.species);
            var look = group == null ? null : group.looks.FirstOrDefault(l => l.id == e.look);
            if (look == null || look.original) return LastResult = "Nothing to regenerate.";
            string made = GolfMapLooks.Generate(Course(), fresh, e.species, look, null);
            var problems = GolfMapLooks.Apply(Course(), fresh, e.species, look);
            ReloadSpecies(e.species);
            return LastResult = "Look '" + e.look + "': " + made + (problems.Count > 0 ? "\n" + string.Join("\n", problems.ToArray()) : "");
        }

        static string UniqueLookId(GolfMapBiomeSpecies group, string id)
        {
            id = string.IsNullOrEmpty(id) ? "tuned" : Regex.Replace(id.Trim(), "[^A-Za-z0-9_ -]", "_");
            string candidate = id; int n = 2;
            while (group.looks.Any(l => l.id == candidate)) candidate = id + "-" + n++;
            return candidate;
        }

        static void SaveTreesIfDirty()
        {
            if (DirtyEntries().Any(x => x.kind == GolfMapVegKind.Tree)) Save();
        }

        // Replace one species' entries in both copies from the files, leaving other edits alone.
        static void ReloadSpecies(string species)
        {
            biome = null;
            var fresh = Biome();
            var course = Course();
            var group = fresh.Species(species);
            var looks = group == null || group.looks.Count == 0 ? new List<GolfMapBiomeLook> { new GolfMapBiomeLook { id = "original", weight = 1, original = true } } : group.looks;
            var entries = new List<GolfMapVegEntry>();
            foreach (var look in looks)
            {
                try { entries.Add(GolfMapVegPalette.TreeEntry(course, fresh, species, look, group == null || group.looks.Count == 0)); }
                catch (Exception ex) { saved.notes.Add("Trees '" + species + "/" + look.id + "': " + ex.Message); }
            }
            foreach (var state in new[] { current, saved })
            {
                int at = state.entries.FindIndex(x => x.kind == GolfMapVegKind.Tree && x.species == species);
                state.entries.RemoveAll(x => x.kind == GolfMapVegKind.Tree && x.species == species);
                if (at < 0) at = state.entries.Count;
                state.entries.InsertRange(Math.Min(at, state.entries.Count), entries.Select(x => x.Copy()));
                state.Reindex();
            }
            saved.treeStamp = Stamp(saved.treePath);
            GolfMapVegLive.Invalidate();
            GolfMapVegLive.Assume(entries);
            Undo.ClearUndo(current);
            Raise();
        }

        // ---- selecting by pattern (bridge) -------------------------------------------------

        // "rough_tall" / "creek_bank/*" (palettes: their items), an item name or glob,
        // "tree:birch", "tree:birch/darker", "trees", "grass", "all".
        public static List<GolfMapVegEntry> Select(string patterns)
        {
            var result = new List<GolfMapVegEntry>();
            foreach (var raw in (patterns ?? "").Split(new[] { ',', ';' }, StringSplitOptions.RemoveEmptyEntries))
            {
                var p = raw.Trim();
                IEnumerable<GolfMapVegEntry> hit;
                if (p == "all") hit = Current.entries.Where(e => e.kind != GolfMapVegKind.Palette);
                else if (p == "trees") hit = Current.entries.Where(e => e.kind == GolfMapVegKind.Tree && !e.readOnly);
                else if (p == "grass") hit = Current.entries.Where(e => e.kind == GolfMapVegKind.Grass || e.kind == GolfMapVegKind.Bush);
                else if (p.StartsWith("tree:", StringComparison.Ordinal))
                {
                    var rx = Glob(p.Substring(5));
                    hit = Current.entries.Where(e => e.kind == GolfMapVegKind.Tree && (rx.IsMatch(e.species) || rx.IsMatch(e.species + "/" + e.look)));
                }
                else
                {
                    var rx = Glob(p);
                    var palettes = Current.entries.Where(e => e.kind == GolfMapVegKind.Palette && rx.IsMatch(e.name)).ToList();
                    hit = palettes.Count > 0
                        ? palettes.Concat(palettes.SelectMany(pe => pe.members.Select(k => Current.Get(k)).Where(x => x != null)))
                        : Current.entries.Where(e => (e.kind == GolfMapVegKind.Grass || e.kind == GolfMapVegKind.Bush) && rx.IsMatch(e.name));
                }
                foreach (var e in hit) if (!result.Contains(e)) result.Add(e);
            }
            return result;
        }

        static Regex Glob(string pattern) { return new Regex("^" + Regex.Escape(pattern).Replace("\\*", ".*").Replace("\\?", ".") + "$", RegexOptions.IgnoreCase); }

        // ---- bridge ----------------------------------------------------------------------------

        static object Describe(GolfMapVegEntry e)
        {
            var d = new Dictionary<string, object> { { "key", e.key }, { "name", e.name }, { "kind", e.kind.ToString().ToLowerInvariant() }, { "palettes", e.palettes.Cast<object>().ToList() } };
            if (e.readOnly) d["readOnly"] = e.readOnlyWhy;
            if (IsDirty(e)) d["unsaved"] = true;
            if (!GolfMapVegLive.InScene(e)) d["inScene"] = false;
            var differs = GolfMapVegLive.SceneDiffers(e);
            if (differs.Count > 0) d["vspDiffers"] = differs.Distinct().Cast<object>().ToList();
            var values = new Dictionary<string, object>();
            foreach (var g in e.values.GroupBy(v => v.part == "" || v.part == null ? v.role : v.part + ":" + v.role))
            {
                var v = g.First();
                if (v.role == "maxDensity") { values["maxDensity"] = g.ToDictionary(x => x.slot, x => (object)Math.Round(x.f, 3)); continue; }
                if (GolfMapVegPalette.IsMaterial(v.role) && !GolfMapVegPalette.CuratedMaterial.Contains(v.prop)) continue;
                values[g.Key] = v.colour ? (object)string.Join(" ", g.Select(x => GolfMapVegPalette.Hex(x.c)).Distinct().ToArray()) : Math.Round(v.f, 4);
            }
            d["values"] = values;
            return d;
        }

        [BridgeCommand("golfmap.vegpalette.list", "The vegetation palette editor's view of the course's palettes (grass-palette.json + palette.json tree looks) as one list: entries with their shared-role values (healthy/dry/bark tints, width, height, spacing, ...), which palettes list them, unsaved edits, whether VSP has the item.",
            args = "select (patterns: palette key or glob like creek_bank/*, item name or glob, tree:<species>[/<look>], trees, grass, all; default all), reload=false (drop unsaved edits and read the files)")]
        static object ListCommand(BridgeArgs a)
        {
            if (a.Bool("reload", false)) Load(); else Fresh();
            var entries = Select(a.String("select", "all"));
            return new Dictionary<string, object>
            {
                { "grassPalette", Saved.grassPath }, { "treePalette", Saved.treePath }, { "notes", Notes.Cast<object>().ToList() },
                { "unsaved", DirtyEntries().Count }, { "entries", entries.Select(Describe).ToList() },
            };
        }

        [BridgeCommand("golfmap.vegpalette.adjust", "Grade/scale a selection of palette entries together, live in the scene (the editor window's 'Adjust together'): colours in linear light, sizes and density relative. Undoable in Unity; nothing is written until save=true or the window's Save.",
            args = "select (see golfmap.vegpalette.list), brightness (-0.1 = 10% darker), saturation, hue (degrees), warmth (-1..1), height, width (+0.2 = 20% larger), density (+1 = twice as many), spread (min..max scale range), colours=healthy,dry (add bark for trees), set ({role: value}; colours as #rrggbb; role like 'healthy', 'height', 'mat:_SmoothnessPower', 'leaves:mat:_SmoothnessPower'), save=false")]
        static object AdjustCommand(BridgeArgs a)
        {
            Fresh();
            var entries = Select(a.Require("select")).Where(e => !e.readOnly).ToList();
            if (entries.Count == 0) throw new BridgeError("Nothing matches '" + a.String("select") + "' (read-only tree looks are skipped: create a look first).");
            var colours = new HashSet<string>((a.String("colours", "healthy,dry")).Split(',').Select(s => s.Trim()));
            var adjust = new GolfMapVegAdjust
            {
                brightness = (float)a.Number("brightness", 0), saturation = (float)a.Number("saturation", 0), hue = (float)a.Number("hue", 0), warmth = (float)a.Number("warmth", 0),
                height = (float)a.Number("height", 0), width = (float)a.Number("width", 0), density = (float)a.Number("density", 0), spread = (float)a.Number("spread", 0),
                healthy = colours.Contains("healthy"), dry = colours.Contains("dry"), bark = colours.Contains("bark"),
            };
            Record("Adjust vegetation palette");
            var before = entries.Select(e => e.Copy()).ToList();
            if (!adjust.IsZero) for (int i = 0; i < entries.Count; i++) GolfMapVegPalette.Adjust(before[i], entries[i], adjust);
            var set = a.Raw("set") as Dictionary<string, object>;
            if (set != null)
                foreach (var kv in set)
                {
                    string role = kv.Key, part = null;
                    int colon = role.IndexOf(':');
                    if (colon > 0 && !role.StartsWith("mat:", StringComparison.Ordinal)) { part = role.Substring(0, colon); role = role.Substring(colon + 1); }
                    var text = kv.Value as string;
                    if (text != null) { Color c; if (!ColorUtility.TryParseHtmlString(text, out c)) throw new BridgeError("Not a colour: " + text); Set(entries, role, part, null, null, c); }
                    else Set(entries, role, part, null, (float)Convert.ToDouble(kv.Value), null);
                }
            var pushed = Push(entries, false);
            string saveNote = a.Bool("save", false) ? Save() : "Not saved (save=true or the window's Save).";
            return new Dictionary<string, object>
            {
                { "changed", entries.Select((e, i) => new KeyValuePair<string, object>(e.key, Changes(before[i], e))).Where(kv => ((Dictionary<string, object>)kv.Value).Count > 0).ToDictionary(kv => kv.Key, kv => kv.Value) },
                { "live", pushed.Summary() }, { "save", saveNote },
            };
        }

        // "role" (or "part:role", "maxDensity@palette") -> "old -> new", for the values that moved.
        static Dictionary<string, object> Changes(GolfMapVegEntry before, GolfMapVegEntry after)
        {
            var changes = new Dictionary<string, object>();
            foreach (var v in after.values)
            {
                var b = before.Find(v);
                if (b == null || b.Same(v)) continue;
                string key = (string.IsNullOrEmpty(v.part) ? "" : v.part + ":") + v.role + (v.role == "maxDensity" ? "@" + v.slot : "");
                if (changes.ContainsKey(key)) continue;
                changes[key] = v.colour ? GolfMapVegPalette.Hex(b.c) + " -> " + GolfMapVegPalette.Hex(v.c) : Math.Round(b.f, 4) + " -> " + Math.Round(v.f, 4);
            }
            return changes;
        }

        [BridgeCommand("golfmap.vegpalette.look", "Tree looks (saved to palette.json at once): create = a tunable copy of a species' materials and prefabs (first look: the source stays as 'original' at weight 0, so the next Plant uses the copy), duplicate = a new look from an existing one, remove, regenerate (missing copies), lab = stand the looks at the Scene view pivot.",
            args = "action=create|duplicate|remove|regenerate|lab, species, look (existing look for duplicate/remove/regenerate), name (new look id; default 'tuned'), clear=false (lab: take the Lab trees away)")]
        static object LookCommand(BridgeArgs a)
        {
            Fresh();
            string action = a.Require("action"), species = a.Require("species");
            var entry = Current.Get("t:" + species + "/" + a.String("look", ""));
            switch (action)
            {
                case "create": return "t:" + species + "/" + CreateLook(species, a.String("name", "tuned"), null) + ": " + LastResult;
                case "duplicate":
                    if (entry == null) throw new BridgeError("No look '" + a.String("look") + "' for " + species + ".");
                    return "t:" + species + "/" + CreateLook(species, a.Require("name"), entry) + ": " + LastResult;
                case "remove": if (entry == null) throw new BridgeError("No such look."); return RemoveLook(entry);
                case "regenerate": if (entry == null) throw new BridgeError("No such look."); return RegenerateLook(entry);
                case "lab":
                    if (a.Bool("clear", false)) { GolfMapVegLive.ClearLab(); return "Lab cleared."; }
                    return GolfMapVegLive.BuildLab(Course(), Current.entries.Where(e => e.kind == GolfMapVegKind.Tree && e.species == species).ToList());
            }
            throw new BridgeError("action must be create, duplicate, remove, regenerate or lab.");
        }

        [BridgeCommand("golfmap.vegpalette.save", "Write the vegetation palette editor's unsaved edits to grass-palette.json / palette.json (tree looks: material values captured).")]
        static object SaveCommand() { return Save(); }

        [BridgeCommand("golfmap.vegpalette.revert", "Drop the vegetation palette editor's unsaved edits and put the saved values back into the scene.", args = "select (default all)")]
        static object RevertCommand(BridgeArgs a)
        {
            var only = a.Has("select") ? Select(a.String("select")) : null;
            int n = (only ?? DirtyEntries()).Count(IsDirty);
            Revert(only);
            return "Reverted " + n + " entr" + (n == 1 ? "y" : "ies") + ".";
        }

        [BridgeCommand("golfmap.vegpalette.spots", "Where a selection grows: spread-out world positions, densest first (grass: the imported zone masks; trees: planted instances). goto=<index> frames the Scene view there.",
            args = "select, goto (index), distance=18 (m from the spot)")]
        static object SpotsCommand(BridgeArgs a)
        {
            Fresh();
            var entries = Select(a.Require("select"));
            string problem;
            var spots = Spots(entries, out problem);
            if (a.Has("goto") && spots.Count > 0) GolfMapVegLive.Frame(spots[Mathf.Clamp(a.Int("goto", 0), 0, spots.Count - 1)], (float)a.Number("distance", 18));
            return new Dictionary<string, object> { { "spots", spots.Select(p => (object)new List<object> { Math.Round(p.x, 1), Math.Round(p.y, 1), Math.Round(p.z, 1) }).ToList() }, { "problem", problem } };
        }

        public static List<Vector3> Spots(List<GolfMapVegEntry> entries, out string problem)
        {
            var course = Course();
            var grass = entries.Where(e => e.kind == GolfMapVegKind.Grass || e.kind == GolfMapVegKind.Bush).Select(e => e.name)
                .Concat(entries.Where(e => e.kind == GolfMapVegKind.Palette).SelectMany(pe => pe.members.Select(k => Current.Get(k)).Where(x => x != null).Select(x => x.name))).Distinct().ToList();
            if (grass.Count > 0) return GolfMapVegLive.GrassSpots(course, grass, out problem);
            var trees = entries.Where(e => e.kind == GolfMapVegKind.Tree).ToList();
            if (trees.Count > 0) return GolfMapVegLive.TreeSpots(course, trees, out problem);
            problem = "Select something first.";
            return new List<Vector3>();
        }

        [BridgeCommand("golfmap.vegpalette.rebuild", "Save, then build the lower-vegetation palette into VSP (golfmap.grass.apply) - for changes a live push cannot show: texture white point, a bush's first material overrides, new items. Runs the zones import and applies again when apply replaced or added items (what Plant vegetation does).")]
        static object RebuildCommand() { return Rebuild(); }

        public static string Rebuild()
        {
            if (DirtyEntries().Count > 0) Save();
            GolfMapVegLive.Unsolo();
            var log = new List<string>();
            var first = BridgeCommands.Invoke("golfmap.grass.apply", new BridgeArgs(new Dictionary<string, object>())) as Dictionary<string, object>;
            var lines = first != null && first["log"] is List<string> ? (List<string>)first["log"] : new List<string>();
            log.AddRange(lines);
            if (lines.Any(l => l.StartsWith("added item", StringComparison.Ordinal) || l.StartsWith("replaced item", StringComparison.Ordinal)))
            {
                try
                {
                    BridgeCommands.Invoke("golfmap.zones.import", new BridgeArgs(new Dictionary<string, object> { { "terrain", "inner" } }));
                    log.Add("zones imported again (new/replaced items get their mask rules)");
                    BridgeCommands.Invoke("golfmap.grass.apply", new BridgeArgs(new Dictionary<string, object>()));
                    log.Add("applied again");
                }
                catch (Exception e) { log.Add("zones import: " + e.Message); }
            }
            GolfMapVegLive.Invalidate();
            GolfMapVegLive.Forget();
            GolfMapVegLive.Assume(Current.entries);
            LastResult = "Rebuilt VSP from the saved palette" + (log.Count > 0 ? ": " + string.Join("; ", log.Take(6).ToArray()) + (log.Count > 6 ? " ..." : "") : ".");
            Raise();
            return LastResult;
        }
    }
}
