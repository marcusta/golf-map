import { test, expect, afterEach } from 'bun:test';
import { di } from '@basics/core/client/core';
import { _reset } from '@basics/core/client/error-report';
import { VegetationRulesPanelComponent } from '../src/zones/vegetation-rules-panel.component';
import { VegetationRulesService } from '../src/zones/vegetation-rules.service';
import type { PlantingRules } from '../../shared/api/vegetation-rules.gen';

// Acceptance A5 (panel half): the Planting rules panel shows each species' models on one line each,
// with who draws it (Arborist or VSP); the size sits in the tooltip.

afterEach(() => { _reset(); di.reset(); });

const RULES = {
    courseId: 'c1', courseName: 'Ombergs Golfklubb', courseDocs: 'docs/gspro/ombergs-golfklubb',
    generators: [], trees: [], treeAreas: [], treeAssets: [],
    treeModels: [
        { species: 'beech', weight: 0.3, models: [{ id: 'arborist:CE_DA_Forest_Tree_16018', renderer: 'arborist', heightM: 22.9, crownWidthM: 14.0, enabled: true }] },
        { species: 'oak', weight: 0.42, models: [{ id: 'vsp:PF_Oak_tall Terrain', renderer: 'vsp', heightM: 20.4, crownWidthM: 14.67, enabled: true }] },
    ],
} as unknown as PlantingRules;

test('each model reads as one line with its renderer', () => {
    const svc = new VegetationRulesService();
    di.set(VegetationRulesService, svc);
    const host = document.createElement('div');
    document.body.appendChild(host);
    new VegetationRulesPanelComponent({}).mount(host);
    svc.panelCourseId.set('c1');
    svc.rules.set(RULES);

    const rows = [...host.querySelectorAll<HTMLElement>('[data-testid="planting-rules-model"]')];
    expect(rows.map((r) => r.dataset.model)).toEqual(['arborist:CE_DA_Forest_Tree_16018', 'vsp:PF_Oak_tall Terrain']);
    expect(rows[0]!.textContent).toContain('beech');
    expect(rows[0]!.textContent).toContain('CE_DA_Forest_Tree_16018');
    expect(rows[0]!.textContent).toContain('Arborist');
    expect(rows[1]!.textContent).toContain('VSP');
    expect(rows[0]!.title).toContain('22.9 m');
});
