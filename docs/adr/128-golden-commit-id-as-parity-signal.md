# ADR-128: Golden `commit.id` per scenario as the load-bearing determinism signal

## Status

Accepted (at `91dfcc674ca8fd0bb818b6b9869b1700cf7919b4`)

## Context

Phase 19.5 declares fixtures deterministic — author identity, timestamps, file contents, commit messages are pinned constants. The Vitest + Playwright runs are expected to produce byte-identical commits across the Node, Memory, and Browser adapters. Two ways to assert determinism in each parity scenario:

1. **Shape-only assertions** (status quo for `test/browser/`): `expect(commit.id).toMatch(/^[0-9a-f]{40}$/)`, `expect(commit.branch).toBe('refs/heads/main')`. Catches type-level regressions; misses any drift in tree serialization, blob framing, parent linkage, or author identity encoding — every one of which would mutate the SHA-1 but leave the shape intact.
2. **Golden 40-hex literal** in `EXPECTED.commit.id`. A single byte of non-determinism anywhere in the commit pipeline changes the hash. The assertion is `expect(actual).toEqual(EXPECTED)` — exact equality.

Option 2 is strictly stronger: every shape regression is also an ID regression (because the bytes hash differently), but the converse is false. The current `test/browser/` specs picked option 1 because there was no shared expected-output module to anchor on; once the parity-scenario module owns `EXPECTED`, option 2 becomes the natural assertion.

The cost of option 2 is one-time fixture pinning per scenario. Once the SHA-1 of the first run is recorded in the file, any future drift surfaces as a literal mismatch with the offending diff shown by Vitest / Playwright. The cost of option 1 is permanent: every byte-level regression in object serialization is silently invisible to the parity layer.

The audit lint in §3.4 of `docs/design/phase-19-5-e2e-harness-upgrade.md` cannot substitute for the golden — it bans known non-determinism sources but cannot prove the *adapters* are byte-identical. Only an end-to-end SHA-1 comparison can.

## Decision

Each `<name>.scenario.ts` exports `EXPECTED: ScenarioResult` with `EXPECTED.commit.id` as a 40-hex literal. The Node driver writes this literal first (Node is the canonical adapter); the Memory and Browser drivers then assert against the same literal. Any drift mid-pipeline fails as a golden mismatch in whichever adapter regressed.

When a scenario legitimately changes (new file content, new author, new message), the contributor updates `EXPECTED.commit.id` along with the change — the audit lint and the determinism rule make this a one-line edit, not a hunt.

## Consequences

### Positive

- **End-to-end byte-identity check across three adapters.** Any silent regression in tree encoding, blob header framing, author identity serialization, or parent linkage surfaces as a failed assertion, not as missing coverage.
- **Cross-adapter parity becomes a first-class invariant.** The single `EXPECTED` per scenario is the binding contract — Memory + Browser are not allowed to deviate from the Node baseline.
- **Failure messages name the wrong byte.** A golden mismatch with Vitest's diff reporter shows `expected: 'abc...' / actual: 'def...'`, which is enough to bisect against `git log -p test/parity/scenarios/<name>.scenario.ts` and find the regression source.

### Negative

- **Updating a scenario's input requires regenerating the golden.** When `FILES.helloA.content` changes from `'hello a\n'` to `'hi a\n'`, every scenario that uses it produces a different commit ID. The contributor runs the Node driver locally, copies the new SHA-1 into `EXPECTED.commit.id`. Acceptable: scenario inputs are tightly scoped pinned constants — they don't churn.
- **No room for adapter-specific compromises in `commit.id`.** If a future adapter cannot match the canonical SHA-1 (e.g., an SHA-256 transitional adapter), that adapter has to be excluded from the matrix or get its own `EXPECTED.commit.id` per algorithm. Accepted — the parity guarantee is the whole point of the matrix.

### Neutral

- **Mutation testing does not run on `test/parity/**`.** The parity scenarios test parity, not the SUT. Stryker is unaffected and the project's mutation budgets remain unchanged.
