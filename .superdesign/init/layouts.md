# Evidra terminal layout

## Workbench shell
- Source: `src/ui/app.tsx`
- Layout: full-screen alternate terminal buffer; cyan logo/header; scroll-like transcript; progress line; contextual picker; yellow input bar; persistent provider/model/thinking/mode/permissions status.
- The render branch is the final `return <Box ...>` in `src/ui/app.tsx`.

```tsx
return <Box flexDirection="column" padding={1} minHeight={Math.max(24, process.stdout.rows ?? 24)}>
  {/* header, transcript, progress, picker, input, status and suggestions */}
</Box>;
```

## Interaction layers
- Primary input: `ink-text-input` remains focused except when a model/mode/permissions picker is open.
- Command palette: slash-prefixed suggestions filter live; ↑/↓ selects; Tab completes; Enter executes.
- Modal selectors: model, reasoning, mode, and permissions capture keyboard focus.
