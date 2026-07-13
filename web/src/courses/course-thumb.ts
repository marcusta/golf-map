// ============================================================
// Schematic minimap thumbnail for a course row (design 3a).
// Projects the course's tee→green routing into a small viewBox and
// draws a leg line + tee/green markers per hole. Colours come from
// the theme-invariant cartography tokens (--map-*) via inline
// `style` (SVG presentation attributes can't take var(), the CSS
// `stroke`/`fill` properties can), so there is no raw hex here.
// ============================================================

import { icon } from '../ui/icons';

export type RoutingHole = {
    hole: number;
    /** [lat, lon] */
    tee: [number, number];
    /** [lat, lon] */
    green: [number, number];
};

export const THUMB_W = 120;
export const THUMB_H = 84;
const PAD = 0.12; // 12% inset around the fitted bbox

const SVG_NS = 'http://www.w3.org/2000/svg';

export type ProjectedHole = { tee: [number, number]; green: [number, number] };

/**
 * Equirectangular projection of routing [lat, lon] points fitted into the
 * THUMB_W×THUMB_H viewBox with PAD inset, aspect preserved. Returns null when
 * there is nothing to draw. Pure — the unit-test entry point.
 */
export function projectRouting(routing: readonly RoutingHole[]): ProjectedHole[] | null {
    if (!routing || routing.length === 0) return null;

    const lats: number[] = [];
    for (const h of routing) { lats.push(h.tee[0], h.green[0]); }
    const midLat = lats.reduce((a, b) => a + b, 0) / lats.length;
    const cosLat = Math.cos((midLat * Math.PI) / 180) || 1;

    // Project to a planar frame (x east, y south so north is up on screen).
    const raw = routing.map(h => ({
        tee: [h.tee[1] * cosLat, -h.tee[0]] as [number, number],
        green: [h.green[1] * cosLat, -h.green[0]] as [number, number],
    }));

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const h of raw) {
        for (const [x, y] of [h.tee, h.green]) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
        }
    }

    const spanX = Math.max(maxX - minX, 1e-9);
    const spanY = Math.max(maxY - minY, 1e-9);
    const innerW = THUMB_W * (1 - 2 * PAD);
    const innerH = THUMB_H * (1 - 2 * PAD);
    const scale = Math.min(innerW / spanX, innerH / spanY);
    const offX = THUMB_W / 2 - scale * (minX + maxX) / 2;
    const offY = THUMB_H / 2 - scale * (minY + maxY) / 2;
    const project = ([x, y]: [number, number]): [number, number] => [
        Math.round((scale * x + offX) * 10) / 10,
        Math.round((scale * y + offY) * 10) / 10,
    ];

    return raw.map(h => ({ tee: project(h.tee), green: project(h.green) }));
}

function el(name: string, attrs: Record<string, string>): SVGElement {
    const node = document.createElementNS(SVG_NS, name);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    return node;
}

/**
 * Build the schematic thumbnail `<svg>` for a course's routing. With no
 * routing, returns a background-only svg with a faint centred flag.
 */
export function renderCourseThumb(routing: readonly RoutingHole[]): SVGElement {
    const svg = el('svg', {
        viewBox: `0 0 ${THUMB_W} ${THUMB_H}`,
        preserveAspectRatio: 'xMidYMid slice',
        'aria-hidden': 'true',
    });

    const holes = projectRouting(routing);
    if (!holes) {
        // Empty state: faint flag glyph centred in the viewBox.
        const g = el('g', { transform: `translate(${THUMB_W / 2 - 12} ${THUMB_H / 2 - 12})` });
        g.setAttribute('style', 'opacity:0.38;color:var(--map-bunker-fill)');
        g.innerHTML = icon('flag', 24);
        const glyph = g.firstElementChild as SVGElement | null;
        glyph?.setAttribute('stroke', 'currentColor');
        svg.appendChild(g);
        return svg;
    }

    for (const h of holes) {
        const [tx, ty] = h.tee;
        const [gx, gy] = h.green;

        const leg = el('line', {
            x1: String(tx), y1: String(ty), x2: String(gx), y2: String(gy),
            'stroke-width': '2', 'stroke-linecap': 'round',
        });
        leg.setAttribute('style', 'stroke:var(--map-shot-line);opacity:0.9');
        svg.appendChild(leg);

        const tee = el('rect', {
            x: String(tx - 2), y: String(ty - 2), width: '4', height: '4', rx: '1',
            'stroke-width': '0.6',
        });
        tee.setAttribute('style', 'fill:var(--map-tee-draw);stroke:var(--map-tee-outline)');
        svg.appendChild(tee);

        const green = el('circle', {
            cx: String(gx), cy: String(gy), r: '2.6', 'stroke-width': '0.8',
        });
        green.setAttribute('style', 'fill:var(--map-green-draw);stroke:var(--map-green-outline)');
        svg.appendChild(green);
    }

    return svg;
}
