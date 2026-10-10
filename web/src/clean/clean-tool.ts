import { di } from '@basics/core/client/core';
import type { EditorTool, HelpSection } from '../editor/tool';
import { CleanToolService, CLEAN_TOOL_ID } from './clean-tool.service';
import { CleanPanelComponent } from './clean-panel.component';

// Help-modal content (D27) — mirrors the Clean panel's hints.
const HELP: HelpSection[] = [
    { title: 'Cleanup areas', shortcuts: [
        { keys: 'Areas', desc: 'Define where external image cleanup is allowed; Keep unchanged always wins' },
        { keys: 'Drag or click corners, Enter', desc: 'Trace or draw an area, then save it' },
        { keys: 'Ctrl/Cmd-drag', desc: 'Pan the map while drawing an area' },
        { keys: 'Backspace / Esc', desc: 'Remove the last corner / cancel drawing' },
    ] },
    {
        title: 'Clean photo (PhotoCraft tools)',
        shortcuts: [
            { keys: 'Clone', desc: 'Clone Stamp: Alt-click picks the source, drag paints a copy' },
            { keys: 'Heal', desc: 'Healing Brush: as Clone, blended into its surroundings on release' },
            { keys: 'Spot', desc: 'Spot Healing: paint over a blemish' },
            { keys: 'Remove', desc: 'Paint over an object, or loop around it, to fill it from its surroundings' },
            { keys: 'Shift-click', desc: 'Straight stroke from the last one' },
            { keys: '[ / ]', desc: 'Shrink / grow the brush' },
            { keys: 'Ctrl+Z / Ctrl+Shift+Z', desc: 'Undo / redo a stroke' },
            { keys: 'Esc', desc: 'Cancel the stroke being drawn' },
            { keys: 'Undo last session', desc: 'Put back the photo from before the last editing session or import (panel)' },
        ],
    },
];

/**
 * The `clean` EditorTool registry entry (editor/tools/index.ts): retouching
 * the cleaned photo's pixels with PhotoCraft's tools (clean-tool.service.ts).
 * Thin descriptor over the CleanToolService DI singleton so the panel and
 * tool share one instance.
 */
export const cleanTool: EditorTool = {
    id: CLEAN_TOOL_ID,
    label: 'Clean photo',
    icon: 'eraser',
    order: 70,
    builderOnly: true,
    panel: CleanPanelComponent,
    help: HELP,
    activate: ctx => di.get(CleanToolService).activate(ctx),
    deactivate: () => di.get(CleanToolService).deactivate(),
    onEscape: () => di.get(CleanToolService).onEscape(),
    isBusy: () => !!di.get(CleanToolService).areas.kind.peek() || di.get(CleanToolService).areas.busy.peek(),
};
