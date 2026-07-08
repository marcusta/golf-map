import { test, expect } from 'bun:test';
import { PuttAccuracyPanelComponent } from '../src/rounds/putt-accuracy-panel.component';
import type { AccuracyTrend } from '../../shared/api/putt-estimate.gen';

// Render smoke for the estimation-accuracy panel (there are no per-component
// specs by design — TESTING.md — but this pure-prop component's render/ref
// wiring is worth one throw-check with real data through happy-dom).

const emptyAgg = { sampleCount: 0, meanSlopeErrorPct: null, breakSideHitRate: null, meanPaceErrorM: null };

function mount(trend: AccuracyTrend): HTMLElement {
    const host = document.createElement('div');
    new PuttAccuracyPanelComponent({ trend }).mount(host);
    return host;
}

test('renders the recent/all-time tables and hides the trend section when empty', () => {
    const host = mount({ recent: emptyAgg, overall: emptyAgg, buckets: [] });

    expect(host.querySelector('[data-testid="putt-accuracy-panel"]')).not.toBeNull();
    // Empty aggregates render em-dash values, not zeros.
    const values = [...host.querySelectorAll('.sg-table__value')].map((e) => e.textContent);
    expect(values).toContain('—');
    // Trend section hidden with no buckets.
    const trendSection = host.querySelector('[bind="trendSection"]') as HTMLElement;
    expect(trendSection.style.display).toBe('none');
});

test('renders populated aggregates and a per-day trend list', () => {
    const host = mount({
        recent: { sampleCount: 5, meanSlopeErrorPct: 0.8, breakSideHitRate: 0.8, meanPaceErrorM: 0.6 },
        overall: { sampleCount: 12, meanSlopeErrorPct: 1.1, breakSideHitRate: 0.66, meanPaceErrorM: 0.9 },
        buckets: [
            { date: '2026-07-01', sampleCount: 4, meanSlopeErrorPct: 1.5, breakSideHitRate: 0.5, meanPaceErrorM: 1 },
            { date: '2026-07-03', sampleCount: 8, meanSlopeErrorPct: 0.9, breakSideHitRate: 0.75, meanPaceErrorM: 0.8 },
        ],
    });

    const text = host.textContent ?? '';
    expect(text).toContain('0.8%'); // recent slope error
    expect(text).toContain('80%'); // recent hit rate
    expect(text).toContain('2026-07-01'); // trend bucket date
    const trendSection = host.querySelector('[bind="trendSection"]') as HTMLElement;
    expect(trendSection.style.display).not.toBe('none');
});
