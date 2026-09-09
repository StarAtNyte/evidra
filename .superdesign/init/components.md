# Evidra UI components

## App
- Source: `src/ui/app.tsx`
- Description: The complete Ink terminal workbench: logo/header, transcript, progress indicator, modal pickers, command suggestions, and input bar.
- Props: `root: string`

```tsx
// The complete source of App is maintained in src/ui/app.tsx.
// This terminal product has one intentionally cohesive view rather than a web component tree.
```

## Reused terminal primitives
- `ink/Box`: layout container and borders
- `ink/Text`: typography and color hierarchy
- `ink-text-input/TextInput`: focused command input
- `ink-spinner/Spinner`: live execution progress
