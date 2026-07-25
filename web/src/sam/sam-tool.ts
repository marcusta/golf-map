import { di } from '@basics/core/client/core';
import type { EditorTool, HelpSection } from '../editor/tool';
import { SamToolService, SAM_TOOL_ID } from './sam-tool.service';
import { SamPanelComponent } from './sam-panel.component';

// Help-modal content (D27) — mirrors the SAM panel's `.sam-panel__hints`.
const HELP: HelpSection[] = [
    {
        title: 'SAM assist',
        shortcuts: [
            { keys: 'Click a feature', desc: 'Segment it into a b-spline of the armed type' },
            { keys: 'Panel picker', desc: 'Choose which feature type a click creates' },
            { keys: '⌘Z (in Draw)', desc: 'Undo the created feature' },
        ],
    },
];

/**
 * The `sam` EditorTool registry entry (editor/tools/index.ts): SAM
 * click-to-feature assist (T45). Thin descriptor over the SamToolService DI
 * singleton so the panel and tool share one instance. Requires the local
 * segmentation sidecar (tools/sam-server) — the panel health-gates and
 * explains itself when the sidecar is down.
 */
export const samTool: EditorTool = {
    id: SAM_TOOL_ID,
    label: 'SAM assist',
    icon: 'circle-dot',
    order: 50,
    builderOnly: true,
    panel: SamPanelComponent,
    help: HELP,
    activate: ctx => di.get(SamToolService).activate(ctx),
    deactivate: () => di.get(SamToolService).deactivate(),
};
