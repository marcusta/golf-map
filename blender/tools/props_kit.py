"""Procedural kit for course props: buildings, shelters and small objects around a clubhouse.

Everything is built from parameters (a JSON spec, see build_props.py) so a building can be
re-measured and rebuilt without hand modelling. Geometry is accumulated in a `Geo` (plain
Python lists) and turned into one Blender mesh per asset at the end, with UVs in metres so a
material's texture tiles at its real size on every face.

Asset-local frame: x = long axis, y = across, z = up, origin on the ground at the footprint
centre. Placement (Unity side) turns local +x onto the instance's `yawDeg` compass bearing.

Textures are generated here (numpy -> PNG): albedo in sRGB and an OpenGL (Y+) normal map, the
convention Unity expects. Blender 4.5, Python 3.11.
"""
import math
import os
import random
import shutil

import bpy
import numpy as np
from mathutils import Matrix, Vector

UP = Vector((0.0, 0.0, 1.0))
SPEC_DIR = "."  # relative `image:` texture paths resolve here (build_props sets it to the spec's folder)

# ---------------------------------------------------------------------------------------------
# Textures
# ---------------------------------------------------------------------------------------------


def _rng(seed):
    return np.random.default_rng(seed)


def _noise(shape, seed, scale):
    """Smooth value noise, 0..1, `scale` pixels per cell, tileable."""
    r = _rng(seed)
    h, w = shape
    gh, gw = max(1, h // scale), max(1, w // scale)
    g = r.random((gh, gw))
    ys = np.arange(h) * gh / h
    xs = np.arange(w) * gw / w
    y0 = np.floor(ys).astype(int)
    x0 = np.floor(xs).astype(int)
    fy = (ys - y0)[:, None]
    fx = (xs - x0)[None, :]
    fy = fy * fy * (3 - 2 * fy)
    fx = fx * fx * (3 - 2 * fx)
    y1 = (y0 + 1) % gh
    x1 = (x0 + 1) % gw
    a = g[y0][:, x0]
    b = g[y0][:, x1]
    c = g[y1][:, x0]
    d = g[y1][:, x1]
    return a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy


def _fbm(shape, seed, scales=(64, 32, 16, 8, 4), weights=None):
    weights = weights or [0.5 ** i for i in range(len(scales))]
    out = np.zeros(shape)
    for i, s in enumerate(scales):
        out += weights[i] * _noise(shape, seed + i * 17, s)
    return out / sum(weights)


def _normal_from_height(hgt, strength):
    dx = (np.roll(hgt, -1, 1) - np.roll(hgt, 1, 1)) * 0.5 * strength
    dy = (np.roll(hgt, -1, 0) - np.roll(hgt, 1, 0)) * 0.5 * strength
    # image rows run top->bottom; OpenGL normal maps have +Y up the image
    n = np.stack([-dx, dy, np.ones_like(hgt)], -1)
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    return n * 0.5 + 0.5


def _rgb(c):
    return np.array(c, dtype=float) / 255.0


class TextureBank:
    """Generates each texture once into `folder` (PNG), returns file names."""

    def __init__(self, folder, size=1024):
        self.folder = folder
        self.size = size
        os.makedirs(folder, exist_ok=True)
        self.made = {}

    def save(self, name, rgb, normal=False, alpha=None):
        path = os.path.join(self.folder, name + ".png")
        h, w, _ = rgb.shape
        img = bpy.data.images.new(name, w, h, alpha=True, float_buffer=False)
        if normal:
            img.colorspace_settings.name = "Non-Color"
        px = np.ones((h, w, 4), dtype=np.float32)
        px[:, :, :3] = np.clip(rgb[:, :, :3], 0, 1)
        if alpha is not None:
            px[:, :, 3] = np.clip(alpha, 0, 1)
        img.pixels.foreach_set(px[::-1].ravel())  # Blender rows are bottom-up
        img.filepath_raw = path
        img.file_format = "PNG"
        img.save()
        return path

    def get(self, name, file_name=None, metal=0.0):
        """name: 'kind:arg:arg' texture spec; file_name: base name of the PNGs (default from the spec).
        Returns (albedo, normal, mask) paths. albedo may carry alpha (cutout materials). mask is Unity's
        Standard metallic/occlusion layout: R metallic, G ambient occlusion (cavities from the height
        map), A smoothness multiplier (worn/dirty spots less shiny)."""
        if name not in self.made and name.startswith("image:"):
            # a finished picture (a sign face): copied as the albedo, mapped once over the face (UV 0..1)
            src = os.path.join(SPEC_DIR, name[len("image:"):])
            dst = os.path.join(self.folder, (file_name or os.path.splitext(os.path.basename(src))[0]) + ".png")
            shutil.copyfile(src, dst)
            self.made[name] = (dst, None, None)
        if name not in self.made:
            fn = getattr(self, "tex_" + name.split(":")[0])
            out = fn(*name.split(":")[1:])
            albedo, height, strength = out[:3]
            alpha = out[3] if len(out) > 3 else None
            base = file_name or name.replace(":", "_").replace(",", "-")
            a = self.save(base, albedo, alpha=alpha)
            n = m = None
            if height is not None:
                n = self.save(base + "_n", _normal_from_height(height, strength), normal=True)
                hh = (height - height.min()) / max(1e-6, float(height.max() - height.min()))
                ao = 0.45 + 0.55 * np.clip(hh * 1.6, 0, 1)
                wear = _fbm(height.shape, 777, scales=(128, 32, 8))
                sm = np.clip(0.55 + 0.6 * wear, 0, 1) * (0.75 + 0.25 * hh)
                mask = np.stack([np.full_like(hh, metal), ao, np.zeros_like(hh)], -1)
                m = self.save(base + "_m", mask, normal=True, alpha=sm)
            self.made[name] = (a, n, m)
        return self.made[name]

    # --- individual textures. Each returns (albedo rgb 0..1, height 0..1 or None, normal strength)

    def tex_boards(self, color="140,40,34", orient="v", board_m="0.19", tile_m="2.0", batten="1"):
        """Board-and-batten (orient v) or horizontal planks (orient h) in paint. Texture = tile_m square."""
        S = self.size
        col = _rgb([int(c) for c in color.split(",")])
        bpx = S * float(board_m) / float(tile_m)
        t = np.arange(S)
        pos = (t % bpx) / bpx
        idx = (t // bpx).astype(int)
        r = _rng(3)
        shade = 1 + (r.random(idx.max() + 2) - 0.5) * 0.10
        grain = _fbm((S, S), 11, scales=(128, 32, 8, 2))
        streak = _noise((S, 8), 5, 2)
        if orient == "v":
            prof = np.ones(S)
            if batten == "2":  # plain boards: the battens are geometry
                prof = 0.9 + 0.1 * np.cos(pos * 2 * math.pi)
            elif batten == "1":
                prof = np.where(pos < 0.16, 1.0, 0.55)  # batten proud of the board
            gap = ((pos < 0.03) | (pos > 0.97)) & (batten != "2")
            prof = np.where(gap, 0.0, prof)
            hgt = np.tile(prof[None, :], (S, 1))
            tone = np.tile(shade[idx][None, :], (S, 1))
            streaks = np.repeat(np.repeat(streak, S // 8, 1)[:, :S], 1, 0)
            streaks = np.tile(_noise((S, 1), 7, 64)[:, :1], (1, S))
        else:
            prof = np.clip((pos - 0.02) * 12, 0, 1) * (0.8 + 0.2 * pos)  # lap: each plank thicker at its foot
            gap = pos < 0.035
            prof = np.where(gap, 0.0, prof)
            hgt = np.tile(prof[:, None], (1, S))
            tone = np.tile(shade[idx][:, None], (1, S))
            streaks = np.tile(_noise((1, S), 7, 64)[:1, :], (S, 1))
        fine = _fbm((S, S), 13, scales=(4, 2, 1))
        idxs = np.arange(S)[None, :] if orient == "v" else np.arange(S)[:, None]
        grainline = np.sin(idxs * 0.9 + grain * 14) * 0.5 + 0.5
        v = tone * (0.86 + 0.14 * grain + 0.05 * streaks + 0.05 * grainline + 0.04 * (fine - 0.5))
        # paint weathering: slightly lighter, less saturated patches
        weather = np.clip((_fbm((S, S), 17, scales=(256, 128, 64)) - 0.55) * 3, 0, 1)
        v = np.where(hgt < 0.05, 0.5, v)
        albedo = col[None, None, :] * v[:, :, None]
        grey = albedo.mean(-1, keepdims=True)
        albedo = albedo * (1 - 0.25 * weather[:, :, None]) + grey * 1.15 * 0.25 * weather[:, :, None]
        return albedo, hgt * 0.85 + grain * 0.1 + grainline * 0.05, 3.0

    def tex_pantile(self, color="186,84,52"):
        """Clay pan tiles, 2 m tile, rows 0.33 m, 0.25 m pan width."""
        S = self.size
        col = _rgb([int(c) for c in color.split(",")])
        rows, cols = 6, 8
        y = np.arange(S)[:, None] / S * rows
        x = np.arange(S)[None, :] / S * cols
        fy = y % 1
        fx = (x + 0.0) % 1
        wave = 0.5 + 0.5 * np.cos(fx * 2 * math.pi)
        lap = fy  # each course thicker at its lower edge (image top = up the slope)
        hgt = 0.55 * wave + 0.45 * (1 - lap)
        r = _rng(9)
        tile_id = (np.floor(y).astype(int) * cols + np.floor(x).astype(int))
        shade = 1 + (r.random(rows * cols + cols) - 0.5) * 0.18
        g = _fbm((S, S), 21, scales=(64, 16, 4))
        v = shade[tile_id] * (0.80 + 0.25 * wave) * (0.9 + 0.15 * g)
        v = np.where(fy > 0.94, v * 0.55, v)
        albedo = col * v[:, :, None]
        return albedo, hgt, 6.0

    def tex_seam(self, color="30,31,33", spacing="0.52", tile_m="2.08", corrugated="0"):
        """Standing-seam (or corrugated) sheet metal, seams along v (down the slope)."""
        S = self.size
        col = _rgb([int(c) for c in color.split(",")])
        per = S * float(spacing) / float(tile_m)
        x = np.arange(S) % per / per
        if corrugated == "1":
            prof = 0.5 + 0.5 * np.sin(np.arange(S) / (S / (float(tile_m) / 0.076)) * 2 * math.pi)
        else:
            prof = np.where(x < 0.04, 1.0, 0.25 + 0.05 * np.sin(x * math.pi))
        hgt = np.tile(prof[None, :], (S, 1))
        g = _fbm((S, S), 31, scales=(256, 64, 16))
        v = (0.92 + 0.12 * g) * (0.95 + 0.1 * hgt)
        albedo = col * v[:, :, None]
        return albedo, hgt, 4.0

    def tex_felt(self, color="104,66,52"):
        S = self.size
        col = _rgb([int(c) for c in color.split(",")])
        g = _fbm((S, S), 41, scales=(128, 32, 8, 2, 1))
        grit = _rng(4).random((S, S))
        v = 0.85 + 0.25 * g + 0.12 * (grit - 0.5)
        return col * v[:, :, None], g * 0.6 + grit * 0.4, 1.5

    def tex_shingle(self, color="62,62,64"):
        S = self.size
        col = _rgb([int(c) for c in color.split(",")])
        rows = 8
        y = np.arange(S)[:, None] / S * rows
        fy = y % 1
        row = np.floor(y).astype(int)
        x = (np.arange(S)[None, :] / S * 6 + (row % 2) * 0.5) % 1
        hgt = (1 - fy) * 0.8 + np.where((x < 0.03) | (fy > 0.96), -0.6, 0)
        g = _fbm((S, S), 51, scales=(64, 8, 2))
        v = 0.85 + 0.25 * g - 0.2 * fy
        return col * v[:, :, None] * np.ones((1, S, 1)), np.clip(hgt, 0, 1) * np.ones((1, S)), 4.0

    def tex_solar(self):
        """One 1.0 x 1.7 m panel per texture: 6 x 10 dark cells, thin silver frame."""
        S = self.size
        h, w = S, int(S * 1.0 / 1.7)
        yy = np.arange(h)[:, None] / h
        xx = np.arange(w)[None, :] / w
        frame = (xx < 0.02) | (xx > 0.98) | (yy < 0.012) | (yy > 0.988)
        cy = (yy * 10) % 1
        cx = (xx * 6) % 1
        gap = (cy < 0.03) | (cx < 0.04)
        base = np.ones((h, w, 3)) * _rgb([22, 26, 38])
        base = np.where(gap[:, :, None], _rgb([55, 58, 66]), base)
        base = np.where(frame[:, :, None], _rgb([120, 122, 126]), base)
        hgt = np.where(frame, 1.0, np.where(gap, 0.4, 0.5))
        return base, hgt, 3.0

    def tex_brickpave(self, colors="104,48,38|116,56,42|128,78,54|92,42,34"):
        """Brick paving, stretcher rows (bricks 0.25 x 0.06 m on edge look), 2 m tile, mixed reds and ochre."""
        S = self.size
        pal = [_rgb([int(c) for c in cc.split(",")]) for cc in colors.split("|")]
        rows = 20
        y = np.arange(S)[:, None] / S * rows
        row = np.floor(y).astype(int)
        cols = 8
        x = np.arange(S)[None, :] / S * cols + (row % 2) * 0.5
        bi = np.floor(x).astype(int) % cols + row * cols
        r = _rng(61)
        pick = r.integers(0, len(pal), rows * cols + cols)
        stripe = (row % 10 == 0)  # the terrace has a lighter course every so often
        cidx = np.where(stripe, 2, pick[bi])
        palarr = np.array(pal)
        albedo = palarr[cidx]
        fx = x % 1
        fy = y % 1
        joint = (fx < 0.03) | (fy < 0.06)
        g = _fbm((S, S), 63, scales=(32, 8, 2))
        albedo = albedo * (0.88 + 0.2 * g)[:, :, None]
        albedo = np.where(joint[:, :, None], _rgb([150, 145, 135]), albedo)
        hgt = np.where(joint, 0.0, 0.8 + 0.2 * g)
        return albedo, hgt, 2.5

    def tex_stone(self, color="128,124,120"):
        """Granite block plinth / wall: irregular blocks ~0.6 x 0.35 m, 2 m tile."""
        S = self.size
        col = _rgb([int(c) for c in color.split(",")])
        rows = 6
        y = np.arange(S)[:, None] / S * rows
        row = np.floor(y).astype(int)
        r = _rng(71)
        off = r.random(rows + 1)
        x = np.arange(S)[None, :] / S * 3.3 + off[row]
        bi = np.floor(x).astype(int) + row * 5
        shade = 0.8 + 0.4 * r.random(rows * 5 + 10)
        fx = x % 1
        fy = y % 1
        g = _fbm((S, S), 73, scales=(64, 16, 4, 1))
        speck = r.random((S, S))
        v = shade[bi] * (0.85 + 0.2 * g + 0.1 * (speck - 0.5))
        joint = (fx < 0.025) | (fy < 0.04)
        v = np.where(joint, 0.45, v)
        hgt = np.where(joint, 0.0, 0.6 + 0.4 * g)
        return col * v[:, :, None], hgt, 4.0

    def tex_foliage(self, color="58,86,40"):
        """Clipped hedge leaves."""
        S = self.size
        col = _rgb([int(c) for c in color.split(",")])
        g = _fbm((S, S), 81, scales=(32, 16, 8, 4, 2))
        leaf = _fbm((S, S), 83, scales=(6, 3, 2))
        v = 0.55 + 0.7 * leaf * (0.6 + 0.6 * g)
        hue = np.stack([np.ones_like(g), 1 + 0.15 * (g - 0.5), 1 - 0.2 * (g - 0.5)], -1)
        albedo = col * v[:, :, None] * hue
        hole = leaf < 0.33
        albedo = np.where(hole[:, :, None], col * 0.25, albedo)
        return albedo, leaf, 6.0

    def tex_gravel(self, color="196,192,182"):
        """White/grey stones (range embankment), stones ~0.15-0.3 m."""
        S = self.size
        col = _rgb([int(c) for c in color.split(",")])
        r = _rng(91)
        n = int(os.environ.get("GRAVEL_N", "9000"))  # 2 m tile: pebbles 1-3 cm
        cx, cy = r.random(n) * S, r.random(n) * S
        rad = r.uniform(S * 0.004, S * 0.011, n)
        tone = r.uniform(0.7, 1.15, n)
        hgt = np.zeros((S, S))
        alb = np.ones((S, S)) * 0.45
        yy, xx = np.mgrid[0:S, 0:S]
        for i in range(n):
            x0, x1 = int(cx[i] - rad[i]) - 1, int(cx[i] + rad[i]) + 2
            y0, y1 = int(cy[i] - rad[i]) - 1, int(cy[i] + rad[i]) + 2
            ys = np.arange(y0, y1) % S
            xs = np.arange(x0, x1) % S
            dy = (np.arange(y0, y1) - cy[i])[:, None]
            dx = (np.arange(x0, x1) - cx[i])[None, :]
            d = 1 - (dx * dx + dy * dy) / rad[i] ** 2
            d = np.clip(d, 0, 1) ** 0.5
            sub_h = hgt[np.ix_(ys, xs)]
            m = d > sub_h
            sub_h[m] = d[m]
            hgt[np.ix_(ys, xs)] = sub_h
            sub_a = alb[np.ix_(ys, xs)]
            sub_a[m] = tone[i] * (0.8 + 0.2 * d[m])
            alb[np.ix_(ys, xs)] = sub_a
        g = _fbm((S, S), 93, scales=(16, 4, 1))
        return col * (alb * (0.9 + 0.2 * g))[:, :, None], hgt, 5.0

    def tex_turf(self, color="52,110,62"):
        """Artificial turf mat: fine fibre noise, faint wear, no blotches."""
        S = self.size
        col = _rgb([int(c) for c in color.split(",")])
        fib = _rng(12).random((S, S))
        g = _fbm((S, S), 101, scales=(256, 128))
        v = 0.88 + 0.16 * (fib - 0.5) + 0.08 * (g - 0.5)
        return col * v[:, :, None], fib * 0.7 + g * 0.3, 1.5

    def tex_asphalt(self, color="92,92,90"):
        S = self.size
        col = _rgb([int(c) for c in color.split(",")])
        g = _fbm((S, S), 111, scales=(128, 16, 2, 1))
        grit = _rng(5).random((S, S))
        return col * (0.85 + 0.2 * g + 0.1 * (grit - 0.5))[:, :, None], grit, 1.0

    def tex_louvre(self, color="24,24,26"):
        """Black louvred shutter / vent, slats 0.06 m, 1 m tile."""
        S = self.size
        col = _rgb([int(c) for c in color.split(",")])
        y = (np.arange(S)[:, None] / S * 16) % 1
        hgt = np.tile(y, (1, S))
        v = 0.8 + 0.4 * hgt
        return col * v[:, :, None], hgt, 5.0

    def tex_plaster(self, color="200,196,188"):
        S = self.size
        col = _rgb([int(c) for c in color.split(",")])
        g = _fbm((S, S), 121, scales=(64, 16, 4, 1))
        return col * (0.9 + 0.15 * g)[:, :, None], g, 1.0

    def tex_netting(self, color="30,32,30"):
        """Ball-stop netting: 4 cm mesh of dark cord, alpha cutout. 1 m tile."""
        S = 512
        col = _rgb([int(c) for c in color.split(",")])
        t = np.arange(S) / S * 25
        on = np.abs((t % 1) - 0.5) > 0.40
        a = (on[None, :] | on[:, None]).astype(float) * 0.85
        return np.ones((S, S, 3)) * col, None, 1.0, a

    def tex_granite(self, color="124,121,116", lichen="0.55", green="0", orange="0"):
        """Weathered granite bedrock (glacier-polished outcrop, photo 21): a 4 m tile at twice the bank size.
        Grey with a warm feldspar cast, mm crystal grains (dark mica, pale quartz, pinkish feldspar), broad
        tonal mottling, crustose lichen (pale grey rosettes, `lichen` = how far they lighten the stone, and
        dark grey-green crusts) and a few long hairline cracks. No cellular joint pattern: on a dome that reads
        as cobbles. `green` (0..1, default 0 = none) adds patchy pale grey-green lichen, `orange` (0..1) sparse
        yellow-orange spots (Xanthoria), as on the field boulders of a heap."""
        S = self.size * 2
        k = S / 2048.0  # noise scales are written for 2048 px = 4 m (~2 mm/px)

        def sc(*v):
            return tuple(max(1, int(round(x * k))) for x in v)

        col = _rgb([int(c) for c in color.split(",")])
        r = _rng(8)
        big = _fbm((S, S), 141, scales=sc(1024, 512, 256))          # metre-scale tone
        mid = _fbm((S, S), 142, scales=sc(128, 64, 32, 16))         # palm-sized blotches
        grain = _noise((S, S), 147, max(1, int(round(3 * k))))      # 5-8 mm crystals
        grain2 = _noise((S, S), 148, max(1, int(round(2 * k))))
        fine = r.random((S, S))
        # crystals
        dark_x = np.clip((0.22 - grain) * 8, 0, 1)                  # biotite / hornblende
        pale_x = np.clip((grain2 - 0.78) * 6, 0, 1)                 # quartz
        pink_x = np.clip((grain - 0.62) * 4, 0, 1) * (1 - pale_x)   # feldspar
        v = 0.84 + 0.26 * (big - 0.5) + 0.18 * (mid - 0.5) + 0.08 * (fine - 0.5)
        alb = col[None, None, :] * v[:, :, None]
        alb = alb * (1 - 0.45 * dark_x[:, :, None])
        alb = alb + (_rgb([200, 198, 192]) - alb) * 0.45 * pale_x[:, :, None]
        alb = alb + (_rgb([150, 118, 106]) - alb) * 0.30 * pink_x[:, :, None]
        # crustose lichen: dense small pale grey rosettes (5-25 cm, thicker where `big` is high) with a
        # darker rim, and dark grey-green crusts in the low spots
        dens = np.clip(0.5 + 1.2 * (big - 0.5), 0, 1)
        lp = _fbm((S, S), 143, scales=sc(96, 48, 24, 10, 5))
        pale = np.clip((lp - 0.66 + 0.10 * dens) * 6, 0, 1)
        rim = np.clip(1 - np.abs(lp - 0.64 + 0.10 * dens) * 50, 0, 1) * (1 - pale) * 0.6
        ld = _fbm((S, S), 149, scales=sc(384, 160, 64, 24)) - 0.3 * (big - 0.5)
        dark = np.clip((ld - 0.57) * 5, 0, 1)
        alb = alb + (_rgb([180, 180, 172]) - alb) * (float(lichen) * pale)[:, :, None]
        alb = alb * (1 - 0.3 * rim[:, :, None])
        alb = alb + (_rgb([70, 74, 66]) - alb) * (0.55 * dark)[:, :, None]
        if float(green) > 0:   # blotches (a hand to half a metre) of pale grey-green crust
            gl = _fbm((S, S), 150, scales=sc(256, 96, 40, 12))
            gm = np.clip((gl - 0.56) * 7, 0, 1) * np.clip(0.4 + 1.2 * (big - 0.3), 0, 1)
            alb = alb + (_rgb([148, 160, 118]) - alb) * (float(green) * 0.75 * gm)[:, :, None]
        if float(orange) > 0:  # a few small yellow-orange spots, mostly on the high, sunlit tone
            ol = _fbm((S, S), 151, scales=sc(96, 32, 12, 5))
            om = np.clip((ol - 0.70) * 12, 0, 1) * np.clip(2 * (big - 0.35), 0, 1)
            alb = alb + (_rgb([214, 156, 52]) - alb) * (float(orange) * 0.8 * om)[:, :, None]
        # a few long cracks (contours of very low-frequency noise, broken up), dirt-dark with a soft edge
        crack = np.zeros((S, S))
        for seed, scl, w, keep in ((145, 2048, 0.006, 0.4), (146, 1024, 0.004, 0.55)):
            n = _fbm((S, S), seed, scales=sc(scl, scl // 4), weights=[1.0, 0.12])
            d = np.abs(n - 0.5) / w
            line = np.clip(1 - d, 0, 1) + 0.35 * np.clip(1 - d / 3, 0, 1)
            mask = np.clip((_fbm((S, S), seed + 7, scales=sc(512, 128)) - keep) * 5, 0, 1)
            crack = np.maximum(crack, np.clip(line, 0, 1) * mask)
        alb = alb * (1 - 0.6 * crack[:, :, None])
        hgt = 0.6 + 0.25 * (mid - 0.5) + 0.12 * grain - 0.1 * dark_x + 0.1 * pale - 0.5 * crack
        return np.clip(alb, 0, 1), np.clip(hgt, 0, 1), 3.0

    # --- photo textures from the course's Unity project (paths relative to its Assets/). Only the
    # luminance is kept: it carries the real surface roughness; colour comes from the spec.

    def _project_image(self, rel):
        """Luminance 0..1 (rows top->bottom) of an image under the Unity project's Assets folder: the
        project that --out lives in, else $GOLFMAP_UNITY_PROJECT."""
        roots = []
        d = os.path.abspath(self.folder)
        while os.path.dirname(d) != d:
            if os.path.basename(d) == "Assets":
                roots.append(d)
            d = os.path.dirname(d)
        if os.environ.get("GOLFMAP_UNITY_PROJECT"):
            roots.append(os.path.join(os.environ["GOLFMAP_UNITY_PROJECT"], "Assets"))
        for r in roots:
            p = os.path.join(r, rel)
            if os.path.exists(p):
                img = bpy.data.images.load(p, check_existing=True)
                w, h = img.size
                px = np.empty(w * h * 4, dtype=np.float32)
                img.pixels.foreach_get(px)
                rgb = px.reshape(h, w, 4)[::-1, :, :3].astype(float)
                return rgb @ np.array([0.299, 0.587, 0.114])
        raise FileNotFoundError("photo texture %r: not under %s (build into the Unity project, or set GOLFMAP_UNITY_PROJECT)" % (rel, roots or "no Assets folder"))

    def tex_photo(self, src, color="140,139,134", contrast="1.0"):
        """A photo's surface detail recoloured to `color` (its mean), with faint large water stains."""
        lum = self._project_image(src)
        col = _rgb([int(c) for c in color.split(",")])
        rel = 1 + (lum / lum.mean() - 1) * float(contrast)
        stain = _fbm(lum.shape, 151, scales=(256, 128, 64))
        v = rel * (1 - 0.18 * np.clip((stain - 0.45) * 3, 0, 1))
        return col * v[:, :, None], lum, 2.0

    def tex_photoblocks(self, src, courses, blocks, colors):
        """A photo of block/brick coursing (`courses` rows of `blocks` per image), each block recoloured
        from `colors` (r,g,b|r,g,b...; repeat an entry to weight it) with the photo's own relief kept.
        Joints are found in the photo: the darkest rows repeat every course, the `blocks` darkest
        well-spaced columns inside a course are its head joints."""
        lum = self._project_image(src)
        h, w = lum.shape
        n, nb = int(courses), int(blocks)
        per = h / n
        rowm = lum.mean(1)
        phase = min(range(int(per)), key=lambda p: rowm[(np.arange(n) * per + p).astype(int) % h].mean())
        rows = (np.arange(h) - phase) % h
        course = np.floor(rows / per).astype(int)
        block = np.zeros((h, w), dtype=int)
        r = _rng(67)
        for k in range(n):
            band = course == k
            ys = np.where(band)[0]
            core = ys[int(len(ys) * 0.2): max(int(len(ys) * 0.8), int(len(ys) * 0.2) + 1)]
            colm = lum[core].mean(0)
            colm = np.convolve(np.concatenate([colm[-3:], colm, colm[:3]]), np.ones(5) / 5, "same")[3:-3]
            joints = []
            for x in np.argsort(colm):
                if len(joints) == nb:
                    break
                if all(min(abs(x - j), w - abs(x - j)) > 0.6 * w / nb for j in joints):
                    joints.append(int(x))
            seg = np.searchsorted(sorted(joints), np.arange(w), side="right") % nb
            block[band] = k * 64 + seg[None, :]
        pal = np.array([_rgb([int(c) for c in cc.split(",")]) for cc in colors.split("|")])
        pick = r.integers(0, len(pal), n * 64)
        bright = 1 + (r.random(n * 64) - 0.5) * 0.16
        # each block's detail relative to its own mean, so a dark source block does not stay dark
        sums = np.bincount(block.ravel(), lum.ravel(), n * 64)
        cnt = np.maximum(np.bincount(block.ravel(), minlength=n * 64), 1)
        rel = np.clip(lum / np.maximum(sums / cnt, 1e-3)[block], 0.25, 1.5)
        albedo = pal[pick[block]] * (rel * bright[block])[:, :, None]
        return albedo, lum, 4.0

    def tex_bark(self, color="120,96,70"):
        S = self.size
        col = _rgb([int(c) for c in color.split(",")])
        g = _fbm((S, S // 8), 131, scales=(32, 8, 2))
        g = np.repeat(g, 8, 1)[:, :S]
        return col * (0.75 + 0.4 * g)[:, :, None], g, 3.0


# ---------------------------------------------------------------------------------------------
# Materials
# ---------------------------------------------------------------------------------------------

# name: (texture spec or None, tile metres (u, v), flat colour sRGB, smoothness, metallic)
# Whites are kept at sRGB ~175 and matte: the course scene (linear, no tonemapping) lights sunlit faces at
# ~1.7x albedo (sun 1.1 + bright trilight ambient), so anything whiter clips and glows. Sheet-metal roofs stay
# rough: seen at a grazing angle a glossy roof mirrors the pale sky and turns white.
MATERIALS = {
    "falu_red_vertical": ("boards:106,33,29:v:0.20:2.0:2", (2.0, 2.0), None, 0.15, 0.0),
    "falu_red_dark_vertical": ("boards:88,29,26:v:0.20:2.0:2", (2.0, 2.0), None, 0.15, 0.0),
    "falu_red_horizontal": ("boards:92,30,26:h:0.20:2.0:0", (2.0, 2.0), None, 0.12, 0.0),
    "gazebo_red_panel": ("boards:110,38,34:v:0.10:1.0:0", (1.0, 1.0), None, 0.15, 0.0),
    "white_trim": (None, (1, 1), (174, 174, 168), 0.15, 0.0),
    "black_trim": (None, (1, 1), (26, 26, 28), 0.30, 0.0),
    "black_steel": (None, (1, 1), (22, 22, 24), 0.55, 0.6),
    "galvanised": (None, (1, 1), (160, 162, 165), 0.45, 0.7),
    "glass": (None, (1, 1), (58, 68, 78), 0.96, 0.85),
    "window_dark": (None, (1, 1), (46, 54, 62), 0.95, 0.75),
    "door_white": ("boards:180,180,174:v:0.12:1.0:0", (1.0, 1.0), None, 0.15, 0.0),
    "door_black": ("boards:30,30,32:v:0.12:1.0:0", (1.0, 1.0), None, 0.3, 0.0),
    "door_red": ("boards:120,36,30:v:0.12:1.0:0", (1.0, 1.0), None, 0.2, 0.0),
    "roof_tile_orange": ("pantile:164,80,56", (2.0, 2.0), None, 0.25, 0.0),
    "roof_metal_black": ("seam:30,31,33:0.52:2.08:0", (2.08, 2.08), None, 0.45, 0.4),
    "roof_metal_charcoal": ("seam:58,60,63:0.52:2.08:0", (2.08, 2.08), None, 0.4, 0.4),
    "roof_metal_grey": ("seam:120,122,124:0.076:2.0:1", (2.0, 2.0), None, 0.12, 0.1),
    "roof_felt_brown": ("felt:104,66,52", (2.0, 2.0), None, 0.1, 0.0),
    "roof_shingle_dark": ("shingle:62,62,64", (2.0, 2.0), None, 0.15, 0.0),
    "solar_panel": ("solar", (1.0, 1.7), None, 0.9, 0.3),
    "brick_paving": ("brickpave", (2.0, 2.0), None, 0.15, 0.0),
    "granite_plinth": ("stone:128,124,120", (2.0, 2.0), None, 0.2, 0.0),
    "granite_dark": ("stone:96,94,92", (2.0, 2.0), None, 0.2, 0.0),
    "granite_rock": ("granite:96,94,90", (4.0, 4.0), None, 0.18, 0.0),
    # field stones of the tee walls (photos c219a56f, 7176f1a2): lighter grey than the bedrock, olive moss on top
    "granite_boulder": ("granite:68,69,70:0.2", (4.0, 4.0), None, 0.12, 0.0),
    "granite_moss": ("granite:62,72,40:0.2", (4.0, 4.0), None, 0.05, 0.0),
    # the heap stones at hole 2's tee (photo, 2026-10-18): mid grey granite, patchy pale grey-green lichen, a few yellow-orange spots
    "granite_lichen": ("granite:112,110,106:0.5:0.9:0.7", (4.0, 4.0), None, 0.15, 0.0),
    # hole 16's boulders: the same lichen granite, mid-to-dark grey (granite_lichen is lit to near white on the pale slabs)
    "granite_lichen_dark": ("granite:50,49,47:0.3:0.7:0.3", (4.0, 4.0), None, 0.15, 0.0),
    # the stone box at hole 3's tees (video frame): pale grey-beige granite
    "granite_beige": ("granite:134,128,116:0.45:0.25:0.15", (4.0, 4.0), None, 0.15, 0.0),
    # Omberg's stone crossings: the warm heaps on hole 6 (photo: sandstone-pink to ochre in low sun) and the old arch
    # bridges on holes 7 and 9 (mid-grey field stone, photos 2026-10-19)
    "sandstone_core": ("granite:84,58,40:0.05:0:0", (4.0, 4.0), None, 0.1, 0.0),
    "sandstone_ochre": ("granite:176,120,66:0.05:0:0", (4.0, 4.0), None, 0.12, 0.0),
    "sandstone_rust": ("granite:164,102,62:0.05:0:0", (4.0, 4.0), None, 0.12, 0.0),
    "sandstone_dark": ("granite:124,86,58:0.1:0:0", (4.0, 4.0), None, 0.12, 0.0),
    "fieldstone_grey": ("granite:128,124,118:0.3:0.1:0", (4.0, 4.0), None, 0.15, 0.0),
    "fieldstone_dark": ("granite:100,96,92:0.25:0.05:0", (4.0, 4.0), None, 0.15, 0.0),
    "fieldstone_brown": ("granite:130,118,108:0.3:0.1:0", (4.0, 4.0), None, 0.15, 0.0),
    # ivy over the big boulders by hole 13's tees (photo cddccbea, late September: yellowing)
    "ivy": ("foliage:92,104,40", (1.5, 1.5), None, 0.1, 0.0),
    "concrete": ("plaster:138,136,130", (2.0, 2.0), None, 0.15, 0.0),
    # the 18th's footbridge (photo 101): split-face concrete blocks, grey and dusty rose, ~0.5 x 0.15 m
    # (the source photo is 24 courses of 6 blocks), on a weathered concrete arch with a grey coping
    "splitface_block": ("photoblocks:Buildings/Residential Houses/Textures/219_rustic facing bricks texture-seamless.jpg:24:6:"
                        "106,105,101|94,93,90|116,114,109|110,80,75|99,72,68|118,89,83", (3.0, 3.6), None, 0.05, 0.0),
    "concrete_weathered": ("photo:Buildings/Residential Houses/Textures/165_concrete bare clean texture-seamless_A.jpg:102,101,97:1.6",
                           (2.0, 2.0), None, 0.05, 0.0),
    "hedge": ("foliage:58,86,40", (1.5, 1.5), None, 0.1, 0.0),
    "hedge_beech": ("foliage:92,98,44", (1.5, 1.5), None, 0.1, 0.0),
    "white_stones": ("gravel:168,164,156", (2.0, 2.0), None, 0.15, 0.0),
    "turf_mat": ("turf:40,70,42", (1.0, 1.0), None, 0.05, 0.0),
    "turf_mat_dark": ("turf:26,48,30", (1.0, 1.0), None, 0.05, 0.0),
    "asphalt": ("asphalt:92,92,90", (2.0, 2.0), None, 0.1, 0.0),
    "shutter_black": ("louvre:24,24,26", (1.0, 1.0), None, 0.25, 0.0),
    "wood_bench": ("boards:150,112,74:h:0.12:1.0:0", (1.0, 1.0), None, 0.2, 0.0),
    "wood_grey": ("boards:120,116,108:h:0.14:1.0:0", (1.0, 1.0), None, 0.15, 0.0),
    "wood_post": ("bark:120,96,70", (1.0, 1.0), None, 0.1, 0.0),
    # the 14th's rope footbridge (photos 83-84): silver-grey deck planks, dark brown stained posts, old
    # railway sleepers for the steps, off-white hemp rope. One board per tile: the planks are geometry.
    "wood_deck_grey": ("boards:86,82,75:v:1.0:1.0:2", (1.0, 1.0), None, 0.1, 0.0),
    "wood_post_brown": ("boards:68,50,42:v:1.0:1.0:2", (1.0, 1.0), None, 0.15, 0.0),
    "wood_sleeper": ("boards:74,69,62:v:1.0:1.0:2", (1.0, 1.0), None, 0.05, 0.0),
    "rope_hemp": (None, (1, 1), (124, 120, 110), 0.05, 0.0),
    "rubber_black": (None, (1, 1), (18, 18, 18), 0.3, 0.0),
    "tyre": (None, (1, 1), (20, 20, 20), 0.2, 0.0),
    "chrome": (None, (1, 1), (200, 200, 205), 0.9, 1.0),
    "light_lens": (None, (1, 1), (240, 236, 220), 0.8, 0.0),
    "flag_white": (None, (1, 1), (200, 200, 198), 0.1, 0.0),
    "flag_blue": (None, (1, 1), (22, 70, 160), 0.1, 0.0),
    "flag_navy": (None, (1, 1), (20, 36, 80), 0.1, 0.0),
    "flag_yellow": (None, (1, 1), (250, 200, 20), 0.1, 0.0),
    "flag_orange": (None, (1, 1), (236, 120, 40), 0.1, 0.0),
    "flag_red": (None, (1, 1), (200, 30, 36), 0.1, 0.0),
    "flag_green": (None, (1, 1), (30, 130, 70), 0.1, 0.0),
    "sign_blue": (None, (1, 1), (20, 90, 180), 0.3, 0.0),
    "sign_yellow": (None, (1, 1), (240, 200, 40), 0.3, 0.0),
    "sign_black": (None, (1, 1), (20, 22, 24), 0.4, 0.0),
    "sign_green": (None, (1, 1), (30, 60, 45), 0.4, 0.0),
    "net": ("netting:30,32,30", (1.0, 1.0), None, 0.1, 0.0),
    "paint_red": (None, (1, 1), (190, 30, 30), 0.5, 0.2),
    "paint_white": (None, (1, 1), (176, 177, 178), 0.25, 0.0),
    "line_paint": (None, (1, 1), (187, 187, 187), 0.2, 0.0),  # road marking paint (#bbb)
    "paint_black": (None, (1, 1), (18, 19, 21), 0.85, 0.4),
    "paint_grey": (None, (1, 1), (98, 102, 106), 0.8, 0.5),
    "paint_silver": (None, (1, 1), (160, 164, 168), 0.8, 0.6),
    "paint_blue": (None, (1, 1), (32, 52, 92), 0.85, 0.5),
    "paint_darkred": (None, (1, 1), (120, 22, 26), 0.85, 0.4),
    "paint_green": (None, (1, 1), (40, 70, 55), 0.5, 0.2),
    "car_glass": (None, (1, 1), (34, 40, 46), 0.95, 0.6),
    "plate": (None, (1, 1), (186, 186, 182), 0.3, 0.0),
    "target_flag_red": (None, (1, 1), (220, 30, 30), 0.1, 0.0),
    "target_flag_yellow": (None, (1, 1), (240, 210, 30), 0.1, 0.0),
    "target_flag_white": (None, (1, 1), (200, 200, 198), 0.1, 0.0),
}


CUTOUT = set()
FADE = {"net"}  # translucent: cords up close, a soft dark veil at distance (mipmapped alpha); cutout aliased


def material_table(bank, names=None):
    """Build the textures of the named materials (default: all); returns {name: dict} for the Unity manifest."""
    out = {}
    for name, (tex, tile, flat, smooth, metal) in MATERIALS.items():
        if names is not None and name not in names:
            continue
        d = {"tileU": tile[0], "tileV": tile[1], "smoothness": smooth, "metallic": metal}
        if name in CUTOUT:
            d["cutout"] = True
        if name in FADE:
            d["fade"] = True
        if tex:
            try:
                a, n, mk = bank.get(tex, name, metal)
            except FileNotFoundError as e:  # a photo texture outside a Unity project: fails only if an asset uses it
                print("warning: material %s skipped: %s" % (name, e))
                continue
            d["albedo"] = os.path.basename(a)
            if n:
                d["normal"] = os.path.basename(n)
            if mk:
                d["mask"] = os.path.basename(mk)
            d["color"] = [1.0, 1.0, 1.0]
        else:
            d["color"] = [round(c / 255.0, 4) for c in flat]
        out[name] = d
    return out


def blender_material(name, table, tex_folder):
    m = bpy.data.materials.get(name)
    if m:
        return m
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    bsdf = nt.nodes.get("Principled BSDF")
    if name not in table:
        raise KeyError("material %s has no textures (see the warning above)" % name)
    d = table[name]
    bsdf.inputs["Roughness"].default_value = 1 - d["smoothness"]
    bsdf.inputs["Metallic"].default_value = d["metallic"]
    if "albedo" in d:
        tx = nt.nodes.new("ShaderNodeTexImage")
        tx.image = bpy.data.images.load(os.path.join(tex_folder, d["albedo"]), check_existing=True)
        nt.links.new(tx.outputs["Color"], bsdf.inputs["Base Color"])
        if "normal" in d:
            tn = nt.nodes.new("ShaderNodeTexImage")
            tn.image = bpy.data.images.load(os.path.join(tex_folder, d["normal"]), check_existing=True)
            tn.image.colorspace_settings.name = "Non-Color"
            nm = nt.nodes.new("ShaderNodeNormalMap")
            nt.links.new(tn.outputs["Color"], nm.inputs["Color"])
            nt.links.new(nm.outputs["Normal"], bsdf.inputs["Normal"])
    else:
        c = d["color"]
        # flat colours are sRGB; Blender wants linear
        lin = [((v + 0.055) / 1.055) ** 2.4 if v > 0.04045 else v / 12.92 for v in c]
        bsdf.inputs["Base Color"].default_value = (lin[0], lin[1], lin[2], 1.0)
    return m


# ---------------------------------------------------------------------------------------------
# Geometry accumulator
# ---------------------------------------------------------------------------------------------


class Geo:
    """Faces with a material and a UV mode. `xf` is the current transform (a stack via push/pop)."""

    def __init__(self):
        self.verts = []
        self.faces = []  # (vertex indices, material, uvmode)
        self.stack = [Matrix.Identity(4)]

    @property
    def xf(self):
        return self.stack[-1]

    def push(self, m):
        self.stack.append(self.stack[-1] @ m)

    def pop(self):
        self.stack.pop()

    def poly(self, pts, mat, uv=None):
        """pts: 3D points (local to the current transform), counter-clockwise seen from outside."""
        base = len(self.verts)
        for p in pts:
            self.verts.append(self.xf @ Vector(p))
        self.faces.append((list(range(base, base + len(pts))), mat, uv))

    def box(self, c, s, mat, rz=0.0, mats=None, uv=None, skip=()):
        """Axis box centred at c with size s, rotated rz degrees about its centre's z.
        mats: optional per-face {'top','bottom','side'} override. skip: faces to omit."""
        cx, cy, cz = c
        hx, hy, hz = s[0] / 2, s[1] / 2, s[2] / 2
        self.push(Matrix.Translation((cx, cy, cz)) @ Matrix.Rotation(math.radians(rz), 4, "Z"))
        p = [(-hx, -hy, -hz), (hx, -hy, -hz), (hx, hy, -hz), (-hx, hy, -hz), (-hx, -hy, hz), (hx, -hy, hz), (hx, hy, hz), (-hx, hy, hz)]
        mats = mats or {}
        fs = {
            "bottom": [3, 2, 1, 0], "top": [4, 5, 6, 7], "-y": [0, 1, 5, 4],
            "+x": [1, 2, 6, 5], "+y": [2, 3, 7, 6], "-x": [3, 0, 4, 7],
        }
        for k, idx in fs.items():
            if k in skip:
                continue
            m = mats.get(k) or (mats.get("side") if k not in ("top", "bottom") else None) or mat
            self.poly([p[i] for i in idx], m, uv)
        self.pop()

    def beam(self, a, b, w, h, mat, uv=None):
        """A rectangular beam from point a to point b (w across horizontally, h vertical-ish)."""
        a, b = Vector(a), Vector(b)
        d = b - a
        L = d.length
        if L < 1e-6:
            return
        fwd = d / L
        # Right-handed (fwd, side, up) basis: the reverse cross order mirrored the box, so every
        # beam's faces were wound inside out (back-face culled in Unity).
        side = UP.cross(fwd)
        if side.length < 1e-4:
            side = Vector((1, 0, 0))
        side.normalize()
        upv = fwd.cross(side).normalized()
        m = Matrix((
            (fwd.x, side.x, upv.x, 0), (fwd.y, side.y, upv.y, 0), (fwd.z, side.z, upv.z, 0), (0, 0, 0, 1)))
        self.push(Matrix.Translation(a) @ m)
        self.box((L / 2, 0, 0), (L, w, h), mat, uv=uv)
        self.pop()

    def cylinder(self, c, r, h, mat, seg=12, cap=True, r_top=None, uv=None):
        cx, cy, cz = c
        rt = r if r_top is None else r_top
        ring0 = [(cx + r * math.cos(2 * math.pi * i / seg), cy + r * math.sin(2 * math.pi * i / seg), cz) for i in range(seg)]
        ring1 = [(cx + rt * math.cos(2 * math.pi * i / seg), cy + rt * math.sin(2 * math.pi * i / seg), cz + h) for i in range(seg)]
        for i in range(seg):
            j = (i + 1) % seg
            self.poly([ring0[i], ring0[j], ring1[j], ring1[i]], mat, uv)
        if cap:
            self.poly(ring1, mat, uv)
            self.poly(list(reversed(ring0)), mat, uv)

    def pipe(self, a, b, r, mat, seg=8, cap=True):
        """Round tube from a to b."""
        a, b = Vector(a), Vector(b)
        d = b - a
        L = d.length
        if L < 1e-6:
            return
        z = d / L
        x = z.cross(UP) if abs(z.z) < 0.99 else Vector((1, 0, 0)).cross(z)
        x.normalize()
        y = z.cross(x)
        m = Matrix(((x.x, y.x, z.x, a.x), (x.y, y.y, z.y, a.y), (x.z, y.z, z.z, a.z), (0, 0, 0, 1)))
        self.push(m)
        self.cylinder((0, 0, 0), r, L, mat, seg=seg, cap=cap)
        self.pop()

    def sphere(self, c, r, mat, seg=10, rings=6, scale=(1, 1, 1)):
        cx, cy, cz = c
        pts = []
        for j in range(rings + 1):
            t = math.pi * j / rings
            row = []
            for i in range(seg):
                a = 2 * math.pi * i / seg
                row.append((cx + r * scale[0] * math.sin(t) * math.cos(a), cy + r * scale[1] * math.sin(t) * math.sin(a), cz + r * scale[2] * math.cos(t)))
            pts.append(row)
        for j in range(rings):
            for i in range(seg):
                k = (i + 1) % seg
                self.poly([pts[j][i], pts[j + 1][i], pts[j + 1][k], pts[j][k]], mat)

    def extrude(self, poly2d, z0, z1, mat, top=None, bottom=None, uv=None):
        """Vertical prism from a CCW footprint polygon."""
        n = len(poly2d)
        for i in range(n):
            a, b = poly2d[i], poly2d[(i + 1) % n]
            self.poly([(a[0], a[1], z0), (b[0], b[1], z0), (b[0], b[1], z1), (a[0], a[1], z1)], mat, uv)
        self.poly([(p[0], p[1], z1) for p in poly2d], top or mat, uv)
        if bottom is not False:
            self.poly([(p[0], p[1], z0) for p in reversed(poly2d)], bottom or mat, uv)


# ---------------------------------------------------------------------------------------------
# Buildings
# ---------------------------------------------------------------------------------------------


class Roof:
    """Roof over a rectangle (roof-local: ridge along x, walls at y = +-w/2).

    kind gable: eaveA at y=-w/2, eaveB at y=+w/2, ridge height `ridge` at y=ridgeY.
    kind mono:  low (eaveA) at -w/2 rising to high (eaveB) at +w/2.
    kind flat:  eaveA everywhere.
    """

    def __init__(self, spec, w):
        self.kind = spec.get("type", "gable")
        self.w = w
        self.eaveA = spec.get("eaveA", spec.get("eave", 3.0))
        self.eaveB = spec.get("eaveB", spec.get("eave", self.eaveA if self.kind != "mono" else spec.get("high", 4.0)))
        if self.kind == "mono":
            self.eaveA = spec.get("low", spec.get("eaveA", 3.0))
            self.eaveB = spec.get("high", spec.get("eaveB", 4.0))
        self.ridge = spec.get("ridge", max(self.eaveA, self.eaveB) + 2)
        self.ridgeY = spec.get("ridgeY", 0.0)
        if self.kind == "mono":
            self.ridgeY = w / 2
            self.ridge = self.eaveB
        if self.kind == "flat":
            self.ridgeY = w / 2
            self.ridge = self.eaveB = self.eaveA

    def z(self, y):
        h = self.w / 2
        if self.kind in ("mono", "flat"):
            return self.eaveA + (y + h) / self.w * (self.eaveB - self.eaveA)
        if y <= self.ridgeY:
            return self.eaveA + (y + h) / (self.ridgeY + h) * (self.ridge - self.eaveA)
        return self.ridge - (y - self.ridgeY) / (h - self.ridgeY) * (self.ridge - self.eaveB)

    def slopes(self):
        """[(y_low_wall, z_low, y_high, z_high)] per slope, low edge at the wall line."""
        h = self.w / 2
        out = [(-h, self.eaveA, self.ridgeY, self.ridge)]
        if self.kind == "gable":
            out.append((h, self.eaveB, self.ridgeY, self.ridge))
        return out


TILE_ROOFS = {"roof_tile_orange": 0.34}          # course length (m): stepped courses as geometry
SEAM_ROOFS = {"roof_metal_black": 0.52, "roof_metal_charcoal": 0.52}  # standing-seam spacing (m)


def _roof_slab(g, x0, x1, ylow, zlow, yhigh, zhigh, ovh, thick, mat, under, edge, ext_high=0.0, seams=True):
    """One roof plane from the wall line (ylow,zlow) up to (yhigh,zhigh), extended `ovh` past the
    wall (down-slope) and `ext_high` past the high edge (mono roofs). Top face `mat`; tile roofs get
    stepped courses, sheet-metal roofs raised standing seams."""
    dy, dz = yhigh - ylow, zhigh - zlow
    L = math.hypot(dy, dz)
    uy, uz = dy / L, dz / L
    # eave edge beyond the wall, measured horizontally
    k = ovh / abs(uy) if abs(uy) > 1e-6 else ovh
    ey, ez = ylow - uy * k, zlow - uz * k
    hy, hz = yhigh + uy * (ext_high / abs(uy) if ext_high and abs(uy) > 1e-6 else 0), zhigh + uz * (ext_high / abs(uy) if ext_high and abs(uy) > 1e-6 else 0)
    # normal of the plane pointing up
    ny, nz = -uz, uy
    if nz < 0:
        ny, nz = -ny, -nz
    ty, tz = -ny * thick, -nz * thick
    top = [(x0, ey, ez), (x1, ey, ez), (x1, hy, hz), (x0, hy, hz)]
    bot = [(x0, ey + ty, ez + tz), (x1, ey + ty, ez + tz), (x1, hy + ty, hz + tz), (x0, hy + ty, hz + tz)]
    s = 1 if hy > ey else -1  # keep faces outward-facing whichever way the slope runs
    S = math.hypot(hy - ey, hz - ez)

    def P(x, t, lift):
        f = t / S
        return (x, ey + (hy - ey) * f + ny * lift, ez + (hz - ez) * f + nz * lift)

    if mat in TILE_ROOFS:
        cl, lip = TILE_ROOFS[mat], 0.035
        n = max(1, int(math.ceil(S / cl)))
        for c in range(n):
            t0, t1 = c * S / n, (c + 1) * S / n
            strip = [P(x0, t0, lip), P(x1, t0, lip), P(x1, t1, 0.0), P(x0, t1, 0.0)]
            front = [P(x0, t0, 0.0), P(x1, t0, 0.0), P(x1, t0, lip), P(x0, t0, lip)]
            for q in (strip, front):
                g.poly(q if s > 0 else [q[1], q[0], q[3], q[2]], mat)
    elif mat in SEAM_ROOFS and seams:
        sp = SEAM_ROOFS[mat]
        for i in range(1, int((x1 - x0) / sp)):
            x = x0 + i * sp
            g.beam(P(x, 0.05, 0.0), P(x, S - 0.02, 0.0), 0.03, 0.07, mat)
    if s > 0:
        if mat not in TILE_ROOFS:
            g.poly(top, mat)
        g.poly(list(reversed(bot)), under)
        g.poly([bot[0], bot[1], top[1], top[0]], edge)  # fascia (eave edge)
        g.poly([bot[3], top[3], top[2], bot[2]], edge)
        g.poly([bot[0], top[0], top[3], bot[3]], edge)  # barge x0
        g.poly([bot[1], bot[2], top[2], top[1]], edge)  # barge x1
    else:
        if mat not in TILE_ROOFS:
            g.poly(list(reversed(top)), mat)
        g.poly(bot, under)
        g.poly([top[0], top[1], bot[1], bot[0]], edge)
        g.poly([bot[2], top[2], top[3], bot[3]], edge)
        g.poly([bot[3], top[3], top[0], bot[0]], edge)
        g.poly([top[1], top[2], bot[2], bot[1]], edge)
    return (ey, ez), (hy, hz), (ny, nz)


def _wall_segments(footprint):
    n = len(footprint)
    return [(footprint[i], footprint[(i + 1) % n]) for i in range(n)]


def _edge_frame(a, b):
    ex, ey = b[0] - a[0], b[1] - a[1]
    L = math.hypot(ex, ey)
    ux, uy = ex / L, ey / L
    return L, ux, uy, uy, -ux  # length, along, outward normal


def _edge_openings(a, b, openings, fp):
    """(t0, t1, z0, z1) boxes (along the edge from a, and height) kept clear for openings on this wall."""
    L, ux, uy, nx, ny = _edge_frame(a, b)
    side = "+x" if nx > 0.9 else "-x" if nx < -0.9 else "+y" if ny > 0.9 else "-y" if ny < -0.9 else None
    out = []
    for o in openings:
        if o.get("side") != side:
            continue
        plane = o.get("plane", _side_plane(fp, side))
        coord = a[0] if side in ("+x", "-x") else a[1]
        if abs(plane - coord) > 0.05:
            continue
        along, u = (a[1], uy) if side in ("+x", "-x") else (a[0], ux)
        t = (o["at"] - along) / u
        if t < -1 or t > L + 1:
            continue
        m = o.get("frameW", 0.08) + _casing(o) + 0.03
        sill = o.get("sill", 0.9)
        out.append((t - o.get("w", 1.2) / 2 - m, t + o.get("w", 1.2) / 2 + m, sill - m, sill + o.get("h", 1.2) + m + 0.05))
    return out


def _casing(o):
    return o.get("casing", 0.1 if o.get("kind", "window") in ("window", "door", "glassdoor") else 0.0)


def _cut(segs, lo, hi):
    out = []
    for a, b in segs:
        if hi <= a or lo >= b:
            out.append((a, b))
            continue
        if lo > a:
            out.append((a, lo))
        if hi < b:
            out.append((hi, b))
    return out


def _cladding(g, fp, walled, roof, base, ph, tw, openings, clad, mat):
    """Real relief on board walls: vertical battens (board-and-batten) or horizontal lap boards,
    kept clear of windows and doors and stopping under the roof."""
    kind = clad.get("type")
    d = clad.get("depth", 0.022)
    z0 = base + ph
    for (a, b), on in zip(_wall_segments(fp), walled):
        if not on:
            continue
        L, ux, uy, nx, ny = _edge_frame(a, b)
        ops = _edge_openings(a, b, openings, fp)

        def P(t, z, off):
            return (a[0] + ux * t + nx * off, a[1] + uy * t + ny * off, z)

        ztop = lambda t: roof.z(a[1] + uy * t) - tw - 0.02
        if kind == "battens":
            w = clad.get("w", 0.055)
            n = max(1, int(round(L / clad.get("spacing", 0.2))))
            rz = math.degrees(math.atan2(uy, ux))
            for i in range(1, n):
                t = i * L / n
                if t < 0.14 or t > L - 0.14:
                    continue
                segs = [(z0, ztop(t))]
                for t0, t1, s0, s1 in ops:
                    if t0 - w / 2 < t < t1 + w / 2:
                        segs = _cut(segs, s0, s1)
                for za, zb in segs:
                    if zb - za > 0.05:
                        p = P(t, (za + zb) / 2, d / 2)
                        g.box(p, (w, d, zb - za), mat, rz=rz, skip=("+y",))
        elif kind == "lap":
            row = clad.get("row", 0.2)
            zr = z0
            ts = [L * k / max(1, int(L / 0.05)) for k in range(int(L / 0.05) + 1)]
            while True:
                ok = [t for t in ts if ztop(t) >= zr + row]
                if not ok:
                    break
                segs = [(ok[0], ok[-1])]
                for t0, t1, s0, s1 in ops:
                    if s0 < zr + row and s1 > zr:
                        segs = _cut(segs, t0, t1)
                for ta, tb in segs:
                    if tb - ta < 0.05:
                        continue
                    g.poly([P(ta, zr, d), P(tb, zr, d), P(tb, zr + row, 0.004), P(ta, zr + row, 0.004)], mat)
                    g.poly([P(ta, zr, 0.0), P(tb, zr, 0.0), P(tb, zr, d), P(ta, zr, d)], mat)
                zr += row


def _gutter(g, x0, x1, gy, gz, r, mat):
    """Half-round gutter along x (open top), both faces."""
    n = 7
    prof = [(gy + r * math.cos(math.pi + math.pi * k / (n - 1)), gz + r * math.sin(math.pi + math.pi * k / (n - 1))) for k in range(n)]
    for k in range(n - 1):
        (ya, za), (yb, zb) = prof[k], prof[k + 1]
        q = [(x0, ya, za), (x1, ya, za), (x1, yb, zb), (x0, yb, zb)]
        g.poly(q, mat)
        g.poly(list(reversed(q)), mat)
    for x in (x0, x1):
        cap = [(x, y, z) for y, z in prof]
        g.poly(cap, mat)
        g.poly(list(reversed(cap)), mat)


def building(g, spec):
    """A house/shed/hall. spec keys:
      length, width (walls rectangle, local x/y), footprint (optional CCW polygon, default rectangle),
      roof {type gable|mono|flat, eave|eaveA/eaveB, ridge, ridgeY, low/high, overhang, gableOverhang,
            thick, mat, under, edge, solar:[{side, x0, x1, rows?}], ridgeCap}
      wall (material), walls (list of bools per footprint edge; false = open), trim, cornerBoards,
      plinth {h, mat}, openings [...], posts [[x,y],...], postSize, postMat.
    Roof heights are defined at y = +-width/2 of the wall rectangle."""
    L, W = spec["length"], spec["width"]
    r = spec.get("roof", {})
    roof = Roof(r, W)
    wall_mat = spec.get("wall", "falu_red_vertical")
    trim = spec.get("trim", "white_trim")
    fp = spec.get("footprint") or [(-L / 2, -W / 2), (L / 2, -W / 2), (L / 2, W / 2), (-L / 2, W / 2)]
    walled = spec.get("walls") or [True] * len(fp)
    plinth = spec.get("plinth", {"h": 0.25, "mat": "concrete"})
    ph = plinth.get("h", 0.25)
    sink = spec.get("sink", 1.5)
    base = spec.get("floor", 0.0)  # floor level above the placement ground

    # walls (split at the ridge so gable walls get their peak)
    for (a, b), on in zip(_wall_segments(fp), walled):
        if not on:
            continue
        pts = [a]
        if roof.kind == "gable" and (a[1] - roof.ridgeY) * (b[1] - roof.ridgeY) < 0:
            t = (roof.ridgeY - a[1]) / (b[1] - a[1])
            pts.append((a[0] + t * (b[0] - a[0]), roof.ridgeY))
        pts.append(b)
        tw = r.get("thick", 0.18) * 0.5  # wall tops end inside the roof slab, not through it
        poly = [(a[0], a[1], base + ph)] + [(b[0], b[1], base + ph)] + [(p[0], p[1], roof.z(p[1]) - tw) for p in reversed(pts)]
        g.poly(poly, wall_mat)
        # plinth band (and foundation down into the ground)
        if ph > 0 or sink > 0:
            nx, ny = (b[1] - a[1]), -(b[0] - a[0])
            ln = math.hypot(nx, ny)
            o = 0.03
            ox, oy = nx / ln * o, ny / ln * o
            g.poly([(a[0] + ox, a[1] + oy, -sink), (b[0] + ox, b[1] + oy, -sink), (b[0] + ox, b[1] + oy, base + ph), (a[0] + ox, a[1] + oy, base + ph)], plinth.get("mat", "concrete"))
    # floor/ceiling so open sheds are not see-through from below the roof
    if not all(walled):
        g.poly([(p[0], p[1], base + ph) for p in fp], spec.get("floorMat", "concrete"))

    # corner boards
    if spec.get("cornerBoards", True):
        cb = spec.get("cornerBoard", 0.12)
        n = len(fp)
        for i in range(n):
            if not (walled[i] or walled[i - 1]):
                continue
            x, y = fp[i]
            zt = roof.z(y) - r.get("thick", 0.18)
            g.box((x, y, (base + ph + zt) / 2), (cb + 0.02, cb + 0.02, zt - base - ph), spec.get("cornerMat", trim))

    # roof planes
    ovh = r.get("overhang", 0.5)
    govh = r.get("gableOverhang", 0.3)
    thick = r.get("thick", 0.18)
    xs = [p[0] for p in fp]
    x0, x1 = min(xs) - govh, max(xs) + govh
    rmat, under, edge = r.get("mat", "roof_tile_orange"), r.get("under", trim), r.get("edge", trim)
    planes = []
    for (yl, zl, yh, zh) in roof.slopes():
        ext = ovh if roof.kind in ("mono", "flat") else 0.0
        planes.append((yl, zl, yh, zh, _roof_slab(g, x0, x1, yl, zl, yh, zh, ovh, thick, rmat, under, edge, ext_high=ext, seams=r.get("seams", True))))
    if roof.kind == "gable" and r.get("ridgeCap", True):
        g.box(((x0 + x1) / 2, roof.ridgeY, roof.ridge + 0.02), (x1 - x0, 0.22, 0.12), r.get("ridgeMat", edge if rmat.startswith("roof_metal") else rmat))

    # solar arrays laid on a slope: side '-y' or '+y'
    for s in r.get("solar", []):
        idx = 0 if s.get("side", "-y") == "-y" else 1
        yl, zl, yh, zh, ((ey, ez), (hy, hz), (ny, nz)) = planes[min(idx, len(planes) - 1)]
        dy, dz = yh - yl, zh - zl
        Ls = math.hypot(dy, dz)
        uy, uz = dy / Ls, dz / Ls
        m0, m1 = s.get("from", 0.3), Ls - s.get("to", 0.3)
        lift = 0.06
        pw, plen = 1.0, 1.7
        nrow = int((m1 - m0) // plen)
        ncol = int((s["x1"] - s["x0"]) // pw)
        xa = (s["x0"] + s["x1"]) / 2 - ncol * pw / 2
        for j in range(nrow):
            t0 = m0 + j * plen
            t1 = t0 + plen - 0.02
            p0 = (yl + uy * t0 + ny * lift, zl + uz * t0 + nz * lift)
            p1 = (yl + uy * t1 + ny * lift, zl + uz * t1 + nz * lift)
            quad = [(xa, p0[0], p0[1]), (xa + ncol * pw, p0[0], p0[1]), (xa + ncol * pw, p1[0], p1[1]), (xa, p1[0], p1[1])]
            if dy < 0:
                quad = [quad[1], quad[0], quad[3], quad[2]]
            g.poly(quad, "solar_panel", uv=("fit", ncol, 1))

    # porch posts (from the floor to the roof underside)
    ps = spec.get("postSize", 0.14)
    for p in spec.get("posts", []):
        g.box((p[0], p[1], (base + roof.z(p[1]) - thick) / 2), (ps, ps, roof.z(p[1]) - thick - base), spec.get("postMat", trim))

    for o in spec.get("openings", []):
        opening(g, o, fp, roof, trim)

    # wall relief: battens on vertical boards, lap rows on horizontal boards (default by material)
    clad = spec.get("cladding")
    if clad is None:
        clad = {"type": "battens"} if "vertical" in wall_mat else {"type": "lap"} if "horizontal" in wall_mat else {}
    if clad:
        _cladding(g, fp, walled, roof, base, ph, r.get("thick", 0.18) * 0.5, spec.get("openings", []), clad, wall_mat)

    # gutters along every eave (low) edge, downpipes at both ends down the wall
    if r.get("gutters", True):
        gm = r.get("gutterMat", "black_steel" if trim == "black_trim" else "galvanised")
        for (yl, zl, yh, zh, ((ey, ez), _hh, _nn)) in planes:
            out = 1 if ey > yl else -1
            gr = 0.07
            gy, gz = ey + out * (gr * 0.6), ez - 0.11
            _gutter(g, x0 + 0.02, x1 - 0.02, gy, gz, gr, gm)
            for x in (min(xs) + 0.3, max(xs) - 0.3):
                wy = yl + out * 0.09
                top = (x, gy, gz - gr)
                elbow = (x, wy, gz - gr - 0.35)
                g.pipe(top, elbow, 0.045, gm, seg=8)
                g.pipe(elbow, (x, wy, base + 0.35), 0.045, gm, seg=8)
                g.pipe((x, wy, base + 0.35), (x, wy + out * 0.25, base + 0.1), 0.045, gm, seg=8)
                for zc in (gz - 1.5, 1.2):
                    if zc > base + 0.5 and zc < gz - 0.6:
                        g.box((x, (wy + yl) / 2, zc), (0.12, abs(wy - yl), 0.03), gm)

    for c in spec.get("chimneys", []):
        zt = roof.z(c["y"])
        h, sx, sy = c.get("h", 1.2), c.get("sx", 0.6), c.get("sy", 0.6)
        g.box((c["x"], c["y"], zt + h / 2 - 0.3), (sx, sy, h + 0.6), c.get("mat", "black_trim"))
        g.box((c["x"], c["y"], zt + h + 0.04), (sx + 0.12, sy + 0.12, 0.08), c.get("capMat", "black_steel"))
    return roof


def _side_plane(fp, side):
    xs = [p[0] for p in fp]
    ys = [p[1] for p in fp]
    return {"+y": max(ys), "-y": min(ys), "+x": max(xs), "-x": min(xs)}[side]


def opening(g, o, fp, roof, trim):
    """Window/door on a wall. o: side (+y/-y/+x/-x), at (coordinate along the wall), w, h, sill,
    kind window|door|glassdoor|shutter|vent|garage|glasswall, frame (material), plane (wall coordinate
    override), bars [cols, rows]."""
    side = o["side"]
    plane = o.get("plane", _side_plane(fp, side))
    w, h, sill = o.get("w", 1.2), o.get("h", 1.2), o.get("sill", 0.9)
    kind = o.get("kind", "window")
    frame = o.get("frame", trim)
    depth = 0.06
    fw = o.get("frameW", 0.08)
    # local frame: u along the wall, n outward
    if side == "+y":
        m = Matrix(((-1, 0, 0, o["at"]), (0, 0, 1, plane), (0, 1, 0, 0), (0, 0, 0, 1)))
    elif side == "-y":
        m = Matrix(((1, 0, 0, o["at"]), (0, 0, -1, plane), (0, 1, 0, 0), (0, 0, 0, 1)))
    elif side == "+x":
        m = Matrix(((0, 0, 1, plane), (1, 0, 0, o["at"]), (0, 1, 0, 0), (0, 0, 0, 1)))
    else:
        m = Matrix(((0, 0, -1, plane), (-1, 0, 0, o["at"]), (0, 1, 0, 0), (0, 0, 0, 1)))
    # in the opening frame: x along wall, y up, z out of the wall
    g.push(m)
    fill = {"window": "window_dark", "glassdoor": "glass", "glasswall": "glass", "door": o.get("mat", "door_white"),
            "shutter": "shutter_black", "vent": "shutter_black", "garage": o.get("mat", "door_red")}[kind]
    g.poly([(-w / 2, sill, 0.015), (w / 2, sill, 0.015), (w / 2, sill + h, 0.015), (-w / 2, sill + h, 0.015)], fill,
           uv=("fit", 1, 1) if kind in ("shutter", "vent") else None)
    if kind != "vent":
        # frame: four bars proud of the wall
        g.box((0, sill + h - fw / 2, depth / 2), (w + fw, fw, depth), frame)
        g.box((0, sill + fw / 2, depth / 2), (w + fw, fw, depth), frame)
        g.box((-w / 2, sill + h / 2, depth / 2), (fw, h, depth), frame)
        g.box((w / 2, sill + h / 2, depth / 2), (fw, h, depth), frame)
        cols, rows = o.get("bars", [2 if kind == "window" and w > 1.0 else 1, 1])
        for i in range(1, cols):
            g.box((-w / 2 + w * i / cols, sill + h / 2, depth / 2), (fw * 0.6, h, depth * 0.8), frame)
        for j in range(1, rows):
            g.box((0, sill + h * j / rows, depth / 2), (w, fw * 0.6, depth * 0.8), frame)
        if kind == "window" and o.get("sillBoard", True):
            g.box((0, sill - fw - 0.02, 0.07), (w + 2 * fw + 0.24, 0.04, 0.14), frame)
        cw = _casing(o)
        if cw:
            cd = 0.035
            g.box((0, sill + h + fw + cw / 2 - 0.02, cd / 2), (w + 2 * fw + 2 * cw, cw, cd), frame)
            for sgn in (-1, 1):
                g.box((sgn * (w / 2 + fw / 2 + cw / 2), sill + h / 2, cd / 2), (cw, h + 2 * fw, cd), frame)
            if kind != "window":
                pass
            g.box((0, sill + h + fw + cw + 0.0, 0.05), (w + 2 * fw + 2 * cw + 0.06, 0.035, 0.1), frame)  # drip cap
        if kind in ("door", "glassdoor"):
            g.box((w / 2 - 0.12, sill + 1.0, 0.09), (0.14, 0.03, 0.04), "chrome")
            if o.get("lamp", True):
                lx = w / 2 + fw + cw + 0.28
                g.box((lx, sill + 2.2, 0.06), (0.1, 0.18, 0.12), "paint_black")
                g.box((lx, sill + 2.1, 0.16), (0.16, 0.26, 0.16), "paint_black", mats={"-x": "light_lens", "+x": "light_lens", "+z": "light_lens"})
    if o.get("shutters"):
        sw = w / 2
        for sgn in (-1, 1):
            g.box((sgn * (w / 2 + sw / 2 + fw), sill + h / 2, 0.03), (sw, h, 0.04), "shutter_black")
    g.pop()


def veranda(g, s):
    """Glazed restaurant veranda: floor deck, glass walls with black mullions, flat roof with a deep
    overhang, and outside V struts. Local rectangle x0..x1 along x, y0 (at the house wall) .. y1."""
    x0, x1, y0, y1 = s["x0"], s["x1"], s["y0"], s["y1"]
    fl = s.get("floor", 0.9)
    hgt = s.get("height", 3.2)
    ovh = s.get("overhang", 1.2)
    sgn = 1 if y1 > y0 else -1
    frame = s.get("frame", "black_steel")
    # deck (brick) with foundation
    ya, yb = min(y0, y1 + sgn * s.get("deck", 2.5)), max(y0, y1 + sgn * s.get("deck", 2.5))
    g.box(((x0 + x1) / 2, (ya + yb) / 2, (fl - 1.5) / 2), (x1 - x0 + 0.2, yb - ya, fl + 1.5), s.get("deckSide", "granite_plinth"), mats={"top": s.get("deckMat", "brick_paving")})
    # glass walls (front and the two ends)
    gy = y1
    g.poly([(x1, gy, fl), (x0, gy, fl), (x0, gy, fl + hgt), (x1, gy, fl + hgt)][:: 1 if sgn > 0 else -1], "glass")
    for xe, d in ((x0, -1), (x1, 1)):
        q = [(xe, y0, fl), (xe, gy, fl), (xe, gy, fl + hgt), (xe, y0, fl + hgt)]
        if (d > 0) != (sgn > 0):
            q = list(reversed(q))
        g.poly(q, "glass")
    # mullions and transom
    step = s.get("mullion", 1.25)
    n = max(1, int(round((x1 - x0) / step)))
    for i in range(n + 1):
        x = x0 + (x1 - x0) * i / n
        g.box((x, gy, fl + hgt / 2), (0.08, 0.12, hgt), frame)
    for yy in (y0 + (gy - y0) * 0.5,):
        for xe in (x0, x1):
            g.box((xe, yy, fl + hgt / 2), (0.12, 0.08, hgt), frame)
    g.box(((x0 + x1) / 2, gy, fl + s.get("transom", 0.55)), (x1 - x0, 0.1, 0.07), frame)
    g.box(((x0 + x1) / 2, gy, fl + 0.05), (x1 - x0, 0.14, 0.1), frame)
    # a white decorative band inside the glass (seen in photos: frosted strip ~1.1 m up)
    if s.get("band"):
        g.poly([(x1, gy - sgn * 0.05, fl + 1.0), (x0, gy - sgn * 0.05, fl + 1.0), (x0, gy - sgn * 0.05, fl + 1.12), (x1, gy - sgn * 0.05, fl + 1.12)][:: 1 if sgn > 0 else -1], "white_trim")
    # roof: flat slab, slight fall outwards
    rt = fl + hgt
    ro = y1 + sgn * ovh
    g.box(((x0 + x1) / 2, (y0 + ro) / 2, rt + 0.15), (x1 - x0 + 2 * s.get("endOverhang", 0.4), abs(ro - y0), 0.3), frame, mats={"top": s.get("roofMat", "roof_metal_black")})
    # V struts outside the glass, every other mullion
    for i in range(0, n + 1, s.get("strutEvery", 2)):
        x = x0 + (x1 - x0) * i / n
        foot = (x, y1 + sgn * 0.25, fl)
        g.beam(foot, (x - 0.6, ro - sgn * 0.2, rt), 0.1, 0.1, frame)
        g.beam(foot, (x + 0.6, ro - sgn * 0.2, rt), 0.1, 0.1, frame)


def steps(g, s):
    """Flight of wide steps: along x from x0..x1, starting at y (top step edge) going outwards dir."""
    x0, x1 = s["x0"], s["x1"]
    y, d = s["y"], s.get("dir", 1)
    n, rise, run = s.get("count", 4), s.get("rise", 0.18), s.get("run", 0.4)
    top = s.get("top", n * rise)
    for i in range(n):
        z1 = top - i * rise
        ya, yb = y + d * i * run, y + d * (i + 1) * run
        g.box(((x0 + x1) / 2, (ya + yb) / 2, (z1 - 1.0) / 2), (x1 - x0, abs(yb - ya), z1 + 1.0), s.get("side", "concrete"), mats={"top": s.get("mat", "brick_paving")})


def railing(g, pts, h=1.0, mat="black_steel", post=1.5):
    for a, b in zip(pts[:-1], pts[1:]):
        g.beam((a[0], a[1], a[2] + h), (b[0], b[1], b[2] + h), 0.05, 0.05, mat)
        g.beam((a[0], a[1], a[2] + h * 0.5), (b[0], b[1], b[2] + h * 0.5), 0.03, 0.03, mat)
        L = math.dist(a[:2], b[:2])
        n = max(1, int(L / post))
        for i in range(n + 1):
            t = i / n
            p = [a[k] + (b[k] - a[k]) * t for k in range(3)]
            g.box((p[0], p[1], p[2] + h / 2), (0.05, 0.05, h), mat)


# ---------------------------------------------------------------------------------------------
# Structures and props
# ---------------------------------------------------------------------------------------------


def shelter(g, s):
    """Open post-and-beam shelter (carport, range bays): mono roof, posts on the open side, optional
    back wall (+y side by default), end walls and bay dividers."""
    L, W = s["length"], s["width"]
    low, high = s.get("low", 2.4), s.get("high", 2.8)
    high_side = s.get("highSide", "-y")  # the open front usually carries the high edge
    sgn = 1 if high_side == "+y" else -1
    z = lambda y: low + (y * sgn + W / 2) / W * (high - low)
    ovh, thick = s.get("overhang", 0.4), s.get("thick", 0.2)
    post = s.get("postMat", "white_trim")
    ps = s.get("postSize", 0.14)
    front = -W / 2 * -sgn * -1 if False else (W / 2 if sgn > 0 else -W / 2)  # open side = high side
    back = -front
    nb = max(1, int(round(L / s.get("bay", 3.0))))
    for i in range(nb + 1):
        x = -L / 2 + L * i / nb
        g.box((x, front, z(front) / 2), (ps, ps, z(front)), post)
        if not s.get("backWall", True):
            g.box((x, back, z(back) / 2), (ps, ps, z(back)), post)
    # beams under the roof
    g.box((0, front, z(front) - 0.12), (L + 0.1, 0.12, 0.24), post)
    wall = s.get("wall", "falu_red_vertical")
    if s.get("backWall", True):
        g.poly([(-L / 2, back, 0), (L / 2, back, 0), (L / 2, back, z(back)), (-L / 2, back, z(back))][:: 1 if back < 0 else -1], wall)
        g.poly([(L / 2, back - 0.1 * (1 if back < 0 else -1), 0), (-L / 2, back - 0.1 * (1 if back < 0 else -1), 0),
                (-L / 2, back - 0.1 * (1 if back < 0 else -1), z(back)), (L / 2, back - 0.1 * (1 if back < 0 else -1), z(back))][:: 1 if back < 0 else -1], s.get("innerWall", wall))
    if s.get("endWalls", False):
        for xe, d in ((-L / 2, -1), (L / 2, 1)):
            q = [(xe, -W / 2, 0), (xe, W / 2, 0), (xe, W / 2, z(W / 2)), (xe, -W / 2, z(-W / 2))]
            g.poly(q if d > 0 else list(reversed(q)), wall)
            g.poly(list(reversed(q)) if d > 0 else q, s.get("innerWall", wall))
    for i in range(1, nb) if s.get("dividers") else []:
        x = -L / 2 + L * i / nb
        g.box((x, 0, 1.0), (0.05, W * 0.8, 2.0), s.get("dividerMat", "net"))
    ya, yb = (-W / 2, W / 2)
    ylow, yhigh = (ya, yb) if sgn > 0 else (yb, ya)
    _roof_slab(g, -L / 2 - ovh, L / 2 + ovh, ylow, z(ylow), yhigh, z(yhigh), ovh, thick, s.get("roofMat", "roof_metal_grey"), s.get("under", "white_trim"), s.get("edge", "white_trim"), ext_high=ovh)
    if s.get("floorMat"):
        g.poly([(-L / 2, -W / 2, 0.03), (L / 2, -W / 2, 0.03), (L / 2, W / 2, 0.03), (-L / 2, W / 2, 0.03)], s["floorMat"])


def gazebo(g, s):
    """Octagonal gazebo: red boarded lower panels in white frames, white posts, pyramid roof, cupola."""
    R = s.get("radius", 1.9)
    h = s.get("height", 2.3)
    n = 8
    pts = [(R * math.cos(2 * math.pi * (i + 0.5) / n), R * math.sin(2 * math.pi * (i + 0.5) / n)) for i in range(n)]
    g.extrude(pts, -0.5, 0.15, "wood_grey")
    open_side = s.get("open", 0)
    for i in range(n):
        a, b = pts[i], pts[(i + 1) % n]
        g.box((a[0], a[1], (h + 0.15) / 2), (0.12, 0.12, h - 0.15), "white_trim")
        if i == open_side:
            continue
        g.poly([(a[0], a[1], 0.15), (b[0], b[1], 0.15), (b[0], b[1], 0.95), (a[0], a[1], 0.95)], "gazebo_red_panel", uv=("fit", 1, 1))
        g.poly([(b[0], b[1], 0.15), (a[0], a[1], 0.15), (a[0], a[1], 0.95), (b[0], b[1], 0.95)], "gazebo_red_panel", uv=("fit", 1, 1))
        g.beam((a[0], a[1], 1.0), (b[0], b[1], 1.0), 0.12, 0.08, "white_trim")
        g.beam((a[0], a[1], 0.2), (b[0], b[1], 0.2), 0.08, 0.06, "white_trim")
        # decorative brackets under the eave
        g.beam((a[0] * 0.8 + b[0] * 0.2, a[1] * 0.8 + b[1] * 0.2, h - 0.35), (a[0], a[1], h - 0.05), 0.05, 0.05, "white_trim")
        g.beam((b[0] * 0.8 + a[0] * 0.2, b[1] * 0.8 + a[1] * 0.2, h - 0.35), (b[0], b[1], h - 0.05), 0.05, 0.05, "white_trim")
    for i in range(n):
        a, b = pts[i], pts[(i + 1) % n]
        g.beam((a[0], a[1], h), (b[0], b[1], h), 0.14, 0.18, "white_trim")
    # roof
    Ro = R + s.get("overhang", 0.35)
    peak = h + s.get("roofRise", 1.2)
    rp = [(Ro * math.cos(2 * math.pi * (i + 0.5) / n), Ro * math.sin(2 * math.pi * (i + 0.5) / n)) for i in range(n)]
    top_r = 0.35
    tp = [(top_r * math.cos(2 * math.pi * (i + 0.5) / n), top_r * math.sin(2 * math.pi * (i + 0.5) / n)) for i in range(n)]
    ze = h - 0.1
    zt = ze + (peak - ze) * (Ro - top_r) / Ro
    for i in range(n):
        j = (i + 1) % n
        g.poly([(rp[i][0], rp[i][1], ze), (rp[j][0], rp[j][1], ze), (tp[j][0], tp[j][1], zt), (tp[i][0], tp[i][1], zt)], s.get("roofMat", "roof_shingle_dark"))
        g.poly([(rp[j][0], rp[j][1], ze - 0.05), (rp[i][0], rp[i][1], ze - 0.05), (0, 0, peak - 0.3)], "white_trim")
        g.poly([(rp[i][0], rp[i][1], ze - 0.12), (rp[j][0], rp[j][1], ze - 0.12), (rp[j][0], rp[j][1], ze), (rp[i][0], rp[i][1], ze)], "white_trim")
    # small cupola
    g.extrude(tp, zt, zt + 0.3, "white_trim", top=s.get("roofMat", "roof_shingle_dark"))
    g.cylinder((0, 0, zt + 0.3), 0.45, 0.25, s.get("roofMat", "roof_shingle_dark"), seg=8, r_top=0.02)


def flagpole(g, s):
    h = s.get("height", 8.0)
    g.cylinder((0, 0, -0.5), 0.055, h + 0.5, "paint_white", seg=10, r_top=0.035)
    g.sphere((0, 0, h + 0.06), 0.07, "paint_white", seg=8, rings=4)
    style = s.get("style", "hanging")
    fw, fh = s.get("flagW", 1.2), s.get("flagH", 3.0)
    colors = s.get("colors", ["flag_white"])
    if style == "hanging":
        # vertical banner hanging from a short crossbar
        g.box((fw / 2, 0, h - 0.15), (fw + 0.1, 0.04, 0.04), "paint_white")
        top, bot = h - 0.2, h - 0.2 - fh
    else:
        top, bot = h - 0.1, h - 0.1 - fh
    wave = s.get("wave", 0.12)
    nseg = 6
    band = s.get("bands", "v")
    for k in range(nseg):
        xa, xb = fw * k / nseg, fw * (k + 1) / nseg
        ya, yb = wave * math.sin(k / nseg * math.pi * 1.5), wave * math.sin((k + 1) / nseg * math.pi * 1.5)
        if band == "cross":  # Nordic cross flag: build it as 3x3 panels of colour
            cols = [0, 0.3125, 0.4375, 1.0]
            rows = [bot, bot + (top - bot) * 0.4, bot + (top - bot) * 0.6, top]
            for ri in range(3):
                mat = colors[1] if (ri == 1 or (0.3125 <= (xa + xb) / 2 / fw <= 0.4375)) else colors[0]
                q = [(xa, ya, rows[ri]), (xb, yb, rows[ri]), (xb, yb, rows[ri + 1]), (xa, ya, rows[ri + 1])]
                g.poly(q, mat)
                g.poly(list(reversed(q)), mat)
            continue
        nb = len(colors)
        for bi in range(nb):
            z0 = top - (top - bot) * (bi + 1) / nb
            z1 = top - (top - bot) * bi / nb
            q = [(xa, ya, z0), (xb, yb, z0), (xb, yb, z1), (xa, ya, z1)]
            g.poly(q, colors[bi])
            g.poly(list(reversed(q)), colors[bi])


def bench(g, s):
    L = s.get("length", 1.8)
    mat = s.get("mat", "wood_bench")
    leg = s.get("legMat", "black_steel")
    if s.get("style") == "stone":
        for x in (-L / 2 + 0.25, L / 2 - 0.25):
            g.box((x, 0, 0.22), (0.3, 0.42, 0.44), "concrete")
        for i in range(4):
            g.box((0, -0.15 + i * 0.1, 0.47), (L, 0.085, 0.05), mat)
        return
    for x in (-L / 2 + 0.2, L / 2 - 0.2):
        g.box((x, 0, 0.22), (0.05, 0.45, 0.44), leg)
        g.beam((x, 0.18, 0.44), (x, 0.28, 0.85), 0.05, 0.05, leg)
    for i in range(3):
        g.box((0, -0.15 + i * 0.12, 0.46), (L, 0.1, 0.04), mat)
    if s.get("back", True):
        for i in range(2):
            g.beam((-L / 2, 0.22 + i * 0.03, 0.6 + i * 0.16), (L / 2, 0.22 + i * 0.03, 0.6 + i * 0.16), 0.03, 0.1, mat)


def picnic_table(g, s):
    L = s.get("length", 1.8)
    mat = s.get("mat", "wood_bench")
    frame = s.get("frame", "black_steel")
    for i in range(5):
        g.box((0, -0.36 + i * 0.18, 0.74), (L, 0.16, 0.04), mat)
    for sy in (-0.7, 0.7):
        g.box((0, sy, 0.45), (L, 0.28, 0.04), mat)
    for x in (-L / 2 + 0.25, L / 2 - 0.25):
        g.beam((x, -0.75, 0.0), (x, 0.3, 0.72), 0.05, 0.05, frame)
        g.beam((x, 0.75, 0.0), (x, -0.3, 0.72), 0.05, 0.05, frame)
        g.box((x, 0, 0.42), (0.05, 1.6, 0.04), frame)


def bollard_light(g, s):
    h = s.get("height", 0.9)
    g.cylinder((0, 0, -0.2), 0.1, h + 0.2, "paint_black", seg=10)
    g.cylinder((0, 0, h - 0.25), 0.095, 0.15, "light_lens", seg=10, cap=False)
    g.cylinder((0, 0, h), 0.11, 0.05, "paint_black", seg=10, r_top=0.05)
    g.cylinder((0, 0, -0.1), 0.18, 0.12, "concrete", seg=10)


def signpost(g, s):
    h = s.get("height", 2.6)
    g.cylinder((0, 0, -0.4), 0.05, h + 0.4, "paint_black", seg=8)
    g.sphere((0, 0, h + 0.03), 0.06, "paint_black", seg=8, rings=4)
    for i, arm in enumerate(s.get("arms", [{"dir": 0}, {"dir": 180}, {"dir": 90}])):
        z = h - 0.25 - i * 0.28
        a = math.radians(arm.get("dir", 0))
        g.push(Matrix.Translation((0, 0, z)) @ Matrix.Rotation(a, 4, "Z"))
        g.box((0.42, 0, 0), (0.75, 0.03, 0.2), "sign_black")
        g.poly([(0.8, -0.016, -0.1), (0.95, -0.016, 0.0), (0.8, -0.016, 0.1)], "sign_black")
        g.poly([(0.8, 0.016, 0.1), (0.95, 0.016, 0.0), (0.8, 0.016, -0.1)], "sign_black")
        g.box((0.42, 0, 0), (0.6, 0.035, 0.03), "paint_white")
        g.pop()


def hole_sign(g, s):
    """Tee-box hole sign: black post with a curved arm and hanging board, sponsor plates below."""
    h = s.get("height", 2.4)
    g.cylinder((0, 0, -0.5), 0.05, h + 0.5, "paint_black", seg=8)
    g.sphere((0, 0, h + 0.05), 0.07, "paint_black", seg=8, rings=4)
    g.beam((0, 0, h - 0.1), (0.8, 0, h - 0.1), 0.04, 0.04, "paint_black")
    g.beam((0.05, 0, h - 0.45), (0.5, 0, h - 0.12), 0.03, 0.03, "paint_black")
    g.box((0.45, 0, h - 0.62), (0.62, 0.03, 0.9), "sign_black", mats={"-y": "sign_green", "+y": "sign_green"})
    g.box((0.45, 0, h - 1.22), (0.58, 0.03, 0.22), "sign_blue")
    g.box((0.45, 0, h - 1.5), (0.58, 0.03, 0.26), "sign_black")


def tee_sign(g, s):
    """Hole sign by the tee (Vreta's, hole 10 photo): black post with a finial, an arm along +x with a curved
    brace, and a board hung under the arm in the x-z plane. `outline` = the board's shape in metres (x from its
    left edge, z up from its bottom edge, counter-clockwise); `face` = the material printed on both sides,
    mapped once over the board (UV 0..1 across width x height, read the right way round from either side)."""
    W, H = s["width"], s["height"]
    arm, hp = s.get("arm", 2.0), s.get("post", 2.5)
    reach, x0, t = s.get("reach", 0.74), s.get("boardX", 0.10), s.get("thick", 0.025)
    ink = s.get("mat", "paint_black")
    g.cylinder((0, 0, -0.5), 0.045, hp + 0.5, ink, seg=10)
    g.cylinder((0, 0, hp - 0.16), 0.058, 0.06, ink, seg=10)
    g.cylinder((0, 0, hp), 0.05, 0.035, ink, seg=10, r_top=0.075)
    g.sphere((0, 0, hp + 0.07), 0.06, ink, seg=10, rings=5)
    g.beam((0, 0, arm), (reach, 0, arm), 0.035, 0.04, ink)
    # brace: leaves the post ~0.3 m above the arm and sweeps down onto its tip
    pts = []
    for i in range(9):
        u = i / 8
        pts.append((0.03 + u * (reach - 0.05), 0, arm + 0.02 + 0.28 * (1 - u) ** 2))
    for a, b in zip(pts, pts[1:]):
        g.beam(a, b, 0.02, 0.02, ink)
    # board, hung from two rods near its shoulders
    z0 = arm - 0.075 - H
    top = lambda x: max(z for (px, z) in s["outline"] if abs(px - x) < W / 20 + 1e-6)
    for hx in (0.09 * W, 0.91 * W):
        g.beam((x0 + hx, 0, arm), (x0 + hx, 0, z0 + top(hx) - 0.01), 0.012, 0.012, ink)
    ol = [(x0 + x, z0 + z) for x, z in s["outline"]]
    c = (x0 + W / 2, z0 + 0.45 * H)
    uv = lambda p, back: ((1 - (p[0] - x0) / W) if back else (p[0] - x0) / W, (p[1] - z0) / H)
    for a, b in zip(ol, ol[1:] + ol[:1]):
        fa = [(a[0], -t / 2, a[1]), (b[0], -t / 2, b[1])]
        ba = [(a[0], t / 2, a[1]), (b[0], t / 2, b[1])]
        g.poly([(c[0], -t / 2, c[1]), fa[0], fa[1]], s["face"], uv=("uv", [uv(c, False), uv(a, False), uv(b, False)]))
        g.poly([(c[0], t / 2, c[1]), ba[1], ba[0]], s["face"], uv=("uv", [uv(c, True), uv(b, True), uv(a, True)]))
        g.poly([fa[0], ba[0], ba[1], fa[1]], ink)


def plank_sign(g, s):
    """Tee sign on a square wooden post (Omberg's, hole 14 photo): a lacquered plank of width x height in the
    x-z plane, screwed to the post's front (-y) with its bottom `bottom` m above the ground; the post stands
    `stub` m proud of the plank. `face` = the material printed on the front, mapped once over it (UV 0..1);
    `back` = the plank's back, also mapped once; `mat` = the post and the plank's edges."""
    W, H, t = s["width"], s["height"], s.get("thick", 0.035)
    z0, ps, stub = s.get("bottom", 0.55), s.get("post", 0.09), s.get("stub", 0.04)
    wood = s.get("mat", "wood_post")
    top = z0 + H + stub
    g.box((0, 0, (top - 0.5) / 2), (ps, ps, top + 0.5), wood)
    g.box((0, 0, top + 0.004), (ps - 0.01, ps - 0.01, 0.008), wood)  # eased top
    y = -ps / 2 - t / 2
    g.box((0, y, z0 + H / 2), (W, t, H), wood, skip=("-y", "+y"))
    x0, x1, yf, yb = -W / 2, W / 2, y - t / 2, y + t / 2
    g.poly([(x0, yf, z0), (x1, yf, z0), (x1, yf, z0 + H), (x0, yf, z0 + H)], s["face"], uv=("uv", [(0, 0), (1, 0), (1, 1), (0, 1)]))
    g.poly([(x1, yb, z0), (x0, yb, z0), (x0, yb, z0 + H), (x1, yb, z0 + H)], s.get("back", wood), uv=("uv", [(0, 0), (1, 0), (1, 1), (0, 1)]))


def bin_(g, s):
    g.box((0, 0, 0.5), (0.6, 0.55, 1.0), s.get("mat", "wood_grey"))
    g.box((0, 0, 1.03), (0.66, 0.6, 0.06), "paint_green")


def hedge(g, s):
    """Clipped hedge along a polyline (pts in local metres), width w, height h, slightly rounded top."""
    pts = s["pts"]
    w, h = s.get("width", 0.9), s.get("height", 1.4)
    mat = s.get("mat", "hedge")
    for a, b in zip(pts[:-1], pts[1:]):
        d = Vector((b[0] - a[0], b[1] - a[1], 0))
        L = d.length
        ang = math.degrees(math.atan2(d.y, d.x))
        c = ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)
        g.push(Matrix.Translation((c[0], c[1], 0)) @ Matrix.Rotation(math.radians(ang), 4, "Z"))
        hw = w / 2
        prof = [(-hw, -0.3), (hw, -0.3), (hw, h * 0.85), (hw * 0.7, h), (-hw * 0.7, h), (-hw, h * 0.85)]
        for i in range(len(prof)):
            p, q = prof[i], prof[(i + 1) % len(prof)]
            if i == 0:
                continue
            g.poly([(-L / 2 - hw * 0.3, p[0], p[1]), (-L / 2 - hw * 0.3, q[0], q[1]), (L / 2 + hw * 0.3, q[0], q[1]), (L / 2 + hw * 0.3, p[0], p[1])][::-1], mat)
        g.poly([(-L / 2 - hw * 0.3, p[0], p[1]) for p in reversed(prof)], mat)
        g.poly([(L / 2 + hw * 0.3, p[0], p[1]) for p in prof], mat)
        g.pop()


def rock_pile(g, s):
    """Low embankment of white stones: a long mound with lumpy profile. Along x, length L."""
    L, W, h = s["length"], s.get("width", 2.0), s.get("height", 0.8)
    rnd = random.Random(s.get("seed", 1))
    nx, ny = max(2, int(L / 0.5)), 6
    grid = []
    for i in range(nx + 1):
        row = []
        for j in range(ny + 1):
            x = -L / 2 + L * i / nx
            y = -W / 2 + W * j / ny
            t = abs(y) / (W / 2)
            ends = min(1.0, (L / 2 - abs(x)) / 0.8)
            z = h * max(0.0, 1 - t ** 1.6) * max(0.0, ends) + (rnd.random() - 0.5) * 0.12 * (1 - t)
            if j in (0, ny) or i in (0, nx):
                z = -0.2
            row.append((x, y, z))
        grid.append(row)
    for i in range(nx):
        for j in range(ny):
            g.poly([grid[i][j], grid[i + 1][j], grid[i + 1][j + 1], grid[i][j + 1]], s.get("mat", "white_stones"))


def rock(g, s):
    """Granite outcrop: a glacier-polished whaleback - smooth dome with low-frequency lumps, a
    sheared flank and fine roughness (sum of sines, seeded)."""
    rnd = random.Random(s.get("seed", 3))
    sx, sy, sz = s.get("sx", 6.0), s.get("sy", 4.0), s.get("sz", 1.8)
    seg, rings = 40, 14
    waves = [(rnd.uniform(1, 5), rnd.uniform(0, 6.3), rnd.uniform(1, 4), rnd.uniform(0, 6.3), rnd.uniform(0.02, 0.07)) for _ in range(9)]

    def bump(a, t):
        return sum(amp * math.sin(fa * a + pa) * math.cos(ft * t + pt) for fa, pa, ft, pt, amp in waves)

    pts = []
    for j in range(rings + 1):
        t = (math.pi / 2) * j / rings
        row = []
        for i in range(seg):
            a = 2 * math.pi * i / seg
            n = 1 + bump(a, t) + (rnd.random() - 0.5) * 0.02
            shear = 1.0 - 0.25 * max(0.0, math.cos(a - 0.6)) * math.sin(t)  # one steeper side
            z = sz * (math.sin(t) ** 0.8) * (0.92 + 0.16 * bump(a * 1.3, t * 2)) * shear if j else -0.6
            row.append((sx / 2 * math.cos(t) * math.cos(a) * n, sy / 2 * math.cos(t) * math.sin(a) * n, z))
        pts.append(row)
    # UVs: distance over the surface from the crest, out along each meridian. Continuous across faces
    # (per-face projection breaks the texture at every quad and reads as cobbles) and unstretched on the
    # steep flanks, where a top-down projection would smear.
    dist = [[0.0] * seg for _ in range(rings + 1)]
    for j in range(rings - 1, -1, -1):
        for i in range(seg):
            dist[j][i] = dist[j + 1][i] + math.dist(pts[j][i], pts[j + 1][i])
    dirs = []
    for i in range(seg):
        a = 2 * math.pi * i / seg
        dx, dy = sx * math.cos(a), sy * math.sin(a)
        L = math.hypot(dx, dy)
        dirs.append((dx / L, dy / L))
    uvs = [[(dirs[i][0] * dist[j][i], dirs[i][1] * dist[j][i]) for i in range(seg)] for j in range(rings + 1)]
    mat = s.get("mat", "granite_dark")
    for j in range(rings):
        for i in range(seg):
            k = (i + 1) % seg
            g.poly([pts[j][i], pts[j][k], pts[j + 1][k], pts[j + 1][i]], mat, uv=("uv", [uvs[j][i], uvs[j][k], uvs[j + 1][k], uvs[j + 1][i]]))
    g.poly([pts[rings][i] for i in range(seg)], mat, uv=("uv", [uvs[rings][i] for i in range(seg)]))


def boulder(g, s):
    """Rounded field stone (a glacial boulder, as laid in dry-stone walls and tee banks): an ellipsoid
    sx x sy x sz centred on the origin with low-frequency lumps, three to five softly flattened faces and fine
    roughness, seeded. UVs run over the surface from the top pole down each meridian, as on `rock` (continuous,
    unstretched on the sides; the pinch at the bottom pole ends up buried). Faces pointing up more than `moss`
    (normal z, give or take a patchy noise; default: none) wear `mossMat`.
    A wall stone (a block fitted into a dry-stone wall face) is the same with `exponent` > 2 (a superellipsoid:
    3 is a block with rounded edges), smaller `lumps` (scales the lumps) and `flats`: [{dir, at, keep}] faces
    cut flat where the unit shape reaches past `at` along `dir`, keeping `keep` of what lies beyond (0 = sawn):
    its face (+y) and its beds (+-z)."""
    rnd = random.Random(s.get("seed", 1))
    sx, sy, sz = s.get("sx", 1.0), s.get("sy", 0.8), s.get("sz", 0.7)
    seg, rings = s.get("seg", 20), s.get("rings", 12)
    exponent, lumps = s.get("exponent", 2.0), s.get("lumps", 1.0)
    flats = []
    for fl in s.get("flats", []):
        d = fl["dir"]
        L = math.sqrt(sum(c * c for c in d))
        flats.append((tuple(c / L for c in d), fl.get("at", 0.85), fl.get("keep", 0.25)))

    def unit():
        z = rnd.uniform(-1, 1)
        a = rnd.uniform(0, 2 * math.pi)
        r = math.sqrt(1 - z * z)
        return (r * math.cos(a), r * math.sin(a), z)

    # lumps: plane waves over the unit sphere (smooth at the poles, unlike waves in latitude/longitude)
    waves = [(unit(), rnd.uniform(1.5, 4.5), rnd.uniform(0, 2 * math.pi), rnd.uniform(0.025, 0.08)) for _ in range(9)]
    # facets: mostly on the sides, cut 12-30 % in, the part beyond kept at a quarter (a worn edge, not a saw cut)
    facets = []
    for _ in range(rnd.randint(3, 5)):
        n = unit()
        n = (n[0], n[1], n[2] * 0.6)
        L = math.sqrt(sum(c * c for c in n))
        facets.append((tuple(c / L for c in n), rnd.uniform(0.7, 0.88)))

    def radius(u):
        box = 1.0 if exponent == 2.0 else (abs(u[0]) ** exponent + abs(u[1]) ** exponent + abs(u[2]) ** exponent) ** (-1.0 / exponent)
        r = box * (1 + lumps * sum(amp * math.sin(f * (k[0] * u[0] + k[1] * u[1] + k[2] * u[2]) + ph) for k, f, ph, amp in waves))
        r += (rnd.random() - 0.5) * 0.02 * lumps
        for n, d in facets:
            c = u[0] * n[0] + u[1] * n[1] + u[2] * n[2]
            if c > 1e-3 and c * r > d:
                r = (d + (c * r - d) * 0.25) / c
        for n, d, keep in flats:
            c = u[0] * n[0] + u[1] * n[1] + u[2] * n[2]
            if c > 1e-3 and c * r > d:
                r = (d + (c * r - d) * keep) / c
        return r

    patches = [(unit(), rnd.uniform(3.0, 7.0), rnd.uniform(0, 2 * math.pi)) for _ in range(4)]

    def patchy(c):  # -1..1 over the stone, blotches a third of it across
        L = math.sqrt(sum(v * v for v in c)) or 1.0
        return sum(math.sin(f * (k[0] * c[0] + k[1] * c[1] + k[2] * c[2]) / L + ph) for k, f, ph in patches) / len(patches)

    top = radius((0.0, 0.0, 1.0))
    bottom = radius((0.0, 0.0, -1.0))
    pts = []
    for j in range(rings + 1):
        t = math.pi * j / rings  # 0 = top pole
        row = []
        for i in range(seg):
            a = 2 * math.pi * i / seg
            u = (math.sin(t) * math.cos(a), math.sin(t) * math.sin(a), math.cos(t))
            r = top if j == 0 else bottom if j == rings else radius(u)
            row.append((sx / 2 * u[0] * r, sy / 2 * u[1] * r, sz / 2 * u[2] * r))
        pts.append(row)
    dist = [[0.0] * seg for _ in range(rings + 1)]
    for j in range(1, rings + 1):
        for i in range(seg):
            dist[j][i] = dist[j - 1][i] + math.dist(pts[j - 1][i], pts[j][i])
    dirs = []
    for i in range(seg):
        a = 2 * math.pi * i / seg
        dx, dy = sx * math.cos(a), sy * math.sin(a)
        L = math.hypot(dx, dy)
        dirs.append((dx / L, dy / L))
    ou, ov = rnd.uniform(0, 4), rnd.uniform(0, 4)  # each stone a different patch of the texture
    uvs = [[(ou + dirs[i][0] * dist[j][i], ov + dirs[i][1] * dist[j][i]) for i in range(seg)] for j in range(rings + 1)]
    mat, moss_mat, moss = s.get("mat", "granite_boulder"), s.get("mossMat", "granite_moss"), s.get("moss")
    for j in range(rings):
        for i in range(seg):
            k = (i + 1) % seg
            q = [(j, i), (j + 1, i), (j + 1, k), (j, k)]
            if j == 0:
                q = q[:3]
            elif j == rings - 1:
                q = [q[0], q[1], q[3]]
            p = [pts[a][b] for a, b in q]
            m = mat
            if moss is not None:
                e1 = [p[1][c] - p[0][c] for c in range(3)]
                e2 = [p[2][c] - p[0][c] for c in range(3)]
                nz = e1[0] * e2[1] - e1[1] * e2[0]
                nl = math.sqrt((e1[1] * e2[2] - e1[2] * e2[1]) ** 2 + (e1[2] * e2[0] - e1[0] * e2[2]) ** 2 + nz ** 2)
                centre = [sum(v[c] for v in p) / len(p) for c in range(3)]
                if nl > 1e-9 and nz / nl + 0.3 * patchy(centre) > moss:
                    m = moss_mat
            g.poly(p, m, uv=("uv", [uvs[a][b] for a, b in q]))


def _parapet(g, rnd, mats, L, yp, t, zd, sc=1.0):
    """A stone parapet ("reling") along y = yp: a course and a rounded coping of field stones following the deck line
    zd(x), thickness t, from the deck up ~0.5 m. sc scales the stones."""
    for lift, hh, ex in ((0.13 * sc, 0.27 * sc, 2.8), (0.38 * sc, 0.28 * sc, 2.2)):
        x = -L / 2 + 0.1
        while x < L / 2 - 0.1:
            cw = rnd.uniform(0.5, 0.85) * sc
            xc = min(x + cw / 2, L / 2 - 0.1)
            slope = (zd(xc + 0.2) - zd(xc - 0.2)) / 0.4
            spec = {"sx": cw * 1.1, "sy": t * (1.15 if lift > 0.3 * sc else 1.0), "sz": hh * 1.15, "exponent": ex, "lumps": 0.6,
                    "seed": rnd.randint(1, 10 ** 6), "seg": 10, "rings": 6, "mat": mats[0] if rnd.random() < 0.5 else rnd.choice(mats)}
            g.push(Matrix.Translation((xc, yp + rnd.uniform(-0.02, 0.02), zd(xc) + lift)) @ Matrix.Rotation(-math.atan(slope), 4, "Y")
                   @ Matrix.Rotation(rnd.uniform(-0.04, 0.04), 4, "Z"))
            boulder(g, spec)
            g.pop()
            x += cw * rnd.uniform(0.92, 1.0)


def _arch_masonry(g, rnd, mats, L, W, ow, oh, depth, zd, roof):
    """The old arch bridge's stonework (Omberg holes 7 and 9): both faces laid as rough strips of field stone stacked
    down from the deck line (so the courses follow the hump and the joints stagger), a ring of larger stones round the
    arch, and a parapet of two rows - a course and a rounded coping - along both edges."""
    def pick():
        return mats[0] if rnd.random() < 0.5 else rnd.choice(mats)

    def stone(c, size, rotz=0.0, roty=0.0, **kw):
        spec = {"sx": size[0], "sy": size[1], "sz": size[2], "exponent": kw.get("exponent", rnd.uniform(2.3, 3.0)), "lumps": kw.get("lumps", 0.7),
                "seed": rnd.randint(1, 10 ** 6), "seg": 10, "rings": 6, "mat": pick()}
        if "face" in kw:
            spec["flats"] = [{"dir": (0, kw["face"], 0), "at": 0.78, "keep": 0.2}]
        g.push(Matrix.Translation(c) @ Matrix.Rotation(roty, 4, "Y") @ Matrix.Rotation(rotz, 4, "Z"))
        boulder(g, spec)
        g.pop()

    t = 0.4  # wall thickness
    for sgn in (-1, 1):
        yf = sgn * (W / 2 - 0.13)
        x = -L / 2 + 0.05
        while x < L / 2 - 0.1:
            cw = rnd.uniform(0.42, 0.85)
            xc = min(x + cw / 2, L / 2)
            z = zd(xc) - 0.02
            while z > -depth * 0.6:
                ch = rnd.uniform(0.22, 0.34)
                zc = z - ch / 2
                r0 = roof(xc)
                in_arch = abs(xc) < ow / 2 + cw * 0.5 + 0.1 and zc - ch * 0.5 < r0 + 0.22
                if not in_arch and zc + ch * 0.5 > 0.0 - depth * 0.6:
                    stone((xc, yf, zc), (cw * 1.1, 0.5, ch * 1.2), rnd.uniform(-0.03, 0.03), face=sgn)
                z -= ch * 0.92
            x += cw * rnd.uniform(0.9, 1.0)
        # the arch ring
        nv = max(7, int(math.pi * (ow + oh) / 2 / 0.42))
        for k in range(nv + 1):
            a = math.pi * k / nv
            xa, za = -math.cos(a) * (ow / 2 + 0.2), math.sin(a) * (oh + 0.2)
            stone((xa, yf, za), (0.46, 0.5, 0.38), roty=a - math.pi / 2, face=sgn, exponent=2.8)
        _parapet(g, rnd, mats, L, sgn * (W / 2 - t / 2), t, zd)


def stone_bridge(g, s):
    """Omberg's old stone crossing: a low, gently humped heap of dry-laid field stones over a culvert (Marcus's
    photos, holes 6/7). Long axis x (the way across), the creek runs along y under it. `length`, `width`, `height`
    (crest above the bank), `seed`; `opening` (width of the culvert, 0 = a solid heap), `openingHeight` (its crown
    above the bank), `sideDeg` (slope of the flanks), `stone` (mean stone size, m), `mats` (stone materials, the
    first the commonest), `core` (the dark body the stones sit on - it shows in the gaps), `depth` (how far the
    body reaches below the bank: the creek groove). One closed core + a shell of `boulder` stones in two passes
    (big, then infill) + dressed stones round the culvert mouths. Triangles ~ 50 per stone, a few hundred stones."""
    arch = s.get("style") == "arch"
    L, W, H = s["length"], s.get("width", 2.4 if arch else 2.6), s.get("height", 1.1 if arch else 0.85)
    ow, oh = s.get("opening", 2.4 if arch else 1.5), s.get("openingHeight", 0.95 if arch else 0.4)
    depth, stone, side = s.get("depth", 0.9), s.get("stone", 0.42), math.radians(s.get("sideDeg", 52))
    mats = s.get("mats", ["fieldstone_grey", "fieldstone_dark", "fieldstone_brown"] if arch else ["sandstone_ochre", "sandstone_rust", "sandstone_dark"])
    core = s.get("core", "fieldstone_dark" if arch else "sandstone_core")
    deck = s.get("deck", "turf_mat")
    rnd = random.Random(s.get("seed", 1))
    if ow > 0:
        H = max(H, oh + 0.42)
    run = max(0.2, H / math.tan(side))
    sink = 0.03 if arch else 0.12  # the stones' shell over the core

    def smooth(t):
        t = min(1.0, max(0.0, t))
        return t * t * (3 - 2 * t)

    def surf(x, y):
        u = min(1.0, abs(2 * x / L))
        if arch:  # a hump bridge: the deck line, level across, vertical flanks
            return H * (1 - u ** 2.6)
        hx = smooth((1 - u) / 0.5) ** 0.9 * (1 - 0.28 * u * u)  # gently domed (the Swilcan bridge's hump), the ends feathering out
        cy = (1 - min(1.0, abs(2 * y / W)) ** 5.0) ** 0.5  # flat top, steep shoulders
        z = H * hx * cy
        if ow > 0:  # the headwall over the culvert: a lip that stands to the mouth, then falls steeply
            hw = (oh + 0.42) * (1 - smooth((abs(x) - ow / 2 - 0.15) / 0.55))
            z = max(z, hw * min(1.0, (W / 2 - abs(y)) / 0.22))
        return z

    def grad(x, y):
        e = 0.05
        return math.hypot((surf(x + e, y) - surf(x - e, y)) / (2 * e), (surf(x, y + e) - surf(x, y - e)) / (2 * e))

    def roof(x):
        t = abs(2 * x / ow)
        return oh * math.sqrt(max(0.0, 1 - t * t)) if ow > 0 else -depth

    # --- the core: a closed solid, top = surface - sink, underside -depth (the arch inside the culvert)
    xs = {round(-L / 2 + L * i / max(2, int(L / 0.25)), 4) for i in range(max(2, int(L / 0.25)) + 1)}
    if ow > 0:
        xs |= {round(ow / 2 * math.sin(math.pi * (k / 8 - 0.5)), 4) for k in range(9)}
        xs |= {round(ow / 2 * 1.0, 4), round(-ow / 2, 4)}
    xs = sorted(x for x in xs if abs(x) <= L / 2)
    ny = max(2, int(W / 0.25))
    ys = [-W / 2 + W * j / ny for j in range(ny + 1)]

    def top(x, y):
        return max(surf(x, y) - sink, -0.12)

    def bot(x, y):
        return roof(x) if ow > 0 and abs(x) < ow / 2 - 1e-6 else -depth

    for i in range(len(xs) - 1):
        for j in range(ny):
            x0, x1, y0, y1 = xs[i], xs[i + 1], ys[j], ys[j + 1]
            g.poly([(x0, y0, top(x0, y0)), (x1, y0, top(x1, y0)), (x1, y1, top(x1, y1)), (x0, y1, top(x0, y1))], deck if arch else core)
            xm = (x0 + x1) / 2
            if ow > 0 and abs(xm) < ow / 2:  # inside the culvert: the arch's soffit, seen from below
                g.poly([(x0, y1, roof(x0)), (x1, y1, roof(x1)), (x1, y0, roof(x1)), (x0, y0, roof(x0))], core)
            else:
                g.poly([(x0, y1, -depth), (x1, y1, -depth), (x1, y0, -depth), (x0, y0, -depth)], core)
    for sgn in (-1, 1):  # the two long faces (y = +-W/2) and the culvert walls
        y = sgn * W / 2
        for i in range(len(xs) - 1):
            x0, x1 = xs[i], xs[i + 1]
            lo0, lo1 = (roof(x0), roof(x1)) if ow > 0 and abs((x0 + x1) / 2) < ow / 2 else (-depth, -depth)
            q = [(x0, y, lo0), (x1, y, lo1), (x1, y, top(x1, y)), (x0, y, top(x0, y))]
            g.poly(q if sgn < 0 else q[::-1], core)
    for sgn in (-1, 1):  # the short ends (x = +-L/2)
        x = sgn * L / 2
        for j in range(ny):
            q = [(x, ys[j], -depth), (x, ys[j + 1], -depth), (x, ys[j + 1], top(x, ys[j + 1])), (x, ys[j], top(x, ys[j]))]
            g.poly(q if sgn > 0 else q[::-1], core)
    if ow > 0:  # vertical culvert walls below the arch springing
        for sgn in (-1, 1):
            x = sgn * ow / 2
            q = [(x, -W / 2, -depth), (x, W / 2, -depth), (x, W / 2, 0.0), (x, -W / 2, 0.0)]
            g.poly(q[::-1] if sgn > 0 else q, core)

    # --- the stones
    placed = {}  # cell -> [(x, y, z, r)]

    def free(x, y, z, r, k):
        cx, cy = int(x // 0.5), int(y // 0.5)
        for i in (cx - 1, cx, cx + 1):
            for j in (cy - 1, cy, cy + 1):
                for a, b, c, d in placed.get((i, j), ()):
                    if (x - a) ** 2 + (y - b) ** 2 + (z - c) ** 2 < (k * (r + d)) ** 2:
                        return False
        return True

    def lay(x, y, z, r, nrm, big):
        sx, sy, sz = r * rnd.uniform(1.6, 2.6), r * rnd.uniform(1.3, 2.0), r * rnd.uniform(0.6, 0.95)
        if rnd.random() < 0.85:  # angular, laid flat: a slab with worn edges
            spec = {"exponent": rnd.uniform(2.8, 3.8), "lumps": 0.3, "flats": [{"dir": (0, 0, 1), "at": 0.74, "keep": 0.1}, {"dir": (0, 0, -1), "at": 0.74, "keep": 0.1}]}
        else:
            spec = {"lumps": 0.6}
        spec.update(sx=sx, sy=sy, sz=sz, seed=rnd.randint(1, 10 ** 6), seg=8 if big else 6, rings=5 if big else 4,
                    mat=mats[0] if rnd.random() < 0.55 else rnd.choice(mats))
        # tilt the stone's up towards the surface normal, a little less than fully; spin about it
        nz = Vector(nrm)
        tilt = Vector((0, 0, 1)).rotation_difference(nz) if nz.length > 1e-6 else Matrix.Identity(3).to_quaternion()
        spin = Matrix.Rotation(rnd.uniform(0, 2 * math.pi), 4, "Z")
        m = Matrix.Translation((x, y, z)) @ tilt.to_matrix().to_4x4() @ spin
        g.push(m)
        boulder(g, spec)
        g.pop()

    def normal(x, y):
        e = 0.06
        dzdx = (surf(x + e, y) - surf(x - e, y)) / (2 * e)
        dzdy = (surf(x, y + e) - surf(x, y - e)) / (2 * e)
        n = Vector((-dzdx * 0.7, -dzdy * 0.7, 1.0))
        return n.normalized()

    def in_mouth(x, y, r):  # keep stones out of the culvert (the mouth's own stones go in below)
        return ow > 0 and abs(x) < ow / 2 + r * 0.3 and abs(y) > W / 2 - 0.3 and surf(x, y) < oh + 0.2

    passes = () if arch else ((stone * 1.0, 0.9, 7000, True), (stone * 0.7, 0.85, 6000, False))
    for rad, k, tries, big in passes:
        for _ in range(tries):
            x, y = rnd.uniform(-L / 2, L / 2), rnd.uniform(-W / 2, W / 2)
            z = surf(x, y)
            if z < 0.03 and (abs(x) > L / 2 - 0.2 or abs(y) > W / 2 - 0.15) and rnd.random() < 0.3:
                continue
            gr = grad(x, y)
            if rnd.random() > min(1.0, math.sqrt(1 + gr * gr) / 1.6) * 0.5 + 0.25 and not big:
                pass
            r = rad * rnd.uniform(0.8, 1.2) * (0.6 + 0.4 * min(1.0, (z + 0.1) / 0.25) if z < 0.25 else 1.0)
            if in_mouth(x, y, r) or not free(x, y, z, r * 0.6, k):
                continue
            n = normal(x, y)
            placed.setdefault((int(x // 0.5), int(y // 0.5)), []).append((x, y, z, r * 0.6))
            lay(x, y, z - r * 0.12, r, n, big)

    nk, nw = max(8, int(L / 0.3)), max(4, int(W / 0.3))
    if not arch:  # a skirt: two rows round the foot, down the slope, so a heap on a hillside has no gap under it
        per = [(x, -W / 2) for x in [-L / 2 + L * i / 14 for i in range(15)]] + [(L / 2, y) for y in [-W / 2 + W * j / 6 for j in range(1, 7)]]             + [(x, W / 2) for x in [L / 2 - L * i / 14 for i in range(1, 15)]] + [(-L / 2, y) for y in [W / 2 - W * j / 6 for j in range(1, 6)]]
        for x, y in per:
            if ow > 0 and abs(x) < ow / 2 + 0.3:
                continue
            for zr in (-0.22, -0.55):
                r = stone * rnd.uniform(0.55, 0.8)
                spec = {"sx": r * 2.2, "sy": r * 1.6, "sz": r * 1.3, "exponent": rnd.uniform(2.3, 3.0), "lumps": 0.5, "seed": rnd.randint(1, 10 ** 6),
                        "seg": 10, "rings": 6, "mat": mats[0] if rnd.random() < 0.55 else rnd.choice(mats)}
                g.push(Matrix.Translation((x * 0.985, y * 0.985, zr)) @ Matrix.Rotation(rnd.uniform(0, math.pi), 4, "Z"))
                boulder(g, spec)
                g.pop()
    if arch:
        _arch_masonry(g, rnd, mats, L, W, ow, oh, depth, lambda x: surf(x, 0.0), roof)
        return
    # the flanks (steep: the passes above sample from above and leave them thin) and the parapet along both edges
    for _ in range(int(L * 260 * stone)):
        x, sgn, zt = rnd.uniform(-L / 2, L / 2), rnd.choice((-1, 1)), rnd.uniform(0.0, 1.0)
        top_z = surf(x, 0.0)
        if top_z < 0.1:
            continue
        zq = zt * top_z
        lo, hi = 0.0, W / 2
        for _i in range(18):  # the y on the flank where the surface is zq
            mid = (lo + hi) / 2
            lo, hi = (mid, hi) if surf(x, mid) > zq else (lo, mid)
        y = sgn * hi
        r = stone * rnd.uniform(0.8, 1.2) * (0.6 + 0.4 * min(1.0, zq / 0.3))
        if in_mouth(x, y, r) or not free(x, y, zq, r * 0.6, 0.85):
            continue
        n = normal(x, y)
        placed.setdefault((int(x // 0.5), int(y // 0.5)), []).append((x, y, zq, r * 0.6))
        lay(x, y, zq - r * 0.12, r, n, True)
    if not arch:
        yp, tp = W / 2 - 0.42, 0.44
        for sgn in (-1, 1):
            _parapet(g, rnd, mats, L, sgn * yp, tp, lambda x: surf(x, yp), sc=0.8)
    # dressed stones on the headwalls (the vertical faces y = +-W/2 beside and over the culvert) and round the mouth
    if ow > 0:
        for sgn in (-1, 1):
            y = sgn * (W / 2 - 0.02)
            courses = 0
            z = -depth * 0.55
            while z < oh + 0.55:
                ch = rnd.uniform(0.24, 0.34)
                x = -(ow / 2 + 0.6)
                while x < ow / 2 + 0.6:
                    cw = rnd.uniform(0.34, 0.6)
                    xc, zc = x + cw / 2, z + ch / 2
                    r0 = roof(xc)
                    inside = abs(xc) < ow / 2 + cw * 0.5 and zc - ch * 0.5 < max(r0, 0.0) + 0.02 and abs(xc) < ow / 2 + 0.2
                    under_head = zc + ch * 0.4 < surf(xc, W / 2 - 0.1) + 0.05
                    if not inside and under_head and zc > -depth * 0.6 and not (abs(xc) < ow / 2 - 0.05):
                        spec = {"sx": cw * 1.1, "sy": 0.34, "sz": ch * 1.2, "exponent": rnd.uniform(2.6, 3.4), "lumps": 0.5,
                                "flats": [{"dir": (0, sgn, 0), "at": 0.75, "keep": 0.15}], "seed": rnd.randint(1, 10 ** 6),
                                "seg": 10, "rings": 6, "mat": mats[0] if rnd.random() < 0.55 else rnd.choice(mats)}
                        g.push(Matrix.Translation((xc, y - sgn * 0.12, zc)) @ Matrix.Rotation(math.radians(rnd.uniform(-4, 4)), 4, "Z"))
                        boulder(g, spec)
                        g.pop()
                    x += cw * rnd.uniform(0.9, 1.0)
                z += ch * 0.92
                courses += 1
        # the voussoirs: bigger stones standing round the arch at both mouths
        nv = max(5, int(math.pi * ow / 2 / 0.4))
        for sgn in (-1, 1):
            for k in range(nv + 1):
                a = math.pi * k / nv
                xa, za = -math.cos(a) * (ow / 2 + 0.12), math.sin(a) * (oh + 0.12)
                spec = {"sx": 0.42, "sy": 0.46, "sz": 0.3, "exponent": 2.8, "lumps": 0.5,
                        "flats": [{"dir": (0, sgn, 0), "at": 0.75, "keep": 0.15}], "seed": rnd.randint(1, 10 ** 6),
                        "seg": 10, "rings": 6, "mat": mats[0] if rnd.random() < 0.55 else rnd.choice(mats)}
                g.push(Matrix.Translation((xa, sgn * (W / 2 - 0.05), za)) @ Matrix.Rotation(a - math.pi / 2, 4, "Y"))
                boulder(g, spec)
                g.pop()


def _clip_convex(poly, clip):
    """Sutherland-Hodgman: poly clipped by a convex CCW polygon."""
    out = poly
    n = len(clip)
    for i in range(n):
        a, b = clip[i], clip[(i + 1) % n]
        inside = lambda p: (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]) >= 0
        src, out = out, []
        if not src:
            break
        for j in range(len(src)):
            p, q = src[j], src[(j + 1) % len(src)]
            ip, iq = inside(p), inside(q)
            if ip:
                out.append(p)
            if ip != iq:
                dx, dy = q[0] - p[0], q[1] - p[1]
                den = (b[0] - a[0]) * dy - (b[1] - a[1]) * dx
                if abs(den) > 1e-12:
                    t = ((b[1] - a[1]) * (p[0] - a[0]) - (b[0] - a[0]) * (p[1] - a[1])) / den
                    out.append((p[0] + dx * t, p[1] + dy * t))
    return out


def _grid_ground(G):
    """Bilinear height at asset-local (x, y) from a `grid` {x0, y0, cell, cols, rows, z: row-major}."""
    x0, y0, c, nc, nr, Z = G["x0"], G["y0"], G["cell"], G["cols"], G["rows"], G["z"]

    def ground(x, y):
        fx = min(max((x - x0) / c, 0), nc - 1.001)
        fy = min(max((y - y0) / c, 0), nr - 1.001)
        i, j = int(fx), int(fy)
        u, v = fx - i, fy - j
        z00, z10, z01, z11 = Z[j * nc + i], Z[j * nc + i + 1], Z[(j + 1) * nc + i], Z[(j + 1) * nc + i + 1]
        return (z00 * (1 - u) + z10 * u) * (1 - v) + (z01 * (1 - u) + z11 * u) * v
    return ground


def drape(g, s):
    """Paving laid on the real ground: `grid` = heights (asset-local metres, from the DEM) on a regular
    grid {x0, y0, cell, cols, rows, z: row-major}; cells clipped to the convex polygon `poly`.
    A skirt goes 0.6 m down round the edge so a slightly different mesh surface never shows a gap.
    `floor`: the paving never drops below this height (a level terrace built up where the ground falls
    away; the skirt then shows as its kerb)."""
    G = s["grid"]
    x0, y0, c, nc, nr = G["x0"], G["y0"], G["cell"], G["cols"], G["rows"]
    lift = s.get("lift", 0.04)
    floor = s.get("floor", -1e9)
    ground = _grid_ground(G)

    def zat(x, y):
        return max(floor, ground(x, y) + lift)

    def zfoot(x, y):
        return min(zat(x, y) - 0.6, ground(x, y) - 0.3)

    poly = s["poly"]
    for j in range(nr - 1):
        for i in range(nc - 1):
            cell = [(x0 + i * c, y0 + j * c), (x0 + (i + 1) * c, y0 + j * c), (x0 + (i + 1) * c, y0 + (j + 1) * c), (x0 + i * c, y0 + (j + 1) * c)]
            cp = _clip_convex(cell, poly)
            if len(cp) >= 3:
                g.poly([(x, y, zat(x, y)) for x, y in cp], s.get("mat", "brick_paving"))
    n = len(poly)
    for k in range(n):
        a, b = poly[k], poly[(k + 1) % n]
        L = math.dist(a, b)
        m = max(1, int(L / c))
        for i in range(m):
            p = (a[0] + (b[0] - a[0]) * i / m, a[1] + (b[1] - a[1]) * i / m)
            q = (a[0] + (b[0] - a[0]) * (i + 1) / m, a[1] + (b[1] - a[1]) * (i + 1) / m)
            g.poly([(p[0], p[1], zfoot(*p)), (q[0], q[1], zfoot(*q)), (q[0], q[1], zat(*q)), (p[0], p[1], zat(*p))], s.get("edge", "concrete"))


def markings(g, s):
    """Paint on the ground (car park stall lines): flat strips `width` wide along `lines`
    [[x0, y0, x1, y1], ...], `lift` over the heights `grid` (as drape), cut every grid cell so they
    follow the ground. No skirt: a strip has no thickness to show."""
    ground = _grid_ground(s["grid"])
    c = s["grid"]["cell"]
    w = s.get("width", 0.12) / 2
    lift = s.get("lift", 0.03)
    mat = s.get("mat", "line_paint")
    for x0, y0, x1, y1 in s["lines"]:
        L = math.hypot(x1 - x0, y1 - y0)
        nx, ny = -(y1 - y0) / L * w, (x1 - x0) / L * w  # left of the line, half the width
        m = max(1, math.ceil(L / c))
        for i in range(m):
            p = (x0 + (x1 - x0) * i / m, y0 + (y1 - y0) * i / m)
            q = (x0 + (x1 - x0) * (i + 1) / m, y0 + (y1 - y0) * (i + 1) / m)
            quad = [(p[0] - nx, p[1] - ny), (q[0] - nx, q[1] - ny), (q[0] + nx, q[1] + ny), (p[0] + nx, p[1] + ny)]
            g.poly([(x, y, ground(x, y) + lift) for x, y in quad], mat)


def _stone(g, c, r, rnd, mat):
    seg, rings = 7, 4
    sx, sy, sz = r * rnd.uniform(0.8, 1.3), r * rnd.uniform(0.7, 1.1), r * rnd.uniform(0.5, 0.8)
    rot = rnd.uniform(0, math.pi)
    pts = []
    for j in range(rings + 1):
        t = math.pi * j / rings
        row = []
        for i in range(seg):
            a = 2 * math.pi * i / seg + rot
            k = rnd.uniform(0.85, 1.12) if 0 < j < rings else 1.0
            row.append((c[0] + sx * k * math.sin(t) * math.cos(a), c[1] + sy * k * math.sin(t) * math.sin(a), c[2] + sz * math.cos(t) * (0.9 if j > rings / 2 else 1.0)))
        pts.append(row)
    for j in range(rings):
        for i in range(seg):
            k = (i + 1) % seg
            q = [pts[j][i], pts[j + 1][i], pts[j + 1][k], pts[j][k]]
            if j == 0:
                g.poly([q[0], q[1], q[2]], mat)
            elif j == rings - 1:
                g.poly([q[0], q[1], q[3]], mat)
            else:
                g.poly(q, mat)


def stones(g, s):
    """Embankment of loose stones on a mound: the mound (as rock_pile) plus individual stones."""
    rock_pile(g, dict(s, mat=s.get("baseMat", s.get("mat", "white_stones"))))
    L, W, h = s["length"], s.get("width", 2.0), s.get("height", 0.8)
    rnd = random.Random(s.get("seed", 1) * 31 + 7)
    n = int(L * W * s.get("density", 7))
    for _ in range(n):
        x = rnd.uniform(-L / 2 + 0.2, L / 2 - 0.2)
        y = rnd.uniform(-W / 2 + 0.15, W / 2 - 0.15)
        t = abs(y) / (W / 2)
        ends = min(1.0, (L / 2 - abs(x)) / 0.8)
        z = h * max(0.0, 1 - t ** 1.6) * max(0.0, ends)
        r = rnd.uniform(0.09, 0.22)
        _stone(g, (x, y, z), r, rnd, s.get("mat", "white_stones"))


def range_mat(g, s):
    w, d = s.get("width", 1.5), s.get("depth", 1.5)
    g.box((0, 0, 0.0), (w, d, 0.06), "turf_mat_dark", mats={"top": "turf_mat"})
    g.box((0.3, 0.1, 0.035), (0.2, 0.2, 0.012), "rubber_black")  # rubber tee
    g.cylinder((0.3, 0.1, 0.04), 0.012, 0.035, "rubber_black", seg=6)
    g.box((-w / 2 + 0.3, 0.45, 0.06), (0.4, 0.3, 0.06), "paint_grey")  # ball tray on the mat


def net_poles(g, s):
    """Safety net along a polyline: poles every `spacing` m and a dark translucent-looking net as thin quads."""
    pts, h = s["pts"], s.get("height", 8.0)
    sp = s.get("spacing", 8.0)
    for a, b in zip(pts[:-1], pts[1:]):
        L = math.dist(a, b)
        n = max(1, int(round(L / sp)))
        for i in range(n + 1):
            t = i / n
            x, y = a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t
            g.cylinder((x, y, -0.5), 0.09, h + 0.5, "galvanised", seg=8, r_top=0.06)
        for z0, z1 in ((h - 0.06, h), (0.0, 0.06)):
            g.beam((a[0], a[1], (z0 + z1) / 2), (b[0], b[1], (z0 + z1) / 2), 0.02, 0.02, "galvanised")
        q = [(a[0], a[1], 0.05), (b[0], b[1], 0.05), (b[0], b[1], h), (a[0], a[1], h)]
        g.poly(q, "net")
        # the back side 4 mm behind: on the same corners the build's weld merges the two faces into one,
        # and the net showed from the outside only
        ox, oy = (b[1] - a[1]) / L * 0.004, -(b[0] - a[0]) / L * 0.004
        g.poly([(x + ox, y + oy, z) for x, y, z in reversed(q)], "net")


def target_flag(g, s):
    h = s.get("height", 2.2)
    g.cylinder((0, 0, -0.3), 0.012, h + 0.3, "paint_white", seg=6)
    m = s.get("mat", "target_flag_red")
    q = [(0, 0, h - 0.4), (0.5, 0, h - 0.4), (0.5, 0, h), (0, 0, h)]
    g.poly(q, m)
    g.poly([(x, 0.004, z) for x, _, z in reversed(q)], m)   # off the front's corners, or the weld merges them (net_poles)


def distance_board(g, s):
    w, h = s.get("width", 1.2), s.get("height", 0.9)
    for x in (-w / 2 + 0.1, w / 2 - 0.1):
        g.box((x, 0, (0.6 + h) / 2 - 0.3), (0.08, 0.08, 0.6 + h + 0.3), "wood_post")
    g.box((0, 0, 0.6 + h / 2), (w, 0.04, h), s.get("mat", "paint_white"), mats={"-y": s.get("face", "sign_yellow"), "+y": s.get("face", "sign_yellow")})


def banner(g, s):
    """Sponsor banner on two posts (range embankment 'ahlsell' board)."""
    w, h, z0 = s.get("width", 3.0), s.get("height", 0.8), s.get("z", 0.4)
    for x in (-w / 2 + 0.05, w / 2 - 0.05):
        g.box((x, 0.03, (z0 + h) / 2), (0.06, 0.06, z0 + h + 0.3), "galvanised")
    g.box((0, 0, z0 + h / 2), (w, 0.02, h), s.get("back", "paint_white"), mats={"-y": s.get("face", "sign_blue")})
    if s.get("stripe"):
        g.box((0, -0.012, z0 + h * 0.5), (w * 0.6, 0.004, h * 0.22), s["stripe"])


def power_pole(g, s):
    h = s.get("height", 9.0)
    g.cylinder((0, 0, -1.0), 0.14, h + 1.0, "wood_post", seg=8, r_top=0.11)
    g.box((0, 0, h - 0.5), (0.1, 1.8, 0.1), "wood_post")
    for y in (-0.8, 0.0, 0.8):
        g.cylinder((0, y, h - 0.45), 0.04, 0.15, "paint_white", seg=6)


def car(g, s):
    """Low-poly passenger car (estate or SUV), 4.7 x 1.85 m. Body colour material `mat`."""
    kind = s.get("style", "estate")
    L, W = s.get("length", 4.7), s.get("width", 1.85)
    body, glass = s.get("mat", "paint_silver"), "car_glass"
    hb = 0.95 if kind != "suv" else 1.05  # belt line
    hr = 1.48 if kind != "suv" else 1.68  # roof
    clear = 0.18 if kind != "suv" else 0.22
    hw = W / 2
    # lower body (profile along x, extruded across y)
    side = [(-L / 2, clear + 0.1), (-L / 2 + 0.1, clear), (L / 2 - 0.15, clear), (L / 2, clear + 0.15), (L / 2, hb - 0.12), (L / 2 - 0.25, hb), (-L / 2 + 0.1, hb), (-L / 2, hb - 0.05)]
    n = len(side)
    for i in range(n):
        a, b = side[i], side[(i + 1) % n]
        g.poly([(a[0], -hw, a[1]), (b[0], -hw, b[1]), (b[0], hw, b[1]), (a[0], hw, a[1])][::-1], body)
    g.poly([(p[0], -hw, p[1]) for p in side], body)
    g.poly([(p[0], hw, p[1]) for p in reversed(side)], body)
    # cabin
    rear = -L / 2 + (0.15 if kind != "sedan" else 0.6)
    cab = [(rear, hb), (L / 2 - 1.45, hb), (L / 2 - 2.05, hr), (rear + 0.12, hr)]
    ti = 0.12
    for i in range(4):
        a, b = cab[i], cab[(i + 1) % 4]
        if i == 0:
            continue
        mat = glass if i in (1, 3) else body
        g.poly([(a[0], -hw + ti, a[1]), (b[0], -hw + ti, b[1]), (b[0], hw - ti, b[1]), (a[0], hw - ti, a[1])][::-1], mat)
    g.poly([(p[0], -hw + ti, p[1]) for p in cab], glass)
    g.poly([(p[0], hw - ti, p[1]) for p in reversed(cab)], glass)
    # pillars on the side glass
    for x in (L / 2 - 1.75, L / 2 - 2.9, rear + 0.2):
        for y in (-hw + ti - 0.005, hw - ti + 0.005):
            g.box((x, y, (hb + hr) / 2), (0.1, 0.01, hr - hb - 0.02), body)
    # wheels
    for x in (L / 2 - 0.85, -L / 2 + 0.95):
        for y in (-hw + 0.12, hw - 0.12):
            g.push(Matrix.Translation((x, y, 0.33)) @ Matrix.Rotation(math.pi / 2, 4, "X"))
            g.cylinder((0, 0, -0.11), 0.33, 0.22, "tyre", seg=10)
            g.pop()
    # lights
    for y in (-hw + 0.25, hw - 0.25):
        g.box((L / 2 + 0.005, y, hb - 0.2), (0.02, 0.35, 0.1), "light_lens")
        g.box((-L / 2 - 0.005, y, hb - 0.12), (0.02, 0.3, 0.12), "paint_red")


def _lerp_table(tab, x):
    """Piecewise-linear lookup in [(x, v), ...] sorted by x."""
    if x <= tab[0][0]:
        return tab[0][1]
    for (x0, v0), (x1, v1) in zip(tab[:-1], tab[1:]):
        if x <= x1:
            return v0 + (v1 - v0) * (x - x0) / (x1 - x0)
    return tab[-1][1]


CAR_STYLES = {
    # profile tables along x (front +x): body bottom, belt/hood/boot line, roof (cabin only), half widths
    "estate": {
        "L": 4.75, "W": 1.86,
        "bottom": [(-2.375, 0.36), (-2.2, 0.24), (2.1, 0.24), (2.375, 0.38)],
        "belt": [(-2.375, 0.62), (-2.33, 0.98), (-2.0, 1.00), (0.9, 0.93), (1.9, 0.82), (2.3, 0.72), (2.375, 0.55)],
        "cabin": (-2.28, 0.95), "roof": [(-2.28, 1.02), (-2.18, 1.44), (-0.3, 1.47), (0.2, 1.44), (0.95, 0.95)],
        "wheels": (1.42, -1.45), "r": 0.335,
    },
    "suv": {
        "L": 4.70, "W": 1.90,
        "bottom": [(-2.35, 0.45), (-2.15, 0.30), (2.05, 0.30), (2.35, 0.48)],
        "belt": [(-2.35, 0.72), (-2.30, 1.10), (-2.0, 1.12), (0.9, 1.06), (1.85, 0.98), (2.28, 0.86), (2.35, 0.66)],
        "cabin": (-2.22, 0.98), "roof": [(-2.22, 1.15), (-2.12, 1.66), (-0.2, 1.70), (0.25, 1.66), (0.98, 1.07)],
        "wheels": (1.40, -1.42), "r": 0.37,
    },
    "hatch": {
        "L": 4.25, "W": 1.80,
        "bottom": [(-2.125, 0.34), (-1.95, 0.23), (1.9, 0.23), (2.125, 0.36)],
        "belt": [(-2.125, 0.60), (-2.1, 0.96), (-1.8, 0.98), (0.8, 0.92), (1.7, 0.82), (2.08, 0.70), (2.125, 0.52)],
        "cabin": (-2.02, 0.80), "roof": [(-2.02, 0.99), (-1.75, 1.44), (-0.2, 1.47), (0.2, 1.44), (0.80, 0.94)],
        "wheels": (1.30, -1.32), "r": 0.32,
    },
}


def car2(g, s):
    """Lofted passenger car: rounded body sections along x with tumblehome, glazed greenhouse with body
    pillars, wheels with rims in the arches, lights, grille, mirrors and plates. ~1.5k tris."""
    st = CAR_STYLES[s.get("style", "estate")]
    body, glass, dark = s.get("mat", "paint_silver"), "car_glass", "rubber_black"
    L, hw = st["L"], st["W"] / 2
    x0c, x1c = st["cabin"]
    N = 26
    xs = [-L / 2 + L * i / N for i in range(N + 1)]
    # cross-section template (half, from bottom centre round to roof centre): (lateral fraction, height key, inset)
    def section(x):
        zb = _lerp_table(st["bottom"], x)
        zl = _lerp_table(st["belt"], x)
        in_cab = x0c <= x <= x1c
        zr = _lerp_table(st["roof"], x) if in_cab else zl
        zr = max(zr, zl)
        endf = min(1.0, (L / 2 - abs(x)) / 0.35 + 0.72)  # ends taper in plan
        w = hw * endf
        pts = [(0.0, zb - 0.02), (w - 0.12, zb), (w - 0.02, zb + 0.08), (w, zb + 0.25), (w + 0.01, (zb + zl) / 2 + 0.05),
               (w - 0.01, zl - 0.06), (w - 0.06, zl)]
        tags = ["b", "b", "b", "b", "b", "b", "b"]
        if zr > zl + 0.05:
            tw = w - 0.06 - (zr - zl) * 0.28  # tumblehome
            pts += [(tw, zr - 0.06), (tw - 0.12, zr), (0.0, zr + 0.02)]
            tags += ["g", "r", "r"]
        else:
            pts += [(w - 0.35, zl + 0.03), (0.0, zl + 0.05)]
            tags += ["b", "b"]
        return pts, tags

    secs = [section(x) for x in xs]
    # resample every section to the same number of points so neighbours can be joined
    K = 12

    def resample(pts):
        d = [0.0]
        for a, b in zip(pts[:-1], pts[1:]):
            d.append(d[-1] + math.dist(a, b))
        out = []
        for k in range(K):
            t = min(d[-1] * k / (K - 1), d[-1] - 1e-9)
            for i in range(len(d) - 1):
                if d[i + 1] >= t:
                    f = (t - d[i]) / max(d[i + 1] - d[i], 1e-9)
                    out.append((pts[i][0] + (pts[i + 1][0] - pts[i][0]) * f, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * f))
                    break
            else:
                out.append(pts[-1])
        return out

    rs = [resample(p) for p, _ in secs]
    pillars = [x1c - 0.05, (x0c + x1c) / 2 + 0.25, x0c + 0.08]
    for i in range(N):
        xa, xb = xs[i], xs[i + 1]
        xm = (xa + xb) / 2
        for k in range(K - 1):
            for side in (1, -1):
                p = [(xa, side * rs[i][k][0], rs[i][k][1]), (xb, side * rs[i + 1][k][0], rs[i + 1][k][1]),
                     (xb, side * rs[i + 1][k + 1][0], rs[i + 1][k + 1][1]), (xa, side * rs[i][k + 1][0], rs[i][k + 1][1])]
                zmid = (rs[i][k][1] + rs[i][k + 1][1]) / 2
                in_cab = x0c < xm < x1c
                zl = _lerp_table(st["belt"], xm)
                zr = _lerp_table(st["roof"], xm) if in_cab else zl
                m = body
                zroof_top = max(_lerp_table(st["roof"], t) for t in (xa, xb)) if in_cab else zl
                # side glass: the band between belt and the roof rail; screens: the sloping cabin ends
                side_band = in_cab and zl + 0.04 < zmid < zr - 0.07 and k < K - 2
                screen = in_cab and zmid > zl + 0.04 and (xm < x0c + 0.22 or xm > _lerp_table([(0, st["roof"][-2][0])], 0) + 0.05)
                if side_band or screen:
                    m = glass
                    if side_band and not screen and any(abs(xm - px) < 0.08 for px in pillars):
                        m = body
                g.poly(p if side < 0 else [p[1], p[0], p[3], p[2]], m)
    # end caps (front and back faces)
    for i, sgn in ((0, -1), (N, 1)):
        pts = rs[i]
        ring = [(xs[i], -y, z) for y, z in reversed(pts)] + [(xs[i], y, z) for y, z in pts]
        g.poly(ring if sgn > 0 else list(reversed(ring)), body)
    # wheels: tyre + rim, dark arch liner behind
    r = st["r"]
    for wx in st["wheels"]:
        for side in (1, -1):
            y = side * (hw - 0.14)
            g.push(Matrix.Translation((wx, y, r)) @ Matrix.Rotation(math.pi / 2, 4, "X"))
            g.cylinder((0, 0, -0.11), r, 0.22, "tyre", seg=14)
            g.cylinder((0, 0, 0.112 * -side), r * 0.62, 0.004, s.get("rim", "paint_silver"), seg=10)
            g.pop()
            g.box((wx, side * (hw - 0.2), r + 0.05), (2 * r + 0.1, 0.25, 0.3), dark, skip=("+y" if side > 0 else "-y",))
    zf = _lerp_table(st["bottom"], L / 2) + 0.2
    zbelt_f = _lerp_table(st["belt"], L / 2 - 0.05)
    # lights, grille, plates, mirrors
    for side in (1, -1):
        g.box((L / 2 - 0.02, side * (hw - 0.32), zbelt_f - 0.08), (0.06, 0.38, 0.1), "light_lens")
        g.box((-L / 2 + 0.02, side * (hw - 0.25), _lerp_table(st["belt"], -L / 2 + 0.05) - 0.12), (0.06, 0.3, 0.16), "paint_red")
        g.box((x1c - 0.15, side * (hw + 0.08), _lerp_table(st["belt"], x1c) + 0.08), (0.12, 0.16, 0.1), body)
    g.box((L / 2 + 0.005, 0, zf + 0.05), (0.03, hw * 1.0, 0.16), dark)
    g.box((L / 2 + 0.03, 0, zf - 0.08), (0.02, 0.52, 0.11), "plate")
    g.box((-L / 2 - 0.02, 0, _lerp_table(st["bottom"], -L / 2) + 0.28), (0.02, 0.52, 0.11), "plate")


def golf_cart(g, s):
    L, W = 2.4, 1.2
    g.box((0, 0, 0.45), (L, W, 0.5), s.get("mat", "paint_black"))
    g.box((0.2, 0, 0.85), (0.6, W - 0.1, 0.12), "rubber_black")
    g.box((0.4, 0, 1.05), (0.1, W - 0.1, 0.5), "rubber_black")
    for x in (-L / 2 + 0.1, L / 2 - 0.5):
        for y in (-W / 2 + 0.05, W / 2 - 0.05):
            g.box((x, y, 1.35), (0.05, 0.05, 1.3), "paint_black")
    g.box((-0.2, 0, 2.02), (L, W + 0.1, 0.06), s.get("roofMat", "paint_black"))
    for x in (0.8, -0.8):
        for y in (-W / 2 + 0.05, W / 2 - 0.05):
            g.push(Matrix.Translation((x, y, 0.22)) @ Matrix.Rotation(math.pi / 2, 4, "X"))
            g.cylinder((0, 0, -0.1), 0.22, 0.2, "tyre", seg=8)
            g.pop()


def bridge_wood(g, s):
    """Timber footbridge with handrails along x, length L, width W, slight arch."""
    L, W = s["length"], s.get("width", 2.0)
    rise = s.get("rise", 0.25)
    n = 8
    zs = [rise * math.sin(math.pi * i / n) for i in range(n + 1)]
    xs = [-L / 2 + L * i / n for i in range(n + 1)]
    for i in range(n):
        g.poly([(xs[i], -W / 2, zs[i] + 0.1), (xs[i + 1], -W / 2, zs[i + 1] + 0.1), (xs[i + 1], W / 2, zs[i + 1] + 0.1), (xs[i], W / 2, zs[i] + 0.1)], s.get("deck", "asphalt"))
        for y in (-W / 2, W / 2):
            g.beam((xs[i], y, zs[i]), (xs[i + 1], y, zs[i + 1]), 0.12, 0.25, "wood_grey")
            g.beam((xs[i], y, zs[i] + 0.95), (xs[i + 1], y, zs[i + 1] + 0.95), 0.07, 0.07, "wood_grey")
    for i in range(0, n + 1, 2):
        for y in (-W / 2, W / 2):
            g.box((xs[i], y, zs[i] + 0.5), (0.09, 0.09, 1.0), "wood_grey")
    for x in (-L / 2, L / 2):
        g.box((x, 0, -0.4), (0.4, W + 0.3, 0.8), "concrete")


def bridge_brick(g, s):
    """Masonry footbridge on a low arch (the 18th, photo 101): a concrete deck and arch slab, parapet
    walls of split-face blocks (courses follow the arch) under a concrete coping. A closed solid: every
    end is capped. Heights are relative to the arch line z = rise * sin(pi * t)."""
    L, W = s["length"], s.get("width", 2.0)
    rise = s.get("rise", 0.35)
    wall, conc = s.get("wall", "splitface_block"), s.get("deck", "concrete_weathered")
    t, ph, cap, lip = s.get("wallThickness", 0.28), s.get("parapet", 0.7), 0.07, 0.03
    deck, brick0, soffit = 0.1, -0.05, -0.4  # deck top, foot of the outer block face, underside of the arch slab
    n = 14
    xs = [-L / 2 + L * i / n for i in range(n + 1)]
    zs = [rise * math.sin(math.pi * i / n) for i in range(n + 1)]
    arc = [0.0]
    for i in range(n):
        arc.append(arc[-1] + math.hypot(xs[i + 1] - xs[i], zs[i + 1] - zs[i]))
    yo = W / 2 + t  # outer face of a parapet

    def side(y, z0, z1, mat, facing):
        """Vertical strip along the arch at y from z0 to z1 above the arch line, normal facing +-y;
        UVs run along the arch (u) and up from it (v), so the block courses bend with the bridge."""
        for i in range(n):
            p = [(xs[i], y, zs[i] + z0), (xs[i + 1], y, zs[i + 1] + z0), (xs[i + 1], y, zs[i + 1] + z1), (xs[i], y, zs[i] + z1)]
            uv = [(arc[i], z0), (arc[i + 1], z0), (arc[i + 1], z1), (arc[i], z1)]
            if facing > 0:
                p, uv = p[::-1], uv[::-1]
            g.poly(p, mat, ("uv", uv))

    def flat(y0, y1, z, mat, facing):
        for i in range(n):
            p = [(xs[i], y0, zs[i] + z), (xs[i + 1], y0, zs[i + 1] + z), (xs[i + 1], y1, zs[i + 1] + z), (xs[i], y1, zs[i] + z)]
            g.poly(p if facing > 0 else p[::-1], mat)

    def end(i, y0, y1, z0, z1, mat):
        x, z, f = xs[i], zs[i], 1 if i == n else -1
        p = [(x, y0, z + z0), (x, y1, z + z0), (x, y1, z + z1), (x, y0, z + z1)]
        g.poly(p if f > 0 else p[::-1], mat)

    flat(-W / 2, W / 2, deck, conc, 1)
    flat(-yo, yo, soffit, conc, -1)
    for d in (-1, 1):
        yi, yw = d * W / 2, d * yo
        lo, hi = min(yi, yw), max(yi, yw)
        side(yi, deck, ph, wall, -d)
        side(yw, brick0, ph, wall, d)
        side(yw, soffit, brick0, conc, d)  # the arch slab's edge below the blocks
        # coping, overhanging the wall by `lip` on both faces
        ci, co = yi - d * lip, yw + d * lip
        flat(min(ci, co), max(ci, co), ph + cap, conc, 1)
        flat(min(ci, co), max(ci, co), ph, conc, -1)
        side(ci, ph, ph + cap, conc, -d)
        side(co, ph, ph + cap, conc, d)
        for i in (0, n):
            end(i, lo, hi, deck, ph, wall)
            end(i, min(ci, co), max(ci, co), ph, ph + cap, conc)
    for i in (0, n):
        end(i, -yo, yo, soffit, deck, conc)


def bridge_rope(g, s):
    """Timber footbridge with rope railings (the 14th, photos 83-84) along x, length L, width W: a flat deck
    of loose cross planks at height `deck` on three stringers, white fascia boards, square posts at the deck
    edges carrying two sagging hemp ropes per bay with a knot where each rope meets a post, piles under
    every post pair (`pileDepth` below the origin), and railway-sleeper steps down to the ground at each end (`steps` = [-x count, +x count]).
    `ramps` = [-x run, +x run] in metres puts a plank ramp at that end instead of its steps (a low deck a trolley rolls over).
    Origin on the bank ground (placed with ground "max"); the creek bed is below z = 0."""
    import random
    L, W = s["length"], s.get("width", 1.8)
    h = s.get("deck", 0.4)
    bays, ph = s.get("bays", 5), s.get("postHeight", 1.05)
    r = random.Random(s.get("seed", 14))
    deck, post, sleeper, rope = s.get("deckMat", "wood_deck_grey"), s.get("postMat", "wood_post_brown"), "wood_sleeper", "rope_hemp"
    pt, pitch, pw = 0.035, 0.155, 0.14  # plank thickness, spacing, width
    n = int(L / pitch)
    for i in range(n):
        x = -L / 2 + (L - n * pitch) / 2 + pitch * (i + 0.5)
        g.box((x, 0, h - pt / 2 + r.uniform(-0.004, 0.004)), (pw, W, pt), deck, rz=r.uniform(-0.6, 0.6))
    sz = 0.2  # stringer depth
    for y in (-W / 2 + 0.1, 0.0, W / 2 - 0.1):
        g.box((0, y, h - pt - sz / 2), (L, 0.07, sz), sleeper)
    for d in (-1, 1):
        g.box((0, d * (W / 2 + 0.0125), h - 0.12), (L, 0.025, 0.22), "white_trim")
    yp = W / 2 + 0.025 + 0.06  # post centres, outside the fascia
    xs = [-L / 2 + 0.08 + k * (L - 0.16) / bays for k in range(bays + 1)]
    for x in xs:
        for d in (-1, 1):
            g.box((x, d * yp, h + (ph - 0.35) / 2), (0.12, 0.12, ph + 0.35), post)
            g.pipe((x, d * yp, -s.get("pileDepth", 1.6)), (x, d * yp, h - pt - sz - 0.12), 0.08, sleeper, seg=8)
        g.box((x, 0, h - pt - sz - 0.06), (0.1, 2 * yp + 0.12, 0.12), sleeper)
    # ropes: parabolic swags through the posts, a monkey's-fist knot on each post's outer face
    for zr, sag in ((h + ph - 0.13, 0.24), (h + 0.52, 0.15)):
        for d in (-1, 1):
            for a, b in zip(xs[:-1], xs[1:]):
                pts = [(a + (b - a) * t / 8, d * yp, zr - sag * 4 * (t / 8) * (1 - t / 8)) for t in range(9)]
                for p, q in zip(pts[:-1], pts[1:]):
                    g.pipe(p, q, 0.022, rope, seg=6)
            for x in xs:
                g.sphere((x, d * (yp + 0.09), zr), 0.06, rope, seg=8, rings=5)
    # plank ramps for trolleys: cross planks on two sloping bearers, from the deck down to `rampFoot` (in the ground)
    ramps = s.get("ramps", [0, 0])
    foot = s.get("rampFoot", -0.1)
    for sgn, run in zip((-1, 1), ramps):
        if not run:
            continue
        x0, slope = sgn * L / 2, math.hypot(run, h - foot)
        g.push(Matrix.Translation((x0, 0, h)) @ Matrix.Rotation(sgn * math.atan2(h - foot, run), 4, "Y"))
        m = int(slope / pitch)
        for i in range(m):
            g.box((sgn * pitch * (i + 0.5), 0, -pt / 2), (pw, W, pt), deck, rz=r.uniform(-0.6, 0.6))
        for y in (-W / 2 + 0.1, W / 2 - 0.1):
            g.box((sgn * slope / 2, y, -pt - 0.06), (slope, 0.07, 0.12), sleeper)
        g.pop()
    # sleeper steps: treads with grass between, splayed edging sleepers along both sides
    for sgn, cnt, run in zip((-1, 1), s.get("steps", [1, 3]), ramps):
        if not cnt or run:
            continue
        rise, run = h / (cnt + 1), 0.42
        x0 = sgn * L / 2
        for i in range(1, cnt + 1):
            top = h - i * rise
            g.box((x0 + sgn * (0.2 + (i - 1) * run), 0, top - 0.23), (0.25, W + 0.2, 0.46), sleeper)
        x1 = x0 + sgn * (0.35 + (cnt - 1) * run)
        for d in (-1, 1):
            g.beam((x0, d * (W / 2 + 0.22), h - rise - 0.1), (x1, d * (W / 2 + 0.22 + 0.08 * cnt), 0.02), 0.22, 0.2, sleeper)


def jetty(g, s):
    """Timber jetty out over a pond along +x. Origin on the bank top at the land end: a boarded gangway `ramp` long
    and `rampWidth` wide runs from z = 0 down to the deck at z = `deckZ`, then a level deck `length` x `width` of
    cross planks on stringers, a cross beam and two piles (`pileDepth` below the deck) every ~3 m, and a few newer,
    paler boards across each end of the deck."""
    import random
    L, W, R = s["length"], s.get("width", 4.0), s.get("ramp", 3.0)
    z, RW = s.get("deckZ", -0.2), s.get("rampWidth", s.get("width", 4.0) - 0.6)
    r = random.Random(s.get("seed", 5))
    deck, pale, sleeper = s.get("deckMat", "wood_deck_grey"), s.get("newMat", "wood_grey"), "wood_sleeper"
    pt, pitch, pw, sz = 0.035, 0.155, 0.14, 0.2
    n = int(L / pitch)
    for i in range(n):
        x = R + (L - n * pitch) / 2 + pitch * (i + 0.5)
        g.box((x, 0, z - pt / 2 + r.uniform(-0.004, 0.004)), (pw, W, pt), pale if i < 3 or i >= n - 3 else deck, rz=r.uniform(-0.5, 0.5))
    for k in range(4):
        g.box((R + L / 2, -W / 2 + 0.15 + k * (W - 0.3) / 3, z - pt - sz / 2), (L - 0.1, 0.08, sz), sleeper)
    for d in (-1, 1):
        g.box((R + L / 2, d * (W / 2 - 0.02), z - pt - 0.11), (L, 0.04, 0.22), sleeper)
    rows = max(2, int(round(L / 3.0)) + 1)
    for k in range(rows):
        x = R + 0.25 + k * (L - 0.5) / (rows - 1)
        g.box((x, 0, z - pt - sz - 0.07), (0.12, W, 0.14), sleeper)
        for d in (-1, 1):
            g.pipe((x, d * (W / 2 - 0.2), z - s.get("pileDepth", 2.5)), (x, d * (W / 2 - 0.2), z - pt - sz), 0.1, sleeper, seg=8)
    # gangway: boards along the slope, its land end let 5 cm into the bank
    g.beam((-0.3, 0, -0.08), (R + 0.02, 0, z - 0.03), RW, 0.06, pale)
    for d in (-1, 1):
        g.beam((-0.3, d * (RW / 2 - 0.1), -0.2), (R, d * (RW / 2 - 0.1), z - 0.15), 0.08, 0.18, sleeper)


def marker_post(g, s):
    """Square post striped in bands from the top (the 14th's yellow/black post by the rope bridge, photo 83)."""
    H, w = s.get("height", 1.0), s.get("size", 0.1)
    bands = s.get("bands", ["sign_black", "sign_yellow"] * 3 + ["sign_black"])
    bh = H / len(bands)
    g.box((0, 0, -0.2), (w, w, 0.4), bands[-1])
    for i, m in enumerate(bands):
        g.box((0, 0, H - bh * (i + 0.5)), (w, w, bh), m)


def trolley_rack(g, s):
    L = s.get("length", 2.0)
    g.beam((-L / 2, 0, 0.9), (L / 2, 0, 0.9), 0.05, 0.05, "galvanised")
    for x in (-L / 2, L / 2):
        g.box((x, 0, 0.45), (0.05, 0.05, 0.9), "galvanised")


BUILDERS = {
    "building": building, "veranda": veranda, "steps": steps, "shelter": shelter, "gazebo": gazebo,
    "flagpole": flagpole, "bench": bench, "picnic_table": picnic_table, "bollard_light": bollard_light,
    "signpost": signpost, "hole_sign": hole_sign, "tee_sign": tee_sign, "plank_sign": plank_sign, "bin": bin_, "hedge": hedge, "rock_pile": rock_pile,
    "rock": rock, "boulder": boulder, "stones": stones, "drape": drape, "markings": markings, "range_mat": range_mat, "net_poles": net_poles, "target_flag": target_flag,
    "distance_board": distance_board, "banner": banner, "power_pole": power_pole, "car": car,
    "golf_cart": golf_cart, "car2": car2, "bridge_wood": bridge_wood, "bridge_brick": bridge_brick,
    "bridge_rope": bridge_rope, "stone_bridge": stone_bridge, "jetty": jetty, "marker_post": marker_post, "trolley_rack": trolley_rack,
}


def build_parts(g, parts):
    for p in parts:
        kind = p["kind"]
        m = Matrix.Translation(p.get("at", (0, 0, 0))) @ Matrix.Rotation(math.radians(p.get("rot", 0.0)), 4, "Z")
        g.push(m)
        if kind == "box":
            g.box(p.get("c", (0, 0, 0)), p["s"], p["mat"], rz=p.get("rz", 0.0), mats=p.get("mats"))
        elif kind == "beam":
            g.beam(p["a"], p["b"], p.get("w", 0.1), p.get("h", 0.1), p["mat"])
        elif kind == "cylinder":
            g.cylinder(p.get("c", (0, 0, 0)), p["r"], p["h"], p["mat"], seg=p.get("seg", 12), r_top=p.get("rTop"))
        elif kind == "railing":
            railing(g, p["pts"], p.get("h", 1.0), p.get("mat", "black_steel"))
        elif kind == "extrude":
            g.extrude(p["poly"], p.get("z0", 0), p["z1"], p["mat"], top=p.get("top"))
        else:
            BUILDERS[kind](g, p)
        g.pop()


# ---------------------------------------------------------------------------------------------
# Mesh output
# ---------------------------------------------------------------------------------------------


def to_object(g, name, table, tex_folder, collection):
    """One mesh object from the accumulated faces, with per-material metre UVs."""
    me = bpy.data.meshes.new(name)
    mats = []
    for _, m, _ in g.faces:
        if m not in mats:
            mats.append(m)
    me.from_pydata([tuple(v) for v in g.verts], [], [f for f, _, _ in g.faces])
    for m in mats:
        me.materials.append(blender_material(m, table, tex_folder))
    uvl = me.uv_layers.new(name="UVMap")
    for poly, (f, m, uvmode) in zip(me.polygons, g.faces):
        poly.material_index = mats.index(m)
        pts = [me.vertices[i].co for i in poly.vertices]
        n = poly.normal
        t = UP.cross(n)
        if t.length < 1e-3:
            t = Vector((1, 0, 0))
        t.normalize()
        b = n.cross(t).normalized()
        tu, tv = table[m]["tileU"], table[m]["tileV"]
        us = [p.dot(t) for p in pts]
        vs = [p.dot(b) for p in pts]
        if uvmode and uvmode[0] == "fit":
            u0, u1, v0, v1 = min(us), max(us), min(vs), max(vs)
            ru, rv = uvmode[1], uvmode[2]
            uv = [((u - u0) / max(u1 - u0, 1e-6) * ru, (v - v0) / max(v1 - v0, 1e-6) * rv) for u, v in zip(us, vs)]
        elif uvmode and uvmode[0] == "uv":  # per-vertex surface coordinates in metres (continuous across faces)
            uv = [(u / tu, v / tv) for u, v in uvmode[1]]
        else:
            uv = [(u / tu, v / tv) for u, v in zip(us, vs)]
        for li, (u, v) in zip(poly.loop_indices, uv):
            uvl.data[li].uv = (u, v)
    # weld coincident corners (UVs live on loops, so they survive), then smooth by angle so round
    # things (poles, wheels) shade round and boxes keep hard edges
    import bmesh
    bm = bmesh.new()
    bm.from_mesh(me)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=0.0005)
    bmesh.ops.dissolve_degenerate(bm, edges=bm.edges, dist=0.0001)
    bm.to_mesh(me)
    bm.free()
    me.validate(clean_customdata=False)
    me.shade_smooth()
    me.set_sharp_from_angle(angle=math.radians(40))
    me.update()
    ob = bpy.data.objects.new(name, me)
    collection.objects.link(ob)
    return ob
