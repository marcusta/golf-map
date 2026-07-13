// ============================================================
// Pure formatting helpers for the Courses list (design 3a).
// Kept dependency-free so they unit-test as plain functions.
// ============================================================

const EMDASH = '—';
const THIN_SPACE = ' ';

/**
 * Relative "time ago" label from an ISO timestamp, e.g. "2d ago", "3w ago".
 * Under an hour reads "Just added"; falls back to EMDASH on an unparseable
 * input. `now` is injectable for deterministic tests.
 */
export function timeAgo(iso: string, now: number = Date.now()): string {
    const then = Date.parse(iso);
    if (Number.isNaN(then)) return EMDASH;
    const secs = Math.max(0, (now - then) / 1000);
    const mins = secs / 60;
    if (mins < 60) return 'Just added';
    const hours = mins / 60;
    if (hours < 24) return `${Math.floor(hours)}h ago`;
    const days = hours / 24;
    if (days < 7) return `${Math.floor(days)}d ago`;
    const weeks = days / 7;
    if (weeks < 4.35) return `${Math.floor(weeks)}w ago`;
    const months = days / 30.44;
    if (months < 12) return `${Math.max(1, Math.floor(months))}mo ago`;
    const years = days / 365.25;
    return `${Math.max(1, Math.floor(years))}y ago`;
}

/** Metres → "5 842 m" with thin-space thousands; EMDASH when 0/absent. */
export function formatLength(m: number): string {
    if (!m || m <= 0) return EMDASH;
    const grouped = String(Math.round(m)).replace(/\B(?=(\d{3})+(?!\d))/g, THIN_SPACE);
    return `${grouped}${THIN_SPACE}m`;
}

/** Par total → string; EMDASH when 0/absent. */
export function formatPar(par: number): string {
    return par > 0 ? String(par) : EMDASH;
}

/** Mapped fraction as an integer percent (0 when no holes). */
export function mappedPct(mapped: number, holes: number): number {
    return holes > 0 ? Math.round((mapped / holes) * 100) : 0;
}

/** Left-side progress label: "Fully mapped" / "N of M mapped" / "Not started". */
export function mappedLabel(mapped: number, holes: number): string {
    if (holes <= 0) return 'Not started';
    if (mapped >= holes) return 'Fully mapped';
    return `${mapped} of ${holes} mapped`;
}

/** Right-side percent label; EMDASH when no holes. */
export function pctLabel(mapped: number, holes: number): string {
    return holes > 0 ? `${mappedPct(mapped, holes)}%` : EMDASH;
}
