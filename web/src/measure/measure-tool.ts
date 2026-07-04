import { di } from '@basics/core/client/core';
import type { EditorTool } from '../editor/tool';
import { MeasureToolService, MEASURE_TOOL_ID } from './measure-tool.service';
import { MeasurePanelComponent } from './measure-panel.component';

/**
 * The `measure` EditorTool registry entry (editor/tools/index.ts). Thin
 * descriptor over the MeasureToolService DI singleton so the panel component
 * and the tool share one instance. Distance/elevation measurement tool —
 * click-click multi-segment path with per-segment + cumulative stats and an
 * elevation-profile sparkline (batch C3).
 */
export const measureTool: EditorTool = {
    id: MEASURE_TOOL_ID,
    label: 'Measure',
    icon: '📏',
    order: 30,
    panel: MeasurePanelComponent,
    attach: ctx => di.get(MeasureToolService).attach(ctx),
    activate: ctx => di.get(MeasureToolService).activate(ctx),
    deactivate: () => di.get(MeasureToolService).deactivate(),
    onEscape: () => di.get(MeasureToolService).onEscape(),
};
