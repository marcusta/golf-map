import { di } from '@basics/core/client/core';
import type { EditorTool, HelpSection } from '../editor/tool';
import { CleanToolService, CLEAN_TOOL_ID } from './clean-tool.service';
import { CleanPanelComponent } from './clean-panel.component';

// Help-modal content (D27) — mirrors the Clean panel's hints.
const HELP: HelpSection[] = [
    {
        title: 'Clean photo',
        shortcuts: [
            { keys: 'Click a blemish', desc: 'SAM masks it; LaMa inpaints the preview' },
            { keys: 'Drag (ellipse mode)', desc: 'Hand-drawn mask — no SAM needed' },
            { keys: 'Accept', desc: 'Queue the previewed edit (bakes later, in one batch)' },
            { keys: 'Bake N edits', desc: 'Bake the whole queue into the CLEANED (sim) photo' },
            { keys: 'Esc', desc: 'Cancel the drag/stroke, discard the preview or queue' },
            { keys: 'Revert last patch', desc: 'Un-bake the most recent baked edit (panel)' },
        ],
    },
    {
        title: 'Clone stamp',
        shortcuts: [
            { keys: 'Alt-click', desc: 'Pick the clone source (ring marker)' },
            { keys: 'Drag', desc: 'Paint — clones from the source at the picked offset' },
            { keys: 'Click', desc: 'Stamp a single dab' },
            { keys: 'Shift-click', desc: 'Straight-line stroke from the last dab' },
            { keys: '[ / ]', desc: 'Shrink / grow the brush' },
            { keys: 'Aligned', desc: 'ON: offset persists across strokes; OFF: restart from the source' },
        ],
    },
];

/**
 * The `clean` EditorTool registry entry (editor/tools/index.ts):
 * interactive ortho photo cleaning (T55 + clone stamp + batch baking into
 * the dual-state sim photo). Thin descriptor over the CleanToolService DI
 * singleton so the panel and tool share one instance. The mask modes
 * require the local assist sidecar's /inpaint capability (tools/sam-server
 * + LaMa weights) — the panel health-gates and explains itself when either
 * is missing; the clone-stamp mode is pure local math and works without
 * the sidecar entirely.
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
};
