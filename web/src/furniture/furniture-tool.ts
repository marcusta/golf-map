import { di } from '@basics/core/client/core';
import type { EditorTool, HelpSection } from '../editor/tool';
import { FURNITURE_TOOL_ID } from './furniture.service';
import { FurnitureToolService } from './furniture-tool.service';
import { FurniturePanelComponent } from './furniture-panel.component';

// Help-modal content (D27) — the sole home of furniture interaction hints.
const HELP: HelpSection[] = [
    {
        title: 'Navigation',
        shortcuts: [
            { keys: '⌘-drag', desc: 'Pan the map (works even starting on a marker)' },
            { keys: 'Middle-drag', desc: 'Pan the map (mouse; works mid-gesture in any tool)' },
        ],
    },
    {
        title: 'Placement',
        shortcuts: [
            { keys: 'Pick a hole, arm, click map', desc: 'Place a tee/pin/aim-point/green point' },
            { keys: 'Shift-click', desc: 'Place several in a row (stay armed)' },
            { keys: 'Esc', desc: 'Cancel placing' },
        ],
    },
    {
        title: 'Selection',
        shortcuts: [
            { keys: 'Click marker', desc: 'Select' },
            { keys: 'Drag marker', desc: 'Move' },
            { keys: 'Del / Backspace', desc: 'Delete selection' },
        ],
    },
];

/**
 * The `furniture` EditorTool registry entry (editor/tools/index.ts). Thin
 * descriptor over the FurnitureToolService DI singleton so the panel
 * component and the tool share one instance.
 */
export const furnitureTool: EditorTool = {
    id: FURNITURE_TOOL_ID,
    label: 'Furniture',
    icon: 'flag',
    order: 20,
    builderOnly: true,
    panel: FurniturePanelComponent,
    help: HELP,
    attach: ctx => di.get(FurnitureToolService).attach(ctx),
    activate: ctx => di.get(FurnitureToolService).activate(ctx),
    deactivate: () => di.get(FurnitureToolService).deactivate(),
    onEscape: () => di.get(FurnitureToolService).onEscape(),
};
