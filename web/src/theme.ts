import { createTokens } from '@basics/core/client/core';

// ============================================================
// Golf Intel — Design Tokens · "Links & Loam"
// Semantic + map-overlay tokens (light + dark) flow through the
// typed t() accessor and the existing data-theme toggle. The
// theme-invariant layers (cartography, data-viz, scale, type,
// motion) live in design-tokens.css, imported from main.ts.
//
// Names match the design package 1:1 (web --color-text-primary
// ↔ iOS Color.textPrimary). The legacy short-name aliases (bg/
// primary/text/…) that eased the file-by-file migration have been
// removed now that all consumers reference semantic/overlay names.
// ============================================================

const scale = {
    // radius (kept under legacy names; values already match the L&L scale)
    radius: '8px',
    'radius-sm': '4px',
    'radius-pill': '999px',
    'done-opacity': '0.4',
};

const light = {
    ...scale,

    // ── semantic · text ──
    'color-text-primary': '#211D14',
    'color-text-secondary': '#55503F',
    'color-text-tertiary': '#8B8471',
    'color-text-disabled': '#B4AC98',
    'color-text-accent': '#A6572F',
    'color-text-inverse': '#F6F1E7',
    // ── semantic · surface ──
    'color-surface-app': '#F6F1E7',
    'color-surface-sunken': '#EDE4D2',
    'color-surface-card': '#FBF8F1',
    'color-surface-raised': '#FFFFFF',
    'color-surface-brand': '#1E2B22',
    // ── semantic · border ──
    'color-border-subtle': '#E8E0CF',
    'color-border-default': '#DDD0B4',
    'color-border-strong': '#C9B899',
    'color-border-focus': '#BF6A3E',
    // ── semantic · accent / action ──
    'color-accent-primary': '#BF6A3E',
    'color-accent-hover': '#A6572F',
    'color-accent-press': '#8F4A28',
    'color-on-accent': '#FBF3E8',
    'color-accent-secondary': '#5C6B4A',
    'color-accent-data': '#C68A2E',
    // ── semantic · status ──
    'color-status-positive': '#4E7A46',
    'color-status-caution': '#C68A2E',
    'color-status-negative': '#B24A32',
    'color-status-info': '#3E7E92',

    // ── map overlay (chrome on imagery) ──
    'overlay-panel-fill': 'rgba(246,241,231,.82)',
    'overlay-panel-stroke': 'rgba(255,255,255,.55)',
    'overlay-panel-blur': '14px',
    'overlay-readout-fill': 'rgba(30,43,34,.90)',
    'overlay-readout-stroke': 'rgba(150,135,105,.3)',
    'overlay-scrim': 'rgba(20,17,11,.45)',
    'overlay-text': '#FFFFFF',
    'overlay-text-muted': 'rgba(255,255,255,.72)',
    'overlay-control-fill': 'rgba(246,241,231,.92)',
    'overlay-dispersion-fill': 'rgba(191,106,62,.14)',
    'overlay-dispersion-stroke': '#E6D8BE',

    // ── elevation (box-shadow) ──
    shadow: '0 1px 2px rgba(40,36,26,.06), 0 2px 8px -2px rgba(40,36,26,.08)',
    'shadow-elevated': '0 4px 10px -4px rgba(40,36,26,.18), 0 12px 28px -12px rgba(40,36,26,.22)',
};

const dark: typeof light = {
    ...scale,

    // ── semantic · text ──
    'color-text-primary': '#F1EADB',
    'color-text-secondary': '#C4BBA6',
    'color-text-tertiary': '#94896F',
    'color-text-disabled': '#5F5847',
    'color-text-accent': '#E08A4E',
    'color-text-inverse': '#16130D',
    // ── semantic · surface ──
    'color-surface-app': '#16130D',
    'color-surface-sunken': '#100E09',
    'color-surface-card': '#221D15',
    'color-surface-raised': '#2C2519',
    'color-surface-brand': '#1E2B22',
    // ── semantic · border ──
    'color-border-subtle': '#2C2517',
    'color-border-default': '#3A3122',
    'color-border-strong': '#4A4033',
    'color-border-focus': '#D2793F',
    // ── semantic · accent / action ──
    'color-accent-primary': '#D2793F',
    'color-accent-hover': '#E08A4E',
    'color-accent-press': '#BF6A3E',
    'color-on-accent': '#1C130B',
    'color-accent-secondary': '#7E9159',
    'color-accent-data': '#E6C08A',
    // ── semantic · status ──
    'color-status-positive': '#7BA36A',
    'color-status-caution': '#E6B355',
    'color-status-negative': '#E07C5E',
    'color-status-info': '#6BB6C9',

    // ── map overlay ──
    'overlay-panel-fill': 'rgba(28,24,16,.74)',
    'overlay-panel-stroke': 'rgba(150,135,105,.28)',
    'overlay-panel-blur': '16px',
    'overlay-readout-fill': 'rgba(28,24,16,.84)',
    'overlay-readout-stroke': 'rgba(150,135,105,.3)',
    'overlay-scrim': 'rgba(8,6,3,.60)',
    'overlay-text': '#FFFFFF',
    'overlay-text-muted': 'rgba(241,234,219,.65)',
    'overlay-control-fill': 'rgba(28,24,16,.82)',
    'overlay-dispersion-fill': 'rgba(191,106,62,.14)',
    'overlay-dispersion-stroke': '#E6C08A',

    // ── elevation (dark swaps ambient shadow → warm glow) ──
    shadow: '0 1px 2px rgba(0,0,0,.4), 0 0 12px -4px rgba(230,192,138,.10)',
    'shadow-elevated': '0 6px 16px -6px rgba(0,0,0,.55), 0 0 24px -6px rgba(230,192,138,.14)',
};

export const t = createTokens(light, dark);
