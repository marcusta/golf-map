"""Carry-over: give a new OPCD build the previous build's source mesh wherever its SVG shape did not change.

OPCD rebuilds every shape of an SVG on each cloud build, and an unchanged shape comes back with ~1 mm of
vertex jitter or a new triangulation, so none of its meshes hash equal to the previous build's: the conform
cache and the shaping op cache (both keyed on mesh state) go cold for the whole course on every build. Before
the conform, `shape_prepare` therefore puts the previous build's source mesh back for every mesh whose shape is
unchanged, so both caches hit for it again.

What "unchanged" means:

- **The shape.** Every SVG export writes `<stem>-shapes.json` (`gspro.py svg`, `golfmap-svg-shape-fingerprints-v1`):
  per SVG id a 12-hex fingerprint of the path's layer, style, fill-rule and `d`. The ids stay the mesh names;
  the fingerprint is never part of a name. The table used is the one beside the SVG that built the .blend
  (`choose_build_svg`: the SVG next to the .blend or in `export-history/` that explains its shape ids best,
  on a tie the newest written before the .blend). A mesh depends on its own shape; a blend (`opcd_kind` blend, `_B_` in the
  name) and an Outer_Deep_Sat fill piece (OPCD's fill between the shapes, no SVG shape of its own) also on
  every shape whose mesh shares a border vertex with it (`depends_on`) - the shapes it joins or fills
  between - and on that set staying the same. A fill piece that borders only other fill pieces depends on no
  shape: its border alone decides.
- **The mesh.** Same name in both builds, the same attribute set, materials and vertex groups, and either
  the same topology (counts, edges, corners, polygons) with the integer attributes equal and every vertex
  within `MAX_MOVE_M` (5 mm) of the old one, or - OPCD filled the same outline anew, which it does to about
  one mesh in five - the same border: as many border vertices, each within 5 mm of its own old one
  (`match_border`). Every array (positions, topology, UVs, colours) is then the old mesh's.
- **The seams.** OPCD's meshes tile the course, so both sides of a seam must come from one build. By default
  (the weld) every mesh that passes the two checks above is swapped, and a kept neighbour (another
  triangulation, an edited shape, a fill piece, a new mesh - anything not bit-identical) takes the swapped
  mesh's position at every border vertex they shared in the new build (`weld_plan`; at most the 5 mm the
  swapped mesh moved, ~1 mm on Omberg). The kept mesh misses both caches either way. The strict rule asked
  for first (`GOLFMAP_CARRY_SEAMS=strict`: swap a mesh only if every mesh sharing a border vertex with it is
  swapped too or bit-identical, `settle_clusters`) swaps nothing on a real course: every mesh is joined to
  every other through seams, and one retriangulated mesh anywhere blocks the lot (Omberg svg_108 -> svg_107:
  0 of 746). After the swap and the weld every border vertex pair that coincided in the new build is checked
  again (`seam_check`); any gap puts every swap and weld back (never expected; reported).

The swap writes the old mesh's arrays (positions, topology, UVs, paint, ...) onto the new object but keeps the
new object's custom properties (OPCD's `opcd_*` ids; when they equal the old ones, as they do for an unchanged
shape, the mesh state is the old one bit for bit and both caches hit).

State on disk, in `<blend folder>/shaping-staging/carry-over/`:

- `builds/<source stem>.json` (`golfmap-carry-over-build-v1`): per prepared source .blend the SVG and shape
  table it was built from and per Spline mesh its state hash (after the carry-over), shapes and neighbours.
  The previous build is the newest record of a source .blend older than this one (`Store.previous`).
- `meshes/<sha[:2]>/<sha>.npz`: the source mesh states by state hash (shape_apply.OpCache), shared by builds;
  only the newest `KEEP_BUILDS` records and the states they name are kept.
"""

import json
import os
import re
import time

import numpy as np

import shape_layers as sl

FORMAT = "golfmap-carry-over-v1"
BUILD_FORMAT = "golfmap-carry-over-build-v1"
SHAPES_FORMAT = "golfmap-svg-shape-fingerprints-v1"
MAX_MOVE_M = 0.005          # a vertex further than this from the old one: the mesh is not the same shape
SEAM_XY = 1e-4              # border vertices this close in XY are one seam vertex (shape_apply.SEAM_XY)
KEEP_BUILDS = 4
OUTER_FILL = re.compile(r"Outer_Deep_Sat", re.I)
TOPOLOGY_KEYS = ("poly_start",)
TOPOLOGY_ATTRS = (".corner_vert", ".corner_edge", ".edge_verts")
POSITION_KEY = "a|position|POINT|FLOAT_VECTOR"
ENV_OFF = "GOLFMAP_PREPARE_NO_CARRY_OVER"
SEAMS_ENV = "GOLFMAP_CARRY_SEAMS"   # weld (default) | strict

REASONS = {
    "swapped": "the previous build's mesh put back",
    "identical": "bit-identical to the previous build's (nothing to do)",
    "new": "no mesh of that name in the previous build",
    "noShape": "no SVG shape for it (or for a mesh a blend or fill piece borders) in this build's table",
    "shapeChanged": "its shape's fingerprint changed, or one a blend / fill piece borders, or the set it borders",
    "topology": "another border: other border vertex counts, or a border vertex more than 5 mm off",
    "attributes": "other attributes, materials or vertex groups",
    "moved": "a vertex moved more than 5 mm",
    "seam": "(strict seams) a mesh sharing a border vertex with it is neither swapped nor identical",
    "seamCheck": "the seam check after the swap found a gap (every swap and weld put back to OPCD's)",
}


# ---------------------------------------------------------------- pure parts (numpy, no bpy)


def shapes_table_path(svg_path):
    return os.path.splitext(svg_path)[0] + "-shapes.json"


def read_shapes_table(svg_path):
    """{svg id: fingerprint} from `<stem>-shapes.json` beside the SVG, or None when it has none."""
    try:
        with open(shapes_table_path(svg_path), encoding="utf-8") as f:
            doc = json.load(f)
    except (OSError, ValueError):
        return None
    if not isinstance(doc, dict) or doc.get("format") != SHAPES_FORMAT or not isinstance(doc.get("shapes"), dict):
        return None
    return doc["shapes"]


def svg_candidates(folder):
    """Every SVG next to the .blend and in its export snapshots (`export-history/<stamp>/`)."""
    out = sorted(os.path.join(folder, f) for f in os.listdir(folder) if f.lower().endswith(".svg"))
    history = os.path.join(folder, "export-history")
    if os.path.isdir(history):
        for d in sorted(os.listdir(history)):
            sub = os.path.join(history, d)
            if os.path.isdir(sub):
                out += sorted(os.path.join(sub, f) for f in os.listdir(sub) if f.lower().endswith(".svg"))
    return out


def choose_build_svg(candidates, shape_ids, blend_mtime):
    """The SVG a .blend was built from: of the candidates ({path: parsed svg}) that explain its shape ids best
    (`shape_layers.score_svg`: most resolved, fewest unused), the newest written no later than the .blend
    (OPCD saves the .blend after the export it built), else the newest. Returns (path, score) or (None, None)."""
    scored = []
    for path, paths in candidates.items():
        sc = sl.score_svg(paths, shape_ids)
        scored.append((path, sc, os.path.getmtime(path) if os.path.exists(path) else 0.0))
    if not scored:
        return None, None
    best = max((s["resolved"], -len(s["unused"])) for _, s, _ in scored)
    top = [t for t in scored if (t[1]["resolved"], -len(t[1]["unused"])) == best]
    before = [t for t in top if t[2] <= blend_mtime + 1.0]
    path, score, _ = max(before or top, key=lambda t: (t[2], t[0]))
    return path, score


def _topology(arrays):
    keys = [k for k in arrays if k in TOPOLOGY_KEYS or (k.startswith("a|") and k.split("|")[1] in TOPOLOGY_ATTRS)]
    return keys


def _key(arrays, name):
    return next((k for k in arrays if k.startswith("a|%s|" % name)), None)


def border_of(arrays):
    """(vertex ids, xy (n, 2)) of a captured mesh's border vertices (on edges with one face)."""
    ek, ck = _key(arrays, ".edge_verts"), _key(arrays, ".corner_edge")
    co = arrays[POSITION_KEY].reshape(-1, 3).astype(np.float64)
    if ek is None or ck is None or not len(arrays[ek]):
        return np.zeros(0, np.int64), np.zeros((0, 2))
    ev = arrays[ek].reshape(-1, 2)
    faces = np.bincount(arrays[ck], minlength=len(ev))
    v = np.unique(ev[faces == 1]).astype(np.int64)
    return v, co[v, :2]


def match_border(new_xy, old_xy, tol=MAX_MOVE_M):
    """For every new border vertex the old one it is (index into `old_xy`, nearest within `tol`), or None when
    the two borders are not the same: other counts, a vertex without a partner, two sharing one.
    Returns (match, largest distance)."""
    if len(new_xy) != len(old_xy):
        return None, None
    if not len(new_xy):
        return np.zeros(0, np.int64), 0.0
    cells = {}
    for i, (x, y) in enumerate(np.floor(old_xy / tol).astype(np.int64).tolist()):
        cells.setdefault((x, y), []).append(i)
    old = old_xy.tolist()
    match = np.full(len(new_xy), -1, np.int64)
    dist = np.zeros(len(new_xy))
    for i, ((cx, cy), (px, py)) in enumerate(zip(np.floor(new_xy / tol).astype(np.int64).tolist(), new_xy.tolist())):
        best, bd = -1, tol * tol
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for j in cells.get((cx + dx, cy + dy), ()):
                    d = (old[j][0] - px) ** 2 + (old[j][1] - py) ** 2
                    if d <= bd:
                        best, bd = j, d
        if best < 0:
            return None, None
        match[i], dist[i] = best, bd
    if len(np.unique(match)) != len(match):
        return None, None
    return match, float(np.sqrt(dist.max()))


def compare_mesh(old_meta, old, new_meta, new, max_move=MAX_MOVE_M):
    """(code, detail) for one mesh present in both builds: 'identical', 'swap' (the same shape: jittered, or
    retriangulated inside the same border), 'topology' (another border), 'attributes' or 'moved'.

    Same topology: every vertex within `max_move` of the old one ('moved' when not), the integer attributes
    equal. Another topology (OPCD filled the same outline again): the same border - as many border vertices,
    each within `max_move` of its own old one (`match_border`); then `detail["vmap"]` = (new border vertex
    ids, the old mesh's vertex ids for them), which the weld and the seam check go by. `moveM` is the largest
    move (of any vertex, or of a border vertex)."""
    if set(old) != set(new):
        return "attributes", {"keys": sorted(set(old) ^ set(new))}
    for f in ("materials", "vgroups", "matrix"):
        if old_meta.get(f) != new_meta.get(f):
            return "attributes", {"meta": f}
    same_topology = old_meta["counts"] == new_meta["counts"] and all(
        np.array_equal(old[k], new[k]) for k in _topology(new))
    if not same_topology:
        bv_new, b_new = border_of(new)
        bv_old, b_old = border_of(old)
        match, move = match_border(b_new, b_old, max_move)
        if match is None:
            return "topology", {"counts": [old_meta["counts"], new_meta["counts"]],
                                "border": [len(bv_old), len(bv_new)]}
        return "swap", {"moveM": move, "retriangulated": True, "vmap": (bv_new, bv_old[match])}
    for k in new:
        if k == POSITION_KEY or k in _topology(new):
            continue
        a, b = old[k], new[k]
        if a.shape != b.shape:
            return "attributes", {"array": k}
        if a.dtype.kind != "f" and not np.array_equal(a, b):
            return "attributes", {"array": k}
    po = old[POSITION_KEY].reshape(-1, 3).astype(np.float64)
    pn = new[POSITION_KEY].reshape(-1, 3).astype(np.float64)
    if np.array_equal(old[POSITION_KEY], new[POSITION_KEY]):
        same = all(np.array_equal(old[k], new[k]) for k in new)
        if same and old_meta.get("props") == new_meta.get("props"):
            return "identical", {"moveM": 0.0}
        return "swap", {"moveM": 0.0}
    move = float(np.sqrt(((po - pn) ** 2).sum(1)).max()) if len(pn) else 0.0
    if move > max_move:
        return "moved", {"moveM": move}
    return "swap", {"moveM": move}


def seam_pairs(boundary, cell=2 * SEAM_XY):
    """Border vertex pairs of different meshes that coincide in XY: `boundary` = {name: (vertex ids, xy (n, 2))}.
    Returns (names, pairs) with pairs an int array (k, 4): owner a, vertex a, owner b, vertex b (a < b by
    owner index). Four grids offset by half a cell, so every pair closer than `cell / 2` on both axes shares a
    cell in at least one of them."""
    names = sorted(n for n in boundary if len(boundary[n][0]))
    if not names:
        return names, np.zeros((0, 4), np.int64)
    owner = np.concatenate([np.full(len(boundary[n][0]), i, np.int64) for i, n in enumerate(names)])
    vid = np.concatenate([np.asarray(boundary[n][0], np.int64) for n in names])
    xy = np.concatenate([np.asarray(boundary[n][1], np.float64).reshape(-1, 2) for n in names])
    found = []
    half = cell / 2.0
    for ox, oy in ((0.0, 0.0), (half, 0.0), (0.0, half), (half, half)):
        k = np.floor((xy + (ox, oy)) / cell).astype(np.int64)
        key = (k[:, 0] - k[:, 0].min()) * (int(k[:, 1].max() - k[:, 1].min()) + 1) + (k[:, 1] - k[:, 1].min())
        order = np.argsort(key, kind="stable")
        ks = key[order]
        start = np.flatnonzero(np.r_[True, ks[1:] != ks[:-1]])
        size = np.diff(np.r_[start, len(ks)])
        two = start[size == 2]
        a, b = order[two], order[two + 1]
        found.append(np.stack([a, b], 1))
        for s, n in zip(start[size > 2].tolist(), size[size > 2].tolist()):
            idx = order[s:s + n]
            ii, jj = np.triu_indices(n, 1)
            found.append(np.stack([idx[ii], idx[jj]], 1))
    p = np.concatenate(found) if found else np.zeros((0, 2), np.int64)
    p = p[owner[p[:, 0]] != owner[p[:, 1]]]
    d = np.abs(xy[p[:, 0]] - xy[p[:, 1]]).max(1) if len(p) else np.zeros(0)
    p = p[d <= cell / 2.0 + 1e-12]
    swap = owner[p[:, 0]] > owner[p[:, 1]]
    p[swap] = p[swap][:, ::-1]
    p = np.unique(p, axis=0) if len(p) else p
    return names, np.stack([owner[p[:, 0]], vid[p[:, 0]], owner[p[:, 1]], vid[p[:, 1]]], 1) if len(p) \
        else np.zeros((0, 4), np.int64)


def neighbours(names, pairs):
    """{name: sorted names it shares a border vertex with} from `seam_pairs`."""
    out = {n: set() for n in names}
    owners = np.unique(pairs[:, [0, 2]], axis=0) if len(pairs) else np.zeros((0, 2), np.int64)
    for a, b in owners.tolist():
        out[names[a]].add(names[b])
        out[names[b]].add(names[a])
    return {n: sorted(v) for n, v in out.items()}


def settle_clusters(candidates, identical, links):
    """The candidates that may be swapped: drop every one with a neighbour (`links` {name: neighbours}) that is
    neither a remaining candidate nor bit-identical, until nothing changes. Returns (swapped, {dropped: the
    neighbour that blocked it})."""
    keep = set(candidates)
    ok = keep | set(identical)
    blocked = {}
    changed = True
    while changed:
        changed = False
        for n in sorted(keep):
            bad = next((m for m in links.get(n, ()) if m not in ok), None)
            if bad is not None:
                keep.discard(n)
                ok.discard(n)
                blocked[n] = bad
                changed = True
    return keep, blocked


def weld_plan(pairs, swapped, frozen):
    """Where a kept mesh must follow a swapped one so no seam opens. `pairs` from `seam_pairs` (owner indices),
    `swapped` / `frozen` sets of owner indices (frozen = bit-identical: already where the old build had it).
    The border vertices that coincided in the new build form groups (union over the pairs); in a group with a
    swapped member every member that is neither swapped nor frozen takes that swapped member's vertex (the
    lowest owner index, so the choice is the same every run). Returns {kept owner: [(vertex, src owner, src
    vertex)]}; groups with two swapped members are left alone (their old vertices coincide, the seam check
    says if not)."""
    parent = {}

    def find(k):
        while parent.get(k, k) != k:
            parent[k] = parent.get(parent[k], parent[k])
            k = parent[k]
        return k

    for a, va, b, vb in pairs.tolist():
        ra, rb = find((a, va)), find((b, vb))
        if ra != rb:
            parent[max(ra, rb)] = min(ra, rb)
    groups = {}
    for a, va, b, vb in pairs.tolist():
        for k in ((a, va), (b, vb)):
            groups.setdefault(find(k), set()).add(k)
    out = {}
    for members in groups.values():
        src = sorted(k for k in members if k[0] in swapped)
        if not src:
            continue
        for o, v in sorted(members):
            if o not in swapped and o not in frozen:
                out.setdefault(o, []).append((v, src[0][0], src[0][1]))
    return out


def blend_shapes(name, own, links, shape_of, kinds):
    """The shapes a blend depends on: its own and those of every non-blend mesh it shares a border with."""
    out = {own} if own else set()
    for m in links.get(name, ()):
        if kinds.get(m) != "blend" and shape_of.get(m):
            out.add(shape_of[m])
    return sorted(out)


def is_blend(name, kind):
    return kind == "blend" or "_B_" in name


def depends_on(name, rec, links, shape_of, kinds):
    """The shapes a mesh depends on in one build: its own; for a blend or an Outer_Deep_Sat fill piece also
    those of every non-blend mesh it shares a border with (the shapes it joins, or fills between)."""
    own = rec.get("shape")
    if is_blend(name, rec.get("kind")) or OUTER_FILL.search(name):
        return blend_shapes(name, own, links, shape_of, kinds)
    return [own] if own else []


def plan(prev, cur, prev_shapes, cur_shapes, compare, seams="weld"):
    """Decide per mesh. `prev` / `cur`: {name: {shape, kind, links}} (links = neighbours in that build);
    `compare(name)` -> (code, detail) as compare_mesh. Returns {name: {code, ...}}, code one of REASONS. A mesh
    in both builds is compared first: one bit-identical to the previous build's is 'identical' whatever else
    holds, so it never needs a weld."""
    out = {}
    cand, ident = set(), set()
    views = {}
    for tag, src in (("cur", cur), ("prev", prev)):
        views[tag] = ({n: c.get("links", []) for n, c in src.items()},
                      {n: c.get("shape") for n, c in src.items()}, {n: c.get("kind") for n, c in src.items()})
    for name in sorted(cur):
        if name not in prev:
            out[name] = {"code": "new"}
            continue
        code, detail = compare(name)
        if code in ("identical", "new"):   # 'new' here: the previous build's state is gone from the store
            if code == "identical":
                ident.add(name)
            out[name] = dict(detail, code=code)
            continue
        shapes = depends_on(name, cur[name], *views["cur"])
        old = set(depends_on(name, prev[name], *views["prev"]))
        missing = [s for s in shapes if s not in cur_shapes]
        # a fill piece that borders only other fill pieces depends on no shape: its border alone decides
        if (not shapes and not OUTER_FILL.search(name)) or missing:
            out[name] = {"code": "noShape", "shapes": missing}
            continue
        changed = sorted({s for s in shapes if prev_shapes.get(s) != cur_shapes[s]} | (set(shapes) ^ old))
        if changed:
            out[name] = {"code": "shapeChanged", "shapes": changed}
            continue
        out[name] = dict(detail, code=code, shapes=shapes)
        if code == "swap":
            cand.add(name)
    links = {}
    for src in (cur, prev):
        for n, rec in src.items():
            for m in rec.get("links", []):
                links.setdefault(n, set()).add(m)
                links.setdefault(m, set()).add(n)
    swapped, blocked = settle_clusters(cand, ident, links) if seams == "strict" else (set(cand), {})
    for n in cand:
        out[n]["code"] = "swapped" if n in swapped else "seam"
        if n not in swapped:
            out[n]["blockedBy"] = blocked.get(n)
    return out


def _compact(d):
    out = {"code": d["code"]}
    if d.get("moveM"):
        out["moveMm"] = round(d["moveM"] * 1e3, 3)
    for k in ("blockedBy", "array", "meta", "counts", "border", "why", "welded", "retriangulated"):
        if d.get(k) is not None:
            out[k] = d[k]
    if d["code"] in ("shapeChanged", "noShape") and d.get("shapes"):
        out["shapes"] = d["shapes"]
    return out


def summarise(decisions, examples=5):
    counts = {}
    for d in decisions.values():
        counts[d["code"]] = counts.get(d["code"], 0) + 1
    ex = {}
    for n in sorted(decisions):
        c = decisions[n]["code"]
        if c not in ("swapped", "identical") and len(ex.setdefault(c, [])) < examples:
            ex[c].append(n + (" (by %s)" % decisions[n]["blockedBy"] if decisions[n].get("blockedBy") else ""))
    moves = [d["moveM"] for d in decisions.values() if d["code"] == "swapped" and "moveM" in d]
    return {"counts": dict(sorted(counts.items())), "examples": ex,
            "retriangulated": sum(1 for d in decisions.values() if d["code"] == "swapped" and d.get("retriangulated")),
            "swappedMoveMm": {"max": round(max(moves) * 1e3, 3), "median": round(float(np.median(moves)) * 1e3, 3)}
            if moves else None}


# ---------------------------------------------------------------- the store


class Store:
    """`<staging>/carry-over/`: build records + mesh states by hash."""

    def __init__(self, staging_dir):
        import shape_apply as sa
        self.dir = os.path.join(staging_dir, "carry-over")
        self.builds = os.path.join(self.dir, "builds")
        self.meshes = sa.OpCache(os.path.join(self.dir, "meshes"))

    def record_path(self, source):
        return os.path.join(self.builds, os.path.splitext(os.path.basename(source))[0] + ".json")

    def records(self):
        out = []
        if not os.path.isdir(self.builds):
            return out
        for f in sorted(os.listdir(self.builds)):
            if not f.endswith(".json"):
                continue
            try:
                with open(os.path.join(self.builds, f), encoding="utf-8") as fh:
                    doc = json.load(fh)
            except (OSError, ValueError):
                continue
            if isinstance(doc, dict) and doc.get("format") == BUILD_FORMAT:
                out.append(doc)
        return out

    def previous(self, source):
        """The build before this one: of the records of other source .blends, the newest built before it (by the
        .blend's mtime), else the newest of them (a re-prepared older build). None when there is none."""
        me = os.path.normcase(os.path.abspath(source))
        mtime = os.path.getmtime(source) if os.path.exists(source) else float("inf")
        others = [r for r in self.records() if os.path.normcase(os.path.abspath(r.get("source") or "")) != me]
        older = [r for r in others if (r.get("sourceMtime") or 0) < mtime]
        return max(older or others, key=lambda r: (r.get("sourceMtime") or 0, r.get("preparedAt") or ""), default=None)

    def write(self, record, states):
        """Write a build record and the mesh states it names that the store does not hold yet."""
        written = 0
        for sha, (meta, arrays) in states.items():
            if not os.path.isfile(self.meshes.path(sha)):
                self.meshes.store(sha, {"format": FORMAT, "meta": meta}, arrays)
                written += 1
        os.makedirs(self.builds, exist_ok=True)
        path = self.record_path(record["source"])
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(record, f, indent=0)
        os.replace(tmp, path)
        return path, written

    def load_state(self, sha):
        entry = self.meshes.load(sha)
        if entry is None:
            return None
        return entry[0].get("meta"), entry[1]

    def prune(self, keep=KEEP_BUILDS):
        """Keep the `keep` newest build records (by when they were prepared) and the mesh states they name."""
        recs = sorted(self.records(), key=lambda r: r.get("preparedAt") or "", reverse=True)
        for r in recs[keep:]:
            try:
                os.remove(self.record_path(r["source"]))
            except OSError:
                pass
        wanted = {m["sha"] for r in recs[:keep] for m in (r.get("meshes") or {}).values() if m.get("sha")}
        removed = 0
        root = self.meshes.folder
        if os.path.isdir(root):
            for sub in os.listdir(root):
                d = os.path.join(root, sub)
                if not os.path.isdir(d):
                    continue
                for f in os.listdir(d):
                    if f.endswith(".npz") and f[:-4] not in wanted:
                        try:
                            os.remove(os.path.join(d, f))
                            removed += 1
                        except OSError:
                            pass
        return removed


# ---------------------------------------------------------------- in Blender


def _boundary(obj, arrays=None):
    """(vertex ids, xy) of an object's border vertices (edges with one face), world XY."""
    import shape_apply as sa
    me = obj.data
    if not len(me.edges):
        return np.zeros(0, np.int64), np.zeros((0, 2))
    ev = np.empty(len(me.edges) * 2, dtype=np.int32)
    me.edges.foreach_get("vertices", ev)
    le = np.empty(len(me.loops), dtype=np.int32)
    me.loops.foreach_get("edge_index", le)
    faces = np.bincount(le, minlength=len(me.edges))
    verts = np.unique(ev.reshape(-1, 2)[faces == 1])
    co = sa.positions(obj)[verts].astype(np.float64)
    m = np.array(obj.matrix_world)
    return verts.astype(np.int64), (co @ m[:3, :3].T + m[:3, 3])[:, :2]


def seam_check(objs_by_name, pairs, names, touched, tol=2 * SEAM_XY, vmaps=None):
    """Of the border vertex pairs `seam_pairs` found in the build as OPCD made it, those touching a mesh in
    `touched` whose two vertices no longer coincide in XY: {name: count} of the meshes involved. `vmaps`
    {name: vertex id map} for meshes swapped for one of another topology (new build's id -> the mesh's now)."""
    import shape_apply as sa
    vmaps = vmaps or {}
    idx = {n: i for i, n in enumerate(names)}
    hit = np.zeros(len(names), bool)
    hit[[idx[n] for n in touched if n in idx]] = True
    sel = pairs[hit[pairs[:, 0]] | hit[pairs[:, 2]]] if len(pairs) else pairs
    bad = {}
    if not len(sel):
        return bad
    pos = {i: sa.positions(objs_by_name[names[i]])[:, :2].astype(np.float64) for i in np.unique(sel[:, [0, 2]]).tolist()}
    owners = np.unique(sel[:, [0, 2]], axis=0)
    for a, b in owners.tolist():
        p = sel[(sel[:, 0] == a) & (sel[:, 2] == b)]
        va = vmaps[names[a]][p[:, 1]] if names[a] in vmaps else p[:, 1]
        vb = vmaps[names[b]][p[:, 3]] if names[b] in vmaps else p[:, 3]
        n = int((np.abs(pos[a][va] - pos[b][vb]).max(1) > tol).sum())
        if n:
            bad[names[a]] = bad.get(names[a], 0) + n
            bad[names[b]] = bad.get(names[b], 0) + n
    return bad


def carry_over(source, staging_dir, enabled=True):
    """Run the carry-over on the open (fresh) source .blend before the conform. Returns (report, finish) where
    `finish()` writes this build's record once the prepare has saved its result (and prunes the store)."""
    import bpy
    import shape_apply as sa
    t_start = time.time()
    report = {"format": FORMAT, "used": False}
    store = Store(staging_dir)
    objs = sorted((o for o in sa.spline_meshes()), key=lambda o: o.name)
    by_name = {o.name: o for o in objs}
    folder = os.path.dirname(os.path.abspath(source))

    # which SVG built this .blend, and its shape table
    t0 = time.time()
    shape_ids = sorted({o.get("opcd_shape_id") for o in objs if o.get("opcd_shape_id")})
    cands = {}
    for p in svg_candidates(folder):
        try:
            cands[p] = sl.load_svg(p)
        except (OSError, UnicodeDecodeError):
            continue
    svg, score = choose_build_svg(cands, shape_ids, os.path.getmtime(source))
    shapes = read_shapes_table(svg) if svg else None
    index = sl.build_index(sa._index_objects(), cands[svg]) if svg else []
    shape_of = {r["name"]: r.get("svgId") for r in index}
    kind_of = {r["name"]: r.get("kind") for r in index}
    report.update(svg=svg, svgResolved=score and score["resolved"], svgShapes=score and score["shapes"],
                  shapesTable=shapes_table_path(svg) if (svg and shapes is not None) else None,
                  svgS=round(time.time() - t0, 1))

    # this build's states and seams as OPCD made them
    t0 = time.time()
    states = {o.name: sa.capture_state(o) for o in objs}
    boundary = {o.name: _boundary(o) for o in objs}
    names, pairs = seam_pairs(boundary)
    links = neighbours(names, pairs)
    report["captureS"] = round(time.time() - t0, 1)

    prev = store.previous(source) if enabled else None
    decisions, posted = {}, {}
    if not enabled:
        report["skipped"] = "carry-over off (%s / --no-carry-over)" % ENV_OFF
    elif shapes is None:
        report["skipped"] = ("no shape table beside %s: run `bun run py gspro.py svg-shapes <svg>`" % svg) if svg \
            else "no SVG explains this .blend's shape ids"
    elif prev is None:
        report["skipped"] = "no previous build recorded in %s (the next build carries over from this one)" % store.dir
    elif not prev.get("shapes"):
        report["skipped"] = "the previous build (%s) has no shape table" % os.path.basename(prev.get("source") or "?")
    else:
        t0 = time.time()
        report["previous"] = {"source": prev.get("source"), "svg": prev.get("svg"), "preparedAt": prev.get("preparedAt")}
        old_states = {}

        def old_state(name):
            if name not in old_states:
                m = prev["meshes"].get(name) or {}
                old_states[name] = store.load_state(m["sha"]) if m.get("sha") else None
            return old_states[name]

        def compare(name):
            st = old_state(name)
            if st is None:
                return "new", {"why": "state not in the store"}
            meta_new, arr_new = states[name]
            meta_old, arr_old = st
            return compare_mesh(meta_old, arr_old, meta_new, arr_new)

        cur = {n: {"shape": shape_of.get(n), "kind": kind_of.get(n), "links": links.get(n, [])} for n in by_name}
        seams = "strict" if os.environ.get(SEAMS_ENV, "weld").lower() == "strict" else "weld"
        decisions = plan(prev["meshes"], cur, prev["shapes"], shapes, compare, seams)
        report["seamRule"] = seams
        report["planS"] = round(time.time() - t0, 1)

        # the swap: the old arrays onto the object, its own custom properties kept
        t0 = time.time()
        swapped = sorted(n for n, d in decisions.items() if d["code"] == "swapped")
        props_differ = 0
        vmaps = {}   # swapped for a mesh of another topology: new build's border vertex id -> the old mesh's
        for n in swapped:
            vm = decisions[n].pop("vmap", None)
            if vm is not None:
                full = np.full(states[n][0]["counts"][0], -1, np.int64)
                full[vm[0]] = vm[1]
                vmaps[n] = full
            meta_old, arr_old = old_state(n)
            props_differ += int(meta_old.get("props") != states[n][0]["props"])
            by_name[n] = sa.apply_state(n, dict(meta_old, props=states[n][0]["props"]), arr_old)
        # the weld: a kept mesh's border vertices on a swapped mesh's seam follow it (<= 5 mm, as it moved)
        idx = {n: i for i, n in enumerate(names)}
        frozen = {idx[n] for n, d in decisions.items() if d["code"] == "identical" and n in idx}
        plan_w = weld_plan(pairs, {idx[n] for n in swapped if n in idx}, frozen)
        welded, weld_moves = [], []
        for o, items in sorted(plan_w.items()):
            n = names[o]
            obj = by_name[n]
            co = sa.positions(obj).copy()
            for v, so, sv in items:
                src_name = names[so]
                src = sa.positions(by_name[src_name])[vmaps[src_name][sv] if src_name in vmaps else sv]
                weld_moves.append(float(np.sqrt(((co[v].astype(np.float64) - src) ** 2).sum())))
                co[v] = src
            obj.data.vertices.foreach_set("co", co.ravel())
            obj.data.update()
            welded.append(n)
            decisions.setdefault(n, {"code": "new"})["welded"] = len(items)
        touched = swapped + welded
        opened = seam_check(by_name, pairs, names, touched, vmaps=vmaps)
        if opened:  # never expected: put every swap and weld back, this build as OPCD made it
            for n in touched:
                by_name[n] = sa.apply_state(n, *states[n])
                if decisions.get(n, {}).get("code") == "swapped":
                    decisions[n]["code"] = "seamCheck"
                decisions.get(n, {}).pop("welded", None)
            swapped, welded, touched = [], [], []
        for n in touched:
            posted[n] = sa.capture_state(by_name[n])
        report["swapS"] = round(time.time() - t0, 1)
        report["propsDiffer"] = props_differ
        report["seams"] = {"pairs": int(len(pairs)), "openedBySwap": sum(opened.values()) // 2,
                           "openAfter": sum(seam_check(by_name, pairs, names, list(opened)).values()) // 2 if opened else 0}
        if opened:
            vmaps = {}
        weld_moves = [m for m in weld_moves if m > 0.0]   # most already sat exactly where the swapped mesh has them
        report["weld"] = {"meshes": len(welded), "vertices": len(weld_moves),
                          "maxMm": round(max(weld_moves) * 1e3, 3) if weld_moves else 0.0,
                          "medianMm": round(float(np.median(weld_moves)) * 1e3, 3) if weld_moves else 0.0}
        report.update(summarise(decisions), used=True)
        report["meshes"] = {n: _compact(d) for n, d in sorted(decisions.items())}
    report["links"] = links   # for the prepare's seam check after the conform; not kept in the report
    report["svgRel"] = os.path.relpath(svg, folder) if svg else None

    def finish():
        """Record this build - its meshes as the conform saw them - for the next one, then prune the store."""
        if not enabled or not svg:
            return None
        t1 = time.time()
        rec_states, meshes = {}, {}
        for n in by_name:
            st = posted.get(n) or states[n]
            sha = sa.state_hash(*st)
            rec_states[sha] = st
            m = {"sha": sha, "shape": shape_of.get(n), "kind": kind_of.get(n), "links": links.get(n, [])}
            if is_blend(n, kind_of.get(n)) or OUTER_FILL.search(n):   # what it was decided by, for reading
                m["shapes"] = depends_on(n, m, links, shape_of, kind_of)
            meshes[n] = m
        record = {"format": BUILD_FORMAT, "source": os.path.abspath(source),
                  "sourceMtime": os.path.getmtime(source), "svg": svg,
                  "shapes": shapes or {}, "meshes": meshes,
                  "preparedAt": time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime())}
        path, written = store.write(record, rec_states)
        removed = store.prune()
        return {"record": path, "statesWritten": written, "statesPruned": removed, "recordS": round(time.time() - t1, 1)}

    report["totalS"] = round(time.time() - t_start, 1)
    return report, finish


def summary_lines(rep):
    if not rep:
        return []
    if not rep.get("used"):
        return ["Carry-over: " + (rep.get("skipped") or "not run")]
    c = rep.get("counts") or {}
    lines = ["Carry-over from %s: %d swapped (%d of them retriangulated by OPCD), %d identical, %d kept as OPCD "
             "made them (svg %s)" % (
                 os.path.basename((rep.get("previous") or {}).get("source") or "?"), c.get("swapped", 0),
                 rep.get("retriangulated") or 0, c.get("identical", 0),
                 sum(v for k, v in c.items() if k not in ("swapped", "identical")), rep.get("svgRel") or "?")]
    why = ", ".join("%s %d" % (k, v) for k, v in sorted(c.items()) if k not in ("swapped", "identical"))
    if why:
        lines.append("  why not: " + why)
    if rep.get("swappedMoveMm"):
        lines.append("  swapped meshes moved back by up to {max} mm (median {median} mm)".format(**rep["swappedMoveMm"]))
    w = rep.get("weld") or {}
    if w.get("meshes"):
        lines.append("  {meshes} kept meshes welded to them: {vertices} of their border vertices moved, up to {maxMm} mm "
                     "(median {medianMm} mm)".format(**w))
    s = rep.get("seams") or {}
    if s.get("openedBySwap"):
        lines.append("  !! the swap opened %d seam vertex pairs: every swap and weld put back to OPCD's (%d pairs "
                     "still open)" % (s["openedBySwap"], s.get("openAfter", 0)))
    if rep.get("conformedSeams"):
        cs = rep["conformedSeams"]
        lines.append("  after the conform, swapped meshes and their neighbours: {points} shared border points, "
                     "{open} open, max dz {maxDz} m".format(**cs))
    return lines
