import { di } from '@basics/core/client/core';
import type { EditorTool, HelpSection } from '../editor/tool';
import { AnalysisToolService, ANALYSIS_TOOL_ID } from './analysis-tool.service';
import { AnalysisOverlayRenderer } from './analysis-overlay';
import { AnalysisPanelComponent } from './analysis-panel.component';

// One renderer instance per app — it owns per-map overlay bookkeeping and
// is handed to the service on every activation (the service itself stays
// maplibre-free so it can run under bun test).
const renderer = new AnalysisOverlayRenderer();

// Help-modal content (D27) — mirrors the analysis panel's `.analysis-panel__hints`.
const HELP: HelpSection[] = [
    {
        title: 'Analysis',
        shortcuts: [
            { keys: 'Click a green', desc: 'Analyse it and its surrounds' },
            { keys: 'Click off the green', desc: 'Clear the analysis' },
            { keys: 'Esc', desc: 'Clear the analysis' },
        ],
    },
];

/**
 * The `analysis` EditorTool registry entry (editor/tools/index.ts): green +
 * surrounds height/slope analysis. Thin descriptor over the
 * AnalysisToolService DI singleton so the panel and tool share one instance.
 */
export const analysisTool: EditorTool = {
    id: ANALYSIS_TOOL_ID,
    label: 'Green analysis',
    icon: 'crosshair',
    order: 40,
    panel: AnalysisPanelComponent,
    help: HELP,
    activate: ctx => di.get(AnalysisToolService).activate(ctx, renderer),
    deactivate: () => di.get(AnalysisToolService).deactivate(),
    onEscape: () => di.get(AnalysisToolService).onEscape(),
};
