# Evidra terminal design tokens

## Compact token summary
- Background: terminal default / near-black
- Primary accent: cyan
- Input accent: yellow
- Progress accent: magenta
- Assistant output: green
- User input: yellow
- System metadata: gray
- Borders: round, one-cell inset
- Layout: full terminal height, 1-cell outer padding, compact vertical rhythm
- Typography: terminal monospace default; bold cyan wordmark; dim gray metadata
- Interaction: arrow-key modal pickers, live slash filtering, Tab completion, Enter execution

## Current source tokens

```tsx
const LOGO = [/* Evidra ASCII wordmark in src/ui/app.tsx */];
<Box borderStyle="round" borderColor="cyan" paddingX={2}>
<Text color="cyan" bold>...</Text>
<Text color="gray">...</Text>
<Box borderStyle="round" borderColor={busy ? "gray" : "yellow"}>
<Text color="yellow">› </Text>
```

## Desired premium direction
- Dense dark command-center composition
- Strong cyan research identity with amber permission state
- Clear separation between conversation, execution telemetry, and controls
- Avoid large empty vertical gaps
- Preserve terminal legibility and keyboard-first interaction
