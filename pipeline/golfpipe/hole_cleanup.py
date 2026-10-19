"""Hole-by-hole photo cleanup: trees, shadows, players and paths painted out of
the cleaned photo on the ground the photo blends into the Unity meshes.

The course's mapped surfaces and the site's cleanup areas decide WHERE, plain
statistics decide WHAT, and LaMa (rough, fairway, green) or PhotoCraft's
content-aware fill (semi-rough, tee, bunker) fills it, one surface at a time so
an edge stays where it was drawn. docs/photo-cleanup.md is the user's side.

  * `cleanup-hole`     one hole: reads its window from a working copy of the
                       cleaned photo (a GeoTIFF), writes the review files and
                       the result into its own folder, and writes the changed
                       pixels back into the working copy, so the next hole
                       (windows overlap) sees them.
  * `cleanup-compose`  the accepted holes' changed pixels as ONE transparent
                       PNG of the photo's size, for `cleaned-replace` to lay
                       over the cleaned photo (one undo step).

The rules and numbers are the ones the 2026-10-10 Vreta pilot was tuned with
(18 holes, kept as they were); they assume the 8192 px photo of a ~2 km square
(0.25 m/px) where a value is given in pixels.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Callable

import numpy as np
import rasterio
from PIL import Image
from rasterio.features import rasterize
from rasterio.warp import transform_geom
from rasterio.windows import Window
from scipy import ndimage as ndi

from .inpaint import InpaintFn, inpaint_tiled


class HoleCleanupError(RuntimeError):
    """User-actionable: missing input, a hole that cannot be placed."""


# --- Where (the scope) ------------------------------------------------------

# Surfaces the photo is blended into on the meshes, as label values.
BLEND = {"rough": 1, "semi_rough": 2, "fairway": 3, "tee": 4, "green": 5}
# Not blended from the photo, but a shadow or a crown on them shows next to
# cleaned grass: cleaned as surfaces of their own, filled only from themselves.
HARD = {"bunker": 7}
PATH_LABEL = 6  # paths take the nearest blend surface's label; 6 is kept for its lit level
SURFACE_NAMES = {1: "rough", 2: "semi_rough", 3: "fairway", 4: "tee", 5: "green", 6: "path", 7: "bunker"}
# Paths are painted out: their ground counts as the blend surface around it and
# is always a target, with this much of a shoulder (the drawn path and the
# gravel in the photo do not line up exactly).
PATH_SHOULDER_M = 1.5
PATH_REACH_M = 6.0  # a path on unmapped ground this near a blend surface joins it
BUFFER_M = 2.0  # the blend surfaces grow this far over unmapped ground and deep rough
NOT_BLEND = ("deep_rough",)  # drawn over the blend surfaces, so they cut them out
KEEP_OUT = ("water", "water_creek", "rock_slab")  # the buffer does not grow over these
MARGIN_M = 15  # round the hole's box
FEATURE_BOX_M = 40  # a hole without a saved view: the box round its own features plus this
BOX_TYPES = ("tee", "fairway", "green", "semi_rough", "bunker")

# --- What (the targets) -----------------------------------------------------

DARK = 0.80        # darker than this share of the local lit brightness = shadow or crown
COLOUR = 38.0
COLOUR_MIN = 24.0  # RGB distance from the local lit colour, at least
COLOUR_SPREADS = 6.0   # ...and this many times the surface's usual distance = an object
OBJECT_MAX_PX = 200    # 12.5 m2: anything off-colour and larger is ground
SIGMA = 30         # px, how local "nearby" is (7.5 m)
GROW = 6           # px grown around every target (1.5 m): shadow edges are soft
MIN_PX = 4

# --- How (the fills) --------------------------------------------------------

LAMA_SURFACES = (1, 3, 5)        # large grass: LaMa continues texture and light
PHOTOCRAFT_SURFACES = (2, 4, 7)  # small surfaces that can lie wholly in shade
LAMA_REACH_PX = 48               # other ground hidden this near a surface's targets
PHOTOCRAFT_ADAPT = "none"

REVIEW_MAX_W = 1600


def _to3006(geom: dict) -> dict:
    return transform_geom("EPSG:4326", "EPSG:3006", geom)


def _points(coords) -> list[tuple[float, float]]:
    """Every (x, y) of a GeoJSON coordinates array of any nesting."""
    if coords and isinstance(coords[0], (int, float)):
        return [(float(coords[0]), float(coords[1]))]
    return [p for c in coords for p in _points(c)]


def hole_box3006(hole: int, region: dict | None, features: list[dict]) -> tuple[float, float, float, float]:
    """(x0, y0, x1, y1) EPSG:3006 of the hole: its saved map view, else the box
    round its tees, fairways, greens, semi-roughs and bunkers plus 40 m."""
    if region:
        c, s = region["center"], region["span"]
        w, e = c["longitude"] - s["longitudeDelta"] / 2, c["longitude"] + s["longitudeDelta"] / 2
        so, n = c["latitude"] - s["latitudeDelta"] / 2, c["latitude"] + s["latitudeDelta"] / 2
        box = _to3006({"type": "Polygon", "coordinates": [[[w, so], [e, so], [e, n], [w, n], [w, so]]]})
        xs, ys = zip(*box["coordinates"][0])
        return min(xs), min(ys), max(xs), max(ys)
    own = [_to3006(f["geometry"]) for f in features
           if f["properties"].get("hole") == hole and f["properties"].get("type") in BOX_TYPES and f.get("geometry")]
    if not own:
        raise HoleCleanupError(f"hole {hole} has neither a saved view nor tees, fairways, greens, semi-roughs or bunkers")
    pts = [p for g in own for p in _points(g["coordinates"])]
    return (min(p[0] for p in pts) - FEATURE_BOX_M, min(p[1] for p in pts) - FEATURE_BOX_M,
            max(p[0] for p in pts) + FEATURE_BOX_M, max(p[1] for p in pts) + FEATURE_BOX_M)


def scope_maps(shape: tuple[int, int], tf, features: list[dict], areas: list[dict]):
    """The hole window's surface labels, its scope and the paths to paint out.

    labels: 0 not cleaned, 1 rough, 2 semi-rough, 3 fairway, 4 tee, 5 green, 7 bunker
    scope:  labelled ground inside an Area to clean or Clean everything, minus Keep unchanged
    paint_out: path ground (plus its shoulder) inside the scope, always a target
    """
    by_type: dict[str, list[dict]] = {}
    for f in features:
        if f.get("geometry"):
            by_type.setdefault(f["properties"]["type"], []).append(_to3006(f["geometry"]))

    labels = np.zeros(shape, np.uint8)
    for typ, value in BLEND.items():
        if by_type.get(typ):
            rasterize([(g, value) for g in by_type[typ]], out=labels, transform=tf)
    for typ in NOT_BLEND:
        if by_type.get(typ):
            rasterize([(g, 0) for g in by_type[typ]], out=labels, transform=tf)

    allowed = np.zeros(shape, np.uint8)
    # 1 = Area to clean, 2 = Clean everything, 0 = outside or Keep unchanged (drawn last: it wins).
    for kind, value in (("include", 1), ("force", 2), ("exclude", 0)):
        geoms = [_to3006({"type": "Polygon", "coordinates": [list(a["ring"]) + [a["ring"][0]]]})
                 for a in areas if a["kind"] == kind]
        if geoms:
            rasterize([(g, value) for g in geoms], out=allowed, transform=tf)
    # The 2 m buffer: unmapped ground and deep rough next to a blend surface take
    # the nearest blend surface's label. Paths, bunkers, water and rock keep theirs.
    blocked = np.zeros(shape, np.uint8)
    for typ in KEEP_OUT:
        if by_type.get(typ):
            rasterize([(g, 1) for g in by_type[typ]], out=blocked, transform=tf)
    for typ, value in HARD.items():
        if by_type.get(typ):
            rasterize([(g, value) for g in by_type[typ]], out=labels, transform=tf)
    labels[blocked > 0] = 0
    blend = (labels >= 1) & (labels <= 5)
    dist, (iy, ix) = ndi.distance_transform_edt(~blend, return_indices=True)
    # "Clean everything" areas: all ground there is cleaned, whatever is mapped or
    # not, as the nearest blend surface. Water and rock are still left alone.
    px = abs(tf.a)
    path = np.zeros(shape, np.uint8)
    if by_type.get("path"):
        rasterize([(g, 1) for g in by_type["path"]], out=path, transform=tf)
    path = ndi.binary_dilation(path > 0, iterations=round(PATH_SHOULDER_M / px)) & (labels != HARD["bunker"])
    grow = (labels == 0) & (blocked == 0) & ((dist <= BUFFER_M / px) | (allowed == 2) | (path & (allowed > 0) & (dist <= PATH_REACH_M / px)))
    labels[grow] = labels[iy[grow], ix[grow]]
    scope = (allowed > 0) & (labels > 0)
    return labels, scope, path & scope, allowed


def detect_targets(rgb_u8: np.ndarray, labels: np.ndarray, scope: np.ndarray, always: np.ndarray):
    """What does not belong on each surface: a pixel much darker than the lit
    ground of its own surface nearby (crowns, shadows) or far from its colour
    and small (players, carts, signs). Returns (targets, sources, stats):
    targets grown to cover soft shadow edges and cut to scope; sources[n] the
    clean lit ground of surface n to sample from."""
    rgb = rgb_u8.astype(np.float32)
    lum = rgb @ np.array([0.299, 0.587, 0.114], np.float32)
    target = np.zeros(lum.shape, bool)
    lit_levels: dict[int, float] = {}
    for value in range(1, 8):
        surf = (labels == value) & scope & ~always
        if not (surf & scope).any():
            continue
        # The lit level of this kind of surface in the whole window: a tee or a
        # stretch of path lying entirely in shade has no lit ground of its own nearby.
        # Paths are of several materials (grey gravel, pale sand): their lit level is
        # the common one, not the palest.
        lit_level = 0.9 * np.percentile(lum[surf], 75 if value == PATH_LABEL else 92)
        lit_levels[value] = lit_level
        lit = surf & (lum > 0.8 * lit_level)
        for _ in range(2):
            wgt = ndi.gaussian_filter(lit.astype(np.float32), SIGMA) + 1e-4
            ref_l = ndi.gaussian_filter(lum * lit, SIGMA) / wgt
            ref_c = np.stack([ndi.gaussian_filter(rgb[..., i] * lit, SIGMA) / wgt for i in range(3)], -1)
            # Where no lit grass of this surface is near, fall back to the surface's own median.
            thin = wgt < 0.02
            if lit.any():
                ref_l[thin] = np.median(lum[lit])
                ref_c[thin] = np.median(rgb[lit], axis=0)
            ref_l = np.maximum(ref_l, 0.85 * lit_level)
            dark = surf & (lum < DARK * ref_l)
            # Objects: far from the lit colour by this surface's own spread (a green
            # is even, rough is not), and small. A large off-colour area is ground
            # (dry grass), not an object.
            dist = np.linalg.norm(rgb - ref_c, axis=-1)
            spread = np.median(dist[lit]) if lit.any() else COLOUR
            odd = surf & ~dark & (dist > max(COLOUR_MIN, COLOUR_SPREADS * spread)) & (value <= 5)
            olab, on = ndi.label(odd)
            if on:
                osize = ndi.sum(odd, olab, range(1, on + 1))
                odd = np.isin(olab, 1 + np.flatnonzero(osize <= OBJECT_MAX_PX))
            bad = dark | odd
            lit = surf & ~ndi.binary_dilation(bad, iterations=GROW)
        target |= bad

    target &= scope
    target |= always
    lab, n = ndi.label(target)
    sizes = ndi.sum(target, lab, range(1, n + 1))
    target = np.isin(lab, 1 + np.flatnonzero(sizes >= MIN_PX))
    target = ndi.binary_dilation(target, iterations=GROW)
    target = ndi.binary_fill_holes(target) & scope

    near_target = ndi.binary_dilation(target, iterations=4)
    sources: dict[int, np.ndarray] = {}
    stats: dict[str, dict] = {}
    for value in range(1, 8):
        src = (labels == value) & ~near_target & (lum > 0.8 * lit_levels.get(value, 0))
        sources[value] = src
        stats[SURFACE_NAMES[value]] = {"targetPx": int((target & (labels == value)).sum()), "sourcePx": int(src.sum())}
    return target, sources, stats


def fill_lama(rgb: np.ndarray, labels: np.ndarray, target: np.ndarray, inpaint_fn: InpaintFn,
              surfaces=LAMA_SURFACES, reach: int = LAMA_REACH_PX) -> np.ndarray:
    """LaMa one surface at a time: a surface's targets are filled seeing only
    that surface nearby, so neither forest nor a neighbouring surface is
    continued into it."""
    res = rgb.copy()
    for v in surfaces:
        tv = target & (labels == v)
        if not tv.any():
            continue
        near = ndi.distance_transform_edt(~tv) <= reach
        hidden = tv | (near & (labels != v))
        out = inpaint_tiled(rgb, hidden, inpaint_fn)
        res[tv] = out[tv]
    return res


def fill_photocraft(cli: Path, folder: Path, src_name: str, out_name: str, labels: np.ndarray,
                    target: np.ndarray, sources: dict[int, np.ndarray], surfaces=PHOTOCRAFT_SURFACES,
                    adapt: str = PHOTOCRAFT_ADAPT) -> list[int]:
    """PhotoCraft's content-aware fill per surface, sampling only that
    surface's clean lit ground, through one headless `photocraft-cli serve`
    session; masks go in as extra documents. Reads `src_name`, writes
    `out_name` in `folder`. Returns the surfaces it filled."""
    folder = folder.resolve()
    done = []
    for v in surfaces:
        t = target & (labels == v)
        if t.any():
            Image.fromarray((t * 255).astype(np.uint8)).save(folder / f"target-{v}.png")
            Image.fromarray((sources[v] * 255).astype(np.uint8)).save(folder / f"source-{v}.png")
            done.append(v)
    if not done:
        Image.open(folder / src_name).save(folder / out_name)
        return done
    proc = subprocess.Popen([str(cli), "serve", "--automation-read-root", str(folder), "--automation-write-root", str(folder)],
                            stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, encoding="utf-8")
    n = 0

    def call(method, **params):
        nonlocal n
        n += 1
        proc.stdin.write(json.dumps({"id": n, "method": method, "params": params}) + "\n")
        proc.stdin.flush()
        line = proc.stdout.readline()
        if not line:
            raise HoleCleanupError(f"photocraft-cli stopped answering at {method}")
        reply = json.loads(line)
        if not reply.get("ok"):
            raise HoleCleanupError(f"photocraft {method} failed: {reply.get('error', reply)}")
        return reply["result"]

    def run(command, **params):
        return call("engine.execute", command=command, params=params)

    try:
        call("doc.open", path=src_name)
        index = {}
        for v in done:
            for kind in ("source", "target"):
                index[kind, v] = call("doc.open", path=f"{kind}-{v}.png")["index"]
        for v in done:
            call("doc.select", index=0)
            run("select.loadSelection", document=index["source", v], channel="composite")
            run("select.saveSelection", name=f"src-{v}")
            run("select.loadSelection", document=index["target", v], channel="composite")
            run("edit.contentAwareFill", sampling="custom", channel=f"src-{v}", colorAdaptation=adapt, output="current")
        call("doc.select", index=0)
        run("select.deselect")
        call("doc.save", path=out_name, index=0)
    finally:
        proc.stdin.close()
        proc.wait(timeout=60)
    return done


def default_photocraft() -> Path | None:
    """$GOLFPIPE_PHOTOCRAFT_CLI, else a PhotoCraft checkout beside golf-map
    (`../crafts/photocraft`, release build), else None."""
    env = os.environ.get("GOLFPIPE_PHOTOCRAFT_CLI")
    if env:
        return Path(env)
    exe = "photocraft-cli.exe" if sys.platform == "win32" else "photocraft-cli"
    guess = Path(__file__).resolve().parents[3] / "crafts" / "photocraft" / "target" / "release" / exe
    return guess if guess.is_file() else None


def _review(before: np.ndarray, after: np.ndarray, out: Path) -> None:
    """Before and after side by side, the pair at most REVIEW_MAX_W wide."""
    h, w = before.shape[:2]
    scale = min(1.0, REVIEW_MAX_W / (2 * w + 8))
    size = (max(1, round(w * scale)), max(1, round(h * scale)))
    pair = Image.new("RGB", (2 * size[0] + 8, size[1]), (255, 255, 255))
    pair.paste(Image.fromarray(before).resize(size, Image.LANCZOS), (0, 0))
    pair.paste(Image.fromarray(after).resize(size, Image.LANCZOS), (size[0] + 8, 0))
    pair.save(out)


def _overlay(rgb: np.ndarray, labels: np.ndarray, scope: np.ndarray, allowed: np.ndarray) -> np.ndarray:
    ov = rgb.astype(np.float32)
    ov[~scope] *= 0.45
    colours = {1: (255, 160, 0), 2: (255, 255, 0), 3: (0, 255, 255), 4: (255, 0, 255), 5: (255, 255, 255), 7: (255, 120, 120)}
    for value, col in colours.items():
        m = labels == value
        ov[m & ~ndi.binary_erosion(m, iterations=1)] = col
    am = allowed > 0
    ov[am & ~ndi.binary_erosion(am, iterations=2)] = (255, 0, 0)
    return ov.astype(np.uint8)


def clean_hole(
    work: Path,
    features: list[dict],
    areas: list[dict],
    hole: int,
    region: dict | None,
    out: Path,
    inpaint_fn: InpaintFn,
    photocraft: Path | None,
    progress: Callable[[str], None] = lambda _msg: None,
) -> dict:
    """Cleans one hole of the working copy `work` (a GeoTIFF of the cleaned
    photo, changed in place: the changed pixels go back into it). Writes into
    `out`: photo.png (before), filled.png (after), changed.png (255 = a pixel
    this hole changed), review.png, detect.png (targets outlined), overlay.png
    (surfaces and scope) and hole.json, which it also returns."""
    t0 = time.time()
    out.mkdir(parents=True, exist_ok=True)
    warnings: list[str] = []
    x0, y0, x1, y1 = hole_box3006(hole, region, features)
    with rasterio.open(work) as src:
        r0, c0 = src.index(x0 - MARGIN_M, y1 + MARGIN_M)
        r1, c1 = src.index(x1 + MARGIN_M, y0 - MARGIN_M)
        r0, c0, r1, c1 = max(r0, 0), max(c0, 0), min(r1, src.height), min(c1, src.width)
        if r1 <= r0 or c1 <= c0:
            raise HoleCleanupError(f"hole {hole} lies outside the photo")
        win = Window(c0, r0, c1 - c0, r1 - r0)
        rgb = np.ascontiguousarray(np.moveaxis(src.read([1, 2, 3], window=win), 0, 2))
        tf = src.window_transform(win)
    window = {"x0": int(c0), "y0": int(r0), "w": int(c1 - c0), "h": int(r1 - r0)}
    doc: dict = {"hole": hole, "window": window, "scopePx": 0, "targetPx": 0, "changedPx": 0,
                 "perSurface": {}, "warnings": warnings, "seconds": 0.0}

    labels, scope, paint_out, allowed = scope_maps(rgb.shape[:2], tf, features, areas)
    Image.fromarray(rgb).save(out / "photo.png", compress_level=1)
    Image.fromarray(_overlay(rgb, labels, scope, allowed)).save(out / "overlay.png")
    doc["scopePx"] = int(scope.sum())
    filled = rgb
    if doc["scopePx"]:
        progress(f"hole {hole}: finding targets in {doc['scopePx']:,} px")
        target, sources, stats = detect_targets(rgb, labels, scope, paint_out)
        doc["targetPx"], doc["perSurface"] = int(target.sum()), stats
        det = rgb.copy()
        det[ndi.binary_dilation(target, iterations=1) & ~target] = (255, 0, 255)
        Image.fromarray(det).save(out / "detect.png")
        if target.any():
            progress(f"hole {hole}: LaMa on rough, fairway, green")
            pc_surfaces = PHOTOCRAFT_SURFACES
            if photocraft is None or not Path(photocraft).is_file():
                warnings.append("PhotoCraft not found: semi-rough, tees and bunkers filled with LaMa "
                                "(shaded small surfaces come out darker); set GOLFPIPE_PHOTOCRAFT_CLI")
                pc_surfaces = ()
            lama_surfaces = tuple(v for v in (*LAMA_SURFACES, *PHOTOCRAFT_SURFACES) if v not in pc_surfaces)
            filled = fill_lama(rgb, labels, target, inpaint_fn, surfaces=lama_surfaces)
            if pc_surfaces:
                progress(f"hole {hole}: PhotoCraft on semi-rough, tees, bunkers")
                Image.fromarray(filled).save(out / "filled-lama.png", compress_level=1)
                fill_photocraft(Path(photocraft), out, "filled-lama.png", "filled.png", labels, target, sources, pc_surfaces)
                filled = np.asarray(Image.open(out / "filled.png").convert("RGB"))
                (out / "filled-lama.png").unlink(missing_ok=True)
    else:
        warnings.append("no cleanup area over this hole's surfaces: nothing to clean")

    changed = (filled != rgb).any(axis=2)
    doc["changedPx"] = int(changed.sum())
    Image.fromarray(filled).save(out / "filled.png", compress_level=1)
    Image.fromarray((changed * 255).astype(np.uint8)).save(out / "changed.png")
    _review(rgb, filled, out / "review.png")
    if changed.any():
        with rasterio.open(work, "r+") as dst:
            merged = rgb.copy()
            merged[changed] = filled[changed]
            dst.write(np.moveaxis(merged, 2, 0), window=win, indexes=[1, 2, 3])
    doc["seconds"] = round(time.time() - t0, 1)
    (out / "hole.json").write_text(json.dumps(doc), encoding="utf-8")
    return doc


def compose(job: Path, holes: list[int], size: int, out: Path) -> dict:
    """The changed pixels of `holes` (folders `job/h<n>`), in that order, as an
    RGBA PNG of `size` px: opaque where a hole changed a pixel, transparent
    elsewhere, so `cleaned-replace` lays it over the photo as it is now."""
    rgba = np.zeros((size, size, 4), np.uint8)
    for n in holes:
        d = job / f"h{n}"
        try:
            w = json.loads((d / "hole.json").read_text(encoding="utf-8"))["window"]
            filled = np.asarray(Image.open(d / "filled.png").convert("RGB"))
            changed = np.asarray(Image.open(d / "changed.png")) > 0
        except (OSError, ValueError, KeyError) as exc:
            raise HoleCleanupError(f"hole {n} has no finished result in {d}: {exc}") from exc
        if filled.shape[:2] != (w["h"], w["w"]) or changed.shape != (w["h"], w["w"]):
            raise HoleCleanupError(f"hole {n}: its images do not match its window")
        view = rgba[w["y0"]:w["y0"] + w["h"], w["x0"]:w["x0"] + w["w"]]
        view[changed, :3] = filled[changed]
        view[changed, 3] = 255
    pixels = int((rgba[..., 3] > 0).sum())
    out.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(rgba).save(out, compress_level=1)
    return {"file": str(out), "holes": holes, "changedPixels": pixels}


def load_features(path: Path) -> list[dict]:
    """The course's features: a GeoJSON FeatureCollection in WGS84 with
    `properties.type` and, for a hole's own features, `properties.hole`."""
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise HoleCleanupError(f"cannot read the features {path}: {exc}") from exc
    return [f for f in doc.get("features", []) if f.get("properties", {}).get("type")]


def load_areas(path: Path) -> list[dict]:
    """The site's cleanup areas as stored: [{kind, ring}] in WGS84."""
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise HoleCleanupError(f"cannot read the cleanup areas {path}: {exc}") from exc
    return doc.get("areas", doc) if isinstance(doc, dict) else doc
