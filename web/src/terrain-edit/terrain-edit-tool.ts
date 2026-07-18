import { di } from '@basics/core/client/core';
import type { EditorTool, HelpSection } from '../editor/tool';
import { TerrainEditToolService, TERRAIN_EDIT_TOOL_ID } from './terrain-edit-tool.service';
import { TerrainEditOverlayRenderer } from './terrain-edit-overlay';
import { TerrainEditPanelComponent } from './terrain-edit-panel.component';

// One renderer instance per app — it owns per-map overlay bookkeeping and is
// handed to the service on every activation (the service itself stays
// maplibre-free so it can run under bun test; analysis-tool pattern).
const renderer = new TerrainEditOverlayRenderer();

// Help-modal content (D27) — mirrors the panel's `.tedit-panel__hints`.
const HELP: HelpSection[] = [
    {
        title: 'Terrain edits',
        shortcuts: [
            { keys: 'Click', desc: 'Place an outline point' },
            { keys: 'Click the first point', desc: 'Close the outline & save the edit' },
            { keys: 'Esc', desc: 'Discard the outline' },
        ],
    },
];

/**
 * The `terrain-edit` EditorTool registry entry (editor/tools/index.ts):
 * draw smooth/flatten areas that are replayed onto the DEM at build time
 * (T55b; ops per D-TE3). Thin descriptor over the TerrainEditToolService DI
 * singleton so the panel component and the tool share one instance.
 */
export const terrainEditTool: EditorTool = {
    id: TERRAIN_EDIT_TOOL_ID,
    label: 'Terrain edit',
    icon: 'mountain',
    order: 60,
    panel: TerrainEditPanelComponent,
    help: HELP,
    activate: ctx => di.get(TerrainEditToolService).activate(ctx, renderer),
    deactivate: () => di.get(TerrainEditToolService).deactivate(),
    onEscape: () => di.get(TerrainEditToolService).onEscape(),
};
