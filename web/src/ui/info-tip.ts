import { t } from '../theme';

// ============================================================
// (i) info tips: a panel's longer explanations, kept out of the way until
// asked for. `infoTip()` is the markup — a small circled "i" that holds its
// text in a hidden child, which a template can `bind` like any other text
// (so a tip can be reactive) — and `attachInfoTips(root)` shows that text in
// a popup while the "i" is hovered or focused.
//
// The popup lives on <body>, not inside the panel: the glass panels scroll
// (overflow: auto clips an absolute child) and use backdrop-filter (which
// makes a position: fixed child fixed to the panel, not the viewport). One
// popup is shared by every tip on the page.
// ============================================================

const TIP_CLASS = 'info-tip';
const TEXT_CLASS = 'info-tip__text';
const POPUP_ID = 'info-tip-popup';
/** Gap between the "i" and the popup, and the popup and the viewport edge (px). */
const GAP = 6;

/**
 * An (i) tip. `bind` names the hidden text span for a template's bindings;
 * `text` is its static content (plain text — escaped here).
 */
export function infoTip(opts: { bind?: string; text?: string } = {}): string {
    const bind = opts.bind ? ` bind="${opts.bind}"` : '';
    return `<span class="${TIP_CLASS}" tabindex="0" role="button" aria-label="More information">`
        + `<span class="info-tip__icon" aria-hidden="true">i</span>`
        + `<span${bind} class="${TEXT_CLASS}">${escapeHtml(opts.text ?? '')}</span></span>`;
}

/** Styles for the "i" itself; include in the consuming component's `static styles`. */
export const infoTipStyles = () => `
    & .${TIP_CLASS} {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        flex: none;
        width: 16px;
        height: 16px;
        border-radius: 50%;
        border: 1px solid ${t('color-border-strong')};
        color: ${t('color-text-secondary')};
        font: italic 600 10px/1 Georgia, 'Times New Roman', serif;
        cursor: help;
        user-select: none;
        vertical-align: middle;
        &:hover, &:focus-visible {
            color: ${t('color-text-primary')};
            border-color: ${t('color-text-secondary')};
            outline: none;
        }
    }
    & .${TEXT_CLASS} { display: none; }
`;

/**
 * Show every (i) tip under `root` on hover and keyboard focus. Returns the
 * cleanup (listeners off, popup hidden).
 */
export function attachInfoTips(root: HTMLElement): () => void {
    let current: HTMLElement | null = null;

    const show = (tip: HTMLElement) => {
        const text = tip.querySelector(`.${TEXT_CLASS}`)?.textContent?.trim();
        if (!text) return;
        const popup = popupFor(tip.ownerDocument);
        popup.textContent = text;
        popup.style.display = 'block';
        place(popup, tip.getBoundingClientRect());
        tip.setAttribute('aria-describedby', POPUP_ID);
        current = tip;
    };
    const hide = () => {
        if (!current) return;
        current.removeAttribute('aria-describedby');
        const popup = current.ownerDocument.getElementById(POPUP_ID);
        if (popup) popup.style.display = 'none';
        current = null;
    };
    const tipOf = (e: Event) => (e.target as Element | null)?.closest?.(`.${TIP_CLASS}`) as HTMLElement | null;

    const onOver = (e: Event) => { const tip = tipOf(e); if (tip && tip !== current) show(tip); };
    const onOut = (e: Event) => {
        const tip = tipOf(e);
        const to = (e as MouseEvent).relatedTarget as Node | null;
        if (tip && tip === current && !(to && tip.contains(to)) && root.ownerDocument.activeElement !== tip) hide();
    };
    const onFocus = (e: Event) => { const tip = tipOf(e); if (tip) show(tip); };
    const onBlur = (e: Event) => { if (tipOf(e) === current) hide(); };
    const onKey = (e: Event) => { if ((e as KeyboardEvent).key === 'Escape') hide(); };

    root.addEventListener('mouseover', onOver);
    root.addEventListener('mouseout', onOut);
    root.addEventListener('focusin', onFocus);
    root.addEventListener('focusout', onBlur);
    root.addEventListener('keydown', onKey);
    // The "i" moves when the panel scrolls; drop the popup rather than chase it.
    root.addEventListener('scroll', hide, true);
    return () => {
        hide();
        root.removeEventListener('mouseover', onOver);
        root.removeEventListener('mouseout', onOut);
        root.removeEventListener('focusin', onFocus);
        root.removeEventListener('focusout', onBlur);
        root.removeEventListener('keydown', onKey);
        root.removeEventListener('scroll', hide, true);
    };
}

/** The page's one popup, made on first use. */
function popupFor(doc: Document): HTMLElement {
    let popup = doc.getElementById(POPUP_ID);
    if (popup) return popup;
    popup = doc.createElement('div');
    popup.id = POPUP_ID;
    popup.setAttribute('role', 'tooltip');
    Object.assign(popup.style, {
        position: 'fixed',
        zIndex: '1000',
        display: 'none',
        maxWidth: '300px',
        padding: '8px 10px',
        background: t('color-surface-raised'),
        color: t('color-text-primary'),
        border: `1px solid ${t('color-border-default')}`,
        borderRadius: '8px',
        boxShadow: 'var(--elev-3)',
        fontSize: '12px',
        lineHeight: '1.45',
        pointerEvents: 'none',
        whiteSpace: 'normal',
    } satisfies Partial<CSSStyleDeclaration>);
    doc.body.appendChild(popup);
    return popup;
}

/** Below the "i", right edges aligned, kept on screen; above it when there is no room below. */
function place(popup: HTMLElement, anchor: DOMRect): void {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const { width, height } = popup.getBoundingClientRect();
    const left = Math.min(Math.max(GAP, anchor.right - width), vw - width - GAP);
    const below = anchor.bottom + GAP;
    const top = below + height <= vh - GAP ? below : Math.max(GAP, anchor.top - GAP - height);
    popup.style.left = `${Math.round(left)}px`;
    popup.style.top = `${Math.round(top)}px`;
}

function escapeHtml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
