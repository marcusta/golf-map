import { di } from '@basics/core/client/core';
import type { EditorTool } from '../editor/tool';
import { DrawToolService, DRAW_TOOL_ID } from './draw-tool.service';
import { DrawPanelComponent } from './draw-panel.component';
import { FeatureStackPanelComponent } from './feature-stack-panel.component';

/**
 * The `draw` EditorTool registry entry (editor/tools/index.ts). Thin
 * descriptor over the DrawToolService DI singleton so the panel component
 * and the tool share one instance.
 */
export const drawTool: EditorTool = {
    id: DRAW_TOOL_ID,
    label: 'Draw',
    icon: '✎',
    order: 10,
    panel: DrawPanelComponent,
    sidePanel: FeatureStackPanelComponent,
    attach: ctx => di.get(DrawToolService).attach(ctx),
    activate: ctx => di.get(DrawToolService).activate(ctx),
    deactivate: () => di.get(DrawToolService).deactivate(),
    onEscape: () => di.get(DrawToolService).onEscape(),
};
