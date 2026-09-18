# Evidra first-use research demo

This is the silent product-demo screenplay for the contemporary computer-vision research workflow shown in `assets/demo/evidra-complete-product-demo.mp4`.

## Research question

> Can open-vocabulary vision models detect previously unseen industrial defects with only 1% labeled training data?

The question is deliberately measurable and useful for demonstrating Evidra from an empty workspace: it requires dataset discovery, literature research, leakage controls, baseline construction, controlled experiments, and independent replication.

## Setup input

```text
/research
```

```text
Study whether open-vocabulary vision models can detect previously unseen industrial defects using only 1% labeled training data.

Start from the empty workspace. Find a suitable public anomaly-detection dataset, establish a supervised baseline, research modern open-vocabulary and self-supervised vision methods, run controlled experiments, and validate improvements on defect categories excluded from training.

Use AUROC and AUPRO as primary metrics. Prevent category leakage, keep the test categories hidden until evaluation, record all sources and decisions, and independently replicate any claimed improvement.
```

When asked for a budget:

```text
90m
```

When asked for the stopping condition:

```text
Stop after an improvement is independently replicated on unseen defect categories, or when the research budget is exhausted.
```

## The three research steps

### 01 — Orient

```text
Phase 01 · Orientation

Workspace is empty.
Selecting a public industrial anomaly benchmark.

Metric: image AUROC + pixel AUPRO
Validation: held-out defect categories
Leakage control: test categories hidden until evaluation
```

Answer:

```text
Orientation complete
Evaluation contract locked
Baseline plan registered
```

### 02 — Discover

```text
Phase 02 · Discovery

Research lanes active:
01 · Open-vocabulary vision
02 · Self-supervised representations
03 · Anomaly scoring and localization
04 · Leakage and robustness audit
```

The director compares frozen DINOv2 features, CLIP prompt scoring, supervised features, and a hybrid method. It records sources and turns the strongest idea into a falsifiable hypothesis:

```text
Hypothesis H01

Frozen self-supervised visual features combined with fixed defect-aware
text prompts will improve unseen-category AUROC over the supervised baseline
under the same 1% label budget.
```

### 03 — Experiment and validate

```text
Baseline: supervised CNN with 1% labeled training data
Candidate: frozen DINOv2 features + fixed defect prompts
Controls: three seeds, unseen categories, identical evaluation contract
```

Evidra should also show a rejected route:

```text
Prompt tuning improved known categories but degraded unseen categories.
Failure recorded as negative evidence.
Next route: fixed prompt templates and independent replication.
```

Example final state for the screenplay:

```text
Baseline       AUROC 0.781
Best candidate AUROC 0.836
Improvement    +7.0%
Replication   PASSED
Leakage audit  PASSED
Provenance     COMPLETE
Decision       RETAIN
```

These metrics are illustrative screenplay values. A real recording must use the values produced by the actual Evidra run.

## Video sequence

1. Existing launch introduction.
2. `/research` and the research question.
3. Orientation: task, metric, holdout, and leakage contract.
4. Discovery: research lanes and method comparison.
5. Validation: baseline, candidate, rejected route, replication, and decision.
6. End card: `Research · Experiment · Validate · Resume`.

No voiceover is required. Do not show tokens, private paths, or fabricated results.
