"""Shaping worker: a long-running headless Blender that keeps a course shaped and re-applies only what changed.

blender/SHAPING-PLAN.md, "Terrain editor -> Blender". The web Terrain editor writes shaping layers
(`docs/gspro/<course>/shaping/NN-*.json`); the server asks this worker to bring the course meshes and their
FBX in step, in seconds instead of a full shape_apply run.

    blender -b --python blender/tools/shape_worker.py -- [--port 8766] [--host 127.0.0.1] [--token <t>]
        [--blend <course>.blend|<course>.conformed.blend]
        [--layers docs/gspro/<course>/shaping] [--fbx-folder <folder>] [--no-cache]

JSON over HTTP on --host (else $GOLFMAP_SHAPING_HOST, else 127.0.0.1; 0.0.0.0 to serve a server on another
machine) and --port (else $GOLFMAP_SHAPING_PORT, else 8766). With --token (else $GOLFMAP_SHAPING_TOKEN) every
request must carry it as `X-Golfmap-Token`, or it is refused with 401. Paths in the body (blend, layersDir,
fbxFolder) may be UNC (\\\\host\\share\\...): nothing here assumes a drive letter.

A /load or /sync is a JOB: the call answers at once and the work goes on in the main thread, so a sync that
takes an hour needs no held connection.

- GET /status -> {state: starting|ready|busy|error, phase, blend, conformed, layersDir, fbxFolder, appliedOps,
  lastRun, error, host, port, pid, queued, job}, where `job` is the running (else the last) job:
  {id, kind, state: running|succeeded|failed, phase, startedAt, seconds, result, error} — `result` is the
  answer the old blocking call returned, `error` its message.
- GET /job/<id> -> that job alone, in the same shape (404 when this worker never ran it; the last few are kept).
- POST /load {blend?, layersDir?, fbxFolder?, cache?, syncFbx?} -> open the conformed cache (running
  shape_prepare first when it is missing, older than the source .blend, or conformed against a terrain.obj
  whose content sha is not the one on disk now - `conformed_stale`), apply every layer (op-result cache:
  a cold load replays unchanged ops from <blend folder>/shaping-staging/cache), keep per-object snapshots, write
  shaping-report.json. syncFbx: also bring fbxFolder in step with the whole shaped course (fbx_sync).
- POST /sync {dryRun?, allowGaps?} -> re-read the layer files, diff the ops against the applied ones by layer:id +
  content, restore the affected objects to their state before the first changed op, re-run in layer order every op
  unit that touches them, seam-check, export the changed objects' FBX into fbxFolder (fbx_sync's exporter,
  fingerprints and manifest) and delete the FBX of removed objects -> {changedObjects, exported, removed, errors,
  seconds, report: {warnings, seams, gates, changedPlaces}, ...}. GATES before any export: a seam gap > 1 cm, a
  T-junction step >= 1 cm, upside-down faces on top or NaN vertices that the sync made (or made worse) fail the
  job (422, the message names the objects and EPSG:3006 spots), the affected objects, history and books go back
  to before the sync and nothing is exported; what was there before it is only a warning (report.gates).
  `allowGaps: true` turns the failures into warnings and exports anyway.
- Both POSTs answer {job, kind, state: "running"} with 202, or 409 when a job is already going.
  `?wait=1` instead holds the connection until the job is done and answers its result, as before
  (what `curl` users want).
- POST /check {boundary?, marginM?, tjunctions?, out?} -> course_check.check() on the shaped course as it is now
  (seam steps, T-junctions, upside-down top faces, NaN; inside the boundary ring + marginM): the report, also
  written to `out` (default course-check-blender.json beside the conformed .blend). A job like /sync.
- POST /shutdown -> stops the worker (Blender exits); always waits.

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
import urllib.parse
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
DEFAULT_HOST = "127.0.0.1"
TOKEN_HEADER = "X-Golfmap-Token"
PLAN_MARGIN = 1.0  # m added to predicted reaches when working out what a change can touch
JOBS_KEPT = 20  # finished jobs still answerable on /job/<id>
GATE_GAP_M = 0.01  # a seam gap wider than this that the sync made (or widened) fails it: the ball falls through
GATE_TJUNCTION_M = 0.01  # ... and a T-junction step at least this high


class HttpError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


# ------------------------------------------------------------ is the conformed cache still good?


def terrain_obj_for(blend):
    """The terrain OBJ a course's conform uses: `terrain.obj` next to the .blend, as shape_prepare's own
    default. Regenerated from every DEM export by `terrain_obj.py`."""
    return os.path.join(os.path.dirname(os.path.abspath(blend)), "terrain.obj")


def conformed_stale(source, conformed, terrain=None):
    """(stale, why) for a `<name>.conformed.blend`: must shape_prepare run again?

    Three inputs decide what the conformed cache holds, and all three are checked:

    - the conformed .blend itself - missing, so there is nothing to use;
    - the source course .blend (OPCD regenerates it with new meshes, new names) - by mtime, which also
      covers the `Outer` outer-plot terrain, since OPCD builds that inside the source .blend;
    - `terrain.obj`, which `terrain_obj.py` rewrites from every DEM export, so its mtime moves even when
      the heightmap did not. Compared by CONTENT: `shape_prepare` records the OBJ's sha1 in
      `<name>.conformed.terrain.json` (and in the prepare report next to it), and that is what is
      compared, so a terrain rewritten byte-for-byte the same keeps a 2.5-minute conform. Only when no
      sha was ever recorded (a conformed .blend from before this sidecar) does the mtime decide.
    """
    if not conformed or not os.path.isfile(conformed):
        return True, f"no conformed cache {conformed}"
    if source and os.path.isfile(source) and os.path.getmtime(source) > os.path.getmtime(conformed):
        return True, f"{os.path.basename(source)} is newer than {os.path.basename(conformed)}"
    terrain = terrain or terrain_obj_for(source or conformed)
    if not os.path.isfile(terrain):
        return False, ""   # nothing to conform against; prepare would fail on it anyway
    import shape_prepare
    recorded = shape_prepare.read_terrain_sidecar(conformed).get("terrainSha") or _reported_terrain_sha(conformed)
    if not recorded:
        if os.path.getmtime(terrain) > os.path.getmtime(conformed):
            return True, (f"{os.path.basename(terrain)} is newer than {os.path.basename(conformed)} "
                          "and no terrain sha was recorded for it")
        return False, ""
    sha, _ = shape_prepare.terrain_fingerprint(terrain, shape_prepare.cache_dir_for(source or conformed))
    if sha != recorded:
        return True, (f"{os.path.basename(terrain)} changed: sha {sha[:12]} now, "
                      f"{recorded[:12]} when {os.path.basename(conformed)} was conformed")
    return False, ""


def _reported_terrain_sha(conformed):
    """The terrain sha out of the prepare report the worker writes next to a conformed .blend, for a cache
    whose sidecar is gone (or that predates it)."""
    try:
        with open(os.path.splitext(conformed)[0] + ".json", encoding="utf-8") as f:
            rep = json.load(f)
    except (OSError, ValueError):
        return None
    if not isinstance(rep, dict):
        return None
    return rep.get("terrainSha") or (rep.get("cache") or {}).get("terrainSha")


class Job:
    """One /load or /sync run: queued by the HTTP thread, run by the main thread's loop, polled on /status
    and /job/<id> (and awaited in place by `?wait=1`)."""

    _seq = 0
    _seq_lock = threading.Lock()

    def __init__(self, kind, body):
        with Job._seq_lock:
            Job._seq += 1
            self.id = str(Job._seq)
        self.kind = kind
        self.body = body
        self.done = threading.Event()
        self.code = 200
        self.result = None
        self.error = None
        self.state = "queued"
        self.queued_at = time.time()
        self.t0 = None
        self.t1 = None

    @property
    def going(self):
        return self.state in ("queued", "running")

    def public(self, phase=None):
        """The job as /status and /job/<id> report it. `phase` = the worker's phase, for a running job."""
        t0 = self.t0 or self.queued_at
        return {"id": self.id, "kind": self.kind, "state": "running" if self.going else self.state,
                "phase": phase if self.going else None,
                "startedAt": time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(t0)),
                "seconds": round((self.t1 or time.time()) - t0, 1),
                "result": self.result if self.state == "succeeded" else None,
                "error": self.error}


def footprint(rec):
    return set(rec["reads"]) | set(rec["writes"]) | set(rec["removed"]) | set(rec["created"])


class Worker:
    def __init__(self, args):
        self.args = args
        self.token = getattr(args, "token", None) or None
        self.lock = threading.Lock()
        self.jobs = queue.Queue()
        self.running = True
        self.app = None
        self.history = None
        self.ops = []  # applied ops, in order: {key, layer, path, op, canon}
        self.entries = {}  # op key -> report entry
        self.first_sync = False  # the first /sync after a /load also exports whatever differs from the FBX manifest
        self.job = None  # the running job, else the last one
        self.by_id = {}  # the last JOBS_KEPT jobs, for /job/<id>
        self.status = {"format": FORMAT, "state": "starting", "phase": None, "blend": None, "conformed": None,
                       "layersDir": None, "fbxFolder": None, "appliedOps": 0, "lastRun": None, "error": None,
                       "pid": os.getpid(), "host": getattr(args, "host", "127.0.0.1"), "port": args.port}

    # ------------------------------------------------------------ status (any thread)

    def set_status(self, **kw):
        with self.lock:
            self.status.update(kw)

    def get_status(self):
        with self.lock:
            s = dict(self.status)
            s["job"] = self.job.public(s["phase"]) if self.job is not None else None
        s["queued"] = self.jobs.qsize()
        return json.loads(json.dumps(s, default=str))

    def job_by_id(self, job_id):
        with self.lock:
            job = self.by_id.get(job_id)
            phase = self.status["phase"]
        return None if job is None else json.loads(json.dumps(job.public(phase), default=str))

    def submit(self, kind, body, alone=True):
        """Queue a job. Returns (job, None), or (None, the job in the way) when one is already going
        (`alone=False` queues behind it anyway — /shutdown must always get through)."""
        with self.lock:
            if alone and self.job is not None and self.job.going:
                return None, self.job
            job = Job(kind, body)
            if self.job is None or not self.job.going:
                self.job = job
            self.by_id[job.id] = job
            for old in sorted(self.by_id, key=int)[:-JOBS_KEPT]:
                self.by_id.pop(old, None)
        self.jobs.put(job)
        return job, None

    # ------------------------------------------------------------ main thread

    def loop(self):
        while self.running:
            try:
                job = self.jobs.get(timeout=0.5)
            except queue.Empty:
                continue
            state_before = self.status["state"]
            job.state = "running"
            job.t0 = time.time()
            self.set_status(state="busy", phase=job.kind)
            try:
                if job.kind == "load":
                    job.result = self.load(job.body)
                elif job.kind == "sync":
                    job.result = self.sync(job.body)
                elif job.kind == "check":
                    job.result = self.check(job.body)
                elif job.kind == "shutdown":
                    job.result = {"ok": True}
                    self.running = False
                else:
                    raise HttpError(404, f"unknown job {job.kind}")
                job.state = "succeeded"
                self.set_status(state="ready" if self.app is not None or job.kind == "shutdown" else state_before,
                                phase=None, error=None)
            except HttpError as e:
                job.code, job.result, job.error, job.state = e.code, {"error": str(e)}, str(e), "failed"
                if self.app is not None:
                    self.set_status(state="ready", phase=None)
                else:
                    self.set_status(state="error" if job.kind == "load" else state_before, phase=None,
                                    error=str(e) if job.kind == "load" else self.status["error"])
            except Exception as e:  # the scene may be half-done: a /load is needed
                traceback.print_exc()
                job.code, job.result = 500, {"error": f"{type(e).__name__}: {e}", "trace": traceback.format_exc()}
                job.error, job.state = job.result["error"], "failed"
                self.set_status(state="error", phase=None, error=job.result["error"])
                if job.kind == "sync":
                    self.app = None  # force a /load
            finally:
                job.t1 = time.time()
                job.done.set()

    # ------------------------------------------------------------ load

    def resolve_blend(self, blend):
        blend = os.path.abspath(blend)
        name = os.path.basename(blend)
        if ".conformed" in name.split(".blend")[0]:
            return sa.find_source(blend), blend
        return blend, os.path.splitext(blend)[0] + ".conformed.blend"

    def ensure_conformed(self, blend):
        """(source, conformed, prepare report or None). Runs shape_prepare when `conformed_stale` says the
        conformed cache no longer matches its inputs. shape_prepare's own per-mesh conform cache
        (`<blend folder>/shaping-staging/conform-cache`) then conforms only the meshes whose flat input
        changed, so a regenerated .blend costs seconds per changed mesh instead of the whole course."""
        source, conformed = self.resolve_blend(blend)
        stale, why = conformed_stale(source, conformed)
        if not stale:
            return source, conformed, None
        if not source or not os.path.isfile(source):
            raise HttpError(400, f"no conformed cache {conformed} and no source .blend to prepare it from")
        import shape_prepare
        self.set_status(phase="prepare: opening " + os.path.basename(source))
        print(f"[shape_worker] preparing {conformed} from {source} ({why})")
        bpy.ops.wm.open_mainfile(filepath=source)
        self.set_status(phase="prepare: import terrain + conform")
        rep = shape_prepare.run(terrain_obj_for(source), conformed)
        with open(os.path.splitext(conformed)[0] + ".json", "w", encoding="utf-8") as f:
            json.dump(rep, f, indent=1)
        print("[shape_worker]\n" + shape_prepare.summary(rep))
        cache = rep.get("cache") or {}
        return source, conformed, dict(
            {k: rep[k] for k in ("out", "conformed", "failedObjects", "timings")},
            stale=why, terrainSha=rep.get("terrainSha"), conformPath=rep.get("conformPath"),
            conformCache={k: cache.get(k) for k in ("used", "hits", "misses", "skipped",
                                                    "gridMeshes", "operatorMeshes")},
            carryOver={k: (rep.get("carryOver") or {}).get(k) for k in ("used", "skipped", "counts", "seams")})

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
                if op["op"] == "golfmap.paint":
                    # The rule's export (R.A.M. roads, creeks, lake plane) lives outside the op: diff its sha too.
                    import shape_paintop
                    folder = (shape_paintop.course_folder(self.app.ctx) if self.app is not None
                              else os.path.dirname(self.status.get("blend") or self.args.blend or ""))
                    canon += json.dumps(shape_paintop.dependency(op, folder), sort_keys=True, separators=(",", ":"))
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

    def check(self, body):
        """course_check on the shaped course (the shaped meshes are only here and in the FBX)."""
        if self.app is None:
            raise HttpError(409, "nothing loaded (or the last sync failed): POST /load first")
        import importlib
        import course_check
        importlib.reload(course_check)  # an edit to the check applies without reloading the course
        self.set_status(phase="check")
        report = course_check.check(body.get("boundary"), float(body.get("marginM", 50)), body.get("sidecar"),
                                    bool(body.get("tjunctions", False)))
        out = body.get("out") or os.path.join(os.path.dirname(self.status["conformed"] or bpy.data.filepath), "course-check-blender.json")
        with open(out, "w", encoding="utf-8") as f:
            json.dump(report, f, indent=1)
        report["report"] = out
        return report

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
        reloaded = ["shape_edgefade", "shape_transition", "shape_paintrules", "shape_paintop"]
        for name in reloaded:
            if name in sys.modules:
                importlib.reload(sys.modules[name])
        app.runner.reload_code(reloaded)  # their text is in the op cache's code keys
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
        self.set_status(phase="sync: checks before")
        existing = sorted(n for n in affected if n in bpy.data.objects)
        dg = bpy.context.evaluated_depsgraph_get()
        fp_before = {n: fbx_sync.fingerprint(bpy.data.objects[n], dg) for n in existing}
        seams_before = sa.seam_check(existing)
        faces_before = face_findings(existing)
        tj_before = sa.tjunction_check(sorted(self.cut_candidates(d, old, new) & set(existing)))
        self.set_status(phase="sync: restore")
        undo = self.undo_point(affected)
        p = d["p"]
        for n in sorted(affected):
            self.history.restore(n, p)
        # The history's entries from p on are dropped from the books (the run records new ones) but their meshes
        # are kept until the gates pass: a failed gate puts them back (revert), a passed one frees them (drop_undo).
        for n in affected:
            keep = [e for e in self.history.entries.get(n, []) if e[0] < p]
            if keep:
                self.history.entries[n] = keep
            else:
                self.history.entries.pop(n, None)
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
            # An op that selected nothing (a feature not in this .blend) never began: op_units are the last op's.
            units_run = runner.op_units if runner.op_key == rec["key"] else []
            for uid in units_run:
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
        allow = bool(body.get("allowGaps"))
        gates = gate_check(seams, (seams.get("tJunctions") or {}).get("objects") or {}, tj_before,
                           face_findings(changed), faces_before, app.frame, allow)
        if not gates["ok"] and not allow:
            self.set_status(phase="sync: gates failed, restoring")
            self.revert(undo)
            message = gate_message(gates["failures"])
            sa._write(os.path.join(app.staging, "shaping-sync.json"),
                      dict(base, failed=message, gates=gates, report={"seams": seams}, ranOps=ran))
            self.set_status(lastRun={"kind": "sync", "at": time.strftime("%Y-%m-%dT%H:%M:%S"), "error": message,
                                     "gateFailures": len(gates["failures"])})
            print(f"[shape_worker] sync refused: {message}")
            raise HttpError(422, message)
        self.drop_undo(undo)
        ops_by_object = {n: [k for k in ran if n in (self.entries[k].get("objectsChanged") or [])] for n in changed}
        places = app.places(changed, ops_by_object, op_keys=set(ran))
        self.set_status(phase="sync: export")
        exported, removed = self.export(changed, gone)
        errors = [{"op": k, "error": self.entries[k].get("error")} for k in ran
                  if (self.entries.get(k) or {}).get("status") == "error"]
        result = dict(base, changedObjects=changed + gone, exported=exported, removed=removed,
                      seconds=round(time.time() - t0, 2), errors=errors,
                      report={"warnings": app.warnings, "seams": seams, "gates": gates, "pathSurface": path_surface,
                              "changedPlaces": places, "changedObjectsDetail": app.places_detail(changed, ops_by_object)},
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

    def cut_candidates(self, d, old, new):
        """Objects a sync's T-junction check after the run can name, for the same check before it: what the cut ops
        from p on cut last time, plus everything the changed cut ops read now."""
        names = sa.cut_objects([self.entries[r["key"]] for r in old[d["p"]:] if r["key"] in self.entries])
        for j in d["changedNew"]:
            op = new[j]["op"]
            if op["op"] not in sa.CUT_OPS or op.get("enabled") is False:
                continue
            try:
                units, _ = sa.plan_units(self.app.ctx, op)
            except Exception as e:  # the op reports it when run
                print(f"[shape_worker] cannot plan {new[j]['key']}: {e}")
                continue
            for u in units:
                names |= set(u.reads(0.0))
        return names

    def undo_point(self, names):
        """What a sync that fails its gates goes back to: the live state of `names` (mesh copies, cheap: the arrays are
        shared until one side changes), the history's books, the applied ops and the op records."""
        h = self.history
        return {"live": {n: h.copy(n) for n in names},
                "entries": {n: [list(e) for e in lst] for n, lst in h.entries.items()},
                "broken": list(h.broken), "ops": self.ops, "opEntries": dict(self.entries),
                "records": {k: dict(v) for k, v in self.app.runner.records.items()}}

    def revert(self, undo):
        """Back to the undo point: every object of it as it was before the sync (the ones the sync made are removed),
        the history, ops and records too, so the next sync diffs against what the FBX folder still holds."""
        h = self.history
        kept = {e[1] for lst in undo["entries"].values() for e in lst if e[1]}
        h.free([e[1] for lst in h.entries.values() for e in lst if e[1] and e[1] not in kept])
        back = sa.History()  # one entry per object: History.restore puts it back (or removes it: absent before)
        back.entries = {n: [[0, snap[0], snap[1]]] for n, snap in undo["live"].items()}
        for n in sorted(back.entries):
            back.restore(n, 0)
        h.free([snap[0] for snap in undo["live"].values() if snap[0]])
        h.entries, h.broken = undo["entries"], undo["broken"]
        self.ops, self.entries = undo["ops"], undo["opEntries"]
        self.app.runner.records = undo["records"]
        sa.object_mode()
        self.app.ctx.forget()
        self.app.ctx.refresh()

    def drop_undo(self, undo):
        """The gates passed: free the undo point's copies and the history entries the sync replaced."""
        h = self.history
        live = {e[1] for lst in h.entries.values() for e in lst if e[1]}
        h.free([e[1] for lst in undo["entries"].values() for e in lst if e[1] and e[1] not in live]
               + [snap[0] for snap in undo["live"].values() if snap[0]])

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


# ------------------------------------------------------------ the sync's gates


def face_findings(names):
    """course_check's per-object checks on these objects, its upside-down-on-top and NaN findings kept:
    {name: {"flipped"|"nan": {severity, faces, note, at: [x, y] | None}}}."""
    import course_check
    out = {}

    def add(kind, severity, note, objects, at):
        if kind not in ("flipped", "nan"):
            return
        faces = note.split(" ", 1)[0]
        out.setdefault(objects[0], {})[kind] = {
            "severity": severity, "faces": int(faces) if faces.isdigit() else None, "note": note,
            "at": None if at is None else [round(float(at[0]), 3), round(float(at[1]), 3)]}

    objs = [bpy.data.objects[n] for n in names if n in bpy.data.objects and bpy.data.objects[n].type == "MESH"]
    if objs:
        course_check.object_checks(objs, course_check.Area(), add)
    return out


def _spot(xy, frame):
    if not xy:
        return {}
    out = {"blend": [round(float(xy[0]), 3), round(float(xy[1]), 3)]}
    if frame is not None:
        import shape_coords
        e, n = shape_coords.from_blend(float(xy[0]), float(xy[1]), frame)
        out["epsg3006"] = [round(e, 2), round(n, 2)]
    return out


def gate_check(seams, tj, tj_before, faces, faces_before, frame, allow=False):
    """The sync's gates on what it changed: a seam gap > GATE_GAP_M, a T-junction step >= GATE_TJUNCTION_M, upside-down
    faces on top (course_check: slivers under its SLIVER_M2 are only a warning there and here), NaN vertices. Only
    what the sync made or made worse fails (`failures`); the same found already before it is `preExisting` (an OPCD
    gap must not block every sync near it). Every finding names its objects and its EPSG:3006 spot.
    -> {ok, allowGaps, limits, failures, preExisting, warnings: [str]}; with `allow` the failures are warnings."""
    fails, pre = [], []
    for g in seams.get("gaps") or []:
        if g["maxAbsDz"] <= GATE_GAP_M:
            continue
        (fails if g["new"] else pre).append(dict(type="seamGap", objects=g["objects"], maxAbsDz=round(g["maxAbsDz"], 4),
                                                 points=g["gaps"], **_spot(g.get("at"), frame)))
    for n, r in sorted(tj.items()):
        if r["maxAbsDz"] < GATE_TJUNCTION_M:
            continue
        new = r["maxAbsDz"] > (tj_before.get(n) or {}).get("maxAbsDz", 0.0) + 1e-6
        (fails if new else pre).append(dict(type="tJunction", objects=[n], maxAbsDz=r["maxAbsDz"], points=r["gaps"],
                                            **_spot(r.get("at"), frame)))
    for n, f in sorted(faces.items()):
        old = faces_before.get(n) or {}
        if "nan" in f:
            (pre if "nan" in old else fails).append(dict(type="nan", objects=[n], **_spot(f["nan"]["at"], frame)))
        fl = f.get("flipped")
        if fl and fl["severity"] == "error":
            was = old.get("flipped")
            new = not was or was["severity"] != "error" or (fl["faces"] or 0) > (was["faces"] or 0)
            (fails if new else pre).append(dict(type="flipped", objects=[n], faces=fl["faces"], note=fl["note"],
                                                **_spot(fl["at"], frame)))
    warnings = [f"allowGaps: exported anyway: {describe_gate(f)}" for f in fails] if allow else []
    warnings += [f"already there before this sync: {describe_gate(f)}" for f in pre]
    return {"ok": not fails, "allowGaps": allow, "limits": {"gapM": GATE_GAP_M, "tJunctionM": GATE_TJUNCTION_M},
            "failures": fails, "preExisting": pre, "warnings": warnings}


def describe_gate(f):
    where = f" at EPSG:3006 {f['epsg3006'][0]:.2f}, {f['epsg3006'][1]:.2f}" if f.get("epsg3006") else (
        f" at blend {f['blend'][0]:.2f}, {f['blend'][1]:.2f}" if f.get("blend") else "")
    if f["type"] == "seamGap":
        return f"seam gap {f['maxAbsDz'] * 100:.1f} cm between {f['objects'][0]} and {f['objects'][1]}{where}"
    if f["type"] == "tJunction":
        return f"T-junction step {f['maxAbsDz'] * 100:.1f} cm on {f['objects'][0]}{where}"
    if f["type"] == "flipped":
        return f"{f['faces']} upside-down face(s) on top of {f['objects'][0]}{where}"
    return f"vertices without a position (NaN) in {f['objects'][0]}{where}"


def gate_message(fails, shown=6):
    more = f" (+{len(fails) - shown} more)" if len(fails) > shown else ""
    return (f"{len(fails)} gap check(s) failed, so nothing was exported and the objects are back as they were before "
            f"this sync: {'; '.join(describe_gate(f) for f in fails[:shown])}{more}. Fix the layer, or sync with "
            "{\"allowGaps\": true} to export anyway")


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

        def allowed(self):
            """With a shared secret set, every request must carry it (a worker on 0.0.0.0 is reachable)."""
            if not worker.token:
                return True
            if self.headers.get(TOKEN_HEADER) == worker.token:
                return True
            # The body is never read, so the connection cannot be kept alive: what is left of
            # the refused request would be parsed as the next one ("Bad request syntax").
            self.close_connection = True
            self.send_json(401, {"error": f"{TOKEN_HEADER} is missing or wrong"})
            return False

        def do_GET(self):
            if not self.allowed():
                return
            path = self.path.split("?")[0]
            if path == "/status":
                self.send_json(200, worker.get_status())
            elif path.startswith("/job/"):
                job = worker.job_by_id(path[len("/job/"):])
                if job is None:
                    self.send_json(404, {"error": "no job " + path[len("/job/"):]})
                else:
                    self.send_json(200, job)
            else:
                self.send_json(404, {"error": "unknown path " + self.path})

        def do_POST(self):
            if not self.allowed():
                return
            parts = urllib.parse.urlsplit(self.path)
            kind = {"/load": "load", "/sync": "sync", "/check": "check", "/shutdown": "shutdown"}.get(parts.path)
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
            wait = kind == "shutdown" or truthy(urllib.parse.parse_qs(parts.query).get("wait"))
            job, busy = worker.submit(kind, body, alone=kind != "shutdown")
            if job is None:
                self.send_json(409, {"error": f"a {busy.kind} job is already going (job {busy.id}"
                                              f"{', ' + busy_phase(worker) if busy_phase(worker) else ''}): wait for it",
                                     "job": busy.id, "kind": busy.kind, "state": "running"})
                return
            if not wait:
                self.send_json(202, {"job": job.id, "kind": kind, "state": "running"})
                return
            job.done.wait()
            self.send_json(job.code, job.result)

    return Handler


def truthy(values):
    return bool(values) and str(values[0]).lower() not in ("", "0", "false", "no")


def busy_phase(worker):
    return worker.get_status().get("phase")


def main(argv):
    ap = argparse.ArgumentParser(prog="shape_worker.py")
    ap.add_argument("--port", type=int, default=int(os.environ.get("GOLFMAP_SHAPING_PORT", DEFAULT_PORT)))
    ap.add_argument("--host", default=os.environ.get("GOLFMAP_SHAPING_HOST", DEFAULT_HOST),
                    help="interface to listen on (default 127.0.0.1; 0.0.0.0 for a server on another machine)")
    ap.add_argument("--token", default=os.environ.get("GOLFMAP_SHAPING_TOKEN", ""),
                    help=f"shared secret every request must carry as {TOKEN_HEADER} (default $GOLFMAP_SHAPING_TOKEN)")
    ap.add_argument("--blend", help="course .blend or its .conformed.blend: loaded at start")
    ap.add_argument("--layers", help="shaping layers folder (docs/gspro/<course>/shaping)")
    ap.add_argument("--fbx-folder", help="FBX folder /sync exports into (e.g. the Unity project's Assets/fbx)")
    ap.add_argument("--svg")
    ap.add_argument("--sidecar")
    ap.add_argument("--no-cache", action="store_true", help="do not use the op-result cache")
    args = ap.parse_args(argv)
    worker = Worker(args)
    server = ThreadingHTTPServer((args.host, args.port), make_handler(worker))
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, name="shape_worker-http", daemon=True).start()
    print(f"[shape_worker] listening on http://{args.host}:{args.port} (pid {os.getpid()}"
          f"{', token required' if worker.token else ''})")
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
