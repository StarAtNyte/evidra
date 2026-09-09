# Evidra routes

This is a full-screen terminal application with no HTTP routes or browser pages.

| Surface | Entry | Purpose |
|---|---|---|
| Workbench | `src/ui/app.tsx:App` | Research and challenge session |
| CLI bootstrap | `src/cli.ts` | Starts Ink TUI when no CLI arguments are supplied |
| Research mode | `/research` in `src/ui/app.tsx` | Evidence-gathering research cycle |
| Challenge mode | `/challenge` in `src/ui/app.tsx` | Baseline, experiments, and runs |
