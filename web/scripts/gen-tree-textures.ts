/**
 * Deterministic tree texture generator. Writes PNGs into web/public/trees/.
 * Run with cwd = web/:  bun scripts/gen-tree-textures.ts [--out public/trees] [--only broadleaf|conifer|bark|shadow]
 *
 * Everything is drawn procedurally (no downloads): thousands of layered leaf
 * and needle strokes with noise-driven colour variation, a bark heightfield
 * with a derived normal map, and a soft shadow decal. Outputs:
 *   broadleaf.png    1024x1024, 2x2 cells of leaf clusters (alpha)
 *   conifer.png      2048x2048, sixteen 512 px needle-cluster cells, eight spruce and eight pine
 *                    (layout in src/map/conifer-atlas.ts; alpha)
 *   bark.png         1024x1024, left half light (pine/birch-like), right half dark (spruce)
 *   bark-normal.png  1024x1024, tangent-space normals for bark.png
 *   shadow.png       256x256 radial shadow decal (alpha)
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { clusterCell, CONIFER_ATLAS_SIZE, CONIFER_CELLS, type AtlasRect } from '../src/map/conifer-atlas';

const outDir = resolve(process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : 'public/trees');
mkdirSync(outDir, { recursive: true });

// ---------- PNG encoder ----------
const crcTable = new Uint32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
});
function crc32(bytes: Uint8Array): number {
    let c = 0xffffffff;
    for (const b of bytes) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Uint8Array): Uint8Array {
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    out.set(type.split('').map(ch => ch.charCodeAt(0)), 4);
    out.set(data, 8);
    view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
}
function encodePng(width: number, height: number, rgba: Uint8Array): Uint8Array {
    const raw = new Uint8Array((width * 4 + 1) * height);
    for (let y = 0; y < height; y++) {
        raw[y * (width * 4 + 1)] = 0;
        raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
    }
    const header = new Uint8Array(13);
    const view = new DataView(header.buffer);
    view.setUint32(0, width); view.setUint32(4, height);
    header[8] = 8; header[9] = 6; header[10] = 0; header[11] = 0; header[12] = 0;
    const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
        chunk('IDAT', new Uint8Array(deflateSync(raw, { level: 9 }))), chunk('IEND', new Uint8Array(0))];
    const total = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const p of parts) { out.set(p, offset); offset += p.length; }
    return out;
}

// ---------- RNG and noise ----------
function rng(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
function hash2(x: number, y: number, seed: number): number {
    let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(seed | 0, 2147483647)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
const smooth = (t: number) => t * t * (3 - 2 * t);
/** Value noise, tileable with period `period` (in noise units) when given. */
function noise(x: number, y: number, seed: number, period = 0): number {
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const fx = smooth(x - x0), fy = smooth(y - y0);
    const wrap = (v: number) => period ? ((v % period) + period) % period : v;
    const v00 = hash2(wrap(x0), wrap(y0), seed), v10 = hash2(wrap(x0 + 1), wrap(y0), seed);
    const v01 = hash2(wrap(x0), wrap(y0 + 1), seed), v11 = hash2(wrap(x0 + 1), wrap(y0 + 1), seed);
    return (v00 * (1 - fx) + v10 * fx) * (1 - fy) + (v01 * (1 - fx) + v11 * fx) * fy;
}
function fbm(x: number, y: number, seed: number, octaves: number, period = 0): number {
    let sum = 0, amp = 0.5, total = 0, f = 1;
    for (let i = 0; i < octaves; i++) {
        sum += amp * noise(x * f, y * f, seed + i * 17, period * f);
        total += amp; amp *= 0.5; f *= 2;
    }
    return sum / total;
}

// ---------- Float canvas ----------
type Rgb = [number, number, number];
class Canvas {
    readonly data: Float32Array;
    /** Drawing is limited to this rect (PNG pixels) while set; keeps atlas cells from bleeding into neighbours. */
    clip: { x: number; y: number; w: number; h: number } | null = null;
    constructor(readonly width: number, readonly height: number) { this.data = new Float32Array(width * height * 4); }
    /** Alpha-composite a straight-alpha colour onto the pixel. */
    blend(x: number, y: number, r: number, g: number, b: number, a: number): void {
        if (x < 0 || y < 0 || x >= this.width || y >= this.height || a <= 0) return;
        const c = this.clip;
        if (c && (x < c.x || y < c.y || x >= c.x + c.w || y >= c.y + c.h)) return;
        const i = (y * this.width + x) * 4, d = this.data;
        const da = d[i + 3], oa = a + da * (1 - a);
        if (oa <= 0) return;
        d[i] = (r * a + d[i] * da * (1 - a)) / oa;
        d[i + 1] = (g * a + d[i + 1] * da * (1 - a)) / oa;
        d[i + 2] = (b * a + d[i + 2] * da * (1 - a)) / oa;
        d[i + 3] = oa;
    }
    /**
     * Fill a rotated leaf shape. `shape` in [0,1]: 0 = ellipse, 1 = pointed leaf.
     * `shade(u, v)` returns colour for local coordinates in [-1,1].
     */
    leaf(cx: number, cy: number, halfLength: number, halfWidth: number, angle: number, shape: number, shade: (u: number, v: number) => Rgb, alphaScale = 1): void {
        const cos = Math.cos(angle), sin = Math.sin(angle);
        const extent = Math.max(halfLength, halfWidth) + 1;
        const x0 = Math.max(0, Math.floor(cx - extent)), x1 = Math.min(this.width - 1, Math.ceil(cx + extent));
        const y0 = Math.max(0, Math.floor(cy - extent)), y1 = Math.min(this.height - 1, Math.ceil(cy + extent));
        for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
            const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
            const u = (dx * cos + dy * sin) / halfLength, v = (-dx * sin + dy * cos) / halfWidth;
            // Pointed shape: width profile narrows toward the tip (u -> +1) and base.
            const profile = shape > 0 ? (1 - shape) + shape * Math.max(0, 1 - Math.abs(u)) * 1.6 : 1;
            const dist = Math.hypot(u, v / Math.min(1, profile));
            const edge = Math.min(halfLength, halfWidth);
            const a = Math.min(1, Math.max(0, (1 - dist) * edge * 1.2)) * alphaScale;
            if (a <= 0.002) continue;
            const [r, g, b] = shade(u, v);
            this.blend(x, y, r, g, b, a);
        }
    }
    /** Soft-edged stroke segment with a width, colour from a callback of t in [0,1]. */
    stroke(x0: number, y0: number, x1: number, y1: number, width: number, shade: (t: number) => Rgb, alphaScale = 1): void {
        const length = Math.hypot(x1 - x0, y1 - y0);
        if (length < 0.01) return;
        const minX = Math.max(0, Math.floor(Math.min(x0, x1) - width)), maxX = Math.min(this.width - 1, Math.ceil(Math.max(x0, x1) + width));
        const minY = Math.max(0, Math.floor(Math.min(y0, y1) - width)), maxY = Math.min(this.height - 1, Math.ceil(Math.max(y0, y1) + width));
        const dx = (x1 - x0) / length, dy = (y1 - y0) / length;
        for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
            const px = x + 0.5 - x0, py = y + 0.5 - y0;
            const t = Math.max(0, Math.min(length, px * dx + py * dy));
            const dist = Math.hypot(px - t * dx, py - t * dy);
            const a = Math.min(1, Math.max(0, (width / 2 + 0.5 - dist))) * alphaScale;
            if (a <= 0.002) continue;
            const [r, g, b] = shade(t / length);
            this.blend(x, y, r, g, b, a);
        }
    }
    /** Push colour into transparent pixels so alpha-tested mips have no dark fringes. */
    dilate(passes: number): void {
        const { width, height, data } = this;
        const filled = new Uint8Array(width * height);
        for (let i = 0; i < width * height; i++) filled[i] = data[i * 4 + 3] > 0.02 ? 1 : 0;
        for (let pass = 0; pass < passes; pass++) {
            const next = new Uint8Array(filled);
            const copy = new Float32Array(data);
            for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
                const i = y * width + x;
                if (filled[i]) continue;
                let r = 0, g = 0, b = 0, n = 0;
                for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
                    const xx = x + ox, yy = y + oy;
                    if (xx < 0 || yy < 0 || xx >= width || yy >= height) continue;
                    const j = yy * width + xx;
                    if (!filled[j]) continue;
                    r += copy[j * 4]; g += copy[j * 4 + 1]; b += copy[j * 4 + 2]; n++;
                }
                if (n === 0) continue;
                data[i * 4] = r / n; data[i * 4 + 1] = g / n; data[i * 4 + 2] = b / n;
                next[i] = 1;
            }
            filled.set(next);
        }
        // Whatever is still empty takes the mean colour of the filled pixels.
        let r = 0, g = 0, b = 0, n = 0;
        for (let i = 0; i < width * height; i++) if (filled[i]) { r += data[i * 4]; g += data[i * 4 + 1]; b += data[i * 4 + 2]; n++; }
        if (n) for (let i = 0; i < width * height; i++) if (!filled[i]) { data[i * 4] = r / n; data[i * 4 + 1] = g / n; data[i * 4 + 2] = b / n; }
    }
    toPng(): Uint8Array {
        const bytes = new Uint8Array(this.width * this.height * 4);
        for (let i = 0; i < bytes.length; i++) bytes[i] = Math.round(Math.min(1, Math.max(0, this.data[i])) * 255);
        return encodePng(this.width, this.height, bytes);
    }
}

// ---------- Colour helpers ----------
function hsl(h: number, s: number, l: number): Rgb {
    const c = (1 - Math.abs(2 * l - 1)) * s, hp = ((h % 360) + 360) % 360 / 60, x = c * (1 - Math.abs(hp % 2 - 1)), m = l - c / 2;
    const [r, g, b] = hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x] : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x];
    return [r + m, g + m, b + m];
}
const mix = (a: Rgb, b: Rgb, t: number): Rgb => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const scale = (a: Rgb, k: number): Rgb => [a[0] * k, a[1] * k, a[2] * k];
// Light comes from the upper left of every cell; matches the sun on the left-hand cards well enough
// and the shader adds the real directional term on top.
const LIGHT = { x: -0.55, y: -0.75 };

// ---------- Broadleaf leaf clusters ----------
function drawLeafCluster(canvas: Canvas, ox: number, oy: number, size: number, seed: number): void {
    const random = rng(seed);
    const cx = ox + size / 2, cy = oy + size / 2;
    const clusterRadius = size * 0.44;
    const leafCount = 3400;
    const hueBase = 82 + random() * 18;
    // Two or three holes punched through the cluster so it never reads as a filled disc.
    const holes = Array.from({ length: 2 + Math.floor(random() * 2) }, () => {
        const a = random() * Math.PI * 2, r = clusterRadius * (0.2 + random() * 0.55);
        return { x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r, r: clusterRadius * (0.10 + random() * 0.12) };
    });
    type Leaf = { x: number; y: number; z: number; len: number; wid: number; angle: number; shape: number; hue: number; sat: number; light: number };
    const leaves: Leaf[] = [];
    // A few sub-clumps make the silhouette lumpy instead of a disc.
    const clumps = Array.from({ length: 4 + Math.floor(random() * 3) }, () => {
        const a = random() * Math.PI * 2, r = clusterRadius * (0.2 + random() * 0.55);
        return { x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r, r: clusterRadius * (0.28 + random() * 0.3), stretch: 1.2 + random() * 0.8, dir: random() * Math.PI };
    });
    for (let i = 0; i < leafCount; i++) {
        const clump = clumps[Math.floor(random() * clumps.length)];
        // Gaussian-ish radial density within the clump, clipped to the cell.
        const a = random() * Math.PI * 2, r = clump.r * Math.sqrt(random()) * (0.75 + 0.5 * random());
        // Elongated clumps: stretch along the clump's own axis.
        const lx = Math.cos(a) * r * clump.stretch, ly = Math.sin(a) * r;
        const x = clump.x + Math.cos(clump.dir) * lx - Math.sin(clump.dir) * ly, y = clump.y + Math.sin(clump.dir) * lx + Math.cos(clump.dir) * ly;
        const dc = Math.hypot(x - cx, y - cy) / clusterRadius;
        if (dc > 1.08) continue;
        if (holes.some(hole => Math.hypot(x - hole.x, y - hole.y) < hole.r * (0.8 + 0.4 * random()))) continue;
        // Fake sphere depth: leaves near the rim tend to be further back (darker).
        const z = Math.sqrt(Math.max(0, 1 - dc * dc)) * (0.4 + 0.6 * random()) + random() * 0.25;
        const scaleLeaf = size / 512;
        const sizeJitter = 0.55 + random() * random() * 1.1;
        leaves.push({ x, y, z, len: (6 + random() * 6) * sizeJitter * scaleLeaf, wid: (3.5 + random() * 3.5) * sizeJitter * scaleLeaf, angle: random() * Math.PI * 2,
            shape: 0.5 + random() * 0.5, hue: hueBase + (random() - 0.5) * 22, sat: 0.30 + random() * 0.20, light: 0.22 + random() * 0.18 });
    }
    // Rim twigs: short sprigs of leaves poking out of the silhouette so the edge is ragged, not blobby.
    const twigs = 26 + Math.floor(random() * 10);
    for (let t = 0; t < twigs; t++) {
        const a = random() * Math.PI * 2, r0 = clusterRadius * (0.7 + random() * 0.25), length = clusterRadius * (0.12 + random() * 0.18);
        const perLeaf = 5 + Math.floor(random() * 6);
        for (let k = 0; k < perLeaf; k++) {
            const along = r0 + (k / perLeaf) * length;
            const x = cx + Math.cos(a) * along + (random() - 0.5) * 8 * (size / 512), y = cy + Math.sin(a) * along + (random() - 0.5) * 8 * (size / 512);
            if (Math.hypot(x - cx, y - cy) > size * 0.49) continue;
            const scaleLeaf = size / 512;
            leaves.push({ x, y, z: 0.55 + random() * 0.45, len: (5 + random() * 5) * scaleLeaf, wid: (3 + random() * 3) * scaleLeaf, angle: a + (random() - 0.5) * 1.4,
                shape: 0.6 + random() * 0.4, hue: hueBase + (random() - 0.5) * 18, sat: 0.32 + random() * 0.2, light: 0.24 + random() * 0.18 });
        }
    }
    leaves.sort((a, b) => a.z - b.z);
    for (const leaf of leaves) {
        // Depth darkening and a rim occlusion term.
        const depthLight = 0.30 + 0.70 * Math.min(1, leaf.z);
        const rimShade = 0.75 + 0.25 * (1 - Math.min(1, Math.hypot(leaf.x - cx, leaf.y - cy) / clusterRadius));
        const nx = (leaf.x - cx) / clusterRadius, ny = (leaf.y - cy) / clusterRadius;
        const sphereLight = Math.max(0, -(nx * LIGHT.x + ny * LIGHT.y) * 0.5 + 0.5);
        const base = hsl(leaf.hue, leaf.sat, leaf.light * depthLight * rimShade * (0.7 + 0.5 * sphereLight));
        const highlight = hsl(leaf.hue - 10, leaf.sat + 0.1, Math.min(0.62, leaf.light * 1.5));
        const dark = scale(base, 0.55);
        canvas.leaf(leaf.x, leaf.y, leaf.len, leaf.wid, leaf.angle, leaf.shape, (u, v) => {
            // Along-leaf gradient toward the light plus a translucent highlight on the sunny half.
            const lightDot = (Math.cos(leaf.angle) * u * LIGHT.x + Math.sin(leaf.angle) * u * LIGHT.y) * -1;
            const vein = Math.abs(v) < 0.09 ? 0.75 : 1;
            const t = Math.max(0, Math.min(1, 0.5 + lightDot * 0.6 + (leaf.z - 0.5) * 0.4));
            const spec = Math.pow(Math.max(0, lightDot), 3) * leaf.z * 0.45;
            return scale(mix(mix(dark, base, t), highlight, spec), vein);
        });
    }
}

function generateBroadleaf(): void {
    const canvas = new Canvas(1024, 1024);
    let seed = 101;
    for (let row = 0; row < 2; row++) for (let col = 0; col < 2; col++) drawLeafCluster(canvas, col * 512, row * 512, 512, seed++);
    canvas.dilate(10);
    writeFileSync(resolve(outDir, 'broadleaf.png'), canvas.toPng());
}

// ---------- Conifer needle palette ----------
const SPRUCE_DARK: Rgb = [0x22 / 255, 0x3c / 255, 0x33 / 255];
const SPRUCE_LIGHT: Rgb = [0x40 / 255, 0x66 / 255, 0x46 / 255];
const SPRUCE_TIP: Rgb = [0x74 / 255, 0x9c / 255, 0x58 / 255];
const PINE_DARK: Rgb = [0x28 / 255, 0x42 / 255, 0x36 / 255];
const PINE_LIGHT: Rgb = [0x4c / 255, 0x70 / 255, 0x47 / 255];
const PINE_TIP: Rgb = [0x9a / 255, 0xb6 / 255, 0x5c / 255];
const SPRUCE_WOOD: Rgb = [0.12, 0.09, 0.06];
const PINE_WOOD_DARK: Rgb = [0.22, 0.15, 0.08];

interface Needles {
    random: () => number;
    dark: Rgb; light: Rgb; tip: Rgb;
    /** Whole-branch brightness (back branches in a profile sit at 0.5). */
    shade: number;
}
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** One needle colour: dark-to-light blend with per-stroke lightness and hue jitter, optional new-growth tip. */
function needleColor(p: Needles, t: number, tipness = 0): Rgb {
    const j = (p.random() - 0.5) * 0.16;
    let c = mix(p.dark, p.light, clamp01(t + j));
    if (tipness > 0) c = mix(c, p.tip, tipness);
    const hue = (p.random() - 0.5) * 0.04;
    return scale([c[0] + hue, c[1], c[2] - hue], p.shade);
}

function needle(canvas: Canvas, p: Needles, x: number, y: number, angle: number, length: number, t: number, tipness = 0, alpha = 0.9): void {
    const color = needleColor(p, t, tipness);
    canvas.stroke(x, y, x + Math.cos(angle) * length, y + Math.sin(angle) * length, 1.15, () => color, alpha);
}

interface Polyline { pts: [number, number][]; at: (t: number) => [number, number] }
function polyline(pts: [number, number][]): Polyline {
    const steps = pts.length - 1;
    return {
        pts,
        at: t => {
            const idx = Math.min(steps - 1, Math.max(0, Math.floor(t * steps))), frac = t * steps - idx;
            return [pts[idx][0] + (pts[idx + 1][0] - pts[idx][0]) * frac, pts[idx][1] + (pts[idx + 1][1] - pts[idx][1]) * frac];
        },
    };
}

/**
 * A short needled twig from (x0, y0) in direction `angle`, curving by `bend` radians over its
 * length. Needles sit dense on both sides, 3 to 6 px at scale 1, pointing forward; the
 * last fifth gets the light new-growth tip colour. Returns the twig end point.
 */
function drawNeedleTwig(canvas: Canvas, p: Needles, x0: number, y0: number, angle: number, length: number, bend: number, scale: number,
    o: { t0: number; t1: number; wood?: Rgb; density?: number; needleLength?: number; spread?: number }): [number, number] {
    const { random } = p;
    const steps = 8;
    const pts: [number, number][] = [];
    for (let s = 0; s <= steps; s++) {
        const u = s / steps, a = angle + bend * u;
        const prev = pts[s - 1] ?? [x0, y0];
        pts.push(s === 0 ? [x0, y0] : [prev[0] + Math.cos(a) * length / steps, prev[1] + Math.sin(a) * length / steps]);
    }
    const twig = polyline(pts);
    if (o.wood) for (let s = 0; s < steps; s++) canvas.stroke(pts[s][0], pts[s][1], pts[s + 1][0], pts[s + 1][1], (0.9 - 0.5 * s / steps) * scale + 0.3, () => o.wood!, 0.85);
    const count = Math.round(length * (o.density ?? 2.4) / scale) + 4;
    const spread = o.spread ?? 1.0;
    for (let n = 0; n < count; n++) {
        const u = random();
        const [nx, ny] = twig.at(u);
        const side = random() < 0.5 ? -1 : 1;
        const a = angle + bend * u + side * (0.35 + random() * spread) * (0.6 + 0.4 * (1 - u));
        const nl = (o.needleLength ?? 3.2) * (0.75 + random() * 0.6) * scale;
        const tipness = u > 0.8 ? 0.2 + 0.3 * (u - 0.8) / 0.2 : 0;
        needle(canvas, p, nx, ny, a, nl, o.t0 + (o.t1 - o.t0) * u + (side > 0 ? 0.06 : -0.04), tipness);
    }
    // Tip fan past the end.
    const [tx, ty] = pts[steps];
    for (let n = 0; n < 8; n++) needle(canvas, p, tx, ty, angle + bend + (random() - 0.5) * 1.4, (4 + random() * 3) * scale, o.t1, 0.3 + random() * 0.3);
    return [tx, ty];
}

/**
 * Spruce needle cluster: a hint of wood at the centre, then 7 to 10 short twigs radiating
 * outward, most of them sideways or downward, each buried in short needles with branchlets
 * hanging from it. Back twigs are drawn first and darker so the cluster has depth.
 */
function drawSpruceCluster(canvas: Canvas, rect: AtlasRect, seed: number): void {
    const random = rng(seed);
    const p: Needles = { random, dark: SPRUCE_DARK, light: SPRUCE_LIGHT, tip: SPRUCE_TIP, shade: 1 };
    const size = rect.w, scale = size / 512;
    const cx = rect.x + size * 0.5, cy = rect.y + size * (0.42 + random() * 0.05);
    const reach = size * 0.42;
    const twigOpts = { wood: SPRUCE_WOOD, density: 7, needleLength: 8, spread: 1.0 };
    type Twig = { angle: number; length: number; shade: number; bend: number };
    const twigs: Twig[] = [];
    const count = 11 + Math.floor(random() * 4);
    for (let k = 0; k < count; k++) {
        // Angles in screen space (y down): spread around the circle but longer in the lower half.
        const a = (k + random() * 0.8) / count * Math.PI * 2;
        const down = Math.sin(a); // +1 straight down
        const length = reach * (0.5 + 0.4 * (down * 0.5 + 0.5)) * (0.8 + random() * 0.3);
        twigs.push({ angle: a, length, shade: 0.5 + random() * 0.5, bend: (down < 0 ? 0.7 : 0.3) * Math.sign(Math.cos(a) || 1) * (random() * 0.8 + 0.2) });
    }
    twigs.sort((a, b) => a.shade - b.shade);
    // Wood hint: short dark stubs from the centre along each twig root.
    for (const twig of twigs) canvas.stroke(cx, cy, cx + Math.cos(twig.angle) * size * 0.05, cy + Math.sin(twig.angle) * size * 0.05, 2.4 * scale, () => SPRUCE_WOOD, 0.9);
    for (const twig of twigs) {
        const local: Needles = { ...p, shade: twig.shade };
        const at = (u: number): [number, number] => [cx + Math.cos(twig.angle + twig.bend * u * 0.5) * twig.length * u, cy + Math.sin(twig.angle + twig.bend * u * 0.5) * twig.length * u];
        // Side branchlets, then hanging branchlets, then the twig itself on top.
        const sides = Math.round(twig.length / (14 * scale));
        for (let h = 0; h < sides; h++) {
            const u = 0.2 + (h + random()) / sides * 0.75;
            const [bx, by] = at(u);
            const side = random() < 0.5 ? -1 : 1;
            const len = twig.length * (0.15 + random() * 0.25) * (1 - u * 0.5);
            drawNeedleTwig(canvas, { ...local, shade: twig.shade * (0.85 + random() * 0.15) }, bx, by, twig.angle + twig.bend * u + side * (0.5 + random() * 0.5), len, side * 0.3, scale,
                { ...twigOpts, t0: 0.15 + 0.3 * u, t1: 0.5 + 0.3 * u, density: 6 });
        }
        const hangers = Math.round(twig.length / (11 * scale));
        for (let h = 0; h < hangers; h++) {
            if (random() < 0.15) continue;
            const u = 0.12 + (h + random() * 0.8) / hangers * 0.85;
            const [bx, by] = at(u);
            const hang = twig.length * (0.25 + random() * 0.4) * Math.sin(Math.PI * Math.min(1, u / 0.98));
            if (hang < 6 * scale) continue;
            drawNeedleTwig(canvas, { ...local, shade: twig.shade * (0.8 + random() * 0.2) }, bx, by, Math.PI / 2 + (random() - 0.5) * 0.7, hang, (random() - 0.5) * 0.5, scale,
                { ...twigOpts, t0: 0.15 + 0.3 * u, t1: 0.55 + 0.25 * u, density: 6, needleLength: 7 });
        }
        drawNeedleTwig(canvas, local, cx, cy, twig.angle, twig.length, twig.bend, scale, { ...twigOpts, t0: 0.2, t1: 0.75 });
    }
    // Fill the middle with short upright shoots so the centre is not a bare hub.
    for (let k = 0; k < 10; k++) {
        const a = random() * Math.PI * 2, r = size * 0.06 * random();
        drawNeedleTwig(canvas, { ...p, shade: 0.7 + random() * 0.3 }, cx + Math.cos(a) * r, cy + Math.sin(a) * r, -Math.PI / 2 + (random() - 0.5) * 2.4, size * (0.08 + random() * 0.1), (random() - 0.5) * 0.6, scale,
            { ...twigOpts, t0: 0.35, t1: 0.8, density: 6 });
    }
}

/** A pine needle brush: several overlapping fans of long needles around a centre, bud at the middle. */
function drawPineTuft(canvas: Canvas, p: Needles, cx: number, cy: number, centre: number, radius: number, t: number, scale: number): void {
    const { random } = p;
    const fans = 3 + Math.floor(random() * 3);
    for (let f = 0; f < fans; f++) {
        const fx = cx + (random() - 0.5) * radius * 0.9, fy = cy + (random() - 0.5) * radius * 0.7;
        const fc = centre + (random() - 0.5) * 1.6;
        const count = Math.round(radius * 3.2);
        const local: Needles = { ...p, shade: p.shade * (0.75 + random() * 0.3) };
        for (let n = 0; n < count; n++) {
            const angle = random() < 0.2 ? random() * Math.PI * 2 : fc + (random() - 0.5) * 2.2;
            const nl = radius * (0.5 + random() * 0.55);
            const up = Math.sin(angle) < 0 ? 0.15 : -0.08;
            needle(canvas, local, fx, fy, angle, nl, t + up + random() * 0.3, random() < 0.1 ? 0.45 : 0, 0.88);
        }
        canvas.leaf(fx, fy, 1.6 * scale + 0.6, 1.2 * scale + 0.4, 0, 0, () => [0.24, 0.16, 0.09]);
    }
}

/**
 * Pine needle cluster: a hint of wood at the centre, four to six thin bare twigs radiating
 * from it (biased upward), each ending in a tufted brush of long needles, plus brushes around
 * the centre so the middle is filled. Back brushes are darker.
 */
function drawPineCluster(canvas: Canvas, rect: AtlasRect, seed: number): void {
    const random = rng(seed);
    const p: Needles = { random, dark: PINE_DARK, light: PINE_LIGHT, tip: PINE_TIP, shade: 1 };
    const size = rect.w, scale = size / 512;
    const cx = rect.x + size * 0.5, cy = rect.y + size * (0.50 + random() * 0.06);
    type Tuft = { x: number; y: number; angle: number; radius: number; shade: number; t: number; twig?: [number, number] };
    const tufts: Tuft[] = [];
    const twigCount = 4 + Math.floor(random() * 3);
    for (let k = 0; k < twigCount; k++) {
        // Up-biased: angles in the upper two thirds of the circle (screen y down).
        const a = -Math.PI * 0.85 + (k + random() * 0.8) / twigCount * Math.PI * 1.7 + (random() < 0.5 ? 0 : Math.PI * 0.1);
        const length = size * (0.14 + random() * 0.14);
        const ex = cx + Math.cos(a) * length, ey = cy + Math.sin(a) * length;
        tufts.push({ x: ex, y: ey, angle: a, radius: size * (0.11 + random() * 0.05), shade: 0.6 + random() * 0.4, t: 0.35 + 0.3 * random(), twig: [cx, cy] });
    }
    for (let k = 0; k < 3 + Math.floor(random() * 2); k++) {
        const a = random() * Math.PI * 2, r = size * (0.04 + random() * 0.08);
        tufts.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r, angle: a, radius: size * (0.10 + random() * 0.05), shade: 0.5 + random() * 0.35, t: 0.25 + 0.25 * random() });
    }
    tufts.sort((a, b) => a.shade - b.shade);
    canvas.leaf(cx, cy, 5 * scale, 3 * scale, 0, 0, () => PINE_WOOD_DARK, 0.9);
    for (const tuft of tufts) {
        if (tuft.twig) canvas.stroke(tuft.twig[0], tuft.twig[1], tuft.x, tuft.y, 1.6 * scale + 0.3, () => PINE_WOOD_DARK, 0.9);
        drawPineTuft(canvas, { ...p, shade: tuft.shade }, tuft.x, tuft.y, tuft.angle, tuft.radius, tuft.t, scale);
    }
}

/** Alpha falls to zero toward the cell border along a ragged radius, so no card ever shows a straight cut. */
function applyRadialFalloff(canvas: Canvas, rect: AtlasRect, cx: number, cy: number, seed: number): void {
    const size = rect.w;
    for (let y = rect.y; y < rect.y + rect.h; y++) for (let x = rect.x; x < rect.x + rect.w; x++) {
        const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
        const r = Math.hypot(dx, dy) / (size * 0.5);
        const angle = Math.atan2(dy, dx);
        const ragged = 0.86 + 0.16 * (fbm(Math.cos(angle) * 3 + 10, Math.sin(angle) * 3 + 10, seed, 2) - 0.5) * 2;
        const k = 1 - smooth(Math.min(1, Math.max(0, (r - ragged + 0.3) / 0.3)));
        if (k < 1) canvas.data[(y * canvas.width + x) * 4 + 3] *= k;
    }
}

function generateConifer(): void {
    const canvas = new Canvas(CONIFER_ATLAS_SIZE, CONIFER_ATLAS_SIZE);
    for (let i = 0; i < CONIFER_CELLS; i++) {
        for (const species of ['spruce', 'pine'] as const) {
            const rect = clusterCell(species, i);
            const seed = (species === 'spruce' ? 201 : 301) + i;
            canvas.clip = rect;
            if (species === 'spruce') drawSpruceCluster(canvas, rect, seed); else drawPineCluster(canvas, rect, seed);
            canvas.clip = null;
            applyRadialFalloff(canvas, rect, rect.x + rect.w / 2, rect.y + rect.h * 0.5, seed);
        }
    }
    canvas.dilate(10);
    writeFileSync(resolve(outDir, 'conifer.png'), canvas.toPng());
}

// ---------- Bark with normal map ----------
function generateBark(): void {
    const width = 1024, height = 1024;
    const color = new Canvas(width, height), normal = new Canvas(width, height);
    const heightField = new Float32Array(width * height);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const dark = x >= width / 2;
        const lx = dark ? x - width / 2 : x;
        // Fissures: vertically stretched noise (x scaled up, y down), ridged, tileable in y.
        const u = lx / (width / 2), v = y / height;
        // Two fissure scales: long primary cracks and a finer network between them. y wraps below.
        const fiss = fbm(u * 26, v * 5, dark ? 71 : 11, 4, 0);
        const fiss2 = fbm(u * 60, v * 14, dark ? 76 : 17, 3, 0);
        const fine = fbm(u * 120, v * 160, dark ? 72 : 12, 3, 0);
        const plates = fbm(u * 12, v * 48, dark ? 73 : 13, 4, 0);
        const ridge = 1 - Math.abs(fiss * 2 - 1), ridge2 = 1 - Math.abs(fiss2 * 2 - 1);
        // Height: deep, narrow vertical cracks over a plate texture.
        const crack = Math.pow(ridge, dark ? 9 : 12) + 0.5 * Math.pow(ridge2, 14);
        let h = 0.55 + 0.25 * (plates - 0.5) - 0.6 * Math.min(1, crack) + 0.18 * (fine - 0.5);
        if (dark) h = 0.5 + 0.3 * (plates - 0.5) - 0.5 * Math.min(1, crack) + 0.22 * (fine - 0.5) + 0.1 * (fbm(u * 6, v * 80, 74, 2) - 0.5);
        heightField[y * width + x] = h;
    }
    // Make the field tile vertically by blending the seam.
    for (let y = 0; y < 24; y++) for (let x = 0; x < width; x++) {
        const t = y / 24;
        const top = heightField[y * width + x], bottom = heightField[(height - 24 + y) * width + x];
        heightField[y * width + x] = top * (0.5 + 0.5 * t) + bottom * (0.5 - 0.5 * t);
    }
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const dark = x >= width / 2;
        const h = heightField[y * width + x];
        const i = (y * width + x) * 4;
        const u = (dark ? x - width / 2 : x) / (width / 2), v = y / height;
        const tint = fbm(u * 10, v * 14, dark ? 75 : 15, 3);
        let rgb: Rgb;
        if (!dark) {
            // Light pine/birch-like: grey-brown plates, orange in the fissures, pale lichen patches.
            const plate = hsl(28 + tint * 12, 0.18 + 0.1 * tint, 0.30 + 0.22 * h);
            const crackColor = hsl(20, 0.35, 0.16);
            const lichen = hsl(95, 0.12, 0.55);
            rgb = mix(crackColor, plate, Math.min(1, Math.max(0, (h - 0.15) / 0.5)));
            rgb = mix(rgb, lichen, Math.max(0, fbm(u * 18, v * 18, 16, 3) - 0.6) * 2.5 * (h > 0.5 ? 1 : 0));
        } else {
            const plate = hsl(18 + tint * 10, 0.16, 0.16 + 0.16 * h);
            const crackColor = hsl(15, 0.2, 0.06);
            rgb = mix(crackColor, plate, Math.min(1, Math.max(0, (h - 0.1) / 0.5)));
        }
        color.data[i] = rgb[0]; color.data[i + 1] = rgb[1]; color.data[i + 2] = rgb[2]; color.data[i + 3] = 1;
        // Normal from finite differences, y wrapped, x clamped inside each half.
        const half = dark ? width / 2 : 0;
        const xl = Math.max(half, x - 1), xr = Math.min(half + width / 2 - 1, x + 1);
        const dhdx = (heightField[y * width + xr] - heightField[y * width + xl]) * 0.5;
        const dhdy = (heightField[((y + 1) % height) * width + x] - heightField[((y - 1 + height) % height) * width + x]) * 0.5;
        const strength = 22;
        const nx = -dhdx * strength, ny = -dhdy * strength, nz = 1;
        const len = Math.hypot(nx, ny, nz);
        normal.data[i] = nx / len * 0.5 + 0.5; normal.data[i + 1] = ny / len * 0.5 + 0.5; normal.data[i + 2] = nz / len * 0.5 + 0.5; normal.data[i + 3] = 1;
    }
    writeFileSync(resolve(outDir, 'bark.png'), color.toPng());
    writeFileSync(resolve(outDir, 'bark-normal.png'), normal.toPng());
}

// ---------- Shadow decal ----------
function generateShadow(): void {
    const size = 256;
    const canvas = new Canvas(size, size);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        const dx = (x + 0.5) / size * 2 - 1, dy = (y + 0.5) / size * 2 - 1;
        const d = Math.hypot(dx, dy);
        const soft = 1 - smooth(Math.min(1, Math.max(0, (d - 0.35) / 0.65)));
        const i = (y * size + x) * 4;
        canvas.data[i] = 0.04; canvas.data[i + 1] = 0.06; canvas.data[i + 2] = 0.03;
        canvas.data[i + 3] = soft * (0.85 + 0.15 * fbm(x / 24, y / 24, 5, 2));
    }
    writeFileSync(resolve(outDir, 'shadow.png'), canvas.toPng());
}

const started = performance.now();
const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
if (!only || only === 'broadleaf') generateBroadleaf();
if (!only || only === 'conifer') generateConifer();
if (!only || only === 'bark') generateBark();
if (!only || only === 'shadow') generateShadow();
console.log(`tree textures written to ${outDir} in ${((performance.now() - started) / 1000).toFixed(1)} s`);
