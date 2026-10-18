"""Steps in a run of water: where a creek or a chain of ponds drops from one level to the next (a weir, a sill, a
dam with a pipe), found on the lidar, and how to split the water there.

The lidar reads a water surface as a flat sheet (the few returns from the water, interpolated between the banks), so
a chain of ponds at different levels shows as flat runs with short, steep steps between them; a creek between ponds
shows as a steady fall. Each drawn body (a `water_creek` polygon, or a long `water` polygon) is read along its line
(`creeks.ribbon_centerline`):

- the profile: the in-water cells (the outline pulled in by INSET_M, off the banks) binned by their distance along
  the line, a low percentile per bin (water plants and reeds read a little high, never low), forced to fall
  downstream (`np.minimum.accumulate`, like the creek surface; downstream = the way the least-squares trend falls);
- a step: the profile falls at least `minDropM` within STEP_RUN_M; it sits where the profile is steepest, and its
  drop is the difference between the levels STEP_CLEAR_M either side;
- each run between steps is a pond (flat: falls less than RUN_FLAT_M + RUN_FLAT_SLOPE of its length, its level the
  median of its profile) or a creek (it keeps falling);
- the body is cut across its line at each step: a strip `sillM` wide is left out between the two waters (the weir's
  crest, a stone sill or a narrow earth dam), and the fall's lip is the downstream edge of that strip.

`cuts` and `skips` (points on the water) add a step the lidar does not show sharply (a sill under water plants reads
as a slope) and drop one found where there is none; a cut is kept whatever its drop.

Two bodies drawn apart (a dam with a pipe under it between two ponds, a path across) are joined by a fall too when
they come within `gapM` of each other at levels at least `minDropM` apart: an `outlet` fall at the lower water's edge
nearest the higher, OUTLET_WIDTH_M wide, the water coming out from under the crossing.

    python -m golfpipe.water_steps --input <request.json> --out <answer.json>   (or the request on stdin)
        request: {"dem": <path>, "bodies": [{"id", "shape", "type", "ring": [[e, n], ...]}, ...],
                  "minDropM"?, "sillM"?, "gapM"?, "cuts"?: [[e, n], ...], "skips"?: [[e, n], ...], "image"?, "ortho"?}
        -> {"bodies": [{"id", "shape", "line", "reversed", "profile": {"s", "z"}, "steps": n}],
            "pieces": [{"bodyId", "shape", "index", "kind": "pond"|"creek", "ring", "levelM", "topM", "bottomM",
                        "areaM2", "digLevelOffsetM"}],
            "falls": [{"style": "sill"|"outlet", "fromBodyId", "toBodyId", "fromPiece", "toPiece", "line", "at",
                       "flow", "topM", "bottomM", "dropM", "widthM", "sillM", "forced"}],
            "image": <path or null>}

A pond piece's `digLevelOffsetM` is what its `water-digs` edit needs to hold the water at the level found here: the
dig sets its level from the 25th percentile of the lidar within DIG_RIM_M of its outline (dem_edit.py), which a
piece cut out of a longer body can put a little off its water.
"""
from __future__ import annotations

import json
import sys

import numpy as np

INSET_M = 0.75          # the outline pulled in this far before the water is read (off the banks)
BIN_M = 1.0             # the profile's station spacing
BIN_HALF_M = 1.0        # each station reads the cells this far either side along the line
LOW_PERCENTILE = 10.0   # of the cells at a station: water plants and reeds read high, nothing reads low
STEP_RUN_M = 6.0        # a step falls minDropM within this
STEP_CLEAR_M = 1.5      # the levels either side are read from this far off the step ...
LEVEL_SPAN_M = 10.0     # ... over at most this
RUN_FLAT_M = 0.15       # a run is a pond when it falls less than this ...
RUN_FLAT_SLOPE = 0.002  # ... plus this much per metre of its length
OUTLET_WIDTH_M = 1.5    # an outlet fall's width
DEFAULT_MIN_DROP_M = 0.3
DEFAULT_SILL_M = 1.0
DEFAULT_GAP_M = 12.0
DIG_RIM_M = 2.0         # dem_edit.DEFAULT_DIG_RIM_M
DIG_LEVEL_PERCENTILE = 25.0  # dem_edit.DIG_LEVEL_PERCENTILE
MIN_PIECE_M2 = 4.0
PICK_M = 4.0            # an asked cut or skip takes the step this near (and must lie this near its body)


def _read_dem(path: str, bounds, pad: float = 6.0):
    import rasterio
    from rasterio.windows import from_bounds

    with rasterio.open(path) as src:
        w = from_bounds(bounds[0] - pad, bounds[1] - pad, bounds[2] + pad, bounds[3] + pad, src.transform)
        w = w.round_offsets().round_lengths()
        z = src.read(1, window=w, boundless=True, fill_value=np.nan).astype(np.float64)
        if src.nodata is not None:
            z[z == src.nodata] = np.nan
        return z, src.window_transform(w)


def _cells(poly, z, transform):
    """(x, y, z) of the valid cells whose centres lie in `poly`."""
    import shapely
    from rasterio.features import rasterize

    mask = rasterize([poly], out_shape=z.shape, transform=transform, all_touched=False) > 0
    mask &= np.isfinite(z)
    rows, cols = np.nonzero(mask)
    xs = transform.c + (cols + 0.5) * transform.a
    ys = transform.f + (rows + 0.5) * transform.e
    del shapely
    return xs, ys, z[rows, cols]


def _profile(poly, line, z, transform):
    """Stations along `line` (s, the low percentile of the in-water cells there, n cells), or None."""
    import shapely

    inner = poly.buffer(-INSET_M)
    if inner.is_empty or inner.area < 0.25 * poly.area:
        inner = poly
    xs, ys, zs = _cells(inner, z, transform)
    if len(zs) < 8:
        return None
    s_cells = shapely.line_locate_point(line, shapely.points(xs, ys))
    s = np.arange(0.0, line.length + 1e-9, BIN_M)
    prof = np.full(len(s), np.nan)
    counts = np.zeros(len(s), int)
    order = np.argsort(s_cells)
    sc, zc = s_cells[order], zs[order]
    for i, si in enumerate(s):
        a, b = np.searchsorted(sc, [si - BIN_HALF_M, si + BIN_HALF_M])
        counts[i] = b - a
        if b - a >= 3:
            prof[i] = np.percentile(zc[a:b], LOW_PERCENTILE)
    good = np.isfinite(prof)
    if good.sum() < 2:
        return None
    prof = np.interp(s, s[good], prof[good])
    return s, prof, counts


def _median_between(s, z, lo, hi):
    k = (s >= lo) & (s <= hi)
    return float(np.median(z[k])) if k.any() else None


def find_steps(s: np.ndarray, z: np.ndarray, min_drop: float) -> list[dict]:
    """Steps in a downstream-monotone profile: [{"s", "topM", "bottomM", "dropM"}] in order. A unit-tested core."""
    n = len(s)
    if n < 3:
        return []
    k = max(int(round(STEP_RUN_M / 2 / BIN_M)), 1)
    drop = np.zeros(n)
    for i in range(n):
        a, b = max(i - k, 0), min(i + k, n - 1)
        drop[i] = z[a] - z[b]
    cand = drop >= min_drop
    grad = np.zeros(n)
    grad[1:-1] = z[:-2] - z[2:]
    grad[0], grad[-1] = z[0] - z[1], z[-2] - z[-1]
    steps: list[int] = []
    i = 0
    while i < n:
        if not cand[i]:
            i += 1
            continue
        j = i
        while j + 1 < n and cand[j + 1]:
            j += 1
        # A long group is two or more steps close together: split at the flat stretches inside it.
        seg = np.arange(i, j + 1)
        peaks = [int(seg[np.argmax(grad[seg])])]
        steep = grad[seg] >= min_drop / (2 * k + 1)
        runs, start = [], None
        for t, flag in zip(seg, steep):
            if flag and start is None:
                start = t
            if not flag and start is not None:
                runs.append((start, t - 1)); start = None
        if start is not None:
            runs.append((start, seg[-1]))
        if len(runs) > 1:
            peaks = [int(a + np.argmax(grad[a:b + 1])) for a, b in runs]
        steps.extend(peaks)
        i = j + 1
    out: list[dict] = []
    prev_s = s[0]
    for idx, p in enumerate(steps):
        sp = float(s[p])
        nxt = float(s[steps[idx + 1]]) if idx + 1 < len(steps) else float(s[-1]) + STEP_CLEAR_M
        up = _median_between(s, z, max(prev_s, sp - STEP_CLEAR_M - LEVEL_SPAN_M), sp - STEP_CLEAR_M)
        down = _median_between(s, z, sp + STEP_CLEAR_M, min(nxt - STEP_CLEAR_M, sp + STEP_CLEAR_M + LEVEL_SPAN_M))
        if up is None:
            up = float(z[max(p - k, 0)])
        if down is None:
            down = float(z[min(p + k, n - 1)])
        if up - down >= min_drop:
            out.append({"s": sp, "topM": round(up, 2), "bottomM": round(down, 2), "dropM": round(up - down, 2)})
            prev_s = sp
    return out


def adjust_steps(steps: list[dict], s: np.ndarray, z: np.ndarray, cuts: list[float], skips: list[float]) -> list[dict]:
    """The found steps with the asked ones: a step within PICK_M (along the line) of a `skips` position is dropped,
    and a `cuts` position with no step that near becomes one (`forced`, kept whatever its drop: a sill the lidar
    smears, as under water plants). Levels either side as in find_steps."""
    out = [st for st in steps if all(abs(st["s"] - k) > PICK_M for k in skips)]
    for c in cuts:
        if any(abs(st["s"] - c) <= PICK_M for st in out):
            continue
        out.append({"s": float(c), "forced": True})
    out.sort(key=lambda st: st["s"])
    for i, st in enumerate(out):
        if not st.get("forced"):
            continue
        prev_s = out[i - 1]["s"] if i else float(s[0]) - STEP_CLEAR_M
        nxt = out[i + 1]["s"] if i + 1 < len(out) else float(s[-1]) + STEP_CLEAR_M
        up = _median_between(s, z, max(prev_s + STEP_CLEAR_M, st["s"] - STEP_CLEAR_M - LEVEL_SPAN_M), st["s"] - STEP_CLEAR_M)
        down = _median_between(s, z, st["s"] + STEP_CLEAR_M, min(nxt - STEP_CLEAR_M, st["s"] + STEP_CLEAR_M + LEVEL_SPAN_M))
        up = up if up is not None else float(np.interp(st["s"] - STEP_CLEAR_M, s, z))
        down = down if down is not None else float(np.interp(st["s"] + STEP_CLEAR_M, s, z))
        st.update(topM=round(up, 2), bottomM=round(down, 2), dropM=round(up - down, 2))
    return out


def _cut_segment(poly, line, s_at: float, reach: float):
    """The stretch of the cross-line at `s_at` that lies in `poly` around the line (a LineString), and the downstream
    tangent there."""
    from shapely.geometry import LineString, Point

    p = line.interpolate(s_at)
    a, b = line.interpolate(max(s_at - 1.0, 0.0)), line.interpolate(min(s_at + 1.0, line.length))
    t = np.array([b.x - a.x, b.y - a.y])
    t /= max(np.hypot(*t), 1e-9)
    nrm = np.array([-t[1], t[0]])
    far = LineString([(p.x - nrm[0] * reach, p.y - nrm[1] * reach), (p.x + nrm[0] * reach, p.y + nrm[1] * reach)])
    inter = far.intersection(poly.buffer(0.05))
    parts = [g for g in getattr(inter, "geoms", [inter]) if g.geom_type == "LineString" and not g.is_empty]
    if not parts:
        return None, t
    seg = min(parts, key=lambda g: g.distance(Point(p.x, p.y)))
    return seg, t


def _ring(poly) -> list[list[float]]:
    poly = poly.buffer(0)
    if poly.geom_type == "MultiPolygon":
        poly = max(poly.geoms, key=lambda g: g.area)
    return [[round(x, 3), round(y, 3)] for x, y in list(poly.exterior.coords)[:-1]]


def _dig_offset(poly, level: float, z, transform) -> float:
    """What a level dig of `poly` adds to its rim percentile to reach `level` (dem_edit's rule)."""
    rim = poly.difference(poly.buffer(-DIG_RIM_M))
    _, _, zs = _cells(rim if not rim.is_empty else poly, z, transform)
    if len(zs) < 4:
        _, _, zs = _cells(poly, z, transform)
    if len(zs) == 0:
        return 0.0
    return round(level - float(np.percentile(zs, DIG_LEVEL_PERCENTILE)), 2)


def water_steps(dem: str, bodies: list[dict], min_drop: float = DEFAULT_MIN_DROP_M, sill_m: float = DEFAULT_SILL_M,
                gap_m: float = DEFAULT_GAP_M, image: str | None = None, ortho: str | None = None,
                cuts: list | None = None, skips: list | None = None) -> dict:
    from shapely.geometry import LineString, Point, Polygon

    cuts, skips = cuts or [], skips or []
    from shapely.ops import unary_union

    from golfpipe.creeks import ribbon_centerline

    polys = [Polygon(b["ring"]).buffer(0) for b in bodies]
    allb = unary_union(polys).bounds
    z, transform = _read_dem(dem, allb, pad=gap_m + 6)

    out_bodies, pieces, falls = [], [], []
    body_pieces: list[list[dict]] = []
    for b, poly in zip(bodies, polys):
        cl = ribbon_centerline(poly)
        prof = _profile(poly, cl[0], z, transform) if cl else None
        if prof is None:
            # A round pond (no line) or too little lidar: one piece, its level the low percentile of its water.
            _, _, zs = _cells(poly.buffer(-INSET_M) if poly.buffer(-INSET_M).area > 1 else poly, z, transform)
            lvl = round(float(np.percentile(zs, LOW_PERCENTILE)), 2) if len(zs) else None
            pc = {"bodyId": b["id"], "shape": b.get("shape"), "index": 0, "kind": "pond", "ring": _ring(poly),
                  "levelM": lvl, "topM": lvl, "bottomM": lvl, "areaM2": round(poly.area, 1),
                  "digLevelOffsetM": _dig_offset(poly, lvl, z, transform) if lvl is not None else 0.0,
                  "_poly": poly, "_line": None, "_s": (0.0, 0.0)}
            pieces.append(pc); body_pieces.append([pc])
            out_bodies.append({"id": b["id"], "shape": b.get("shape"), "line": None, "reversed": False,
                               "profile": None, "steps": 0})
            continue
        line, width = cl
        s, raw, _ = prof
        rev = bool(np.polyfit(s, raw, 1)[0] > 0)
        if rev:
            line = LineString(list(line.coords)[::-1])
            s, raw, _ = _profile(poly, line, z, transform)
        mono = np.minimum.accumulate(raw)
        steps = adjust_steps(find_steps(s, mono, min_drop), s, mono,
                             [line.project(Point(*p)) for p in cuts if poly.distance(Point(*p)) <= PICK_M],
                             [line.project(Point(*p)) for p in skips if poly.distance(Point(*p)) <= PICK_M])
        reach = 3 * width + 20

        # Cut at each step, leaving the sill out.
        strips, lips = [], []
        for st in steps:
            seg, t = _cut_segment(poly, line, st["s"], reach)
            if seg is None:
                continue
            strips.append(seg.buffer(sill_m / 2, cap_style="flat"))
            lip = LineString([(x + t[0] * sill_m / 2, y + t[1] * sill_m / 2) for x, y in seg.coords])
            lips.append((st, lip, t, seg.length))
        rest = poly.difference(unary_union(strips)) if strips else poly
        parts = [g for g in getattr(rest, "geoms", [rest]) if g.area >= MIN_PIECE_M2]
        bounds_s = [0.0] + [st["s"] for st, *_ in lips] + [float(s[-1])]
        mine: list[dict] = []
        for idx in range(len(bounds_s) - 1):
            lo, hi = bounds_s[idx], bounds_s[idx + 1]
            members = [g for g in parts if lo <= line.project(g.representative_point()) < hi
                       or (idx == len(bounds_s) - 2 and line.project(g.representative_point()) >= hi)]
            if not members:
                continue
            geom = unary_union(members)
            k = (s >= lo + STEP_CLEAR_M * (idx > 0)) & (s <= hi - STEP_CLEAR_M * (idx < len(bounds_s) - 2))
            if not k.any():
                k = (s >= lo) & (s <= hi)
            seg_z = mono[k]
            fall = float(seg_z[0] - seg_z[-1]) if len(seg_z) > 1 else 0.0
            length = hi - lo
            flat = fall < RUN_FLAT_M + RUN_FLAT_SLOPE * length
            level = round(float(np.median(raw[k])), 2)
            pc = {"bodyId": b["id"], "shape": b.get("shape"), "index": idx, "kind": "pond" if flat else "creek",
                  "ring": _ring(geom), "levelM": level if flat else None,
                  "topM": round(float(seg_z[0]), 2), "bottomM": round(float(seg_z[-1]), 2),
                  "areaM2": round(geom.area, 1),
                  "digLevelOffsetM": _dig_offset(geom, level, z, transform) if flat else None,
                  "_poly": geom, "_line": line, "_s": (lo, hi)}
            mine.append(pc)
        pieces.extend(mine)
        body_pieces.append(mine)
        for n_step, (st, lip, t, wid) in enumerate(lips):
            up = next((p for p in mine if p["_s"][1] == st["s"]), None)
            down = next((p for p in mine if p["_s"][0] == st["s"]), None)
            mid = lip.interpolate(0.5, normalized=True)
            falls.append({"style": "sill", "fromBodyId": b["id"], "toBodyId": b["id"],
                          "fromPiece": up["index"] if up else None, "toPiece": down["index"] if down else None,
                          "line": [[round(x, 3), round(y, 3)] for x, y in lip.coords],
                          "at": [round(mid.x, 3), round(mid.y, 3)], "flow": [round(t[0], 4), round(t[1], 4)],
                          "topM": up["levelM"] if up and up["levelM"] is not None else st["topM"],
                          "bottomM": down["levelM"] if down and down["levelM"] is not None else st["bottomM"],
                          "dropM": None, "widthM": round(wid, 2), "sillM": sill_m,
                          "forced": bool(st.get("forced"))})
        out_bodies.append({"id": b["id"], "shape": b.get("shape"),
                           "line": [[round(x, 3), round(y, 3)] for x, y in line.coords], "reversed": rev,
                           "profile": {"s": [round(v, 2) for v in s], "z": [round(v, 3) for v in raw]},
                           "steps": len(lips)})

    # Bodies drawn apart: an outlet fall where one comes near another at a lower level.
    for i in range(len(polys)):
        for j in range(len(polys)):
            if i == j or polys[i].distance(polys[j]) > gap_m:
                continue
            from shapely.ops import nearest_points

            pi, pj = nearest_points(polys[i], polys[j])
            hi_piece = min(body_pieces[i], key=lambda p: p["_poly"].distance(pi), default=None)
            lo_piece = min(body_pieces[j], key=lambda p: p["_poly"].distance(pj), default=None)
            if not hi_piece or not lo_piece:
                continue
            top = hi_piece["levelM"] if hi_piece["levelM"] is not None else hi_piece["bottomM"]
            bottom = lo_piece["levelM"] if lo_piece["levelM"] is not None else lo_piece["topM"]
            if top is None or bottom is None or top - bottom < min_drop:
                continue
            flow = np.array([pj.x - pi.x, pj.y - pi.y])
            flow = flow / max(np.hypot(*flow), 1e-9)
            nrm = np.array([-flow[1], flow[0]])
            half = OUTLET_WIDTH_M / 2
            lip = [[round(pj.x - nrm[0] * half, 3), round(pj.y - nrm[1] * half, 3)],
                   [round(pj.x + nrm[0] * half, 3), round(pj.y + nrm[1] * half, 3)]]
            falls.append({"style": "outlet", "fromBodyId": bodies[i]["id"], "toBodyId": bodies[j]["id"],
                          "fromPiece": hi_piece["index"], "toPiece": lo_piece["index"], "line": lip,
                          "at": [round(pj.x, 3), round(pj.y, 3)], "flow": [round(flow[0], 4), round(flow[1], 4)],
                          "topM": top, "bottomM": bottom, "dropM": None, "widthM": OUTLET_WIDTH_M,
                          "gapM": round(pi.distance(pj), 2)})
    for f in falls:
        f["dropM"] = round(f["topM"] - f["bottomM"], 2)
    falls = [f for f in falls if f["dropM"] >= min_drop or f.get("forced")]

    img = _image(image, ortho, polys, pieces, falls) if image else None
    for p in pieces:
        for k in ("_poly", "_line", "_s"):
            p.pop(k, None)
    return {"bodies": out_bodies, "pieces": pieces, "falls": falls, "image": img}


def _image(path: str, ortho: str | None, polys, pieces, falls) -> str:
    """The check picture: the photo (or grey) with the drawn bodies (blue), the pieces (ponds green, creeks cyan,
    labelled with their level) and the falls (red, with their drop)."""
    from PIL import Image, ImageDraw
    from shapely.ops import unary_union

    w, s_, e, n = unary_union(polys).buffer(8).bounds
    scale = min(1600 / max(e - w, 1), 1600 / max(n - s_, 1), 8.0)
    W, H = int((e - w) * scale), int((n - s_) * scale)
    img = Image.new("RGB", (W, H), (90, 90, 90))
    if ortho:
        import rasterio
        from rasterio.windows import from_bounds

        with rasterio.open(ortho) as src:
            a = src.read([1, 2, 3], window=from_bounds(w, s_, e, n, src.transform), boundless=True, fill_value=0)
        img = Image.fromarray(np.moveaxis(a, 0, -1).astype(np.uint8)).resize((W, H))
    d = ImageDraw.Draw(img)
    P = lambda p: ((p[0] - w) * scale, (n - p[1]) * scale)
    for poly in polys:
        d.line([P(p) for p in poly.exterior.coords], fill=(0, 170, 255), width=1)
    for p in pieces:
        col = (60, 230, 90) if p["kind"] == "pond" else (0, 230, 230)
        d.line([P(q) for q in p["ring"]] + [P(p["ring"][0])], fill=col, width=2)
        c = p["_poly"].representative_point()
        label = f'{p["levelM"]:.2f}' if p["levelM"] is not None else f'{p["topM"]:.2f}>{p["bottomM"]:.2f}'
        d.text(P((c.x, c.y)), label, fill=(255, 255, 255))
    for f in falls:
        d.line([P(q) for q in f["line"]], fill=(255, 40, 40), width=4)
        d.text(P(f["at"]), f'  {f["dropM"]:.2f} m {f["style"]}', fill=(255, 220, 60))
    img.save(path)
    return path


def main(argv: list[str] | None = None) -> None:
    """`--input <json> --out <json>` (the server's runner), else the request on stdin and the answer on stdout."""
    import argparse
    p = argparse.ArgumentParser(prog="python -m golfpipe.water_steps")
    p.add_argument("--input")
    p.add_argument("--out")
    args = p.parse_args(argv)
    a = json.loads(open(args.input, encoding="utf-8").read()) if args.input else json.load(sys.stdin)
    result = water_steps(a["dem"], a["bodies"], min_drop=float(a.get("minDropM", DEFAULT_MIN_DROP_M)),
                         sill_m=float(a.get("sillM", DEFAULT_SILL_M)), gap_m=float(a.get("gapM", DEFAULT_GAP_M)),
                         image=a.get("image"), ortho=a.get("ortho"),
                         cuts=a.get("cuts"), skips=a.get("skips"))
    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            json.dump(result, f)
        print(f"water steps: {len(result['pieces'])} piece(s), {len(result['falls'])} fall(s) -> {args.out}")
    else:
        print(json.dumps(result))


if __name__ == "__main__":
    main()
