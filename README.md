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
- active competition adapters;
- autonomous research campaigns with durable budgets and stopping conditions;
- hashed source retrieval, claims, and searchable research memory;
- data audits and versioned validation policies;
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

Plain-language messages are ordinary conversation. Start autonomous work explicitly with `/research`; Evidra then asks for the goal, budget, and stopping condition before it inspects the workspace or runs experiments. Use `/usage`, `/status`, `/sources add <url>`, and `/memory search <query>` to inspect durable state.

Pi is an internal agent-runtime dependency target. The user-facing product is Evidra, not a Pi extension.

The WhestBench starter kit is kept under `competitions/whestbench/starterkit/` as the immutable competition reference. Experiment outputs are written under `competitions/whestbench/experiments/`.
