# Components

Evidra currently has no browser UI component library. Its interface is an Ink/React terminal UI in `src/ui/app.tsx`; it is not a reusable web component system.

## Terminal UI

- Source: `src/ui/app.tsx`
- Component: `EvidraApp`
- Description: Full-screen terminal workbench with transcript, command palette, status rails, progress, and input handling.
- Web reuse: none; use the product's visual language as inspiration for the companion site.

```tsx
// The file is intentionally not duplicated here: it is a large terminal application.
// Read `src/ui/app.tsx` as the source of truth when terminal UI context is needed.
```
