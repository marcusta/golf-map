import { di } from '@basics/core/client/core';
import type { EditorTool } from '../editor/tool';
import { FURNITURE_TOOL_ID } from './furniture.service';
import { FurnitureToolService } from './furniture-tool.service';
import { FurniturePanelComponent } from './furniture-panel.component';

/**
 * The `furniture` EditorTool registry entry (editor/tools/index.ts). Thin
 * descriptor over the FurnitureToolService DI singleton so the panel
 * component and the tool share one instance.
 */
export const furnitureTool: EditorTool = {
    id: FURNITURE_TOOL_ID,
    label: 'Furniture',
    icon: '⛳',
    order: 20,
    panel: FurniturePanelComponent,
    attach: ctx => di.get(FurnitureToolService).attach(ctx),
    activate: ctx => di.get(FurnitureToolService).activate(ctx),
    deactivate: () => di.get(FurnitureToolService).deactivate(),
    onEscape: () => di.get(FurnitureToolService).onEscape(),
};
