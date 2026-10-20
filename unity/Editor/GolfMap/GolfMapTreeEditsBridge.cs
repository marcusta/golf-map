// Tree edits without the Scene view editor (golfmap.trees.edit): one hand change to one placement by tree
// id (CONTEXT.md "Tree edit"), recorded in <prefix>-<terrain>-tree-edits.json beside the trees export as
// the scene editor records it, so the next Plant applies it and a replant or a regenerated survey keeps it.
// Planting is not run here.
//
//   modify  another model (model=) or species, a size (heightM, crownWidthM), a rotation (rotationY), a
//           position (x, z in world metres); what is not named stays as the tree is now
//   add     a new tree at x, z with its species or model and its size; returns its id
//   delete  the tree is not planted (an added tree's record is simply dropped)
//   revert  the tree's record is removed: it is the survey's again
//
// A model named without a crown width keeps that model's proportions at the height asked for; a size
// named by hand is the tree's drawn size, so the fit takes it as it is (no lidar pad, no woodland canopy).
using System;
using System.Collections.Generic;
using System.Linq;

namespace GolfMap.Editor
{
    // One golfmap.trees.edit call: the op, the tree, and what it names (null = not named).
    internal struct TreeEditRequest
    {
        public string op, id, model, species;
        public double? x, z, heightM, crownWidthM, rotationY;   // world metres, metres, degrees
    }

    public partial class GolfMapTreePlanter
    {
        internal Dictionary<string, object> EditFromBridge(TreeEditRequest r)
        {
            var problem = SyncRole();
            if (!string.IsNullOrEmpty(problem)) throw new InvalidOperationException(problem);
            if (terrain == null || string.IsNullOrEmpty(filePath)) throw new InvalidOperationException("The " + RoleKey + " panel has no terrain or trees file.");
            LoadFile();
            if (loaded == null) throw new InvalidOperationException(status);
            if (r.op == "revert") return Revert(r.id);
            if (r.op == "add") return Add(r);
            if (r.op == "modify" || r.op == "delete") return ModifyOrDelete(r);
            throw new InvalidOperationException("op must be modify, add, delete or revert.");
        }

        // The survey's trees as the next Plant sees them, after GolfMapTreeEdits.Apply (golfmap.trees.edits.applied):
        // id and terrain-local x, z of each, and the warnings for records that matched nothing. Nothing is written.
        // arborist.py's edited_stems routes from its own copy of Apply; pipeline's parity test compares the two.
        internal Dictionary<string, object> AppliedFromBridge()
        {
            var problem = SyncRole();
            if (!string.IsNullOrEmpty(problem)) throw new InvalidOperationException(problem);
            if (string.IsNullOrEmpty(filePath)) throw new InvalidOperationException("The " + RoleKey + " panel has no trees file.");
            LoadFile();
            if (loaded == null) throw new InvalidOperationException(status);
            return new Dictionary<string, object>
            {
                { "trees", System.IO.Path.GetFileName(filePath) }, { "edits", System.IO.Path.GetFileName(editsPath) },
                { "stems", loaded.trees.Select(t => (object)new Dictionary<string, object> { { "id", t.id }, { "x", (double)t.x }, { "z", (double)t.z } }).ToList() },
                { "warnings", editWarnings.Cast<object>().ToList() },
            };
        }

        Dictionary<string, object> Revert(string id)
        {
            int removed = editFile.edits.RemoveAll(e => e.id == id);
            GolfMapTreeEdits.Save(editsPath, editFile);
            return Result("revert", id, removed > 0 ? "removed the tree's edit" : "the tree had no edit", null);
        }

        Dictionary<string, object> Add(TreeEditRequest r)
        {
            if (!r.x.HasValue || !r.z.HasValue) throw new InvalidOperationException("add needs x and z (world metres).");
            if (!r.heightM.HasValue) throw new InvalidOperationException("add needs heightM.");
            if (string.IsNullOrEmpty(r.model) && string.IsNullOrEmpty(r.species)) throw new InvalidOperationException("add needs a species or a model.");
            var edit = new GolfMapTreeEdit { id = GolfMapTreeEdits.NewId(), op = "add", k = 0 };
            edit.ox = edit.x = LocalX(r.x.Value); edit.oz = edit.z = LocalZ(r.z.Value);
            Apply(edit, r);
            // (An id given with add that some edit already has: that edit's record stays as it is.)
            bool isNew = string.IsNullOrEmpty(r.id) || !editFile.edits.Any(e => e.id == r.id);
            return Record(r.op, edit, isNew, "added");
        }

        Dictionary<string, object> ModifyOrDelete(TreeEditRequest r)
        {
            if (string.IsNullOrEmpty(r.id)) throw new InvalidOperationException(r.op + " needs the tree's id.");
            var existing = editFile.edits.FirstOrDefault(e => e.id == r.id);
            var tree = loaded.trees.FirstOrDefault(t => t.id == r.id);
            if (tree == null && existing == null) throw new InvalidOperationException("No tree " + r.id + " in " + System.IO.Path.GetFileName(filePath) + " or its edits.");
            if (r.op == "delete" && existing != null && existing.op == "add")
            {
                editFile.edits.Remove(existing);
                GolfMapTreeEdits.Save(editsPath, editFile);
                return Result(r.op, r.id, "removed the added tree", null);
            }
            var edit = existing ?? new GolfMapTreeEdit { id = r.id, op = "modify", ox = tree.x, oz = tree.z };
            if (tree != null) { edit.x = tree.x; edit.z = tree.z; edit.h = tree.h; edit.r = tree.r; edit.k = tree.k; edit.bush = tree.bush; }
            if (r.op == "delete") edit.op = "delete";
            else Apply(edit, r);
            return Record(r.op, edit, existing == null, r.op == "delete" ? "deleted" : "modified");
        }

        // What a modify or add names, onto the edit: the model or species, then the position, size and rotation.
        void Apply(GolfMapTreeEdit edit, TreeEditRequest r)
        {
            var picked = ApplyModelOrSpecies(edit, GolfMapPalette.Load(BiomeFile), r.model, r.species);
            if (r.x.HasValue) edit.x = LocalX(r.x.Value);
            if (r.z.HasValue) edit.z = LocalZ(r.z.Value);
            ApplySize(edit, picked, r.heightM, r.crownWidthM);
            if (r.rotationY.HasValue) { edit.rotation = (float)(((r.rotationY.Value % 360) + 360) % 360); edit.rotationSet = true; }
        }

        // A model of the palette (wins over species and asset), or a species the palette has enabled models of.
        // Returns the picked model, null when none was named.
        GolfMapBiomeAsset ApplyModelOrSpecies(GolfMapTreeEdit edit, GolfMapBiome palette, string model, string species)
        {
            if (!string.IsNullOrEmpty(model))
            {
                var picked = palette.assets.FirstOrDefault(a => a.model == model);
                if (picked == null) throw new InvalidOperationException("Model '" + model + "' is not in the palette (" + BiomeFile + "); add it there first.");
                edit.model = model; edit.species = picked.species ?? ""; edit.guid = "";
                edit.k = GolfMapBiome.StemKind(new[] { picked });
                return picked;
            }
            if (!string.IsNullOrEmpty(species))
            {
                var assets = palette.assets.Where(a => a.enabled && a.species == species).ToList();
                if (assets.Count == 0) throw new InvalidOperationException("No enabled model of species '" + species + "' in the palette.");
                edit.species = species; edit.model = ""; edit.guid = "";
                edit.k = GolfMapBiome.StemKind(assets);
            }
            return null;
        }

        // A size named by hand is the drawn size (sized); a picked model without a crown width keeps its proportions.
        static void ApplySize(GolfMapTreeEdit edit, GolfMapBiomeAsset picked, double? heightM, double? crownWidthM)
        {
            if (heightM.HasValue)
            {
                if (!(heightM.Value > 0)) throw new InvalidOperationException("heightM must be positive.");
                edit.h = (float)heightM.Value; edit.sized = true;
            }
            if (crownWidthM.HasValue)
            {
                if (!(crownWidthM.Value > 0)) throw new InvalidOperationException("crownWidthM must be positive.");
                edit.r = (float)(crownWidthM.Value / 2); edit.sized = true;
            }
            else if (picked != null && picked.heightM > 0 && edit.h > 0)
                edit.r = (float)(edit.h / picked.heightM * picked.crownWidthM / 2);   // the model's own proportions
            if (!(edit.r > 0)) throw new InvalidOperationException("The tree needs a crown width (crownWidthM).");
        }

        Dictionary<string, object> Record(string op, GolfMapTreeEdit edit, bool isNew, string note)
        {
            if (isNew) editFile.edits.Add(edit);
            if (string.IsNullOrEmpty(editFile.trees)) editFile.trees = System.IO.Path.GetFileName(filePath);
            GolfMapTreeEdits.Save(editsPath, editFile);
            return Result(op, edit.id, note, edit);
        }

        // World metres -> the trees file's (terrain-local) metres.
        float LocalX(double worldX) { return (float)(worldX - terrain.transform.position.x); }
        float LocalZ(double worldZ) { return (float)(worldZ - terrain.transform.position.z); }

        Dictionary<string, object> Result(string op, string id, string note, GolfMapTreeEdit edit)
        {
            var origin = terrain.transform.position;
            var d = new Dictionary<string, object> { { "terrain", RoleKey }, { "op", op }, { "id", id }, { "note", note + "; plant the " + RoleKey + " trees to apply it" }, { "file", editsPath } };
            if (edit != null)
                d["edit"] = new Dictionary<string, object>
                {
                    { "op", edit.op }, { "model", edit.model }, { "species", edit.species }, { "x", edit.x + origin.x }, { "z", edit.z + origin.z },
                    { "heightM", edit.h }, { "crownWidthM", 2 * edit.r }, { "rotationY", edit.rotationSet ? (object)edit.rotation : null }, { "sized", edit.sized },
                };
            return d;
        }
    }
}
