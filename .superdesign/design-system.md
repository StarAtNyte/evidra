# Evidra Workbench design system

Evidra is a local-first autonomous research laboratory for competitions. Its primary surface is a keyboard-first full-screen terminal workbench used by technical researchers. The design must feel like a serious scientific control room: dense, calm, legible, and state-aware.

## Visual direction
- Dark terminal canvas, no marketing-dashboard decoration.
- Cyan is the Evidra research identity.
- Yellow means user action, selected state, or permission.
- Magenta means active execution/progress.
- Green means completed assistant/evidence output.
- Gray is metadata and secondary telemetry.
- Use compact panels and eliminate unused vertical space.

## Sections
1. Compact identity/status header
2. Research transcript with role-coded messages
3. Live execution telemetry
4. Contextual command/model/mode/permission palette
5. Single-line command input
6. Persistent state rail under input

## Interaction rules
- `/` opens/filter commands; ↑/↓ moves selection; Tab completes; Enter executes.
- `/model`, `/mode`, and `/permissions` open modal pickers and lock the text input until selection or Esc.
- Every autonomous action exposes current phase, provider, model, mode, and permission level.

## Constraints
- Preserve terminal monospace rendering.
- Preserve full-screen alternate-buffer behavior.
- Do not introduce decorative imagery, gradients, browser-only controls, or mouse-only interactions.
- Use only the existing Ink primitives and terminal-safe colors.
