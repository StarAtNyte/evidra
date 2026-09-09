# Evidra

Evidra is a research-focused autonomous experimentation workbench. It uses an agent runtime for reasoning and coding, while deterministic infrastructure owns experiments, evidence, budgets, artifacts, and submissions.

The first trial competition is AIcrowd's ARC White-Box Estimation Challenge (WhestBench).

## Status

Initial TypeScript foundation:

- standalone CLI;
- durable SQLite research state;
- append-only event log;
- competition configuration;
- agent and executor boundaries;
- WhestBench project initialization.

## Development

```bash
npm install
npm run dev -- init whestbench
npm run dev -- status
npm run dev -- baseline
npm run dev -- experiment run exp_0001
npm run check
```

Run `evidra` without arguments for the interactive research session. Use `/help` inside the session to see available research commands.

Pi is an internal agent-runtime dependency target. The user-facing product is Evidra, not a Pi extension.

The WhestBench starter kit is kept under `competitions/whestbench/starterkit/` as the immutable competition reference. Experiment outputs are written under `competitions/whestbench/experiments/`.
