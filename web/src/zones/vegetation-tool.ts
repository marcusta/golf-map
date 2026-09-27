import { di } from '@basics/core/client/core';
import type { EditorTool, HelpSection } from '../editor/tool';
import { DrawToolService } from '../draw/draw-tool.service';

export const VEGETATION_TOOL_ID = 'vegetation';

// Help-modal content — the Draw gestures that apply to the zones.
const HELP: HelpSection[] = [
    {
        title: 'Navigation',
        shortcuts: [
            { keys: '⌘-drag', desc: 'Pan the map' },
            { keys: 'Middle-drag', desc: 'Pan the map (mouse; works mid-gesture in any tool)' },
        ],
    },
    {
        title: 'Zones',
        shortcuts: [
            { keys: 'Zone type picker', desc: 'Zone type for the next zone, or retype the selected zones' },
            { keys: 'N', desc: 'Start a new zone' },
            { keys: 'Enter / click first point', desc: 'Close the zone' },
            { keys: 'Press-drag while armed', desc: 'Trace a zone freehand' },
            { keys: 'Esc', desc: 'Cancel drawing, then the selection' },
        ],
    },
    {
        title: 'Selection and editing',
        shortcuts: [
            { keys: 'Click a zone', desc: 'Select (the course is a backdrop: its shapes are not selectable here)' },
            { keys: 'Click a creek or water', desc: 'Select it to set its bank vegetation (palette, water cover); ⌘/Ctrl-click adds more' },
            { keys: '⌘/Ctrl-click · drag empty ground', desc: 'Multi-select · marquee select' },
            { keys: 'Drag inside selection · drag vertex', desc: 'Move · reshape' },
            { keys: 'Click edge · right-click vertex', desc: 'Insert / remove a vertex' },
            { keys: '⌘/Ctrl-D', desc: 'Duplicate' },
            { keys: 'Del / Backspace', desc: 'Delete selection' },
            { keys: '⌘/Ctrl-Z · ⌘/Ctrl-Shift-Z', desc: 'Undo / redo zone shape edits' },
        ],
    },
];

/**
 * The `vegetation` EditorTool registry entry (editor/tools/index.ts): the
 * draw engine in its `vegetation` scope (see `DrawScope`). The zones are
 * drawn, selected and edited here only, over the course shown as an outline
 * backdrop; Draw hides them. Of the backdrop, the creeks and water can be
 * selected (read-only) to set their bank vegetation in the selection panel. Like Draw it declares no `panel`: the dock
 * hosts the selection and stack panels for it (feature-dock.component.ts).
 */
export const vegetationTool: EditorTool = {
    id: VEGETATION_TOOL_ID,
    label: 'Vegetation',
    icon: 'sprout',
    order: 15,
    builderOnly: true,
    help: HELP,
    activate: ctx => di.get(DrawToolService).activate(ctx, { scope: 'vegetation', toolId: VEGETATION_TOOL_ID }),
    deactivate: () => di.get(DrawToolService).deactivate(),
    onEscape: () => di.get(DrawToolService).onEscape(),
};
