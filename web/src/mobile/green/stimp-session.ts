import { DEFAULT_STIMP_FT, STIMP_MAX_FT, STIMP_MIN_FT } from '../../planner/putt-read.service';

/**
 * Session-scoped green speed. Deliberately `sessionStorage`, not
 * `localStorage`: a PWA launched from the home screen gets its OWN storage
 * partition (feature-mobile-companion.md §5), so a "remembered" stimp would
 * silently differ between the installed app and a Safari tab. Stimp is a
 * per-round input anyway — one round, one session.
 */
export const STIMP_SESSION_KEY = 'golf-map.m.stimpFt';

/** Clamp to the desktop's input range (outside it is a typo, not a green). */
export function clampStimp(value: number): number {
    if (!Number.isFinite(value)) return DEFAULT_STIMP_FT;
    return Math.min(STIMP_MAX_FT, Math.max(STIMP_MIN_FT, value));
}

/** The session's stimp, or the default (10) when unset/unusable. */
export function loadSessionStimp(): number {
    try {
        const raw = sessionStorage.getItem(STIMP_SESSION_KEY);
        if (raw === null) return DEFAULT_STIMP_FT;
        return clampStimp(Number(raw));
    } catch {
        return DEFAULT_STIMP_FT;
    }
}

/** Persist for this session only; a locked-down storage is a silent no-op. */
export function saveSessionStimp(stimpFt: number): void {
    try {
        sessionStorage.setItem(STIMP_SESSION_KEY, String(clampStimp(stimpFt)));
    } catch {
        // Private mode / storage disabled — the in-memory signal still drives it.
    }
}
