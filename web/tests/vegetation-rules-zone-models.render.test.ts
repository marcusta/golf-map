import { test, expect, afterEach } from 'bun:test';
import { di } from '@basics/core/client/core';
import { _reset } from '@basics/core/client/error-report';
import { VegetationRulesPanelComponent } from '../src/zones/vegetation-rules-panel.component';
import { VegetationRulesService } from '../src/zones/vegetation-rules.service';
import type { PlantingRules } from '../../shared/api/vegetation-rules.gen';

// Acceptance C4 (panel half), zone palettes on the model library: the Planting rules panel shows each zone
// item on one line with who draws it (Arborist or VSP); the model id sits in the tooltip.

afterEach(() => { _reset(); di.reset(); });

const RULES = {
    courseId: 'c1', courseName: 'Ombergs Golfklubb', courseDocs: 'docs/gspro/ombergs-golfklubb',
    generators: [], trees: [], treeAreas: [], treeAssets: [], treeModels: [],
    zoneModels: [
        { palette: 'rough_tall', items: [{ name: 'Tall rough - green base', model: 'vsp:texture:Rustic Grass_15', renderer: 'vsp' }] },
        { palette: 'woodland_floor/edge', items: [{ name: 'Woodland edge - hazel', model: 'arborist:MountainEnv_bush_hazel_01', renderer: 'arborist' }] },
    ],
} as unknown as PlantingRules;

test('each zone item reads as one line with its renderer', () => {
    const svc = new VegetationRulesService();
    di.set(VegetationRulesService, svc);
    const host = document.createElement('div');
    document.body.appendChild(host);
    new VegetationRulesPanelComponent({}).mount(host);
    svc.panelCourseId.set('c1');
    svc.rules.set(RULES);

    const rows = [...host.querySelectorAll<HTMLElement>('[data-testid="planting-rules-zone-item"]')];
    expect(rows.map((r) => r.dataset.model)).toEqual(['vsp:texture:Rustic Grass_15', 'arborist:MountainEnv_bush_hazel_01']);
    expect(rows[0]!.textContent).toContain('Tall rough - green base');
    expect(rows[0]!.textContent).toContain('VSP');
    expect(rows[1]!.textContent).toContain('Woodland edge - hazel');
    expect(rows[1]!.textContent).toContain('Arborist');
    expect(rows[1]!.title).toContain('arborist:MountainEnv_bush_hazel_01');
});
