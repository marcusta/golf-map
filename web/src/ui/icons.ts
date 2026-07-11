// ============================================================
// Links & Loam iconography (guide section 06): ONE monoline set,
// one weight. Lucide line icons (ISC), hand-inlined — no runtime
// dependency. Every icon is stroke 1.75, round caps & joins,
// fill:none, stroke:currentColor (colour ALWAYS inherits from the
// surrounding text — never hard-coded), viewBox 0 0 24 24, sized
// on the 4-pt grid (16 / 20 / 24).
//
// Usage (template-literal HTML, same as the component templates):
//     import { icon } from '../ui/icons';
//     `<button>${icon('arrow-up')} Raise</button>`
//
// The svg is aria-hidden: when an icon sits next to a text label
// the accessible name stays the text; an icon-only button MUST
// carry its own aria-label / title.
// ============================================================

/** Inner path markup per icon, from Lucide (stroke geometry only). */
const ICON_PATHS = {
    'arrow-down': '<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>',
    'arrow-down-to-line': '<path d="M12 17V3"/><path d="m6 11 6 6 6-6"/><path d="M19 21H5"/>',
    'arrow-up': '<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>',
    'arrow-up-to-line': '<path d="M5 3h14"/><path d="m18 13-6-6-6 6"/><path d="M12 7v14"/>',
    'check': '<path d="M20 6 9 17l-5-5"/>',
    'circle': '<circle cx="12" cy="12" r="10"/>',
    'circle-dot': '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="1"/>',
    'circle-help': '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
    'crosshair': '<circle cx="12" cy="12" r="10"/><line x1="22" x2="18" y1="12" y2="12"/><line x1="6" x2="2" y1="12" y2="12"/><line x1="12" x2="12" y1="6" y2="2"/><line x1="12" x2="12" y1="22" y2="18"/>',
    'diamond': '<path d="M2.7 10.3a2.41 2.41 0 0 0 0 3.41l7.59 7.59a2.41 2.41 0 0 0 3.41 0l7.59-7.59a2.41 2.41 0 0 0 0-3.41l-7.59-7.59a2.41 2.41 0 0 0-3.41 0Z"/>',
    'eye': '<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/>',
    'eye-off': '<path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49"/><path d="M14.084 14.158a3 3 0 0 1-4.242-4.242"/><path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"/><path d="m2 2 20 20"/>',
    'flag': '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" x2="4" y1="22" y2="15"/>',
    'loader-circle': '<path d="M21 12a9 9 0 1 1-6.219-8.56"/>',
    'map-pin': '<path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0"/><circle cx="12" cy="10" r="3"/>',
    'pencil': '<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/>',
    'plus': '<path d="M5 12h14"/><path d="M12 5v14"/>',
    'redo': '<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5A5.5 5.5 0 0 0 4 14.5A5.5 5.5 0 0 0 9.5 20H13"/>',
    'ruler': '<path d="M21.3 15.3a2.4 2.4 0 0 1 0 3.4l-2.6 2.6a2.4 2.4 0 0 1-3.4 0L2.7 8.7a2.41 2.41 0 0 1 0-3.4l2.6-2.6a2.41 2.41 0 0 1 3.4 0Z"/><path d="m14.5 12.5 2-2"/><path d="m11.5 9.5 2-2"/><path d="m8.5 6.5 2-2"/><path d="m17.5 15.5 2-2"/>',
    'triangle-alert': '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
    'undo': '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11"/>',
    'x': '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
} as const;

export type IconName = keyof typeof ICON_PATHS;

/** Icon sizes allowed by the guide's 4-pt grid. */
export type IconSize = 16 | 20 | 24;

/**
 * Inline monoline icon as an `<svg>` HTML string for interpolation into a
 * component template. `vertical-align` is baked in so the icon sits on the
 * text's optical baseline in inline flow; inside flex rows it is inert.
 */
export function icon(name: IconName, size: IconSize = 16): string {
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor"`
        + ` stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"`
        + ` style="vertical-align:-0.18em">${ICON_PATHS[name]}</svg>`;
}
