// Clone-stamp brush engine — the CLIENT-SIDE mirror of the authoritative
// renderer in pipeline/golfpipe/stamp.py. Pure math over flat RGBA buffers
// (no canvas, no DOM) so it runs under bun test and paints the live LOCAL
// preview by cloning served-tile pixels on the preview surface.
//
// Preview fidelity: the bake re-executes the same stroke server-side against
// SOURCE-raster pixels (EPSG:3006 grid), while this preview clones from
// WebP-lossy, mercator-resampled tile pixels — visually near-identical, and
// the bake is seam-free BY CONSTRUCTION (clone source and destination share
// raster provenance), so the preview/bake delta is tone-level noise only.
//
// Semantics (must stay in lockstep with golfpipe/stamp.py):
//   size     brush DIAMETER (ground metres; px here).
//   hardness fully-opaque core fraction of the radius; raised-cosine feather
//            from there to the rim.
//   flow     per-dab alpha; dabs composite over each other along the path
//            (a += dab·(1−a)) and flow also sets DAB SPACING.
//   opacity  scales the whole accumulated stroke alpha (a cap — no pixel of
//            one stroke exceeds it).
//   tone-match  shift the clone's mean RGB (over the painted region) to the
//            destination region's mean before compositing — texture kept,
//            tone blended.
//
// The stroke reads source AND destination from a SNAPSHOT taken before the
// stroke composites (no mid-stroke feedback) — same as the bake.

/** Dab spacing at flow=1, as a fraction of the brush diameter. */
export const DAB_SPACING_FRACTION = 0.25;
/** Flow below this is treated as this. */
export const MIN_FLOW = 0.05;
/** Spacing never exceeds this many diameters. */
export const MAX_SPACING_DIAMETERS = 2;

export interface StampBrushParams {
    /** Brush DIAMETER in ground metres. */
    sizeM: number;
    opacity: number;
    flow: number;
    hardness: number;
}

export interface PxPoint {
    x: number;
    y: number;
}

/** Distance between successive dab centers along the path, in px —
 * higher flow → denser dabs. Mirrors golfpipe.stamp.dab_spacing_px. */
export function dabSpacingPx(diameterPx: number, flow: number): number {
    const f = Math.max(flow, MIN_FLOW);
    const spacing = (diameterPx * DAB_SPACING_FRACTION) / f;
    return Math.min(Math.max(spacing, 1), diameterPx * MAX_SPACING_DIAMETERS);
}

/** Dab centers spaced `spacingPx` along a polyline. First point always gets
 * a dab; the endpoint gets one when it sits more than half a spacing past
 * the last emitted dab. Mirrors golfpipe.stamp.dab_centers. */
export function dabCenters(path: PxPoint[], spacingPx: number): PxPoint[] {
    if (path.length === 0) return [];
    const centers: PxPoint[] = [{ ...path[0] }];
    let carried = 0;
    for (let i = 0; i + 1 < path.length; i++) {
        const a = path[i];
        const b = path[i + 1];
        const segLen = Math.hypot(b.x - a.x, b.y - a.y);
        if (segLen === 0) continue;
        let t = spacingPx - carried;
        while (t <= segLen) {
            const k = t / segLen;
            centers.push({ x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k });
            t += spacingPx;
        }
        carried = segLen - (t - spacingPx);
    }
    const last = path[path.length - 1];
    const tail = centers[centers.length - 1];
    if (Math.hypot(last.x - tail.x, last.y - tail.y) > spacingPx * 0.5) {
        centers.push({ ...last });
    }
    return centers;
}

/** Feathered dab alpha at distance `d` from the center: 1 inside
 * hardness·radius, raised-cosine falloff to 0 at the rim. */
export function dabAlphaAt(d: number, radiusPx: number, hardness: number): number {
    if (d > radiusPx) return 0;
    const h = Math.min(Math.max(hardness, 0), 1);
    if (h >= 1 || radiusPx <= 0) return d <= radiusPx ? 1 : 0;
    const core = h * radiusPx;
    if (d <= core) return 1;
    const t = Math.min((d - core) / Math.max(radiusPx - core, 1e-9), 1);
    return 0.5 * (1 + Math.cos(Math.PI * t));
}

export interface StampStrokePx {
    /** Dest polyline in surface pixels. */
    path: PxPoint[];
    /** Integer source offset in surface pixels (source = dest + offset). */
    offsetPx: { dx: number; dy: number };
    radiusPx: number;
    opacity: number;
    flow: number;
    hardness: number;
    toneMatch: boolean;
}

/**
 * Composites one clone-stamp stroke IN PLACE into `data` (flat RGBA,
 * size×size). Source and destination reads come from a snapshot of the
 * surface taken at call time; pixels whose shifted source falls outside the
 * surface are left untouched. Only the stroke's bbox window is visited.
 */
export function renderStampStroke(data: Uint8ClampedArray, size: number, stroke: StampStrokePx): void {
    const { path, offsetPx, radiusPx, hardness, toneMatch } = stroke;
    if (path.length === 0 || radiusPx <= 0) return;
    const flow = Math.max(stroke.flow, MIN_FLOW);
    const opacity = Math.min(Math.max(stroke.opacity, 0), 1);
    if (opacity <= 0) return;

    const pad = Math.ceil(radiusPx) + 2;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of path) {
        minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
        minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    }
    const x0 = Math.max(0, Math.floor(minX) - pad);
    const x1 = Math.min(size, Math.ceil(maxX) + pad);
    const y0 = Math.max(0, Math.floor(minY) - pad);
    const y1 = Math.min(size, Math.ceil(maxY) + pad);
    if (x1 <= x0 || y1 <= y0) return;
    const ww = x1 - x0;
    const wh = y1 - y0;

    // Accumulate the stroke alpha over the window: a += dab·(1−a).
    const alpha = new Float32Array(ww * wh);
    const spacing = dabSpacingPx(radiusPx * 2, stroke.flow);
    const r = Math.ceil(radiusPx) + 1;
    for (const c of dabCenters(path, spacing)) {
        const cx0 = Math.max(x0, Math.floor(c.x) - r);
        const cx1 = Math.min(x1, Math.ceil(c.x) + r + 1);
        const cy0 = Math.max(y0, Math.floor(c.y) - r);
        const cy1 = Math.min(y1, Math.ceil(c.y) + r + 1);
        for (let y = cy0; y < cy1; y++) {
            for (let x = cx0; x < cx1; x++) {
                const d = Math.hypot(x + 0.5 - c.x, y + 0.5 - c.y);
                const a = flow * dabAlphaAt(d, radiusPx, hardness);
                if (a <= 0) continue;
                const i = (y - y0) * ww + (x - x0);
                alpha[i] += a * (1 - alpha[i]);
            }
        }
    }

    // Snapshot: source AND destination read pre-stroke pixels.
    const snapshot = data.slice();
    const dx = Math.round(offsetPx.dx);
    const dy = Math.round(offsetPx.dy);

    // Tone-match statistics over the painted region (valid-source only).
    let dr = 0, dg = 0, db = 0, sr = 0, sg = 0, sb = 0, n = 0;
    if (toneMatch) {
        for (let y = y0; y < y1; y++) {
            for (let x = x0; x < x1; x++) {
                if (alpha[(y - y0) * ww + (x - x0)] <= 0) continue;
                const sx = x + dx, sy = y + dy;
                if (sx < 0 || sy < 0 || sx >= size || sy >= size) continue;
                const di = (y * size + x) * 4;
                const si = (sy * size + sx) * 4;
                dr += snapshot[di]; dg += snapshot[di + 1]; db += snapshot[di + 2];
                sr += snapshot[si]; sg += snapshot[si + 1]; sb += snapshot[si + 2];
                n++;
            }
        }
    }
    const shiftR = n > 0 ? (dr - sr) / n : 0;
    const shiftG = n > 0 ? (dg - sg) / n : 0;
    const shiftB = n > 0 ? (db - sb) / n : 0;

    for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
            const a = alpha[(y - y0) * ww + (x - x0)] * opacity;
            if (a <= 0) continue;
            const sx = x + dx, sy = y + dy;
            if (sx < 0 || sy < 0 || sx >= size || sy >= size) continue; // no source — untouched
            const di = (y * size + x) * 4;
            const si = (sy * size + sx) * 4;
            const cr = Math.min(255, Math.max(0, snapshot[si] + shiftR));
            const cg = Math.min(255, Math.max(0, snapshot[si + 1] + shiftG));
            const cb = Math.min(255, Math.max(0, snapshot[si + 2] + shiftB));
            data[di] = Math.round(snapshot[di] * (1 - a) + cr * a);
            data[di + 1] = Math.round(snapshot[di + 1] * (1 - a) + cg * a);
            data[di + 2] = Math.round(snapshot[di + 2] * (1 - a) + cb * a);
            data[di + 3] = 255;
        }
    }
}

/** Axis-aligned pixel rectangle, half-open: [x0, x1) x [y0, y1). */
export interface PxRect {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
}

function unionRect(a: PxRect | null, b: PxRect | null): PxRect | null {
    if (!a) return b;
    if (!b) return a;
    return { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) };
}

/**
 * The live form of renderStampStroke: the stroke grows point by point and
 * `flush()` paints only what changed since the last flush into `out`.
 *
 * After any flush, `out` equals `base` with renderStampStroke(path so far)
 * applied, byte for byte. That holds because:
 * - Dab centers come from the same carried-distance walk as dabCenters. The
 *   interior dabs of a path are a prefix of the dabs of any extension of it.
 *   Only the endpoint dab is provisional: it is painted on top for the flush
 *   and its alpha window is restored afterwards.
 * - The stroke alpha accumulates per dab in the same order and the same
 *   float32 buffer arithmetic (a += dab * (1 - a)).
 * - Tone-match sums are integer sums over pixels whose alpha is above zero,
 *   so they do not depend on visit order.
 * - Source and destination always read `base`, the pre-stroke snapshot.
 *
 * With tone-match on, a flush that moves the mean shift re-composites the
 * whole painted rectangle; otherwise only the new dab windows and the old
 * and new endpoint windows.
 */
export class IncrementalStampStroke {
    private readonly alpha: Float32Array;
    private readonly flow: number;
    private readonly opacity: number;
    private readonly spacing: number;
    private readonly r: number;
    private readonly dx: number;
    private readonly dy: number;
    private readonly path: PxPoint[] = [];
    /** Path points already walked for dab centers. */
    private walked = 0;
    private carried = 0;
    private lastCenter: PxPoint | null = null;
    /** Dab centers found but not yet painted into `alpha`. */
    private queued: PxPoint[] = [];
    /** Tone-match sums over committed alpha (dest RGB, source RGB, count). */
    private sums = [0, 0, 0, 0, 0, 0, 0];
    private shift: [number, number, number] = [0, 0, 0];
    /** Union of every dab window painted so far (committed + endpoint). */
    private painted: PxRect | null = null;
    /** Endpoint dab window of the previous flush (restored, must repaint). */
    private prevTail: PxRect | null = null;
    private readonly enabled: boolean;

    constructor(
        private readonly base: Uint8ClampedArray,
        private readonly out: Uint8ClampedArray,
        private readonly size: number,
        private readonly params: Omit<StampStrokePx, 'path'>,
    ) {
        this.alpha = new Float32Array(size * size);
        this.flow = Math.max(params.flow, MIN_FLOW);
        this.opacity = Math.min(Math.max(params.opacity, 0), 1);
        this.spacing = dabSpacingPx(params.radiusPx * 2, params.flow);
        this.r = Math.ceil(params.radiusPx) + 1;
        this.dx = Math.round(params.offsetPx.dx);
        this.dy = Math.round(params.offsetPx.dy);
        this.enabled = params.radiusPx > 0 && this.opacity > 0;
    }

    /** Points recorded so far (the stroke's dest polyline in surface px). */
    get points(): readonly PxPoint[] {
        return this.path;
    }

    /** Append one path point. Cheap: painting waits for flush(). */
    add(p: PxPoint): void {
        this.path.push({ x: p.x, y: p.y });
    }

    /**
     * Paint every point added since the last flush. Returns the rectangle of
     * `out` that changed, or null when nothing did.
     */
    flush(): PxRect | null {
        if (!this.enabled || this.path.length === 0) return null;
        this.walk();
        let dirty: PxRect | null = this.prevTail;
        for (const c of this.queued) dirty = unionRect(dirty, this.paintDab(c, this.alpha, true));
        this.queued = [];

        // Provisional endpoint dab (dabCenters' tail rule).
        const last = this.path[this.path.length - 1];
        const tail = this.lastCenter!;
        let tailRect: PxRect | null = null;
        let saved: Float32Array | null = null;
        let tailSums: number[] | null = null;
        if (Math.hypot(last.x - tail.x, last.y - tail.y) > this.spacing * 0.5) {
            tailRect = this.dabRect(last);
            if (tailRect) {
                saved = this.saveWindow(tailRect);
                const before = this.sums.slice();
                this.paintDab(last, this.alpha, true);
                tailSums = this.sums;
                this.sums = before;
            }
        }
        dirty = unionRect(dirty, tailRect);
        this.painted = unionRect(this.painted, tailRect);

        const sums = tailSums ?? this.sums;
        const n = sums[6];
        const shift: [number, number, number] = this.params.toneMatch && n > 0
            ? [(sums[0] - sums[3]) / n, (sums[1] - sums[4]) / n, (sums[2] - sums[5]) / n]
            : [0, 0, 0];
        const shiftMoved = shift[0] !== this.shift[0] || shift[1] !== this.shift[1] || shift[2] !== this.shift[2];
        this.shift = shift;
        if (shiftMoved) dirty = unionRect(dirty, this.painted);
        if (dirty) this.composite(dirty);

        if (tailRect && saved) this.restoreWindow(tailRect, saved);
        this.prevTail = tailRect;
        return dirty;
    }

    /** Walk new path segments for dab centers (mirrors dabCenters). */
    private walk(): void {
        const path = this.path;
        if (this.walked === 0) {
            this.lastCenter = { ...path[0] };
            this.queued.push(this.lastCenter);
            this.walked = 1;
        }
        for (let i = this.walked - 1; i + 1 < path.length; i++) {
            const a = path[i];
            const b = path[i + 1];
            const segLen = Math.hypot(b.x - a.x, b.y - a.y);
            if (segLen === 0) continue;
            let t = this.spacing - this.carried;
            while (t <= segLen) {
                const k = t / segLen;
                this.lastCenter = { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
                this.queued.push(this.lastCenter);
                t += this.spacing;
            }
            this.carried = segLen - (t - this.spacing);
        }
        this.walked = path.length;
    }

    private dabRect(c: PxPoint): PxRect | null {
        const r = this.r;
        const x0 = Math.max(0, Math.floor(c.x) - r);
        const x1 = Math.min(this.size, Math.ceil(c.x) + r + 1);
        const y0 = Math.max(0, Math.floor(c.y) - r);
        const y1 = Math.min(this.size, Math.ceil(c.y) + r + 1);
        return x1 > x0 && y1 > y0 ? { x0, y0, x1, y1 } : null;
    }

    /** Accumulate one dab into `alpha`; pixels that turn non-zero join the
     * tone-match sums. Returns the dab window. */
    private paintDab(c: PxPoint, alpha: Float32Array, track: boolean): PxRect | null {
        const rect = this.dabRect(c);
        if (!rect) return null;
        const { radiusPx, hardness } = this.params;
        const size = this.size;
        const base = this.base;
        const sums = this.sums;
        for (let y = rect.y0; y < rect.y1; y++) {
            for (let x = rect.x0; x < rect.x1; x++) {
                const d = Math.hypot(x + 0.5 - c.x, y + 0.5 - c.y);
                const a = this.flow * dabAlphaAt(d, radiusPx, hardness);
                if (a <= 0) continue;
                const i = y * size + x;
                const was = alpha[i];
                alpha[i] += a * (1 - was);
                if (!track || was > 0 || alpha[i] <= 0) continue;
                const sx = x + this.dx, sy = y + this.dy;
                if (sx < 0 || sy < 0 || sx >= size || sy >= size) continue;
                const di = i * 4;
                const si = (sy * size + sx) * 4;
                sums[0] += base[di]; sums[1] += base[di + 1]; sums[2] += base[di + 2];
                sums[3] += base[si]; sums[4] += base[si + 1]; sums[5] += base[si + 2];
                sums[6]++;
            }
        }
        if (track) this.painted = unionRect(this.painted, rect);
        return rect;
    }

    private saveWindow(rect: PxRect): Float32Array {
        const w = rect.x1 - rect.x0;
        const saved = new Float32Array(w * (rect.y1 - rect.y0));
        for (let y = rect.y0; y < rect.y1; y++) {
            saved.set(this.alpha.subarray(y * this.size + rect.x0, y * this.size + rect.x1), (y - rect.y0) * w);
        }
        return saved;
    }

    private restoreWindow(rect: PxRect, saved: Float32Array): void {
        const w = rect.x1 - rect.x0;
        for (let y = rect.y0; y < rect.y1; y++) {
            this.alpha.set(saved.subarray((y - rect.y0) * w, (y - rect.y0 + 1) * w), y * this.size + rect.x0);
        }
    }

    /** Write `out` over `rect` from base + current alpha (renderStampStroke's
     * final loop; pixels without alpha or source go back to base). */
    private composite(rect: PxRect): void {
        const { size, base, out, alpha, opacity, dx, dy } = this;
        const [shiftR, shiftG, shiftB] = this.shift;
        for (let y = rect.y0; y < rect.y1; y++) {
            for (let x = rect.x0; x < rect.x1; x++) {
                const di = (y * size + x) * 4;
                const a = alpha[y * size + x] * opacity;
                const sx = x + dx, sy = y + dy;
                if (a <= 0 || sx < 0 || sy < 0 || sx >= size || sy >= size) {
                    out[di] = base[di];
                    out[di + 1] = base[di + 1];
                    out[di + 2] = base[di + 2];
                    out[di + 3] = base[di + 3];
                    continue;
                }
                const si = (sy * size + sx) * 4;
                const cr = Math.min(255, Math.max(0, base[si] + shiftR));
                const cg = Math.min(255, Math.max(0, base[si + 1] + shiftG));
                const cb = Math.min(255, Math.max(0, base[si + 2] + shiftB));
                out[di] = Math.round(base[di] * (1 - a) + cr * a);
                out[di + 1] = Math.round(base[di + 1] * (1 - a) + cg * a);
                out[di + 2] = Math.round(base[di + 2] * (1 - a) + cb * a);
                out[di + 3] = 255;
            }
        }
    }
}
