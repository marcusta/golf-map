# T26 report — Contextual help modal

`?` (guarded against input targets) or a small `?` button in a dock header
opens a contextual keyboard-shortcut modal whose content is per-tool,
resolved from whichever `EditorTool` currently holds
`MapService.interactionMode`. The draw panel's old inline
`.draw-panel__hints` manual block is gone; its content moved to
`draw-tool.ts`'s new `help` data alongside D23/D24/D27 additions.

## Files touched

- `web/src/editor/tool.ts` — new `HelpShortcut`/`HelpSection` types and an
  optional `help?: HelpSection[]` on `EditorTool`, doc'd in a new "## Help
  (D27)" header section: static data, not a Component — the modal reads
  whichever tool currently holds `MapService.interactionMode`.
- `web/src/editor/help-modal.component.ts` (new) —
  - `HelpModalService`: DI singleton, a single `open: Signal<boolean>` plus
    `show`/`hide`/`toggle`. No per-tool state — trivial enough not to warrant
    a Signal-per-tool split.
  - `HelpModalComponent`: fixed-position backdrop + card, following
    `confirm-dialog.component.ts`'s house modal convention (`z-index: 1000`,
    `t('shadow-elevated')`, backdrop-click-to-close). Title and body react to
    `mapSvc.interactionMode`; body renders the active tool's `help` sections
    or a "No shortcuts for this tool." empty state.
  - Its own `window` `keydown` listener (guarded against
    input/select/textarea targets) handles both `?` (toggle) and `Escape`
    (close, `stopImmediatePropagation` while open — see ordering note below).
- `web/src/editor/toolbar.component.ts` — spawns `HelpModalComponent` into a
  new `helpHost` div as the **first** statement in `onMount()`, before the
  attach-hooks loop and before the toolbar's own ESC listener further down
  the same method. `spawn()` runs the child's full `render`+`onMount`
  synchronously, and `window.addEventListener` listeners fire in
  registration order, so the modal's Escape handler is always registered
  (and thus always runs) before the toolbar's — combined with its
  `stopImmediatePropagation`, closing help on Escape never also falls
  through to `tool.onEscape`/deactivation in the same keystroke. Header doc
  comment updated to mention the modal + ESC ordering.
- `web/src/draw/draw-panel.component.ts` — removed the entire
  `.draw-panel__hints` block (manual text) and its CSS rule; added a
  `.draw-panel__section-head` row (title + `?` button) above "Feature type",
  wired to `HelpModalService.show()`.
- `web/src/draw/feature-stack-panel.component.ts` — same `?`-button
  treatment on the "Feature stack" header (`.stack-panel__section-head`),
  proving a second dock can open the same modal without duplicating it.
- `web/src/draw/draw-tool.ts` — new `HELP: HelpSection[]` (Drawing,
  Selection, Feature stack (D27), Editing, Undo/redo — the old panel manual
  text plus the D24 alt-cycle wording and D27 stack keys) on `drawTool.help`.
- `web/src/furniture/furniture-tool.ts`, `web/src/measure/measure-tool.ts`,
  `web/src/analysis/analysis-tool.ts` — `help` data added to each,
  transcribed from their existing (untouched) inline hint blocks /
  `onKeyDown` behavior. Data only — no panel UI changes, no `?` button in
  these three panels (out of scope; the brief's "done" bar only requires
  draw + at least one other tool, which the global `?` shortcut already
  satisfies for every tool).

## Tests / verification

```
cd web && bun run check:client   # clean
cd web && bun run check:test     # clean
cd web && bun test                # 529 pass, 0 fail (unchanged from T25 baseline)
```

No colocated component test for `help-modal.component.ts` — `TESTING.md`:
"No component-level specs for web UI." Verified interactively instead
(preview browser, Vreta course):

- Draw tool active: `.draw-panel__hints` gone, `.draw-panel .help-btn` and
  `.stack-panel .help-btn` both present.
- Clicked the draw panel's `?` — modal opens titled "Keyboard shortcuts —
  Draw" with all 5 sections (Drawing/Selection/Feature stack (D27)/Editing
  visible, Undo/redo below the fold).
- `Escape` closes the modal (`is-open` class removed) while
  `[data-testid="tool-btn-draw"]` keeps its `active` class — confirms the
  modal's Escape wins without deactivating the tool.
- `?` keydown re-opens it.
- Switched to the Furniture tool, pressed `?` again: title becomes
  "Keyboard shortcuts — Furniture", body shows the Placement/Selection
  sections from `furniture-tool.ts`'s `HELP` — confirms per-tool content
  resolution and that `?` works globally, not just via the draw panel's
  button.

## Notes / deviations

- Scope limited to removing the manual block from `draw-panel.component.ts`
  only, per the brief's Done-bar wording; furniture/measure/analysis panel
  components were not touched (no `?` button added there) — their tools
  still gained real `help` data so the modal has correct content for them
  too, just reached via the `?` key rather than a per-panel button.
- `MapService.interactionMode` (pre-existing, used for exclusive-interaction
  claims) was reused to resolve "active tool" rather than adding a new
  service or coupling to `EditorToolbarComponent`'s private state.
- No new decisions opened; D23/D24/D27 wording consumed as-is (Alt/Option+
  click cycle-with-wrap, PageUp/PageDown/Home/End reorder keys, `?` help).
