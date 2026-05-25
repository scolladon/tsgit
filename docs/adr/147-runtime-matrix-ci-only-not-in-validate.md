# ADR-147: Runtime-parity matrix runs in CI only, not in `npm run validate`

## Status

Accepted (at `4911c0d`)

## Context

`npm run validate` is the project's local quality gate. It runs lint +
types + dead-code + duplicates + filesystem + architecture + spelling +
deps + security + size + exports + 100% coverage + integration + parity.
A contributor expects "clean validate" to mean "this PR will pass CI".

Adding Deno + Bun + Workers to `validate` would extend that contract
to: "contributors must have Deno, Bun, and wrangler installed locally".
Three problems:

1. **Install friction.** `wrangler` alone is ~150 MB after
   dependencies. A contributor who only edits `docs/` should not need
   it.
2. **Tooling-version drift.** Each contributor's local Deno/Bun version
   drifts from CI's pinned version, producing per-contributor
   spurious-failure variance.
3. **The non-Vitest runtimes don't share Vitest's reporter, watch
   mode, or coverage integration.** Local validate becomes a
   four-tool orchestration instead of one.

The alternative — runtime matrix in CI only — costs nothing locally and
catches regressions at PR time. The contributor's local validate stays
fast, single-tooled, and self-contained.

## Decision

`npm run validate` does **not** include the runtime-parity matrix.

The matrix runs as three CI jobs (`parity-deno`, `parity-bun`,
`parity-workers`) that gate on `needs.changes.outputs.code == 'true'`
— so a docs-only PR skips them entirely, while any code change exercises
them.

Local runner recipes (`npm run test:parity:deno`, `test:parity:bun`,
`test:parity:workers`) are added for contributors who *do* have the
runtimes installed and want to validate locally before pushing. These
recipes are best-effort affordances, not gating contracts.

`CONTRIBUTING.md` documents:

- `npm run validate` is the green light for "ready to push".
- The runtime matrix is CI-gated; install Deno/Bun/wrangler only if
  you want to validate locally before pushing.

## Consequences

### Positive

- Contributor onboarding stays one-command (`npm install && npm run
  validate`).
- Docs-only contributors never install runtime tooling.
- CI is the authoritative gate — no "passes locally but fails in CI"
  surface area on the runtime axis.

### Negative

- A regression on Deno/Bun/Workers is only caught in CI, not at the
  commit step. Mitigated by the opt-in local recipes — engineers
  touching cross-runtime concerns can run them.
- If a runtime breaks on `main`, fixing it requires a CI round-trip
  (or installing the runtime locally on demand). Acceptable —
  cross-runtime regressions are not the steady-state failure mode.

### Neutral

- If Deno/Bun/Workers become so universally installed that the friction
  argument no longer holds, the matrix can be promoted to
  `validate`. The decision is reversible.
