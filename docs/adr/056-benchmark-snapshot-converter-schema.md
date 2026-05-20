# ADR-056: Benchmark-snapshot converter — metric and schema

## Status

Accepted (at `5da3b52`)

## Context

The `benchmark-snapshot` CI job (trend tracking on gh-pages via
`benchmark-action/github-action-benchmark@v1`) has been disabled since Phase
11: the action does not accept vitest's `reports/benchmarks/raw.json` shape.
Backlog 15.6 re-enables it, which needs a converter from raw.json to the
schema the action consumes.

`github-action-benchmark@v1` accepts several `tool` values. For an arbitrary
JSON input it offers two custom modes:

- `customSmallerIsBetter` — each entry's `value` is "better" when lower.
- `customBiggerIsBetter` — "better" when higher.

Both expect `[{ name, unit, value }]`. The converter must choose **which
metric** from each vitest benchmark becomes `value`, and **how to name**
entries so the gh-pages chart is stable and unique.

vitest emits per benchmark: `hz` (ops/s), `mean`, `median`, `p99`, `rme`.
`scripts/bench-summarize.ts` already reports `median ?? mean` runtime in ms as
its headline number.

## Decision

`scripts/bench-to-snapshot.ts` exports a pure `toSnapshotEntries(raw)` that
flattens raw.json into `customSmallerIsBetter` entries:

- **Metric:** `median ?? mean` runtime, in **milliseconds**. Smaller = faster
  = better, which is exactly `customSmallerIsBetter`'s semantics, so the
  action's regression alerts read intuitively ("value went up = slower").
- **Naming:** `"<group fullName> > <bench name>"` — e.g.
  `"log:walk-50-commits > tsgit"`. Unique per (scenario, library) pair and
  stable across runs, so each line in the gh-pages chart tracks one series.
- **Unit:** the literal `'ms'`.

The disabled `benchmark-snapshot` block in `ci.yml` is replaced with a real
job: on push to `main`, `test:bench` → `bench-to-snapshot.ts` →
`github-action-benchmark@v1` with `tool: customSmallerIsBetter`,
`auto-push: true`, an alert threshold, and `comment-on-alert`.

## Consequences

### Positive

- Reuses the metric `bench-summarize.ts` already treats as headline — one
  consistent performance number across the summary table and the trend chart.
- Smaller-is-better matches human intuition for a latency chart; regression
  alerts need no mental inversion.
- `<group> > <bench>` keying is unique per series — no collapse across
  scenarios (a defect the existing `benchmark-compare` extractor has by keying
  on bench name alone; out of scope here, flagged in the Phase 15 design).

### Negative

- Median hides tail latency. Accepted: p99 is far noisier on shared CI
  runners; trend tracking wants a stable central-tendency line, and the
  nightly artifacts still carry full p99/RME data.

### Neutral

- The converter declares its own minimal view of the raw.json schema rather
  than sharing types with `bench-summarize.ts` — the two scripts independently
  own their read of the external vitest JSON.
- gh-pages accrues one data point per series per `main` push. The action
  prunes via its own config if the history ever needs trimming.

## Alternatives considered

- **`hz` (ops/s) with `customBiggerIsBetter`** — rejected: bigger-is-better
  inverts the latency intuition and diverges from `bench-summarize.ts`'s
  ms-based headline.
- **`p99` as the tracked metric** — rejected: too noisy on GitHub Actions
  runners (±20% variance) for a trend line.
- **A different benchmarking service** (e.g. bencher.dev) — rejected: a new
  external dependency when `github-action-benchmark` + gh-pages already exist
  in the repo's infrastructure.
