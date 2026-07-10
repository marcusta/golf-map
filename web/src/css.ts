export { s } from '@basics/core/client/ui/css';
import { s } from '@basics/core/client/ui/css';
import { t } from './theme';

// ============================================================
// Links & Loam component recipes.
// Each recipe returns a CSS declaration block for interpolation
// into a component's `static styles` template literal. Source of
// truth: the component treatment guide (sections referenced per
// recipe). Semantic/overlay tokens go through the typed t();
// theme-invariant tokens (--space-*, --radius-*, --elev-*, type,
// motion, --map-*, --data-*) come from design-tokens.css as raw
// var() references.
//
// NOTE on radius: the guide's "radius-sm" means the L&L scale
// value 8px (design-tokens --radius-sm). At runtime that var is
// shadowed by theme.ts's legacy scale entry 'radius-sm': '4px'
// (createTokens' style element is appended after design-tokens.css
// and wins the tie), so recipes use t('radius') — also 8px — for
// the guide's radius-sm until the legacy alias is retired.
// ============================================================

/**
 * Focus treatment (guide section 04): border-focus edge + 3px clay
 * glow. Apply on `:focus` / `:focus-within` of the control; pair
 * with `outline: none`.
 */
export const focusRing = () => `
    border-color: ${t('color-border-focus')};
    box-shadow: 0 0 0 3px color-mix(in srgb, ${t('color-accent-primary')} 12%, transparent);
`;

/**
 * Secondary button (guide section 04): quiet surface-raised fill,
 * hairline border, medium weight. Exactly one clay primary per
 * view — everything else uses this or ghostBtn().
 */
export const btn = (radius = t('radius')) => `
    border: 1px solid ${t('color-border-default')};
    border-radius: ${radius};
    background: ${t('color-surface-raised')};
    color: ${t('color-text-primary')};
    font-weight: 500;
    cursor: pointer;
    transition: background var(--dur-fast) var(--ease-standard),
        border-color var(--dur-fast) var(--ease-standard);
    &:hover { border-color: ${t('color-border-strong')}; background: ${t('color-surface-card')}; }
`;

/**
 * Form control chrome (guide section 04): kill the native look —
 * surface-raised fill, border-default, radius-sm, focus ring.
 */
export const input = () => `
    border: 1px solid ${t('color-border-default')};
    border-radius: ${t('radius')};
    background: ${t('color-surface-raised')};
    color: ${t('color-text-primary')};
    font-family: inherit;
    transition: border-color var(--dur-fast) var(--ease-standard),
        box-shadow var(--dur-fast) var(--ease-standard);
    &::placeholder { color: ${t('color-text-tertiary')}; }
    &:focus { outline: none; ${focusRing()} }
`;

/**
 * Card container (guide section 05): surface-card, subtle hairline,
 * elev-1. `hover: true` raises to border-strong + elev-2.
 */
export const card = (options?: { hover?: boolean }) => `
    background: ${t('color-surface-card')};
    border: 1px solid ${t('color-border-subtle')};
    border-radius: ${t('radius')};
    box-shadow: var(--elev-1);
    ${options?.hover ? `
    transition: box-shadow var(--dur-fast) var(--ease-standard),
        border-color var(--dur-fast) var(--ease-standard);
    &:hover { border-color: ${t('color-border-strong')}; box-shadow: var(--elev-2); }` : ''}
`;

/**
 * Label-above-field pattern (guide section 04). Wrap
 * `<label>Text <input/></label>`; nested controls get the input
 * chrome + focus ring.
 */
export const field = () => `
    display: flex;
    flex-direction: column;
    gap: ${s('xs')};
    font-size: 0.8rem;
    font-weight: 600;
    color: ${t('color-text-secondary')};

    & input, & select, & textarea {
        padding: ${s('sm')} ${s('md')};
        font-size: 0.875rem;
        ${input()}
    }
    &:focus-within { color: ${t('color-text-primary')}; }
`;

/**
 * Primary action button (guide section 04): the one clay action
 * per view. Accent fill, on-accent text, no border.
 */
export const primaryBtn = () => `
    border: none;
    border-radius: ${t('radius')};
    background: ${t('color-accent-primary')};
    color: ${t('color-on-accent')};
    padding: var(--space-3) var(--space-4);
    font-weight: 600;
    cursor: pointer;
    transition: background var(--dur-fast) var(--ease-standard);
    &:hover { background: ${t('color-accent-hover')}; }
`;

/**
 * Tertiary/ghost button (guide section 04): transparent, no
 * border, quiet text. For cancel/dismiss-grade actions.
 */
export const ghostBtn = () => `
    border: none;
    border-radius: ${t('radius')};
    background: transparent;
    color: ${t('color-text-secondary')};
    font-weight: 500;
    cursor: pointer;
    transition: background var(--dur-fast) var(--ease-standard),
        color var(--dur-fast) var(--ease-standard);
    &:hover {
        color: ${t('color-text-primary')};
        background: color-mix(in srgb, ${t('color-text-primary')} 6%, transparent);
    }
`;

/**
 * Destructive button (guide section 04): status-negative text on a
 * 12% tint with a 30% tint border.
 */
export const dangerBtn = () => `
    border: 1px solid color-mix(in srgb, ${t('color-status-negative')} 30%, transparent);
    border-radius: ${t('radius')};
    background: color-mix(in srgb, ${t('color-status-negative')} 12%, transparent);
    color: ${t('color-status-negative')};
    font-weight: 600;
    cursor: pointer;
    transition: background var(--dur-fast) var(--ease-standard);
    &:hover { background: color-mix(in srgb, ${t('color-status-negative')} 18%, transparent); }
`;

/**
 * Glass panel over the map (guide section 01): translucent
 * overlay-panel fill + backdrop blur, rim-light stroke, radius-lg,
 * elev-3. Terrain must read through.
 */
export const glassPanel = () => `
    background: ${t('overlay-panel-fill')};
    backdrop-filter: blur(${t('overlay-panel-blur')});
    -webkit-backdrop-filter: blur(${t('overlay-panel-blur')});
    border: 1px solid ${t('overlay-panel-stroke')};
    border-radius: var(--radius-lg);
    box-shadow: var(--elev-3);
    padding: var(--space-4);
`;

/**
 * Panel header (guide section 01): mono overline in text-tertiary —
 * never bold body text.
 */
export const panelTitle = () => `
    font: var(--text-overline);
    letter-spacing: var(--tracking-overline);
    text-transform: uppercase;
    color: ${t('color-text-tertiary')};
`;

/**
 * Numeric readout (guide section 02): every measurement is mono,
 * tabular, semibold. Put the unit in a nested
 * `<span class="metric__unit">m</span>` — it drops to text-tertiary
 * at ~80% size so the number leads.
 */
export const metric = () => `
    font-family: var(--font-mono);
    font-variant-numeric: tabular-nums;
    font-weight: 600;
    & .metric__unit {
        color: ${t('color-text-tertiary')};
        font-size: 0.8em;
        font-weight: 400;
    }
`;

/**
 * Over-map text pill (guide section 03): never set raw text on
 * imagery — dark readout scrim, blur, mono tabular, overlay-text
 * (not a theme text token).
 */
export const mapLabel = () => `
    background: ${t('overlay-readout-fill')};
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    border: 1px solid ${t('overlay-readout-stroke')};
    border-radius: ${t('radius-pill')};
    padding: 6px 12px;
    font-family: var(--font-mono);
    font-size: 12px;
    font-variant-numeric: tabular-nums;
    color: ${t('overlay-text')};
`;

/**
 * Segmented control (guide section 04): tool switchers are one
 * sunken track with a lifted active pill, not loose buttons.
 * Apply to the container; segments are the direct-child buttons.
 * Convention: mark the active segment with `aria-pressed="true"`
 * (state stays in the accessibility tree; no extra class needed).
 */
export const segmented = () => `
    display: inline-flex;
    gap: 4px;
    background: ${t('color-surface-sunken')};
    border: 1px solid ${t('color-border-default')};
    border-radius: 12px;
    padding: 4px;

    & > button {
        border: none;
        border-radius: 9px;
        background: transparent;
        color: ${t('color-text-secondary')};
        font-family: inherit;
        cursor: pointer;
        transition: background var(--dur-fast) var(--ease-standard),
            color var(--dur-fast) var(--ease-standard);
        &:hover { color: ${t('color-text-primary')}; }
        &[aria-pressed="true"] {
            background: ${t('color-surface-raised')};
            color: ${t('color-text-primary')};
            font-weight: 600;
            box-shadow: var(--elev-1);
        }
    }
`;

/**
 * Selected row/item treatment (guide section 01): clay 12% tint +
 * 1.5px inset ring — never a heavy border.
 */
export const selectedRow = () => `
    background: color-mix(in srgb, ${t('color-accent-primary')} 12%, transparent);
    box-shadow: inset 0 0 0 1.5px ${t('color-accent-primary')};
`;

/**
 * List row (guide section 05): calm surface-card row, hairline +
 * elev-1; hover raises to border-strong + elev-2.
 */
export const listRow = () => `
    background: ${t('color-surface-card')};
    border: 1px solid ${t('color-border-subtle')};
    border-radius: var(--radius-md);
    box-shadow: var(--elev-1);
    padding: var(--space-4) var(--space-5);
    transition: border-color var(--dur-fast) var(--ease-standard),
        box-shadow var(--dur-fast) var(--ease-standard);
    &:hover { border-color: ${t('color-border-strong')}; box-shadow: var(--elev-2); }
`;

/**
 * Status pill (guide section 05): quiet tinted tag — 12% tint of
 * its own colour, never loud clay. Pass a CSS color expression,
 * e.g. `statusTag(t('color-status-positive'))` for published or
 * `statusTag('var(--data-risk)')` (wheat) for draft.
 */
export const statusTag = (color: string) => `
    display: inline-block;
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: ${color};
    background: color-mix(in srgb, ${color} 12%, transparent);
    padding: 4px 9px;
    border-radius: ${t('radius-pill')};
`;
