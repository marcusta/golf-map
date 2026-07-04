import { di } from '@basics/core/client/core';
import type { EditorTool } from '../editor/tool';
import { AnalysisToolService, ANALYSIS_TOOL_ID } from './analysis-tool.service';
import { AnalysisOverlayRenderer } from './analysis-overlay';
import { AnalysisPanelComponent } from './analysis-panel.component';

// One renderer instance per app — it owns per-map overlay bookkeeping and
// is handed to the service on every activation (the service itself stays
// maplibre-free so it can run under bun test).
const renderer = new AnalysisOverlayRenderer();

/**
 * The `analysis` EditorTool registry entry (editor/tools/index.ts): green +
 * surrounds height/slope analysis. Thin descriptor over the
 * AnalysisToolService DI singleton so the panel and tool share one instance.
 */
export const analysisTool: EditorTool = {
    id: ANALYSIS_TOOL_ID,
    label: 'Green analysis',
    icon: '◉',
    order: 40,
    panel: AnalysisPanelComponent,
    activate: ctx => di.get(AnalysisToolService).activate(ctx, renderer),
    deactivate: () => di.get(AnalysisToolService).deactivate(),
    onEscape: () => di.get(AnalysisToolService).onEscape(),
};
