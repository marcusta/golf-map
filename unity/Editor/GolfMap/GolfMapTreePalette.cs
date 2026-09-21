// Palette tab of the GolfMap Trees Inspector: edits the course's palette.json.
//
// The file stays the source of truth and is edited from both sides. The tab works
// on a draft (GolfMapPalette keeps every key it does not model), writes it back
// on Save, and reloads when the file changes on disk - silently while the draft
// is clean, with a prompt once it is not. The preview re-runs the matcher over
// the loaded survey with the draft, so a weight can be judged by the mix it
// actually produces before anything is planted: weights are preferences, and a
// species only wins a stem it fits.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEngine;

namespace GolfMap.Editor
{
    public partial class GolfMapTreePlanter
    {
        GolfMapBiome draft;
        GolfMapJsonObject draftDoc;
        string draftPath = "";
        DateTime draftStamp;
        bool draftDirty, diskChanged;
        string diskText = "", draftText = "";   // file as loaded/saved, and as the draft would write it
        string paletteNote = "";
        string newSpecies = "";
        [SerializeField] bool showRules, showAssets = true;
        [SerializeField] Vector2 assetScroll;

        // Preview of the draft against the loaded survey; "planted" is the last Load and check / Plant.
        bool previewStale = true;
        int previewTotal, previewChanged, previewUnmatched;
        readonly Dictionary<string, int> previewSpecies = new Dictionary<string, int>();
        readonly Dictionary<string, int> previewAssets = new Dictionary<string, int>();
        readonly Dictionary<string, int> plantedSpecies = new Dictionary<string, int>();
        readonly Dictionary<string, int> plantedAssets = new Dictionary<string, int>();
        string previewError;

        // Counting key: shrub-form stems race apart from trees, so they are tallied apart too.
        static string SpeciesLabel(GolfMapBiomeAsset a) { return a.form == "shrub" ? a.Label + " shrub" : a.Label; }

        void DrawPalette()
        {
            string path;
            try { path = BiomeFile; }
            catch (Exception e) { EditorGUILayout.HelpBox(e.Message, MessageType.Warning); return; }
            if (!File.Exists(path)) { EditorGUILayout.HelpBox("No palette at " + path + ".", MessageType.Warning); return; }
            SyncDraft(path);
            if (draft == null) { EditorGUILayout.HelpBox(paletteNote, MessageType.Error); return; }

            // Palette edits belong to the file: GUI.changed is cleared below so the planter's own
            // change check does not mark the scene dirty for them.
            EditorGUI.BeginChangeCheck();
            DrawPaletteHeader(path);
            EditorGUILayout.Space();
            DrawSpeciesMix();
            EditorGUILayout.Space();
            showRules = EditorGUILayout.Foldout(showRules, "Matching rules", true);
            if (showRules) DrawRules();
            EditorGUILayout.Space();
            showAssets = EditorGUILayout.Foldout(showAssets, "Assets (" + draft.assets.Count(a => a.enabled) + " of " + draft.assets.Count + " enabled)", true);
            if (showAssets) DrawAssets();
            // Buttons and foldouts raise GUI.changed too, so dirtiness is what the file would become.
            if (EditorGUI.EndChangeCheck())
            {
                var text = GolfMapPalette.Text(draft, draftDoc);
                if (text != draftText) { draftText = text; previewStale = true; }
                draftDirty = draftText != diskText;
            }
            GUI.changed = false;

            // Recount once the mouse is released, so a slider drag stays smooth.
            if (previewStale && loaded != null && Event.current.type == EventType.Repaint && GUIUtility.hotControl == 0)
            {
                UpdatePreview();
                Repaint();
            }
        }

        void SyncDraft(string path)
        {
            var stamp = File.GetLastWriteTimeUtc(path);
            if (draft != null && draftPath == path && stamp == draftStamp) return;
            if (draft != null && draftPath == path && draftDirty) { diskChanged = true; return; }
            bool reloaded = draft != null && draftPath == path;
            LoadDraft(path);
            if (reloaded && draft != null) paletteNote = "Reloaded: the file changed on disk.";
        }

        void LoadDraft(string path)
        {
            try
            {
                draft = GolfMapPalette.Load(path, out draftDoc);
                diskText = draftText = GolfMapPalette.Text(draft, draftDoc);
                paletteNote = "";
            }
            catch (Exception e) { draft = null; paletteNote = "Cannot read " + path + ": " + e.Message; }
            draftPath = path; draftStamp = File.GetLastWriteTimeUtc(path);
            draftDirty = false; diskChanged = false; previewStale = true;
        }

        void SaveDraft()
        {
            var problem = DraftProblem();
            if (problem != null) { paletteNote = "Not saved: " + problem; return; }
            GolfMapPalette.Save(draftPath, draft, draftDoc);
            diskText = draftText = GolfMapPalette.Text(draft, draftDoc);
            draftStamp = File.GetLastWriteTimeUtc(draftPath);
            draftDirty = false; diskChanged = false;
            if (GolfMapCourses.Owns(draftPath)) AssetDatabase.ImportAsset(draftPath);
            paletteNote = "Saved " + draftPath + ". Planted trees are unchanged until the next Plant.";
        }

        string DraftProblem()
        {
            var r = draft.rules;
            if (!(r.minScale > 0 && r.maxScale >= r.minScale)) return "scale limits need 0 < min <= max.";
            if (r.variationBand < 0 || r.speciesFitSlack < 0 || r.maxHeightError < 0 || r.maxWidthError < 0) return "bands, slack and tolerances cannot be negative.";
            if (r.speciesWeights != null && r.speciesWeights.species.Any(s => r.speciesWeights.Weight(s) < 0)) return "species weights cannot be negative.";
            if (string.IsNullOrEmpty(draft.seed)) return "the seed is empty.";
            if (!draft.assets.Any(a => a.enabled)) return "every asset is disabled.";
            return null;
        }

        void DrawPaletteHeader(string path)
        {
            EditorGUILayout.LabelField(path + (draftDirty ? "  *" : ""), EditorStyles.miniLabel);
            if (diskChanged)
            {
                EditorGUILayout.HelpBox("palette.json changed on disk while you have unsaved edits here.", MessageType.Warning);
                using (new EditorGUILayout.HorizontalScope())
                {
                    if (GUILayout.Button("Reload from disk (drop my edits)")) { LoadDraft(path); GUIUtility.ExitGUI(); }
                    if (GUILayout.Button("Keep mine (Save overwrites)")) { diskChanged = false; draftStamp = File.GetLastWriteTimeUtc(path); }
                }
            }
            using (new EditorGUILayout.HorizontalScope())
            {
                using (new EditorGUI.DisabledScope(!draftDirty))
                {
                    if (GUILayout.Button("Save")) SaveDraft();
                    if (GUILayout.Button("Revert")) { LoadDraft(path); GUIUtility.ExitGUI(); }
                }
                using (new EditorGUI.DisabledScope(draftDirty || loaded == null))
                    if (GUILayout.Button(new GUIContent("Re-check planting", "Load and check with the saved palette; Plant on the Planting tab applies it.")))
                    {
                        try { LoadFile(); if (loaded != null) { ValidateTarget(); status = AlignmentReport() + PrepareBiome() + EditsReport(); } }
                        catch (Exception e) { status = e.Message; }
                        previewStale = true;
                    }
            }
            if (!string.IsNullOrEmpty(paletteNote)) EditorGUILayout.HelpBox(paletteNote, MessageType.Info);
            if (loaded == null) EditorGUILayout.HelpBox("Run Load and check on the Planting tab to preview the mix this palette produces.", MessageType.Info);
            else if (previewError != null) EditorGUILayout.HelpBox("Preview stopped: " + previewError, MessageType.Warning);
            else if (!previewStale)
                EditorGUILayout.LabelField("Preview: " + previewTotal + " stems matched, " + previewUnmatched + " unmatched; " +
                    (biomeMatches.Count == 0 ? "nothing checked yet to compare with." : previewChanged + " would change asset against the last check."), EditorStyles.wordWrappedMiniLabel);

            using (new EditorGUILayout.HorizontalScope())
            {
                draft.seed = EditorGUILayout.DelayedTextField(new GUIContent("Seed", "Every random choice (species race, variant, rotation) hashes this with the stem ID. A new seed reshuffles every tree."), draft.seed);
                if (GUILayout.Button(new GUIContent("Reroll", "New seed: same rules, a different draw for every stem."), GUILayout.Width(60)))
                {
                    int dash = draft.seed.LastIndexOf('-'); int n;
                    draft.seed = dash > 0 && int.TryParse(draft.seed.Substring(dash + 1), out n) ? draft.seed.Substring(0, dash + 1) + (n + 1) : draft.seed + "-2";
                    GUI.changed = true;
                }
            }
        }

        // Weights race within a stem's kind, so shares are shown per kind.
        string KindOf(string species)
        {
            var asset = draft.assets.FirstOrDefault(x => x.Label == species);
            return asset == null ? "unused" : asset.kind;
        }

        void DrawSpeciesMix()
        {
            EditorGUILayout.LabelField("Species mix", EditorStyles.boldLabel);
            var weights = draft.rules.speciesWeights;
            if (weights == null)
            {
                EditorGUILayout.HelpBox("This palette has no species weights: every stem takes its best-fitting asset.", MessageType.None);
                if (GUILayout.Button("Add species weights"))
                {
                    weights = draft.rules.speciesWeights = new GolfMapSpeciesWeights();
                    foreach (var s in draft.assets.Where(x => x.kind == "broadleaf").Select(x => x.Label).Distinct()) weights.Set(s, 1);
                    GUI.changed = true;
                }
                return;
            }
            using (new EditorGUILayout.HorizontalScope())
            {
                GUILayout.Label("", GUILayout.Width(70));
                GUILayout.Label("weight", EditorStyles.miniLabel);
                GUILayout.Label(new GUIContent("target", "This weight's share within its kind."), EditorStyles.miniLabel, GUILayout.Width(44));
                GUILayout.Label(new GUIContent("preview", "Share and count the draft produces on the loaded survey. Below target means the species' assets fit too few stems."), EditorStyles.miniLabel, GUILayout.Width(92));
                GUILayout.Label(new GUIContent("checked", "Share at the last Load and check / Plant."), EditorStyles.miniLabel, GUILayout.Width(44));
                GUILayout.Label("", GUILayout.Width(22));
            }
            foreach (var kind in weights.species.GroupBy(s => KindOf(s)).OrderBy(g => g.Key, StringComparer.Ordinal))
            {
                var weighted = new HashSet<string>(kind.Where(s => weights.Weight(s) > 0));
                double sum = kind.Sum(s => weights.Weight(s));
                int previewPool = previewSpecies.Where(p => weighted.Contains(p.Key)).Sum(p => p.Value);
                int plantedPool = plantedSpecies.Where(p => weighted.Contains(p.Key)).Sum(p => p.Value);
                EditorGUILayout.LabelField(kind.Key, EditorStyles.miniBoldLabel);
                foreach (var species in kind.ToArray())
                {
                    int enabledAssets = draft.assets.Count(x => x.enabled && x.Label == species);
                    using (new EditorGUILayout.HorizontalScope())
                    {
                        GUILayout.Label(new GUIContent(species, enabledAssets + " enabled asset(s)"), GUILayout.Width(70));
                        double w = Math.Round(EditorGUILayout.Slider((float)weights.Weight(species), 0, 1), 3);
                        if (w != weights.Weight(species)) weights.Set(species, w);
                        GUILayout.Label(sum > 0 ? Percent(weights.Weight(species) / sum) : "-", GUILayout.Width(44));
                        int count; previewSpecies.TryGetValue(species, out count);
                        GUILayout.Label(previewStale || loaded == null ? "..." : Percent(previewPool > 0 ? (double)count / previewPool : 0) + "  " + count, GUILayout.Width(92));
                        int planted; plantedSpecies.TryGetValue(species, out planted);
                        GUILayout.Label(plantedPool > 0 ? Percent((double)planted / plantedPool) : "-", GUILayout.Width(44));
                        if (GUILayout.Button(new GUIContent("x", "Stop weighting this species. Its assets stay in the palette; with no weight it never wins a stem another weighted species fits."), EditorStyles.miniButton, GUILayout.Width(22)))
                        { weights.Remove(species); GUI.changed = true; }
                    }
                    if (enabledAssets == 0 && weights.Weight(species) > 0)
                        EditorGUILayout.LabelField("   no enabled asset carries '" + species + "', so it never plants.", EditorStyles.miniLabel);
                }
            }
            // Species in the palette that take no part in a race yet.
            var unweighted = draft.assets.Where(x => x.enabled).Select(x => x.Label).Distinct().Where(l => !weights.species.Contains(l)).OrderBy(l => l, StringComparer.Ordinal).ToList();
            if (unweighted.Count > 0)
                using (new EditorGUILayout.HorizontalScope())
                {
                    GUILayout.Label(new GUIContent("Unweighted", "These take their best fit only. Weight one to give it a share of its kind; once any species of a kind is weighted, weight them all."), GUILayout.Width(70));
                    foreach (var label in unweighted)
                        if (GUILayout.Button("+ " + label, EditorStyles.miniButton)) { weights.Set(label, 0.1); GUI.changed = true; }
                    GUILayout.FlexibleSpace();
                }
            using (new EditorGUILayout.HorizontalScope())
            {
                newSpecies = EditorGUILayout.TextField("New species", newSpecies).Trim().ToLowerInvariant();
                using (new EditorGUI.DisabledScope(newSpecies.Length == 0 || weights.species.Contains(newSpecies)))
                    if (GUILayout.Button("Add", GUILayout.Width(60))) { weights.Set(newSpecies, 0.1); newSpecies = ""; GUI.changed = true; GUI.FocusControl(null); }
            }
            EditorGUILayout.LabelField("Weights are relative within a kind. A species is only offered stems one of its assets fits within the species fit slack, so a tight fit can hold a share below its target. Assets without a species race under their kind. The number beside an asset shares its species' stems between the variants that fit (blank = 1).", EditorStyles.wordWrappedMiniLabel);
        }

        static string Percent(double share) { return (share * 100).ToString("0.#") + "%"; }

        static double Rule(string label, string tip, double value, double min, double max)
        {
            double v = EditorGUILayout.DoubleField(new GUIContent(label, tip), value);
            return Math.Round(Math.Max(min, Math.Min(max, v)), 4);
        }

        void DrawRules()
        {
            var r = draft.rules;
            EditorGUI.indentLevel++;
            r.minScale = Rule("Min scale", "Smallest uniform scale an asset may be planted at.", r.minScale, 0.01, 100);
            r.maxScale = Rule("Max scale", "Largest uniform scale an asset may be planted at.", r.maxScale, 0.01, 100);
            r.scalePenalty = Rule("Scale penalty", "Cost per log-unit of scaling: higher prefers assets close to their natural size.", r.scalePenalty, 0, 10);
            r.shrubMaxHeightM = Rule("Shrub max height (m)", "Stems at or below this height use shrub-form assets.", r.shrubMaxHeightM, 0, 100);
            r.variationBand = Rule("Variation band", "Assets scoring within this of the best fit share the stem by hash: wider means more variety, looser fits.", r.variationBand, 0, 10);
            r.speciesFitSlack = Rule("Species fit slack", "A species enters the weighted race for a stem when its best asset scores within this of the overall best. Raise it to let the weights win over fit.", r.speciesFitSlack, 0, 10);
            r.maxHeightError = Rule("Max height error", "Relative height error above which a match is flagged imperfect (0.25 = 25%).", r.maxHeightError, 0, 10);
            r.maxWidthError = Rule("Max width error", "Relative crown width error above which a match is flagged imperfect.", r.maxWidthError, 0, 10);
            EditorGUILayout.LabelField("Woodland (dense stands match as canopy)", EditorStyles.miniBoldLabel);
            r.woodlandRadiusM = Rule("Neighbour radius (m)", "A stem is woodland when enough others stand within this radius. 0 turns woodland matching off.", r.woodlandRadiusM, 0, 1000);
            r.woodlandMinNeighbours = Math.Max(0, EditorGUILayout.IntField(new GUIContent("Min neighbours", "Neighbours within the radius that make a stem woodland."), r.woodlandMinNeighbours));
            r.woodlandCrownMultiplier = Rule("Crown multiplier", "Lidar under-measures crowns in a closed canopy; woodland stems match against radius x this.", r.woodlandCrownMultiplier, 0, 10);
            r.woodlandWidthWeight = Rule("Width weight", "Weight of crown width against height for woodland stems (open-grown stems use 1).", r.woodlandWidthWeight, 0, 10);
            r.woodlandScaleBoost = Rule("Scale boost", "Extra scale applied to woodland matches, capped at max scale.", r.woodlandScaleBoost, 0, 10);
            r.woodlandSpeciesFitSlack = Rule("Species fit slack", "Species fit slack used for woodland stems (0: same as open-grown).", r.woodlandSpeciesFitSlack, 0, 10);
            EditorGUI.indentLevel--;
        }

        void DrawAssets()
        {
            assetScroll = EditorGUILayout.BeginScrollView(assetScroll, GUILayout.MaxHeight(360));
            foreach (var group in draft.assets.GroupBy(a => SpeciesLabel(a)).OrderBy(g => g.Key, StringComparer.Ordinal))
            {
                int groupCount; previewSpecies.TryGetValue(group.Key, out groupCount);
                EditorGUILayout.LabelField(group.Key + (previewStale || loaded == null ? "" : "  -  " + groupCount), EditorStyles.miniBoldLabel);
                foreach (var a in group)
                {
                    using (new EditorGUILayout.HorizontalScope())
                    {
                        a.enabled = EditorGUILayout.Toggle(a.enabled, GUILayout.Width(16));
                        if (GUILayout.Button(new GUIContent(a.name, a.path), EditorStyles.label, GUILayout.MinWidth(80)))
                            EditorGUIUtility.PingObject(AssetDatabase.LoadMainAssetAtPath(AssetDatabase.GUIDToAssetPath(a.guid)));
                        GUILayout.Label(new GUIContent(a.heightM.ToString("0.#") + " x " + a.crownWidthM.ToString("0.#"), "Natural height x crown width (m)"), EditorStyles.miniLabel, GUILayout.Width(62));
                        a.selectionWeight = Math.Round(Math.Max(0, EditorGUILayout.DoubleField(new GUIContent("", "Share of this species' stems among its variants that fit (0 = unset, counts as 1)."), a.selectionWeight, GUILayout.Width(40))), 3);
                        int count; previewAssets.TryGetValue(a.guid, out count);
                        int planted; plantedAssets.TryGetValue(a.guid, out planted);
                        GUILayout.Label(new GUIContent(previewStale || loaded == null ? "" : count + (planted != count && biomeMatches.Count > 0 ? " (" + planted + ")" : ""), "Stems in the preview (at the last check)"), EditorStyles.miniLabel, GUILayout.Width(84));
                    }
                }
            }
            EditorGUILayout.EndScrollView();
        }

        // Re-run the matcher over the survey with the draft in place of the saved palette.
        void UpdatePreview()
        {
            previewStale = false; previewError = null;
            previewSpecies.Clear(); previewAssets.Clear(); plantedSpecies.Clear(); plantedAssets.Clear();
            previewTotal = previewChanged = previewUnmatched = 0;
            foreach (var m in biomeMatches.Values) { Bump(plantedSpecies, SpeciesLabel(m.asset)); Bump(plantedAssets, m.asset.guid); }
            var saved = biome;
            try
            {
                if (DraftProblem() != null) throw new Exception(DraftProblem());
                biome = draft;
                var woodland = WoodlandStems(draft.rules);
                foreach (var t in loaded.trees)
                {
                    if (!InsidePlot(t) || t.h < minHeightM) continue;
                    var m = MatchTree(t, woodland.Contains(t));
                    GolfMapBiomeMatch before; biomeMatches.TryGetValue(t, out before);
                    if (m == null || (m.review && !includeReviewMatches)) { if (m == null) previewUnmatched++; if (before != null) previewChanged++; continue; }
                    previewTotal++;
                    Bump(previewSpecies, SpeciesLabel(m.asset)); Bump(previewAssets, m.asset.guid);
                    if (before == null || before.asset.guid != m.asset.guid) previewChanged++;
                }
            }
            catch (Exception e) { previewError = e.Message; }
            finally { biome = saved; }
        }

        static void Bump(Dictionary<string, int> counts, string key) { int n; counts.TryGetValue(key, out n); counts[key] = n + 1; }
    }
}
