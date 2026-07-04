import { createTokens } from '@basics/core/client/core';

// Neutral slate palette (framework defaults) with a fairway-green primary.
// Tokens are spelled out so `t(name)` stays fully type-checked.

const base = {
    radius: '8px',
    'radius-pill': '20px',
    'radius-sm': '4px',
    'done-opacity': '0.4',
};

export const t = createTokens({
    ...base,
    bg: '#f8f9fa',
    surface: '#ffffff',
    primary: '#2f7d4f',
    'primary-hover': '#276a42',
    'primary-text': '#f8f9fa',
    'btn-bg': '#e9ecef',
    'btn-hover': '#dee2e6',
    text: '#212529',
    'text-muted': '#868e96',
    border: '#dee2e6',
    'topbar-bg': '#1d3b2a',
    'topbar-logo': 'rgba(248, 249, 250, 0.85)',
    'active-bg': '#2f7d4f',
    'active-text': '#f8f9fa',
    'hover-bg': '#e9ecef',
    'input-bg': '#ffffff',
    accent: '#2f7d4f',
    error: '#c92a2a',
    shadow: '0 1px 3px rgba(0,0,0,0.08), 0 4px 12px rgba(0,0,0,0.04)',
    'shadow-elevated': '0 4px 6px rgba(0,0,0,0.06), 0 16px 32px rgba(0,0,0,0.08)',
}, {
    ...base,
    bg: '#1a1b1e',
    surface: '#25262b',
    primary: '#5cab7d',
    'primary-hover': '#4d9a6e',
    'primary-text': '#1a1b1e',
    'btn-bg': '#2c2e33',
    'btn-hover': '#373a40',
    text: '#c1c2c5',
    'text-muted': '#909296',
    border: '#373a40',
    'topbar-bg': '#14211a',
    'topbar-logo': 'rgba(193, 194, 197, 0.75)',
    'active-bg': '#2f7d4f',
    'active-text': '#f0f1f2',
    'hover-bg': '#2c2e33',
    'input-bg': '#25262b',
    accent: '#5cab7d',
    error: '#ff8787',
    shadow: '0 1px 3px rgba(0,0,0,0.2), 0 4px 12px rgba(0,0,0,0.15)',
    'shadow-elevated': '0 4px 6px rgba(0,0,0,0.15), 0 16px 32px rgba(0,0,0,0.2)',
});
