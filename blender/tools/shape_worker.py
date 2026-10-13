"""Shaping worker: a long-running headless Blender that keeps a course shaped and re-applies only what changed.

blender/SHAPING-PLAN.md, "Terrain editor -> Blender". The web Terrain editor writes shaping layers
(`docs/gspro/<course>/shaping/NN-*.json`); the server asks this worker to bring the course meshes and their
FBX in step, in seconds instead of a full shape_apply run.

    blender -b --python blender/tools/shape_worker.py -- [--port 8766] [--blend <course>.blend|<course>.conformed.blend]
        [--layers docs/gspro/<course>/shaping] [--fbx-folder <folder>] [--no-cache]

JSON over HTTP on 127.0.0.1 (port: --port, else $GOLFMAP_SHAPING_PORT, else 8766):

- GET /status -> {state: starting|ready|busy|error, phase, blend, conformed, layersDir, fbxFolder, appliedOps,
  lastRun, error}
- POST /load {blend?, layersDir?, fbxFolder?, cache?, syncFbx?} -> open the conformed cache (running
  shape_prepare first when it is missing or older than the source .blend), apply every layer (op-result cache:
  a cold load replays unchanged ops from <blend folder>/shaping-staging/cache), keep per-object snapshots, write
  shaping-report.json. syncFbx: also bring fbxFolder in step with the whole shaped course (fbx_sync).
- POST /sync {dryRun?} -> re-read the layer files, diff the ops against the applied ones by layer:id + content,
  restore the affected objects to their state before the first changed op, re-run in layer order every op
  unit that touches them, seam-check, export the changed objects' FBX into fbxFolder (fbx_sync's exporter,
  fingerprints and manifest) and delete the FBX of removed objects -> {changedObjects, exported, removed,
  seconds, report: {warnings, seams, changedPlaces}, ...}
- POST /shutdown -> stops the worker (Blender exits).

How /sync stays exact: every op runs as units (one per feature group, shape_apply.plan_units) whose reads
(targets plus every mesh within the op's reach) and writes are recorded. Before each op, the state of every
object that op changes is kept (a mesh copy that shares its arrays until one side changes, so this is cheap):
the state at any op boundary is known. A sync restores the affected objects to the boundary before the first
changed op p and re-runs, from p on, the changed ops plus every unit whose footprint meets the affected set
(closed transitively), which is exactly what a fresh full apply does to those objects. If an op writes outside
its predicted reach, the worker re-opens the .blend and applies everything again (still fast: op cache).

bpy is single-threaded: the HTTP server runs in a thread that only queues requests (and answers /status);
every bpy call runs on the main thread in the job loop. The .blend is never saved (shape_prepare saves the
conformed cache, as it does on its own).
"""

import argparse
import json
import os
import queue
import sys
import threading
import time
import traceback
from types import SimpleNamespace
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import bpy

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
import shape_apply as sa  # noqa: E402
import shape_layers as sl  # noqa: E402

FORMAT = "golfmap-shaping-worker-v1"
DEFAULT_PORT = 8766
PLAN_MARGIN = 1.0  # m added to predicted reaches when working out what a change can touch


class HttpError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


class Job:
    def __init__(self, kind, body):
        self.kind = kind
        self.body = body
        self.done = threading.Event()
        self.code = 200
        self.result = None


def footprint(rec):
    return set(rec["reads"]) | set(rec["writes"]) | set(rec["removed"]) | set(rec["created"])


class Worker:
    def __init__(self, args):
        self.args = args
        self.lock = threading.Lock()
        self.jobs = queue.Queue()
        self.running = True
        self.app = None
        self.history = None
        self.ops = []  # applied ops, in order: {key, layer, path, op, canon}
        self.entries = {}  # op key -> report entry
        self.first_sync = False  # the first /sync after a /load also exports whatever differs from the FBX manifest
        self.status = {"format": FORMAT, "state": "starting", "phase": None, "blend": None, "conformed": None,
                       "layersDir": None, "fbxFolder": None, "appliedOps": 0, "lastRun": None, "error": None,
                       "pid": os.getpid(), "port": args.port}

    # ------------------------------------------------------------ status (any thread)

    def set_status(self, **kw):
        with self.lock:
            self.status.update(kw)

    def get_status(self):
        with self.lock:
            s = dict(self.status)
        s["queued"] = self.jobs.qsize()
        return json.loads(json.dumps(s, default=str))

    def submit(self, kind, body):
        job = Job(kind, body)
        self.jobs.put(job)
        return job

    # ------------------------------------------------------------ main thread

    def loop(self):
        while self.running:
            try:
                job = self.jobs.get(timeout=0.5)
            except queue.Empty:
                continue
            state_before = self.status["state"]
            self.set_status(state="busy", phase=job.kind)
            try:
                if job.kind == "load":
                    job.result = self.load(job.body)
                elif job.kind == "sync":
                    job.result = self.sync(job.body)
                elif job.kind == "shutdown":
                    job.result = {"ok": True}
                    self.running = False
                else:
                    raise HttpError(404, f"unknown job {job.kind}")
                self.set_status(state="ready" if self.app is not None or job.kind == "shutdown" else state_before,
                                phase=None, error=None)
            except HttpError as e:
                job.code, job.result = e.code, {"error": str(e)}
                if self.app is not None:
                    self.set_status(state="ready", phase=None)
                else:
                    self.set_status(state="error" if job.kind == "load" else state_before, phase=None,
                                    error=str(e) if job.kind == "load" else self.status["error"])
            except Exception as e:  # the scene may be half-done: a /load is needed
                traceback.print_exc()
                job.code, job.result = 500, {"error": f"{type(e).__name__}: {e}", "trace": traceback.format_exc()}
                self.set_status(state="error", phase=None, error=job.result["error"])
                if job.kind == "sync":
                    self.app = None  # force a /load
            finally:
                job.done.set()

    # ------------------------------------------------------------ load

    def resolve_blend(self, blend):
        blend = os.path.abspath(blend)
        name = os.path.basename(blend)
        if ".conformed" in name.split(".blend")[0]:
            return sa.find_source(blend), blend
        return blend, os.path.splitext(blend)[0] + ".conformed.blend"

    def ensure_conformed(self, blend):
        """(source, conformed, prepare report or None). Runs shape_prepare when the conformed cache is missing or
        older than its source .blend (a regenerated course)."""
        source, conformed = self.resolve_blend(blend)
        stale = not os.path.isfile(conformed) or (
            source and os.path.isfile(source) and os.path.getmtime(source) > os.path.getmtime(conformed))
        if not stale:
            return source, conformed, None
        if not source or not os.path.isfile(source):
            raise HttpError(400, f"no conformed cache {conformed} and no source .blend to prepare it from")
        import shape_prepare
        self.set_status(phase="prepare: opening " + os.path.basename(source))
        print(f"[shape_worker] preparing {conformed} from {source}")
        bpy.ops.wm.open_mainfile(filepath=source)
        self.set_status(phase="prepare: import terrain + conform")
        rep = shape_prepare.run(os.path.join(os.path.dirname(source), "terrain.obj"), conformed)
        with open(os.path.splitext(conformed)[0] + ".json", "w", encoding="utf-8") as f:
            json.dump(rep, f, indent=1)
        print("[shape_worker]\n" + shape_prepare.summary(rep))
        return source, conformed, {k: rep[k] for k in ("out", "conformed", "failedObjects", "timings")}

    def op_list(self, layers_dir):
        try:
            layers = sl.load_layers(layers_dir)
        except sl.LayerError as e:
            raise HttpError(400, str(e))
        out = []
        for path, layer in layers:
            for op in layer["ops"]:
                canon = sa.op_canonical(op)
                if op["op"] == "golfmap.path_transition":
                    # Transition settings live outside the constant generated op.
                    # Diff them before sync's unchanged fast path, independently
                    # of split_surfaces so a paint edit does not rebuild roads.
                    import shape_surfaces
                    ctx = self.app.ctx if self.app is not None else SimpleNamespace(svg_file=self.args.svg)
                    paths = sa._split_sidecar(ctx, op)
                    try:
                        dependency = shape_surfaces.load_sidecar(paths).get("transitions", [])
                    except (OSError, ValueError) as error:
                        dependency = {"missing": paths, "error": str(error)}
                    canon += json.dumps(dependency, sort_keys=True, separators=(",", ":"))
                out.append({"key": sa.op_key(layer, op), "layer": layer, "path": path, "op": op,
                            "canon": canon})
        return out

    def load(self, body):
        t0 = time.time()
        a = self.args
        blend = body.get("blend") or self.status["blend"] or a.blend
        layers_dir = body.get("layersDir") or self.status["layersDir"] or a.layers
        fbx = body.get("fbxFolder") or self.status["fbxFolder"] or a.fbx_folder
        if not blend or not layers_dir:
            raise HttpError(400, "blend and layersDir are needed (body or --blend/--layers)")
        layers_dir = os.path.abspath(layers_dir)
        source, conformed, prepared = self.ensure_conformed(blend)
        self.app = None
        self.set_status(phase="opening " + os.path.basename(conformed), blend=source or conformed, conformed=conformed,
                        layersDir=layers_dir, fbxFolder=os.path.abspath(fbx) if fbx else None, appliedOps=0)
        t_open = time.time()
        bpy.ops.wm.open_mainfile(filepath=conformed)
        t_open = time.time() - t_open
        self.history = sa.History()
        app = sa.Applier(svg=body.get("svg") or a.svg, sidecar=body.get("sidecar") or a.sidecar,
                         cache=body.get("cache", not a.no_cache), history=self.history)
        sa.object_mode()
        self.app = app
        ops = self.op_list(layers_dir)
        self.ops, self.entries = ops, {}
        t_apply = time.time()
        for i, rec in enumerate(ops):
            self.set_status(phase=f"apply {i + 1}/{len(ops)} {rec['key']}")
            self.entries[rec["key"]] = app.apply_op(i, rec["layer"], rec["path"], rec["op"])
        t_apply = time.time() - t_apply
        self.app = app
        self.first_sync = True
        errors = [{"op": k, "error": e.get("error")} for k, e in self.entries.items() if e.get("status") == "error"]
        result = {"format": FORMAT, "blend": source or conformed, "conformed": conformed, "prepared": prepared,
                  "layersDir": layers_dir, "fbxFolder": self.status["fbxFolder"], "appliedOps": len(ops),
                  "errors": errors, "warnings": app.warnings, "unresolved": app.unresolved,
                  "cache": app.runner.summary(), "hash": sa.hash_all(),
                  "timings": {"openS": round(t_open, 1), "applyS": round(t_apply, 1)}}
        if body.get("syncFbx") and self.status["fbxFolder"]:
            fbx_sync = sa.fbx_sync_module()
            self.set_status(phase="fbx sync")
            sa.object_mode()
            synced = fbx_sync.run(bpy.context, folder=self.status["fbxFolder"], export_all=fbx_sync.load_manifest(self.status["fbxFolder"]) is None)
            result["syncFbx"] = {"exported": sorted(synced["export"]), "deletedOrphans": synced.get("deletedOrphans", 0),
                                 "seconds": synced["seconds"]}
            self.first_sync = False
        result["seconds"] = round(time.time() - t0, 1)
        report = {"format": sa.REPORT_FORMAT, "worker": True, "blend": conformed, "source": source,
                  "layersFolder": layers_dir, "startedAt": time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(t0)),
                  "svg": app.svg_report(), "frame": app.frame, "ops": [self.entries[r["key"]] for r in ops],
                  "unresolved": app.unresolved, "warnings": app.warnings, "untouched": app.untouched(),
                  "changedPlaces": app.places(sorted(app.changed_by)),
                  "changedObjectsDetail": app.places_detail(sorted(app.changed_by)), "hashAll": result["hash"],
                  "cache": result["cache"], "seconds": result["seconds"]}
        sa._write(os.path.join(app.staging, "shaping-report.json"), report)
        self.set_status(appliedOps=len(ops), lastRun={"kind": "load", "at": time.strftime("%Y-%m-%dT%H:%M:%S"),
                                                      "seconds": result["seconds"], "cache": result["cache"],
                                                      "errors": len(errors)})
        print(f"[shape_worker] loaded {conformed}: {len(ops)} ops in {result['seconds']} s "
              f"(open {result['timings']['openS']} s, apply {result['timings']['applyS']} s; cache {result['cache']})")
        return result

    # ------------------------------------------------------------ sync

    def diff(self, old, new):
        """p = first position where the op sequences differ; mapping new index -> old index for the ops after p
        that are unchanged (same key and content, relative order kept); the rest are changed/added/removed."""
        p = 0
        while p < min(len(old), len(new)) and old[p]["key"] == new[p]["key"] and old[p]["canon"] == new[p]["canon"]:
            p += 1
        old_at = {r["key"]: k for k, r in enumerate(old)}
        mapping, last = {}, p - 1
        for j in range(p, len(new)):
            k = old_at.get(new[j]["key"])
            if k is not None and k > last and old[k]["canon"] == new[j]["canon"]:
                mapping[j] = k
                last = k
        matched = set(mapping.values())
        return {"p": p, "mapping": mapping,
                "changedNew": [j for j in range(p, len(new)) if j not in mapping],
                "changedOld": [k for k in range(p, len(old)) if k not in matched]}

    def closure(self, d, old, new):
        """Objects a change can reach (transitively through later units' footprints) and, per unchanged op after
        p, the units to re-run."""
        ctx, records = self.app.ctx, self.app.runner.records
        planned = {}

        def plan(j):
            if j not in planned:
                op = new[j]["op"]
                planned[j] = {}
                if op.get("enabled") is not False:
                    try:
                        units, _ = sa.plan_units(ctx, op)
                        planned[j] = {u.id: u.reads(PLAN_MARGIN) for u in units}
                    except Exception as e:  # e.g. a recipe file that is gone: the op reports it when run
                        print(f"[shape_worker] cannot plan {new[j]['key']}: {e}")
            return planned[j]

        affected = set()
        for k in d["changedOld"]:
            for rec in records.get(old[k]["key"], {}).values():
                affected |= footprint(rec)
        for j in d["changedNew"]:
            for reads in plan(j).values():
                affected |= reads
        rerun = {j: set() for j in d["mapping"]}
        grew = True
        while grew:
            grew = False
            for j, k in sorted(d["mapping"].items()):
                old_recs = records.get(old[k]["key"], {})
                pu = plan(j)
                for uid in sorted(set(old_recs) | set(pu), key=str):
                    if uid in rerun[j]:
                        continue
                    f = (footprint(old_recs[uid]) if uid in old_recs else set()) | pu.get(uid, set())
                    if f & affected:
                        rerun[j].add(uid)
                        affected |= f
                        grew = True
        return affected, rerun

    def sync(self, body):
        if self.app is None:
            raise HttpError(409, "nothing loaded (or the last sync failed): POST /load first")
        t0 = time.time()
        stats0 = dict(self.app.runner.stats)
        result = self.sync_ops(body, t0)
        if self.app is not None and "cache" in result:
            now = self.app.runner.stats
            result["cache"] = {k: round(now[k] - stats0.get(k, 0), 2) for k in now}
        result["seconds"] = round(time.time() - t0, 2)
        if self.first_sync and not body.get("dryRun"):
            # First sync after a load: the FBX folder may predate this .blend or these layers, so bring it in
            # step with the whole shaped course (every mesh whose fingerprint differs from the manifest).
            self.first_sync = False
            full = self.export_all()
            if full is not None:
                result["exported"] = sorted(set(result["exported"]) | set(full["exported"]))
                result["removed"] = sorted(set(result["removed"]) | set(full["removed"]))
                result["changedObjects"] = sorted(set(result["changedObjects"]) | set(full["objects"]))
                result["fullExport"] = {k: full[k] for k in ("exported", "removed", "seconds")}
                result["seconds"] = round(time.time() - t0, 2)
                print(f"[shape_worker] first sync after load: {len(full['exported'])} FBX exported, "
                      f"{len(full['removed'])} removed ({full['seconds']} s)")
        return result

    def export_all(self):
        """fbx_sync over the whole .blend into fbxFolder: export what differs from its manifest (everything when it
        has none), delete FBX whose mesh is gone. None without a folder."""
        folder = self.status["fbxFolder"]
        if not folder:
            return None
        fbx_sync = sa.fbx_sync_module()
        os.makedirs(folder, exist_ok=True)
        sa.object_mode()
        synced = fbx_sync.run(bpy.context, folder=folder, export_all=fbx_sync.load_manifest(folder) is None)
        removed = sorted(synced["orphans"]) if synced.get("deletedOrphans") else []
        return {"exported": [n + ".fbx" for n in sorted(synced["export"])], "removed": [n + ".fbx" for n in removed],
                "objects": sorted(synced["export"]) + removed, "seconds": synced["seconds"]}

    def sync_ops(self, body, t0):
        app, old = self.app, self.ops
        # Any subsequent planner must see freshly exported sidecar content.
        app.ctx.__dict__.pop("_sidecars", None)
        # The transition paint is keyed on these files' content, so an edit re-runs it: with the edited code.
        import importlib
        for name in ("shape_edgefade", "shape_transition"):
            if name in sys.modules:
                importlib.reload(sys.modules[name])
        new = self.op_list(self.status["layersDir"])
        d = self.diff(old, new)
        base = {"changedOps": [new[j]["key"] for j in d["changedNew"]],
                "removedOps": [old[k]["key"] for k in d["changedOld"] if old[k]["key"] not in {r["key"] for r in new}]}
        if not d["changedNew"] and not d["changedOld"]:
            return dict(base, changedObjects=[], exported=[], removed=[], seconds=round(time.time() - t0, 2),
                        report={"warnings": [], "seams": None, "changedPlaces": []}, restorePoint=None)
        sa.object_mode()
        full = bool(self.history.broken)
        affected, rerun = self.closure(d, old, new)
        base.update(restorePoint={"index": d["p"], "op": new[d["p"]]["key"] if d["p"] < len(new) else None},
                    affectedObjects=sorted(affected),
                    rerunUnits={new[j]["key"]: sorted(u, key=str) for j, u in rerun.items() if u})
        if body.get("dryRun"):
            return dict(base, dryRun=True, fullReload=full, seconds=round(time.time() - t0, 2))
        if full:
            return self.full_reload(body, base, t0, "history incomplete: " + "; ".join(self.history.broken[:3]))
        fbx_sync = sa.fbx_sync_module()
        self.set_status(phase="sync: restore")
        existing = sorted(n for n in affected if n in bpy.data.objects)
        dg = bpy.context.evaluated_depsgraph_get()
        fp_before = {n: fbx_sync.fingerprint(bpy.data.objects[n], dg) for n in existing}
        seams_before = sa.seam_check(existing)
        p = d["p"]
        for n in sorted(affected):
            self.history.restore(n, p)
        self.history.truncate(affected, p)
        inverse = {k: j for j, k in d["mapping"].items()}
        if not self.history.remap(inverse, p, affected):
            return self.full_reload(body, base, t0, "an unchanged object has history at a changed op")
        app.ctx.forget()
        app.ctx.refresh()
        app.reset()
        runner = app.runner
        for k in d["changedOld"]:
            if old[k]["key"] not in {r["key"] for r in new}:
                runner.records.pop(old[k]["key"], None)
                self.entries.pop(old[k]["key"], None)
        t_run = time.time()
        ran = []
        for j in range(p, len(new)):
            rec = new[j]
            if j in d["mapping"]:
                units = rerun[j]
                if not units:
                    continue
                self.set_status(phase=f"sync: {rec['key']} ({len(units)} unit(s))")
                entry = app.apply_op(j, rec["layer"], rec["path"], rec["op"], unit_filter=units)
                old_entry = self.entries.get(rec["key"]) or {}
                redone = {r.get("feature") for r in entry.get("runs", [])}
                entry["runs"] = [r for r in old_entry.get("runs", []) if r.get("feature") not in redone] + entry.get("runs", [])
                entry["partial"] = sorted(units, key=str)
            else:
                self.set_status(phase=f"sync: {rec['key']}")
                entry = app.apply_op(j, rec["layer"], rec["path"], rec["op"])
            self.entries[rec["key"]] = entry
            ran.append(rec["key"])
            for uid in runner.op_units:
                out = footprint(runner.records[rec["key"]][uid]) - affected
                if out:
                    self.ops = new
                    return self.full_reload(body, base, t0, f"{rec['key']}/{uid} reached {sorted(out)[:5]} outside the restored set")
        t_run = time.time() - t_run
        self.ops = new
        sa.object_mode()
        now = sorted(n for n in affected if n in bpy.data.objects)
        dg = bpy.context.evaluated_depsgraph_get()
        fp_after = {n: fbx_sync.fingerprint(bpy.data.objects[n], dg) for n in now}
        changed = sorted(n for n in now if fp_before.get(n) != fp_after[n])
        gone = sorted(set(fp_before) - set(fp_after))
        self.set_status(phase="sync: checks")
        seams = sa.seam_summary(seams_before, sa.seam_check(now))
        cut = sa.cut_objects([self.entries[k] for k in ran if k in self.entries]) & set(changed)
        if cut:
            tj = sa.tjunction_check(sorted(cut))
            seams["tJunctions"] = {"toleranceXY": 1e-3, "objects": tj, "gaps": sum(r["gaps"] for r in tj.values()),
                                   "maxAbsDz": max([r["maxAbsDz"] for r in tj.values()] or [0.0])}
        path_meshes = [n for n in changed if (app.ctx.by_name.get(n) or {}).get("type") == "path"
                       and (app.ctx.by_name.get(n) or {}).get("kind") == "mesh"]
        path_surface = sa.path_surface_check(path_meshes, app.frame, app.svg_paths)
        ops_by_object = {n: [k for k in ran if n in (self.entries[k].get("objectsChanged") or [])] for n in changed}
        places = app.places(changed, ops_by_object, op_keys=set(ran))
        self.set_status(phase="sync: export")
        exported, removed = self.export(changed, gone)
        result = dict(base, changedObjects=changed + gone, exported=exported, removed=removed,
                      seconds=round(time.time() - t0, 2),
                      report={"warnings": app.warnings, "seams": seams, "pathSurface": path_surface, "changedPlaces": places,
                              "changedObjectsDetail": app.places_detail(changed, ops_by_object)},
                      ranOps=ran, cache=runner.summary(), hash=sa.hash_all(),
                      timings={"rerunS": round(t_run, 2)}, fbxFolder=self.status["fbxFolder"])
        sa._write(os.path.join(app.staging, "shaping-sync.json"),
                  dict(result, ops=[self.entries[k] for k in ran if k in self.entries]))
        self.set_status(appliedOps=len(new), lastRun={"kind": "sync", "at": time.strftime("%Y-%m-%dT%H:%M:%S"),
                                                      "seconds": result["seconds"], "changedObjects": len(result["changedObjects"]),
                                                      "exported": len(exported), "ranOps": ran})
        print(f"[shape_worker] sync: {len(base['changedOps'])} changed op(s), restored {len(affected)} object(s) to before "
              f"{base['restorePoint']['op']}, re-ran {len(ran)} op(s) in {t_run:.1f} s; {len(changed)} changed, "
              f"{len(exported)} FBX exported, {len(removed)} removed; {result['seconds']} s")
        return result

    def full_reload(self, body, base, t0, reason):
        """Fallback when the snapshots cannot restore exactly: open the .blend again and apply everything (op
        cache makes this fast), then export whatever differs from the FBX manifest."""
        print(f"[shape_worker] full re-apply: {reason}")
        self.load({})
        self.first_sync = False
        result = dict(base, fullReload=reason, changedObjects=[], exported=[], removed=[])
        full = self.export_all()
        if full is not None:
            result.update(exported=full["exported"], removed=full["removed"], changedObjects=full["objects"])
        result.update(seconds=round(time.time() - t0, 2), hash=sa.hash_all(),
                      report={"warnings": self.app.warnings, "seams": None,
                              "changedPlaces": self.app.places(result["changedObjects"]),
                              "changedObjectsDetail": self.app.places_detail(result["changedObjects"])})
        return result

    def export(self, names, gone):
        """fbx_sync's exporter call + fingerprints for just these objects into fbxFolder (manifest kept, so a later
        full fbx_sync agrees); FBX of objects that no longer exist are deleted."""
        folder = self.status["fbxFolder"]
        if not folder:
            return [], []
        fbx_sync = sa.fbx_sync_module()
        os.makedirs(folder, exist_ok=True)
        sa.object_mode()
        skip = fbx_sync.exclude_prefixes(fbx_sync.DEFAULT_EXCLUDE)
        dg = bpy.context.evaluated_depsgraph_get()
        objects = {}
        for n in names:
            o = bpy.data.objects.get(n)
            if o is not None and o.type == "MESH" and o.visible_get() and not fbx_sync.is_excluded(fbx_sync.file_name(o), skip):
                objects[fbx_sync.file_name(o)] = o
        hashes = {fn: fbx_sync.fingerprint(o, dg) for fn, o in objects.items()}
        manifest = fbx_sync.load_manifest(folder) or {}
        todo = sorted(fn for fn in objects if manifest.get(fn) != hashes[fn]
                      or not os.path.isfile(os.path.join(folder, fn + ".fbx")))
        fbx_sync.export_objects(bpy.context, folder, todo, objects)
        manifest.update({fn: hashes[fn] for fn in todo})
        live = {fbx_sync.file_name(o) for o in bpy.data.objects if o.type == "MESH"}
        removed = []
        for n in gone:
            fn = bpy.path.clean_name(n)
            if fn in live:
                continue
            path = os.path.join(folder, fn + ".fbx")
            if os.path.isfile(path):
                os.remove(path)
                removed.append(fn + ".fbx")
            manifest.pop(fn, None)
        fbx_sync.save_manifest(folder, manifest)
        return [fn + ".fbx" for fn in todo], removed


def make_handler(worker):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt, *args):
            print("[shape_worker] http " + (fmt % args))

        def send_json(self, code, data):
            raw = json.dumps(data, default=str).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def do_GET(self):
            if self.path.split("?")[0] == "/status":
                self.send_json(200, worker.get_status())
            else:
                self.send_json(404, {"error": "unknown path " + self.path})

        def do_POST(self):
            path = self.path.split("?")[0]
            kind = {"/load": "load", "/sync": "sync", "/shutdown": "shutdown"}.get(path)
            if kind is None:
                self.send_json(404, {"error": "unknown path " + self.path})
                return
            n = int(self.headers.get("Content-Length") or 0)
            try:
                body = json.loads(self.rfile.read(n).decode("utf-8") or "{}") if n else {}
                if not isinstance(body, dict):
                    raise ValueError("body must be a JSON object")
            except ValueError as e:
                self.send_json(400, {"error": f"bad JSON body: {e}"})
                return
            job = worker.submit(kind, body)
            job.done.wait()
            self.send_json(job.code, job.result)

    return Handler


def main(argv):
    ap = argparse.ArgumentParser(prog="shape_worker.py")
    ap.add_argument("--port", type=int, default=int(os.environ.get("GOLFMAP_SHAPING_PORT", DEFAULT_PORT)))
    ap.add_argument("--blend", help="course .blend or its .conformed.blend: loaded at start")
    ap.add_argument("--layers", help="shaping layers folder (docs/gspro/<course>/shaping)")
    ap.add_argument("--fbx-folder", help="FBX folder /sync exports into (e.g. the Unity project's Assets/fbx)")
    ap.add_argument("--svg")
    ap.add_argument("--sidecar")
    ap.add_argument("--no-cache", action="store_true", help="do not use the op-result cache")
    args = ap.parse_args(argv)
    worker = Worker(args)
    server = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(worker))
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, name="shape_worker-http", daemon=True).start()
    print(f"[shape_worker] listening on http://127.0.0.1:{args.port} (pid {os.getpid()})")
    if args.blend and args.layers:
        worker.submit("load", {})
    else:
        worker.set_status(state="ready")
    try:
        worker.loop()
    finally:
        server.shutdown()
        print("[shape_worker] stopped")


if __name__ == "__main__":
    sys.stdout.reconfigure(line_buffering=True)
    main(sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else [])
