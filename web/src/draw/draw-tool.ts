import { di } from '@basics/core/client/core';
import type { EditorTool, HelpSection } from '../editor/tool';
import { DrawToolService, DRAW_TOOL_ID } from './draw-tool.service';

// Help-modal content (D27) — moved here from the draw panel's old inline
// `.draw-panel__hints` manual block, plus the D27 stack/cycle additions.
const HELP: HelpSection[] = [
    {
        title: 'Navigation',
        shortcuts: [
            { keys: '⌘-drag', desc: 'Pan the map (trackpad-friendly; falls through to the map even in box-select)' },
            { keys: 'Middle-drag', desc: 'Pan the map (mouse; works mid-gesture in any tool)' },
        ],
    },
    {
        title: 'Drawing',
        shortcuts: [
            { keys: 'N', desc: 'Start a new polygon' },
            { keys: 'Enter / click first point', desc: 'Close the polygon' },
            { keys: 'Esc', desc: 'Cancel drawing' },
            { keys: 'Click', desc: 'Place a smooth point' },
            { keys: 'Shift-click', desc: 'Place a corner point' },
            { keys: '1–9, 0', desc: 'Arm a feature type (or retype the selection) — tee…water, 0 = creek' },
        ],
    },
    {
        title: 'Selection',
        shortcuts: [
            { keys: '⌘/Ctrl-click', desc: 'Multi-select' },
            { keys: 'Drag empty ground', desc: 'Marquee select (Alt: touch-friendly)' },
            { keys: 'B', desc: 'Toggle box-select: drag anywhere marquees, even over shapes' },
            { keys: 'Space-drag', desc: 'Momentary box-select over a shape (no toggle)' },
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
 * descriptor over the DrawToolService DI singleton so the tool and its dock
 * content (SelectionPanel + FeatureStackPanel, hosted by ContextDockComponent)
 * share one instance. Draw declares NO `panel`: its editing surface lives in
 * the contextual right dock, not a floating panel over the map.
 */
export const drawTool: EditorTool = {
    id: DRAW_TOOL_ID,
    label: 'Draw',
    icon: 'pencil',
    order: 10,
    help: HELP,
    attach: ctx => di.get(DrawToolService).attach(ctx),
    activate: ctx => di.get(DrawToolService).activate(ctx),
    deactivate: () => di.get(DrawToolService).deactivate(),
    onEscape: () => di.get(DrawToolService).onEscape(),
};
