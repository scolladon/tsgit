# ADR-105: Classify tests by directory, not by heuristic

## Status

Accepted (at `b511d7f`)

## Context

The 19.2 audit needs to put every test file into exactly one of three tiers
— unit, integration, e2e — to compute the ratio and pick the right
heuristics (mock-detection runs on integration; assertion-density runs on
unit). Two classification schemes were considered:

1. **Directory-based.** `test/unit/**` → unit, `test/integration/**` →
   integration, `test/browser/**` → e2e. Mechanical, no inspection of file
   content, matches the existing `vitest.config.ts` project layout (which
   already uses these same globs to wire its projects).
2. **Heuristic-based.** Inspect each test file's imports and runtime API
   surface:
   - `vi.mock` / `vi.fn` → unit.
   - `node:fs` / `node:child_process` / a memory adapter compose → integration.
   - A Playwright API import → e2e.

The heuristic scheme is more "honest" — a test that lives under `test/unit/`
but spawns a real subprocess is *de facto* an integration test. But it
relocates the boundary on every refactor: rename an import, change tiers.
That's exactly the kind of churn that makes the audit untrustworthy.

The directory scheme has a different failure mode: a test that should be in
`test/integration/` but lives in `test/unit/` won't be flagged for using
real I/O. Mitigation: PR review catches "you put an integration test under
unit/" the same way it catches any structural mistake, and the over-mocked
heuristic still runs on files that *are* under `test/integration/` — which is
where the audit's signal value is concentrated.

## Decision

Classify every test file by its top-level directory under `test/`:

| Directory | Tier |
|---|---|
| `test/unit/**/*.test.ts` | unit |
| `test/integration/**/*.test.ts` (incl. `posix-only/`, `win-only/`) | integration |
| `test/browser/**/*.spec.ts` | e2e |

`test/fixtures/**`, `test/bench/**`, `test/**/support/**`, and
`test/**/fixtures.ts` are excluded — they hold helper code and data, not test
cases.

A file under `test/` that matches none of the three globs is reported as
`unclassified` in the audit but does not fail the run (consistent with the
report-only stance of ADR-104).

The manifest `test-pyramid-budgets.json` is the single source of truth for
the globs — changing the layout means editing the manifest in the same PR.

## Consequences

### Positive

- Reuses the existing layout; no migration.
- Reuses `vitest.config.ts`'s existing tier separation — one mental model.
- Stable: refactors inside a tier don't move tier boundaries.

### Negative

- A miscategorised test (real I/O under `test/unit/`) won't be flagged by the
  audit. Mitigation: PR review, and the over-mocked heuristic still gives a
  layer of defence on the integration tier.
- A new test category (e.g. property-based 19.6, contract tests for 19.7)
  needs a manifest update and an ADR — friction, but cheap friction.

### Neutral

- Compatible with the runtime parity matrix (19.8) — Deno/Bun/Workers add
  *runtime* dimensions, not new tiers; the same files re-run.
