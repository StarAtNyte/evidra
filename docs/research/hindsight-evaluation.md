# Hindsight evaluation for Evidra

Status: design review, 2026-09-25

Hindsight is an open-source agent-memory system focused on learning over time rather than only replaying conversation history. Its repository describes three main operations—`retain`, `recall`, and `reflect`—plus several memory types, isolated memory banks, evidence-backed observations, and persistent mental models/knowledge pages.

Reference: [vectorize-io/hindsight](https://github.com/vectorize-io/hindsight)

## What is transferable

### 1. Separate lookup from reflection

Evidra already retrieves bounded claims, hypotheses, failures, playbooks, and source leads. Hindsight’s distinction is useful for naming two different controller actions:

- **Recall:** retrieve existing, provenance-linked evidence for the next decision.
- **Reflect:** synthesize a bounded historical brief from several evidence items, without promoting the synthesis to proof.

Reflection would be useful before a new phase, after a failed experiment cluster, and when a campaign resumes on another machine.

### 2. Evidence-backed observations

Hindsight consolidates related memories into observations while retaining supporting evidence. Evidra has the safer primitives already—claims, source hashes, excerpts, graph edges, active/stale lifecycle, and quarantined negative evidence—but does not yet expose a first-class consolidated observation object.

The Evidra version must retain:

- the source claim and artifact IDs;
- the observation’s scope and task/phase fingerprint;
- supporting and contradicting evidence counts;
- the last observed timestamp and source revisions;
- an explicit `historical`, `provisional`, or `verified` status.

It must never turn repeated agent statements into verified evidence.

### 3. Standing campaign context

Hindsight’s mental models and knowledge pages map well to a durable, refreshable research brief:

- objective and stopping rule;
- current phase and verified gates;
- best measured result and its exact run;
- active hypotheses and falsification agenda;
- failed directions and route changes;
- unresolved evidence conflicts;
- external score feedback, kept separate from local proof.

Evidra already stores most of this data. The missing feature is a compact, controller-generated projection that can be read cheaply at startup and regenerated when its evidence fingerprint changes.

### 4. Multi-signal retrieval

Hindsight reports combining semantic, keyword, graph, and temporal retrieval, then merging and reranking the results. Evidra currently combines deterministic lexical ranking with its SQLite FTS index and regime-aware quotas. The next low-risk improvement is to add deterministic signals before introducing embeddings:

1. FTS/lexical relevance;
2. active-source and provenance quality;
3. task, phase, and provider-context match;
4. recency within the active campaign;
5. diversity across source IDs, hypothesis families, and artifacts;
6. contradiction and failure relevance.

This keeps retrieval reproducible and cheap for a TypeScript CLI. A semantic reranker should be optional and benchmarked, never required for an offline challenge run.

## What we should not copy

- Do not replace Evidra’s SQLite event ledger with a separate memory service.
- Do not allow an LLM-generated observation or mental model to satisfy a phase gate.
- Do not merge challenge leaderboard scores with local evaluator metrics.
- Do not add a background LLM memory writer to every conversation; it would increase cost, latency, and unreviewed state.
- Do not adopt Hindsight’s conversational memory benchmarks as evidence that Evidra solves scientific or competition tasks better.

Hindsight is a Python/PostgreSQL-oriented memory product with optional hosted deployment. Evidra’s differentiator is an auditable research controller whose memory is tied to experiments, evaluators, artifacts, and stopping conditions. The systems are complementary, but Hindsight should remain an optional integration rather than a runtime dependency.

## Adoption gate

Implement the following as one matched harness change:

1. Add a controller-generated campaign brief with a deterministic evidence fingerprint.
2. Add recall-vs-reflect retrieval modes; reflection is historical guidance only.
3. Add the deterministic multi-signal ranking features above.
4. Evaluate on at least two research tasks and one challenge task with the same model, effort, time budget, and evaluator.
5. Require no regression in evidence validity, recovery, latency, or external-score alignment.

Retain the change only if it improves task-balanced measured performance or reduces time-to-valid-evidence without weakening provenance. Otherwise keep the current simpler memory path.
