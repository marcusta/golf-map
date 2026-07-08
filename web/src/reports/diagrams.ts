/**
 * diagrams — the shared visual language for report diagrams, as pure markup.
 *
 * Generative diagram blocks (StepFlow, CycleDiagram, PyramidDiagram,
 * StackDiagram, Timeline, SequenceDiagram, Quadrants, ActivityDiagram,
 * BlockDiagram). Deliberately DOM-free and dependency-free: every builder is a
 * pure function returning a self-contained, fully inline-styled HTML/SVG string
 * — no CDN, no runtime, no external host.
 *
 * That property is why it's vendored here: the visual test report and the
 * refactor/architecture report are published as Claude Artifacts, whose strict
 * CSP blocks external hosts (so CDN Tailwind/Mermaid can't load). These builders
 * were written for the same isolation constraint (Confluence's CSS-isolated HTML
 * macro), so the markup drops straight into a CSP-locked Artifact. Each
 * `var(--…, #fallback)` falls back to a light-theme hex when no theme vars are
 * defined — which is exactly the standalone-Artifact case.
 *
 * Vendored from second-brain `src/briefings/diagrams.ts`. Pure, dependency-free;
 * re-sync by re-copying if the upstream visual language changes.
 */

// ---- palette / tokens -------------------------------------------------------

export interface DiagramColor {
  stroke: string;
  fill: string;
  text: string;
}

export const DIAGRAM_PALETTE: Record<string, DiagramColor> = {
  teal: { stroke: '#16A085', fill: '#E8F6F2', text: '#117A68' },
  red: { stroke: '#EE1E3A', fill: '#FDE8EC', text: '#B01527' },
  gold: { stroke: '#D69E00', fill: '#FFF7D6', text: '#92400E' },
  navy: { stroke: '#1E3A5F', fill: '#E7EDF4', text: '#1E3A5F' },
  slate: { stroke: '#94A3B8', fill: '#F1F5F9', text: '#475569' },
  blue: { stroke: '#3B82F6', fill: '#E8F0FE', text: '#1D4ED8' },
  purple: { stroke: '#7C3AED', fill: '#F1EAFE', text: '#6D28D9' },
};

export const DIAGRAM_INK = {
  title: '#0F172A',
  meta: '#64748B',
  connector: '#94A3B8',
};

export const DIAGRAM_TOKENS = {
  card: { radius: 14, borderWidth: 1.5, padX: 15, padY: 16 },
  connector: { color: DIAGRAM_INK.connector, width: 2 },
  type: { eyebrow: 11, title: 19, status: 14, meta: 12 },
} as const;

export function resolveDiagramColor(accent: string | undefined): DiagramColor {
  if (!accent) return DIAGRAM_PALETTE.slate;
  const named = DIAGRAM_PALETTE[accent.toLowerCase()];
  if (named) return named;
  if (/^#[0-9a-fA-F]{6}$/.test(accent)) {
    return { stroke: accent, fill: `${accent}14`, text: accent };
  }
  return DIAGRAM_PALETTE.slate;
}

/** Pick black-ish or white text for legibility on a solid hex fill. */
export function contrastText(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return '#FFFFFF';
  const v = parseInt(m[1], 16);
  const r = (v >> 16) & 255;
  const g = (v >> 8) & 255;
  const b = v & 255;
  const lum = 0.299 * r + 0.587 * g + 0.114 * b;
  return lum > 150 ? '#1F2937' : '#FFFFFF';
}

const FONT_BODY = "var(--font-body, system-ui, sans-serif)";
const FONT_DISPLAY = "var(--font-display, var(--font-body, system-ui, sans-serif))";

function esc(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Self-contained figure frame shared by every diagram. */
function frame(bodyHtml: string, caption: string | undefined, pad: number): string {
  const cap = caption
    ? `<figcaption style="margin-top:12px;font-family:${FONT_BODY};font-size:12px;color:var(--text-muted,#64748B);letter-spacing:0.04em;text-transform:uppercase;">${esc(caption)}</figcaption>`
    : '';
  return (
    `<figure style="margin:0;background:var(--surface,#ffffff);border:1px solid var(--border,#E2E8F0);` +
    `border-radius:var(--radius,10px);padding:${pad}px;overflow-x:auto;">${bodyHtml}${cap}</figure>`
  );
}

let markerSeq = 0;

// ---- StepFlow ---------------------------------------------------------------

export interface StepFlowStep {
  eyebrow?: string;
  title: string;
  status?: string;
  meta?: string;
  accent?: string;
}

export interface StepFlowInput {
  steps?: StepFlowStep[];
  arrows?: 'solid' | 'dashed' | 'none';
  /** 'horizontal': a left-to-right row (tidy for short flows, cramps past ~4).
   * 'vertical': a top-to-bottom stack (full-width cards, no title clipping).
   * 'auto' (default): horizontal for ≤4 steps, vertical for ≥5. */
  orientation?: 'horizontal' | 'vertical' | 'auto';
  caption?: string;
}

function hArrow(style: 'solid' | 'dashed'): string {
  const c = DIAGRAM_INK.connector;
  const w = DIAGRAM_TOKENS.connector.width;
  const dash = style === 'dashed' ? ' stroke-dasharray="3 4"' : '';
  return (
    `<div style="flex:0 0 auto;align-self:center;display:flex;align-items:center;padding:0 2px;">` +
    `<svg width="34" height="24" viewBox="0 0 34 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">` +
    `<line x1="2" y1="12" x2="22" y2="12" stroke="${c}" stroke-width="${w}" stroke-linecap="round"${dash}/>` +
    `<path d="M21 6 L31 12 L21 18" fill="none" stroke="${c}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>` +
    `</svg></div>`
  );
}

export function stepFlowMarkup(input: StepFlowInput): string {
  const steps = Array.isArray(input.steps) ? input.steps : [];
  const arrows = input.arrows ?? 'solid';
  const orientation = input.orientation ?? 'auto';
  const n = steps.length;
  // A horizontal row of ≥5 cards cramps and breaks titles mid-word; a briefing
  // page has unlimited vertical room, so fall back to a top-to-bottom stack.
  const vertical = orientation === 'vertical' || (orientation === 'auto' && n >= 5);

  // Horizontal cards share the width, so long titles need a shrink; vertical
  // cards get the full width and keep the base type size.
  const titlePx = vertical ? DIAGRAM_TOKENS.type.title : n >= 6 ? 15 : n === 5 ? 17 : DIAGRAM_TOKENS.type.title;
  const padX = !vertical && n >= 6 ? 10 : DIAGRAM_TOKENS.card.padX;
  // Column flex stretches cards to full width on the cross-axis; a row flex must
  // size them equally on the main-axis (flex:1) with a floor so they don't crush.
  const cardFlex = vertical ? '' : 'flex:1 1 0;min-width:96px;';

  const card = (s: StepFlowStep): string => {
    const c = resolveDiagramColor(s.accent);
    const eyebrow = s.eyebrow
      ? `<div style="font-family:${FONT_BODY};font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:${c.text};">${esc(s.eyebrow)}</div>`
      : '';
    const status = s.status
      ? `<div style="font-family:${FONT_BODY};font-size:14px;font-weight:600;color:${c.text};">${esc(s.status)}</div>`
      : '';
    const meta = s.meta
      ? `<div style="font-family:${FONT_BODY};font-size:12px;color:${DIAGRAM_INK.meta};">${esc(s.meta)}</div>`
      : '';
    return (
      `<div style="${cardFlex}display:flex;flex-direction:column;gap:4px;` +
      `padding:${DIAGRAM_TOKENS.card.padY}px ${padX}px;border:1.5px solid ${c.stroke};border-radius:14px;background:${c.fill};">` +
      eyebrow +
      `<div style="font-family:${FONT_DISPLAY};font-size:${titlePx}px;font-weight:750;line-height:1.15;color:${DIAGRAM_INK.title};overflow-wrap:break-word;">${esc(s.title)}</div>` +
      status +
      meta +
      `</div>`
    );
  };

  const arrow = vertical ? vArrow : hArrow;
  const parts: string[] = [];
  steps.forEach((s, i) => {
    parts.push(card(s));
    if (arrows !== 'none' && i < steps.length - 1) parts.push(arrow(arrows));
  });
  const gap = arrows === 'none' ? (vertical ? 12 : 14) : 0;
  const body = vertical
    ? `<div style="display:flex;flex-direction:column;align-items:stretch;gap:${gap}px;max-width:560px;margin:0 auto;">${parts.join('')}</div>`
    : `<div style="display:flex;align-items:stretch;gap:${gap}px;">${parts.join('')}</div>`;
  return frame(body, input.caption, 24);
}

// ---- StackDiagram -----------------------------------------------------------

export interface StackLayer {
  title: string;
  sub?: string;
  items?: string[];
  accent?: string;
}

export interface StackInput {
  layers?: StackLayer[];
  arrows?: 'solid' | 'dashed' | 'none';
  caption?: string;
}

function vArrow(style: 'solid' | 'dashed'): string {
  const c = DIAGRAM_INK.connector;
  const dash = style === 'dashed' ? ' stroke-dasharray="3 4"' : '';
  return (
    `<div style="display:flex;justify-content:center;padding:5px 0;">` +
    `<svg width="24" height="26" viewBox="0 0 24 26" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">` +
    `<line x1="12" y1="2" x2="12" y2="18" stroke="${c}" stroke-width="2" stroke-linecap="round"${dash}/>` +
    `<path d="M6 17 L12 24 L18 17" fill="none" stroke="${c}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>` +
    `</svg></div>`
  );
}

export function stackMarkup(input: StackInput): string {
  const layers = Array.isArray(input.layers) ? input.layers : [];
  const arrows = input.arrows ?? 'solid';

  const band = (l: StackLayer): string => {
    const c = resolveDiagramColor(l.accent);
    const sub = l.sub
      ? `<div style="font-family:${FONT_BODY};font-size:12px;color:${DIAGRAM_INK.meta};margin-top:2px;">${esc(l.sub)}</div>`
      : '';
    const items = Array.isArray(l.items) ? l.items : [];
    const chips = items.length
      ? `<div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:10px;">` +
        items
          .map(
            (it) =>
              `<span style="font-family:${FONT_BODY};font-size:13px;color:#334155;background:#FFFFFF;border:1px solid #E2E8F0;border-radius:999px;padding:4px 12px;white-space:nowrap;">${esc(it)}</span>`,
          )
          .join('') +
        `</div>`
      : '';
    return (
      `<div style="padding:14px 18px;border:1.5px solid ${c.stroke};border-radius:14px;background:${c.fill};">` +
      `<div style="font-family:${FONT_DISPLAY};font-size:15px;font-weight:750;color:${c.text};">${esc(l.title)}</div>` +
      sub +
      chips +
      `</div>`
    );
  };

  const gap = arrows === 'none' ? 12 : 0;
  const parts: string[] = [];
  layers.forEach((l, i) => {
    parts.push(band(l));
    if (arrows !== 'none' && i < layers.length - 1) parts.push(vArrow(arrows));
  });
  const body = `<div style="display:flex;flex-direction:column;align-items:stretch;gap:${gap}px;min-width:260px;">${parts.join('')}</div>`;
  return frame(body, input.caption, 24);
}

// ---- CycleDiagram -----------------------------------------------------------

export interface CycleSatellite {
  label: string;
  sub?: string;
  accent?: string;
}

export interface CycleStep {
  title: string;
  meta?: string;
  accent?: string;
  /** Optional smaller dashed circle attached radially outward — e.g. the
   * humans pulled into an agent-run station. Keep label/sub short. */
  satellite?: CycleSatellite;
}

export interface CycleInput {
  steps?: CycleStep[];
  /** 'cycle' (default): clockwise arc arrows around the ring — a sequence.
   * 'hub': no perimeter arrows; each node connects to a central hub circle by a
   * bidirectional spoke — a shared substrate the nodes meet in, with no
   * node-to-node order implied. */
  mode?: 'cycle' | 'hub';
  centerTitle?: string;
  centerSubtitle?: string;
  /** Hub mode only: palette name or hex for the central hub circle. */
  centerAccent?: string;
  arrowAccent?: string;
  caption?: string;
}

export function cycleMarkup(input: CycleInput): string {
  const steps = Array.isArray(input.steps) ? input.steps : [];
  const n = steps.length;
  const hub = input.mode === 'hub';
  const NODE_R = 60;
  const SAT_R = 36;
  const HUB_R = 70;
  const hasSat = steps.some((s) => s.satellite);
  // Satellites sit outside the ring, so the canvas grows to keep them in frame.
  const SIZE = hasSat ? 676 : 520;
  const C = SIZE / 2;
  const R = n >= 6 ? 186 : 168;
  const arrow = resolveDiagramColor(input.arrowAccent ?? 'gold').stroke;
  const markerId = `bf-cyc-arrow-${markerSeq++}`;

  const centers = steps.map((_, i) => {
    const a = (-90 + (i * 360) / n) * (Math.PI / 180);
    return { x: C + R * Math.cos(a), y: C + R * Math.sin(a), a };
  });

  // Angular half-width a node actually covers on the ring (chord math, not the
  // linear approximation — that overestimates and starves the arcs), plus a
  // small clearance so arrowheads don't touch the circles.
  const gap = Math.asin(NODE_R / R) + 10 / R;
  const arcs: string[] = [];
  if (hub) {
    // Bidirectional spokes: hub edge → node edge, arrowheads both ends.
    for (const { a } of centers) {
      const p0x = C + (HUB_R + 8) * Math.cos(a);
      const p0y = C + (HUB_R + 8) * Math.sin(a);
      const p1x = C + (R - NODE_R - 8) * Math.cos(a);
      const p1y = C + (R - NODE_R - 8) * Math.sin(a);
      arcs.push(
        `<line x1="${p0x.toFixed(1)}" y1="${p0y.toFixed(1)}" x2="${p1x.toFixed(1)}" y2="${p1y.toFixed(1)}" stroke="${arrow}" stroke-width="3" marker-start="url(#${markerId}-rev)" marker-end="url(#${markerId})"/>`,
      );
    }
  } else if (n >= 2) {
    for (let i = 0; i < n; i++) {
      const a0 = centers[i].a + gap;
      const a1 = centers[(i + 1) % n].a - gap + (i === n - 1 ? 2 * Math.PI : 0);
      const p0x = C + R * Math.cos(a0);
      const p0y = C + R * Math.sin(a0);
      const p1x = C + R * Math.cos(a1);
      const p1y = C + R * Math.sin(a1);
      arcs.push(
        `<path d="M${p0x.toFixed(1)},${p0y.toFixed(1)} A${R} ${R} 0 0 1 ${p1x.toFixed(1)},${p1y.toFixed(1)}" fill="none" stroke="${arrow}" stroke-width="4" marker-end="url(#${markerId})"/>`,
      );
    }
  }

  // Shrink a line's font size until it fits the chord of a circle of radius
  // `r` at the line's vertical offset from the centre. `charW` is the average
  // glyph width as a fraction of font size (heavier weights run wider).
  const fitFont = (text: string, base: number, dy: number, charW: number, r: number = NODE_R): number => {
    const avail = 2 * Math.sqrt(r * r - dy * dy) - 8;
    const est = text.length * charW * base;
    return est > avail ? Math.max(9, avail / (text.length * charW)) : base;
  };

  // One shared size per line class, so nodes don't render mismatched type.
  const titleFs = steps.reduce((fs, s) => Math.min(fs, fitFont(s.title, 17, 6, 0.56)), 17);
  const metaFs = steps.reduce((fs, s) => (s.meta ? Math.min(fs, fitFont(s.meta, 11, 18, 0.52)) : fs), 11);
  const sats = steps.map((s) => s.satellite).filter((s): s is CycleSatellite => !!s);
  const satFs = sats.reduce((fs, s) => Math.min(fs, fitFont(s.label, 13, 4, 0.56, SAT_R)), 13);
  const satSubFs = sats.reduce((fs, s) => (s.sub ? Math.min(fs, fitFont(s.sub, 10, 14, 0.52, SAT_R)) : fs), 10);

  const nodes = steps
    .map((step, i) => {
      const { x, y, a } = centers[i];
      const color = resolveDiagramColor(step.accent);
      const titleY = step.meta ? y - 4 : y + 6;
      const metaSvg = step.meta
        ? `<text x="${x.toFixed(1)}" y="${(y + 18).toFixed(1)}" text-anchor="middle" fill="${DIAGRAM_INK.meta}" font-size="${metaFs.toFixed(1)}">${esc(step.meta)}</text>`
        : '';
      let satSvg = '';
      if (step.satellite) {
        const sat = step.satellite;
        const satColor = resolveDiagramColor(sat.accent ?? 'slate');
        const d = R + NODE_R + SAT_R + 14;
        const sx = C + d * Math.cos(a);
        const sy = C + d * Math.sin(a);
        const l0x = C + (R + NODE_R) * Math.cos(a);
        const l0y = C + (R + NODE_R) * Math.sin(a);
        const l1x = sx - SAT_R * Math.cos(a);
        const l1y = sy - SAT_R * Math.sin(a);
        const labelY = sat.sub ? sy - 2 : sy + 4;
        const subSvg = sat.sub
          ? `<text x="${sx.toFixed(1)}" y="${(sy + 14).toFixed(1)}" text-anchor="middle" fill="${DIAGRAM_INK.meta}" font-size="${satSubFs.toFixed(1)}">${esc(sat.sub)}</text>`
          : '';
        satSvg =
          `<line x1="${l0x.toFixed(1)}" y1="${l0y.toFixed(1)}" x2="${l1x.toFixed(1)}" y2="${l1y.toFixed(1)}" stroke="${satColor.stroke}" stroke-width="1.5" stroke-dasharray="4 3"/>` +
          `<circle cx="${sx.toFixed(1)}" cy="${sy.toFixed(1)}" r="${SAT_R}" fill="#fff" stroke="${satColor.stroke}" stroke-width="1.8" stroke-dasharray="5 4"/>` +
          `<text x="${sx.toFixed(1)}" y="${labelY.toFixed(1)}" text-anchor="middle" fill="${DIAGRAM_INK.title}" font-size="${satFs.toFixed(1)}" font-weight="650">${esc(sat.label)}</text>` +
          subSvg;
      }
      return (
        satSvg +
        `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${NODE_R}" fill="${color.fill}" stroke="${color.stroke}" stroke-width="2.5"/>` +
        `<text x="${x.toFixed(1)}" y="${titleY.toFixed(1)}" text-anchor="middle" fill="${DIAGRAM_INK.title}" font-size="${titleFs.toFixed(1)}" font-weight="700">${esc(step.title)}</text>` +
        metaSvg
      );
    })
    .join('');

  // In hub mode the centre is a real node: a circle the spokes attach to, with
  // the title fitted inside it like any other node label.
  const hubColor = resolveDiagramColor(input.centerAccent ?? 'slate');
  const hubCircle = hub
    ? `<circle cx="${C}" cy="${C}" r="${HUB_R}" fill="${hubColor.fill}" stroke="${hubColor.stroke}" stroke-width="2.5"/>`
    : '';
  const cTitleFs = hub && input.centerTitle ? fitFont(input.centerTitle, 20, 6, 0.6, HUB_R) : 20;
  const cSubFs = hub && input.centerSubtitle ? fitFont(input.centerSubtitle, 13, 18, 0.52, HUB_R) : 13;
  const centerTitle = input.centerTitle
    ? `<text x="${C}" y="${input.centerSubtitle ? C - 4 : C + 6}" text-anchor="middle" fill="${DIAGRAM_INK.title}" font-size="${cTitleFs.toFixed(1)}" font-weight="800" letter-spacing="0.04em">${esc(input.centerTitle)}</text>`
    : '';
  const centerSub = input.centerSubtitle
    ? `<text x="${C}" y="${C + 18}" text-anchor="middle" fill="${DIAGRAM_INK.meta}" font-size="${cSubFs.toFixed(1)}">${esc(input.centerSubtitle)}</text>`
    : '';

  const revMarker = hub
    ? `<marker id="${markerId}-rev" markerUnits="userSpaceOnUse" markerWidth="14" markerHeight="14" refX="1" refY="7" orient="auto"><path d="M12,1 L0,7 L12,13 Z" fill="${arrow}"/></marker>`
    : '';
  const svg =
    `<svg viewBox="0 0 ${SIZE} ${SIZE}" xmlns="http://www.w3.org/2000/svg" font-family="${FONT_BODY}" role="img" style="width:100%;max-width:${SIZE}px;height:auto;">` +
    `<defs><marker id="${markerId}" markerUnits="userSpaceOnUse" markerWidth="14" markerHeight="14" refX="11" refY="7" orient="auto"><path d="M0,1 L12,7 L0,13 Z" fill="${arrow}"/></marker>${revMarker}</defs>` +
    hubCircle +
    arcs.join('') +
    nodes +
    centerTitle +
    centerSub +
    `</svg>`;
  const body = `<div style="display:flex;justify-content:center;">${svg}</div>`;
  return frame(body, input.caption, 20);
}

// ---- PyramidDiagram ---------------------------------------------------------

export interface PyramidLayer {
  title: string;
  sub?: string;
  meta?: string;
  accent?: string;
}

export interface PyramidInput {
  layers?: PyramidLayer[];
  pointed?: boolean;
  caption?: string;
}

export function pyramidMarkup(input: PyramidInput): string {
  const W = 720;
  const BASE = 640;
  const APEX = Math.max(154, BASE * 0.24);
  const BAND_H = 86;
  const PAD = 10;

  const layers = Array.isArray(input.layers) ? input.layers : [];
  const n = layers.length || 1;
  const H = n * BAND_H;
  const cx = W / 2;
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

  const pointed = input.pointed === true;
  const capH = pointed ? (APEX * H) / (BASE - APEX) : 0;
  const topColor = resolveDiagramColor(layers[0]?.accent);
  const cap = pointed
    ? `<polygon points="${cx.toFixed(1)},3 ${(cx - APEX / 2).toFixed(1)},${capH + 3} ${(cx + APEX / 2).toFixed(1)},${capH + 3}" fill="${topColor.stroke}" stroke="#FFFFFF" stroke-width="2"/>`
    : '';

  const bands = layers
    .map((layer, k) => {
      const color = resolveDiagramColor(layer.accent);
      const ink = contrastText(color.stroke);
      const yTop = k * BAND_H + 3 + capH;
      const yBot = (k + 1) * BAND_H + 3 + capH;
      const wTop = lerp(APEX, BASE, k / n);
      const wBot = lerp(APEX, BASE, (k + 1) / n);
      const pts = [
        `${(cx - wTop / 2).toFixed(1)},${yTop}`,
        `${(cx + wTop / 2).toFixed(1)},${yTop}`,
        `${(cx + wBot / 2).toFixed(1)},${yBot}`,
        `${(cx - wBot / 2).toFixed(1)},${yBot}`,
      ].join(' ');

      const boxW = Math.max(40, wTop - 2 * PAD);
      const boxX = cx - boxW / 2;
      const sub = layer.sub ? `<div style="font-size:12px;line-height:1.25;">${esc(layer.sub)}</div>` : '';
      const meta = layer.meta
        ? `<div style="font-size:11px;opacity:0.82;line-height:1.2;margin-top:1px;">${esc(layer.meta)}</div>`
        : '';
      const label =
        `<foreignObject x="${boxX.toFixed(1)}" y="${yTop}" width="${boxW.toFixed(1)}" height="${BAND_H}">` +
        `<div xmlns="http://www.w3.org/1999/xhtml" style="height:${BAND_H}px;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;color:${ink};font-family:${FONT_BODY};">` +
        `<div style="font-size:15px;font-weight:700;line-height:1.2;">${esc(layer.title)}</div>` +
        sub +
        meta +
        `</div></foreignObject>`;

      return `<polygon points="${pts}" fill="${color.stroke}" stroke="#FFFFFF" stroke-width="2"/>` + label;
    })
    .join('');

  const svg =
    `<svg viewBox="0 0 ${W} ${H + capH + 6}" xmlns="http://www.w3.org/2000/svg" role="img" style="width:100%;max-width:720px;height:auto;">${cap}${bands}</svg>`;
  const body = `<div style="display:flex;justify-content:center;">${svg}</div>`;
  return frame(body, input.caption, 20);
}

// ---- Timeline ---------------------------------------------------------------

export interface TimelineEvent {
  date: string;
  title: string;
  description?: string;
  accent?: string;
  deadline?: boolean;
}

export interface TimelineInput {
  events?: TimelineEvent[];
  accent?: string;
  caption?: string;
}

export function timelineMarkup(input: TimelineInput): string {
  const events = Array.isArray(input.events) ? input.events : [];
  const n = events.length;
  const defaultAccent = input.accent ?? 'teal';
  const COLW = 190;
  const PAD = 72;
  const W = Math.max(520, PAD * 2 + (n > 1 ? (n - 1) * COLW : 0));
  const lineY = 74;
  const H = 210;
  const usable = W - PAD * 2;
  const spacing = n > 1 ? usable / (n - 1) : 0;
  const xs = events.map((_, i) => (n > 1 ? PAD + i * spacing : W / 2));
  const boxW = Math.min(220, n > 1 ? spacing + 44 : 260);

  const track =
    n > 0
      ? `<line x1="${xs[0].toFixed(1)}" y1="${lineY}" x2="${xs[n - 1].toFixed(1)}" y2="${lineY}" stroke="${DIAGRAM_INK.connector}" stroke-width="4" stroke-linecap="round"/>`
      : '';

  const nodes = events
    .map((e, i) => {
      const c = resolveDiagramColor(e.accent ?? defaultAccent);
      const x = xs[i];
      const isD = e.deadline === true;
      const date = `<text x="${x.toFixed(1)}" y="${(lineY - 34).toFixed(1)}" text-anchor="middle" fill="${c.text}" font-size="13" font-weight="700" letter-spacing="0.04em">${esc(e.date)}</text>`;
      let node: string;
      if (isD) {
        const s = 22;
        node =
          `<rect x="${(x - s / 2).toFixed(1)}" y="${(lineY - s / 2).toFixed(1)}" width="${s}" height="${s}" rx="5" fill="${c.stroke}" stroke="#FFFFFF" stroke-width="3"/>` +
          `<path d="M${(x - 4).toFixed(1)} ${(lineY - 5).toFixed(1)} h8 v5 h-8 z" fill="#FFFFFF" opacity="0.92"/>`;
      } else {
        node = `<circle cx="${x.toFixed(1)}" cy="${lineY}" r="9" fill="${c.stroke}" stroke="#FFFFFF" stroke-width="3"/>`;
      }
      const desc = e.description
        ? `<div style="font-size:12px;line-height:1.35;color:${DIAGRAM_INK.meta};margin-top:3px;">${esc(e.description)}</div>`
        : '';
      const label =
        `<foreignObject x="${(x - boxW / 2).toFixed(1)}" y="${(lineY + 16).toFixed(1)}" width="${boxW.toFixed(1)}" height="${(H - lineY - 20).toFixed(1)}">` +
        `<div xmlns="http://www.w3.org/1999/xhtml" style="text-align:center;font-family:${FONT_BODY};">` +
        `<div style="font-size:${isD ? 16 : 15}px;font-weight:${isD ? 750 : 700};line-height:1.2;color:${DIAGRAM_INK.title};">${esc(e.title)}</div>` +
        desc +
        `</div></foreignObject>`;
      return date + node + label;
    })
    .join('');

  const svg =
    `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" font-family="${FONT_BODY}" role="img" style="width:100%;max-width:${W}px;height:auto;">` +
    track +
    nodes +
    `</svg>`;
  const body = `<div style="display:flex;justify-content:center;">${svg}</div>`;
  return frame(body, input.caption, 20);
}

// ---- SequenceDiagram --------------------------------------------------------

export interface SequenceActor {
  id: string;
  label: string;
  accent?: string;
}

export interface SequenceMessage {
  from: string;
  to: string;
  label?: string;
  dashed?: boolean;
}

export interface SequenceInput {
  actors?: SequenceActor[];
  messages?: SequenceMessage[];
  lifelines?: boolean;
  messageSpacing?: number;
  caption?: string;
}

export function sequenceMarkup(input: SequenceInput): string {
  const actors = Array.isArray(input.actors) ? input.actors : [];
  const messages = Array.isArray(input.messages) ? input.messages : [];
  const showLifelines = input.lifelines !== false;
  const spacing = input.messageSpacing && input.messageSpacing > 0 ? input.messageSpacing : 54;

  const ACTOR_W = 130;
  const ACTOR_H = 46;
  const ACTOR_SP = 180;
  const topPad = 14;
  const msgStartY = topPad + ACTOR_H + 40;
  const W = Math.max(ACTOR_SP, actors.length * ACTOR_SP);
  const H = msgStartY + messages.length * spacing + 30;
  const ink = '#334155';

  const xOf = (id: string): number => {
    const i = actors.findIndex((a) => a.id === id);
    return i === -1 ? 0 : (i + 0.5) * ACTOR_SP;
  };

  const lifelines = showLifelines
    ? actors
        .map((a) => {
          const x = xOf(a.id);
          return `<line x1="${x}" y1="${topPad + ACTOR_H}" x2="${x}" y2="${H - 10}" stroke="${DIAGRAM_INK.connector}" stroke-width="1.5" stroke-dasharray="6 5"/>`;
        })
        .join('')
    : '';

  const boxes = actors
    .map((a) => {
      const x = xOf(a.id);
      const c = resolveDiagramColor(a.accent);
      return (
        `<rect x="${(x - ACTOR_W / 2).toFixed(1)}" y="${topPad}" width="${ACTOR_W}" height="${ACTOR_H}" rx="8" fill="${c.fill}" stroke="${c.stroke}" stroke-width="2"/>` +
        `<text x="${x.toFixed(1)}" y="${(topPad + ACTOR_H / 2 + 5).toFixed(1)}" text-anchor="middle" fill="${DIAGRAM_INK.title}" font-size="15" font-weight="700">${esc(a.label)}</text>`
      );
    })
    .join('');

  const AR = 8;
  const msgs = messages
    .map((m, i) => {
      const fromX = xOf(m.from);
      const toX = xOf(m.to);
      const y = msgStartY + i * spacing;
      const dash = m.dashed ? ' stroke-dasharray="6 4"' : '';
      if (m.from === m.to) {
        const lw = 44;
        const lh = 26;
        const path = `M ${fromX} ${y} L ${fromX + lw} ${y} L ${fromX + lw} ${y + lh} L ${fromX + AR} ${y + lh}`;
        const head = `${fromX},${y + lh} ${fromX + AR},${y + lh - AR / 2} ${fromX + AR},${y + lh + AR / 2}`;
        const lbl = m.label
          ? `<text x="${fromX + lw + 8}" y="${y + lh / 2 + 4}" text-anchor="start" fill="${ink}" font-size="13">${esc(m.label)}</text>`
          : '';
        return `<path d="${path}" fill="none" stroke="${ink}" stroke-width="2"${dash}/><polygon points="${head}" fill="${ink}"/>${lbl}`;
      }
      const ltr = toX > fromX;
      const endX = ltr ? toX - AR : toX + AR;
      const head = ltr
        ? `${toX},${y} ${toX - AR},${y - AR / 2} ${toX - AR},${y + AR / 2}`
        : `${toX},${y} ${toX + AR},${y - AR / 2} ${toX + AR},${y + AR / 2}`;
      const lbl = m.label
        ? `<text x="${((fromX + toX) / 2).toFixed(1)}" y="${y - 8}" text-anchor="middle" fill="${ink}" font-size="13">${esc(m.label)}</text>`
        : '';
      return `<line x1="${fromX}" y1="${y}" x2="${endX}" y2="${y}" stroke="${ink}" stroke-width="2" stroke-linecap="round"${dash}/><polygon points="${head}" fill="${ink}"/>${lbl}`;
    })
    .join('');

  const svg =
    `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" font-family="${FONT_BODY}" role="img" style="width:100%;max-width:${W}px;height:auto;">` +
    lifelines +
    boxes +
    msgs +
    `</svg>`;
  const body = `<div style="display:flex;justify-content:center;">${svg}</div>`;
  return frame(body, input.caption, 20);
}

// ---- Quadrants --------------------------------------------------------------

export interface QuadrantAxis {
  label: string;
  low?: string;
  high?: string;
}

export interface QuadrantCell {
  label?: string;
  accent?: string;
}

export interface QuadrantItem {
  label: string;
  x: number;
  y: number;
  accent?: string;
}

export interface QuadrantsInput {
  xAxis?: QuadrantAxis;
  yAxis?: QuadrantAxis;
  items?: QuadrantItem[];
  quadrants?: {
    topLeft?: QuadrantCell;
    topRight?: QuadrantCell;
    bottomLeft?: QuadrantCell;
    bottomRight?: QuadrantCell;
  };
  caption?: string;
}

export function quadrantsMarkup(input: QuadrantsInput): string {
  const S = 440;
  const ML = 84;
  const MR = 20;
  const MT = 20;
  const MB = 66;
  const W = ML + S + MR;
  const H = MT + S + MB;
  const x0 = ML;
  const y0 = MT;
  const midX = x0 + S / 2;
  const midY = y0 + S / 2;
  const items = Array.isArray(input.items) ? input.items : [];
  const q = input.quadrants ?? {};
  const xAxis = input.xAxis ?? { label: '' };
  const yAxis = input.yAxis ?? { label: '' };

  const cells = [
    { cfg: q.topLeft, cx: x0, cy: y0, anchor: 'start', tx: x0 + 16, ty: y0 + 26 },
    { cfg: q.topRight, cx: midX, cy: y0, anchor: 'end', tx: x0 + S - 16, ty: y0 + 26 },
    { cfg: q.bottomLeft, cx: x0, cy: midY, anchor: 'start', tx: x0 + 16, ty: y0 + S - 16 },
    { cfg: q.bottomRight, cx: midX, cy: midY, anchor: 'end', tx: x0 + S - 16, ty: y0 + S - 16 },
  ];

  const tints = cells
    .map((c) => {
      if (!c.cfg?.accent) return '';
      const col = resolveDiagramColor(c.cfg.accent);
      return `<rect x="${c.cx}" y="${c.cy}" width="${S / 2}" height="${S / 2}" fill="${col.fill}"/>`;
    })
    .join('');

  const labels = cells
    .map((c) => {
      if (!c.cfg?.label) return '';
      const col = c.cfg.accent ? resolveDiagramColor(c.cfg.accent).text : DIAGRAM_INK.meta;
      return `<text x="${c.tx}" y="${c.ty}" text-anchor="${c.anchor}" fill="${col}" font-size="14" font-weight="700" letter-spacing="0.06em">${esc(c.cfg.label.toUpperCase())}</text>`;
    })
    .join('');

  const frameRect =
    `<rect x="${x0}" y="${y0}" width="${S}" height="${S}" rx="14" fill="none" stroke="#CBD5E1" stroke-width="2"/>` +
    `<line x1="${midX}" y1="${y0}" x2="${midX}" y2="${y0 + S}" stroke="#CBD5E1" stroke-width="1.5" stroke-dasharray="5 5"/>` +
    `<line x1="${x0}" y1="${midY}" x2="${x0 + S}" y2="${midY}" stroke="#CBD5E1" stroke-width="1.5" stroke-dasharray="5 5"/>`;

  const dots = items
    .map((it) => {
      const cx = x0 + Math.max(0, Math.min(1, it.x)) * S;
      const cy = y0 + (1 - Math.max(0, Math.min(1, it.y))) * S;
      const col = resolveDiagramColor(it.accent ?? 'navy');
      const bw = it.label.length * 6.6 + 16;
      const toLeft = cx > x0 + S - bw - 24;
      const bx = toLeft ? cx - 14 - bw : cx + 14;
      const anchor = toLeft ? 'end' : 'start';
      const tx = toLeft ? cx - 20 : cx + 20;
      return (
        `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="11" fill="none" stroke="${col.stroke}" stroke-width="1.5" opacity="0.3"/>` +
        `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="7" fill="${col.stroke}"/>` +
        `<rect x="${bx.toFixed(1)}" y="${(cy - 11).toFixed(1)}" width="${bw.toFixed(1)}" height="22" rx="6" fill="#FFFFFF" stroke="#E2E8F0" stroke-width="1"/>` +
        `<text x="${tx.toFixed(1)}" y="${(cy + 4).toFixed(1)}" text-anchor="${anchor}" fill="${DIAGRAM_INK.title}" font-size="12.5" font-weight="600">${esc(it.label)}</text>`
      );
    })
    .join('');

  const yLabel = yAxis.label
    ? `<text x="${x0 - 46}" y="${midY}" text-anchor="middle" fill="${DIAGRAM_INK.title}" font-size="16" font-weight="700" letter-spacing="0.08em" transform="rotate(-90 ${x0 - 46} ${midY})">${esc(yAxis.label.toUpperCase())}</text>`
    : '';
  const yHigh = yAxis.high
    ? `<text x="${x0 - 12}" y="${y0 + 16}" text-anchor="end" fill="${DIAGRAM_INK.meta}" font-size="12" font-weight="600">${esc(yAxis.high)}</text>`
    : '';
  const yLow = yAxis.low
    ? `<text x="${x0 - 12}" y="${y0 + S - 6}" text-anchor="end" fill="${DIAGRAM_INK.meta}" font-size="12" font-weight="600">${esc(yAxis.low)}</text>`
    : '';
  const xLabel = xAxis.label
    ? `<text x="${midX}" y="${y0 + S + 46}" text-anchor="middle" fill="${DIAGRAM_INK.title}" font-size="16" font-weight="700" letter-spacing="0.08em">${esc(xAxis.label.toUpperCase())}</text>`
    : '';
  const xLow = xAxis.low
    ? `<text x="${x0 + 4}" y="${y0 + S + 22}" text-anchor="start" fill="${DIAGRAM_INK.meta}" font-size="12" font-weight="600">${esc(xAxis.low)}</text>`
    : '';
  const xHigh = xAxis.high
    ? `<text x="${x0 + S - 4}" y="${y0 + S + 22}" text-anchor="end" fill="${DIAGRAM_INK.meta}" font-size="12" font-weight="600">${esc(xAxis.high)}</text>`
    : '';

  const svg =
    `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" font-family="${FONT_BODY}" role="img" style="width:100%;max-width:${W}px;height:auto;">` +
    tints +
    frameRect +
    labels +
    dots +
    yLabel +
    yHigh +
    yLow +
    xLabel +
    xLow +
    xHigh +
    `</svg>`;
  const body = `<div style="display:flex;justify-content:center;">${svg}</div>`;
  return frame(body, input.caption, 20);
}

// ---- ActivityDiagram --------------------------------------------------------

export type ActivityNodeType = 'start' | 'end' | 'action' | 'decision' | 'fork' | 'join';

export interface ActivityNode {
  id: string;
  type: ActivityNodeType;
  label?: string;
  accent?: string;
  column?: number;
  row?: number;
}

export interface ActivityEdge {
  from: string;
  to: string;
  label?: string;
}

export interface ActivityInput {
  nodes?: ActivityNode[];
  edges?: ActivityEdge[];
  rowSpacing?: number;
  columnSpacing?: number;
  caption?: string;
}

const ACT_W = 150;
const ACT_H = 46;
const DEC = 58;
const SE = 22;
const FJ_W = 110;
const FJ_H = 6;

export function activityMarkup(input: ActivityInput): string {
  const nodes = Array.isArray(input.nodes) ? input.nodes : [];
  const edges = Array.isArray(input.edges) ? input.edges : [];
  const rowSpacing = input.rowSpacing && input.rowSpacing > 0 ? input.rowSpacing : 92;
  const columnSpacing = input.columnSpacing && input.columnSpacing > 0 ? input.columnSpacing : 180;
  const ink = '#475569';

  const pos = new Map<string, { x: number; y: number }>();
  nodes.forEach((node, i) => {
    const col = node.column ?? 0;
    const row = node.row ?? i;
    pos.set(node.id, { x: col * columnSpacing, y: row * rowSpacing });
  });
  const ps = Array.from(pos.values());
  if (ps.length === 0) return frame('<svg viewBox="0 0 10 10" xmlns="http://www.w3.org/2000/svg"></svg>', input.caption, 20);

  const minX = Math.min(...ps.map((p) => p.x)) - columnSpacing;
  const maxX = Math.max(...ps.map((p) => p.x)) + columnSpacing;
  const maxY = Math.max(...ps.map((p) => p.y)) + rowSpacing;
  const offsetX = -minX;
  const width = maxX - minX;
  const TOPPAD = 30;

  const px = (id: string) => (pos.get(id)?.x ?? 0) + offsetX;
  const py = (id: string) => pos.get(id)?.y ?? 0;
  const byId = new Map(nodes.map((n) => [n.id, n]));

  const boundsOf = (node: ActivityNode) => {
    const x = px(node.id);
    const y = py(node.id);
    let hw = 0;
    let hh = 0;
    switch (node.type) {
      case 'start':
      case 'end':
        hw = SE / 2;
        hh = SE / 2;
        break;
      case 'action':
        hw = ACT_W / 2;
        hh = ACT_H / 2;
        break;
      case 'decision':
        hw = DEC / 2;
        hh = DEC / 2;
        break;
      case 'fork':
      case 'join':
        hw = FJ_W / 2;
        hh = FJ_H / 2;
        break;
    }
    return {
      top: { x, y: y - hh },
      bottom: { x, y: y + hh },
      left: { x: x - hw, y },
      right: { x: x + hw, y },
    };
  };

  const AR = 8;
  const edgeSvg = edges
    .map((e) => {
      const fn = byId.get(e.from);
      const tn = byId.get(e.to);
      if (!fn || !tn) return '';
      const fb = boundsOf(fn);
      const tb = boundsOf(tn);
      const dx = (pos.get(e.to)?.x ?? 0) - (pos.get(e.from)?.x ?? 0);
      const dy = (pos.get(e.to)?.y ?? 0) - (pos.get(e.from)?.y ?? 0);
      let sp: { x: number; y: number };
      let ep: { x: number; y: number };
      if (Math.abs(dy) > Math.abs(dx) || dy > 0) {
        if (dy > 0) {
          sp = fb.bottom;
          ep = tb.top;
        } else {
          sp = fb.top;
          ep = tb.bottom;
        }
      } else if (dx > 0) {
        sp = fb.right;
        ep = tb.left;
      } else {
        sp = fb.left;
        ep = tb.right;
      }
      const midYy = (sp.y + ep.y) / 2;
      const vertical = Math.abs(sp.x - ep.x) < 5;
      const horizontal = Math.abs(sp.y - ep.y) < 5;
      let path: string;
      if (vertical) {
        path = `M ${sp.x} ${sp.y} L ${ep.x} ${ep.y - AR}`;
      } else if (horizontal) {
        const off = ep.x > sp.x ? -AR : AR;
        path = `M ${sp.x} ${sp.y} L ${ep.x + off} ${ep.y}`;
      } else {
        path = `M ${sp.x} ${sp.y} L ${sp.x} ${midYy} L ${ep.x} ${midYy} L ${ep.x} ${ep.y - AR}`;
      }
      const isVert = vertical || !horizontal;
      let head: string;
      if (isVert) {
        head = `${ep.x},${ep.y} ${ep.x - AR / 2},${ep.y - AR} ${ep.x + AR / 2},${ep.y - AR}`;
      } else if (ep.x > sp.x) {
        head = `${ep.x},${ep.y} ${ep.x - AR},${ep.y - AR / 2} ${ep.x - AR},${ep.y + AR / 2}`;
      } else {
        head = `${ep.x},${ep.y} ${ep.x + AR},${ep.y - AR / 2} ${ep.x + AR},${ep.y + AR / 2}`;
      }
      const isOrth = !vertical && !horizontal;
      const lx = (sp.x + ep.x) / 2 + (dx > 0 ? 12 : dx < 0 ? -12 : 0);
      const ly = isOrth ? midYy - 8 : sp.y + 15;
      const anchor = dx > 0 ? 'start' : dx < 0 ? 'end' : 'middle';
      const lbl = e.label
        ? `<text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="${anchor}" fill="${DIAGRAM_INK.meta}" font-size="12" font-style="italic">${esc(e.label)}</text>`
        : '';
      return `<path d="${path}" fill="none" stroke="${ink}" stroke-width="2"/><polygon points="${head}" fill="${ink}"/>${lbl}`;
    })
    .join('');

  const nodeSvg = nodes
    .map((node) => {
      const x = px(node.id);
      const y = py(node.id);
      const c = resolveDiagramColor(node.accent);
      switch (node.type) {
        case 'start':
          return `<circle cx="${x}" cy="${y}" r="${SE / 2}" fill="#334155"/>`;
        case 'end':
          return (
            `<circle cx="${x}" cy="${y}" r="${SE / 2}" fill="none" stroke="#334155" stroke-width="3"/>` +
            `<circle cx="${x}" cy="${y}" r="${SE / 2 - 5}" fill="#334155"/>`
          );
        case 'action':
          return (
            `<rect x="${(x - ACT_W / 2).toFixed(1)}" y="${(y - ACT_H / 2).toFixed(1)}" width="${ACT_W}" height="${ACT_H}" rx="10" fill="${c.fill}" stroke="${c.stroke}" stroke-width="2"/>` +
            `<text x="${x}" y="${(y + 5).toFixed(1)}" text-anchor="middle" fill="${DIAGRAM_INK.title}" font-size="13.5" font-weight="600">${esc(node.label ?? '')}</text>`
          );
        case 'decision':
          return (
            `<polygon points="${x},${y - DEC / 2} ${x + DEC / 2},${y} ${x},${y + DEC / 2} ${x - DEC / 2},${y}" fill="${c.fill}" stroke="${c.stroke}" stroke-width="2"/>` +
            `<text x="${x}" y="${(y + 4).toFixed(1)}" text-anchor="middle" fill="${DIAGRAM_INK.title}" font-size="12" font-weight="600">${esc(node.label ?? '')}</text>`
          );
        case 'fork':
        case 'join':
          return `<rect x="${(x - FJ_W / 2).toFixed(1)}" y="${(y - FJ_H / 2).toFixed(1)}" width="${FJ_W}" height="${FJ_H}" rx="2" fill="#334155"/>`;
        default:
          return '';
      }
    })
    .join('');

  const svg =
    `<svg viewBox="0 ${-TOPPAD} ${width} ${maxY + TOPPAD}" xmlns="http://www.w3.org/2000/svg" font-family="${FONT_BODY}" role="img" style="width:100%;max-width:${width}px;height:auto;">` +
    edgeSvg +
    nodeSvg +
    `</svg>`;
  const body = `<div style="display:flex;justify-content:center;">${svg}</div>`;
  return frame(body, input.caption, 20);
}

// ---- BlockDiagram -----------------------------------------------------------

export interface BlockItem {
  label: string;
  sub?: string;
  accent?: string;
  dashed?: boolean;
}

export interface BlockNode {
  id: string;
  /** 0-based grid row/column. Placement is explicit — no auto-layout. */
  row: number;
  column: number;
  /** Stretch vertically across this many rows (default 1). */
  rowSpan?: number;
  title: string;
  sub?: string;
  /** Small uppercase role label rendered above the box (TRUTH, TRANSPORT…). */
  kicker?: string;
  /** Chips inside the box: plain strings or { label, sub?, accent?, dashed? }. */
  items?: (string | BlockItem)[];
  accent?: string;
  /** Dashed border + white fill — proposed / human / not-yet-real. */
  dashed?: boolean;
  /** Slightly heavier border, for the diagram's focal node. */
  emphasis?: boolean;
}

export interface BlockEdge {
  from: string;
  to: string;
  /** Split on \n for multi-line labels. */
  label?: string;
  dashed?: boolean;
  accent?: string;
  fromSide?: 'top' | 'bottom' | 'left' | 'right';
  toSide?: 'top' | 'bottom' | 'left' | 'right';
  /** Fraction 0..1 along the chosen side (default 0.5 = midpoint). */
  fromAt?: number;
  toAt?: number;
  /** Quadratic curve instead of a straight/elbow line — for back-edges. */
  curve?: boolean;
}

export interface BlockInput {
  nodes?: BlockNode[];
  edges?: BlockEdge[];
  caption?: string;
}

const BLK_W = 200;
const BLK_GAP_X = 110;
const BLK_GAP_Y = 62;
const BLK_PAD_X = 15;

export function blockMarkup(input: BlockInput): string {
  const nodes = Array.isArray(input.nodes) ? input.nodes : [];
  const edges = Array.isArray(input.edges) ? input.edges : [];
  if (nodes.length === 0)
    return frame('<svg viewBox="0 0 10 10" xmlns="http://www.w3.org/2000/svg"></svg>', input.caption, 20);

  const items = (n: BlockNode): BlockItem[] =>
    (n.items ?? []).map((it) => (typeof it === 'string' ? { label: it } : it));

  // Greedy word-wrap into at most `maxLines` lines that fit the box width.
  const wrap = (text: string, fs: number, maxLines: number): string[] => {
    const maxW = BLK_W - 2 * BLK_PAD_X + 6;
    const charW = 0.52 * fs;
    const words = String(text).split(/\s+/);
    const lines: string[] = [];
    let cur = '';
    for (const w of words) {
      const cand = cur ? `${cur} ${w}` : w;
      if (cand.length * charW > maxW && cur) {
        lines.push(cur);
        cur = w;
      } else {
        cur = cand;
      }
    }
    if (cur) lines.push(cur);
    if (lines.length > maxLines) {
      const head = lines.slice(0, maxLines - 1);
      head.push(lines.slice(maxLines - 1).join(' '));
      return head;
    }
    return lines;
  };

  // ---- measure ----
  const subLinesOf = new Map<string, string[]>();
  const naturalH = (n: BlockNode): number => {
    const subLines = n.sub ? wrap(n.sub, 10.5, 2) : [];
    subLinesOf.set(n.id, subLines);
    let h = 24 + 10; // title baseline + descent
    h += subLines.length * 15;
    const its = items(n);
    if (its.length) {
      h += 8;
      for (const it of its) h += (it.sub ? 48 : 28) + 6;
      h -= 6;
    }
    return h + 14;
  };

  const nRows = Math.max(...nodes.map((n) => n.row + (n.rowSpan ?? 1)));
  const nCols = Math.max(...nodes.map((n) => n.column)) + 1;
  const rowH: number[] = new Array(nRows).fill(44);
  for (const n of nodes) {
    if ((n.rowSpan ?? 1) === 1) rowH[n.row] = Math.max(rowH[n.row], naturalH(n));
  }
  // Grow a span's last row if the spanned rows don't fit its content.
  for (const n of nodes) {
    const span = n.rowSpan ?? 1;
    if (span > 1) {
      const have = rowH.slice(n.row, n.row + span).reduce((a, b) => a + b, 0) + (span - 1) * BLK_GAP_Y;
      const need = naturalH(n);
      if (need > have) rowH[n.row + span - 1] += need - have;
    }
  }

  const kickerRow = new Array(nRows).fill(false);
  for (const n of nodes) if (n.kicker) kickerRow[n.row] = true;
  const rowY: number[] = [];
  let y = 16;
  for (let r = 0; r < nRows; r++) {
    if (kickerRow[r] && r === 0) y += 14;
    rowY.push(y);
    y += rowH[r] + BLK_GAP_Y;
  }
  const HEIGHT = y - BLK_GAP_Y + 16;
  const WIDTH = 20 * 2 + nCols * BLK_W + (nCols - 1) * BLK_GAP_X;

  const rect = (n: BlockNode) => {
    const span = n.rowSpan ?? 1;
    const h = rowH.slice(n.row, n.row + span).reduce((a, b) => a + b, 0) + (span - 1) * BLK_GAP_Y;
    return { x: 20 + n.column * (BLK_W + BLK_GAP_X), y: rowY[n.row], w: BLK_W, h };
  };
  const byId = new Map(nodes.map((n) => [n.id, n]));

  // ---- edges ----
  const inkEdge = '#5a6578';
  const markerColors = new Map<string, string>();
  const markerBase = `bf-blk-arrow-${markerSeq++}`;
  const markerFor = (color: string): string => {
    if (!markerColors.has(color)) markerColors.set(color, `${markerBase}-${markerColors.size}`);
    return markerColors.get(color)!;
  };

  type Side = 'top' | 'bottom' | 'left' | 'right';
  const anchor = (n: BlockNode, side: Side, at: number) => {
    const r = rect(n);
    switch (side) {
      case 'top': return { x: r.x + r.w * at, y: r.y };
      case 'bottom': return { x: r.x + r.w * at, y: r.y + r.h };
      case 'left': return { x: r.x, y: r.y + r.h * at };
      case 'right': return { x: r.x + r.w, y: r.y + r.h * at };
    }
  };

  // Opposite-direction edges between the same pair get offset so they run
  // side by side instead of overlapping.
  const pairCount = new Map<string, number>();
  for (const e of edges) {
    const k = [e.from, e.to].sort().join('|');
    pairCount.set(k, (pairCount.get(k) ?? 0) + 1);
  }

  // Labels render in a separate layer above the nodes, with a white halo, so
  // they stay readable when a short edge's label overhangs its boxes or an
  // arrow crosses the text.
  const HALO = ` paint-order="stroke" stroke="var(--surface,#ffffff)" stroke-width="3"`;
  const edgeLabels: string[] = [];
  const edgeSvg = edges
    .map((e) => {
      const fn = byId.get(e.from);
      const tn = byId.get(e.to);
      if (!fn || !tn) return '';
      const fr = rect(fn);
      const tr = rect(tn);
      const fcx = fr.x + fr.w / 2, fcy = fr.y + fr.h / 2;
      const tcx = tr.x + tr.w / 2, tcy = tr.y + tr.h / 2;
      const dx = tcx - fcx, dy = tcy - fcy;
      const horizontal = Math.abs(dx) >= Math.abs(dy);
      const fSide: Side = e.fromSide ?? (horizontal ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'bottom' : 'top');
      const tSide: Side = e.toSide ?? (horizontal ? (dx > 0 ? 'left' : 'right') : dy > 0 ? 'top' : 'bottom');
      let sp = anchor(fn, fSide, e.fromAt ?? 0.5);
      let ep = anchor(tn, tSide, e.toAt ?? 0.5);

      const paired = (pairCount.get([e.from, e.to].sort().join('|')) ?? 0) > 1 && !e.curve;
      let pairShift = 0;
      if (paired) {
        // Downward/rightward member shifts negative, its reverse positive.
        pairShift = (horizontal ? dx > 0 : dy > 0) ? -30 : 30;
        if (horizontal) { sp = { ...sp, y: sp.y + pairShift }; ep = { ...ep, y: ep.y + pairShift }; }
        else { sp = { ...sp, x: sp.x + pairShift }; ep = { ...ep, x: ep.x + pairShift }; }
      } else if (!e.curve && e.fromAt === undefined && e.toAt === undefined) {
        // Clamp to a straight line when the source's anchor level falls inside
        // the target's extent — a horizontal edge into a taller box should hit
        // it at the source's height, not slope to its midpoint.
        if (horizontal && sp.y >= tr.y + 14 && sp.y <= tr.y + tr.h - 14) ep = { ...ep, y: sp.y };
        else if (!horizontal && sp.x >= tr.x + 14 && sp.x <= tr.x + tr.w - 14) ep = { ...ep, x: sp.x };
      }

      const color = e.accent ? resolveDiagramColor(e.accent).stroke : inkEdge;
      const mk = markerFor(color);
      const dash = e.dashed ? ` stroke-dasharray="4 3"` : '';
      const sw = e.accent ? 2 : 1.5;

      let path: string;
      let mid: { x: number; y: number };
      if (e.curve) {
        const mx = (sp.x + ep.x) / 2, my = (sp.y + ep.y) / 2;
        const len = Math.hypot(ep.x - sp.x, ep.y - sp.y) || 1;
        const nx = -(ep.y - sp.y) / len, ny = (ep.x - sp.x) / len;
        const cx = mx + nx * 36, cy = my + ny * 36;
        path = `M ${sp.x.toFixed(1)} ${sp.y.toFixed(1)} Q ${cx.toFixed(1)} ${cy.toFixed(1)} ${ep.x.toFixed(1)} ${ep.y.toFixed(1)}`;
        mid = { x: (mx + cx) / 2, y: (my + cy) / 2 };
      } else if (Math.abs(sp.x - ep.x) < 1 || Math.abs(sp.y - ep.y) < 1) {
        path = `M ${sp.x.toFixed(1)} ${sp.y.toFixed(1)} L ${ep.x.toFixed(1)} ${ep.y.toFixed(1)}`;
        mid = { x: (sp.x + ep.x) / 2, y: (sp.y + ep.y) / 2 };
      } else if (fSide === 'left' || fSide === 'right') {
        // One elbow: run horizontally, then vertically into the target.
        path = `M ${sp.x.toFixed(1)} ${sp.y.toFixed(1)} L ${ep.x.toFixed(1)} ${sp.y.toFixed(1)} L ${ep.x.toFixed(1)} ${ep.y.toFixed(1)}`;
        mid = { x: (sp.x + ep.x) / 2, y: sp.y };
      } else {
        path = `M ${sp.x.toFixed(1)} ${sp.y.toFixed(1)} L ${sp.x.toFixed(1)} ${ep.y.toFixed(1)} L ${ep.x.toFixed(1)} ${ep.y.toFixed(1)}`;
        mid = { x: sp.x, y: (sp.y + ep.y) / 2 };
      }

      if (e.label) {
        const lines = String(e.label).split('\n');
        const vertical = !e.curve && Math.abs(sp.x - ep.x) < 1;
        let lx: number, ly: number, anchorAttr: string;
        if (vertical) {
          const left = pairShift < 0;
          lx = mid.x + (left ? -10 : 10);
          anchorAttr = left ? 'end' : 'start';
          ly = mid.y + 3 - ((lines.length - 1) * 12) / 2;
        } else {
          lx = mid.x;
          anchorAttr = 'middle';
          ly = mid.y - 8 - (lines.length - 1) * 12 + (e.curve ? -2 : 0);
        }
        edgeLabels.push(
          lines
            .map(
              (line, i) =>
                `<text x="${lx.toFixed(1)}" y="${(ly + i * 12).toFixed(1)}" text-anchor="${anchorAttr}" fill="${e.accent ? color : DIAGRAM_INK.meta}" font-size="10"${HALO}>${esc(line)}</text>`,
            )
            .join(''),
        );
      }
      return `<path d="${path}" fill="none" stroke="${color}" stroke-width="${sw}"${dash} marker-end="url(#${mk})"/>`;
    })
    .join('');

  // ---- nodes ----
  const fitLine = (text: string, base: number, charW: number): number => {
    const avail = BLK_W - 2 * BLK_PAD_X + 6;
    const est = text.length * charW * base;
    return est > avail ? Math.max(8.5, avail / (text.length * charW)) : base;
  };

  const nodeSvg = nodes
    .map((n) => {
      const r = rect(n);
      const c = resolveDiagramColor(n.accent ?? 'slate');
      const fill = n.dashed ? '#fff' : c.fill;
      const dash = n.dashed ? ` stroke-dasharray="6 4"` : '';
      const sw = n.emphasis ? 2 : 1.5;
      const cx = r.x + r.w / 2;
      let svg = '';
      if (n.kicker)
        svg += `<text x="${cx}" y="${(r.y - 8).toFixed(1)}" text-anchor="middle" font-size="9" font-weight="700" letter-spacing="1.5" fill="#8a94a6"${HALO}>${esc(n.kicker.toUpperCase())}</text>`;
      svg += `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" rx="10" fill="${fill}" stroke="${c.stroke}" stroke-width="${sw}"${dash}/>`;
      const titleFs = fitLine(n.title, 12.5, 0.6);
      svg += `<text x="${cx}" y="${(r.y + 24).toFixed(1)}" text-anchor="middle" font-size="${titleFs.toFixed(1)}" font-weight="700" fill="${c.text}">${esc(n.title)}</text>`;
      const subLines = subLinesOf.get(n.id) ?? [];
      subLines.forEach((line, i) => {
        svg += `<text x="${cx}" y="${(r.y + 42 + i * 15).toFixed(1)}" text-anchor="middle" font-size="10.5" fill="${DIAGRAM_INK.meta}">${esc(line)}</text>`;
      });
      let iy = r.y + 24 + 10 + subLines.length * 15 + 8;
      for (const it of items(n)) {
        const ih = it.sub ? 48 : 28;
        const ic = it.accent ? resolveDiagramColor(it.accent) : null;
        const idash = it.dashed ? ` stroke-dasharray="5 3"` : '';
        svg += `<rect x="${r.x + BLK_PAD_X}" y="${iy.toFixed(1)}" width="${r.w - 2 * BLK_PAD_X}" height="${ih}" rx="6" fill="${it.accent && !it.dashed ? ic!.fill : '#fff'}" stroke="${ic ? ic.stroke : '#c8d1de'}"${idash}/>`;
        const labelFs = fitLine(it.label, 10.5, 0.56);
        if (it.sub) {
          svg += `<text x="${cx}" y="${(iy + 19).toFixed(1)}" text-anchor="middle" font-size="${labelFs.toFixed(1)}" font-weight="650" fill="${ic ? ic.text : DIAGRAM_INK.title}">${esc(it.label)}</text>`;
          const subFs = fitLine(it.sub, 10, 0.52);
          svg += `<text x="${cx}" y="${(iy + 36).toFixed(1)}" text-anchor="middle" font-size="${subFs.toFixed(1)}" fill="${DIAGRAM_INK.meta}">${esc(it.sub)}</text>`;
        } else {
          svg += `<text x="${cx}" y="${(iy + 18).toFixed(1)}" text-anchor="middle" font-size="${labelFs.toFixed(1)}" fill="${ic ? ic.text : DIAGRAM_INK.title}">${esc(it.label)}</text>`;
        }
        iy += ih + 6;
      }
      return svg;
    })
    .join('');

  const markers = Array.from(markerColors.entries())
    .map(
      ([color, id]) =>
        `<marker id="${id}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="${color}"/></marker>`,
    )
    .join('');

  const svg =
    `<svg viewBox="0 0 ${WIDTH} ${HEIGHT}" xmlns="http://www.w3.org/2000/svg" font-family="${FONT_BODY}" role="img" style="width:100%;max-width:${WIDTH}px;height:auto;">` +
    `<defs>${markers}</defs>` +
    edgeSvg +
    nodeSvg +
    edgeLabels.join('') +
    `</svg>`;
  const body = `<div style="display:flex;justify-content:center;">${svg}</div>`;
  return frame(body, input.caption, 20);
}
