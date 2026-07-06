/**
 * The editor tool ids, mirroring web/src/editor/tools/index.ts (draw=10,
 * furniture=20, measure=30, analysis=40). Each renders a toolbar button with
 * data-testid="tool-btn-<id>". Kept as a plain list so the E2E harness has no
 * import dependency on the web app source.
 */
export const EDITOR_TOOL_IDS = ['draw', 'furniture', 'measure', 'analysis'] as const;
