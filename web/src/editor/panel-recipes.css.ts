// CSS recipes for editor tool panels hosted in the feature dock.
//
// Each recipe returns nested CSS (`& .class { ... }`) or a declaration
// block for interpolation into a panel's `static styles`, inside the
// panel's root rule. The panels of clean, SAM, terrain-edit and measure
// share these blocks; css.ts holds the app-wide component recipes these
// build on (panelTitle).

import { t } from '../theme';
import { s, panelTitle } from '../css';

/**
 * Declarations for a panel root that is a flat dock body
 * (feature-dock.component.ts hosting contract): the dock owns the surface
 * and the scroll bound with zero padding, so the panel carries its own
 * interior padding and one flex column.
 */
export const dockBody = () => `
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding: var(--space-3) var(--space-4) var(--space-4);
    font-size: 0.8rem;
    color: ${t('color-text-primary')};
`;

/** `.section-title` overline. `margin` defaults to a small bottom gap. */
export const sectionTitle = (margin = `0 0 ${s('xs')}`) => `
    & .section-title {
        margin: ${margin};
        ${panelTitle()}
    }
`;

/**
 * Sidecar health row: `.status-row` holding a `.status-dot` (classes
 * `online`, `offline`, `degraded`) and a `.status-text`. The retry button
 * is the panel's own.
 */
export const statusRow = () => `
    & .status-row {
        display: flex;
        align-items: center;
        gap: ${s('sm')};
    }

    & .status-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: ${t('color-text-secondary')};
        flex: none;
        &.online { background: var(--data-good); }
        &.offline { background: var(--data-bad); }
        &.degraded { background: var(--data-risk); }
    }

    & .status-text { flex: 1; }
`;

/** Small outlined text button declarations (retry, revert, discard). */
export const smallBtn = () => `
    font: inherit;
    font-size: 0.72rem;
    padding: 2px ${s('sm')};
    border: 1px solid ${t('color-border-default')};
    border-radius: ${t('radius-sm')};
    background: transparent;
    color: ${t('color-text-primary')};
    cursor: pointer;
`;

/** Full-width select or text input declarations. */
export const panelInput = () => `
    width: 100%;
    font: inherit;
    padding: ${s('xs')} ${s('sm')};
    border: 1px solid ${t('color-border-default')};
    border-radius: ${t('radius-sm')};
    background: ${t('color-surface-card')};
    color: ${t('color-text-primary')};
`;

/** `.busy-line` (secondary text) and `.notice` (error text), shown with `.show`. */
export const busyAndNotice = () => `
    & .busy-line {
        display: none;
        color: ${t('color-text-secondary')};
        &.show { display: block; }
    }

    & .notice {
        display: none;
        color: var(--data-bad);
        line-height: 1.4;
        &.show { display: block; }
    }
`;

/** Hints footer below a hairline; `cls` is the panel's BEM hints class. */
export const hintsFooter = (cls: string) => `
    & .${cls} {
        padding-top: var(--space-3);
        border-top: 1px solid ${t('color-border-default')};
        display: flex;
        flex-direction: column;
        gap: ${s('xs')};
        font-size: 0.72rem;
        color: ${t('color-text-secondary')};
        line-height: 1.4;
    }
`;
