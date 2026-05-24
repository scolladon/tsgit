# ADR-120: `skipIf` / `runIf` are non-skipped at scan time

## Status

Accepted (at `b35a5fcb86e5138121a6dc828204146b4bccb208`)

## Context

The testing-pyramid scanners (`tooling/test-pyramid/scan-it-blocks.ts`, `scan-describe-blocks.ts`) tag each emitted block with an `isSkipped` boolean. Today the tag is set when any chain segment is in `SKIP_MODIFIERS = {'skip', 'todo', 'fails'}`. Detectors that report on test bodies (`underAssertedUnit`, `aaaBody`, `emptyAaaSection`, `gwtTitle`, `sutNaming`, `bareClassToThrow`) use the flag as a "don't bother" hint — a `.skip` test is exempt from finding assertions, AAA markers, etc.

Vitest also ships `it.skipIf(cond)` and `it.runIf(cond)` (mirrored on `describe`), which conditionally skip based on a runtime expression. The scanner is static and cannot evaluate the condition. We have a choice:

1. **Treat as skipped** (`isSkipped: true` whenever `skipIf` / `runIf` is present). Conservative: no false positives from heuristics on tests that may never run.
2. **Treat as not skipped** (`isSkipped: false`). Heuristics run as if the test executes unconditionally. False positives only if the condition is always falsy in practice — but then the test is dead code anyway.

`each` is already an analogous case: `it.each([…])('case %s', …)` runs every row unless an explicit `.skip` is chained, and the scanner returns `isSkipped: false` for it.

## Decision

`skipIf` and `runIf` are NOT added to `SKIP_MODIFIERS`. Both helpers produce blocks with `isSkipped: false`, matching the `each` precedent. Static text heuristics (titles, AAA markers, `sut` naming, bare-class `toThrow`) fire on them just like any unconditional test.

Explicit chains still win: `it.skipIf(cond).skip('title', body)` would carry `skip` in the chain keys and emit `isSkipped: true` — but in practice the scanner's chain regex only captures segments **before** the first `(`, so this combinatorial shape is not reachable today. It is documented as out of scope alongside three-stage chains.

## Consequences

### Positive

- **Closes the original 19.3b blind spot.** The whole point of the change is to make heuristics fire on `…If`-wrapped tests; treating them as skipped would re-create today's bug under a different mechanism.
- **Consistent with `each`.** Both helpers wrap a runtime expression in a first call; both leave the title in the second call; both produce real tests that run in some environments. Same `isSkipped` semantics across the family.
- **Heuristics are condition-independent.** A test with a bad GWT title or missing AAA markers is wrong whether the condition gates execution or not. Fixing the static text costs nothing if the test never runs and prevents the slip the day the condition flips.

### Negative

- **No way to opt a conditional test out of the lint via the scanner.** If a unit test legitimately needs to skip the gates (a fixture-only file, etc.), the operator must use the existing `excludePaths` in `test-pyramid-budgets.json` or an explicit `.skip` chain. The `skipIf` helper is not a lint escape hatch.

### Neutral

- **No corpus impact today.** Every existing `it.skipIf` / `describe.skipIf` usage lives in the integration tier, where the affected heuristics are not gated. The decision is forward-looking.
