import { di } from '@basics/core/client/core';
import type { EditorTool, HelpSection } from '../editor/tool';
import { DrawToolService, DRAW_TOOL_ID } from './draw-tool.service';
import { DrawPanelComponent } from './draw-panel.component';
import { FeatureStackPanelComponent } from './feature-stack-panel.component';

// Help-modal content (D27) — moved here from the draw panel's old inline
// `.draw-panel__hints` manual block, plus the D27 stack/cycle additions.
const HELP: HelpSection[] = [
    {
        title: 'Drawing',
        shortcuts: [
            { keys: 'N', desc: 'Start a new polygon' },
            { keys: 'Enter / click first point', desc: 'Close the polygon' },
            { keys: 'Esc', desc: 'Cancel drawing' },
            { keys: 'Click', desc: 'Place a smooth point' },
            { keys: 'Shift-click', desc: 'Place a corner point' },
        ],
    },
    {
        title: 'Selection',
        shortcuts: [
            { keys: '⌘/Ctrl-click', desc: 'Multi-select' },
            { keys: 'Drag empty ground', desc: 'Marquee select (Alt: touch-friendly)' },
            { keys: 'Alt/Option-click', desc: 'Select topmost feature; repeat to cycle down the hit stack, wrapping' },
        ],
    },
    {
        title: 'Feature stack (D27)',
        shortcuts: [
            { keys: 'PageUp', desc: 'Raise selection one step' },
            { keys: 'PageDown', desc: 'Lower selection one step' },
            { keys: 'Home', desc: 'Raise selection to top' },
            { keys: 'End', desc: 'Lower selection to bottom' },
        ],
    },
    {
        title: 'Editing',
        shortcuts: [
            { keys: 'Drag inside selection', desc: 'Move' },
            { keys: '⌘/Ctrl-D', desc: 'Duplicate' },
            { keys: 'Drag vertex', desc: 'Move vertex' },
            { keys: 'Click edge', desc: 'Insert a vertex' },
            { keys: 'Shift-click / drag', desc: 'Select vertices' },
            { keys: 'I', desc: 'Insert between two selected vertices' },
            { keys: 'C', desc: 'Toggle hovered vertex smooth/corner' },
            { keys: 'Right-click vertex', desc: 'Remove it' },
            { keys: 'Alt-drag (bezier)', desc: 'Adjust curve handles' },
            { keys: 'Alt-click (bezier)', desc: 'Straighten the vertex' },
            { keys: 'Del / Backspace', desc: 'Delete selection (or selected vertices)' },
        ],
    },
    {
        title: 'Undo / redo',
        shortcuts: [
            { keys: '⌘/Ctrl-Z', desc: 'Undo (or last drawn point, while drawing)' },
            { keys: '⌘/Ctrl-Shift-Z / ⌘/Ctrl-Y', desc: 'Redo (or point redo, while drawing)' },
        ],
    },
];

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
    help: HELP,
    attach: ctx => di.get(DrawToolService).attach(ctx),
    activate: ctx => di.get(DrawToolService).activate(ctx),
    deactivate: () => di.get(DrawToolService).deactivate(),
    onEscape: () => di.get(DrawToolService).onEscape(),
};
