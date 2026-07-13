import { test, expect } from 'bun:test';
import { chartSvg, statsHtml, signedMeters } from '../src/profile/elevation-profile.component';
import type { ProfileSample } from '../src/profile/elevation-profile';

// Structure checks on the pure SVG/stats builders (the visual layer the e2e
// harness can't exercise — it serves no terrain tiles).

const markers = [
    { label: 'Tee', distance: 0, elevation: 62.0 },
    { label: 'S1', distance: 100, elevation: 61.0 },
    { label: 'Green', distance: 200, elevation: 64.0 },
];

function samplesWithGap(): ProfileSample[] {
    const samples: ProfileSample[] = [];
    for (let d = 0; d <= 200; d += 2) {
        // Coverage gap mid-path → the curve must split into two runs.
        samples.push({ distance: d, elevation: d > 118 && d < 142 ? null : 62 + d / 100 });
    }
    return samples;
}

test('signedMeters formats raw deltas', () => {
    expect(signedMeters(1.23)).toBe('+1.2 m');
    expect(signedMeters(-0.05)).toBe('−0.1 m');
    expect(signedMeters(0)).toBe('+0.0 m');
    expect(signedMeters(null)).toBe('—');
});

test('chartSvg draws runs, markers, dots, and axis ticks', () => {
    const svg = chartSvg(samplesWithGap(), markers, { min: 62, max: 64 }, 200);

    // Gap → exactly two area paths + two polylines (one per contiguous run).
    expect((svg.match(/<polyline /g) ?? []).length).toBe(2);
    expect((svg.match(/url\(#elev-area\)/g) ?? []).length).toBe(2);

    // One dashed rule + label per marker; one dot per resolved elevation.
    expect((svg.match(/class="rule"/g) ?? []).length).toBe(3);
    for (const m of markers) expect(svg).toContain(`>${m.label}</text>`);
    expect((svg.match(/<circle /g) ?? []).length).toBe(3);

    // Real metre tick labels on both axes.
    expect(svg).toContain('class="tick tick--y"');
    expect(svg).toContain('class="tick tick--x"');
});

test('chartSvg escapes user-provided marker labels', () => {
    const svg = chartSvg(
        samplesWithGap(),
        [{ label: '<b>&"x"', distance: 50, elevation: 62.5 }],
        { min: 62, max: 64 },
        200,
    );
    expect(svg).toContain('&lt;b&gt;&amp;&quot;x&quot;');
    expect(svg).not.toContain('<b>&"x"');
});

test('statsHtml: endpoint-named total chip, leg chips only on multi-leg routes', () => {
    const legs = [
        { label: 'Tee→S1', delta: -1.0 },
        { label: 'S1→Green', delta: 3.0 },
    ];
    const multi = statsHtml(2.0, legs, markers);
    expect(multi).toContain('Δ Green−Tee');
    expect(multi).toContain('+2.0 m');
    expect(multi).toContain('Tee→S1');
    expect(multi).toContain('S1→Green');

    // Single-leg route (par 3): the total IS the leg — no redundant chip.
    const single = statsHtml(2.0, [{ label: 'Tee→Green', delta: 2.0 }],
        [markers[0], markers[2]]);
    expect(single).toContain('Δ Green−Tee');
    expect(single).not.toContain('Tee→Green');
});
