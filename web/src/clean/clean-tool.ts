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
            { keys: 'Accept / Discard', desc: 'Bake the preview into the tiles, or drop it' },
            { keys: 'Esc', desc: 'Discard the preview / cancel the drag' },
            { keys: 'Revert last patch', desc: 'Un-bake the most recent patch (panel)' },
        ],
    },
];

/**
 * The `clean` EditorTool registry entry (editor/tools/index.ts):
 * interactive ortho photo cleaning (T55). Thin descriptor over the
 * CleanToolService DI singleton so the panel and tool share one instance.
 * Requires the local assist sidecar's /inpaint capability
 * (tools/sam-server + LaMa weights) — the panel health-gates and explains
 * itself when either is missing.
 */
export const cleanTool: EditorTool = {
    id: CLEAN_TOOL_ID,
    label: 'Clean photo',
    icon: 'eraser',
    order: 70,
    panel: CleanPanelComponent,
    help: HELP,
    activate: ctx => di.get(CleanToolService).activate(ctx),
    deactivate: () => di.get(CleanToolService).deactivate(),
    onEscape: () => di.get(CleanToolService).onEscape(),
};
