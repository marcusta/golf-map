// The SVG-level bisect of a broken OPCD build (`bun run gspro:bisect -- <course> svg-mix`):
// a variant is the last GOOD export with a chosen set of the BAD export's shape
// changes laid over it, built straight from the two snapshot SVGs, so the variant
// is exactly what the pipeline wrote then — no re-export, no database.
//
// A shape is keyed by its `data-feature-id`, never by its path id: a feature moved
// to another hole gets a new path id (`hole_3_112` -> `hole_101_112`), and a
// path-id mix would keep the old copy and add the new one. Keyed by feature, a move
// is one change, applied or not as a whole.
//
// The files are what `gspro.py svg` writes: a head, one `<g inkscape:groupmode="layer">`
// per hole/layer, one `<path …/>` per line inside it, and a tail. Anything else inside
// a layer is refused rather than guessed at.

export interface SvgShape {
    /** The path's `id` (`hole_101_16c`). */
    pid: string;
    /** `data-feature-id` — several space-separated ids for a merged road. */
    key: string;
    /** `data-type`, for the listing. */
    type: string;
    line: string;
}

export interface SvgLayer {
    /** `inkscape:label` (`Hole101`, `Roads`): what tells layers apart across files. */
    label: string;
    /** The `<g …>` line as written. */
    tag: string;
    shapes: SvgShape[];
}

export interface ParsedSvg {
    head: string[];
    layers: SvgLayer[];
    tail: string[];
}

const attr = (line: string, name: string): string | null => {
    const m = new RegExp(`\\s${name}="([^"]*)"`).exec(line);
    return m ? m[1]! : null;
};

export function parseSvg(text: string): ParsedSvg {
    const head: string[] = [];
    const tail: string[] = [];
    const layers: SvgLayer[] = [];
    let current: SvgLayer | null = null;
    const seen = new Map<string, number>();
    for (const line of text.split(/\r?\n/)) {
        const s = line.trim();
        if (s.startsWith('<g ')) {
            if (current) throw new Error(`nested layer at '${s.slice(0, 80)}'`);
            const label = attr(line, 'inkscape:label');
            if (label === null) throw new Error(`a layer without inkscape:label: '${s.slice(0, 80)}'`);
            current = { label, tag: line, shapes: [] };
            layers.push(current);
        } else if (s === '</g>') {
            current = null;
        } else if (current) {
            if (!s.startsWith('<path')) throw new Error(`layer ${current.label}: unexpected line '${s.slice(0, 80)}'`);
            const pid = attr(line, 'id');
            const fid = attr(line, 'data-feature-id');
            if (pid === null || fid === null) throw new Error(`layer ${current.label}: a path without id or data-feature-id: '${s.slice(0, 80)}'`);
            // A feature drawn as two paths would share its id: number the second one, in file order.
            const n = (seen.get(fid) ?? 0) + 1;
            seen.set(fid, n);
            current.shapes.push({ pid, key: n === 1 ? fid : `${fid}#${n}`, type: attr(line, 'data-type') ?? '', line });
        } else if (layers.length === 0) {
            head.push(line);
        } else {
            tail.push(line);
        }
    }
    return { head, layers, tail };
}

export type ShapeChangeKind = 'added' | 'removed' | 'edited' | 'moved';

export interface ShapeChange {
    /** 1-based, stable for a pair of files: what `--apply` names. */
    n: number;
    kind: ShapeChangeKind;
    key: string;
    type: string;
    /** The path id in the good file (null when added) and in the bad one (null when removed). */
    goodPid: string | null;
    badPid: string | null;
    goodLayer: string | null;
    badLayer: string | null;
}

interface Placed { layer: string; shape: SvgShape }

const index = (svg: ParsedSvg) => new Map<string, Placed>(
    svg.layers.flatMap(l => l.shapes.map(shape => [shape.key, { layer: l.label, shape }] as const)));

/**
 * What differs between the two files, shape by shape, in the bad file's layer and
 * path order (removed shapes last, in the good file's order).
 */
export function shapeChanges(good: ParsedSvg, bad: ParsedSvg): ShapeChange[] {
    const g = index(good);
    const out: Omit<ShapeChange, 'n'>[] = [];
    for (const layer of bad.layers) {
        for (const shape of layer.shapes) {
            const before = g.get(shape.key);
            if (before && before.layer === layer.label && before.shape.line === shape.line) continue;
            const kind: ShapeChangeKind = !before ? 'added' : before.layer !== layer.label ? 'moved' : 'edited';
            out.push({
                kind, key: shape.key, type: shape.type,
                goodPid: before?.shape.pid ?? null, badPid: shape.pid,
                goodLayer: before?.layer ?? null, badLayer: layer.label,
            });
        }
    }
    const b = index(bad);
    for (const layer of good.layers) {
        for (const shape of layer.shapes) {
            if (b.has(shape.key)) continue;
            out.push({ kind: 'removed', key: shape.key, type: shape.type, goodPid: shape.pid, badPid: null, goodLayer: layer.label, badLayer: null });
        }
    }
    return out.map((c, i) => ({ n: i + 1, ...c }));
}

/** Do the two files list their common layers in a different order? (A variant always takes the bad file's.) */
export function layerOrderChanged(good: ParsedSvg, bad: ParsedSvg): boolean {
    const common = new Set(good.layers.map(l => l.label).filter(l => bad.layers.some(b => b.label === l)));
    const a = good.layers.map(l => l.label).filter(l => common.has(l));
    const z = bad.layers.map(l => l.label).filter(l => common.has(l));
    return a.join('\n') !== z.join('\n');
}

export interface MixResult {
    text: string;
    paths: number;
    /** The non-empty layers written, in order. */
    layers: string[];
}

/**
 * GOOD with the changes to the shapes in `apply` (keys) taken from BAD: an edited
 * shape is swapped in place, a removed one dropped, an added or moved one placed
 * after the nearest shape that precedes it in BAD and is already there (else first
 * in its layer). Layers keep BAD's order, with GOOD-only layers after their GOOD
 * predecessor; empty layers are left out and the rest renumbered `layer1..n`.
 * Throws when two paths would share an id (OPCD would build only one of them).
 */
export function mixSvg(good: ParsedSvg, bad: ParsedSvg, apply: ReadonlySet<string>): MixResult {
    const b = index(bad);
    const order = bad.layers.map(l => l.label);
    good.layers.forEach((l, i) => {
        if (order.includes(l.label)) return;
        const prev = i > 0 ? good.layers[i - 1]!.label : null;
        order.splice(prev !== null && order.includes(prev) ? order.indexOf(prev) + 1 : 0, 0, l.label);
    });
    const tags = new Map<string, string>([...good.layers.map(l => [l.label, l.tag] as const), ...bad.layers.map(l => [l.label, l.tag] as const)]);
    const result = new Map<string, SvgShape[]>(order.map(label => [label, []]));
    const done = new Set<string>();

    for (const layer of good.layers) {
        for (const shape of layer.shapes) {
            if (!apply.has(shape.key)) {
                result.get(layer.label)!.push(shape);
                done.add(shape.key);
                continue;
            }
            const now = b.get(shape.key);
            if (!now) done.add(shape.key);                       // removed in BAD
            else if (now.layer === layer.label) {                 // edited (or the same) in place
                result.get(layer.label)!.push(now.shape);
                done.add(shape.key);
            }
            // moved to another layer: placed in the BAD pass below
        }
    }
    for (const layer of bad.layers) {
        const list = result.get(layer.label)!;
        layer.shapes.forEach((shape, i) => {
            if (done.has(shape.key) || !apply.has(shape.key)) return;
            let at = 0;
            for (let j = i - 1; j >= 0; j--) {
                const k = list.findIndex(s => s.key === layer.shapes[j]!.key);
                if (k >= 0) { at = k + 1; break; }
            }
            list.splice(at, 0, shape);
            done.add(shape.key);
        });
    }

    const lines = [...bad.head];
    const written: string[] = [];
    for (const label of order) {
        const shapes = result.get(label)!;
        if (!shapes.length) continue;
        written.push(label);
        lines.push(tags.get(label)!.replace(/\sid="layer\d+"/, ` id="layer${written.length}"`));
        for (const s of shapes) lines.push(s.line);
        lines.push('  </g>');
    }
    lines.push(...bad.tail);

    const ids = new Set<string>();
    const dup = new Set<string>();
    for (const s of [...result.values()].flat()) (ids.has(s.pid) ? dup : ids).add(s.pid);
    if (dup.size) throw new Error(`the variant would have duplicate path ids: ${[...dup].join(', ')} — apply the changes that renumbered them together`);
    return { text: lines.join('\n'), paths: ids.size, layers: written };
}
