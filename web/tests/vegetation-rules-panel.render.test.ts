import { test, expect, afterEach } from 'bun:test';
import { di } from '@basics/core/client/core';
import { _reset } from '@basics/core/client/error-report';
import { VegetationRulesPanelComponent } from '../src/zones/vegetation-rules-panel.component';
import { VegetationRulesService, formatRuleValue } from '../src/zones/vegetation-rules.service';
import type { PlantingRule, PlantingRules } from '../../shared/api/vegetation-rules.gen';

// Render smoke for the read-only Planting rules panel: each section folds to one
// line with a tag for the rules the course sets, a course value shows its default,
// Explain shows the explanations inline, and a mix with no items reads "off".

afterEach(() => { _reset(); di.reset(); });

const rule = (key: string, value: unknown, more: Partial<PlantingRule> = {}): PlantingRule => ({
    key, unit: 'm', text: `what ${key} does`, flag: false, defaultValue: value, courseSets: false, courseValue: null, value, ...more,
});

const RULES: PlantingRules = {
    courseId: 'c1', courseName: 'Vreta', courseDocs: 'docs/gspro/vreta',
    generators: [{
        source: 'tall-grass', label: 'Tall rough', script: 'grass_zones.py', summary: 'Tall grass on the deep rough.',
        steps: ['Grows on deep rough.', 'Thinner far from play.'], courseFile: 'docs/gspro/vreta/vegetation-rules.json',
        groups: [{
            title: 'Density by distance from play',
            rules: [
                rule('far-start', 40, { flag: true, defaultValue: 30, courseSets: true, courseValue: 40 }),
                rule('clearances', [{ surfaces: ['tee', 'green'], clear: 4, ramp: 4 }, { surfaces: ['water'], clear: 1.5, ramp: 2 }]),
            ],
        }],
        courseExtras: [],
        mixes: [
            { zoneType: 'rough_tall', zoneTypeName: 'Tall rough', variant: '', variantName: 'Default', items: ['Green base', 'Seed heads'] },
            { zoneType: 'rough_tall', zoneTypeName: 'Tall rough', variant: 'far', variantName: 'Far', items: [] },
        ],
    }],
    trees: [],
    treeAreas: [{ name: 'Oak grove', mix: 'oak 9, birch 1', ignoreKind: false }],
    treeAssets: [{ species: 'oak', enabled: 4, total: 4 }],
};

function mount() {
    const svc = new VegetationRulesService();
    di.set(VegetationRulesService, svc);
    const host = document.createElement('div');
    document.body.appendChild(host);
    new VegetationRulesPanelComponent({}).mount(host);
    svc.panelCourseId.set('c1');
    svc.rules.set(RULES);
    return { host, svc };
}

test('the panel folds each section to a line, marks the course values and shows the mixes', () => {
    const { host, svc } = mount();
    expect(host.querySelector('.veg-rules')?.classList.contains('show')).toBe(true);
    const sections = host.querySelectorAll<HTMLDetailsElement>('[data-testid="planting-rules-section"]');
    expect(sections).toHaveLength(1);
    expect(sections[0]!.open).toBe(false);
    expect(sections[0]!.querySelector('summary')?.textContent).toContain('Tall rough');
    expect(sections[0]!.querySelector('.vr-tag')?.textContent).toBe('1 course');

    const far = host.querySelector<HTMLElement>('[data-key="far-start"]')!;
    expect(far.classList.contains('course')).toBe(true);
    expect(far.textContent).toContain('40 m');
    expect(far.textContent).toContain('(default 30)');
    expect(far.title).toContain('what far-start does');
    // A list of objects reads one line per entry.
    expect(host.querySelector('[data-key="clearances"] .vr-rule__value')?.innerHTML).toContain('tee, green: clear 4, ramp 4<br>water: clear 1.5, ramp 2');

    const mixes = [...host.querySelectorAll('[data-testid="planting-rules-mix"]')].map((m) => m.textContent);
    expect(mixes).toEqual(['rough_tall/default2 items', 'rough_tall/farno items: off']);

    // Explain: the explanations and the steps inline.
    expect(host.querySelector('.vr-rule__text')).toBeNull();
    const explain = host.querySelector<HTMLInputElement>('[data-testid="planting-rules-explain"]')!;
    explain.checked = true;
    explain.dispatchEvent(new Event('change'));
    expect(host.querySelector('[data-key="far-start"] .vr-rule__text')?.textContent).toBe('what far-start does');
    expect([...host.querySelectorAll('ol.vr-steps li')].map((li) => li.textContent)).toEqual(['Grows on deep rough.', 'Thinner far from play.']);

    svc.close();
    expect(host.querySelector('.veg-rules')?.classList.contains('show')).toBe(false);
});

test('rule values read as one short line', () => {
    expect(formatRuleValue(['gravel', 'dirt'])).toBe('gravel, dirt');
    expect(formatRuleValue({ oak: 0.7, birch: 0.3 })).toBe('oak 0.7, birch 0.3');
    expect(formatRuleValue([[400, 0.8], [null, 0.2]])).toBe('[400, 0.8], [—, 0.2]');
    expect(formatRuleValue(null)).toBe('—');
    expect(formatRuleValue(false)).toBe('off');
});
