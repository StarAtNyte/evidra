# Evidra screens

## Full-screen Workbench
Entry: `src/ui/app.tsx`

Dependencies:
- `src/ui/app.tsx`
  - `ink/Box`
  - `ink/Text`
  - `ink-text-input`
  - `ink-spinner`
  - `src/core/store.ts`
  - `src/core/process.ts`
  - `src/agents/codex-exec.ts`
  - `src/agents/research-director.ts`
  - `src/core/research-graph.ts`
  - `src/core/experiment-manifest.ts`
  - `src/core/executors.ts`
  - `src/core/worktree.ts`

The target is a terminal composition, not a browser page: header, transcript, live progress, modal selection panel, command input, and state rail.
